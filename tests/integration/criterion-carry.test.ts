/**
 * Completed criteria carried across a review revision, a restart and a
 * concurrent commit, and settled criterion by criterion (CSET-203 r16, the
 * fault arm).
 *
 * r16: the cli's first generation completed AC-3 (its RED failed for the
 * missing recovery, then the fix), AC-4 and AC-5 at the integrated head. R001
 * — its first reviewer lost with its host and re-issued — found AC-1 on
 * apply-release-plan, AC-3 (its tests too narrow) and AC-5 on the cli. The
 * refinement withdrew the sibling's challenged AC-1 and rebased the cli's
 * order, untouched, to revision 1. The cli's worker found R001's exact AC-3
 * reproduction already passing (its first generation's fix holds it), kept it
 * out of the branch and committed AC-5's compatibility unit: 0 RED cycles, 1
 * compatibility unit. Settle demanded a RED of this generation for the whole
 * node and charged INVALID_RED_EVIDENCE twice: BLOCKED, no candidate — an
 * administrative carry failure, never a product one.
 *
 * Here, on the version fixture with r16's shape (the teammate's commit merged
 * by the first integration; the reviewer interrupted and re-issued; the
 * sibling's challenge withdrawn):
 *
 *  - r16's own answer (AC-3 BLOCKED for its reason, AC-5 DONE) settles AC-5
 *    with the node's carried RED: nothing charged; AC-3 ordered again alone;
 *  - the answer the protocol allows now — AC-3 DONE by its completed proof
 *    and the reproduction its red gate passed (a re-proof), AC-5 DONE by its
 *    unit — settles DONE, as a per-criterion answer and as a legacy one; the
 *    check line agrees; each completion is recorded once, its lineage to the
 *    RED that completed it; an interrupted settle finishes it once;
 *  - a re-proof is never a RED and never alone (its completed proof is cited
 *    with it); production code behind carried proofs is refused; a tampered
 *    completion is never carried; a challenge beside a compatibility unit
 *    binds with its focused test kept out of the branch.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { git } from '../helpers/git-fixture.js';
import { CLI, CLI_COMPAT_FILE, CLI_COMPAT_TESTS, CLI_FAILURE_TEST, CLI_JOURNAL_STATUS_TEST, CLI_RECOVERY_TEST, CLI_SRC, CLI_TESTS, CLI_TRUNCATED_IMPL, VER_FEATURE, commitVerControl, verCli, verCliTestId, verState, type Ver } from '../helpers/version-fixture.js';
import { commit, runGate, writeFiles, type ShopTicket } from '../helpers/shop-worker.js';
import { check, commitCompat, dispatch, settle } from '../helpers/cset203-rework.js';
import { cliAc3Clauses } from '../helpers/cset203-r14.js';
import { CLI_AC3_HOLDS_TEST, CLI_R16_REPRODUCTION, R001, cite, compatContinuation, eventsOf, ledgerOf, nothingCharged, r16Answer, r16Reviewed, reproofAnswer, reworkOf, withdrawSibling, writeAnswer, type Continuation, type R16 } from '../helpers/cset203-r16.js';
import { Orchestrator, type SettleFaultPoint } from '../../src/engine/orchestrator.js';
import type { SessionAdapter } from '../../src/sessions/adapter.js';
import { mutateState } from '../../src/state/feature-state.js';

afterAll(() => cleanupTmpRoots());

const crashing = (s: Ver, point: SettleFaultPoint): Orchestrator =>
  new Orchestrator({ controlRoot: s.control, featureId: VER_FEATURE, adapter: {} as SessionAdapter, settleFault: (p: SettleFaultPoint) => { if (p === point) throw new Error(`CRASH at ${p}`); } });

/** r16 up to the cli's continuation ticket: R001 (reviewer lost and re-issued), the sibling's AC-1 challenged and withdrawn, the cli's order rebased to revision 1. */
async function r16Continuation(): Promise<{ s: R16; t: ShopTicket; attempts: number }> {
  const s = await r16Reviewed();
  let state = verState(s);
  expect(state.acceptance_review.reviews[0]).toMatchObject({ review_id: R001, outcome: 'GAPS' });
  expect(state.nodes[CLI].rework_brief).toMatchObject({ acceptance_criteria: ['AC-3', 'AC-5'] });
  await withdrawSibling(s);
  state = verState(s);
  // The cli's order rebased, untouched, from revision 0 to revision 1 (r16's rebase).
  expect(state.nodes[CLI].rework_brief).toMatchObject({ acceptance_criteria: ['AC-3', 'AC-5'], origin: { review_id: R001, revision: 1 }, rebases: [expect.objectContaining({ from: expect.objectContaining({ revision: 0 }), to: expect.objectContaining({ revision: 1 }), criteria: ['AC-3', 'AC-5'] })] });
  const attempts = state.nodes[CLI].attempts as number;
  const d = await dispatch(s);
  expect(d.status, d.detail).toBe('DISPATCHED');
  const t = d.ticket!;
  expect(t.node_id).toBe(CLI);
  return { s, t, attempts };
}

/** What the cli's DONE generation must hold after its continuation settled, however it was answered. */
function expectCarriedDone(s: Ver, attempts: number): void {
  const state = verState(s);
  const cli = state.nodes[CLI];
  // One product attempt for the continuation; nothing charged for the carry.
  expect(cli).toMatchObject({ state: 'DONE', attempts: attempts + 1, failure_counts: {}, blocked_reason: null, claim: null });
  nothingCharged(s);
  // The generation ran no RED: the node's RED is AC-3's, carried from the generation that completed it.
  expect(cli.evidence.red).toMatchObject({ exit_code: 1, red_reason: 'behaviour-missing', carried_from: { criterion: 'AC-3', generation: 0 } });
  // AC-5's unit integrated, and R001's AC-3 reproduction too (CSET-201 final): committed by settle as a re-proof unit on top of
  // the worker's head, exactly as the red gate ran it — so every later head holds the proof the review passes AC-3 on.
  const head = git(s.repo, ['rev-parse', `feature/${VER_FEATURE}`]);
  expect(git(s.repo, ['show', `${head}:${CLI_COMPAT_TESTS}`])).toBe(CLI_COMPAT_FILE.trimEnd());
  expect(git(s.repo, ['show', `${head}:${CLI_TESTS}`])).toContain(CLI_AC3_HOLDS_TEST);
  expect(git(s.repo, ['show', '-s', '--format=%B', head])).toMatch(/Mycelink-Reproof: AC-3/);
  expect(git(s.repo, ['diff', '--name-only', `${head}~1`, head])).toBe(CLI_TESTS);
  expect(git(s.repo, ['show', `${head}:${CLI_SRC}`])).toBe(CLI_TRUNCATED_IMPL.trimEnd());
  // Each criterion as it settled.
  const by = Object.fromEntries((cli.criteria as Record<string, any>[]).map((c) => [`${c.criterion}${c.reproof ? ':reproof' : ''}`, c]));
  expect(by['AC-3']).toMatchObject({ carried: true, test_id: verCliTestId(CLI_RECOVERY_TEST), carried_from: { generation: 0, gate: 'red' } });
  expect(by['AC-3:reproof']).toMatchObject({ reproof: { tests: [expect.objectContaining({ full_name: CLI_AC3_HOLDS_TEST })] } });
  expect(by['AC-4']).toMatchObject({ carried: true, test_id: verCliTestId(CLI_FAILURE_TEST) });
  expect(by['AC-5']).toMatchObject({ gate: 'green', test: { path: CLI_COMPAT_TESTS } });
  // The ledger: generation 0's completions, then this generation's, each once, AC-3's re-proof standing on its RED.
  const ledger = ledgerOf(s);
  const g0 = Object.fromEntries(ledger.filter((r) => r.generation === 0).map((r) => [r.criterion, r]));
  const g1 = Object.fromEntries(ledger.filter((r) => r.generation === 1).map((r) => [r.criterion, r]));
  expect(Object.keys(g0).sort()).toEqual(['AC-3', 'AC-4', 'AC-5']);
  expect(g0['AC-3']).toMatchObject({ basis: 'red', red: { record: expect.objectContaining({ exit_code: 1 }) } });
  expect(Object.keys(g1).sort()).toEqual(['AC-3', 'AC-4', 'AC-5']);
  expect(g1['AC-3']).toMatchObject({ basis: 'reproved', source: g0['AC-3'].record_id, parent: g0['AC-3'].record_id, order: { review_id: R001, revision: 1 } });
  expect(g1['AC-3'].reproof.files.map((f: { path: string }) => f.path)).toContain(CLI_TESTS);
  expect(g1['AC-4']).toMatchObject({ basis: 'carried', source: g0['AC-4'].record_id });
  expect(g1['AC-5']).toMatchObject({ basis: 'compatibility', parent: g0['AC-5'].record_id });
  expect(new Set(ledger.map((r) => r.record_id)).size).toBe(ledger.length);
}

describe('r16: a compatibility-only continuation with a passing RED settles on its carried completions', () => {
  it("r16's own answer (AC-3 BLOCKED for its reason, AC-5 DONE) settles AC-5 with AC-3's carried RED: nothing charged, AC-3 ordered again on its own", async () => {
    const { s, t, attempts } = await r16Continuation();
    const run = compatContinuation(t, s.control);
    r16Answer(t, run);
    const settled = await settle(s, t);
    // r16 charged INVALID_RED_EVIDENCE here (RETRY), and BLOCKED the node on the next attempt.
    expect(settled.detail ?? '').not.toMatch(/INVALID_RED_EVIDENCE/);
    expect(settled, settled.detail).toMatchObject({ outcome: 'CRITERIA_SETTLED' });
    commitVerControl(s, 'r16 answer settled');
    const state = verState(s);
    expect(state.nodes[CLI].failure_counts).toEqual({});
    expect(state.nodes[CLI].attempts).toBe(attempts + 1);
    // AC-5's unit integrated; AC-3 ordered again with its own reason (the worker's), as any unresolved criterion.
    expect(git(s.repo, ['show', `feature/${VER_FEATURE}:${CLI_COMPAT_TESTS}`])).toBe(CLI_COMPAT_FILE.trimEnd());
    expect(state.nodes[CLI].rework_brief).toMatchObject({ acceptance_criteria: ['AC-3'] });
    expect(eventsOf(s).filter((e) => e.type === 'node.criteria_settled').map((e) => e.data['done'])).toEqual([['AC-5']]);
    // The DONE generation it settled ran no RED: AC-4's carried one stood for it.
    const g1 = ledgerOf(s).filter((r) => r.generation === 1);
    expect(g1.map((r) => [r.criterion, r.basis]).sort()).toEqual([['AC-4', 'carried'], ['AC-5', 'compatibility']]);
  });

  it('the answer the protocol allows now — AC-3 re-proved on its completed proof, AC-5 by its unit — settles DONE; the check line agrees; nothing charged; each completion recorded once', async () => {
    const { s, t, attempts } = await r16Continuation();
    // The order names AC-3 again, and the pack says it was completed, with the proof to cite and how to re-prove it.
    const rework = reworkOf(t);
    expect(rework['completed_criteria']).toEqual([expect.objectContaining({ criterion: 'AC-3', test_id: verCliTestId(CLI_RECOVERY_TEST), gate: 'red', source_generation: 0, record_id: expect.stringMatching(/^CC-/) })]);
    expect(rework['carried_criteria']).toEqual([expect.objectContaining({ criterion: 'AC-4', test_id: verCliTestId(CLI_FAILURE_TEST) })]);
    expect(t.prompt).toMatch(/re-proof/i);
    const run = compatContinuation(t, s.control);
    // The red gate said what a passing reproduction of a completed criterion is.
    expect(run.red.out).toMatch(/re-proof/i);
    expect(run.red.out).toMatch(/exactly the review's reproduction.*challenge line.*--criteria/s);
    expect(run.red.out).toMatch(/no git restore is required/i);
    reproofAnswer(t, run);
    const checked = await check(s, t);
    expect(checked, JSON.stringify(checked)).toMatchObject({ ok: true });
    const settled = await settle(s, t);
    expect(settled, settled.detail).toMatchObject({ outcome: 'DONE', state: 'DONE' });
    commitVerControl(s, 'cli continuation');
    expectCarriedDone(s, attempts);
    // Settled again with the same capability: its receipt, nothing re-run, nothing recorded twice.
    const again = await settle(s, t);
    expect(again).toMatchObject({ outcome: 'DONE' });
    expect(ledgerOf(s)).toHaveLength(6);
    const verify = JSON.parse((await verCli(s, ['feature', 'verify', VER_FEATURE, '--json'])).out) as { problems?: string[] };
    expect((verify.problems ?? []).filter((p) => p.includes(CLI))).toEqual([]);
  });

  it('the same work as a legacy SUBMITTED answer settles DONE the same way', async () => {
    const { s, t, attempts } = await r16Continuation();
    const run = compatContinuation(t, s.control);
    reproofAnswer(t, run, { legacy: true });
    const settled = await settle(s, t);
    expect(settled, settled.detail).toMatchObject({ outcome: 'DONE', state: 'DONE' });
    commitVerControl(s, 'cli continuation (legacy answer)');
    expectCarriedDone(s, attempts);
  });

  it('a settle interrupted at each boundary finishes once: the same DONE generation, each completion recorded exactly once', async () => {
    for (const point of ['history-sealed', 'fresh-verified', 'gates-advanced', 'integrated'] as SettleFaultPoint[]) {
      const { s, t, attempts } = await r16Continuation();
      const run = compatContinuation(t, s.control);
      reproofAnswer(t, run);
      expect(() => crashing(s, point).settle(CLI, t.capability), point).toThrow(/CRASH/);
      commitVerControl(s, `crashed at ${point}`);
      const resumed = await settle(s, t);
      expect(resumed, `${point}: ${resumed.detail}`).toMatchObject({ outcome: 'DONE' });
      expectCarriedDone(s, attempts);
    }
  }, 900_000);
});

describe('r16: what a re-proof may not be', () => {
  it("AC-3 cited by its completed proof alone (no re-proof of the review's reproduction) is held for correction, nothing charged", async () => {
    const { s, t } = await r16Continuation();
    const run = compatContinuation(t, s.control);
    const answer = reproofAnswer(t, run) as { criterion_evidence: Record<string, unknown>[] };
    writeAnswer(t, { criteria: [{ criterion: 'AC-3', outcome: 'DONE' }, { criterion: 'AC-5', outcome: 'DONE' }], evidence: answer.criterion_evidence.filter((e) => !(e['criterion'] === 'AC-3' && e['test_id'] === run.reproof.test_id)) });
    const held = await settle(s, t);
    expect(held, held.detail).toMatchObject({ outcome: 'EVIDENCE_CORRECTION_REQUIRED' });
    expect(held.detail).toMatch(/CRITERION_REPROOF_REQUIRED/);
    nothingCharged(s);
  });

  it("a passing reproduction is never a criterion's RED: AC-3 cited by its re-proof alone (its completed proof left out) is held for correction", async () => {
    const { s, t } = await r16Continuation();
    const run = compatContinuation(t, s.control);
    const answer = reproofAnswer(t, run) as { criterion_evidence: Record<string, unknown>[] };
    writeAnswer(t, { criteria: [{ criterion: 'AC-3', outcome: 'DONE' }, { criterion: 'AC-5', outcome: 'DONE' }], evidence: answer.criterion_evidence.filter((e) => !(e['criterion'] === 'AC-3' && e['test_id'] === verCliTestId(CLI_RECOVERY_TEST))) });
    const held = await settle(s, t);
    expect(held, held.detail).toMatchObject({ outcome: 'EVIDENCE_CORRECTION_REQUIRED' });
    expect(held.detail).toMatch(/CRITERION_REPROOF_REQUIRED/);
    nothingCharged(s);
  });

  it('new production code behind carried proofs is refused: a production change driven by a RED no DONE criterion of the answer names', async () => {
    const { s, t } = await r16Continuation();
    // R001's reproduction and AC-5's test, one red gate: every declared test passes (refused), the reproduction kept apart.
    writeFiles(t.worktree, { [CLI_TESTS]: CLI_R16_REPRODUCTION, [CLI_COMPAT_TESTS]: CLI_COMPAT_FILE });
    const repro = runGate(t, 'red', s.control);
    expect(repro.code, repro.out).not.toBe(0);
    git(t.worktree, ['checkout', '--', CLI_TESTS]);
    git(t.worktree, ['rm', '-q', '--cached', '--ignore-unmatch', CLI_COMPAT_TESTS]);
    execSync(`git -C "${t.worktree}" clean -fdq -- packages/cli/test`);
    // Then an unrelated RED and the production change it drives, laundered behind AC-3's carried proof.
    const extra = 'packages/cli/test/extra.test.mjs';
    writeFiles(t.worktree, {
      [extra]: "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { status } from '../src/index.mjs';\n\ntest('status counts the pending changesets when asked', () => {\n  const lines = [];\n  status({ files: new Map([['.changeset/a.md', 'a']]), io: { log: (l) => lines.push(l) }, count: true });\n  assert.equal(lines.at(-1), '1 pending');\n});\n",
    });
    const red = runGate(t, 'red', s.control);
    expect(red.code, red.out).toBe(0);
    commit(t.worktree, [extra], 'test: pending count');
    writeFiles(t.worktree, {
      [CLI_SRC]: CLI_TRUNCATED_IMPL.replace('export function status({ files, io }) {', 'export function status({ files, io, count = false }) {').replace(
        'io.log(path);\n  return 0;\n}',
        "io.log(path);\n  if (count) io.log([...files.keys()].filter((p) => /^\\.changeset\\/[^./][^/]*\\.md$/.test(p)).length + ' pending');\n  return 0;\n}",
      ),
    });
    expect(runGate(t, 'green', s.control).code).toBe(0);
    commit(t.worktree, [CLI_SRC], 'feat: pending count');
    writeFiles(t.worktree, { [CLI_COMPAT_TESTS]: CLI_COMPAT_FILE });
    commitCompat(t.worktree, [CLI_COMPAT_TESTS], 'AC-5');
    const green = runGate(t, 'green', s.control);
    expect(green.code, green.out).toBe(0);
    expect(runGate(t, 'regression', s.control).code).toBe(0);
    const run: Continuation = {
      red: repro,
      green,
      regression: green,
      reproof: { test_id: repro.tests.find((x) => x.full_name === CLI_AC3_HOLDS_TEST)!.id, sha256: repro.sha256 as string },
      compat: { test_id: green.tests.find((x) => x.full_name === CLI_JOURNAL_STATUS_TEST)!.id, sha256: green.sha256 as string },
    };
    reproofAnswer(t, run);
    const refused = await settle(s, t);
    expect(refused.detail, refused.detail).toMatch(/PRODUCTION_UNDRIVEN/);
    expect(verState(s).nodes[CLI].state).not.toBe('DONE');
    expect(git(s.repo, ['show', `feature/${VER_FEATURE}:${CLI_SRC}`])).toBe(CLI_TRUNCATED_IMPL.trimEnd());
  });

  it("a completion record tampered with is never carried: the claim's revalidation reopens AC-3 alone, nothing charged", async () => {
    const s = await r16Reviewed();
    // Edit generation 0's AC-3 record in place (as a hand on STATE.json would).
    mutateState(s.featureDir, (st) => {
      const rec = (st.nodes[CLI]?.criterion_ledger ?? []).find((r) => r.criterion === 'AC-3');
      if (rec) rec.proof.output_sha256 = '0'.repeat(64);
      return st;
    });
    commitVerControl(s, 'tampered');
    await withdrawSibling(s);
    const t = (await dispatch(s)).ticket!;
    expect(t.node_id).toBe(CLI);
    const rework = reworkOf(t);
    expect(rework['completed_criteria'] ?? []).toEqual([]);
    expect(rework['reopened']).toEqual([expect.objectContaining({ criterion: 'AC-3', code: 'COMPLETION_TAMPERED' })]);
    expect(rework['carried_criteria']).toEqual([expect.objectContaining({ criterion: 'AC-4' })]);
    expect(eventsOf(s).filter((e) => e.type === 'node.criterion_reopened').map((e) => [e.data['criterion'], e.data['code']])).toEqual([['AC-3', 'COMPLETION_TAMPERED']]);
    nothingCharged(s);
  });
});

describe('r16: a challenge beside a compatibility unit', () => {
  it('the focused test of a challenged criterion, written in an existing test file and kept out of the branch, binds: AC-3 challenged, AC-5 DONE by its unit, in one answer', async () => {
    const { s, t, attempts } = await r16Continuation();
    const run = compatContinuation(t, s.control);
    // The challenge line, narrowed to AC-3: the passing reproduction, its clauses traced to the file as the red gate ran it.
    const line = /^- challenge(?: \([^)]*\))?: (.+)$/m.exec(t.prompt)?.[1];
    expect(line).toBeDefined();
    let raw = '{}';
    try {
      raw = execSync(`${line} --criteria AC-3 --json`, { cwd: s.control, encoding: 'utf8', stdio: 'pipe' });
    } catch (error) {
      raw = (error as { stdout?: string }).stdout ?? '{}';
    }
    const skeleton = JSON.parse(raw) as Record<string, any>;
    expect(skeleton['challenge'], raw).toBeDefined();
    const challenge = structuredClone(skeleton['challenge']) as Record<string, any>;
    for (const gap of challenge['gaps'] as Record<string, any>[]) {
      gap['tests'] = [run.reproof.test_id];
      gap['clauses'] = cliAc3Clauses(CLI_R16_REPRODUCTION, run.reproof.test_id);
      gap['explanation'] = "R001's exact AC-3 reproduction passes on the head the cli's first generation completed.";
    }
    const carried = (reworkOf(t)['carried_criteria'] ?? []) as { criterion: string; test_id: string; gate?: string; output_sha256: string }[];
    writeAnswer(t, { criteria: [{ criterion: 'AC-3', outcome: 'REVIEW_GAP_CHALLENGE' }, { criterion: 'AC-5', outcome: 'DONE' }], evidence: [{ criterion: 'AC-5', test_id: run.compat.test_id, gate: 'green', output_sha256: run.compat.sha256 }, ...carried.map(cite)], extra: { challenge } });
    const settled = await settle(s, t);
    expect(settled, settled.detail).toMatchObject({ outcome: 'CRITERIA_SETTLED', state: 'DONE', challenge: { criteria: ['AC-3'] } });
    expect(verState(s).nodes[CLI]).toMatchObject({ attempts: attempts + 1, failure_counts: {} });
    nothingCharged(s);
  });
});
