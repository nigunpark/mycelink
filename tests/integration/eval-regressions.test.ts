/**
 * Product bugs behind the failed real-model eval runs (2026-10-06 repair run).
 *
 * existing-informed: the control repository had uncommitted scaffolding when
 * the candidate build came due. `dispatch` ran the controller node, it failed
 * on the dirty worktree, and `dispatch` retried it inline until the identical
 * fingerprint BLOCKED it, all inside one call, before the host could fix
 * anything. A dirty control repository is a precondition, not a task failure.
 *
 * greenfield: a worker ran `tdd regression` while its node was RED_VERIFIED.
 * The gate ran the failing verifier anyway and then counted its fingerprint
 * a second time, so one failing GREEN plus one illegal call BLOCKED the node
 * in its first attempt. A gate that cannot transition is refused before it
 * runs anything, and a fingerprint counts once per claim.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { commitAll } from '../helpers/git-fixture.js';
import { FEATURE_ID, type Portfolio } from '../helpers/portfolio-fixture.js';
import { fakeAgent } from '../helpers/host-agent.js';
import { API, CANDIDATE, CORE, WEB, WORK, cli, dispatch, hostPortfolio, settle } from '../helpers/host-loop.js';
import { loadState } from '../../src/state/feature-state.js';

afterAll(() => cleanupTmpRoots());

async function settleWorkers(p: Portfolio): Promise<void> {
  for (let i = 0; i < 6; i++) {
    const s = loadState(p.featureDir)!.data.nodes;
    if ([CORE, API, WEB].every((id) => s[id]!.state === 'DONE')) return;
    const d = await dispatch(p);
    expect(d.status).toBe('DISPATCHED');
    fakeAgent(d.ticket!, WORK[d.ticket!.node_id]!, p.control);
    expect(await settle(p, d.ticket!.node_id, d.ticket!.capability)).toMatchObject({ outcome: 'DONE' });
  }
}

describe('a controller node that cannot run stops dispatch instead of burning its budget', () => {
  it('a dirty control repository is a precondition: nothing is charged, and the host can fix it and continue', async () => {
    const p = await hostPortfolio();
    await settleWorkers(p);
    writeFileSync(join(p.control, 'scratch-notes.md'), 'uncommitted\n');

    const d = await dispatch(p);
    expect(d.status).toBe('PRECONDITION_FAILED');
    expect(d.detail).toMatch(/dirty/);
    expect(d.detail).toMatch(/scratch-notes\.md/);
    const rt = loadState(p.featureDir)!.data.nodes[CANDIDATE]!;
    expect(rt).toMatchObject({ state: 'READY', attempts: 0, failure_counts: {}, claim: null });

    commitAll(p.control, 'commit the notes');
    const again = await dispatch(p);
    expect(again.status).toBe('ALL_SETTLED');
    expect(loadState(p.featureDir)!.data.nodes[CANDIDATE]!.state).toBe('DONE');
  });
});

describe('tdd gates', () => {
  async function claim(p: Portfolio): Promise<string> {
    const r = await cli(p, ['node', 'claim', FEATURE_ID, CORE, '--json']);
    expect(r.err).toBe('');
    return (JSON.parse(r.out) as { capability: string }).capability;
  }

  const evidenceFiles = (p: Portfolio): number => {
    const dir = join(p.featureDir, 'evidence', CORE);
    return existsSync(dir) ? readdirSync(dir).length : 0;
  };

  it('refuses a gate whose transition is illegal before running anything or counting a failure', async () => {
    const p = await hostPortfolio();
    const cap = await claim(p);
    expect((await cli(p, ['tdd', 'red', FEATURE_ID, CORE, '--capability', cap])).code).toBe(0);
    expect(loadState(p.featureDir)!.data.nodes[CORE]!.state).toBe('RED_VERIFIED');
    const files = evidenceFiles(p);

    const r = await cli(p, ['tdd', 'regression', FEATURE_ID, CORE, '--capability', cap]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/GATE_OUT_OF_ORDER|ILLEGAL_TRANSITION/);
    expect(r.err).toMatch(/green/i);
    const rt = loadState(p.featureDir)!.data.nodes[CORE]!;
    expect(rt.state).toBe('RED_VERIFIED');
    expect(rt.failure_counts).toEqual({});
    expect(rt.evidence['regression']).toBeUndefined();
    expect(evidenceFiles(p)).toBe(files);
  });

  it('refuses green before red without running the verifier', async () => {
    const p = await hostPortfolio();
    const cap = await claim(p);
    const files = evidenceFiles(p);
    const r = await cli(p, ['tdd', 'green', FEATURE_ID, CORE, '--capability', cap]);
    expect(r.err).toMatch(/GATE_OUT_OF_ORDER.*red/);
    const rt = loadState(p.featureDir)!.data.nodes[CORE]!;
    expect(rt.failure_counts).toEqual({});
    expect(rt.evidence['green']).toBeUndefined();
    expect(evidenceFiles(p)).toBe(files);
  });

  it('counts a repeated identical gate failure once per claim, so one attempt can iterate', async () => {
    const p = await hostPortfolio();
    const cap = await claim(p);
    expect((await cli(p, ['tdd', 'red', FEATURE_ID, CORE, '--capability', cap])).code).toBe(0);
    // GREEN fails twice for the same reason inside one attempt.
    for (let i = 0; i < 3; i++) {
      expect((await cli(p, ['tdd', 'green', FEATURE_ID, CORE, '--capability', cap])).code).not.toBe(0);
    }
    const rt = loadState(p.featureDir)!.data.nodes[CORE]!;
    expect(rt.state).not.toBe('BLOCKED');
    expect(Object.values(rt.failure_counts)).toEqual([1]);

    // The worker then fixes it within the same attempt.
    const wt = rt.claim!.worktree!;
    writeFileSync(join(wt, 'src', 'publish.js'), 'export const JOB_RESULT_V2 = true;\n');
    commitAll(wt, 'implement');
    expect((await cli(p, ['tdd', 'green', FEATURE_ID, CORE, '--capability', cap])).code).toBe(0);
    expect(loadState(p.featureDir)!.data.nodes[CORE]!.state).toBe('GREEN_VERIFIED');
  });
});
