/**
 * CSET-203 r7 with-normal, model-free, to the delivery it should have
 * reached (every platform).
 *
 * r7: R001 found AC-1 on apply-release-plan and AC-5 on the cli. The
 * apply-release-plan worker challenged AC-1 and its refinement withdrew it;
 * the cli's compatibility rework settled; R002 found AC-1 again and its
 * rework of apply-release-plan reopened the cli and the compatibility node
 * (they depend on it). The worker challenged that gap too, but the challenge
 * restored apply-release-plan alone; R002's refinement withdrew AC-1 and
 * settled PASS while the cli and the compatibility node were still reopened;
 * the cli was then dispatched on a fresh branch already holding its own
 * work, and its worker answered BLOCKED INVALID_RED_EVIDENCE: behaviour
 * already present. No candidate. Here:
 *
 *  1. R001 as r7's, on producers that are right: AC-1's reproduction holds,
 *     AC-5 reworks the cli (compatibility only);
 *  2. the AC-1 challenge; R001's refinement waits for nothing it does not
 *     decide (the cli's standing rework and the compatibility node behind
 *     it) and withdraws AC-1;
 *  3. the cli's compatibility rework: its first dispatch generation is
 *     revoked by a resume; that generation's worker answers late, BLOCKED
 *     INVALID_RED_EVIDENCE: STALE_ORCHESTRATION_EPOCH, archived, nothing
 *     changed, nothing charged, the same answer when settled twice; the
 *     replacement settles DONE;
 *  4. R002 (AC-1 again, another reproduction the code satisfies): the
 *     rework reopens the cli and the compatibility node;
 *  5. the challenge restores apply-release-plan and the cli (reopened by
 *     that rework alone, its generation intact); the compatibility node, a
 *     verification consumer, runs again before the refinement is handed out;
 *  6. R002's refinement withdraws AC-1: PASS, bound to the orchestration
 *     epoch, with no dispatch lease outstanding and every judged node DONE;
 *  7. the obsolete cli dispatch answers again after the PASS:
 *     STALE_ORCHESTRATION_EPOCH; state, PASS and usage unchanged;
 *  8. C001 delivered and accepted; the hidden-like AC-1, AC-3 and AC-5
 *     checks pass on the delivery.
 *
 * The second test runs the producers side by side (the cli independent of
 * apply-release-plan): the cli's rework is live while apply-release-plan's
 * challenge settles, and the refinement waits for it (await-worker).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { git } from '../helpers/git-fixture.js';
import {
  ARP,
  ARP_TESTS,
  CLI,
  COMPAT,
  VER_CANDIDATE,
  VER_CHANGELOG_ACCEPTANCE,
  VER_FEATURE,
  VER_R3_ACCEPTANCE,
  commitVerControl,
  verCli,
  verState,
  type Ver,
} from '../helpers/version-fixture.js';
import { refinementFor, reviewPacket, verdictFor, writeVerdict, type ReviewTicket } from '../helpers/review-agent.js';
import { dispatch, settle, status, type Dispatched } from '../helpers/cset203-rework.js';
import { writeChallenge } from '../helpers/cset203-challenge.js';
import { ARP_R002_RED, ARP_R002_TEST, GAP_AC1_R002, compatRework, r002Clauses, r7Reviewed, settleReview, siblingGraph, writeLateBlocked } from '../helpers/cset203-r7.js';

afterAll(() => cleanupTmpRoots());

const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

function acceptance(repo: string, sha: string, script: string): { code: number; out: string } {
  const at = join(makeTmpDir('cset203-r7-hidden-like-'), 'checkout');
  git(repo, ['worktree', 'add', '--detach', at, sha]);
  try {
    const file = join(makeTmpDir('cset203-r7-script-'), 'acceptance.mjs');
    writeFileSync(file, script);
    const r = spawnSync(process.execPath, [file, at], { encoding: 'utf8' });
    return { code: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
  } finally {
    git(repo, ['worktree', 'remove', '--force', at]);
  }
}

/** What a late answer must leave untouched: every node's state, attempts, claim and integration, the reviews, the usage, the epoch. */
function untouched(s: Ver): string {
  const st = verState(s);
  return JSON.stringify({
    nodes: Object.fromEntries(Object.entries(st.nodes as Record<string, any>).map(([id, rt]) => [id, [rt.state, rt.attempts, rt.claim?.claim_id ?? null, rt.integrated_sha, rt.failure_counts, rt.last_failure_fingerprint, rt.lineage ?? 0]])),
    reviews: st.acceptance_review.reviews.map((r: Record<string, unknown>) => [r['review_id'], r['outcome'], r['receipt_sha256']]),
    usage: [st.usage, st.acceptance_review.usage],
    epoch: st.orchestration.epoch,
    candidate: st.current_candidate,
  });
}

describe('CSET-203 r7, replayed model-free to the delivery it should have reached', () => {
  it('R001 and R002 each challenged and withdrawn; a challenge restores the dependents its rework reopened; the refinement waits for the compatibility node; a late obsolete cli answer is stale; C001 delivered; hidden-like checks pass', async () => {
    // 1. R001 as r7's.
    const s = await r7Reviewed();
    let state = verState(s);
    expect(state.orchestration).toMatchObject({ epoch: expect.any(Number) });
    expect(state.nodes[ARP]).toMatchObject({ state: 'INVALIDATED', rework_brief: { acceptance_criteria: ['AC-1'] } });
    expect(state.nodes[CLI]).toMatchObject({ state: 'INVALIDATED', rework_brief: { acceptance_criteria: ['AC-5'], red_required: false } });

    // 2. The AC-1 challenge; R001's refinement does not wait for the cli's standing rework, and withdraws AC-1.
    const a1 = (await dispatch(s)).ticket!;
    expect(a1.node_id).toBe(ARP);
    writeChallenge(a1, s.control);
    expect(await settle(s, a1)).toMatchObject({ outcome: 'REVIEW_CHALLENGED', state: 'DONE' });
    commitVerControl(s, 'R001 AC-1 challenged');
    const d1 = await dispatch(s);
    expect(d1.controller_reports ?? []).toEqual([]);
    const r1 = d1.ticket as unknown as ReviewTicket & { refinement: Record<string, any> };
    expect(r1).toMatchObject({ kind: 'acceptance-review', review_id: `${VER_FEATURE}-R001`, refinement: { round: 1 } });
    await writeVerdict(r1, refinementFor(reviewPacket(r1), { 'AC-1': { decision: 'WITHDRAW' } }), { cwd: s.control });
    expect(await settleReview(s, r1)).toMatchObject({ outcome: 'GAPS', refinement: { decisions: [{ criterion: 'AC-1', decision: 'WITHDRAW' }] } });
    commitVerControl(s, 'R001 refined');

    // 3. The cli's compatibility rework. Its first generation is revoked by a resume; that worker answers late: stale.
    const c1 = (await dispatch(s)).ticket!;
    expect(c1.node_id).toBe(CLI);
    expect(c1).toMatchObject({ orchestration: { epoch: expect.any(Number), lineage: expect.any(Number) } });
    expect(c1.prompt).toContain(`orchestration_epoch`);
    const resumed = JSON.parse((await verCli(s, ['dispatch', VER_FEATURE, '--resume', CLI, '--json'])).out) as Dispatched;
    const c2 = resumed.ticket!;
    expect(c2).toMatchObject({ node_id: CLI, claim_id: c1.claim_id });
    expect(c2.dispatch_id).not.toBe(c1.dispatch_id);
    writeLateBlocked(c1);
    const before = untouched(s);
    const late = await settle(s, c1);
    expect(late, late.detail).toMatchObject({ outcome: 'STALE_ORCHESTRATION_EPOCH', idempotent: false });
    expect(late.detail).toMatch(/revoked/);
    expect(untouched(s)).toBe(before);
    expect(existsSync(c1.result_slot)).toBe(false);
    const archived = (late as unknown as { stale: { archived: { path: string; sha256: string } } }).stale.archived;
    expect(sha256(readFileSync(join(s.control, archived.path)))).toBe(archived.sha256);
    // Settled again, the same answer: nothing archived twice, nothing charged.
    const again = await settle(s, c1);
    expect(again).toMatchObject({ outcome: 'STALE_ORCHESTRATION_EPOCH', idempotent: true });
    expect((again as unknown as { stale: { archived: { path: string } } }).stale.archived.path).toBe(archived.path);
    expect(untouched(s)).toBe(before);
    expect(verState(s).orchestration.leases.find((l: { dispatch_id: string }) => l.dispatch_id === c1.dispatch_id)).toMatchObject({ status: 'stale', node_id: CLI });
    compatRework(c2, s.control);
    expect(await settle(s, c2)).toMatchObject({ outcome: 'DONE' });
    commitVerControl(s, 'cli: AC-5 regression test');
    const cliDone = structuredClone(verState(s).nodes[CLI]);

    // 4. The compatibility node, then R002: AC-1 again; its rework reopens the cli and the compatibility node.
    const d2 = await dispatch(s);
    expect((d2.controller_reports ?? []).map((x) => [x.node_id, x.outcome])).toEqual([[COMPAT, 'DONE']]);
    const r2 = d2.ticket as unknown as ReviewTicket;
    expect(r2).toMatchObject({ kind: 'acceptance-review', review_id: `${VER_FEATURE}-R002` });
    await writeVerdict(r2, verdictFor(reviewPacket(r2), { 'AC-1': GAP_AC1_R002 }), { cwd: s.control });
    const gaps2 = await settleReview(s, r2);
    expect(gaps2).toMatchObject({ outcome: 'GAPS', reworked: [ARP] });
    commitVerControl(s, 'R002');
    state = verState(s);
    expect(state.nodes[CLI]).toMatchObject({ state: 'INVALIDATED', fresh_branch_required: true, integrated_sha: null });
    expect(state.nodes[COMPAT]).toMatchObject({ state: 'INVALIDATED' });
    expect(state.reworks.at(-1).node_id).toBe(ARP);
    expect(state.reworks.at(-1).reopened).toEqual(expect.arrayContaining([ARP, CLI, COMPAT]));

    // 5. The challenge restores apply-release-plan and the cli its rework reopened; the compatibility node runs again.
    const a2 = (await dispatch(s)).ticket!;
    expect(a2.node_id).toBe(ARP);
    writeChallenge(a2, s.control, { tests: { [ARP_TESTS]: ARP_R002_RED }, test: ARP_R002_TEST, clauses: r002Clauses });
    const challenged = await settle(s, a2);
    expect(challenged, challenged.detail).toMatchObject({ outcome: 'REVIEW_CHALLENGED', state: 'DONE', challenge: { review_id: `${VER_FEATURE}-R002`, restored: [CLI] } });
    commitVerControl(s, 'R002 AC-1 challenged');
    state = verState(s);
    expect(state.nodes[ARP]).toMatchObject({ state: 'DONE', claim: null });
    // The cli is the generation it was before R002's rework, exactly: integrated, its evidence and history back, no fresh branch.
    expect(state.nodes[CLI]).toMatchObject({ state: 'DONE', claim: null, integrated_sha: cliDone.integrated_sha, attempts: cliDone.attempts, criteria: cliDone.criteria, tdd_history: cliDone.tdd_history, last_settlement: cliDone.last_settlement, evidence: cliDone.evidence });
    expect(state.nodes[CLI].fresh_branch_required).toBeUndefined();
    expect(state.nodes[COMPAT]).toMatchObject({ state: 'INVALIDATED' });
    expect(state.acceptance_review.challenges.at(-1)).toMatchObject({ challenge_id: `${VER_FEATURE}-R002-C1`, status: 'pending', restored: [CLI] });
    // What comes next: the refinement — but the verification consumer runs first, in the same dispatch.
    expect(await status(s)).toMatchObject({ next_action: { kind: 'review-refine', resumable: true } });
    const d3 = await dispatch(s);
    expect((d3.controller_reports ?? []).map((x) => [x.node_id, x.outcome])).toEqual([[COMPAT, 'DONE']]);
    const rr = d3.ticket as unknown as ReviewTicket & { refinement: Record<string, any> };
    expect(rr).toMatchObject({ kind: 'acceptance-review', review_id: `${VER_FEATURE}-R002`, refinement: { round: 1 } });

    // 6. R002's refinement withdraws AC-1: PASS, bound to the epoch, nothing outstanding, every judged node DONE.
    await writeVerdict(rr, refinementFor(reviewPacket(rr), { 'AC-1': { decision: 'WITHDRAW' } }), { cwd: s.control });
    const pass = await settleReview(s, rr);
    expect(pass).toMatchObject({ outcome: 'PASS', refinement: { decisions: [{ criterion: 'AC-1', decision: 'WITHDRAW' }] } });
    commitVerControl(s, 'R002 PASS');
    state = verState(s);
    const passed = state.acceptance_review.reviews.find((r: { review_id: string }) => r.review_id === `${VER_FEATURE}-R002`);
    expect(passed).toMatchObject({ outcome: 'PASS', epoch: state.orchestration.epoch, barrier: { epoch: state.orchestration.epoch, leases: [], nodes_done: true } });
    for (const id of [ARP, CLI, COMPAT]) expect(state.nodes[id].state, id).toBe('DONE');
    expect(state.orchestration.leases.filter((l: { status: string }) => l.status === 'active')).toEqual([]);
    expect((await status(s))['acceptance_review']).toMatchObject({ passed: true });

    // 7. The obsolete cli dispatch answers again after the PASS: stale; state, PASS and usage unchanged.
    writeLateBlocked(c1);
    const afterPass = untouched(s);
    const obsolete = await settle(s, c1);
    expect(obsolete).toMatchObject({ outcome: 'STALE_ORCHESTRATION_EPOCH', state: 'DONE' });
    // The settled generation's own capability, after its node's lineage moved: stale too, never its old receipt replayed as fresh.
    writeLateBlocked(c2);
    const settledLate = await settle(s, c2);
    expect(settledLate).toMatchObject({ outcome: 'STALE_ORCHESTRATION_EPOCH', state: 'DONE' });
    expect(untouched(s)).toBe(afterPass);
    expect((await status(s))['acceptance_review']).toMatchObject({ passed: true });

    // 8. The candidate, the delivery, and the hidden-like checks.
    const built = await dispatch(s);
    expect(built.status, built.detail).toBe('ALL_SETTLED');
    expect((built.controller_reports ?? []).map((x) => [x.node_id, x.outcome])).toEqual([[VER_CANDIDATE, 'DONE']]);
    commitVerControl(s, 'settled');
    expect(JSON.parse((await verCli(s, ['deliver', VER_FEATURE, '--json'])).out)).toMatchObject({ status: 'ACCEPTED', candidate_id: `${VER_FEATURE}-C001` });
    commitVerControl(s, 'delivered');
    expect(JSON.parse((await verCli(s, ['feature', 'verify', VER_FEATURE, '--delivered', '--json'])).out)).toEqual({ ok: true, problems: [] });
    state = verState(s);
    expect(state.acceptance_review.reviews.map((x: { review_id: string; outcome: string }) => [x.review_id, x.outcome])).toEqual([[`${VER_FEATURE}-R001`, 'GAPS'], [`${VER_FEATURE}-R002`, 'PASS']]);
    expect(state.acceptance_review.challenges.map((x: { challenge_id: string; status: string }) => [x.challenge_id, x.status])).toEqual([[`${VER_FEATURE}-R001-C1`, 'withdrawn'], [`${VER_FEATURE}-R002-C1`, 'withdrawn']]);
    // R001, its refinement, R002, its refinement: four reviewer sessions, each once.
    expect(state.acceptance_review.usage.sessions).toBe(4);
    const delivered = git(s.repo, ['rev-parse', 'main']);
    const changelog = acceptance(s.repo, delivered, VER_CHANGELOG_ACCEPTANCE);
    expect(changelog.code, changelog.out).toBe(0);
    const r3 = acceptance(s.repo, delivered, VER_R3_ACCEPTANCE);
    expect(r3.code, r3.out).toBe(0);
  });

  it('side by side: the cli rework is live when the AC-1 challenge settles; no refinement or review until it settles (await-worker); then the compatibility node, the refinement, R002 PASS, C001', async () => {
    const s = await r7Reviewed({ graph: siblingGraph() });
    const a = (await dispatch(s)).ticket!;
    expect(a.node_id).toBe(ARP);
    const c = (await dispatch(s)).ticket!;
    expect(c.node_id).toBe(CLI);
    writeChallenge(a, s.control);
    expect(await settle(s, a)).toMatchObject({ outcome: 'REVIEW_CHALLENGED', state: 'DONE' });
    commitVerControl(s, 'R001 AC-1 challenged, the cli live');
    // The cli's lease is live and current: the challenge left it alone, and nothing reviews past it.
    let state = verState(s);
    expect(state.nodes[CLI]).toMatchObject({ claim: { claim_id: c.claim_id, dispatch_id: c.dispatch_id } });
    expect(state.orchestration.leases.filter((l: { status: string }) => l.status === 'active').map((l: { node_id: string }) => l.node_id)).toEqual([CLI]);
    const waiting = await dispatch(s);
    expect(waiting.status, waiting.detail).toBe('WAITING');
    expect(waiting.ticket).toBeUndefined();
    expect(await status(s)).toMatchObject({ resumable: true, next_action: { kind: 'await-worker', nodes: [expect.objectContaining({ node_id: CLI })] } });
    // A candidate is refused outright while the lease is live.
    const cut = await verCli(s, ['candidate', 'create', VER_FEATURE, '--json']);
    expect(cut.code).not.toBe(0);
    expect(cut.err).toMatch(/NODES_NOT_DONE|REVIEW_BARRIER/);
    // The cli settles with its current lease: valid.
    compatRework(c, s.control);
    expect(await settle(s, c)).toMatchObject({ outcome: 'DONE' });
    commitVerControl(s, 'cli settled');
    // Only then the compatibility node, and the refinement.
    const d = await dispatch(s);
    expect((d.controller_reports ?? []).map((x) => [x.node_id, x.outcome])).toEqual([[COMPAT, 'DONE']]);
    const r = d.ticket as unknown as ReviewTicket & { refinement: Record<string, any> };
    expect(r).toMatchObject({ review_id: `${VER_FEATURE}-R001`, refinement: { round: 1 } });
    await writeVerdict(r, refinementFor(reviewPacket(r), { 'AC-1': { decision: 'WITHDRAW' } }), { cwd: s.control });
    expect(await settleReview(s, r)).toMatchObject({ outcome: 'GAPS' });
    commitVerControl(s, 'R001 refined');
    // R002 on the heads both reworks left: PASS.
    const d2 = await dispatch(s);
    const r2 = d2.ticket as unknown as ReviewTicket;
    expect(r2).toMatchObject({ kind: 'acceptance-review', review_id: `${VER_FEATURE}-R002` });
    expect((r2 as unknown as { refinement?: unknown }).refinement ?? null).toBeNull();
    await writeVerdict(r2, verdictFor(reviewPacket(r2)), { cwd: s.control });
    expect(await settleReview(s, r2)).toMatchObject({ outcome: 'PASS' });
    commitVerControl(s, 'R002 PASS');
    // The cli's settled lease, presented again after the PASS: stale, nothing moves.
    writeLateBlocked(c);
    expect(await settle(s, c)).toMatchObject({ outcome: 'STALE_ORCHESTRATION_EPOCH' });
    const built = await dispatch(s);
    expect(built.status, built.detail).toBe('ALL_SETTLED');
    commitVerControl(s, 'settled');
    expect(JSON.parse((await verCli(s, ['deliver', VER_FEATURE, '--json'])).out)).toMatchObject({ status: 'ACCEPTED' });
    state = verState(s);
    expect(state.orchestration.leases.filter((l: { status: string }) => l.status === 'active')).toEqual([]);
    const delivered = git(s.repo, ['rev-parse', 'main']);
    expect(acceptance(s.repo, delivered, VER_CHANGELOG_ACCEPTANCE).code).toBe(0);
    expect(acceptance(s.repo, delivered, VER_R3_ACCEPTANCE).code).toBe(0);
  });
});
