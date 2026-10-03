/**
 * READY computation and conflict-free batch scheduling.
 *
 * Parallelism is never an agent preference: it is a derived property of the
 * graph. A node is only scheduled when its dependencies are satisfied, its
 * attempt budget is intact, no other scheduled node owns the same files or
 * contracts in the same repository, and every required resource still has
 * capacity (full runtime and deploy slots are always capacity 1).
 */
import type { FeatureState_, GraphNode, NodeState, PortfolioGraph } from '../model/types.js';

/** Node states that count as "the work of this node is finished and trusted". */
const SATISFIED_DEPENDENCY_STATES: ReadonlySet<NodeState> = new Set<NodeState>([
  'DONE',
  'EXCLUDED',
]);

/** Node states from which a node may be (re)offered for work. */
const OFFERABLE_STATES: ReadonlySet<NodeState> = new Set<NodeState>([
  'PLANNED',
  'READY',
  'INVALIDATED',
]);

/** Node states that mean the node is currently occupying a writer slot. */
const IN_FLIGHT_STATES: ReadonlySet<NodeState> = new Set<NodeState>([
  'CLAIMED',
  'RED_PENDING',
  'GREEN_PENDING',
]);

export interface ScheduleOptions {
  writerConcurrency: number;
  /** Resource units already leased by work outside this batch. */
  heldResources?: Record<string, number>;
}

export interface ScheduledNode {
  node_id: string;
  repository: string | null;
  resources: string[];
}

export type DeferReason =
  | 'WIP_LIMIT'
  | 'RESOURCE_CAPACITY'
  | 'PATH_OWNERSHIP_CONFLICT'
  | 'CONTRACT_OWNERSHIP_CONFLICT'
  | 'ATTEMPTS_EXHAUSTED';

export interface DeferredNode {
  node_id: string;
  reason: DeferReason;
  detail: string;
}

export interface SchedulePlan {
  scheduled: ScheduledNode[];
  deferred: DeferredNode[];
}

/** The literal prefix of a glob, i.e. everything before the first wildcard. */
function globPrefix(pattern: string): string {
  const normalised = pattern.replace(/\\/g, '/');
  const wildcard = normalised.search(/[*?[\]{}]/);
  const head = wildcard === -1 ? normalised : normalised.slice(0, wildcard);
  // Trim to the last complete path segment so "src/re*" does not claim "src/queue".
  const lastSlash = head.lastIndexOf('/');
  if (wildcard === -1) return normalised;
  return lastSlash === -1 ? '' : head.slice(0, lastSlash);
}

function prefixesOverlap(a: string, b: string): boolean {
  if (a === '' || b === '') return true;
  const an = a.endsWith('/') ? a : a + '/';
  const bn = b.endsWith('/') ? b : b + '/';
  return an === bn || an.startsWith(bn) || bn.startsWith(an);
}

/**
 * Conservative ownership overlap test between two allowed-path sets.
 *
 * Deliberately errs towards "overlapping": serialising two workers that could
 * have run in parallel costs time; letting two workers edit the same subtree
 * costs a corrupt integration.
 */
export function pathsOverlap(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  for (const pa of a) {
    for (const pb of b) {
      if (prefixesOverlap(globPrefix(pa), globPrefix(pb))) return true;
    }
  }
  return false;
}

function dependenciesSatisfied(node: GraphNode, state: FeatureState_): boolean {
  return node.depends_on.every((dep) => {
    const runtime = state.nodes[dep];
    return runtime !== undefined && SATISFIED_DEPENDENCY_STATES.has(runtime.state);
  });
}

/**
 * Nodes whose dependencies are satisfied and which are currently offerable.
 * Returned in deterministic graph order (declaration order of `graph.nodes`).
 */
export function computeReady(graph: PortfolioGraph, state: FeatureState_): string[] {
  const ready: string[] = [];
  for (const node of graph.nodes) {
    const runtime = state.nodes[node.id];
    if (!runtime) continue;
    if (!OFFERABLE_STATES.has(runtime.state)) continue;
    if (!dependenciesSatisfied(node, state)) continue;
    ready.push(node.id);
  }
  return ready;
}

/** Resource units currently consumed by in-flight nodes recorded in STATE. */
export function inFlightResources(
  graph: PortfolioGraph,
  state: FeatureState_,
): Record<string, number> {
  const held: Record<string, number> = {};
  for (const node of graph.nodes) {
    const runtime = state.nodes[node.id];
    if (!runtime || !IN_FLIGHT_STATES.has(runtime.state)) continue;
    for (const res of node.required_resources) held[res] = (held[res] ?? 0) + 1;
  }
  return held;
}

function countInFlight(graph: PortfolioGraph, state: FeatureState_): number {
  let n = 0;
  for (const node of graph.nodes) {
    const runtime = state.nodes[node.id];
    if (runtime && IN_FLIGHT_STATES.has(runtime.state)) n++;
  }
  return n;
}

/**
 * Pick a conflict-free batch from the READY set.
 *
 * Nodes are considered in deterministic graph order, so the same inputs always
 * produce the same plan — a precondition for reproducible orchestration.
 */
export function scheduleBatch(
  graph: PortfolioGraph,
  state: FeatureState_,
  options: ScheduleOptions,
): SchedulePlan {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const ready = computeReady(graph, state);

  const held: Record<string, number> = { ...inFlightResources(graph, state) };
  for (const [res, n] of Object.entries(options.heldResources ?? {})) {
    held[res] = (held[res] ?? 0) + n;
  }

  let writerSlots = options.writerConcurrency - countInFlight(graph, state);

  const scheduled: ScheduledNode[] = [];
  const deferred: DeferredNode[] = [];

  for (const id of ready) {
    const node = byId.get(id);
    const runtime = state.nodes[id];
    if (!node || !runtime) continue;

    if (runtime.attempts >= node.worker.max_attempts) {
      deferred.push({
        node_id: id,
        reason: 'ATTEMPTS_EXHAUSTED',
        detail: `attempts ${runtime.attempts} >= max_attempts ${node.worker.max_attempts}`,
      });
      continue;
    }

    // Ownership conflicts against nodes already picked for this batch.
    const pathConflict = scheduled.find((s) => {
      const other = byId.get(s.node_id);
      if (!other) return false;
      if (other.repository === null || node.repository === null) return false;
      if (other.repository !== node.repository) return false;
      return pathsOverlap(other.allowed_paths, node.allowed_paths);
    });
    if (pathConflict) {
      deferred.push({
        node_id: id,
        reason: 'PATH_OWNERSHIP_CONFLICT',
        detail: `overlaps allowed_paths of ${pathConflict.node_id} in repository ${node.repository}`,
      });
      continue;
    }

    const contractConflict = scheduled.find((s) => {
      const other = byId.get(s.node_id);
      if (!other) return false;
      const mine = new Set(node.contract_outputs ?? []);
      return (other.contract_outputs ?? []).some((c) => mine.has(c));
    });
    if (contractConflict) {
      deferred.push({
        node_id: id,
        reason: 'CONTRACT_OWNERSHIP_CONFLICT',
        detail: `writes a contract also produced by ${contractConflict.node_id}`,
      });
      continue;
    }

    // Resource capacity, counting this batch's own reservations.
    const blockingResource = node.required_resources.find((res) => {
      const capacity = graph.resources[res]?.capacity ?? 0;
      return (held[res] ?? 0) + 1 > capacity;
    });
    if (blockingResource !== undefined) {
      deferred.push({
        node_id: id,
        reason: 'RESOURCE_CAPACITY',
        detail: `resource "${blockingResource}" is at capacity ${graph.resources[blockingResource]?.capacity ?? 0}`,
      });
      continue;
    }

    if (writerSlots <= 0) {
      deferred.push({
        node_id: id,
        reason: 'WIP_LIMIT',
        detail: `writer concurrency limit ${options.writerConcurrency} reached`,
      });
      continue;
    }

    for (const res of node.required_resources) held[res] = (held[res] ?? 0) + 1;
    writerSlots--;
    scheduled.push({
      node_id: id,
      repository: node.repository,
      resources: [...node.required_resources],
    });
  }

  return { scheduled, deferred };
}
