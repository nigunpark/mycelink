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

/**
 * Node states that mean an attempt holds a claim: a worktree, a writer slot
 * and its resources. Every state between CLAIMED and DONE counts, not only
 * the pending ones, because the claim is held until the attempt settles.
 */
export const IN_FLIGHT_STATES: ReadonlySet<NodeState> = new Set<NodeState>([
  'CLAIMED',
  'RED_PENDING',
  'RED_VERIFIED',
  'GREEN_PENDING',
  'GREEN_VERIFIED',
  'REFACTOR_VERIFIED',
  'REGRESSION_VERIFIED',
  'REVIEW_VERIFIED',
  'INTEGRATED',
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

/** Conflict of `node` with nodes already in flight or already picked. */
function conflictWith(
  graph: PortfolioGraph,
  node: GraphNode,
  runtime: FeatureState_['nodes'][string],
  occupied: readonly GraphNode[],
  held: Record<string, number>,
  writerSlots: number,
  writerConcurrency: number,
): DeferredNode | null {
  const id = node.id;
  if (runtime.attempts >= node.worker.max_attempts) {
    return {
      node_id: id,
      reason: 'ATTEMPTS_EXHAUSTED',
      detail: `attempts ${runtime.attempts} >= max_attempts ${node.worker.max_attempts}`,
    };
  }

  // Ownership conflicts against nodes in flight or already picked: two
  // workers editing the same subtree of one repository would collide at
  // integration even though their worktrees are separate.
  const pathConflict = occupied.find((other) => {
    if (other.repository === null || node.repository === null) return false;
    if (other.repository !== node.repository) return false;
    return pathsOverlap(other.allowed_paths, node.allowed_paths);
  });
  if (pathConflict) {
    return {
      node_id: id,
      reason: 'PATH_OWNERSHIP_CONFLICT',
      detail: `overlaps allowed_paths of ${pathConflict.id} in repository ${node.repository}`,
    };
  }

  const mine = new Set(node.contract_outputs ?? []);
  const contractConflict = occupied.find((other) => (other.contract_outputs ?? []).some((c) => mine.has(c)));
  if (contractConflict) {
    return {
      node_id: id,
      reason: 'CONTRACT_OWNERSHIP_CONFLICT',
      detail: `writes a contract also produced by ${contractConflict.id}`,
    };
  }

  const blockingResource = node.required_resources.find((res) => {
    const capacity = graph.resources[res]?.capacity ?? 0;
    return (held[res] ?? 0) + 1 > capacity;
  });
  if (blockingResource !== undefined) {
    return {
      node_id: id,
      reason: 'RESOURCE_CAPACITY',
      detail: `resource "${blockingResource}" is at capacity ${graph.resources[blockingResource]?.capacity ?? 0}`,
    };
  }

  if (writerSlots <= 0) {
    return { node_id: id, reason: 'WIP_LIMIT', detail: `writer concurrency limit ${writerConcurrency} reached` };
  }
  return null;
}

function inFlightNodes(graph: PortfolioGraph, state: FeatureState_): GraphNode[] {
  return graph.nodes.filter((n) => {
    const runtime = state.nodes[n.id];
    return runtime !== undefined && IN_FLIGHT_STATES.has(runtime.state);
  });
}

function heldUnits(graph: PortfolioGraph, state: FeatureState_, options: ScheduleOptions): Record<string, number> {
  const held: Record<string, number> = { ...inFlightResources(graph, state) };
  for (const [res, n] of Object.entries(options.heldResources ?? {})) {
    held[res] = (held[res] ?? 0) + n;
  }
  return held;
}

export type ScheduleCheck =
  | { ok: true }
  | { ok: false; reason: DeferReason | 'UNKNOWN_NODE' | 'NOT_OFFERABLE' | 'DEPENDENCIES_NOT_DONE'; detail: string };

/**
 * Whether one node may be claimed right now, judged against everything
 * already in flight. Unlike {@link scheduleBatch} it does not care about
 * batch order: an explicit claim of a conflict-free node is allowed even if a
 * batch would have picked others first.
 */
export function canSchedule(
  graph: PortfolioGraph,
  state: FeatureState_,
  nodeId: string,
  options: ScheduleOptions,
): ScheduleCheck {
  const node = graph.nodes.find((n) => n.id === nodeId);
  const runtime = state.nodes[nodeId];
  if (!node || !runtime) return { ok: false, reason: 'UNKNOWN_NODE', detail: `"${nodeId}" is not in the graph` };
  if (!OFFERABLE_STATES.has(runtime.state)) {
    return { ok: false, reason: 'NOT_OFFERABLE', detail: `${nodeId} is ${runtime.state}` };
  }
  if (!dependenciesSatisfied(node, state)) {
    const pending = node.depends_on.filter((d) => !SATISFIED_DEPENDENCY_STATES.has(state.nodes[d]?.state ?? 'PLANNED'));
    return {
      ok: false,
      reason: 'DEPENDENCIES_NOT_DONE',
      detail: pending.map((d) => `${d}=${state.nodes[d]?.state ?? 'missing'}`).join(', '),
    };
  }
  const conflict = conflictWith(
    graph,
    node,
    runtime,
    inFlightNodes(graph, state),
    heldUnits(graph, state, options),
    options.writerConcurrency - countInFlight(graph, state),
    options.writerConcurrency,
  );
  return conflict === null ? { ok: true } : { ok: false, reason: conflict.reason, detail: conflict.detail };
}

/**
 * Pick a conflict-free batch from the READY set.
 *
 * Nodes are considered in deterministic graph order, so the same inputs always
 * produce the same plan — a precondition for reproducible orchestration.
 * Conflicts are checked against nodes already in flight as well as against
 * the batch itself.
 */
export function scheduleBatch(
  graph: PortfolioGraph,
  state: FeatureState_,
  options: ScheduleOptions,
): SchedulePlan {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const held = heldUnits(graph, state, options);
  const occupied = inFlightNodes(graph, state);
  let writerSlots = options.writerConcurrency - countInFlight(graph, state);

  const scheduled: ScheduledNode[] = [];
  const deferred: DeferredNode[] = [];

  for (const id of computeReady(graph, state)) {
    const node = byId.get(id);
    const runtime = state.nodes[id];
    if (!node || !runtime) continue;
    const conflict = conflictWith(graph, node, runtime, occupied, held, writerSlots, options.writerConcurrency);
    if (conflict !== null) {
      deferred.push(conflict);
      continue;
    }
    for (const res of node.required_resources) held[res] = (held[res] ?? 0) + 1;
    writerSlots--;
    occupied.push(node);
    scheduled.push({ node_id: id, repository: node.repository, resources: [...node.required_resources] });
  }

  return { scheduled, deferred };
}
