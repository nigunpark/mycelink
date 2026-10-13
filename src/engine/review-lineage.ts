/**
 * The acceptance review's per-criterion gap lineage (CSET-203 r11).
 *
 * r11 with-normal ran continuously and trusted. R001's AC-1 gap was
 * challenged and withdrawn while the cli was reworked for AC-5; R002 gave
 * AC-1 another reproduction, challenged and withdrawn too, while the cli was
 * reworked for AC-3; R003 then found materially new, concrete AC-1 and AC-3
 * gaps — the boundaries hidden acceptance checks — and the one global
 * `max_rounds: 2` blocked it REVIEW_GAPS before any rework. Withdrawn
 * hypotheses and unrelated criteria had spent the count it needed.
 *
 * Here each criterion has a budget of its own. A gap spends it only when its
 * reproduction is materially new (a normalized fingerprint, never the
 * wording: repeatsPrior) and a producer is actually reworked for it; a
 * challenged rework is restored and spends nothing, whatever the refinement
 * decides. Repeats are rejected without a rework. Past its budget a
 * materially new gap is `exhausted`: the feature is blocked once every other
 * allowable gap has been reworked and settled. Two global ceilings bound the
 * rest: review sessions since the last accepted delivery, and consecutive
 * reviews that made no progress (no producer change, no new criterion proof,
 * no accepted new gap, no valid challenge) — past either, REVIEW_NONCONVERGENT.
 *
 * Everything is one append-only chain of events in STATE.json, each bound by
 * its hash to the one before; every receipt pins the chain head its settle
 * left. Budgets are never stored: they are summarized from the events
 * (summarizeLineage), so a crash, a repeated settle or a stale generation
 * cannot count anything twice, and a reset is a broken chain.
 *
 * CSET-201 final (normal arm, trusted): R003 found a materially new AC-2 gap
 * — one changeset reason per changeset, `none` included — after both earlier
 * AC-2 reworks had settled with a RED and a production change, with no
 * no-progress streak and three of eight review sessions spent. It was
 * exhausted solely because the per-criterion count was 2, and a person was
 * asked to decide: an arbitrary logical cap stopping valid implementation.
 * The count is a budget, never a cap: within it a materially new gap is
 * reworked on its newness (basis `budget`); past it, only on verified producer
 * progress — the producers reworked for the criterion's last accepted gap
 * settled it with a RED, a production change or a new proof, in the heads
 * reviewed now (basis `progress`, its completion records named). What stops a
 * criterion is a duplicate or a no-progress loop, a proof lost and restored
 * again and again (oscillation), the review-session or configured wall-clock
 * budget, a trust failure — or the configurable emergency ceiling, where a
 * person decides (default DEFAULT_CRITERION_CEILING, never silently 2). A
 * repeat of a gap whose fix's proof vanished from the reviewed head is a
 * `regression`: restored, never ignored as a duplicate, spending nothing.
 */
import { createHash } from 'node:crypto';
import { stableStringify } from '../graph/validate.js';
import type { GapBasis, LineageEvent, LineageEventBody, LineageGapVerdict, RefinementDecisionKind, ReviewChallengeRecord, ReviewLineage, ReviewRecord } from '../model/types.js';

export const REVIEW_LINEAGE_SCHEMA = 'mycelink-review-lineage/1';
/** Review sessions (reviews, not their refinements or corrections) since the last accepted delivery, at most (the default budget). */
export const MAX_REVIEW_SESSIONS = 8;
/** Consecutive reviews that made no progress before the review is nonconvergent. */
export const MAX_NO_PROGRESS_REVIEWS = 4;
/**
 * The emergency ceiling of accepted reworks per criterion since the last accepted delivery, unless the policy says
 * otherwise: past its budget (`max_criterion_reworks`) each one needs verified producer progress, and here a person decides.
 */
export const DEFAULT_CRITERION_CEILING = 6;
/** Restorations of a criterion's lost proof since the last accepted delivery before its loss is an oscillation without recovery. */
export const MAX_REGRESSIONS = 2;
/** A reproduction with fewer new normalized terms than this, against an earlier one of its criterion, repeats it. */
export const NOVEL_TERMS = 3;
/** ... and one whose terms overlap an earlier one's this much (Jaccard) repeats it however many it adds. */
export const NEAR_DUPLICATE_JACCARD = 0.7;
const MAX_TERMS = 128;

const sha256 = (data: string): string => createHash('sha256').update(data).digest('hex');

// ---- the fingerprint ------------------------------------------------------------

/** Words that say how to test, not what: they never make a reproduction new. */
const STOPWORDS = new Set(
  (
    'the and with that this then also from into when its for are was were has have had but any all each again same just than them they their there these those what which while will would should could ' +
    'assert asserts asserted assertion expect expects expected verify verifies check checks ensure ensures confirm confirms test tests testing reproduce reproduction run runs running ' +
    'example such like use using make makes made inject injects injected simulate simulates simulated force forces cause caused one two before after only exactly every some does not none ' +
    'its it is be been being an a of to in on at by or as if so do where without start starts once given whose please carefully must'
  ).split(/\s+/),
);
const SUFFIXES = ['ations', 'ation', 'ings', 'ing', 'ions', 'ion', 'ers', 'er', 'ies', 'ied', 'es', 'ed', 'ly', 's', 'e'];
/** Stems that name the same thing. */
const FOLD = new Map([
  ['failur', 'fail'],
  ['fault', 'fail'],
  ['crash', 'fail'],
  ['throw', 'fail'],
  ['thrown', 'fail'],
  ['threw', 'fail'],
  ['error', 'fail'],
  ['written', 'writ'],
  ['wrot', 'writ'],
  ['gon', 'absent'],
  ['miss', 'absent'],
  ['delet', 'remov'],
  ['removal', 'remov'],
  ['match', 'equal'],
  ['ident', 'equal'],
]);

function stem(word: string): string {
  let w = word;
  for (const s of SUFFIXES) {
    if (w.endsWith(s) && w.length - s.length >= 3) {
      w = w.slice(0, -s.length);
      break;
    }
  }
  return FOLD.get(w) ?? w;
}

/**
 * A reproduction's normalized terms: identifiers split, case and punctuation
 * set aside, how-to words dropped, the rest stemmed and folded, each once,
 * sorted. Rewording, reordering or padding a reproduction keeps them.
 */
export function reproductionTerms(text: string): string[] {
  const words = text
    .normalize('NFKC')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ');
  const terms = new Set(words.filter((w) => w.length >= 3 && !STOPWORDS.has(w)).map(stem).filter((w) => w.length >= 3 && !STOPWORDS.has(w)).map((w) => w.slice(0, 64)));
  return [...terms].sort().slice(0, MAX_TERMS);
}

/** The fingerprint a reproduction is recorded under: the SHA-256 of its normalized terms, and the terms. */
export function reproductionFingerprint(text: string): { sha256: string; terms: string[] } {
  const terms = reproductionTerms(text);
  return { sha256: sha256(terms.join(' ')), terms };
}

/**
 * Whether a reproduction (its terms) repeats an earlier one: fewer than
 * NOVEL_TERMS terms the earlier one lacks, or an overlap of at least
 * NEAR_DUPLICATE_JACCARD. Another state, failure, order or boundary brings
 * its own terms; a paraphrase does not.
 */
export function repeats(terms: readonly string[], earlier: readonly string[]): boolean {
  const mine = new Set(terms);
  if (mine.size === 0) return true;
  const theirs = new Set(earlier);
  const novel = [...mine].filter((t) => !theirs.has(t)).length;
  const union = new Set([...mine, ...theirs]).size;
  return novel < NOVEL_TERMS || (mine.size - novel) / union >= NEAR_DUPLICATE_JACCARD;
}

// ---- the chain ------------------------------------------------------------------

/** The safety a lineage is created with (engine/acceptance-review.ts reviewPolicyOf): the policy's, fixed at feature init. */
export interface LineageSafety {
  criterionCeiling?: number;
  maxReviewSessions?: number;
  maxReviewMs?: number | null;
}

export function emptyLineage(maxCriterionReworks: number, safety: LineageSafety = {}): ReviewLineage {
  return {
    schema: REVIEW_LINEAGE_SCHEMA,
    max_criterion_reworks: maxCriterionReworks,
    max_review_sessions: safety.maxReviewSessions ?? MAX_REVIEW_SESSIONS,
    max_no_progress: MAX_NO_PROGRESS_REVIEWS,
    ...(safety.criterionCeiling !== undefined ? { criterion_ceiling: safety.criterionCeiling } : {}),
    ...(safety.maxReviewMs !== undefined && safety.maxReviewMs !== null ? { max_review_ms: safety.maxReviewMs } : {}),
    events: [],
    head_sha256: null,
  };
}

/** A lineage's emergency ceiling per criterion: what it recorded, else the default — never below its budget. */
export function ceilingOf(lineage: Pick<ReviewLineage, 'max_criterion_reworks' | 'criterion_ceiling'>): number {
  return Math.max(lineage.max_criterion_reworks, lineage.criterion_ceiling ?? DEFAULT_CRITERION_CEILING);
}

/** What makes an event the same fact: appended once, however often its settle runs. */
function identity(e: LineageEventBody): string {
  switch (e.kind) {
    case 'gap':
      return `gap|${e.review_id}|${e.criterion}|${e.reproduction_sha256}|${e.challenge_id ?? ''}`;
    case 'challenge':
      return `challenge|${e.challenge_id}|${e.criterion}`;
    case 'decision':
      return `decision|${e.challenge_id}|${e.criterion}`;
    case 'review':
      return `review|${e.review_id}`;
    case 'closure':
      return `closure|${e.review_id}|${e.criterion}`;
    case 'blocked':
      return `blocked|${e.review_id}|${e.code}|${[...e.criteria].sort().join(',')}`;
    case 'grant':
      return `grant|${e.decision_id}|${e.criterion}`;
    case 'regression':
      return `regression|${e.criterion}|${e.record_id}`;
    case 'migrated':
      return 'migrated';
  }
}

function eventSha(e: Omit<LineageEvent, 'sha256'>): string {
  return sha256(stableStringify(e));
}

/**
 * The lineage with `bodies` appended at `at`, each bound to the one before by
 * its hash; a fact the lineage already holds is not appended again. Pure:
 * the caller writes the result in the same STATE.json write as what it records.
 */
export function appendLineage(lineage: ReviewLineage, bodies: readonly LineageEventBody[], at: string): { lineage: ReviewLineage; appended: LineageEvent[] } {
  const known = new Set(lineage.events.map(identity));
  const events = [...lineage.events];
  const appended: LineageEvent[] = [];
  for (const body of bodies) {
    const id = identity(body);
    if (known.has(id)) continue;
    known.add(id);
    const prev = events.length === 0 ? null : (events[events.length - 1] as LineageEvent).sha256;
    const unsigned = { ...structuredClone(body), seq: events.length + 1, at, prev_sha256: prev } as Omit<LineageEvent, 'sha256'>;
    const event = { ...unsigned, sha256: eventSha(unsigned) } as LineageEvent;
    events.push(event);
    appended.push(event);
  }
  return { lineage: { ...lineage, events, head_sha256: events.length === 0 ? null : (events[events.length - 1] as LineageEvent).sha256 }, appended };
}

/** Why a lineage is not the chain it says it is: a changed, dropped, reordered or repeated event, or a head that is not its last. */
export function chainProblems(lineage: ReviewLineage): string[] {
  const problems: string[] = [];
  if (lineage.schema !== REVIEW_LINEAGE_SCHEMA) problems.push(`the lineage schema is ${String(lineage.schema)}, not ${REVIEW_LINEAGE_SCHEMA}`);
  const seen = new Set<string>();
  let prev: string | null = null;
  for (const [i, e] of lineage.events.entries()) {
    if (e.seq !== i + 1) problems.push(`event ${i + 1} has seq ${e.seq}: an event was dropped or reordered`);
    if (e.prev_sha256 !== prev) problems.push(`event ${e.seq} binds prev ${String(e.prev_sha256).slice(0, 12)}, not ${String(prev).slice(0, 12)}: an event was dropped or reordered`);
    const { sha256: recorded, ...unsigned } = e;
    if (eventSha(unsigned) !== recorded) problems.push(`event ${e.seq} (${e.kind}) does not hash to ${String(recorded).slice(0, 12)}: it was changed`);
    const id = identity(e);
    if (seen.has(id)) problems.push(`event ${e.seq} repeats ${id}`);
    seen.add(id);
    prev = recorded;
  }
  if (lineage.head_sha256 !== prev) problems.push(`the lineage head ${String(lineage.head_sha256).slice(0, 12)} is not its last event's hash ${String(prev).slice(0, 12)}`);
  return problems;
}

// ---- the summary ----------------------------------------------------------------

export type ReproductionStatus = LineageGapVerdict | 'challenged' | 'withdrawn' | 'refined' | 'upheld';

export interface LineageReproduction {
  review_id: string;
  sha256: string;
  fingerprint: string;
  terms: string[];
  status: ReproductionStatus;
  nodes: string[];
  /** The challenge of it, or the challenge a refined gap answers. */
  challenge_id: string | null;
  /** A repeat: the reproduction it repeats. */
  duplicate_of: string | null;
  /** The uncovered boundaries its verdict named, each by its normalized terms (none recorded before CSET-201 final). */
  boundaries: string[][] | null;
  seq: number;
}

export interface CriterionLineage {
  criterion: string;
  /**
   * The budget: accepted producer reworks a materially new gap gets on its newness alone (the policy's max_rounds),
   * plus each grant a person decided past a block. Past it, each one needs verified producer progress (CSET-201 final).
   */
  max: number;
  accepted_reworks: number;
  /** Of the budget. */
  remaining: number;
  /** The emergency ceiling: past it a person decides, however much progress was made (plus each grant). */
  ceiling: number;
  ceiling_remaining: number;
  challenges: number;
  withdrawals: number;
  /** Repeats rejected without a rework. */
  duplicates: number;
  /** Completed proofs of the criterion lost from a reviewed head and ordered restored (each lost record once). */
  regressions: number;
  /** A materially new gap the review did not rework automatically (no progress, or the ceiling), not yet blocked or granted. */
  exhausted: boolean;
  /** The PASS that last closed it, when no gap came after. */
  closed: { review_id: string; inputs_sha256: string } | null;
  reproductions: LineageReproduction[];
  decisions: { review_id: string; challenge_id: string; decision: RefinementDecisionKind }[];
  next_action: string;
}

export interface LineageReview {
  review_id: string;
  outcome: string;
  heads: string[];
  passed: string[];
  gaps: string[];
  /** Its own progress, a valid challenge of it, a gap its refinement had reworked. */
  progress: string[];
  seq: number;
}

export interface LineageSummary {
  max_criterion_reworks: number;
  criterion_ceiling: number;
  criteria: Record<string, CriterionLineage>;
  reviews: LineageReview[];
  review_sessions: number;
  max_review_sessions: number;
  no_progress_streak: number;
  max_no_progress: number;
  /** The configured review wall-clock budget, measured from the first review counted (null: none configured). */
  max_review_ms: number | null;
  first_review_at: string | null;
  pending_exhausted: { criterion: string; review_id: string; reproduction_sha256: string }[];
  head_sha256: string | null;
}

/**
 * Each criterion's budget and history, and the reviews' progress, from the
 * events since the last accepted delivery (`since`; null: all of them).
 * Nothing here is stored: the events are the only record.
 */
export function summarizeLineage(lineage: ReviewLineage, criteria: readonly string[], since: string | null): LineageSummary {
  const events = lineage.events.filter((e) => since === null || e.at > since);
  const per = new Map<string, { reps: LineageReproduction[]; decisions: CriterionLineage['decisions']; grants: number; lastBlocked: number; lastGrant: number; closure: { review_id: string; inputs_sha256: string; seq: number } | null; lastGap: number; challenges: number; withdrawals: number; regressions: number }>();
  const of = (criterion: string) => {
    let c = per.get(criterion);
    if (c === undefined) {
      c = { reps: [], decisions: [], grants: 0, lastBlocked: 0, lastGrant: 0, closure: null, lastGap: 0, challenges: 0, withdrawals: 0, regressions: 0 };
      per.set(criterion, c);
    }
    return c;
  };
  for (const id of criteria) of(id);
  const reviews: LineageReview[] = [];
  let lastGrant = 0;
  const challenged = new Set<string>();
  const reworkedLater = new Set<string>();
  for (const e of events) {
    switch (e.kind) {
      case 'gap': {
        const c = of(e.criterion);
        c.reps.push({ review_id: e.review_id, sha256: e.reproduction_sha256, fingerprint: e.fingerprint, terms: [...e.terms], status: e.verdict, nodes: [...e.nodes], challenge_id: e.challenge_id, duplicate_of: e.duplicate_of, boundaries: e.boundaries === undefined ? null : e.boundaries.map((b) => [...b]), seq: e.seq });
        c.lastGap = e.seq;
        if (e.verdict === 'accepted' && e.challenge_id !== null) reworkedLater.add(e.review_id);
        break;
      }
      case 'challenge': {
        const c = of(e.criterion);
        c.challenges++;
        challenged.add(e.review_id);
        const rep = [...c.reps].reverse().find((r) => r.status === 'accepted' && r.sha256 === e.reproduction_sha256 && r.review_id === e.review_id) ?? [...c.reps].reverse().find((r) => r.status === 'accepted' && r.sha256 === e.reproduction_sha256);
        if (rep !== undefined) {
          rep.status = 'challenged';
          rep.challenge_id = e.challenge_id;
        }
        break;
      }
      case 'decision': {
        const c = of(e.criterion);
        c.decisions.push({ review_id: e.review_id, challenge_id: e.challenge_id, decision: e.decision });
        if (e.decision === 'WITHDRAW') c.withdrawals++;
        const rep = c.reps.find((r) => r.status === 'challenged' && r.challenge_id === e.challenge_id);
        if (rep !== undefined) rep.status = e.decision === 'WITHDRAW' ? 'withdrawn' : e.decision === 'REFINE' ? 'refined' : 'upheld';
        break;
      }
      case 'review':
        reviews.push({ review_id: e.review_id, outcome: e.outcome, heads: [...e.heads], passed: [...e.passed], gaps: [...e.gaps], progress: [...e.progress], seq: e.seq });
        break;
      case 'closure':
        of(e.criterion).closure = { review_id: e.review_id, inputs_sha256: e.inputs_sha256, seq: e.seq };
        break;
      case 'blocked':
        for (const id of e.criteria) of(id).lastBlocked = e.seq;
        break;
      case 'grant': {
        // A person's decision: the ceilings count afresh from it; a criterion it names gets one more accepted rework.
        lastGrant = e.seq;
        if (e.criterion === '*') break;
        const c = of(e.criterion);
        c.grants++;
        c.lastGrant = e.seq;
        break;
      }
      case 'regression':
        // A completed proof lost from a reviewed head, ordered restored: never an accepted rework, counted for oscillation.
        of(e.criterion).regressions++;
        break;
      case 'migrated':
        break;
    }
  }
  for (const r of reviews) {
    if (challenged.has(r.review_id) && !r.progress.includes('challenge')) r.progress.push('challenge');
    if (reworkedLater.has(r.review_id) && !r.progress.includes('accepted-gap')) r.progress.push('accepted-gap');
  }
  // The ceilings count the reviews since a person last decided past a block.
  const counted = reviews.filter((r) => r.seq > lastGrant);
  let streak = 0;
  for (let i = counted.length - 1; i >= 0 && (counted[i] as LineageReview).progress.length === 0; i--) streak++;
  const pending: LineageSummary['pending_exhausted'] = [];
  const out: Record<string, CriterionLineage> = {};
  const baseCeiling = ceilingOf(lineage);
  for (const [criterion, c] of [...per.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const max = lineage.max_criterion_reworks + c.grants;
    const ceiling = Math.max(max, baseCeiling + c.grants);
    const accepted = c.reps.filter((r) => r.status === 'accepted').length;
    const open = c.reps.filter((r) => r.status === 'exhausted' && r.seq > c.lastBlocked && r.seq > c.lastGrant);
    for (const r of open) pending.push({ criterion, review_id: r.review_id, reproduction_sha256: r.sha256 });
    const remaining = Math.max(0, max - accepted);
    const ceilingRemaining = Math.max(0, ceiling - accepted);
    const closed = c.closure !== null && c.closure.seq > c.lastGap ? { review_id: c.closure.review_id, inputs_sha256: c.closure.inputs_sha256 } : null;
    out[criterion] = {
      criterion,
      max,
      accepted_reworks: accepted,
      remaining,
      ceiling,
      ceiling_remaining: ceilingRemaining,
      challenges: c.challenges,
      withdrawals: c.withdrawals,
      duplicates: c.reps.filter((r) => r.status === 'duplicate').length,
      regressions: c.regressions,
      exhausted: open.length > 0,
      closed,
      reproductions: c.reps,
      decisions: c.decisions,
      next_action:
        open.length > 0
          ? `decision: a materially new gap of ${criterion} is open that the review did not rework on its own (${accepted} accepted rework(s); ceiling ${ceiling}); a person decides (node rework --decision grants one more)`
          : closed !== null
            ? `closed by ${closed.review_id}'s PASS`
            : ceilingRemaining === 0
              ? `review: at its ceiling of ${ceiling} accepted rework(s); a materially new gap of ${criterion} asks a person`
              : remaining === 0
                ? `review: past its budget of ${max}, a materially new gap of ${criterion} is reworked on verified producer progress (${ceilingRemaining} of its ceiling of ${ceiling} left)`
                : `review: ${remaining} accepted rework(s) of ${max} left, then on verified producer progress up to ${ceiling}`,
    };
  }
  return {
    max_criterion_reworks: lineage.max_criterion_reworks,
    criterion_ceiling: baseCeiling,
    criteria: out,
    reviews,
    review_sessions: counted.length,
    max_review_sessions: lineage.max_review_sessions,
    no_progress_streak: streak,
    max_no_progress: lineage.max_no_progress,
    max_review_ms: lineage.max_review_ms ?? null,
    first_review_at: (events.find((e) => e.kind === 'review' && e.seq > lastGrant) as LineageEvent | undefined)?.at ?? null,
    pending_exhausted: pending,
    head_sha256: lineage.head_sha256,
  };
}

// ---- judging a review's gaps --------------------------------------------------------

/**
 * What the producers did for a criterion's last accepted gap, as the controller verified it from the completion ledger
 * (engine/orchestrator.ts): every producer reworked for it settled the criterion with a RED, a production change or a
 * new proof, that work in the heads reviewed now.
 */
export interface ProgressFact {
  verified: boolean;
  basis: 'producer-change' | 'new-proof' | 'none';
  /** The completion records that show it. */
  records: string[];
  detail: string;
}

/** A criterion's completed proofs the reviewed heads no longer hold (engine/criterion-coverage.ts). */
export interface RegressionFact {
  lost: { node_id: string; record_id: string; code: string; detail: string }[];
}

export interface GapFacts {
  progress?: Record<string, ProgressFact>;
  regressions?: Record<string, RegressionFact>;
}

export interface GapLineageJudgement {
  criterion: string;
  reproduction_sha256: string;
  fingerprint: string;
  terms: string[];
  /**
   * accepted: materially new, within its criterion's budget or past it on verified progress (spent only once a producer
   * is reworked for it); exhausted: materially new, but neither (a person decides); regression: its proof was lost.
   */
  verdict: 'accepted' | 'duplicate' | 'exhausted' | 'regression';
  duplicate_of: string | null;
  /** Why it was (or was not) reworked; null for a duplicate. */
  basis: GapBasis | null;
  /** basis `progress`: the completion records the progress stands on. */
  progress: string[];
  /** What makes a non-duplicate materially new: its reproduction, or an uncovered boundary no earlier gap named. */
  novelty: 'reproduction' | 'boundary' | null;
  /** The uncovered boundaries its verdict named, each by its normalized terms, as its event records them. */
  boundaries: string[][];
  /** verdict `regression`: the completed proofs lost. */
  lost?: RegressionFact['lost'];
}

/** Boundaries a gap event records, and terms each: bounded. */
const MAX_BOUNDARIES = 8;
const MAX_BOUNDARY_TERMS = 32;

function boundaryTerms(texts: readonly string[] | undefined): string[][] {
  return (texts ?? []).map((t) => reproductionTerms(t).slice(0, MAX_BOUNDARY_TERMS)).filter((t) => t.length > 0).slice(0, MAX_BOUNDARIES);
}

/**
 * Whether a gap that repeats an earlier reproduction still names an uncovered boundary none of the earlier gaps of its
 * criterion named. Only an earlier gap that recorded its boundaries can tell (a lineage from before them cannot).
 */
function newBoundary(mine: readonly string[][], priors: readonly LineageReproduction[]): boolean {
  const recorded = priors.filter((r) => r.boundaries !== null);
  if (mine.length === 0 || recorded.length === 0) return false;
  const earlier = recorded.flatMap((r) => r.boundaries ?? []);
  return mine.some((b) => !earlier.some((e) => repeats(b, e)));
}

/**
 * Each gap against its own criterion's lineage. A gap of a criterion whose completed proof the reviewed heads lost is a
 * regression, whatever it repeats: the fix is restored, never ignored, and nothing is spent. Otherwise a repeat of any
 * reproduction of that criterion so far (withdrawn, accepted, challenged, rejected), by hash, fingerprint or near terms,
 * is a duplicate. A materially new one is accepted within the criterion's budget; past it, only on verified producer
 * progress (`facts.progress`); at the criterion's ceiling, or past its budget without that progress, it is exhausted.
 */
export function judgeGapLineage(summary: LineageSummary, gaps: readonly { criterion: string; reproduction: string; boundaries?: readonly string[] }[], facts: GapFacts = {}): GapLineageJudgement[] {
  return gaps.map((g) => {
    const fp = reproductionFingerprint(g.reproduction);
    const sha = sha256(g.reproduction);
    const c = summary.criteria[g.criterion];
    const priors = (c?.reproductions ?? []).filter((r) => r.status !== 'unreworkable');
    const repeated = priors.find((r) => r.sha256 === sha || r.fingerprint === fp.sha256) ?? priors.find((r) => repeats(fp.terms, r.terms));
    const boundaries = boundaryTerms(g.boundaries);
    // A repeat of the reproduction that names an uncovered boundary none of the criterion's earlier gaps named is new all the same.
    const byBoundary = repeated !== undefined && newBoundary(boundaries, priors);
    const prior = byBoundary ? undefined : repeated;
    const base = { criterion: g.criterion, reproduction_sha256: sha, fingerprint: fp.sha256, terms: fp.terms, progress: [] as string[], boundaries, novelty: (byBoundary ? 'boundary' : 'reproduction') as GapLineageJudgement['novelty'] };
    const lost = facts.regressions?.[g.criterion]?.lost ?? [];
    if (lost.length > 0) return { ...base, verdict: 'regression' as const, duplicate_of: repeated?.sha256 ?? null, basis: 'regression' as const, lost: lost.map((x) => ({ ...x })) };
    if (prior !== undefined) return { ...base, novelty: null, verdict: 'duplicate' as const, duplicate_of: prior.sha256, basis: null };
    const accepted = c?.accepted_reworks ?? 0;
    const max = c?.max ?? summary.max_criterion_reworks;
    const ceiling = c?.ceiling ?? Math.max(max, summary.criterion_ceiling);
    if (accepted < max) return { ...base, verdict: 'accepted' as const, duplicate_of: null, basis: 'budget' as const };
    if (accepted >= ceiling) return { ...base, verdict: 'exhausted' as const, duplicate_of: null, basis: 'ceiling' as const };
    const progress = facts.progress?.[g.criterion];
    if (progress?.verified === true) return { ...base, verdict: 'accepted' as const, duplicate_of: null, basis: 'progress' as const, progress: [...progress.records] };
    return { ...base, verdict: 'exhausted' as const, duplicate_of: null, basis: 'no-progress' as const };
  });
}

/** The `gap` event of a judged gap, once what became of it is known: its basis and the progress it stood on recorded with it. */
export function gapEvent(reviewId: string, j: GapLineageJudgement, verdict: LineageGapVerdict, nodes: readonly string[], challengeId: string | null = null): LineageEventBody {
  return {
    kind: 'gap',
    review_id: reviewId,
    criterion: j.criterion,
    reproduction_sha256: j.reproduction_sha256,
    fingerprint: j.fingerprint,
    terms: [...j.terms],
    verdict,
    nodes: [...nodes],
    duplicate_of: j.duplicate_of,
    challenge_id: challengeId,
    ...(j.basis !== null && j.basis !== undefined ? { basis: j.basis } : {}),
    ...((j.progress ?? []).length > 0 ? { progress: [...j.progress] } : {}),
    ...(j.novelty !== null && j.novelty !== undefined ? { novelty: j.novelty } : {}),
    ...(j.boundaries !== undefined ? { boundaries: j.boundaries.map((b) => [...b]) } : {}),
  };
}

/**
 * Why a review settled now makes progress, against the last one settled: a
 * producer change (other heads), a new criterion proof (a criterion the last
 * one found a gap in passes), a materially new gap accepted, a PASS. None: it
 * adds to the no-progress streak (a valid challenge of it later still counts).
 */
export function reviewProgress(summary: LineageSummary, review: { heads: readonly string[]; passed: readonly string[]; gaps: readonly string[]; accepted: number; pass?: boolean }): string[] {
  const prev = summary.reviews[summary.reviews.length - 1];
  const out: string[] = [];
  if (prev === undefined) out.push('first-review');
  else {
    if (stableStringify([...review.heads].sort()) !== stableStringify([...prev.heads].sort())) out.push('producer-change');
    if (review.passed.some((c) => prev.gaps.includes(c))) out.push('criterion-proof');
  }
  if (review.accepted > 0) out.push('accepted-gap');
  if (review.pass === true) out.push('closure');
  return out;
}

/**
 * Why the review cannot converge, or null: the no-progress streak or the review sessions at their ceiling, a
 * criterion's completed proof lost and restored past MAX_REGRESSIONS (an oscillation that does not recover), or the
 * configured review wall-clock budget spent by `now` (ms; measured from the first review counted).
 */
export function nonconvergence(summary: LineageSummary, now: number = Date.now()): string | null {
  if (summary.no_progress_streak >= summary.max_no_progress) {
    const last = summary.reviews.slice(-summary.no_progress_streak).map((r) => `${r.review_id} ${r.outcome}`);
    return `${summary.no_progress_streak} consecutive reviews made no progress (no producer change, no new criterion proof, no accepted materially new gap, no valid challenge): ${last.join(', ')}`;
  }
  if (summary.review_sessions >= summary.max_review_sessions) {
    return `${summary.review_sessions} review sessions since the last accepted delivery reached the ceiling of ${summary.max_review_sessions} review sessions`;
  }
  const oscillating = Object.values(summary.criteria).find((c) => c.regressions > MAX_REGRESSIONS);
  if (oscillating !== undefined) {
    return `${oscillating.criterion}'s completed proof was lost from a reviewed head and restored ${oscillating.regressions} times since the last accepted delivery (more than ${MAX_REGRESSIONS}): it does not stay restored, an oscillation without recovery`;
  }
  if (summary.max_review_ms !== null && summary.first_review_at !== null) {
    const spent = now - Date.parse(summary.first_review_at);
    if (spent > summary.max_review_ms) return `${Math.round(spent / 60_000)} minutes since the first review of this delivery passed the configured review wall-clock budget of ${Math.round(summary.max_review_ms / 60_000)} minutes`;
  }
  return null;
}

/** Each criterion's budget, in one line: `AC-1 1/2 (2 withdrawn)`, `AC-2 3/2 (ceiling 6)` past its budget. */
export function budgetLine(summary: LineageSummary): string {
  return Object.values(summary.criteria)
    .map((c) => `${c.criterion} ${c.accepted_reworks}/${c.max}${c.accepted_reworks >= c.max ? ` (ceiling ${c.ceiling})` : ''}${c.withdrawals > 0 ? ` (${c.withdrawals} withdrawn)` : ''}${c.duplicates > 0 ? ` (${c.duplicates} repeat(s) rejected)` : ''}${c.regressions > 0 ? ` (${c.regressions} restored)` : ''}${c.exhausted ? ' EXHAUSTED' : ''}${c.closed !== null ? ' closed' : ''}`)
    .join(', ');
}

// ---- migration ---------------------------------------------------------------------

interface ReceiptLike {
  gaps?: { criterion: string; reproduction: string }[];
  reworks?: { node_id: string; criteria: string[] }[];
  criteria?: { criterion: string; verdict: string }[];
  inputs?: { repositories?: { name: string; head_sha: string }[] };
  inputs_sha256?: string;
  outcome?: string;
  overall?: string;
  settled_at?: string;
  refinement?: { decisions?: { challenge_id: string; criterion: string; decision: RefinementDecisionKind; gap?: { reproduction: string } }[] };
}

/**
 * The lineage of a review state from before it existed, from its records
 * and their pinned receipts, in the order things happened: each review's gaps
 * (accepted where its receipt reworked a producer for them, else never acted
 * on), the review and its progress, each challenge, each refinement's
 * decisions and refined gaps, a PASS's closures. Deterministic: the same
 * records give the same chain.
 */
export function migrateLineage(args: { reviews: readonly ReviewRecord[]; challenges: readonly ReviewChallengeRecord[] | undefined; maxCriterionReworks: number; safety?: LineageSafety; readReceipt: (rel: string) => ReceiptLike | null }): ReviewLineage {
  type Step = { at: string; order: number; build: (l: ReviewLineage) => LineageEventBody[] };
  const steps: Step[] = [];
  let order = 0;
  const nodesFor = (r: ReceiptLike, criterion: string): string[] => (r.reworks ?? []).filter((t) => t.criteria.includes(criterion)).map((t) => t.node_id);
  for (const record of args.reviews) {
    const first = args.readReceipt(record.original?.receipt_path ?? record.receipt_path) ?? {};
    steps.push({
      at: first.settled_at ?? record.at,
      order: order++,
      build: (l) => {
        const gaps = first.gaps ?? [];
        const summary = summarizeLineage(l, [], null);
        const bodies: LineageEventBody[] = gaps.map((g) => {
          const fp = reproductionFingerprint(g.reproduction);
          const nodes = nodesFor(first, g.criterion);
          return { kind: 'gap', review_id: record.review_id, criterion: g.criterion, reproduction_sha256: sha256(g.reproduction), fingerprint: fp.sha256, terms: fp.terms, verdict: nodes.length > 0 ? 'accepted' : 'unreworkable', nodes, duplicate_of: null, challenge_id: null };
        });
        const heads = (first.inputs?.repositories ?? []).map((r) => `${r.name}@${r.head_sha}`).sort();
        const passed = (first.criteria ?? []).filter((c) => c.verdict === 'PASS').map((c) => c.criterion);
        const accepted = bodies.filter((b) => b.kind === 'gap' && b.verdict === 'accepted').length;
        const progress = reviewProgress(summary, { heads, passed, gaps: gaps.map((g) => g.criterion), accepted, pass: first.overall === 'PASS' });
        bodies.push({ kind: 'review', review_id: record.review_id, inputs_sha256: first.inputs_sha256 ?? record.inputs_sha256, heads, outcome: first.outcome ?? record.outcome, passed, gaps: gaps.map((g) => g.criterion), progress });
        if (first.overall === 'PASS') for (const c of passed) bodies.push({ kind: 'closure', review_id: record.review_id, criterion: c, inputs_sha256: first.inputs_sha256 ?? record.inputs_sha256 });
        return bodies;
      },
    });
    for (const ref of record.refinements ?? []) {
      const receipt = args.readReceipt(ref.receipt_path) ?? {};
      steps.push({
        at: ref.at,
        order: order++,
        build: () => {
          const bodies: LineageEventBody[] = [];
          for (const d of receipt.refinement?.decisions ?? []) {
            bodies.push({ kind: 'decision', review_id: record.review_id, challenge_id: d.challenge_id, criterion: d.criterion, decision: d.decision });
            if (d.gap !== undefined) {
              const fp = reproductionFingerprint(d.gap.reproduction);
              const nodes = nodesFor(receipt, d.criterion);
              bodies.push({ kind: 'gap', review_id: record.review_id, criterion: d.criterion, reproduction_sha256: sha256(d.gap.reproduction), fingerprint: fp.sha256, terms: fp.terms, verdict: nodes.length > 0 ? 'accepted' : 'unreworkable', nodes, duplicate_of: null, challenge_id: d.challenge_id });
            }
          }
          if (receipt.overall === 'PASS' && receipt.outcome === 'PASS') {
            for (const c of (receipt.criteria ?? []).filter((x) => x.verdict === 'PASS')) bodies.push({ kind: 'closure', review_id: record.review_id, criterion: c.criterion, inputs_sha256: receipt.inputs_sha256 ?? record.inputs_sha256 });
          }
          return bodies;
        },
      });
    }
  }
  for (const c of args.challenges ?? []) {
    steps.push({
      at: c.at,
      order: order++,
      build: () => c.gaps.map((g) => ({ kind: 'challenge', review_id: c.review_id, challenge_id: c.challenge_id, criterion: g.criterion, reproduction_sha256: g.reproduction_sha256, receipt_sha256: c.receipt_sha256, node_id: c.node_id })),
    });
  }
  steps.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.order - b.order));
  let lineage = emptyLineage(args.maxCriterionReworks, args.safety ?? {});
  lineage = appendLineage(lineage, [{ kind: 'migrated', review_id: null, reviews: args.reviews.map((r) => r.review_id) }], steps[0]?.at ?? new Date(0).toISOString()).lineage;
  for (const step of steps) lineage = appendLineage(lineage, step.build(lineage), step.at).lineage;
  return lineage;
}

// ---- trust ----------------------------------------------------------------------------

/**
 * Why a review state's lineage cannot be trusted: its chain is broken, a
 * settled review (one it was not migrated from) has no event of its own, or
 * a receipt pins a chain head the chain does not hold — a reset or a rewrite
 * outside Mycelink, the events re-chained by hand included.
 */
export function lineageProblems(review: { reviews: readonly ReviewRecord[]; lineage?: ReviewLineage | undefined }, readReceipt: (rel: string) => { lineage?: { head_sha256?: unknown } } | null): string[] {
  const l = review.lineage;
  if (l === undefined) return [];
  const problems = chainProblems(l);
  const heads = new Set(l.events.map((e) => e.sha256));
  const first = l.events[0];
  const migrated = new Set(first?.kind === 'migrated' ? first.reviews : []);
  for (const rec of review.reviews) {
    const before = migrated.has(rec.review_id);
    const receipts = new Set([...(before ? [] : [rec.original?.receipt_path ?? rec.receipt_path]), ...(rec.refinements ?? []).map((r) => r.receipt_path)]);
    for (const rel of receipts) {
      const head = readReceipt(rel)?.lineage?.head_sha256;
      if (typeof head !== 'string') {
        if (!before) problems.push(`${rel} pins no lineage head: it was settled outside the lineage`);
        continue;
      }
      if (!heads.has(head)) problems.push(`${rel} pins lineage head ${head.slice(0, 12)}, which the chain does not hold: the lineage was reset or rewritten`);
    }
    if (!before && !l.events.some((e) => e.kind === 'review' && e.review_id === rec.review_id)) problems.push(`${rec.review_id} is settled, but the lineage holds no review event of it`);
  }
  return problems;
}
