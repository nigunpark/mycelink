import { describe, expect, it } from 'vitest';
import {
  type E2EScenario,
  conflictReason,
  planShards,
  attributeFailure,
} from '../../src/e2e/scheduler.js';
import { clone, VALID_GRAPH } from '../helpers/graph-fixtures.js';
import type { PortfolioGraph } from '../../src/model/types.js';

function scenario(id: string, patch: Partial<E2EScenario> = {}): E2EScenario {
  return {
    schema_version: 1,
    id,
    depends_on: [],
    resources: ['browser-worker'],
    isolation: {
      browser_profile: 'unique',
      account: 'unique',
      data_namespace: 'unique',
      global_fixture_reset: false,
      mutates_global_state: false,
      order_dependent: false,
      writes: [],
    },
    conflicts_with: [],
    test_command: ['node', 'e2e.mjs', id],
    attributed_nodes: [],
    ...patch,
  };
}

const RESOURCES = {
  'full-runtime': { capacity: 1 },
  'deploy-slot': { capacity: 1 },
  'browser-worker': { capacity: 2 },
  'global-admin-account': { capacity: 1 },
  'fixture-global-reset': { capacity: 1 },
};

describe('conflictReason', () => {
  it('finds no conflict between two fully isolated scenarios', () => {
    expect(conflictReason(scenario('a'), scenario('b'))).toBeNull();
  });

  it('honours an explicit conflicts_with declaration in both directions', () => {
    const a = scenario('a', { conflicts_with: ['b'] });
    const b = scenario('b');
    expect(conflictReason(a, b)).toBe('DECLARED_CONFLICT');
    expect(conflictReason(b, a)).toBe('DECLARED_CONFLICT');
  });

  it('serialises two scenarios that both reset the global fixture', () => {
    const a = scenario('a', { isolation: { ...scenario('a').isolation, global_fixture_reset: true } });
    const b = scenario('b', { isolation: { ...scenario('b').isolation, global_fixture_reset: true } });
    expect(conflictReason(a, b)).toBe('SHARED_GLOBAL_FIXTURE');
  });

  it('serialises two scenarios sharing a non-unique account', () => {
    const a = scenario('a', { isolation: { ...scenario('a').isolation, account: 'global-admin' } });
    const b = scenario('b', { isolation: { ...scenario('b').isolation, account: 'global-admin' } });
    expect(conflictReason(a, b)).toBe('SHARED_ACCOUNT');
  });

  it('serialises two scenarios sharing a data namespace', () => {
    const a = scenario('a', { isolation: { ...scenario('a').isolation, data_namespace: 'shared' } });
    const b = scenario('b', { isolation: { ...scenario('b').isolation, data_namespace: 'shared' } });
    expect(conflictReason(a, b)).toBe('SHARED_DATA_NAMESPACE');
  });

  it('serialises scenarios that write the same logical data owner', () => {
    const a = scenario('a', { isolation: { ...scenario('a').isolation, writes: ['db:orders'] } });
    const b = scenario('b', { isolation: { ...scenario('b').isolation, writes: ['db:orders'] } });
    expect(conflictReason(a, b)).toBe('SHARED_DATA_OWNER');
  });

  it('serialises anything against a scenario that mutates global state', () => {
    const a = scenario('a', {
      isolation: { ...scenario('a').isolation, mutates_global_state: true },
    });
    expect(conflictReason(a, scenario('b'))).toBe('GLOBAL_MUTATION');
  });

  it('serialises an order-dependent scenario', () => {
    const a = scenario('a', { isolation: { ...scenario('a').isolation, order_dependent: true } });
    expect(conflictReason(a, scenario('b'))).toBe('ORDER_DEPENDENT');
  });

  it('serialises two scenarios sharing a non-unique browser profile', () => {
    const a = scenario('a', { isolation: { ...scenario('a').isolation, browser_profile: 'shared' } });
    const b = scenario('b', { isolation: { ...scenario('b').isolation, browser_profile: 'shared' } });
    expect(conflictReason(a, b)).toBe('SHARED_BROWSER_PROFILE');
  });
});

describe('planShards', () => {
  it('runs two fully isolated scenarios in one parallel shard', () => {
    const plan = planShards([scenario('a'), scenario('b')], RESOURCES);
    expect(plan.shards).toHaveLength(1);
    expect(plan.shards[0]?.scenarios).toEqual(['a', 'b']);
  });

  it('never exceeds the browser-worker capacity in a shard', () => {
    const plan = planShards([scenario('a'), scenario('b'), scenario('c')], RESOURCES);
    expect(plan.shards[0]?.scenarios).toHaveLength(2);
    expect(plan.shards[1]?.scenarios).toEqual(['c']);
  });

  it('puts conflicting scenarios in separate shards', () => {
    const a = scenario('a', { conflicts_with: ['b'] });
    const plan = planShards([a, scenario('b')], RESOURCES);
    expect(plan.shards).toHaveLength(2);
    expect(plan.shards[0]?.scenarios).toEqual(['a']);
    expect(plan.shards[1]?.scenarios).toEqual(['b']);
  });

  it('reports why each serialised scenario could not join a shard', () => {
    const a = scenario('a', { conflicts_with: ['b'] });
    const plan = planShards([a, scenario('b')], RESOURCES);
    expect(plan.serialised).toContainEqual({
      scenario: 'b',
      against: 'a',
      reason: 'DECLARED_CONFLICT',
    });
  });

  it('runs a scenario needing the full runtime alone', () => {
    const a = scenario('a', { resources: ['full-runtime', 'browser-worker'] });
    const b = scenario('b');
    const plan = planShards([a, b], RESOURCES);
    expect(plan.shards[0]?.scenarios).toEqual(['a']);
    expect(plan.shards[1]?.scenarios).toEqual(['b']);
  });

  it('orders dependent scenarios after their dependencies', () => {
    const a = scenario('a');
    const b = scenario('b', { depends_on: ['a'] });
    const plan = planShards([b, a], RESOURCES);
    expect(plan.shards[0]?.scenarios).toEqual(['a']);
    expect(plan.shards[1]?.scenarios).toEqual(['b']);
  });

  it('rejects a dependency cycle rather than scheduling nothing silently', () => {
    const a = scenario('a', { depends_on: ['b'] });
    const b = scenario('b', { depends_on: ['a'] });
    expect(() => planShards([a, b], RESOURCES)).toThrow(/cycle/i);
  });

  it('is deterministic', () => {
    const scenarios = [scenario('c'), scenario('a'), scenario('b')];
    const first = planShards(scenarios, RESOURCES);
    const second = planShards(scenarios, RESOURCES);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('matches the designed mix: two independent in parallel, one conflicting serial', () => {
    const create = scenario('E2E-create');
    const read = scenario('E2E-read');
    const reset = scenario('E2E-reset', {
      isolation: { ...scenario('x').isolation, global_fixture_reset: true, mutates_global_state: true },
    });
    const plan = planShards([create, read, reset], RESOURCES);
    expect(plan.shards[0]?.scenarios).toEqual(['E2E-create', 'E2E-read']);
    expect(plan.shards[1]?.scenarios).toEqual(['E2E-reset']);
  });
});

describe('attributeFailure', () => {
  const graph = clone(VALID_GRAPH) as unknown as PortfolioGraph;

  it('attributes a failure to the scenario-declared nodes first', () => {
    const s = scenario('a', { attributed_nodes: ['FEAT-101.core.publish.impl'] });
    const result = attributeFailure(s, graph, 'AssertionError: no event published');
    expect(result.nodes).toEqual(['FEAT-101.core.publish.impl']);
    expect(result.strategy).toBe('declared');
  });

  it('falls back to the nodes covering the scenario acceptance criteria', () => {
    const s = scenario('a', { acceptance_criteria: ['AC-1'] });
    const result = attributeFailure(s, graph, 'failure');
    expect(result.nodes).toContain('FEAT-101.core.publish.impl');
    expect(result.strategy).toBe('acceptance-criteria');
  });

  it('falls back to every non-e2e node when nothing narrower is known', () => {
    const result = attributeFailure(scenario('a'), graph, 'failure');
    expect(result.strategy).toBe('whole-feature');
    expect(result.nodes).not.toContain('FEAT-101.e2e.acceptance.full');
  });

  it('prefers a producer node named in the failure output', () => {
    const s = scenario('a', { acceptance_criteria: ['AC-1', 'AC-2'] });
    const result = attributeFailure(
      s,
      graph,
      'contract mismatch in contracts/order-status.schema.json',
    );
    expect(result.nodes).toEqual(['FEAT-101.core.publish.impl']);
    expect(result.strategy).toBe('contract');
  });
});
