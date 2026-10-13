/**
 * Which archive may restore a stale evidence pointer (engine/evidence-integrity.ts).
 *
 * Exact bytes are necessary and never sufficient: the archive's provenance —
 * the node, gate, generation and claim, and where known the commit, module,
 * plan and exit — must be attested by the node's own records and match the
 * stale record's, and no two archives may disagree about it. Otherwise the
 * repair is refused and the pointer stays as it is.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { evidenceReferences, repairSourceFor, type EvidenceReference } from '../../src/engine/evidence-integrity.js';
import { sealCompletion, COMPLETION_SCHEMA, type CompletionBody } from '../../src/engine/criterion-ledger.js';
import type { EvidenceRecord, FeatureState_, NodeRuntime } from '../../src/model/types.js';

afterAll(() => cleanupTmpRoots());

const F = 'F-1';
const N = 'F-1.core.impl';
const DIR = `features/${F}/evidence/${N}`;
const sha = (b: string): string => createHash('sha256').update(b).digest('hex');
const BYTES = '$ node tests/run.mjs\n(cwd: .)\n\nnot ok 1 publishes\n';
const H = sha(BYTES);
const COMMIT = 'c'.repeat(40);

function put(root: string, rel: string, bytes: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), bytes);
}

function redRecord(over: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return { kind: 'red', node_id: N, command: ['node', 'tests/run.mjs'], exit_code: 1, started_at: '2026-10-11T00:00:00.000Z', finished_at: '2026-10-11T00:00:01.000Z', cwd: '.', repository: 'core', commit_sha: COMMIT, output_path: `${DIR}/${N}.red.log`, output_sha256: H, failure_fingerprint: 'f'.repeat(16), module: 'core', module_sha256: 'm'.repeat(64), plan_sha256: 'p'.repeat(64), red_reason: 'behaviour-missing', ...over };
}

function stateWith(rt: Partial<NodeRuntime>): FeatureState_ {
  const node = { state: 'DONE', attempts: 1, claim: null, evidence: {}, failure_counts: {}, last_failure_fingerprint: null, integrated_sha: null, blocked_reason: null, usage: {}, updated_at: '2026-10-11T00:00:00.000Z', last_settlement: { claim_id: 'claim-1' }, rework_history: [{ generation: 0, claim_id: 'claim-0', evidence: {}, red_bindings: [] }], ...rt } as unknown as NodeRuntime;
  return { feature_id: F, nodes: { [N]: node } } as unknown as FeatureState_;
}

function liveRed(state: FeatureState_): EvidenceReference {
  return evidenceReferences(state).find((r) => r.key === `node:${N}:evidence:red`) as EvidenceReference;
}

function ledgerRecord(over: Partial<CompletionBody> = {}, red: EvidenceRecord = redRecord({ output_path: `${DIR}/ledger/AC-1.g1.claim-1/red.log` })) {
  const body: CompletionBody = {
    schema: COMPLETION_SCHEMA,
    node_id: N,
    criterion: 'AC-1',
    kind: 'new-behavior',
    generation: 1,
    basis: 'red',
    source: null,
    parent: null,
    claim_id: 'claim-1',
    dispatch_id: null,
    settled_at: '2026-10-11T00:00:02.000Z',
    order: null,
    repo: { repository: 'core', base_sha: COMMIT, head_sha: COMMIT, integrated_sha: COMMIT },
    production: { paths: [], sha256: sha('[]') },
    proof: { test_id: 'a'.repeat(16), test: { path: 'tests/publish.test.mjs', name: 'publishes' }, test_blob: null, gate: 'red', output_sha256: H },
    red: { output_sha256: H, record: red },
    history: null,
    reproof: null,
    archive: `${DIR}/ledger/AC-1.g1.claim-1`,
    ...over,
  };
  return sealCompletion(body);
}

describe('repair provenance', () => {
  it('takes the exact archive whose provenance is the record\'s: the generation\'s own red gate binding', () => {
    const root = makeTmpDir('provenance-');
    put(root, `${DIR}/${N}.red.log`, 'a later run\n');
    put(root, `${DIR}/challenge-red/${H.slice(0, 16)}/gate/red.log`, BYTES);
    const state = stateWith({ evidence: { red: redRecord() }, tdd_red_bindings: [{ head_sha: COMMIT, tests: [], tests_sha256: 'x', evidence_sha256: H, recorded_at: 'x' }] });
    const v = repairSourceFor(root, F, state, liveRed(state));
    expect(v).toMatchObject({ ok: true, source: { kind: 'challenge-snapshot', path: `${DIR}/challenge-red/${H.slice(0, 16)}/gate/red.log` } });
  });

  it('refuses an archive another generation attests (wrong generation, wrong claim)', () => {
    const root = makeTmpDir('provenance-');
    put(root, `${DIR}/challenge-red/${H.slice(0, 16)}/gate/red.log`, BYTES);
    // Only rework 0 (generation 0, claim-0) ran a red gate that wrote these bytes; the record is generation 1's.
    const state = stateWith({ evidence: { red: redRecord() }, tdd_red_bindings: [], rework_history: [{ generation: 0, claim_id: 'claim-0', evidence: {}, red_bindings: [{ head_sha: COMMIT, tests: [], tests_sha256: 'x', evidence_sha256: H, recorded_at: 'x' }] }] as unknown as NodeRuntime['rework_history'] });
    const v = repairSourceFor(root, F, state, liveRed(state));
    expect(v.ok).toBe(false);
    expect(v).toMatchObject({ code: 'EVIDENCE_REPAIR_PROVENANCE' });
    expect((v as { detail: string }).detail).toMatch(/claim claim-0|generation 0/);
  });

  it('refuses a replaced generation\'s record whose claim is not the stale one (wrong capability)', () => {
    const root = makeTmpDir('provenance-');
    put(root, `${DIR}/challenge-red/${H.slice(0, 16)}/gate/red.log`, BYTES);
    // The stale pointer is rework 0's (claim-0): the live generation's binding (claim-1) does not stand for it.
    const state = stateWith({
      evidence: {},
      tdd_red_bindings: [{ head_sha: COMMIT, tests: [], tests_sha256: 'x', evidence_sha256: H, recorded_at: 'x' }],
      rework_history: [{ generation: 0, claim_id: 'claim-0', evidence: { red: { output_path: `${DIR}/${N}.red.log`, output_sha256: H, exit_code: 1, commit_sha: COMMIT } }, red_bindings: [] }] as unknown as NodeRuntime['rework_history'],
    });
    const ref = evidenceReferences(state).find((r) => r.key === `node:${N}:rework:0:evidence:red`) as EvidenceReference;
    const v = repairSourceFor(root, F, state, ref);
    expect(v).toMatchObject({ ok: false, code: 'EVIDENCE_REPAIR_PROVENANCE' });
  });

  it('refuses a red gate binding of another base (wrong commit)', () => {
    const root = makeTmpDir('provenance-');
    put(root, `${DIR}/challenge-red/${H.slice(0, 16)}/gate/red.log`, BYTES);
    const state = stateWith({ evidence: { red: redRecord() }, tdd_red_bindings: [{ head_sha: 'd'.repeat(40), tests: [], tests_sha256: 'x', evidence_sha256: H, recorded_at: 'x' }] });
    const v = repairSourceFor(root, F, state, liveRed(state));
    expect(v).toMatchObject({ ok: false, code: 'EVIDENCE_REPAIR_PROVENANCE' });
    expect((v as { detail: string }).detail).toMatch(/commit/);
  });

  it('refuses a completion record of another module (wrong module)', () => {
    const root = makeTmpDir('provenance-');
    const rec = ledgerRecord({}, redRecord({ output_path: `${DIR}/ledger/AC-1.g1.claim-1/red.log`, module_sha256: 'n'.repeat(64) }));
    put(root, `${DIR}/ledger/AC-1.g1.claim-1/red.log`, BYTES);
    const state = stateWith({ evidence: { red: redRecord() }, criterion_ledger: [rec] });
    const v = repairSourceFor(root, F, state, liveRed(state));
    expect(v).toMatchObject({ ok: false, code: 'EVIDENCE_REPAIR_PROVENANCE' });
    expect((v as { detail: string }).detail).toMatch(/module/);
  });

  it('never takes a completion record whose seal is broken', () => {
    const root = makeTmpDir('provenance-');
    const rec = { ...ledgerRecord(), claim_id: 'claim-1', settled_at: 'edited' };
    put(root, `${DIR}/ledger/AC-1.g1.claim-1/red.log`, BYTES);
    const state = stateWith({ evidence: { red: redRecord() }, criterion_ledger: [rec] });
    expect(repairSourceFor(root, F, state, liveRed(state))).toMatchObject({ ok: false, code: 'EVIDENCE_REPAIR_NO_SOURCE' });
  });

  it('fails closed when two matching archives disagree on what the record leaves open (ambiguous)', () => {
    const root = makeTmpDir('provenance-');
    // A legacy record that never recorded its commit: the completion record says one commit, the red gate's binding another.
    const rec = ledgerRecord({}, redRecord({ output_path: `${DIR}/ledger/AC-1.g1.claim-1/red.log`, commit_sha: 'a'.repeat(40) }));
    put(root, `${DIR}/ledger/AC-1.g1.claim-1/red.log`, BYTES);
    put(root, `${DIR}/challenge-red/${H.slice(0, 16)}/gate/red.log`, BYTES);
    const state = stateWith({ evidence: { red: redRecord({ commit_sha: null }) }, criterion_ledger: [rec], tdd_red_bindings: [{ head_sha: 'b'.repeat(40), tests: [], tests_sha256: 'x', evidence_sha256: H, recorded_at: 'x' }] });
    expect(repairSourceFor(root, F, state, liveRed(state))).toMatchObject({ ok: false, code: 'EVIDENCE_REPAIR_AMBIGUOUS' });
  });

  it('never follows an archive path out of the node\'s own evidence (another node, traversal)', () => {
    const root = makeTmpDir('provenance-');
    const elsewhere = `features/${F}/evidence/F-1.api.impl/ledger/AC-1.g1.claim-1/red.log`;
    put(root, elsewhere, BYTES);
    const foreign = ledgerRecord({}, redRecord({ output_path: elsewhere }));
    const traversal = ledgerRecord({ criterion: 'AC-2' }, redRecord({ output_path: `${DIR}/../../../../outside.log` }));
    put(root, 'outside.log', BYTES);
    const state = stateWith({ evidence: { red: redRecord() }, criterion_ledger: [foreign, traversal] });
    expect(repairSourceFor(root, F, state, liveRed(state))).toMatchObject({ ok: false, code: 'EVIDENCE_REPAIR_NO_SOURCE' });
  });

  it('a results pointer is restored only beside the output its record names', () => {
    const root = makeTmpDir('provenance-');
    const results = '{"schema":"mycelink-test-results/1","results":[]}\n';
    const RH = sha(results);
    put(root, `${DIR}/challenge-red/${H.slice(0, 16)}/gate/red.results.json`, results);
    // The same results bytes beside a snapshot of another output: not this record's.
    put(root, `${DIR}/challenge-red/${'e'.repeat(16)}/gate/red.results.json`, results);
    const rec = redRecord({ results: { format: 'vitest-json', path: `${DIR}/${N}.red.results.json`, sha256: RH, total: 0, passed: 0, failed: 0, skipped: 0 } });
    const state = stateWith({ evidence: { red: rec }, tdd_red_bindings: [{ head_sha: COMMIT, tests: [], tests_sha256: 'x', evidence_sha256: H, recorded_at: 'x' }] });
    const ref = evidenceReferences(state).find((r) => r.key === `node:${N}:evidence:red:results`) as EvidenceReference;
    expect(repairSourceFor(root, F, state, ref)).toMatchObject({ ok: true, source: { path: `${DIR}/challenge-red/${H.slice(0, 16)}/gate/red.results.json` } });
  });
});
