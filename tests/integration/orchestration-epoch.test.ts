/**
 * Orchestration epoch fencing and the dispatch lease registry.
 *
 * CSET-203 r7 settled a review PASS while a node it judged was reopened, and
 * a worker dispatched past it settled into the reviewed state. Every claim
 * and review generation is a lease: issued in the claim's own STATE.json
 * write, bound to the orchestration epoch and the node's lineage, carried on
 * the ticket, and closed in the write that ends it. A settle checks the
 * lease first: a revoked, abandoned or obsolete generation, a result whose
 * epoch is not its claim's, or a settled lease presented after the epoch
 * moved, is STALE_ORCHESTRATION_EPOCH — its result archived, nothing
 * changed, nothing charged, never the node BLOCKED, the same answer again.
 * A live lease keeps the reviewer out (`await-worker`); a review whose epoch
 * moved while it was out is never recorded; a PASS binds the epoch it was
 * settled at, and stops binding when it moves.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { ARP, CLI, COMPAT, VER_FEATURE, commitVerControl, createVer, verCli, verState, type Ver } from '../helpers/version-fixture.js';
import { fulfil, type ShopTicket } from '../helpers/shop-worker.js';
import { refinementFor, reviewPacket, verdictFor, writeVerdict, type ReviewTicket } from '../helpers/review-agent.js';
import { ARP_CRITERIA, CLI_CRITERIA, GAP_AC5, dispatch, reviewed, settle, status, type Dispatched } from '../helpers/cset203-rework.js';
import { GAP_AC1_HOLDS, writeChallenge } from '../helpers/cset203-challenge.js';
import { compatRework, settleReview, writeLateBlocked } from '../helpers/cset203-r7.js';
import { ARP_FIXED_IMPL, ARP_RED, ARP_SRC, ARP_TESTS, CLI_FULL_WORK } from '../helpers/version-fixture.js';
import { mutateState } from '../../src/state/feature-state.js';
import { Orchestrator, type SettleFaultPoint } from '../../src/engine/orchestrator.js';
import type { SessionAdapter } from '../../src/sessions/adapter.js';

afterAll(() => cleanupTmpRoots());

const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

function runs(s: Ver): number {
  const file = join(s.featureDir, 'RUNS.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0;
}

/** What a stale answer must leave untouched. */
function snapshot(s: Ver): string {
  const st = verState(s);
  return JSON.stringify({
    nodes: Object.fromEntries(Object.entries(st.nodes as Record<string, any>).map(([id, rt]) => [id, [rt.state, rt.attempts, rt.claim?.claim_id ?? null, rt.claim?.dispatch_id ?? null, rt.integrated_sha, rt.failure_counts, rt.last_failure_fingerprint, rt.evidence, rt.usage]])),
    usage: st.usage,
    epoch: st.orchestration?.epoch ?? null,
    reviews: (st.acceptance_review?.reviews ?? []).length,
    runs: runs(s),
  });
}

function leases(s: Ver): Record<string, any>[] {
  return verState(s).orchestration.leases as Record<string, any>[];
}

/** R001 reworked the cli for AC-5 alone (compatibility only): the cli is the one node to dispatch. */
async function cliReworked(): Promise<Ver> {
  return reviewed({ 'AC-5': GAP_AC5 });
}

/** Both producers DONE and R001 out with its reviewer, not settled. */
async function reviewOut(): Promise<{ s: Ver; r: ReviewTicket }> {
  const s = await createVer({ review: {} });
  const a = (await dispatch(s)).ticket!;
  fulfil(a, { tests: { [ARP_TESTS]: ARP_RED }, impl: { [ARP_SRC]: ARP_FIXED_IMPL }, criteria: ARP_CRITERIA }, s.control);
  expect(await settle(s, a)).toMatchObject({ outcome: 'DONE' });
  const c = (await dispatch(s)).ticket!;
  fulfil(c, { ...CLI_FULL_WORK, criteria: CLI_CRITERIA }, s.control);
  expect(await settle(s, c)).toMatchObject({ outcome: 'DONE' });
  commitVerControl(s, 'both producers');
  const r = (await dispatch(s)).ticket as unknown as ReviewTicket;
  expect(r).toMatchObject({ kind: 'acceptance-review', review_id: `${VER_FEATURE}-R001` });
  commitVerControl(s, 'R001 out');
  return { s, r };
}

describe('a dispatch is a lease', () => {
  it('the claim, its ticket and the registry agree; await-worker while it is live, reconcile once its result is in; the settle closes it at the epoch it moved to', async () => {
    const s = await cliReworked();
    const before = verState(s).orchestration.epoch as number;
    const t = (await dispatch(s)).ticket! as ShopTicket & { orchestration: { epoch: number; lineage: number; generation: number } };
    expect(t.node_id).toBe(CLI);
    let state = verState(s);
    const lineage = state.nodes[CLI].lineage as number;
    expect(lineage).toBeGreaterThan(0);
    expect(t.orchestration).toEqual({ epoch: before, lineage, generation: 1 });
    expect(state.nodes[CLI].claim).toMatchObject({ epoch: before, lineage, generation: 1 });
    expect(leases(s).filter((l) => l['status'] === 'active')).toEqual([expect.objectContaining({ lease_id: t.dispatch_id, kind: 'worker', node_id: CLI, claim_id: t.claim_id, dispatch_id: t.dispatch_id, epoch: before, lineage, generation: 1 })]);
    expect(t.prompt).toContain(`orchestration_epoch ${before}`);
    // A live worker: the controller waits for it; nothing is reviewed or cut past it.
    expect(await status(s)).toMatchObject({ resumable: true, next_action: { kind: 'await-worker', nodes: [expect.objectContaining({ node_id: CLI })] } });
    // Its result is in the slot: the controller has something to settle.
    compatRework(t, s.control, { orchestration_epoch: before });
    expect(await status(s)).toMatchObject({ resumable: true, next_action: { kind: 'reconcile' } });
    expect(await settle(s, t)).toMatchObject({ outcome: 'DONE' });
    state = verState(s);
    expect(state.orchestration.epoch).toBeGreaterThan(before);
    expect(leases(s).find((l) => l['lease_id'] === t.dispatch_id)).toMatchObject({ status: 'settled', outcome: 'DONE', settled_epoch: state.orchestration.epoch });
    expect(leases(s).filter((l) => l['status'] === 'active')).toEqual([]);
    // The same settle again, straight after: its receipt, as before.
    expect(await settle(s, t)).toMatchObject({ outcome: 'DONE', idempotent: true });
  });

  it("a generation revoked by a resume answers late: STALE_ORCHESTRATION_EPOCH, its result archived, nothing charged or counted; the same answer twice; the replacement settles", async () => {
    const s = await cliReworked();
    const t1 = (await dispatch(s)).ticket!;
    const t2 = (JSON.parse((await verCli(s, ['dispatch', VER_FEATURE, '--resume', CLI, '--json'])).out) as Dispatched).ticket!;
    expect(leases(s).find((l) => l['lease_id'] === t1.dispatch_id)).toMatchObject({ status: 'revoked' });
    expect(leases(s).filter((l) => l['status'] === 'active').map((l) => l['lease_id'])).toEqual([t2.dispatch_id]);
    const late = writeLateBlocked(t1);
    const before = snapshot(s);
    const r = (await settle(s, t1)) as Record<string, any>;
    expect(r, r['detail']).toMatchObject({ outcome: 'STALE_ORCHESTRATION_EPOCH', idempotent: false, stale: { lease_id: t1.dispatch_id, status: 'revoked' } });
    expect(snapshot(s)).toBe(before);
    expect(existsSync(t1.result_slot)).toBe(false);
    expect(readFileSync(join(s.control, r['stale']['archived']['path']), 'utf8')).toBe(JSON.stringify(late, null, 2));
    expect(sha256(readFileSync(join(s.control, r['stale']['archived']['path'])))).toBe(r['stale']['archived']['sha256']);
    const again = (await settle(s, t1)) as Record<string, any>;
    expect(again).toMatchObject({ outcome: 'STALE_ORCHESTRATION_EPOCH', idempotent: true, stale: { archived: { path: r['stale']['archived']['path'] } } });
    expect(snapshot(s)).toBe(before);
    expect(leases(s).find((l) => l['lease_id'] === t1.dispatch_id)).toMatchObject({ status: 'stale' });
    compatRework(t2, s.control);
    expect(await settle(s, t2)).toMatchObject({ outcome: 'DONE' });
  });

  it("a late answer behind a result directory replaced by a link is never followed: stale, nothing archived, nothing outside touched", async (ctx) => {
    const s = await cliReworked();
    const t1 = (await dispatch(s)).ticket!;
    (JSON.parse((await verCli(s, ['dispatch', VER_FEATURE, '--resume', CLI, '--json'])).out) as Dispatched).ticket!;
    const outside = join(s.root, 'outside');
    mkdirSync(outside, { recursive: true });
    const victim = join(outside, basename(t1.result_slot));
    writeFileSync(victim, '{"keep":"me"}');
    const dir = dirname(t1.result_slot);
    rmSync(dir, { recursive: true, force: true });
    try {
      symlinkSync(outside, dir, 'junction');
    } catch {
      return ctx.skip();
    }
    const before = snapshot(s);
    const r = (await settle(s, t1)) as Record<string, any>;
    expect(r).toMatchObject({ outcome: 'STALE_ORCHESTRATION_EPOCH', stale: { archived: null } });
    expect(readFileSync(victim, 'utf8')).toBe('{"keep":"me"}');
    expect(snapshot(s)).toBe(before);
  });

  it("a result whose orchestration_epoch is not its claim's is refused STALE_ORCHESTRATION_EPOCH, uncharged; the claim stays live and the honest result settles", async () => {
    const s = await cliReworked();
    const t = (await dispatch(s)).ticket! as ShopTicket & { orchestration: { epoch: number } };
    compatRework(t, s.control, { orchestration_epoch: t.orchestration.epoch + 7 });
    const before = snapshot(s);
    const r = (await settle(s, t)) as Record<string, any>;
    expect(r, r['detail']).toMatchObject({ outcome: 'STALE_ORCHESTRATION_EPOCH' });
    expect(r['detail']).toMatch(/orchestration_epoch/);
    expect(snapshot(s)).toBe(before);
    expect(verState(s).nodes[CLI].claim).toMatchObject({ claim_id: t.claim_id, dispatch_id: t.dispatch_id });
    expect(leases(s).find((l) => l['lease_id'] === t.dispatch_id)).toMatchObject({ status: 'active' });
    // The honest result, the same claim: settled.
    const honest = JSON.parse(readFileSync(join(s.control, r['stale']['archived']['path']), 'utf8')) as Record<string, unknown>;
    writeFileSync(t.result_slot, JSON.stringify({ ...honest, orchestration_epoch: t.orchestration.epoch }, null, 2));
    expect(await settle(s, t)).toMatchObject({ outcome: 'DONE' });
  });

  it('a lease whose claim expired is reconciled abandoned; next_action dispatch; its late answer is stale, never the node BLOCKED', async () => {
    const s = await cliReworked();
    const t = (await dispatch(s)).ticket!;
    mutateState(s.featureDir, (st) => {
      st.nodes[CLI]!.claim!.expires_at = new Date(Date.now() - 1000).toISOString();
      return st;
    });
    const rec = JSON.parse((await verCli(s, ['session', 'reconcile', VER_FEATURE, '--json'])).out) as { abandoned_dispatches: string[] };
    expect(rec.abandoned_dispatches).toEqual([CLI]);
    expect(leases(s).find((l) => l['lease_id'] === t.dispatch_id)).toMatchObject({ status: 'abandoned' });
    expect(await status(s)).toMatchObject({ next_action: { kind: 'dispatch' } });
    writeLateBlocked(t);
    const before = snapshot(s);
    expect(await settle(s, t)).toMatchObject({ outcome: 'STALE_ORCHESTRATION_EPOCH' });
    expect(snapshot(s)).toBe(before);
    expect(verState(s).nodes[CLI].state).not.toBe('BLOCKED');
  });

  it('a crash right after the claim write leaves the claim and its lease together; reconcile keeps it pending, resume re-issues it under a new lease', async () => {
    const s = await cliReworked();
    const crashing = new Orchestrator({ controlRoot: s.control, featureId: VER_FEATURE, adapter: {} as SessionAdapter, owner: 'mycelink', settleFault: (p: SettleFaultPoint) => { if (p === 'lease-issued') throw new Error(`CRASH at ${p}`); } });
    await expect(crashing.dispatchNext()).rejects.toThrow(/CRASH at lease-issued/);
    let state = verState(s);
    const claim = state.nodes[CLI].claim;
    expect(claim).toMatchObject({ mode: 'host', worktree: null });
    expect(leases(s).filter((l) => l['status'] === 'active')).toEqual([expect.objectContaining({ node_id: CLI, claim_id: claim.claim_id, dispatch_id: claim.dispatch_id })]);
    const rec = JSON.parse((await verCli(s, ['session', 'reconcile', VER_FEATURE, '--json'])).out) as { pending_dispatches: { node_id: string }[] };
    expect(rec.pending_dispatches.map((d) => d.node_id)).toEqual([CLI]);
    const resumed = (JSON.parse((await verCli(s, ['dispatch', VER_FEATURE, '--resume', CLI, '--json'])).out) as Dispatched).ticket!;
    state = verState(s);
    expect(leases(s).filter((l) => l['status'] === 'active').map((l) => l['lease_id'])).toEqual([resumed.dispatch_id]);
    expect(leases(s).find((l) => l['lease_id'] === claim.dispatch_id)).toMatchObject({ status: 'revoked' });
    compatRework(resumed, s.control);
    expect(await settle(s, resumed)).toMatchObject({ outcome: 'DONE' });
  });
});

describe('the review and the epoch', () => {
  it('a rework while a review is out moves the epoch: its verdict is STALE_ORCHESTRATION_EPOCH when settled, never recorded; no node is claimed by hand while it is out; dispatch drops it and goes on', async () => {
    const { s, r } = await reviewOut();
    const before = verState(s).orchestration.epoch as number;
    expect(verState(s).acceptance_review.open).toMatchObject({ review_id: r.review_id, epoch: before });
    expect(leases(s).filter((l) => l['status'] === 'active')).toEqual([expect.objectContaining({ kind: 'review', review_id: r.review_id, dispatch_id: r.dispatch_id })]);
    // QA reworks the cli meanwhile (no claim is live: allowed), which moves the epoch.
    expect((await verCli(s, ['node', 'rework', VER_FEATURE, CLI, '--reason', 'QA: status lists a journal left in .changeset', '--json'])).code).toBe(0);
    expect(verState(s).orchestration.epoch).toBeGreaterThan(before);
    // No product node is claimed by hand while the review is out.
    const claimed = await verCli(s, ['node', 'claim', VER_FEATURE, CLI, '--json']);
    expect(claimed.code).not.toBe(0);
    expect(claimed.err).toMatch(/REVIEW_OPEN/);
    // The reviewer's verdict comes back: it reviewed what no longer is.
    await writeVerdict(r, verdictFor(reviewPacket(r)), { cwd: s.control });
    const settled = await settleReview(s, r);
    expect(settled).toMatchObject({ outcome: 'STALE_ORCHESTRATION_EPOCH', code: 'STALE_ORCHESTRATION_EPOCH' });
    let state = verState(s);
    expect(state.acceptance_review.reviews).toEqual([]);
    expect(state.acceptance_review.open).toBeNull();
    expect(leases(s).find((l) => l['lease_id'] === r.dispatch_id)).toMatchObject({ status: 'stale' });
    // The reviewer session ran: counted once, however often it is settled.
    expect(state.acceptance_review.usage.sessions).toBe(1);
    expect(await settleReview(s, r)).toMatchObject({ outcome: 'STALE_ORCHESTRATION_EPOCH', idempotent: true });
    expect(verState(s).acceptance_review.usage.sessions).toBe(1);
    // Dispatch goes on with the reworked cli.
    const next = await dispatch(s);
    expect(next.ticket?.node_id).toBe(CLI);
    state = verState(s);
    expect(state.acceptance_review.open).toBeNull();
  });

  it('a PASS binds the epoch it was settled at: once the epoch moves it binds nothing, and review status, feature verify and candidate create say so', async () => {
    const { s, r } = await reviewOut();
    await writeVerdict(r, verdictFor(reviewPacket(r)), { cwd: s.control });
    expect(await settleReview(s, r)).toMatchObject({ outcome: 'PASS' });
    commitVerControl(s, 'R001 PASS');
    let state = verState(s);
    const pass = state.acceptance_review.reviews[0];
    expect(pass).toMatchObject({ outcome: 'PASS', epoch: state.orchestration.epoch, barrier: { epoch: state.orchestration.epoch, leases: [], nodes_done: true } });
    expect((await status(s))['acceptance_review']).toMatchObject({ passed: true });
    // QA reworks apply-release-plan: the heads have not moved yet, but the PASS no longer binds anything.
    expect((await verCli(s, ['node', 'rework', VER_FEATURE, ARP, '--reason', 'QA: a changelog half written is left as it was', '--json'])).code).toBe(0);
    state = verState(s);
    expect(state.orchestration.epoch).toBeGreaterThan(pass.epoch);
    expect((await status(s))['acceptance_review']).toMatchObject({ passed: false });
    const review = JSON.parse((await verCli(s, ['review', 'status', VER_FEATURE, '--json'])).out) as { problems: string[] };
    expect(review.problems.join('\n')).toMatch(/REVIEW_STALE: .*epoch/);
    const cut = await verCli(s, ['candidate', 'create', VER_FEATURE, '--json']);
    expect(cut.code).not.toBe(0);
  });

  it('a challenge, or its refinement, interrupted on either side of its write moves the epoch exactly once', async () => {
    const crashAt = (s: Ver, point: SettleFaultPoint): Orchestrator =>
      new Orchestrator({ controlRoot: s.control, featureId: VER_FEATURE, adapter: {} as SessionAdapter, owner: 'mycelink', settleFault: (p: SettleFaultPoint) => { if (p === point) throw new Error(`CRASH at ${p}`); } });
    for (const point of ['challenge-archived', 'challenge-recorded'] as const) {
      const s = await reviewed({ 'AC-1': GAP_AC1_HOLDS });
      const t = (await dispatch(s)).ticket!;
      expect(t.node_id).toBe(ARP);
      writeChallenge(t, s.control);
      const before = verState(s).orchestration.epoch as number;
      expect(() => crashAt(s, point).settle(ARP, t.capability)).toThrow(new RegExp(`CRASH at ${point}`));
      expect(verState(s).orchestration.epoch).toBe(point === 'challenge-archived' ? before : before + 1);
      commitVerControl(s, `crashed at ${point}`);
      if (point === 'challenge-archived') {
        const d = await dispatch(s);
        // Finished once; the compatibility node its rework reopened runs again before the refinement is handed out.
        expect((d.controller_reports ?? []).map((x) => [x.node_id, x.outcome])).toEqual([[ARP, 'REVIEW_CHALLENGED'], [COMPAT, 'DONE']]);
        expect((d.ticket as unknown as { refinement: unknown }).refinement).toBeDefined();
      } else {
        expect(await settle(s, t)).toMatchObject({ outcome: 'REVIEW_CHALLENGED', idempotent: true });
      }
      expect(verState(s).orchestration.epoch).toBe(before + 1);
      if (point !== 'challenge-recorded') continue;
      // The refinement, interrupted after its receipt and before its write: recorded once, by the retried settle.
      const r = (await dispatch(s)).ticket as unknown as ReviewTicket;
      await writeVerdict(r, refinementFor(reviewPacket(r), { 'AC-1': { decision: 'WITHDRAW' } }), { cwd: s.control });
      const issued = verState(s).orchestration.epoch as number;
      expect(issued).toBe(before + 1);
      expect(() => crashAt(s, 'review-receipt-written').settleReview(r.review_id, r.capability)).toThrow(/CRASH at review-receipt-written/);
      expect(verState(s).orchestration.epoch).toBe(issued);
      expect(await settleReview(s, r)).toMatchObject({ outcome: 'PASS' });
      expect(verState(s).orchestration.epoch).toBe(issued + 1);
      expect(await settleReview(s, r)).toMatchObject({ outcome: 'PASS', idempotent: true });
      expect(verState(s).orchestration.epoch).toBe(issued + 1);
    }
  }, 300_000);
});
