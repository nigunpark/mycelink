import { describe, expect, it } from 'vitest';
import { clone, VALID_GRAPH } from '../helpers/graph-fixtures.js';
import type { FeatureState_, GraphNode, NodeState, PortfolioGraph } from '../../src/model/types.js';
import { initialState } from '../../src/state/feature-state.js';
import { computeReady, scheduleBatch, pathsOverlap } from '../../src/scheduler/ready.js';

function stateFor(graph: PortfolioGraph, overrides: Record<string, Partial<{ state: NodeState }>> = {}): FeatureState_ {
  const s = initialState(graph, 'hash'.padEnd(64, '0'));
  for (const [id, patch] of Object.entries(overrides)) {
    const node = s.nodes[id];
    if (!node) throw new Error(`unknown fixture node ${id}`);
    Object.assign(node, patch);
  }
  return s;
}

function makeNode(id: string, patch: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    level: 'executable-node',
    repository: 'core',
    capability: 'CAP-CORE-PUBLISH',
    node_type: 'implementation',
    depends_on: [],
    allowed_paths: ['src/**'],
    forbidden_paths: [],
    contract_inputs: [],
    contract_outputs: [],
    required_resources: [],
    required_evidence: ['red', 'green'],
    verification_commands: [{ id: 't', command: ['node', '--test'] }],
    worker: {
      model: 'sonnet',
      effort: 'high',
      max_turns: 10,
      max_wall_clock_minutes: 20,
      max_attempts: 2,
      nested_delegation: false,
    },
    invalidation_rules: [],
    acceptance_criteria: ['AC-1'],
    ...patch,
  };
}

describe('pathsOverlap', () => {
  it('detects identical and nested globs as overlapping', () => {
    expect(pathsOverlap(['src/**'], ['src/**'])).toBe(true);
    expect(pathsOverlap(['src/**'], ['src/queue/**'])).toBe(true);
    expect(pathsOverlap(['src/queue/client.ts'], ['src/**'])).toBe(true);
  });

  it('treats disjoint subtrees as non-overlapping', () => {
    expect(pathsOverlap(['src/queue/**'], ['src/http/**'])).toBe(false);
    expect(pathsOverlap(['tests/**'], ['src/**'])).toBe(false);
  });

  it('treats an empty path set as non-overlapping', () => {
    expect(pathsOverlap([], ['src/**'])).toBe(false);
  });
});

describe('computeReady', () => {
  it('returns only nodes whose dependencies are all DONE', () => {
    const graph = clone(VALID_GRAPH) as unknown as PortfolioGraph;
    const state = stateFor(graph);
    expect(computeReady(graph, state)).toEqual(['FEAT-101.core.publish.red']);

    const advanced = stateFor(graph, { 'FEAT-101.core.publish.red': { state: 'DONE' } });
    expect(computeReady(graph, advanced)).toEqual(['FEAT-101.core.publish.impl']);
  });

  it('excludes nodes that are already claimed, blocked or done', () => {
    const graph = clone(VALID_GRAPH) as unknown as PortfolioGraph;
    for (const blockedState of ['CLAIMED', 'BLOCKED', 'DONE', 'NEEDS_DECISION'] as NodeState[]) {
      const state = stateFor(graph, { 'FEAT-101.core.publish.red': { state: blockedState } });
      expect(computeReady(graph, state)).not.toContain('FEAT-101.core.publish.red');
    }
  });

  it('re-offers an INVALIDATED node whose dependencies still hold', () => {
    const graph = clone(VALID_GRAPH) as unknown as PortfolioGraph;
    const state = stateFor(graph, {
      'FEAT-101.core.publish.red': { state: 'DONE' },
      'FEAT-101.core.publish.impl': { state: 'INVALIDATED' },
    });
    expect(computeReady(graph, state)).toContain('FEAT-101.core.publish.impl');
  });

  it('is deterministic: same inputs give the same order', () => {
    const graph = clone(VALID_GRAPH) as unknown as PortfolioGraph;
    const state = stateFor(graph);
    expect(computeReady(graph, state)).toEqual(computeReady(graph, state));
  });
});

describe('scheduleBatch', () => {
  function twoIndependent(patchA: Partial<GraphNode> = {}, patchB: Partial<GraphNode> = {}): PortfolioGraph {
    const graph = clone(VALID_GRAPH) as unknown as PortfolioGraph;
    graph.nodes = [
      makeNode('FEAT-101.core.a.impl', { allowed_paths: ['src/a/**'], ...patchA }),
      makeNode('FEAT-101.core.b.impl', { allowed_paths: ['src/b/**'], ...patchB }),
    ];
    return graph;
  }

  it('runs two conflict-free nodes in parallel', () => {
    const graph = twoIndependent();
    const plan = scheduleBatch(graph, stateFor(graph), { writerConcurrency: 2 });
    expect(plan.scheduled.map((p) => p.node_id).sort()).toEqual([
      'FEAT-101.core.a.impl',
      'FEAT-101.core.b.impl',
    ]);
  });

  it('serialises two nodes in the same repository with overlapping paths', () => {
    const graph = twoIndependent({ allowed_paths: ['src/**'] }, { allowed_paths: ['src/b/**'] });
    const plan = scheduleBatch(graph, stateFor(graph), { writerConcurrency: 2 });
    expect(plan.scheduled).toHaveLength(1);
    expect(plan.deferred[0]?.reason).toBe('PATH_OWNERSHIP_CONFLICT');
  });

  it('serialises two nodes writing the same contract output', () => {
    const graph = twoIndependent(
      { contract_outputs: ['contracts/x.json'] },
      { contract_outputs: ['contracts/x.json'] },
    );
    const plan = scheduleBatch(graph, stateFor(graph), { writerConcurrency: 2 });
    expect(plan.scheduled).toHaveLength(1);
    expect(plan.deferred[0]?.reason).toBe('CONTRACT_OWNERSHIP_CONFLICT');
  });

  it('respects the writer concurrency limit', () => {
    const graph = twoIndependent();
    const plan = scheduleBatch(graph, stateFor(graph), { writerConcurrency: 1 });
    expect(plan.scheduled).toHaveLength(1);
    expect(plan.deferred[0]?.reason).toBe('WIP_LIMIT');
  });

  it('never schedules two nodes needing the capacity-1 full runtime', () => {
    const graph = twoIndependent(
      { required_resources: ['full-runtime'], node_type: 'e2e-scenario', repository: null, capability: null, allowed_paths: [] },
      { required_resources: ['full-runtime'], node_type: 'e2e-scenario', repository: null, capability: null, allowed_paths: [] },
    );
    const plan = scheduleBatch(graph, stateFor(graph), { writerConcurrency: 4 });
    expect(plan.scheduled).toHaveLength(1);
    expect(plan.deferred[0]?.reason).toBe('RESOURCE_CAPACITY');
  });

  it('accounts for resources already leased outside this batch', () => {
    const graph = twoIndependent(
      { required_resources: ['full-runtime'], node_type: 'e2e-scenario', repository: null, capability: null, allowed_paths: [] },
      { allowed_paths: ['src/b/**'] },
    );
    const plan = scheduleBatch(graph, stateFor(graph), {
      writerConcurrency: 4,
      heldResources: { 'full-runtime': 1 },
    });
    expect(plan.scheduled.map((p) => p.node_id)).toEqual(['FEAT-101.core.b.impl']);
    expect(plan.deferred.find((d) => d.node_id === 'FEAT-101.core.a.impl')?.reason).toBe(
      'RESOURCE_CAPACITY',
    );
  });

  it('allows browser workers up to declared capacity', () => {
    const graph = twoIndependent(
      { required_resources: ['browser-worker'], node_type: 'e2e-scenario', repository: null, capability: null, allowed_paths: [] },
      { required_resources: ['browser-worker'], node_type: 'e2e-scenario', repository: null, capability: null, allowed_paths: [] },
    );
    const plan = scheduleBatch(graph, stateFor(graph), { writerConcurrency: 4 });
    expect(plan.scheduled).toHaveLength(2);
  });

  it('counts in-flight claimed nodes against writer concurrency', () => {
    const graph = twoIndependent();
    graph.nodes.push(makeNode('FEAT-101.core.c.impl', { allowed_paths: ['src/c/**'] }));
    const state = stateFor(graph, { 'FEAT-101.core.c.impl': { state: 'CLAIMED' } });
    const plan = scheduleBatch(graph, state, { writerConcurrency: 2 });
    expect(plan.scheduled).toHaveLength(1);
  });

  it('defers a node whose attempts already reached its budget', () => {
    const graph = twoIndependent();
    const state = stateFor(graph);
    state.nodes['FEAT-101.core.a.impl']!.attempts = 2;
    const plan = scheduleBatch(graph, state, { writerConcurrency: 4 });
    expect(plan.scheduled.map((p) => p.node_id)).toEqual(['FEAT-101.core.b.impl']);
    expect(plan.deferred[0]?.reason).toBe('ATTEMPTS_EXHAUSTED');
  });

  it('is deterministic across repeated calls', () => {
    const graph = twoIndependent({ allowed_paths: ['src/**'] }, { allowed_paths: ['src/b/**'] });
    const a = scheduleBatch(graph, stateFor(graph), { writerConcurrency: 2 });
    const b = scheduleBatch(graph, stateFor(graph), { writerConcurrency: 2 });
    expect(a.scheduled.map((p) => p.node_id)).toEqual(b.scheduled.map((p) => p.node_id));
  });
});
