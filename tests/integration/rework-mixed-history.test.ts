/**
 * A rework that names a new behaviour and a compatibility criterion at once
 * (CSET-203 r4's cli: AC-3 and AC-5 from R001).
 *
 * r4's two cli workers each lost an attempt to the order of their commits:
 * the first ran the red gate with AC-5's regression file beside AC-3's test,
 * committed it first with the compatibility trailer and claimed only AC-3's
 * commit as the RED (TDD_CLAIM_MISMATCH); the second committed AC-5's file
 * between AC-3's RED commit and the code (CHANGED_RED_BLOBS at 49a5357).
 * Appending AC-5's test after the code to the very file AC-3's RED bound
 * changes the RED's blob too. The contract, held by settle (and by `tdd
 * check` before a submission, the brief and the plugin's hook):
 *
 *  - every new-behaviour RED test before the production code, the RED-bound
 *    files byte-identical from the RED on;
 *  - a compatibility-regression test after the code goes into a test file
 *    no RED of the history bound, alone, with its trailer, green again;
 *  - a test that belongs in a RED-bound file goes in before the red gate,
 *    or starts a new complete RED cycle.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { git } from '../helpers/git-fixture.js';
import {
  CLI,
  CLI_COMPAT_FILE,
  CLI_COMPAT_TESTS,
  CLI_COMPAT_TEST_BODY,
  CLI_COMPAT_TEST_ID,
  CLI_JOURNAL_STATUS_TEST,
  CLI_SRC,
  CLI_TESTS,
  CLI_TRUNCATED_IMPL,
  CLI_TRUNCATED_RED,
  CLI_TRUNCATED_TEST,
  VER_FEATURE,
  commitVerControl,
  verCli,
  verState,
  type Ver,
} from '../helpers/version-fixture.js';
import { commit, packOf, runGate, writeFiles, type GateRun, type ShopTicket } from '../helpers/shop-worker.js';
import { GAP_AC1, GAP_AC3, GAP_AC5, carriedItems, check, commitCompat, dispatch, repairArp, reviewed, settle, tddClaim, writeResult } from '../helpers/cset203-rework.js';

afterAll(() => cleanupTmpRoots());

/** R001's three gaps settled, apply-release-plan repaired: the cli's rework ticket (generation 1, AC-3 and AC-5). */
async function cliTicket(): Promise<{ s: Ver; t: ShopTicket }> {
  const s = await reviewed({ 'AC-1': GAP_AC1, 'AC-3': GAP_AC3, 'AC-5': GAP_AC5 });
  await repairArp(s);
  const t = (await dispatch(s)).ticket!;
  expect(t.node_id).toBe(CLI);
  return { s, t };
}

const ac3 = (red: GateRun): Record<string, unknown> => ({ criterion: 'AC-3', test_id: red.tests.find((x) => x.full_name === CLI_TRUNCATED_TEST)!.id, gate: 'red', output_sha256: red.sha256 });

/** AC-3's focused test through the red gate, committed alone; the fix through green, committed alone. */
function ac3Cycle(t: ShopTicket, control: string): GateRun {
  writeFiles(t.worktree, { [CLI_TESTS]: CLI_TRUNCATED_RED });
  const red = runGate(t, 'red', control);
  expect(red.code, red.out).toBe(0);
  commit(t.worktree, [CLI_TESTS], 'test(cli): AC-3 a journal cut short by a kill is recovered from');
  writeFiles(t.worktree, { [CLI_SRC]: CLI_TRUNCATED_IMPL });
  expect(runGate(t, 'green', control).code).toBe(0);
  commit(t.worktree, [CLI_SRC], 'fix(cli): a journal cut short by a kill changed nothing yet; remove it');
  return red;
}

describe("the cli's AC-3 + AC-5 rework: r4's histories refused, before the submission and at settle", () => {
  it('AC-5 appended after the code to the test file AC-3\'s RED bound: CHANGED_RED_BLOBS, the file named; the attempt is charged and the next one told why', async () => {
    const { s, t } = await cliTicket();
    const red = ac3Cycle(t, s.control);
    writeFiles(t.worktree, { [CLI_TESTS]: CLI_TRUNCATED_RED + CLI_COMPAT_TEST_BODY });
    commitCompat(t.worktree, [CLI_TESTS], 'AC-5');
    const green = runGate(t, 'green', s.control);
    expect(green.code, green.out).toBe(0);
    expect(runGate(t, 'regression', s.control).code).toBe(0);
    writeResult(t, [ac3(red), ...carriedItems(t), { criterion: 'AC-5', test_id: green.tests.find((x) => x.full_name === CLI_JOURNAL_STATUS_TEST)!.id, gate: 'green', output_sha256: green.sha256 }], tddClaim(t, [{ red: [0], green: [1] }]));
    // The worker's own check judges the history as settle will.
    expect(await check(s, t)).toMatchObject({ ok: false, code: 'CHANGED_RED_BLOBS', paths: [CLI_TESTS] });
    const refused = await settle(s, t);
    expect(refused.outcome).toBe('TDD_HISTORY_INVALID');
    expect(refused.detail).toMatch(/CHANGED_RED_BLOBS/);
    expect(refused.detail).toContain(CLI_TESTS);
    const rt = verState(s).nodes[CLI];
    expect(rt).toMatchObject({ state: 'READY', failure_counts: { 'TDD_HISTORY_INVALID:CHANGED_RED_BLOBS': 1 }, tdd_rejection: { code: 'CHANGED_RED_BLOBS' } });
    commitVerControl(s, 'refused');
    const next = (await dispatch(s)).ticket!;
    expect(next.node_id).toBe(CLI);
    expect(packOf(next)['tdd']['rejection']).toMatchObject({ code: 'CHANGED_RED_BLOBS' });
    expect(packOf(next)['budget']).toMatchObject({ attempt: 2, max_attempts: 2 });
  });

  it("r4's second attempt: AC-5's file committed between AC-3's RED commit and the code is not what the red gate ran", async () => {
    const { s, t } = await cliTicket();
    writeFiles(t.worktree, { [CLI_TESTS]: CLI_TRUNCATED_RED });
    const red = runGate(t, 'red', s.control);
    expect(red.code, red.out).toBe(0);
    commit(t.worktree, [CLI_TESTS], 'test(cli): AC-3');
    writeFiles(t.worktree, { [CLI_COMPAT_TESTS]: CLI_COMPAT_FILE });
    commitCompat(t.worktree, [CLI_COMPAT_TESTS], 'AC-5');
    writeFiles(t.worktree, { [CLI_SRC]: CLI_TRUNCATED_IMPL });
    const green = runGate(t, 'green', s.control);
    expect(green.code, green.out).toBe(0);
    commit(t.worktree, [CLI_SRC], 'fix(cli): AC-3');
    expect(runGate(t, 'regression', s.control).code).toBe(0);
    writeResult(t, [ac3(red), ...carriedItems(t), { criterion: 'AC-5', test_id: CLI_COMPAT_TEST_ID, gate: 'green', output_sha256: green.sha256 }], tddClaim(t, [{ red: [0, 1], green: [2] }]));
    expect(await check(s, t)).toMatchObject({ ok: false, code: 'CHANGED_RED_BLOBS', paths: [CLI_COMPAT_TESTS] });
    const refused = await settle(s, t);
    expect(refused.outcome).toBe('TDD_HISTORY_INVALID');
    expect(refused.detail).toMatch(/CHANGED_RED_BLOBS/);
  });

  it("r4's first attempt: AC-5's file under the red gate beside AC-3's test, committed first with a trailer, and a claim naming only AC-3's commit: tdd check says TDD_CLAIM_MISMATCH before settle does", async () => {
    const { s, t } = await cliTicket();
    writeFiles(t.worktree, { [CLI_TESTS]: CLI_TRUNCATED_RED, [CLI_COMPAT_TESTS]: CLI_COMPAT_FILE });
    const red = runGate(t, 'red', s.control);
    expect(red.code, red.out).toBe(0);
    commitCompat(t.worktree, [CLI_COMPAT_TESTS], 'AC-5');
    commit(t.worktree, [CLI_TESTS], 'test(cli): AC-3');
    writeFiles(t.worktree, { [CLI_SRC]: CLI_TRUNCATED_IMPL });
    const green = runGate(t, 'green', s.control);
    commit(t.worktree, [CLI_SRC], 'fix(cli): AC-3');
    expect(runGate(t, 'regression', s.control).code).toBe(0);
    const evidence = [ac3(red), ...carriedItems(t), { criterion: 'AC-5', test_id: CLI_COMPAT_TEST_ID, gate: 'green', output_sha256: green.sha256 }];
    writeResult(t, evidence, tddClaim(t, [{ red: [1], green: [2] }]));
    const report = await check(s, t);
    expect(report).toMatchObject({ ok: false, code: 'TDD_CLAIM_MISMATCH' });
    expect(report['detail']).toMatch(/RED commits/);
    // The history itself is a valid cycle: both files are its RED (bound by the gate, byte-identical since). Claimed as it is, it settles.
    writeResult(t, evidence, tddClaim(t, [{ red: [0, 1], green: [2] }]));
    expect(await check(s, t)).toMatchObject({ ok: true });
    const done = await settle(s, t);
    expect(done, done.detail).toMatchObject({ outcome: 'DONE' });
    expect(verState(s).nodes[CLI].tdd_history).toMatchObject({ ok: true, cycles: 1, compatibility_units: 0 });
  });

  it('the corrected history: AC-3\'s cycle, then AC-5 alone in a new test file after the code; settled DONE with AC-4 carried and freshly proved', async () => {
    const { s, t } = await cliTicket();
    const red = ac3Cycle(t, s.control);
    writeFiles(t.worktree, { [CLI_COMPAT_TESTS]: CLI_COMPAT_FILE });
    commitCompat(t.worktree, [CLI_COMPAT_TESTS], 'AC-5');
    const green = runGate(t, 'green', s.control);
    expect(green.code, green.out).toBe(0);
    expect(green.tests.find((x) => x.id === CLI_COMPAT_TEST_ID)).toMatchObject({ status: 'passed' });
    expect(runGate(t, 'regression', s.control).code).toBe(0);
    writeResult(t, [ac3(red), ...carriedItems(t), { criterion: 'AC-5', test_id: CLI_COMPAT_TEST_ID, gate: 'green', output_sha256: green.sha256 }], tddClaim(t, [{ red: [0], green: [1] }]));
    expect(await check(s, t)).toMatchObject({ ok: true });
    const done = await settle(s, t);
    expect(done, done.detail).toMatchObject({ outcome: 'DONE' });
    const rt = verState(s).nodes[CLI];
    expect(rt.tdd_history).toMatchObject({ ok: true, cycles: 1, compatibility_units: 1 });
    expect(rt.criteria.find((c: { criterion: string }) => c.criterion === 'AC-4')).toMatchObject({ carried: true, carried_from: { generation: 0 } });
    expect(rt.criteria.find((c: { criterion: string }) => c.criterion === 'AC-5')).toMatchObject({ gate: 'green', test_id: CLI_COMPAT_TEST_ID });
  });
});

describe('the RED-bound files, named to the worker', () => {
  it('the red gate and the pack of a resumed ticket name each RED-bound file with its blob, to stay byte-identical', async () => {
    const { s, t } = await cliTicket();
    writeFiles(t.worktree, { [CLI_TESTS]: CLI_TRUNCATED_RED });
    const red = runGate(t, 'red', s.control);
    expect(red.code, red.out).toBe(0);
    const blob = git(t.worktree, ['hash-object', CLI_TESTS]);
    expect(red.out).toMatch(/RED-bound/);
    expect(red.out).toContain(`${CLI_TESTS} ${blob}`);
    commitVerControl(s, 'red');
    const resumed = JSON.parse((await verCli(s, ['dispatch', VER_FEATURE, '--resume', CLI, '--json'])).out) as { status: string; ticket: ShopTicket };
    expect(resumed.status, JSON.stringify(resumed)).toBe('DISPATCHED');
    expect(packOf(resumed.ticket)['tdd']['red_bound_paths']).toEqual([{ path: CLI_TESTS, blob }]);
    // A fresh claim on a fresh branch has none.
    expect(packOf(t)['tdd']['red_bound_paths']).toBeUndefined();
  });

  it("the brief of a rework naming a new behaviour and a compatibility criterion orders them: RED tests before the code, RED-bound files untouched after, AC-5 in a new test file", async () => {
    const { t } = await cliTicket();
    const brief = t.prompt;
    expect(brief).toMatch(/AC-3 \(new behavior\)/);
    expect(brief).toMatch(/AC-5 \(compatibility\)/);
    expect(brief).toMatch(/every new-behavior RED test[^.]*before[^.]*production/i);
    expect(brief).toMatch(/never (?:change|edit|modify) a RED-bound (?:test )?file/i);
    expect(brief).toMatch(/new test file/i);
    expect(brief).toMatch(/before (?:you run )?the red gate/i);
    expect(brief).toMatch(/new complete RED cycle/i);
    expect(brief).toMatch(/tdd cycle/);
  });
});
