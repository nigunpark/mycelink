/**
 * CSET-201 final, normal arm, model-free, to the delivery it should have
 * reached (every platform).
 *
 * The real run (WSL ~/mycelink-pilot-results/CSET-201-final/with-normal,
 * trusted, no controller violation, no candidate): R001 found AC-2 and AC-3
 * gaps whose reproductions the first generations' code already passed; both
 * reworks settled as re-proofs — the passing tests archived and kept out of
 * the branch, never in the product. R002 passed AC-3 on those archived tests
 * and found a new AC-2 gap (a dependent's workspace: range recorded
 * stripped); the planner's second rework fixed it and the cli, reopened,
 * re-proved on that head by citing a RED of tests its head never held. R003
 * found a materially new AC-2 gap (one changeset reason per changeset, none
 * included) — exhausted solely because `max_criterion_reworks` was 2 — and
 * AC-3's tests absent from the integrated head, judged a duplicate of R001's
 * and dropped. A person was asked to decide.
 *
 * Here, the same reviews in the same order:
 *
 *  1. every first generation; R001 GAPS AC-2 + AC-3, both re-proved: each
 *     re-proof is committed by settle as a test-only unit (`Mycelink-Reproof`)
 *     and integrated, so every later head holds it;
 *  2. R002 PASS AC-3 at that head, a new AC-2 gap (workspace: range);
 *  3. the planner's second rework: its first worker rebuilds its branch on
 *     the head R001 reviewed, before either re-proof unit — integrating it
 *     would erase the cli's AC-3 proof and the planner's own AC-2 re-proof:
 *     refused uncharged (SIBLING_PROGRESS_LOST) and reissued from the latest
 *     head; the reissued worker's RED and fix land with AC-3's tests intact;
 *  4. R003's materially new third AC-2 gap is reworked on its verified
 *     progress (the second rework's RED and production change), past the old
 *     cap of 2, never a person's decision; its RED and fix;
 *  5. R004 PASS; C001 delivered; the hidden-like checks pass on the delivered
 *     head; the delivered history replays test-first, the re-proof units as
 *     tests of behaviour an earlier RED drove; nothing charged anywhere.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { git } from '../helpers/git-fixture.js';
import { fulfil, packOf, type ShopTicket } from '../helpers/shop-worker.js';
import {
  ASM_FLATTEN_RED,
  ASM_FLATTEN_TEST,
  ASM_GEN2,
  ASM_GEN3,
  ASM_GROUP_TEST,
  ASM_PEER_TEST,
  ASM_R001_REPRODUCTION,
  ASM_SRC,
  ASM_TESTS,
  ASM_WORKSPACE_RED,
  ASM_WORKSPACE_RED_STALE,
  ASM_WORKSPACE_TEST,
  ASSEMBLE,
  CANDIDATE,
  CLI,
  CLI_COMPAT_TEST,
  CLI_DEPENDENT_TEST,
  CLI_FIXED_TEST,
  CLI_R001_REPRODUCTION,
  CLI_TESTS,
  COMPAT,
  EXP_BENCH_MANIFEST,
  EXP_FEATURE,
  GAP_R001_AC2,
  GAP_R001_AC3,
  GAP_R002_AC2,
  GAP_R003_AC2,
  TYPES,
  cliTestId,
  commitExpControl,
  createExplain,
  expCli,
  expState,
  type Exp,
} from '../helpers/explain-fixture.js';
import { completedProof, cite, dispatch, featureStatus, firstGenerations, reprove, reverifyCli, reviewTicket, reviewWith, settle, ticketFor, writeResult } from '../helpers/cset201.js';
import { reviewPacket, verdictFor, writeVerdict } from '../helpers/review-agent.js';
// @ts-expect-error -- plain ESM module without type declarations
import { replayUnit, segmentUnits } from '../../evals-public-projects/lib/tdd.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { createAdapter } from '../../evals-public-projects/lib/adapters/index.mjs';

afterAll(() => cleanupTmpRoots());

const R = (n: number): string => `${EXP_FEATURE}-R00${n}`;
const featureBranch = `feature/${EXP_FEATURE}`;

/** Hidden-like acceptance of every criterion the reviews found, run from outside on a checkout of the delivered head. */
const ACCEPTANCE = `import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
const { assembleReleasePlan } = await import(pathToFileURL(join(root, 'packages/assemble-release-plan/src/index.mjs')).href);
const { status } = await import(pathToFileURL(join(root, 'packages/cli/src/index.mjs')).href);
const packages = [{ name: 'pkg-a', version: '1.0.0' }, { name: 'pkg-b', version: '1.0.0' }, { name: 'pkg-c', version: '1.0.0', dependencies: { 'pkg-a': 'workspace:^1.0.0' } }, { name: 'pkg-d', version: '1.0.0', peerDependencies: { 'pkg-b': '~1.0.0' } }];
const changesets = [{ id: 'one', releases: [{ name: 'pkg-a', type: 'major' }] }, { id: 'two', releases: [{ name: 'pkg-a', type: 'major' }] }, { id: 'three', releases: [{ name: 'pkg-b', type: 'none' }] }];
const plan = assembleReleasePlan(changesets, packages, { fixed: [['pkg-a', 'pkg-b']] }, { explain: true });
const of = (name) => plan.releases.find((r) => r.name === name);
assert.deepEqual(of('pkg-a').reasons, [{ type: 'changeset', changeset: 'one', bumpType: 'major' }, { type: 'changeset', changeset: 'two', bumpType: 'major' }], 'AC-2 one reason per changeset');
assert.deepEqual(of('pkg-b').reasons, [{ type: 'changeset', changeset: 'three', bumpType: 'none' }, { type: 'fixed', group: ['pkg-a', 'pkg-b'], bumpType: 'major' }], 'AC-2 a none changeset reason, then the group alignment');
assert.deepEqual(of('pkg-c').reasons, [{ type: 'dependent', dependency: 'pkg-a', dependencyType: 'dependencies', versionRange: 'workspace:^1.0.0', bumpType: 'patch' }], 'AC-2 the range exactly as written');
assert.deepEqual(of('pkg-d').reasons, [{ type: 'dependent', dependency: 'pkg-b', dependencyType: 'peerDependencies', versionRange: '~1.0.0', bumpType: 'patch' }], 'AC-2 a dependent of a group-added package names it');
assert.equal('reasons' in assembleReleasePlan(changesets, packages, { fixed: [['pkg-a', 'pkg-b']] }).releases[0], false, 'AC-2 no reasons without explain');
const lines = status({ changesets, packages, config: { fixed: [['pkg-a', 'pkg-b']] }, explain: true });
assert.ok(lines.includes('    - reason: dependent of pkg-a (dependencies workspace:^1.0.0) -> patch'), 'AC-3 the dependent line');
assert.ok(lines.includes('    - reason: fixed group [pkg-a, pkg-b] -> major'), 'AC-3 the fixed line');
assert.deepEqual(lines.slice(0, 4), ['Packages to be bumped:', '  pkg-a: major', '    - reason: changeset .changeset/one.md (major)', '    - reason: changeset .changeset/two.md (major)'], 'AC-3 one line per reason, in order');
const files = new Map();
status({ changesets, packages, output: 'plan.json', files });
assert.equal(JSON.stringify(JSON.parse(files.get('plan.json'))).includes('reasons'), false, 'AC-4 no reasons without --explain');
assert.equal(status({ changesets, packages }).some((l) => l.includes('reason')), false, 'AC-4 no reason lines without --explain');
console.log('CSET-201 acceptance: ok');
`;

function acceptance(repo: string, sha: string): { code: number; out: string } {
  const at = join(makeTmpDir('cset201-hidden-like-'), 'checkout');
  git(repo, ['worktree', 'add', '--detach', at, sha]);
  try {
    const file = join(makeTmpDir('cset201-script-'), 'acceptance.mjs');
    writeFileSync(file, ACCEPTANCE);
    const r = spawnSync(process.execPath, [file, at], { encoding: 'utf8' });
    return { code: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
  } finally {
    git(repo, ['worktree', 'remove', '--force', at]);
  }
}

const gapEvents = (s: Exp): Record<string, any>[] => (expState(s).acceptance_review.lineage?.events ?? []).filter((e: { kind: string }) => e.kind === 'gap');
const ledgerOf = (s: Exp, node: string): Record<string, any>[] => (expState(s).nodes[node].criterion_ledger ?? []) as Record<string, any>[];
const fileAt = (s: Exp, rev: string, path: string): string => git(s.repo, ['show', `${rev}:${path}`]);
const trailerCommits = (s: Exp, rev: string, trailer: string): string[] =>
  git(s.repo, ['log', '--format=%H%x00%B%x01', rev])
    .split('\u0001')
    .map((x) => x.trim())
    .filter((x) => x.includes(`${trailer}:`))
    .map((x) => x.split('\u0000')[0] as string);

/** Every node's first generation, then R001 GAPS AC-2 + AC-3 — both re-proved and each re-proof committed and integrated by settle. */
async function reprovedAfterR001(): Promise<{ s: Exp; r001Head: string }> {
  const s = await createExplain();
  await firstGenerations(s);
  const r1 = await reviewWith(s, 'R001', { 'AC-2': GAP_R001_AC2, 'AC-3': GAP_R001_AC3 });
  expect(r1.settled, JSON.stringify(r1.settled)).toMatchObject({ outcome: 'GAPS' });
  const r001Head = reviewPacket(r1.t).repositories[0]!.head_sha;
  // The planner's re-proof of R001's AC-2: kept out of the branch by its worker, committed by settle exactly as the red gate ran it.
  const a = await ticketFor(s, ASSEMBLE);
  const done = completedProof(a, 'AC-2');
  const ra = reprove(a, s.control, ASM_TESTS, ASM_R001_REPRODUCTION, [ASM_GROUP_TEST, ASM_PEER_TEST]);
  writeResult(a, [cite(done), { criterion: 'AC-2', test_id: ra.tests[0]!.id, gate: 'red', output_sha256: ra.red.sha256 as string }]);
  const settledA = await settle(s, a);
  expect(settledA, settledA.detail).toMatchObject({ outcome: 'DONE', state: 'DONE' });
  commitExpControl(s, 'assemble: AC-2 re-proved');
  let head = git(s.repo, ['rev-parse', featureBranch]);
  expect(head).not.toBe(r001Head);
  expect(fileAt(s, head, ASM_TESTS)).toBe(ASM_R001_REPRODUCTION.trimEnd());
  expect(trailerCommits(s, head, 'Mycelink-Reproof')).toHaveLength(1);
  expect(git(s.repo, ['show', '-s', '--format=%B', head])).toMatch(/Mycelink-Reproof: AC-2/);
  // A re-proof unit is tests alone, on top of what the worker submitted.
  expect(git(s.repo, ['diff', '--name-only', `${head}~1`, head])).toBe(ASM_TESTS);
  const asmAc2 = ledgerOf(s, ASSEMBLE).filter((r) => r.criterion === 'AC-2');
  expect(asmAc2.map((r) => r.basis)).toEqual(['red', 'reproved']);
  expect(asmAc2[1]).toMatchObject({ repo: { head_sha: head, integrated_sha: head }, reproof: { commit: head } });
  // The cli's re-proof of R001's AC-3, on that head.
  const c = await ticketFor(s, CLI);
  expect(git(c.worktree, ['rev-parse', 'HEAD'])).toBe(head);
  const doneC = completedProof(c, 'AC-3');
  const rc = reprove(c, s.control, CLI_TESTS, CLI_R001_REPRODUCTION, [CLI_DEPENDENT_TEST, CLI_FIXED_TEST]);
  writeResult(c, [cite(doneC), { criterion: 'AC-3', test_id: rc.tests[0]!.id, gate: 'red', output_sha256: rc.red.sha256 as string }, { criterion: 'AC-4', test_id: cliTestId(CLI_COMPAT_TEST), gate: 'green', output_sha256: rc.green.sha256 as string }]);
  const settledC = await settle(s, c);
  expect(settledC, settledC.detail).toMatchObject({ outcome: 'DONE', state: 'DONE' });
  commitExpControl(s, 'cli: AC-3 re-proved');
  head = git(s.repo, ['rev-parse', featureBranch]);
  expect(fileAt(s, head, CLI_TESTS)).toBe(CLI_R001_REPRODUCTION.trimEnd());
  expect(git(s.repo, ['show', '-s', '--format=%B', head])).toMatch(/Mycelink-Reproof: AC-3/);
  expect(ledgerOf(s, CLI).filter((r) => r.criterion === 'AC-3').map((r) => r.basis)).toEqual(['red', 'reproved']);
  return { s, r001Head };
}

describe('CSET-201 final normal arm, replayed model-free to the delivery it should have reached', () => {
  it("R001's re-proofs land in the product; a stale second AC-2 rework that would erase AC-3 is reissued uncharged; R003's materially new third AC-2 gap is reworked on verified progress past the old cap; R004 PASS, C001 delivered, test-first, nothing charged", async () => {
    const { s, r001Head } = await reprovedAfterR001();
    const attempts = (): number => expState(s).nodes[ASSEMBLE].attempts as number;

    // R002: AC-3 passes on the tests its head now holds; the workspace: range is a materially new AC-2 gap.
    const r2 = await reviewWith(s, 'R002', { 'AC-2': GAP_R002_AC2 });
    expect(r2.settled, JSON.stringify(r2.settled)).toMatchObject({ outcome: 'GAPS', reworked: [ASSEMBLE] });
    const r002Head = reviewPacket(r2.t).repositories[0]!.head_sha;
    expect(fileAt(s, r002Head, CLI_TESTS)).toBe(CLI_R001_REPRODUCTION.trimEnd());

    // The planner's second rework, first worker: its branch rebuilt on the head R001 reviewed, before either re-proof unit.
    const before = attempts();
    const stale = await ticketFor(s, ASSEMBLE);
    expect(git(stale.worktree, ['rev-parse', 'HEAD'])).toBe(r002Head);
    git(stale.worktree, ['reset', '-q', '--hard', r001Head]);
    fulfil(stale, { tests: { [ASM_TESTS]: ASM_WORKSPACE_RED_STALE }, impl: { [ASM_SRC]: ASM_GEN2 }, criteria: [{ criterion: 'AC-2', gate: 'red', full_name: ASM_WORKSPACE_TEST }] }, s.control);
    const lost = await settle(s, stale);
    expect(lost.outcome, lost.detail).toBe('PRECONDITION_FAILED');
    expect(lost.detail).toMatch(/SIBLING_PROGRESS_LOST/);
    expect(lost.detail).toMatch(new RegExp(`${CLI.replace(/\./g, '\\.')}.*AC-3|AC-3.*${CLI.replace(/\./g, '\\.')}`));
    commitExpControl(s, 'assemble: stale branch refused');
    // Nothing integrated, nothing charged; the next dispatch reissues the order from the latest head.
    expect(git(s.repo, ['rev-parse', featureBranch])).toBe(r002Head);
    let state = expState(s);
    expect(state.nodes[ASSEMBLE]).toMatchObject({ state: 'READY', failure_counts: {} });
    expect(attempts()).toBe(before);
    expect(state.nodes[ASSEMBLE].sibling_progress).toMatchObject({ code: 'SIBLING_PROGRESS_LOST', cause: 'stale-base' });
    const reissued = await ticketFor(s, ASSEMBLE);
    expect(reissued.claim_id).not.toBe(stale.claim_id);
    expect(git(reissued.worktree, ['rev-parse', 'HEAD'])).toBe(r002Head);
    // Its worker is told why, and what to keep.
    expect(packOf(reissued)['tdd']['progress_lost']).toMatchObject({ code: 'SIBLING_PROGRESS_LOST', cause: 'stale-base', lost: expect.arrayContaining([{ node_id: CLI, criterion: 'AC-3' }]) });
    fulfil(reissued, { tests: { [ASM_TESTS]: ASM_WORKSPACE_RED }, impl: { [ASM_SRC]: ASM_GEN2 }, criteria: [{ criterion: 'AC-2', gate: 'red', full_name: ASM_WORKSPACE_TEST }] }, s.control);
    const second = await settle(s, reissued);
    expect(second, second.detail).toMatchObject({ outcome: 'DONE' });
    commitExpControl(s, 'assemble: AC-2 workspace range');
    expect(attempts()).toBe(before + 1);
    const afterSecond = git(s.repo, ['rev-parse', featureBranch]);
    // The cli's AC-3 tests and the planner's own AC-2 re-proof are still there.
    expect(fileAt(s, afterSecond, CLI_TESTS)).toBe(CLI_R001_REPRODUCTION.trimEnd());
    expect(fileAt(s, afterSecond, ASM_TESTS)).toBe(ASM_WORKSPACE_RED.trimEnd());
    const c2 = await ticketFor(s, CLI);
    reverifyCli(c2, s.control);
    expect(await settle(s, c2)).toMatchObject({ outcome: 'DONE' });
    commitExpControl(s, 'cli re-verified');

    // R003: a materially new third AC-2 gap — reworked on the second rework's verified progress, never exhausted at 2.
    const r3 = await reviewWith(s, 'R003', { 'AC-2': GAP_R003_AC2 });
    expect(r3.settled, JSON.stringify(r3.settled)).toMatchObject({ outcome: 'GAPS', reworked: [ASSEMBLE], blocked: false });
    state = expState(s);
    expect(state.feature_state).not.toBe('BLOCKED');
    expect(state.acceptance_review.blocked).toBeNull();
    expect(gapEvents(s).map((e) => [e.review_id, e.criterion, e.verdict, e.basis ?? null])).toEqual([
      [R(1), 'AC-2', 'accepted', 'budget'],
      [R(1), 'AC-3', 'accepted', 'budget'],
      [R(2), 'AC-2', 'accepted', 'budget'],
      [R(3), 'AC-2', 'accepted', 'progress'],
    ]);
    const r3gap = gapEvents(s).at(-1) as Record<string, any>;
    const secondRecord = ledgerOf(s, ASSEMBLE).filter((r) => r.criterion === 'AC-2').at(-1) as Record<string, any>;
    expect(r3gap['progress']).toEqual([secondRecord['record_id']]);
    // The coverage R003 was settled with: every criterion's completed proof held at its head, AC-3's tests included.
    expect(r3.settled['coverage']).toMatchObject({ holds: true });
    const st = (await featureStatus(s))['acceptance_review'];
    expect(st['criteria']['AC-2']).toMatchObject({ accepted_reworks: 3, max: 2, ceiling: 6, exhausted: false });
    // Its RED and fix.
    const a3 = await ticketFor(s, ASSEMBLE);
    fulfil(a3, { tests: { [ASM_TESTS]: ASM_FLATTEN_RED }, impl: { [ASM_SRC]: ASM_GEN3 }, criteria: [{ criterion: 'AC-2', gate: 'red', full_name: ASM_FLATTEN_TEST }] }, s.control);
    const third = await settle(s, a3);
    expect(third, third.detail).toMatchObject({ outcome: 'DONE' });
    commitExpControl(s, 'assemble: one reason per changeset');
    const c3 = await ticketFor(s, CLI);
    reverifyCli(c3, s.control);
    expect(await settle(s, c3)).toMatchObject({ outcome: 'DONE' });
    commitExpControl(s, 'cli re-verified again');

    // R004 PASS; the candidate; C001 delivered and accepted.
    const r4 = await reviewTicket(s, 'R004');
    await writeVerdict(r4, verdictFor(reviewPacket(r4)), { cwd: s.control });
    const passed = JSON.parse((await expCli(s, ['review', 'settle', EXP_FEATURE, '--review', r4.review_id, '--capability', r4.capability, '--json'])).out) as Record<string, any>;
    expect(passed, JSON.stringify(passed)).toMatchObject({ outcome: 'PASS' });
    commitExpControl(s, 'R004 PASS');
    const settled = await dispatch(s);
    expect(settled.status, settled.detail).toBe('ALL_SETTLED');
    expect((settled.controller_reports ?? []).map((x) => x.node_id)).toContain(CANDIDATE);
    commitExpControl(s, 'settled');
    const delivered = JSON.parse((await expCli(s, ['deliver', EXP_FEATURE, '--json'])).out) as Record<string, unknown>;
    expect(delivered, JSON.stringify(delivered).slice(0, 3000)).toMatchObject({ status: 'ACCEPTED', candidate_id: `${EXP_FEATURE}-C001` });
    commitExpControl(s, 'delivered C001');

    // Verified from outside: every gap the reviews found is closed on the delivered head.
    const head = git(s.repo, ['rev-parse', 'main']);
    const hidden = acceptance(s.repo, head);
    expect(hidden.code, hidden.out).toBe(0);
    // Test-first, as the benchmark's independent replay reads the delivered history: every unit replays; each re-proof unit
    // is tests alone of behaviour an earlier RED drove, passing on the code before it and on the delivered tree.
    const adapter = createAdapter(EXP_BENCH_MANIFEST, { projectDir: null });
    const start = git(s.repo, ['rev-list', '--max-parents=0', head]);
    const units = segmentUnits(s.repo, start, head, adapter);
    const verdicts: string[] = [];
    for (const [i, unit] of units.entries()) {
      const record = await replayUnit({ repo: s.repo, unit, adapter, ctx: { workRoot: makeTmpDir(`cset201-tdd-${i}-`), cacheRoot: null, timeoutMs: 120_000 }, compatibility: ['AC-4'], criteria: ['AC-1', 'AC-2', 'AC-3', 'AC-4'], finalHead: head });
      expect(record.ok, `${record.verdict}: ${record.detail ?? ''}`).toBe(true);
      verdicts.push(record.verdict as string);
    }
    expect(verdicts).toEqual(['declarations-only', 'valid', 'valid', 'reproof', 'reproof', 'valid', 'valid']);
    // Nothing charged for any of it: no failure on any node, no decision asked.
    state = expState(s);
    for (const [id, rt] of Object.entries(state.nodes as Record<string, any>)) expect(rt.failure_counts, id).toEqual({});
    expect(state.pending_decisions).toEqual([]);
    for (const id of [TYPES, COMPAT]) expect(state.nodes[id].state).toBe('DONE');
  }, 600_000);
});
