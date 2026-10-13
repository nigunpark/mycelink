/**
 * The with arm's controller sessions as transactions, end to end on the toy
 * (CSET-203 r9): a stand-in Mycelink host whose controller changes the
 * workspace itself where the plugin's fence never sees it. The harness finds
 * what it changed by the workspace, not the transcript; rolls back exactly
 * that (or, when Mycelink may have read it, the whole session), verifies the
 * rollback, and starts a fresh corrective session told that nothing is left
 * to clean up — whose first action is `/mycelink:run` — which completes the
 * feature through Mycelink. Two independent violations get two corrective
 * sessions; an identical repeat ends the phase.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { TEST_ISOLATION } from './isolation-fixture.js';
import { REPO_ROOT } from '../helpers/global-setup.js';
import { TOY, TOY_PRD, preparedToy, type Toy } from './toy-fixture.js';
// @ts-expect-error -- plain ESM module without type declarations
import { runArm } from '../../evals-public-projects/lib/arms.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { TASK_CORRECTIVE_PROMPT } from '../../evals-public-projects/lib/faults.mjs';

afterAll(() => cleanupTmpRoots());

const FAKE_HOST = join(REPO_ROOT, 'tests', 'benchmark', 'fake-mycelink-host.mjs');
const AGENT_TESTS = Object.fromEntries(Object.entries(TOY.referenceTests).map(([p, body]) => [p, `// written by the agent\n${body}`]));
let toy: Toy;
let echo: net.Server;
let PROXY: { allowed: string; denied: string };

beforeAll(async () => {
  ({ toy } = await preparedToy());
  echo = net.createServer((c) => c.end('echo'));
  await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()));
  PROXY = { allowed: `127.0.0.1:${(echo.address() as net.AddressInfo).port}`, denied: 'example.invalid:443' };
}, 300_000);
afterAll(() => echo?.close());

function hostPlan(extra: Record<string, unknown> = {}) {
  const dir = makeTmpDir('bench-rb-host-');
  const log = join(dir, 'log.jsonl');
  writeFileSync(log, '');
  const file = join(dir, 'plan.json');
  const work = {
    'mod-a': { tests: { 'mod-a/test/reserve.test.mjs': AGENT_TESTS['mod-a/test/reserve.test.mjs'] }, impl: { 'mod-a/src/stock.mjs': TOY.referenceCode['mod-a/src/stock.mjs'] } },
    'mod-b': { tests: { 'mod-b/test/place.test.mjs': AGENT_TESTS['mod-b/test/place.test.mjs'] }, impl: { 'mod-b/src/orders.mjs': TOY.referenceCode['mod-b/src/orders.mjs'] } },
  };
  // A host that runs no plugin hook: what the controller does lands, as a script the fence could not read did in r9.
  writeFileSync(file, JSON.stringify({ log, work, regression: {}, hooks: false, ...extra }));
  return { dir, file, entries: () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
}

const run = (fake: { dir: string; file: string }, options: { lightCheckMs?: number } = {}) =>
  runArm({
    suiteRoot: toy.suite,
    caseKey: TOY_PRD,
    arm: 'with',
    outDir: join(makeTmpDir('bench-rb-run-'), 'run'),
    cacheRoot: toy.cacheRoot,
    claude: [process.execPath, FAKE_HOST],
    pollMs: 100,
    lightCheckMs: options.lightCheckMs ?? 300,
    env: { FAKE_CLAUDE_PLAN: fake.file },
    isolation: TEST_ISOLATION,
    sessionBinds: [{ path: fake.dir, rw: true }],
    preflightProxy: PROXY,
    proxyAllow: ['api.anthropic.com:443', PROXY.allowed],
    requireMycelink: true,
    requireTdd: true,
  });

const failingOf = (v: any) => Object.entries(v.sections).flatMap(([name, s]: [string, any]) => (s?.checks ?? []).filter((c: any) => !c.ok && c.severity !== 'warning').map((c: any) => `${name}:${c.id}`));
const shape = (r: any) => r.sessions.map((s: any) => [s.index, s.purpose, s.ended_by, s.corrects ?? null, Boolean(s.violation)]);

/** The corrective session completed the feature through Mycelink, the violation recovered and on the record. */
function recovered(r: any, fake: ReturnType<typeof hostPlan>, sessions = 2) {
  const head = execFileSync('git', ['rev-parse', 'main'], { cwd: join(r.workspace, 'repos', 'toyshop'), encoding: 'utf8' }).trim();
  expect(r.mycelink).toMatchObject({ initialised: true, complete: true, candidate: 'TOY-001-C001', candidate_sha: head, branch_head: head });
  expect(r.controller.ok, JSON.stringify(r.controller.failures)).toBe(true);
  expect(r.controller.recovered).toHaveLength(r.controller.violations.length);
  for (const v of r.controller.violations) expect(v).toMatchObject({ verified: true, recovered_by: sessions });
  const v = JSON.parse(readFileSync(r.verification, 'utf8'));
  expect(failingOf(v)).toEqual([]);
  expect(r.delivery).toMatchObject({ ok: true, failures: [] });
  expect(r.ok).toBe(true);
  // The corrective prompt: already undone, /mycelink:run first, nothing to clean up, the paths only.
  const corrective = fake.entries()[1].prompt as string;
  expect(corrective.startsWith(TASK_CORRECTIVE_PROMPT)).toBe(true);
  expect(corrective).toContain('Your first action is to invoke `/mycelink:run TOY-001`');
  expect(corrective).not.toMatch(/forged|# mine/);
}

describe('a controller that changes the workspace itself, outside the fence', () => {
  it('CSET-203 r9: a helper script writes ACCEPTANCE.json through a path it computes — both rolled back, Mycelink’s init kept; the corrective session completes C001 and recovers the key', async () => {
    const fake = hostPlan({ forgeries: ['r9'] });
    const r = await run(fake);
    expect(shape(r)).toEqual([
      [1, 'task', 'controller-violation', null, true],
      [2, 'corrective', 'exit', 1, false],
    ]);
    const [first] = r.sessions;
    // Stopped by what it wrote, within seconds, though the transcript names no path for it.
    expect(first.duration_ms).toBeLessThan(60_000);
    expect(first.controller_edits).toEqual([expect.objectContaining({ unknown: true, action: 'python3 gen.py' })]);
    // What the check that stopped it saw: the workspace, by path and kind.
    expect(first.controller_txn.stopped_for.unauthorized).toEqual(expect.arrayContaining(['platform/features/TOY-001/ACCEPTANCE.json (created; mycelink-state)']));
    expect(first.violation).toMatchObject({ mode: 'selective', verified: true, summary: ['platform/features/TOY-001/ACCEPTANCE.json (created; a Mycelink-managed file)', 'platform/gen.py (created; a helper or scratch file in the workspace)'] });
    expect(first.controller_txn.rollback).toMatchObject({ verified: true, removed: ['platform/features/TOY-001/ACCEPTANCE.json', 'platform/gen.py'], plan_sha256: expect.stringMatching(/^[0-9a-f]{64}$/), manifest_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(first.controller_txn.authorized).toMatchObject({ core: expect.any(Number) });
    // The transaction's files are the evaluator's, outside the workspace.
    expect(first.controller_txn.dir.startsWith(r.workspace)).toBe(false);
    expect(existsSync(join(first.controller_txn.dir, 'result.json'))).toBe(true);
    recovered(r, fake);
    // The corrective session found Mycelink initialised and recovered the key the stopped session held.
    expect(r.controller.authority_recovered).toBe(true);
    expect(r.mycelink.authority_recovered).toBe(true);
    expect(fake.entries()[1].prompt).toContain('- platform/features/TOY-001/ACCEPTANCE.json (created; a Mycelink-managed file)');
  }, 900_000);

  it('the same, when the session ends on its own: the violation is found after it', async () => {
    const fake = hostPlan({ forgeries: ['r9-exit'] });
    const r = await run(fake);
    expect(shape(r)).toEqual([
      [1, 'task', 'exit', null, true],
      [2, 'corrective', 'exit', 1, false],
    ]);
    recovered(r, fake);
  }, 900_000);

  it.each([
    ['a deleted core-managed file is restored', 'delete', 'platform/features/TOY-001/events.jsonl (deleted; a Mycelink-managed file)', (ws: string) => expect(existsSync(join(ws, 'platform', 'features', 'TOY-001', 'events.jsonl'))).toBe(true)],
    ['a renamed one is restored and its new name removed', 'rename', 'platform/features/TOY-001/events.jsonl (deleted; a Mycelink-managed file)', (ws: string) => expect(existsSync(join(ws, 'platform', 'features', 'TOY-001', 'events.jsonl.bak'))).toBe(false)],
    ['a mode change is reverted', 'chmod', 'platform/mycelink.config.json (', (ws: string) => expect(statSync(join(ws, 'platform', 'mycelink.config.json')).mode & 0o200).not.toBe(0)],
    ['a file replaced by a symlink is a file again', 'symlink', 'platform/requirements/TOY-001.md (type; ', (ws: string) => expect(lstatSync(join(ws, 'platform', 'requirements', 'TOY-001.md')).isSymbolicLink()).toBe(false)],
    ['a commit on main in the product repository goes back, branch, index and files', 'commit', 'repos/toyshop/.git:refs/heads/main (moved from ', (ws: string) => expect(execFileSync('git', ['log', '--format=%s', 'main'], { cwd: join(ws, 'repos', 'toyshop'), encoding: 'utf8' })).not.toMatch(/fix it myself/)],
    ['a background helper’s later write is caught by the workspace check', 'helper', 'platform/features/TOY-001/LOOPS.json (created; a Mycelink-managed file)', (ws: string) => expect(existsSync(join(ws, 'platform', 'features', 'TOY-001', 'LOOPS.json'))).toBe(false)],
  ])('%s', async (_label, kind, line, check) => {
    const fake = hostPlan({ forgeries: [kind] });
    const r = await run(fake);
    expect(shape(r)).toEqual([
      [1, 'task', 'controller-violation', null, true],
      [2, 'corrective', 'exit', 1, false],
    ]);
    expect(r.sessions[0].violation.summary.some((l: string) => l.startsWith(line)), JSON.stringify(r.sessions[0].violation.summary)).toBe(true);
    expect(r.sessions[0].violation.verified).toBe(true);
    check(r.workspace);
    recovered(r, fake);
  }, 900_000);

  it('a module-worker’s settle that completed meanwhile stays: only the controller’s own change goes back', async () => {
    const fake = hostPlan({ forgeries: ['after-settle'] });
    const r = await run(fake);
    expect(shape(r)).toEqual([
      [1, 'task', 'controller-violation', null, true],
      [2, 'corrective', 'exit', 1, false],
    ]);
    expect(r.sessions[0].violation).toMatchObject({ mode: 'selective', summary: ['notes.txt (created; a helper or scratch file in the workspace)'] });
    expect(r.sessions[0].controller_txn.authorized).toMatchObject({ core: expect.any(Number), worker: expect.any(Number) });
    // The corrective session's workers: mod-b only — mod-a's settle survived the rollback.
    const calls = readFileSync(r.sessions[1].transcript, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === 'assistant').flatMap((e) => e.message.content.filter((c: any) => c.type === 'tool_use' && c.name === 'Agent').map((c: any) => c.input.description));
    expect(calls.filter((d: string) => d.startsWith('TOY-001.mod'))).toEqual(['TOY-001.mod-b.impl']);
    expect(existsSync(join(r.workspace, 'notes.txt'))).toBe(false);
    recovered(r, fake);
  }, 900_000);

  it('a change a Mycelink step then read: the session is rebuilt as it stood just before that step — what Mycelink did before it is kept, and the corrective session continues from there', async () => {
    // The first worker waits after its RED, so the session is stopped there however fast the host — before delivery
    // changes the checkout's index, whose bytes a rebuild never keeps (past that, the session goes back whole).
    const fake = hostPlan({ forgeries: ['registry'], taskStalls: ['red'] });
    // Checked seldom enough that Mycelink's next step reads the change before a second check sees it persist.
    const r = await run(fake, { lightCheckMs: 5000 });
    expect(shape(r)).toEqual([
      [1, 'task', 'controller-violation', null, true],
      [2, 'corrective', 'exit', 1, false],
    ]);
    const txn = r.sessions[0].controller_txn;
    expect(r.sessions[0].violation).toMatchObject({ mode: 'full', verified: true, reconstruction: { cut_at: expect.any(String) } });
    expect(txn.dependencies).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'platform/repositories.yaml' })]));
    expect(txn.ambiguous).toEqual(expect.arrayContaining([expect.stringMatching(/^the core read platform\/repositories\.yaml after it changed/)]));
    // Not back to how the session began: Mycelink's own steps before the cut (init, the key, the registered project) stay.
    expect(txn.rollback.reconstruction).toMatchObject({ cut: expect.stringMatching(/^\d+$/) });
    expect(txn.rollback.digest).not.toBe(txn.pre_digest);
    expect(readFileSync(join(r.workspace, 'platform', 'repositories.yaml'), 'utf8')).not.toContain('# mine');
    expect(readFileSync(join(r.workspace, 'platform', 'repositories.yaml'), 'utf8')).toContain('toyshop');
    expect(fake.entries()[1].prompt).toMatch(/taken back to just before its first step that read those changes/);
    recovered(r, fake);
  }, 900_000);
});

describe('CSET-203 r12: a module-worker’s own stash, through the plugin’s hooks', () => {
  const stashOf = (ws: string) => execFileSync('git', ['stash', 'list'], { cwd: join(ws, 'repos', 'toyshop'), encoding: 'utf8' }).trim();

  it.each([
    ['pops its own entry back', false],
    ['leaves its entry: settle archives and drops it', true],
  ])('the worker sets its production draft aside with git stash, re-proves RED, %s — authorised, on record; the session goes on and delivers C001', async (_label, leave) => {
    const fake = hostPlan({ hooks: true, workerStash: { 'mod-a': { leave } } });
    const r = await run(fake);
    expect(shape(r)).toEqual([[1, 'task', 'exit', null, false]]);
    const [first] = r.sessions;
    expect(first.controller_txn).toMatchObject({ violation: false, mode: 'none', unauthorized: [], ambiguous: [] });
    expect(first.controller_txn.authorized['worker-git']).toBe(1);
    expect(first.controller_txn.worker_git).toEqual([expect.objectContaining({ path: 'repos/toyshop/.git:refs/stash', workers: [expect.objectContaining({ node_id: 'TOY-001.mod-a.impl' })] })]);
    expect(first.controller_txn.calls).toMatchObject({ intact: true });
    expect(fake.entries().filter((e) => e.stash)).toEqual([{ stash: { node: 'TOY-001.mod-a.impl', left: leave, entries: leave ? 1 : 0 } }]);
    const head = execFileSync('git', ['rev-parse', 'main'], { cwd: join(r.workspace, 'repos', 'toyshop'), encoding: 'utf8' }).trim();
    expect(r.mycelink).toMatchObject({ complete: true, candidate: 'TOY-001-C001', candidate_sha: head });
    expect(r.controller).toMatchObject({ ok: true, violations: [] });
    expect(failingOf(JSON.parse(readFileSync(r.verification, 'utf8')))).toEqual([]);
    expect(r.ok).toBe(true);
    // Nothing set aside is live at the end: popped, or archived by settle.
    expect(stashOf(r.workspace)).toBe('');
  }, 900_000);

  it('a record the controller forges into Mycelink’s provenance ledger is a violation: stopped at once, the session rolled back whole, a corrective session completes C001', async () => {
    const fake = hostPlan({ forgeries: ['ledger'] });
    const r = await run(fake);
    expect(shape(r)).toEqual([
      [1, 'task', 'controller-violation', null, true],
      [2, 'corrective', 'exit', 1, false],
    ]);
    expect(r.sessions[0].controller_txn.stopped_for.forced).toEqual([expect.stringMatching(/^the controller wrote Mycelink's provenance ledger itself/)]);
    expect(r.sessions[0].violation).toMatchObject({ mode: 'full', verified: true, reconstruction: null });
    recovered(r, fake);
  }, 900_000);

  it('the controller’s own stash in the product checkout is still the controller’s: rolled back, a corrective session completes C001', async () => {
    const fake = hostPlan({ hooks: true, workerStash: { 'mod-a': {} }, forgeries: ['stash'] });
    const r = await run(fake);
    expect(shape(r)).toEqual([
      [1, 'task', 'controller-violation', null, true],
      [2, 'corrective', 'exit', 1, false],
    ]);
    expect(r.sessions[0].violation).toMatchObject({ mode: 'selective', verified: true, summary: [expect.stringMatching(/^repos\/toyshop\/\.git:refs\/stash \(moved from nothing to [0-9a-f]{12}; a product repository's ref\)$/)] });
    expect(stashOf(r.workspace)).toBe('');
    recovered(r, fake);
  }, 900_000);
});

describe('CSET-202 final: a host waiting on its background workers while they stash', () => {
  const stashOf = (ws: string) => execFileSync('git', ['stash', 'list'], { cwd: join(ws, 'repos', 'toyshop'), encoding: 'utf8' }).trim();
  // CSET-202's shape: each worker launched in the background, the host waiting on it in `sleep 100; echo waiting`, the
  // worker setting its draft aside beside the red gate (`cd <wt> && git stash push -q && <red>`) and popping it back with
  // its test commit — its entry live for checks of the workspace to see twice.
  const CSET202 = { hooks: true, asyncWorkers: true, hostWait: 'sleep 100; echo waiting', workerStash: { 'mod-a': { shape: 'cset202' }, 'mod-b': { shape: 'cset202' } } };
  const transitionsOf = (s: any) => s.controller_txn.worker_git.flatMap((g: any) => g.transitions.map((t: any) => [t.node_id, t.added.length, t.removed.length]));

  it('both workers push, run the red gate, commit and pop while the host waits — no check stops the session, no violation, C001 delivered', async () => {
    const fake = hostPlan(CSET202);
    const r = await run(fake);
    expect(shape(r)).toEqual([[1, 'task', 'exit', null, false]]);
    const [first] = r.sessions;
    expect(first.controller_txn.stopped_for).toBeUndefined();
    expect(first.controller_txn).toMatchObject({ violation: false, mode: 'none', unauthorized: [], ambiguous: [] });
    expect(first.controller_txn.authorized['worker-git']).toBe(1);
    // Each push and pop, the worker's own, by the call that made it.
    expect(transitionsOf(first)).toEqual([
      ['TOY-001.mod-a.impl', 1, 0],
      ['TOY-001.mod-a.impl', 0, 1],
      ['TOY-001.mod-b.impl', 1, 0],
      ['TOY-001.mod-b.impl', 0, 1],
    ]);
    expect(fake.entries().filter((e) => e.stash).map((e) => e.stash)).toEqual([
      { node: 'TOY-001.mod-a.impl', shape: 'cset202', entries: 0 },
      { node: 'TOY-001.mod-b.impl', shape: 'cset202', entries: 0 },
    ]);
    const head = execFileSync('git', ['rev-parse', 'main'], { cwd: join(r.workspace, 'repos', 'toyshop'), encoding: 'utf8' }).trim();
    expect(r.mycelink).toMatchObject({ complete: true, candidate: 'TOY-001-C001', candidate_sha: head });
    expect(r.controller).toMatchObject({ ok: true, violations: [] });
    expect(failingOf(JSON.parse(readFileSync(r.verification, 'utf8')))).toEqual([]);
    expect(r.ok).toBe(true);
    expect(stashOf(r.workspace)).toBe('');
  }, 900_000);

  it('a restart and a compaction: the task session exits once mod-a settles; the fresh session’s mod-b worker stashes beside a compaction while the host waits — no violation, C001', async () => {
    const fake = hostPlan({ ...CSET202, taskExits: ['settled-one'], compact: true });
    const r = await run(fake);
    expect(shape(r)).toEqual([
      [1, 'task', 'exit', null, false],
      [2, 'resume', 'exit', null, false],
    ]);
    for (const s of r.sessions) {
      expect(s.controller_txn.stopped_for, `session ${s.index}`).toBeUndefined();
      expect(s.controller_txn, `session ${s.index}`).toMatchObject({ violation: false, mode: 'none', unauthorized: [] });
    }
    expect(transitionsOf(r.sessions[0])).toEqual([
      ['TOY-001.mod-a.impl', 1, 0],
      ['TOY-001.mod-a.impl', 0, 1],
    ]);
    expect(transitionsOf(r.sessions[1])).toEqual([
      ['TOY-001.mod-b.impl', 1, 0],
      ['TOY-001.mod-b.impl', 0, 1],
    ]);
    // Both sessions' streams were compacted once, mid-entry.
    for (const s of r.sessions) expect(readFileSync(s.transcript, 'utf8')).toContain('"compact_boundary"');
    const head = execFileSync('git', ['rev-parse', 'main'], { cwd: join(r.workspace, 'repos', 'toyshop'), encoding: 'utf8' }).trim();
    expect(r.mycelink).toMatchObject({ complete: true, candidate: 'TOY-001-C001', candidate_sha: head });
    expect(r.controller.violations).toEqual([]);
    expect(r.ok).toBe(true);
    expect(stashOf(r.workspace)).toBe('');
  }, 900_000);
});

describe('corrective sessions are bounded', () => {
  it('the same violation again ends the task: no third session, the run fails on both', async () => {
    const fake = hostPlan({ forgeries: ['r9', 'r9'] });
    const r = await run(fake);
    expect(shape(r)).toEqual([
      [1, 'task', 'controller-violation', null, true],
      [2, 'corrective', 'controller-violation', 1, true],
    ]);
    expect(r.phases).toEqual([expect.objectContaining({ phase: 'task', ended_by: 'controller-violation' })]);
    expect(r.sessions[1].terminal).toBe('identical-violation');
    expect(r.sessions[1].violation.fingerprint).toBe(r.sessions[0].violation.fingerprint);
    expect(r.controller.ok).toBe(false);
    expect(r.controller.failures).toEqual([expect.stringMatching(/^controller-violation: session 1 \(task\)/), expect.stringMatching(/^controller-violation: session 2 \(corrective\).*The phase ended: the same violation as before\./)]);
    // Both rolled back and verified: the workspace holds nothing of either.
    expect(existsSync(join(r.workspace, 'platform', 'gen.py'))).toBe(false);
    expect(r.delivery.ok).toBe(false);
  }, 900_000);

  it('an independent second violation gets a second corrective session, which completes it: both recovered', async () => {
    const fake = hostPlan({ forgeries: ['r9', 'commit'] });
    const r = await run(fake);
    expect(shape(r)).toEqual([
      [1, 'task', 'controller-violation', null, true],
      [2, 'corrective', 'controller-violation', 1, true],
      [3, 'corrective', 'exit', 2, false],
    ]);
    expect(r.sessions[1].violation.fingerprint).not.toBe(r.sessions[0].violation.fingerprint);
    recovered(r, fake, 3);
  }, 900_000);
});
