/**
 * Claim authority: a single node is schedulable only against what is already
 * in flight. The batch planner only compared nodes inside one batch, so a node
 * that overlapped a running worker's files, or needed a resource that worker
 * holds, could still be claimed by hand (root cause A3).
 */
import { describe, expect, it } from 'vitest';
import type { FeatureState_, GraphNode, NodeState, PortfolioGraph } from '../../src/model/types.js';
import { initialState } from '../../src/state/feature-state.js';
import { canSchedule, scheduleBatch } from '../../src/scheduler/ready.js';

function node(id: string, patch: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    level: 'executable-node',
    repository: 'core',
    capability: 'CAP-1',
    node_type: 'implementation',
    depends_on: [],
    allowed_paths: ['src/**'],
    forbidden_paths: [],
    contract_inputs: [],
    contract_outputs: [],
    required_resources: [],
    required_evidence: ['red', 'green'],
    verification_commands: [{ id: 't', command: ['node', '--test'] }],
    worker: { model: 'sonnet', max_turns: 5, max_wall_clock_minutes: 5, max_attempts: 2, nested_delegation: false },
    acceptance_criteria: ['AC-1'],
    ...patch,
  };
}

function graphOf(nodes: GraphNode[]): PortfolioGraph {
  return {
    schema_version: 1,
    feature_id: 'FEAT-1',
    title: 't',
    acceptance_criteria: [{ id: 'AC-1', text: 'x' }],
    resources: { 'full-runtime': { capacity: 1 } },
    repositories: ['core', 'api'],
    capabilities: [],
    nodes,
  };
}

function state(graph: PortfolioGraph, states: Record<string, NodeState>, writers = 4): FeatureState_ {
  const s = initialState(graph, '0'.repeat(64));
  s.budget.max_writer_concurrency = writers;
  for (const [id, st] of Object.entries(states)) s.nodes[id]!.state = st;
  return s;
}

const opts = (s: FeatureState_) => ({ writerConcurrency: s.budget.max_writer_concurrency });

describe('canSchedule', () => {
  it('refuses a node whose dependencies are not DONE', () => {
    const g = graphOf([node('A'), node('B', { depends_on: ['A'], allowed_paths: ['lib/**'] })]);
    const s = state(g, { A: 'REGRESSION_VERIFIED' });
    expect(canSchedule(g, s, 'B', opts(s))).toMatchObject({ ok: false, reason: 'DEPENDENCIES_NOT_DONE' });
  });

  it('refuses a node that is already claimed or in flight', () => {
    const g = graphOf([node('A')]);
    for (const st of ['CLAIMED', 'RED_PENDING', 'GREEN_VERIFIED', 'DONE', 'BLOCKED'] as NodeState[]) {
      const s = state(g, { A: st });
      expect(canSchedule(g, s, 'A', opts(s))).toMatchObject({ ok: false, reason: 'NOT_OFFERABLE' });
    }
  });

  it('refuses a node overlapping the files of an in-flight node in the same repository', () => {
    const g = graphOf([node('A'), node('B', { allowed_paths: ['src/queue/**'] })]);
    const s = state(g, { A: 'GREEN_PENDING' });
    expect(canSchedule(g, s, 'B', opts(s))).toMatchObject({ ok: false, reason: 'PATH_OWNERSHIP_CONFLICT' });
  });

  it('allows the same paths in a different repository', () => {
    const g = graphOf([node('A'), node('B', { repository: 'api' })]);
    const s = state(g, { A: 'CLAIMED' });
    expect(canSchedule(g, s, 'B', opts(s))).toEqual({ ok: true });
  });

  it('refuses a node needing a resource an in-flight node holds', () => {
    const g = graphOf([
      node('A', { required_resources: ['full-runtime'] }),
      node('B', { repository: 'api', required_resources: ['full-runtime'] }),
    ]);
    const s = state(g, { A: 'CLAIMED' });
    expect(canSchedule(g, s, 'B', opts(s))).toMatchObject({ ok: false, reason: 'RESOURCE_CAPACITY' });
  });

  it('refuses past the writer limit and past the attempt budget', () => {
    const g = graphOf([node('A'), node('B', { repository: 'api' })]);
    const s = state(g, { A: 'CLAIMED' }, 1);
    expect(canSchedule(g, s, 'B', opts(s))).toMatchObject({ ok: false, reason: 'WIP_LIMIT' });
    const t = state(g, {});
    t.nodes['A']!.attempts = 2;
    expect(canSchedule(g, t, 'A', opts(t))).toMatchObject({ ok: false, reason: 'ATTEMPTS_EXHAUSTED' });
  });

  it('counts the attempt budget per approved rework generation, never resetting lifetime attempts', () => {
    const g = graphOf([node('A')]);
    const t = state(g, {});
    const a = t.nodes['A']!;
    a.attempts = 2;
    a.rework_brief = {
      generation: 1,
      limit: 2,
      at: 'now',
      reason: 'QA failed',
      reason_sha256: '0'.repeat(64),
      decision_id: null,
      acceptance_criteria: [],
      evidence: [],
      replaced: { integrated_sha: null, candidate_id: null, archived_ref: null },
      attempt_base: 1,
    };
    // One of this generation's two attempts used.
    expect(canSchedule(g, t, 'A', opts(t))).toMatchObject({ ok: true });
    a.attempts = 3;
    expect(canSchedule(g, t, 'A', opts(t))).toMatchObject({ ok: false, reason: 'ATTEMPTS_EXHAUSTED' });
    // A base past the lifetime count (attempts reset by a decision) never mints extra attempts.
    a.attempts = 2;
    a.rework_brief.attempt_base = 5;
    expect(canSchedule(g, t, 'A', opts(t))).toMatchObject({ ok: false, reason: 'ATTEMPTS_EXHAUSTED' });
  });

  it('accepts a node that is out of batch order but conflict-free', () => {
    const g = graphOf([node('A'), node('B', { repository: 'api' }), node('C', { allowed_paths: ['docs/**'] })]);
    const s = state(g, {}, 2);
    // The batch picks A and B first, but C conflicts with nothing in flight.
    expect(scheduleBatch(g, s, opts(s)).scheduled.map((x) => x.node_id)).toEqual(['A', 'B']);
    expect(canSchedule(g, s, 'C', opts(s))).toEqual({ ok: true });
  });
});

describe('scheduleBatch against in-flight work', () => {
  it('defers a ready node that overlaps an in-flight node', () => {
    const g = graphOf([node('A'), node('B', { allowed_paths: ['src/x/**'] })]);
    const s = state(g, { A: 'RED_PENDING' });
    const plan = scheduleBatch(g, s, opts(s));
    expect(plan.scheduled).toEqual([]);
    expect(plan.deferred).toEqual([expect.objectContaining({ node_id: 'B', reason: 'PATH_OWNERSHIP_CONFLICT' })]);
  });
});
