/**
 * Every gap of a GAPS review is reworked on the graph's producer, at once.
 *
 * CSET-203 r3 with-normal: every implementation node and the compatibility
 * verification node were DONE and the reviewer found public GAPs on AC-1,
 * AC-3 and AC-5 before any candidate — the review doing its job. AC-5 was
 * the verification node's alone, a node that changes nothing; settle found
 * no producer for it, recorded the review REVIEW_GAPS with `reworks: []`
 * and `reworks_applied: true`, reworked nothing — not even AC-1 and AC-3,
 * whose producers were known — blocked the feature, and the controller
 * exited with it incomplete.
 *
 * Here, on the CSET-203-shaped fixture, with r3's three gaps:
 *
 *  - the graph gives AC-5 to the cli as its producer (the verification node
 *    proves it again); the reviewer named the verification node, as r3's
 *    did, and it is advisory: AC-3 and AC-5 go to the cli, AC-1 to
 *    apply-release-plan, all in the one STATE.json write that records the
 *    review, each with its criteria and a bounded public reason; the
 *    candidate and everything downstream invalidated once;
 *  - `reworks_applied` is true only when the rework records exist;
 *  - the next dispatch hands out the next worker's ticket;
 *  - a graph from before every criterion had a producer: the mapped gaps are
 *    reworked, the unowned one blocks the feature — no candidate;
 *  - a settle interrupted on either side of its write is finished once, with
 *    no rework or reviewer session counted twice.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import {
  ARP,
  ARP_GAPPY_IMPL,
  ARP_JOURNAL_TEST,
  ARP_RED,
  ARP_ROLLBACK_TEST,
  ARP_SRC,
  ARP_TESTS,
  CLI,
  CLI_FAILURE_TEST,
  CLI_FULL_WORK,
  CLI_AC5,
  CLI_RECOVERY_TEST,
  COMPAT,
  VER_CANDIDATE,
  VER_FEATURE,
  commitVerControl,
  createVer,
  verCli,
  verGraph,
  verState,
  type Ver,
} from '../helpers/version-fixture.js';
import { fulfil, packOf, type CriterionItem, type ShopTicket } from '../helpers/shop-worker.js';
import { reviewPacket, verdictFor, writeVerdict, type ReviewTicket, type VerdictOverride } from '../helpers/review-agent.js';
import { Orchestrator, type SettleFaultPoint } from '../../src/engine/orchestrator.js';
import type { SessionAdapter } from '../../src/sessions/adapter.js';
import { hashGraph } from '../../src/graph/validate.js';
import { mutateState } from '../../src/state/feature-state.js';

afterAll(() => cleanupTmpRoots());

interface Dispatched {
  status: string;
  detail: string;
  ticket?: (ShopTicket & { kind?: string; agent: string; review_id?: string }) | undefined;
  controller_reports: { node_id: string; outcome: string }[];
  review_reports?: { review_id: string; outcome: string; reworked: string[] }[];
}

async function dispatch(s: Ver): Promise<Dispatched> {
  const r = await verCli(s, ['dispatch', VER_FEATURE, '--json']);
  if (r.out === '') throw new Error(`dispatch printed nothing: ${r.err}`);
  return JSON.parse(r.out) as Dispatched;
}

async function settleReview(s: Ver, t: ReviewTicket): Promise<{ code: number; out: Record<string, any>; err: string }> {
  const r = await verCli(s, ['review', 'settle', VER_FEATURE, '--review', t.review_id, '--capability', t.capability, '--json']);
  return { code: r.code, out: r.out === '' ? {} : (JSON.parse(r.out) as Record<string, any>), err: r.err };
}

const ARP_CRITERIA: CriterionItem[] = [
  { criterion: 'AC-1', gate: 'red', full_name: ARP_ROLLBACK_TEST },
  { criterion: 'AC-2', gate: 'red', full_name: ARP_JOURNAL_TEST },
];
/** The cli's first submission: its two new behaviours by their REDs, AC-5 (compatibility) by the existing status test its green gate passed. */
const CLI_CRITERIA: CriterionItem[] = [
  { criterion: 'AC-3', gate: 'red', full_name: CLI_RECOVERY_TEST },
  { criterion: 'AC-4', gate: 'red', full_name: CLI_FAILURE_TEST },
  CLI_AC5,
];

/** CSET-203 r3's three public gaps, in this fixture's words; the reviewer names AC-5's verification node, as r3's did. */
const R3_GAPS: Record<string, VerdictOverride> = {
  'AC-1': {
    gap: {
      missing: 'rollback is tested only for a formatter crash after every file was written; no test fails the changelog write itself after the package/version writes',
      reproduction: 'inject changelog writer failure after package/version writes and assert exact rollback',
      producer: { node_id: ARP },
    },
  },
  'AC-3': {
    gap: {
      missing: 'recovery is tested with a complete journal only; a journal cut short by a kill while it was written is never recovered from',
      reproduction: 'leave a truncated, unparseable journal in .changeset, run version, and assert it warns interrupted, removes the journal and versions once',
      producer: { node_id: CLI },
    },
  },
  'AC-5': {
    gap: {
      missing: 'no regression evidence runs status with a journal present in .changeset',
      reproduction: 'put .changeset/.version-journal.json beside a changeset, run status, and assert the journal is not listed and the output is the same as without it',
      producer: { node_id: COMPAT },
    },
    untested: ['AC-5.2'],
  },
};

/**
 * Both producers DONE (apply-release-plan as r2's worker wrote it), then the
 * dispatch that runs the compatibility node and hands out the review. With
 * `legacy`, the feature runs r3's own graph shape: initialised before the
 * ownership rule, AC-5 on the verification node alone.
 */
async function untilReview(options: { legacy?: boolean } = {}): Promise<{ s: Ver; t: ReviewTicket }> {
  const s = await createVer({ review: {} });
  if (options.legacy === true) {
    const legacy = verGraph({ legacyCompat: true });
    writeFileSync(join(s.featureDir, 'PORTFOLIO-GRAPH.yaml'), YAML.stringify(legacy, { lineWidth: 0 }));
    mutateState(s.featureDir, (st) => ({ ...st, graph_hash: hashGraph(legacy) }));
    commitVerControl(s, 'a feature initialised before every criterion had a producer');
  }
  const a = (await dispatch(s)).ticket!;
  expect(a.node_id).toBe(ARP);
  fulfil(a, { tests: { [ARP_TESTS]: ARP_RED }, impl: { [ARP_SRC]: ARP_GAPPY_IMPL }, criteria: ARP_CRITERIA }, s.control);
  expect(JSON.parse((await verCli(s, ['settle', VER_FEATURE, ARP, '--capability', a.capability, '--json'])).out)).toMatchObject({ outcome: 'DONE' });
  commitVerControl(s, 'apply-release-plan');
  const c = (await dispatch(s)).ticket!;
  expect(c.node_id).toBe(CLI);
  fulfil(c, { ...CLI_FULL_WORK, criteria: options.legacy === true ? CLI_CRITERIA.filter((x) => x.criterion !== 'AC-5') : CLI_CRITERIA }, s.control);
  const cli = JSON.parse((await verCli(s, ['settle', VER_FEATURE, CLI, '--capability', c.capability, '--json'])).out) as { outcome: string; detail: string };
  expect(cli, cli.detail).toMatchObject({ outcome: 'DONE' });
  commitVerControl(s, 'cli');
  const d = await dispatch(s);
  expect(d.controller_reports.map((r) => [r.node_id, r.outcome])).toEqual([[COMPAT, 'DONE']]);
  expect(d.ticket).toMatchObject({ kind: 'acceptance-review', review_id: `${VER_FEATURE}-R001` });
  return { s, t: d.ticket as unknown as ReviewTicket };
}

const reworksOf = (s: Ver, reviewId: string): { node_id: string; reopened: string[]; invalidated_candidate: string | null }[] =>
  (verState(s).reworks ?? []).filter((r: { origin?: { review_id?: string } }) => r.origin?.review_id === reviewId);

describe("r3's three gaps on a graph whose every criterion has a producer", () => {
  it('records the review and reworks the cli (AC-3, AC-5) and apply-release-plan (AC-1) in one write; the next dispatch is a worker ticket', async () => {
    const { s, t } = await untilReview();
    await writeVerdict(t, verdictFor(reviewPacket(t), R3_GAPS), { cwd: s.control });
    const settled = await settleReview(s, t);
    expect(settled.err).toBe('');
    expect(settled.out).toMatchObject({ review_id: t.review_id, outcome: 'GAPS', reworked: [CLI, ARP], blocked: false, next: 'dispatch', code: null });

    const state = verState(s);
    expect(state.acceptance_review.reviews).toEqual([expect.objectContaining({ review_id: t.review_id, overall: 'GAPS', outcome: 'GAPS', reworks: [CLI, ARP], reworks_applied: true })]);
    expect(state.acceptance_review.blocked).toBeNull();
    expect(state.feature_state).toBe('RUNNING');
    // One rework record per producer, dependents first; the candidate and everything downstream invalidated once.
    const records = reworksOf(s, t.review_id);
    expect(records.map((r) => r.node_id)).toEqual([CLI, ARP]);
    expect(records[0]!.reopened).toEqual(expect.arrayContaining([CLI, COMPAT]));
    expect(records[1]!.reopened).toEqual([ARP]);
    for (const id of [ARP, CLI, COMPAT]) expect(state.nodes[id].state, id).toBe('INVALIDATED');
    expect(state.nodes[VER_CANDIDATE].state).not.toBe('DONE');
    expect(state.current_candidate).toBeNull();

    // Each producer's brief: its own criteria, the kind of each, r3's public reproductions, bounded.
    const cli = state.nodes[CLI].rework_brief;
    expect(cli).toMatchObject({ acceptance_criteria: ['AC-3', 'AC-5'], origin: { kind: 'acceptance-review', review_id: t.review_id, review: 1 } });
    expect(cli.reason).toContain('AC-3 (new-behavior)');
    expect(cli.reason).toContain('AC-5 (compatibility)');
    expect(cli.reason).toContain(R3_GAPS['AC-3']!.gap!.reproduction);
    expect(cli.reason).toContain(R3_GAPS['AC-5']!.gap!.reproduction);
    expect(cli.reason).toContain('Mycelink-Compatibility: AC-5');
    expect(cli.reason).not.toContain(R3_GAPS['AC-1']!.gap!.reproduction);
    expect(Buffer.byteLength(cli.reason, 'utf8')).toBeLessThanOrEqual(2000);
    expect(state.nodes[ARP].rework_brief).toMatchObject({ acceptance_criteria: ['AC-1'] });
    expect(state.nodes[ARP].rework_brief.reason).toContain(R3_GAPS['AC-1']!.gap!.reproduction);

    // The receipt says where each gap went, and that none was left without a producer.
    const receipt = JSON.parse(readFileSync(join(s.control, settled.out['receipt_path']), 'utf8'));
    expect(receipt).toMatchObject({ outcome: 'GAPS', reworks: [{ node_id: CLI, criteria: ['AC-3', 'AC-5'], by: 'criterion' }, { node_id: ARP, criteria: ['AC-1'], by: 'criterion' }], unowned: [], blocked: null });
    commitVerControl(s, 'review R001: three gaps');

    // Settling again changes nothing.
    const again = await settleReview(s, t);
    expect(again.out).toMatchObject({ outcome: 'GAPS', reworked: [CLI, ARP], idempotent: true });
    expect(reworksOf(s, t.review_id)).toHaveLength(2);

    // The loop continues: the next dispatch is the reworked apply-release-plan's worker ticket.
    const next = await dispatch(s);
    expect(next.status, next.detail).toBe('DISPATCHED');
    expect(next.ticket?.node_id).toBe(ARP);
    expect(packOf(next.ticket!)['rework']).toMatchObject({ acceptance_criteria: ['AC-1'], origin: { review_id: t.review_id } });
  });

  it('a settle that dies after the receipt and before its STATE.json write is settled by the next dispatch from the slot, once, and the loop goes on', async () => {
    const { s, t } = await untilReview();
    await writeVerdict(t, verdictFor(reviewPacket(t), R3_GAPS), { cwd: s.control });
    const crashing = new Orchestrator({ controlRoot: s.control, featureId: VER_FEATURE, adapter: {} as SessionAdapter, settleFault: (point: SettleFaultPoint) => { if (point === 'review-receipt-written') throw new Error(`CRASH at ${point}`); } });
    expect(() => crashing.settleReview(t.review_id, t.capability)).toThrow(/CRASH at review-receipt-written/);
    let state = verState(s);
    expect(state.acceptance_review.reviews).toEqual([]);
    expect(state.acceptance_review.open).toMatchObject({ review_id: t.review_id });
    expect(reworksOf(s, t.review_id)).toEqual([]);
    expect(state.nodes[ARP].state).toBe('DONE');
    commitVerControl(s, 'crashed before the record');
    const next = await dispatch(s);
    expect(next.review_reports).toEqual([expect.objectContaining({ review_id: t.review_id, outcome: 'GAPS', reworked: [CLI, ARP] })]);
    expect(next.status, next.detail).toBe('DISPATCHED');
    expect(next.ticket?.node_id).toBe(ARP);
    state = verState(s);
    expect(state.acceptance_review.reviews).toEqual([expect.objectContaining({ reworks: [CLI, ARP], reworks_applied: true })]);
    expect(reworksOf(s, t.review_id).map((r) => r.node_id)).toEqual([CLI, ARP]);
    expect(state.acceptance_review.usage.sessions).toBe(1);
    // The host's own settle afterwards is answered from the record.
    expect((await settleReview(s, t)).out).toMatchObject({ outcome: 'GAPS', idempotent: true });
    expect(reworksOf(s, t.review_id)).toHaveLength(2);
    expect(verState(s).acceptance_review.usage.sessions).toBe(1);
  });

  it('a settle that dies right after its write leaves the review recorded with every rework made: nothing is made twice', async () => {
    const { s, t } = await untilReview();
    await writeVerdict(t, verdictFor(reviewPacket(t), R3_GAPS), { cwd: s.control });
    const crashing = new Orchestrator({ controlRoot: s.control, featureId: VER_FEATURE, adapter: {} as SessionAdapter, settleFault: (point: SettleFaultPoint) => { if (point === 'review-recorded') throw new Error(`CRASH at ${point}`); } });
    expect(() => crashing.settleReview(t.review_id, t.capability)).toThrow(/CRASH at review-recorded/);
    const state = verState(s);
    expect(state.acceptance_review.reviews).toEqual([expect.objectContaining({ outcome: 'GAPS', reworks: [CLI, ARP], reworks_applied: true })]);
    expect(reworksOf(s, t.review_id).map((r) => r.node_id)).toEqual([CLI, ARP]);
    commitVerControl(s, 'crashed after the record');
    const next = await dispatch(s);
    expect(next.status, next.detail).toBe('DISPATCHED');
    expect(next.ticket?.node_id).toBe(ARP);
    expect(reworksOf(s, t.review_id)).toHaveLength(2);
    expect(verState(s).acceptance_review.usage.sessions).toBe(1);
    expect((await settleReview(s, t)).out).toMatchObject({ outcome: 'GAPS', reworked: [CLI, ARP], idempotent: true });
  });

  it('a review recorded as reworked whose rework records are gone is an internal error dispatch names, never a new review or a candidate', async () => {
    const { s, t } = await untilReview();
    await writeVerdict(t, verdictFor(reviewPacket(t), R3_GAPS), { cwd: s.control });
    expect((await settleReview(s, t)).out).toMatchObject({ outcome: 'GAPS' });
    // STATE.json changed outside Mycelink: the review's rework records dropped.
    mutateState(s.featureDir, (st) => ({ ...st, reworks: (st.reworks ?? []).filter((r) => r.origin?.review_id !== t.review_id) }));
    commitVerControl(s, 'tampered');
    const stop = await dispatch(s);
    expect(stop.status).toBe('BLOCKED');
    expect(stop.detail).toMatch(/REVIEW_REWORKS_MISSING/);
    expect(stop.detail).toContain(t.review_id);
    expect(stop.detail).toContain(CLI);
    expect(verState(s).acceptance_review.reviews[0]).toMatchObject({ reworks_applied: false });
    expect(stop.ticket).toBeUndefined();
    expect(verState(s).current_candidate).toBeNull();
  });
});

describe("r3's own graph (AC-5 on the verification node alone), as a feature initialised before the ownership rule", () => {
  it('reworks the producers of AC-1 and AC-3, then blocks on AC-5, which has no product node: no gap is dropped, no candidate is cut', async () => {
    const { s, t } = await untilReview({ legacy: true });
    await writeVerdict(t, verdictFor(reviewPacket(t), R3_GAPS), { cwd: s.control });
    const settled = await settleReview(s, t);
    expect(settled.out).toMatchObject({ outcome: 'REVIEW_GAPS', reworked: [CLI, ARP], blocked: true, next: 'stop' });
    const state = verState(s);
    expect(state.acceptance_review.reviews).toEqual([expect.objectContaining({ outcome: 'REVIEW_GAPS', reworks: [CLI, ARP], reworks_applied: true })]);
    expect(reworksOf(s, t.review_id).map((r) => r.node_id)).toEqual([CLI, ARP]);
    expect(state.nodes[CLI].rework_brief).toMatchObject({ acceptance_criteria: ['AC-3'] });
    expect(state.nodes[ARP].rework_brief).toMatchObject({ acceptance_criteria: ['AC-1'] });
    expect(state.feature_state).toBe('BLOCKED');
    expect(state.acceptance_review.blocked).toMatchObject({ code: 'REVIEW_GAPS', review_id: t.review_id });
    const detail = state.acceptance_review.blocked.detail as string;
    expect(detail).toMatch(/AC-5.*no product node/);
    expect(detail).toContain(CLI);
    expect(detail).toContain(ARP);
    const receipt = JSON.parse(readFileSync(join(s.control, settled.out['receipt_path']), 'utf8'));
    expect(receipt.unowned.map((g: { criterion: string }) => g.criterion)).toEqual(['AC-5']);
    commitVerControl(s, 'blocked on an unowned gap');
    const stop = await dispatch(s);
    expect(stop.status).toBe('BLOCKED');
    expect(stop.detail).toContain('REVIEW_GAPS');
    const create = await verCli(s, ['candidate', 'create', VER_FEATURE]);
    expect(create.code).not.toBe(0);
    expect(create.err).toMatch(/NODES_NOT_DONE|REVIEW_GAPS/);
    expect(verState(s).current_candidate).toBeNull();
    expect(JSON.parse((await verCli(s, ['feature', 'verify', VER_FEATURE, '--json'])).out).problems.join('\n')).toMatch(/REVIEW_GAPS[\s\S]*CRITERION_NO_PRODUCER|CRITERION_NO_PRODUCER[\s\S]*REVIEW_GAPS/);
  });
});
