/**
 * The CSET-202 rerun, model-free, to the delivery it should have reached.
 *
 * The rerun (trusted, no controller violation): R001 found a coverage gap in
 * the cli that its first generation's code already satisfied. The cli's review
 * rework (generation 1) wrote the review's reproduction beside two tests of
 * its own and ran the red gate: those two failed for a missing behaviour, the
 * reproduction passed — a RED, accepted. It changed its tests and ran the red
 * gate again: everything passed, refused, kept as the re-proof's material, and
 * the node's RED stayed the first run's record. Both runs wrote the same
 * canonical log and results, so the first record now named bytes the second
 * run had put there. The worker restored its test file, ran green and
 * regression and answered: the criterion completed by generation 0's RED,
 * re-proved by the reproduction that passed. Settled DONE; R002 PASS; C001.
 * Delivery refused C001: FEATURE_NOT_VERIFIED: OUTPUT_HASH_MISMATCH. The
 * harness ordered a product rework to "rerun the red gate"; the worker could
 * not honestly make a passing test fail and asked a person (NEEDS_DECISION).
 *
 * Here the same generation, step by step:
 *
 *  1. with immutable gate evidence, the two runs are two artifacts: the kept
 *     RED still verifies, R002 passes, C001 is delivered with nothing to
 *     repair;
 *  2. with the state an earlier release left (the kept record on the canonical
 *     name, the second run's bytes there), delivery of C001 repairs the
 *     pointer itself from the red gate's own snapshot of its first run —
 *     attested by that run's binding in the same generation — and accepts the
 *     same candidate: R002 still binds it, nothing reopened, rerun, charged
 *     or asked.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { git } from '../helpers/git-fixture.js';
import { CLI, CLI_AC5, CLI_TESTS, VER_CANDIDATE, VER_FEATURE, commitVerControl, verCli, verState, type Ver } from '../helpers/version-fixture.js';
import { runGate, writeFiles, type ShopTicket } from '../helpers/shop-worker.js';
import { reviewPacket, verdictFor, writeVerdict, type ReviewTicket } from '../helpers/review-agent.js';
import { dispatch, settle } from '../helpers/cset203-rework.js';
import { settleReview } from '../helpers/cset203-r7.js';
import { CLI_AC3_HOLDS_TEST, GAP_AC3_HOLDS, R002, cite, eventsOf, r16Reviewed, reworkOf, writeAnswer, CLI_R16_REPRODUCTION } from '../helpers/cset203-r16.js';
import { canonicalPath, holds, legacyOverwrite, sha256 } from '../helpers/legacy-evidence.js';
import { checkEvidenceOutput } from '../../src/evidence/paths.js';
import { featureVerifyProblems } from '../../src/engine/feature-verify.js';
import { reviewGateProblems } from '../../src/engine/acceptance-review.js';
import { nodeEvidenceDir } from '../../src/workspace/paths.js';
import type { EvidenceRecord } from '../../src/model/types.js';

afterAll(() => cleanupTmpRoots());

/** Two tests of the worker's own beside the reproduction, failing for a behaviour the cli does not have (CSET-202's MIXED_IGNORED pair). */
const CLI_OWN_TESTS = `
test('version reports a mixed changeset once and exits 1', async () => {
  const errors = [];
  const code = await version({ files: new Map([['packages/a/package.json', '{"version":"1.0.0"}']]), changes: [], config: { ignore: ['b'] }, io: { log() {}, warn() {}, error: (m) => errors.push(m) }, git: { add() {}, commit() {} } });
  assert.equal(code, 1);
  assert.deepEqual(errors, ['mixed changeset']);
});
`;

interface Generation1 {
  t: ShopTicket;
  /** The first red gate's record: the node's RED. */
  first: { sha256: string; record: EvidenceRecord };
  /** The second red gate's output and results, as it printed them. */
  second: { sha256: string; output_path: string; results_path: string };
  reproof: { test_id: string; sha256: string };
}

/** R001's gap on the cli, and its generation 1 exactly as the rerun's worker ran it: two red gates, no commit, settled DONE by re-proof. */
async function generation1(): Promise<Ver & Generation1> {
  const s = await r16Reviewed({ interruptReviewer: false, gaps: { 'AC-3': GAP_AC3_HOLDS } });
  const t = (await dispatch(s)).ticket!;
  expect(t.node_id).toBe(CLI);
  expect(reworkOf(t)).toMatchObject({ acceptance_criteria: ['AC-3'], completed_criteria: [expect.objectContaining({ criterion: 'AC-3' })] });
  // Red gate, run 1: the reproduction and two tests of its own; those fail for the missing behaviour — an accepted RED.
  writeFiles(t.worktree, { [CLI_TESTS]: `${CLI_R16_REPRODUCTION}${CLI_OWN_TESTS}` });
  const run1 = runGate(t, 'red', s.control);
  expect(run1.code, run1.out).toBe(0);
  const first = verState(s).nodes[CLI].evidence.red as EvidenceRecord;
  expect(first.output_sha256).toBe(run1.sha256);
  // Red gate, run 2: its own tests taken out, the reproduction alone passes — refused, kept as the re-proof's material.
  writeFiles(t.worktree, { [CLI_TESTS]: CLI_R16_REPRODUCTION });
  const run2 = runGate(t, 'red', s.control);
  expect(run2.code, run2.out).not.toBe(0);
  expect(run2.out).toMatch(/all pass on the unchanged base/i);
  const reproof = run2.tests.find((x) => x.full_name === CLI_AC3_HOLDS_TEST && x.status === 'passed');
  expect(reproof, run2.out).toBeDefined();
  // The node's RED is still the first run's record.
  const kept = verState(s).nodes[CLI].evidence.red as EvidenceRecord;
  expect(kept.output_sha256).toBe(first.output_sha256);
  // The reproduction stays out of the branch; green and regression on the unchanged head.
  git(t.worktree, ['checkout', '--', CLI_TESTS]);
  const green = runGate(t, 'green', s.control);
  expect(green.code, green.out).toBe(0);
  expect(runGate(t, 'regression', s.control).code).toBe(0);
  const rework = reworkOf(t);
  const completed = (rework['completed_criteria'] as { criterion: string; test_id: string; gate?: string; output_sha256: string }[]).filter((c) => c.criterion === 'AC-3');
  const carried = (rework['carried_criteria'] ?? []) as { criterion: string; test_id: string; gate?: string; output_sha256: string }[];
  writeAnswer(t, { evidence: [cite(completed[0]!), { criterion: 'AC-3', test_id: (reproof as { id: string }).id, gate: 'red', output_sha256: run2.sha256 as string }, ...carried.map(cite), { ...CLI_AC5, output_sha256: green.sha256 as string }], changed: [] });
  const done = await settle(s, t);
  expect(done, done.detail).toMatchObject({ outcome: 'DONE', state: 'DONE' });
  commitVerControl(s, 'cli: generation 1 re-proved');
  const printed = /evidence (\S+) sha256 ([0-9a-f]{64})/.exec(run2.out) as RegExpExecArray;
  const results = /with its test_id: (\S+?\.json)/.exec(run2.out) as RegExpExecArray;
  return Object.assign(s, { t, first: { sha256: first.output_sha256, record: kept }, second: { sha256: run2.sha256 as string, output_path: printed[1] as string, results_path: results[1] as string }, reproof: { test_id: (reproof as { id: string }).id, sha256: run2.sha256 as string } });
}

/** R002 PASS and the candidate cut (C001): dispatch until the feature is settled. */
async function reviewedAndCut(s: Ver): Promise<string> {
  for (let i = 0; i < 6; i++) {
    const d = await dispatch(s);
    if (d.status === 'ALL_SETTLED') {
      expect((d.controller_reports ?? []).map((x) => x.node_id)).toContain(VER_CANDIDATE);
      commitVerControl(s, 'settled');
      return verState(s).current_candidate as string;
    }
    const t = d.ticket as unknown as ReviewTicket & { kind?: string };
    expect(t?.kind, `${d.status} ${d.detail}`).toBe('acceptance-review');
    expect(t.review_id).toBe(R002);
    await writeVerdict(t, verdictFor(reviewPacket(t)), { cwd: s.control });
    expect(await settleReview(s, t)).toMatchObject({ outcome: 'PASS' });
    commitVerControl(s, 'R002 PASS');
  }
  throw new Error('the feature never settled');
}

/** Everything a delivery's repair may never change. */
function product(s: Ver): Record<string, unknown> {
  const d = verState(s);
  return {
    nodes: Object.fromEntries(Object.entries(d.nodes as Record<string, any>).map(([id, rt]) => [id, { state: rt.state, attempts: rt.attempts, failure_counts: rt.failure_counts, integrated: rt.integrated_sha, ledger: rt.criterion_ledger ?? null }])),
    reworks: (d.reworks ?? []).length,
    decisions: d.pending_decisions,
    epoch: d.orchestration?.epoch ?? null,
    candidate: d.current_candidate,
    review: (d.acceptance_review?.reviews ?? []).map((r: Record<string, unknown>) => [r['review_id'], r['overall'], r['epoch']]),
  };
}

describe('CSET-202 rerun, replayed model-free to the delivery it should have reached', () => {
  it('two red gates of one claim are two immutable artifacts: the kept RED verifies, R002 passes, C001 is delivered with nothing to repair', async () => {
    const s = await generation1();
    // Two runs, two artifacts: each still holds exactly what its run wrote.
    expect(s.second.output_path).not.toBe(s.first.record.output_path);
    expect(s.second.results_path).not.toBe(s.first.record.results?.path);
    expect(checkEvidenceOutput(s.control, VER_FEATURE, s.first.record)).toBeNull();
    expect(checkEvidenceOutput(s.control, VER_FEATURE, { output_path: s.second.output_path, output_sha256: s.second.sha256 })).toBeNull();
    expect(s.first.record.results).toBeDefined();
    expect(holds(resolve(s.control, s.first.record.results!.path), s.first.record.results!.sha256)).toBe(true);
    const candidate = await reviewedAndCut(s);
    expect(candidate).toBe(`${VER_FEATURE}-C001`);
    expect(featureVerifyProblems(s.control, VER_FEATURE)).toEqual([]);
    const delivered = JSON.parse((await verCli(s, ['deliver', VER_FEATURE, '--json'])).out) as Record<string, unknown>;
    expect(delivered).toMatchObject({ ok: true, status: 'ACCEPTED', candidate_id: candidate });
    expect(verState(s).evidence_repairs ?? []).toEqual([]);
  });

  it("C001 with the pointer an earlier release left is repaired from the red gate's own snapshot and delivered: same candidate, R002 still binding, nothing reopened, rerun, charged or asked", async () => {
    const s = await generation1();
    const candidate = await reviewedAndCut(s);
    // The state the rerun's controller held at delivery: the kept RED on the canonical names, the second run's bytes there.
    const second = { output: readFileSync(resolve(s.control, s.second.output_path)), results: readFileSync(resolve(s.control, s.second.results_path)) };
    const kept = { record: s.first.record, bytes: readFileSync(resolve(s.control, s.first.record.output_path)), results: readFileSync(resolve(s.control, s.first.record.results!.path)) };
    legacyOverwrite(s.control, VER_FEATURE, CLI, 'red', kept, { output: second.output, results: second.results });
    // An earlier release wrote no content-addressed artifact of a red gate at all.
    const dir = nodeEvidenceDir(s.control, VER_FEATURE, CLI);
    for (const name of readdirSync(dir)) if (/^red(\.results)?\.[0-9a-f]{16}(-\d+)?\.(log|json)$/.test(name)) rmSync(join(dir, name));
    const refused = featureVerifyProblems(s.control, VER_FEATURE);
    // Exactly the rerun's refusal.
    expect(refused.join('\n')).toContain(`OUTPUT_HASH_MISMATCH: ${CLI} red ${canonicalPath(VER_FEATURE, CLI, 'red')} hashes to ${sha256(second.output).slice(0, 12)}, record says ${s.first.sha256.slice(0, 12)}`);
    commitVerControl(s, 'the state an earlier release left');
    const before = product(s);
    const events = eventsOf(s).length;

    const r = await verCli(s, ['deliver', VER_FEATURE, '--json']);
    expect(r.err).toBe('');
    expect(JSON.parse(r.out)).toMatchObject({ ok: true, status: 'ACCEPTED', candidate_id: candidate });

    const after = verState(s);
    // The same candidate, R002 still the PASS that binds it, no node reopened, nothing rerun, charged or asked.
    expect(product(s)).toEqual({ ...before });
    expect(reviewGateProblems(s.control, VER_FEATURE)).toEqual([]);
    expect(after.feature_state).toBe('COMPLETED');
    const red = after.nodes[CLI].evidence.red as EvidenceRecord;
    expect(red.output_sha256).toBe(s.first.sha256);
    expect(checkEvidenceOutput(s.control, VER_FEATURE, red)).toBeNull();
    expect(holds(resolve(s.control, red.results!.path), s.first.record.results!.sha256)).toBe(true);
    const repairs = after.evidence_repairs as { from_path: string; refs: string[]; source: { kind: string; path: string }; to_path: string }[];
    const live = repairs.filter((x) => x.from_path === canonicalPath(VER_FEATURE, CLI, 'red') || x.from_path === canonicalPath(VER_FEATURE, CLI, 'red', true));
    expect(live.map((x) => [x.from_path, x.source.kind])).toEqual([
      [canonicalPath(VER_FEATURE, CLI, 'red'), 'challenge-snapshot'],
      [canonicalPath(VER_FEATURE, CLI, 'red', true), 'challenge-snapshot'],
    ]);
    expect(live.every((x) => x.source.path.includes(`/challenge-red/${s.first.sha256.slice(0, 16)}/gate/`))).toBe(true);
    // The generation R001's rework replaced, kept whole for a challenge to restore, named the same gate's artifacts of its
    // own: restored from the copies that rework archived, attested by it.
    for (const x of repairs.filter((r) => !live.includes(r))) {
      expect(x.source.kind).toBe('replaced-generation');
      expect(x.refs.every((k) => /:rework:0:restore:/.test(k))).toBe(true);
    }
    // The canonical files are left exactly as the second run left them.
    expect(holds(resolve(s.control, canonicalPath(VER_FEATURE, CLI, 'red')), sha256(second.output))).toBe(true);
    const added = eventsOf(s).slice(events).map((e) => e.type);
    expect(added.filter((x) => x === 'evidence.repaired')).toHaveLength(repairs.length);
    expect(added).not.toContain('node.reworked');
    expect(added).not.toContain('decision.requested');
    expect(added).not.toContain('node.transition');
    expect((await verCli(s, ['feature', 'verify', VER_FEATURE, '--delivered'])).code).toBe(0);
  });
});
