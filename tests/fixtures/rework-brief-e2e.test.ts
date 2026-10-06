/**
 * A rework the worker can act on, end to end.
 *
 * Regression for a real-model run: QA found, after delivery, that the API
 * accepted a 201-character refund reason (the requirement's maximum is 200).
 * The host reworked the owning node through the controller with exactly
 * that reason, but the reason never reached the worker: its own local suite
 * was green, it could not write a RED, reported INVALID_RED_EVIDENCE, and
 * the node parked on its last attempt.
 *
 * Here the controller carries the reason to the worker as a bounded,
 * data-only rework brief in the dispatch ticket and context pack; the worker
 * turns it into a focused failing regression test before changing
 * production code; one worker mistake inside the approved rework is a
 * retryable, recorded failure (the generation has its own bounded attempt
 * allowance, lifetime attempts and fingerprints are kept); and the repair
 * settles, a replacement candidate is cut and delivered, and the same single
 * feature verifies.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { FEATURE_ID, type Portfolio } from '../helpers/portfolio-fixture.js';
import { fakeAgent, type AgentBehaviour, type DispatchTicket } from '../helpers/host-agent.js';
import { CANDIDATE, WORK, WEB, cli, dispatch, hostLoop, hostPortfolio, settle } from '../helpers/host-loop.js';
import { git } from '../helpers/git-fixture.js';
import { loadState } from '../../src/state/feature-state.js';
import { loadCandidate } from '../../src/git/candidate.js';
import type { ContextPack } from '../../src/sessions/context-pack.js';

afterAll(() => cleanupTmpRoots());

/** The first delivery: renders the result, but validates the refund reason against the wrong maximum. */
const BUGGY_VIEW = [
  'export const RENDER_JOB_RESULT = true;',
  'export const MAX_REFUND_REASON = 300;',
  'export function acceptRefundReason(reason) {',
  '  return typeof reason === "string" && reason.length > 0 && reason.length <= MAX_REFUND_REASON;',
  '}',
  '',
].join('\n');

const FIXED_VIEW = BUGGY_VIEW.replace('MAX_REFUND_REASON = 300', 'MAX_REFUND_REASON = 200');

const QA_REASON =
  'Acceptance test 03-refunds-api R4 failed: POST refund with 201-char reason returned 202 instead of 400 ' +
  'VALIDATION_FAILED (AC-3 check 2). Validation lives in web src/view.js, owned by this node.';

/** QA's acceptance check, run by the host against the delivered web main branch. */
async function qaAcceptsRefundLimit(p: Portfolio): Promise<boolean> {
  const dir = makeTmpDir('qa-');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `view-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`);
  writeFileSync(file, git(p.app, ['show', 'main:src/view.js']) + '\n', 'utf8');
  const view = (await import(pathToFileURL(file).href)) as { acceptRefundReason?: (r: string) => boolean };
  if (typeof view.acceptRefundReason !== 'function') return false;
  return view.acceptRefundReason('x'.repeat(200)) && !view.acceptRefundReason('x'.repeat(201));
}

/** The context pack exactly as the worker reads it: the JSON between the prompt's data delimiters. */
function packFromPrompt(prompt: string): ContextPack {
  const open = '<mycelink-context-pack>';
  const close = '</mycelink-context-pack>';
  const start = prompt.indexOf(open);
  const end = prompt.indexOf(close);
  expect(start).toBeGreaterThan(-1);
  expect(prompt.indexOf(open, start + 1)).toBe(-1);
  expect(prompt.indexOf(close, end + 1)).toBe(-1);
  return JSON.parse(prompt.slice(start + open.length, end)) as ContextPack;
}

/**
 * A worker that follows the node-worker skill on a rework: it reads the
 * brief, writes a focused regression test for the failure it describes,
 * proves it RED against the current code, then fixes production code.
 */
function briefDrivenWorker(t: DispatchTicket): AgentBehaviour {
  const pack = packFromPrompt(t.prompt);
  const brief = pack.rework;
  if (brief === undefined) throw new Error('no rework brief: nothing to write a regression test from');
  const over = /(\d+)-char/.exec(brief.reason);
  if (over === null) throw new Error('the brief does not say which input failed');
  const bad = Number(over[1]);
  return {
    tests: {
      'tests/run.mjs': [
        "import { RENDER_JOB_RESULT, acceptRefundReason } from '../src/view.js';",
        "if (!RENDER_JOB_RESULT) { console.error('AssertionError: result not rendered'); process.exit(1); }",
        `if (acceptRefundReason('x'.repeat(${bad}))) {`,
        `  console.error('AssertionError: a ${bad}-character refund reason was accepted');`,
        '  process.exit(1);',
        '}',
        `if (!acceptRefundReason('x'.repeat(${bad - 1}))) {`,
        `  console.error('AssertionError: a ${bad - 1}-character refund reason was refused');`,
        '  process.exit(1);',
        '}',
        "console.log('ok 1 - refund reason limit');",
        '',
      ].join('\n'),
    },
    impl: { 'src/view.js': FIXED_VIEW },
  };
}

describe('rework brief: QA failure -> regression test -> repaired delivery, one feature', () => {
  let p: Portfolio;

  beforeAll(async () => {
    p = await hostPortfolio();
  });

  it('1. the feature is delivered; QA finds the 201-character refund reason accepted', async () => {
    const run = await hostLoop(p, { ...WORK, [WEB]: { impl: { 'src/view.js': BUGGY_VIEW } } });
    expect(run.status).toBe('ALL_SETTLED');
    const d = await cli(p, ['deliver', FEATURE_ID, '--json']);
    expect(d.err).toBe('');
    expect(JSON.parse(d.out)).toMatchObject({ status: 'ACCEPTED' });
    expect(await qaAcceptsRefundLimit(p)).toBe(false);
    expect(loadState(p.featureDir)!.data.nodes[WEB]!.attempts).toBe(1);
  });

  it('2. the controller records an audited rework brief from the reason', async () => {
    const r = await cli(p, [
      'node', 'rework', FEATURE_ID, WEB, '--reason', QA_REASON,
      '--evidence', 'qa/03-refunds-api/R4.log', '--json',
    ]);
    expect(r.err).toBe('');
    const s = loadState(p.featureDir)!.data;
    const brief = s.nodes[WEB]!.rework_brief!;
    expect(brief).toMatchObject({
      generation: 1,
      limit: s.budget.max_same_failure,
      reason: QA_REASON,
      acceptance_criteria: ['AC-3'],
      evidence: ['qa/03-refunds-api/R4.log'],
      attempt_base: 1,
      replaced: { candidate_id: `${FEATURE_ID}-C001` },
    });
    expect(brief.reason_sha256).toMatch(/^[0-9a-f]{64}$/);
    // Audited: the event log carries the reason's hash and generation.
    const reworked = readFileSync(join(p.featureDir, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.includes('"node.reworked"'))
      .map((l) => JSON.parse(l) as { data: Record<string, unknown> });
    expect(reworked).toHaveLength(1);
    expect(reworked[0]!.data).toMatchObject({ generation: 1, reason_sha256: brief.reason_sha256 });
  });

  it('3. the dispatch ticket and pack carry the bounded brief, and the prompt says to use it', async () => {
    const d = await dispatch(p);
    expect(d.status).toBe('DISPATCHED');
    const t = d.ticket!;
    expect(t.node_id).toBe(WEB);
    expect(t.rework).toMatchObject({ generation: 1, reason: QA_REASON });
    const pack = packFromPrompt(t.prompt);
    expect(pack.rework).toMatchObject({
      generation: 1,
      reason: QA_REASON,
      acceptance_criteria: ['AC-3'],
      evidence: ['qa/03-refunds-api/R4.log'],
      scope: { node_id: WEB, repository: 'web' },
    });
    expect(pack.budget).toMatchObject({ attempt: 1, max_attempts: 2, lifetime_attempts: 2 });
    expect(t.prompt).toMatch(/rework brief/i);
    expect(t.prompt).toMatch(/focused failing regression test/i);
    expect(t.prompt).toMatch(/green local suite is not evidence/i);
    // Never controller authority.
    expect(t.prompt).not.toMatch(/--authority\s+[0-9a-f]{64}/);

    // 4. The worker's first try is a mistake: it reruns the old green suite,
    // cannot make a RED, and reports INVALID_RED_EVIDENCE as BLOCKED, as the
    // real worker did. Inside an approved rework that is a recorded,
    // retryable failure, not a park.
    fakeAgent(
      t,
      {
        outcome: 'BLOCKED',
        failure_fingerprint:
          'INVALID_RED_EVIDENCE: implementation and tests already committed (13/13 pass); RED exited 0 and no behaviour is missing',
      },
      p.control,
    );
    const settled = await settle(p, WEB, t.capability);
    expect(settled).toMatchObject({ outcome: 'RETRY' });
    const s = loadState(p.featureDir)!.data.nodes[WEB]!;
    expect(s.state).toBe('READY');
    expect(s.attempts).toBe(2);
    expect(s.failure_counts).toEqual({ INVALID_RED_EVIDENCE: 1 });
    expect(s.rework_history).toHaveLength(1);
  });

  it('5. the retry stays inside the approved rework: brief kept, RED from the brief, repair settles', async () => {
    const d = await dispatch(p);
    expect(d.status).toBe('DISPATCHED');
    const t = d.ticket!;
    expect(t.node_id).toBe(WEB);
    const pack = packFromPrompt(t.prompt);
    expect(pack.rework).toMatchObject({ generation: 1, reason: QA_REASON });
    expect(pack.budget).toMatchObject({ attempt: 2, max_attempts: 2, lifetime_attempts: 3 });
    expect(pack.last_failure_fingerprint).toBe('INVALID_RED_EVIDENCE');

    const run = fakeAgent(t, briefDrivenWorker(t), p.control);
    expect(run.gates).toEqual([
      { gate: 'red', exit: 0 },
      { gate: 'green', exit: 0 },
      { gate: 'regression', exit: 0 },
    ]);
    const settled = await settle(p, WEB, t.capability);
    expect(settled).toMatchObject({ outcome: 'DONE' });
    const s = loadState(p.featureDir)!.data.nodes[WEB]!;
    expect(s.state).toBe('DONE');
    expect(s.evidence.red).toMatchObject({ red_reason: 'behaviour-missing' });
    expect(s.evidence.red!.exit_code).not.toBe(0);
    // Lifetime history kept; the brief is spent once the repair is DONE.
    expect(s.attempts).toBe(3);
    expect(s.failure_counts).toEqual({ INVALID_RED_EVIDENCE: 1 });
    expect(s.rework_brief ?? null).toBeNull();
  });

  it('6. a replacement candidate is cut and delivered, and the same feature verifies', async () => {
    const d = await dispatch(p);
    expect(d.status).toBe('ALL_SETTLED');
    expect(d.controller_reports.map((r) => [r.node_id, r.outcome])).toEqual([[CANDIDATE, 'DONE']]);
    const s = loadState(p.featureDir)!.data;
    expect(s.current_candidate).toBe(`${FEATURE_ID}-C002`);
    const c = loadCandidate(p.featureDir, s.current_candidate!);
    const delivered = await cli(p, ['deliver', FEATURE_ID, '--json']);
    expect(delivered.err).toBe('');
    expect(JSON.parse(delivered.out)).toMatchObject({ status: 'ACCEPTED' });
    expect(git(p.app, ['rev-parse', 'main'])).toBe(c.repositories['web']!.sha);
    expect((await cli(p, ['feature', 'verify', FEATURE_ID])).code).toBe(0);
    expect((await cli(p, ['candidate', 'verify', FEATURE_ID])).code).toBe(0);
    expect(loadState(p.featureDir)!.data.feature_state).toBe('COMPLETED');
    expect(await qaAcceptsRefundLimit(p)).toBe(true);
    expect(readdirSync(join(p.control, 'features')).filter((f) => !f.startsWith('.'))).toEqual([FEATURE_ID]);
  });
});

describe('rework attempts stay bounded', () => {
  it('the same worker failure twice in one approved rework parks the node, with its history', async () => {
    const p = await hostPortfolio();
    expect((await hostLoop(p)).status).toBe('ALL_SETTLED');
    expect((await cli(p, ['node', 'rework', FEATURE_ID, WEB, '--reason', QA_REASON])).code).toBe(0);
    const outcomes: unknown[] = [];
    for (let i = 0; i < 2; i++) {
      const t = (await dispatch(p)).ticket!;
      expect(t.node_id).toBe(WEB);
      fakeAgent(t, { outcome: 'BLOCKED', failure_fingerprint: `INVALID_RED_EVIDENCE: try ${i + 1}, suite is green` }, p.control);
      outcomes.push((await settle(p, WEB, t.capability))['outcome']);
    }
    expect(outcomes).toEqual(['RETRY', 'BLOCKED']);
    const s = loadState(p.featureDir)!.data.nodes[WEB]!;
    expect(s.state).toBe('BLOCKED');
    expect(s.attempts).toBe(3);
    expect(s.failure_counts).toEqual({ INVALID_RED_EVIDENCE: 2 });
    expect(s.rework_history).toHaveLength(1);
    // A parked node is never reopened by another rework.
    const again = await cli(p, ['node', 'rework', FEATURE_ID, WEB, '--reason', QA_REASON + ' (again)']);
    expect(again.err).toContain('REWORK_NOT_DONE');
  });

  it('a rework generation has its own bounded allowance; distinct failures exhaust it', async () => {
    const p = await hostPortfolio();
    expect((await hostLoop(p)).status).toBe('ALL_SETTLED');
    expect((await cli(p, ['node', 'rework', FEATURE_ID, WEB, '--reason', QA_REASON])).code).toBe(0);
    for (const fp of ['gate-green-exit-1', 'gate-regression-exit-1']) {
      const t = (await dispatch(p)).ticket!;
      expect(t.node_id).toBe(WEB);
      fakeAgent(t, { skipGates: true, outcome: 'RETRYABLE', failure_fingerprint: fp }, p.control);
      expect((await settle(p, WEB, t.capability))['outcome']).toBe('RETRY');
    }
    const d = await dispatch(p);
    expect(d.status).not.toBe('DISPATCHED');
    const s = loadState(p.featureDir)!.data.nodes[WEB]!;
    expect(s.attempts).toBe(3);
    expect(s.state).toBe('READY');
  });
});
