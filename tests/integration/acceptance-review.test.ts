/**
 * The independent acceptance review, between the last product node and the
 * candidate (engine/acceptance-review.ts, Orchestrator.dispatchNext).
 *
 * CSET-203 r2: every node strict-TDD DONE, criterion evidence mechanically
 * accepted, C001/C002 delivered — and hidden acceptance failed AC-1 at a
 * boundary the worker never tested (a changelog that cannot be written after
 * the package versions were). Here, on the CSET-203-shaped fixture:
 *
 *  - once every product and verification node is DONE, `dispatch` hands out
 *    an acceptance-review ticket for the read-only reviewer subagent, bound
 *    to the repository heads, the graph and the approved criteria; nothing
 *    cuts a candidate before a PASS (dispatch, `candidate create`, `feature
 *    verify`, `candidate verify` and `deliver` all ask for its receipt);
 *  - a GAP reworks the producer the graph says owns the criterion, with the
 *    reviewer's public reproduction as the rework reason, downstream
 *    reopened; the next worker adds a focused RED; the review runs again;
 *  - at most `max_rounds` accepted reworks per criterion: a materially new gap
 *    of a criterion past them blocks the feature (REVIEW_GAPS), never a
 *    candidate (CSET-203 r11: the budget is each criterion's own);
 *  - a missing, malformed, unattested, forged or incomplete verdict is
 *    refused; one refused for its form is corrected (MAX_FORMAT_CORRECTIONS), one
 *    that left nothing to correct gets a fresh reviewer once, then REVIEW_INVALID;
 *  - an interrupted review or rework resumes without running a reviewer
 *    whose verdict is already in hand, and counts its usage once.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { git } from '../helpers/git-fixture.js';
import {
  ARP,
  ARP_CHANGELOG_TEST,
  ARP_FIXED_IMPL,
  ARP_GAPPY_IMPL,
  ARP_JOURNAL_TEST,
  ARP_RED,
  ARP_REVIEW_RED,
  ARP_ROLLBACK_TEST,
  ARP_SRC,
  ARP_TESTS,
  CLI,
  CLI_AC5,
  CLI_FAILURE_TEST,
  CLI_FULL_WORK,
  CLI_RECOVERY_TEST,
  COMPAT,
  VER_CANDIDATE,
  VER_FEATURE,
  commitVerControl,
  createVer,
  verCli,
  verState,
  type Ver,
} from '../helpers/version-fixture.js';
import { fulfil, packOf, type CriterionItem, type ShopTicket } from '../helpers/shop-worker.js';
import { reviewPacket, reviewerToolCall, verdictFor, writeVerdict, type ReviewTicket } from '../helpers/review-agent.js';
import { claudeSession, finishAgent, launchAgent } from '../helpers/claude-session.js';
import { Orchestrator, type SettleFaultPoint } from '../../src/engine/orchestrator.js';
import type { SessionAdapter } from '../../src/sessions/adapter.js';
import { reviewGateProblems } from '../../src/engine/acceptance-review.js';
import { canonicalTestId } from '../../src/evidence/test-ids.js';
import { mutateState } from '../../src/state/feature-state.js';

afterAll(() => cleanupTmpRoots());

const sha256 = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

interface Dispatched {
  status: string;
  detail: string;
  ticket?: (ShopTicket & { kind?: string; agent: string; review_id?: string }) | undefined;
  controller_reports: { node_id: string; outcome: string }[];
  review_reports?: { review_id: string; outcome: string; detail: string }[];
  pending_review?: { review_id: string; dispatch_id: string; verdict_present: boolean; expired: boolean } | null;
}

async function dispatch(s: Ver, ...extra: string[]): Promise<Dispatched> {
  const r = await verCli(s, ['dispatch', VER_FEATURE, ...extra, '--json']);
  if (r.out === '') throw new Error(`dispatch printed nothing: ${r.err}`);
  return JSON.parse(r.out) as Dispatched;
}

async function settleNode(s: Ver, t: ShopTicket): Promise<{ outcome: string; detail: string }> {
  return JSON.parse((await verCli(s, ['settle', VER_FEATURE, t.node_id, '--capability', t.capability, '--json'])).out) as { outcome: string; detail: string };
}

async function settleReview(s: Ver, t: ReviewTicket): Promise<{ code: number; out: Record<string, any>; err: string }> {
  const r = await verCli(s, ['review', 'settle', VER_FEATURE, '--review', t.review_id, '--capability', t.capability, '--json']);
  return { code: r.code, out: r.out === '' ? {} : (JSON.parse(r.out) as Record<string, any>), err: r.err };
}

const ARP_CRITERIA: CriterionItem[] = [
  { criterion: 'AC-1', gate: 'red', full_name: ARP_ROLLBACK_TEST },
  { criterion: 'AC-2', gate: 'red', full_name: ARP_JOURNAL_TEST },
];
const CLI_CRITERIA: CriterionItem[] = [
  { criterion: 'AC-3', gate: 'red', full_name: CLI_RECOVERY_TEST },
  { criterion: 'AC-4', gate: 'red', full_name: CLI_FAILURE_TEST },
  CLI_AC5,
];
/** The cli reopened by an upstream rework keeps its RED: its evidence names the same tests by id. */
const cliId = (name: string): string => canonicalTestId('junit-xml', 'packages/cli/test/cli.test.mjs', name);
const CLI_REVERIFIED: CriterionItem[] = [
  { criterion: 'AC-3', gate: 'red', test_id: cliId(CLI_RECOVERY_TEST) },
  { criterion: 'AC-4', gate: 'red', test_id: cliId(CLI_FAILURE_TEST) },
  CLI_AC5,
];

/** Both producers DONE (apply-release-plan as r2's worker wrote it), then the dispatch that runs the compatibility node and hands out the review. */
async function untilReview(options: { review?: { required?: boolean; max_rounds?: number; criterion_ceiling?: number }; arpImpl?: string } = {}): Promise<{ s: Ver; d: Dispatched }> {
  const s = await createVer({ review: options.review ?? {} });
  const a = (await dispatch(s)).ticket!;
  expect(a.node_id).toBe(ARP);
  fulfil(a, { tests: { [ARP_TESTS]: ARP_RED }, impl: { [ARP_SRC]: options.arpImpl ?? ARP_GAPPY_IMPL }, criteria: ARP_CRITERIA }, s.control);
  expect(await settleNode(s, a)).toMatchObject({ outcome: 'DONE' });
  commitVerControl(s, 'apply-release-plan');
  const c = (await dispatch(s)).ticket!;
  expect(c.node_id).toBe(CLI);
  fulfil(c, { ...CLI_FULL_WORK, criteria: CLI_CRITERIA }, s.control);
  expect(await settleNode(s, c)).toMatchObject({ outcome: 'DONE' });
  commitVerControl(s, 'cli');
  return { s, d: await dispatch(s) };
}

const GAP = {
  missing: 'rollback is tested only for a formatter crash after every file was written; no test fails the changelog write itself after the package/version writes',
  reproduction: 'inject changelog writer failure after package/version writes and assert exact rollback',
  producer: { node_id: ARP, module: 'changesets:packages/apply-release-plan' },
};

/** The reworked producer's worker: the focused RED for the gap alone, then the fix; AC-2 keeps the proof its replaced work had. */
function repairArp(t: ShopTicket, control: string): void {
  const carried = (packOf(t)['rework']?.['carried_criteria'] ?? []) as { criterion: string; test_id: string; output_sha256: string }[];
  const ac2 = carried.find((c) => c.criterion === 'AC-2');
  if (ac2 === undefined) throw new Error(`no carried proof for AC-2 in ${JSON.stringify(packOf(t)['rework'])}`);
  const run = fulfil(t, { tests: { [ARP_TESTS]: ARP_REVIEW_RED }, impl: { [ARP_SRC]: ARP_FIXED_IMPL }, criteria: [{ criterion: 'AC-1', gate: 'red', full_name: ARP_CHANGELOG_TEST }] }, control);
  expect(run.gates.map((g) => [g.gate, g.code]), run.gates.map((g) => g.out.slice(-800)).join('\n')).toEqual([['red', 0], ['green', 0], ['regression', 0]]);
  const result = run.result as { criterion_evidence: Record<string, unknown>[] };
  result.criterion_evidence.push({ criterion: 'AC-2', test_id: ac2.test_id, gate: 'red', output_sha256: ac2.output_sha256 });
  writeFileSync(t.result_slot, JSON.stringify(result, null, 2));
}

describe('the acceptance review sits between the last product node and the candidate', () => {
  it('is handed out once every product and verification node is DONE, bound to the heads, graph and criteria, and nothing cuts a candidate before it', async () => {
    const { s, d } = await untilReview();
    expect(d.controller_reports.map((r) => [r.node_id, r.outcome])).toEqual([[COMPAT, 'DONE']]);
    expect(d.status, d.detail).toBe('DISPATCHED');
    const t = d.ticket as unknown as ReviewTicket;
    expect(t).toMatchObject({ schema: 'mycelink-review-ticket/1', kind: 'acceptance-review', node_id: null, review_id: `${VER_FEATURE}-R001`, agent: 'mycelink:acceptance-reviewer', criteria: ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5'] });
    const state = verState(s);
    expect(state.nodes[VER_CANDIDATE].state).not.toBe('DONE');
    expect(state.current_candidate).toBeNull();
    expect(state.acceptance_review).toMatchObject({ required: true, max_rounds: 2, open: { review_id: t.review_id, dispatch_id: t.dispatch_id } });
    // The brief: identity, the packet, the verdict file and every criterion's clauses; never a capability or the key.
    expect(t.prompt).toContain(`Acceptance review: ${t.review_id}`);
    expect(t.prompt).toContain(`Dispatch: ${t.dispatch_id}`);
    expect(t.prompt).toContain(t.packet_path.replace(/\\/g, '/'));
    expect(t.prompt).toContain(t.result_slot.replace(/\\/g, '/'));
    for (const clause of ['AC-1.1', 'AC-1.2', 'AC-3.1', 'AC-5.1']) expect(t.prompt).toContain(clause);
    expect(t.prompt).not.toContain(t.capability);
    expect(t.settle_command).toContain(`review settle ${VER_FEATURE} --review ${t.review_id}`);
    // The packet: the approved criteria verbatim, the graph's ownership, the reviewed head checked out, its diff, the workers' evidence.
    const packet = reviewPacket(t);
    expect(packet).toMatchObject({ schema: 'mycelink-review-packet/1', review_id: t.review_id, dispatch_id: t.dispatch_id, inputs_sha256: t.inputs_sha256, review: 1, rework_rounds: { used: 0, max: 2 } });
    expect(packet.criteria.map((c) => [c.id, c.kind])).toEqual([['AC-1', 'new-behavior'], ['AC-2', 'new-behavior'], ['AC-3', 'new-behavior'], ['AC-4', 'new-behavior'], ['AC-5', 'compatibility']]);
    expect(packet.criteria.find((c) => c.id === 'AC-1')?.producers).toEqual([ARP]);
    const head = git(s.repo, ['rev-parse', `feature/${VER_FEATURE}`]);
    const repo = packet.repositories[0]!;
    expect(repo).toMatchObject({ name: 'changesets', head_sha: head });
    expect(git(repo.checkout, ['rev-parse', 'HEAD'])).toBe(head);
    expect(readFileSync(repo.diff, 'utf8')).toContain('restore(files, changed)');
    expect(repo.changed.map((c) => [c.path, c.test])).toEqual(expect.arrayContaining([[ARP_TESTS, true], [ARP_SRC, false]]));
    expect(packet.criterion_evidence.filter((e) => e.criterion === 'AC-1').map((e) => e.test?.name)).toEqual([ARP_ROLLBACK_TEST]);
    // AC-5's evidence: the cli's test through green (its product producer) and the compatibility node's receipt.
    expect(packet.criterion_evidence.filter((e) => e.criterion === 'AC-5').flatMap((e) => e.evidence_ids)).toEqual(expect.arrayContaining([`receipt:${COMPAT}`, `gate:${CLI}:green`]));
    expect(packet.evidence.map((e) => e.id)).toEqual(expect.arrayContaining([`gate:${ARP}:red`, `gate:${CLI}:green`, `receipt:${COMPAT}`]));
    // Nothing cuts a candidate meanwhile.
    const again = await dispatch(s);
    expect(again.status).toBe('WAITING');
    expect(again.pending_review).toMatchObject({ review_id: t.review_id, verdict_present: false, expired: false });
    const create = await verCli(s, ['candidate', 'create', VER_FEATURE, '--json']);
    expect(create.code).not.toBe(0);
    expect(create.err).toContain('REVIEW_REQUIRED');
    const verify = JSON.parse((await verCli(s, ['feature', 'verify', VER_FEATURE, '--json'])).out) as { ok: boolean; problems: string[] };
    expect(verify.ok).toBe(false);
    expect(verify.problems.join('\n')).toMatch(/REVIEW_REQUIRED/);
  });

  it('a PASS receipt lets the candidate build run; feature verify, candidate verify and deliver check it is bound to what they deliver', async () => {
    const { s, d } = await untilReview({ arpImpl: ARP_FIXED_IMPL });
    const t = d.ticket as unknown as ReviewTicket;
    await writeVerdict(t, verdictFor(reviewPacket(t), {}, 'claude-review-model'), { cwd: s.control, agentId: 'agent-r1', sessionId: 'session-r1' });
    const settled = await settleReview(s, t);
    expect(settled.err).toBe('');
    expect(settled.out).toMatchObject({ review_id: t.review_id, outcome: 'PASS', idempotent: false });
    const receiptPath = join(s.control, settled.out['receipt_path']);
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    const head = git(s.repo, ['rev-parse', `feature/${VER_FEATURE}`]);
    expect(receipt).toMatchObject({
      schema: 'mycelink-review-receipt/1',
      review_id: t.review_id,
      dispatch_id: t.dispatch_id,
      overall: 'PASS',
      inputs_sha256: t.inputs_sha256,
      inputs: { feature_id: VER_FEATURE, repositories: [{ name: 'changesets', head_sha: head }] },
      reviewer: { agent: 'mycelink:acceptance-reviewer', model: 'claude-review-model', agent_id: 'agent-r1', session_id: 'session-r1' },
    });
    expect(verState(s).acceptance_review.reviews).toEqual([expect.objectContaining({ review_id: t.review_id, overall: 'PASS', receipt_sha256: sha256(receiptPath) })]);
    // The reviewer's checkout is gone; its verdict and the packet stay in the scratch area.
    expect(existsSync(reviewPacket(t).repositories[0]!.checkout)).toBe(false);
    commitVerControl(s, 'reviewed');
    const built = await dispatch(s);
    expect(built.status, built.detail).toBe('ALL_SETTLED');
    expect(built.controller_reports.map((r) => [r.node_id, r.outcome])).toEqual([[VER_CANDIDATE, 'DONE']]);
    commitVerControl(s, 'settled');
    expect(verState(s).current_candidate).toBe(`${VER_FEATURE}-C001`);
    expect(JSON.parse((await verCli(s, ['feature', 'verify', VER_FEATURE, '--json'])).out)).toEqual({ ok: true, problems: [] });
    expect(JSON.parse((await verCli(s, ['candidate', 'verify', VER_FEATURE, '--json'])).out)).toMatchObject({ ok: true });
    // A candidate the PASS does not bind is not deliverable on it.
    expect(reviewGateProblems(s.control, VER_FEATURE)).toEqual([]);
    expect(reviewGateProblems(s.control, VER_FEATURE, { candidateRepositories: { changesets: head } })).toEqual([]);
    expect(reviewGateProblems(s.control, VER_FEATURE, { candidateRepositories: { changesets: '0'.repeat(40) } }).join('\n')).toMatch(/REVIEW_NOT_FOR_CANDIDATE/);
    expect(JSON.parse((await verCli(s, ['deliver', VER_FEATURE, '--json'])).out)).toMatchObject({ status: 'ACCEPTED' });
    commitVerControl(s, 'delivered');
    expect(JSON.parse((await verCli(s, ['feature', 'verify', VER_FEATURE, '--delivered', '--json'])).out)).toEqual({ ok: true, problems: [] });
    // A receipt edited afterwards proves nothing.
    writeFileSync(receiptPath, readFileSync(receiptPath, 'utf8').replace('"PASS"', '"PASS" '));
    const tampered = JSON.parse((await verCli(s, ['feature', 'verify', VER_FEATURE, '--json'])).out) as { problems: string[] };
    expect(tampered.problems.join('\n')).toMatch(/REVIEW_RECEIPT_TAMPERED/);
  });

  it('a GAP reworks the producer the graph names, with the reviewer\'s exact public reason; downstream reopens; the review runs again and its PASS lets the candidate through', async () => {
    const { s, d } = await untilReview();
    const t = d.ticket as unknown as ReviewTicket;
    await writeVerdict(t, verdictFor(reviewPacket(t), { 'AC-1': { gap: GAP } }), { cwd: s.control });
    const settled = await settleReview(s, t);
    expect(settled.out).toMatchObject({ outcome: 'GAPS', reworked: [ARP] });
    const state = verState(s);
    expect(state.nodes[ARP].state).toBe('INVALIDATED');
    const brief = state.nodes[ARP].rework_brief;
    expect(brief.reason).toContain(GAP.reproduction);
    expect(brief.reason).toContain(t.review_id);
    expect(brief.acceptance_criteria).toEqual(['AC-1']);
    // Bound to the review's revision 0, its receipt by hash (engine/review-revision.ts).
    expect(brief.origin).toEqual({ kind: 'acceptance-review', review_id: t.review_id, review: 1, revision: 0, receipt_path: settled.out['receipt_path'], receipt_sha256: settled.out['receipt_sha256'] });
    expect(brief.evidence).toEqual([settled.out['receipt_path']]);
    for (const id of [CLI, COMPAT, VER_CANDIDATE]) expect(['INVALIDATED', 'PLANNED', 'READY']).toContain(state.nodes[id].state);
    expect(state.reworks.at(-1)).toMatchObject({ node_id: ARP, origin: { kind: 'acceptance-review', review_id: t.review_id } });
    expect(state.acceptance_review.reviews).toEqual([expect.objectContaining({ review_id: t.review_id, overall: 'GAPS', reworks: [ARP], reworks_applied: true })]);
    commitVerControl(s, 'review gaps');

    // A fresh module-worker gets the gap, must prove it with a focused RED, and keeps AC-2's proof.
    const r = (await dispatch(s)).ticket!;
    expect(r.node_id).toBe(ARP);
    const rework = packOf(r)['rework'];
    expect(rework).toMatchObject({ acceptance_criteria: ['AC-1'], origin: { kind: 'acceptance-review', review_id: t.review_id } });
    expect(rework.carried_criteria.map((c: { criterion: string }) => c.criterion)).toEqual(['AC-2']);
    expect(r.prompt).toMatch(/acceptance review/i);
    expect(r.prompt).toMatch(/focused failing (regression )?test/);
    repairArp(r, s.control);
    const repaired = await settleNode(s, r);
    expect(repaired, repaired.detail).toMatchObject({ outcome: 'DONE' });
    expect(verState(s).nodes[ARP].criteria).toEqual(expect.arrayContaining([expect.objectContaining({ criterion: 'AC-1', gate: 'red', test: expect.objectContaining({ name: ARP_CHANGELOG_TEST }) }), expect.objectContaining({ criterion: 'AC-2', carried: true })]));
    commitVerControl(s, 'arp repaired');
    // The cli re-proves GREEN on the repaired integration; the compatibility node runs again; then the second review.
    const c = (await dispatch(s)).ticket!;
    expect(c.node_id).toBe(CLI);
    expect(packOf(c)['next_required_gate']).toBe('GREEN_VERIFIED');
    fulfil(c, { ...CLI_FULL_WORK, criteria: CLI_REVERIFIED }, s.control);
    expect(await settleNode(s, c)).toMatchObject({ outcome: 'DONE' });
    commitVerControl(s, 'cli again');
    const second = await dispatch(s);
    expect(second.controller_reports.map((x) => [x.node_id, x.outcome])).toEqual([[COMPAT, 'DONE']]);
    const t2 = second.ticket as unknown as ReviewTicket;
    expect(t2).toMatchObject({ kind: 'acceptance-review', review_id: `${VER_FEATURE}-R002` });
    const packet2 = reviewPacket(t2);
    expect(packet2.rework_rounds).toEqual({ used: 1, max: 2 });
    expect(packet2.criterion_evidence.filter((e) => e.criterion === 'AC-1').map((e) => e.test?.name)).toEqual([ARP_CHANGELOG_TEST]);
    await writeVerdict(t2, verdictFor(packet2), { cwd: s.control });
    expect((await settleReview(s, t2)).out).toMatchObject({ outcome: 'PASS' });
    commitVerControl(s, 'reviewed again');
    expect((await dispatch(s)).status).toBe('ALL_SETTLED');
    commitVerControl(s, 'settled');
    expect(JSON.parse((await verCli(s, ['deliver', VER_FEATURE, '--json'])).out)).toMatchObject({ status: 'ACCEPTED', candidate_id: `${VER_FEATURE}-C001` });
  });

  it('a materially new gap of a criterion at its emergency ceiling blocks the feature (REVIEW_GAPS), never a candidate', async () => {
    const { s, d } = await untilReview({ review: { max_rounds: 1, criterion_ceiling: 1 } });
    const t = d.ticket as unknown as ReviewTicket;
    await writeVerdict(t, verdictFor(reviewPacket(t), { 'AC-1': { gap: GAP } }), { cwd: s.control });
    expect((await settleReview(s, t)).out).toMatchObject({ outcome: 'GAPS', reworked: [ARP] });
    commitVerControl(s, 'gaps');
    const r = (await dispatch(s)).ticket!;
    repairArp(r, s.control);
    expect(await settleNode(s, r)).toMatchObject({ outcome: 'DONE' });
    commitVerControl(s, 'arp repaired');
    const c = (await dispatch(s)).ticket!;
    fulfil(c, { ...CLI_FULL_WORK, criteria: CLI_REVERIFIED }, s.control);
    expect(await settleNode(s, c)).toMatchObject({ outcome: 'DONE' });
    commitVerControl(s, 'repaired');
    const t2 = (await dispatch(s)).ticket as unknown as ReviewTicket;
    await writeVerdict(t2, verdictFor(reviewPacket(t2), { 'AC-1': { gap: { missing: 'a changelog the run created is never shown removed after a later failure', reproduction: 'make the formatter fail on the second package.json after the first CHANGELOG.md was created; assert that changelog is absent and both package.json files hold their exact previous bytes' } } }), { cwd: s.control });
    const blocked = await settleReview(s, t2);
    expect(blocked.out).toMatchObject({ outcome: 'REVIEW_GAPS', reworked: [] });
    const state = verState(s);
    expect(state.feature_state).toBe('BLOCKED');
    expect(state.acceptance_review.blocked).toMatchObject({ code: 'REVIEW_GAPS', review_id: t2.review_id, criteria: ['AC-1'] });
    expect(state.acceptance_review.blocked.detail).toContain('AC-1 (at its emergency ceiling of 1 accepted rework(s)');
    expect(state.nodes[ARP].state).toBe('DONE');
    commitVerControl(s, 'blocked');
    const stop = await dispatch(s);
    expect(stop.status).toBe('BLOCKED');
    expect(stop.detail).toContain('REVIEW_GAPS');
    expect(verState(s).nodes[VER_CANDIDATE].state).not.toBe('DONE');
    expect((await verCli(s, ['candidate', 'create', VER_FEATURE])).err).toMatch(/REVIEW_GAPS/);
    expect(JSON.parse((await verCli(s, ['feature', 'verify', VER_FEATURE, '--json'])).out).problems.join('\n')).toMatch(/REVIEW_GAPS/);
  });
});

describe('a verdict is checked before anything is believed', () => {
  it('missing, malformed, unattested and incomplete verdicts are refused; a fresh reviewer gets one more try, then REVIEW_INVALID', async () => {
    const { s, d } = await untilReview();
    const t = d.ticket as unknown as ReviewTicket;
    // No reviewer launched yet: no missing verdict, nothing spent (CSET-203 r13).
    expect((await settleReview(s, t)).out).toMatchObject({ outcome: 'REVIEWER_NOT_LAUNCHED', code: null, next: 'launch' });
    expect(verState(s).acceptance_review.open.refused).toEqual([]);
    // The reviewer completed and wrote nothing, answered nothing.
    const host = claudeSession(s.control);
    const { agent } = await launchAgent(host, { subagent_type: 'mycelink:acceptance-reviewer', description: `acceptance review ${t.review_id}`, prompt: t.prompt });
    finishAgent(host, agent, '');
    const missing = await settleReview(s, t);
    expect(missing.out).toMatchObject({ outcome: 'REVIEW_INVALID', code: 'REVIEW_VERDICT_MISSING', lifecycle: 'COMPLETED_NO_OUTPUT' });
    expect(verState(s).nodes[ARP].state).toBe('DONE');
    // The next dispatch re-issues the same review to a fresh reviewer generation: a new slot, the old capability revoked.
    const again = (await dispatch(s)).ticket as unknown as ReviewTicket;
    expect(again).toMatchObject({ review_id: t.review_id, resumed: true });
    expect(again.dispatch_id).not.toBe(t.dispatch_id);
    expect(again.result_slot).not.toBe(t.result_slot);
    // The revoked generation settled late: stale (CSET-203 r7), nothing recorded or counted again.
    const sessions = verState(s).acceptance_review.usage.sessions;
    expect((await settleReview(s, t)).out).toMatchObject({ outcome: 'STALE_ORCHESTRATION_EPOCH', idempotent: false });
    expect(verState(s).acceptance_review.usage.sessions).toBe(sessions);
    // A verdict planted in the slot without the reviewer's attested Write.
    writeFileSync(again.result_slot, JSON.stringify(verdictFor(reviewPacket(again))));
    const planted = await settleReview(s, again);
    expect(planted.out).toMatchObject({ outcome: 'REVIEW_INVALID', code: 'REVIEW_UNATTESTED' });
    const state = verState(s);
    expect(state.feature_state).toBe('BLOCKED');
    expect(state.acceptance_review.blocked).toMatchObject({ code: 'REVIEW_INVALID', review_id: t.review_id });
    expect((await dispatch(s)).status).toBe('BLOCKED');
  });

  it('a PASS that leaves a criterion out, a verdict for another generation, and an attested verdict changed afterwards are each refused', async () => {
    const { s, d } = await untilReview({ review: { max_rounds: 2 } });
    const t = d.ticket as unknown as ReviewTicket;
    const incomplete = verdictFor(reviewPacket(t)) as { criteria: { criterion: string }[] };
    incomplete.criteria = incomplete.criteria.filter((c) => c.criterion !== 'AC-5');
    await writeVerdict(t, incomplete, { cwd: s.control });
    expect((await settleReview(s, t)).out).toMatchObject({ outcome: 'REVIEW_INVALID', code: 'REVIEW_INCOMPLETE' });
    expect(verState(s).acceptance_review.blocked).toBeNull();
    const t2 = (await dispatch(s)).ticket as unknown as ReviewTicket;
    // The first generation's verdict, written into the second's slot: bound to another dispatch.
    await writeVerdict(t2, verdictFor(reviewPacket(t)), { cwd: s.control });
    expect((await settleReview(s, t2)).out).toMatchObject({ outcome: 'REVIEW_INVALID', code: 'REVIEW_BINDING_MISMATCH', blocked: false });
    // Both refused for their form: each is corrected by the next generation (at most MAX_FORMAT_CORRECTIONS), not blocked.
    expect(verState(s).acceptance_review.blocked).toBeNull();
    const t3 = (await dispatch(s)).ticket as unknown as ReviewTicket & { correction: { number: number; of_dispatch_id: string } };
    expect(t3.correction).toMatchObject({ number: 2, of_dispatch_id: t2.dispatch_id });
  });

  it('an attested verdict edited after the Write is not the reviewer\'s', async () => {
    const { s, d } = await untilReview();
    const t = d.ticket as unknown as ReviewTicket;
    await writeVerdict(t, verdictFor(reviewPacket(t), { 'AC-1': { gap: GAP } }), { cwd: s.control });
    // The attested GAP turned into a PASS in place, by anything but the reviewer's own Write.
    writeFileSync(t.result_slot, JSON.stringify(verdictFor(reviewPacket(t)), null, 2));
    expect((await settleReview(s, t)).out).toMatchObject({ outcome: 'REVIEW_INVALID', code: 'REVIEW_UNATTESTED' });
    expect(verState(s).nodes[ARP].state).toBe('DONE');
    expect(verState(s).acceptance_review.reviews).toEqual([]);
  });

  it('a PASS for heads that have moved since is stale: later code needs a review of its own', async () => {
    const { s, d } = await untilReview({ arpImpl: ARP_FIXED_IMPL });
    const t = d.ticket as unknown as ReviewTicket;
    await writeVerdict(t, verdictFor(reviewPacket(t)), { cwd: s.control });
    expect((await settleReview(s, t)).out).toMatchObject({ outcome: 'PASS' });
    commitVerControl(s, 'reviewed');
    expect(reviewGateProblems(s.control, VER_FEATURE)).toEqual([]);
    // Later work lands on the integration branch where the controller records it.
    const branch = `feature/${VER_FEATURE}`;
    const head = git(s.repo, ['rev-parse', branch]);
    const moved = git(s.repo, ['commit-tree', git(s.repo, ['rev-parse', `${head}^{tree}`]), '-p', head, '-m', 'later work']);
    git(s.repo, ['update-ref', `refs/heads/${branch}`, moved, head]);
    mutateState(s.featureDir, (st) => {
      st.integration_heads = { ...(st.integration_heads ?? {}), changesets: moved };
      return st;
    });
    expect(reviewGateProblems(s.control, VER_FEATURE).join('\n')).toMatch(/REVIEW_STALE/);
    const create = await verCli(s, ['candidate', 'create', VER_FEATURE, '--json']);
    expect(create.code).not.toBe(0);
    expect(create.err).toMatch(/REVIEW_STALE/);
    // The next dispatch reviews what is there now.
    const next = await dispatch(s);
    expect(next.ticket).toMatchObject({ kind: 'acceptance-review', review_id: `${VER_FEATURE}-R002` });
    expect(reviewPacket(next.ticket as unknown as ReviewTicket).repositories[0]!.head_sha).toBe(moved);
  });
});

describe('an interrupted review or rework resumes where it stopped', () => {
  it('a verdict already in its slot is settled by the next dispatch, without another reviewer, its usage counted once', async () => {
    const { s, d } = await untilReview({ arpImpl: ARP_FIXED_IMPL });
    const t = d.ticket as unknown as ReviewTicket;
    await writeVerdict(t, verdictFor(reviewPacket(t)), { cwd: s.control });
    commitVerControl(s, 'interrupted');
    // A new session: reconcile names the review, the next dispatch settles it from its slot.
    const reconciled = JSON.parse((await verCli(s, ['session', 'reconcile', VER_FEATURE, '--json'])).out);
    expect(reconciled.pending_review).toMatchObject({ review_id: t.review_id, verdict_present: true });
    const resumed = await dispatch(s);
    expect(resumed.review_reports).toEqual([expect.objectContaining({ review_id: t.review_id, outcome: 'PASS' })]);
    expect(resumed.ticket).toBeUndefined();
    expect(resumed.status).toBe('ALL_SETTLED');
    expect(verState(s).acceptance_review.usage.sessions).toBe(1);
    // The host's own settle afterwards changes nothing.
    const late = await settleReview(s, t);
    expect(late.out).toMatchObject({ outcome: 'PASS', idempotent: true });
    expect(verState(s).acceptance_review.usage.sessions).toBe(1);
    expect(verState(s).acceptance_review.reviews).toHaveLength(1);
  });

  it('a reviewer interrupted before its verdict is re-issued only on resume, with a new generation; the old one can no longer settle', async () => {
    const { s, d } = await untilReview();
    const t = d.ticket as unknown as ReviewTicket;
    const reconciled = JSON.parse((await verCli(s, ['session', 'reconcile', VER_FEATURE, '--json'])).out);
    expect(reconciled.pending_review).toMatchObject({ review_id: t.review_id, verdict_present: false });
    expect((await dispatch(s)).status).toBe('WAITING');
    const r = await dispatch(s, '--resume', t.review_id);
    expect(r.status).toBe('DISPATCHED');
    const t2 = r.ticket as unknown as ReviewTicket;
    expect(t2).toMatchObject({ review_id: t.review_id, resumed: true });
    expect(t2.dispatch_id).not.toBe(t.dispatch_id);
    // The old generation's late verdict counts for nothing.
    await writeVerdict(t, verdictFor(reviewPacket(t)), { cwd: s.control });
    expect((await settleReview(s, t)).out).toMatchObject({ outcome: 'STALE_ORCHESTRATION_EPOCH', code: 'STALE_ORCHESTRATION_EPOCH' });
    expect(verState(s).acceptance_review.reviews).toEqual([]);
    await writeVerdict(t2, verdictFor(reviewPacket(t2)), { cwd: s.control });
    expect((await settleReview(s, t2)).out).toMatchObject({ outcome: 'PASS' });
  });

  it('a controller that died after recording the GAP and its reworks (one write) goes on from them on the next dispatch, without another reviewer or rework', async () => {
    const { s, d } = await untilReview();
    const t = d.ticket as unknown as ReviewTicket;
    await writeVerdict(t, verdictFor(reviewPacket(t), { 'AC-1': { gap: GAP } }), { cwd: s.control });
    const crashing = new Orchestrator({ controlRoot: s.control, featureId: VER_FEATURE, adapter: {} as SessionAdapter, settleFault: (point: SettleFaultPoint) => { if (point === 'review-recorded') throw new Error(`CRASH at ${point}`); } });
    expect(() => crashing.settleReview(t.review_id, t.capability)).toThrow(/CRASH at review-recorded/);
    let state = verState(s);
    expect(state.acceptance_review.reviews).toEqual([expect.objectContaining({ review_id: t.review_id, overall: 'GAPS', reworks: [ARP], reworks_applied: true })]);
    expect(state.nodes[ARP].state).toBe('INVALIDATED');
    commitVerControl(s, 'crashed');
    const next = await dispatch(s);
    expect(next.status, next.detail).toBe('DISPATCHED');
    expect(next.ticket?.node_id).toBe(ARP);
    expect(packOf(next.ticket!)['rework']).toMatchObject({ origin: { review_id: t.review_id } });
    state = verState(s);
    expect(state.acceptance_review.reviews).toEqual([expect.objectContaining({ reworks_applied: true })]);
    expect(state.reworks.filter((r: { node_id: string }) => r.node_id === ARP)).toHaveLength(1);
    expect(state.acceptance_review.usage.sessions).toBe(1);
    expect(state.acceptance_review.open).toBeNull();
  });
});

describe('the reviewer is read-only', () => {
  it('its only write is its own verdict file; product code, the control repository, other slots and the shell are refused', async () => {
    const { s, d } = await untilReview();
    const t = d.ticket as unknown as ReviewTicket;
    const packet = reviewPacket(t);
    const refused: [string, Record<string, unknown>][] = [
      ['Write', { file_path: join(s.repo, ARP_SRC), content: 'x' }],
      ['Write', { file_path: join(packet.repositories[0]!.checkout, ARP_SRC), content: 'x' }],
      ['Edit', { file_path: join(s.repo, ARP_SRC), old_string: 'a', new_string: 'b' }],
      ['Edit', { file_path: t.result_slot, old_string: 'a', new_string: 'b' }],
      ['Write', { file_path: join(s.featureDir, 'PRD.md'), content: 'x' }],
      ['Write', { file_path: join(s.featureDir, 'STATE.json'), content: '{}' }],
      ['Write', { file_path: t.packet_path, content: '{}' }],
      ['Write', { file_path: join(s.root, 'elsewhere.txt'), content: 'x' }],
      ['Bash', { command: `cat ${t.packet_path}` }],
      ['Bash', { command: `node mycelink.mjs review settle ${VER_FEATURE} --review ${t.review_id} --capability ${t.capability}` }],
      ['Agent', { subagent_type: 'mycelink:module-worker', prompt: 'fix AC-1', description: 'fix' }],
    ];
    for (const [tool, input] of refused) {
      const r = await reviewerToolCall(tool, input, { cwd: s.control });
      expect(r.code, `${tool} ${JSON.stringify(input).slice(0, 120)}`).toBe(2);
      expect(r.err).toMatch(/Blocked/);
    }
    expect(readFileSync(join(s.repo, ARP_SRC), 'utf8')).not.toBe('x');
    expect((await reviewerToolCall('Write', { file_path: t.result_slot, content: '{}' }, { cwd: s.control })).code).toBe(0);
    // Nobody else writes the verdict file: the controller and a module-worker are refused there.
    expect((await reviewerToolCall('Write', { file_path: t.result_slot, content: '{}' }, { cwd: s.control, agentId: '', agentType: '' })).code).toBe(2);
    expect((await reviewerToolCall('Write', { file_path: t.result_slot, content: '{}' }, { cwd: s.control, agentType: 'mycelink:module-worker' })).code).toBe(2);
  });
});
