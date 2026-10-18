import { afterAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { makeTmpDir, cleanupTmpRoots } from '../helpers/tmp.js';
import { loadRegistry, recordObservation, recordSpawn } from '../../src/sessions/registry.js';
import { zeroObservationUsage, type SessionHandle, type SessionObservation } from '../../src/sessions/adapter.js';

afterAll(() => cleanupTmpRoots());

const handle: SessionHandle = { session_id: 'controller-session-1', adapter: 'codex-cli', pid: 52, node_id: 'feature.node', claim_id: 'claim-a', started_at: '2026-10-18T00:00:00Z', log_path: 'log', result_path: 'result' };
const observation: SessionObservation = {
  status: 'failed', exit_code: 1, turns: 0, usage: zeroObservationUsage(), result: null,
  failure_reason: 'PROVIDER_FAILED', timed_out: false, last_progress_at: '2026-10-18T00:00:01Z',
  codex_evidence: { provider: 'codex', source: 'exec-jsonl', process_session_id: handle.session_id, thread_id: '11111111-1111-4111-8111-111111111111', terminal: 'failed', turns: 0, final: null, failure: { class: 'unclassified', transient: false }, role_attested: false },
  codex_provenance: { provider: 'codex', process_session_id: handle.session_id, worker_result: null, reviewer_verdict: null },
};

describe('provider-tagged durable registry', () => {
  it('retains Codex transport binding separately from worker and reviewer evidence over duplicate recovery', () => {
    const file = join(makeTmpDir('codex-registry-'), 'registry.json');
    recordSpawn(file, handle, { featureId: 'feature', repository: null, worktree: null, branch: null, attempt: 1 });
    const first = recordObservation(file, handle.session_id, observation);
    expect(first?.codex_evidence).toEqual(observation.codex_evidence);
    expect(first?.codex_provenance).toEqual(observation.codex_provenance);
    const second = recordObservation(file, handle.session_id, observation);
    expect(second).toEqual(first);
    expect(loadRegistry(file).sessions[handle.session_id]).toEqual(first);
  });
  it('does not accept another process session or provider claim for a Codex record', () => {
    const file = join(makeTmpDir('codex-registry-'), 'registry.json');
    recordSpawn(file, handle, { featureId: 'feature', repository: null, worktree: null, branch: null, attempt: 1 });
    expect(() => recordObservation(file, handle.session_id, { ...observation, codex_evidence: { ...observation.codex_evidence!, process_session_id: 'foreign' } })).toThrow();
    expect(loadRegistry(file).sessions[handle.session_id]?.codex_evidence).toBeUndefined();
  });
});
