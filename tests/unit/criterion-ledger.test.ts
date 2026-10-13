/**
 * The criterion completion ledger's pure parts (engine/criterion-ledger.ts; CSET-203 r16): a record is bound by its
 * hash and its archived proof; its lineage names records the node holds; a completed criterion is revalidated on a new
 * head — its work in the head, its test as it was proved, its production change still there (or changed by someone else
 * only where its test still passes there); a generation that runs no RED stands on the attested RED of a completion it
 * carries; a state from before the ledger derives its records from what its rework history kept.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { commitAll, git, makeGitRepo } from '../helpers/git-fixture.js';
import {
  COMPLETION_SCHEMA,
  carriedRed,
  completionProblem,
  completionSha256,
  completionsOf,
  ledgerProblems,
  migratedLedger,
  productionDelta,
  revalidateCompletion,
  rootCompletion,
  sealCompletion,
  type CompletionBody,
} from '../../src/engine/criterion-ledger.js';
import { DEFAULT_TDD_POLICY } from '../../src/engine/tdd-history.js';
import type { CriterionCompletion, EvidenceRecord, GraphNode, NodeRuntime, PortfolioGraph } from '../../src/model/types.js';

afterAll(() => cleanupTmpRoots());

const F = 'FEAT-1';
const NODE = 'FEAT-1.app.cli.impl';
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const policy = { ...DEFAULT_TDD_POLICY, test_paths: ['test/**'], production_roots: [], declaration_paths: [] };

const TEST_V1 = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { warn } from '../src/index.mjs';\n\ntest('warns that the run was interrupted', () => {\n  assert.match(warn(), /interrupted/);\n});\n";
const SRC_BEFORE = 'export function warn() {\n  return "";\n}\n';
const SRC_FIX = 'export function warn() {\n  return "the run was interrupted";\n}\n';

const graph = {
  feature_id: F,
  acceptance_criteria: [
    { id: 'AC-3', kind: 'new-behavior', text: 'AC-3 recovery warns interrupted' },
    { id: 'AC-5', kind: 'compatibility', text: 'AC-5 status unchanged' },
  ],
  nodes: [],
} as unknown as PortfolioGraph;
const node = { id: NODE, repository: 'app', node_type: 'implementation', acceptance_criteria: ['AC-3', 'AC-5'], allowed_paths: ['**'], required_evidence: ['red', 'green', 'regression'] } as unknown as GraphNode;

/** A repository at the RED's base, then its fix: [base, head]. */
function repo(): { path: string; base: string; head: string } {
  const path = makeGitRepo(join(makeTmpDir('ledger-'), 'app'), { files: { 'src/index.mjs': SRC_BEFORE, 'README.md': '# app\n' } });
  const base = git(path, ['rev-parse', 'HEAD']);
  mkdirSync(join(path, 'test'), { recursive: true });
  writeFileSync(join(path, 'test', 'cli.test.mjs'), TEST_V1);
  commitAll(path, 'test: warn');
  writeFileSync(join(path, 'src', 'index.mjs'), SRC_FIX);
  const head = commitAll(path, 'fix: warn');
  return { path, base, head };
}

/** A control root holding a RED's output (and results) under the feature's evidence. */
function control(): { root: string; red: EvidenceRecord } {
  const root = makeTmpDir('ledger-control-');
  const dir = join(root, 'features', F, 'evidence', NODE, 'ledger', 'AC-3.g0.claim-0');
  mkdirSync(dir, { recursive: true });
  const log = 'not ok 1 - warns that the run was interrupted\n';
  writeFileSync(join(dir, 'red.log'), log);
  const red: EvidenceRecord = { kind: 'red', node_id: NODE, command: ['node', '--test'], exit_code: 1, started_at: 'x', finished_at: 'x', cwd: '.', repository: 'app', commit_sha: null, output_path: `features/${F}/evidence/${NODE}/ledger/AC-3.g0.claim-0/red.log`, output_sha256: sha(log), failure_fingerprint: 'abc', red_reason: 'behaviour-missing', red_category: 'assertion' };
  return { root, red };
}

function body(r: { base: string; head: string; path: string }, red: EvidenceRecord, over: Partial<CompletionBody> = {}): CompletionBody {
  return {
    schema: COMPLETION_SCHEMA,
    node_id: NODE,
    criterion: 'AC-3',
    kind: 'new-behavior',
    generation: 0,
    basis: 'red',
    source: null,
    parent: null,
    claim_id: 'claim-0',
    dispatch_id: null,
    settled_at: '2026-10-11T00:00:00.000Z',
    order: null,
    repo: { repository: 'app', base_sha: r.base, head_sha: r.head, integrated_sha: r.head },
    production: productionDelta(r.path, policy, r.base, r.head),
    proof: { test_id: '0123456789abcdef', test: { path: 'test/cli.test.mjs', name: 'warns that the run was interrupted' }, test_blob: null, gate: 'red', output_sha256: red.output_sha256 },
    red: { output_sha256: red.output_sha256, record: red },
    history: null,
    reproof: null,
    archive: `features/${F}/evidence/${NODE}/ledger/AC-3.g0.claim-0`,
    ...over,
  };
}

describe('a completion record', () => {
  it('is bound by its hash: sealed, its id from it; any change to it (or to its archived RED) is tampering', () => {
    const r = repo();
    const c = control();
    const rec = sealCompletion(body(r, c.red));
    expect(rec.record_id).toBe(`CC-${rec.sha256.slice(0, 16)}`);
    expect(completionSha256(rec)).toBe(rec.sha256);
    expect(completionProblem(c.root, F, rec)).toBeNull();
    const edited: CriterionCompletion = { ...rec, proof: { ...rec.proof, output_sha256: '0'.repeat(64) } };
    expect(completionProblem(c.root, F, edited)).toMatch(/^COMPLETION_TAMPERED/);
    writeFileSync(join(c.root, ...c.red.output_path.split('/')), 'ok 1 - forged\n');
    expect(completionProblem(c.root, F, rec)).toMatch(/^COMPLETION_TAMPERED: the RED/);
  });

  it("its lineage names records the node holds: a carried completion's root is the one that ran the RED", () => {
    const r = repo();
    const c = control();
    const g0 = sealCompletion(body(r, c.red));
    const g1 = sealCompletion(body(r, c.red, { generation: 1, basis: 'carried', source: g0.record_id, parent: g0.record_id, claim_id: 'claim-1' }));
    const g2 = sealCompletion(body(r, c.red, { generation: 2, basis: 'reproved', source: g1.record_id, parent: g1.record_id, claim_id: 'claim-2' }));
    expect(rootCompletion([g0, g1, g2], g2).record_id).toBe(g0.record_id);
    expect(ledgerProblems(c.root, F, [g0, g1, g2])).toEqual([]);
    expect(ledgerProblems(c.root, F, [g1, g2])[0]).toMatch(/^COMPLETION_LINEAGE_INVALID/);
  });

  it('records the production delta of its generation, test paths left out, each blob before and after', () => {
    const r = repo();
    const delta = productionDelta(r.path, policy, r.base, r.head);
    expect(delta.paths).toEqual([{ path: 'src/index.mjs', before: git(r.path, ['rev-parse', `${r.base}:src/index.mjs`]), after: git(r.path, ['rev-parse', `${r.head}:src/index.mjs`]) }]);
    expect(delta.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('revalidated on a new head', () => {
  const setup = (): { r: ReturnType<typeof repo>; c: ReturnType<typeof control>; rec: CriterionCompletion } => {
    const r = repo();
    const c = control();
    return { r, c, rec: sealCompletion(body(r, c.red)) };
  };
  const judge = (s: ReturnType<typeof setup>, head: string, ledger?: CriterionCompletion[]) =>
    revalidateCompletion({ controlRoot: s.c.root, featureId: F, record: s.rec, ledger: ledger ?? [s.rec], repoPath: s.r.path, head, policy });

  it('holds on the head it was proved at, and on a later one that changed nothing of it — whose test still runs there', () => {
    const s = setup();
    expect(judge(s, s.r.head)).toEqual({ ok: true, retest: false });
    writeFileSync(join(s.r.path, 'TEAM-NOTES.md'), '# notes\n');
    const later = commitAll(s.r.path, 'docs: team notes');
    expect(judge(s, later)).toEqual({ ok: true, retest: true });
    // A test appended beside it keeps its own block: still the test that proved it.
    writeFileSync(join(s.r.path, 'test', 'cli.test.mjs'), `${TEST_V1}\ntest('another', () => {\n  assert.ok(true);\n});\n`);
    expect(judge(s, commitAll(s.r.path, 'test: another'))).toEqual({ ok: true, retest: true });
  });

  it('a head without the work that completed it is stale', () => {
    const s = setup();
    expect(judge(s, s.r.base)).toMatchObject({ ok: false, code: 'COMPLETION_BASE_STALE', hard: true });
  });

  it('its test weakened (or removed) is changed: what proved it is not what is there', () => {
    const s = setup();
    writeFileSync(join(s.r.path, 'test', 'cli.test.mjs'), TEST_V1.replace('assert.match(warn(), /interrupted/);', 'assert.ok(true);'));
    expect(judge(s, commitAll(s.r.path, 'test: weaken'))).toMatchObject({ ok: false, code: 'COMPLETION_TEST_CHANGED', hard: true });
  });

  it('its fix reverted is deleted; changed by someone else, it holds only while its test passes (soft); changed by its own later generation, it holds', () => {
    const s = setup();
    writeFileSync(join(s.r.path, 'src', 'index.mjs'), SRC_BEFORE);
    const reverted = commitAll(s.r.path, 'chore: sync platform changes');
    expect(judge(s, reverted)).toMatchObject({ ok: false, code: 'COMPLETION_FIX_DELETED', hard: true });
    git(s.r.path, ['reset', '-q', '--hard', s.r.head]);
    writeFileSync(join(s.r.path, 'src', 'index.mjs'), SRC_FIX.replace('the run was interrupted', 'the run was interrupted earlier'));
    const teammate = commitAll(s.r.path, 'feat: teammate wording');
    expect(judge(s, teammate)).toMatchObject({ ok: false, code: 'COMPLETION_FIX_CHANGED', hard: false });
    // The same change made by the node's own later generation is the node's, never a conflict.
    const own = sealCompletion(body(s.r, s.c.red, { generation: 1, criterion: 'AC-4', claim_id: 'claim-1', repo: { repository: 'app', base_sha: s.r.head, head_sha: teammate, integrated_sha: teammate }, production: productionDelta(s.r.path, policy, s.r.head, teammate) }));
    expect(judge(s, teammate, [s.rec, own])).toEqual({ ok: true, retest: true });
  });

  it('a record tampered with is never revalidated', () => {
    const s = setup();
    const forged = { ...s.rec, settled_at: '2026-10-12T00:00:00.000Z' };
    expect(revalidateCompletion({ controlRoot: s.c.root, featureId: F, record: forged, ledger: [forged], repoPath: s.r.path, head: s.r.head, policy })).toMatchObject({ ok: false, code: 'COMPLETION_TAMPERED', hard: true });
  });
});

describe('the RED a generation that runs none stands on', () => {
  it("is the attested RED of a completion it carries, followed to its root, marked with where it came from; never a tampered one", () => {
    const r = repo();
    const c = control();
    const g0 = sealCompletion(body(r, c.red));
    const g1 = sealCompletion(body(r, c.red, { generation: 1, basis: 'carried', source: g0.record_id, parent: g0.record_id, red: null, claim_id: 'claim-1' }));
    const red = carriedRed(c.root, F, [g0, g1], [g1.record_id]);
    expect(red).toMatchObject({ exit_code: 1, red_reason: 'behaviour-missing', output_sha256: c.red.output_sha256, carried_from: { record_id: g0.record_id, criterion: 'AC-3', generation: 0, claim_id: 'claim-0' } });
    writeFileSync(join(c.root, ...c.red.output_path.split('/')), 'forged\n');
    expect(carriedRed(c.root, F, [g0, g1], [g1.record_id])).toBeNull();
  });
});

describe('a state from before the ledger', () => {
  it("derives each settled generation's records from its rework history: the RED it ran, the proof it carried", () => {
    const r = repo();
    const c = control();
    const rt = {
      state: 'INVALIDATED',
      criteria: [],
      evidence: {},
      rework_history: [
        {
          at: '2026-10-11T00:00:00.000Z',
          reason: 'R001',
          decision_id: null,
          attempts: 1,
          failure_counts: {},
          integrated_sha: r.head,
          branch_head: r.head,
          archived_ref: null,
          candidate_id: null,
          evidence: { red: { output_path: c.red.output_path, output_sha256: c.red.output_sha256, exit_code: 1, commit_sha: null } },
          generation: 0,
          claim_id: 'claim-0',
          dispatch_id: null,
          criteria: [
            { criterion: 'AC-3', test_id: '0123456789abcdef', test: { path: 'test/cli.test.mjs', name: 'warns that the run was interrupted' }, gate: 'red', output_sha256: c.red.output_sha256 },
            { criterion: 'AC-5', test_id: 'fedcba9876543210', test: { path: 'test/cli.test.mjs', name: 'status' }, gate: 'green', output_sha256: sha('green') },
          ],
          settlement: { capability_sha256: sha('cap'), claim_id: 'claim-0', outcome: 'DONE', state: 'DONE', detail: 'ok', settled_at: '2026-10-11T00:00:00.000Z' },
          restore: { state: 'DONE', attempts: 1, failure_counts: {}, last_failure_fingerprint: null, integrated_sha: r.head, branch_base_sha: r.base, evidence: { red: c.red }, criteria: [], tdd_history: null, tdd_red_bindings: [], last_settlement: null, carried_criterion_proofs: [], worktree_setup: null },
        },
      ],
    } as unknown as NodeRuntime;
    const ledger = migratedLedger({ controlRoot: c.root, featureId: F, graph, node, runtime: rt, repoPath: r.path, policy });
    expect(ledger.map((x) => [x.criterion, x.basis, x.generation, x.migrated])).toEqual([
      ['AC-3', 'red', 0, true],
      ['AC-5', 'compatibility', 0, true],
    ]);
    expect(ledger[0]?.red?.record).toMatchObject({ output_path: c.red.output_path, exit_code: 1 });
    expect(ledger[0]?.production.paths.map((p) => p.path)).toEqual(['src/index.mjs']);
    expect(ledger.every((x) => completionSha256(x) === x.sha256)).toBe(true);
  });
});

describe("a settled generation's records", () => {
  it('one per criterion, never twice for the same claim: its own RED archived, a carried proof naming the completion it stands on', () => {
    const r = repo();
    const c = control();
    // The live RED the generation ran, at its usual place (the archive copies it).
    const liveDir = join(c.root, 'features', F, 'evidence', NODE);
    writeFileSync(join(liveDir, 'red.log'), 'not ok 1 - live\n');
    const live: EvidenceRecord = { ...c.red, output_path: `features/${F}/evidence/${NODE}/red.log`, output_sha256: sha('not ok 1 - live\n') };
    const prior = sealCompletion(body(r, c.red, { criterion: 'AC-5', kind: 'compatibility', basis: 'compatibility', red: null, proof: { test_id: 'fedcba9876543210', test: { path: 'test/cli.test.mjs', name: 'status' }, test_blob: null, gate: 'green', output_sha256: sha('g') } }));
    const rt = {
      state: 'INTEGRATED',
      evidence: { red: live },
      criteria: [
        { criterion: 'AC-3', test_id: '0123456789abcdef', test: { path: 'test/cli.test.mjs', name: 'warns that the run was interrupted' }, gate: 'red', output_sha256: live.output_sha256 },
        { criterion: 'AC-5', test_id: 'fedcba9876543210', test: { path: 'test/cli.test.mjs', name: 'status' }, gate: 'regression', output_sha256: sha('fresh'), carried: true, carried_from: { generation: 0, gate: 'green', output_sha256: sha('g'), claim_id: 'claim-0', dispatch_id: null, repo_sha: r.head, record_id: prior.record_id } },
      ],
      tdd_history: null,
    } as unknown as NodeRuntime;
    const g = { controlRoot: c.root, featureId: F, graph, node, runtime: rt, ledger: [prior], repoPath: r.path, policy, generation: 1, claimId: 'claim-1', dispatchId: 'd-1', base: r.base, head: r.head, integrated: r.head, order: null, snapshots: [], settledAt: '2026-10-11T01:00:00.000Z' };
    const made = completionsOf(g);
    const by = Object.fromEntries(made.records.map((x) => [x.criterion, x]));
    expect(by['AC-3']).toMatchObject({ basis: 'red', generation: 1, source: null, red: { output_sha256: live.output_sha256, record: { output_path: expect.stringMatching(/ledger\/AC-3\.g1\.claim-1\/red\.log$/) } } });
    expect(by['AC-5']).toMatchObject({ basis: 'carried', source: prior.record_id, parent: prior.record_id });
    // Each copy carries exactly the bytes its record names: an archive never keeps anything else.
    expect(made.copies).toEqual([{ from: live.output_path, to: expect.stringMatching(/ledger\/AC-3\.g1\.claim-1\/red\.log$/), sha256: live.output_sha256 }]);
    // Recorded once: the same claim's generation adds nothing again.
    expect(completionsOf({ ...g, ledger: [prior, ...made.records] }).records).toEqual([]);
  });
});
