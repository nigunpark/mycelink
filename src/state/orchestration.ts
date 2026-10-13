/**
 * The orchestration epoch and the dispatch lease registry of a feature, as
 * pure functions of its STATE.json.
 *
 * CSET-203 r7: a review advanced (a refinement settled PASS) while nodes it
 * judged were still reopened, and a worker dispatched past it settled into
 * the reviewed state. Nothing tied the reviewed state to the work in flight.
 *
 *  - The epoch is monotonic. It moves, in the same STATE.json write, with
 *    every change of what a review or a candidate binds: a rework applied
 *    (its reopened nodes with it), a review-gap challenge restoring a
 *    generation, a review or refinement settled, a producer integrated, a
 *    node invalidated. Nothing else moves it: a dispatch, a status read or a
 *    stale answer never does.
 *  - A node's lineage is the epoch its own generation last changed at
 *    (reworked, reopened, restored, invalidated). A claim binds it: a claim
 *    whose node's lineage moved is obsolete, whatever else holds.
 *  - Every claim generation (a host dispatch, a resume's, a controller run)
 *    and every review generation is a lease: issued in the write that makes
 *    it, closed in the write that ends it — settled, revoked (a resume
 *    rotated it), abandoned (its holder vanished), released (its claim went
 *    some other way), stale (it answered after it stopped counting) or
 *    interrupted-provider (a model provider ended its holder: CSET-203 r10).
 *    `syncLeases` runs inside every STATE.json write (state/feature-state.ts):
 *    a lease whose claim or review generation is gone is closed, and a live
 *    claim or open review with no lease (a STATE.json from before the
 *    registry) is adopted, so the registry and the state never disagree.
 */
import type { DispatchLease, DispatchLeaseKind, DispatchLeaseStatus, FeatureState_, HostSessionBinding, OrchestrationState } from '../model/types.js';

/** Closed leases kept for a late answer to be recognised by (every active one is kept). */
export const MAX_CLOSED_LEASES = 64;
/** Epoch bumps kept, newest last: what moved it and when. */
export const MAX_BUMPS = 32;
const MAX_REASON = 300;
/** Late answers archived per closed lease. */
const MAX_STALE_ARCHIVES = 8;

export function emptyOrchestration(): OrchestrationState {
  return { epoch: 0, bumps: [], leases: [] };
}

/** The feature's epoch: 0 for a STATE.json from before epochs existed. */
export function currentEpoch(s: Pick<FeatureState_, 'orchestration'>): number {
  return s.orchestration?.epoch ?? 0;
}

/** The orchestration record of `s`, created (at epoch 0) when it has none. */
export function orchestrationOf(s: FeatureState_): OrchestrationState {
  if (s.orchestration === undefined || s.orchestration === null) s.orchestration = emptyOrchestration();
  return s.orchestration;
}

/** A node's lineage: the epoch its generation last changed at (0: never since epochs existed). */
export function lineageOf(s: Pick<FeatureState_, 'nodes'>, nodeId: string): number {
  return s.nodes[nodeId]?.lineage ?? 0;
}

/**
 * Move the epoch by one, in the write that makes the change, and the lineage
 * of exactly the nodes whose own generation changed with it. Returns the new
 * epoch.
 */
export function bumpEpoch(s: FeatureState_, reason: string, nodes: readonly string[] = [], at: string = new Date().toISOString()): number {
  const o = orchestrationOf(s);
  o.epoch += 1;
  const named = [...new Set(nodes)].filter((id) => s.nodes[id] !== undefined);
  for (const id of named) (s.nodes[id] as NonNullable<FeatureState_['nodes'][string]>).lineage = o.epoch;
  o.bumps = [...o.bumps, { epoch: o.epoch, reason: reason.slice(0, MAX_REASON), at, ...(named.length > 0 ? { nodes: named } : {}) }].slice(-MAX_BUMPS);
  return o.epoch;
}

export interface LeaseIssue {
  kind: DispatchLeaseKind;
  node_id: string | null;
  review_id: string | null;
  refinement?: boolean;
  claim_id: string | null;
  dispatch_id: string | null;
  capability_sha256: string | null;
  generation: number;
  worktree: string | null;
  result_file: string | null;
  /** The host session it is handed to, when the plugin's fence bound one (hooks/provider-binding.ts). */
  host?: HostSessionBinding | null;
}

/** Issue an active lease, bound to the epoch now and the node's lineage (a review's: the epoch). */
export function issueLease(s: FeatureState_, issue: LeaseIssue, at: string = new Date().toISOString()): DispatchLease {
  const o = orchestrationOf(s);
  const epoch = o.epoch;
  const lease: DispatchLease = {
    lease_id: issue.dispatch_id ?? issue.claim_id ?? `${issue.review_id ?? 'lease'}-${o.leases.length + 1}`,
    kind: issue.kind,
    node_id: issue.node_id,
    review_id: issue.review_id,
    ...(issue.refinement === true ? { refinement: true } : {}),
    claim_id: issue.claim_id,
    dispatch_id: issue.dispatch_id,
    capability_sha256: issue.capability_sha256,
    epoch,
    lineage: issue.node_id !== null ? lineageOf(s, issue.node_id) : epoch,
    generation: issue.generation,
    status: 'active',
    issued_at: at,
    closed_at: null,
    closed_reason: null,
    worktree: issue.worktree,
    result_file: issue.result_file,
    ...(issue.host !== undefined && issue.host !== null ? { host: issue.host } : {}),
  };
  o.leases = [...o.leases, lease];
  trimLeases(o);
  return lease;
}

/** Close every active lease `match` selects, as `status`, for `reason`. Returns those closed. */
export function closeLeases(
  s: FeatureState_,
  match: (l: DispatchLease) => boolean,
  status: Exclude<DispatchLeaseStatus, 'active'>,
  reason: string,
  at: string = new Date().toISOString(),
  extra: Partial<Pick<DispatchLease, 'outcome' | 'settled_epoch'>> = {},
): DispatchLease[] {
  const o = s.orchestration;
  if (o === undefined || o === null) return [];
  const closed: DispatchLease[] = [];
  for (const l of o.leases) {
    if (l.status !== 'active' || !match(l)) continue;
    l.status = status;
    l.closed_at = at;
    l.closed_reason = reason.slice(0, MAX_REASON);
    if (extra.outcome !== undefined) l.outcome = extra.outcome.slice(0, 64);
    if (extra.settled_epoch !== undefined) l.settled_epoch = extra.settled_epoch;
    closed.push(l);
  }
  return closed;
}

/** Leases still active (of `kinds`, when given). */
export function activeLeases(s: Pick<FeatureState_, 'orchestration'>, kinds?: readonly DispatchLeaseKind[]): DispatchLease[] {
  return (s.orchestration?.leases ?? []).filter((l) => l.status === 'active' && (kinds === undefined || kinds.includes(l.kind)));
}

/** The lease a capability (by its SHA-256 test) was issued with, newest first. */
export function leaseOf(s: Pick<FeatureState_, 'orchestration'>, matches: (capabilitySha256: string) => boolean): DispatchLease | null {
  return [...(s.orchestration?.leases ?? [])].reverse().find((l) => l.capability_sha256 !== null && matches(l.capability_sha256)) ?? null;
}

/** Record a late answer of a closed lease refused stale: the archived result, once per content. */
export function markStale(lease: DispatchLease, reason: string, archived: { path: string; sha256: string } | null, at: string = new Date().toISOString()): void {
  const prior = lease.stale ?? { at, reason: reason.slice(0, MAX_REASON), archived: [] };
  const list = archived === null || prior.archived.some((a) => a.sha256 === archived.sha256) ? prior.archived : [...prior.archived, archived].slice(-MAX_STALE_ARCHIVES);
  lease.stale = { at: prior.at, reason: prior.reason, archived: list };
  if (lease.status === 'active') {
    lease.status = 'stale';
    lease.closed_at = at;
    lease.closed_reason = reason.slice(0, MAX_REASON);
  } else if (lease.status !== 'settled' && lease.status !== 'interrupted-provider') {
    // A lease a provider failure closed keeps saying so (its accounting); the late answer is on its stale record.
    lease.status = 'stale';
  }
}

/**
 * Keep the registry and the state one: inside every STATE.json write, an
 * active lease whose claim (or review generation) is gone is closed —
 * `settled` when its node settled exactly that claim and generation (or its
 * review recorded exactly that generation), `released` otherwise — and a live
 * claim or open review with no active lease is adopted. Idempotent. A
 * STATE.json with no orchestration record (written before the registry) is
 * left as it is until an orchestration-aware write creates one.
 */
export function syncLeases(s: FeatureState_, at: string = new Date().toISOString()): FeatureState_ {
  const o = s.orchestration;
  if (o === undefined || o === null) return s;
  const open = s.acceptance_review?.open ?? null;
  for (const l of o.leases) {
    if (l.status !== 'active') continue;
    if (l.kind === 'review') {
      if (open !== null && open.dispatch_id === l.dispatch_id) continue;
      const recorded = (s.acceptance_review?.reviews ?? []).find((r) => r.dispatch_id === l.dispatch_id || (r.refinements ?? []).some((x) => x.dispatch_id === l.dispatch_id));
      l.status = recorded !== undefined ? 'settled' : 'released';
      l.closed_at = at;
      l.closed_reason = recorded !== undefined ? `review ${recorded.review_id} settled ${recorded.outcome}` : 'its review generation is no longer open';
      if (recorded !== undefined) {
        l.outcome = recorded.outcome;
        l.settled_epoch = o.epoch;
      }
      continue;
    }
    const rt = l.node_id !== null ? s.nodes[l.node_id] : undefined;
    const c = rt?.claim ?? null;
    if (c !== null && c.claim_id === l.claim_id && (c.dispatch_id ?? null) === l.dispatch_id && (c.capability_sha256 ?? null) === l.capability_sha256) continue;
    const settled = rt?.last_settlement ?? null;
    const same = settled !== null && settled.claim_id === l.claim_id && (settled.dispatch_id ?? null) === (l.dispatch_id ?? null);
    l.status = same ? 'settled' : 'released';
    l.closed_at = at;
    l.closed_reason = same ? `settled ${settled.outcome}` : 'its claim ended without a settlement of this generation';
    if (same) {
      l.outcome = settled.outcome.slice(0, 64);
      l.settled_epoch = o.epoch;
    }
  }
  // Adopt what has no lease: a live claim, an open review generation.
  for (const [id, rt] of Object.entries(s.nodes)) {
    const c = rt.claim;
    if (c === null) continue;
    const held = o.leases.some((l) => l.status === 'active' && l.node_id === id && l.claim_id === c.claim_id && l.dispatch_id === (c.dispatch_id ?? null) && l.capability_sha256 === (c.capability_sha256 ?? null));
    if (held) continue;
    issueLease(
      s,
      {
        kind: c.lease_kind ?? (c.mode === 'controller' ? 'verification' : 'worker'),
        node_id: id,
        review_id: null,
        claim_id: c.claim_id,
        dispatch_id: c.dispatch_id ?? null,
        capability_sha256: c.capability_sha256 ?? null,
        generation: c.generation ?? 0,
        worktree: c.worktree,
        result_file: c.result_file ?? null,
        host: c.host_session ?? null,
      },
      at,
    );
  }
  // A generation a provider failure revoked, or whose reviewer was interrupted (CSET-203 r13), stays open only to be re-issued: it holds no lease.
  if (open !== null && (open.provider_interrupted ?? null) === null && (open.agent_interrupted ?? null) === null && !o.leases.some((l) => l.status === 'active' && l.kind === 'review' && l.dispatch_id === open.dispatch_id)) {
    issueLease(s, { kind: 'review', node_id: null, review_id: open.review_id, ...((open.refinement ?? null) !== null ? { refinement: true } : {}), claim_id: null, dispatch_id: open.dispatch_id, capability_sha256: open.capability_sha256, generation: open.attempt, worktree: null, result_file: null, host: open.host_session ?? null }, at);
  }
  trimLeases(o);
  return s;
}

/** Every active lease, and the newest MAX_CLOSED_LEASES closed ones, in issue order. */
function trimLeases(o: OrchestrationState): void {
  const closed = o.leases.filter((l) => l.status !== 'active');
  if (closed.length <= MAX_CLOSED_LEASES) return;
  const drop = new Set(closed.slice(0, closed.length - MAX_CLOSED_LEASES));
  o.leases = o.leases.filter((l) => !drop.has(l));
}

/** The lease kind of a node's claim: what a review barrier and a candidate gate count. */
export function leaseKindFor(nodeType: string, mode: string | undefined): DispatchLeaseKind {
  if (nodeType === 'verification') return 'verification';
  if (nodeType === 'candidate-build') return 'candidate';
  if (nodeType === 'e2e-scenario') return 'e2e';
  return mode === 'controller' ? 'verification' : 'worker';
}

/** Leases that can still change what a review judges: work on a product or verification node. */
export const BARRIER_KINDS: readonly DispatchLeaseKind[] = ['worker', 'verification'];
