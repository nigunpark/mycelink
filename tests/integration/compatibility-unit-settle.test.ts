/**
 * Settling a compatibility-regression unit.
 *
 * CSET-203 r3's reviewer found AC-5 (compatibility) untested: no test runs
 * status beside a journal. The cli, the product producer of AC-5, is
 * reworked for it — and its behaviour is already right, so the honest repair
 * is a regression test alone: no RED (it passes), no production change.
 * Settle accepts it as a compatibility-regression unit, apart from the RED
 * cycles, when:
 *
 *  - its commits are test-only, after the node's production (or the whole
 *    history of a rework whose production is in its base), each carrying
 *    `Mycelink-Compatibility: AC-5`;
 *  - every test it adds is named in AC-5's criterion evidence through a
 *    green or regression gate that passed it at the head (a green gate may
 *    run again after the commit, so its output names the test);
 *  - a rework whose brief names compatibility criteria only needs no RED of
 *    its generation (the code is in its base) and carries none of the
 *    replaced one: its worker runs no red gate and makes no fake production
 *    commit, and the new behaviours it does not name are carried proofs,
 *    re-run by settle at the new head;
 *  - after a RED cycle of the rework, the unit's test goes into a test file
 *    no RED of the history bound (CSET-203 r4: appended to AC-3's RED file
 *    it is CHANGED_RED_BLOBS).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
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
  CLI_COMPAT_FILE,
  CLI_COMPAT_TESTS,
  CLI_COMPAT_TEST_BODY,
  CLI_COMPAT_TEST_ID,
  CLI_FAILURE_TEST,
  CLI_FULL_WORK,
  CLI_JOURNAL_STATUS_TEST,
  CLI_RECOVERY_TEST,
  CLI_SRC,
  CLI_STATUS_TEST,
  CLI_TESTS,
  CLI_TRUNCATED_IMPL,
  CLI_TRUNCATED_RED,
  CLI_TRUNCATED_TEST,
  COMPAT,
  VER_FEATURE,
  commitVerControl,
  createVer,
  verCli,
  verCliTestId,
  verState,
  type Ver,
} from '../helpers/version-fixture.js';
import { commit, fulfil, packOf, runGate, writeFiles, type CriterionItem, type ShopTicket } from '../helpers/shop-worker.js';
import { reviewPacket, verdictFor, writeVerdict, type ReviewTicket, type VerdictOverride } from '../helpers/review-agent.js';

afterAll(() => cleanupTmpRoots());

async function dispatch(s: Ver): Promise<{ status: string; detail: string; ticket?: ShopTicket & { kind?: string } }> {
  return JSON.parse((await verCli(s, ['dispatch', VER_FEATURE, '--json'])).out) as { status: string; detail: string; ticket?: ShopTicket & { kind?: string } };
}
async function settle(s: Ver, t: ShopTicket): Promise<{ outcome: string; detail: string }> {
  return JSON.parse((await verCli(s, ['settle', VER_FEATURE, t.node_id, '--capability', t.capability, '--json'])).out) as { outcome: string; detail: string };
}
async function check(s: Ver, t: ShopTicket): Promise<Record<string, any>> {
  return JSON.parse((await verCli(s, ['tdd', 'check', VER_FEATURE, t.node_id, '--capability', t.capability, '--json'])).out) as Record<string, any>;
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

const GAP_AC1: VerdictOverride = { gap: { missing: 'no test fails the changelog write after the package/version writes', reproduction: 'inject changelog writer failure after package/version writes and assert exact rollback', producer: { node_id: ARP } } };
const GAP_AC3: VerdictOverride = { gap: { missing: 'a journal cut short by a kill is never recovered from', reproduction: 'leave a truncated, unparseable journal in .changeset, run version, and assert it warns interrupted, removes the journal and versions once', producer: { node_id: CLI } } };
const GAP_AC5: VerdictOverride = { gap: { missing: 'no regression evidence runs status with a journal present in .changeset', reproduction: 'put .changeset/.version-journal.json beside a changeset, run status, and assert the journal is not listed', producer: { node_id: COMPAT } }, untested: ['AC-5.2'] };

/** Both producers DONE, the compatibility node run, R001 settled with `gaps`. */
async function reviewed(gaps: Record<string, VerdictOverride>): Promise<Ver> {
  const s = await createVer({ review: {} });
  const a = (await dispatch(s)).ticket!;
  fulfil(a, { tests: { [ARP_TESTS]: ARP_RED }, impl: { [ARP_SRC]: ARP_GAPPY_IMPL }, criteria: ARP_CRITERIA }, s.control);
  expect(await settle(s, a)).toMatchObject({ outcome: 'DONE' });
  commitVerControl(s, 'apply-release-plan');
  const c = (await dispatch(s)).ticket!;
  fulfil(c, { ...CLI_FULL_WORK, criteria: CLI_CRITERIA }, s.control);
  expect(await settle(s, c)).toMatchObject({ outcome: 'DONE' });
  commitVerControl(s, 'cli');
  const t = (await dispatch(s)).ticket as unknown as ReviewTicket;
  expect(t).toMatchObject({ kind: 'acceptance-review' });
  await writeVerdict(t, verdictFor(reviewPacket(t), gaps), { cwd: s.control });
  const settled = JSON.parse((await verCli(s, ['review', 'settle', VER_FEATURE, '--review', t.review_id, '--capability', t.capability, '--json'])).out) as { outcome: string };
  expect(settled).toMatchObject({ outcome: 'GAPS' });
  commitVerControl(s, 'review R001');
  return s;
}

/** The reworked apply-release-plan's worker: AC-1's focused RED and the fix; AC-2 keeps its proof. */
async function repairArp(s: Ver): Promise<void> {
  const t = (await dispatch(s)).ticket!;
  expect(t.node_id).toBe(ARP);
  const ac2 = (packOf(t)['rework']['carried_criteria'] as { criterion: string; test_id: string; output_sha256: string }[]).find((c) => c.criterion === 'AC-2')!;
  const run = fulfil(t, { tests: { [ARP_TESTS]: ARP_REVIEW_RED }, impl: { [ARP_SRC]: ARP_FIXED_IMPL }, criteria: [{ criterion: 'AC-1', gate: 'red', full_name: ARP_CHANGELOG_TEST }] }, s.control);
  const result = run.result as { criterion_evidence: Record<string, unknown>[] };
  result.criterion_evidence.push({ criterion: 'AC-2', test_id: ac2.test_id, gate: 'red', output_sha256: ac2.output_sha256 });
  writeFileSync(t.result_slot, JSON.stringify(result, null, 2));
  expect(await settle(s, t)).toMatchObject({ outcome: 'DONE' });
  commitVerControl(s, 'apply-release-plan repaired');
}

/** Commit `paths` alone with the compatibility trailer for `criteria`. */
function commitCompat(worktree: string, paths: string[], criteria: string): string {
  git(worktree, ['add', '--', ...paths]);
  git(worktree, ['commit', '-q', '-m', `test(cli): ${criteria} status beside a journal`, '-m', `Mycelink-Compatibility: ${criteria}`]);
  return git(worktree, ['rev-parse', 'HEAD']);
}

function writeResult(t: ShopTicket, evidence: Record<string, unknown>[]): void {
  const result = {
    schema_version: 1,
    node_id: t.node_id,
    claim_id: t.claim_id,
    dispatch_id: t.dispatch_id,
    outcome: 'SUBMITTED',
    commands: [],
    evidence_paths: [],
    failure_fingerprint: null,
    decision_request: null,
    commit_sha: git(t.worktree, ['rev-parse', 'HEAD']),
    criterion_evidence: evidence,
  };
  mkdirSync(dirname(t.result_slot), { recursive: true });
  writeFileSync(t.result_slot, JSON.stringify(result, null, 2));
}

/** The cli's rework for AC-3 (new behaviour) and AC-5 (compatibility): AC-3's RED cycle, then AC-5's test alone in a file of its own, green again, regression. */
function reworkCli(t: ShopTicket, control: string): { red: ReturnType<typeof runGate>; green: ReturnType<typeof runGate>; carried: { criterion: string; test_id: string; output_sha256: string }[] } {
  writeFiles(t.worktree, { [CLI_TESTS]: CLI_TRUNCATED_RED });
  const red = runGate(t, 'red', control);
  expect(red.code, red.out).toBe(0);
  expect(red.tests.find((x) => x.full_name === CLI_TRUNCATED_TEST)).toMatchObject({ status: 'failed' });
  commit(t.worktree, [CLI_TESTS], 'test(cli): AC-3 a journal cut short by a kill is recovered from');
  writeFiles(t.worktree, { [CLI_SRC]: CLI_TRUNCATED_IMPL });
  const first = runGate(t, 'green', control);
  expect(first.code, first.out).toBe(0);
  commit(t.worktree, [CLI_SRC], 'fix(cli): a truncated journal changed nothing yet; remove it');
  writeFiles(t.worktree, { [CLI_COMPAT_TESTS]: CLI_COMPAT_FILE });
  commitCompat(t.worktree, [CLI_COMPAT_TESTS], 'AC-5');
  // Green again, after the regression test's commit: its output names the test.
  const green = runGate(t, 'green', control);
  expect(green.code, green.out).toBe(0);
  expect(green.tests.find((x) => x.id === CLI_COMPAT_TEST_ID)).toMatchObject({ status: 'passed' });
  const regression = runGate(t, 'regression', control);
  expect(regression.code, regression.out).toBe(0);
  return { red, green, carried: packOf(t)['rework']['carried_criteria'] };
}

describe("the cli's rework for r3's AC-3 and AC-5 gaps", () => {
  it('a RED cycle for AC-3, then AC-5\'s regression test alone after the code: settled DONE, the unit apart from the cycle', async () => {
    const s = await reviewed({ 'AC-1': GAP_AC1, 'AC-3': GAP_AC3, 'AC-5': GAP_AC5 });
    await repairArp(s);
    const t = (await dispatch(s)).ticket!;
    expect(t.node_id).toBe(CLI);
    const pack = packOf(t);
    expect(pack['rework']).toMatchObject({ acceptance_criteria: ['AC-3', 'AC-5'], compatibility: ['AC-5'] });
    expect(pack['rework']['carried_criteria'].map((c: { criterion: string }) => c.criterion)).toEqual(['AC-4']);
    expect(pack['tdd']).toMatchObject({ compatibility_criteria: ['AC-5'] });
    // The brief says what each criterion of the rework asks for.
    expect(t.prompt).toMatch(/AC-3 \(new behavior\)[^\n]*focused failing/);
    expect(t.prompt).toMatch(/AC-5 \(compatibility\)[^\n]*compatibility-regression/);
    expect(t.prompt).toContain('Mycelink-Compatibility: AC-5');
    const { red, green, carried } = reworkCli(t, s.control);
    writeResult(t, [
      { criterion: 'AC-3', test_id: red.tests.find((x) => x.full_name === CLI_TRUNCATED_TEST)!.id, gate: 'red', output_sha256: red.sha256 },
      { criterion: 'AC-4', test_id: carried[0]!.test_id, gate: 'red', output_sha256: carried[0]!.output_sha256 },
      { criterion: 'AC-5', test_id: CLI_COMPAT_TEST_ID, gate: 'green', output_sha256: green.sha256 },
    ]);
    expect(await check(s, t)).toMatchObject({ ok: true });
    const done = await settle(s, t);
    expect(done, done.detail).toMatchObject({ outcome: 'DONE' });
    const rt = verState(s).nodes[CLI];
    expect(rt.tdd_history).toMatchObject({ ok: true, cycles: 1, compatibility_units: 1 });
    expect(rt.criteria).toEqual(expect.arrayContaining([expect.objectContaining({ criterion: 'AC-5', gate: 'green', test: expect.objectContaining({ name: CLI_JOURNAL_STATUS_TEST }) })]));
  });

  it("AC-5's evidence must name the unit's test: an existing test leaves it unbound, held for a metadata correction, never charged", async () => {
    const s = await reviewed({ 'AC-1': GAP_AC1, 'AC-3': GAP_AC3, 'AC-5': GAP_AC5 });
    await repairArp(s);
    const t = (await dispatch(s)).ticket!;
    const { red, green, carried } = reworkCli(t, s.control);
    const ac3 = { criterion: 'AC-3', test_id: red.tests.find((x) => x.full_name === CLI_TRUNCATED_TEST)!.id, gate: 'red', output_sha256: red.sha256 };
    const ac4 = { criterion: 'AC-4', test_id: carried[0]!.test_id, gate: 'red', output_sha256: carried[0]!.output_sha256 };
    writeResult(t, [ac3, ac4, { criterion: 'AC-5', test_id: verCliTestId(CLI_STATUS_TEST), gate: 'green', output_sha256: green.sha256 }]);
    const report = await check(s, t);
    expect(report).toMatchObject({ ok: false, code: 'CRITERION_COMPATIBILITY_UNBOUND', criterion: 'AC-5' });
    expect(report['candidates'].map((c: { full_name: string }) => c.full_name)).toContain(CLI_JOURNAL_STATUS_TEST);
    const held = await settle(s, t);
    expect(held.outcome).toBe('EVIDENCE_CORRECTION_REQUIRED');
    expect(held.detail).toMatch(/CRITERION_COMPATIBILITY_UNBOUND/);
    const rt = verState(s).nodes[CLI];
    expect(rt.claim.evidence_correction).toMatchObject({ code: 'CRITERION_COMPATIBILITY_UNBOUND', criterion: 'AC-5', cycle: false });
    expect(rt.failure_counts).toEqual({});
    commitVerControl(s, 'held');
    // The correction names the unit's test, on the same commit.
    const fix = (await dispatch(s)).ticket!;
    expect(fix.node_id).toBe(CLI);
    writeResult(fix, [ac3, ac4, { criterion: 'AC-5', test_id: CLI_COMPAT_TEST_ID, gate: 'green', output_sha256: green.sha256 }]);
    const done = await settle(s, fix);
    expect(done, done.detail).toMatchObject({ outcome: 'DONE' });
  });
});

describe('a rework whose brief names compatibility criteria only', () => {
  it("needs no RED and keeps none: its worker adds AC-5's regression test alone, runs no red gate, commits no production, and settles DONE", async () => {
    const s = await reviewed({ 'AC-5': GAP_AC5 });
    let state = verState(s);
    expect(state.nodes[ARP].state).toBe('DONE');
    expect(state.nodes[CLI]).toMatchObject({ state: 'INVALIDATED', rework_brief: { acceptance_criteria: ['AC-5'], red_required: false } });
    // No gate of the replaced generation is active: its new behaviours are carried proofs, archived under replaced/g1/.
    expect(state.nodes[CLI].evidence).toEqual({});
    for (const p of state.nodes[CLI].carried_criterion_proofs) expect(p.output_path).toMatch(/replaced\/g1\//);
    const t = (await dispatch(s)).ticket!;
    expect(t.node_id).toBe(CLI);
    const pack = packOf(t);
    expect(pack['next_required_gate']).toBe('GREEN_VERIFIED');
    expect(pack['rework']).toMatchObject({ acceptance_criteria: ['AC-5'], compatibility: ['AC-5'] });
    expect(pack['rework']['carried_criteria'].map((c: { criterion: string }) => c.criterion)).toEqual(['AC-3', 'AC-4']);
    expect(t.prompt).toMatch(/no red gate/i);
    const base = pack['tdd']['base_sha'] as string;
    writeFiles(t.worktree, { [CLI_TESTS]: `${git(t.worktree, ['show', `HEAD:${CLI_TESTS}`])}\n${CLI_COMPAT_TEST_BODY}` });
    const unit = commitCompat(t.worktree, [CLI_TESTS], 'AC-5');
    const green = runGate(t, 'green', s.control);
    expect(green.code, green.out).toBe(0);
    expect(runGate(t, 'regression', s.control).code).toBe(0);
    const carried = pack['rework']['carried_criteria'] as { criterion: string; test_id: string; output_sha256: string }[];
    writeResult(t, [
      ...carried.map((c) => ({ criterion: c.criterion, test_id: c.test_id, gate: (c as { gate?: string }).gate ?? 'red', output_sha256: c.output_sha256 })),
      { criterion: 'AC-5', test_id: green.tests.find((x) => x.full_name === CLI_JOURNAL_STATUS_TEST)!.id, gate: 'green', output_sha256: green.sha256 },
    ]);
    expect(await check(s, t)).toMatchObject({ ok: true });
    const done = await settle(s, t);
    expect(done, done.detail).toMatchObject({ outcome: 'DONE' });
    // One test-only commit: no production, no RED of its own.
    expect(git(s.repo, ['rev-list', `${base}..${unit}`]).split('\n').filter(Boolean)).toEqual([unit]);
    state = verState(s);
    expect(state.nodes[CLI].tdd_history).toMatchObject({ ok: true, cycles: 0, compatibility_units: 1 });
    expect(state.nodes[CLI].criteria).toEqual(expect.arrayContaining([expect.objectContaining({ criterion: 'AC-3', carried: true }), expect.objectContaining({ criterion: 'AC-4', carried: true }), expect.objectContaining({ criterion: 'AC-5', gate: 'green' })]));
    // No RED of this generation: feature verify accepts the compatibility-only generation as it settled.
    expect(state.nodes[CLI].evidence.red).toBeUndefined();
    commitVerControl(s, 'cli: AC-5 regression test');
    const verify = JSON.parse((await verCli(s, ['feature', 'verify', VER_FEATURE, '--json'])).out) as { problems: string[] };
    expect(verify.problems.filter((p) => p.includes(CLI))).toEqual([]);
  });

  it('a red gate run by mistake there, whose test passes, records no RED for the generation', async () => {
    const s = await reviewed({ 'AC-5': GAP_AC5 });
    const t = (await dispatch(s)).ticket!;
    writeFiles(t.worktree, { [CLI_TESTS]: `${git(t.worktree, ['show', `HEAD:${CLI_TESTS}`])}\n${CLI_COMPAT_TEST_BODY}` });
    const red = runGate(t, 'red', s.control);
    expect(red.code).not.toBe(0);
    expect(verState(s).nodes[CLI].evidence.red).toBeUndefined();
    commitCompat(t.worktree, [CLI_TESTS], 'AC-5');
    expect(runGate(t, 'green', s.control).code).toBe(0);
  });
});
