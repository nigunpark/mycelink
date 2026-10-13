/**
 * A completed producer's proof is never erased by a sibling, a stale worker
 * or an interrupted settle (CSET-201 final), on the explain fixture through
 * the controller's own lines:
 *
 *  - a re-proof unit settle commits survives a crash before and after its
 *    branch moves: the resumed settle finishes at exactly that unit, once;
 *    a duplicate settle changes nothing;
 *  - a RED a re-proof's first run recorded on tests it never committed is no
 *    generation's own, and citing it later is refused uncharged;
 *  - a sibling whose own commit drops a completed producer's tests (an
 *    overlapping fence) is never integrated: refused uncharged twice, then
 *    charged; the integration head never moves;
 *  - a concurrent sibling's clean edit of a shared file merges and lands;
 *    one that conflicts with it is reissued from the latest head, uncharged;
 *  - an integration branch moved outside Mycelink is a trust stop, never a
 *    restoration;
 *  - a head that lost a completed proof (as a core before this repair left
 *    one) is restored before any reviewer runs: the producer re-proves it on
 *    its original RED, nothing spent, the lineage records the regression.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { git } from '../helpers/git-fixture.js';
import { commit, fulfil, packOf, runGate, writeFiles, type ShopTicket } from '../helpers/shop-worker.js';
import {
  ASM_GEN0,
  ASM_GEN2,
  ASM_RED,
  ASM_RED_TEST,
  ASM_SRC,
  ASM_TESTS,
  ASM_WORKSPACE_RED_STALE,
  ASM_WORKSPACE_TEST,
  ASM_R001_REPRODUCTION,
  ASM_GROUP_TEST,
  ASM_PEER_TEST,
  ASSEMBLE,
  CLI,
  CLI_COMPAT_TEST,
  CLI_DEPENDENT_TEST,
  CLI_FIXED_TEST,
  CLI_R001_REPRODUCTION,
  CLI_BASE,
  CLI_GEN0,
  CLI_TESTS_BASE,
  CLI_RED,
  CLI_RED_TEST,
  CLI_SRC,
  CLI_TESTS,
  EXP_FEATURE,
  GAP_R001_AC2,
  GAP_R001_AC3,
  GAP_R002_AC2,
  TYPES,
  cliTestId,
  commitExpControl,
  createExplain,
  expGraph,
  expState,
  type Exp,
} from '../helpers/explain-fixture.js';
import { cite, completedProof, dispatch, firstGenerations, reprove, reverifyCli, reviewTicket, reviewWith, settle, ticketFor, writeResult } from '../helpers/cset201.js';
import { Orchestrator, type SettleFaultPoint } from '../../src/engine/orchestrator.js';
import type { SessionAdapter } from '../../src/sessions/adapter.js';
import { mutateState } from '../../src/state/feature-state.js';
import { escapeRegExp } from '../helpers/regex.js';

afterAll(() => cleanupTmpRoots());

const featureBranch = `feature/${EXP_FEATURE}`;
const head = (s: Exp): string => git(s.repo, ['rev-parse', featureBranch]);
const reproofCommits = (s: Exp): string[] =>
  git(s.repo, ['log', '--format=%H%x00%B%x01', featureBranch])
    .split('\u0001')
    .filter((x) => x.includes('Mycelink-Reproof:'))
    .map((x) => x.trim().split('\u0000')[0] as string);
const charged = (s: Exp, node: string): Record<string, number> => expState(s).nodes[node].failure_counts as Record<string, number>;

/** The cli's AC-3 re-proof (R001's AC-3 gap), its answer written: the completed proof, the passing reproduction, AC-4's status test. */
function cliReproof(t: ShopTicket, control: string): void {
  const done = completedProof(t, 'AC-3');
  const r = reprove(t, control, CLI_TESTS, CLI_R001_REPRODUCTION, [CLI_DEPENDENT_TEST, CLI_FIXED_TEST]);
  writeResult(t, [cite(done), { criterion: 'AC-3', test_id: r.tests[0]!.id, gate: 'red', output_sha256: r.red.sha256 as string }, { criterion: 'AC-4', test_id: cliTestId(CLI_COMPAT_TEST), gate: 'green', output_sha256: r.green.sha256 as string }]);
}

describe('a re-proof unit is settled once, whatever interrupts it', () => {
  it('a crash with the unit journaled but the branch not moved, or after it moved and before integration: the resumed settle lands exactly that unit; a duplicate settle changes nothing', async () => {
    for (const point of ['reproof-committed', 'fresh-verified'] as SettleFaultPoint[]) {
      const s = await createExplain();
      await firstGenerations(s);
      expect((await reviewWith(s, 'R001', { 'AC-2': GAP_R001_AC2 })).settled).toMatchObject({ outcome: 'GAPS' });
      const t = await ticketFor(s, ASSEMBLE);
      const done = completedProof(t, 'AC-2');
      const r = reprove(t, s.control, ASM_TESTS, ASM_R001_REPRODUCTION, [ASM_GROUP_TEST, ASM_PEER_TEST]);
      writeResult(t, [cite(done), { criterion: 'AC-2', test_id: r.tests[0]!.id, gate: 'red', output_sha256: r.red.sha256 as string }]);
      const before = head(s);
      const crashing = new Orchestrator({ controlRoot: s.control, featureId: EXP_FEATURE, adapter: {} as SessionAdapter, settleFault: (p: SettleFaultPoint) => { if (p === point) throw new Error(`CRASH at ${p}`); } });
      expect(() => crashing.settle(ASSEMBLE, t.capability), point).toThrow(/CRASH/);
      expect(head(s), point).toBe(before);
      const unit = expState(s).nodes[ASSEMBLE].claim.reproof_unit;
      expect(unit, point).toMatchObject({ criteria: ['AC-2'], files: [{ path: ASM_TESTS }] });
      const resumed = await settle(s, t);
      expect(resumed, `${point}: ${resumed.detail}`).toMatchObject({ outcome: 'DONE' });
      expect(head(s), point).toBe(unit.commit);
      expect(reproofCommits(s), point).toEqual([unit.commit]);
      const again = await settle(s, t);
      expect(again.outcome, point).toBe('DONE');
      expect(reproofCommits(s), point).toEqual([unit.commit]);
      expect(charged(s, ASSEMBLE), point).toEqual({});
    }
  }, 600_000);
});

describe('a stale RED is no proof', () => {
  it("a re-proof's first failing run on tests never committed is not the generation's RED; cited later, it is refused, nothing charged", async () => {
    const s = await createExplain();
    await firstGenerations(s);
    expect((await reviewWith(s, 'R001', { 'AC-3': GAP_R001_AC3 })).settled).toMatchObject({ outcome: 'GAPS' });
    const t = await ticketFor(s, CLI);
    // The worker's first try: the reproduction and a test of a line the code does not print — a RED of tests it then drops.
    const phantomName = 'phantom: --explain prints an exiting prerelease mode line';
    writeFiles(t.worktree, { [CLI_TESTS]: `${CLI_R001_REPRODUCTION}\ntest('${phantomName}', () => {\n  assert.ok(status({ changesets, packages, explain: true }).includes('    - reason: exiting prerelease mode -> patch'));\n});\n` });
    const phantom = runGate(t, 'red', s.control);
    expect(phantom.code, phantom.out).toBe(0);
    const phantomTest = phantom.tests.find((x) => x.full_name === phantomName && x.status === 'failed');
    expect(phantomTest, phantom.out).toBeDefined();
    git(t.worktree, ['checkout', '--', CLI_TESTS]);
    cliReproof(t, s.control);
    expect(await settle(s, t)).toMatchObject({ outcome: 'DONE' });
    commitExpControl(s, 'cli: AC-3 re-proved');
    // What stands as the cli's RED is the completed one it carries, never the phantom run.
    const red = expState(s).nodes[CLI].evidence.red;
    expect(red.output_sha256).not.toBe(phantom.sha256);
    expect(red.carried_from).toMatchObject({ criterion: 'AC-3', generation: 0 });
    // The planner reworked; the cli, reopened, cites the phantom run: refused, held for correction, nothing charged.
    expect((await reviewWith(s, 'R002', { 'AC-2': GAP_R002_AC2 })).settled).toMatchObject({ outcome: 'GAPS' });
    const a = await ticketFor(s, ASSEMBLE);
    fulfil(a, { tests: { [ASM_TESTS]: ASM_WORKSPACE_RED_STALE }, impl: { [ASM_SRC]: ASM_GEN2 }, criteria: [{ criterion: 'AC-2', gate: 'red', full_name: ASM_WORKSPACE_TEST }] }, s.control);
    expect(await settle(s, a)).toMatchObject({ outcome: 'DONE' });
    const c = await ticketFor(s, CLI);
    const green = runGate(c, 'green', s.control);
    expect(runGate(c, 'regression', s.control).code).toBe(0);
    writeResult(c, [{ criterion: 'AC-3', test_id: (phantomTest as { id: string }).id, gate: 'red', output_sha256: phantom.sha256 as string }, { criterion: 'AC-4', test_id: cliTestId(CLI_COMPAT_TEST), gate: 'green', output_sha256: green.sha256 as string }]);
    const refused = await settle(s, c);
    expect(refused.outcome, refused.detail).toBe('EVIDENCE_CORRECTION_REQUIRED');
    expect(charged(s, CLI)).toEqual({});
    // Its honest citation of the same held head settles: the RED it carries, AC-4's status test.
    const carried = (packOf(c)['latest_evidence'] as { kind: string; output_sha256?: string }[]).find((e) => e.kind === 'red')?.output_sha256 as string;
    writeResult(c, [{ criterion: 'AC-3', test_id: cliTestId(CLI_RED_TEST), gate: 'red', output_sha256: carried }, { criterion: 'AC-4', test_id: cliTestId(CLI_COMPAT_TEST), gate: 'green', output_sha256: green.sha256 as string }]);
    const fixed = await settle(s, c);
    expect(fixed, fixed.detail).toMatchObject({ outcome: 'DONE' });
    expect(charged(s, CLI)).toEqual({});
  }, 600_000);
});


const CLI2 = `${EXP_FEATURE}.cli.verbose.impl`;
const VERBOSE_TEST = '--verbose prints each package version under its line';
const VERBOSE_RED = `${CLI_RED}
test('${VERBOSE_TEST}', () => {
  const lines = status({ changesets: [{ id: 'v', releases: [{ name: 'pkg-a', type: 'patch' }] }], packages: [{ name: 'pkg-a', version: '1.0.0' }], verbose: true });
  assert.deepEqual(lines, ['Packages to be bumped:', '  pkg-a: patch', '    version: 1.0.0']);
});
`;
const VERBOSE_IMPL = CLI_GEN0.replace('export function status({ changesets, packages, config = {}, explain = false, output = null, files = new Map() }) {', 'export function status({ changesets, packages, config = {}, explain = false, verbose = false, output = null, files = new Map() }) {').replace("    lines.push(`  ${rel.name}: ${rel.type}`);\n", "    lines.push(`  ${rel.name}: ${rel.type}`);\n    if (verbose) lines.push(`    version: ${packages.find((p) => p.name === rel.name)?.version}`);\n");
const STANDALONE_RED = VERBOSE_RED.replace(CLI_RED, CLI_TESTS_BASE);
const STANDALONE_IMPL = CLI_BASE.replace(
  'export function status({ changesets, packages, config = {}, output = null, files = new Map() }) {',
  'export function status({ changesets, packages, config = {}, verbose = false, output = null, files = new Map() }) {',
).replace(
  "  for (const rel of plan.releases) lines.push(`  ${rel.name}: ${rel.type}`);",
  "  for (const rel of plan.releases) {\n    lines.push(`  ${rel.name}: ${rel.type}`);\n    if (verbose) lines.push(`    version: ${packages.find((p) => p.name === rel.name)?.version}`);\n  }",
);
const UNVERSIONED_TEST = '--verbose says none for a package with no version';
const DROPPING_RED = `${VERBOSE_RED}
test('${UNVERSIONED_TEST}', () => {
  const lines = status({ changesets: [{ id: 'v', releases: [{ name: 'pkg-z', type: 'patch' }] }], packages: [{ name: 'pkg-z' }], verbose: true });
  assert.deepEqual(lines.slice(2), ['    version: none']);
});
`;
const DROPPING_IMPL = VERBOSE_IMPL.replace('?.version}`', "?.version ?? 'none'}`");

/** CSET-201's graph with a second producer of the cli's module (a verbose listing, AC-5), after the cli: one test file, two owners. */
function sameModuleGraph(): Record<string, unknown> {
  const graph = expGraph() as Record<string, any>;
  graph['acceptance_criteria'].push({ id: 'AC-5', kind: 'new-behavior', text: 'AC-5 verbose: changeset status --verbose prints each package line followed by its version.' });
  graph['capabilities'].push({ id: 'CAP-VERBOSE', repository: 'changesets', title: 'status --verbose', acceptance_criteria: ['AC-5'] });
  const cli = graph['nodes'].find((n: { id: string }) => n.id === CLI);
  graph['nodes'].splice(3, 0, { ...structuredClone(cli), id: CLI2, capability: 'CAP-VERBOSE', depends_on: [CLI], acceptance_criteria: ['AC-5'] });
  for (const n of graph['nodes']) if (n.node_type === 'verification' || n.node_type === 'candidate-build') n.depends_on = [...n.depends_on, CLI2];
  return graph;
}

describe("a sibling never erases a completed producer's tests", () => {
  it('a sibling in the same module whose RED drops them is refused uncharged and reissued from the latest head; past the bound it is charged; the integration head never moves', async () => {
    const s = await createExplain({ graph: sameModuleGraph() });
    await firstGenerations(s);
    const v = await ticketFor(s, CLI2);
    fulfil(v, { tests: { [CLI_TESTS]: VERBOSE_RED }, impl: { [CLI_SRC]: VERBOSE_IMPL }, criteria: [{ criterion: 'AC-5', gate: 'red', full_name: VERBOSE_TEST }] }, s.control);
    expect(await settle(s, v)).toMatchObject({ outcome: 'DONE' });
    commitExpControl(s, 'cli verbose');
    expect((await reviewWith(s, 'R001', { 'AC-3': GAP_R001_AC3 })).settled).toMatchObject({ outcome: 'GAPS' });
    // The cli re-proves AC-3 in the shared test file, after the sibling's test.
    const c = await ticketFor(s, CLI);
    const done = completedProof(c, 'AC-3');
    const r = reprove(c, s.control, CLI_TESTS, `${VERBOSE_RED}${CLI_R001_REPRODUCTION.slice(CLI_RED.length)}`, [CLI_DEPENDENT_TEST, CLI_FIXED_TEST]);
    writeResult(c, [cite(done), { criterion: 'AC-3', test_id: r.tests[0]!.id, gate: 'red', output_sha256: r.red.sha256 as string }, { criterion: 'AC-4', test_id: cliTestId(CLI_COMPAT_TEST), gate: 'green', output_sha256: r.green.sha256 as string }]);
    const reproved = await settle(s, c);
    expect(reproved, reproved.detail).toMatchObject({ outcome: 'DONE' });
    commitExpControl(s, 'cli: AC-3 re-proved');
    const integrated = head(s);
    const tickets: string[] = [];
    for (const n of [1, 2, 3]) {
      // The sibling, reopened by the cli's rework: its RED rewrites the shared test file as it knew it, the cli's re-proof gone.
      const t = await ticketFor(s, CLI2);
      expect(git(t.worktree, ['rev-parse', 'HEAD']), `attempt ${n}`).toBe(integrated);
      tickets.push(t.claim_id);
      writeFiles(t.worktree, { [CLI_TESTS]: DROPPING_RED });
      const red = runGate(t, 'red', s.control);
      expect(red.code, `attempt ${n}: ${red.out}`).toBe(0);
      commit(t.worktree, [CLI_TESTS], 'test: verbose without a version');
      writeFiles(t.worktree, { [CLI_SRC]: DROPPING_IMPL });
      const green = runGate(t, 'green', s.control);
      expect(green.code, green.out).toBe(0);
      commit(t.worktree, [CLI_SRC], 'feat: verbose without a version');
      expect(runGate(t, 'regression', s.control).code).toBe(0);
      writeResult(t, [{ criterion: 'AC-5', test_id: cliTestId(UNVERSIONED_TEST), gate: 'red', output_sha256: red.sha256 as string }]);
      const res = await settle(s, t);
      expect(head(s), `attempt ${n}`).toBe(integrated);
      expect(res.detail, `attempt ${n}`).toMatch(/SIBLING_PROGRESS_LOST/);
      expect(res.detail).toMatch(new RegExp(`${escapeRegExp(CLI)} AC-3`));
      if (n <= 2) {
        expect(res.outcome, `attempt ${n}: ${res.detail}`).toBe('PRECONDITION_FAILED');
        expect(charged(s, CLI2), `attempt ${n}`).toEqual({});
        expect(expState(s).nodes[CLI2].sibling_progress).toMatchObject({ cause: 'delta', count: n, lost: [{ node_id: CLI, criterion: 'AC-3' }] });
      } else {
        expect(res.outcome, res.detail).toBe('VERIFICATION_FAILED');
        expect(Object.keys(charged(s, CLI2)).join(' ')).toMatch(/SIBLING_PROGRESS_LOST/);
      }
      commitExpControl(s, `sibling attempt ${n}`);
    }
    expect(new Set(tickets).size).toBe(3);
    expect(git(s.repo, ['show', `${featureBranch}:${CLI_TESTS}`])).toContain(CLI_DEPENDENT_TEST);
  }, 600_000);
});

/** CSET-201's graph with the planner and the cli side by side on the types (`shared`: both may also write packages/shared/test/). */
function parallelGraph(shared: boolean): Record<string, unknown> {
  const graph = expGraph() as { nodes: { id: string; node_type: string; depends_on: string[]; allowed_paths: string[] }[] };
  if (shared) for (const n of graph.nodes) if (n.id === ASSEMBLE || n.id === CLI) n.allowed_paths.push('packages/shared/test/**');
  (graph.nodes.find((n) => n.id === CLI) as { depends_on: string[] }).depends_on = [TYPES];
  for (const n of graph.nodes) if (n.node_type === 'verification') n.depends_on = [...new Set([...n.depends_on, ASSEMBLE])];
  return graph;
}

async function typesSettled(shared: boolean): Promise<Exp> {
  const s = await createExplain({ graph: parallelGraph(shared), writerConcurrency: 2, review: { required: false } });
  const types = await ticketFor(s, TYPES);
  writeFiles(types.worktree, { 'packages/types/src/index.d.ts': 'export type VersionType = string;\n' });
  commit(types.worktree, ['packages/types/src/index.d.ts'], 'types');
  const green = runGate(types, 'green', s.control);
  expect(runGate(types, 'regression', s.control).code).toBe(0);
  writeResult(types, [{ criterion: 'AC-1', gate: 'green', output_sha256: green.sha256 as string }]);
  expect(await settle(s, types)).toMatchObject({ outcome: 'DONE' });
  return s;
}

const planner = (t: ShopTicket, control: string, extra: Record<string, string> = {}) => fulfil(t, { tests: { [ASM_TESTS]: ASM_RED, ...extra }, impl: { [ASM_SRC]: ASM_GEN0 }, criteria: [{ criterion: 'AC-2', gate: 'red', full_name: ASM_RED_TEST }] }, control);
const explainer = (t: ShopTicket, control: string, extra: Record<string, string> = {}, tests = CLI_RED) => fulfil(t, { tests: { [CLI_TESTS]: tests, ...extra }, impl: { [CLI_SRC]: CLI_GEN0 }, criteria: [{ criterion: 'AC-3', gate: 'red', full_name: CLI_RED_TEST }, { criterion: 'AC-4', gate: 'green', test_id: cliTestId(CLI_COMPAT_TEST) }] }, control);

describe('concurrent siblings: overlapping writers never run at once, disjoint ones merge, a conflict is reissued', () => {
  it('two writers sharing a test path are never claimed together: the second waits, then starts from the head the first integrated and keeps its edit', async () => {
    const s = await typesSettled(true);
    const a = await ticketFor(s, ASSEMBLE);
    const waiting = await dispatch(s);
    expect(waiting.status, waiting.detail).toBe('WAITING');
    expect(JSON.stringify(waiting)).toMatch(/PATH_OWNERSHIP_CONFLICT/);
    planner(a, s.control, { 'packages/shared/test/plan.json': '{"by":"assemble"}\n' });
    expect(await settle(s, a)).toMatchObject({ outcome: 'DONE' });
    const c = await ticketFor(s, CLI);
    expect(git(c.worktree, ['rev-parse', 'HEAD'])).toBe(head(s));
    explainer(c, s.control, { 'packages/shared/test/plan.json': '{"by":"assemble","and":"cli"}\n' });
    expect(await settle(s, c)).toMatchObject({ outcome: 'DONE' });
    expect(git(s.repo, ['show', `${featureBranch}:packages/shared/test/plan.json`])).toBe('{"by":"assemble","and":"cli"}');
  }, 600_000);

  it('disjoint writers run at once; the second integration merges three ways and lands, every standing proof kept', async () => {
    const s = await typesSettled(false);
    const a = await ticketFor(s, ASSEMBLE);
    const c = await ticketFor(s, CLI);
    expect(git(c.worktree, ['rev-parse', 'HEAD'])).toBe(git(a.worktree, ['rev-parse', 'HEAD']));
    planner(a, s.control);
    // The cli's own work, independent of the planner's: a verbose listing on the code its base holds.
    fulfil(c, { tests: { [CLI_TESTS]: STANDALONE_RED }, impl: { [CLI_SRC]: STANDALONE_IMPL }, criteria: [{ criterion: 'AC-3', gate: 'red', full_name: VERBOSE_TEST }, { criterion: 'AC-4', gate: 'green', test_id: cliTestId(CLI_COMPAT_TEST) }] }, s.control);
    expect(await settle(s, a)).toMatchObject({ outcome: 'DONE' });
    const r = await settle(s, c);
    expect(r, r.detail).toMatchObject({ outcome: 'DONE' });
    expect(git(s.repo, ['rev-list', '--parents', '-n', '1', featureBranch]).split(' ')).toHaveLength(3);
    expect(git(s.repo, ['show', `${featureBranch}:${ASM_TESTS}`])).toBe(ASM_RED.trimEnd());
    expect(git(s.repo, ['show', `${featureBranch}:${CLI_TESTS}`])).toBe(STANDALONE_RED.trimEnd());
  }, 600_000);

  it('a recorded sibling integration that conflicts with a claim in flight: refused uncharged, reissued from the latest head, where its worker resolves it', async () => {
    const s = await createExplain();
    await firstGenerations(s);
    expect((await reviewWith(s, 'R001', { 'AC-3': GAP_R001_AC3 })).settled).toMatchObject({ outcome: 'GAPS' });
    const c = await ticketFor(s, CLI);
    // While the cli's worker works, the integration head moves under it (a sibling's integration, recorded as the controller's):
    // the same end of the same test file.
    const integration = join(s.control, '.mycelink', 'integration', `integration__changesets__${EXP_FEATURE}`);
    const sibling = `${CLI_RED}\ntest('a sibling appended this', () => {});\n`;
    writeFiles(integration, { [CLI_TESTS]: sibling });
    const moved = commit(integration, [CLI_TESTS], 'sibling: append') as string;
    mutateState(s.featureDir, (st) => {
      st.integration_heads = { ...(st.integration_heads ?? {}), changesets: moved };
      return st;
    });
    cliReproof(c, s.control);
    const r = await settle(s, c);
    expect(r.outcome, r.detail).toBe('PRECONDITION_FAILED');
    expect(r.detail).toMatch(/SIBLING_PROGRESS_LOST: integrating it conflicts with a sibling's integrated work in packages\/cli\/test\/status\.test\.mjs/);
    expect(head(s)).toBe(moved);
    expect(charged(s, CLI)).toEqual({});
    expect(expState(s).nodes[CLI].sibling_progress).toMatchObject({ cause: 'conflict', conflicts: [CLI_TESTS] });
    // Reissued from the moved head: the worker writes its reproduction after the sibling's test.
    const again = await ticketFor(s, CLI);
    expect(git(again.worktree, ['rev-parse', 'HEAD'])).toBe(moved);
    const done = completedProof(again, 'AC-3');
    const rr = reprove(again, s.control, CLI_TESTS, `${sibling}${CLI_R001_REPRODUCTION.slice(CLI_RED.length)}`, [CLI_DEPENDENT_TEST, CLI_FIXED_TEST]);
    writeResult(again, [cite(done), { criterion: 'AC-3', test_id: rr.tests[0]!.id, gate: 'red', output_sha256: rr.red.sha256 as string }, { criterion: 'AC-4', test_id: cliTestId(CLI_COMPAT_TEST), gate: 'green', output_sha256: rr.green.sha256 as string }]);
    const settled = await settle(s, again);
    expect(settled, settled.detail).toMatchObject({ outcome: 'DONE' });
    expect(git(s.repo, ['show', `${featureBranch}:${CLI_TESTS}`])).toContain('a sibling appended this');
    expect(git(s.repo, ['show', `${featureBranch}:${CLI_TESTS}`])).toContain(CLI_DEPENDENT_TEST);
    expect(charged(s, CLI)).toEqual({});
  }, 600_000);
});

describe('what Mycelink did not integrate is never restored as if it had', () => {
  it('an integration branch moved outside Mycelink stops everything; nothing is reworked or restored', async () => {
    const s = await createExplain();
    await firstGenerations(s);
    const reworks = (expState(s).reworks ?? []).length;
    const integration = join(s.control, '.mycelink', 'integration', `integration__changesets__${EXP_FEATURE}`);
    writeFiles(integration, { [CLI_TESTS]: 'rewritten outside Mycelink\n' });
    commit(integration, [CLI_TESTS], 'force: rewrite');
    const d = await dispatch(s).catch((e: unknown) => ({ status: 'THREW', detail: String(e) }));
    expect(`${d.status} ${d.detail}`).toMatch(/INTEGRATION_BRANCH_MOVED/);
    expect((expState(s).reworks ?? []).length).toBe(reworks);
  }, 600_000);

  it('a head that lost a completed proof (as a core before this repair left it) is restored before any reviewer runs: re-proved on its original RED, nothing spent', async () => {
    const s = await createExplain();
    await firstGenerations(s);
    expect((await reviewWith(s, 'R001', { 'AC-3': GAP_R001_AC3 })).settled).toMatchObject({ outcome: 'GAPS' });
    const c = await ticketFor(s, CLI);
    cliReproof(c, s.control);
    expect(await settle(s, c)).toMatchObject({ outcome: 'DONE' });
    // The integrated head without the re-proof's tests, as the CSET-201 final core left it (never committed), recorded as the controller's.
    const integration = join(s.control, '.mycelink', 'integration', `integration__changesets__${EXP_FEATURE}`);
    writeFiles(integration, { [CLI_TESTS]: CLI_RED });
    const legacy = commit(integration, [CLI_TESTS], 'legacy: the re-proof was never committed') as string;
    mutateState(s.featureDir, (st) => {
      st.integration_heads = { ...(st.integration_heads ?? {}), changesets: legacy };
      return st;
    });
    commitExpControl(s, 'legacy head');
    const accepted = (): number => (expState(s).acceptance_review.lineage.events as { kind: string; verdict?: string; criterion?: string }[]).filter((e) => e.kind === 'gap' && e.verdict === 'accepted' && e.criterion === 'AC-3').length;
    expect(accepted()).toBe(1);
    // No reviewer yet: the cli is ordered to restore AC-3, carrying its original RED.
    const r = await ticketFor(s, CLI);
    const rework = packOf(r)['rework'] as Record<string, any>;
    expect(rework['acceptance_criteria']).toEqual(['AC-3']);
    expect(rework['reason']).toMatch(/AC-3 restoration \(its completed proof is lost; nothing spent\)/);
    const done = completedProof(r, 'AC-3');
    const root = (expState(s).nodes[CLI].criterion_ledger as Record<string, any>[]).find((x) => x.criterion === 'AC-3' && x.basis === 'red');
    expect(done.output_sha256).toBe(root.red.output_sha256);
    const lineage = expState(s).acceptance_review.lineage.events as Record<string, any>[];
    expect(lineage.filter((e) => e.kind === 'regression')).toEqual([expect.objectContaining({ criterion: 'AC-3', node_id: CLI, code: 'COMPLETION_REPROOF_MISSING' })]);
    expect(expState(s).acceptance_review.reviews).toHaveLength(1);
    cliReproof(r, s.control);
    const restored = await settle(s, r);
    expect(restored, restored.detail).toMatchObject({ outcome: 'DONE' });
    expect(git(s.repo, ['show', `${featureBranch}:${CLI_TESTS}`])).toBe(CLI_R001_REPRODUCTION.trimEnd());
    commitExpControl(s, 'restored');
    // Then the review, on a head that holds every proof; nothing was spent from AC-3's budget.
    const nd = await dispatch(s);
    expect(nd.ticket, JSON.stringify(nd).slice(0, 1500)).toBeDefined();
    const t = nd.ticket as unknown as { review_id: string };
    expect(t.review_id).toBe(`${EXP_FEATURE}-R002`);
    expect(accepted()).toBe(1);
    for (const [id, rt] of Object.entries(expState(s).nodes as Record<string, any>)) expect(rt.failure_counts, id).toEqual({});
  }, 600_000);
});
