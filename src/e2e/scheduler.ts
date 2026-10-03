/**
 * Browser E2E scheduling.
 *
 * Parallelism across browsers is only safe when scenarios genuinely cannot
 * interfere. This module derives a conflict graph from declared isolation
 * properties and schedules the largest conflict-free shards that still fit
 * the declared resource capacities — with the full runtime always capacity 1.
 *
 * When a scenario fails, it is attributed back to the narrowest set of graph
 * nodes that could have caused it, so the fix goes through TDD at the right
 * layer rather than becoming a blind E2E retry.
 */
import type { PortfolioGraph, ResourceDecl } from '../model/types.js';

export interface E2EIsolation {
  browser_profile: 'unique' | 'shared';
  account: 'unique' | 'shared' | 'global-admin';
  data_namespace: 'unique' | 'shared';
  global_fixture_reset?: boolean;
  mutates_global_state?: boolean;
  order_dependent?: boolean;
  /** Logical data owners written: db table, queue key prefix, global setting. */
  writes?: string[];
}

export interface E2EScenario {
  schema_version: 1;
  id: string;
  title?: string;
  depends_on?: string[];
  acceptance_criteria?: string[];
  resources: string[];
  isolation: E2EIsolation;
  conflicts_with?: string[];
  setup_command?: string[];
  test_command: string[];
  cleanup_command?: string[];
  attributed_nodes?: string[];
  evidence?: { screenshots?: boolean; trace?: boolean; junit?: boolean };
}

export type ConflictReason =
  | 'DECLARED_CONFLICT'
  | 'GLOBAL_MUTATION'
  | 'ORDER_DEPENDENT'
  | 'SHARED_GLOBAL_FIXTURE'
  | 'SHARED_ACCOUNT'
  | 'SHARED_DATA_NAMESPACE'
  | 'SHARED_DATA_OWNER'
  | 'SHARED_BROWSER_PROFILE';

/**
 * Why two scenarios may not run concurrently, or null when they may.
 *
 * Checked in declaration order so the reported reason is the strongest one.
 */
export function conflictReason(a: E2EScenario, b: E2EScenario): ConflictReason | null {
  if ((a.conflicts_with ?? []).includes(b.id) || (b.conflicts_with ?? []).includes(a.id)) {
    return 'DECLARED_CONFLICT';
  }
  if (a.isolation.mutates_global_state || b.isolation.mutates_global_state) {
    return 'GLOBAL_MUTATION';
  }
  if (a.isolation.order_dependent || b.isolation.order_dependent) {
    return 'ORDER_DEPENDENT';
  }
  if (a.isolation.global_fixture_reset && b.isolation.global_fixture_reset) {
    return 'SHARED_GLOBAL_FIXTURE';
  }
  if (a.isolation.account !== 'unique' && a.isolation.account === b.isolation.account) {
    return 'SHARED_ACCOUNT';
  }
  if (a.isolation.data_namespace === 'shared' && b.isolation.data_namespace === 'shared') {
    return 'SHARED_DATA_NAMESPACE';
  }
  const aWrites = new Set(a.isolation.writes ?? []);
  if ((b.isolation.writes ?? []).some((w) => aWrites.has(w))) {
    return 'SHARED_DATA_OWNER';
  }
  if (a.isolation.browser_profile === 'shared' && b.isolation.browser_profile === 'shared') {
    return 'SHARED_BROWSER_PROFILE';
  }
  return null;
}

export interface Shard {
  index: number;
  scenarios: string[];
  resources: Record<string, number>;
}

export interface SerialisedNote {
  scenario: string;
  against: string;
  reason: ConflictReason | 'RESOURCE_CAPACITY' | 'EXCLUSIVE_RESOURCE';
}

export interface E2EPlan {
  shards: Shard[];
  serialised: SerialisedNote[];
}

/**
 * A declared capacity of 1 means the resource cannot be shared at all.
 *
 * Note this is about a *scenario* declaring the resource. The single
 * `full-runtime` lease covering the whole E2E run is taken once by the
 * runner; browser scenarios that simply talk to that runtime do not declare
 * it, which is what lets them shard in parallel.
 */
function isExclusive(
  resource: string,
  resources: Record<string, ResourceDecl | { capacity: number }>,
): boolean {
  return (resources[resource]?.capacity ?? 0) <= 1;
}

/** Topological order honouring depends_on; throws on a cycle. */
function topoOrder(scenarios: E2EScenario[]): E2EScenario[] {
  const byId = new Map(scenarios.map((s) => [s.id, s]));
  const state = new Map<string, 0 | 1 | 2>();
  const out: E2EScenario[] = [];

  function visit(id: string, trail: string[]): void {
    const current = state.get(id) ?? 0;
    if (current === 2) return;
    if (current === 1) {
      throw new Error(`E2E scenario dependency cycle: ${[...trail, id].join(' -> ')}`);
    }
    const scenario = byId.get(id);
    if (!scenario) return;
    state.set(id, 1);
    for (const dep of [...(scenario.depends_on ?? [])].sort()) visit(dep, [...trail, id]);
    state.set(id, 2);
    out.push(scenario);
  }

  for (const scenario of [...scenarios].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    visit(scenario.id, []);
  }
  return out;
}

/**
 * Pack scenarios into shards.
 *
 * A scenario joins the current shard only if it conflicts with nothing in it,
 * every resource it needs still has capacity, and none of its dependencies
 * are in that same shard.
 */
export function planShards(
  scenarios: E2EScenario[],
  resources: Record<string, ResourceDecl | { capacity: number }>,
): E2EPlan {
  const ordered = topoOrder(scenarios);
  const byId = new Map(scenarios.map((s) => [s.id, s]));
  const shards: Shard[] = [];
  const serialised: SerialisedNote[] = [];
  const placed = new Map<string, number>();

  for (const scenario of ordered) {
    let shardIndex = -1;

    // A scenario may not share a shard with anything it depends on.
    const earliest = Math.max(
      0,
      ...(scenario.depends_on ?? []).map((d) => {
        const at = placed.get(d);
        return at === undefined ? 0 : at + 1;
      }),
    );

    for (let i = earliest; i < shards.length; i++) {
      const shard = shards[i] as Shard;
      let blocker: SerialisedNote | null = null;

      for (const otherId of shard.scenarios) {
        const other = byId.get(otherId);
        if (!other) continue;
        const reason = conflictReason(scenario, other);
        if (reason !== null) {
          blocker = { scenario: scenario.id, against: otherId, reason };
          break;
        }
      }

      if (blocker === null) {
        // A capacity-1 resource is exclusive: a scenario that needs the whole
        // runtime (restart, migration, global reset) runs on its own, and so
        // does anything already sharing a shard with such a scenario.
        const exclusiveHere =
          scenario.resources.some((r) => isExclusive(r, resources)) ||
          shard.scenarios.some((id) =>
            (byId.get(id)?.resources ?? []).some((r) => isExclusive(r, resources)),
          );
        if (exclusiveHere && shard.scenarios.length > 0) {
          blocker = {
            scenario: scenario.id,
            against: shard.scenarios[0] as string,
            reason: 'EXCLUSIVE_RESOURCE',
          };
        }
      }

      if (blocker === null) {
        const over = scenario.resources.find((r) => {
          const capacity = resources[r]?.capacity ?? 0;
          return (shard.resources[r] ?? 0) + 1 > capacity;
        });
        if (over !== undefined) {
          blocker = {
            scenario: scenario.id,
            against: shard.scenarios[0] ?? '(shard)',
            reason: 'RESOURCE_CAPACITY',
          };
        }
      }

      if (blocker === null) {
        shardIndex = i;
        break;
      }
      // Record only the first reason this scenario was pushed out.
      if (!serialised.some((s) => s.scenario === scenario.id)) serialised.push(blocker);
    }

    if (shardIndex === -1) {
      shardIndex = shards.length;
      shards.push({ index: shardIndex, scenarios: [], resources: {} });
    }
    const shard = shards[shardIndex] as Shard;
    shard.scenarios.push(scenario.id);
    for (const r of scenario.resources) shard.resources[r] = (shard.resources[r] ?? 0) + 1;
    placed.set(scenario.id, shardIndex);
  }

  return { shards, serialised };
}

export interface AttributionResult {
  nodes: string[];
  strategy: 'declared' | 'contract' | 'acceptance-criteria' | 'whole-feature';
  detail: string;
}

/**
 * Map an E2E failure back onto the graph nodes that could have caused it.
 *
 * Narrowest signal wins: an explicit declaration, then a contract named in
 * the failure output, then the acceptance criteria the scenario covers, then
 * the whole feature. E2E nodes are never blamed for their own failure.
 */
export function attributeFailure(
  scenario: E2EScenario,
  graph: PortfolioGraph,
  failureOutput: string,
): AttributionResult {
  const implementationNodes = graph.nodes.filter((n) => n.node_type !== 'e2e-scenario');

  if ((scenario.attributed_nodes ?? []).length > 0) {
    return {
      nodes: [...(scenario.attributed_nodes as string[])],
      strategy: 'declared',
      detail: 'scenario declares the nodes it exercises',
    };
  }

  const haystack = failureOutput.toLowerCase();
  const contractHits = implementationNodes.filter((n) =>
    (n.contract_outputs ?? []).some((c) => haystack.includes(c.toLowerCase())),
  );
  if (contractHits.length > 0) {
    return {
      nodes: contractHits.map((n) => n.id),
      strategy: 'contract',
      detail: `failure output names a contract produced by ${contractHits.length} node(s)`,
    };
  }

  const acs = new Set(scenario.acceptance_criteria ?? []);
  if (acs.size > 0) {
    const covering = implementationNodes.filter((n) =>
      (n.acceptance_criteria ?? []).some((a) => acs.has(a)),
    );
    if (covering.length > 0) {
      return {
        nodes: covering.map((n) => n.id),
        strategy: 'acceptance-criteria',
        detail: `nodes covering ${[...acs].join(', ')}`,
      };
    }
  }

  return {
    nodes: implementationNodes.map((n) => n.id),
    strategy: 'whole-feature',
    detail: 'no narrower signal; every implementation node is a suspect',
  };
}
