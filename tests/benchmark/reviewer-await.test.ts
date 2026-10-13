/**
 * The with arm on the toy, end to end, with the acceptance reviewer as
 * CSET-203 r13 ran it — in the background, its completion enqueued while
 * the host was busy (2.1.290's record) — and as a controller session can
 * leave it, still running when the session exits.
 *
 *  - A slow reviewer: the host runs r13's lines at once (the ticket's ingest
 *    and settle together): both say it runs and spend nothing; then the
 *    await line, again while it runs; then ingest and settle take its answer.
 *    One reviewer session counted, no refusal, the delivery holds, and the
 *    sessions' own streams attest each step of its lifecycle.
 *  - A session that exits while its reviewer runs: the reviewer went with
 *    it. The harness has Mycelink look, model-free, before any fresh session
 *    opens: the reviewer's host process is gone, so it is LOST — interrupted,
 *    its generation re-issued with nothing spent. The continuation's fresh
 *    reviewer delivers; the interruption is attested by the streams (the
 *    task started in session 1, which had ended).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { REPO_ROOT } from '../helpers/global-setup.js';
import { TEST_ISOLATION } from './isolation-fixture.js';
import { TOY, TOY_PRD, preparedToy, type Toy } from './toy-fixture.js';
// @ts-expect-error -- plain ESM module without type declarations
import { reviewerLifecycleTrustProblems, runArm } from '../../evals-public-projects/lib/arms.mjs';

afterAll(() => cleanupTmpRoots());

const FAKE_HOST = join(REPO_ROOT, 'tests', 'benchmark', 'fake-mycelink-host.mjs');
const T = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n";
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

function hostPlan(extra: Record<string, unknown>) {
  const dir = makeTmpDir('bench-reviewer-');
  const log = join(dir, 'log.jsonl');
  writeFileSync(log, '');
  const file = join(dir, 'plan.json');
  const regression = { 'mod-a': { 'mod-a/test/regression.test.mjs': `${T}test('regression', () => {});\n` } };
  writeFileSync(file, JSON.stringify({ log, work: Object.fromEntries(['mod-a', 'mod-b'].map((m) => [m, { tests: Object.fromEntries(Object.entries(AGENT_TESTS).filter(([p]) => p.startsWith(`${m}/`))), impl: Object.fromEntries(Object.entries(TOY.referenceCode).filter(([p]) => p.startsWith(`${m}/`))) }])), regression, ...extra }));
  return { dir, file, entries: () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>) };
}

const withArm = (plan: { dir: string; file: string }) =>
  runArm({
    suiteRoot: toy.suite,
    caseKey: TOY_PRD,
    arm: 'with',
    outDir: join(makeTmpDir('bench-reviewer-run-'), 'run'),
    cacheRoot: toy.cacheRoot,
    claude: [process.execPath, FAKE_HOST],
    pollMs: 100,
    env: { FAKE_CLAUDE_PLAN: plan.file },
    isolation: TEST_ISOLATION,
    sessionBinds: [{ path: plan.dir, rw: true }],
    preflightProxy: PROXY,
    proxyAllow: ['api.anthropic.com:443', PROXY.allowed],
  });

const featureEvents = (run: any, type: string): Record<string, any>[] =>
  readFileSync(join(run.workspace, 'platform', 'features', 'TOY-001', 'events.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, any>)
    .filter((e) => e['type'] === type);

describe('CSET-203 r13: a reviewer that runs in the background', () => {
  it("is awaited, never settled while it runs: r13's ingest and settle at once spend nothing, the await line waits it out, its answer settles once; the streams attest it", async () => {
    const plan = hostPlan({ reviewerLifecycle: ['slow'], slowReviewerMs: 8000 });
    const run = await withArm(plan);
    const slow = plan.entries().filter((e) => e['slow_reviewer']).map((e) => e['slow_reviewer']);
    expect(slow).toHaveLength(1);
    expect(slow[0]).toMatchObject({ early: { ingest: 'REVIEWER_RUNNING', settle: 'REVIEWER_RUNNING', lifecycle: 'RUNNING' }, ingest: 'INGESTED', settle: 'PASS' });
    expect(slow[0].awaits.length).toBeGreaterThan(1);
    expect(slow[0].awaits.slice(0, -1).every((s: string) => s === 'RUNNING')).toBe(true);
    expect(slow[0].awaits.at(-1)).toBe('COMPLETED');
    expect(featureEvents(run, 'review.refused')).toEqual([]);
    expect(featureEvents(run, 'review.reissued')).toEqual([]);
    expect(featureEvents(run, 'review.ingested')).toHaveLength(1);
    expect(run.reviewer_lifecycle).toMatchObject({ streamed: true, tasks: [expect.objectContaining({ session: 1, status: 'completed' })], ingested: [expect.objectContaining({ outcome: 'INGESTED' })], interrupted: [] });
    expect(reviewerLifecycleTrustProblems(run)).toEqual([]);
    expect(run.trust.problems.filter((p: string) => p.startsWith('reviewer lifecycle'))).toEqual([]);
    expect(run.sessions).toHaveLength(1);
    expect(run.delivery).toMatchObject({ ok: true, failures: [] });
    expect(run.ok).toBe(true);
  }, 600_000);
});

describe('CSET-203 r13: a controller session that exits while its reviewer runs', () => {
  it('the harness has Mycelink find the reviewer lost with its session, model-free: interrupted, re-issued with nothing spent; the continuation delivers; the streams attest it', async () => {
    const plan = hostPlan({ reviewerLifecycle: ['exit-running'] });
    const run = await withArm(plan);
    expect(run.sessions.map((s: any) => [s.index, s.purpose, s.ended_by, s.exit_code, s.continuation ?? false])).toEqual([
      [1, 'task', 'exit', 0, false],
      [2, 'resume', 'exit', 0, true],
    ]);
    const c = run.continuations[0];
    expect(c).toMatchObject({ after_session: 1, session: 2, outcome: 'resumed', reviewer_reconciled: { review_id: 'TOY-001-R001', state: 'LOST', next: 'dispatch', reviewer: { state: 'LOST' } } });
    expect(c.next_action).toMatchObject({ kind: 'reconcile', resumable: true, reviewer: { review_id: 'TOY-001-R001', state: 'LOST' } });
    expect(JSON.stringify(c)).not.toMatch(/"agent_id"|"prompt"/);
    const interrupted = featureEvents(run, 'review.reviewer_interrupted');
    expect(interrupted).toEqual([expect.objectContaining({ data: expect.objectContaining({ review_id: 'TOY-001-R001', reason: 'host-ended', count: 1, blocked: false }) })]);
    expect(featureEvents(run, 'review.refused')).toEqual([]);
    const tickets = plan.entries().filter((e) => e['review_ticket']).map((e) => e['review_ticket']);
    expect(tickets.map((t: any) => [t.review_id, t.attempt])).toEqual([
      ['TOY-001-R001', 1],
      ['TOY-001-R001', 2],
    ]);
    expect(run.reviewer_lifecycle).toMatchObject({ streamed: true, interrupted: [expect.objectContaining({ reason: 'host-ended' })] });
    expect(reviewerLifecycleTrustProblems(run)).toEqual([]);
    expect(run.delivery).toMatchObject({ ok: true, failures: [] });
    expect(run.ok).toBe(true);
  }, 600_000);
});
