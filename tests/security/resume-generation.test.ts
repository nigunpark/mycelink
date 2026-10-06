/**
 * A resumed dispatch revokes the old worker's result authority.
 *
 * `dispatch --resume` used to rotate only the capability: the claim id and
 * the result slot stayed the same, and a result was bound to node + claim
 * only. A worker from before the resume (still running in a lost session)
 * could therefore write SUBMITTED, BLOCKED, NEEDS_DECISION or RETRYABLE into
 * the very slot the resumed worker was writing, and settle believed it.
 *
 * Now every dispatch generation has its own dispatch id and its own result
 * file, settle accepts only a result naming the current dispatch id, and a
 * result the old worker had already written is taken into the controller
 * (attested) before the rotation, or not at all.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { FEATURE_ID, type Portfolio } from '../helpers/portfolio-fixture.js';
import { fakeAgent, type DispatchTicket } from '../helpers/host-agent.js';
import { CORE, WORK, cli, dispatch, hostPortfolio } from '../helpers/host-loop.js';
import { loadState } from '../../src/state/feature-state.js';

afterAll(() => cleanupTmpRoots());

type Outcome = 'SUBMITTED' | 'BLOCKED' | 'NEEDS_DECISION' | 'RETRYABLE';

/** What a stale worker writes: a well-formed result for its own (old) ticket. */
function staleResult(t: DispatchTicket, outcome: Outcome): Record<string, unknown> {
  return {
    schema_version: 1,
    node_id: t.node_id,
    claim_id: t.claim_id,
    ...((t as { dispatch_id?: string }).dispatch_id ? { dispatch_id: (t as { dispatch_id?: string }).dispatch_id } : {}),
    outcome,
    commands: [],
    commit_sha: null,
    changed_paths: [],
    evidence_paths: [],
    failure_fingerprint: outcome === 'SUBMITTED' ? null : `STALE_${outcome}`,
    decision_request: outcome === 'NEEDS_DECISION' ? { question: 'stale?', options: ['a', 'b'] } : null,
  };
}

function writeStale(t: DispatchTicket, outcome: Outcome): void {
  mkdirSync(dirname(t.result_slot), { recursive: true });
  writeFileSync(t.result_slot, JSON.stringify(staleResult(t, outcome)));
}

async function settleOut(p: Portfolio, t: DispatchTicket): Promise<{ code: number; report: Record<string, unknown>; err: string }> {
  const r = await cli(p, ['settle', FEATURE_ID, t.node_id, '--capability', t.capability, '--json']);
  return { code: r.code, report: r.out.trim() ? (JSON.parse(r.out) as Record<string, unknown>) : {}, err: r.err };
}

describe('resumed dispatch generations', () => {
  let p: Portfolio;
  beforeEach(async () => {
    p = await hostPortfolio();
  });

  it('gives a resumed dispatch a new dispatch id and its own result file', async () => {
    const t1 = (await dispatch(p)).ticket!;
    const t2 = (await dispatch(p, ['--resume', CORE])).ticket!;
    const id1 = (t1 as { dispatch_id?: string }).dispatch_id;
    const id2 = (t2 as { dispatch_id?: string }).dispatch_id;
    expect(id1).toMatch(/^[0-9a-f-]{16,}$/);
    expect(id2).toMatch(/^[0-9a-f-]{16,}$/);
    expect(id2).not.toBe(id1);
    expect(t2.result_slot).not.toBe(t1.result_slot);
    expect(t2.prompt).toContain(id2 as string);
    expect(t2.prompt).not.toContain(id1 as string);
  });

  for (const outcome of ['SUBMITTED', 'BLOCKED', 'NEEDS_DECISION', 'RETRYABLE'] as Outcome[]) {
    it(`a stale worker writing ${outcome} after the rotation does not affect the resumed dispatch`, async () => {
      const t1 = (await dispatch(p)).ticket!;
      // The host loses the ticket and resumes; the old worker is still alive.
      const t2 = (await dispatch(p, ['--resume', CORE])).ticket!;
      expect(t2.result_present).toBe(false);
      // The resumed worker does the real work...
      fakeAgent(t2, WORK[CORE]!, p.control);
      // ...and then the stale worker writes its result, exactly where its own
      // ticket told it to.
      writeStale(t1, outcome);

      const s = await settleOut(p, t2);
      expect(s.err).toBe('');
      expect(s.report).toMatchObject({ outcome: 'DONE' });
      const state = loadState(p.featureDir)!.data;
      expect(state.nodes[CORE]!.state).toBe('DONE');
      expect(state.pending_decisions).toEqual([]);
      expect(Object.keys(state.nodes[CORE]!.failure_counts)).toEqual([]);
    });
  }

  it('a stale-generation result found in the current slot is refused, not believed', async () => {
    const t1 = (await dispatch(p)).ticket!;
    const t2 = (await dispatch(p, ['--resume', CORE])).ticket!;
    // A confused stale worker writes its old identity into the new path.
    mkdirSync(dirname(t2.result_slot), { recursive: true });
    writeFileSync(t2.result_slot, JSON.stringify(staleResult(t1, 'BLOCKED')));
    const s = await settleOut(p, t2);
    expect(s.report['outcome']).not.toBe('BLOCKED');
    expect(String(s.report['detail'])).toMatch(/RESULT_STALE_DISPATCH|RESULT_IDENTITY_MISMATCH/);
    expect(loadState(p.featureDir)!.data.nodes[CORE]!.state).not.toBe('BLOCKED');
    expect(loadState(p.featureDir)!.data.pending_decisions).toEqual([]);
  });

  it('a result written before the rotation is attested into the controller and resumed; later stale writes are ignored', async () => {
    const t1 = (await dispatch(p)).ticket!;
    fakeAgent(t1, WORK[CORE]!, p.control); // finished before the host lost the ticket
    const t2 = (await dispatch(p, ['--resume', CORE])).ticket!;
    expect(t2.result_present).toBe(true);
    // The old slot was taken into the controller at the resume.
    expect(existsSync(t1.result_slot)).toBe(false);
    const claim = loadState(p.featureDir)!.data.nodes[CORE]!.claim as unknown as Record<string, unknown>;
    expect(claim['result_captured_sha256']).toMatch(/^[0-9a-f]{64}$/);
    // The stale worker overwrites its slot afterwards; it no longer counts.
    writeStale(t1, 'BLOCKED');
    const s = await settleOut(p, t2);
    expect(s.err).toBe('');
    expect(s.report).toMatchObject({ outcome: 'DONE' });
    // The attested copy never holds the old capability.
    const sessions = JSON.stringify(loadState(p.featureDir)!.data);
    expect(sessions).not.toContain(t1.capability);
  });

  it('an invalid result in the old slot is not attested at the resume', async () => {
    const t1 = (await dispatch(p)).ticket!;
    mkdirSync(dirname(t1.result_slot), { recursive: true });
    writeFileSync(t1.result_slot, JSON.stringify({ ...staleResult(t1, 'SUBMITTED'), claim_id: 'someone-else' }));
    const t2 = (await dispatch(p, ['--resume', CORE])).ticket!;
    expect(t2.result_present).toBe(false);
    const claim = loadState(p.featureDir)!.data.nodes[CORE]!.claim as unknown as Record<string, unknown>;
    expect(claim['result_captured_sha256']).toBeUndefined();
  });

  it('the old capability stays dead and the ledger records each generation once', async () => {
    const t1 = (await dispatch(p)).ticket!;
    const t2 = (await dispatch(p, ['--resume', CORE])).ticket!;
    fakeAgent(t2, WORK[CORE]!, p.control);
    expect((await settleOut(p, t1)).err).toMatch(/CAPABILITY_INVALID/);
    expect((await settleOut(p, t2)).report).toMatchObject({ outcome: 'DONE' });
    const runs = readFileSync(`${p.featureDir}/RUNS.jsonl`, 'utf8').trim().split('\n').filter((l) => l.includes(CORE));
    expect(runs.length).toBe(1);
  });
});

describe('result file names', () => {
  it('the hook exempts exactly the controller-assigned result files', async () => {
    const { isWorkerResultRel, generationResultFile } = await import('../../src/sessions/worker-protocol.js');
    const name = generationResultFile('0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0');
    expect(isWorkerResultRel(`.mycelink-worker/${name}`)).toBe(true);
    expect(isWorkerResultRel('.mycelink-worker/result.json')).toBe(true);
    for (const bad of ['.mycelink-worker/result-x.json', '.mycelink-worker/../src/a.js', 'src/result-0f1e2d3c.json', '.mycelink-worker/result-0f1e2d3c.json/x']) {
      expect(`${bad}:${isWorkerResultRel(bad)}`).toBe(`${bad}:false`);
    }
    expect(() => generationResultFile('../../etc')).toThrow(/malformed/);
  });
});
