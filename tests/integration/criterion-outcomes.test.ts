/**
 * One rework order, settled criterion by criterion (CSET-203 r15).
 *
 * r15 with-normal: R001's AC-3, AC-4 and AC-5 were one order on the cli. One
 * red gate ran the review's exact AC-3 and AC-4 reproductions: AC-3's failed,
 * AC-4's passed on the unchanged base. The worker fixed AC-3 test-first and
 * added AC-5's compatibility-regression unit — and could only answer one
 * outcome for the whole order: the challenge line refused (that red gate had
 * failed AC-3's test), SUBMITTED would have needed a RED for AC-4 that no
 * honest test has, so it asked a person (NEEDS_DECISION): one product attempt,
 * automation stopped. Here, on the CSET-203-shaped fixture, through the
 * ticket's own lines:
 *
 *  - a per-criterion result (schema_version 2, outcome CRITERIA) settles each
 *    criterion on its own: AC-3's RED-proved fix and AC-5's compatibility unit
 *    integrated as the node's new DONE generation, AC-4 recorded as a
 *    challenge of R001 (its prior proof carried, revalidated), R001
 *    CHALLENGED; one product attempt for the one execution, nothing failed;
 *  - settled again, or interrupted at any boundary and finished by dispatch:
 *    integrated once, challenged once;
 *  - its order bound to an older revision of its review: reconciled, never
 *    judged, nothing charged; the reissued worker's answer settles;
 *  - what it may not say: a passing test as a RED, a failing test as a
 *    challenge, one test for two criteria without tracing both, a production
 *    change no DONE criterion's RED drives, a criterion missing;
 *  - one test explicitly traced to two criteria's clauses proves both;
 *  - a criterion BLOCKED or NEEDS_DECISION: the done ones integrated, the
 *    unresolved one ordered again and parked with its own reason;
 *  - a late answer changes nothing.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { git } from '../helpers/git-fixture.js';
import { CLI, CLI_COMPAT_FILE, CLI_COMPAT_TESTS, CLI_COMPAT_TEST_ID, CLI_FAILURE_TEST, CLI_SRC, CLI_TESTS, CLI_TRUNCATED_IMPL, COMPAT, VER_FEATURE, commitVerControl, verCli, verState, verCliTestId, type Ver } from '../helpers/version-fixture.js';
import { commit, packOf, runGate, writeFiles, type ShopTicket } from '../helpers/shop-worker.js';
import { refinementFor, reviewPacket, writeVerdict, type ReviewTicket } from '../helpers/review-agent.js';
import { commitCompat, dispatch, reviewed, settle, status } from '../helpers/cset203-rework.js';
import { GAP_AC1_HOLDS, writeChallenge } from '../helpers/cset203-challenge.js';
import { settleReview } from '../helpers/cset203-r7.js';
import { CLI_SHARED_RED, CLI_SHARED_TEST, GAP_AC3, GAP_AC4_HOLDS, GAP_AC5, checkFor, eventsOf, mixedWork, r15Result, r15Reviewed, sharedClauses, writeCriteriaResult } from '../helpers/cset203-r15.js';
import { Orchestrator, type SettleFaultPoint } from '../../src/engine/orchestrator.js';
import type { SessionAdapter } from '../../src/sessions/adapter.js';
import { mutateState } from '../../src/state/feature-state.js';

afterAll(() => cleanupTmpRoots());

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const R001 = `${VER_FEATURE}-R001`;
const C1 = `${R001}-C1`;
const REV0 = `features/${VER_FEATURE}/reviews/${R001}.json`;
const REV1 = `features/${VER_FEATURE}/reviews/${R001}.refined-1.json`;

const crashing = (s: Ver, point: SettleFaultPoint): Orchestrator =>
  new Orchestrator({ controlRoot: s.control, featureId: VER_FEATURE, adapter: {} as SessionAdapter, settleFault: (p: SettleFaultPoint) => { if (p === point) throw new Error(`CRASH at ${p}`); } });

/** R001 as r15's, and the cli's rework ticket: one order of AC-3, AC-4 and AC-5. */
async function r15Rework(): Promise<{ s: Ver; t: ShopTicket; attempts: number }> {
  const s = await r15Reviewed();
  const state = verState(s);
  expect(state.acceptance_review.reviews[0]).toMatchObject({ review_id: R001, outcome: 'GAPS', reworks: [CLI] });
  const d = await dispatch(s);
  expect(d.status, d.detail).toBe('DISPATCHED');
  const t = d.ticket!;
  expect(t.node_id).toBe(CLI);
  expect(packOf(t)['rework']).toMatchObject({ acceptance_criteria: ['AC-3', 'AC-4', 'AC-5'], origin: { kind: 'acceptance-review', review_id: R001 } });
  return { s, t, attempts: verState(s).nodes[CLI].attempts as number };
}

/** The integration branch's head. */
const integrationHead = (s: Ver): string => git(s.repo, ['rev-parse', `refs/heads/feature/${VER_FEATURE}`]);

/** Everything a valid r15 settle leaves, whichever road it took to it. */
function expectR15Settled(s: Ver, t: ShopTicket, attempts: number, head: string): void {
  const state = verState(s);
  const cli = state.nodes[CLI];
  // One product attempt for the one execution; nothing failed, nothing parked, nothing asked of a person.
  expect(cli).toMatchObject({ state: 'DONE', attempts, claim: null, failure_counts: {}, blocked_reason: null });
  expect(state.pending_decisions).toEqual([]);
  // The node's new generation is the work: AC-3's fix and AC-5's unit, integrated exactly once.
  expect(git(s.repo, ['merge-base', '--is-ancestor', head, integrationHead(s)])).toBe('');
  expect(git(s.repo, ['show', `${integrationHead(s)}:${CLI_SRC}`])).toBe(CLI_TRUNCATED_IMPL.trimEnd());
  expect(git(s.repo, ['show', `${integrationHead(s)}:${CLI_COMPAT_TESTS}`])).toBe(CLI_COMPAT_FILE.trimEnd());
  expect(eventsOf(s).filter((e) => e.type === 'node.integrated' && e.node_id === CLI)).toHaveLength(2);
  // Each criterion as it settled: AC-3 by its RED, AC-5 by its unit's test through green, AC-4 by its prior proof, pending its challenge.
  const byCriterion = Object.fromEntries((cli.criteria as Record<string, any>[]).map((c) => [c.criterion, c]));
  expect(byCriterion['AC-3']).toMatchObject({ gate: 'red', test: { path: CLI_TESTS } });
  expect(byCriterion['AC-5']).toMatchObject({ test_id: CLI_COMPAT_TEST_ID });
  expect(byCriterion['AC-4']).toMatchObject({ test_id: verCliTestId(CLI_FAILURE_TEST), carried: true, challenge_id: C1, carried_from: { generation: 0, gate: 'red' } });
  // The challenge is AC-4's alone; R001 waits for its refinement.
  expect(state.acceptance_review.challenges).toEqual([expect.objectContaining({ challenge_id: C1, node_id: CLI, status: 'pending', gaps: [expect.objectContaining({ criterion: 'AC-4', round: 1 })], partial: expect.objectContaining({ done: ['AC-3', 'AC-5'] }) })]);
  expect(state.acceptance_review.reviews[0]).toMatchObject({ review_id: R001, outcome: 'CHALLENGED' });
  const entry = cli.rework_history.at(-1);
  // The order stood (its generation is the node's): never marked challenged as a whole.
  expect(entry.challenged ?? null).toBeNull();
  expect(entry).toMatchObject({ partial: { done: ['AC-3', 'AC-5'], challenged: ['AC-4'], unresolved: [], challenge_id: C1, dispatch_id: t.dispatch_id } });
  // The lineage gives back AC-4's rework (its challenge), never AC-3's or AC-5's.
  const challengeEvents = (state.acceptance_review.lineage.events as Record<string, any>[]).filter((e) => e.kind === 'challenge');
  expect(challengeEvents.map((e) => e.criterion)).toEqual(['AC-4']);
  expect(eventsOf(s).filter((e) => e.type === 'review.challenged').map((e) => e.data['criteria'])).toEqual([['AC-4']]);
  expect(eventsOf(s).filter((e) => e.type === 'decision.requested')).toEqual([]);
}

describe('r15: one order settled criterion by criterion', () => {
  it("AC-3 DONE by its RED, AC-4 challenged, AC-5 DONE by its unit: the check line agrees, settle integrates the done work and records AC-4's challenge — one attempt, nothing failed, R001 CHALLENGED; settled again, answered from its receipt", async () => {
    const { s, t, attempts } = await r15Rework();
    const run = mixedWork(t, s.control);
    // The red gate kept what a challenge of the passing reproduction binds, though it accepted the RED.
    expect(run.skeleton['challenge']).toMatchObject({ review_id: R001, gate_output_sha256: run.red.sha256, gaps: [{ criterion: 'AC-4', tests: [run.ids.ac4] }] });
    expect((run.skeleton['tests'] as { id: string }[]).map((x) => x.id)).toEqual([run.ids.ac4]);
    r15Result(t, run);
    const check = checkFor(t, s.control);
    expect(check.out, check.raw).toMatchObject({ ok: true, criteria: [{ criterion: 'AC-3', outcome: 'DONE' }, { criterion: 'AC-4', outcome: 'REVIEW_GAP_CHALLENGE' }, { criterion: 'AC-5', outcome: 'DONE' }] });
    const head = git(t.worktree, ['rev-parse', 'HEAD']);
    const settled = await settle(s, t);
    expect(settled, settled.detail).toMatchObject({ outcome: 'CRITERIA_SETTLED', state: 'DONE', criteria: [{ criterion: 'AC-3', outcome: 'DONE' }, { criterion: 'AC-4', outcome: 'REVIEW_GAP_CHALLENGE', challenge_id: C1 }, { criterion: 'AC-5', outcome: 'DONE' }], challenge: { challenge_id: C1, criteria: ['AC-4'], status: 'pending' } });
    commitVerControl(s, 'r15 settled per criterion');
    expectR15Settled(s, t, attempts, head);
    // The challenge's archived receipt binds AC-4 alone, the red gate that passed it and the review as ordered.
    const rec = verState(s).acceptance_review.challenges[0];
    const archived = JSON.parse(readFileSync(join(s.control, ...rec.receipt_path.split('/')), 'utf8')) as Record<string, any>;
    expect(archived).toMatchObject({ challenge_id: C1, review_id: R001, node_id: CLI, gaps: [{ criterion: 'AC-4', tests: [run.ids.ac4] }], gate: { recorded_output_sha256: run.red.sha256 }, partial: { done: ['AC-3', 'AC-5'] } });
    expect(archived['tests']).toEqual([expect.objectContaining({ test_id: run.ids.ac4, status: 'passed' })]);
    // Feature status: the cli is DONE, awaiting the review of AC-4; the next step a fresh reviewer's refinement.
    const st = await status(s);
    expect(st).toMatchObject({ next_action: { kind: 'review-refine', resumable: true } });
    expect(st['next_action']['detail']).toMatch(/AC-4/);
    // The same capability again: its receipt, nothing re-run, nothing recorded twice.
    const again = await settle(s, t);
    expect(again).toMatchObject({ outcome: 'CRITERIA_SETTLED', idempotent: true });
    expectR15Settled(s, t, attempts, head);
  });

  for (const point of ['criteria-judged', 'fresh-verified', 'integrated', 'challenge-archived', 'criteria-recorded'] as SettleFaultPoint[]) {
    it(`a settle that dies at ${point} is finished by dispatch: integrated once, challenged once, no attempt or failure counted`, async () => {
      const { s, t, attempts } = await r15Rework();
      const run = mixedWork(t, s.control);
      r15Result(t, run);
      const head = git(t.worktree, ['rev-parse', 'HEAD']);
      expect(() => crashing(s, point).settle(CLI, t.capability)).toThrow(/CRASH/);
      commitVerControl(s, `crashed at ${point}`);
      const d = await dispatch(s);
      commitVerControl(s, 'finished');
      expect(d.status, d.detail).not.toBe('BLOCKED');
      expectR15Settled(s, t, attempts, head);
    }, 240_000);
  }
});

describe('a per-criterion answer on an order bound to an older revision is reconciled, never judged', () => {
  it("R001's AC-1 challenged and withdrawn (revision 1); the cli's order still bound to revision 0: its mixed answer reconciled, nothing charged; the reissued ticket's answer settles per criterion", async () => {
    const s = await reviewed({ 'AC-1': GAP_AC1_HOLDS, 'AC-3': GAP_AC3, 'AC-4': GAP_AC4_HOLDS, 'AC-5': GAP_AC5 });
    const a = (await dispatch(s)).ticket!;
    writeChallenge(a, s.control);
    expect(await settle(s, a)).toMatchObject({ outcome: 'REVIEW_CHALLENGED', state: 'DONE' });
    commitVerControl(s, 'AC-1 challenged');
    const rr = (await dispatch(s)).ticket as unknown as ReviewTicket;
    expect(rr).toMatchObject({ review_id: R001, refinement: { round: 1 } });
    await writeVerdict(rr, refinementFor(reviewPacket(rr), { 'AC-1': { decision: 'WITHDRAW' } }), { cwd: s.control });
    expect(await settleReview(s, rr)).toMatchObject({ outcome: 'GAPS' });
    commitVerControl(s, 'AC-1 withdrawn');
    const c = (await dispatch(s)).ticket!;
    expect(c.node_id).toBe(CLI);
    // As a STATE.json from before revisions bound it: to R001's original receipt.
    mutateState(s.featureDir, (st) => {
      const n = st.nodes[CLI]!;
      const b = n.rework_brief!;
      b.origin = { kind: 'acceptance-review', review_id: R001, review: 1 };
      b.evidence = [REV0];
      delete b.rebases;
      delete n.rework_history!.at(-1)!.rebases;
      return st;
    });
    commitVerControl(s, 'bound to revision 0');
    const attempts = verState(s).nodes[CLI].attempts as number;
    const run = mixedWork(c, s.control);
    r15Result(c, run);
    const reconciled = await settle(s, c);
    expect(reconciled, reconciled.detail).toMatchObject({ outcome: 'REVIEW_ORDER_REBASED' });
    commitVerControl(s, 'reconciled');
    expect(verState(s).nodes[CLI]).toMatchObject({ attempts, failure_counts: {}, claim: { claim_id: c.claim_id } });
    expect(verState(s).nodes[CLI].rework_brief).toMatchObject({ origin: { revision: 1, receipt_path: REV1 } });
    const d = await dispatch(s);
    const c2 = d.ticket!;
    expect(c2, d.detail).toMatchObject({ node_id: CLI, claim_id: c.claim_id, resumed: true });
    // The same worktree and work: only the answer is the reissued generation's own, bound to revision 1.
    const skeleton = run.challenge;
    r15Result(c2, run, { challenge: { ...skeleton } });
    const settled = await settle(s, c2);
    expect(settled, settled.detail).toMatchObject({ outcome: 'CRITERIA_SETTLED', state: 'DONE' });
    const state = verState(s);
    expect(state.nodes[CLI]).toMatchObject({ attempts, failure_counts: {} });
    expect(state.acceptance_review.challenges.map((x: Record<string, any>) => [x.node_id, x.status, x.gaps.map((g: Record<string, any>) => g.criterion)])).toEqual([
      [expect.stringContaining('apply-release-plan'), 'withdrawn', ['AC-1']],
      [CLI, 'pending', ['AC-4']],
    ]);
    const archived = JSON.parse(readFileSync(join(s.control, ...state.acceptance_review.challenges[1].receipt_path.split('/')), 'utf8')) as Record<string, any>;
    expect(archived['review_receipt']).toMatchObject({ path: REV1 });
  }, 300_000);
});

describe('what a per-criterion answer may not say', () => {
  it("a passing test is never a criterion's RED: AC-3 named by AC-4's passing reproduction is held for correction, uncharged; corrected, it settles", async () => {
    const { s, t, attempts } = await r15Rework();
    const run = mixedWork(t, s.control);
    r15Result(t, run, { evidence: [{ criterion: 'AC-3', test_id: run.ids.ac4, gate: 'red', output_sha256: run.red.sha256 }, { criterion: 'AC-5', test_id: run.ids.ac5, gate: 'green', output_sha256: run.regreen.sha256 }] });
    const held = await settle(s, t);
    expect(held, held.detail).toMatchObject({ outcome: 'EVIDENCE_CORRECTION_REQUIRED' });
    expect(held.detail).toMatch(/CRITERION_NOT_RUN/);
    expect(verState(s).nodes[CLI]).toMatchObject({ attempts, failure_counts: {}, claim: { evidence_correction: { criterion: 'AC-3' } } });
    expect(verState(s).acceptance_review.challenges ?? []).toEqual([]);
    commitVerControl(s, 'held');
    // The capability holder corrects it at the same commit, the per-criterion answer kept.
    r15Result(t, run);
    const done = await settle(s, t);
    expect(done, done.detail).toMatchObject({ outcome: 'CRITERIA_SETTLED', state: 'DONE' });
    expect(verState(s).nodes[CLI]).toMatchObject({ attempts, failure_counts: {} });
  }, 240_000);

  it("a failing test is never a challenge: AC-4 challenged with AC-3's failing test (AC-3's own proof) is refused before anything is integrated or recorded — the check line says so first", async () => {
    const { s, t, attempts } = await r15Rework();
    const run = mixedWork(t, s.control);
    const challenge = structuredClone(run.challenge);
    challenge['gaps'][0]['tests'] = [run.ids.ac3];
    for (const cl of challenge['gaps'][0]['clauses'] as Record<string, any>[]) cl['test_id'] = run.ids.ac3;
    const before = integrationHead(s);
    r15Result(t, run, { challenge });
    const check = checkFor(t, s.control);
    expect(check.out, check.raw).toMatchObject({ ok: false, code: 'CRITERION_EVIDENCE_REUSED' });
    const refused = await settle(s, t);
    expect(refused, refused.detail).toMatchObject({ outcome: 'EVIDENCE_CORRECTION_REQUIRED' });
    expect(refused.detail).toMatch(/CRITERION_EVIDENCE_REUSED/);
    const state = verState(s);
    expect(state.nodes[CLI]).toMatchObject({ attempts, failure_counts: {} });
    expect(state.acceptance_review.challenges ?? []).toEqual([]);
    expect(integrationHead(s)).toBe(before);
  }, 240_000);

  it("one test named for two criteria is held for correction unless both trace their own clauses to it; traced, it proves both", async () => {
    const s = await r15Reviewed();
    const t = (await dispatch(s)).ticket!;
    expect(t.node_id).toBe(CLI);
    writeFiles(t.worktree, { [CLI_TESTS]: CLI_SHARED_RED });
    const red = runGate(t, 'red', s.control);
    expect(red.code, red.out).toBe(0);
    const shared = red.tests.find((x) => x.full_name === CLI_SHARED_TEST);
    expect(shared, red.out).toMatchObject({ status: 'failed' });
    commit(t.worktree, [CLI_TESTS], 'test(cli): one reproduction of AC-3 and AC-4');
    writeFiles(t.worktree, { [CLI_SRC]: CLI_TRUNCATED_IMPL });
    expect(runGate(t, 'green', s.control).code).toBe(0);
    commit(t.worktree, [CLI_SRC], 'fix(cli): recover a journal a kill cut short');
    writeFiles(t.worktree, { [CLI_COMPAT_TESTS]: CLI_COMPAT_FILE });
    commitCompat(t.worktree, [CLI_COMPAT_TESTS], 'AC-5');
    const regreen = runGate(t, 'green', s.control);
    expect(regreen.code).toBe(0);
    expect(runGate(t, 'regression', s.control).code).toBe(0);
    const attempts = verState(s).nodes[CLI].attempts as number;
    const evidence = [
      { criterion: 'AC-3', test_id: shared!.id, gate: 'red', output_sha256: red.sha256 },
      { criterion: 'AC-4', test_id: shared!.id, gate: 'red', output_sha256: red.sha256 },
      { criterion: 'AC-5', test_id: CLI_COMPAT_TEST_ID, gate: 'green', output_sha256: regreen.sha256 },
    ];
    writeCriteriaResult(t, { criteria: [{ criterion: 'AC-3', outcome: 'DONE' }, { criterion: 'AC-4', outcome: 'DONE' }, { criterion: 'AC-5', outcome: 'DONE' }], evidence });
    const held = await settle(s, t);
    expect(held, held.detail).toMatchObject({ outcome: 'EVIDENCE_CORRECTION_REQUIRED' });
    expect(held.detail).toMatch(/CRITERION_EVIDENCE_REUSED/);
    commitVerControl(s, 'held: one test for two criteria');
    const clauses = sharedClauses(readFileSync(join(t.worktree, ...CLI_TESTS.split('/')), 'utf8'), shared!.id);
    writeCriteriaResult(t, { criteria: [{ criterion: 'AC-3', outcome: 'DONE', clauses: clauses['AC-3'] }, { criterion: 'AC-4', outcome: 'DONE', clauses: clauses['AC-4'] }, { criterion: 'AC-5', outcome: 'DONE' }], evidence });
    const done = await settle(s, t);
    expect(done, done.detail).toMatchObject({ outcome: 'DONE', state: 'DONE' });
    const state = verState(s);
    expect(state.nodes[CLI]).toMatchObject({ attempts, failure_counts: {} });
    expect((state.nodes[CLI].criteria as Record<string, any>[]).filter((c) => c.test_id === shared!.id).map((c) => c.criterion)).toEqual(['AC-3', 'AC-4']);
  }, 240_000);

  it('a production change no DONE criterion\'s RED drives is refused with the challenge: AC-3 left BLOCKED, AC-4 challenged, AC-5 done — a failed attempt, nothing integrated', async () => {
    const { s, t, attempts } = await r15Rework();
    const run = mixedWork(t, s.control);
    const before = integrationHead(s);
    r15Result(t, run, {
      criteria: [{ criterion: 'AC-3', outcome: 'BLOCKED', reason: 'unsure the recovery belongs here' }, { criterion: 'AC-4', outcome: 'REVIEW_GAP_CHALLENGE' }, { criterion: 'AC-5', outcome: 'DONE' }],
      evidence: [{ criterion: 'AC-5', test_id: run.ids.ac5, gate: 'green', output_sha256: run.regreen.sha256 }],
    });
    const refused = await settle(s, t);
    expect(refused, refused.detail).toMatchObject({ outcome: 'RETRY' });
    expect(refused.detail).toMatch(/REVIEW_CHALLENGE_INVALID:PRODUCTION/);
    const state = verState(s);
    expect(state.nodes[CLI]).toMatchObject({ attempts, state: 'READY' });
    expect(state.acceptance_review.challenges ?? []).toEqual([]);
    expect(integrationHead(s)).toBe(before);
  }, 240_000);

  it('a criterion missing from the answer is a malformed result: the check line names it first; settled, a failed attempt under CRITERIA_RESULT_INVALID', async () => {
    const { s, t, attempts } = await r15Rework();
    const run = mixedWork(t, s.control);
    r15Result(t, run, { criteria: [{ criterion: 'AC-3', outcome: 'DONE' }, { criterion: 'AC-4', outcome: 'REVIEW_GAP_CHALLENGE' }], evidence: [{ criterion: 'AC-3', test_id: run.ids.ac3, gate: 'red', output_sha256: run.red.sha256 }] });
    const check = checkFor(t, s.control);
    expect(check.out, check.raw).toMatchObject({ ok: false, code: 'CRITERIA_MISSING' });
    const refused = await settle(s, t);
    expect(refused, refused.detail).toMatchObject({ outcome: 'RETRY' });
    expect(refused.detail).toMatch(/CRITERIA_RESULT_INVALID:MISSING/);
    expect(verState(s).nodes[CLI]).toMatchObject({ attempts, state: 'READY' });
  }, 240_000);
});

describe('a criterion left unresolved stays ordered, parked with its own reason', () => {
  it('AC-3 and AC-5 done, AC-4 BLOCKED: the done work integrated; AC-4 ordered again alone and parked BLOCKED with its reason; nothing charged for the split', async () => {
    const { s, t, attempts } = await r15Rework();
    const run = mixedWork(t, s.control);
    const head = git(t.worktree, ['rev-parse', 'HEAD']);
    r15Result(t, run, {
      criteria: [{ criterion: 'AC-3', outcome: 'DONE' }, { criterion: 'AC-4', outcome: 'BLOCKED', reason: "AC-4's message comes from apply-release-plan's error, outside this node's allowed paths" }, { criterion: 'AC-5', outcome: 'DONE' }],
      challenge: null,
    });
    const settled = await settle(s, t);
    expect(settled, settled.detail).toMatchObject({ outcome: 'CRITERIA_SETTLED', state: 'BLOCKED', criteria: [{ criterion: 'AC-3', outcome: 'DONE' }, { criterion: 'AC-4', outcome: 'BLOCKED' }, { criterion: 'AC-5', outcome: 'DONE' }], follow_up: { criteria: ['AC-4'], state: 'BLOCKED' } });
    commitVerControl(s, 'partial BLOCKED');
    const state = verState(s);
    const cli = state.nodes[CLI];
    expect(git(s.repo, ['merge-base', '--is-ancestor', head, integrationHead(s)])).toBe('');
    expect(cli).toMatchObject({ state: 'BLOCKED', attempts, failure_counts: {} });
    expect(cli.blocked_reason).toMatch(/AC-4/);
    expect(cli.blocked_reason).toMatch(/outside this node's allowed paths/);
    // The follow-up order: AC-4 alone, the same review and revision, AC-3's proof carried; the done generation kept to restore.
    expect(cli.rework_brief).toMatchObject({ acceptance_criteria: ['AC-4'], attempt_base: attempts, origin: { review_id: R001, revision: 0 }, review_gaps: [{ criterion: 'AC-4', reproduction_sha256: sha256(GAP_AC4_HOLDS.gap!.reproduction) }] });
    expect((cli.carried_criterion_proofs as Record<string, any>[]).map((p) => p.criterion)).toEqual(['AC-3']);
    const history = cli.rework_history as Record<string, any>[];
    expect(history.at(-2)).toMatchObject({ partial: { done: ['AC-3', 'AC-5'], unresolved: [expect.objectContaining({ criterion: 'AC-4', outcome: 'BLOCKED' })], follow_up: 'ordered' } });
    expect(history.at(-1)!['restore']).toMatchObject({ state: 'DONE' });
    expect(state.acceptance_review.challenges ?? []).toEqual([]);
    expect(await status(s)).toMatchObject({ next_action: { kind: 'decision', resumable: false } });
  }, 240_000);

  it('AC-4 NEEDS_DECISION: its question recorded as a decision; the node parked NEEDS_DECISION on AC-4 alone; decided, the next ticket answers AC-4 with AC-3 carried', async () => {
    const { s, t, attempts } = await r15Rework();
    const run = mixedWork(t, s.control);
    const question = 'AC-4: should a failed apply print the whole cause chain or only the top error?';
    r15Result(t, run, {
      criteria: [{ criterion: 'AC-3', outcome: 'DONE' }, { criterion: 'AC-4', outcome: 'NEEDS_DECISION', reason: 'a product call on what the message holds', decision_request: { question, options: ['the whole chain', 'the top error only'] } }, { criterion: 'AC-5', outcome: 'DONE' }],
      challenge: null,
    });
    const settled = await settle(s, t);
    expect(settled, settled.detail).toMatchObject({ outcome: 'CRITERIA_SETTLED', state: 'NEEDS_DECISION', follow_up: { criteria: ['AC-4'], state: 'NEEDS_DECISION' } });
    commitVerControl(s, 'partial NEEDS_DECISION');
    let state = verState(s);
    expect(state.nodes[CLI]).toMatchObject({ state: 'NEEDS_DECISION', attempts, failure_counts: {} });
    expect(state.pending_decisions).toHaveLength(1);
    const decision = state.pending_decisions[0] as string;
    expect(readFileSync(join(s.featureDir, 'DECISIONS.md'), 'utf8')).toContain(question);
    expect((await dispatch(s)).status).toBe('NEEDS_DECISION');
    expect((await verCli(s, ['decision', 'record', VER_FEATURE, decision, '--answer', 'the whole chain'])).code).toBe(0);
    expect((await verCli(s, ['decision', 'apply', VER_FEATURE, decision])).code).toBe(0);
    commitVerControl(s, 'decided');
    const d = await dispatch(s);
    const t2 = d.ticket!;
    expect(t2, d.detail).toMatchObject({ node_id: CLI });
    expect(packOf(t2)['rework']).toMatchObject({ acceptance_criteria: ['AC-4'], carried_criteria: [expect.objectContaining({ criterion: 'AC-3' })] });
    state = verState(s);
    // An applied decision makes it a new problem (state/transition.ts): its attempts count afresh, this ticket the first.
    expect(state.nodes[CLI]).toMatchObject({ attempts: 1, failure_counts: {} });
  }, 240_000);
});

describe('a late answer changes nothing', () => {
  it("after the per-criterion settle, the old ticket's slot written again and settled: answered from its receipt; nothing integrated or challenged twice", async () => {
    const { s, t, attempts } = await r15Rework();
    const run = mixedWork(t, s.control);
    r15Result(t, run);
    const head = git(t.worktree, ['rev-parse', 'HEAD']);
    expect(await settle(s, t)).toMatchObject({ outcome: 'CRITERIA_SETTLED' });
    commitVerControl(s, 'settled');
    // The worker writes once more where its slot was (its worktree is gone; the slot's directory made again).
    r15Result(t, run, { criteria: [{ criterion: 'AC-3', outcome: 'DONE' }, { criterion: 'AC-4', outcome: 'BLOCKED', reason: 'changed my mind' }, { criterion: 'AC-5', outcome: 'DONE' }], challenge: null });
    const late = await settle(s, t);
    expect(['CRITERIA_SETTLED', 'STALE_ORCHESTRATION_EPOCH']).toContain(late.outcome);
    expect(late).toMatchObject({ idempotent: true });
    expectR15Settled(s, t, attempts, head);
  }, 240_000);

  it('a ticket re-issued before it settled: the old generation\'s per-criterion answer is refused stale, the new one settles', async () => {
    const { s, t, attempts } = await r15Rework();
    const run = mixedWork(t, s.control);
    const resumed = JSON.parse((await verCli(s, ['dispatch', VER_FEATURE, '--resume', CLI, '--json'])).out) as { ticket: ShopTicket };
    const t2 = resumed.ticket;
    expect(t2.dispatch_id).not.toBe(t.dispatch_id);
    r15Result(t, run);
    const old = await settle(s, t);
    expect(old.outcome, old.detail).toBe('STALE_ORCHESTRATION_EPOCH');
    r15Result(t2, run);
    const settled = await settle(s, t2);
    expect(settled, settled.detail).toMatchObject({ outcome: 'CRITERIA_SETTLED', state: 'DONE' });
    expect(verState(s).nodes[CLI]).toMatchObject({ attempts, failure_counts: {} });
    expect(verState(s).acceptance_review.challenges).toHaveLength(1);
  }, 240_000);
});

describe('the compatibility node and the refinement after a per-criterion settle', () => {
  it('the compatibility node runs again on the new work first; then the refinement of AC-4 alone', async () => {
    const { s, t } = await r15Rework();
    const run = mixedWork(t, s.control);
    r15Result(t, run);
    expect(await settle(s, t)).toMatchObject({ outcome: 'CRITERIA_SETTLED' });
    commitVerControl(s, 'settled');
    const d = await dispatch(s);
    expect((d.controller_reports ?? []).map((x) => [x.node_id, x.outcome])).toEqual([[COMPAT, 'DONE']]);
    const rr = d.ticket as unknown as ReviewTicket & { refinement: Record<string, any> };
    expect(rr).toMatchObject({ review_id: R001, refinement: { round: 1 } });
    const packet = reviewPacket(rr) as unknown as Record<string, any>;
    expect((packet['refinement']['challenges'] as Record<string, any>[]).map((c) => c['criterion'])).toEqual(['AC-4']);
  }, 240_000);
});
