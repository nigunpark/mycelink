/**
 * An acceptance review's revisions, and the producer orders bound to them
 * (CSET-203 r14).
 *
 * r14: R002 found AC-1 on apply-release-plan and AC-3 on the cli, and its
 * atomic rework ordered both producers from R002's original receipt. The
 * AC-1 gap was challenged and its refinement withdrew it: R002's record moved
 * to R002.refined-1.json. The cli's order of AC-3 — a gap the refinement
 * never touched — stayed bound to the original receipt. Its worker's exact
 * AC-3 reproduction passed, and its challenge was refused twice as
 * REVIEW_CHALLENGE_STALE ("not the receipt this rework was ordered with"): an
 * administrative mismatch charged as two failed attempts, the cli BLOCKED.
 *
 * Here a review is a chain of immutable revisions — revision 0 its original
 * receipt, revision n its n-th refinement's receipt, each pinned by its
 * SHA-256 and linked to the one before — and every producer order of a
 * review is bound to one revision of it. A refinement decides each gap of the
 * revision it refines (retained, withdrawn, refined, upheld) and, in the
 * write that records the new revision, reconciles every order of the review
 * with it (planRevision):
 *
 *  - rebase: every gap the order holds is carried unchanged — the same
 *    criterion, exact reproduction (by SHA-256) and normalized fingerprint,
 *    the node still among its producers — so the order is bound to the new
 *    revision, its generation, attempts and reason untouched, with a rebase
 *    record bound by its own hash;
 *  - amend: its gaps changed (one withdrawn, one refined): the order is
 *    replaced by one of exactly what the revision keeps, never charged;
 *  - cancel: every gap of it withdrawn: the order counts for nothing and the
 *    generation it replaced is restored;
 *  - reorder: the challenger, restored by its challenge, ordered again for
 *    what the revision keeps of its gaps (a retained one included);
 *  - order: a node a refined gap newly falls to;
 *  - keep: an order the node already completed.
 *
 * And why a chain, an order's binding or a rebase record cannot be trusted:
 * a receipt not as STATE.json pins it, a refinement that does not name the
 * revision before it, an order whose gaps are not its bound revision's, a
 * rebase record edited, or naming a revision the chain does not pin, or
 * carrying a reproduction a receipt does not hold.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AcceptanceReviewState, CarryProof, FeatureState_, GraphNode, NodeRuntime, OrderActionKind, PortfolioGraph, RefinementDecisionKind, ReviewRecord, ReviewRevisionRef, ReworkBrief, ReworkHistoryEntry, ReworkOrigin, ReworkRebase } from '../model/types.js';
import { stableStringify } from '../graph/validate.js';
import { gapTargets, type Gap } from './acceptance-review.js';
import { reproductionFingerprint } from './review-lineage.js';

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

// ---- the chain ------------------------------------------------------------------

/** A review's revisions, oldest first: its original receipt (revision 0), then each refinement's. */
export function revisionChain(record: ReviewRecord): ReviewRevisionRef[] {
  const first = record.original ?? null;
  const base: ReviewRevisionRef = first !== null ? { revision: 0, receipt_path: first.receipt_path, receipt_sha256: first.receipt_sha256 } : { revision: 0, receipt_path: record.receipt_path, receipt_sha256: record.receipt_sha256 };
  return [base, ...(record.refinements ?? []).map((r, i) => ({ revision: i + 1, receipt_path: r.receipt_path, receipt_sha256: r.receipt_sha256 }))];
}

/** A review's current revision: its last refinement's, else its original receipt. */
export function currentRevision(record: ReviewRecord): ReviewRevisionRef {
  const chain = revisionChain(record);
  return chain[chain.length - 1] as ReviewRevisionRef;
}

/**
 * The revision of `record` an order is bound to: the one its origin names,
 * else (an order from before revisions, as r14's) the latest whose receipt its
 * evidence names; null when it names none of the review's.
 */
export function boundRevision(record: ReviewRecord, brief: { origin?: ReworkOrigin | undefined; evidence: readonly string[] }): ReviewRevisionRef | null {
  const origin = brief.origin;
  if (origin === undefined || origin.kind !== 'acceptance-review' || origin.review_id !== record.review_id) return null;
  const chain = revisionChain(record);
  if (origin.revision !== undefined) return chain[origin.revision] ?? null;
  return [...chain].reverse().find((r) => brief.evidence.includes(r.receipt_path)) ?? null;
}

/** The revision binding an origin carries: which revision, its receipt, by hash. */
export function boundOrigin(origin: ReworkOrigin, ref: ReviewRevisionRef): ReworkOrigin {
  return { ...structuredClone(origin), revision: ref.revision, receipt_path: ref.receipt_path, receipt_sha256: ref.receipt_sha256 };
}

// ---- a refinement's revision ----------------------------------------------------------

/** What a revision did to one gap of the revision it refines. */
export interface GapDisposition {
  criterion: string;
  reproduction_sha256: string;
  fingerprint: string;
  disposition: 'retained' | 'withdrawn' | 'refined' | 'upheld';
  challenge_id: string | null;
  /** A refined or upheld gap: its new exact reproduction, by SHA-256. */
  to_reproduction_sha256?: string;
}

/** What a revision does to one producer's order of the review. */
export interface OrderAction {
  node_id: string;
  action: OrderActionKind;
  /** The order's criteria before: its live order's, its challenged order's, or the one it completed. */
  criteria_before: string[];
  /** What the node is ordered (or keeps) under the new revision. */
  criteria_after: string[];
  gaps: Gap[];
  /** A rebase: each gap carried unchanged. */
  carry: CarryProof[];
}

/** A producer's orders of the review the revision refines, as STATE.json holds them. */
export interface NodeOrderView {
  node_id: string;
  /** Its live order (not DONE, neither challenged nor superseded): its criteria and their bound reproductions. */
  live: { criteria: string[]; review_gaps: { criterion: string; reproduction_sha256: string }[] } | null;
  /**
   * Its last order of the review was challenged by a challenge this revision decides: that order's criteria. The node
   * restored, or (a per-criterion answer's challenge, CSET-203 r15) DONE on what it completed of them (`completed`).
   */
  challenged: { criteria: string[] } | null;
  /** It completed an order of the review (DONE on it): that order's criteria — or, beside `challenged`, those it proved DONE. */
  completed: { criteria: string[] } | null;
}

const order = (graph: PortfolioGraph): ((a: string, b: string) => number) => {
  const depth = new Map<string, number>();
  const depthOf = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    depth.set(id, 0);
    const n = graph.nodes.find((x) => x.id === id);
    const d = n === undefined || n.depends_on.length === 0 ? 0 : 1 + Math.max(...n.depends_on.map(depthOf));
    depth.set(id, d);
    return d;
  };
  const index = new Map(graph.nodes.map((n, i) => [n.id, i]));
  // Dependents first, as gapTargets orders reworks: each keeps the review's reason as its own brief.
  return (a, b) => depthOf(b) - depthOf(a) || (index.get(a) ?? 0) - (index.get(b) ?? 0);
};

/** Each gap's criterion, reproduction and fingerprint, carried: the producers it maps to before and after. */
function carried(gaps: readonly Gap[], before: { node_id: string; criteria: string[] }[], after: { node_id: string; criteria: string[] }[]): CarryProof[] {
  const of = (targets: { node_id: string; criteria: string[] }[], criterion: string): string[] => targets.filter((t) => t.criteria.includes(criterion)).map((t) => t.node_id);
  return gaps.map((g) => ({ criterion: g.criterion, reproduction_sha256: sha256(g.reproduction), fingerprint: reproductionFingerprint(g.reproduction).sha256, from_targets: of(before, g.criterion), to_targets: of(after, g.criterion) }));
}

/** Whether a live order holds exactly `gaps`: the same criteria, each bound to the same exact reproduction. */
function sameGaps(live: NonNullable<NodeOrderView['live']>, gaps: readonly Gap[]): boolean {
  const want = [...gaps].map((g) => g.criterion).sort();
  const have = [...live.criteria].sort();
  if (want.length !== have.length || want.some((c, i) => c !== have[i])) return false;
  return gaps.every((g) => live.review_gaps.some((b) => b.criterion === g.criterion && b.reproduction_sha256 === sha256(g.reproduction)));
}

/**
 * A refinement's new revision of a review: what it does to each gap of the
 * revision it refines (`parentGaps`) — retained when no decision names its
 * criterion, else withdrawn, refined or upheld — the gaps the review is left
 * with (the retained ones, then the refined and upheld ones, one per
 * criterion), and what it does to each producer's order (the module doc).
 * A refined or upheld gap its criterion's lineage does not accept (a
 * duplicate, an exhausted budget) orders nothing. Pure.
 */
export function planRevision(args: {
  graph: PortfolioGraph;
  parentGaps: readonly Gap[];
  decisions: readonly { challenge_id: string; criterion: string; decision: RefinementDecisionKind }[];
  refined: readonly (Gap & { challenge_id: string })[];
  /** The criteria whose refined (or upheld) gap its lineage accepts. */
  accepted: ReadonlySet<string>;
  /** Whether a retained gap ordered its producers when it was found (a repeat, or one past its budget, ordered nothing): default yes. */
  retainedOrderable?: (gap: Gap) => boolean;
  nodes: readonly NodeOrderView[];
}): { dispositions: GapDisposition[]; gaps: Gap[]; orders: OrderAction[] } {
  const decided = new Map<string, { challenge_id: string; decision: RefinementDecisionKind }>();
  for (const d of args.decisions) if (!decided.has(d.criterion)) decided.set(d.criterion, { challenge_id: d.challenge_id, decision: d.decision });
  const refinedGaps: Gap[] = args.refined.filter((g, i, all) => all.findIndex((x) => x.criterion === g.criterion) === i).map(({ challenge_id: _c, ...g }) => g as Gap);
  const dispositions: GapDisposition[] = args.parentGaps.map((g) => {
    const base = { criterion: g.criterion, reproduction_sha256: sha256(g.reproduction), fingerprint: reproductionFingerprint(g.reproduction).sha256 };
    const d = decided.get(g.criterion);
    if (d === undefined) return { ...base, disposition: 'retained', challenge_id: null };
    if (d.decision === 'WITHDRAW') return { ...base, disposition: 'withdrawn', challenge_id: d.challenge_id };
    const r = refinedGaps.find((x) => x.criterion === g.criterion);
    return { ...base, disposition: d.decision === 'REFINE' ? 'refined' : 'upheld', challenge_id: d.challenge_id, ...(r !== undefined ? { to_reproduction_sha256: sha256(r.reproduction) } : {}) };
  });
  const retained = args.parentGaps.filter((g) => !decided.has(g.criterion));
  const gaps = [...retained, ...refinedGaps];
  const orderable = args.retainedOrderable ?? ((): boolean => true);
  const required = gapTargets(args.graph, [...retained.filter((g) => orderable(g)), ...refinedGaps.filter((g) => args.accepted.has(g.criterion))]).targets;
  const before = gapTargets(args.graph, [...args.parentGaps]).targets;
  const views = new Map(args.nodes.map((v) => [v.node_id, v]));
  const ids = [...new Set([...required.map((t) => t.node_id), ...args.nodes.map((v) => v.node_id)])].sort(order(args.graph));
  const orders: OrderAction[] = [];
  for (const id of ids) {
    const req = required.find((t) => t.node_id === id);
    const reqGaps = req?.gaps ?? [];
    const reqCriteria = req?.criteria ?? [];
    const v = views.get(id) ?? { node_id: id, live: null, challenged: null, completed: null };
    if (v.live !== null) {
      if (reqCriteria.length === 0) orders.push({ node_id: id, action: 'cancel', criteria_before: [...v.live.criteria], criteria_after: [], gaps: [], carry: [] });
      else if (sameGaps(v.live, reqGaps)) orders.push({ node_id: id, action: 'rebase', criteria_before: [...v.live.criteria], criteria_after: [...reqCriteria], gaps: [...reqGaps], carry: carried(reqGaps, before, required) });
      else orders.push({ node_id: id, action: 'amend', criteria_before: [...v.live.criteria], criteria_after: [...reqCriteria], gaps: [...reqGaps], carry: [] });
    } else {
      // A retained gap the node already completed is kept, never ordered again (CSET-203 r15: one answer proved AC-3 and
      // AC-5 and challenged AC-4 alone); a refined one is ordered wherever it falls, and anything else left of the order.
      const completed = new Set(v.completed?.criteria ?? []);
      const refinedHere = (g: Gap): boolean => refinedGaps.some((r) => r.criterion === g.criterion && r.reproduction === g.reproduction);
      const outstanding = reqGaps.filter((g) => !completed.has(g.criterion) || refinedHere(g));
      const named = (gaps: readonly Gap[]): string[] => reqCriteria.filter((c) => gaps.some((g) => g.criterion === c));
      const kept = reqCriteria.filter((c) => completed.has(c));
      if (v.challenged !== null) {
        if (outstanding.length > 0) orders.push({ node_id: id, action: 'reorder', criteria_before: [...v.challenged.criteria], criteria_after: named(outstanding), gaps: outstanding, carry: [] });
        else if (kept.length > 0) orders.push({ node_id: id, action: 'keep', criteria_before: [...v.challenged.criteria], criteria_after: kept, gaps: reqGaps.filter((g) => completed.has(g.criterion)), carry: [] });
      } else if (outstanding.length > 0) orders.push({ node_id: id, action: 'order', criteria_before: [...(v.completed?.criteria ?? [])], criteria_after: named(outstanding), gaps: outstanding, carry: [] });
      else if (v.completed !== null && reqCriteria.length > 0) orders.push({ node_id: id, action: 'keep', criteria_before: [...v.completed.criteria], criteria_after: [...reqCriteria], gaps: [...reqGaps], carry: [] });
    }
  }
  return { dispositions, gaps, orders };
}

/**
 * Whether an order bound to one revision carries to a later one unchanged:
 * each gap it orders there with the same exact reproduction, and the node
 * among that gap's producers in both. The carry proofs, or the criteria that
 * changed (withdrawn, or another reproduction).
 */
export function carryAcross(args: { graph: PortfolioGraph; nodeId: string; reviewGaps: readonly { criterion: string; reproduction_sha256: string }[]; fromGaps: readonly Gap[]; toGaps: readonly Gap[] }): { ok: true; carry: CarryProof[] } | { ok: false; changed: string[] } {
  const before = gapTargets(args.graph, [...args.fromGaps]).targets;
  const after = gapTargets(args.graph, [...args.toGaps]).targets;
  const changed: string[] = [];
  const gaps: Gap[] = [];
  for (const b of args.reviewGaps) {
    const was = args.fromGaps.find((g) => g.criterion === b.criterion);
    const now = args.toGaps.find((g) => g.criterion === b.criterion);
    const mine = (targets: typeof after): boolean => targets.some((t) => t.node_id === args.nodeId && t.criteria.includes(b.criterion));
    if (was === undefined || now === undefined || sha256(was.reproduction) !== b.reproduction_sha256 || sha256(now.reproduction) !== b.reproduction_sha256 || !mine(before) || !mine(after)) {
      changed.push(b.criterion);
      continue;
    }
    gaps.push(now);
  }
  // A gap of the later revision that falls to this node and the order does not hold changes it too.
  const extra = after.filter((t) => t.node_id === args.nodeId).flatMap((t) => t.criteria).filter((c) => !args.reviewGaps.some((b) => b.criterion === c));
  changed.push(...extra);
  if (args.reviewGaps.length === 0 || changed.length > 0) return { ok: false, changed: [...new Set(changed)] };
  return { ok: true, carry: carried(gaps, before, after) };
}

// ---- rebase records -------------------------------------------------------------------

function rebaseBodySha(body: Omit<ReworkRebase, 'sha256'>): string {
  return sha256(stableStringify(body));
}

/** A rebase record, bound by the SHA-256 of everything it says. */
export function rebaseRecord(body: Omit<ReworkRebase, 'sha256'>): ReworkRebase {
  const clean = structuredClone(body);
  return { ...clean, sha256: rebaseBodySha(clean) };
}

/**
 * Why a rebase record cannot be trusted: it does not hash to its recorded
 * SHA-256 (it was edited), it names a revision the review's chain does not
 * pin (or goes backwards), or it carries a gap one of the two revisions does
 * not hold exactly so.
 */
export function rebaseProblems(r: ReworkRebase, chain: readonly ReviewRevisionRef[], gapsOf: (ref: ReviewRevisionRef) => readonly Gap[] | null): string[] {
  const problems: string[] = [];
  const { sha256: recorded, ...body } = r;
  if (rebaseBodySha(body) !== recorded) problems.push(`the rebase of ${r.review_id} from revision ${r.from.revision} to ${r.to.revision} does not hash to its recorded ${String(recorded).slice(0, 12)}: it was changed`);
  for (const ref of [r.from, r.to]) {
    const pinned = chain[ref.revision];
    if (pinned === undefined || pinned.receipt_path !== ref.receipt_path || pinned.receipt_sha256 !== ref.receipt_sha256) {
      problems.push(`the rebase of ${r.review_id} names revision ${ref.revision} at ${String(ref.receipt_sha256).slice(0, 12)}, which ${r.review_id}'s chain does not pin${pinned !== undefined ? ` (revision ${ref.revision} is ${pinned.receipt_sha256.slice(0, 12)})` : ''}`);
    }
  }
  if (r.to.revision <= r.from.revision) problems.push(`the rebase of ${r.review_id} goes from revision ${r.from.revision} to ${r.to.revision}, not to a later one`);
  const criteria = [...r.criteria].sort().join(',');
  if ([...r.carry.map((c) => c.criterion)].sort().join(',') !== criteria) problems.push(`the rebase of ${r.review_id} carries ${r.carry.map((c) => c.criterion).join(', ') || 'nothing'}, not its criteria ${r.criteria.join(', ')}`);
  const from = gapsOf(r.from);
  const to = gapsOf(r.to);
  for (const c of r.carry) {
    const a = from?.find((g) => g.criterion === c.criterion);
    const b = to?.find((g) => g.criterion === c.criterion);
    if (a === undefined || b === undefined || sha256(a.reproduction) !== c.reproduction_sha256 || sha256(b.reproduction) !== c.reproduction_sha256 || reproductionFingerprint(b.reproduction).sha256 !== c.fingerprint) {
      problems.push(`the rebase of ${r.review_id} carries ${c.criterion} at ${String(c.reproduction_sha256).slice(0, 12)}, which revision ${r.from.revision} and revision ${r.to.revision} do not both hold exactly so`);
    }
  }
  return problems;
}

// ---- trust ------------------------------------------------------------------------------

/** A receipt as read: the SHA-256 of its bytes, and its JSON. */
export type ReceiptRead = { sha256: string; json: Record<string, any> } | null;

/** A receipt under the control root, read for its hash and content; null when it is missing or not JSON. */
export function readReceiptFile(controlRoot: string, rel: string): ReceiptRead {
  const file = join(controlRoot, ...rel.split('/'));
  if (!existsSync(file)) return null;
  try {
    const bytes = readFileSync(file);
    return { sha256: sha256(bytes), json: JSON.parse(bytes.toString('utf8')) as Record<string, any> };
  } catch {
    return null;
  }
}

/** A revision's gaps as its receipt holds them, null when it cannot be read. */
export function revisionGaps(read: (rel: string) => ReceiptRead, ref: ReviewRevisionRef): Gap[] | null {
  const r = read(ref.receipt_path);
  if (r === null || r.sha256 !== ref.receipt_sha256) return null;
  return ((r.json['gaps'] ?? []) as Gap[]).filter((g) => g !== null && typeof g === 'object' && typeof g.criterion === 'string' && typeof g.reproduction === 'string');
}

/**
 * Why a review's revision chain cannot be trusted: a revision's receipt
 * missing or not as STATE.json pins it, a refinement's receipt that says it is
 * another revision, names another parent, or refines another receipt than
 * the revision before it, or a record whose revision is not its chain's last.
 */
export function revisionChainProblems(record: ReviewRecord, read: (rel: string) => ReceiptRead): string[] {
  const chain = revisionChain(record);
  const problems: string[] = [];
  for (const ref of chain) {
    const r = read(ref.receipt_path);
    if (r === null) {
      problems.push(`${ref.receipt_path} (revision ${ref.revision} of ${record.review_id}) is missing or not JSON`);
      continue;
    }
    if (r.sha256 !== ref.receipt_sha256) problems.push(`${ref.receipt_path} (revision ${ref.revision} of ${record.review_id}) hashes to ${r.sha256.slice(0, 12)}, not ${ref.receipt_sha256.slice(0, 12)} as STATE.json pins`);
    if (ref.revision === 0) continue;
    const prev = chain[ref.revision - 1] as ReviewRevisionRef;
    const j = r.json;
    if (j['revision'] !== undefined && j['revision'] !== ref.revision) problems.push(`${ref.receipt_path} says it is revision ${String(j['revision'])} of ${record.review_id}, not ${ref.revision}`);
    const parent = j['parent'] as { revision?: unknown; receipt_path?: unknown; receipt_sha256?: unknown } | undefined;
    if (parent !== undefined && (parent?.revision !== prev.revision || parent?.receipt_path !== prev.receipt_path || parent?.receipt_sha256 !== prev.receipt_sha256)) {
      problems.push(`${ref.receipt_path} names parent ${String(parent?.receipt_path)} at ${String(parent?.receipt_sha256).slice(0, 12)}, not revision ${prev.revision} of ${record.review_id} (${prev.receipt_path} at ${prev.receipt_sha256.slice(0, 12)})`);
    }
    const of = (j['refinement'] as { of?: { receipt_sha256?: unknown } } | undefined)?.of;
    if (of !== undefined && of.receipt_sha256 !== prev.receipt_sha256) problems.push(`${ref.receipt_path} refines ${String(of.receipt_sha256).slice(0, 12)}, not revision ${prev.revision} of ${record.review_id} (${prev.receipt_sha256.slice(0, 12)})`);
  }
  if (record.revision !== undefined && record.revision !== chain.length - 1) problems.push(`${record.review_id} records revision ${record.revision}, but its chain ends at revision ${chain.length - 1}`);
  return problems;
}

/**
 * Why an order's binding to its review cannot be trusted: it names no
 * revision of the review, names one at another receipt than the chain pins,
 * does not name that receipt as its evidence, or orders a gap the bound
 * revision does not hold with exactly that reproduction.
 */
export function orderBindingProblems(record: ReviewRecord, brief: Pick<ReworkBrief, 'origin' | 'evidence' | 'acceptance_criteria' | 'review_gaps'>, read: (rel: string) => ReceiptRead): string[] {
  const o = brief.origin;
  const bound = boundRevision(record, brief);
  if (bound === null) return [`the order names no revision of ${record.review_id} (${o?.revision !== undefined ? `revision ${o.revision}` : `evidence ${brief.evidence.join(', ') || 'none'}`})`];
  const problems: string[] = [];
  if (o?.receipt_sha256 !== undefined && (o.receipt_sha256 !== bound.receipt_sha256 || (o.receipt_path !== undefined && o.receipt_path !== bound.receipt_path))) {
    problems.push(`the order is bound to revision ${bound.revision} of ${record.review_id} at ${o.receipt_sha256.slice(0, 12)}, but revision ${bound.revision} is pinned at ${bound.receipt_sha256.slice(0, 12)}`);
  }
  if (!brief.evidence.includes(bound.receipt_path)) problems.push(`the order does not name revision ${bound.revision}'s receipt ${bound.receipt_path} as its evidence`);
  const r = read(bound.receipt_path);
  const gaps = (r?.json['gaps'] ?? []) as Gap[];
  for (const g of brief.review_gaps ?? []) {
    const found = gaps.find((x) => x.criterion === g.criterion);
    if (found === undefined || typeof found.reproduction !== 'string' || sha256(found.reproduction) !== g.reproduction_sha256) problems.push(`the order holds ${g.criterion} at ${g.reproduction_sha256.slice(0, 12)}, which revision ${bound.revision} of ${record.review_id} does not hold`);
    if (!brief.acceptance_criteria.includes(g.criterion)) problems.push(`the order binds ${g.criterion}, which it does not name`);
  }
  return problems;
}

/** The last rework history entry of a node and the order it holds, when it is in an acceptance review's rework. */
function reviewOrderOf(rt: NodeRuntime): { brief: ReworkBrief; entry: ReworkHistoryEntry | undefined } | null {
  const brief = rt.rework_brief ?? null;
  if (brief === null || brief.origin?.kind !== 'acceptance-review') return null;
  const history = rt.rework_history ?? [];
  return { brief, entry: history[history.length - 1] };
}

/**
 * Why the revision lineage of a feature's reviews cannot be trusted (it was
 * changed outside Mycelink): every review's chain, and every rebase record —
 * a live order's and its history entry's — against the chain of its review
 * and the receipts it carries between.
 */
export function revisionTrustProblems(review: Pick<AcceptanceReviewState, 'reviews'>, nodes: FeatureState_['nodes'], read: (rel: string) => ReceiptRead): string[] {
  const problems: string[] = [];
  const records = new Map<string, ReviewRecord>();
  for (const rec of review.reviews) records.set(rec.review_id, rec);
  for (const rec of records.values()) problems.push(...revisionChainProblems(rec, read).map((p) => `revision: ${p}`));
  for (const [id, rt] of Object.entries(nodes)) {
    const seen = new Set<string>();
    for (const r of [...(rt.rework_brief?.rebases ?? []), ...(rt.rework_history ?? []).flatMap((e) => e.rebases ?? [])]) {
      if (seen.has(r.sha256)) continue;
      seen.add(r.sha256);
      const rec = records.get(r.review_id);
      if (rec === undefined) {
        problems.push(`rebase: ${id}'s rebase names ${r.review_id}, which is not a settled review`);
        continue;
      }
      const chain = revisionChain(rec);
      problems.push(...rebaseProblems(r, chain, (ref) => revisionGaps(read, ref)).map((p) => `rebase: ${id}: ${p}`));
    }
  }
  return problems;
}

/**
 * Why a node's live review order cannot be trusted as it stands: its binding
 * (orderBindingProblems), or rebase records that are not its history
 * entry's. A binding to an older revision is not one of these: it is
 * reconciled (rebased, or the order replaced), never trusted as it is.
 */
export function nodeOrderProblems(review: Pick<AcceptanceReviewState, 'reviews'>, nodeId: string, rt: NodeRuntime, read: (rel: string) => ReceiptRead): string[] {
  const held = reviewOrderOf(rt);
  if (held === null) return [];
  const rec = [...review.reviews].reverse().find((r) => r.review_id === held.brief.origin?.review_id);
  if (rec === undefined) return [`${nodeId}'s order names ${held.brief.origin?.review_id}, which is not a settled review`];
  const problems = orderBindingProblems(rec, held.brief, read).map((p) => `${nodeId}: ${p}`);
  if (stableStringify(held.brief.rebases ?? []) !== stableStringify(held.entry?.rebases ?? [])) problems.push(`${nodeId}: the order's rebase records are not its rework history entry's`);
  return problems;
}

/** Every review-revision problem of a feature, as feature verify names them: REVIEW_REVISION_INVALID. */
export function reviewRevisionProblems(controlRoot: string, state: FeatureState_): string[] {
  const review = state.acceptance_review ?? null;
  if (review === null) return [];
  const read = (rel: string): ReceiptRead => readReceiptFile(controlRoot, rel);
  return [
    ...revisionTrustProblems(review, state.nodes, read),
    ...Object.entries(state.nodes).flatMap(([id, rt]) => nodeOrderProblems(review, id, rt, read)),
  ].map((p) => `REVIEW_REVISION_INVALID: ${p}`);
}

/**
 * Each product producer's orders of review `reviewId`, from STATE.json, for
 * the revision that refines `parentGaps`: its live order; its last order,
 * challenged by one of the challenges the revision decides (`challengedNow`);
 * or the order of the review it completed. A challenged or completed order
 * held exactly the parent revision's gaps that fall to the node.
 */
export function orderViews(graph: PortfolioGraph, state: FeatureState_, reviewId: string, challengedNow: ReadonlySet<string>, parentGaps: readonly Gap[]): NodeOrderView[] {
  const parent = gapTargets(graph, [...parentGaps]).targets;
  const views: NodeOrderView[] = [];
  for (const n of graph.nodes.filter((x: GraphNode) => x.repository !== null)) {
    const rt = state.nodes[n.id];
    if (rt === undefined) continue;
    const history = rt.rework_history ?? [];
    const last = [...history].reverse().find((e) => (e.superseded ?? null) === null);
    const mine = last !== undefined && (state.reworks ?? []).some((r) => r.node_id === n.id && r.at === last.at && r.origin?.kind === 'acceptance-review' && r.origin.review_id === reviewId);
    const brief = rt.rework_brief ?? null;
    const live = brief !== null && brief.origin?.kind === 'acceptance-review' && brief.origin.review_id === reviewId && rt.state !== 'DONE' && rt.state !== 'EXCLUDED';
    const challenged = !live && mine && (last?.challenged ?? null) !== null && challengedNow.has((last?.challenged as { challenge_id: string }).challenge_id);
    // A per-criterion answer's challenge (CSET-203 r15): the node is DONE on the criteria it proved; the rest of its order is decided now.
    const partial = last?.partial ?? null;
    const partly = !live && !challenged && mine && rt.state === 'DONE' && partial !== null && partial.challenge_id !== null && challengedNow.has(partial.challenge_id);
    const completed = !live && !challenged && !partly && mine && rt.state === 'DONE' && (last?.challenged ?? null) === null;
    const criteria = parent.find((t) => t.node_id === n.id)?.criteria ?? [];
    views.push({
      node_id: n.id,
      live: live ? { criteria: [...(brief as ReworkBrief).acceptance_criteria], review_gaps: [...((brief as ReworkBrief).review_gaps ?? [])] } : null,
      challenged: challenged || partly ? { criteria: [...criteria] } : null,
      completed: partly ? { criteria: criteria.filter((c) => (partial?.done ?? []).includes(c)) } : completed ? { criteria: [...criteria] } : null,
    });
  }
  return views;
}
