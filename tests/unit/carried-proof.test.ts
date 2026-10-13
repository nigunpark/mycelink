/**
 * A carried criterion proof is never an active gate: settle re-runs its test
 * on the new generation's head (the fresh verification of the sealed commit)
 * and records a fresh proof of this generation, with where it came from.
 * Nothing the replaced generation's outputs say stands in for that run.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { revalidateCarried, type CarriedCriterionProof } from '../../src/engine/criteria.js';
import { canonicalTestId } from '../../src/evidence/test-ids.js';
import type { EvidenceRecord } from '../../src/model/types.js';

afterAll(() => cleanupTmpRoots());

const FILE = 'packages/cli/test/cli.test.mjs';
const NAME = 'version reports a failed apply without a stack trace, exits 1 and does not commit';
const ID = canonicalTestId('junit-xml', FILE, NAME);
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

function record(root: string, kind: 'green' | 'regression', tests: { name: string; status: string }[] | null, label = kind): EvidenceRecord {
  const dir = join(root, 'features', 'F-1', 'evidence', 'N');
  mkdirSync(dir, { recursive: true });
  const log = `${label} output`;
  writeFileSync(join(dir, `${label}.log`), log);
  const results = tests === null ? null : JSON.stringify({ format: 'junit-xml', results: tests.map((t) => ({ file: FILE, name: t.name, status: t.status, category: t.status === 'passed' ? 'passed' : 'assertion' })) });
  if (results !== null) writeFileSync(join(dir, `${label}.results.json`), results);
  return {
    kind,
    node_id: 'N',
    command: ['node', '--test'],
    exit_code: 0,
    started_at: '2026-10-09T00:00:00.000Z',
    finished_at: '2026-10-09T00:00:01.000Z',
    cwd: root,
    repository: 'changesets',
    commit_sha: 'a'.repeat(40),
    output_path: `features/F-1/evidence/N/${label}.log`,
    output_sha256: sha(log),
    failure_fingerprint: null,
    ...(results !== null ? { results: { format: 'junit-xml' as const, path: `features/F-1/evidence/N/${label}.results.json`, sha256: sha(results), total: tests!.length, passed: tests!.filter((t) => t.status === 'passed').length, failed: 0, skipped: 0 } } : {}),
  } as EvidenceRecord;
}

const proof: CarriedCriterionProof = {
  criterion: 'AC-4',
  test_id: ID,
  test: { path: FILE, name: NAME },
  source_generation: 0,
  source_claim_id: 'c-0',
  source_dispatch_id: 'd-0',
  repo_sha: 'b'.repeat(40),
  gate: 'red',
  output_sha256: 'c'.repeat(64),
  output_path: 'features/F-1/evidence/N/replaced/g1/N.red.log',
};
const accepted = [
  { criterion: 'AC-3', test_id: 'd'.repeat(16), test: { path: FILE, name: 'x' }, gate: 'red' as const, output_sha256: 'e'.repeat(64) },
  { criterion: 'AC-4', test_id: ID, test: { path: FILE, name: NAME }, gate: 'red' as const, output_sha256: proof.output_sha256, carried: true },
];

describe('revalidateCarried', () => {
  it("records the fresh proof: the fresh regression's output when its report passed the test, with where it came from", () => {
    const root = makeTmpDir('carried-');
    const green = record(root, 'green', [{ name: NAME, status: 'passed' }]);
    const regression = record(root, 'regression', [{ name: NAME, status: 'passed' }]);
    const r = revalidateCarried({ controlRoot: root, accepted, proofs: [proof], fresh: [green, regression] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.criteria[0]).toEqual(accepted[0]);
    expect(r.criteria[1]).toEqual({
      criterion: 'AC-4',
      test_id: ID,
      test: { path: FILE, name: NAME },
      gate: 'regression',
      output_sha256: regression.output_sha256,
      carried: true,
      carried_from: { generation: 0, gate: 'red', output_sha256: proof.output_sha256, claim_id: 'c-0', dispatch_id: 'd-0', repo_sha: proof.repo_sha },
    });
  });

  it("the fresh module run's output when the full suite publishes no report", () => {
    const root = makeTmpDir('carried-');
    const green = record(root, 'green', [{ name: NAME, status: 'passed' }]);
    const regression = record(root, 'regression', null);
    const r = revalidateCarried({ controlRoot: root, accepted, proofs: [proof], fresh: [green, regression] });
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.criteria[1]).toMatchObject({ gate: 'green', output_sha256: green.output_sha256 });
  });

  it('refuses a carried test the fresh verification did not pass, did not run, or whose report no longer hashes as recorded', () => {
    const root = makeTmpDir('carried-');
    for (const fresh of [
      [record(root, 'green', [{ name: NAME, status: 'failed' }], 'g1')],
      [record(root, 'green', [{ name: 'another test', status: 'passed' }], 'g2')],
      [record(root, 'green', null, 'g3'), record(root, 'regression', null, 'r3')],
    ]) {
      const r = revalidateCarried({ controlRoot: root, accepted, proofs: [proof], fresh });
      expect(r).toMatchObject({ ok: false, code: 'CARRIED_PROOF_NOT_REVALIDATED', criterion: 'AC-4' });
    }
    const tampered = record(root, 'green', [{ name: NAME, status: 'passed' }], 'g4');
    writeFileSync(join(root, (tampered.results as { path: string }).path), '{"format":"junit-xml","results":[]}');
    expect(revalidateCarried({ controlRoot: root, accepted, proofs: [proof], fresh: [tampered] })).toMatchObject({ ok: false, code: 'CARRIED_PROOF_NOT_REVALIDATED' });
  });

  it('refuses an item marked carried that no carried proof of the node records', () => {
    const root = makeTmpDir('carried-');
    const green = record(root, 'green', [{ name: NAME, status: 'passed' }]);
    expect(revalidateCarried({ controlRoot: root, accepted, proofs: [], fresh: [green] })).toMatchObject({ ok: false, code: 'CARRIED_PROOF_NOT_REVALIDATED', criterion: 'AC-4' });
  });
});
