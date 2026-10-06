#!/usr/bin/env node
/**
 * Model-free self-test for the multi-module eval suite. Builds every scenario
 * in fresh temporary directories and proves, without any model usage:
 *
 *   1. scaffolds are deterministic (baseline SHAs match baseline-shas.json)
 *      and leave clean Git repositories;
 *   2. baseline preconditions: existing-* module suites pass; the acceptance
 *      suite fails on exactly the refund behaviour; greenfield fails entirely;
 *   3. existing-cold and existing-informed differ only by knowledge artifacts;
 *   4. the external verifier fails closed on the untouched baseline;
 *   5. the maintainers' reference solution passes acceptance and the verifier
 *      (both existing and greenfield);
 *   6. verifier negative paths: uncommitted code, a tampered acceptance suite,
 *      required-but-missing Mycelink evidence, and fake Mycelink state with a
 *      leaked lease and a live session;
 *   7. the acceptance suite catches a broken cross-process lock (mutant);
 *   8. a genuine Mycelink orchestration of LEDGER-142 (fake Claude workers,
 *      real controller, real worktrees and candidate) verifies end to end,
 *      and a leaked lease or post-candidate drift is rejected;
 *   9. the cases' own regex graders pass on the reference delivery, fail on
 *      the baseline and carry the pristine suite hash; a repository whose git
 *      config would execute programs is refused without running them; every
 *      execution.env key in each case.yaml begins EVAL_; every prompt carries
 *      the exact Mycelink availability-conditional instruction, and the cold
 *      and informed prompts are identical;
 *  10. git-safe classifies .git, commondir, config and info/attributes through
 *      a single open descriptor (no stat-then-read race) and fails closed on
 *      redirected, non-regular or missing git metadata.
 *
 *   node evals-multimodule/tools/selftest.mjs [--write-baseline] [--keep] [--json <file>]
 *
 * --write-baseline regenerates _lib/baseline-shas.json (only after an
 * intentional fixture change). Exit 0 only when every check passes.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Every case prompt must carry this sentence verbatim: it forces plugin use in
// the with arm and is a no-op in the without arm, so one prompt serves both.
const MYCELINK_INSTRUCTION = 'If the Mycelink plugin is available, you must use it to coordinate and deliver the work; if it is not available, proceed directly without it.';
const TOOLS = dirname(fileURLToPath(import.meta.url));
const LIB = resolve(TOOLS, '..', '_lib');
const { scaffold, SCENARIOS, MODULES, git } = await import(pathToFileURL(join(LIB, 'scaffold.mjs')).href);
const { applyReference } = await import(pathToFileURL(join(LIB, 'reference.mjs')).href);
const { runAcceptance, suiteSha256 } = await import(pathToFileURL(join(LIB, 'acceptance', 'run.mjs')).href);
const SUITE = resolve(TOOLS, '..');
const VERIFIER = join(TOOLS, 'verify-workspace.mjs');

const args = process.argv.slice(2);
const writeBaseline = args.includes('--write-baseline');
const keep = args.includes('--keep');
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;

const results = [];
const tempRoots = [];
function record(id, ok, detail = '') {
  results.push({ id, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}${detail ? `  — ${detail}` : ''}`);
  return Boolean(ok);
}
function freshDir(label) {
  const dir = mkdtempSync(join(tmpdir(), `ledger-selftest-${label}-`));
  tempRoots.push(dir);
  return join(dir, 'ws');
}
function verifier(workspace, extra = []) {
  const r = spawnSync(process.execPath, [VERIFIER, '--workspace', workspace, ...extra], { encoding: 'utf8', windowsHide: true, timeout: 900_000 });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = null;
  }
  return { code: r.status, json, stderr: r.stderr };
}
const failedCheck = (v, id) => [...(v.json?.completion?.checks ?? []), ...(v.json?.orchestration?.checks ?? [])].find((c) => c.id === id && !c.ok);
/** Minimal reader for the regex graders in our own case.yaml files. */
function parseRegexGraders(yamlText) {
  const section = yamlText.slice(yamlText.indexOf('\ngraders:\n'));
  return section
    .split(/^  - name: /m)
    .slice(1)
    .map((block) => {
      const field = (k) => new RegExp(`^    ${k}: (.+)$`, 'm').exec(block)?.[1];
      const unquote = (v) => (v && v.startsWith("'") ? v.slice(1, -1).replace(/''/g, "'") : v);
      const target = field('target');
      return {
        name: block.split('\n')[0].trim(),
        type: field('type'),
        target: target?.startsWith('{') ? 'file' : target,
        file: /path: ([^}]+)}/.exec(target ?? '')?.[1]?.trim(),
        pattern: unquote(field('pattern')),
        flags: field('flags') ?? '',
        match: field('match') ?? 'contains',
      };
    })
    .filter((g) => g.type === 'regex');
}

/** Same semantics as the harness: contains | not_contains | count:N. */
/**
 * Keys of execution.env in one of our case.yaml files. `claude plugin eval`
 * accepts only EVAL_* keys there; anything else must come from the operator's
 * shell. Fails closed on a flow-style map or any layout it cannot read.
 */
function parseExecutionEnvKeys(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  const exec = lines.findIndex((l) => /^execution:\s*$/.test(l));
  if (exec < 0) return { ok: false, error: 'no execution block' };
  const keys = [];
  for (let i = exec + 1; i < lines.length && !/^\S/.test(lines[i]); i++) {
    const m = /^(\s+)env:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (m[1].length !== 2) return { ok: false, error: `unexpected env indentation at line ${i + 1}` };
    if (m[2] && !/^(#.*|\{\s*\})$/.test(m[2])) return { ok: false, error: `unsupported inline env at line ${i + 1}` };
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (/^\s*(#.*)?$/.test(l)) continue;
      const indent = /^ */.exec(l)[0].length;
      if (indent <= 2) break;
      const k = /^ {4}("?)([^":\s]+)\1\s*:/.exec(l);
      if (!k) return { ok: false, error: `unreadable env entry at line ${j + 1}` };
      keys.push(k[2]);
    }
  }
  return { ok: true, keys };
}

/**
 * The literal-block execution.prompt of one of our case.yaml files, with the
 * block indentation removed, or null when it cannot be read.
 */
function parsePrompt(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  const start = lines.findIndex((l) => /^ {2}prompt: \|\s*$/.test(l));
  if (start < 0) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') { out.push(''); continue; }
    if (!l.startsWith('    ')) break;
    out.push(l.slice(4));
  }
  return out.join('\n').trim();
}

function evalRegexGrader(g, text) {
  if (g.match.startsWith('count:')) {
    const flags = g.flags.includes('g') ? g.flags : `${g.flags}g`;
    return (text.match(new RegExp(g.pattern, flags)) ?? []).length === Number(g.match.slice(6));
  }
  const found = new RegExp(g.pattern, g.flags).test(text);
  return g.match === 'not_contains' ? !found : found;
}

function listFiles(dir, skipGit = true) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      if (skipGit && name === '.git') continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p).split(sep).join('/'));
    }
  };
  walk(dir);
  return out;
}

// ------------------------------------------------- 0. baseline SHAs ----
if (writeBaseline) {
  const shas = {};
  for (const scenario of SCENARIOS) shas[scenario] = scaffold(freshDir(`base-${scenario}`), scenario, { checkShas: false, runTests: false });
  writeFileSync(join(LIB, 'baseline-shas.json'), JSON.stringify(shas, null, 2) + '\n');
  console.log(`wrote ${join(LIB, 'baseline-shas.json')}`);
}

const EXISTING_BASELINE_PASSING = [
  'C4 every consumer vendors exactly the delivered core, pinned by its lock',
  'O1 orders can be created, fetched and validated',
  'O2 order creation is idempotent across two API processes',
  'O3 capture goes through the worker and emits valid events',
  'O4 a declined capture marks the order payment_failed',
  'O5 captures charge exactly once under concurrent workers and redelivery',
  'O6 the CLI still creates, captures and shows orders',
];

const workspaces = {};
try {
  // ------------------------------------- 1-2. scaffold + preconditions ----
  for (const scenario of SCENARIOS) {
    const ws = freshDir(scenario);
    let shas;
    try {
      const started = Date.now();
      shas = scaffold(ws, scenario);
      record(`${scenario}: scaffold deterministic + clean`, true, `${Date.now() - started} ms, SHAs match baseline-shas.json`);
    } catch (error) {
      record(`${scenario}: scaffold deterministic + clean`, false, error.message.split('\n')[0]);
      continue;
    }
    workspaces[scenario] = ws;
    for (const repo of ['platform', ...MODULES.map((m) => `repos/${m}`)]) {
      const dir = join(ws, ...repo.split('/'));
      const count = git(dir, ['rev-list', '--count', 'HEAD']).stdout;
      const branch = git(dir, ['symbolic-ref', '--short', 'HEAD']).stdout;
      record(`${scenario}: ${repo} is a one-commit repo on main`, count === '1' && branch === 'main', `${count} commit(s) on ${branch}`);
    }
    const out = join(dirname(ws), 'baseline-results');
    const report = await runAcceptance({ workspace: ws, out });
    const passing = report.acceptance?.cases.filter((c) => c.ok).map((c) => c.name) ?? [];
    record(`${scenario}: baseline acceptance verdict FAIL`, report.verdict === 'FAIL', `${report.acceptance?.pass}/${report.acceptance?.tests} passing`);
    record(`${scenario}: suite has 23 acceptance tests`, report.acceptance?.tests === 23);
    if (scenario === 'greenfield') {
      record(`${scenario}: no acceptance test passes on empty repos`, passing.length === 0, passing.join(', '));
      record(`${scenario}: module repos hold only a README`, MODULES.every((m) => listFiles(join(ws, 'repos', m)).join() === 'README.md'));
    } else {
      record(`${scenario}: baseline passes exactly the pre-existing behaviour`, JSON.stringify(passing) === JSON.stringify(EXISTING_BASELINE_PASSING), passing.map((p) => p.split(' ')[0]).join(','));
      record(
        `${scenario}: module suites pass at baseline`,
        MODULES.every((m) => report.modules[m].tests?.exit_code === 0),
        MODULES.map((m) => `${m}=${report.modules[m].tests?.pass}`).join(' '),
      );
    }
    record(`${scenario}: baseline run leaves repos clean`, MODULES.every((m) => git(join(ws, 'repos', m), ['status', '--porcelain']).stdout === ''));
  }

  // ------------------------------------------ 3. cold vs informed diff ----
  if (workspaces['existing-cold'] && workspaces['existing-informed']) {
    const cold = workspaces['existing-cold'];
    const informed = workspaces['existing-informed'];
    const sameModules = MODULES.every((m) => git(join(cold, 'repos', m), ['rev-parse', 'HEAD']).stdout === git(join(informed, 'repos', m), ['rev-parse', 'HEAD']).stdout);
    record('cold vs informed: module repositories identical (same SHAs)', sameModules);
    const a = new Set(listFiles(cold));
    const b = new Set(listFiles(informed));
    const onlyInformed = [...b].filter((f) => !a.has(f));
    const onlyCold = [...a].filter((f) => !b.has(f));
    const changed = [...a].filter((f) => b.has(f) && readFileSync(join(cold, f), 'utf8') !== readFileSync(join(informed, f), 'utf8'));
    const expectedExtra = ['CLAUDE.md', 'platform/docs/ARCHITECTURE.md', 'platform/docs/COMMANDS.md', 'platform/docs/CONTRACTS.md', 'platform/docs/MODULES.md'];
    record(
      'cold vs informed: differ only by knowledge artifacts',
      onlyCold.length === 0 && JSON.stringify(onlyInformed.sort()) === JSON.stringify(expectedExtra) && JSON.stringify(changed) === JSON.stringify(['platform/README.md']),
      `extra=${onlyInformed.join(',')} changed=${changed.join(',')}`,
    );
  }

  // ----------------------------------------- 4. verifier on baseline ----
  for (const scenario of ['greenfield', 'existing-cold']) {
    const ws = workspaces[scenario];
    if (!ws) continue;
    const v = verifier(ws);
    record(`${scenario}: verifier rejects the untouched baseline (exit 1, JSON ok=false)`, v.code === 1 && v.json?.ok === false && v.json?.scenario === scenario, `exit ${v.code}`);
    record(`${scenario}: verifier names the failed acceptance re-run`, Boolean(failedCheck(v, 'acceptance-rerun-pass')) && Boolean(failedCheck(v, 'module-changed:core')));
  }
  {
    const v = verifier(join(tmpdir(), 'ledger-selftest-does-not-exist'));
    record('verifier fails closed on a missing workspace', v.code === 1 && v.json?.ok === false && v.json.errors.length > 0);
    const u = spawnSync(process.execPath, [VERIFIER, '--bogus'], { encoding: 'utf8' });
    record('verifier rejects bad usage with exit 2 and JSON', u.status === 2 && JSON.parse(u.stdout).ok === false);
  }

  // ------------------------------------- 5. reference solution passes ----
  for (const scenario of ['existing-cold', 'greenfield']) {
    const ws = workspaces[scenario];
    if (!ws) continue;
    applyReference(ws, scenario);
    const inRun = spawnSync(process.execPath, [join(ws, 'acceptance', 'run.mjs')], { cwd: ws, encoding: 'utf8', windowsHide: true });
    record(`${scenario}: reference solution passes acceptance in the workspace`, inRun.status === 0, inRun.stdout.split('\n')[0]);
    const v = verifier(ws, ['--scenario', scenario]);
    record(`${scenario}: verifier accepts the reference delivery (exit 0)`, v.code === 0 && v.json?.ok === true && v.json.reporting?.ok === true, `exit ${v.code}${v.json?.errors?.length ? ` ${v.json.errors[0]}` : ''}`);
    if (v.code !== 0) console.log(JSON.stringify(v.json?.completion?.checks?.filter((c) => !c.ok), null, 2));
    const req = verifier(ws, ['--require-mycelink']);
    record(`${scenario}: --require-mycelink fails without Mycelink artifacts`, req.code === 1 && req.json?.completion?.ok === true && Boolean(failedCheck(req, 'control-root-present')));
  }

  // ------------------ 5b. the cases' own graders against real outputs ----
  {
    const trustedSuite = suiteSha256(join(LIB, 'acceptance'));
    const caseFor = { 'existing-cold': 'existing-refunds-cold', greenfield: 'greenfield-refunds', 'existing-informed': 'existing-refunds-informed' };
    for (const name of Object.values(caseFor)) {
      const text = readFileSync(join(SUITE, name, 'case.yaml'), 'utf8');
      record(`${name}: suite hash in graders matches the pristine suite`, text.includes(`^suite_sha256: ${trustedSuite}$`));
      const env = parseExecutionEnvKeys(text);
      const bad = env.ok ? env.keys.filter((k) => !k.startsWith('EVAL_')) : [];
      record(`${name}: every execution.env key begins EVAL_ (harness rejects others)`, env.ok && bad.length === 0, env.ok ? bad.join(', ') : env.error);
    }
    const prompts = {};
    for (const name of Object.values(caseFor)) {
      const prompt = parsePrompt(readFileSync(join(SUITE, name, 'case.yaml'), 'utf8'));
      prompts[name] = prompt;
      const paragraphs = prompt === null ? [] : prompt.split(/\n\s*\n/).map((s) => s.trim());
      record(`${name}: prompt carries the exact Mycelink availability-conditional instruction once`, paragraphs.filter((s) => s === MYCELINK_INSTRUCTION).length === 1 && prompt.split(MYCELINK_INSTRUCTION).length === 2);
    }
    record('cold vs informed: prompts identical', prompts['existing-refunds-cold'] !== null && prompts['existing-refunds-cold'] === prompts['existing-refunds-informed']);
    const body = (name) => readFileSync(join(SUITE, name, 'case.yaml'), 'utf8').replace(/^#.*\n/gm, '').replace(/^(name|tags):.*\n/gm, '').replace(/^description: >-\n(  .*\n)+/m, '');
    record('cold vs informed: case.yaml identical apart from name, description, tags and comments', body('existing-refunds-cold') === body('existing-refunds-informed'));
    for (const scenario of ['existing-cold', 'greenfield']) {
      const ws = workspaces[scenario];
      if (!ws) continue;
      const graders = parseRegexGraders(readFileSync(join(SUITE, caseFor[scenario], 'case.yaml'), 'utf8'));
      const fileGraders = graders.filter((g) => g.file);
      const verdicts = fileGraders.map((g) => [g.name, evalRegexGrader(g, readFileSync(join(ws, ...g.file.split('/')), 'utf8'))]);
      record(`${caseFor[scenario]}: every file grader passes on the reference delivery`, verdicts.length >= 5 && verdicts.every(([, ok]) => ok), verdicts.filter(([, ok]) => !ok).map(([n]) => n).join(','));
      const baselineSummary = readFileSync(join(dirname(ws), 'baseline-results', 'SUMMARY.txt'), 'utf8');
      const verdictGrader = fileGraders.find((g) => g.name === 'acceptance-verdict-pass');
      record(`${caseFor[scenario]}: verdict grader fails on the baseline`, verdictGrader && !evalRegexGrader(verdictGrader, baselineSummary));
      const good = 'Done. QA acceptance verdict: PASS (23/23).\n- core 1a2b3c4d\n- api 2b3c4d5e\n- worker 3c4d5e6f\n- cli 4d5e6f70';
      const msgGraders = graders.filter((g) => g.target === 'last_message');
      record(`${caseFor[scenario]}: summary graders accept a good final message and reject an empty one`, msgGraders.length === 2 && msgGraders.every((g) => evalRegexGrader(g, good) && !evalRegexGrader(g, 'All done!')));
      const trace = graders.find((g) => g.name === 'did-not-read-reference-solution');
      record(`${caseFor[scenario]}: contamination grader flags a read of the reference solution`, trace && !evalRegexGrader(trace, '{"tool":"Read","file_path":"C:\\\\x\\\\evals-multimodule\\\\_lib\\\\reference-solution\\\\api\\\\src\\\\refunds.mjs"}') && evalRegexGrader(trace, '{"tool":"Read","file_path":"repos/api/src/app.mjs"}'));
    }
  }

  // ------------------------------------------- 6. negative paths ----
  const ws = workspaces['existing-cold'];
  if (ws) {
    const stray = join(ws, 'repos', 'api', 'src', 'wip.mjs');
    writeFileSync(stray, 'export const wip = true;\n');
    let v = verifier(ws);
    record('negative: uncommitted code is rejected', v.code === 1 && Boolean(failedCheck(v, 'no-uncommitted-code:api')));
    rmSync(stray);

    const testFile = join(ws, 'acceptance', 'tests', '03-refunds-api.test.mjs');
    const original = readFileSync(testFile, 'utf8');
    appendFileSync(testFile, '\n// weakened\n');
    v = verifier(ws);
    record('negative: a tampered acceptance suite is rejected', v.code === 1 && Boolean(failedCheck(v, 'acceptance-suite-untampered')));
    writeFileSync(testFile, original);

    // Hand-made Mycelink state in the real { revision, data } envelope.
    const featureDir = join(ws, 'platform', 'features', 'LEDGER-142');
    mkdirSync(join(featureDir, 'sessions'), { recursive: true });
    writeFileSync(join(ws, 'platform', 'mycelink.config.json'), '{}\n');
    const doc = (data) => JSON.stringify({ revision: 3, data });
    writeFileSync(
      join(featureDir, 'STATE.json'),
      doc({ schema_version: 1, feature_id: 'LEDGER-142', feature_state: 'RUNNING', graph_hash: '0'.repeat(64), nodes: { 'LEDGER-142.api.refunds.impl': { state: 'GREEN_PENDING', evidence: {} } }, current_candidate: null }),
    );
    writeFileSync(join(featureDir, 'leases.json'), doc({ schema_version: 1, leases: [{ lease_id: 'l1', resource: 'full-runtime', node_id: 'n', owner: 'o', pid: process.pid, host: 'h', acquired_at: new Date().toISOString(), ttl_ms: 1 }], known_resources: [] }));
    writeFileSync(join(featureDir, 'sessions', 'registry.json'), doc({ schema_version: 1, sessions: { s1: { session_id: 's1', status: 'working', pid: process.pid } } }));
    v = verifier(ws, ['--require-mycelink']);
    const ids = ['nodes-done:LEDGER-142', 'no-leaked-leases:LEDGER-142', 'no-live-sessions:LEDGER-142', 'candidate-recorded:LEDGER-142', 'feature-verify:LEDGER-142'];
    record('negative: incomplete Mycelink state, leaked lease and live session are each reported', v.code === 1 && ids.every((id) => failedCheck(v, id)), ids.filter((id) => !failedCheck(v, id)).join(','));
    // A lease file without the envelope must not read as "no leases".
    writeFileSync(join(featureDir, 'leases.json'), JSON.stringify({ leases: [] }));
    v = verifier(ws, ['--require-mycelink']);
    record('negative: an unrecognised lease document fails closed', v.code === 1 && Boolean(failedCheck(v, 'no-leaked-leases:LEDGER-142')));
    const notRequired = verifier(ws);
    record('negative: same workspace without --require-mycelink still verifies completion', notRequired.code === 0 && notRequired.json?.orchestration?.ok === false);
    rmSync(join(ws, 'platform', 'features'), { recursive: true, force: true });
    rmSync(join(ws, 'platform', 'mycelink.config.json'));

    // A repository whose own git config would execute a program.
    const marker = join(dirname(ws), 'filter-ran.txt');
    const workerRepo = join(ws, 'repos', 'worker');
    const cfgPath = join(workerRepo, '.git', 'config');
    const cfg = readFileSync(cfgPath, 'utf8');
    const script = join(dirname(ws), 'evil-filter.cjs');
    writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); process.stdin.pipe(process.stdout);\n`);
    appendFileSync(cfgPath, `[filter "evil"]\n\tclean = node "${script.replace(/\\/g, '/')}"\n\tsmudge = node "${script.replace(/\\/g, '/')}"\n[core]\n\tfsmonitor = node "${script.replace(/\\/g, '/')}"\n`);
    writeFileSync(join(workerRepo, '.gitattributes'), '* filter=evil\n');
    v = verifier(ws);
    const inRunEvil = spawnSync(process.execPath, [join(ws, 'acceptance', 'run.mjs')], { cwd: ws, encoding: 'utf8', windowsHide: true });
    record(
      'negative: repository git config that would execute programs is refused, never run',
      v.code === 1 && Boolean(failedCheck(v, 'git-config-safe:worker')) && inRunEvil.status === 1 && /unsafe git configuration/.test(inRunEvil.stdout) && !existsSync(marker),
      existsSync(marker) ? 'the filter/fsmonitor program RAN' : `verifier exit ${v.code}, runner exit ${inRunEvil.status}`,
    );
    writeFileSync(cfgPath, cfg);
    rmSync(join(workerRepo, '.gitattributes'));

    // History rewrite: re-create core from scratch with the same content.
    const coreHead = git(join(ws, 'repos', 'core'), ['rev-parse', 'HEAD']).stdout;
    git(join(ws, 'repos', 'core'), ['checkout', '--quiet', '--orphan', 'rewritten']);
    git(join(ws, 'repos', 'core'), ['commit', '--quiet', '-m', 'squashed'], { time: Date.parse('2026-10-02T00:00:00Z') });
    v = verifier(ws);
    record('negative: rewritten history (baseline not an ancestor) is rejected', v.code === 1 && Boolean(failedCheck(v, 'history-preserved:core')));
    git(join(ws, 'repos', 'core'), ['checkout', '--quiet', '--force', coreHead]);
  }

  // ------------- 6b. git-safe reads git metadata through one descriptor ----
  {
    const { gitDirs, readEntry, unsafeGitConfig } = await import(pathToFileURL(join(LIB, 'acceptance', 'lib', 'git-safe.mjs')).href);
    const root = dirname(freshDir('gitsafe'));
    const evilConfig = '[core]\n\trepositoryformatversion = 0\n\tfsmonitor = node evil.cjs\n';
    const repo = join(root, 'repo');
    const real = join(root, 'real-gitdir');
    mkdirSync(repo, { recursive: true });
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, 'config'), evilConfig);

    writeFileSync(join(repo, '.git'), `gitdir: ${real}\n`);
    record('git-safe: a .git file redirecting to a gitdir with an executing config is refused', unsafeGitConfig(repo).includes('core.fsmonitor'), JSON.stringify(unsafeGitConfig(repo)));

    rmSync(join(repo, '.git'));
    mkdirSync(join(repo, '.git'));
    writeFileSync(join(repo, '.git', 'config'), evilConfig);
    const asDir = gitDirs(repo);
    record('git-safe: .git as a directory is classified by the open descriptor and still refused', asDir?.gitDir === join(repo, '.git') && unsafeGitConfig(repo).includes('core.fsmonitor'));

    rmSync(join(repo, '.git', 'config'));
    mkdirSync(join(repo, '.git', 'config'));
    record('git-safe: a config path that is not a regular file fails closed', unsafeGitConfig(repo).some((p) => /not a regular file/.test(p)), JSON.stringify(unsafeGitConfig(repo)));
    rmSync(join(repo, '.git'), { recursive: true });

    writeFileSync(join(repo, '.git'), `gitdir: ${real}\n`);
    mkdirSync(join(real, 'commondir'));
    record('git-safe: a commondir that is not a regular file fails closed', gitDirs(repo) === null && unsafeGitConfig(repo).includes('<no git directory>'));
    rmSync(join(real, 'commondir'), { recursive: true });

    writeFileSync(join(repo, '.git'), 'not a gitdir pointer\n');
    record('git-safe: a .git file without a gitdir pointer fails closed', unsafeGitConfig(repo).includes('<no git directory>'));
    rmSync(join(repo, '.git'));
    record('git-safe: a missing .git fails closed', unsafeGitConfig(repo).includes('<no git directory>') && readEntry(join(repo, '.git')).kind === 'missing');

    // A symlinked .git pointer is still followed and inspected, not skipped.
    const pointer = join(root, 'pointer');
    writeFileSync(pointer, `gitdir: ${real}\n`);
    let linked = true;
    try {
      symlinkSync(pointer, join(repo, '.git'), 'file');
    } catch {
      linked = false;
    }
    if (linked) record('git-safe: a symlinked .git pointer is followed and the executing config refused', unsafeGitConfig(repo).includes('core.fsmonitor'));
  }

  // ------------------- 8. genuine Mycelink orchestration (host dispatch) ----
  {
    const ows = freshDir('mycelink');
    const { buildOrchestratedWorkspace, FEATURE } = await import(pathToFileURL(join(TOOLS, 'mycelink-fixture.mjs')).href);
    let built = null;
    try {
      // The plugin's primary path: dispatch tickets, a deterministic Agent, settle, deliver.
      built = buildOrchestratedWorkspace(ows, { mode: 'host' });
      record(
        'mycelink: host-dispatch orchestration of LEDGER-142 settles and delivers',
        built.report.stop_reason === 'ALL_SETTLED' && built.delivery.status === 'ACCEPTED',
        `${built.report.stop_reason} / ${built.delivery.status}`,
      );
    } catch (error) {
      record('mycelink: host-dispatch orchestration of LEDGER-142 settles and delivers', false, error.message.split('\n')[0]);
    }
    if (built) {
      record(
        'mycelink: delivery moved every module main to exactly the candidate',
        MODULES.every((m) => built.delivery.repositories?.[m]?.after === git(join(ows, 'repos', m), ['rev-parse', 'main']).stdout),
      );
    }
    if (built) {
      spawnSync(process.execPath, [join(ows, 'acceptance', 'run.mjs')], { cwd: ows, encoding: 'utf8', windowsHide: true });
      let v = verifier(ows, ['--require-mycelink']);
      record(
        'mycelink: verifier accepts genuine artifacts (completion + orchestration + reporting)',
        v.code === 0 && v.json?.completion?.ok && v.json?.orchestration?.ok && v.json?.reporting?.ok,
        [...(v.json?.completion?.checks ?? []), ...(v.json?.orchestration?.checks ?? [])].filter((c) => !c.ok && c.severity !== 'warning').map((c) => c.id).join(',') || `exit ${v.code}`,
      );
      const f = v.json?.evidence?.mycelink?.features?.[0];
      record('mycelink: candidate binds all four modules at the delivered SHAs', f?.candidate_matches_delivery?.matches?.length === 4 && f.candidate_matches_delivery.mismatches.length === 0);
      record('mycelink: worker usage is reported for cost accounting', (v.json?.evidence?.mycelink?.usage?.sessions ?? 0) >= 4, JSON.stringify(v.json?.evidence?.mycelink?.usage));

      const bin = join(TOOLS, '..', '..', 'bin', 'mycelink.mjs');
      spawnSync(process.execPath, [bin, 'resource', 'acquire', FEATURE, 'full-runtime', '--node', 'stray', '--control-root', join(ows, 'platform')], { encoding: 'utf8' });
      v = verifier(ows, ['--require-mycelink']);
      // `mycelink feature verify` ignores a lease whose holder process has
      // exited (it is reclaimable); the verifier counts any unreleased lease.
      record('mycelink: a genuinely leaked (unreleased) lease is rejected', v.code === 1 && Boolean(failedCheck(v, `no-leaked-leases:${FEATURE}`)), failedCheck(v, `no-leaked-leases:${FEATURE}`)?.detail ?? `exit ${v.code}`);
      spawnSync(process.execPath, [bin, 'resource', 'release', FEATURE, 'node:stray', '--control-root', join(ows, 'platform')], { encoding: 'utf8' });

      const api = join(ows, 'repos', 'api');
      writeFileSync(join(api, 'src', 'late-change.mjs'), 'export const late = true;\n');
      git(api, ['add', '--all']);
      git(api, ['commit', '--quiet', '-m', 'late change outside the candidate'], { time: Date.parse('2026-10-03T00:00:00Z') });
      v = verifier(ows, ['--require-mycelink']);
      record('mycelink: delivery that drifted from the candidate is rejected', v.code === 1 && v.json?.completion?.ok === true && Boolean(failedCheck(v, `candidate-equals-delivery:${FEATURE}`)));
    }

    // The optional standalone CLI adapter (nested fake `claude -p` workers).
    const aws = freshDir('mycelink-adapter');
    try {
      const adapter = buildOrchestratedWorkspace(aws, { mode: 'adapter' });
      record(
        'mycelink: standalone-adapter orchestration settles and delivers',
        adapter.report.stop_reason === 'ALL_SETTLED' && adapter.delivery.status === 'ACCEPTED',
        `${adapter.report.stop_reason} / ${adapter.delivery.status}`,
      );
    } catch (error) {
      record('mycelink: standalone-adapter orchestration settles and delivers', false, error.message.split('\n')[0]);
    }
  }

  // ---------------------------------------------- 7. lock mutant ----
  {
    const mws = freshDir('mutant');
    scaffold(mws, 'existing-cold', { runTests: false });
    applyReference(mws, 'existing-cold');
    const store = join(mws, 'repos', 'core', 'src', 'store.mjs');
    const text = readFileSync(store, 'utf8');
    const mutated = text.replace(/async withLock\(name, fn, \{ timeoutMs = 15_000 \} = \{\}\) \{/, 'async withLock(name, fn) {\n    return fn();');
    record('mutant: lock removal applied', mutated !== text);
    writeFileSync(store, mutated);
    git(join(mws, 'repos', 'core'), ['commit', '--quiet', '-am', 'mutant: no lock'], { time: Date.parse('2026-10-02T00:00:00Z') });
    for (const name of ['api', 'worker', 'cli']) {
      spawnSync(process.execPath, [join(mws, 'repos', name, 'scripts', 'sync-core.mjs'), join(mws, 'repos', 'core')], { encoding: 'utf8' });
      git(join(mws, 'repos', name), ['commit', '--quiet', '-am', 'mutant'], { time: Date.parse('2026-10-02T00:00:00Z') });
    }
    const report = await runAcceptance({ workspace: mws, out: join(dirname(mws), 'mutant-results') });
    const failing = report.acceptance?.cases.filter((c) => !c.ok).map((c) => c.name.split(' ')[0]) ?? [];
    const concurrency = ['O2', 'O5', 'R5', 'R6', 'W2'];
    record('mutant: acceptance catches missing cross-process locking', report.verdict === 'FAIL' && failing.some((f) => concurrency.includes(f)), `failing: ${failing.join(',')}`);
  }
} catch (error) {
  record('selftest crashed', false, error?.stack ?? String(error));
} finally {
  if (keep) console.log(`kept: ${tempRoots.join(' ')}`);
  else for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

const failed = results.filter((r) => !r.ok);
const summary = { ok: failed.length === 0, passed: results.length - failed.length, failed: failed.length, results, node: process.version, platform: `${process.platform}-${process.arch}` };
if (jsonOut) writeFileSync(resolve(jsonOut), JSON.stringify(summary, null, 2) + '\n');
console.log(`\n${summary.passed} passed, ${summary.failed} failed`);
process.exitCode = summary.ok ? 0 : 1;
