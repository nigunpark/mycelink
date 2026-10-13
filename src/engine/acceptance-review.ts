/**
 * The independent acceptance review, before any candidate.
 *
 * CSET-203 r2: both with arms were matched and trusted, every implementation
 * and verification node settled DONE under strict TDD, C001/C002 were
 * delivered and the controller stayed clean — and both failed exactly one
 * hidden check: AC-1's rollback "when a changelog cannot be written". The
 * worker had tested rollback when a write failed at the package.json
 * boundary; its criterion evidence passed mechanically, because a test id
 * existed for AC-1. Criterion coverage by test id cannot judge whether the
 * tests exercise what the criterion's words require.
 *
 * Once every product and verification node is DONE, the controller hands
 * an acceptance-review ticket to a bundled, read-only reviewer subagent
 * (agents/acceptance-reviewer.md), a session of its own, with a packet of
 * public inputs: the approved criteria verbatim with their kinds, hashes and
 * material clauses, the graph's ownership, each repository's diff and a
 * checkout of the reviewed head, and the workers' criterion evidence and
 * gate outputs. It adversarially compares each criterion's words with the
 * tests and the implementation and answers one strict JSON verdict.
 *
 * The verdict is advisory model evidence; what it must contain is checked
 * here, mechanically: its binding (feature, review, dispatch generation and
 * the inputs' hash), a verdict for every approved criterion and nothing
 * else, every material clause of a PASS traced to a test and the location
 * of its assertion, the boundaries a new behaviour's text implies
 * enumerated and each covered by a test, regression evidence for a
 * compatibility criterion, only evidence the packet catalogued or files the
 * reviewed head holds, and an overall verdict consistent with all of it.
 * A GAP goes to the producer node the graph's criterion map and ownership
 * name, as a rework whose reason is the reviewer's public reproduction.
 * The receipt of a PASS is what candidate, feature verify and delivery ask
 * for, bound to the repository heads, the graph and the criteria; anything
 * changed since makes it stale. Hidden acceptance stays the final judge.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CriterionKind, FeatureState_, GraphNode, PortfolioGraph, RefinementDecisionKind, ReviewInputs, ReviewProblem, ReviewRecord } from '../model/types.js';
import { matchGlob } from '../git/worktree.js';
import { resolveRef } from '../git/git.js';
import { hashGraph, isProductProducer, stableStringify } from '../graph/validate.js';
import { loadState } from '../state/feature-state.js';
import { BARRIER_KINDS, activeLeases, currentEpoch } from '../state/orchestration.js';
import { featurePaths } from '../workspace/paths.js';
import { loadGraph, loadWorkspace, repositoryPath, type Workspace } from '../workspace/workspace.js';
import { loadAcceptanceManifest } from './acceptance.js';
import { criteriaSha256, normalizeCriterionKind } from './criteria.js';
import { trustedIntegrationHead } from './portfolio.js';
import { MAX_REWORK_REASON_BYTES } from './rework-brief.js';
import { COMPATIBILITY_TRAILER } from './tdd-history.js';
import { credentialKinds } from '../security/redact.js';
import { DEFAULT_CRITERION_CEILING, MAX_REVIEW_SESSIONS, lineageProblems, repeats, reproductionTerms } from './review-lineage.js';

/** A JSON file, or null when it is missing or not JSON. */
function readJsonOrNull(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export type { ReviewInputs } from '../model/types.js';

/** The plugin subagent a review ticket is for. */
export const REVIEWER_AGENT = 'mycelink:acceptance-reviewer';
export const REVIEW_VERDICT_SCHEMA = 'mycelink-acceptance-review/1';
export const REVIEW_RECEIPT_SCHEMA = 'mycelink-review-receipt/1';
export const REVIEW_PACKET_SCHEMA = 'mycelink-review-packet/1';
export const REVIEW_TICKET_SCHEMA = 'mycelink-review-ticket/1';
export const REVIEW_ATTESTATION_SCHEMA = 'mycelink-review-attestation/1';
/** The verdict file a reviewer writes, and the attestation of that write, inside its generation's directory. */
export const VERDICT_FILE = 'verdict.json';
export const ATTESTATION_FILE = 'verdict.attest.json';
/** Where reviews live in the scratch area: `<control>/.mycelink/reviews/<feature>/<review>/<dispatch>/`. */
export const REVIEWS_DIR = 'reviews';
export const DEFAULT_REVIEW_POLICY = { required: true, max_rounds: 2 } as const;
/** The most review-rework rounds a control repository may allow: per criterion, the budget granted on newness alone. */
export const MAX_REVIEW_ROUNDS_LIMIT = 5;
/** The highest emergency ceiling of accepted reworks per criterion a control repository may configure. */
export const MAX_CRITERION_CEILING = 32;
/** The most review sessions since the last accepted delivery a control repository may configure. */
export const MAX_REVIEW_SESSIONS_LIMIT = 64;
/** The longest review wall-clock budget a control repository may configure: a week. */
export const MAX_REVIEW_WALL_CLOCK_MINUTES = 7 * 24 * 60;
/**
 * Reviewer generations of one review that may end with no verdict to correct (none written, one not attested, a
 * changed packet) before the feature is blocked (REVIEW_INVALID). A verdict refused for its form is corrected
 * instead, MAX_FORMAT_CORRECTIONS times at most.
 */
export const MAX_REVIEW_ATTEMPTS = 2;
export const MAX_VERDICT_BYTES = 256 * 1024;

export type ReviewCode =
  | 'REVIEW_POLICY_INVALID'
  | 'REVIEW_VERDICT_MISSING'
  | 'REVIEW_VERDICT_INVALID'
  | 'REVIEW_VERDICT_UNSAFE'
  | 'REVIEW_UNATTESTED'
  | 'REVIEW_BINDING_MISMATCH'
  | 'REVIEW_INCOMPLETE'
  | 'REVIEW_TRACE_INCOMPLETE'
  | 'REVIEW_EVIDENCE_UNKNOWN'
  | 'REVIEW_INCONSISTENT'
  | 'REVIEW_OWNER_UNKNOWN'
  // A refinement's REFINE or UPHOLD that reproduces nothing materially different from what was challenged.
  | 'REVIEW_REFINEMENT_REPEATED'
  // A reviewer's final answer that is not exactly one JSON object (engine/review-transport.ts).
  | 'REVIEW_RESULT_INVALID'
  // A reviewer that wrote one verdict and answered another.
  | 'REVIEW_OUTPUT_CONFLICT'
  // A refinement that decides one criterion two ways (two challenges of it, by producers that both serve it).
  | 'REVIEW_REFINEMENT_CONFLICT';

export class ReviewError extends Error {
  readonly code: string;
  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'ReviewError';
    this.code = code;
  }
}

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

// ---- policy ------------------------------------------------------------------

export interface ReviewPolicy {
  required: boolean;
  /** Per criterion, the budget: accepted reworks a materially new gap gets on its newness alone. */
  max_rounds: number;
  /** How long a launched reviewer may run, from its launch, before it is interrupted (CSET-203 r13). */
  reviewer_timeout_ms: number;
  /** Per criterion, the emergency ceiling: past max_rounds each accepted rework needs verified producer progress, and here a person decides. */
  criterion_ceiling: number;
  /** Review sessions since the last accepted delivery, at most. */
  max_review_sessions: number;
  /** The review wall-clock budget from the first review of a delivery (null: none). */
  review_wall_clock_ms: number | null;
}

/** The reviewer's wall-clock unless `reviewer_timeout_seconds` says otherwise: 20 minutes. */
export const DEFAULT_REVIEWER_TIMEOUT_SECONDS = 20 * 60;
export const MAX_REVIEWER_TIMEOUT_SECONDS = 24 * 60 * 60;

const POLICY_KEYS = ['required', 'max_rounds', 'reviewer_timeout_seconds', 'criterion_ceiling', 'max_review_sessions', 'review_wall_clock_minutes'];

/**
 * The control repository's review policy (`mycelink.config.json`
 * `acceptance_review`): required unless it opts out; per criterion a budget
 * of two accepted reworks on newness alone unless it says otherwise (never
 * more than MAX_REVIEW_ROUNDS_LIMIT), then reworks on verified producer
 * progress up to the emergency ceiling (default DEFAULT_CRITERION_CEILING,
 * never below the budget: CSET-201 final's `max_rounds: 2` is a budget, not
 * a cap); the review-session budget (default 8) and an optional review
 * wall-clock budget. Fixed for a feature when it is initialised.
 */
export function reviewPolicyOf(config: { acceptance_review?: unknown }): ReviewPolicy {
  const raw = config.acceptance_review;
  const timeoutMs = DEFAULT_REVIEWER_TIMEOUT_SECONDS * 1000;
  const safety = (rounds: number) => ({ criterion_ceiling: Math.max(rounds, DEFAULT_CRITERION_CEILING), max_review_sessions: MAX_REVIEW_SESSIONS, review_wall_clock_ms: null });
  if (raw === undefined) return { ...DEFAULT_REVIEW_POLICY, reviewer_timeout_ms: timeoutMs, ...safety(DEFAULT_REVIEW_POLICY.max_rounds) };
  const bad = (why: string): never => {
    throw new ReviewError(
      'REVIEW_POLICY_INVALID',
      `mycelink.config.json acceptance_review ${why}; expected { "required": true|false, "max_rounds": 1..${MAX_REVIEW_ROUNDS_LIMIT}, "criterion_ceiling": max_rounds..${MAX_CRITERION_CEILING}, "max_review_sessions": 1..${MAX_REVIEW_SESSIONS_LIMIT}, "review_wall_clock_minutes": 1..${MAX_REVIEW_WALL_CLOCK_MINUTES}, "reviewer_timeout_seconds": 1..${MAX_REVIEWER_TIMEOUT_SECONDS} }`,
    );
  };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return bad('is not an object');
  const policy = raw as Record<string, unknown>;
  const extra = Object.keys(policy).filter((k) => !POLICY_KEYS.includes(k));
  if (extra.length > 0) bad(`has unknown keys (${extra.join(', ')})`);
  const whole = (key: string, value: unknown, min: number, max: number): number => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) bad(`${key} is ${JSON.stringify(value)}`);
    return value as number;
  };
  const required = policy['required'] ?? DEFAULT_REVIEW_POLICY.required;
  if (typeof required !== 'boolean') bad('required is not a boolean');
  const rounds = whole('max_rounds', policy['max_rounds'] ?? DEFAULT_REVIEW_POLICY.max_rounds, 1, MAX_REVIEW_ROUNDS_LIMIT);
  const seconds = whole('reviewer_timeout_seconds', policy['reviewer_timeout_seconds'] ?? DEFAULT_REVIEWER_TIMEOUT_SECONDS, 1, MAX_REVIEWER_TIMEOUT_SECONDS);
  const ceiling = policy['criterion_ceiling'] === undefined ? safety(rounds).criterion_ceiling : whole('criterion_ceiling', policy['criterion_ceiling'], rounds, MAX_CRITERION_CEILING);
  const sessions = whole('max_review_sessions', policy['max_review_sessions'] ?? MAX_REVIEW_SESSIONS, 1, MAX_REVIEW_SESSIONS_LIMIT);
  const minutes = policy['review_wall_clock_minutes'] === undefined ? null : whole('review_wall_clock_minutes', policy['review_wall_clock_minutes'], 1, MAX_REVIEW_WALL_CLOCK_MINUTES);
  return { required: required as boolean, max_rounds: rounds, reviewer_timeout_ms: seconds * 1000, criterion_ceiling: ceiling, max_review_sessions: sessions, review_wall_clock_ms: minutes === null ? null : minutes * 60_000 };
}

// ---- clauses -----------------------------------------------------------------

export interface ReviewClause {
  id: string;
  text: string;
  /** The clause only grants the implementation a choice ("The journal's format is up to you."): nothing in it to test. */
  latitude?: true;
}

const MAX_CLAUSES = 16;
/** A clause that leaves a choice to the implementation ... */
const LATITUDE = /\b(?:is|are)\s+(?:entirely\s+)?up\s+to\s+(?:you|the\s+implement(?:er|ation)|the\s+worker)\b|\b(?:is|are)\s+left\s+to\s+the\s+implement(?:er|ation)\b|\bat\s+(?:your|the\s+implementer'?s)\s+discretion\b|\b(?:is|are)\s+an?\s+implementation\s+detail\b/i;
/** ... and demands nothing besides. */
const OBLIGATION = /\b(?:must|shall|should|never|always|exactly|only|requires?|required|every|each|but)\b/i;
const ABBREVIATIONS = /(?:^|[\s(])(?:e\.g|i\.e|etc|vs|cf|al|approx)$/i;

/** A criterion's own label at the start of its text: a bold block naming it, or `AC-n ...:`. */
function stripLabel(id: string, segment: string): string {
  let s = segment;
  const bold = /^\*\*([^*]*)\*\*\s*/.exec(s);
  if (bold !== null && (bold[1] as string).includes(id)) s = s.slice(bold[0].length);
  else {
    const heading = /^#{1,6}\s+/.exec(s);
    if (heading !== null) s = s.slice(heading[0].length);
  }
  if (s.startsWith(id)) {
    const colon = s.indexOf(':');
    if (colon > 0 && colon <= id.length + 80) s = s.slice(colon + 1);
  }
  return s.trim();
}

/** A segment's sentences and semicolon clauses, each with its terminator; an abbreviation or a lower-case continuation does not end one. */
function sentences(segment: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < segment.length - 1; i++) {
    const c = segment[i] as string;
    if (!'.;!?'.includes(c) || segment[i + 1] !== ' ') continue;
    if (c !== ';') {
      const next = segment[i + 2] ?? '';
      if (!/[A-Z0-9`"'(\[*_]/.test(next)) continue;
      if (c === '.' && ABBREVIATIONS.test(segment.slice(start, i))) continue;
    }
    const piece = segment.slice(start, i + 1).trim();
    if (piece !== '') out.push(piece);
    start = i + 2;
  }
  const rest = segment.slice(start).trim();
  if (rest !== '') out.push(rest);
  return out;
}

/**
 * The material clauses of an approved criterion, verbatim and in order:
 * its own label dropped, each list item and each sentence or semicolon
 * clause on its own, whitespace collapsed; at most MAX_CLAUSES (the rest
 * joins the last). Numbered `<criterion>.<n>`. Never empty. A clause that
 * only leaves a choice to the implementation, demanding nothing besides, is
 * marked `latitude`: a PASS traces it without a test (judgeVerdict).
 */
export function criterionClauses(id: string, text: string): ReviewClause[] {
  const segments: string[] = [];
  let current: string[] = [];
  const flush = (): void => {
    const s = current.join(' ').replace(/\s+/g, ' ').trim();
    if (s !== '') segments.push(s);
    current = [];
  };
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    if (line === '') {
      flush();
      continue;
    }
    const item = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item !== null) {
      flush();
      current.push(item[1] as string);
      continue;
    }
    current.push(line);
  }
  flush();
  if (segments.length > 0) {
    const first = stripLabel(id, segments[0] as string);
    if (first === '') segments.shift();
    else segments[0] = first;
  }
  let pieces = segments.flatMap(sentences);
  if (pieces.length > MAX_CLAUSES) pieces = [...pieces.slice(0, MAX_CLAUSES - 1), pieces.slice(MAX_CLAUSES - 1).join(' ')];
  if (pieces.length === 0) pieces = [text.replace(/\s+/g, ' ').trim() || id];
  return pieces.map((p, i) => (isLatitudeClause(p) ? { id: `${id}.${i + 1}`, text: p, latitude: true as const } : { id: `${id}.${i + 1}`, text: p }));
}

/** Whether a clause only leaves a choice to the implementation and demands nothing besides. */
export function isLatitudeClause(text: string): boolean {
  return LATITUDE.test(text) && !OBLIGATION.test(text);
}

// ---- inputs ------------------------------------------------------------------

/** The hash a review binds: its canonical JSON. */
export function reviewInputsSha256(inputs: ReviewInputs): string {
  return sha256(stableStringify(inputs));
}

/** A verdict file's identity, independent of its formatting: the canonical JSON of what it parses to, or its bytes. The fence attests it; receipts carry it as the original verdict's hash. */
export function canonicalVerdictSha256(content: string): string {
  try {
    return sha256(stableStringify(JSON.parse(content) as unknown));
  } catch {
    return sha256(content);
  }
}

/** The approved criteria a review judges: the manifest's when the feature has one, else the graph's (validated equal at init). */
export function reviewCriteria(controlRoot: string, featureId: string, graph: PortfolioGraph): { id: string; kind: CriterionKind; text: string; sha256: string }[] {
  const manifest = loadAcceptanceManifest(controlRoot, featureId);
  if (manifest !== null) return manifest.manifest.criteria.map((c) => ({ id: c.id, kind: c.kind, text: c.text, sha256: c.sha256 }));
  return graph.acceptance_criteria.map((c) => ({ id: c.id, kind: normalizeCriterionKind(c.kind), text: c.text, sha256: sha256(c.text) }));
}

/**
 * What a review of the feature binds now: every registered repository's
 * head (its integration branch, trusted only where the controller left it,
 * or its base branch's tip where nothing was integrated: exactly what a
 * candidate would bind), the graph, the approved criteria and the
 * manifest's bytes. Throws when an integration branch moved.
 */
export function currentReviewInputs(controlRoot: string, featureId: string, workspace: Workspace, graph: PortfolioGraph, state: FeatureState_): ReviewInputs {
  const manifest = loadAcceptanceManifest(controlRoot, featureId);
  const criteria = reviewCriteria(controlRoot, featureId, graph);
  const repositories = workspace.repositories.repositories
    .map((r) => r.name)
    .sort()
    .map((name) => {
      const decl = workspace.repositories.repositories.find((r) => r.name === name);
      const trusted = trustedIntegrationHead(workspace, featureId, name, { graph, state });
      return { name, head_sha: trusted ?? resolveRef(repositoryPath(workspace, name), `refs/heads/${decl?.base_branch ?? 'main'}`) };
    });
  return {
    feature_id: featureId,
    graph_sha256: hashGraph(graph),
    criteria_sha256: criteriaSha256(criteria),
    manifest_sha256: manifest?.sha256 ?? null,
    repositories,
  };
}

// ---- the verdict -------------------------------------------------------------

export interface ReviewCriterion {
  id: string;
  kind: CriterionKind;
  text: string;
  sha256: string;
  clauses: ReviewClause[];
}

/** An evidence id the packet catalogued, and what it names. */
export interface CataloguedEvidence {
  kind: 'test' | 'gate' | 'receipt' | 'challenge';
  gate?: 'red' | 'green' | 'regression';
  /** A test: whether a green or regression gate (or the criterion evidence of one) recorded it passing. */
  passed?: boolean;
}

/** A compatibility criterion an earlier review of this delivery found GAP, and the clauses it found no test for. */
export interface PriorGap {
  review_id: string;
  criterion: string;
  untested: string[];
}

export interface VerdictContext {
  feature_id: string;
  review_id: string;
  dispatch_id: string;
  inputs_sha256: string;
  criteria: ReviewCriterion[];
  /** Every evidence id the packet catalogued. */
  evidence: Map<string, CataloguedEvidence>;
  /** The registered repositories the review binds. */
  repositories: string[];
  /** Whether `path` is a file of `repo` at the reviewed head. */
  fileExists: (repo: string, path: string) => boolean;
  /** Compatibility gaps of earlier reviews since the last accepted delivery: a PASS of them now needs a test the gates passed. */
  prior_gaps?: PriorGap[];
  /** Per criterion, the evidence ids the packet offers for it: named in a refusal of a trace to complete. */
  candidates?: Map<string, string[]>;
  /** Whether a string carries the control repository's authority (its controller key). */
  holdsAuthority?: (text: string) => boolean;
}

export interface Gap {
  criterion: string;
  missing: string;
  reproduction: string;
  /** Advisory: where the reviewer thinks the gap lies. Only a repository/path in it may pick among the criterion's producers (gapTargets). */
  producer: { node_id?: string; module?: string } | null;
  confidence: 'high' | 'medium' | 'low';
  /** A compatibility gap: the material clauses the reviewer found no test for (their evidence cites no test). */
  untested?: string[];
}

export interface VerdictCriterion {
  criterion: string;
  verdict: 'PASS' | 'GAP';
  confidence: 'high' | 'medium' | 'low';
  clauses: { clause: string; evidence: string[]; trace: string }[];
  boundaries: { kind: string; boundary: string; covered: boolean; evidence: string[] }[];
  gap: { missing: string; reproduction: string } | null;
  producer: { node_id?: string; module?: string } | null;
}

export interface Verdict {
  schema: typeof REVIEW_VERDICT_SCHEMA;
  feature_id: string;
  review_id: string;
  dispatch_id: string;
  inputs_sha256: string;
  reviewer: { agent: typeof REVIEWER_AGENT; model: string };
  criteria: VerdictCriterion[];
  overall: 'PASS' | 'GAPS';
}

/**
 * The bounds of a verdict's fields, in Unicode code points (items for
 * lists). The judge, the JSON schema (verdictJsonSchema,
 * schemas/acceptance-review-verdict.schema.json) and the reviewer's prompt
 * (verdictLimitsText) all read them here, so they cannot drift apart.
 */
export const VERDICT_LIMITS = {
  /** reviewer.model */
  model: 100,
  /** feature_id, review_id, dispatch_id, inputs_sha256 */
  binding: 200,
  criterion: 64,
  clause: 64,
  /** Human prose: over its bound it is cut and marked (canonicalised), never refused for its length. */
  trace: 600,
  boundary: 300,
  missing: 1000,
  reproduction: 1000,
  /** One evidence id or file location. */
  evidence_ref: 400,
  /** producer.node_id, producer.module */
  producer: 200,
  /** Entries of `criteria`. */
  criteria: 64,
  /** Entries of every other list: clauses, boundaries, evidence. */
  items: 32,
} as const;

/** What ends a prose field the controller cut at its bound. */
export const TRUNCATION_MARK = '…[truncated]';
/** Corrective reviewer generations one review may take for a verdict refused for its form, before REVIEW_INVALID. */
export const MAX_FORMAT_CORRECTIONS = 3;
/**
 * Refusals a corrective generation can mend from the refused verdict and
 * the field pointers: its form, binding, completeness, traces, citations or
 * consistency — a final answer that was not exactly one JSON object, or a
 * written verdict and a final answer that differ, included. Any other (no
 * verdict, an unattested one, a changed packet) spends one of
 * MAX_REVIEW_ATTEMPTS reviewer generations instead.
 */
export const FORMAT_REFUSALS: ReadonlySet<string> = new Set([
  'REVIEW_VERDICT_INVALID',
  'REVIEW_VERDICT_UNSAFE',
  'REVIEW_BINDING_MISMATCH',
  'REVIEW_INCOMPLETE',
  'REVIEW_TRACE_INCOMPLETE',
  'REVIEW_EVIDENCE_UNKNOWN',
  'REVIEW_INCONSISTENT',
  'REVIEW_REFINEMENT_REPEATED',
  'REVIEW_RESULT_INVALID',
  'REVIEW_OUTPUT_CONFLICT',
  'REVIEW_REFINEMENT_CONFLICT',
]);

/** One reason a verdict is refused, at the field it concerns. */
export interface VerdictProblem extends ReviewProblem {
  code: ReviewCode;
}

/** A prose field the canonical verdict holds otherwise than it was written. */
export interface NormalizedField {
  pointer: string;
  /** `normalized`: whitespace or Unicode form only; `truncated`: cut at its bound and marked. */
  action: 'normalized' | 'truncated';
  limit: number;
  original_length: number;
  original_sha256: string;
  canonical_length: number;
}

/** How the canonical verdict differs from the one the reviewer wrote: both hashes, and every changed field (at most MAX_NORMALIZED listed). */
export interface VerdictNormalization {
  /** verdictCanonicalSha256 of the verdict as written: the attested one. */
  original_sha256: string;
  /** verdictCanonicalSha256 of the canonical verdict: the one receipts carry. */
  canonical_sha256: string;
  changed: NormalizedField[];
  /** Changed fields beyond MAX_NORMALIZED. */
  omitted: number;
}

export type VerdictJudgement =
  | { ok: true; verdict: Verdict; overall: 'PASS' | 'GAPS'; gaps: Gap[]; normalization: VerdictNormalization }
  | { ok: false; code: ReviewCode; detail: string; problems: VerdictProblem[] };

/** A verdict's identity: the SHA-256 of its canonical JSON. */
export function verdictCanonicalSha256(verdict: unknown): string {
  return sha256(stableStringify(verdict));
}

const BOUNDARY_KINDS = ['state', 'failure', 'concurrency', 'order', 'partial-write', 'input', 'other'];
const CONFIDENCE = ['high', 'medium', 'low'];
const EVIDENCE_ID = /^(?:test:[0-9a-f]{16}|gate:[^\s:]+:(?:red|green|regression)|receipt:[^\s:]+|challenge:[A-Z][A-Z0-9]*-[0-9]+-R[0-9]{3,}-C[0-9]+)$/;
const FILE_REF = /^file:([a-z0-9][a-z0-9-]*):([^#\s]+)(?:#L(\d+)(?:-L?(\d+))?)?$/;
const MAX_NORMALIZED = 64;
const MAX_PROBLEMS = 24;
const MAX_CANDIDATES = 12;

/** The verdict's JSON schema, generated from VERDICT_LIMITS (schemas/acceptance-review-verdict.schema.json is this, written out). */
export function verdictJsonSchema(): Record<string, unknown> {
  const L = VERDICT_LIMITS;
  const str = (max: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ type: 'string', minLength: 1, maxLength: max, ...extra });
  const prose = (max: number, description: string, minLength = 1): Record<string, unknown> => ({ type: 'string', minLength, maxLength: max, description });
  const evidence = { type: 'array', maxItems: L.items, items: str(L.evidence_ref, { description: 'test:<16 hex>, gate:<node>:<red|green|regression>, receipt:<node> from the packet, or file:<repository>:<path>[#L<a>-L<b>]' }) };
  const cut = `Human prose; over the bound the controller cuts it at a word or code-point boundary and appends "${TRUNCATION_MARK}".`;
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'urn:mycelink:schema:acceptance-review-verdict',
    title: 'Mycelink acceptance-review verdict',
    description: 'The one JSON object an acceptance reviewer writes. Generated from VERDICT_LIMITS (src/engine/acceptance-review.ts); lengths are Unicode code points.',
    type: 'object',
    additionalProperties: false,
    required: ['schema', 'feature_id', 'review_id', 'dispatch_id', 'inputs_sha256', 'reviewer', 'criteria', 'overall'],
    properties: {
      schema: { const: REVIEW_VERDICT_SCHEMA },
      feature_id: str(L.binding),
      review_id: str(L.binding),
      dispatch_id: str(L.binding),
      inputs_sha256: str(L.binding),
      reviewer: { type: 'object', additionalProperties: false, required: ['agent', 'model'], properties: { agent: { const: REVIEWER_AGENT }, model: str(L.model) } },
      criteria: {
        type: 'array',
        maxItems: L.criteria,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['criterion', 'verdict', 'confidence', 'clauses', 'boundaries', 'gap', 'producer'],
          properties: {
            criterion: str(L.criterion),
            verdict: { enum: ['PASS', 'GAP'] },
            confidence: { enum: CONFIDENCE },
            clauses: {
              type: 'array',
              maxItems: L.items,
              items: { type: 'object', additionalProperties: false, required: ['clause', 'evidence', 'trace'], properties: { clause: str(L.clause), evidence, trace: prose(L.trace, cut, 0) } },
            },
            boundaries: {
              type: 'array',
              maxItems: L.items,
              items: { type: 'object', additionalProperties: false, required: ['kind', 'boundary', 'covered', 'evidence'], properties: { kind: { enum: BOUNDARY_KINDS }, boundary: prose(L.boundary, cut), covered: { type: 'boolean' }, evidence } },
            },
            gap: { type: ['object', 'null'], additionalProperties: false, required: ['missing', 'reproduction'], properties: { missing: prose(L.missing, cut), reproduction: prose(L.reproduction, cut) } },
            producer: { type: ['object', 'null'], additionalProperties: false, minProperties: 1, properties: { node_id: str(L.producer), module: str(L.producer) } },
          },
        },
      },
      overall: { enum: ['PASS', 'GAPS'] },
    },
  };
}

/** The bounds, as the reviewer's prompt states them. */
export function verdictLimitsText(): string {
  const L = VERDICT_LIMITS;
  return [
    `Bounds (Unicode characters): trace ${L.trace}, boundary ${L.boundary}, gap.missing ${L.missing}, gap.reproduction ${L.reproduction};`,
    `each evidence id or file location ${L.evidence_ref}, producer.node_id/module ${L.producer}, criterion ${L.criterion}, clause ${L.clause}, reviewer.model ${L.model};`,
    `at most ${L.criteria} criteria and ${L.items} clauses, boundaries or evidence entries per list. Prose over its bound is cut by the controller`,
    `and marked "${TRUNCATION_MARK}" (write within it); an id, hash, path, evidence reference or list over its bound is refused.`,
  ].join('\n');
}

const pointerOf = (...parts: (string | number)[]): string => parts.map((p) => `/${String(p).replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');
const codePoints = (s: string): number => {
  let n = 0;
  for (const _ of s) n++;
  return n;
};

// eslint-disable-next-line no-control-regex
const PROSE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;
// eslint-disable-next-line no-control-regex
const ID_CONTROL = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/;
const NONCHARACTER = /\p{Noncharacter_Code_Point}/u;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const AUTHORITY_FLAG = /(?:^|[\s"'`(=])--(?:authority|capability)\b/;
const INSTRUCTION = [
  /<\/?\s*(?:mycelink-[a-z0-9-]+|system(?:-reminder)?|assistant|human|user|instructions?|tool_use|tool_result|function_calls?|antml:[a-z_]+)\b[^>]*>/i,
  /\b(?:ignore|disregard|forget|override)\s+(?:(?:all|any|the|of)\s+)*(?:previous|prior|above|earlier|preceding|foregoing|your|these|those|system)\s+(?:instructions?|rules|prompts?|directions|guidelines)\b/i,
];

/** What a string carries that no verdict field may (none: null). Prose may hold tabs and line breaks; an identifier holds none. */
export function unsafeContent(s: string, prose: boolean, ctx: Pick<VerdictContext, 'holdsAuthority'>): { kind: NonNullable<VerdictProblem['kind']>; what: string } | null {
  if ((prose ? PROSE_CONTROL : ID_CONTROL).test(s)) return { kind: 'control', what: 'a control, bidirectional-override or byte-order character' };
  if (LONE_SURROGATE.test(s) || NONCHARACTER.test(s)) return { kind: 'unicode', what: 'invalid Unicode (a lone surrogate or a noncharacter)' };
  const credentials = credentialKinds(s);
  if (credentials.length > 0) return { kind: 'credential', what: `a credential (${credentials.join(', ')})` };
  if (ctx.holdsAuthority?.(s) === true || AUTHORITY_FLAG.test(s)) return { kind: 'authority', what: 'Mycelink authority (the controller key, --authority or --capability)' };
  if (INSTRUCTION.some((rx) => rx.test(s))) return { kind: 'instruction', what: 'an embedded instruction (a prompt delimiter, a role marker, or an instruction to disregard instructions)' };
  return null;
}

/** Combining marks, joiners and variation selectors: a cut never leaves one without what it attaches to. */
const EXTENDS = /^[\p{M}\u200c\u200d\ufe00-\ufe0f\u{e0100}-\u{e01ef}\u{1f3fb}-\u{1f3ff}]$/u;

/**
 * `s` (already canonical) within `limit` code points: unchanged when it
 * fits; else cut and ended with TRUNCATION_MARK, at the last space when one
 * lies in the last quarter of the room, else at a code point — never inside
 * a surrogate pair, never between a character and a mark, joiner or
 * selector that extends it. Deterministic.
 */
export function truncateProse(s: string, limit: number): string {
  const chars = Array.from(s);
  if (chars.length <= limit) return s;
  const room = Math.max(0, limit - Array.from(TRUNCATION_MARK).length);
  let n = room;
  while (n > 0 && (EXTENDS.test(chars[n] as string) || chars[n - 1] === '\u200d')) n--;
  const space = chars.lastIndexOf(' ', n);
  if (space >= Math.floor((room * 3) / 4) && space > 0) n = space;
  return `${chars.slice(0, n).join('').trimEnd()}${TRUNCATION_MARK}`;
}

/** Prose as the canonical verdict holds it: NFC; a run of whitespace with a line break, tab or other non-space in it one space; trimmed. Spaces as written stay. */
export function canonicalProse(s: string): string {
  return s
    .normalize('NFC')
    .replace(/\s+/g, (run) => (/^ +$/.test(run) ? run : ' '))
    .trim();
}

/** The judging of one verdict: its problems and the prose it changed, collected as it goes. */
class Judging {
  readonly problems: VerdictProblem[] = [];
  readonly changed: NormalizedField[] = [];

  constructor(readonly ctx: VerdictContext) {}

  add(code: ReviewCode, pointer: string, detail: string, extra: Partial<VerdictProblem> = {}): void {
    this.problems.push({ code, pointer, detail, ...extra });
  }

  /** An object with exactly `keys` (and `optional`), each missing or unknown key a problem at its own pointer. */
  object(value: unknown, at: string, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> | null {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      this.add('REVIEW_VERDICT_INVALID', at || '/', `${at || 'the verdict'} is not an object`);
      return null;
    }
    const v = value as Record<string, unknown>;
    for (const k of Object.keys(v).filter((k) => !keys.includes(k) && !optional.includes(k))) this.add('REVIEW_VERDICT_INVALID', `${at}${pointerOf(k)}`, `unknown field ${JSON.stringify(k.slice(0, 40))} (expected ${[...keys, ...optional].join(', ')})`);
    for (const k of keys.filter((k) => !(k in v))) this.add('REVIEW_VERDICT_INVALID', `${at}${pointerOf(k)}`, `is missing (required: ${keys.join(', ')})`);
    return v;
  }

  /** An identifier, hash, path or evidence reference: exact as written, refused over its bound (never cut). Undefined: a missing key, already a problem. */
  id(value: unknown, at: string, limit: number): string | null {
    if (value === undefined) return null;
    if (typeof value !== 'string') return this.fail('REVIEW_VERDICT_INVALID', at, 'is not a string');
    const unsafe = unsafeContent(value, false, this.ctx);
    if (unsafe !== null) return this.fail('REVIEW_VERDICT_UNSAFE', at, `carries ${unsafe.what}`, { kind: unsafe.kind });
    const n = codePoints(value);
    if (n > limit) return this.fail('REVIEW_VERDICT_INVALID', at, `is ${n} characters, over its bound of ${limit}: an identifier, hash, path or evidence reference is never cut`, { limit });
    if (value.trim() === '') return this.fail('REVIEW_VERDICT_INVALID', at, 'is empty');
    return value;
  }

  /** Human prose, canonicalised: refused for what it carries, never for its length (cut and marked over `limit`). */
  prose(value: unknown, at: string, limit: number, options: { empty?: boolean } = {}): string | null {
    if (value === undefined) return null;
    if (typeof value !== 'string') return this.fail('REVIEW_VERDICT_INVALID', at, 'is not a string');
    const unsafe = unsafeContent(value, true, this.ctx);
    if (unsafe !== null) return this.fail('REVIEW_VERDICT_UNSAFE', at, `carries ${unsafe.what}`, { kind: unsafe.kind });
    const normal = canonicalProse(value);
    if (normal === '' && options.empty !== true) return this.fail('REVIEW_VERDICT_INVALID', at, 'is empty');
    const canonical = truncateProse(normal, limit);
    if (canonical !== value) {
      this.changed.push({ pointer: at, action: canonical !== normal ? 'truncated' : 'normalized', limit, original_length: codePoints(value), original_sha256: sha256(value), canonical_length: codePoints(canonical) });
    }
    return canonical;
  }

  list(value: unknown, at: string, max: number): unknown[] | null {
    if (value === undefined) return null;
    if (!Array.isArray(value)) return this.fail('REVIEW_VERDICT_INVALID', at, 'is not an array');
    if (value.length > max) return this.fail('REVIEW_VERDICT_INVALID', at, `has ${value.length} entries, over its bound of ${max}`, { limit: max });
    return value;
  }

  oneOf(value: unknown, at: string, allowed: readonly string[]): string | null {
    if (value === undefined) return null;
    if (typeof value !== 'string' || !allowed.includes(value)) return this.fail('REVIEW_VERDICT_INVALID', at, `is ${JSON.stringify(value)?.slice(0, 40)}, not one of ${allowed.join(', ')}`);
    return value;
  }

  candidates(criterion: string): { candidates?: string[] } {
    const c = this.ctx.candidates?.get(criterion);
    return c !== undefined && c.length > 0 ? { candidates: c.slice(0, MAX_CANDIDATES) } : {};
  }

  private fail(code: ReviewCode, at: string, detail: string, extra: Partial<VerdictProblem> = {}): null {
    this.add(code, at, detail, extra);
    return null;
  }

  refusal(): Extract<VerdictJudgement, { ok: false }> {
    const problems = this.problems.slice(0, MAX_PROBLEMS);
    const first = problems.find((p) => p.code === 'REVIEW_VERDICT_UNSAFE') ?? (problems[0] as VerdictProblem);
    const more = this.problems.length - problems.length;
    const detail = problems.map((p) => `${p.pointer}: ${p.detail}`).join('; ') + (more > 0 ? `; and ${more} more` : '');
    return { ok: false, code: first.code, detail, problems };
  }
}

/** Each evidence id is one the packet catalogued, or a file of a registered repository at the reviewed head. */
function checkEvidence(j: Judging, ids: string[], at: string, criterion: string): void {
  for (const [k, id] of ids.entries()) {
    const where = `${at}${pointerOf(k)}`;
    if (EVIDENCE_ID.test(id)) {
      if (!j.ctx.evidence.has(id)) j.add('REVIEW_EVIDENCE_UNKNOWN', where, `cites ${id}, which the review packet does not catalogue`, j.candidates(criterion));
      continue;
    }
    const file = FILE_REF.exec(id);
    if (file === null) {
      j.add('REVIEW_EVIDENCE_UNKNOWN', where, `cites ${JSON.stringify(id.slice(0, 120))}: evidence is test:<id>, gate:<node>:<gate>, receipt:<node> from the packet, or file:<repository>:<path>[#L<a>-L<b>]`, j.candidates(criterion));
      continue;
    }
    const [, repo, path] = file as unknown as [string, string, string];
    const unsafe = path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.split('/').some((seg) => seg === '..' || seg === '') || path.includes('\\');
    if (!j.ctx.repositories.includes(repo) || unsafe || !j.ctx.fileExists(repo, path)) j.add('REVIEW_EVIDENCE_UNKNOWN', where, `cites ${id.slice(0, 160)}, which is not a file of a reviewed repository at its reviewed head`);
  }
}

/**
 * Judge a reviewer's verdict against the review it answers, and give its
 * canonical form. Never trusts what it says beyond its form: refused unless
 * it is exactly bound to this review generation and its inputs, complete
 * over the approved criteria, traced clause by clause, boundary by
 * boundary, to evidence that exists, consistent, and free of what no field
 * may carry. Its prose is canonicalised (canonicalProse, truncateProse):
 * prose over its bound is cut and marked, the original's length and hash
 * kept; nothing else is ever cut. A refusal lists every problem found, each
 * at its JSON pointer, with the bound it is over or the evidence ids the
 * packet offers. Its PASS and GAP judgements themselves stay advisory.
 */
export function judgeVerdict(raw: unknown, ctx: VerdictContext): VerdictJudgement {
  const j = new Judging(ctx);
  const parsed = structure(j, raw);
  if (parsed === null || j.problems.length > 0) return j.refusal();
  const gaps = semantics(j, parsed.criteria, parsed.overall);
  if (j.problems.length > 0) return j.refusal();
  const verdict: Verdict = {
    schema: REVIEW_VERDICT_SCHEMA,
    feature_id: ctx.feature_id,
    review_id: ctx.review_id,
    dispatch_id: ctx.dispatch_id,
    inputs_sha256: ctx.inputs_sha256,
    reviewer: { agent: REVIEWER_AGENT, model: parsed.model },
    criteria: parsed.criteria.map((c) => c.value),
    overall: parsed.overall,
  };
  return {
    ok: true,
    verdict,
    overall: verdict.overall,
    gaps,
    normalization: { original_sha256: verdictCanonicalSha256(raw), canonical_sha256: verdictCanonicalSha256(verdict), changed: j.changed.slice(0, MAX_NORMALIZED), omitted: Math.max(0, j.changed.length - MAX_NORMALIZED) },
  };
}

interface Judged {
  /** The index the criterion has in the verdict as written. */
  index: number;
  value: VerdictCriterion;
}

/** The verdict's form, field by field: every problem collected; null when it is not even an object. */
function structure(j: Judging, raw: unknown): { model: string; criteria: Judged[]; overall: 'PASS' | 'GAPS' } | null {
  const top = j.object(raw, '', ['schema', 'feature_id', 'review_id', 'dispatch_id', 'inputs_sha256', 'reviewer', 'criteria', 'overall']);
  if (top === null) return null;
  const L = VERDICT_LIMITS;
  if ('schema' in top && top['schema'] !== REVIEW_VERDICT_SCHEMA) j.add('REVIEW_VERDICT_INVALID', '/schema', `is ${JSON.stringify(top['schema'])?.slice(0, 60)}, not ${REVIEW_VERDICT_SCHEMA}`);
  const reviewer = 'reviewer' in top ? j.object(top['reviewer'], '/reviewer', ['agent', 'model']) : null;
  if (reviewer !== null && 'agent' in reviewer && reviewer['agent'] !== REVIEWER_AGENT) j.add('REVIEW_VERDICT_INVALID', '/reviewer/agent', `is ${JSON.stringify(reviewer['agent'])?.slice(0, 60)}, not ${REVIEWER_AGENT}`);
  const model = reviewer === null ? null : j.id(reviewer['model'], '/reviewer/model', L.model);
  for (const key of ['feature_id', 'review_id', 'dispatch_id', 'inputs_sha256'] as const) {
    const value = j.id(top[key], pointerOf(key), L.binding);
    if (value !== null && value !== j.ctx[key]) j.add('REVIEW_BINDING_MISMATCH', pointerOf(key), `is ${value.slice(0, 80)}, but this review generation is ${j.ctx[key]}: a verdict answers exactly the ticket it was given`);
  }
  const overall = j.oneOf(top['overall'], '/overall', ['PASS', 'GAPS']);

  const items = j.list(top['criteria'], '/criteria', L.criteria) ?? [];
  const criteria: Judged[] = [];
  const seen = new Set<string>();
  for (const [i, item] of items.entries()) {
    const at = pointerOf('criteria', i);
    const c = j.object(item, at, ['criterion', 'verdict', 'confidence', 'clauses', 'boundaries', 'gap', 'producer']);
    if (c === null) continue;
    const before = j.problems.length;
    const id = j.id(c['criterion'], `${at}/criterion`, L.criterion);
    if (id !== null && seen.has(id)) j.add('REVIEW_VERDICT_INVALID', `${at}/criterion`, `${id} is judged twice`);
    if (id !== null) seen.add(id);
    const verdict = j.oneOf(c['verdict'], `${at}/verdict`, ['PASS', 'GAP']);
    const confidence = j.oneOf(c['confidence'], `${at}/confidence`, CONFIDENCE);
    const evidence = (value: unknown, where: string): string[] => (j.list(value, where, L.items) ?? []).map((e, k) => j.id(e, `${where}${pointerOf(k)}`, L.evidence_ref) ?? '');
    const clauses = (j.list(c['clauses'], `${at}/clauses`, L.items) ?? []).map((x, k) => {
      const where = `${at}/clauses/${k}`;
      const cl = j.object(x, where, ['clause', 'evidence', 'trace']);
      if (cl === null) return { clause: '', evidence: [], trace: '' };
      return { clause: j.id(cl['clause'], `${where}/clause`, L.clause) ?? '', evidence: evidence(cl['evidence'], `${where}/evidence`), trace: j.prose(cl['trace'], `${where}/trace`, L.trace, { empty: true }) ?? '' };
    });
    const boundaries = (j.list(c['boundaries'], `${at}/boundaries`, L.items) ?? []).map((x, k) => {
      const where = `${at}/boundaries/${k}`;
      const b = j.object(x, where, ['kind', 'boundary', 'covered', 'evidence']);
      if (b === null) return { kind: '', boundary: '', covered: false, evidence: [] };
      const kind = j.oneOf(b['kind'], `${where}/kind`, BOUNDARY_KINDS) ?? '';
      if ('covered' in b && typeof b['covered'] !== 'boolean') j.add('REVIEW_VERDICT_INVALID', `${where}/covered`, 'is not a boolean');
      return { kind, boundary: j.prose(b['boundary'], `${where}/boundary`, L.boundary) ?? '', covered: b['covered'] === true, evidence: evidence(b['evidence'], `${where}/evidence`) };
    });
    let gap: VerdictCriterion['gap'] = null;
    if (c['gap'] !== null && c['gap'] !== undefined) {
      const g = j.object(c['gap'], `${at}/gap`, ['missing', 'reproduction']);
      if (g !== null) gap = { missing: j.prose(g['missing'], `${at}/gap/missing`, L.missing) ?? '', reproduction: j.prose(g['reproduction'], `${at}/gap/reproduction`, L.reproduction) ?? '' };
    }
    let producer: VerdictCriterion['producer'] = null;
    if (c['producer'] !== null && c['producer'] !== undefined) {
      const p = j.object(c['producer'], `${at}/producer`, [], ['node_id', 'module']);
      if (p !== null) {
        if (p['node_id'] === undefined && p['module'] === undefined) j.add('REVIEW_VERDICT_INVALID', `${at}/producer`, 'names neither node_id nor module');
        const nodeId = p['node_id'] !== undefined ? j.id(p['node_id'], `${at}/producer/node_id`, L.producer) : null;
        const module = p['module'] !== undefined ? j.id(p['module'], `${at}/producer/module`, L.producer) : null;
        producer = { ...(nodeId !== null ? { node_id: nodeId } : {}), ...(module !== null ? { module } : {}) };
      }
    }
    if (j.problems.length > before || id === null || verdict === null || confidence === null) continue;
    criteria.push({ index: i, value: { criterion: id, verdict: verdict as 'PASS' | 'GAP', confidence: confidence as VerdictCriterion['confidence'], clauses, boundaries, gap, producer } });
  }
  if (model === null || overall === null) return null;
  return { model, criteria, overall: overall as 'PASS' | 'GAPS' };
}

/** Whether the packet names tests by id (structured reports), else by file location only. */
function testEvidence(ctx: VerdictContext): (e: string) => boolean {
  // A packet whose gates published no test ids (no structured report anywhere) names tests by file location only.
  const ids = [...ctx.evidence.values()].some((e) => e.kind === 'test');
  return (e: string): boolean => e.startsWith('test:') || (!ids && e.startsWith('file:'));
}

/** A criterion's clauses as traced: each one of its own, traced once, and every evidence id one the packet catalogues. */
function clauseChecks(j: Judging, approved: ReviewCriterion, c: Pick<VerdictCriterion, 'criterion' | 'clauses' | 'boundaries'>, at: string): void {
  const clauseIds = approved.clauses.map((x) => x.id);
  const traced = new Set<string>();
  for (const [k, cl] of c.clauses.entries()) {
    if (!clauseIds.includes(cl.clause)) j.add('REVIEW_VERDICT_INVALID', `${at}/clauses/${k}/clause`, `${cl.clause} is not one of ${c.criterion}'s clauses (${clauseIds.join(', ')})`);
    else if (traced.has(cl.clause)) j.add('REVIEW_VERDICT_INVALID', `${at}/clauses/${k}/clause`, `${cl.clause} is traced twice`);
    traced.add(cl.clause);
    checkEvidence(j, cl.evidence, `${at}/clauses/${k}/evidence`, c.criterion);
  }
  for (const [k, b] of c.boundaries.entries()) checkEvidence(j, b.evidence, `${at}/boundaries/${k}/evidence`, c.criterion);
}

/**
 * The ordinary rules of a PASS, at `at`: every clause traced (a new
 * behaviour's to a test and its assertion's location; a latitude clause to a
 * trace alone), at least one boundary for a new behaviour, each covered by a
 * test; a compatibility criterion on regression evidence, and an earlier
 * review's untested clause on a test the gates passed.
 */
function passTrace(j: Judging, approved: ReviewCriterion, c: Pick<VerdictCriterion, 'criterion' | 'clauses' | 'boundaries'>, at: string): void {
  const ctx = j.ctx;
  const isTest = testEvidence(ctx);
  const offered = j.candidates(c.criterion);
  const clauseIds = approved.clauses.map((x) => x.id);
  const latitude = new Set(approved.clauses.filter((x) => x.latitude === true).map((x) => x.id));
  const kind = approved.kind;
  // Every clause traced: a trace, and evidence unless the clause only grants latitude (nothing to test).
  const untraced = new Set<string>();
  for (const id of clauseIds) {
    const k = c.clauses.findIndex((x) => x.clause === id);
    const cl = c.clauses[k];
    if (cl !== undefined && cl.trace.trim() !== '' && (cl.evidence.length > 0 || latitude.has(id))) continue;
    untraced.add(id);
    j.add('REVIEW_TRACE_INCOMPLETE', k < 0 ? `${at}/clauses` : `${at}/clauses/${k}`, `${c.criterion} is a PASS but ${id} is not traced to evidence: a test existing for a criterion proves nothing about a clause no assertion exercises`, offered);
  }
  if (kind === 'new-behavior') {
    for (const [k, cl] of c.clauses.entries()) {
      if (untraced.has(cl.clause) || latitude.has(cl.clause)) continue;
      if (!cl.evidence.some(isTest) || !cl.evidence.some((e) => e.startsWith('file:'))) {
        j.add('REVIEW_TRACE_INCOMPLETE', `${at}/clauses/${k}/evidence`, `${c.criterion} ${cl.clause}: a new behaviour's clause is traced to the test that exercises it (test:<id>) and the location of the assertion that checks it (file:<repository>:<path>#L<line>)`, offered);
      }
    }
    if (c.boundaries.length === 0) j.add('REVIEW_TRACE_INCOMPLETE', `${at}/boundaries`, `${c.criterion} is a new behaviour judged PASS with no boundary: enumerate the state, failure, concurrency, order and partial-write boundaries its text implies`);
  }
  if (kind === 'compatibility') {
    const all = c.clauses.flatMap((x) => x.evidence);
    if (!all.some((e) => e.startsWith('receipt:') || (e.startsWith('gate:') && e.endsWith(':regression')))) {
      j.add('REVIEW_TRACE_INCOMPLETE', `${at}/clauses`, `${c.criterion} is a compatibility criterion: a PASS stands on regression evidence (a verification receipt or a regression gate), not on a new test`, offered);
    }
    // An earlier review of this delivery found clauses of it untested: their PASS now rests on a test the gates passed.
    for (const prior of (ctx.prior_gaps ?? []).filter((p) => p.criterion === c.criterion)) {
      for (const clause of prior.untested) {
        const k = c.clauses.findIndex((x) => x.clause === clause);
        const cited = c.clauses[k]?.evidence ?? [];
        if (!cited.some((e) => e.startsWith('test:') && ctx.evidence.get(e)?.passed === true)) {
          j.add('REVIEW_TRACE_INCOMPLETE', k < 0 ? `${at}/clauses` : `${at}/clauses/${k}/evidence`, `${c.criterion} ${clause} was a GAP in ${prior.review_id} (no test exercised it): its PASS now cites the test that exercises it, one a green or regression gate passed (test:<id>), not only a receipt or the suite`, offered);
        }
      }
    }
  }
  for (const [k, b] of c.boundaries.entries()) {
    if (!b.covered) j.add('REVIEW_INCONSISTENT', `${at}/boundaries/${k}/covered`, `${c.criterion} is a PASS with a boundary it found uncovered ("${b.boundary.slice(0, 80)}"): that is a GAP`);
    else if (!b.evidence.some(isTest)) j.add('REVIEW_TRACE_INCOMPLETE', `${at}/boundaries/${k}/evidence`, `${c.criterion} boundary "${b.boundary.slice(0, 80)}" is covered by no test (test:<id>)`, offered);
  }
}

/** What the verdict says, against the approved criteria and the packet: every problem collected; the gaps when there is none. */
function semantics(j: Judging, criteria: Judged[], overallSaid: 'PASS' | 'GAPS'): Gap[] {
  const ctx = j.ctx;
  // Every approved criterion judged, and nothing else.
  const approved = ctx.criteria.map((c) => c.id);
  const seen = criteria.map((c) => c.value.criterion);
  const missing = approved.filter((id) => !seen.includes(id));
  const unknown = seen.filter((id) => !approved.includes(id));
  if (missing.length > 0 || unknown.length > 0) {
    j.add('REVIEW_INCOMPLETE', '/criteria', [missing.length > 0 ? `no verdict for ${missing.join(', ')}` : '', unknown.length > 0 ? `${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not approved criteria` : ''].filter(Boolean).join('; ') + `: judge exactly ${approved.join(', ')}`);
  }

  const isTest = testEvidence(ctx);
  const gaps: Gap[] = [];
  for (const { index, value: c } of criteria) {
    const approvedCriterion = ctx.criteria.find((a) => a.id === c.criterion);
    if (approvedCriterion === undefined) continue;
    const at = pointerOf('criteria', index);
    const offered = j.candidates(c.criterion);
    const latitude = new Set(approvedCriterion.clauses.filter((x) => x.latitude === true).map((x) => x.id));
    clauseChecks(j, approvedCriterion, c, at);

    const kind = approvedCriterion.kind;
    if (c.verdict === 'GAP') {
      if (c.gap === null) {
        j.add('REVIEW_INCONSISTENT', `${at}/gap`, `${c.criterion} is a GAP without a gap: say what is not proved and how to reproduce it publicly`);
        continue;
      }
      if (kind !== 'compatibility') {
        gaps.push({ criterion: c.criterion, missing: c.gap.missing, reproduction: c.gap.reproduction, producer: c.producer, confidence: c.confidence });
        continue;
      }
      // A compatibility criterion already stands on the green suite: a GAP in it is a finding only when it names the
      // material clause no test exercises (its evidence cites no test) and says what is not shown there.
      const untested = c.clauses.filter((x) => !latitude.has(x.clause) && !x.evidence.some(isTest) && x.trace.trim() !== '').map((x) => x.clause);
      if (untested.length === 0) {
        j.add('REVIEW_TRACE_INCOMPLETE', `${at}/clauses`, `${c.criterion} is a compatibility GAP that names no material clause no test covers: trace the clause the suite leaves unshown with evidence citing no test:<id> (a receipt, a regression gate, or nothing) and a trace of what is not shown, and give its public reproduction; a passing suite with every clause tested is no gap`, offered);
        continue;
      }
      gaps.push({ criterion: c.criterion, missing: c.gap.missing, reproduction: c.gap.reproduction, producer: c.producer, confidence: c.confidence, untested });
      continue;
    }
    if (c.gap !== null) j.add('REVIEW_INCONSISTENT', `${at}/gap`, `${c.criterion} is a PASS with a gap to rework`);
    if (c.producer !== null) j.add('REVIEW_INCONSISTENT', `${at}/producer`, `${c.criterion} is a PASS with a producer to rework`);
    passTrace(j, approvedCriterion, c, at);
  }
  const overall: 'PASS' | 'GAPS' = gaps.length > 0 ? 'GAPS' : 'PASS';
  if (j.problems.length === 0 && overallSaid !== overall) {
    j.add('REVIEW_INCONSISTENT', '/overall', `is ${overallSaid}, but ${gaps.length > 0 ? `${gaps.map((g) => g.criterion).join(', ')} ${gaps.length === 1 ? 'is a GAP' : 'are GAPs'}` : 'every criterion is a PASS'}`);
  }
  return gaps;
}

// ---- a challenged gap, refined -------------------------------------------------

/**
 * What a refinement reviewer writes (CSET-203 r6): after a module-worker's
 * valid challenge showed a GAP's exact public reproduction passing on the
 * unchanged integrated head, a fresh reviewer session, given the original
 * packet and verdict and the challenge's tests, results and traces, decides
 * each challenged gap: WITHDRAW (the reproduction proves the clause: the
 * criterion traced as a PASS, on the challenge's evidence), REFINE (a
 * materially different exact reproduction, and its producer) or UPHOLD (why
 * the challenge's assertions do not test the clause, and a corrected exact
 * reproduction). The review's other gaps are kept as they were.
 */
export const REVIEW_REFINEMENT_SCHEMA = 'mycelink-acceptance-refinement/1';

/** One challenged gap a refinement decides: the challenge, the gap as challenged, its reproductions so far, the challenge's evidence. */
export interface RefinementChallenge {
  challenge_id: string;
  challenge_sha256: string;
  criterion: string;
  node_id: string;
  gap: { missing: string; reproduction: string };
  /** Every reproduction of this gap so far, the one challenged included: a REFINE or UPHOLD reproduces something materially different from each. */
  earlier_reproductions: string[];
  /** The challenge's focused tests, as evidence ids (test:<16 hex>). */
  tests: string[];
  /** The challenge's test files, as `<repository>:<path>` (their archived copies). */
  files: string[];
}

export interface RefinementContext extends VerdictContext {
  challenges: RefinementChallenge[];
  /** The review's other gaps, as it found them: kept. */
  unchanged_gaps: Gap[];
  /** The review's criteria verdicts as its receipt holds them: the refined verdict keeps every one not challenged. */
  original_criteria: VerdictCriterion[];
}

export interface RefinementDecision {
  challenge_id: string;
  challenge_sha256: string;
  criterion: string;
  decision: RefinementDecisionKind;
  reason: string;
  clauses: VerdictCriterion['clauses'];
  boundaries: VerdictCriterion['boundaries'];
  gap: { missing: string; reproduction: string } | null;
  producer: { node_id?: string; module?: string } | null;
  rebuttal: { test_id: string; assertion: string; why: string }[];
}

export interface Refinement {
  schema: typeof REVIEW_REFINEMENT_SCHEMA;
  feature_id: string;
  review_id: string;
  dispatch_id: string;
  inputs_sha256: string;
  reviewer: { agent: typeof REVIEWER_AGENT; model: string };
  decisions: RefinementDecision[];
  overall: 'PASS' | 'GAPS';
}

export type RefinementJudgement =
  | {
      ok: true;
      refinement: Refinement;
      decisions: RefinementDecision[];
      overall: 'PASS' | 'GAPS';
      /** The review's criteria verdicts as refined: a withdrawn gap a PASS, a refined or upheld one a GAP with its new reproduction, the rest as they were. */
      criteria: VerdictCriterion[];
      /** Every gap the review is left with: the ones it kept, then the refined and upheld ones. */
      gaps: Gap[];
      /** The refined and upheld gaps alone: each is reworked anew. */
      refined: (Gap & { challenge_id: string })[];
      normalization: VerdictNormalization;
    }
  | { ok: false; code: ReviewCode; detail: string; problems: VerdictProblem[] };

/**
 * Whether `candidate` reproduces something materially different from every
 * earlier reproduction of the same gap: not one of them by its normalized
 * fingerprint, its terms or near enough to them (engine/review-lineage.ts
 * repeats: case, punctuation, order, padding and synonyms set aside). A
 * refinement may not answer a challenge with the challenged reproduction
 * dressed up.
 */
export function materiallyDifferent(candidate: string, earlier: readonly string[]): boolean {
  const terms = reproductionTerms(candidate);
  return earlier.every((e) => e !== candidate && !repeats(terms, reproductionTerms(e)));
}

const DECISIONS = ['WITHDRAW', 'REFINE', 'UPHOLD'];

/**
 * Judge a refinement against the challenges it answers, as a verdict is
 * judged: its form and bounds, its binding (feature, review, this
 * generation's dispatch and inputs, each challenge's hash), every challenged
 * gap decided exactly once and nothing else, and each decision as its kind
 * requires — a WITHDRAW the ordinary trace of a PASS resting on the
 * challenge's evidence; a REFINE a new exact reproduction materially
 * different from every earlier one, and its producer; an UPHOLD the same,
 * with a rebuttal of the challenge's own assertions. `overall` is PASS only
 * when every gap is withdrawn and the review has none left; then every
 * criterion of the refined verdict must meet the ordinary PASS rules. Its
 * prose is canonicalised (cut and marked over its bound); what no field may
 * carry is refused.
 */
export function judgeRefinement(raw: unknown, ctx: RefinementContext): RefinementJudgement {
  const j = new Judging(ctx);
  const L = VERDICT_LIMITS;
  const top = j.object(raw, '', ['schema', 'feature_id', 'review_id', 'dispatch_id', 'inputs_sha256', 'reviewer', 'decisions', 'overall']);
  if (top === null) return j.refusal();
  if ('schema' in top && top['schema'] !== REVIEW_REFINEMENT_SCHEMA) j.add('REVIEW_VERDICT_INVALID', '/schema', `is ${JSON.stringify(top['schema'])?.slice(0, 60)}, not ${REVIEW_REFINEMENT_SCHEMA}: a refinement answers a challenged review`);
  const reviewer = 'reviewer' in top ? j.object(top['reviewer'], '/reviewer', ['agent', 'model']) : null;
  if (reviewer !== null && 'agent' in reviewer && reviewer['agent'] !== REVIEWER_AGENT) j.add('REVIEW_VERDICT_INVALID', '/reviewer/agent', `is ${JSON.stringify(reviewer['agent'])?.slice(0, 60)}, not ${REVIEWER_AGENT}`);
  const model = reviewer === null ? null : j.id(reviewer['model'], '/reviewer/model', L.model);
  for (const key of ['feature_id', 'review_id', 'dispatch_id', 'inputs_sha256'] as const) {
    const value = j.id(top[key], pointerOf(key), L.binding);
    if (value !== null && value !== ctx[key]) j.add('REVIEW_BINDING_MISMATCH', pointerOf(key), `is ${value.slice(0, 80)}, but this refinement generation is ${ctx[key]}: a refinement answers exactly the ticket it was given`);
  }
  const overallSaid = j.oneOf(top['overall'], '/overall', ['PASS', 'GAPS']);
  const evidence = (value: unknown, where: string): string[] => (j.list(value, where, L.items) ?? []).map((e, k) => j.id(e, `${where}${pointerOf(k)}`, L.evidence_ref) ?? '');
  const decisions: { index: number; value: RefinementDecision }[] = [];
  for (const [i, item] of (j.list(top['decisions'], '/decisions', L.criteria) ?? []).entries()) {
    const at = pointerOf('decisions', i);
    const d = j.object(item, at, ['challenge_id', 'challenge_sha256', 'criterion', 'decision', 'reason', 'clauses', 'boundaries', 'gap', 'producer', 'rebuttal']);
    if (d === null) continue;
    const before = j.problems.length;
    const challengeId = j.id(d['challenge_id'], `${at}/challenge_id`, L.binding);
    const challengeSha = j.id(d['challenge_sha256'], `${at}/challenge_sha256`, L.binding);
    const criterion = j.id(d['criterion'], `${at}/criterion`, L.criterion);
    const decision = j.oneOf(d['decision'], `${at}/decision`, DECISIONS);
    const reason = j.prose(d['reason'], `${at}/reason`, L.missing);
    const clauses = (j.list(d['clauses'], `${at}/clauses`, L.items) ?? []).map((x, k) => {
      const where = `${at}/clauses/${k}`;
      const cl = j.object(x, where, ['clause', 'evidence', 'trace']);
      if (cl === null) return { clause: '', evidence: [], trace: '' };
      return { clause: j.id(cl['clause'], `${where}/clause`, L.clause) ?? '', evidence: evidence(cl['evidence'], `${where}/evidence`), trace: j.prose(cl['trace'], `${where}/trace`, L.trace, { empty: true }) ?? '' };
    });
    const boundaries = (j.list(d['boundaries'], `${at}/boundaries`, L.items) ?? []).map((x, k) => {
      const where = `${at}/boundaries/${k}`;
      const b = j.object(x, where, ['kind', 'boundary', 'covered', 'evidence']);
      if (b === null) return { kind: '', boundary: '', covered: false, evidence: [] };
      const kind = j.oneOf(b['kind'], `${where}/kind`, BOUNDARY_KINDS) ?? '';
      if ('covered' in b && typeof b['covered'] !== 'boolean') j.add('REVIEW_VERDICT_INVALID', `${where}/covered`, 'is not a boolean');
      return { kind, boundary: j.prose(b['boundary'], `${where}/boundary`, L.boundary) ?? '', covered: b['covered'] === true, evidence: evidence(b['evidence'], `${where}/evidence`) };
    });
    let gap: RefinementDecision['gap'] = null;
    if (d['gap'] !== null && d['gap'] !== undefined) {
      const g = j.object(d['gap'], `${at}/gap`, ['missing', 'reproduction']);
      if (g !== null) gap = { missing: j.prose(g['missing'], `${at}/gap/missing`, L.missing) ?? '', reproduction: j.prose(g['reproduction'], `${at}/gap/reproduction`, L.reproduction) ?? '' };
    }
    let producer: RefinementDecision['producer'] = null;
    if (d['producer'] !== null && d['producer'] !== undefined) {
      const p = j.object(d['producer'], `${at}/producer`, [], ['node_id', 'module']);
      if (p !== null) {
        if (p['node_id'] === undefined && p['module'] === undefined) j.add('REVIEW_VERDICT_INVALID', `${at}/producer`, 'names neither node_id nor module');
        const nodeId = p['node_id'] !== undefined ? j.id(p['node_id'], `${at}/producer/node_id`, L.producer) : null;
        const module = p['module'] !== undefined ? j.id(p['module'], `${at}/producer/module`, L.producer) : null;
        producer = { ...(nodeId !== null ? { node_id: nodeId } : {}), ...(module !== null ? { module } : {}) };
      }
    }
    const rebuttal = (j.list(d['rebuttal'], `${at}/rebuttal`, L.items) ?? []).map((x, k) => {
      const where = `${at}/rebuttal/${k}`;
      const r = j.object(x, where, ['test_id', 'assertion', 'why']);
      if (r === null) return { test_id: '', assertion: '', why: '' };
      return { test_id: j.id(r['test_id'], `${where}/test_id`, L.evidence_ref) ?? '', assertion: j.id(r['assertion'], `${where}/assertion`, L.evidence_ref) ?? '', why: j.prose(r['why'], `${where}/why`, L.trace) ?? '' };
    });
    if (j.problems.length > before || challengeId === null || challengeSha === null || criterion === null || decision === null || reason === null) continue;
    decisions.push({ index: i, value: { challenge_id: challengeId, challenge_sha256: challengeSha, criterion, decision: decision as RefinementDecisionKind, reason, clauses, boundaries, gap, producer, rebuttal } });
  }
  if (model === null || overallSaid === null || j.problems.length > 0) return j.refusal();

  // Every challenged gap decided once, against its exact challenge, and nothing else.
  const key = (challenge: string, criterion: string): string => `${challenge}\u0000${criterion}`;
  const expected = new Map(ctx.challenges.map((c) => [key(c.challenge_id, c.criterion), c]));
  const decided = new Set<string>();
  for (const { index, value: d } of decisions) {
    const at = pointerOf('decisions', index);
    const c = expected.get(key(d.challenge_id, d.criterion));
    if (c === undefined) {
      j.add('REVIEW_INCOMPLETE', at, `decides ${d.criterion} of ${d.challenge_id.slice(0, 80)}, which this refinement was not given: decide exactly ${[...expected.values()].map((x) => `${x.criterion} of ${x.challenge_id}`).join(', ')}`);
      continue;
    }
    if (decided.has(key(d.challenge_id, d.criterion))) j.add('REVIEW_INCOMPLETE', at, `decides ${d.criterion} of ${d.challenge_id} twice`);
    decided.add(key(d.challenge_id, d.criterion));
    if (d.challenge_sha256 !== c.challenge_sha256) j.add('REVIEW_BINDING_MISMATCH', `${at}/challenge_sha256`, `is not the hash of ${c.challenge_id} (${c.challenge_sha256.slice(0, 12)}): a refinement answers exactly the challenge it was given`);
  }
  const undecided = [...expected.entries()].filter(([k]) => !decided.has(k)).map(([, c]) => `${c.criterion} of ${c.challenge_id}`);
  if (undecided.length > 0) j.add('REVIEW_INCOMPLETE', '/decisions', `no decision for ${undecided.join(', ')}: WITHDRAW, REFINE or UPHOLD each challenged gap`);
  // One criterion challenged by several producers (each serves it) is one gap of the review: decided one way, with one
  // reproduction (CSET-203 r14: decisions are merged into one revision, never two answers to one gap).
  const first = new Map<string, { index: number; value: RefinementDecision }>();
  for (const d of decisions) {
    const was = first.get(d.value.criterion);
    if (was === undefined) {
      first.set(d.value.criterion, d);
      continue;
    }
    const at = pointerOf('decisions', d.index);
    if (d.value.decision !== was.value.decision) {
      j.add('REVIEW_REFINEMENT_CONFLICT', `${at}/decision`, `decides ${d.value.criterion} ${d.value.decision} for ${d.value.challenge_id}, but /decisions/${was.index} decides it ${was.value.decision} for ${was.value.challenge_id}: one criterion is one gap of the review — decide it one way for every challenge of it`);
    } else if (d.value.decision !== 'WITHDRAW' && canonicalProse(d.value.gap?.reproduction ?? '') !== canonicalProse(was.value.gap?.reproduction ?? '')) {
      j.add('REVIEW_REFINEMENT_CONFLICT', `${at}/gap/reproduction`, `gives ${d.value.criterion} another reproduction than /decisions/${was.index}: one criterion is one gap of the review — give every challenge of it the same exact reproduction`);
    }
  }
  if (j.problems.length > 0) return j.refusal();

  const refined: (Gap & { challenge_id: string })[] = [];
  for (const { index, value: d } of decisions) {
    const at = pointerOf('decisions', index);
    const c = expected.get(key(d.challenge_id, d.criterion)) as RefinementChallenge;
    const approved = ctx.criteria.find((a) => a.id === d.criterion);
    if (approved === undefined) {
      j.add('REVIEW_INCOMPLETE', `${at}/criterion`, `${d.criterion} is not an approved criterion`);
      continue;
    }
    clauseChecks(j, approved, d, at);
    if (d.decision === 'WITHDRAW') {
      if (d.gap !== null) j.add('REVIEW_INCONSISTENT', `${at}/gap`, `a WITHDRAW of ${d.criterion} leaves no gap to rework`);
      if (d.producer !== null) j.add('REVIEW_INCONSISTENT', `${at}/producer`, `a WITHDRAW of ${d.criterion} names no producer`);
      if (d.rebuttal.length > 0) j.add('REVIEW_INCONSISTENT', `${at}/rebuttal`, `a WITHDRAW of ${d.criterion} rebuts nothing`);
      passTrace(j, approved, d, at);
      // A gap is withdrawn on what the challenge showed: its own evidence, cited.
      const cited = [...d.clauses.flatMap((x) => x.evidence), ...d.boundaries.flatMap((x) => x.evidence)];
      if (!cited.some((e) => e === `challenge:${c.challenge_id}` || c.tests.includes(e))) {
        j.add('REVIEW_TRACE_INCOMPLETE', `${at}/clauses`, `a WITHDRAW of ${d.criterion} rests on what ${c.challenge_id} showed: cite its evidence (challenge:${c.challenge_id}, its tests ${c.tests.join(', ')} and their assertion lines)`, { candidates: [`challenge:${c.challenge_id}`, ...c.tests, ...c.files.map((f) => `file:${f}`)].slice(0, 12) });
      }
      continue;
    }
    if (d.gap === null) {
      j.add('REVIEW_INCONSISTENT', `${at}/gap`, `a ${d.decision} of ${d.criterion} gives the gap anew: what is not proved and its exact public reproduction`);
      continue;
    }
    if (d.producer === null) j.add('REVIEW_INCONSISTENT', `${at}/producer`, `a ${d.decision} of ${d.criterion} names the producer the gap lies in (node_id, or module <repository>:<path>)`);
    if (!materiallyDifferent(d.gap.reproduction, c.earlier_reproductions)) {
      j.add('REVIEW_REFINEMENT_REPEATED', `${at}/gap/reproduction`, `reproduces nothing materially different from what ${c.challenge_id} already ran (or an earlier reproduction of this gap): a ${d.decision} gives a new exact reproduction — another failure, state, order or boundary — never the challenged one again`);
    }
    if (d.decision === 'REFINE' && d.rebuttal.length > 0) j.add('REVIEW_INCONSISTENT', `${at}/rebuttal`, 'a REFINE rebuts nothing: an UPHOLD does');
    if (d.decision === 'UPHOLD') {
      if (d.rebuttal.length === 0) {
        j.add('REVIEW_TRACE_INCOMPLETE', `${at}/rebuttal`, `an UPHOLD of ${d.criterion} says why ${c.challenge_id}'s assertions do not test the clause: each entry a test of the challenge, its assertion location and why`, { candidates: [...c.tests, ...c.files.map((f) => `file:${f}`)].slice(0, 12) });
      }
      for (const [k, r] of d.rebuttal.entries()) {
        if (!c.tests.includes(`test:${r.test_id.replace(/^test:/, '')}`)) j.add('REVIEW_EVIDENCE_UNKNOWN', `${at}/rebuttal/${k}/test_id`, `${r.test_id.slice(0, 40)} is not one of ${c.challenge_id}'s tests (${c.tests.join(', ')})`);
        const file = FILE_REF.exec(r.assertion);
        if (file === null || !c.files.includes(`${file[1]}:${file[2]}`)) j.add('REVIEW_EVIDENCE_UNKNOWN', `${at}/rebuttal/${k}/assertion`, `${r.assertion.slice(0, 120)} is not a location in ${c.challenge_id}'s test files (${c.files.join(', ')})`);
      }
    }
    if (!refined.some((g) => g.criterion === d.criterion)) refined.push({ challenge_id: c.challenge_id, criterion: d.criterion, missing: d.gap.missing, reproduction: d.gap.reproduction, producer: d.producer, confidence: 'high' });
  }
  if (j.problems.length > 0) return j.refusal();

  // The refined verdict: a withdrawn gap a PASS, a refined or upheld one a GAP, every other criterion as the review judged it.
  const byCriterion = new Map(decisions.map(({ value: d }) => [d.criterion, d]));
  const criteria: VerdictCriterion[] = ctx.original_criteria.map((o) => {
    const d = byCriterion.get(o.criterion);
    if (d === undefined) return o;
    return d.decision === 'WITHDRAW'
      ? { criterion: o.criterion, verdict: 'PASS', confidence: 'high', clauses: d.clauses, boundaries: d.boundaries, gap: null, producer: null }
      : { criterion: o.criterion, verdict: 'GAP', confidence: 'high', clauses: d.clauses, boundaries: d.boundaries, gap: d.gap, producer: d.producer };
  });
  const gaps: Gap[] = [...ctx.unchanged_gaps.filter((g) => !byCriterion.has(g.criterion)), ...refined.map(({ challenge_id: _c, ...g }) => g)];
  const overall: 'PASS' | 'GAPS' = gaps.length === 0 ? 'PASS' : 'GAPS';
  if (overallSaid !== overall) {
    j.add('REVIEW_INCONSISTENT', '/overall', `is ${overallSaid}, but ${gaps.length > 0 ? `${gaps.map((g) => g.criterion).join(', ')} ${gaps.length === 1 ? 'is a GAP' : 'are GAPs'} after it` : 'every gap is withdrawn and the review has no other'}`);
  }
  if (overall === 'PASS') {
    // No gap left: the refined verdict is a PASS by the ordinary rules, every criterion of it (the challenge's evidence may support them).
    const scratch = new Judging(ctx);
    for (const c of criteria) {
      const approved = ctx.criteria.find((a) => a.id === c.criterion);
      if (approved === undefined || byCriterion.has(c.criterion)) continue;
      if (c.verdict !== 'PASS') scratch.add('REVIEW_INCONSISTENT', '/overall', `${c.criterion} was a GAP of the review and is not refined: it is no PASS`);
      else {
        clauseChecks(scratch, approved, c, '/overall');
        passTrace(scratch, approved, c, '/overall');
      }
    }
    for (const p of scratch.problems) j.add(p.code, '/overall', `the review's ${p.detail}`);
    const missing = ctx.criteria.filter((a) => !criteria.some((c) => c.criterion === a.id)).map((a) => a.id);
    if (missing.length > 0) j.add('REVIEW_INCOMPLETE', '/overall', `the refined verdict judges no ${missing.join(', ')}`);
  }
  if (j.problems.length > 0) return j.refusal();
  const refinement: Refinement = {
    schema: REVIEW_REFINEMENT_SCHEMA,
    feature_id: ctx.feature_id,
    review_id: ctx.review_id,
    dispatch_id: ctx.dispatch_id,
    inputs_sha256: ctx.inputs_sha256,
    reviewer: { agent: REVIEWER_AGENT, model },
    decisions: decisions.map((d) => d.value),
    overall,
  };
  return {
    ok: true,
    refinement,
    decisions: refinement.decisions,
    overall,
    criteria,
    gaps,
    refined,
    normalization: { original_sha256: verdictCanonicalSha256(raw), canonical_sha256: verdictCanonicalSha256(refinement), changed: j.changed.slice(0, MAX_NORMALIZED), omitted: Math.max(0, j.changed.length - MAX_NORMALIZED) },
  };
}

// ---- gaps to producers -------------------------------------------------------

export interface GapTarget {
  node_id: string;
  criteria: string[];
  gaps: Gap[];
  /** How it was found: the graph's producers of the criterion (the only one, or every one), or the one of several owning the repository/path the reviewer gave. */
  by: 'criterion' | 'path';
}

/** Whether a producer owns `<repository>:<path>` (or a bare path): a path inside its allowed paths, or a directory holding them. */
function ownsModule(node: GraphNode, module: string): boolean {
  const colon = module.indexOf(':');
  const repo = colon > 0 && /^[a-z0-9][a-z0-9-]*$/.test(module.slice(0, colon)) ? module.slice(0, colon) : null;
  const path = (repo === null ? module : module.slice(colon + 1)).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (path === '' || (repo !== null && node.repository !== repo)) return false;
  if ((node.forbidden_paths ?? []).some((g) => matchGlob(g, path))) return false;
  return node.allowed_paths.some((g) => {
    if (matchGlob(g, path) || matchGlob(g, `${path}/x`)) return true;
    const literal = g.split(/[*?[{]/)[0] ?? '';
    return literal.startsWith(`${path}/`);
  });
}

/**
 * The producer nodes each GAP is reworked on, by the graph alone: the
 * product producers that serve its criterion (validate.ts: every criterion
 * has one). Where several serve it, a repository/path the reviewer gave
 * that exactly one of them owns picks that one; otherwise each reworks. The
 * reviewer's node id is advisory and decides nothing: r3's reviewer named
 * the verification node that proves AC-5, which changes no code. A gap
 * whose criterion no product node serves (a graph from before every
 * criterion had one) is returned `unowned`, apart: it never discards the
 * targets of the others. Several gaps of one producer make one target;
 * targets come dependents first, so each keeps the review's reason as its
 * own brief.
 */
export function gapTargets(graph: PortfolioGraph, gaps: Gap[]): { targets: GapTarget[]; unowned: Gap[] } {
  const targets = new Map<string, GapTarget>();
  const unowned: Gap[] = [];
  const producers = graph.nodes.filter(isProductProducer);
  for (const gap of gaps) {
    const serving = producers.filter((n) => (n.acceptance_criteria ?? []).includes(gap.criterion));
    if (serving.length === 0) {
      unowned.push(gap);
      continue;
    }
    const module = gap.producer?.module;
    const owned = serving.length > 1 && module !== undefined ? serving.filter((n) => ownsModule(n, module)) : [];
    const picked: { ids: string[]; by: GapTarget['by'] } = owned.length === 1 ? { ids: [(owned[0] as GraphNode).id], by: 'path' } : { ids: serving.map((n) => n.id), by: 'criterion' };
    for (const id of picked.ids) {
      const t = targets.get(id) ?? { node_id: id, criteria: [], gaps: [], by: picked.by };
      if (!t.criteria.includes(gap.criterion)) t.criteria.push(gap.criterion);
      t.gaps.push(gap);
      targets.set(id, t);
    }
  }
  const order = graph.acceptance_criteria.map((a) => a.id);
  for (const t of targets.values()) t.criteria.sort((a, b) => order.indexOf(a) - order.indexOf(b));
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
  return { targets: [...targets.values()].sort((a, b) => depthOf(b.node_id) - depthOf(a.node_id) || (index.get(a.node_id) ?? 0) - (index.get(b.node_id) ?? 0)), unowned };
}

// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
const oneLine = (s: string): string => s.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim();

/** `s` cut to at most `bytes` UTF-8 bytes, marked when cut. */
function cutTo(s: string, bytes: number): string {
  if (Buffer.byteLength(s, 'utf8') <= bytes) return s;
  let out = s;
  while (out.length > 0 && Buffer.byteLength(`${out}...`, 'utf8') > bytes) out = out.slice(0, Math.max(0, out.length - Math.max(1, Math.ceil((Buffer.byteLength(out, 'utf8') - bytes) / 4))));
  return `${out}...`;
}

/**
 * The rework reason a producer is handed for its gaps: the review, its
 * round, each criterion with its kind, what is not proved and the public
 * reproduction, verbatim but on one line and within the rework bound; then
 * what each kind of gap asks for: a new behaviour a focused RED and its fix;
 * a compatibility criterion a regression test that passes on the current
 * code, committed alone as a compatibility-regression unit (a failing one
 * is a RED); a declaration its change and GREEN. Data for the worker, never
 * instructions to it (the worker's brief says what to do with it).
 */
/** One criterion's place in its lineage, as a rework reason names it (engine/review-lineage.ts). */
export interface ReasonBudget {
  used: number;
  max: number;
  ceiling?: number;
  /** `progress`: past its budget, on verified producer progress; `regression`: its completed proof is lost and restored. */
  basis?: 'budget' | 'progress' | 'regression';
}

export function gapReason(args: { reviewId: string; review: number; budgets: Record<string, ReasonBudget>; gaps: Gap[]; kindOf: (criterion: string) => CriterionKind; refinement?: { challenge_id: string; round: number; max: number } }): string {
  const refined = args.refinement === undefined ? '' : `; refined after challenge ${args.refinement.challenge_id}, round ${args.refinement.round} of ${args.refinement.max}`;
  // Each criterion's own accepted-rework budget (engine/review-lineage.ts): this rework is the next of it — past the budget
  // on verified producer progress, up to its ceiling; a restoration of a lost proof spends none of it (CSET-201 final).
  const budget = [...new Set(args.gaps.map((g) => g.criterion))]
    .filter((c) => args.budgets[c] !== undefined)
    .map((c) => {
      const b = args.budgets[c] as ReasonBudget;
      if (b.basis === 'regression') return `${c} restoration (its completed proof is lost; nothing spent)`;
      if (b.basis === 'progress' || b.used + 1 > b.max) return `${c} rework ${b.used + 1} (past its budget of ${b.max}, on verified producer progress; ceiling ${b.ceiling ?? b.max})`;
      return `${c} rework ${b.used + 1} of ${b.max}`;
    })
    .join(', ');
  const head = `Acceptance review ${args.reviewId} (review ${args.review}${budget !== '' ? `, ${budget}` : ''}${refined}) found`;
  const of = (kind: CriterionKind): string => [...new Set(args.gaps.filter((g) => args.kindOf(g.criterion) === kind).map((g) => g.criterion))].join(', ');
  const tail = [
    of('new-behavior') !== '' ? `${of('new-behavior')}: a focused failing test for exactly this first, proved by the red gate on the current code, then the production fix.` : '',
    of('compatibility') !== ''
      ? `${of('compatibility')}: a regression test that passes on the current code, committed alone (test files only, trailer "${COMPATIBILITY_TRAILER}: ${of('compatibility')}") as a compatibility-regression unit, then green and regression; a test that fails there is a RED: the red gate, then the fix.`
      : '',
    of('declaration') !== '' ? `${of('declaration')}: the declaration change alone, proved by the green gate.` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const labels = args.gaps.map((g) => `${g.criterion} (${args.kindOf(g.criterion)}) not proved:`);
  const fixed = Buffer.byteLength([head, ...labels.map((l) => `${l} . Reproduce: .`), tail].join(' '), 'utf8');
  const each = Math.max(40, Math.floor((MAX_REWORK_REASON_BYTES - fixed - 8) / Math.max(1, args.gaps.length * 2)));
  const body = args.gaps.map((g, i) => `${labels[i]} ${cutTo(oneLine(g.missing), each)}. Reproduce: ${cutTo(oneLine(g.reproduction), each)}.`);
  return cutTo([head, ...body, tail].join(' '), MAX_REWORK_REASON_BYTES);
}

// ---- the gate: a current PASS receipt ----------------------------------------

/**
 * The reviews since the last accepted delivery whose reworks were made: informational only (CSET-203 r11). The
 * budget is each criterion's own (engine/review-lineage.ts), never this count.
 */
export function roundsUsed(reviews: readonly ReviewRecord[], since: string | null): number {
  return reviews.filter((r) => r.overall === 'GAPS' && r.reworks_applied && r.reworks.length > 0 && (since === null || r.at > since)).length;
}

/** The nodes of `nodes` with no rework record of review `reviewId` in `state` (none missing: the review's reworks were made). */
export function missingReworks(state: Pick<FeatureState_, 'reworks'>, reviewId: string, nodes: readonly string[]): string[] {
  return nodes.filter((id) => !(state.reworks ?? []).some((r) => r.node_id === id && r.origin?.kind === 'acceptance-review' && r.origin.review_id === reviewId));
}

/** The latest PASS whose inputs are exactly `inputsSha256`. */
export function passFor(reviews: readonly ReviewRecord[], inputsSha256: string): ReviewRecord | null {
  // A PASS that found a completed proof lost (REGRESSION, CSET-201 final) closes nothing.
  return [...reviews].reverse().find((r) => r.overall === 'PASS' && r.outcome !== 'REGRESSION' && r.inputs_sha256 === inputsSha256) ?? null;
}

/** Why a settled review's receipt is not the one STATE.json pins, or null. */
export function receiptProblem(controlRoot: string, record: ReviewRecord): string | null {
  const file = join(controlRoot, ...record.receipt_path.split('/'));
  if (!existsSync(file)) return `${record.receipt_path} is missing`;
  const bytes = readFileSync(file);
  if (sha256(bytes) !== record.receipt_sha256) return `${record.receipt_path} hashes to ${sha256(bytes).slice(0, 12)}, not ${record.receipt_sha256.slice(0, 12)} as STATE.json pins`;
  try {
    const r = JSON.parse(bytes.toString('utf8')) as ReceiptVerdict & { schema?: string; review_id?: string; overall?: string; inputs_sha256?: string; verdict_sha256?: string; canonical_verdict_sha256?: string; normalization?: { original_sha256?: string; canonical_sha256?: string } };
    if (r.schema !== REVIEW_RECEIPT_SCHEMA || r.review_id !== record.review_id || r.overall !== record.overall || r.inputs_sha256 !== record.inputs_sha256) return `${record.receipt_path} does not say what STATE.json records of ${record.review_id}`;
    // A receipt that binds its canonical verdict (every one since CSET-203 r5): the verdict it carries is the one it hashed.
    if (r.canonical_verdict_sha256 !== undefined) {
      const actual = verdictCanonicalSha256(receiptVerdict(r));
      if (actual !== r.canonical_verdict_sha256) return `${record.receipt_path}'s canonical verdict hashes to ${actual.slice(0, 12)}, not ${String(r.canonical_verdict_sha256).slice(0, 12)} as it records: the verdict was changed after it was settled`;
      if (r.normalization?.canonical_sha256 !== r.canonical_verdict_sha256 || r.normalization?.original_sha256 !== r.verdict_sha256) return `${record.receipt_path}'s normalization does not bind its original and canonical verdict hashes`;
    }
  } catch {
    return `${record.receipt_path} is not JSON`;
  }
  return null;
}

interface ReceiptVerdict {
  feature_id?: unknown;
  review_id?: unknown;
  dispatch_id?: unknown;
  inputs_sha256?: unknown;
  reviewer?: { agent?: unknown; model?: unknown };
  criteria?: unknown;
  overall?: unknown;
}

/** The canonical verdict a receipt carries, as judgeVerdict gave it. */
function receiptVerdict(r: ReceiptVerdict): unknown {
  return { schema: REVIEW_VERDICT_SCHEMA, feature_id: r.feature_id, review_id: r.review_id, dispatch_id: r.dispatch_id, inputs_sha256: r.inputs_sha256, reviewer: { agent: r.reviewer?.agent, model: r.reviewer?.model }, criteria: r.criteria, overall: r.overall };
}

/**
 * Every reason the feature has no acceptance review PASS for what it would
 * deliver now (empty when it has one, or needs none): a review blocked
 * (REVIEW_GAPS, REVIEW_INVALID), no PASS at all (REVIEW_REQUIRED), a PASS
 * for other heads, graph or criteria (REVIEW_STALE), a receipt that is not
 * the one STATE.json pins (REVIEW_RECEIPT_TAMPERED), or, given a
 * candidate's repositories, a PASS that does not bind exactly them
 * (REVIEW_NOT_FOR_CANDIDATE).
 */
export function reviewGateProblems(controlRoot: string, featureId: string, options: { candidateRepositories?: Record<string, string> } = {}): string[] {
  const state = loadState(featurePaths(controlRoot, featureId).featureDir)?.data;
  const review = state?.acceptance_review;
  if (state === undefined || review === undefined || review === null || !review.required) return [];
  const problems: string[] = [];
  if (review.blocked !== null) problems.push(`${review.blocked.code}: ${review.blocked.detail}`);
  // The per-criterion lineage (engine/review-lineage.ts): a chain reset or rewritten outside Mycelink binds nothing.
  if (review.blocked?.code !== 'REVIEW_LINEAGE_INVALID') {
    const broken = lineageProblems(review, (rel) => readJsonOrNull(join(controlRoot, ...rel.split('/'))));
    if (broken.length > 0) problems.push(`REVIEW_LINEAGE_INVALID: ${broken.slice(0, 3).join('; ')}`);
  }
  let inputs: ReviewInputs;
  try {
    inputs = currentReviewInputs(controlRoot, featureId, loadWorkspace(controlRoot), loadGraph(controlRoot, featureId), state);
  } catch (err) {
    problems.push(`REVIEW_INPUTS_UNREADABLE: ${err instanceof Error ? err.message : String(err)}`);
    return problems;
  }
  const sha = reviewInputsSha256(inputs);
  const pass = passFor(review.reviews, sha);
  const heads = inputs.repositories.map((r) => `${r.name}@${r.head_sha.slice(0, 12)}`).join(' ');
  if (pass === null) {
    const challenged = (review.challenges ?? []).filter((c) => c.status === 'pending');
    if (review.blocked === null && challenged.length > 0) {
      problems.push(`REVIEW_CHALLENGED: ${challenged.map((c) => `${c.challenge_id} challenges ${c.gaps.map((g) => g.criterion).join(', ')} of ${c.review_id}`).join('; ')}: a worker's focused test of the gap's exact reproduction passed on the unchanged head; dispatch hands a fresh reviewer its refinement`);
      return problems;
    }
    if (review.blocked === null) {
      const last = [...review.reviews].reverse().find((r) => r.overall === 'PASS');
      problems.push(
        last !== undefined
          ? `REVIEW_STALE: the acceptance review PASS ${last.review_id} bound other repository heads, graph or criteria than the feature has now (${heads}); dispatch hands out a new review`
          : `REVIEW_REQUIRED: no acceptance review PASS binds ${heads}; dispatch hands out the review once every product and verification node is DONE`,
      );
    }
    return problems;
  }
  const tampered = receiptProblem(controlRoot, pass);
  if (tampered !== null) problems.push(`REVIEW_RECEIPT_TAMPERED: ${tampered}`);
  // The PASS binds the orchestration epoch it was settled at (state/orchestration.ts; CSET-203 r7): anything that changed
  // what a review binds since — a rework, a challenge, an integration, an invalidation — leaves it binding nothing.
  const epoch = currentEpoch(state);
  if ((pass.epoch ?? 0) !== epoch) {
    const since = (state.orchestration?.bumps ?? []).filter((b) => b.epoch > (pass.epoch ?? 0)).map((b) => b.reason);
    problems.push(`REVIEW_STALE: the acceptance review PASS ${pass.review_id} was settled at orchestration epoch ${pass.epoch ?? 0}; the feature is at epoch ${epoch} (${since.slice(-3).join('; ') || 'later changes'}): it binds nothing now; dispatch hands out a new review once the work in flight has settled`);
  }
  const leased = activeLeases(state, BARRIER_KINDS);
  if (leased.length > 0) {
    problems.push(`REVIEW_BARRIER: dispatch leases outstanding (${leased.map((l) => `${l.node_id ?? l.review_id} ${l.lease_id}`).join(', ')}): no PASS binds a candidate while work that can change what it reviewed is in flight; settle or reconcile them first`);
  }
  const bound = options.candidateRepositories;
  if (bound !== undefined) {
    const names = new Set([...Object.keys(bound), ...inputs.repositories.map((r) => r.name)]);
    const differ = [...names].filter((n) => bound[n] !== inputs.repositories.find((r) => r.name === n)?.head_sha);
    if (differ.length > 0) problems.push(`REVIEW_NOT_FOR_CANDIDATE: the acceptance review PASS ${pass.review_id} bound ${heads}, the candidate binds ${differ.map((n) => `${n}@${String(bound[n] ?? 'nothing').slice(0, 12)}`).join(' ')}`);
  }
  return problems;
}

/** A receipt's SHA-256, as STATE.json pins it. */
export function fileSha256(file: string): string {
  return sha256(readFileSync(file));
}

/** The review id after `reviews` and the open one: `<feature>-R<nnn>`. */
export function nextReviewId(featureId: string, state: FeatureState_): string {
  const used = (state.acceptance_review?.reviews ?? []).map((r) => r.review_id);
  const open = state.acceptance_review?.open?.review_id;
  if (open !== undefined) used.push(open);
  let max = 0;
  for (const id of used) {
    const n = Number.parseInt(id.slice(`${featureId}-R`.length), 10);
    if (Number.isFinite(n)) max = Math.max(max, n);
  }
  return `${featureId}-R${String(max + 1).padStart(3, '0')}`;
}

/** The directory of a review's generation in the scratch area, and its verdict file. */
export function reviewSlot(controlRoot: string, featureId: string, reviewId: string, dispatchId: string): { dir: string; verdict: string; attestation: string } {
  const dir = join(controlRoot, '.mycelink', REVIEWS_DIR, featureId, reviewId, dispatchId);
  return { dir, verdict: join(dir, VERDICT_FILE), attestation: join(dir, ATTESTATION_FILE) };
}

/** `<root>/.mycelink/reviews/<FEATURE-1>/<FEATURE-1-R001>/<uuid>/verdict.json`, as the fence recognises a verdict file. */
export const VERDICT_PATH = /\/\.mycelink\/reviews\/([A-Z][A-Z0-9]*-[0-9]+)\/(\1-R[0-9]{3,})\/([0-9a-f-]{36})\/verdict\.json$/;
