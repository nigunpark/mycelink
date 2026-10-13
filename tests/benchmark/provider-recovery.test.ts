/**
 * A benchmark session the model provider failed is recovered, boundedly,
 * and accounted for (CSET-203 r10).
 *
 * r10 with-normal: the controller dispatched the cli's rework (its attempt 2)
 * and its very next reply was refused by a provider safeguard
 * (`reasoning_extraction`). The session exited 1; the harness ended the run
 * there — a continuation needed exit 0 — with the claim live until its
 * expiry and no candidate. That is an infrastructure failure, not the
 * controller's or the product's.
 *
 * Now the session's own stream classifies its failure (lib/provider.mjs, the
 * plugin's rules: tests/unit/provider-failure.test.ts). A transient one —
 * whatever the exit code — has Mycelink reconcile the work in flight from
 * Claude Code's records (`session provider-interrupt`), then a fresh resume
 * session continues, told first to run /mycelink:run, what the provider
 * interrupted and that Mycelink reconciled it, on the phase's same deadline,
 * with no fault re-injected. Four per phase at most, two per ticket (the
 * plugin's own bound, PROVIDER_UNAVAILABLE); an authentication failure ends
 * the phase at once. Each recovery is recorded with the session lineage and
 * the budget left; trust re-reads every recorded failure from its session's
 * transcript and refuses one that is not there, or more than the bounds.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { REPO_ROOT } from '../helpers/global-setup.js';
import { TEST_ISOLATION } from './isolation-fixture.js';
import { TOY, TOY_PRD, preparedToy, type Toy } from './toy-fixture.js';
import { classifyProviderFailure as coreClassify, parseJsonLines as coreParse } from '../../src/sessions/provider-failure.js';
// @ts-expect-error -- plain ESM module without type declarations
import { classifyProviderFailure, parseJsonLines, sessionFailure } from '../../evals-public-projects/lib/provider.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { MAX_PROVIDER_RECOVERIES, controllerReport, providerTrustProblems, runArm, runPhase } from '../../evals-public-projects/lib/arms.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { PROVIDER_RESUME_PROMPT, providerResumePrompt } from '../../evals-public-projects/lib/faults.mjs';

afterAll(() => cleanupTmpRoots());

const FIXTURES = join(REPO_ROOT, 'tests', 'benchmark', 'fixtures', 'cset203-r10');
const R10_STREAM = readFileSync(join(FIXTURES, 'r10-stream.jsonl'), 'utf8');
const R10_TRANSCRIPT = readFileSync(join(FIXTURES, 'r10-transcript.jsonl'), 'utf8');

const synthetic = (error: string, extra: Record<string, unknown> = {}) => ({ type: 'assistant', parent_tool_use_id: null, is_api_error_message: true, error, request_id: 'req_011Bench', message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error' }], stop_reason: 'stop_sequence' }, ...extra });
const failedResult = (extra: Record<string, unknown> = {}) => ({ type: 'result', subtype: 'success', is_error: true, api_error_status: null, terminal_reason: 'api_error', ...extra });

describe("the harness's classifier is the plugin's", () => {
  const corpus: { entries: unknown[]; exitCode?: number | null; scope?: 'stream' | 'transcript' }[] = [
    { entries: coreParse(R10_STREAM), exitCode: 1 },
    { entries: coreParse(R10_TRANSCRIPT), scope: 'transcript' },
    { entries: coreParse(R10_TRANSCRIPT).slice(0, 3), scope: 'transcript' },
    { entries: [synthetic('rate_limit'), failedResult({ api_error_status: 429 })], exitCode: 1 },
    { entries: [failedResult({ api_error_status: 529 })], exitCode: 1 },
    { entries: [synthetic('connection_error'), failedResult()], exitCode: 1 },
    { entries: [synthetic('authentication_failed'), failedResult({ api_error_status: 401 })], exitCode: 1 },
    { entries: [{ type: 'result', subtype: 'error_max_turns', is_error: true }], exitCode: 1 },
    { entries: [{ type: 'result', subtype: 'error_max_budget_usd', is_error: true }], exitCode: 1 },
    { entries: [synthetic('max_output_tokens'), failedResult()], exitCode: 1 },
    { entries: [{ type: 'assistant', parent_tool_use_id: null, message: { model: 'm', content: [{ type: 'text', text: 'API Error: [reasoning_extraction] req_011Forged' }] } }, { type: 'result', is_error: false }], exitCode: 0 },
    { entries: [{ ...synthetic('rate_limit'), parent_tool_use_id: 'toolu_x' }, { type: 'result', is_error: true }], exitCode: 1 },
    { entries: [{ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' } }, failedResult()], exitCode: 1 },
    { entries: [], exitCode: 1 },
    { entries: [], exitCode: 0 },
  ];
  it('answers every case of the corpus exactly as src/sessions/provider-failure.ts does', () => {
    for (const c of corpus) expect(classifyProviderFailure(c), JSON.stringify(c).slice(0, 200)).toEqual(coreClassify(c));
    expect(parseJsonLines(R10_STREAM)).toEqual(coreParse(R10_STREAM));
  });

  it("classifies r10's own session: a transient refusal, exit 1", () => {
    expect(sessionFailure(R10_STREAM, 1)).toMatchObject({ class: 'provider-refusal', transient: true, request_id: 'req_synthetic_r10_refusal', category: 'reasoning_extraction' });
  });
});

type Session = { index: number; purpose: string; phase: string; resumes: number | null; provider_recovery?: boolean; continuation?: boolean; ended_by: string; exit_code: number | null; provider_failure?: Record<string, unknown> | null; text: string; terminal?: string };

const REFUSAL = { class: 'provider-refusal', transient: true, request_id: 'req_011R10', category: 'reasoning_extraction', status: null, error: 'invalid_request', at: null };
const RATE = { class: 'rate-limit', transient: true, request_id: 'req_011Rate', category: null, status: 429, error: 'rate_limit', at: null };
const AUTH = { class: 'auth', transient: false, request_id: null, category: null, status: 401, error: 'authentication_failed', at: null };

/** A scripted phase: each session ends as `ends` says (`ok`, or a failure class); `recover` answers each provider failure. */
async function scripted(ends: (Record<string, unknown> | 'ok')[], recover: ((s: Session, info: { count: number }) => Promise<{ text: string } | null>) | null, deadline = Date.now() + 60_000) {
  const started: Session[] = [];
  const asked: { after: number; count: number }[] = [];
  const start = async ({ purpose, phase, text, resumes, provider_recovery }: { purpose: string; phase: string; text: string; resumes: number | null; provider_recovery?: boolean }) => {
    const index = started.length + 1;
    const end = ends[index - 1] ?? 'ok';
    const s: Session = { index, purpose, phase, resumes, ...(provider_recovery ? { provider_recovery: true } : {}), ended_by: 'exit', exit_code: end === 'ok' ? 0 : 1, provider_failure: end === 'ok' ? null : (end as Record<string, unknown>), text };
    started.push(s);
    return s;
  };
  const p = await runPhase({
    phase: 'task',
    prompt: 'the request',
    deadline,
    start,
    providerRecovery:
      recover === null
        ? null
        : async (s: Session, info: { count: number }) => {
            asked.push({ after: s.index, ...info });
            return recover(s, info);
          },
  });
  return { p, started, asked };
}

describe('runPhase: a session the provider failed is resumed, boundedly', () => {
  it('a transient failure with exit 1 is resumed by a fresh resume session (no exit 0 needed); the phase then ends as usual', async () => {
    const { p, started, asked } = await scripted([REFUSAL, 'ok'], async () => ({ text: 'resume after the provider' }));
    expect(started.map((s) => [s.index, s.purpose, s.resumes, s.provider_recovery ?? false, s.exit_code])).toEqual([[1, 'task', null, false, 1], [2, 'resume', 1, true, 0]]);
    expect(started[1]!.text).toBe('resume after the provider');
    expect(asked).toEqual([{ after: 1, count: 1 }]);
    expect(p.ended_by).toBe('exit');
  });

  it('a rate limit is retried the same way; an authentication failure is not: the phase ends at once, provider-permanent', async () => {
    expect((await scripted([RATE, 'ok'], async () => ({ text: 'again' }))).started.map((s) => s.purpose)).toEqual(['task', 'resume']);
    const auth = await scripted([AUTH, 'ok'], async () => ({ text: 'never' }));
    expect(auth.started.map((s) => s.purpose)).toEqual(['task']);
    expect(auth.asked).toEqual([]);
    expect(auth.p).toMatchObject({ ended_by: 'provider-permanent', terminal: 'provider-permanent' });
    expect(auth.started[0]!.terminal).toBe('provider-permanent');
  });

  it(`at most ${4} recoveries a phase: the next transient failure ends it provider-unavailable`, async () => {
    expect(MAX_PROVIDER_RECOVERIES).toBe(4);
    const { p, started, asked } = await scripted([REFUSAL, RATE, REFUSAL, RATE, REFUSAL, 'ok'], async () => ({ text: 'again' }));
    expect(started).toHaveLength(5);
    expect(asked.map((a) => a.count)).toEqual([1, 2, 3, 4]);
    expect(p).toMatchObject({ ended_by: 'provider-unavailable', terminal: 'provider-unavailable' });
  });

  it("Mycelink's own bound (PROVIDER_UNAVAILABLE) ends it too; a spent budget ends it; a product failure or a limit is no provider's", async () => {
    const stopped = await scripted([REFUSAL, 'ok'], async () => null);
    expect(stopped.started).toHaveLength(1);
    expect(stopped.p).toMatchObject({ ended_by: 'provider-unavailable' });
    const late = await scripted([REFUSAL, 'ok'], async () => ({ text: 'x' }), Date.now() - 1);
    expect(late.started).toHaveLength(1);
    expect(late.p.ended_by).toBe('budget');
    const product = await scripted([{ class: 'product', transient: false }], async () => ({ text: 'x' }));
    expect(product.started).toHaveLength(1);
    expect(product.asked).toEqual([]);
    expect(product.p.ended_by).toBe('exit');
    const limit = await scripted([{ class: 'turn-limit', transient: false }], async () => ({ text: 'x' }));
    expect(limit.asked).toEqual([]);
  });
});

describe('the resume prompt after a provider failure', () => {
  it('runs /mycelink:run first, names what the provider interrupted and that Mycelink reconciled it, keeps the fence, then the request', () => {
    const text = providerResumePrompt('THE REQUEST', {
      feature_id: 'CSET-203',
      failure: REFUSAL,
      reconciled: { outcome: 'RECONCILED', interrupted: [{ kind: 'worker', node_id: 'CSET-203.cli.recover', review_id: null, dispatch_id: 'd-1', action: 'released' }, { kind: 'review', node_id: null, review_id: 'CSET-203-R002', dispatch_id: 'd-2', action: 'review-reissue' }] },
      next_action: { kind: 'dispatch', resumable: true, detail: 'CSET-203 is incomplete' },
    });
    expect(text.startsWith(PROVIDER_RESUME_PROMPT)).toBe(true);
    const head = text.split('\n\nThe original request follows.')[0]!;
    expect(head.indexOf('/mycelink:run')).toBeGreaterThan(-1);
    expect(head).toMatch(/model provider/);
    expect(head).toMatch(/provider-refusal/);
    expect(head).toMatch(/CSET-203\.cli\.recover .*released/);
    expect(head).toMatch(/CSET-203-R002.*fresh reviewer generation/);
    expect(head).toMatch(/already reconciled/);
    expect(head).toMatch(/never write, edit, commit or run a gate/);
    expect(head).not.toMatch(/req_|safeguard|reasoning_extraction|API Error/);
    expect(text.endsWith('THE REQUEST')).toBe(true);
    expect(providerResumePrompt('R', { feature_id: 'F-1', failure: RATE, reconciled: null, next_action: null })).toMatch(/nothing of Mycelink's was in flight|feature status F-1/);
  });
});

const ws = '/w';
const delivered = { feature_id: 'CSET-203', initialised: true, complete: true, candidate: 'CSET-203-C001', incomplete: [] };

describe('the controller record and trust of a recovered run', () => {
  const failed = (index: number, purpose: string, failure: Record<string, unknown>, transcript = '') => ({ index, purpose, phase: 'task', resumes: null, ended_by: 'exit', exit_code: 1, provider_failure: failure, transcript });
  const resumed = (index: number, resumes: number) => ({ index, purpose: 'resume', phase: 'task', resumes, provider_recovery: true, ended_by: 'exit', exit_code: 0, provider_failure: null, transcript: '' });

  it('a provider interruption a fresh session recovered is recovered, never a failure; the exit 1 is not exited-incomplete', () => {
    const report = controllerReport({ arm: 'with', workspace: ws, phases: [{ phase: 'task', sessions: [failed(1, 'task', REFUSAL), resumed(2, 1)], mycelink: delivered }] });
    expect(report.failures).toEqual([]);
    expect(report.recovered).toEqual([expect.stringMatching(/^provider-interrupted: session 1 \(task\) was ended by a transient model-provider failure \(provider-refusal\); resumed by session 2 \(resume\)/)]);
  });

  it('trust re-reads each recorded failure from its transcript: bounded, attested recoveries pass; a tampered or unrecorded one, or too many, do not', () => {
    const dir = makeTmpDir('bench-provider-trust-');
    const t1 = join(dir, '1-task.jsonl');
    writeFileSync(t1, R10_STREAM);
    const ok = {
      sessions: [failed(1, 'task', sessionFailure(R10_STREAM, 1), t1), resumed(2, 1)],
      provider_recoveries: [{ phase: 'task', session: 1, class: 'provider-refusal', request_id: 'req_synthetic_r10_refusal', count: 1, resumed_by: 2, outcome: 'resumed', reconciled: { outcome: 'RECONCILED', interrupted: [{ count: { ticket: 1, phase: 1 } }] } }],
    };
    expect(providerTrustProblems(ok)).toEqual([]);
    // The transcript says nothing of it (rewritten after the run): refused.
    const tampered = join(dir, 'tampered.jsonl');
    writeFileSync(tampered, `${JSON.stringify({ type: 'result', is_error: false })}\n`);
    expect(providerTrustProblems({ ...ok, sessions: [failed(1, 'task', REFUSAL, tampered), resumed(2, 1)] })).toEqual([expect.stringMatching(/provider recovery: session 1's transcript does not record/)]);
    // Another request id than the transcript's: refused.
    expect(providerTrustProblems({ ...ok, provider_recoveries: [{ ...ok.provider_recoveries[0], request_id: 'req_011Other' }] })).toEqual([expect.stringMatching(/does not record/)]);
    // A resume the record never accounts for: refused.
    expect(providerTrustProblems({ ...ok, sessions: [...ok.sessions, resumed(3, 2)] })).toEqual([expect.stringMatching(/session 3 resumed .* no recorded provider failure/)]);
    // More than the bounds: refused.
    const many = Array.from({ length: 5 }, (_, i) => ({ ...ok.provider_recoveries[0], count: i + 1 }));
    expect(providerTrustProblems({ ...ok, provider_recoveries: many }).some((p: string) => /more than 4/.test(p))).toBe(true);
    expect(providerTrustProblems({ ...ok, provider_recoveries: [{ ...ok.provider_recoveries[0], reconciled: { outcome: 'RECONCILED', interrupted: [{ count: { ticket: 3, phase: 1 } }] } }] }).some((p: string) => /ticket/.test(p))).toBe(true);
    // A permanent failure is never recovered.
    expect(providerTrustProblems({ ...ok, sessions: [failed(1, 'task', AUTH, t1), resumed(2, 1)] }).length).toBeGreaterThan(0);
  });
});

// ---- the with arm, end to end on the toy: the stand-in controller's reply refused right after a dispatch, as r10's was.

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
  const dir = makeTmpDir('bench-provider-');
  const log = join(dir, 'log.jsonl');
  writeFileSync(log, '');
  const file = join(dir, 'plan.json');
  const regression = { 'mod-a': { 'mod-a/test/regression.test.mjs': `${T}test('regression', () => {});\n` } };
  writeFileSync(file, JSON.stringify({ log, work: Object.fromEntries(['mod-a', 'mod-b'].map((m) => [m, { tests: Object.fromEntries(Object.entries(AGENT_TESTS).filter(([p]) => p.startsWith(`${m}/`))), impl: Object.fromEntries(Object.entries(TOY.referenceCode).filter(([p]) => p.startsWith(`${m}/`))) }])), regression, ...extra }));
  return { dir, file, entries: () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
}

const withArm = (plan: { dir: string; file: string }) =>
  runArm({
    suiteRoot: toy.suite,
    caseKey: TOY_PRD,
    arm: 'with',
    outDir: join(makeTmpDir('bench-provider-run-'), 'run'),
    cacheRoot: toy.cacheRoot,
    claude: [process.execPath, FAKE_HOST],
    pollMs: 100,
    env: { FAKE_CLAUDE_PLAN: plan.file },
    isolation: TEST_ISOLATION,
    sessionBinds: [{ path: plan.dir, rw: true }],
    preflightProxy: PROXY,
    proxyAllow: ['api.anthropic.com:443', PROXY.allowed],
  });

const toyState = (run: any) => JSON.parse(readFileSync(join(run.workspace, 'platform', 'features', 'TOY-001', 'STATE.json'), 'utf8')).data;

describe('the with arm, model-free: the provider refuses the controller right after a dispatch (r10)', () => {
  it('session 1 exits 1 on the refusal; Mycelink reconciles the live claim at once; a fresh resume session, told so, delivers; nothing charged; the old ticket is stale', async () => {
    const plan = hostPlan({ taskRefusals: ['after-dispatch'] });
    const run = await withArm(plan);
    expect(run.sessions.map((s: any) => [s.index, s.purpose, s.ended_by, s.exit_code, s.resumes ?? null, s.provider_recovery ?? false])).toEqual([
      [1, 'task', 'exit', 1, null, false],
      [2, 'resume', 'exit', 0, 1, true],
    ]);
    expect(run.sessions[0].provider_failure).toMatchObject({ class: 'provider-refusal', transient: true, category: 'reasoning_extraction', request_id: expect.stringMatching(/^req_/) });
    expect(run.faults).toEqual([]);
    expect(run.continuations).toEqual([]);
    expect(run.provider_recoveries).toEqual([
      expect.objectContaining({
        phase: 'task',
        session: 1,
        class: 'provider-refusal',
        resumed_by: 2,
        outcome: 'resumed',
        remaining_ms: expect.any(Number),
        reconciled: expect.objectContaining({ outcome: 'RECONCILED', interrupted: [expect.objectContaining({ kind: 'worker', node_id: 'TOY-001.mod-a.impl', action: 'released', class: 'provider-refusal', count: { ticket: 1, phase: 1 } })] }),
      }),
    ]);
    expect(run.provider).toMatchObject({ recoveries: 1, unavailable: false, permanent: null, lineage: [{ session: 1, resumes: null, provider_recovery: false }, { session: 2, resumes: 1, provider_recovery: true }] });
    const prompts = plan.entries().filter((e) => typeof e.prompt === 'string').map((e) => e.prompt as string);
    expect(prompts[1]!.startsWith(PROVIDER_RESUME_PROMPT)).toBe(true);
    expect(prompts[1]).toMatch(/TOY-001\.mod-a\.impl/);
    // The old ticket, presented late by the fresh session: stale, nothing charged.
    expect(plan.entries().filter((e) => e.late).map((e) => e.late.outcome)).toEqual(['STALE_ORCHESTRATION_EPOCH']);
    const state = toyState(run);
    expect(state.nodes['TOY-001.mod-a.impl']).toMatchObject({ state: 'DONE', attempts: 1 });
    expect(state.nodes['TOY-001.mod-a.impl'].interruptions ?? 0).toBe(0);
    expect(state.orchestration.leases.filter((l: any) => l.status === 'interrupted-provider')).toEqual([expect.objectContaining({ node_id: 'TOY-001.mod-a.impl', provider: expect.objectContaining({ class: 'provider-refusal', source: 'host-transcript' }) })]);
    expect(run.controller).toMatchObject({ ok: true, failures: [] });
    expect(run.controller.recovered).toEqual([expect.stringMatching(/^provider-interrupted: session 1 \(task\)/)]);
    expect(run.trust.problems.filter((p: string) => /provider/.test(p))).toEqual([]);
    expect(run.delivery).toMatchObject({ ok: true, failures: [] });
    expect(run.ok).toBe(true);
  }, 600_000);

  it('a rate limit after the dispatch is recovered the same way', async () => {
    const plan = hostPlan({ taskRefusals: ['rate-limit-after-dispatch'] });
    const run = await withArm(plan);
    expect(run.sessions.map((s: any) => [s.purpose, s.exit_code, s.provider_failure?.class ?? null])).toEqual([['task', 1, 'rate-limit'], ['resume', 0, null]]);
    expect(run.provider_recoveries[0].reconciled.interrupted[0]).toMatchObject({ node_id: 'TOY-001.mod-a.impl', class: 'rate-limit' });
    expect(run.delivery.ok).toBe(true);
  }, 600_000);

  it('an authentication failure is not retried: one session, the phase ended provider-permanent, a provider failure on the record', async () => {
    const plan = hostPlan({ taskRefusals: ['auth-after-dispatch'] });
    const run = await withArm(plan);
    expect(run.sessions.map((s: any) => [s.purpose, s.exit_code, s.provider_failure?.class ?? null])).toEqual([['task', 1, 'auth']]);
    expect(run.phases[0]).toMatchObject({ ended_by: 'provider-permanent' });
    expect(run.provider_recoveries).toEqual([]);
    expect(run.provider).toMatchObject({ recoveries: 0, permanent: expect.objectContaining({ session: 1, class: 'auth' }) });
    expect(run.delivery.failures).toContainEqual(expect.stringMatching(/^provider:permanent: session 1 \(task\) ended on auth/));
    expect(run.verdict).not.toBe('verified');
  }, 600_000);

  it('the same ticket refused three times: two recoveries, then Mycelink stops PROVIDER_UNAVAILABLE and the phase ends, the node never BLOCKED', async () => {
    const plan = hostPlan({ taskRefusals: ['after-dispatch', 'after-dispatch', 'after-dispatch'] });
    const run = await withArm(plan);
    expect(run.sessions.map((s: any) => s.purpose)).toEqual(['task', 'resume', 'resume']);
    expect(run.provider_recoveries.map((r: any) => r.outcome), JSON.stringify({ phases: run.phases, sessions: run.sessions.map((s: any) => [s.index, s.purpose, s.exit_code, s.provider_failure, s.terminal ?? null]), recoveries: run.provider_recoveries, poll: run.poll_errors })).toEqual(['resumed', 'resumed', 'provider-unavailable']);
    expect(run.phases[0]).toMatchObject({ ended_by: 'provider-unavailable' });
    const state = toyState(run);
    expect(state.orchestration.provider.unavailable).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(state.nodes['TOY-001.mod-a.impl']).toMatchObject({ state: 'READY', claim: null });
    expect(run.provider).toMatchObject({ recoveries: 2, unavailable: true });
    expect(run.delivery.failures).toContainEqual(expect.stringMatching(/^provider:unavailable/));
    expect(run.trust.problems.filter((p: string) => /provider/.test(p))).toEqual([]);
  }, 900_000);

  it("the reviewer's final answer refused: its generation revoked and re-issued within the same session, no correction or round spent", async () => {
    const plan = hostPlan({ reviewRefusals: ['refusal'] });
    const run = await withArm(plan);
    expect(run.sessions.map((s: any) => [s.purpose, s.exit_code])).toEqual([['task', 0]]);
    expect(plan.entries().filter((e) => e.reviewed).map((e) => [e.reviewed.outcome, e.reviewed.attempt])).toEqual([['PROVIDER_INTERRUPTED', 1], ['PASS', 2]]);
    const state = toyState(run);
    expect(state.acceptance_review.reviews.map((r: any) => r.outcome)).toEqual(['PASS']);
    expect(state.orchestration.provider.interruptions).toEqual([expect.objectContaining({ kind: 'review', action: 'review-reissue', class: 'provider-refusal', source: 'agent-transcript' })]);
    expect(run.delivery.ok).toBe(true);
  }, 600_000);
});
