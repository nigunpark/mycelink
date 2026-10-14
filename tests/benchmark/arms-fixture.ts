/**
 * What the treatment-arm tests (arms*.test.ts) share: the toy case, a local
 * stand-in for the model proxy's preflight target, the scripted stand-ins'
 * plans and the arm runner with the tests' isolation. Each test file calls
 * useArmsFixture() once at its top level; `toy`, `project`, `prd` and `PROXY`
 * are set by its beforeAll. The tests are cut into files so that CI can run
 * the longest ones on different runners (scripts/test-suites.mjs).
 */
import { afterAll, beforeAll, expect, onTestFailed } from 'vitest';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import net from 'node:net';
import { join } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { TEST_ISOLATION } from './isolation-fixture.js';
import { REPO_ROOT } from '../helpers/global-setup.js';
import { TOY, TOY_PRD, preparedToy, type Toy } from './toy-fixture.js';
// @ts-expect-error -- plain ESM module without type declarations
import { runArm } from '../../evals-public-projects/lib/arms.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { lateDefectPrompt } from '../../evals-public-projects/lib/faults.mjs';

export const FAKE = join(REPO_ROOT, 'tests', 'benchmark', 'fake-claude.mjs');
const T = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n";
export const REGRESSION = {
  'mod-a/test/regression.test.mjs': `${T}import { reserve } from '../src/stock.mjs';\ntest('reserving takes the quantity out of the stock again', () => {\n  assert.deepEqual(reserve(2, 1), { stock: 1, reserved: 1 });\n});\n`,
};
export const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/**
 * The QA prompt a run must have sent for its late-defect record: lateDefectPrompt's own output — no arm
 * changes a byte of it — with the checks the record says QA reported, as the prompt lists them.
 */
export function qaPrompt(sent: string, defect: any, original: string): string {
  const failures = sent
    .split('\n\nThe original request follows.')[0]!
    .split('\n')
    .filter((l) => l.startsWith('- ') && l.includes(': '))
    .map((l) => ({ name: l.slice(2, l.indexOf(': ')), message: l.slice(l.indexOf(': ') + 2) }));
  expect(failures.map((f) => f.name)).toEqual(defect.reported);
  // The module the record binds, as the case's README names it, in both arms alike.
  expect(defect.affected).toEqual({ module: defect.module, path: defect.module, repository: 'repos/toyshop' });
  return lateDefectPrompt({ commit: defect.commit, failures, affected: defect.affected, original });
}
// The agent's own tests: the reference's verbatim would be evaluator content in the delivery.
export const AGENT_TESTS = Object.fromEntries(Object.entries(TOY.referenceTests).map(([p, body]) => [p, `// written by the agent\n${body}`]));
// libuv copies these into every child environment on Windows.
export const WINDOWS_REQUIRED = ['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR'];
/** What macOS's CoreFoundation sets in every process it starts, whatever environment it was given. */
export const MACOS_REQUIRED = ['__CF_USER_TEXT_ENCODING'];

export let toy: Toy;
export let project: any;
export let prd: any;

// The model proxy's preflight target in these tests: a local server instead of the model API (no network needed).
let echo: net.Server;
export let PROXY: { allowed: string; denied: string };

/** Registers the shared setup on the test file that calls it, at its top level: the toy case and the echo server. */
export function useArmsFixture(): void {
  afterAll(() => cleanupTmpRoots());
  beforeAll(async () => {
    ({ toy, project, prd } = await preparedToy());
    echo = net.createServer((c) => c.end('echo'));
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()));
    PROXY = { allowed: `127.0.0.1:${(echo.address() as net.AddressInfo).port}`, denied: 'example.invalid:443' };
  }, 300_000);
  afterAll(() => echo?.close());
}

export function fakePlan(extra: Record<string, unknown> = {}) {
  const dir = makeTmpDir('bench-a-fake-');
  const log = join(dir, 'log.jsonl');
  writeFileSync(log, '');
  const file = join(dir, 'plan.json');
  writeFileSync(file, JSON.stringify({ log, tests: AGENT_TESTS, code: TOY.referenceCode, regression: REGRESSION, ...extra }));
  return { dir, file, entries: () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
}

/** The tail of a text file, or null when there is none. */
const tail = (file: string, lines: number) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-lines).join('\n') : null);

/**
 * What a failed arm test — an assertion, or its own timeout — says of the run, from what was written through while it ran
 * (a timeout never reaches the run's record): the harness's account of each session's process (harness-trace.log beside
 * the plan), where each stand-in session stood (host-trace.jsonl: its last steps, and anything that did not answer), and
 * each session's stderr. A session still running is killed with what it started: nothing outlives the test.
 */
export function armDiagnostics(fake: { dir: string }, outDir: string): string {
  const harness = join(fake.dir, 'harness-trace.log');
  const lines = existsSync(harness) ? readFileSync(harness, 'utf8').split('\n').filter(Boolean) : [];
  const running = new Map<string, number>();
  for (const l of lines) {
    const started = /session (\d+): started \(pid (\d+)\)/.exec(l);
    if (started) running.set(started[1]!, Number(started[2]));
    const ended = /session (\d+): ended \(/.exec(l);
    if (ended) running.delete(ended[1]!);
  }
  const killed: string[] = [];
  for (const [n, pid] of running) {
    try {
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 30_000 });
      else process.kill(-pid, 'SIGKILL');
      killed.push(`session ${n} (pid ${pid})`);
    } catch {
      // already gone
    }
  }
  const host = join(fake.dir, 'host-trace.jsonl');
  const events = existsSync(host) ? readFileSync(host, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const brief = (e: any) => `${e.t?.slice(11, 23)} ${e.ev}${e.label ? ` ${e.label}` : ''}${e.command ? ` ${String(e.command).slice(0, 120)}` : ''}${e.where ? ` at ${e.where}` : ''}${e.code !== undefined ? ` ${e.code}` : ''}${e.ms !== undefined ? ` ${e.ms} ms` : ''}${e.timed_out ? ` TIMED OUT (${e.signal ?? `status ${e.status}`})` : ''}${e.input_bytes !== undefined ? ` (its ${e.input_bytes}-byte payload on a file)` : ''}${e.message ? ` ${String(e.message).split('\n')[0]}` : ''}`;
  const sessions = [...new Set(events.map((e: any) => e.session))].map((session) => {
    const mine = events.filter((e: any) => e.session === session);
    const anomalies = mine.filter((e: any) => /unanswered|timeout|^error$/.test(e.ev));
    return `stand-in ${session} (${mine.find((e: any) => e.ev === 'start')?.kind ?? '?'}), ${mine.length} events; last:\n${mine.slice(-8).map(brief).join('\n')}${anomalies.length ? `\nunanswered:\n${anomalies.map(brief).join('\n')}` : ''}`;
  });
  const sessionsDir = join(outDir, 'sessions');
  const stderr = existsSync(sessionsDir) ? readdirSync(sessionsDir).filter((f) => f.endsWith('.stderr.log')).map((f) => `${f}:\n${tail(join(sessionsDir, f), 15) ?? ''}`) : [];
  return [`harness:\n${lines.slice(-40).join('\n')}`, ...sessions, ...stderr, killed.length ? `killed, still running: ${killed.join(', ')}` : 'no session left running'].join('\n---\n');
}

/** Each stand-in session of a run, in order: its kind, and the last thing its trace shows it doing (where it ended). */
export function standInEnds(fake: { dir: string }): { kind: string; last: string }[] {
  const host = join(fake.dir, 'host-trace.jsonl');
  const events = existsSync(host) ? readFileSync(host, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return [...new Set(events.map((e: any) => e.session))].map((session) => {
    const mine = events.filter((e: any) => e.session === session);
    const last = mine.at(-1);
    return { kind: mine.find((e: any) => e.ev === 'start')?.kind ?? '?', last: last.ev === 'await-stop' ? `await-stop ${last.where}` : last.ev === 'exit' ? `exit ${last.code}` : last.ev };
  });
}

export const arm = (name: string, fake: { dir: string; file: string }, options: Record<string, unknown> = {}) => {
  const outDir = (options.outDir as string | undefined) ?? join(makeTmpDir('bench-a-run-'), 'run');
  // Written through as it happens, so that it outlives a timeout.
  const trace = join(fake.dir, 'harness-trace.log');
  const t0 = Date.now();
  const log = (line: string) => appendFileSync(trace, `+${((Date.now() - t0) / 1000).toFixed(1)}s ${line}\n`);
  onTestFailed(() => {
    console.error(`arm ${name} run ${outDir}:\n${armDiagnostics(fake, outDir)}`);
  });
  return runArm({
    suiteRoot: toy.suite,
    caseKey: TOY_PRD,
    arm: name,
    cacheRoot: toy.cacheRoot,
    claude: [process.execPath, FAKE],
    pollMs: 100,
    env: { FAKE_CLAUDE_PLAN: fake.file },
    isolation: TEST_ISOLATION,
    // Inside the boundary the stand-in agent sees its plan and log only because they are bound in.
    sessionBinds: [{ path: fake.dir, rw: true }],
    preflightProxy: PROXY,
    proxyAllow: ['api.anthropic.com:443', PROXY.allowed],
    log,
    ...options,
    outDir,
  });
};

// The with arm, model-free: a stand-in host (fake-mycelink-host.mjs) on the sealed Mycelink.
export const FAKE_HOST = join(REPO_ROOT, 'tests', 'benchmark', 'fake-mycelink-host.mjs');
export const testOf = (path: string) => AGENT_TESTS[path]!;
export function hostPlan(extra: Record<string, unknown> = {}) {
  const dir = makeTmpDir('bench-a-host-');
  const log = join(dir, 'log.jsonl');
  writeFileSync(log, '');
  const file = join(dir, 'plan.json');
  const work = {
    'mod-a': { tests: { 'mod-a/test/reserve.test.mjs': testOf('mod-a/test/reserve.test.mjs') }, impl: { 'mod-a/src/stock.mjs': TOY.referenceCode['mod-a/src/stock.mjs'] } },
    'mod-b': { tests: { 'mod-b/test/place.test.mjs': testOf('mod-b/test/place.test.mjs') }, impl: { 'mod-b/src/orders.mjs': TOY.referenceCode['mod-b/src/orders.mjs'] } },
  };
  // QA's rework: a regression test for what the late defect broke, then the fix (the module's production again).
  const regression = {
    'mod-a': { 'mod-a/test/reserve.test.mjs': `${testOf('mod-a/test/reserve.test.mjs')}test('reserving two takes two out of the stock', () => {\n  assert.deepEqual(reserve(5, 2), { stock: 3, reserved: 2 });\n});\n` },
    'mod-b': { 'mod-b/test/place.test.mjs': `${testOf('mod-b/test/place.test.mjs')}test('an order of two leaves the rest', () => {\n  assert.deepEqual(placeOrder(5, 2), { status: 'placed', stock: 3 });\n});\n` },
  };
  writeFileSync(file, JSON.stringify({ log, work, regression, ...extra }));
  return { dir, file, entries: () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
}
export const DEFAULT_SHAPE = (interrupt: unknown) => ({
  schema: 'mycelink-bench/fault-plan@1',
  id: 'with-faults',
  faults: [
    { kind: 'concurrent-commit', trigger: { on: 'first-commit' } },
    { kind: 'interrupt-restart', trigger: interrupt },
    { kind: 'duplicate-result', trigger: { on: 'session-end' } },
    { kind: 'stale-result', trigger: { on: 'session-end' } },
    { kind: 'late-hidden-defect', trigger: { on: 'session-end' } },
  ],
});
export const LATE_ONLY = { schema: 'mycelink-bench/fault-plan@1', id: 'late', faults: [{ kind: 'late-hidden-defect', trigger: { on: 'session-end' } }] };
/** The rework session's top-level tool calls and its worker calls, from its stream. */
export const callsOf = (transcript: string) => {
  const events = readFileSync(transcript, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return events.filter((e) => e.type === 'assistant').flatMap((e) => e.message.content.filter((c: any) => c.type === 'tool_use').map((c: any) => ({ ...c, parent: e.parent_tool_use_id })));
};
export const failingOf = (v: any) => Object.entries(v.sections).flatMap(([name, s]: [string, any]) => (s?.checks ?? []).filter((c: any) => !c.ok && c.severity !== 'warning').map((c: any) => `${name}:${c.id}`));
/**
 * On a session-shape mismatch, what each session's checks found (its stop, its violation, what its settlement could not
 * attribute), and how each phase and fault ended (a rework phase starts only on a late defect QA reported).
 */
export const checksFound = (run: any) =>
  JSON.stringify({
    sessions: run.sessions.map((s: any) => ({ ended_by: s.ended_by, stopped_for: s.controller_txn?.stopped_for ?? null, violation: s.violation?.summary ?? null, unauthorized: s.controller_txn?.unauthorized ?? null, ambiguous: s.controller_txn?.ambiguous ?? null, housekeeping: s.controller_txn?.housekeeping ?? null })),
    phases: (run.phases ?? []).map((p: any) => ({ phase: p.phase, ended_by: p.ended_by, mycelink: p.mycelink })),
    faults: (run.faults ?? []).map((f: any) => ({ kind: f.kind, applied: f.applied, detail: f.detail ?? null, reported: f.reported ?? null, already_failing: f.already_failing ?? null })),
  });
