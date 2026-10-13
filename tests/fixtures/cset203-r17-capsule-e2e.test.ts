/**
 * CSET-203 r17 with-faults, model-free, to the delivery it should have
 * reached (every platform).
 *
 * r17 (fault arm; trusted: the concurrent commit, duplicate and stale
 * replays, the interrupted and restarted host and controller authority
 * recovery all handled): a teammate's commit landed on main during
 * apply-release-plan's first work; R001, R002 and R003 ran to C001. Then the
 * late hidden defect — a teammate's commit on main breaking
 * apply-release-plan's rollback — and QA's rework of it. R004 found AC-1 on
 * apply-release-plan (its code held the reproduction) and AC-3 on the cli;
 * the cli challenged AC-3 with its focused test committed alone. R005 found
 * AC-1 again, a changelog the run changed or created restored when removing
 * a changeset fails; the worker wrote that exact reproduction as two cases of
 * one template-literal title in a loop and kept it out of the branch. It
 * passed on the unchanged base, but nothing could name its tests: the red
 * gate kept no challenge material, the challenge line answered GATE_UNKNOWN,
 * the check line CRITERION_TEST_UNKNOWN (NO_DECLARED_TESTS once committed).
 * BLOCKED after six attempts; no candidate.
 *
 * Here the same faults, in the same order, with reproductions sealed as
 * capsules:
 *
 *  1. the teammate's commit during apply-release-plan's first work; R001
 *     (AC-1, AC-3: real gaps, fixed test-first) with the cli's host
 *     interrupted and resumed mid-rework, the old ticket's late answer
 *     stale; R002 (AC-5); R003 PASS; C001; duplicate and stale settle
 *     replays idempotent;
 *  2. the late hidden defect on main; QA's rework of apply-release-plan;
 *     the cli re-proved on the repaired head;
 *  3. (withdraw/refine) R004's AC-1 reproduction sealed as a capsule —
 *     uncommitted, its host restarted mid-way — and challenged: no attempt;
 *     the refinement REFINEs it to r17's R005 reproduction, sealed exactly as
 *     r17's worker wrote it (template literal, loop, uncommitted), challenged
 *     again and WITHDRAWn; the cli's AC-3 challenged with its focused test
 *     committed alone (the committed flow) and WITHDRAWn; R004 PASS; C002;
 *  3'. (uphold) R004's AC-1 at a real boundary of QA's code: a weak capsule
 *     challenged, the refinement UPHOLDs it; only AC-1 is reworked: the gap's
 *     exact reproduction sealed fails — promoted to the RED, committed
 *     test-first, then the fix; R005 PASS; C002;
 *  4. trusted and verified: feature verify, hidden-like acceptance, both
 *     teammate commits in the delivered history, every capsule replayed
 *     independently, nothing charged for any challenge, nothing BLOCKED.
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
  ARP_FIXED_IMPL,
  ARP_GAPPY_IMPL,
  ARP_RED,
  ARP_SRC,
  ARP_TESTS,
  BASE_FILES,
  CLI,
  CLI_AC5,
  CLI_FULL_WORK,
  CLI_SRC,
  CLI_TESTS,
  CLI_TRUNCATED_IMPL,
  CLI_TRUNCATED_RED,
  CLI_TRUNCATED_TEST,
  VER_CANDIDATE,
  VER_CHANGELOG_ACCEPTANCE,
  VER_FEATURE,
  VER_R3_ACCEPTANCE,
  commitVerControl,
  createVer,
  verCli,
  verState,
  type Ver,
} from '../helpers/version-fixture.js';
import { commit, fulfil, packOf, runGate, writeFiles, type ShopTicket } from '../helpers/shop-worker.js';
import { refinementFor, reviewPacket, verdictFor, writeVerdict, type ReviewTicket } from '../helpers/review-agent.js';
import { ARP_CRITERIA, CLI_CRITERIA, GAP_AC1, GAP_AC3, GAP_AC5, carriedItems, dispatch, repairArp, settle, status, writeResult } from '../helpers/cset203-rework.js';
import { compatRework, settleReview, writeLateBlocked } from '../helpers/cset203-r7.js';
import { CLI_AC3_HOLDS_BODY, CLI_AC3_HOLDS_TEST, GAP_AC3_HOLDS, cliAc3Clauses } from '../helpers/cset203-r14.js';
import { writeChallenge } from '../helpers/cset203-challenge.js';
import { TEAM_NOTES, eventsOf, teammateCommit } from '../helpers/cset203-r16.js';
import {
  AC1_R005_REFINED,
  ARP_CAPSULE_FILE,
  ARP_CAPSULE_NAMES,
  ARP_CAPSULE_TESTS,
  ARP_PARTIAL_FILE,
  ARP_PARTIAL_TEST,
  ARP_PARTIAL_TESTS,
  ARP_R005_FILE,
  ARP_R005_NAMES,
  ARP_R005_TESTS,
  ARP_WEAK_FILE,
  ARP_WEAK_NAMES,
  ARP_WEAK_TESTS,
  GAP_AC1_PARTIAL,
  GAP_AC1_R004,
  arpCapsuleClauses,
  arpR005Clauses,
  arpWeakClauses,
  registerCapsule,
  writeCapsuleChallenge,
  writeReproduction,
} from '../helpers/cset203-r17.js';

afterAll(() => cleanupTmpRoots());

const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');
const R = (n: number): string => `${VER_FEATURE}-R00${n}`;

/** The product state a settle may change: every node, the review, the candidate, the integration heads (never a lease's bookkeeping). */
const stateHash = (s: Ver): string => {
  const d = verState(s);
  return sha256(JSON.stringify({ nodes: d.nodes, review: { ...(d.acceptance_review ?? {}), usage: undefined }, candidate: d.current_candidate, heads: d.integration_heads, feature: d.feature_state }));
};

function acceptance(repo: string, sha: string, script: string): { code: number; out: string } {
  const at = join(makeTmpDir('cset203-r17-hidden-like-'), 'checkout');
  git(repo, ['worktree', 'add', '--detach', at, sha]);
  try {
    const file = join(makeTmpDir('cset203-r17-script-'), 'acceptance.mjs');
    writeFileSync(file, script);
    const r = spawnSync(process.execPath, [file, at], { encoding: 'utf8' });
    return { code: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
  } finally {
    git(repo, ['worktree', 'remove', '--force', at]);
  }
}

/** Every review dispatch answered PASS until the feature settles; then the candidate delivered and accepted. */
async function reviewAndDeliver(s: Ver, expected: { review: string; candidate: string }): Promise<void> {
  let reviewed = false;
  for (let i = 0; i < 6; i++) {
    const d = await dispatch(s);
    if (d.status === 'ALL_SETTLED') {
      expect(reviewed, `${expected.review} was never handed out`).toBe(true);
      expect((d.controller_reports ?? []).map((x) => x.node_id)).toContain(VER_CANDIDATE);
      commitVerControl(s, 'settled');
      const delivered = JSON.parse((await verCli(s, ['deliver', VER_FEATURE, '--json'])).out) as Record<string, unknown>;
      expect(delivered).toMatchObject({ status: 'ACCEPTED', candidate_id: expected.candidate });
      commitVerControl(s, `delivered ${expected.candidate}`);
      return;
    }
    const t = d.ticket as unknown as ReviewTicket & { kind?: string; refinement?: unknown };
    expect(t?.kind, `dispatch ${i}: ${d.status} ${d.detail}`).toBe('acceptance-review');
    expect(t.review_id).toBe(expected.review);
    await writeVerdict(t, verdictFor(reviewPacket(t)), { cwd: s.control });
    expect(await settleReview(s, t)).toMatchObject({ outcome: 'PASS' });
    commitVerControl(s, `${expected.review} PASS`);
    reviewed = true;
  }
  throw new Error('the feature never settled');
}

/** The feature settled with its review passed: the next dispatch builds the candidate, which is delivered and accepted. */
async function deliverSettled(s: Ver, candidate: string): Promise<void> {
  const d = await dispatch(s);
  expect(d.status, d.detail).toBe('ALL_SETTLED');
  expect((d.controller_reports ?? []).map((x) => x.node_id)).toContain(VER_CANDIDATE);
  commitVerControl(s, 'settled');
  expect(JSON.parse((await verCli(s, ['deliver', VER_FEATURE, '--json'])).out)).toMatchObject({ status: 'ACCEPTED', candidate_id: candidate });
  commitVerControl(s, `delivered ${candidate}`);
}

/**
 * A node reopened by its upstream's rework, re-proved on the repaired head: green and regression; each criterion its
 * last generation proved cited as that generation settled it — its own RED (still the node's), a carried proof exactly
 * as the pack gives it (r17's cli: AC-4, carried since the cli's first generation, asked a person here), and a
 * compatibility criterion by this generation's green gate.
 */
async function reprove(s: Ver, node: string): Promise<void> {
  const c = await ticketOf(s, node);
  const pack = packOf(c);
  const carried = ((pack['rework']?.['carried_criteria'] ?? pack['carried_criteria'] ?? []) as { criterion: string; test_id: string; gate: string; output_sha256: string }[]);
  const green = runGate(c, 'green', s.control);
  expect(green.code, green.out).toBe(0);
  expect(runGate(c, 'regression', s.control).code).toBe(0);
  const evidence = (verState(s).nodes[node].criteria as { criterion: string; test_id: string; gate: string; output_sha256: string; carried?: boolean }[]).map((x) => {
    if (x.carried === true) {
      const p = carried.find((k) => k.criterion === x.criterion);
      expect(p, `the pack carries ${x.criterion}'s proof: ${JSON.stringify(carried)}`).toBeDefined();
      return { criterion: p!.criterion, test_id: p!.test_id, gate: p!.gate, output_sha256: p!.output_sha256 };
    }
    return x.gate === 'red' ? { criterion: x.criterion, test_id: x.test_id, gate: 'red', output_sha256: x.output_sha256 } : { criterion: x.criterion, test_id: x.test_id, gate: 'green', output_sha256: green.sha256 };
  });
  writeResult(c, evidence);
  const done = await settle(s, c);
  expect(done, done.detail).toMatchObject({ outcome: 'DONE' });
  commitVerControl(s, `${node} re-proved`);
}

/** The next dispatch is the review `id` (a new one, or its refinement): answered with `verdict`, settled as `outcome`. */
async function review(s: Ver, id: string, verdict: (t: ReviewTicket) => Record<string, unknown>, outcome: string): Promise<Record<string, any>> {
  const d = await dispatch(s);
  const t = d.ticket as unknown as ReviewTicket & { kind?: string };
  expect(t?.kind, `${d.status} ${d.detail}`).toBe('acceptance-review');
  expect(t.review_id).toBe(id);
  await writeVerdict(t, verdict(t), { cwd: s.control });
  const settled = await settleReview(s, t);
  expect(settled, JSON.stringify(settled)).toMatchObject({ outcome });
  commitVerControl(s, `${id} ${outcome}`);
  return settled;
}

/** The next product ticket, of `node`. */
async function ticketOf(s: Ver, node: string): Promise<ShopTicket> {
  const d = await dispatch(s);
  expect(d.status, d.detail).toBe('DISPATCHED');
  const t = d.ticket!;
  expect(t.node_id, d.detail).toBe(node);
  return t;
}

/** No failure counted on any node and no person asked: nothing administrative or challenged was charged. */
function nothingCharged(s: Ver): void {
  for (const [id, rt] of Object.entries(verState(s).nodes as Record<string, any>)) expect(rt.failure_counts, id).toEqual({});
  expect(verState(s).pending_decisions).toEqual([]);
}

type R17 = Ver & { teammate: string; first: { arp: ShopTicket; cli: ShopTicket }; tickets: ShopTicket[] };

/**
 * Step 1: to C001, with r17's task-phase faults. Each review finds real gaps, fixed test-first: unless `arpGap` is
 * false, R001 finds AC-1 on apply-release-plan (a changelog write that fails part-way); the next finds AC-3 on the cli
 * (a journal cut short by a kill), its rework's host killed and resumed mid-way; the next is PASS: C001. Returns the
 * fixture and the id of the first review after the delivery.
 */
async function r17Delivered(options: { arpGap?: boolean } = {}): Promise<R17 & { next: number }> {
  const s = await createVer({ review: {} });
  const a = await ticketOf(s, ARP);
  // The concurrent commit: the teammate's notes on main, while apply-release-plan's first worker works.
  const teammate = teammateCommit(s, { [TEAM_NOTES]: '# Team notes\n\nRelease freeze starts Friday.\n' });
  fulfil(a, { tests: { [ARP_TESTS]: ARP_RED }, impl: { [ARP_SRC]: ARP_GAPPY_IMPL }, criteria: ARP_CRITERIA }, s.control);
  expect(await settle(s, a)).toMatchObject({ outcome: 'DONE' });
  commitVerControl(s, 'apply-release-plan');
  const c = await ticketOf(s, CLI);
  fulfil(c, { ...CLI_FULL_WORK, criteria: CLI_CRITERIA }, s.control);
  expect(await settle(s, c)).toMatchObject({ outcome: 'DONE' });
  commitVerControl(s, 'cli');
  let n = 1;
  if (options.arpGap !== false) {
    // R001: AC-1, the changelog boundary: a real gap, fixed test-first.
    await review(s, R(n++), (t) => verdictFor(reviewPacket(t), { 'AC-1': GAP_AC1 }), 'GAPS');
    await repairArp(s);
    // The cli, reopened by its upstream's rework, re-proved on the repaired head.
    await reprove(s, CLI);
  }
  // AC-3, a journal cut short by a kill: the cli's rework, its host killed after the RED was committed and resumed.
  await review(s, R(n++), (t) => verdictFor(reviewPacket(t), { 'AC-3': GAP_AC3 }), 'GAPS');
  const c1 = await ticketOf(s, CLI);
  writeFiles(c1.worktree, { [CLI_TESTS]: CLI_TRUNCATED_RED });
  const red = runGate(c1, 'red', s.control);
  expect(red.code, red.out).toBe(0);
  commit(c1.worktree, [CLI_TESTS], 'test(cli): a journal cut short by a kill');
  const resumed = JSON.parse((await verCli(s, ['dispatch', VER_FEATURE, '--resume', CLI, '--json'])).out) as { ticket?: ShopTicket; detail: string };
  const c2 = resumed.ticket!;
  expect(c2, resumed.detail).toMatchObject({ node_id: CLI, claim_id: c1.claim_id, worktree: c1.worktree });
  writeFiles(c2.worktree, { [CLI_SRC]: CLI_TRUNCATED_IMPL });
  const green = runGate(c2, 'green', s.control);
  expect(green.code, green.out).toBe(0);
  commit(c2.worktree, [CLI_SRC], 'fix(cli): a journal cut short by a kill is removed, with the warning');
  expect(runGate(c2, 'regression', s.control).code).toBe(0);
  writeResult(c2, [{ criterion: 'AC-3', test_id: red.tests.find((x) => x.full_name === CLI_TRUNCATED_TEST)!.id, gate: 'red', output_sha256: red.sha256 }, ...carriedItems(c2), { ...CLI_AC5, output_sha256: green.sha256 }]);
  const cli = await settle(s, c2);
  expect(cli, cli.detail).toMatchObject({ outcome: 'DONE' });
  commitVerControl(s, 'cli repaired');
  // The killed generation's late answer: stale, nothing moves.
  const before = stateHash(s);
  writeLateBlocked(c1);
  expect((await settle(s, c1)).outcome).toMatch(/STALE/);
  expect(stateHash(s)).toBe(before);
  await reviewAndDeliver(s, { review: R(n++), candidate: `${VER_FEATURE}-C001` });
  expect(git(s.repo, ['merge-base', '--is-ancestor', teammate, 'main'])).toBe('');
  // Duplicate and stale replays of earlier settles: idempotent, nothing moves.
  const settledState = stateHash(s);
  for (const replay of [a, c, c2]) expect(['DONE', 'STALE_ORCHESTRATION_EPOCH']).toContain((await settle(s, replay)).outcome);
  expect(stateHash(s)).toBe(settledState);
  return Object.assign(s, { teammate, first: { arp: a, cli: c }, tickets: [a, c, c1, c2], next: n });
}

/** Step 2: the late hidden defect, QA's rework of apply-release-plan to `impl`, the cli re-proved on the repaired head. */
async function lateDefectRepaired(s: R17, impl: string): Promise<string> {
  // A teammate's commit on main reverts apply-release-plan's rollback (the hidden defect).
  const defect = teammateCommit(s, { [ARP_SRC]: BASE_FILES[ARP_SRC] as string }, 'chore: sync platform changes');
  const report = '[AC-1] when the formatter crashes after files were changed, every file is restored and the original error is the cause (failed: assertion); [AC-2] the journal is kept while applying and removed afterwards (failed: assertion)';
  const qa = JSON.parse((await verCli(s, ['feature', 'rework', VER_FEATURE, '--reason', `QA on the delivered commit: ${report}`, '--since-delivery', '--json'])).out) as Record<string, any>;
  expect(qa, JSON.stringify(qa)).toMatchObject({ targets: [ARP] });
  commitVerControl(s, 'QA rework');
  const a = await ticketOf(s, ARP);
  const qaTests = 'packages/apply-release-plan/test/qa.test.mjs';
  const fixed = fulfil(a, {
    tests: {
      [qaTests]: `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { applyReleasePlan } from '../src/index.mjs';\n\ntest('QA: a crash after a change restores every file, the cause kept', async () => {\n  const files = new Map([['packages/q/package.json', '{"version":"1.0.0"}']]);\n  const failure = new Error('formatter crashed');\n  const error = await applyReleasePlan(files, [{ path: 'packages/q/package.json', content: '{"version":"2.0.0"}' }], { format: async () => { throw failure; } }).then(() => null, (e) => e);\n  assert.equal(error.cause, failure);\n  assert.deepEqual([...files], [['packages/q/package.json', '{"version":"1.0.0"}']]);\n});\n\ntest('QA: a journal is kept while applying and removed afterwards', async () => {\n  const files = new Map([['packages/q/package.json', '{"version":"1.0.0"}']]);\n  const seen = [];\n  await applyReleasePlan(files, [{ path: 'packages/q/package.json', content: '{"version":"2.0.0"}' }], { format: async () => seen.push([...files.keys()].some((p) => p.startsWith('.changeset/.'))) });\n  assert.deepEqual(seen, [true]);\n  assert.deepEqual([...files.keys()], ['packages/q/package.json']);\n});\n`,
    },
    impl: { [ARP_SRC]: impl },
    criteria: [
      { criterion: 'AC-1', gate: 'red', full_name: 'QA: a crash after a change restores every file, the cause kept' },
      { criterion: 'AC-2', gate: 'red', full_name: 'QA: a journal is kept while applying and removed afterwards' },
    ],
  }, s.control);
  expect(fixed.result['outcome'], JSON.stringify(fixed.gates.map((g) => [g.gate, g.code, g.out.slice(-300)]))).toBe('SUBMITTED');
  expect(await settle(s, a)).toMatchObject({ outcome: 'DONE' });
  commitVerControl(s, 'apply-release-plan repaired by QA');
  // The cli, reopened by its upstream's rework: green and regression on the repaired head, its proofs carried.
  await reprove(s, CLI);
  return defect;
}

/** Trusted and verified on the delivered head: verify, hidden-like acceptance, both teammate commits kept, every capsule replayed. */
async function trustedAndVerified(s: R17, defect: string): Promise<string> {
  expect(JSON.parse((await verCli(s, ['feature', 'verify', VER_FEATURE, '--delivered', '--json'])).out)).toEqual({ ok: true, problems: [] });
  const delivered = git(s.repo, ['rev-parse', 'main']);
  for (const kept of [s.teammate, defect]) expect(git(s.repo, ['merge-base', '--is-ancestor', kept, delivered]), kept).toBe('');
  expect(git(s.repo, ['show', `${delivered}:${TEAM_NOTES}`])).toContain('Release freeze');
  for (const script of [VER_R3_ACCEPTANCE, VER_CHANGELOG_ACCEPTANCE]) {
    const r = acceptance(s.repo, delivered, script);
    expect(r.code, r.out).toBe(0);
  }
  const replay = JSON.parse((await verCli(s, ['capsule', 'verify', VER_FEATURE, '--replay', '--json'])).out) as Record<string, any>;
  expect(replay, JSON.stringify(replay)).toMatchObject({ ok: true });
  expect((replay['capsules'] as unknown[]).length).toBeGreaterThan(0);
  nothingCharged(s);
  expect(eventsOf(s).filter((e) => e.type === 'node.settled' && e.data['outcome'] === 'BLOCKED')).toEqual([]);
  expect(await status(s)).toMatchObject({ next_action: { kind: 'none' } });
  return delivered;
}

describe('CSET-203 r17 fault arm, replayed model-free with reproduction capsules to the delivery it should have reached', () => {
  it("withdraw/refine: R004's AC-1 capsule (host restarted mid-way) challenged and refined to r17's R005 reproduction, sealed exactly as r17's worker wrote it and challenged again, withdrawn; the cli's committed AC-3 challenge withdrawn; R004 PASS, C002 delivered, nothing charged, the reproductions never integrated", async () => {
    const s = await r17Delivered();
    expect(s.next).toBe(4);
    const defect = await lateDefectRepaired(s, ARP_FIXED_IMPL);
    // R004: AC-1 (QA's code holds the reproduction) and AC-3 (the cli's holds its own).
    await review(s, R(4), (t) => verdictFor(reviewPacket(t), { 'AC-1': GAP_AC1_R004, 'AC-3': GAP_AC3_HOLDS }), 'GAPS');
    const arpAttempts = verState(s).nodes[ARP].attempts as number;
    const t = await ticketOf(s, ARP);
    writeReproduction(t, ARP_CAPSULE_TESTS, ARP_CAPSULE_FILE);
    const sealed = registerCapsule(t, s.control, 'AC-1');
    expect(sealed.out, sealed.raw).toMatchObject({ ok: true, result: 'passed' });
    // The host is killed with the capsule sealed; a fresh session resumes the same generation, which challenges with it.
    const resumed = JSON.parse((await verCli(s, ['dispatch', VER_FEATURE, '--resume', ARP, '--json'])).out) as { ticket?: ShopTicket; detail: string };
    const t2 = resumed.ticket!;
    expect(t2, resumed.detail).toMatchObject({ node_id: ARP, claim_id: t.claim_id });
    writeCapsuleChallenge(t2, s.control, [{ id: sealed.out['capsule_id'], file: ARP_CAPSULE_TESTS, source: ARP_CAPSULE_FILE, names: ARP_CAPSULE_NAMES, clauses: arpCapsuleClauses }]);
    const challenged = await settle(s, t2);
    expect(challenged, challenged.detail).toMatchObject({ outcome: 'REVIEW_CHALLENGED', state: 'DONE' });
    commitVerControl(s, 'R004 AC-1 challenged by its capsule');
    expect(verState(s).nodes[ARP].attempts).toBe(arpAttempts);
    // The refinement refines AC-1 to r17's R005 reproduction: a changelog the run changed or created.
    await review(s, R(4), (rr) => refinementFor(reviewPacket(rr), { 'AC-1': { decision: 'REFINE', gap: AC1_R005_REFINED, producer: { node_id: ARP } } }), 'GAPS');
    // r17's own last generation, as it should have gone: the exact reproduction (template literal, loop) kept out of the branch, sealed, challenged.
    const t3 = await ticketOf(s, ARP);
    expect(t3.prompt).toMatch(/tdd capsule/);
    writeReproduction(t3, ARP_R005_TESTS, ARP_R005_FILE);
    const red = runGate(t3, 'red', s.control);
    expect(red.code).not.toBe(0);
    expect(red.out).toMatch(/capsule/);
    const r005 = registerCapsule(t3, s.control, 'AC-1');
    expect(r005.out, r005.raw).toMatchObject({ ok: true, result: 'passed', tests: ARP_R005_NAMES.map((n) => expect.objectContaining({ full_name: n, status: 'passed' })) });
    writeCapsuleChallenge(t3, s.control, [{ id: r005.out['capsule_id'], file: ARP_R005_TESTS, source: ARP_R005_FILE, names: ARP_R005_NAMES, clauses: arpR005Clauses }]);
    const again = await settle(s, t3);
    expect(again, again.detail).toMatchObject({ outcome: 'REVIEW_CHALLENGED', state: 'DONE' });
    commitVerControl(s, 'R004 AC-1 (refined) challenged by its capsule');
    expect(verState(s).nodes[ARP].attempts).toBe(arpAttempts);
    await review(s, R(4), (rr) => refinementFor(reviewPacket(rr), { 'AC-1': { decision: 'WITHDRAW' } }), 'GAPS');
    // The cli's AC-3: its focused test committed alone, the committed challenge flow.
    const cliAttempts = verState(s).nodes[CLI].attempts as number;
    const c = await ticketOf(s, CLI);
    writeChallenge(c, s.control, { tests: { [CLI_TESTS]: `${CLI_TRUNCATED_RED}${CLI_AC3_HOLDS_BODY}` }, test: CLI_AC3_HOLDS_TEST, clauses: cliAc3Clauses, commit: true });
    expect(await settle(s, c)).toMatchObject({ outcome: 'REVIEW_CHALLENGED' });
    commitVerControl(s, 'R004 AC-3 challenged');
    expect(verState(s).nodes[CLI].attempts).toBe(cliAttempts);
    // Every gap of R004 withdrawn: its last refinement is its PASS; the next dispatch builds the candidate.
    await review(s, R(4), (rr) => refinementFor(reviewPacket(rr), { 'AC-3': { decision: 'WITHDRAW' } }), 'PASS');
    await deliverSettled(s, `${VER_FEATURE}-C002`);
    const delivered = await trustedAndVerified(s, defect);
    // The challenges' reproductions were never integrated; every challenge withdrawn, its capsule archived with it.
    for (const file of [ARP_CAPSULE_TESTS, ARP_R005_TESTS]) expect(git(s.repo, ['ls-tree', '-r', '--name-only', delivered]).split('\n')).not.toContain(file);
    const challenges = verState(s).acceptance_review.challenges as { node_id: string; status: string; receipt_path: string }[];
    expect(challenges.map((x) => [x.node_id, x.status])).toEqual([[ARP, 'refined'], [ARP, 'withdrawn'], [CLI, 'withdrawn']]);
    const capsuled = challenges.filter((x) => x.node_id === ARP).map((x) => (JSON.parse(readFileSync(join(s.control, ...x.receipt_path.split('/')), 'utf8')) as { capsules?: { capsule_id: string }[] }).capsules?.map((k) => k.capsule_id));
    expect(capsuled).toEqual([[sealed.out['capsule_id']], [r005.out['capsule_id']]]);
  }, 900_000);

  it("uphold: R004's AC-1 at a real boundary of QA's code — a weak capsule challenged and upheld; only AC-1 reworked: the gap's exact reproduction sealed fails, promoted to the RED, committed test-first, then the fix; R005 PASS, C002 delivered, nothing charged for the challenge", async () => {
    // R001 misses the changelog boundary: C001 ships apply-release-plan's first generation.
    const s = await r17Delivered({ arpGap: false });
    // QA's repair restores the rollback the late defect removed, but not a changelog write that fails part-way.
    const defect = await lateDefectRepaired(s, ARP_GAPPY_IMPL);
    // The first review after C001 (R003: R001 found AC-3 alone) finds AC-1 at a real boundary of QA's code.
    await review(s, R(s.next), (t) => verdictFor(reviewPacket(t), { 'AC-1': GAP_AC1_PARTIAL }), 'GAPS');
    const arpAttempts = verState(s).nodes[ARP].attempts as number;
    const t = await ticketOf(s, ARP);
    // The worker's first reproduction writes nothing of the changelog before it fails: it passes, at another boundary.
    writeReproduction(t, ARP_WEAK_TESTS, ARP_WEAK_FILE);
    const weak = registerCapsule(t, s.control, 'AC-1');
    expect(weak.out, weak.raw).toMatchObject({ ok: true, result: 'passed' });
    writeCapsuleChallenge(t, s.control, [{ id: weak.out['capsule_id'], file: ARP_WEAK_TESTS, source: ARP_WEAK_FILE, names: ARP_WEAK_NAMES, clauses: arpWeakClauses }]);
    expect(await settle(s, t)).toMatchObject({ outcome: 'REVIEW_CHALLENGED' });
    commitVerControl(s, 'R004 AC-1 challenged');
    expect(verState(s).nodes[ARP].attempts).toBe(arpAttempts);
    // The refinement upholds it: the challenge's writer never writes part of the file the gap names.
    await review(s, R(s.next), (rr) => refinementFor(reviewPacket(rr), { 'AC-1': { decision: 'UPHOLD', reason: 'The challenge injects a writer that fails before writing anything; the gap is a changelog write that fails part-way, leaving a half-written file.', gap: { missing: 'no test leaves a half-written changelog behind a failure: the writer of the challenge fails before writing any byte', reproduction: 'bump packages/a/package.json, then have the changelog writer write the first two characters of packages/a/CHANGELOG.md and fail with ENOSPC; assert the half-written changelog and package.json hold their exact previous bytes and the rejection cause is the ENOSPC failure' }, producer: { node_id: ARP } } }), 'GAPS');
    const state = verState(s);
    // Only AC-1 is reworked, and only on apply-release-plan.
    const ordered = Object.entries(state.nodes as Record<string, any>).filter(([, rt]) => (rt.rework_brief?.acceptance_criteria ?? []).length > 0).map(([id, rt]) => [id, rt.rework_brief.acceptance_criteria]);
    expect(ordered).toEqual([[ARP, ['AC-1']]]);
    const t2 = await ticketOf(s, ARP);
    writeReproduction(t2, ARP_PARTIAL_TESTS, ARP_PARTIAL_FILE);
    const exact = registerCapsule(t2, s.control, 'AC-1');
    expect(exact.out, exact.raw).toMatchObject({ ok: true, result: 'failed', tests: [expect.objectContaining({ full_name: ARP_PARTIAL_TEST, status: 'failed' })] });
    // Promoted: the red gate runs its exact bytes, they are committed test-first, then the fix.
    const red = runGate(t2, 'red', s.control);
    expect(red.code, red.out).toBe(0);
    commit(t2.worktree, [ARP_PARTIAL_TESTS], 'test(apply-release-plan): a changelog write that fails part-way is rolled back');
    writeFiles(t2.worktree, { [ARP_SRC]: ARP_FIXED_IMPL });
    expect(runGate(t2, 'green', s.control).code).toBe(0);
    commit(t2.worktree, [ARP_SRC], 'fix(apply-release-plan): restore every file the plan was about to change');
    expect(runGate(t2, 'regression', s.control).code).toBe(0);
    const testId = (exact.out['tests'] as { id: string }[])[0]!.id;
    writeResult(t2, [{ criterion: 'AC-1', test_id: testId, gate: 'red', output_sha256: red.sha256, capsule_id: exact.out['capsule_id'] }, ...carriedItems(t2)]);
    const done = await settle(s, t2);
    expect(done, done.detail).toMatchObject({ outcome: 'DONE' });
    commitVerControl(s, 'apply-release-plan: AC-1 RED from its capsule, fixed');
    expect((verState(s).nodes[ARP].criteria as Record<string, any>[]).find((x) => x['criterion'] === 'AC-1')).toMatchObject({ capsule: { capsule_id: exact.out['capsule_id'], result: 'failed' } });
    // The cli re-proved on the repaired head; R005 PASS; C002.
    await reprove(s, CLI);
    await reviewAndDeliver(s, { review: R(s.next + 1), candidate: `${VER_FEATURE}-C002` });
    const delivered = await trustedAndVerified(s, defect);
    // The promoted reproduction is in the delivered history, byte for byte; the weak one never was.
    expect(git(s.repo, ['show', `${delivered}:${ARP_PARTIAL_TESTS}`])).toBe(ARP_PARTIAL_FILE.trimEnd());
    expect(git(s.repo, ['ls-tree', '-r', '--name-only', delivered]).split('\n')).not.toContain(ARP_WEAK_TESTS);
    expect((verState(s).acceptance_review.challenges as { status: string }[]).map((x) => x.status)).toEqual(['upheld']);
  }, 900_000);
});

