/**
 * Who ran the call that changed the shared Git state (CSET-203 r12).
 *
 * r12's module-worker ran `git stash` in its own worktree; worktrees share
 * their repository's stash, so `refs/stash` moved in the common Git
 * directory, and the benchmark, with no record of which actor's call moved
 * it, took it for the controller's. With MYCELINK_PROVENANCE naming the
 * ledger, the plugin's hooks now record every Bash call — the controller's
 * and every subagent's — before it runs (PreToolUse) and after
 * (PostToolUse, PostToolUseFailure): the session, the subagent, the tool use,
 * the command's hash (never the command), the hook's process and its parent,
 * wall and monotonic times, and the shared Git state of every registered
 * repository as it stood (refs, per-worktree refs, the stash's reflog with
 * its bytes kept, each worktree's HEAD). A module-worker's call is bound to
 * the claim it was launched for, through Claude Code's own record of the
 * subagent (its meta's tool use id) and the launch record the hook made at
 * the host's Agent call: the claim's worktree, branch, repository and common
 * Git directory. A worker's end (SubagentStop, or its foreground Agent
 * call's end) is recorded too. Nothing is recorded outside a Mycelink
 * workspace or without the ledger, and the after-hooks never block or print.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { git } from '../helpers/git-fixture.js';
import { ERRORS, SHOP_FEATURE, createShop, moduleVerifier, shopCli, shopGraph, type Shop } from '../helpers/shop-fixture.js';
import type { ShopTicket } from '../helpers/shop-worker.js';
import { runLauncher } from '../helpers/launcher-process.js';

afterAll(() => cleanupTmpRoots());

const LAUNCHER = resolve(process.cwd(), 'bin', 'mycelink.mjs');
const WORKER = 'mycelink:module-worker';
const SESSION = '00000000-0000-4000-8000-000000005c01';
const AGENT = 'a0000000000000c01';
const LAUNCH = 'toolu_worker_calls_launch';

let s: Shop;
let t: ShopTicket;
let home: string;
let ledger: string;
let transcript: string;

beforeAll(async () => {
  s = await createShop({ modules: 'structured', graph: shopGraph(moduleVerifier()) });
  t = (JSON.parse((await shopCli(s, ['dispatch', SHOP_FEATURE, '--json'])).out) as { ticket: ShopTicket }).ticket;
  home = makeTmpDir('calls-home-');
  ledger = join(home, '.mycelink-provenance');
  const project = join(home, '.claude', 'projects', 'p');
  transcript = join(project, `${SESSION}.jsonl`);
  mkdirSync(join(project, SESSION, 'subagents'), { recursive: true });
  writeFileSync(transcript, '');
  // Claude Code's own record of the subagent: its type and the Agent call that launched it.
  writeFileSync(join(project, SESSION, 'subagents', `agent-${AGENT}.meta.json`), JSON.stringify({ agentType: WORKER, description: ERRORS, toolUseId: LAUNCH }));
});

/** Run one of the plugin's hooks as Claude Code would. */
function hook(event: string, payload: Record<string, unknown>, env: Record<string, string | undefined> = {}): { code: number; stdout: string; stderr: string } {
  const e: Record<string, string | undefined> = { ...process.env, CLAUDE_PROJECT_DIR: s.root, MYCELINK_PROVENANCE: ledger, ...env };
  delete e['MYCELINK_CONTROL_ROOT'];
  delete e['MYCELINK_NODE_ID'];
  const r = runLauncher([LAUNCHER, 'hook', event], { input: JSON.stringify({ session_id: SESSION, transcript_path: transcript, cwd: s.root, ...payload }), env: e as NodeJS.ProcessEnv, cwd: s.root });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
const pre = (tool: string, input: Record<string, unknown>, id: string, who: Record<string, string> = {}, env: Record<string, string | undefined> = {}) => hook('controller-fence', { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: id, ...who }, env);
const post = (tool: string, input: Record<string, unknown>, id: string, who: Record<string, string> = {}, event = 'PostToolUse') => hook('tool-end', { hook_event_name: event, tool_name: tool, tool_input: input, tool_use_id: id, tool_response: { stdout: 'x' }, ...who });
const calls = (): any[] => (existsSync(join(ledger, 'calls.jsonl')) ? readFileSync(join(ledger, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const worker = { agent_id: AGENT, agent_type: WORKER };
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const common = () => resolve(s.repo, '.git');

describe('every Bash call is recorded before and after it runs, with the shared Git state as it stood', () => {
  it('the host launches a module-worker for its ticket: the launch is recorded with the dispatch it names', () => {
    const r = pre('Agent', { subagent_type: WORKER, description: ERRORS, prompt: t.prompt }, LAUNCH);
    expect(r.code, r.stderr).toBe(0);
    const start = calls().find((c) => c.kind === 'agent-start' && c.tool_use_id === LAUNCH);
    expect(start).toMatchObject({ session_id: SESSION, subagent_type: WORKER, dispatch_id: t.dispatch_id, prompt_sha256: sha(t.prompt) });
  });

  it('a worker’s git stash: before, the stash as it was; after, the entry it made — bound to its claim, worktree, branch and repository', () => {
    const command = `git -C '${t.worktree.replace(/\\/g, '/')}' stash push -m "set the draft aside"`;
    writeFileSync(join(t.worktree, 'packages', 'errors', 'src', 'index.mjs'), 'export const draft = 1;\n');
    expect(pre('Bash', { command }, 'toolu_w1', worker).code).toBe(0);
    git(t.worktree, ['stash', 'push', '-q', '-m', 'set the draft aside']);
    const entry = git(t.worktree, ['rev-parse', 'refs/stash']);
    const end = post('Bash', { command }, 'toolu_w1', worker);
    expect(end).toEqual({ code: 0, stdout: '', stderr: '' });
    const [start, done] = calls().filter((c) => c.tool_use_id === 'toolu_w1');
    expect(start).toMatchObject({ kind: 'call-start', role: 'worker', tool: 'Bash', session_id: SESSION, agent_id: AGENT, agent_type: WORKER, command_sha256: sha(command), background: false, pid: expect.any(Number), ppid: expect.any(Number) });
    expect(start.t).toMatch(/^\d+$/);
    expect(start.t_mono).toMatch(/^\d+$/);
    expect(start.worker).toMatchObject({ feature_id: SHOP_FEATURE, node_id: ERRORS, claim_id: t.claim_id, dispatch_id: t.dispatch_id, launch_tool_use_id: LAUNCH, worktree: resolve(t.worktree), branch: `wip/${SHOP_FEATURE}/shop.errors.impl`, repository: 'shop', common_dir: common() });
    expect(start.worker.capability_sha256).toMatch(/^[0-9a-f]{64}$/);
    // The command is never kept, only its hash.
    expect(JSON.stringify(calls())).not.toContain('set the draft aside');
    expect(start.git[common()].refs['refs/stash']).toBeUndefined();
    expect(start.git[common()].stash_log).toBeNull();
    expect(start.git[common()].heads).toMatchObject({ [`shop__${ERRORS}`]: `ref: refs/heads/wip/${SHOP_FEATURE}/shop.errors.impl` });
    expect(done).toMatchObject({ kind: 'call-end', event: 'PostToolUse', role: 'worker', tool_use_id: 'toolu_w1', agent_id: AGENT });
    expect(done.git[common()].refs['refs/stash']).toBe(entry);
    // The stash's reflog, its bytes kept beside the ledger: what each entry is, line by line.
    const log = readFileSync(join(s.repo, '.git', 'logs', 'refs', 'stash'));
    expect(done.git[common()].stash_log).toMatchObject({ sha256: sha(log.toString('latin1')), size: log.length, kept: true });
    expect(readFileSync(join(ledger, 'objects', done.git[common()].stash_log.sha256.slice(0, 2), done.git[common()].stash_log.sha256))).toEqual(log);
    expect(BigInt(done.t_mono) > BigInt(start.t_mono)).toBe(true);
    git(t.worktree, ['stash', 'pop', '-q']);
  });

  it('the controller’s own call is recorded as the controller’s, bound to nothing; a failed call ends with PostToolUseFailure', () => {
    expect(pre('Bash', { command: 'git status' }, 'toolu_c1').code).toBe(0);
    expect(post('Bash', { command: 'git status' }, 'toolu_c1', {}, 'PostToolUseFailure').code).toBe(0);
    const [start, done] = calls().filter((c) => c.tool_use_id === 'toolu_c1');
    expect(start).toMatchObject({ kind: 'call-start', role: 'controller', agent_id: null, worker: null });
    expect(done).toMatchObject({ kind: 'call-end', event: 'PostToolUseFailure', role: 'controller' });
  });

  it('a background Bash call is marked so: its process may outlive the call', () => {
    expect(pre('Bash', { command: 'sleep 1', run_in_background: true }, 'toolu_bg').code).toBe(0);
    expect(calls().find((c) => c.tool_use_id === 'toolu_bg')).toMatchObject({ kind: 'call-start', background: true });
  });

  it('a call the fence blocks never ran: nothing is recorded for it', () => {
    const before = calls().length;
    const r = pre('Bash', { command: `git -C '${s.repo.replace(/\\/g, '/')}' stash` }, 'toolu_blocked');
    expect(r.code).toBe(2);
    expect(calls().length).toBe(before);
  });

  it('a subagent whose own record cannot be found is a worker bound to nothing, and says why', () => {
    expect(pre('Bash', { command: 'git status' }, 'toolu_w2', { agent_id: 'a000000000000dead', agent_type: WORKER }).code).toBe(0);
    const start = calls().find((c) => c.tool_use_id === 'toolu_w2');
    expect(start).toMatchObject({ role: 'worker', worker: null, worker_problem: expect.stringMatching(/meta/) });
  });

  it('a worker’s end is recorded from SubagentStop, and from its foreground Agent call’s end', () => {
    expect(hook('subagent-end', { hook_event_name: 'SubagentStop', ...worker, stop_hook_active: false })).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(post('Agent', { subagent_type: WORKER, prompt: t.prompt }, LAUNCH).code).toBe(0);
    const ends = calls().filter((c) => c.kind === 'agent-end');
    expect(ends).toEqual([expect.objectContaining({ event: 'SubagentStop', agent_id: AGENT, agent_type: WORKER }), expect.objectContaining({ event: 'PostToolUse', tool_use_id: LAUNCH, async: false })]);
  });

  it('no session writes the ledger itself — the controller’s or a worker’s call: only the hooks and Mycelink’s core do', () => {
    const before = calls().length;
    for (const who of [{}, worker]) {
      for (const command of [`echo '{}' >> '${join(ledger, 'calls.jsonl').replace(/\\/g, '/')}'`, `rm -rf '${ledger.replace(/\\/g, '/')}'`]) {
        const r = pre('Bash', { command }, 'toolu_ledger', who);
        expect(r.code, command).toBe(2);
        expect(r.stderr).toMatch(/^Blocked: .*provenance ledger/);
      }
    }
    expect(pre('Write', { file_path: join(ledger, 'ledger.jsonl'), content: '' }, 'toolu_ledger_w').code).toBe(2);
    expect(calls().length).toBe(before);
  });

  it('nothing is recorded without the ledger, or outside a Mycelink workspace', () => {
    const before = calls().length;
    expect(pre('Bash', { command: 'git status' }, 'toolu_n1', {}, { MYCELINK_PROVENANCE: undefined }).code).toBe(0);
    const outside = makeTmpDir('calls-outside-');
    const r = runLauncher([LAUNCHER, 'hook', 'tool-end'], { input: JSON.stringify({ session_id: SESSION, transcript_path: transcript, cwd: outside, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'toolu_n2' }), env: { ...process.env, CLAUDE_PROJECT_DIR: outside, MYCELINK_PROVENANCE: ledger }, cwd: outside });
    expect(r.status).toBe(0);
    expect(calls().length).toBe(before);
    rmSync(outside, { recursive: true, force: true });
  });
});

describe('the plugin registers the after-hooks', () => {
  it('hooks/hooks.json records every Bash and Agent call’s end, failed or not, and every subagent’s stop', () => {
    const hooks = JSON.parse(readFileSync(join(process.cwd(), 'hooks', 'hooks.json'), 'utf8')) as { hooks: Record<string, unknown> };
    const end = [{ matcher: 'Bash|Agent|Task', hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" hook tool-end', timeout: 15 }] }];
    expect(hooks.hooks['PostToolUse']).toEqual(end);
    expect(hooks.hooks['PostToolUseFailure']).toEqual(end);
    expect(hooks.hooks['SubagentStop']).toEqual([{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" hook subagent-end', timeout: 15 }] }]);
  });
});
