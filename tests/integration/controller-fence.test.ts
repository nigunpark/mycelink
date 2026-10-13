/**
 * The controller/worker fence, enforced before a tool runs (PreToolUse).
 *
 * CSET-202 r2, with-normal: the top-level controller rewrote module-workers'
 * result files with `sed -i` and `cat >` to change their criterion evidence,
 * and the read node settled DONE on evidence the controller had forged. The
 * existing direct-edit detection covered QA's rework only. Claude Code tells
 * a hook whether a tool call comes from the main thread or a subagent
 * (`agent_id`, `agent_type`), so the plugin's PreToolUse hook now fences
 * every with-plugin session:
 *
 *  - the top-level controller (and any subagent that is not
 *    `mycelink:module-worker`) may inspect anything and run Mycelink's CLI,
 *    but never Write/Edit or mutate through Bash a registered repository, a
 *    worker worktree, a result slot or evidence — however the shell spells
 *    it (cd, git -C, redirections, heredocs, sed -i, tee, cp, python, node);
 *    nor run a worker's gates;
 *  - a module-worker may write its worktree and result slot, never a base
 *    checkout or evidence, and never settles;
 *  - reads, the controller's CLI and the control repository's own files
 *    (PRD, graph, a commit of the control repository) pass; outside a
 *    Mycelink workspace the hook does nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { ERRORS, SHOP_FEATURE, createShop, moduleVerifier, shopCli, shopGraph, type Shop } from '../helpers/shop-fixture.js';
import type { ShopTicket } from '../helpers/shop-worker.js';
import { fenceDecision } from '../../src/hooks/fence.js';

afterAll(() => cleanupTmpRoots());

const LAUNCHER = resolve(process.cwd(), 'bin', 'mycelink.mjs');
const WORKER = 'mycelink:module-worker';

let s: Shop;
let t: ShopTicket;
/** The workspace a session runs in: the control repository and the product repository are its children. */
let ws: string;

beforeAll(async () => {
  s = await createShop({ modules: 'structured', graph: shopGraph(moduleVerifier()) });
  const d = JSON.parse((await shopCli(s, ['dispatch', SHOP_FEATURE, '--json'])).out) as { ticket: ShopTicket };
  t = d.ticket;
  ws = s.root;
});

/** Run the plugin's fence hook as Claude Code would, for one tool call from `cwd`. */
function fence(tool: string, input: Record<string, unknown>, who: { agent_id?: string; agent_type?: string } = {}, cwd = ws): { code: number; stderr: string } {
  const payload = { session_id: 's', transcript_path: join(ws, 't.jsonl'), cwd, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: 'toolu_1', ...who };
  const env = { ...process.env, CLAUDE_PROJECT_DIR: ws };
  delete env['MYCELINK_CONTROL_ROOT'];
  delete env['MYCELINK_NODE_ID'];
  const r = spawnSync(process.execPath, [LAUNCHER, 'hook', 'controller-fence'], { input: JSON.stringify(payload), encoding: 'utf8', env, cwd, windowsHide: true });
  return { code: r.status ?? -1, stderr: r.stderr ?? '' };
}
const bash = (command: string, who: { agent_id?: string; agent_type?: string } = {}, cwd = ws) => fence('Bash', { command }, who, cwd);
const slash = (p: string) => p.replace(/\\/g, '/');
/** A path as a command line quotes it: the fixture's root has a space. */
const q = (p: string) => `'${slash(p)}'`;
const worker = { agent_id: 'a0000000000000901', agent_type: WORKER };

describe('the top-level controller never writes product code, a worktree, a result slot or evidence', () => {
  it.each([
    ['Write a worktree file', () => fence('Write', { file_path: join(t.worktree, 'packages', 'errors', 'src', 'index.mjs'), content: 'x' })],
    ['Edit a worktree test', () => fence('Edit', { file_path: join(t.worktree, 'packages', 'errors', 'test', 'errors.test.mjs'), old_string: 'a', new_string: 'b' })],
    ['Write the result slot', () => fence('Write', { file_path: t.result_slot, content: '{}' })],
    ['Write the product repository', () => fence('Write', { file_path: join(s.repo, 'packages', 'errors', 'src', 'index.mjs'), content: 'x' })],
    ['Write a gate log', () => fence('Write', { file_path: join(s.featureDir, 'evidence', ERRORS, `${ERRORS}.red.log`), content: 'x' })],
    ['Write the acceptance manifest', () => fence('Write', { file_path: join(s.featureDir, 'ACCEPTANCE.json'), content: '{}' })],
  ])('%s', (_label, call) => {
    const r = call();
    expect(r.code, r.stderr).toBe(2);
    expect(r.stderr).toMatch(/^Blocked: /);
    expect(r.stderr).toMatch(/controller/);
  });

  it.each([
    ['sed -i on the result slot (the r2 read result)', () => `sed -i 's/invalid changesets > collects/collects/' ${q(t.result_slot)}`],
    ['cat > the result slot through a heredoc (the r2 cli result)', () => `cd ${q(s.control)}; F=${q(t.result_slot)}; cat > "$F" <<'EOF'\n{"schema_version":1}\nEOF`],
    ['a redirection into a worktree after cd', () => `cd ${q(t.worktree)} && echo 'export const x = 1;' > packages/errors/src/x.mjs`],
    ['a commit in a worktree after cd', () => `cd ${q(t.worktree)} && git add -A && git commit -qm wip`],
    ['a commit in a worktree with git -C', () => `git -C ${q(t.worktree)} commit -qm wip`],
    ['a commit in the product repository', () => `git -C ${q(s.repo)} commit --allow-empty -qm wip`],
    ['tee into a worktree', () => `printf 'x' | tee ${q(join(t.worktree, 'packages', 'errors', 'src', 'y.mjs'))}`],
    ['cp over a worktree file', () => `cp /tmp/a.mjs ${q(join(t.worktree, 'packages', 'errors', 'src', 'index.mjs'))}`],
    ['rm a result slot', () => `rm -f ${q(t.result_slot)}`],
    ['python -c writing a worktree file', () => `python3 -c "open('${slash(join(t.worktree, 'packages', 'errors', 'src', 'z.mjs'))}', 'w').write('x')"`],
    ['python fed a script through a heredoc', () => `cd ${q(t.worktree)} && python3 - <<'PY'\nfrom pathlib import Path\nPath('packages/errors/src/w.mjs').write_text('x')\nPY`],
    ['node -e writing the result slot', () => `node -e "require('fs').writeFileSync('${slash(t.result_slot)}', '{}')"`],
    ['a script written by a heredoc and then run', () => `cat > /tmp/fix.mjs <<'EOF'\nimport { writeFileSync } from 'node:fs';\nwriteFileSync('${slash(t.result_slot)}', '{}');\nEOF\nnode /tmp/fix.mjs`],
    ["running a worker's gate", () => t.gate_commands.find((g) => g.gate === 'red')!.command],
  ])('Bash: %s', (_label, command) => {
    const r = bash(command());
    expect(r.code, r.stderr).toBe(2);
    expect(r.stderr).toMatch(/^Blocked: /);
  });

  it('a subagent that is not a module-worker is held to the same fence', () => {
    expect(fence('Write', { file_path: t.result_slot, content: '{}' }, { agent_id: 'a1', agent_type: 'general-purpose' }).code).toBe(2);
  });
});

describe('what the controller may do', () => {
  it.each([
    ['read a worktree file', () => `cat ${q(join(t.worktree, 'packages', 'errors', 'src', 'index.mjs'))}`],
    ['grep a worktree and a result slot', () => `grep -rn "describe(" ${q(join(t.worktree, 'packages'))}; grep -o '"name":"[^"]*"' ${q(t.result_slot)} || true`],
    ['sed -n in a worktree', () => `sed -n 1,20p ${q(join(t.worktree, 'packages', 'errors', 'test', 'errors.test.mjs'))}`],
    ['git log and diff in a worktree', () => `git -C ${q(t.worktree)} log --oneline | head; cd ${q(t.worktree)} && git diff HEAD~1 --stat`],
    ['python reading a worktree file', () => `python3 -c "print(open('${slash(join(t.worktree, 'packages', 'errors', 'src', 'index.mjs'))}').read())"`],
    ['run the controller CLI', () => `cd ${q(s.control)}; node ${q(LAUNCHER)} dispatch ${SHOP_FEATURE} --json --authority k > /tmp/t.json; node ${q(LAUNCHER)} settle ${SHOP_FEATURE} ${ERRORS} --capability ${t.capability} --json`],
    ['commit the control repository', () => `git -C ${q(s.control)} add -A && git -C ${q(s.control)} commit -qm "SHOP-202 plan"`],
    ['write a temporary file', () => `cat > /tmp/gen.mjs <<'EOF'\nconsole.log(1)\nEOF\nnode /tmp/gen.mjs`],
    ["look up a bound test's id", () => `${t.gate_commands.find((g) => g.gate === 'red')!.command.replace(' tdd red ', ' tdd tests ')} --match git`],
  ])('Bash: %s', (_label, command) => {
    const r = bash(command());
    expect(r.code, r.stderr).toBe(0);
  });

  it('Write the PRD and the graph of the control repository', () => {
    expect(fence('Write', { file_path: join(s.featureDir, 'PRD.md'), content: '# PRD' }).code).toBe(0);
    expect(fence('Write', { file_path: join(s.featureDir, 'PLAN.md'), content: '# plan' }).code).toBe(0);
  });

  it('fails closed inside a Mycelink workspace when it cannot judge a call, open outside one', () => {
    const unreadable = { tool_name: 'Bash', tool_input: { command: { toString: () => { throw new Error('unreadable'); } } as unknown as string } };
    expect(fenceDecision({ ...unreadable, cwd: ws }, { CLAUDE_PROJECT_DIR: ws })).toMatchObject({ ok: false, reason: expect.stringMatching(/^Blocked: the Mycelink fence could not judge/) });
    const elsewhere = makeTmpDir('no-mycelink-');
    expect(fenceDecision({ ...unreadable, cwd: elsewhere }, {})).toEqual({ ok: true });
  });

  it('the hook refuses input it cannot read inside a Mycelink workspace, and lets it through outside one', () => {
    const raw = (input: string, cwd: string) => {
      const env = { ...process.env, CLAUDE_PROJECT_DIR: cwd };
      delete env['MYCELINK_CONTROL_ROOT'];
      delete env['MYCELINK_NODE_ID'];
      return spawnSync(process.execPath, [LAUNCHER, 'hook', 'controller-fence'], { input, encoding: 'utf8', env, cwd, windowsHide: true });
    };
    for (const input of ['{not json', '[]', JSON.stringify({ cwd: ws, tool_input: { command: 'true' } })]) {
      const r = raw(input, ws);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/^Blocked: the Mycelink fence could not judge/);
    }
    expect(raw('{not json', makeTmpDir('no-mycelink-')).status).toBe(0);
  });

  it('a feature state it cannot load never lets a write through', () => {
    const corrupt = join(s.featureDir, '..', 'ZZZ-999');
    mkdirSync(corrupt, { recursive: true });
    writeFileSync(join(corrupt, 'STATE.json'), '{corrupt');
    try {
      expect(fence('Write', { file_path: t.result_slot, content: '{}' }).code).toBe(2);
      expect(bash(`sed -i s/a/b/ ${q(join(t.worktree, 'packages', 'errors', 'src', 'index.mjs'))}`).code).toBe(2);
    } finally {
      rmSync(corrupt, { recursive: true, force: true });
    }
  });

  it('does nothing outside a Mycelink workspace', () => {
    const elsewhere = makeTmpDir('no-mycelink-');
    expect(fence('Write', { file_path: join(elsewhere, 'a.txt'), content: 'x' }, {}, elsewhere).code).toBe(0);
    expect(bash(`echo x > ${q(join(elsewhere, 'a.txt'))} && git -C ${q(elsewhere)} status`, {}, elsewhere).code).toBe(0);
  });
});

/**
 * CSET-203 r9: inside a Mycelink workspace the controller writes its own
 * documents — a feature's directory, PRD, plan, graph and E2E scenarios,
 * contracts, handoffs — and commits the control repository; a helper or
 * scratch file belongs under $TMPDIR, outside the workspace. Code whose
 * writes the fence cannot place, and a script it cannot read, are refused
 * before they run (the benchmark's post-session scan stays the authority);
 * what a script only reads is no write, so generating the graph from the
 * approved criteria (as /mycelink:plan asks) passes.
 */
describe('in a Mycelink workspace the controller writes its own documents only', () => {
  const blocked = (r: { code: number; stderr: string }, pattern: RegExp) => {
    expect(r.code, r.stderr).toBe(2);
    expect(r.stderr).toMatch(/^Blocked: /);
    expect(r.stderr).toMatch(pattern);
  };
  it.each([
    ['a helper script in the control repository (Write)', () => fence('Write', { file_path: join(s.control, 'gen.py'), content: 'print(1)' }), /TMPDIR/],
    ['a helper script at the workspace root (Write)', () => fence('Write', { file_path: join(ws, 'gen.py'), content: 'print(1)' }), /TMPDIR/],
    ['a scratch file through a redirection', () => bash(`echo x > ${q(join(s.control, 'notes.txt'))}`), /TMPDIR/],
    ['code writing through a path the fence cannot place', () => bash(`cd ${q(s.control)} && python3 -c "import os; p=os.path.join('features', '${SHOP_FEATURE}', 'ACCEPT' + 'ANCE.json'); open(p, 'w').write('{}')"`), /cannot tell where/],
    ['a shell script it wrote and runs with bash, writing the criteria', () => bash(`cat > /tmp/fix-${process.pid}.sh <<'EOF'\necho '{}' > ${q(join(s.featureDir, 'ACCEPTANCE.json'))}\nEOF\nbash /tmp/fix-${process.pid}.sh`), /only Mycelink writes/],
    ['a script it cannot read, run by an interpreter', () => bash(`python3 /tmp/missing-${process.pid}.py`), /cannot tell where/],
    ['git reset in the control repository', () => bash(`git -C ${q(s.control)} reset --hard -q`), /git add.*git commit/],
    ['the approved requirement', () => fence('Write', { file_path: join(s.control, 'requirements', 'X.md'), content: 'x' }), /approved inputs/],
    ['the configuration', () => bash(`echo '{}' > ${q(join(s.control, 'mycelink.config.json'))}`), /approved inputs/],
    ["a feature's decisions, which Mycelink records", () => fence('Write', { file_path: join(s.featureDir, 'DECISIONS.md'), content: 'x' }), /only Mycelink writes/],
  ])('refused: %s', (_label, call, pattern) => blocked(call(), pattern));

  it.each([
    ["CSET-203 r9's graph generator: it reads the approved criteria, writes the graph and the PRD", () => `cd ${q(s.control)}; mkdir -p /tmp/gen-${process.pid}; cat > /tmp/gen-${process.pid}/gen.py <<'EOF'\nimport json\nacc=json.load(open('features/${SHOP_FEATURE}/ACCEPTANCE.json'))['criteria']\njson.dump({'acceptance_criteria': acc}, open('features/${SHOP_FEATURE}/PORTFOLIO-GRAPH.yaml','w'))\nEOF\npython3 -I /tmp/gen-${process.pid}/gen.py\ncat > features/${SHOP_FEATURE}/PRD.md <<'EOF'\n# PRD\nEOF`],
    ["CSET-203 r6's node graph generator", () => `cd ${q(s.control)} && cat > /tmp/mkgraph-${process.pid}.mjs <<'EOF'\nimport { readFileSync, writeFileSync } from 'node:fs';\nconst acc = JSON.parse(readFileSync('features/${SHOP_FEATURE}/ACCEPTANCE.json', 'utf8'));\nwriteFileSync('features/${SHOP_FEATURE}/PORTFOLIO-GRAPH.yaml', JSON.stringify(acc));\nEOF\nnode /tmp/mkgraph-${process.pid}.mjs`],
    ['a new feature directory', () => `mkdir -p ${q(join(s.control, 'features', 'NEW-1'))}`],
    ['a contract', () => `echo '{}' > ${q(join(s.control, 'contracts', 'order.json'))}`],
  ])('allowed: %s', (_label, command) => {
    const r = bash(command());
    expect(r.code, r.stderr).toBe(0);
  });

  it('an E2E scenario and a contract by Write', () => {
    expect(fence('Write', { file_path: join(s.featureDir, 'e2e', 'E2E-1.yaml'), content: 'x' }).code).toBe(0);
    expect(fence('Write', { file_path: join(s.control, 'handoffs', 'h.md'), content: 'x' }).code).toBe(0);
  });
});

describe('the module-worker owns its worktree and result slot, nothing else', () => {
  it('writes its worktree and result slot, commits there and runs its gates', () => {
    expect(fence('Write', { file_path: join(t.worktree, 'packages', 'errors', 'test', 'errors.test.mjs'), content: 'x' }, worker).code).toBe(0);
    expect(fence('Write', { file_path: t.result_slot, content: '{}' }, worker).code).toBe(0);
    expect(bash(`git -C ${q(t.worktree)} add -A && git -C ${q(t.worktree)} commit -qm "test: RED"`, worker).code).toBe(0);
    expect(bash(t.gate_commands.find((g) => g.gate === 'red')!.command, worker).code).toBe(0);
  });

  it('never writes the base checkout or evidence, and never settles', () => {
    expect(fence('Write', { file_path: join(s.repo, 'packages', 'errors', 'src', 'index.mjs'), content: 'x' }, worker).code).toBe(2);
    expect(fence('Write', { file_path: join(s.featureDir, 'evidence', ERRORS, 'x.log'), content: 'x' }, worker).code).toBe(2);
    expect(bash(`git -C ${q(s.repo)} commit --allow-empty -qm x`, worker).code).toBe(2);
    expect(bash(`node ${q(LAUNCHER)} settle ${SHOP_FEATURE} ${ERRORS} --capability ${t.capability} --json`, worker).code).toBe(2);
  });
});

describe('the plugin registers the fence', () => {
  it('hooks/hooks.json runs it on every file tool, Bash call and subagent launch, from the plugin root', () => {
    const hooks = JSON.parse(readFileSync(join(process.cwd(), 'hooks', 'hooks.json'), 'utf8')) as { hooks: Record<string, { matcher: string; hooks: { type: string; command: string; timeout: number }[] }[]> };
    expect(hooks.hooks['PreToolUse']).toEqual([
      { matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash|Agent|Task', hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" hook controller-fence', timeout: 15 }] },
    ]);
  });
});
