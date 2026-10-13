/**
 * A with-arm controller session that exits 0 while its feature is incomplete
 * and still resumable is followed, automatically, by a fresh `resume`
 * controller session (CSET-203 r4: the corrective session exited 0 with the
 * cli READY in its rework generation, one attempt left, and the run ended
 * failed). Bounded: at most two consecutive incomplete exits are continued,
 * on the same phase budget; no fault is recorded; a session that changed
 * nothing ends it, as does a state no controller can move on (a decision, a
 * stop) or a spent budget. Each continuation is recorded, and an incomplete
 * exit a later session completed is recovered, not failed. The without arm
 * is unchanged: it has no feature to resume.
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
import { AWAIT_WORKER_MAX_MS, AWAIT_WORKER_POLL_MS, MAX_CONTINUATIONS, awaitLiveLease, controllerReport, matrixRunEntry, runArm, runPhase } from '../../evals-public-projects/lib/arms.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { CONTINUATION_PROMPT, continuationPrompt } from '../../evals-public-projects/lib/faults.mjs';

afterAll(() => cleanupTmpRoots());

type Session = { index: number; purpose: string; phase: string; resumes: number | null; continuation?: boolean; ended_by: string; exit_code: number | null; text: string };

/** A scripted phase: each session ends as `ends` says; `decide` answers each continuation. */
async function scripted(ends: string[], decide: (s: Session, info: { consecutive: number; bounded: boolean; budget: boolean }) => { text: string } | null, deadline = Date.now() + 60_000) {
  const started: Session[] = [];
  const asked: { after: number; consecutive: number; bounded: boolean; budget: boolean }[] = [];
  const start = async ({ purpose, phase, text, resumes, continuation }: { purpose: string; phase: string; text: string; resumes: number | null; continuation?: boolean }) => {
    const index = started.length + 1;
    const s: Session = { index, purpose, phase, resumes, ...(continuation ? { continuation: true } : {}), ended_by: ends[index - 1] ?? 'exit', exit_code: (ends[index - 1] ?? 'exit') === 'exit' ? 0 : null, text };
    started.push(s);
    return s;
  };
  const p = await runPhase({
    phase: 'task',
    prompt: 'the request',
    deadline,
    start,
    continuation: async (s: Session, info: { consecutive: number; bounded: boolean; budget: boolean }) => {
      asked.push({ after: s.index, ...info });
      return decide(s, info);
    },
  });
  return { p, started, asked };
}

describe('runPhase: an incomplete exit is continued by a fresh resume session', () => {
  it('continues once when asked to, the new session a `resume` of the one that exited, then ends when told the feature is done', async () => {
    const { p, started, asked } = await scripted(['exit', 'exit'], (s) => (s.index === 1 ? { text: 'continue please' } : null));
    expect(started.map((s) => [s.index, s.purpose, s.resumes, s.continuation ?? false])).toEqual([
      [1, 'task', null, false],
      [2, 'resume', 1, true],
    ]);
    expect(started[1]!.text).toBe('continue please');
    expect(asked).toEqual([
      { after: 1, consecutive: 1, bounded: false, budget: true },
      { after: 2, consecutive: 2, bounded: false, budget: true },
    ]);
    expect(p).toMatchObject({ phase: 'task', ended_by: 'exit', sessions: started });
  });

  it(`stops after ${MAX_CONTINUATIONS} consecutive continued exits: the next incomplete exit is reported bounded and ends the phase`, async () => {
    expect(MAX_CONTINUATIONS).toBe(2);
    const { started, asked } = await scripted(['exit', 'exit', 'exit', 'exit', 'exit'], () => ({ text: 'again' }));
    expect(started.map((s) => s.purpose)).toEqual(['task', 'resume', 'resume']);
    expect(asked.at(-1)).toEqual({ after: 3, consecutive: 3, bounded: true, budget: true });
  });

  it('a spent budget is reported and ends the phase; an interrupt in between starts the count again', async () => {
    const spent = await scripted(['exit'], () => ({ text: 'again' }), Date.now() - 1);
    expect(spent.started.map((s) => s.purpose)).toEqual(['task']);
    expect(spent.asked).toEqual([{ after: 1, consecutive: 1, bounded: false, budget: false }]);
    const mixed = await scripted(['exit', 'interrupt', 'exit', 'exit'], (s) => (s.index < 4 ? { text: 'again' } : null));
    expect(mixed.started.map((s) => [s.purpose, s.ended_by])).toEqual([['task', 'exit'], ['resume', 'interrupt'], ['resume', 'exit'], ['resume', 'exit']]);
    expect(mixed.asked.map((a) => a.consecutive)).toEqual([1, 1, 2]);
  });

  it('without a continuation (the without arm), an exit ends the phase as before', async () => {
    const started: string[] = [];
    const p = await runPhase({ phase: 'task', prompt: 'x', deadline: Date.now() + 60_000, start: async ({ purpose }: { purpose: string }) => (started.push(purpose), { index: started.length, purpose, ended_by: 'exit', exit_code: 0 }) });
    expect(started).toEqual(['task']);
    expect(p.ended_by).toBe('exit');
  });
});

describe('a controller that exited on a live dispatch lease (await-worker, CSET-203 r7)', () => {
  const clock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  };
  const kind = (k: string) => ({ next_action: { kind: k, resumable: true }, resumable: true });

  it('is waited for, without a model session, until the next action changes', async () => {
    const c = clock();
    const seen = [kind('await-worker'), kind('await-worker'), kind('dispatch')];
    let i = 0;
    const r = await awaitLiveLease({ read: () => seen[Math.min(i++, seen.length - 1)], digest: () => 'same', pollMs: 1000, maxMs: 10_000, ...c });
    expect(r).toMatchObject({ until: 'changed', polls: 3, waited_ms: 2000, status: { next_action: { kind: 'dispatch' } } });
  });

  it('stops waiting when the state moves, or at its bound — its holder went with the session, and a fresh controller re-issues it', async () => {
    const moved = clock();
    let d = 0;
    expect(await awaitLiveLease({ read: () => kind('await-worker'), digest: () => (d++ === 0 ? 'before' : 'after'), pollMs: 1000, maxMs: 10_000, ...moved })).toMatchObject({ until: 'progress', polls: 1 });
    const bounded = clock();
    const r = await awaitLiveLease({ read: () => kind('await-worker'), digest: () => 'same', pollMs: 1000, maxMs: 3500, ...bounded });
    expect(r).toMatchObject({ until: 'bounded', polls: 4, waited_ms: 3000 });
    expect(AWAIT_WORKER_POLL_MS).toBeLessThanOrEqual(AWAIT_WORKER_MAX_MS);
  });
});

describe('the continuation prompt', () => {
  it('mandates /mycelink:run first, names the exact READY node and its refusal, keeps the controller fence, then the request', () => {
    const text = continuationPrompt('Build the thing.', {
      feature_id: 'CSET-203',
      incomplete: ['node CSET-203.changesets.cli.impl is READY', 'node CSET-203.changesets.compat.verify is INVALIDATED', 'no current candidate'],
      next_action: {
        kind: 'dispatch',
        resumable: true,
        detail: 'CSET-203.changesets.cli.impl is READY: rework generation 2, attempt 1 of 2 used; last refused TDD_HISTORY_INVALID:CHANGED_RED_BLOBS at 49a535798620',
        nodes: [{ node_id: 'CSET-203.changesets.cli.impl', state: 'READY', rework_generation: 2, attempts_used: 1, max_attempts: 2, last_refusal: { code: 'TDD_HISTORY_INVALID:CHANGED_RED_BLOBS', commit: '49a535798620cc89623b73c671d54a919603a647' } }],
      },
    });
    expect(text.startsWith(CONTINUATION_PROMPT)).toBe(true);
    expect(CONTINUATION_PROMPT).toMatch(/first action[^.]*`\/mycelink:run`/i);
    expect(CONTINUATION_PROMPT).toMatch(/never write[^.]*product/i);
    expect(text).toContain('CSET-203.changesets.cli.impl is READY: rework generation 2, attempt 1 of 2 used; last refused TDD_HISTORY_INVALID:CHANGED_RED_BLOBS at 49a535798620');
    expect(text).toContain('node CSET-203.changesets.compat.verify is INVALIDATED');
    expect(text.endsWith('The original request follows.\n\nBuild the thing.')).toBe(true);
  });
});

describe('the controller record of a continued phase', () => {
  const ws = '/w';
  const exit = (index: number, purpose: string, extra: Record<string, unknown> = {}) => ({ index, purpose, phase: 'task', ended_by: 'exit', exit_code: 0, transcript: `/s/${index}.jsonl`, controller_edits: [], ...extra });
  const delivered = { feature_id: 'F-1', complete: true, candidate: 'F-1-C001', incomplete: [] };
  const stuck = { feature_id: 'F-1', complete: false, candidate: null, incomplete: ['node N is READY'] };

  it('an incomplete exit a continuation completed is recovered, never a failure', () => {
    const report = controllerReport({ arm: 'with', workspace: ws, phases: [{ phase: 'task', sessions: [exit(1, 'task'), exit(2, 'resume', { resumes: 1, continuation: true })], mycelink: delivered }] });
    expect(report.failures).toEqual([]);
    expect(report.recovered).toEqual([expect.stringMatching(/^exited-incomplete: session 1 \(task\) exited 0 with the feature incomplete; continued by session 2 \(resume\), which completed it through Mycelink to F-1-C001$/)]);
  });

  it('a continued phase that still ends incomplete fails on its last exit, as before', () => {
    const report = controllerReport({ arm: 'with', workspace: ws, phases: [{ phase: 'task', sessions: [exit(1, 'task'), exit(2, 'resume', { resumes: 1, continuation: true })], mycelink: stuck }] });
    expect(report.recovered).toEqual([]);
    expect(report.failures).toEqual(['exited-incomplete: session 2 (resume) exited 0 with F-1 incomplete: node N is READY']);
  });

  it('the matrix entry of a run counts its continuation sessions apart', () => {
    const entry = matrixRunEntry({ arm: 'with', condition: 'normal', verdict: 'verified', sessions: [exit(1, 'task'), exit(2, 'resume', { resumes: 1, continuation: true })], phases: [], continuations: [{ phase: 'task', after_session: 1, session: 2, outcome: 'resumed' }] }, '/m');
    expect(entry.sessions.map((s: { purpose: string; continuation: boolean }) => [s.purpose, s.continuation])).toEqual([['task', false], ['resume', true]]);
    expect(entry.continuations).toEqual([{ phase: 'task', after_session: 1, session: 2, outcome: 'resumed' }]);
    expect(entry.extra_sessions).toBe(1);
  });
});

// ---- the with arm, end to end on the toy: the stand-in controller exits 0 after one node, as r4's corrective did.

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
  const dir = makeTmpDir('bench-continue-');
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
    outDir: join(makeTmpDir('bench-continue-run-'), 'run'),
    cacheRoot: toy.cacheRoot,
    claude: [process.execPath, FAKE_HOST],
    pollMs: 100,
    env: { FAKE_CLAUDE_PLAN: plan.file },
    isolation: TEST_ISOLATION,
    sessionBinds: [{ path: plan.dir, rw: true }],
    preflightProxy: PROXY,
    proxyAllow: ['api.anthropic.com:443', PROXY.allowed],
  });

describe('the with arm continues a controller that exited 0 incomplete', () => {
  it('session 1 exits after one node settles; a fresh resume session, told /mycelink:run first and which node is READY, delivers; the delivery holds, recovered, no fault', async () => {
    const plan = hostPlan({ taskExits: ['settled-one'] });
    const run = await withArm(plan);
    expect(run.sessions.map((s: any) => [s.index, s.purpose, s.ended_by, s.exit_code, s.resumes ?? null, s.continuation ?? false])).toEqual([
      [1, 'task', 'exit', 0, null, false],
      [2, 'resume', 'exit', 0, 1, true],
    ]);
    expect(run.faults).toEqual([]);
    expect(run.continuations).toEqual([expect.objectContaining({ phase: 'task', after_session: 1, session: 2, outcome: 'resumed', next_action: expect.objectContaining({ kind: 'dispatch', resumable: true }) })]);
    const prompts = plan.entries().filter((e) => typeof e.prompt === 'string').map((e) => e.prompt as string);
    expect(prompts[1]!.startsWith(CONTINUATION_PROMPT)).toBe(true);
    expect(prompts[1]).toMatch(/TOY-001\.mod-b\.impl/);
    expect(run.controller).toMatchObject({ ok: true, failures: [] });
    expect(run.controller.recovered).toEqual([expect.stringMatching(/^exited-incomplete: session 1 \(task\) exited 0 with the feature incomplete; continued by session 2 \(resume\)/)]);
    // What keeps this harness's runs from `verified` is its setup alone (no suite pin, a toy, off Linux no boundary): the delivery holds.
    expect(run.delivery).toMatchObject({ ok: true, failures: [] });
    expect(run.ok).toBe(true);
  }, 600_000);

  it('a continuation that changes nothing ends the phase there: no third session, exited-incomplete, recorded as no progress', async () => {
    const plan = hostPlan({ taskExits: ['setup', 'setup', 'setup'] });
    const run = await withArm(plan);
    expect(run.sessions.map((s: any) => [s.purpose, s.ended_by])).toEqual([['task', 'exit'], ['resume', 'exit']]);
    expect(run.continuations.map((c: any) => c.outcome)).toEqual(['resumed', 'no-progress']);
    expect(run.controller.failures).toEqual([expect.stringMatching(/^exited-incomplete: session 2 \(resume\) exited 0/)]);
    expect(run.delivery.ok).toBe(false);
    expect(run.delivery.failures).toContainEqual(expect.stringMatching(/^controller:exited-incomplete: session 2 \(resume\)/));
    expect(run.verdict).not.toBe('verified');
  }, 600_000);
});
