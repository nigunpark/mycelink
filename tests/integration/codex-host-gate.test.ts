import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { makeTmpDir, cleanupTmpRoots } from '../helpers/tmp.js';
import { canonicalTestId } from '../../src/evidence/test-ids.js';
import { executeHostClaimGate } from '../../src/sessions/codex-host-gate.js';
import type { EvidenceRecord } from '../../src/model/types.js';

afterAll(() => cleanupTmpRoots());
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

describe('host-owned claim gate', () => {
  it('executes the supplied controller argv, then verifies a new hashed gate output and canonical test IDs', () => {
    const root = makeTmpDir('host-gate-');
    mkdirSync(join(root, 'features', 'FEAT-1'), { recursive: true });
    const output = 'features/FEAT-1/gate.log';
    const results = 'features/FEAT-1/results.json';
    const testId = canonicalTestId('vitest-json', 'tests/a.test.js', 'suite > assertion');
    const report = JSON.stringify({ format: 'vitest-json', results: [{ file: 'tests/a.test.js', name: 'assertion', full_name: 'suite > assertion', test_id: testId, status: 'passed', category: 'assertion' }] });
    const script = `require('fs').writeFileSync(${JSON.stringify(join(root, output))}, 'real-output');require('fs').writeFileSync(${JSON.stringify(join(root, results))}, ${JSON.stringify(report)});`;
    let record: EvidenceRecord | undefined;
    const run = executeHostClaimGate({ controlRoot: root, featureId: 'FEAT-1', gate: 'green', cwd: root,
      argv: [process.execPath, '-e', script], deadlineMs: 5_000,
      readRecord: () => {
        if (record) return record;
        if (!existsSync(join(root, output))) return undefined;
        record = { kind: 'green', node_id: 'F.n', command: [process.execPath, '-e', script], exit_code: 0, started_at: '', finished_at: '', cwd: root, repository: 'repo', commit_sha: null,
          output_path: output, output_sha256: sha(readFileSync(join(root, output))), failure_fingerprint: null,
          results: { format: 'vitest-json', path: results, sha256: sha(readFileSync(join(root, results))), total: 1, passed: 1, failed: 0, skipped: 0 } };
        return record;
      } });
    expect(run).toMatchObject({ exitCode: 0, outputSha256: sha('real-output'), testIds: [testId] });
  });

  it('refuses missing, stale, tampered and noncanonical evidence even after exit zero', () => {
    const root = makeTmpDir('host-gate-invalid-');
    mkdirSync(join(root, 'features', 'FEAT-1'), { recursive: true });
    writeFileSync(join(root, 'features/FEAT-1/gate.log'), 'old');
    const base = { kind: 'red', node_id: 'F.n', command: [], exit_code: 0, started_at: '', finished_at: '', cwd: root, repository: 'repo', commit_sha: null,
      output_path: 'features/FEAT-1/gate.log', output_sha256: sha('old'), failure_fingerprint: null } as EvidenceRecord;
    for (const record of [undefined, base, { ...base, output_sha256: sha('other') }]) {
      const run = executeHostClaimGate({ controlRoot: root, featureId: 'FEAT-1', gate: 'red', cwd: root, argv: [process.execPath, '-e', ''], deadlineMs: 5_000,
        readRecord: () => record });
      expect(run.exitCode).not.toBe(0);
    }
    const wrong = { ...base, output_sha256: sha('new'), results: { format: 'vitest-json', path: 'features/FEAT-1/results.json', sha256: '', total: 1, passed: 0, failed: 1, skipped: 0 } } as EvidenceRecord;
    writeFileSync(join(root, 'features/FEAT-1/gate.log'), 'new');
    const report = JSON.stringify({ format: 'vitest-json', results: [{ file: 'tests/a.test.js', name: 'bad', full_name: 'suite > bad', test_id: '0000000000000000', status: 'failed', category: 'assertion' }] });
    writeFileSync(join(root, 'features/FEAT-1/results.json'), report);
    wrong.results!.sha256 = sha(report);
    expect(executeHostClaimGate({ controlRoot: root, featureId: 'FEAT-1', gate: 'red', cwd: root, argv: [process.execPath, '-e', ''], deadlineMs: 5_000, readRecord: () => wrong }).exitCode).not.toBe(0);
  });

  it('sets a hard deadline on the host child without accepting an absent receipt', () => {
    const root = makeTmpDir('host-gate-timeout-');
    const run = executeHostClaimGate({ controlRoot: root, featureId: 'FEAT-1', gate: 'green', cwd: root,
      argv: [process.execPath, '-e', 'setTimeout(() => {}, 5000)'], deadlineMs: 400, readRecord: () => undefined });
    expect(run.exitCode).not.toBe(0);
    expect(run.output).toMatch(/TIMEOUT|FAILED/);
  });
});
