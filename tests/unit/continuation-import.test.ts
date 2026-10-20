import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { validateCompletionImport } from '../../src/engine/continuation-import.js';
import { COMPLETION_SCHEMA, productionDelta, sealCompletion } from '../../src/engine/criterion-ledger.js';
import { DEFAULT_TDD_POLICY } from '../../src/engine/tdd-history.js';
import { hashGraph } from '../../src/graph/validate.js';
import { initialState } from '../../src/state/feature-state.js';
import type { EvidenceRecord, PortfolioGraph } from '../../src/model/types.js';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { commitAll, git, makeGitRepo } from '../helpers/git-fixture.js';

afterAll(() => cleanupTmpRoots());
const sha = (x: Buffer | string): string => createHash('sha256').update(x).digest('hex');
const feature = 'FEAT-1';
const producer = 'FEAT-1.errors.impl';
const remaining = 'FEAT-1.read.impl';
const policy = { ...DEFAULT_TDD_POLICY, test_paths: ['test/**'], production_roots: [], declaration_paths: [] };

function fixture() {
  const root = makeTmpDir('continuation-import-');
  const repo = makeGitRepo(join(root, 'app'), { files: { 'src/index.mjs': 'export const value = 0;\n' } });
  const base = git(repo, ['rev-parse', 'HEAD']);
  mkdirSync(join(repo, 'test'), { recursive: true });
  writeFileSync(join(repo, 'test', 'value.test.mjs'), "import { test } from 'node:test';\ntest('value works', () => {});\n");
  commitAll(repo, 'test: value');
  writeFileSync(join(repo, 'src', 'index.mjs'), 'export const value = 1;\n');
  const head = commitAll(repo, 'fix: value');
  const graph = { feature_id: feature, acceptance_criteria: [{ id: 'AC-1', kind: 'new-behavior', text: 'value works' }, { id: 'AC-2', kind: 'new-behavior', text: 'read works' }], nodes: [{ id: producer, repository: 'app', node_type: 'implementation', acceptance_criteria: ['AC-1'], required_evidence: ['red', 'green', 'regression'] }, { id: remaining, repository: 'app', node_type: 'implementation', acceptance_criteria: ['AC-2'], depends_on: [producer] }] } as PortfolioGraph;
  const sourceRoot = join(root, 'source');
  const log = `features/${feature}/evidence/${producer}/ledger/AC-1.g0.claim/red.log`;
  mkdirSync(join(sourceRoot, ...log.split('/').slice(0, -1)), { recursive: true });
  writeFileSync(join(sourceRoot, ...log.split('/')), 'not ok 1 value works\n');
  const red: EvidenceRecord = { kind: 'red', node_id: producer, command: ['node', '--test'], exit_code: 1, started_at: 'x', finished_at: 'x', cwd: '.', repository: 'app', commit_sha: null, output_path: log, output_sha256: sha('not ok 1 value works\n'), failure_fingerprint: 'abc', red_reason: 'behaviour-missing', red_category: 'assertion' };
  const record = sealCompletion({ schema: COMPLETION_SCHEMA, node_id: producer, criterion: 'AC-1', kind: 'new-behavior', generation: 0, basis: 'red', source: null, parent: null, claim_id: 'claim', dispatch_id: null, settled_at: '2026-10-20T00:00:00Z', order: null, repo: { repository: 'app', base_sha: base, head_sha: head, integrated_sha: head }, production: productionDelta(repo, policy, base, head), proof: { test_id: '0123456789abcdef', test: { path: 'test/value.test.mjs', name: 'value works' }, test_blob: git(repo, ['rev-parse', `${head}:test/value.test.mjs`]), gate: 'red', output_sha256: red.output_sha256 }, red: { output_sha256: red.output_sha256, record: red }, history: null, reproof: null, archive: `features/${feature}/evidence/${producer}/ledger/AC-1.g0.claim` });
  const source = initialState(graph, hashGraph(graph));
  source.acceptance = { path: `features/${feature}/ACCEPTANCE.json`, sha256: sha('approved criteria') };
  source.nodes[producer]!.state = 'DONE';
  source.nodes[producer]!.integrated_sha = head;
  source.nodes[producer]!.criterion_ledger = [record];
  source.nodes[producer]!.criteria = [{ criterion: 'AC-1', test_id: record.proof.test_id, test: record.proof.test, gate: 'red', output_sha256: red.output_sha256 }];
  source.nodes[producer]!.evidence.red = red;
  for (const kind of ['green', 'regression'] as const) {
    const output_path = `features/${feature}/evidence/${producer}/${kind}.log`;
    writeFileSync(join(sourceRoot, ...output_path.split('/')), 'ok 1 value works\n');
    source.nodes[producer]!.evidence[kind] = { ...red, kind, exit_code: 0, output_path, output_sha256: sha('ok 1 value works\n') };
  }
  const historyPath = `features/${feature}/evidence/${producer}/tdd-history.json`;
  writeFileSync(join(sourceRoot, ...historyPath.split('/')), '{"ok":true}\n');
  source.nodes[producer]!.tdd_history = { ok: true, base_sha: base, head_sha: head, cycles: 1, compatibility_units: 0, code: null, policy_sha256: sha('policy'), output_path: historyPath, output_sha256: sha('{"ok":true}\n'), verified_at: '2026-10-20T00:00:00Z' };
  const target = initialState(graph, hashGraph(graph));
  target.acceptance = { ...source.acceptance };
  const bytes = Buffer.from(JSON.stringify({ revision: 3, data: source }));
  const args = { sourceControlRoot: sourceRoot, sourceStateBytes: bytes, expectedSourceSha256: sha(bytes), sourceGraph: graph, targetGraph: graph, targetState: target, repositoryPath: repo, head, policy, completedNodes: [producer] };
  return { args, root, repo, base, head, record, log };
}

const codes = (args: ReturnType<typeof fixture>['args']) => validateCompletionImport(args).problems.map((p) => p.code);

describe('read-only continuation completion import preflight', () => {
  it('recognises a pinned independently completed producer at the descendant head without making it DONE', () => {
    const f = fixture();
    expect(codes(f.args)).toEqual([]);
    expect(f.args.targetState.nodes[producer]!.state).toBe('PLANNED');
    expect(f.args.targetGraph.acceptance_criteria.map((a) => a.id)).toEqual(['AC-1', 'AC-2']);
  });
  it('rejects altered source bytes and altered archived RED even if the state bytes remain pinned', () => {
    const f = fixture();
    expect(codes({ ...f.args, sourceStateBytes: Buffer.from(f.args.sourceStateBytes.toString().replace('claim', 'other')) })).toContain('IMPORT_SOURCE_HASH');
    writeFileSync(join(f.args.sourceControlRoot, ...f.log.split('/')), 'ok 1 forged\n');
    expect(codes(f.args)).toContain('IMPORT_LEDGER_INVALID');
  });
  it('refuses a missing GREEN receipt or altered test-first history, despite intact completion records', () => {
    const f = fixture();
    const source = JSON.parse(f.args.sourceStateBytes.toString()) as { revision: number; data: typeof f.args.targetState };
    source.data.nodes[producer]!.evidence.green!.output_sha256 = '0'.repeat(64);
    const bytes = Buffer.from(JSON.stringify(source));
    expect(codes({ ...f.args, sourceStateBytes: bytes, expectedSourceSha256: sha(bytes) })).toContain('IMPORT_GATE_INVALID');
    writeFileSync(join(f.args.sourceControlRoot, 'features', feature, 'evidence', producer, 'tdd-history.json'), '{}\n');
    expect(codes(f.args)).toContain('IMPORT_HISTORY_INVALID');
  });
  it('rejects wrong feature, criterion ownership, and changed acceptance text', () => {
    const f = fixture();
    expect(codes({ ...f.args, targetGraph: { ...f.args.targetGraph, feature_id: 'FEAT-2' } })).toContain('IMPORT_GRAPH_MISMATCH');
    expect(codes({ ...f.args, targetGraph: { ...f.args.targetGraph, acceptance_criteria: [{ id: 'AC-1', kind: 'new-behavior', text: 'weakened' }, f.args.targetGraph.acceptance_criteria[1]!] } })).toContain('IMPORT_GRAPH_MISMATCH');
    expect(codes({ ...f.args, completedNodes: [remaining] })).toContain('IMPORT_PRODUCER_NOT_DONE');
  });
  it('rejects unrelated ancestry, missing proof, and duplicate or replayed target state', () => {
    const f = fixture();
    git(f.repo, ['reset', '--hard', f.base]);
    expect(codes({ ...f.args, head: f.base })).toContain('IMPORT_ANCESTRY');
    git(f.repo, ['reset', '--hard', f.head]);
    expect(codes({ ...f.args, completedNodes: [producer, producer] })).toContain('IMPORT_DUPLICATE');
    const target = structuredClone(f.args.targetState);
    target.nodes[producer]!.state = 'DONE';
    expect(codes({ ...f.args, targetState: target })).toContain('IMPORT_REPLAY');
    const source = JSON.parse(f.args.sourceStateBytes.toString()) as { revision: number; data: typeof f.args.targetState };
    source.data.nodes[producer]!.criteria = [];
    const bytes = Buffer.from(JSON.stringify(source));
    expect(codes({ ...f.args, sourceStateBytes: bytes, expectedSourceSha256: sha(bytes) })).toContain('IMPORT_CRITERION_MISSING');
  });
  it('does not accept a declared head that is not the checkout HEAD', () => {
    const f = fixture();
    git(f.repo, ['reset', '--hard', f.base]);
    expect(codes(f.args)).toContain('IMPORT_HEAD_MISMATCH');
    expect(f.args.targetState.nodes[producer]!.state).toBe('PLANNED');
  });
  it('does not import a dependent completion without its producer or with a duplicate accepted proof', () => {
    const f = fixture();
    const source = JSON.parse(f.args.sourceStateBytes.toString()) as { revision: number; data: typeof f.args.targetState };
    source.data.nodes[remaining]!.state = 'DONE';
    source.data.nodes[remaining]!.integrated_sha = f.head;
    const bytes = Buffer.from(JSON.stringify(source));
    expect(codes({ ...f.args, sourceStateBytes: bytes, expectedSourceSha256: sha(bytes), completedNodes: [remaining] })).toContain('IMPORT_DEPENDENCY_MISSING');
    const duplicated = JSON.parse(f.args.sourceStateBytes.toString()) as { revision: number; data: typeof f.args.targetState };
    duplicated.data.nodes[producer]!.criteria!.push(structuredClone(duplicated.data.nodes[producer]!.criteria![0]!));
    const replay = Buffer.from(JSON.stringify(duplicated));
    expect(codes({ ...f.args, sourceStateBytes: replay, expectedSourceSha256: sha(replay) })).toContain('IMPORT_CRITERION_MISSING');
  });
});
