/**
 * CSET-203 r14 with-normal, model-free, to the delivery it should have
 * reached (every platform).
 *
 * r14: the reviewer lifecycle held (every reviewer completed and was
 * ingested). R002 found AC-1 on apply-release-plan and AC-3 on the cli; its
 * atomic rework ordered both producers from R002's original receipt. The
 * apply-release-plan worker challenged AC-1 and the refinement withdrew it:
 * R002's receipt moved from the original to R002.refined-1.json and
 * apply-release-plan was DONE again. The cli's rework of AC-3 — a gap the
 * refinement left untouched — went on bound to the original receipt; its
 * worker's exact AC-3 reproduction passed, and its challenge was refused
 * twice, REVIEW_CHALLENGE_STALE ("not the receipt this rework was ordered
 * with"): both attempts and a failure count spent on an administrative
 * mismatch, the cli BLOCKED, no candidate. Here:
 *
 *  1. R001: AC-1 reworked on apply-release-plan (the changelog boundary),
 *     AC-5 on the cli (compatibility only);
 *  2. R002 as r14's: AC-1 (a reproduction the repaired code satisfies) and
 *     AC-3 on the cli (one the cli's code satisfies), both producers ordered
 *     from R002's revision 0;
 *  3. the AC-1 challenge; the refinement withdraws AC-1: revision 1 of R002
 *     (linked to revision 0) and, in the same write, the cli's order rebased
 *     to it — same generation, attempts and reason, a carry proof that
 *     AC-3's reproduction, fingerprint and producer are unchanged;
 *  4. the cli's ticket carries revision 1: its exact AC-3 reproduction
 *     passes, its challenge is valid — no stale refusal, no attempt or
 *     failure count spent;
 *  5. the compatibility node, then the refinement of AC-3: REFINE, a
 *     reproduction the cli fails (a journal cut short by a kill): revision 2,
 *     the cli reordered from the generation its challenge restored;
 *  6. the cli's focused RED fails, its fix settles; R003 PASS; C001
 *     delivered and accepted; the hidden-like AC-1, AC-3 and AC-5 checks pass;
 *     every attempt is product work.
 *
 * The second test: R002's AC-3 a real gap — the rebased ticket's RED fails
 * and proceeds as any rework, to delivery.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { git } from '../helpers/git-fixture.js';
import { ARP, ARP_REVIEW_RED, ARP_TESTS, CLI, CLI_TESTS, CLI_TRUNCATED_IMPL, CLI_TRUNCATED_RED, CLI_TRUNCATED_TEST, COMPAT, VER_CANDIDATE, VER_CHANGELOG_ACCEPTANCE, VER_FEATURE, VER_R3_ACCEPTANCE, commitVerControl, verCli, verState, type Ver } from '../helpers/version-fixture.js';
import { refinementFor, reviewPacket, verdictFor, writeVerdict, type ReviewTicket } from '../helpers/review-agent.js';
import { GAP_AC1, GAP_AC3, GAP_AC5, dispatch, repairArp, reviewed, settle, status } from '../helpers/cset203-rework.js';
import { reworkOf, writeChallenge } from '../helpers/cset203-challenge.js';
import { ARP_R002_BODY, ARP_R002_TEST, GAP_AC1_R002, compatRework, r002Clauses, settleReview } from '../helpers/cset203-r7.js';
import { AC3_TRUNCATED_REPRODUCTION, cliRedRework } from '../helpers/cset203-r11.js';
import { AC3_HOLDS_REPRODUCTION, CLI_AC3_HOLDS_RED, CLI_AC3_HOLDS_TEST, GAP_AC3_HOLDS, cliAc3Clauses, events, receiptAt } from '../helpers/cset203-r14.js';

afterAll(() => cleanupTmpRoots());

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const R002 = `${VER_FEATURE}-R002`;
const REV0 = `features/${VER_FEATURE}/reviews/${R002}.json`;
const REV1 = `features/${VER_FEATURE}/reviews/${R002}.refined-1.json`;
const REV2 = `features/${VER_FEATURE}/reviews/${R002}.refined-2.json`;

function acceptance(repo: string, sha: string, script: string): { code: number; out: string } {
  const at = join(makeTmpDir('cset203-r14-hidden-like-'), 'checkout');
  git(repo, ['worktree', 'add', '--detach', at, sha]);
  try {
    const file = join(makeTmpDir('cset203-r14-script-'), 'acceptance.mjs');
    writeFileSync(file, script);
    const r = spawnSync(process.execPath, [file, at], { encoding: 'utf8' });
    return { code: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
  } finally {
    git(repo, ['worktree', 'remove', '--force', at]);
  }
}

/** No refusal of a challenge anywhere, and no node carrying a challenge refusal's fingerprint: nothing administrative was charged. */
function nothingStale(s: Ver): void {
  expect(events(s).filter((e) => e.type === 'review.challenge_refused').map((e) => [e.node_id, e.data['code']])).toEqual([]);
  for (const [id, rt] of Object.entries(verState(s).nodes as Record<string, any>)) {
    expect(Object.keys(rt.failure_counts).filter((k) => k.startsWith('REVIEW_CHALLENGE')), id).toEqual([]);
  }
}

/** R001 (AC-1 on apply-release-plan, AC-5 on the cli) reworked and settled; R002 handed out with `ac3` as its AC-3 gap and AC-1 one the repaired code satisfies, settled GAPS. */
async function untilR002(ac3: typeof GAP_AC3): Promise<Ver> {
  const s = await reviewed({ 'AC-1': GAP_AC1, 'AC-5': GAP_AC5 });
  await repairArp(s);
  const c1 = (await dispatch(s)).ticket!;
  expect(c1.node_id).toBe(CLI);
  compatRework(c1, s.control);
  expect(await settle(s, c1)).toMatchObject({ outcome: 'DONE' });
  commitVerControl(s, 'cli: AC-5');
  const d2 = await dispatch(s);
  expect((d2.controller_reports ?? []).map((x) => [x.node_id, x.outcome])).toEqual([[COMPAT, 'DONE']]);
  const r2 = d2.ticket as unknown as ReviewTicket;
  expect(r2).toMatchObject({ kind: 'acceptance-review', review_id: R002 });
  await writeVerdict(r2, verdictFor(reviewPacket(r2), { 'AC-1': GAP_AC1_R002, 'AC-3': ac3 }), { cwd: s.control });
  const gaps2 = await settleReview(s, r2);
  expect(gaps2, gaps2.detail).toMatchObject({ outcome: 'GAPS' });
  expect([...gaps2.reworked].sort()).toEqual([ARP, CLI].sort());
  commitVerControl(s, 'R002');
  return s;
}

/** The AC-1 challenge of R002 and its refinement, WITHDRAW: R002's revision 1. Returns the refinement's settle report. */
async function withdrawAc1(s: Ver): Promise<Record<string, any>> {
  const a = (await dispatch(s)).ticket!;
  expect(a.node_id).toBe(ARP);
  // apply-release-plan's test file holds R001's repair (its changelog test): the challenge adds the focused test beside it.
  writeChallenge(a, s.control, { tests: { [ARP_TESTS]: `${ARP_REVIEW_RED}${ARP_R002_BODY}` }, test: ARP_R002_TEST, clauses: r002Clauses });
  expect(await settle(s, a)).toMatchObject({ outcome: 'REVIEW_CHALLENGED', state: 'DONE' });
  commitVerControl(s, 'R002 AC-1 challenged');
  const rr = (await dispatch(s)).ticket as unknown as ReviewTicket;
  expect(rr).toMatchObject({ review_id: R002, refinement: { round: 1 } });
  await writeVerdict(rr, refinementFor(reviewPacket(rr), { 'AC-1': { decision: 'WITHDRAW' } }), { cwd: s.control });
  const settled = await settleReview(s, rr);
  commitVerControl(s, 'R002 refined: AC-1 withdrawn');
  return settled;
}

/** The cli's order rebased to R002's revision 1 in the refinement's write: what r14's cli never had. */
function expectRebasedToRevision1(s: Ver, before: Record<string, any>): void {
  const state = verState(s);
  const rec = state.acceptance_review.reviews.find((r: { review_id: string }) => r.review_id === R002);
  expect(rec).toMatchObject({ revision: 1, receipt_path: REV1, original: { receipt_path: REV0 } });
  expect(rec.refinements[0]).toMatchObject({ revision: 1, orders: expect.arrayContaining([{ node_id: CLI, action: 'rebase' }]) });
  const receipt = receiptAt(s, REV1);
  expect(receipt).toMatchObject({ revision: 1, parent: { revision: 0, receipt_path: REV0, receipt_sha256: rec.original.receipt_sha256 } });
  expect(receipt['gap_dispositions']).toEqual([
    expect.objectContaining({ criterion: 'AC-1', disposition: 'withdrawn', challenge_id: `${R002}-C1` }),
    expect.objectContaining({ criterion: 'AC-3', disposition: 'retained', reproduction_sha256: before['review_gaps'][0].reproduction_sha256 }),
  ]);
  expect((receipt['orders'] as Record<string, any>[]).find((o) => o['node_id'] === CLI)).toMatchObject({
    action: 'rebase',
    criteria_before: ['AC-3'],
    criteria_after: ['AC-3'],
    carry: [{ criterion: 'AC-3', reproduction_sha256: before['review_gaps'][0].reproduction_sha256, fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/), from_targets: [CLI], to_targets: [CLI] }],
  });
  const brief = state.nodes[CLI].rework_brief;
  // Same generation, attempt base, reason and gaps: only the revision it is bound to moved, with its receipt.
  expect(brief).toMatchObject({ generation: before['generation'], attempt_base: before['attempt_base'], reason_sha256: before['reason_sha256'], acceptance_criteria: ['AC-3'], review_gaps: before['review_gaps'] });
  expect(brief.origin).toMatchObject({ kind: 'acceptance-review', review_id: R002, revision: 1, receipt_path: REV1, receipt_sha256: rec.receipt_sha256 });
  expect(brief.evidence).toEqual([REV1]);
  expect(brief.rebases).toEqual([
    expect.objectContaining({ review_id: R002, from: { revision: 0, receipt_path: REV0, receipt_sha256: rec.original.receipt_sha256 }, to: { revision: 1, receipt_path: REV1, receipt_sha256: rec.receipt_sha256 }, criteria: ['AC-3'], by: 'refinement', claim: null, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }),
  ]);
  expect(state.nodes[CLI].rework_history.at(-1).rebases).toEqual(brief.rebases);
}

describe('CSET-203 r14, replayed model-free to the delivery it should have reached', () => {
  it("the refinement that withdraws AC-1 rebases the cli's AC-3 order to revision 1 in its own write; the cli's passing AC-3 reproduction is a valid challenge, refined, reworked; R003 passes; C001 delivered; no stale refusal, every attempt product work", async () => {
    const s = await untilR002(GAP_AC3_HOLDS);
    let state = verState(s);
    // Both producers ordered from R002's revision 0.
    const rec0 = state.acceptance_review.reviews.find((r: { review_id: string }) => r.review_id === R002);
    expect(rec0).toMatchObject({ revision: 0, receipt_path: REV0 });
    expect(state.nodes[CLI].rework_brief).toMatchObject({ acceptance_criteria: ['AC-3'], evidence: [REV0], origin: { review_id: R002, revision: 0, receipt_path: REV0, receipt_sha256: rec0.receipt_sha256 }, review_gaps: [{ criterion: 'AC-3', reproduction_sha256: sha256(AC3_HOLDS_REPRODUCTION) }] });
    expect(state.nodes[ARP].rework_brief).toMatchObject({ acceptance_criteria: ['AC-1'], origin: { review_id: R002, revision: 0 } });
    const cliBefore = structuredClone(state.nodes[CLI].rework_brief) as Record<string, any>;
    const cliAttempts = state.nodes[CLI].attempts as number;

    // 3. The AC-1 challenge, withdrawn: revision 1, and the cli's order rebased to it in the same write.
    expect(await withdrawAc1(s)).toMatchObject({ outcome: 'GAPS', refinement: { decisions: [{ criterion: 'AC-1', decision: 'WITHDRAW' }] } });
    expectRebasedToRevision1(s, cliBefore);
    state = verState(s);
    expect(state.nodes[CLI]).toMatchObject({ state: 'INVALIDATED', attempts: cliAttempts, claim: null });
    expect(state.nodes[ARP]).toMatchObject({ state: 'DONE' });
    expect(events(s).filter((e) => e.type === 'review.order_rebased').map((e) => [e.node_id, e.data['to']?.revision])).toEqual([[CLI, 1]]);

    // 4. The cli's ticket: revision 1. Its exact AC-3 reproduction passes; the challenge is valid.
    const c2 = (await dispatch(s)).ticket!;
    expect(c2.node_id).toBe(CLI);
    expect(reworkOf(c2)).toMatchObject({ evidence: [REV1], origin: { review_id: R002, revision: 1 }, review_gaps: [{ criterion: 'AC-3', reproduction_sha256: sha256(AC3_HOLDS_REPRODUCTION) }] });
    writeChallenge(c2, s.control, { tests: { [CLI_TESTS]: CLI_AC3_HOLDS_RED }, test: CLI_AC3_HOLDS_TEST, clauses: cliAc3Clauses });
    const challenged = await settle(s, c2);
    expect(challenged, challenged.detail).toMatchObject({ outcome: 'REVIEW_CHALLENGED', state: 'DONE' });
    commitVerControl(s, 'R002 AC-3 challenged');
    nothingStale(s);
    state = verState(s);
    const rev1Sha = state.acceptance_review.reviews.find((r: { review_id: string }) => r.review_id === R002).receipt_sha256;
    const c2rec = state.acceptance_review.challenges.find((c: { challenge_id: string }) => c.challenge_id === `${R002}-C2`);
    expect(c2rec).toMatchObject({ node_id: CLI, status: 'pending', gaps: [{ criterion: 'AC-3', round: 1, reproduction_sha256: sha256(AC3_HOLDS_REPRODUCTION) }] });
    expect(receiptAt(s, c2rec.receipt_path)).toMatchObject({ review_receipt: { path: REV1, sha256: rev1Sha } });
    // The challenge charged nothing: the cli is DONE on the generation R002's rework replaced, its attempts as they were.
    expect(state.nodes[CLI]).toMatchObject({ state: 'DONE', attempts: cliAttempts, claim: null });

    // 5. The compatibility node runs again; AC-3's refinement: REFINE, a reproduction the cli fails.
    const d5 = await dispatch(s);
    expect((d5.controller_reports ?? []).map((x) => [x.node_id, x.outcome])).toEqual([[COMPAT, 'DONE']]);
    const rr2 = d5.ticket as unknown as ReviewTicket;
    expect(rr2).toMatchObject({ review_id: R002, refinement: { round: 1 } });
    // A reproduction materially different from the one challenged (another state: the journal itself cut short by the kill).
    const truncated = AC3_TRUNCATED_REPRODUCTION;
    await writeVerdict(rr2, refinementFor(reviewPacket(rr2), { 'AC-3': { decision: 'REFINE', gap: { missing: 'a journal a kill cut short while it was written makes version throw', reproduction: truncated }, producer: { node_id: CLI } } }), { cwd: s.control });
    const refined2 = await settleReview(s, rr2);
    expect(refined2, refined2.detail).toMatchObject({ outcome: 'GAPS', reworked: [CLI], refinement: { decisions: [{ criterion: 'AC-3', decision: 'REFINE' }] } });
    commitVerControl(s, 'R002 refined: AC-3 refined');
    state = verState(s);
    const rec2 = state.acceptance_review.reviews.find((r: { review_id: string }) => r.review_id === R002);
    expect(rec2).toMatchObject({ revision: 2, receipt_path: REV2 });
    expect(receiptAt(s, REV2)).toMatchObject({
      revision: 2,
      parent: { revision: 1, receipt_path: REV1, receipt_sha256: rev1Sha },
      gap_dispositions: [expect.objectContaining({ criterion: 'AC-3', disposition: 'refined', challenge_id: `${R002}-C2`, reproduction_sha256: sha256(AC3_HOLDS_REPRODUCTION), to_reproduction_sha256: sha256(truncated) })],
      orders: [expect.objectContaining({ node_id: CLI, action: 'reorder', criteria_before: ['AC-3'], criteria_after: ['AC-3'] })],
    });
    expect(state.nodes[CLI].rework_brief).toMatchObject({
      acceptance_criteria: ['AC-3'],
      evidence: [REV2],
      origin: { review_id: R002, revision: 2, receipt_path: REV2, receipt_sha256: rec2.receipt_sha256, refinement: { challenge_id: `${R002}-C2`, round: 1 } },
      review_gaps: [{ criterion: 'AC-3', reproduction_sha256: sha256(truncated) }],
    });
    expect(state.nodes[CLI].attempts).toBe(cliAttempts);

    // 6. The cli's focused RED fails on its code; the fix settles.
    const c3 = (await dispatch(s)).ticket!;
    expect(c3.node_id).toBe(CLI);
    expect(reworkOf(c3)).toMatchObject({ origin: { review_id: R002, revision: 2 } });
    cliRedRework(c3, s.control, { tests: CLI_TRUNCATED_RED, impl: CLI_TRUNCATED_IMPL, test: CLI_TRUNCATED_TEST });
    const done = await settle(s, c3);
    expect(done, done.detail).toMatchObject({ outcome: 'DONE' });
    commitVerControl(s, 'cli: AC-3 truncated journal');

    // R003 PASS, the candidate, the delivery.
    const d6 = await dispatch(s);
    expect((d6.controller_reports ?? []).map((x) => [x.node_id, x.outcome])).toEqual([[COMPAT, 'DONE']]);
    const r3 = d6.ticket as unknown as ReviewTicket;
    expect(r3).toMatchObject({ kind: 'acceptance-review', review_id: `${VER_FEATURE}-R003` });
    await writeVerdict(r3, verdictFor(reviewPacket(r3)), { cwd: s.control });
    expect(await settleReview(s, r3)).toMatchObject({ outcome: 'PASS' });
    commitVerControl(s, 'R003 PASS');
    const built = await dispatch(s);
    expect(built.status, built.detail).toBe('ALL_SETTLED');
    expect((built.controller_reports ?? []).map((x) => [x.node_id, x.outcome])).toEqual([[VER_CANDIDATE, 'DONE']]);
    commitVerControl(s, 'settled');
    expect(JSON.parse((await verCli(s, ['deliver', VER_FEATURE, '--json'])).out)).toMatchObject({ status: 'ACCEPTED', candidate_id: `${VER_FEATURE}-C001` });
    commitVerControl(s, 'delivered');
    expect(JSON.parse((await verCli(s, ['feature', 'verify', VER_FEATURE, '--delivered', '--json'])).out)).toEqual({ ok: true, problems: [] });

    state = verState(s);
    expect(state.acceptance_review.reviews.map((r: { review_id: string; outcome: string; revision: number }) => [r.review_id, r.outcome, r.revision])).toEqual([
      [`${VER_FEATURE}-R001`, 'GAPS', 0],
      [R002, 'GAPS', 2],
      [`${VER_FEATURE}-R003`, 'PASS', 0],
    ]);
    expect(state.acceptance_review.challenges.map((c: { challenge_id: string; status: string; node_id: string }) => [c.challenge_id, c.node_id, c.status])).toEqual([
      [`${R002}-C1`, ARP, 'withdrawn'],
      [`${R002}-C2`, CLI, 'refined'],
    ]);
    // Every attempt is product work: the cli's first work, its AC-5 rework, its AC-3 rework; apply-release-plan's first work and its AC-1 repair. The challenges spent none.
    expect(state.nodes[CLI].attempts).toBe(3);
    expect(state.nodes[ARP].attempts).toBe(2);
    nothingStale(s);
    // R001, R002, its two refinements, R003: five reviewer sessions, each once.
    expect(state.acceptance_review.usage.sessions).toBe(5);
    // The revision lineage, as feature status reports it.
    const st = await status(s);
    expect(st['acceptance_review']['revisions'].find((r: { review_id: string }) => r.review_id === R002)).toMatchObject({
      review_id: R002,
      revision: 2,
      receipts: [
        { revision: 0, receipt_path: REV0, parent_sha256: null },
        { revision: 1, receipt_path: REV1, parent_sha256: state.acceptance_review.reviews[1].original.receipt_sha256 },
        { revision: 2, receipt_path: REV2, parent_sha256: rev1Sha },
      ],
    });
    const delivered = git(s.repo, ['rev-parse', 'main']);
    for (const script of [VER_CHANGELOG_ACCEPTANCE, VER_R3_ACCEPTANCE]) {
      const r = acceptance(s.repo, delivered, script);
      expect(r.code, r.out).toBe(0);
    }
  }, 300_000);

  it("R002's AC-3 a real gap: the cli's order rebased to revision 1, its focused RED fails and proceeds as any rework; R003 passes; C001 delivered", async () => {
    const s = await untilR002(GAP_AC3);
    const cliBefore = structuredClone(verState(s).nodes[CLI].rework_brief) as Record<string, any>;
    const cliAttempts = verState(s).nodes[CLI].attempts as number;
    expect(await withdrawAc1(s)).toMatchObject({ outcome: 'GAPS' });
    expectRebasedToRevision1(s, cliBefore);
    const c2 = (await dispatch(s)).ticket!;
    expect(c2.node_id).toBe(CLI);
    expect(reworkOf(c2)).toMatchObject({ evidence: [REV1], origin: { review_id: R002, revision: 1 } });
    cliRedRework(c2, s.control, { tests: CLI_TRUNCATED_RED, impl: CLI_TRUNCATED_IMPL, test: CLI_TRUNCATED_TEST });
    const done = await settle(s, c2);
    expect(done, done.detail).toMatchObject({ outcome: 'DONE' });
    commitVerControl(s, 'cli: AC-3');
    expect(verState(s).nodes[CLI].attempts).toBe(cliAttempts + 1);
    const d = await dispatch(s);
    expect((d.controller_reports ?? []).map((x) => [x.node_id, x.outcome])).toEqual([[COMPAT, 'DONE']]);
    const r3 = d.ticket as unknown as ReviewTicket;
    expect(r3).toMatchObject({ kind: 'acceptance-review', review_id: `${VER_FEATURE}-R003` });
    await writeVerdict(r3, verdictFor(reviewPacket(r3)), { cwd: s.control });
    expect(await settleReview(s, r3)).toMatchObject({ outcome: 'PASS' });
    commitVerControl(s, 'R003 PASS');
    const built = await dispatch(s);
    expect(built.status, built.detail).toBe('ALL_SETTLED');
    commitVerControl(s, 'settled');
    expect(JSON.parse((await verCli(s, ['deliver', VER_FEATURE, '--json'])).out)).toMatchObject({ status: 'ACCEPTED' });
    commitVerControl(s, 'delivered');
    nothingStale(s);
    const state = verState(s);
    expect(state.nodes[CLI].attempts).toBe(3);
    expect(state.nodes[ARP].attempts).toBe(2);
    const delivered = git(s.repo, ['rev-parse', 'main']);
    for (const script of [VER_CHANGELOG_ACCEPTANCE, VER_R3_ACCEPTANCE]) {
      const r = acceptance(s.repo, delivered, script);
      expect(r.code, r.out).toBe(0);
    }
  }, 300_000);
});
