/**
 * CSET-203 r11 with-normal, model-free, to the delivery it should have
 * reached (every platform).
 *
 * r11 ran continuously and trusted; provider recovery was not the issue.
 * R001: AC-1 on apply-release-plan challenged and withdrawn, the cli
 * reworked for AC-5. R002: another AC-1 reproduction challenged and
 * withdrawn, the cli reworked for AC-3. R003 found materially new, concrete
 * AC-1 and AC-3 gaps — the boundaries hidden acceptance checks — and the
 * global `max_rounds: 2` blocked it REVIEW_GAPS before any rework: every
 * product and verification node DONE, no candidate. The withdrawn hypotheses
 * and the other criteria had spent the one count. Here:
 *
 *  1. R001 as r11's: AC-1 (holds) challenged and withdrawn, AC-5 reworked on
 *     the cli (compatibility only);
 *  2. R002 as r11's: another AC-1 reproduction (holds) challenged and
 *     withdrawn; AC-3 (an empty journal) reworked on the cli, RED and fix;
 *  3. R003's materially new AC-1 (a changelog write failing part-way) and
 *     AC-3 (a journal cut short mid-JSON) are NOT blocked: AC-1 has spent
 *     nothing (two withdrawals), AC-3 one of two; the cli's third review
 *     rework is not refused REWORK_LIMIT; the packet R003 was given carries
 *     every prior finding and its fate;
 *  4. both producers' focused REDs fail on the code as it is; the fixes
 *     settle DONE;
 *  5. R004 PASS, C001 delivered and accepted; the hidden-like AC-1, AC-3,
 *     AC-4 and AC-5 checks pass on the delivery, which they did not on R003's
 *     heads.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { git } from '../helpers/git-fixture.js';
import { ARP, ARP_TESTS, CLI, CLI_TRUNCATED_TEST, COMPAT, VER_CANDIDATE, VER_CHANGELOG_ACCEPTANCE, VER_FEATURE, VER_R3_ACCEPTANCE, commitVerControl, verCli, verState } from '../helpers/version-fixture.js';
import { packOf } from '../helpers/shop-worker.js';
import { refinementFor, reviewPacket, verdictFor, writeVerdict, type ReviewTicket } from '../helpers/review-agent.js';
import { dispatch, repairArp, reviewed, settle, status } from '../helpers/cset203-rework.js';
import { AC1_HOLDS_REPRODUCTION, GAP_AC1_HOLDS, writeChallenge } from '../helpers/cset203-challenge.js';
import { AC1_R002_REPRODUCTION, ARP_R002_RED, ARP_R002_TEST, GAP_AC1_R002, compatRework, r002Clauses, settleReview } from '../helpers/cset203-r7.js';
import { GAP_AC5 } from '../helpers/cset203-rework.js';
import { AC1_PARTIAL_REPRODUCTION, AC3_EMPTY_REPRODUCTION, CLI_EMPTY_IMPL, CLI_EMPTY_RED, CLI_EMPTY_TEST, CLI_TRUNCATED_R11_IMPL, CLI_TRUNCATED_R11_RED, GAP_AC1_PARTIAL, GAP_AC3_EMPTY, GAP_AC3_TRUNCATED, VER_AC4_ACCEPTANCE, cliRedRework } from '../helpers/cset203-r11.js';

afterAll(() => cleanupTmpRoots());

function acceptance(repo: string, sha: string, script: string): { code: number; out: string } {
  const at = join(makeTmpDir('cset203-r11-hidden-like-'), 'checkout');
  git(repo, ['worktree', 'add', '--detach', at, sha]);
  try {
    const file = join(makeTmpDir('cset203-r11-script-'), 'acceptance.mjs');
    writeFileSync(file, script);
    const r = spawnSync(process.execPath, [file, at], { encoding: 'utf8' });
    return { code: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
  } finally {
    git(repo, ['worktree', 'remove', '--force', at]);
  }
}

describe('CSET-203 r11, replayed model-free to the delivery it should have reached', () => {
  it('two withdrawn AC-1 hypotheses and the cli reworks for AC-5 and AC-3 spend nothing R003 needs: its new AC-1 and AC-3 gaps are reworked, R004 passes, C001 is delivered and the hidden-like checks pass', async () => {
    // 1. R001 as r11's: AC-1 (a reproduction the code satisfies) and AC-5 on the cli.
    const s = await reviewed({ 'AC-1': GAP_AC1_HOLDS, 'AC-5': GAP_AC5 });
    let state = verState(s);
    expect(state.acceptance_review).toMatchObject({ max_rounds: 2 });
    const a1 = (await dispatch(s)).ticket!;
    expect(a1.node_id).toBe(ARP);
    writeChallenge(a1, s.control);
    expect(await settle(s, a1)).toMatchObject({ outcome: 'REVIEW_CHALLENGED', state: 'DONE' });
    commitVerControl(s, 'R001 AC-1 challenged');
    const rr1 = (await dispatch(s)).ticket as unknown as ReviewTicket;
    expect(rr1).toMatchObject({ review_id: `${VER_FEATURE}-R001`, refinement: { round: 1 } });
    await writeVerdict(rr1, refinementFor(reviewPacket(rr1), { 'AC-1': { decision: 'WITHDRAW' } }), { cwd: s.control });
    expect(await settleReview(s, rr1)).toMatchObject({ outcome: 'GAPS', refinement: { decisions: [{ criterion: 'AC-1', decision: 'WITHDRAW' }] } });
    commitVerControl(s, 'R001 refined');
    const c1 = (await dispatch(s)).ticket!;
    expect(c1.node_id).toBe(CLI);
    compatRework(c1, s.control);
    expect(await settle(s, c1)).toMatchObject({ outcome: 'DONE' });
    commitVerControl(s, 'cli: AC-5');

    // 2. R002 as r11's: another AC-1 reproduction the code satisfies, and AC-3 on the cli (an empty journal).
    const d2 = await dispatch(s);
    expect((d2.controller_reports ?? []).map((x) => [x.node_id, x.outcome])).toEqual([[COMPAT, 'DONE']]);
    const r2 = d2.ticket as unknown as ReviewTicket;
    expect(r2).toMatchObject({ kind: 'acceptance-review', review_id: `${VER_FEATURE}-R002` });
    await writeVerdict(r2, verdictFor(reviewPacket(r2), { 'AC-1': GAP_AC1_R002, 'AC-3': GAP_AC3_EMPTY }), { cwd: s.control });
    expect(await settleReview(s, r2)).toMatchObject({ outcome: 'GAPS' });
    commitVerControl(s, 'R002');
    const a2 = (await dispatch(s)).ticket!;
    expect(a2.node_id).toBe(ARP);
    writeChallenge(a2, s.control, { tests: { [ARP_TESTS]: ARP_R002_RED }, test: ARP_R002_TEST, clauses: r002Clauses });
    expect(await settle(s, a2)).toMatchObject({ outcome: 'REVIEW_CHALLENGED', state: 'DONE' });
    commitVerControl(s, 'R002 AC-1 challenged');
    const rr2 = (await dispatch(s)).ticket as unknown as ReviewTicket;
    expect(rr2).toMatchObject({ review_id: `${VER_FEATURE}-R002`, refinement: { round: 1 } });
    await writeVerdict(rr2, refinementFor(reviewPacket(rr2), { 'AC-1': { decision: 'WITHDRAW' } }), { cwd: s.control });
    expect(await settleReview(s, rr2)).toMatchObject({ outcome: 'GAPS' });
    commitVerControl(s, 'R002 refined');
    const c2 = (await dispatch(s)).ticket!;
    cliRedRework(c2, s.control, { tests: CLI_EMPTY_RED, impl: CLI_EMPTY_IMPL, test: CLI_EMPTY_TEST });
    const c2done = await settle(s, c2);
    expect(c2done, c2done.detail).toMatchObject({ outcome: 'DONE' });
    commitVerControl(s, 'cli: AC-3 empty journal');

    // 3. R003: materially new AC-1 and AC-3 gaps. Its packet carries every prior finding, its fate and the budgets.
    const d3 = await dispatch(s);
    expect((d3.controller_reports ?? []).map((x) => [x.node_id, x.outcome])).toEqual([[COMPAT, 'DONE']]);
    const r3 = d3.ticket as unknown as ReviewTicket;
    expect(r3).toMatchObject({ kind: 'acceptance-review', review_id: `${VER_FEATURE}-R003` });
    const packet3 = reviewPacket(r3) as ReturnType<typeof reviewPacket> & { review_memory: Record<string, any> };
    expect(packet3.review_memory.budgets).toMatchObject({
      'AC-1': { accepted_reworks: 0, max: 2, remaining: 2, withdrawals: 2 },
      'AC-3': { accepted_reworks: 1, max: 2, remaining: 1 },
      'AC-5': { accepted_reworks: 1, max: 2, remaining: 1 },
    });
    const findings = packet3.review_memory.findings as { review_id: string; criterion: string; reproduction: string; status: string; challenge: { challenge_id: string; tests: unknown[] } | null }[];
    expect(findings.map((f) => [f.review_id, f.criterion, f.status])).toEqual([
      [`${VER_FEATURE}-R001`, 'AC-1', 'withdrawn'],
      [`${VER_FEATURE}-R001`, 'AC-5', 'accepted'],
      [`${VER_FEATURE}-R002`, 'AC-1', 'withdrawn'],
      [`${VER_FEATURE}-R002`, 'AC-3', 'accepted'],
    ]);
    expect(findings[0]).toMatchObject({ reproduction: AC1_HOLDS_REPRODUCTION, challenge: { challenge_id: `${VER_FEATURE}-R001-C1` } });
    expect(findings[0]!.challenge!.tests.length).toBeGreaterThan(0);
    expect(findings[2]).toMatchObject({ reproduction: AC1_R002_REPRODUCTION });
    expect(findings[3]).toMatchObject({ reproduction: AC3_EMPTY_REPRODUCTION });
    expect(r3.prompt).toMatch(/never report again/i);
    expect(r3.prompt).toMatch(/AC-1 0\/2/);
    // The gaps are real on R003's heads.
    const reviewedHead = git(s.repo, ['rev-parse', `refs/heads/feature/${VER_FEATURE}`]);
    expect(acceptance(s.repo, reviewedHead, VER_CHANGELOG_ACCEPTANCE).code).not.toBe(0);
    expect(acceptance(s.repo, reviewedHead, VER_R3_ACCEPTANCE).code).not.toBe(0);
    await writeVerdict(r3, verdictFor(packet3, { 'AC-1': GAP_AC1_PARTIAL, 'AC-3': GAP_AC3_TRUNCATED }), { cwd: s.control });
    const settled3 = await settleReview(s, r3);
    expect(settled3, settled3.detail).toMatchObject({ outcome: 'GAPS', blocked: false });
    expect([...settled3.reworked].sort()).toEqual([ARP, CLI].sort());
    commitVerControl(s, 'R003 reworked');
    state = verState(s);
    expect(state.feature_state).not.toBe('BLOCKED');
    expect(state.acceptance_review.blocked).toBeNull();
    // The cli's third review rework: AC-3's second; never REWORK_LIMIT (review reworks are bounded by their criterion).
    expect(state.nodes[CLI].rework_brief).toMatchObject({ acceptance_criteria: ['AC-3'], origin: { review_id: `${VER_FEATURE}-R003` } });
    expect(state.nodes[ARP].rework_brief).toMatchObject({ acceptance_criteria: ['AC-1'] });
    const st = await status(s);
    expect(st['acceptance_review']['criteria']).toMatchObject({
      'AC-1': { accepted_reworks: 1, remaining: 1, withdrawals: 2 },
      'AC-3': { accepted_reworks: 2, remaining: 0 },
      'AC-5': { accepted_reworks: 1, remaining: 1 },
    });
    // Past its budget, never a cap (CSET-201 final): a materially new AC-3 gap is reworked on verified producer progress.
    expect(st['acceptance_review']['criteria']['AC-3']['next_action']).toMatch(/past its budget of 2, a materially new gap of AC-3 is reworked on verified producer progress/);
    const receipt3 = JSON.parse((await verCli(s, ['review', 'status', VER_FEATURE, '--json'])).out) as Record<string, any>;
    expect(receipt3['lineage']).toMatchObject({ head_sha256: state.acceptance_review.lineage.head_sha256 });

    // 4. The focused REDs fail on the code as it is; the fixes settle.
    await repairArp(s);
    const c3 = (await dispatch(s)).ticket!;
    expect(c3.node_id).toBe(CLI);
    expect(packOf(c3)['rework']).toMatchObject({ acceptance_criteria: ['AC-3'] });
    cliRedRework(c3, s.control, { tests: CLI_TRUNCATED_R11_RED, impl: CLI_TRUNCATED_R11_IMPL, test: CLI_TRUNCATED_TEST });
    const c3done = await settle(s, c3);
    expect(c3done, c3done.detail).toMatchObject({ outcome: 'DONE' });
    commitVerControl(s, 'cli: AC-3 truncated journal');

    // 5. R004 PASS, the candidate, the delivery, the hidden-like checks.
    const d4 = await dispatch(s);
    expect((d4.controller_reports ?? []).map((x) => [x.node_id, x.outcome])).toEqual([[COMPAT, 'DONE']]);
    const r4 = d4.ticket as unknown as ReviewTicket;
    expect(r4).toMatchObject({ kind: 'acceptance-review', review_id: `${VER_FEATURE}-R004` });
    await writeVerdict(r4, verdictFor(reviewPacket(r4)), { cwd: s.control });
    expect(await settleReview(s, r4)).toMatchObject({ outcome: 'PASS' });
    commitVerControl(s, 'R004 PASS');
    const built = await dispatch(s);
    expect(built.status, built.detail).toBe('ALL_SETTLED');
    expect((built.controller_reports ?? []).map((x) => [x.node_id, x.outcome])).toEqual([[VER_CANDIDATE, 'DONE']]);
    commitVerControl(s, 'settled');
    expect(JSON.parse((await verCli(s, ['deliver', VER_FEATURE, '--json'])).out)).toMatchObject({ status: 'ACCEPTED', candidate_id: `${VER_FEATURE}-C001` });
    commitVerControl(s, 'delivered');
    state = verState(s);
    expect(state.acceptance_review.reviews.map((r: { review_id: string; outcome: string }) => [r.review_id, r.outcome])).toEqual([
      [`${VER_FEATURE}-R001`, 'GAPS'],
      [`${VER_FEATURE}-R002`, 'GAPS'],
      [`${VER_FEATURE}-R003`, 'GAPS'],
      [`${VER_FEATURE}-R004`, 'PASS'],
    ]);
    const closures = state.acceptance_review.lineage.events.filter((e: { kind: string }) => e.kind === 'closure').map((e: { criterion: string }) => e.criterion);
    expect(closures.sort()).toEqual(['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5']);
    const delivered = git(s.repo, ['rev-parse', 'main']);
    for (const script of [VER_CHANGELOG_ACCEPTANCE, VER_R3_ACCEPTANCE, VER_AC4_ACCEPTANCE]) {
      const r = acceptance(s.repo, delivered, script);
      expect(r.code, r.out).toBe(0);
    }
    expect(AC1_PARTIAL_REPRODUCTION).not.toBe(AC1_HOLDS_REPRODUCTION);
  }, 300_000);
});
