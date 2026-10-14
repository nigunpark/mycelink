/**
 * What the controller-rollback tests (controller-rollback*.test.ts) share: the
 * toy case, a stand-in Mycelink host whose plan the test writes, and the
 * with-arm run on it. Each test file calls useRollbackFixture() once at its
 * top level. The tests are cut into files so that CI can run them on
 * different runners (scripts/test-suites.mjs).
 */
import { afterAll, beforeAll, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
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

export const FAKE_HOST = join(REPO_ROOT, 'tests', 'benchmark', 'fake-mycelink-host.mjs');
export const AGENT_TESTS = Object.fromEntries(Object.entries(TOY.referenceTests).map(([p, body]) => [p, `// written by the agent\n${body}`]));
export let toy: Toy;
let echo: net.Server;
let PROXY: { allowed: string; denied: string };

/** Registers the shared setup on the test file that calls it, at its top level: the toy case and the echo server. */
export function useRollbackFixture(): void {
  afterAll(() => cleanupTmpRoots());
  beforeAll(async () => {
    ({ toy } = await preparedToy());
    echo = net.createServer((c) => c.end('echo'));
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()));
    PROXY = { allowed: `127.0.0.1:${(echo.address() as net.AddressInfo).port}`, denied: 'example.invalid:443' };
  }, 300_000);
  afterAll(() => echo?.close());
}

export function hostPlan(extra: Record<string, unknown> = {}) {
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

export const run = (fake: { dir: string; file: string }, options: { lightCheckMs?: number } = {}) =>
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

export const failingOf = (v: any) => Object.entries(v.sections).flatMap(([name, s]: [string, any]) => (s?.checks ?? []).filter((c: any) => !c.ok && c.severity !== 'warning').map((c: any) => `${name}:${c.id}`));
export const shape = (r: any) => r.sessions.map((s: any) => [s.index, s.purpose, s.ended_by, s.corrects ?? null, Boolean(s.violation)]);
/** On a shape mismatch, what each session's checks found: its stop, its violation, what its settlement could not attribute. */
export const found = (r: any) => JSON.stringify(r.sessions.map((s: any) => ({ ended_by: s.ended_by, stopped_for: s.controller_txn?.stopped_for ?? null, violation: s.violation?.summary ?? null, unauthorized: s.controller_txn?.unauthorized ?? null, ambiguous: s.controller_txn?.ambiguous ?? null })));

/** The corrective session completed the feature through Mycelink, the violation recovered and on the record. */
export function recovered(r: any, fake: ReturnType<typeof hostPlan>, sessions = 2) {
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
