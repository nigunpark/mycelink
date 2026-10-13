/**
 * CSET-203 r6 with-normal, model-free, to the delivery it should have
 * reached (every platform).
 *
 * r6: R001 found AC-1 (apply-release-plan), AC-3 and AC-5 (the cli), and
 * both producers were reworked in one settle. apply-release-plan's rework
 * worker wrote R001's exact AC-1 reproduction as focused tests; they passed
 * on the unchanged integrated head ("the RED does not fail"), the worker
 * answered BLOCKED REVIEW_GAP_NOT_REPRODUCED:AC-1, the node was parked and
 * the cli and compatibility nodes stayed INVALIDATED: no candidate. Here,
 * through the shipped launcher's fence and the tickets' own lines:
 *
 *  1. R001 as r6's: AC-1's reproduction is one the code already satisfies
 *     (a file the run created is removed by the rollback); the hidden-like
 *     changelog check still fails on the reviewed head;
 *  2. the apply-release-plan worker writes that exact reproduction, the red
 *     gate passes it, and the worker challenges the gap (REVIEW_GAP_CHALLENGE)
 *     instead of parking the node: no attempt charged, the node DONE on its
 *     prior generation, R001 CHALLENGED, its evidence archived;
 *  3. the controller exits there; `feature status` says `review-refine`,
 *     resumable; a fresh controller dispatches the refinement to a fresh
 *     reviewer, which REFINEs AC-1 to the boundary hidden acceptance checks
 *     (a changelog write failing part-way after the package version write,
 *     exact-byte rollback), materially different from the challenged one;
 *  4. the refined rework, from the original attempt base: its focused RED
 *     fails on the code as it is, the fix settles DONE;
 *  5. the cli's own rework (AC-3's RED cycle, AC-5's compatibility unit);
 *     the compatibility node; R002 PASS; C001 delivered and accepted; the
 *     hidden-like AC-1, AC-3 and AC-5 checks pass on the delivery.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { git } from '../helpers/git-fixture.js';
import {
  ARP,
  ARP_CHANGELOG_TEST,
  CLI,
  CLI_COMPAT_FILE,
  CLI_COMPAT_TESTS,
  CLI_COMPAT_TEST_ID,
  CLI_SRC,
  CLI_TESTS,
  CLI_TRUNCATED_IMPL,
  CLI_TRUNCATED_RED,
  CLI_TRUNCATED_TEST,
  COMPAT,
  VER_CANDIDATE,
  VER_CHANGELOG_ACCEPTANCE,
  VER_FEATURE,
  VER_R3_ACCEPTANCE,
  commitVerControl,
  verCli,
  verState,
} from '../helpers/version-fixture.js';
import { commit, packOf, runGate, writeFiles } from '../helpers/shop-worker.js';
import { refinementFor, reviewPacket, verdictFor, writeVerdict, type ReviewTicket } from '../helpers/review-agent.js';
import { carriedItems, commitCompat, dispatch, repairArp, settle, status, tddClaim, writeResult } from '../helpers/cset203-rework.js';
import { AC1_HOLDS_REPRODUCTION, AC1_REFINED, ARP_CHALLENGE_TEST, checkLine, r6Reviewed, writeChallenge } from '../helpers/cset203-challenge.js';

afterAll(() => cleanupTmpRoots());

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

function acceptance(repo: string, sha: string, script: string): { code: number; out: string } {
  const at = join(makeTmpDir('cset203-r6-hidden-like-'), 'checkout');
  git(repo, ['worktree', 'add', '--detach', at, sha]);
  try {
    const file = join(makeTmpDir('cset203-r6-script-'), 'acceptance.mjs');
    writeFileSync(file, script);
    const r = spawnSync(process.execPath, [file, at], { encoding: 'utf8' });
    return { code: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
  } finally {
    git(repo, ['worktree', 'remove', '--force', at]);
  }
}

describe('CSET-203 r6, replayed model-free to the delivery it should have reached', () => {
  it('R001 as r6; the passing AC-1 reproduction challenged; a fresh controller and reviewer refine it to the hidden-like boundary; RED, fix, the cli rework, R002 PASS, C001 delivered, the hidden-like checks pass', async () => {
    // 1. R001 as r6's.
    const s = await r6Reviewed();
    const reviewedHead = git(s.repo, ['rev-parse', `refs/heads/feature/${VER_FEATURE}`]);
    expect(acceptance(s.repo, reviewedHead, VER_CHANGELOG_ACCEPTANCE).code).not.toBe(0);
    let state = verState(s);
    expect(state.nodes[ARP].rework_brief.reason).toContain(AC1_HOLDS_REPRODUCTION);

    // 2. The worker's exact focused test passes on the unchanged head: a challenge, not a BLOCKED node.
    const t = (await dispatch(s)).ticket!;
    expect(t.node_id).toBe(ARP);
    const w = writeChallenge(t, s.control);
    expect(w.red.code).not.toBe(0);
    expect(w.red.tests.find((x) => x.full_name === ARP_CHALLENGE_TEST)).toMatchObject({ status: 'passed' });
    expect(w.skeleton['challenge']).toMatchObject({ review_id: `${VER_FEATURE}-R001`, reason_sha256: packOf(t)['rework']['reason_sha256'], gate_output_sha256: w.red.sha256, gaps: [{ criterion: 'AC-1', reproduction_sha256: sha256(AC1_HOLDS_REPRODUCTION) }] });
    expect(checkLine(t, s.control).out).toMatchObject({ ok: true });
    const challenged = await settle(s, t);
    expect(challenged, challenged.detail).toMatchObject({ outcome: 'REVIEW_CHALLENGED', state: 'DONE' });
    commitVerControl(s, 'R001 AC-1 challenged');
    state = verState(s);
    expect(state.nodes[ARP]).toMatchObject({ state: 'DONE', attempts: 1 });
    expect(state.acceptance_review.reviews[0].outcome).toBe('CHALLENGED');

    // 3. The controller exits; the next one is told what comes next, reconciles and dispatches the refinement.
    expect(await status(s)).toMatchObject({ resumable: true, next_action: { kind: 'review-refine', resumable: true } });
    expect((await verCli(s, ['session', 'reconcile', VER_FEATURE, '--json'])).code).toBe(0);
    const r = (await dispatch(s)).ticket as unknown as ReviewTicket & { refinement: Record<string, any> };
    expect(r).toMatchObject({ kind: 'acceptance-review', review_id: `${VER_FEATURE}-R001`, refinement: { round: 1 } });
    await writeVerdict(r, refinementFor(reviewPacket(r), { 'AC-1': { decision: 'REFINE', gap: AC1_REFINED, producer: { module: 'changesets:packages/apply-release-plan/src/index.mjs' } } }), { cwd: s.control });
    const refined = JSON.parse((await verCli(s, ['review', 'settle', VER_FEATURE, '--review', r.review_id, '--capability', r.capability, '--json'])).out);
    expect(refined).toMatchObject({ outcome: 'GAPS', refinement: { decisions: [{ criterion: 'AC-1', decision: 'REFINE' }] } });
    commitVerControl(s, 'R001 AC-1 refined');
    state = verState(s);
    expect(state.nodes[ARP].rework_brief).toMatchObject({ generation: 1, attempt_base: 1, review_gaps: [{ criterion: 'AC-1', reproduction_sha256: sha256(AC1_REFINED.reproduction) }] });

    // 4. The refined rework: its focused RED (a changelog write failing part-way) fails on the code as it is; the fix.
    await repairArp(s);
    state = verState(s);
    expect(state.nodes[ARP]).toMatchObject({ state: 'DONE' });
    expect(state.nodes[ARP].criteria.find((c: { criterion: string }) => c.criterion === 'AC-1')).toMatchObject({ gate: 'red', test: { name: ARP_CHANGELOG_TEST } });

    // 5. The cli's own rework: AC-3's RED cycle, AC-5's compatibility unit alone after the code.
    const c = (await dispatch(s)).ticket!;
    expect(c.node_id).toBe(CLI);
    writeFiles(c.worktree, { [CLI_TESTS]: CLI_TRUNCATED_RED });
    const red = runGate(c, 'red', s.control);
    expect(red.code, red.out).toBe(0);
    commit(c.worktree, [CLI_TESTS], 'test(cli): AC-3 a journal cut short by a kill is recovered from');
    writeFiles(c.worktree, { [CLI_SRC]: CLI_TRUNCATED_IMPL });
    expect(runGate(c, 'green', s.control).code).toBe(0);
    commit(c.worktree, [CLI_SRC], 'fix(cli): a journal cut short by a kill changed nothing yet; remove it');
    writeFiles(c.worktree, { [CLI_COMPAT_TESTS]: CLI_COMPAT_FILE });
    commitCompat(c.worktree, [CLI_COMPAT_TESTS], 'AC-5');
    const green = runGate(c, 'green', s.control);
    expect(green.code, green.out).toBe(0);
    expect(runGate(c, 'regression', s.control).code).toBe(0);
    writeResult(c, [
      { criterion: 'AC-3', test_id: red.tests.find((x) => x.full_name === CLI_TRUNCATED_TEST)!.id, gate: 'red', output_sha256: red.sha256 },
      ...carriedItems(c),
      { criterion: 'AC-5', test_id: CLI_COMPAT_TEST_ID, gate: 'green', output_sha256: green.sha256 },
    ], tddClaim(c, [{ red: [0], green: [1] }]));
    expect(await settle(s, c)).toMatchObject({ outcome: 'DONE' });
    commitVerControl(s, 'cli repaired');

    // The compatibility node, R002 on the repaired heads, the candidate, the delivery.
    const d2 = (await dispatch(s)) as unknown as { controller_reports: { node_id: string; outcome: string }[]; ticket: ReviewTicket };
    expect(d2.controller_reports.map((x) => [x.node_id, x.outcome])).toEqual([[COMPAT, 'DONE']]);
    expect(d2.ticket).toMatchObject({ kind: 'acceptance-review', review_id: `${VER_FEATURE}-R002` });
    expect((d2.ticket as unknown as { refinement?: unknown }).refinement ?? null).toBeNull();
    await writeVerdict(d2.ticket, verdictFor(reviewPacket(d2.ticket)), { cwd: s.control });
    expect(JSON.parse((await verCli(s, ['review', 'settle', VER_FEATURE, '--review', d2.ticket.review_id, '--capability', d2.ticket.capability, '--json'])).out)).toMatchObject({ outcome: 'PASS' });
    commitVerControl(s, 'review R002: PASS');
    const built = await dispatch(s);
    expect(built.status, built.detail).toBe('ALL_SETTLED');
    expect((built.controller_reports ?? []).map((x) => [x.node_id, x.outcome])).toEqual([[VER_CANDIDATE, 'DONE']]);
    commitVerControl(s, 'settled');
    expect(JSON.parse((await verCli(s, ['deliver', VER_FEATURE, '--json'])).out)).toMatchObject({ status: 'ACCEPTED', candidate_id: `${VER_FEATURE}-C001` });
    commitVerControl(s, 'delivered');
    expect(JSON.parse((await verCli(s, ['feature', 'verify', VER_FEATURE, '--delivered', '--json'])).out)).toEqual({ ok: true, problems: [] });
    state = verState(s);
    expect(state.acceptance_review).toMatchObject({ blocked: null, usage: { sessions: 3 } });
    expect(state.acceptance_review.reviews.map((x: { review_id: string; outcome: string }) => [x.review_id, x.outcome])).toEqual([[`${VER_FEATURE}-R001`, 'GAPS'], [`${VER_FEATURE}-R002`, 'PASS']]);
    expect(state.acceptance_review.challenges.map((x: { challenge_id: string; status: string }) => [x.challenge_id, x.status])).toEqual([[`${VER_FEATURE}-R001-C1`, 'refined']]);
    // The challenge's tests were never integrated: the delivered tests are the refined RED's and the cli's.
    const delivered = git(s.repo, ['rev-parse', 'main']);
    expect(git(s.repo, ['show', `${delivered}:packages/apply-release-plan/test/apply.test.mjs`])).not.toContain(ARP_CHALLENGE_TEST);
    const changelog = acceptance(s.repo, delivered, VER_CHANGELOG_ACCEPTANCE);
    expect(changelog.code, changelog.out).toBe(0);
    const r3 = acceptance(s.repo, delivered, VER_R3_ACCEPTANCE);
    expect(r3.code, r3.out).toBe(0);
    void readFileSync;
  });
});
