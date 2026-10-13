/**
 * The acceptance review converges per criterion (CSET-203 r11).
 *
 * r11: one global `max_rounds` count was spent by withdrawn hypotheses and
 * other criteria's reworks, and blocked R003 exactly when its reviewer found
 * the likely real hidden boundaries. Here, on the CSET-203-shaped fixture,
 * through the controller's own lines:
 *
 *  - a criterion past its own budget is exhausted while another criterion's
 *    gap is reworked all the same; the feature blocks only once that rework
 *    settled, naming the exhausted criterion, never a candidate; a person's
 *    decided rework grants that criterion alone one more;
 *  - a repeat of an accepted reproduction, reworded, is no rework; repeats
 *    at unchanged heads are no progress; the fourth in a row is
 *    REVIEW_NONCONVERGENT; the review-session ceiling stops a ninth review;
 *  - a settle that dies on either side of its write counts its gaps once;
 *  - a lineage reset outside Mycelink (a dropped, re-chained or edited
 *    event) blocks everything, REVIEW_LINEAGE_INVALID;
 *  - a review state from before the lineage is migrated, and goes on.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { ARP, ARP_RED, ARP_GAPPY_IMPL, ARP_SRC, ARP_TESTS, CLI, CLI_AC5, CLI_FAILURE_TEST, CLI_FULL_WORK, CLI_RECOVERY_TEST, CLI_TRUNCATED_IMPL, CLI_TRUNCATED_RED, CLI_TRUNCATED_TEST, COMPAT, VER_FEATURE, commitVerControl, createVer, verCli, verState, type Ver } from '../helpers/version-fixture.js';
import { fulfil, type CriterionItem } from '../helpers/shop-worker.js';
import { reviewPacket, verdictFor, writeVerdict, type ReviewTicket, type VerdictOverride } from '../helpers/review-agent.js';
import { ARP_CRITERIA, CLI_CRITERIA, GAP_AC1, dispatch, repairArp, reviewed, settle, status } from '../helpers/cset203-rework.js';
import { AC1_HOLDS_REPRODUCTION } from '../helpers/cset203-challenge.js';
import { settleReview } from '../helpers/cset203-r7.js';
import { GAP_AC3_TRUNCATED, cliRedRework, reviewStatusOf } from '../helpers/cset203-r11.js';
import { canonicalTestId } from '../../src/evidence/test-ids.js';
import { Orchestrator, type SettleFaultPoint } from '../../src/engine/orchestrator.js';
import type { SessionAdapter } from '../../src/sessions/adapter.js';
import { mutateState } from '../../src/state/feature-state.js';
import { appendLineage, emptyLineage, reproductionFingerprint } from '../../src/engine/review-lineage.js';
import { reproductionSha256 } from '../../src/engine/review-challenge.js';
import type { LineageEvent, LineageEventBody } from '../../src/model/types.js';

afterAll(() => cleanupTmpRoots());

const cliId = (name: string): string => canonicalTestId('junit-xml', 'packages/cli/test/cli.test.mjs', name);
/** The cli reopened by an upstream rework keeps its RED: its evidence names the same tests by id. */
const CLI_REVERIFIED: CriterionItem[] = [
  { criterion: 'AC-3', gate: 'red', test_id: cliId(CLI_RECOVERY_TEST) },
  { criterion: 'AC-4', gate: 'red', test_id: cliId(CLI_FAILURE_TEST) },
  CLI_AC5,
];

/** apply-release-plan repaired for R001's AC-1, then the cli it reopened re-proves GREEN. */
async function repaired(s: Ver): Promise<void> {
  await repairArp(s);
  const c = (await dispatch(s)).ticket!;
  expect(c.node_id).toBe(CLI);
  fulfil(c, { ...CLI_FULL_WORK, criteria: CLI_REVERIFIED }, s.control);
  expect(await settle(s, c)).toMatchObject({ outcome: 'DONE' });
  commitVerControl(s, 'cli re-verified');
}

/** The next dispatch: the compatibility node, then a review ticket. */
async function nextReview(s: Ver, id: string): Promise<ReviewTicket> {
  const d = await dispatch(s);
  const t = d.ticket as unknown as ReviewTicket;
  expect(t, d.detail).toMatchObject({ kind: 'acceptance-review', review_id: `${VER_FEATURE}-${id}` });
  return t;
}

async function judged(s: Ver, t: ReviewTicket, gaps: Record<string, VerdictOverride>): Promise<Record<string, any>> {
  await writeVerdict(t, verdictFor(reviewPacket(t), gaps), { cwd: s.control });
  const r = await settleReview(s, t);
  commitVerControl(s, `${t.review_id} settled`);
  return r;
}

const gapsOf = (s: Ver): LineageEvent[] => (verState(s).acceptance_review.lineage?.events ?? []).filter((e: LineageEvent) => e.kind === 'gap');

/** Both producers DONE, the review handed out, no verdict yet. */
async function untilR001(): Promise<{ s: Ver; t: ReviewTicket }> {
  const s = await createVer({ review: {} });
  const a = (await dispatch(s)).ticket!;
  fulfil(a, { tests: { [ARP_TESTS]: ARP_RED }, impl: { [ARP_SRC]: ARP_GAPPY_IMPL }, criteria: ARP_CRITERIA }, s.control);
  expect(await settle(s, a)).toMatchObject({ outcome: 'DONE' });
  commitVerControl(s, 'apply-release-plan');
  const c = (await dispatch(s)).ticket!;
  fulfil(c, { ...CLI_FULL_WORK, criteria: CLI_CRITERIA }, s.control);
  expect(await settle(s, c)).toMatchObject({ outcome: 'DONE' });
  commitVerControl(s, 'cli');
  return { s, t: await nextReview(s, 'R001') };
}

describe("each criterion's budget is its own", () => {
  it('past its budget a materially new AC-1 gap is reworked on the producer\'s verified progress, never stopped by the count (CSET-201 final): its basis and the records it stands on are on record', async () => {
    const s = await reviewed({ 'AC-1': GAP_AC1 }, { max_rounds: 1 });
    await repaired(s);
    const r2 = await nextReview(s, 'R002');
    expect((reviewPacket(r2) as unknown as { review_memory: Record<string, any> }).review_memory.budgets['AC-1']).toMatchObject({ accepted_reworks: 1, max: 1, remaining: 0, ceiling: 6, ceiling_remaining: 5 });
    const another: VerdictOverride = { gap: { missing: 'rollback of a file the run created is never exercised', reproduction: AC1_HOLDS_REPRODUCTION, producer: { node_id: ARP } } };
    const settled = await judged(s, r2, { 'AC-1': another, 'AC-3': GAP_AC3_TRUNCATED });
    expect(settled, settled.detail).toMatchObject({ outcome: 'GAPS', blocked: false });
    expect([...settled.reworked].sort()).toEqual([ARP, CLI].sort());
    const state = verState(s);
    expect(state.feature_state).not.toBe('BLOCKED');
    // R001's rework of apply-release-plan settled AC-1 with its RED and a production change, integrated: the progress R002's gap stands on.
    const arpRecord = (state.nodes[ARP].criterion_ledger as Record<string, any>[]).filter((r) => r.criterion === 'AC-1').at(-1) as Record<string, any>;
    expect(arpRecord).toMatchObject({ basis: 'red', order: { review_id: `${VER_FEATURE}-R001` } });
    expect(gapsOf(s).map((e) => [e.review_id, (e as { criterion: string }).criterion, (e as { verdict: string }).verdict, (e as { basis?: string }).basis, (e as { progress?: string[] }).progress ?? null])).toEqual([
      [`${VER_FEATURE}-R001`, 'AC-1', 'accepted', 'budget', null],
      [`${VER_FEATURE}-R002`, 'AC-1', 'accepted', 'progress', [arpRecord['record_id']]],
      [`${VER_FEATURE}-R002`, 'AC-3', 'accepted', 'budget', null],
    ]);
    // The receipt says it, and so do status and the reason the producer is handed.
    const receipt = JSON.parse(readFileSync(join(s.featureDir, 'reviews', `${VER_FEATURE}-R002.json`), 'utf8')) as Record<string, any>;
    expect(receipt['lineage']['gaps'][0]).toMatchObject({ criterion: 'AC-1', verdict: 'accepted', basis: 'progress', progress: [arpRecord['record_id']] });
    expect(receipt['lineage']['budgets']['AC-1']).toMatchObject({ accepted_reworks: 2, max: 1, ceiling: 6, ceiling_remaining: 4 });
    const st = (await status(s))['acceptance_review'];
    expect(st['criteria']['AC-1']).toMatchObject({ accepted_reworks: 2, max: 1, ceiling: 6, exhausted: false, next_action: expect.stringMatching(/verified producer progress/) });
    expect(verState(s).nodes[ARP].rework_brief.reason).toMatch(/AC-1 rework 2 \(past its budget of 1, on verified producer progress; ceiling 6\)/);
  });

  it('at its emergency ceiling a materially new AC-1 gap is exhausted while AC-3 is reworked; the feature blocks once that rework settled, naming AC-1; a decided rework grants AC-1 alone one more', async () => {
    const s = await reviewed({ 'AC-1': GAP_AC1 }, { max_rounds: 1, criterion_ceiling: 1 });
    await repaired(s);
    const r2 = await nextReview(s, 'R002');
    expect((reviewPacket(r2) as unknown as { review_memory: Record<string, any> }).review_memory.budgets['AC-1']).toMatchObject({ accepted_reworks: 1, max: 1, remaining: 0, ceiling: 1, ceiling_remaining: 0 });
    const exhausted: VerdictOverride = { gap: { missing: 'rollback of a file the run created is never exercised', reproduction: AC1_HOLDS_REPRODUCTION, producer: { node_id: ARP } } };
    const settled = await judged(s, r2, { 'AC-1': exhausted, 'AC-3': GAP_AC3_TRUNCATED });
    expect(settled, settled.detail).toMatchObject({ outcome: 'GAPS', reworked: [CLI], blocked: false });
    let state = verState(s);
    expect(state.feature_state).not.toBe('BLOCKED');
    expect(state.nodes[ARP].state).toBe('DONE');
    expect(gapsOf(s).map((e) => [e.review_id, (e as { criterion: string }).criterion, (e as { verdict: string }).verdict, (e as { basis?: string }).basis])).toEqual([
      [`${VER_FEATURE}-R001`, 'AC-1', 'accepted', 'budget'],
      [`${VER_FEATURE}-R002`, 'AC-1', 'exhausted', 'ceiling'],
      [`${VER_FEATURE}-R002`, 'AC-3', 'accepted', 'budget'],
    ]);
    let st = (await status(s))['acceptance_review'];
    expect(st['criteria']['AC-1']).toMatchObject({ exhausted: true, accepted_reworks: 1, max: 1, ceiling: 1, next_action: expect.stringMatching(/decision/) });
    expect(st['criteria']['AC-3']).toMatchObject({ exhausted: false, accepted_reworks: 1, remaining: 0 });
    // The cli's rework proceeds: its RED, its fix, DONE.
    const c = (await dispatch(s)).ticket!;
    cliRedRework(c, s.control, { tests: CLI_TRUNCATED_RED, impl: CLI_TRUNCATED_IMPL, test: CLI_TRUNCATED_TEST });
    const done = await settle(s, c);
    expect(done, done.detail).toMatchObject({ outcome: 'DONE' });
    commitVerControl(s, 'cli: AC-3');
    // Every allowable gap settled: the block, naming AC-1, and no third review.
    const stop = await dispatch(s);
    expect((stop as unknown as { controller_reports: { node_id: string; outcome: string }[] }).controller_reports.map((x) => [x.node_id, x.outcome])).toEqual([[COMPAT, 'DONE']]);
    expect(stop.status, stop.detail).toBe('BLOCKED');
    expect(stop.detail).toMatch(/REVIEW_GAPS/);
    expect(stop.detail).toMatch(/AC-1/);
    expect(stop.detail).toMatch(/exhausted/);
    commitVerControl(s, 'blocked');
    state = verState(s);
    expect(state.acceptance_review).toMatchObject({ open: null, blocked: { code: 'REVIEW_GAPS', criteria: ['AC-1'] } });
    expect(state.acceptance_review.reviews.map((r: { review_id: string }) => r.review_id)).toEqual([`${VER_FEATURE}-R001`, `${VER_FEATURE}-R002`]);
    const cut = await verCli(s, ['candidate', 'create', VER_FEATURE, '--json']);
    expect(cut.code).not.toBe(0);
    expect(cut.err).toMatch(/REVIEW_GAPS/);
    // A person decides: AC-1 gets one more accepted rework, AC-3 none.
    expect((await verCli(s, ['decision', 'record', VER_FEATURE, 'DEC-AC1', '--answer', 'rework AC-1 once more'])).code).toBe(0);
    const decided = await verCli(s, ['node', 'rework', VER_FEATURE, ARP, '--reason', 'R002 AC-1: rollback of a file the run created is never exercised', '--decision', 'DEC-AC1', '--json']);
    expect(decided.code, decided.err).toBe(0);
    commitVerControl(s, 'decided');
    st = (await status(s))['acceptance_review'];
    expect(st['blocked']).toBeNull();
    expect(st['criteria']['AC-1']).toMatchObject({ max: 2, ceiling: 2, exhausted: false });
    expect(st['criteria']['AC-3']).toMatchObject({ max: 1, ceiling: 1 });
  });
});

describe('repeats make no rework and no progress', () => {
  it('the accepted reproduction reworded is a duplicate: no rework; repeats at unchanged heads are no progress; the fourth in a row is REVIEW_NONCONVERGENT', async () => {
    const s = await reviewed({ 'AC-1': GAP_AC1 });
    await repaired(s);
    const reworks = verState(s).reworks.length;
    const reworded: VerdictOverride = { gap: { missing: 'the changelog write itself is still never failed', reproduction: `${(GAP_AC1.gap as { reproduction: string }).reproduction.toUpperCase()}, AGAIN!`, producer: { node_id: ARP } } };
    const r2 = await nextReview(s, 'R002');
    const first = await judged(s, r2, { 'AC-1': reworded });
    expect(first, first.detail).toMatchObject({ outcome: 'REPEATED', reworked: [], blocked: false });
    let state = verState(s);
    expect(state.feature_state).not.toBe('BLOCKED');
    expect(state.reworks).toHaveLength(reworks);
    expect(state.nodes[ARP].state).toBe('DONE');
    expect(gapsOf(s).at(-1)).toMatchObject({ review_id: `${VER_FEATURE}-R002`, criterion: 'AC-1', verdict: 'duplicate', duplicate_of: reproductionSha256((GAP_AC1.gap as { reproduction: string }).reproduction) });
    // R002 saw the producers' change since R001: progress. Each repeat after it, at the same heads, is none.
    for (const [n, outcome] of [[3, 'REPEATED'], [4, 'REPEATED'], [5, 'REPEATED'], [6, 'REVIEW_NONCONVERGENT']] as const) {
      const t = await nextReview(s, `R00${n}`);
      const packet = reviewPacket(t) as unknown as { review_memory: { findings: { review_id: string; status: string }[]; no_progress: { streak: number; max: number } } };
      expect(packet.review_memory.findings.map((f) => f.status)).toContain('duplicate');
      expect(packet.review_memory.no_progress).toEqual({ streak: n - 3, max: 4 });
      expect(t.prompt).toMatch(/never report again/i);
      const r = await judged(s, t, { 'AC-1': n % 2 === 0 ? reworded : GAP_AC1 });
      expect(r, r.detail).toMatchObject({ outcome, reworked: [] });
    }
    state = verState(s);
    expect(state.acceptance_review.blocked).toMatchObject({ code: 'REVIEW_NONCONVERGENT', review_id: `${VER_FEATURE}-R006` });
    expect(state.acceptance_review.blocked.detail).toMatch(/no progress/);
    expect(state.acceptance_review.blocked.detail).toMatch(/AC-1 1\/2/);
    expect(state.feature_state).toBe('BLOCKED');
    expect(state.reworks).toHaveLength(reworks);
    expect((await dispatch(s)).status).toBe('BLOCKED');
    const cut = await verCli(s, ['candidate', 'create', VER_FEATURE, '--json']);
    expect(cut.err).toMatch(/REVIEW_NONCONVERGENT/);
  });

  it('a ninth review session is never handed out: REVIEW_NONCONVERGENT with the lineage', async () => {
    const { s } = await untilR001();
    // Eight settled review sessions on record (as earlier deliveries of this feature would leave them), chained honestly.
    mutateState(s.featureDir, (st) => {
      const r = st.acceptance_review!;
      let l = r.lineage ?? emptyLineage(r.max_rounds);
      for (let n = 1; n <= 8; n++) l = appendLineage(l, [{ kind: 'review', review_id: `${VER_FEATURE}-R90${n}`, inputs_sha256: 'a'.repeat(64), heads: [`changesets@${n}`], outcome: 'GAPS', passed: [], gaps: ['AC-2'], progress: ['producer-change'] }], new Date().toISOString()).lineage;
      r.lineage = l;
      r.open = null;
      return st;
    });
    commitVerControl(s, 'eight sessions');
    const d = await dispatch(s);
    expect(d.status, d.detail).toBe('BLOCKED');
    expect(d.detail).toMatch(/REVIEW_NONCONVERGENT/);
    expect(d.detail).toMatch(/8 review sessions/);
    expect(verState(s).acceptance_review.open).toBeNull();
  });
});

describe('the lineage counts each fact once, and only its own chain', () => {
  it('a settle that dies after its receipt, or right after its write, records each gap once; settling again changes nothing', async () => {
    for (const point of ['review-receipt-written', 'review-recorded'] as SettleFaultPoint[]) {
      const { s, t } = await untilR001();
      await writeVerdict(t, verdictFor(reviewPacket(t), { 'AC-1': GAP_AC1 }), { cwd: s.control });
      const crashing = new Orchestrator({ controlRoot: s.control, featureId: VER_FEATURE, adapter: {} as SessionAdapter, settleFault: (p: SettleFaultPoint) => { if (p === point) throw new Error(`CRASH at ${p}`); } });
      expect(() => crashing.settleReview(t.review_id, t.capability)).toThrow(/CRASH/);
      commitVerControl(s, `crashed at ${point}`);
      await dispatch(s);
      const head = verState(s).acceptance_review.lineage.head_sha256;
      expect(await settleReview(s, t)).toMatchObject({ outcome: 'GAPS', idempotent: true });
      const state = verState(s);
      expect(state.acceptance_review.lineage.head_sha256, point).toBe(head);
      expect(gapsOf(s).map((e) => [e.review_id, (e as { verdict: string }).verdict]), point).toEqual([[`${VER_FEATURE}-R001`, 'accepted']]);
      expect(state.acceptance_review.lineage.events.filter((e: LineageEvent) => e.kind === 'review'), point).toHaveLength(1);
      expect((await status(s))['acceptance_review']['criteria']['AC-1'], point).toMatchObject({ accepted_reworks: 1 });
    }
  });

  it("a reset outside Mycelink — AC-1's accepted gap dropped and the chain rebuilt, or an event edited in place — blocks everything REVIEW_LINEAGE_INVALID", async () => {
    for (const how of ['rechained', 'edited'] as const) {
      const s = await reviewed({ 'AC-1': GAP_AC1 }, { max_rounds: 1 });
      mutateState(s.featureDir, (st) => {
        const r = st.acceptance_review!;
        const l = r.lineage!;
        if (how === 'edited') {
          (l.events.find((e) => e.kind === 'gap') as { verdict: string }).verdict = 'unreworkable';
          return st;
        }
        let rebuilt = emptyLineage(l.max_criterion_reworks);
        for (const e of l.events.filter((x) => x.kind !== 'gap')) {
          const { seq: _seq, at, prev_sha256: _prev, sha256: _sha, ...body } = e;
          rebuilt = appendLineage(rebuilt, [body as LineageEventBody], at).lineage;
        }
        r.lineage = rebuilt;
        return st;
      });
      commitVerControl(s, `lineage ${how}`);
      const d = await dispatch(s);
      expect(d.status, `${how}: ${d.detail}`).toBe('BLOCKED');
      expect(d.detail).toMatch(/REVIEW_LINEAGE_INVALID/);
      expect(verState(s).acceptance_review.blocked).toMatchObject({ code: 'REVIEW_LINEAGE_INVALID' });
      const verify = JSON.parse((await verCli(s, ['feature', 'verify', VER_FEATURE, '--json'])).out) as { problems: string[] };
      expect(verify.problems.join('\n')).toMatch(/REVIEW_LINEAGE_INVALID/);
      expect((await dispatch(s)).status).toBe('BLOCKED');
    }
  });

  it('a review state from before the lineage is migrated from its records and receipts: status reports the budgets, and the next settle chains on', async () => {
    const s = await reviewed({ 'AC-1': GAP_AC1 });
    // As a STATE.json written before the lineage existed would be.
    mutateState(s.featureDir, (st) => {
      delete st.acceptance_review!.lineage;
      return st;
    });
    commitVerControl(s, 'legacy review state');
    expect((await status(s))['acceptance_review']['criteria']['AC-1']).toMatchObject({ accepted_reworks: 1, remaining: 1 });
    expect((await reviewStatusOf(s))['lineage']).toMatchObject({ migrated: true });
    await repaired(s);
    const r2 = await nextReview(s, 'R002');
    expect((reviewPacket(r2) as unknown as { review_memory: Record<string, any> }).review_memory.budgets['AC-1']).toMatchObject({ accepted_reworks: 1 });
    const fp = reproductionFingerprint(AC1_HOLDS_REPRODUCTION);
    expect(fp.terms.length).toBeGreaterThan(0);
    expect(await judged(s, r2, { 'AC-1': { gap: { missing: 'rollback of a created file is never exercised', reproduction: AC1_HOLDS_REPRODUCTION, producer: { node_id: ARP } } } })).toMatchObject({ outcome: 'GAPS', reworked: [ARP] });
    const events = verState(s).acceptance_review.lineage.events as LineageEvent[];
    expect(events[0]).toMatchObject({ kind: 'migrated', reviews: [`${VER_FEATURE}-R001`] });
    expect(events.filter((e) => e.kind === 'gap').map((e) => [e.review_id, (e as { verdict: string }).verdict])).toEqual([[`${VER_FEATURE}-R001`, 'accepted'], [`${VER_FEATURE}-R002`, 'accepted']]);
    expect((await status(s))['acceptance_review']['criteria']['AC-1']).toMatchObject({ accepted_reworks: 2, remaining: 0 });
  });
});
