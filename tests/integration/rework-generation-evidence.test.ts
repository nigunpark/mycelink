/**
 * A rework starts a new generation of the node's evidence.
 *
 * CSET-203 r4: the cli, reworked by R001 for AC-3 and AC-5, kept AC-4's proof
 * from the work its rework replaced, and a compatibility-only rework kept the
 * replaced RED as the node's active RED. Old gate evidence carried the old
 * claim and generation into the new one's TDD state. Now:
 *
 *  - the rework archives everything the replaced generation was gated and
 *    settled with (gate outputs, the judged history, the RED bindings, the
 *    accepted criteria, the settlement receipt), bound to that generation
 *    and its claim, and the new generation starts with no active gate,
 *    history, binding, criterion or receipt;
 *  - a new behaviour the rework does not name keeps a carried criterion
 *    proof (criterion, test, source generation and claim, repository commit,
 *    output hash), never an active gate; settle re-runs its test on the new
 *    head and records a fresh proof of this generation;
 *  - a criterion the rework names needs this generation's evidence: an old
 *    proof cited for it, or a carried one cited otherwise than recorded, is
 *    refused; the replaced generation's capability settles nothing.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { git } from '../helpers/git-fixture.js';
import {
  CLI,
  CLI_COMPAT_FILE,
  CLI_COMPAT_TESTS,
  CLI_COMPAT_TEST_BODY,
  CLI_COMPAT_TEST_ID,
  CLI_FAILURE_TEST,
  CLI_JOURNAL_STATUS_TEST,
  CLI_RECOVERY_TEST,
  CLI_SRC,
  CLI_TESTS,
  CLI_TRUNCATED_IMPL,
  CLI_TRUNCATED_RED,
  CLI_TRUNCATED_TEST,
  VER_FEATURE,
  commitVerControl,
  verCli,
  verCliTestId,
  verState,
  type Ver,
} from '../helpers/version-fixture.js';
import { commit, packOf, runGate, writeFiles, type ShopTicket } from '../helpers/shop-worker.js';
import { GAP_AC1, GAP_AC3, GAP_AC5, carriedItems, check, commitCompat, dispatch, repairArp, reviewed, settle, tddClaim, writeResult } from '../helpers/cset203-rework.js';

afterAll(() => cleanupTmpRoots());

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

/** The cli's rework done right: AC-3's RED cycle, then AC-5's regression test in a file of its own, after the code. */
function repairCli(t: ShopTicket, control: string): { red: ReturnType<typeof runGate>; green: ReturnType<typeof runGate> } {
  writeFiles(t.worktree, { [CLI_TESTS]: CLI_TRUNCATED_RED });
  const red = runGate(t, 'red', control);
  expect(red.code, red.out).toBe(0);
  commit(t.worktree, [CLI_TESTS], 'test(cli): AC-3 a journal cut short by a kill is recovered from');
  writeFiles(t.worktree, { [CLI_SRC]: CLI_TRUNCATED_IMPL });
  expect(runGate(t, 'green', control).code).toBe(0);
  commit(t.worktree, [CLI_SRC], 'fix(cli): a journal cut short by a kill changed nothing yet; remove it');
  writeFiles(t.worktree, { [CLI_COMPAT_TESTS]: CLI_COMPAT_FILE });
  commitCompat(t.worktree, [CLI_COMPAT_TESTS], 'AC-5');
  const green = runGate(t, 'green', control);
  expect(green.code, green.out).toBe(0);
  expect(runGate(t, 'regression', control).code).toBe(0);
  return { red, green };
}

describe('a rework archives the replaced generation and starts the next with no active gate', () => {
  it("the cli's gen-0 gates, history, RED bindings, criteria and receipt go to its history entry, bound to that generation and claim; AC-4 is a carried proof, never an active RED", async () => {
    const s = await reviewed({ 'AC-1': GAP_AC1, 'AC-3': GAP_AC3, 'AC-5': GAP_AC5 });
    const rt = verState(s).nodes[CLI];
    expect(rt).toMatchObject({ state: 'INVALIDATED', rework_brief: { generation: 1, acceptance_criteria: ['AC-3', 'AC-5'] } });
    // Nothing of generation 0 is active in generation 1.
    expect(rt.evidence).toEqual({});
    expect(rt.criteria ?? []).toEqual([]);
    expect(rt.tdd_history ?? null).toBeNull();
    expect(rt.tdd_red_bindings ?? []).toEqual([]);
    expect(rt.last_settlement ?? null).toBeNull();
    // Everything it was gated and settled with, archived with the generation and the claim that settled it.
    const entry = rt.rework_history.at(-1);
    expect(entry).toMatchObject({ generation: 0, claim_id: expect.any(String), dispatch_id: expect.any(String), integrated_sha: expect.stringMatching(/^[0-9a-f]{40}$/) });
    expect(entry.criteria.map((c: { criterion: string; gate: string }) => [c.criterion, c.gate])).toEqual([['AC-3', 'red'], ['AC-4', 'red'], ['AC-5', 'green']]);
    expect(entry.tdd_history).toMatchObject({ ok: true, cycles: 1, output_path: expect.stringMatching(/\/replaced\/g1\//) });
    expect(sha256(readFileSync(join(s.control, entry.tdd_history.output_path)))).toBe(entry.tdd_history.output_sha256);
    expect(entry.red_bindings.length).toBeGreaterThan(0);
    expect(entry.settlement).toMatchObject({ claim_id: entry.claim_id, outcome: 'DONE' });
    expect(entry.evidence.red.output_path).toMatch(/\/replaced\/g1\//);
    // AC-4, a new behaviour R001 did not name: a carried proof of generation 0, apart from the gates. AC-3, which R001
    // names again: its completed proof, re-provable (CSET-203 r16), never an active gate. Each the completion record it is.
    const ac3 = entry.criteria.find((c: { criterion: string }) => c.criterion === 'AC-3');
    const ac4 = entry.criteria.find((c: { criterion: string }) => c.criterion === 'AC-4');
    const proof = (criterion: string, test: string, output: string): Record<string, unknown> => ({
      criterion,
      test_id: verCliTestId(test),
      test: { path: CLI_TESTS, name: test },
      source_generation: 0,
      source_claim_id: entry.claim_id,
      source_dispatch_id: entry.dispatch_id,
      repo_sha: entry.integrated_sha,
      gate: 'red',
      output_sha256: output,
      output_path: entry.evidence.red.output_path,
      record_id: expect.stringMatching(/^CC-[0-9a-f]{16}$/),
      record_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(rt.carried_criterion_proofs).toEqual([{ ...proof('AC-3', CLI_RECOVERY_TEST, ac3.output_sha256), ordered: true }, proof('AC-4', CLI_FAILURE_TEST, ac4.output_sha256)]);
    // Generation 0's completions, recorded when it settled: the records those proofs name.
    const ledger = rt.criterion_ledger as { record_id: string; criterion: string; generation: number; basis: string }[];
    expect(ledger.map((r) => [r.criterion, r.generation, r.basis])).toEqual([['AC-3', 0, 'red'], ['AC-4', 0, 'red'], ['AC-5', 0, 'compatibility']]);
    expect(rt.carried_criterion_proofs.map((p: { record_id: string }) => p.record_id)).toEqual([ledger[0]?.record_id, ledger[1]?.record_id]);
    // The worker of generation 1 is told so: no RED on record, its own RED next, AC-4 carried as data.
    await repairArp(s);
    const t = (await dispatch(s)).ticket!;
    expect(t.node_id).toBe(CLI);
    const pack = packOf(t);
    expect(pack['latest_evidence']).toEqual([]);
    expect(pack['next_required_gate']).toBe('RED_VERIFIED');
    expect(pack['rework']['carried_criteria']).toEqual([{ criterion: 'AC-4', test_id: verCliTestId(CLI_FAILURE_TEST), gate: 'red', output_sha256: ac4.output_sha256, source_generation: 0, test: { path: CLI_TESTS, name: CLI_FAILURE_TEST } }]);
  });

  it("the replaced generation's capability settles nothing and runs no gate once the node is reworked", async () => {
    const s = await reviewed({ 'AC-3': GAP_AC3 });
    const old = s.first.cli;
    const answer = await settle(s, old);
    // Never its old DONE receipt: that generation is history.
    expect(answer.outcome).not.toBe('DONE');
    // Its lineage moved with the rework: stale (CSET-203 r7), nothing settled under it.
    expect(answer.outcome).toBe('STALE_ORCHESTRATION_EPOCH');
    expect(answer.detail).toMatch(/STALE_ORCHESTRATION_EPOCH/);
    const gate = runGate(old, 'green', s.control);
    expect(gate.code).not.toBe(0);
    expect(gate.out).toMatch(/NOT_CLAIMED|CAPABILITY_INVALID/);
  });
});

describe("generation 1's settle re-runs every carried proof on its own head", () => {
  it('AC-4 carried from generation 0 settles as a fresh proof of generation 1: its test passed by the fresh verification at the sealed head, with where it came from', async () => {
    const s = await reviewed({ 'AC-1': GAP_AC1, 'AC-3': GAP_AC3, 'AC-5': GAP_AC5 });
    await repairArp(s);
    const t = (await dispatch(s)).ticket!;
    const gen0 = verState(s).nodes[CLI].rework_history.at(-1);
    const { red, green } = repairCli(t, s.control);
    writeResult(
      t,
      [
        { criterion: 'AC-3', test_id: red.tests.find((x) => x.full_name === CLI_TRUNCATED_TEST)!.id, gate: 'red', output_sha256: red.sha256 },
        ...carriedItems(t),
        { criterion: 'AC-5', test_id: CLI_COMPAT_TEST_ID, gate: 'green', output_sha256: green.sha256 },
      ],
      tddClaim(t, [{ red: [0], green: [1] }]),
    );
    expect(await check(s, t)).toMatchObject({ ok: true });
    const done = await settle(s, t);
    expect(done, done.detail).toMatchObject({ outcome: 'DONE' });
    const rt = verState(s).nodes[CLI];
    expect(rt.tdd_history).toMatchObject({ ok: true, cycles: 1, compatibility_units: 1 });
    const ac4 = rt.criteria.find((c: { criterion: string }) => c.criterion === 'AC-4');
    // Fresh: the output of a gate this generation recorded at its head, never generation 0's RED.
    expect(ac4).toMatchObject({ test_id: verCliTestId(CLI_FAILURE_TEST), carried: true, carried_from: { generation: 0, gate: 'red', output_sha256: gen0.criteria.find((c: { criterion: string }) => c.criterion === 'AC-4').output_sha256, claim_id: gen0.claim_id } });
    expect(['green', 'regression']).toContain(ac4.gate);
    expect(ac4.output_sha256).toBe(rt.evidence[ac4.gate].output_sha256);
    // ...run at the head settle sealed.
    expect(rt.evidence[ac4.gate].commit_sha).toBe(rt.tdd_history.head_sha);
    const archived = new Set(rt.rework_history.flatMap((h: { evidence: Record<string, { output_sha256: string }> }) => Object.values(h.evidence).map((e) => e.output_sha256)));
    for (const c of rt.criteria as { criterion: string; output_sha256: string }[]) expect(archived.has(c.output_sha256), `${c.criterion} cites an archived output`).toBe(false);
    commitVerControl(s, 'cli: generation 1');
    const verify = JSON.parse((await verCli(s, ['feature', 'verify', VER_FEATURE, '--json'])).out) as { problems: string[] };
    expect(verify.problems.filter((p) => p.includes(CLI))).toEqual([]);
  });
});

describe('a compatibility-only rework proves its generation without any RED', () => {
  it('no RED is active, none is required: the regression test alone, green and regression, cycles [] claimed, settled DONE; AC-3 and AC-4 carried and freshly proved', async () => {
    const s = await reviewed({ 'AC-5': GAP_AC5 });
    let rt = verState(s).nodes[CLI];
    expect(rt).toMatchObject({ state: 'INVALIDATED', rework_brief: { acceptance_criteria: ['AC-5'] } });
    expect(rt.evidence).toEqual({});
    expect(rt.carried_criterion_proofs.map((c: { criterion: string }) => c.criterion)).toEqual(['AC-3', 'AC-4']);
    const t = (await dispatch(s)).ticket!;
    expect(t.node_id).toBe(CLI);
    const pack = packOf(t);
    expect(pack['next_required_gate']).toBe('GREEN_VERIFIED');
    expect(pack['latest_evidence']).toEqual([]);
    expect(pack['rework']).toMatchObject({ acceptance_criteria: ['AC-5'], compatibility: ['AC-5'] });
    expect(t.prompt).toMatch(/no red gate/i);
    // No RED of this generation binds the cli's test file: the test may go there, alone, after the code in its base.
    writeFiles(t.worktree, { [CLI_TESTS]: `${git(t.worktree, ['show', `HEAD:${CLI_TESTS}`])}\n${CLI_COMPAT_TEST_BODY}` });
    commitCompat(t.worktree, [CLI_TESTS], 'AC-5');
    const green = runGate(t, 'green', s.control);
    expect(green.code, green.out).toBe(0);
    expect(runGate(t, 'regression', s.control).code).toBe(0);
    writeResult(t, [...carriedItems(t), { criterion: 'AC-5', test_id: green.tests.find((x) => x.full_name === CLI_JOURNAL_STATUS_TEST)!.id, gate: 'green', output_sha256: green.sha256 }], tddClaim(t, []));
    expect(await check(s, t)).toMatchObject({ ok: true });
    const done = await settle(s, t);
    expect(done, done.detail).toMatchObject({ outcome: 'DONE' });
    rt = verState(s).nodes[CLI];
    expect(rt.tdd_history).toMatchObject({ ok: true, cycles: 0, compatibility_units: 1 });
    expect(rt.evidence.red).toBeUndefined();
    for (const ac of ['AC-3', 'AC-4']) {
      const c = rt.criteria.find((x: { criterion: string }) => x.criterion === ac);
      expect(c, ac).toMatchObject({ carried: true, carried_from: { generation: 0, gate: 'red' } });
      expect(c.output_sha256).toBe(rt.evidence[c.gate].output_sha256);
    }
    commitVerControl(s, 'cli: AC-5 regression test');
    const verify = JSON.parse((await verCli(s, ['feature', 'verify', VER_FEATURE, '--json'])).out) as { problems: string[] };
    expect(verify.problems.filter((p) => p.includes(CLI))).toEqual([]);
  });

  it('a red gate run by mistake there, whose test passes, is refused and changes nothing the generation needs', async () => {
    const s = await reviewed({ 'AC-5': GAP_AC5 });
    const t = (await dispatch(s)).ticket!;
    writeFiles(t.worktree, { [CLI_TESTS]: `${git(t.worktree, ['show', `HEAD:${CLI_TESTS}`])}\n${CLI_COMPAT_TEST_BODY}` });
    const red = runGate(t, 'red', s.control);
    expect(red.code).not.toBe(0);
    commitCompat(t.worktree, [CLI_TESTS], 'AC-5');
    expect(runGate(t, 'green', s.control).code).toBe(0);
  });
});

describe('forged or stale carries are refused', () => {
  async function cliRework(): Promise<{ s: Ver; t: ShopTicket; red: ReturnType<typeof runGate>; green: ReturnType<typeof runGate>; gen0: Record<string, any> }> {
    const s = await reviewed({ 'AC-1': GAP_AC1, 'AC-3': GAP_AC3, 'AC-5': GAP_AC5 });
    await repairArp(s);
    const t = (await dispatch(s)).ticket!;
    const gen0 = verState(s).nodes[CLI].rework_history.at(-1);
    return { s, t, gen0, ...repairCli(t, s.control) };
  }

  it("AC-3, named by the rework, cited with generation 0's RED alone: its completed proof is no proof of the review's gap (CRITERION_REPROOF_REQUIRED), held for correction, nothing charged", async () => {
    const { s, t, green, gen0 } = await cliRework();
    const stale = gen0.criteria.find((c: { criterion: string }) => c.criterion === 'AC-3');
    writeResult(t, [{ criterion: 'AC-3', test_id: verCliTestId(CLI_RECOVERY_TEST), gate: 'red', output_sha256: stale.output_sha256 }, ...carriedItems(t), { criterion: 'AC-5', test_id: CLI_COMPAT_TEST_ID, gate: 'green', output_sha256: green.sha256 }]);
    expect(await check(s, t)).toMatchObject({ ok: false, code: 'CRITERION_REPROOF_REQUIRED', criterion: 'AC-3' });
    const held = await settle(s, t);
    expect(held.outcome).toBe('EVIDENCE_CORRECTION_REQUIRED');
    expect(held.detail).toMatch(/CRITERION_REPROOF_REQUIRED/);
    expect(verState(s).nodes[CLI].failure_counts).toEqual({});
  });

  it("an old output of generation 0 cited for AC-3 that is not its completed proof is still a stale proof", async () => {
    const { s, t, green, gen0 } = await cliRework();
    writeResult(t, [{ criterion: 'AC-3', test_id: verCliTestId(CLI_RECOVERY_TEST), gate: 'green', output_sha256: gen0.evidence.green.output_sha256 }, ...carriedItems(t), { criterion: 'AC-5', test_id: CLI_COMPAT_TEST_ID, gate: 'green', output_sha256: green.sha256 }]);
    expect(await check(s, t)).toMatchObject({ ok: false, code: 'CRITERION_STALE_PROOF', criterion: 'AC-3' });
    expect(verState(s).nodes[CLI].failure_counts).toEqual({});
  });

  it("AC-4 cited with generation 0's GREEN output instead of its carried proof: CRITERION_STALE_PROOF", async () => {
    const { s, t, red, green, gen0 } = await cliRework();
    writeResult(t, [
      { criterion: 'AC-3', test_id: red.tests.find((x) => x.full_name === CLI_TRUNCATED_TEST)!.id, gate: 'red', output_sha256: red.sha256 },
      { criterion: 'AC-4', test_id: verCliTestId(CLI_FAILURE_TEST), gate: 'green', output_sha256: gen0.evidence.green.output_sha256 },
      { criterion: 'AC-5', test_id: CLI_COMPAT_TEST_ID, gate: 'green', output_sha256: green.sha256 },
    ]);
    expect(await check(s, t)).toMatchObject({ ok: false, code: 'CRITERION_STALE_PROOF', criterion: 'AC-4' });
  });

  it("a carried proof whose archived output no longer hashes as recorded proves nothing", async () => {
    const { s, t, red, green } = await cliRework();
    const proof = verState(s).nodes[CLI].carried_criterion_proofs[0];
    appendFileSync(join(s.control, proof.output_path), '\nforged\n');
    writeResult(t, [{ criterion: 'AC-3', test_id: red.tests.find((x) => x.full_name === CLI_TRUNCATED_TEST)!.id, gate: 'red', output_sha256: red.sha256 }, ...carriedItems(t), { criterion: 'AC-5', test_id: CLI_COMPAT_TEST_ID, gate: 'green', output_sha256: green.sha256 }]);
    expect(await check(s, t)).toMatchObject({ ok: false, code: 'CRITERION_EVIDENCE_UNBOUND', criterion: 'AC-4' });
  });
});
