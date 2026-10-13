/**
 * Each criterion of a rework order answered on its own.
 *
 * CSET-203 r15: R001's AC-3, AC-4 and AC-5 were one order on the cli. One red
 * gate ran the review's exact AC-3 and AC-4 reproductions: AC-3's failed (a
 * real gap) and AC-4's passed on the unchanged base. The worker fixed AC-3
 * test-first and committed AC-5's compatibility-regression unit. A result had
 * one outcome for the whole order: SUBMITTED needed a RED for AC-4 that no
 * honest test has, and a challenge allowed no production change. The
 * challenge line refused (that red gate had failed AC-3's test). So the
 * worker answered NEEDS_DECISION, asking how to close AC-4: one product
 * attempt, automation stopped. That was an orchestration overconstraint, not
 * a product failure.
 *
 * Here a result (schema_version 2, outcome CRITERIA) answers every criterion
 * the order holds, exactly once, each with its own outcome:
 *
 *  - DONE: proved by its criterion_evidence as its kind requires (a RED and
 *    its fix, or a compatibility unit's passing test);
 *  - REVIEW_GAP_CHALLENGE: its gap in `challenge.gaps` (its exact
 *    reproduction passed on the unchanged base) — a new behaviour only;
 *  - BLOCKED or NEEDS_DECISION: its own reason (and question).
 *
 * This module holds the pure parts: the form against the order, how a scalar
 * (legacy) outcome maps to the order's criteria, and when one test may stand
 * for two criteria. Settle judges each criterion on its own against the same
 * claim, order, revision and base (engine/orchestrator.ts).
 */
import type { GraphNode, PortfolioGraph, ReworkBrief, UnresolvedCriterionRecord } from '../model/types.js';
import type { NodeResult } from '../sessions/adapter.js';
import { criterionKind } from './criteria.js';

export const CRITERION_OUTCOMES = ['DONE', 'REVIEW_GAP_CHALLENGE', 'BLOCKED', 'NEEDS_DECISION'] as const;
export type CriterionOutcomeKind = (typeof CRITERION_OUTCOMES)[number];

/** The failure fingerprint of a malformed per-criterion result: `CRITERIA_RESULT_INVALID:<what>`. */
export const CRITERIA_REFUSED = 'CRITERIA_RESULT_INVALID';

export type CriteriaFormCode =
  | 'CRITERIA_RESULT_INVALID'
  | 'CRITERIA_NOT_REVIEW_REWORK'
  | 'CRITERIA_MISSING'
  | 'CRITERIA_DUPLICATE'
  | 'CRITERIA_NOT_ORDERED'
  | 'CRITERIA_COMPATIBILITY_CHALLENGED'
  | 'CRITERIA_CHALLENGE_MISMATCH'
  | 'CRITERIA_EVIDENCE_CONFLICT'
  | 'CRITERIA_EVIDENCE_MISSING'
  | 'CRITERIA_REASON_MISSING'
  | 'CRITERIA_DECISION_MISSING';

/** What a per-criterion result says of the order it answers, each criterion once. */
export interface CriteriaForm {
  /** The order's criteria, as its brief holds them. */
  ordered: string[];
  done: string[];
  challenged: string[];
  unresolved: UnresolvedCriterionRecord[];
}

export type CriteriaFormRefusal = { ok: false; code: CriteriaFormCode; detail: string; criterion: string | null };

/** The fingerprint a malformed per-criterion result is recorded under: stable per kind of refusal. */
export function criteriaFingerprint(code: CriteriaFormCode): string {
  return `${CRITERIA_REFUSED}:${code.replace(/^CRITERIA_/, '')}`;
}

// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

/**
 * The form of a per-criterion result against the order it answers (its
 * rework brief): null for a scalar result (judged as it always was), else
 * each ordered criterion's outcome, or the first refusal. Pure.
 */
export function criteriaForm(args: { result: NodeResult; brief: ReworkBrief | null; graph: PortfolioGraph; node: GraphNode }): { ok: true; form: CriteriaForm | null } | CriteriaFormRefusal {
  const { result, brief, graph } = args;
  const fail = (code: CriteriaFormCode, detail: string, criterion: string | null = null): CriteriaFormRefusal => ({ ok: false, code, detail, criterion });
  if (result.outcome !== 'CRITERIA') {
    if (result.criteria !== undefined) return fail('CRITERIA_RESULT_INVALID', `per-criterion outcomes answer outcome CRITERIA (schema_version 2), not ${result.outcome}`);
    return { ok: true, form: null };
  }
  if (result.schema_version !== 2) return fail('CRITERIA_RESULT_INVALID', 'outcome CRITERIA is schema_version 2');
  if (brief === null || brief.origin?.kind !== 'acceptance-review') {
    return fail('CRITERIA_NOT_REVIEW_REWORK', `${args.node.id} answers no acceptance review's rework order: per-criterion outcomes answer the criteria such an order holds; answer this node as a whole (SUBMITTED, BLOCKED, NEEDS_DECISION, RETRYABLE)`);
  }
  const ordered = [...brief.acceptance_criteria];
  const items = result.criteria ?? [];
  if (items.length === 0) return fail('CRITERIA_MISSING', `outcome CRITERIA names no criterion; the order holds ${ordered.join(', ')}`, ordered[0] ?? null);
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.criterion)) return fail('CRITERIA_DUPLICATE', `${item.criterion} is answered twice: each ordered criterion has exactly one outcome`, item.criterion);
    seen.add(item.criterion);
    if (!ordered.includes(item.criterion)) return fail('CRITERIA_NOT_ORDERED', `${item.criterion} is not a criterion this order holds (${ordered.join(', ')}): answer exactly the order's criteria`, item.criterion);
  }
  const missing = ordered.find((c) => !seen.has(c));
  if (missing !== undefined) return fail('CRITERIA_MISSING', `${missing} is ordered and not answered: every criterion of the order (${ordered.join(', ')}) has exactly one outcome`, missing);
  const done: string[] = [];
  const challenged: string[] = [];
  const unresolved: UnresolvedCriterionRecord[] = [];
  for (const c of ordered) {
    const item = items.find((x) => x.criterion === c) as NonNullable<NodeResult['criteria']>[number];
    if (item.clauses !== undefined && item.outcome !== 'DONE') return fail('CRITERIA_RESULT_INVALID', `${c} is ${item.outcome}: only a DONE criterion traces clauses to a test it shares`, c);
    if (item.outcome === 'DONE') {
      if (item.reason !== undefined || item.decision_request !== undefined) return fail('CRITERIA_RESULT_INVALID', `${c} is DONE: its proof is its criterion_evidence, never a reason or a question`, c);
      done.push(c);
    } else if (item.outcome === 'REVIEW_GAP_CHALLENGE') {
      if (item.reason !== undefined || item.decision_request !== undefined) return fail('CRITERIA_RESULT_INVALID', `${c} is challenged: its gap in challenge.gaps says why, never a reason or a question`, c);
      if (criterionKind(graph, c) !== 'new-behavior') {
        return fail('CRITERIA_COMPATIBILITY_CHALLENGED', `${c} is a ${criterionKind(graph, c)} criterion: its gap's test is expected to pass, committed as a compatibility-regression unit (DONE), never challenged`, c);
      }
      challenged.push(c);
    } else {
      const reason = typeof item.reason === 'string' ? item.reason.trim() : '';
      if (reason === '') return fail('CRITERIA_REASON_MISSING', `${c} is ${item.outcome}: say why, for this criterion alone (reason)`, c);
      const question = item.decision_request?.question ?? '';
      if ([reason, question, ...(item.decision_request?.options ?? [])].some((t) => UNSAFE.test(t))) return fail('CRITERIA_RESULT_INVALID', `${c}'s reason or question carries control, separator or bidirectional-override characters`, c);
      if (item.outcome === 'NEEDS_DECISION' && (item.decision_request === undefined || question.trim() === '')) {
        return fail('CRITERIA_DECISION_MISSING', `${c} is NEEDS_DECISION: give the question a person answers and its options (decision_request)`, c);
      }
      unresolved.push({
        criterion: c,
        outcome: item.outcome,
        reason,
        decision_request: item.outcome === 'NEEDS_DECISION' && item.decision_request !== undefined ? { question: question.trim(), options: [...item.decision_request.options], ...(item.decision_request.category !== undefined ? { category: item.decision_request.category } : {}) } : null,
      });
    }
  }
  // The challenge's gaps are exactly the challenged criteria.
  const gaps = (result.challenge?.gaps ?? []).map((g) => g.criterion);
  const stray = gaps.find((g) => !challenged.includes(g));
  if (stray !== undefined) return fail('CRITERIA_CHALLENGE_MISMATCH', `the challenge holds a gap of ${stray}, which this answer does not challenge: challenge.gaps are exactly the REVIEW_GAP_CHALLENGE criteria`, stray);
  const ungapped = challenged.find((c) => !gaps.includes(c));
  if (ungapped !== undefined) return fail('CRITERIA_CHALLENGE_MISMATCH', `${ungapped} is challenged but the challenge holds no gap of it: write its gap (the challenge line, narrowed with --criteria) into challenge.gaps`, ungapped);
  if (challenged.length === 0 && result.challenge !== undefined) return fail('CRITERIA_CHALLENGE_MISMATCH', 'a challenge with no REVIEW_GAP_CHALLENGE criterion');
  // Evidence is a DONE criterion's (or a criterion the order does not hold: a carried proof), never a challenged or unresolved one's.
  const evidence = result.criterion_evidence ?? [];
  const conflict = evidence.find((e) => challenged.includes(e.criterion) || unresolved.some((u) => u.criterion === e.criterion));
  if (conflict !== undefined) {
    return fail('CRITERIA_EVIDENCE_CONFLICT', `criterion_evidence names ${conflict.criterion}, which this answer does not prove DONE: a challenged criterion keeps its prior proof while its challenge waits, an unresolved one has none`, conflict.criterion);
  }
  const unproved = done.find((c) => !evidence.some((e) => e.criterion === c));
  if (unproved !== undefined) return fail('CRITERIA_EVIDENCE_MISSING', `${unproved} is DONE and criterion_evidence names no proof of it: the test that proves it, the gate that ran it and that gate's output hash`, unproved);
  return { ok: true, form: { ordered, done, challenged, unresolved } };
}

/**
 * How a result's outcome maps to each criterion of the order it answers —
 * only as it means: SUBMITTED proves every one (and is judged so, refused as
 * a whole otherwise); a legacy challenge of a subset challenges those and
 * keeps the others as gaps, ordered again after its refinement (RETAINED,
 * never DONE); BLOCKED and NEEDS_DECISION park the node for all of them; a
 * per-criterion result says each. Null when nothing maps (no order, or an
 * attempt that ended without an answer: RETRYABLE, BUDGET_EXHAUSTED).
 */
export function scalarCriteria(result: NodeResult, brief: ReworkBrief | null): { criterion: string; outcome: CriterionOutcomeKind | 'RETAINED' }[] | null {
  if (brief === null) return null;
  const ordered = brief.acceptance_criteria;
  switch (result.outcome) {
    case 'SUBMITTED':
      return ordered.map((criterion) => ({ criterion, outcome: 'DONE' as const }));
    case 'REVIEW_GAP_CHALLENGE': {
      const gaps = new Set((result.challenge?.gaps ?? []).map((g) => g.criterion));
      return ordered.map((criterion) => ({ criterion, outcome: gaps.has(criterion) ? ('REVIEW_GAP_CHALLENGE' as const) : ('RETAINED' as const) }));
    }
    case 'BLOCKED':
    case 'NEEDS_DECISION':
      return ordered.map((criterion) => ({ criterion, outcome: result.outcome as 'BLOCKED' | 'NEEDS_DECISION' }));
    case 'CRITERIA':
      return ordered.map((criterion) => ({ criterion, outcome: (result.criteria ?? []).find((x) => x.criterion === criterion)?.outcome ?? 'RETAINED' }));
    default:
      return null;
  }
}

/** One test named for one criterion: as its RED, green or regression proof, or among its challenge's passing tests. */
export interface EvidenceUse {
  criterion: string;
  test_id: string;
  role: 'red' | 'green' | 'regression' | 'challenge';
}

/**
 * The first test named for two of the order's criteria where it may not be:
 * a challenge's passing test is never another criterion's proof (it cannot
 * both show a gap absent and prove a behaviour added); two proofs share a
 * test only when each criterion explicitly traces its own clauses to that
 * test's assertions (`traced`). Two challenged criteria may share their
 * passing test (each challenge traces its clauses). Null when none.
 */
export function evidenceReuse(uses: readonly EvidenceUse[], traced: (criterion: string, testId: string) => boolean): { criterion: string; other: string; test_id: string; detail: string } | null {
  const byTest = new Map<string, EvidenceUse[]>();
  for (const u of uses) byTest.set(u.test_id, [...(byTest.get(u.test_id) ?? []), u]);
  for (const [testId, all] of byTest) {
    const criteria = [...new Set(all.map((u) => u.criterion))];
    if (criteria.length < 2) continue;
    const challengedBy = new Set(all.filter((u) => u.role === 'challenge').map((u) => u.criterion));
    const provedBy = new Set(all.filter((u) => u.role !== 'challenge').map((u) => u.criterion));
    if (challengedBy.size > 0 && provedBy.size > 0) {
      const [proved] = [...provedBy];
      const [challenged] = [...challengedBy];
      return { criterion: proved as string, other: challenged as string, test_id: testId, detail: `${testId} is ${challenged}'s challenge (it passed on the unchanged base) and ${proved}'s proof: one test cannot both show a gap absent and prove a behaviour added` };
    }
    if (provedBy.size < 2) continue;
    // The later criterion reuses the earlier one's test: it is the one named.
    const untraced = [...criteria].reverse().find((c) => !traced(c, testId));
    if (untraced !== undefined) {
      const other = criteria.find((c) => c !== untraced) as string;
      return { criterion: untraced, other, test_id: testId, detail: `${testId} is named for ${criteria.join(' and ')}: one test proves two criteria only when each traces its own clauses to that test's assertion lines (the criterion's clauses in criteria[].clauses)` };
    }
  }
  return null;
}
