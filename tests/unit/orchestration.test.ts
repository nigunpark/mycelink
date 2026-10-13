/**
 * The orchestration epoch and the dispatch lease registry, as pure
 * functions of a feature's STATE.json (src/state/orchestration.ts).
 *
 * CSET-203 r7: a review advanced while a node it judged was still reopened,
 * and work dispatched past it settled into the reviewed state. The epoch
 * moves, in the same STATE.json write, with every change of what a review
 * or a candidate binds; each node's lineage records the epoch its own
 * generation last changed at; every claim and review generation is a lease
 * in a durable registry, closed in the very write that ends it.
 */
import { describe, expect, it } from 'vitest';
import type { FeatureState_, NodeClaim } from '../../src/model/types.js';
import { initialState } from '../../src/state/feature-state.js';
import {
  MAX_BUMPS,
  MAX_CLOSED_LEASES,
  activeLeases,
  bumpEpoch,
  closeLeases,
  currentEpoch,
  issueLease,
  orchestrationOf,
  syncLeases,
} from '../../src/state/orchestration.js';
import { validateAgainstSchema } from '../../src/schema/registry.js';

const NOW = '2026-10-09T05:00:00.000Z';

function state(): FeatureState_ {
  const graph = {
    schema_version: 1,
    feature_id: 'CSET-203',
    title: 't',
    prd: 'PRD.md',
    acceptance_criteria: [],
    resources: {},
    repositories: ['changesets'],
    capabilities: [],
    nodes: ['A', 'B', 'V'].map((id) => ({ id: `CSET-203.${id}` })),
  } as unknown as Parameters<typeof initialState>[0];
  return initialState(graph, 'f'.repeat(64), undefined, NOW);
}

function claim(id: string, extra: Partial<NodeClaim> = {}): NodeClaim {
  return { claim_id: id, owner: 'mycelink', worktree: null, branch: null, claimed_at: NOW, capability_sha256: 'a'.repeat(64), mode: 'host', dispatch_id: `${id.slice(0, 8)}-0000-4000-8000-000000000000`, ...extra };
}

describe('the orchestration epoch', () => {
  it('starts at 0 for a new feature, and a legacy STATE.json without one reads as 0', () => {
    const s = state();
    expect(s.orchestration).toEqual({ epoch: 0, bumps: [], leases: [] });
    delete s.orchestration;
    expect(currentEpoch(s)).toBe(0);
    expect(orchestrationOf(s)).toEqual({ epoch: 0, bumps: [], leases: [] });
    expect(validateAgainstSchema('state', s)).toEqual([]);
  });

  it('bumps monotonically, one step per call, with its reason, and moves the lineage of exactly the nodes named', () => {
    const s = state();
    expect(bumpEpoch(s, 'rework CSET-203.A', ['CSET-203.A', 'CSET-203.B'], NOW)).toBe(1);
    expect(bumpEpoch(s, 'integrate CSET-203.V', [], NOW)).toBe(2);
    expect(s.orchestration?.epoch).toBe(2);
    expect(s.nodes['CSET-203.A']?.lineage).toBe(1);
    expect(s.nodes['CSET-203.B']?.lineage).toBe(1);
    expect(s.nodes['CSET-203.V']?.lineage).toBeUndefined();
    expect(s.orchestration?.bumps).toEqual([
      { epoch: 1, reason: 'rework CSET-203.A', at: NOW, nodes: ['CSET-203.A', 'CSET-203.B'] },
      { epoch: 2, reason: 'integrate CSET-203.V', at: NOW },
    ]);
    expect(validateAgainstSchema('state', s)).toEqual([]);
  });

  it(`keeps the last ${MAX_BUMPS} bumps only, and a bounded reason`, () => {
    const s = state();
    for (let i = 0; i < MAX_BUMPS + 5; i++) bumpEpoch(s, `r${i}${'x'.repeat(400)}`, [], NOW);
    expect(s.orchestration?.bumps).toHaveLength(MAX_BUMPS);
    expect(s.orchestration?.bumps[0]?.epoch).toBe(6);
    expect(s.orchestration?.bumps.every((b) => b.reason.length <= 300)).toBe(true);
  });
});

describe('the dispatch lease registry', () => {
  it('a lease issued is active, bound to the epoch and the lineage it was issued at; closing it records how and when', () => {
    const s = state();
    bumpEpoch(s, 'x', ['CSET-203.A'], NOW);
    const c = claim('11111111-aaaa-4bbb-8ccc-000000000001');
    s.nodes['CSET-203.A']!.claim = c;
    const lease = issueLease(s, { kind: 'worker', node_id: 'CSET-203.A', review_id: null, claim_id: c.claim_id, dispatch_id: c.dispatch_id ?? null, capability_sha256: c.capability_sha256 ?? null, generation: 0, worktree: null, result_file: null }, NOW);
    expect(lease).toMatchObject({ lease_id: c.dispatch_id, status: 'active', epoch: 1, lineage: 1, issued_at: NOW, closed_at: null });
    expect(activeLeases(s).map((l) => l.lease_id)).toEqual([c.dispatch_id]);
    const closed = closeLeases(s, (l) => l.lease_id === c.dispatch_id, 'revoked', 'rotated by dispatch --resume', NOW);
    expect(closed).toHaveLength(1);
    expect(s.orchestration?.leases[0]).toMatchObject({ status: 'revoked', closed_reason: 'rotated by dispatch --resume', closed_at: NOW });
    expect(activeLeases(s)).toEqual([]);
    expect(validateAgainstSchema('state', s)).toEqual([]);
  });

  it('sync closes an active lease whose claim is gone: settled when the node settled that very claim, released otherwise', () => {
    const s = state();
    const a = claim('11111111-aaaa-4bbb-8ccc-00000000000a');
    const b = claim('11111111-aaaa-4bbb-8ccc-00000000000b');
    s.nodes['CSET-203.A']!.claim = a;
    s.nodes['CSET-203.B']!.claim = b;
    syncLeases(s, NOW);
    expect(activeLeases(s).map((l) => l.node_id).sort()).toEqual(['CSET-203.A', 'CSET-203.B']);
    // A settled (its receipt names the claim and generation); B dropped without one.
    s.nodes['CSET-203.A']!.claim = null;
    s.nodes['CSET-203.A']!.state = 'DONE';
    s.nodes['CSET-203.A']!.last_settlement = { capability_sha256: 'a'.repeat(64), claim_id: a.claim_id, outcome: 'DONE', state: 'DONE', detail: 'ok', settled_at: NOW, dispatch_id: a.dispatch_id ?? null };
    s.nodes['CSET-203.B']!.claim = null;
    syncLeases(s, NOW);
    const by = (id: string) => s.orchestration?.leases.find((l) => l.node_id === id);
    expect(by('CSET-203.A')).toMatchObject({ status: 'settled', outcome: 'DONE', settled_epoch: 0 });
    expect(by('CSET-203.B')).toMatchObject({ status: 'released' });
    // Idempotent: a second sync changes nothing.
    const once = JSON.stringify(s.orchestration);
    syncLeases(s, '2026-10-09T06:00:00.000Z');
    expect(JSON.stringify(s.orchestration)).toBe(once);
  });

  it('sync adopts a live claim or an open review that has no lease (a STATE.json from before the registry), exactly once', () => {
    const s = state();
    delete s.orchestration;
    s.nodes['CSET-203.A']!.claim = claim('11111111-aaaa-4bbb-8ccc-0000000000aa');
    s.acceptance_review = {
      required: true,
      max_rounds: 2,
      open: { review_id: 'CSET-203-R001', dispatch_id: '22222222-aaaa-4bbb-8ccc-000000000001', capability_sha256: 'b'.repeat(64), inputs: { feature_id: 'CSET-203', graph_sha256: 'c'.repeat(64), criteria_sha256: 'd'.repeat(64), manifest_sha256: null, repositories: [] }, inputs_sha256: 'e'.repeat(64), packet_path: 'p', packet_sha256: 'f'.repeat(64), slot: 's', review: 1, attempt: 1, refused: [], issued_at: NOW, expires_at: NOW },
      reviews: [],
      blocked: null,
      usage: { model_turns: 0, wall_clock_ms: 0, input_tokens: 0, output_tokens: 0, sessions: 0 },
    };
    // A legacy state is left as it is until something orchestration-aware writes it.
    syncLeases(s, NOW);
    expect(s.orchestration).toBeUndefined();
    orchestrationOf(s);
    syncLeases(s, NOW);
    syncLeases(s, NOW);
    expect(activeLeases(s).map((l) => [l.kind, l.node_id ?? l.review_id]).sort()).toEqual([
      ['review', 'CSET-203-R001'],
      ['worker', 'CSET-203.A'],
    ]);
    expect(validateAgainstSchema('state', s)).toEqual([]);
  });

  it(`keeps every active lease and the last ${MAX_CLOSED_LEASES} closed ones`, () => {
    const s = state();
    for (let i = 0; i < MAX_CLOSED_LEASES + 10; i++) {
      issueLease(s, { kind: 'worker', node_id: 'CSET-203.A', review_id: null, claim_id: `c${i}`, dispatch_id: null, capability_sha256: null, generation: 0, worktree: null, result_file: null }, NOW);
      closeLeases(s, (l) => l.claim_id === `c${i}`, 'released', 'test', NOW);
    }
    const live = claim('11111111-aaaa-4bbb-8ccc-0000000000ff');
    s.nodes['CSET-203.B']!.claim = live;
    syncLeases(s, NOW);
    expect(s.orchestration?.leases.filter((l) => l.status !== 'active')).toHaveLength(MAX_CLOSED_LEASES);
    expect(activeLeases(s)).toHaveLength(1);
    expect(s.orchestration?.leases.at(-1)?.status).toBe('active');
  });
});
