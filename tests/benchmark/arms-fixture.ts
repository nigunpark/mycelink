/**
 * What the treatment-arm tests (arms*.test.ts) share: the toy case, a local
 * stand-in for the model proxy's preflight target, the scripted stand-ins'
 * plans and the arm runner with the tests' isolation. Each test file calls
 * useArmsFixture() once at its top level; `toy`, `project`, `prd` and `PROXY`
 * are set by its beforeAll. The tests are cut into files so that CI can run
 * the longest ones on different runners (scripts/test-suites.mjs).
 */
import { afterAll, beforeAll, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
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

export const arm = (name: string, fake: { dir: string; file: string }, options: Record<string, unknown> = {}) =>
  runArm({
    suiteRoot: toy.suite,
    caseKey: TOY_PRD,
    arm: name,
    outDir: join(makeTmpDir('bench-a-run-'), 'run'),
    cacheRoot: toy.cacheRoot,
    claude: [process.execPath, FAKE],
    pollMs: 100,
    env: { FAKE_CLAUDE_PLAN: fake.file },
    isolation: TEST_ISOLATION,
    // Inside the boundary the stand-in agent sees its plan and log only because they are bound in.
    sessionBinds: [{ path: fake.dir, rw: true }],
    preflightProxy: PROXY,
    proxyAllow: ['api.anthropic.com:443', PROXY.allowed],
    ...options,
  });

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
/** On a session-shape mismatch, what each session's checks found: its stop, its violation, what its settlement could not attribute. */
export const checksFound = (run: any) => JSON.stringify(run.sessions.map((s: any) => ({ ended_by: s.ended_by, stopped_for: s.controller_txn?.stopped_for ?? null, violation: s.violation?.summary ?? null, unauthorized: s.controller_txn?.unauthorized ?? null, ambiguous: s.controller_txn?.ambiguous ?? null })));
