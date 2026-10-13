/**
 * A refinement is an immutable revision of the review it refines, and every
 * producer order it leaves standing is rebased to it in the same write
 * (CSET-203 r14).
 *
 * r14: R002's atomic rework ordered apply-release-plan (AC-1) and the cli
 * (AC-3) from R002's original receipt. AC-1 was challenged and withdrawn; the
 * refinement repointed R002 at R002.refined-1.json while the cli's AC-3 order
 * stayed bound to the original. The cli's passing AC-3 reproduction was then
 * refused twice, REVIEW_CHALLENGE_STALE — an administrative mismatch charged
 * as worker failures — and the cli was BLOCKED. Here, on the CSET-203-shaped
 * fixture, through the controller's own lines:
 *
 *  - revision 1 and the cli's rebased order are one write: a settle that dies
 *    on either side of it leaves both or neither; settled again, once;
 *  - an order STATE.json still binds to an older revision (r14's own, written
 *    before this) is reconciled, never judged: its live claim reissued from
 *    where it stands, nothing charged; its old capability's late answer is
 *    archived stale; the reissued worker's challenge is valid;
 *  - a sibling that completed its rework is kept, untouched;
 *  - a producer with a withdrawn and a retained gap is reordered for the
 *    retained one alone, no budget spent twice;
 *  - a criterion two producers serve (AC-4 here): withdrawn, the sibling's
 *    order of it is narrowed or cancelled; refined, amended; nothing else lost;
 *  - a worker's challenge naming another reproduction is still its own
 *    failure; an order, a revision receipt or a rebase record edited outside
 *    Mycelink is refused, never built on;
 *  - two producers' near-simultaneous challenges are decided in one revision.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { git } from '../helpers/git-fixture.js';
import { canonicalTestId } from '../../src/evidence/test-ids.js';
import {
  ARP,
  ARP_GAPPY_IMPL,
  ARP_JOURNAL_TEST,
  ARP_RED,
  ARP_ROLLBACK_TEST,
  ARP_SRC,
  ARP_TESTS,
  CLI,
  CLI_FULL_WORK,
  CLI_TESTS,
  CLI_TRUNCATED_RED,
  COMPAT,
  VER_FEATURE,
  commitVerControl,
  createVer,
  verCli,
  verGraph,
  verState,
  type Ver,
} from '../helpers/version-fixture.js';
import { fulfil, type ShopTicket } from '../helpers/shop-worker.js';
import { refinementFor, reviewPacket, verdictFor, writeVerdict, type ReviewTicket, type VerdictOverride } from '../helpers/review-agent.js';
import { ARP_CRITERIA, CLI_CRITERIA, GAP_AC5, dispatch, reviewed, settle, status } from '../helpers/cset203-rework.js';
import { ARP_CHALLENGE_RED, ARP_CHALLENGE_TEST, CLI_CHALLENGE_BODY, CLI_CHALLENGE_TEST, GAP_AC1_HOLDS, GAP_AC4_HOLDS, arpClauses, challengeSkeleton, cliClauses, lineOf, reworkOf, writeChallenge } from '../helpers/cset203-challenge.js';
import { compatRework, r7Reviewed, settleReview, siblingGraph, writeLateBlocked } from '../helpers/cset203-r7.js';
import { AC3_HOLDS_REPRODUCTION, CLI_AC3_HOLDS_RED, CLI_AC3_HOLDS_TEST, GAP_AC3_HOLDS, cliAc3Clauses, events, receiptAt } from '../helpers/cset203-r14.js';
import { Orchestrator, type SettleFaultPoint } from '../../src/engine/orchestrator.js';
import type { SessionAdapter } from '../../src/sessions/adapter.js';
import { mutateState } from '../../src/state/feature-state.js';

afterAll(() => cleanupTmpRoots());

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const R001 = `${VER_FEATURE}-R001`;
const REV0 = `features/${VER_FEATURE}/reviews/${R001}.json`;
const REV1 = `features/${VER_FEATURE}/reviews/${R001}.refined-1.json`;

const record = (s: Ver, id = R001): Record<string, any> => verState(s).acceptance_review.reviews.find((r: { review_id: string }) => r.review_id === id);

/** R001 GAPS: AC-1 on apply-release-plan (a reproduction its code satisfies), AC-3 on the cli (one its code satisfies); AC-1 challenged; the refinement handed out and written, WITHDRAW, not settled. */
async function refinementWritten(): Promise<{ s: Ver; rr: ReviewTicket; brief: Record<string, any> }> {
  const s = await reviewed({ 'AC-1': GAP_AC1_HOLDS, 'AC-3': GAP_AC3_HOLDS });
  const brief = structuredClone(verState(s).nodes[CLI].rework_brief) as Record<string, any>;
  expect(brief).toMatchObject({ acceptance_criteria: ['AC-3'], origin: { review_id: R001, revision: 0, receipt_path: REV0 } });
  const a = (await dispatch(s)).ticket!;
  expect(a.node_id).toBe(ARP);
  writeChallenge(a, s.control);
  expect(await settle(s, a)).toMatchObject({ outcome: 'REVIEW_CHALLENGED', state: 'DONE' });
  commitVerControl(s, 'R001 AC-1 challenged');
  const rr = (await dispatch(s)).ticket as unknown as ReviewTicket;
  expect(rr).toMatchObject({ review_id: R001, refinement: { round: 1 } });
  await writeVerdict(rr, refinementFor(reviewPacket(rr), { 'AC-1': { decision: 'WITHDRAW' } }), { cwd: s.control });
  return { s, rr, brief };
}

/** Either revision 0 and the cli's order bound to it, or revision 1 and the order rebased to it: never one without the other. */
function oneOrTheOther(s: Ver): 0 | 1 {
  const state = verState(s);
  const rec = record(s);
  const brief = state.nodes[CLI].rework_brief;
  if ((rec.revision ?? 0) === 0) {
    expect(rec.receipt_path).toBe(REV0);
    expect(brief.origin).toMatchObject({ revision: 0, receipt_path: REV0 });
    expect(brief.rebases ?? []).toEqual([]);
    expect(brief.evidence).toEqual([REV0]);
    return 0;
  }
  expect(rec).toMatchObject({ revision: 1, receipt_path: REV1 });
  expect(brief.origin).toMatchObject({ revision: 1, receipt_path: REV1, receipt_sha256: rec.receipt_sha256 });
  expect(brief.rebases).toHaveLength(1);
  expect(brief.evidence).toEqual([REV1]);
  return 1;
}

const crashing = (s: Ver, point: SettleFaultPoint): Orchestrator =>
  new Orchestrator({ controlRoot: s.control, featureId: VER_FEATURE, adapter: {} as SessionAdapter, settleFault: (p: SettleFaultPoint) => { if (p === point) throw new Error(`CRASH at ${p}`); } });

describe("the refinement's revision and the orders it leaves standing: one write", () => {
  it('a settle that dies after its receipt, or right after its write, leaves revision 1 and the rebased order together or neither; settled again, the rebase is made once', async () => {
    for (const point of ['review-receipt-written', 'review-recorded'] as SettleFaultPoint[]) {
      const { s, rr } = await refinementWritten();
      expect(() => crashing(s, point).settleReview(rr.review_id, rr.capability)).toThrow(/CRASH/);
      commitVerControl(s, `crashed at ${point}`);
      expect(oneOrTheOther(s), point).toBe(point === 'review-receipt-written' ? 0 : 1);
      if (point === 'review-receipt-written') expect(verState(s).acceptance_review.open).toMatchObject({ dispatch_id: rr.dispatch_id });
      const again = await settleReview(s, rr);
      expect(again, `${point}: ${again.detail}`).toMatchObject({ outcome: 'GAPS', ...(point === 'review-recorded' ? { idempotent: true } : {}) });
      commitVerControl(s, `settled after ${point}`);
      expect(oneOrTheOther(s), point).toBe(1);
      expect(events(s).filter((e) => e.type === 'review.order_rebased'), point).toHaveLength(1);
    }
  });

  it('a duplicate settle of the refinement is answered from its record: one revision, one rebase', async () => {
    const { s, rr, brief } = await refinementWritten();
    expect(await settleReview(s, rr)).toMatchObject({ outcome: 'GAPS', refinement: { decisions: [{ criterion: 'AC-1', decision: 'WITHDRAW' }] } });
    commitVerControl(s, 'R001 refined');
    const once = verState(s);
    expect(await settleReview(s, rr)).toMatchObject({ outcome: 'GAPS', idempotent: true });
    const twice = verState(s);
    expect(twice.nodes[CLI].rework_brief).toEqual(once.nodes[CLI].rework_brief);
    expect(twice.nodes[CLI].rework_brief.rebases).toHaveLength(1);
    expect(twice.nodes[CLI].rework_brief).toMatchObject({ generation: brief['generation'], reason_sha256: brief['reason_sha256'], attempt_base: brief['attempt_base'] });
    expect(record(s).refinements).toHaveLength(1);
    expect(events(s).filter((e) => e.type === 'review.order_rebased')).toHaveLength(1);
  });
});

describe('a stale administrative mismatch is reconciled, never charged', () => {
  it("an order still bound to revision 0 (r14's STATE): its claim's challenge is reconciled — rebased, reissued from where it stands, nothing charged; the old ticket's late answer is archived stale; the reissued worker's challenge is valid", async () => {
    const { s, rr } = await refinementWritten();
    expect(await settleReview(s, rr)).toMatchObject({ outcome: 'GAPS' });
    commitVerControl(s, 'R001 refined');
    const c = (await dispatch(s)).ticket!;
    expect(c.node_id).toBe(CLI);
    // As r14's STATE.json was written: the cli's order bound to R001's original receipt, never rebased.
    mutateState(s.featureDir, (st) => {
      const n = st.nodes[CLI]!;
      const b = n.rework_brief!;
      b.origin = { kind: 'acceptance-review', review_id: R001, review: 1 };
      b.evidence = [REV0];
      delete b.rebases;
      const e = n.rework_history!.at(-1)!;
      delete e.rebases;
      return st;
    });
    commitVerControl(s, 'r14 STATE');
    const attempts = verState(s).nodes[CLI].attempts as number;
    writeChallenge(c, s.control, { tests: { [CLI_TESTS]: CLI_AC3_HOLDS_RED }, test: CLI_AC3_HOLDS_TEST, clauses: cliAc3Clauses });
    const head = git(c.worktree, ['rev-parse', 'HEAD']);
    const reconciled = await settle(s, c);
    expect(reconciled, reconciled.detail).toMatchObject({ outcome: 'REVIEW_ORDER_REBASED' });
    expect(reconciled.detail).toMatch(/REVIEW_CHALLENGE_STALE|revision/);
    commitVerControl(s, 'reconciled');
    let state = verState(s);
    expect(state.feature_state).not.toBe('BLOCKED');
    expect(state.nodes[CLI]).toMatchObject({ attempts, claim: { claim_id: c.claim_id } });
    expect(state.nodes[CLI].claim.dispatch_id).not.toBe(c.dispatch_id);
    expect(state.nodes[CLI].claim.review_rebase).toMatchObject({ review_id: R001, from_revision: 0, to_revision: 1, from_dispatch_id: c.dispatch_id });
    expect(Object.keys(state.nodes[CLI].failure_counts).filter((k) => k.startsWith('REVIEW_CHALLENGE'))).toEqual([]);
    expect(state.nodes[CLI].rework_brief).toMatchObject({ origin: { revision: 1, receipt_path: REV1 }, evidence: [REV1] });
    expect(state.nodes[CLI].rework_brief.rebases).toEqual([expect.objectContaining({ from: expect.objectContaining({ revision: 0 }), to: expect.objectContaining({ revision: 1 }), by: 'reconcile', claim: expect.objectContaining({ claim_id: c.claim_id, from_dispatch_id: c.dispatch_id }) })]);
    expect(events(s).filter((e) => e.type === 'review.challenge_refused')).toEqual([]);
    expect(events(s).filter((e) => e.type === 'review.order_rebased').at(-1)?.data).toMatchObject({ by: 'reconcile', code: 'REVIEW_CHALLENGE_STALE' });
    expect(await status(s)).toMatchObject({ resumable: true, next_action: { kind: 'reconcile' } });
    // The old ticket answers again, late: stale, archived, nothing moves.
    writeLateBlocked(c);
    const late = await settle(s, c);
    expect(late, late.detail).toMatchObject({ outcome: 'STALE_ORCHESTRATION_EPOCH' });
    expect(verState(s).nodes[CLI]).toMatchObject({ attempts, claim: { claim_id: c.claim_id } });
    // The reissued ticket: the same claim, worktree and commit, a new capability; the revision it is bound to now.
    const d = await dispatch(s);
    const c2 = d.ticket!;
    expect(c2, d.detail).toMatchObject({ node_id: CLI, claim_id: c.claim_id, worktree: c.worktree, resumed: true });
    expect(c2.dispatch_id).not.toBe(c.dispatch_id);
    expect(c2.prompt).toMatch(/revision 1/);
    expect(reworkOf(c2)).toMatchObject({ evidence: [REV1], origin: { revision: 1 } });
    expect(git(c2.worktree, ['rev-parse', 'HEAD'])).toBe(head);
    writeChallenge(c2, s.control, { tests: { [CLI_TESTS]: CLI_AC3_HOLDS_RED }, test: CLI_AC3_HOLDS_TEST, clauses: cliAc3Clauses });
    const valid = await settle(s, c2);
    expect(valid, valid.detail).toMatchObject({ outcome: 'REVIEW_CHALLENGED', state: 'DONE' });
    state = verState(s);
    expect(state.acceptance_review.challenges.map((x: { node_id: string; status: string }) => [x.node_id, x.status])).toEqual([[ARP, 'withdrawn'], [CLI, 'pending']]);
    expect(Object.keys(state.nodes[CLI].failure_counts).filter((k) => k.startsWith('REVIEW_CHALLENGE'))).toEqual([]);
  });

  it('an order bound to revision 0 with no claim yet is rebased by the next dispatch before any ticket is handed out', async () => {
    const { s, rr } = await refinementWritten();
    expect(await settleReview(s, rr)).toMatchObject({ outcome: 'GAPS' });
    mutateState(s.featureDir, (st) => {
      const n = st.nodes[CLI]!;
      n.rework_brief!.origin = { kind: 'acceptance-review', review_id: R001, review: 1 };
      n.rework_brief!.evidence = [REV0];
      delete n.rework_brief!.rebases;
      delete n.rework_history!.at(-1)!.rebases;
      return st;
    });
    commitVerControl(s, 'r14 STATE, no claim');
    const c = (await dispatch(s)).ticket!;
    expect(c.node_id).toBe(CLI);
    expect(reworkOf(c)).toMatchObject({ evidence: [REV1], origin: { revision: 1, receipt_path: REV1 } });
    expect(verState(s).nodes[CLI].rework_brief.rebases).toEqual([expect.objectContaining({ by: 'reconcile', claim: null })]);
  });
});

describe('siblings and splits', () => {
  it('a sibling that completed its rework while the challenge waited is kept: DONE, not reopened, not rebased', async () => {
    const s = await r7Reviewed({ graph: siblingGraph() });
    const a = (await dispatch(s)).ticket!;
    const c = (await dispatch(s)).ticket!;
    expect([a.node_id, c.node_id]).toEqual([ARP, CLI]);
    writeChallenge(a, s.control);
    expect(await settle(s, a)).toMatchObject({ outcome: 'REVIEW_CHALLENGED' });
    compatRework(c, s.control);
    expect(await settle(s, c)).toMatchObject({ outcome: 'DONE' });
    commitVerControl(s, 'both settled');
    const done = structuredClone(verState(s).nodes[CLI]);
    const d = await dispatch(s);
    const r = d.ticket as unknown as ReviewTicket;
    expect(r, d.detail).toMatchObject({ review_id: R001, refinement: { round: 1 } });
    await writeVerdict(r, refinementFor(reviewPacket(r), { 'AC-1': { decision: 'WITHDRAW' } }), { cwd: s.control });
    expect(await settleReview(s, r)).toMatchObject({ outcome: 'GAPS' });
    const state = verState(s);
    expect(state.nodes[CLI]).toMatchObject({ state: 'DONE', integrated_sha: done.integrated_sha, attempts: done.attempts });
    expect(state.nodes[CLI].rework_brief ?? null).toBeNull();
    expect(state.nodes[CLI].rework_history.at(-1).rebases ?? []).toEqual([]);
    expect(receiptAt(s, REV1)['orders']).toEqual([expect.objectContaining({ node_id: CLI, action: 'keep', criteria_before: ['AC-5'], criteria_after: ['AC-5'] })]);
  });

  it("the challenger's retained gap is reordered alone: AC-3 withdrawn, AC-4 reordered from the generation its challenge restored, no attempt charged, no budget spent twice", async () => {
    const s = await reviewed({ 'AC-3': GAP_AC3_HOLDS, 'AC-4': GAP_AC4_HOLDS });
    let state = verState(s);
    expect(state.nodes[CLI].rework_brief).toMatchObject({ acceptance_criteria: ['AC-3', 'AC-4'], generation: 1 });
    const attempts = state.nodes[CLI].attempts as number;
    const c = (await dispatch(s)).ticket!;
    expect(c.node_id).toBe(CLI);
    // Only AC-3's reproduction holds: its focused test alone, and a challenge of AC-3 alone.
    writeChallenge(c, s.control, { tests: { [CLI_TESTS]: CLI_AC3_HOLDS_RED }, test: CLI_AC3_HOLDS_TEST, clauses: cliAc3Clauses, mutate: (ch) => (ch['gaps'] = (ch['gaps'] as { criterion: string }[]).filter((g) => g.criterion === 'AC-3')) });
    const challenged = await settle(s, c);
    expect(challenged, challenged.detail).toMatchObject({ outcome: 'REVIEW_CHALLENGED', state: 'DONE' });
    commitVerControl(s, 'AC-3 challenged');
    const d = await dispatch(s);
    expect((d.controller_reports ?? []).map((x) => [x.node_id, x.outcome])).toEqual([[COMPAT, 'DONE']]);
    const r = d.ticket as unknown as ReviewTicket;
    expect(r).toMatchObject({ review_id: R001, refinement: { round: 1 } });
    await writeVerdict(r, refinementFor(reviewPacket(r), { 'AC-3': { decision: 'WITHDRAW' } }), { cwd: s.control });
    const settled = await settleReview(s, r);
    expect(settled, settled.detail).toMatchObject({ outcome: 'GAPS', reworked: [CLI] });
    state = verState(s);
    expect(receiptAt(s, REV1)).toMatchObject({
      revision: 1,
      gap_dispositions: [expect.objectContaining({ criterion: 'AC-3', disposition: 'withdrawn' }), expect.objectContaining({ criterion: 'AC-4', disposition: 'retained' })],
      orders: [expect.objectContaining({ node_id: CLI, action: 'reorder', criteria_before: ['AC-3', 'AC-4'], criteria_after: ['AC-4'] })],
    });
    expect(state.nodes[CLI]).toMatchObject({ state: 'INVALIDATED', attempts });
    expect(state.nodes[CLI].rework_brief).toMatchObject({
      acceptance_criteria: ['AC-4'],
      generation: 1,
      review_gaps: [{ criterion: 'AC-4', reproduction_sha256: sha256(GAP_AC4_HOLDS.gap!.reproduction) }],
      origin: { review_id: R001, revision: 1, receipt_path: REV1 },
    });
    expect(state.nodes[CLI].rework_brief.reason).toMatch(/AC-4 rework 1 of 2/);
    const st = await status(s);
    expect(st['acceptance_review']['criteria']).toMatchObject({ 'AC-3': { accepted_reworks: 0, withdrawals: 1 }, 'AC-4': { accepted_reworks: 1 } });
  });
});

/** The version graph with AC-4 served by both producers: a criterion two orders can share. */
function sharedAc4Graph(): Record<string, unknown> {
  const g = verGraph() as { capabilities: { id: string; acceptance_criteria: string[] }[]; nodes: { id: string; acceptance_criteria?: string[] }[] };
  for (const c of g.capabilities) if (c.id === 'CAP-ARP-ROLLBACK-JOURNAL') c.acceptance_criteria = ['AC-1', 'AC-2', 'AC-4'];
  for (const n of g.nodes) if (n.id === ARP) n.acceptance_criteria = ['AC-1', 'AC-2', 'AC-4'];
  return g as unknown as Record<string, unknown>;
}

/** apply-release-plan's own focused test of AC-4 (it reads the cli it feeds): a failed apply exits 1 with no stack, nothing committed. */
const ARP_AC4_TEST = 'a failed apply reaches the cli as one message without a stack, exit 1, nothing committed';
const ARP_AC4_BODY = `
test('${ARP_AC4_TEST}', async () => {
  const { version } = await import('../../cli/src/index.mjs');
  const errors = [];
  const calls = [];
  const code = await version({ files: new Map([['packages/a/package.json', '{"version":"1.0.0"}']]), changes: [{ path: 'packages/a/package.json', content: '{"version":"2.0.0"}' }], config: { commit: true }, io: { log() {}, warn() {}, error: (m) => errors.push(m) }, git: { add: () => calls.push('add'), commit: () => calls.push('commit') }, format: async () => { throw new Error('disk exploded'); } });
  assert.equal(code, 1);
  assert.doesNotMatch(errors[0], /\\n\\s+at /);
  assert.deepEqual(calls, []);
});
`;
const arpTestId = (name: string): string => canonicalTestId('junit-xml', ARP_TESTS, name);
const GAP_AC4_SHARED: VerdictOverride = { gap: { missing: 'a failed apply is never shown to reach the user without a stack', reproduction: 'make the formatter throw "disk exploded" with commit enabled; assert version exits 1, prints one message with no stack trace line and runs neither git add nor git commit', producer: null } };

/** Both producers DONE on the shared-AC-4 graph (apply-release-plan proves AC-4 by its rollback test, the cli by its failure test), R001 settled with `gaps`. */
async function sharedReviewed(gaps: Record<string, VerdictOverride>): Promise<Ver> {
  const s = await createVer({ review: {}, graph: sharedAc4Graph() });
  const a = (await dispatch(s)).ticket!;
  fulfil(a, { tests: { [ARP_TESTS]: ARP_RED }, impl: { [ARP_SRC]: ARP_GAPPY_IMPL }, criteria: [...ARP_CRITERIA, { criterion: 'AC-4', gate: 'red', test_id: arpTestId(ARP_ROLLBACK_TEST) }] }, s.control);
  expect(await settle(s, a)).toMatchObject({ outcome: 'DONE' });
  commitVerControl(s, 'apply-release-plan');
  const c = (await dispatch(s)).ticket!;
  fulfil(c, { ...CLI_FULL_WORK, criteria: CLI_CRITERIA }, s.control);
  expect(await settle(s, c)).toMatchObject({ outcome: 'DONE' });
  commitVerControl(s, 'cli');
  const t = (await dispatch(s)).ticket as unknown as ReviewTicket;
  expect(t).toMatchObject({ kind: 'acceptance-review', review_id: R001 });
  await writeVerdict(t, verdictFor(reviewPacket(t), gaps), { cwd: s.control });
  expect(await settleReview(s, t)).toMatchObject({ outcome: 'GAPS' });
  commitVerControl(s, 'R001');
  return s;
}

/** apply-release-plan's challenge of both its gaps, AC-1 and AC-4, each traced to its own focused test. */
function challengeAc1AndAc4(t: ShopTicket, control: string): void {
  writeChallenge(t, control, {
    tests: { [ARP_TESTS]: `${ARP_CHALLENGE_RED}${ARP_AC4_BODY}` },
    mutate: (ch) => {
      const source = readFileSync(join(t.worktree, ...ARP_TESTS.split('/')), 'utf8');
      const skeleton = challengeSkeleton(t, control).out;
      const id = (name: string): string => (skeleton['tests'] as { id: string; full_name: string }[]).find((x) => x.full_name === name)!.id;
      const start = lineOf(source, ARP_AC4_TEST);
      const exit = lineOf(source, 'assert.equal(code, 1);', start);
      const stack = lineOf(source, 'assert.doesNotMatch(errors[0]', start);
      const calls = lineOf(source, 'assert.deepEqual(calls, []);', start);
      for (const g of ch['gaps'] as Record<string, any>[]) {
        if (g['criterion'] === 'AC-1') {
          g['tests'] = [id(ARP_CHALLENGE_TEST)];
          g['clauses'] = arpClauses(source, id(ARP_CHALLENGE_TEST));
        } else {
          g['tests'] = [id(ARP_AC4_TEST)];
          g['clauses'] = [
            { clause: 'AC-4.1', test_id: id(ARP_AC4_TEST), assertions: [`file:changesets:${ARP_TESTS}#L${exit}-L${stack}`], trace: 'exit 1 and one message with no stack line after the injected apply failure' },
            { clause: 'AC-4.2', test_id: id(ARP_AC4_TEST), assertions: [`file:changesets:${ARP_TESTS}#L${calls}`], trace: 'neither git add nor git commit ran with commit enabled' },
          ];
        }
      }
    },
  });
}

describe('a criterion two producers serve (AC-4)', () => {
  it("withdrawn: the sibling's order keeps its untouched AC-3 alone (narrowed, superseding the old one); nothing charged", async () => {
    const s = await sharedReviewed({ 'AC-1': GAP_AC1_HOLDS, 'AC-3': GAP_AC3_HOLDS, 'AC-4': GAP_AC4_SHARED });
    let state = verState(s);
    expect(state.nodes[ARP].rework_brief).toMatchObject({ acceptance_criteria: ['AC-1', 'AC-4'] });
    expect(state.nodes[CLI].rework_brief).toMatchObject({ acceptance_criteria: ['AC-3', 'AC-4'] });
    const cliAttempts = state.nodes[CLI].attempts as number;
    const generation = state.nodes[CLI].rework_brief.generation as number;
    const a = (await dispatch(s)).ticket!;
    expect(a.node_id).toBe(ARP);
    challengeAc1AndAc4(a, s.control);
    const challenged = await settle(s, a);
    expect(challenged, challenged.detail).toMatchObject({ outcome: 'REVIEW_CHALLENGED' });
    commitVerControl(s, 'AC-1 and AC-4 challenged');
    const r = (await dispatch(s)).ticket as unknown as ReviewTicket;
    expect(r).toMatchObject({ review_id: R001, refinement: { round: 1 } });
    await writeVerdict(r, refinementFor(reviewPacket(r), { 'AC-1': { decision: 'WITHDRAW' }, 'AC-4': { decision: 'WITHDRAW' } }), { cwd: s.control });
    const settled = await settleReview(s, r);
    expect(settled, settled.detail).toMatchObject({ outcome: 'GAPS', reworked: [CLI] });
    state = verState(s);
    expect(receiptAt(s, REV1)['orders']).toEqual(expect.arrayContaining([expect.objectContaining({ node_id: CLI, action: 'amend', criteria_before: ['AC-3', 'AC-4'], criteria_after: ['AC-3'] })]));
    expect(state.nodes[CLI]).toMatchObject({ state: 'INVALIDATED', attempts: cliAttempts });
    expect(state.nodes[CLI].rework_brief).toMatchObject({ acceptance_criteria: ['AC-3'], generation, origin: { revision: 1 }, review_gaps: [{ criterion: 'AC-3', reproduction_sha256: sha256(AC3_HOLDS_REPRODUCTION) }] });
    const history = state.nodes[CLI].rework_history;
    expect(history.at(-2)).toMatchObject({ superseded: { review_id: R001, revision: 1, action: 'amend' } });
    expect(state.nodes[ARP]).toMatchObject({ state: 'DONE' });
  });

  it("withdrawn where it was the sibling's only gap: the sibling's order is cancelled, its DONE generation back", async () => {
    const s = await sharedReviewed({ 'AC-1': GAP_AC1_HOLDS, 'AC-4': GAP_AC4_SHARED });
    let state = verState(s);
    expect(state.nodes[CLI].rework_brief).toMatchObject({ acceptance_criteria: ['AC-4'] });
    const before = structuredClone(state.nodes[CLI].rework_history.at(-1).restore);
    const a = (await dispatch(s)).ticket!;
    challengeAc1AndAc4(a, s.control);
    expect(await settle(s, a)).toMatchObject({ outcome: 'REVIEW_CHALLENGED' });
    commitVerControl(s, 'challenged');
    const r = (await dispatch(s)).ticket as unknown as ReviewTicket;
    await writeVerdict(r, refinementFor(reviewPacket(r), { 'AC-1': { decision: 'WITHDRAW' }, 'AC-4': { decision: 'WITHDRAW' } }), { cwd: s.control });
    const settled = await settleReview(s, r);
    expect(settled, settled.detail).toMatchObject({ outcome: 'WITHDRAWN' });
    state = verState(s);
    expect(receiptAt(s, REV1)['orders']).toEqual([expect.objectContaining({ node_id: CLI, action: 'cancel', criteria_before: ['AC-4'], criteria_after: [] })]);
    expect(state.nodes[CLI]).toMatchObject({ state: 'DONE', attempts: before.attempts, integrated_sha: before.integrated_sha });
    expect(state.nodes[CLI].rework_brief ?? null).toBeNull();
    expect(state.nodes[CLI].rework_history.at(-1)).toMatchObject({ superseded: { review_id: R001, revision: 1, action: 'cancel' } });
  });

  it("refined: the challenger reordered for the refined AC-4, the sibling's order amended to it, its untouched AC-3 kept", async () => {
    const s = await sharedReviewed({ 'AC-1': GAP_AC1_HOLDS, 'AC-3': GAP_AC3_HOLDS, 'AC-4': GAP_AC4_SHARED });
    const a = (await dispatch(s)).ticket!;
    challengeAc1AndAc4(a, s.control);
    expect(await settle(s, a)).toMatchObject({ outcome: 'REVIEW_CHALLENGED' });
    commitVerControl(s, 'challenged');
    const r = (await dispatch(s)).ticket as unknown as ReviewTicket;
    // A node id is advisory (engine/acceptance-review.ts gapTargets): both producers serve AC-4, so both are ordered.
    const refined = { missing: 'a failure inside git add is never reported without a stack', reproduction: 'make git add throw "index.lock exists" with commit enabled after a successful apply; assert version exits 1, prints the failure without a stack trace line and never commits' };
    await writeVerdict(r, refinementFor(reviewPacket(r), { 'AC-1': { decision: 'WITHDRAW' }, 'AC-4': { decision: 'REFINE', gap: refined, producer: { node_id: CLI } } }), { cwd: s.control });
    const settled = await settleReview(s, r);
    expect(settled, settled.detail).toMatchObject({ outcome: 'GAPS' });
    expect([...settled.reworked].sort()).toEqual([ARP, CLI].sort());
    const state = verState(s);
    const orders = receiptAt(s, REV1)['orders'] as Record<string, any>[];
    expect(orders.find((o) => o['node_id'] === ARP)).toMatchObject({ action: 'reorder', criteria_before: ['AC-1', 'AC-4'], criteria_after: ['AC-4'] });
    expect(orders.find((o) => o['node_id'] === CLI)).toMatchObject({ action: 'amend', criteria_before: ['AC-3', 'AC-4'], criteria_after: ['AC-3', 'AC-4'] });
    expect(state.nodes[ARP].rework_brief).toMatchObject({ acceptance_criteria: ['AC-4'], review_gaps: [{ criterion: 'AC-4', reproduction_sha256: sha256(refined.reproduction) }], origin: { revision: 1 } });
    expect(state.nodes[CLI].rework_brief).toMatchObject({
      acceptance_criteria: ['AC-3', 'AC-4'],
      review_gaps: [
        { criterion: 'AC-3', reproduction_sha256: sha256(AC3_HOLDS_REPRODUCTION) },
        { criterion: 'AC-4', reproduction_sha256: sha256(refined.reproduction) },
      ],
      origin: { revision: 1 },
    });
  });
});

describe('nothing edited or misbound is built on', () => {
  it("a challenge naming another reproduction is the worker's own failure, charged as before; an order whose bound gap was edited refuses its claim; an edited revision receipt or rebase record blocks the review", async () => {
    const { s, rr } = await refinementWritten();
    expect(await settleReview(s, rr)).toMatchObject({ outcome: 'GAPS' });
    commitVerControl(s, 'R001 refined');
    const c = (await dispatch(s)).ticket!;
    writeChallenge(c, s.control, { tests: { [CLI_TESTS]: CLI_AC3_HOLDS_RED }, test: CLI_AC3_HOLDS_TEST, clauses: cliAc3Clauses, mutate: (ch) => ((ch['gaps'] as Record<string, any>[])[0]!['reproduction_sha256'] = sha256('another reproduction')) });
    const refused = await settle(s, c);
    expect(refused, refused.detail).toMatchObject({ outcome: 'RETRY' });
    expect(refused.detail).toMatch(/REVIEW_CHALLENGE_STALE/);
    let state = verState(s);
    expect(state.nodes[CLI]).toMatchObject({ state: 'READY', last_failure_fingerprint: 'REVIEW_CHALLENGE_INVALID:STALE' });
    expect(state.nodes[CLI].failure_counts['REVIEW_CHALLENGE_INVALID:STALE']).toBe(1);
    commitVerControl(s, 'refused');

    // The order's bound gap edited outside Mycelink: its claim is refused, and feature verify names it.
    mutateState(s.featureDir, (st) => {
      st.nodes[CLI]!.rework_brief!.review_gaps = [{ criterion: 'AC-3', reproduction_sha256: sha256('another reproduction') }];
      return st;
    });
    commitVerControl(s, 'order edited');
    const d = await dispatch(s);
    expect(d.status, d.detail).toBe('PRECONDITION_FAILED');
    expect(d.detail).toMatch(/REWORK_BRIEF_INVALID/);
    const verify = JSON.parse((await verCli(s, ['feature', 'verify', VER_FEATURE, '--json'])).out) as { problems: string[] };
    expect(verify.problems.join('\n')).toMatch(/REVIEW_REVISION_INVALID/);
    mutateState(s.featureDir, (st) => {
      st.nodes[CLI]!.rework_brief!.review_gaps = [{ criterion: 'AC-3', reproduction_sha256: sha256(AC3_HOLDS_REPRODUCTION) }];
      return st;
    });
    commitVerControl(s, 'order restored');

    // A rebase record edited (its carried reproduction): the revision lineage cannot be trusted.
    const saved = structuredClone(verState(s).nodes[CLI].rework_brief.rebases);
    mutateState(s.featureDir, (st) => {
      for (const r of [st.nodes[CLI]!.rework_brief!.rebases!, st.nodes[CLI]!.rework_history!.at(-1)!.rebases!]) r[0]!.carry[0]!.reproduction_sha256 = sha256('forged');
      return st;
    });
    commitVerControl(s, 'rebase edited');
    const blocked = await dispatch(s);
    expect(blocked.status, blocked.detail).toBe('BLOCKED');
    expect(blocked.detail).toMatch(/REVIEW_LINEAGE_INVALID/);
    expect(blocked.detail).toMatch(/rebase/);
    state = verState(s);
    expect(state.acceptance_review.blocked).toMatchObject({ code: 'REVIEW_LINEAGE_INVALID' });
    expect(saved).toHaveLength(1);
  });

  it('a revision receipt edited after it was settled (its retained gap rewritten) blocks the review; no order is rebased onto it', async () => {
    const { s, rr } = await refinementWritten();
    expect(await settleReview(s, rr)).toMatchObject({ outcome: 'GAPS' });
    commitVerControl(s, 'R001 refined');
    const file = join(s.control, ...REV1.split('/'));
    const receipt = JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;
    receipt['gaps'][0]['reproduction'] = 'a different reproduction a forger prefers';
    writeFileSync(file, JSON.stringify(receipt, null, 2) + '\n');
    commitVerControl(s, 'receipt edited');
    const d = await dispatch(s);
    expect(d.status, d.detail).toBe('BLOCKED');
    expect(d.detail).toMatch(/REVIEW_LINEAGE_INVALID/);
    expect(d.ticket).toBeUndefined();
  });
});

describe('near-simultaneous challenges', () => {
  it("two producers' challenges of one review, settled while both worked, are decided by one refinement: one revision, both decisions merged", async () => {
    const s = await r7Reviewed({ graph: siblingGraph(), gaps: { 'AC-1': GAP_AC1_HOLDS, 'AC-4': GAP_AC4_HOLDS } });
    const a = (await dispatch(s)).ticket!;
    const c = (await dispatch(s)).ticket!;
    expect([a.node_id, c.node_id]).toEqual([ARP, CLI]);
    writeChallenge(a, s.control);
    expect(await settle(s, a)).toMatchObject({ outcome: 'REVIEW_CHALLENGED' });
    writeChallenge(c, s.control, { tests: { [CLI_TESTS]: `${CLI_TRUNCATED_RED}${CLI_CHALLENGE_BODY}` }, test: CLI_CHALLENGE_TEST, clauses: cliClauses });
    const second = await settle(s, c);
    expect(second, second.detail).toMatchObject({ outcome: 'REVIEW_CHALLENGED' });
    commitVerControl(s, 'both challenged');
    let state = verState(s);
    expect(state.acceptance_review.challenges.map((x: { challenge_id: string; status: string }) => [x.challenge_id, x.status])).toEqual([[`${R001}-C1`, 'pending'], [`${R001}-C2`, 'pending']]);
    const d = await dispatch(s);
    const r = d.ticket as unknown as ReviewTicket & { refinement: { challenges: { challenge_id: string }[] } };
    expect(r, d.detail).toMatchObject({ review_id: R001, refinement: { round: 1 } });
    expect(r.refinement.challenges.map((x) => x.challenge_id).sort()).toEqual([`${R001}-C1`, `${R001}-C2`]);
    const refined = { missing: 'a failure inside git commit is never reported without a stack', reproduction: 'make git commit throw "hook rejected" with commit enabled after a successful apply; assert version exits 1, prints the failure without a stack trace line and the files keep the applied versions' };
    await writeVerdict(r, refinementFor(reviewPacket(r), { 'AC-1': { decision: 'WITHDRAW' }, 'AC-4': { decision: 'REFINE', gap: refined, producer: { node_id: CLI } } }), { cwd: s.control });
    const settled = await settleReview(s, r);
    expect(settled, settled.detail).toMatchObject({ outcome: 'GAPS', reworked: [CLI] });
    state = verState(s);
    expect(record(s)).toMatchObject({ revision: 1, receipt_path: REV1 });
    expect(record(s).refinements).toHaveLength(1);
    expect(receiptAt(s, REV1)['gap_dispositions']).toEqual([
      expect.objectContaining({ criterion: 'AC-1', disposition: 'withdrawn', challenge_id: `${R001}-C1` }),
      expect.objectContaining({ criterion: 'AC-4', disposition: 'refined', challenge_id: `${R001}-C2`, to_reproduction_sha256: sha256(refined.reproduction) }),
    ]);
    expect(state.acceptance_review.challenges.map((x: { status: string }) => x.status)).toEqual(['withdrawn', 'refined']);
    expect(state.nodes[CLI].rework_brief).toMatchObject({ acceptance_criteria: ['AC-4'], origin: { revision: 1, refinement: { challenge_id: `${R001}-C2` } } });
    expect(state.nodes[ARP]).toMatchObject({ state: 'DONE' });
    void GAP_AC5;
    void ARP_JOURNAL_TEST;
  });
});
