/**
 * A module-worker's challenge of an acceptance review's GAP.
 *
 * CSET-203 r6: R001's AC-1 gap was valid as a hypothesis and apply-release-
 * plan was reworked on it. The rework worker wrote the reviewer's exact
 * public reproductions as focused tests; they passed on the unchanged
 * integrated head, so the red gate said, rightly, "the RED does not fail".
 * The worker answered BLOCKED REVIEW_GAP_NOT_REPRODUCED:AC-1, the node spent
 * its attempts and was parked, and the feature never reached a candidate. A
 * reviewer's hypothesis a faithful, passing reproduction contradicts is
 * review feedback, not a product failure.
 *
 * Here a worker says so, structured (node result outcome
 * REVIEW_GAP_CHALLENGE): the review and the rework's exact reason, each
 * gap's criterion and the SHA-256 of its exact reproduction, the red gate's
 * output that ran the focused tests on the unchanged base, those tests by
 * canonical id, each challenged clause traced to the concrete assertion
 * lines inside a passing focused test, and an explanation. Nothing it says
 * is believed beyond what is checked here, mechanically, against the claim,
 * the red gate's own snapshot of the test files it ran, the review's pinned
 * receipt and the repository: the current generation and claim, the exact
 * brief and receipt, a gate that passed exactly those declared tests on the
 * base the generation started from (the replaced generation's work in it),
 * tests added only (no existing test weakened), no production change and
 * no commit but test-only ones, and every challenged clause backed by an
 * assertion on what the code did. A valid challenge's evidence is archived
 * under the review (features/<f>/reviews/challenges/<id>/); the orchestrator
 * restores the node's DONE generation and hands the gap to a fresh reviewer
 * to refine (engine/acceptance-review.ts judgeRefinement).
 *
 * CSET-203 r15: one red gate ran AC-3's and AC-4's exact reproductions of one
 * order; AC-3's failed (a real gap, fixed test-first) and AC-4's passed. A
 * per-criterion answer (engine/criterion-outcomes.ts) challenges AC-4 alone
 * beside the criteria it proves DONE: its red gate may be any of the claim's
 * (an accepted RED whose other declared tests failed), only the tests it
 * cites must have passed (and never failed in any RED of the claim), and
 * production may change only where a DONE criterion's own RED drives it —
 * no production change is attributable to the challenged criterion alone.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ChallengeRedSnapshot, EvidenceRecord, GraphNode, NodeRuntime, PortfolioGraph, ReviewRecord, TddRedBinding, UnresolvedCriterionRecord } from '../model/types.js';
import type { NodeResult, WorkerChallenge } from '../sessions/adapter.js';
import { isAncestor, runGit } from '../git/git.js';
import { stableStringify } from '../graph/validate.js';
import { checkEvidenceOutput } from '../evidence/paths.js';
import { testTitle } from '../evidence/test-identity.js';
import { writeTextAtomic } from '../state/atomic-json.js';
import { readRegular } from '../security/paths.js';
import { canonicalProse, criterionClauses, receiptProblem, truncateProse, unsafeContent, type Gap, type NormalizedField } from './acceptance-review.js';
import { criterionKind } from './criteria.js';
import { declaredTestTemplates, declaredTests, priorTestChanges, templateMatches, testLanguage, testsInDelta, type DeltaEntry } from './test-declarations.js';
import { isTestPath, type TddPolicy } from './tdd-history.js';
import { capsuleUse, templateWeakening } from './reproduction-capsule.js';

export const REVIEW_CHALLENGE_SCHEMA = 'mycelink-review-challenge/1';
/** Challenge-refinement rounds per review and gap: one more valid challenge of it blocks the review REVIEW_DISPUTE. */
export const MAX_CHALLENGE_ROUNDS = 2;
/** Where challenges are archived: features/<f>/reviews/challenges/<challenge id>/. */
export const CHALLENGES_DIR = 'challenges';
/** Bounds of a challenge's prose, in code points: over them it is cut and marked, never refused. */
export const CHALLENGE_LIMITS = { trace: 600, explanation: 1500 } as const;
/** The failure fingerprint of a refused challenge: `REVIEW_CHALLENGE_INVALID:<what>`. */
export const CHALLENGE_REFUSED = 'REVIEW_CHALLENGE_INVALID';

export type ChallengeCode =
  | 'REVIEW_CHALLENGE_UNSTRUCTURED'
  | 'REVIEW_CHALLENGE_INVALID'
  | 'REVIEW_CHALLENGE_UNSAFE'
  | 'REVIEW_CHALLENGE_NOT_REVIEW_REWORK'
  | 'REVIEW_CHALLENGE_STALE'
  | 'REVIEW_CHALLENGE_CRITERION'
  | 'REVIEW_CHALLENGE_GATE_UNKNOWN'
  | 'REVIEW_CHALLENGE_GATE_NOT_PASSED'
  | 'REVIEW_CHALLENGE_BASE_MOVED'
  | 'REVIEW_CHALLENGE_PRODUCTION'
  | 'REVIEW_CHALLENGE_TESTS_UNBOUND'
  | 'REVIEW_CHALLENGE_TEST_NOT_DECLARED'
  | 'REVIEW_CHALLENGE_TEST_FAILED'
  | 'REVIEW_CHALLENGE_WEAKENS'
  | 'REVIEW_CHALLENGE_CLAUSE_UNKNOWN'
  | 'REVIEW_CHALLENGE_ASSERTION_WEAK'
  | 'REVIEW_CHALLENGE_ASSERTION_OUTSIDE'
  // A gap's reproduction capsule (engine/reproduction-capsule.ts): stale (the controller's state, never charged) or not one.
  | 'REVIEW_CHALLENGE_CAPSULE_STALE'
  | 'REVIEW_CHALLENGE_CAPSULE_INVALID';

export interface ChallengeProblem {
  code: ChallengeCode;
  /** RFC 6901 pointer into the challenge as written. */
  pointer: string;
  detail: string;
}

export type ChallengeRefusal = { ok: false; code: ChallengeCode; detail: string; problems: ChallengeProblem[] };

/** The fingerprint a refused challenge is recorded under: stable per kind of refusal. */
export function challengeFingerprint(code: ChallengeCode): string {
  return `${CHALLENGE_REFUSED}:${code.replace(/^REVIEW_CHALLENGE_/, '')}`;
}

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

/** A reproduction is bound by the SHA-256 of its exact text, as the review's receipt holds it. */
export function reproductionSha256(text: string): string {
  return sha256(text);
}

/** `<review>-C<n>`: the n-th challenge of a review. */
export function challengeId(reviewId: string, n: number): string {
  return `${reviewId}-C${n}`;
}

// ---- the form -----------------------------------------------------------------

const REVIEW_ID = /^[A-Z][A-Z0-9]*-[0-9]+-R[0-9]{3,}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const TEST_ID = /^[0-9a-f]{16}$/;
const CAPSULE_ID = /^CAP-[0-9a-f]{16}$/;
const CRITERION = /^AC-[A-Za-z0-9_.-]{1,60}$/;
const CLAUSE = /^AC-[A-Za-z0-9_.-]{1,60}\.[0-9]{1,3}$/;
const ASSERTION_REF = /^(?:file:([a-z0-9][a-z0-9-]*):)?([^#\s]+)#L(\d{1,7})(?:-L?(\d{1,7}))?$/;

const pointerOf = (...parts: (string | number)[]): string => parts.map((p) => `/${String(p).replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');
const codePoints = (s: string): number => [...s].length;

/**
 * An assertion location: `file:<repository>:<path>#L<a>[-L<b>]` or
 * `<path>#L<a>[-L<b>]`, the path relative and inside the repository. Null
 * when it is not one, names another repository, or leaves it.
 */
export function parseAssertionRef(ref: string, repository: string | null): { path: string; from: number; to: number } | null {
  const m = ASSERTION_REF.exec(ref);
  if (m === null) return null;
  const [, repo, path, a, b] = m as unknown as [string, string | undefined, string, string, string | undefined];
  if (repo !== undefined && repository !== null && repo !== repository) return null;
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.includes('\\') || path.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return null;
  const from = Number(a);
  return { path, from, to: b === undefined ? from : Number(b) };
}

/**
 * A challenge's form alone: exactly its fields, ids and hashes in their form,
 * every assertion a location inside a repository, its prose canonicalised
 * (cut and marked over its bound, never refused for its length) and free of
 * what no field may carry (credentials, Mycelink's authority, embedded
 * instructions, control characters). The canonical challenge, or every
 * problem found, each at its pointer.
 */
export function challengeForm(
  raw: unknown,
  options: { holdsAuthority?: (text: string) => boolean } = {},
): { ok: true; challenge: WorkerChallenge; normalization: { changed: NormalizedField[] } } | ChallengeRefusal {
  const problems: ChallengeProblem[] = [];
  const changed: NormalizedField[] = [];
  const add = (code: ChallengeCode, pointer: string, detail: string): void => {
    problems.push({ code, pointer, detail });
  };
  const object = (value: unknown, at: string, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> | null => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      add('REVIEW_CHALLENGE_INVALID', at || '/', 'is not an object');
      return null;
    }
    const v = value as Record<string, unknown>;
    for (const k of Object.keys(v).filter((k) => !keys.includes(k) && !optional.includes(k))) add('REVIEW_CHALLENGE_INVALID', `${at}${pointerOf(k)}`, `unknown field ${JSON.stringify(k.slice(0, 40))} (expected ${[...keys, ...optional].join(', ')})`);
    for (const k of keys.filter((k) => !(k in v))) add('REVIEW_CHALLENGE_INVALID', `${at}${pointerOf(k)}`, 'is missing');
    return v;
  };
  const id = (value: unknown, at: string, rx: RegExp, what: string): string => {
    if (typeof value !== 'string' || !rx.test(value)) {
      add('REVIEW_CHALLENGE_INVALID', at, `is not ${what}`);
      return '';
    }
    return value;
  };
  const prose = (value: unknown, at: string, limit: number): string => {
    if (typeof value !== 'string') {
      add('REVIEW_CHALLENGE_INVALID', at, 'is not a string');
      return '';
    }
    const unsafe = unsafeContent(value, true, { holdsAuthority: options.holdsAuthority });
    if (unsafe !== null) {
      add('REVIEW_CHALLENGE_UNSAFE', at, `carries ${unsafe.what}`);
      return '';
    }
    const normal = canonicalProse(value);
    if (normal === '') {
      add('REVIEW_CHALLENGE_INVALID', at, 'is empty');
      return '';
    }
    const canonical = truncateProse(normal, limit);
    if (canonical !== value) changed.push({ pointer: at, action: canonical !== normal ? 'truncated' : 'normalized', limit, original_length: codePoints(value), original_sha256: sha256(value), canonical_length: codePoints(canonical) });
    return canonical;
  };
  const list = (value: unknown, at: string, min: number, max: number): unknown[] => {
    if (!Array.isArray(value)) {
      add('REVIEW_CHALLENGE_INVALID', at, 'is not an array');
      return [];
    }
    if (value.length < min || value.length > max) add('REVIEW_CHALLENGE_INVALID', at, `has ${value.length} entries; ${min} to ${max} are allowed`);
    return value.slice(0, max);
  };

  const top = object(raw, '', ['review_id', 'reason_sha256', 'base_sha', 'gate_output_sha256', 'gaps']);
  if (top === null) return refusal(problems);
  const challenge: WorkerChallenge = {
    review_id: id(top['review_id'], '/review_id', REVIEW_ID, 'a review id'),
    reason_sha256: id(top['reason_sha256'], '/reason_sha256', SHA256, 'a SHA-256'),
    base_sha: id(top['base_sha'], '/base_sha', COMMIT, 'a commit'),
    // Null only where every gap cites a reproduction capsule (CSET-203 r17): the capsules' own runs are the gates.
    gate_output_sha256: top['gate_output_sha256'] === null ? null : id(top['gate_output_sha256'], '/gate_output_sha256', SHA256, 'a SHA-256 (or null, every gap citing a capsule)'),
    gaps: [],
  };
  const criteria = new Set<string>();
  const capsules = new Set<string>();
  for (const [g, rawGap] of list(top['gaps'], '/gaps', 1, 8).entries()) {
    const at = pointerOf('gaps', g);
    const gap = object(rawGap, at, ['criterion', 'reproduction_sha256', 'tests', 'clauses', 'explanation'], ['capsule']);
    if (gap === null) continue;
    let capsule: { capsule_id: string; capsule_sha256: string } | undefined;
    if ('capsule' in gap) {
      const k = object(gap['capsule'], `${at}/capsule`, ['capsule_id', 'capsule_sha256']);
      if (k !== null) {
        capsule = { capsule_id: id(k['capsule_id'], `${at}/capsule/capsule_id`, CAPSULE_ID, 'a capsule id (CAP- and 16 hex digits)'), capsule_sha256: id(k['capsule_sha256'], `${at}/capsule/capsule_sha256`, SHA256, 'a SHA-256') };
        if (capsule.capsule_id !== '' && capsules.has(capsule.capsule_id)) add('REVIEW_CHALLENGE_INVALID', `${at}/capsule/capsule_id`, `${capsule.capsule_id} is cited twice: a capsule reproduces one criterion's gap`);
        capsules.add(capsule.capsule_id);
      }
    }
    const criterion = id(gap['criterion'], `${at}/criterion`, CRITERION, 'a criterion id');
    if (criterion !== '' && criteria.has(criterion)) add('REVIEW_CHALLENGE_INVALID', `${at}/criterion`, `${criterion} is challenged twice`);
    criteria.add(criterion);
    const tests = list(gap['tests'], `${at}/tests`, 1, 16).map((t, k) => id(t, `${at}/tests/${k}`, TEST_ID, 'a 16-hex test id'));
    if (new Set(tests).size !== tests.length) add('REVIEW_CHALLENGE_INVALID', `${at}/tests`, 'names a test twice');
    const clauses = list(gap['clauses'], `${at}/clauses`, 0, 16).map((rawClause, k) => {
      const where = `${at}/clauses/${k}`;
      const cl = object(rawClause, where, ['clause', 'test_id', 'assertions', 'trace']);
      if (cl === null) return { clause: '', test_id: '', assertions: [], trace: '' };
      const assertions = list(cl['assertions'], `${where}/assertions`, 1, 8).map((ref, n) => {
        const pointer = `${where}/assertions/${n}`;
        if (typeof ref !== 'string' || parseAssertionRef(ref, null) === null) {
          add('REVIEW_CHALLENGE_INVALID', pointer, 'is not an assertion location <path>#L<a>[-L<b>] (or file:<repository>:<path>#L<a>[-L<b>]) inside the repository');
          return '';
        }
        return ref;
      });
      return { clause: id(cl['clause'], `${where}/clause`, CLAUSE, 'a clause id (AC-n.m)'), test_id: id(cl['test_id'], `${where}/test_id`, TEST_ID, 'a 16-hex test id'), assertions, trace: prose(cl['trace'], `${where}/trace`, CHALLENGE_LIMITS.trace) };
    });
    challenge.gaps.push({
      criterion,
      reproduction_sha256: id(gap['reproduction_sha256'], `${at}/reproduction_sha256`, SHA256, 'a SHA-256'),
      ...(capsule !== undefined ? { capsule } : {}),
      tests,
      clauses,
      explanation: prose(gap['explanation'], `${at}/explanation`, CHALLENGE_LIMITS.explanation),
    });
  }
  if (challenge.gate_output_sha256 === null && challenge.gaps.some((x) => x.capsule === undefined)) {
    add('REVIEW_CHALLENGE_INVALID', '/gate_output_sha256', `is null, but ${challenge.gaps.filter((x) => x.capsule === undefined).map((x) => x.criterion).join(', ')} cites no capsule: name the red gate that passed its focused tests, or seal them as a capsule`);
  }
  if (problems.length > 0) return refusal(problems);
  return { ok: true, challenge, normalization: { changed } };
}

function refusal(problems: ChallengeProblem[]): ChallengeRefusal {
  const first = problems.find((p) => p.code === 'REVIEW_CHALLENGE_UNSAFE') ?? (problems[0] as ChallengeProblem);
  const shown = problems.slice(0, 24);
  const detail = shown.map((p) => `${p.pointer || '/'}: ${p.detail}`).join('; ') + (problems.length > shown.length ? `; and ${problems.length - shown.length} more` : '');
  return { ok: false, code: first.code, detail: detail.slice(0, 4000), problems: shown };
}

// ---- assertions -----------------------------------------------------------------

/** Source with comments blanked out (offsets and line breaks kept), strings kept: a call in a comment asserts nothing. */
function withoutComments(src: string, language: string): string {
  const out = src.split('');
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  const hash = language === 'python';
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (!hash && c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? src.length : end;
      blank(i, stop);
      i = stop;
    } else if (!hash && c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (hash && c === '#') {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? src.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c && (c === '`' || src[j] !== '\n')) j += src[j] === '\\' ? 2 : 1;
      i = j + 1;
    } else i++;
  }
  return out.join('');
}

/** The arguments of the call whose `(` is at `open`, split at top-level commas; null when it does not close. */
function callArguments(text: string, open: number): string[] | null {
  let depth = 0;
  let quote: string | null = null;
  let start = open + 1;
  const args: string[] = [];
  for (let i = open; i < text.length; i++) {
    const c = text[i] as string;
    if (quote !== null) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) {
        args.push(text.slice(start, i));
        return args.map((a) => a.trim()).filter((a, k, all) => a !== '' || all.length > 1);
      }
    } else if (c === ',' && depth === 1) {
      args.push(text.slice(start, i));
      start = i + 1;
    }
  }
  return null;
}

/** A value fixed in the test's own text: it says nothing about what the code did. */
const LITERAL = /^(?:true|false|null|undefined|None|True|False|nil|NaN|-?\d[\d_]*(?:\.\d+)?(?:e-?\d+)?n?|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[^`$]*`|\/(?:[^/\\\n]|\\.)+\/[a-z]*|\[\s*\]|\{\s*\}|\(\s*\))$/;
const isLiteral = (arg: string): boolean => LITERAL.test(arg.trim());

/** The assertion calls of a language, by where their `(` is: [name, open index]. */
function assertionCalls(text: string, language: string): { name: string; open: number }[] {
  const found: { name: string; open: number }[] = [];
  const scan = (rx: RegExp): void => {
    for (let m = rx.exec(text); m !== null; m = rx.exec(text)) found.push({ name: m[1] ?? m[0], open: m.index + m[0].length - 1 });
  };
  if (language === 'js') {
    scan(/(?<![\w$.])(expect(?:\.soft)?)\s*\(/g);
    scan(/(?<![\w$.])(assert(?:\s*\.\s*[A-Za-z]+)?)\s*\(/g);
  } else if (language === 'java') {
    scan(/(?<![\w$])((?:Assertions\.|Assert\.)?assert[A-Z]\w*)\s*\(/g);
  } else if (language === 'csharp') {
    scan(/(?<![\w$])((?:Assert|CollectionAssert|StringAssert)\.[A-Z]\w*)\s*\(/g);
  } else if (language === 'rust') {
    scan(/(?<![\w$])(assert(?:_eq|_ne)?!)\s*\(/g);
  } else if (language === 'go') {
    scan(/(?<![\w$])((?:assert|require)\.[A-Z]\w*|t\.(?:Error|Errorf|Fatal|Fatalf))\s*\(/g);
  } else if (language === 'python') {
    scan(/(?<![\w$.])((?:self\.)?assert[A-Z]\w*|pytest\.raises)\s*\(/g);
  }
  return found;
}

/** Whether one assertion call checks something the code did: its subject (or, failing that, any compared value) is not fixed in the test's text. */
function concreteCall(text: string, call: { name: string; open: number }, language: string): boolean {
  const args = callArguments(text, call.open);
  if (args === null || args.length === 0) return false;
  // expect(<subject>) then a matcher: the subject is what the code produced.
  if (language === 'js' && call.name.startsWith('expect')) return !isLiteral(args[0] as string);
  if (language === 'go' && /^t\./.test(call.name)) return false; // a bare t.Error asserts nothing by itself
  if (/^(?:t\.)?(?:Fail|fail)\b/.test(call.name)) return false;
  // Every other assertion: concrete when some compared value comes from the code.
  const compared = args.slice(0, 2);
  return compared.some((a) => !isLiteral(a));
}

/**
 * Why the lines `from`..`to` of `source` (the test file `path`) do not hold a
 * concrete assertion of the test `test` (its name, or its full name ending
 * `> <name>`), or null when they do. OUTSIDE: the lines are not inside that
 * test's own block (or it is not a test the file declares); WEAK: no
 * assertion there checks what the code did — a constant (`assert.ok(true)`,
 * `expect(1).toEqual(1)`), no assertion at all, or a test that is skipped.
 */
export function assertionProblem(source: string, path: string, test: string, from: number, to: number): 'ASSERTION_OUTSIDE' | 'ASSERTION_WEAK' | null {
  const text = source.replace(/\r\n/g, '\n');
  const declared = declaredTests(path, text);
  const name = testTitle(path, test);
  // A test whose title its run filled in from a template literal (CSET-203 r17) is in the one template block that produces it.
  const hit = declared.find((t) => t.name === test || t.name === name) ?? templateBlock(path, text, name);
  if (hit === undefined) return 'ASSERTION_OUTSIDE';
  const start = text.indexOf(hit.block);
  if (start < 0) return 'ASSERTION_OUTSIDE';
  const firstLine = text.slice(0, start).split('\n').length;
  const lastLine = firstLine + hit.block.split('\n').length - 1;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || from < firstLine || to > lastLine) return 'ASSERTION_OUTSIDE';
  const language = testLanguage(path);
  // A test that is skipped (or only a todo) asserts nothing that ran.
  const head = hit.block.slice(0, 200);
  const before = text.slice(0, start).split('\n').slice(-3).join('\n');
  if (/^\s*(?:x(?:it|test|describe)\b|(?:it|test|describe)\s*\.\s*(?:skip|todo)\b)/.test(head) || /@(?:Disabled|Ignore)\b|@pytest\.mark\.skip|\[Ignore\]|#\[ignore\]/.test(`${before}\n${head}`)) return 'ASSERTION_WEAK';
  const lines = withoutComments(text, language).split('\n');
  const cited = lines.slice(from - 1, to).join('\n');
  // An assertion begun on the cited lines may close after them: read on to the end of the test's block.
  const rest = lines.slice(from - 1, lastLine).join('\n');
  const calls = assertionCalls(cited, language);
  if (language === 'python') {
    for (const m of cited.matchAll(/^\s*assert\s+(.+?)\s*(?:,.*)?$/gm)) {
      const expr = (m[1] as string).trim();
      const sides = expr.split(/\s*(?:==|!=|<=|>=|<|>|\bis not\b|\bis\b|\bnot in\b|\bin\b)\s*/);
      if (!sides.every((x) => isLiteral(x))) return null;
    }
  }
  if (calls.some((call) => concreteCall(rest, call, language))) return null;
  return 'ASSERTION_WEAK';
}

/** The block of the single template-titled test that produces the title `name`; undefined when none or more than one does. */
function templateBlock(path: string, text: string, name: string): { block: string } | undefined {
  const hits = declaredTestTemplates(path, text).filter((t) => templateMatches(t.template, name));
  return hits.length === 1 ? hits[0] : undefined;
}

// ---- reproductions ----------------------------------------------------------------

/** Whether a refined reproduction is materially different from every earlier one (engine/acceptance-review.ts). */
export { materiallyDifferent } from './acceptance-review.js';

// ---- the judgement ----------------------------------------------------------------

/** A test of the challenge, as its red gate ran it. */
export interface ChallengeTest {
  test_id: string;
  path: string;
  full_name: string;
  status: string;
}

/** A reproduction capsule a challenge's gap cites, as judged (engine/reproduction-capsule.ts): what it sealed and ran. */
export interface JudgedCapsule {
  capsule_id: string;
  capsule_sha256: string;
  criterion: string;
  receipt_path: string;
  result: 'passed' | 'failed';
  /** Its files as sealed: each one's blob, the base's blob, its archived copy (relative to the control root) and that copy's SHA-256. */
  files: { path: string; blob: string; base_blob: string | null; copy: string; sha256: string }[];
  run: { output_path: string; output_sha256: string; results_path: string | null; results_sha256: string | null; exit_code: number; commit_sha: string | null };
  artifact: { path: string; sha256: string };
  tests: (ChallengeTest & { block: { from: number; to: number } | null })[];
}

/** A valid challenge, canonical, with everything it was checked against. */
export interface JudgedChallenge {
  challenge: WorkerChallenge;
  challenge_sha256: string;
  normalization: { changed: NormalizedField[] };
  review: ReviewRecord;
  /** The review's gap of each challenged criterion, as its receipt holds it. */
  gaps: Gap[];
  tests: ChallengeTest[];
  files: ChallengeRedSnapshot['files'];
  /** The red gate that ran the gaps citing no capsule; null when every gap cites one (CSET-203 r17). */
  red: EvidenceRecord | null;
  /** The capsules its gaps cite. */
  capsules: JudgedCapsule[];
  base_sha: string;
  head_sha: string;
}

export interface JudgeChallengeArgs {
  controlRoot: string;
  featureId: string;
  graph: PortfolioGraph;
  node: GraphNode;
  runtime: NodeRuntime;
  result: NodeResult;
  repoPath: string;
  repository: string;
  /** The head of the node's worker branch. */
  head: string;
  policy: TddPolicy;
  /** The feature's settled reviews (STATE.json). */
  reviews: readonly ReviewRecord[];
  /** Approved criteria texts: the manifest's, else the graph's. */
  criteria: readonly { id: string; text: string }[];
  holdsAuthority?: (text: string) => boolean;
  /**
   * A per-criterion answer's challenge (engine/criterion-outcomes.ts): beside the criteria the same answer proves DONE.
   * Absent: a challenge of the whole answer, which changes no production code at all.
   */
  answer?: CriteriaChallengeContext | null;
}

/** What a per-criterion answer's challenge is judged beside: the same answer's DONE criteria and the claim's REDs. */
export interface CriteriaChallengeContext {
  /** The criteria the answer proves DONE, the tests their RED proofs name, and every test it names for one of them. */
  done: string[];
  doneRedTests: string[];
  doneTests: string[];
  /** The judged history's cycles (engine/tdd-history.ts): each production change and the RED binding it follows. */
  cycles: readonly { green_commits: readonly string[]; red_binding: { evidence_sha256: string | null } | null }[];
  /** The claim's RED bindings: a test any of them failed is a RED, never a challenge. */
  bindings: readonly TddRedBinding[];
}

/** The red gate a snapshot kept its own copies of, as an evidence record (its output and results where the snapshot copied them). */
function snapshotGate(nodeId: string, snapshot: ChallengeRedSnapshot): EvidenceRecord | undefined {
  const g = snapshot.gate;
  if (g === undefined) return undefined;
  return {
    kind: 'red',
    node_id: nodeId,
    command: [],
    exit_code: g.exit_code,
    started_at: snapshot.recorded_at,
    finished_at: snapshot.recorded_at,
    cwd: '',
    repository: null,
    commit_sha: g.commit_sha,
    output_path: g.output_path,
    output_sha256: g.output_sha256,
    failure_fingerprint: null,
    ...(g.red_category !== null ? { red_category: g.red_category as NonNullable<EvidenceRecord['red_category']> } : {}),
    ...(g.module_sha256 !== null ? { module_sha256: g.module_sha256 } : {}),
    ...(g.plan_sha256 !== null ? { plan_sha256: g.plan_sha256 } : {}),
    ...(g.results_path !== null && g.results_sha256 !== null ? { results: { path: g.results_path, sha256: g.results_sha256 } as unknown as NonNullable<EvidenceRecord['results']> } : {}),
  };
}

/** The contents of `path` at `rev`, or null when it has none. */
function contentAt(repoPath: string, rev: string, path: string): string | null {
  const r = runGit(repoPath, ['show', `${rev}:${path}`], { allowFail: true });
  return r.exitCode === 0 ? r.stdout : null;
}

/** Paths changed between two commits. */
function changedBetween(repoPath: string, from: string, to: string): string[] {
  if (from === to) return [];
  return runGit(repoPath, ['diff', '--name-only', '-z', '--no-renames', from, to]).stdout.split('\0').filter((p) => p !== '');
}

/**
 * Judge a worker's REVIEW_GAP_CHALLENGE against the claim it answers, the red
 * gate's snapshot of what it ran, the review's pinned receipt and the
 * repository. The canonical challenge with what it was checked against, or
 * the first refusal with every problem found.
 */
export function judgeChallenge(args: JudgeChallengeArgs): ({ ok: true } & JudgedChallenge) | ChallengeRefusal {
  const fail = (code: ChallengeCode, pointer: string, detail: string): ChallengeRefusal => ({ ok: false, code, detail, problems: [{ code, pointer, detail }] });
  const { runtime, result } = args;
  // A per-criterion answer (outcome CRITERIA) carries the challenge of its REVIEW_GAP_CHALLENGE criteria.
  if ((result.outcome !== 'REVIEW_GAP_CHALLENGE' && !(result.outcome === 'CRITERIA' && (args.answer ?? null) !== null)) || result.challenge === undefined) {
    return fail('REVIEW_CHALLENGE_UNSTRUCTURED', '', `${result.outcome} ${result.failure_fingerprint ?? ''}`.trim() + ': a review gap whose exact reproduction passes is challenged with outcome REVIEW_GAP_CHALLENGE and its structured challenge (review, reason, reproduction hash, the red gate output or the reproduction capsule, the focused tests, each clause traced to its assertions, an explanation): the challenge line prints what it binds');
  }
  const form = challengeForm(result.challenge, { holdsAuthority: args.holdsAuthority });
  if (!form.ok) return form;
  const c = form.challenge;
  const brief = runtime.rework_brief ?? null;
  const claim = runtime.claim;
  if (brief === null || brief.origin?.kind !== 'acceptance-review' || claim === null) {
    return fail('REVIEW_CHALLENGE_NOT_REVIEW_REWORK', '', `${args.node.id} is not in an acceptance review's rework: only a review's gap is challenged, by the worker of the rework it ordered`);
  }
  // The exact review, its exact rework reason, its pinned receipt.
  if (c.review_id !== brief.origin.review_id) return fail('REVIEW_CHALLENGE_STALE', '/review_id', `this rework was ordered by ${brief.origin.review_id}, not ${c.review_id}`);
  if (c.reason_sha256 !== brief.reason_sha256) return fail('REVIEW_CHALLENGE_STALE', '/reason_sha256', `is not the SHA-256 of this rework's exact reason (${brief.reason_sha256.slice(0, 12)}): the pack's rework.reason_sha256`);
  const record = [...args.reviews].reverse().find((r) => r.review_id === c.review_id);
  if (record === undefined || !brief.evidence.includes(record.receipt_path)) return fail('REVIEW_CHALLENGE_STALE', '/review_id', `${c.review_id}'s receipt is not the one this rework was ordered with`);
  // An order bound to a revision of its review (engine/review-revision.ts): exactly the current one, by hash.
  if (brief.origin.receipt_sha256 !== undefined && (brief.origin.receipt_sha256 !== record.receipt_sha256 || brief.origin.receipt_path !== record.receipt_path)) {
    return fail('REVIEW_CHALLENGE_STALE', '/review_id', `this rework is bound to revision ${brief.origin.revision ?? 0} of ${c.review_id} (${brief.origin.receipt_sha256.slice(0, 12)}), not its current receipt ${record.receipt_sha256.slice(0, 12)}`);
  }
  const tampered = receiptProblem(args.controlRoot, record);
  if (tampered !== null) return fail('REVIEW_CHALLENGE_STALE', '/review_id', `${c.review_id}: ${tampered}`);
  let receipt: { gaps?: Gap[] };
  try {
    receipt = JSON.parse(readFileSync(join(args.controlRoot, ...record.receipt_path.split('/')), 'utf8')) as { gaps?: Gap[] };
  } catch {
    return fail('REVIEW_CHALLENGE_STALE', '/review_id', `${record.receipt_path} cannot be read`);
  }
  const gaps: Gap[] = [];
  for (const [g, gap] of c.gaps.entries()) {
    const at = pointerOf('gaps', g);
    if (!brief.acceptance_criteria.includes(gap.criterion)) return fail('REVIEW_CHALLENGE_CRITERION', `${at}/criterion`, `${gap.criterion} is not a criterion of this rework (${brief.acceptance_criteria.join(', ')})`);
    if (criterionKind(args.graph, gap.criterion) !== 'new-behavior') {
      return fail('REVIEW_CHALLENGE_CRITERION', `${at}/criterion`, `${gap.criterion} is a ${criterionKind(args.graph, gap.criterion)} criterion: its gap's test is expected to pass and is committed as a compatibility-regression unit, never challenged`);
    }
    const found = (receipt.gaps ?? []).find((x) => x.criterion === gap.criterion);
    const bound = brief.review_gaps?.find((x) => x.criterion === gap.criterion)?.reproduction_sha256 ?? (found !== undefined ? reproductionSha256(found.reproduction) : null);
    if (found === undefined || bound === null || reproductionSha256(found.reproduction) !== bound || gap.reproduction_sha256 !== bound) {
      return fail('REVIEW_CHALLENGE_STALE', `${at}/reproduction_sha256`, `is not the SHA-256 of ${c.review_id}'s exact reproduction of ${gap.criterion} (the pack's rework.review_gaps)`);
    }
    gaps.push(found);
  }
  const answer = args.answer ?? null;
  // On the base this generation started from, the replaced generation's work in it.
  const base = claim.base_sha ?? runtime.branch_base_sha ?? null;
  if (base === null || c.base_sha !== base) return fail('REVIEW_CHALLENGE_STALE', '/base_sha', `is not the commit this claim's branch started from (${String(base).slice(0, 12)})`);

  // Each capsule a gap cites (engine/reproduction-capsule.ts; CSET-203 r17): this claim's, sealed for this generation, base,
  // module and order revision, for the gap's criterion, intact, and passing. Stale is the controller's state (administrative);
  // anything else fails closed.
  const capsules: JudgedCapsule[] = [];
  for (const [g, gap] of c.gaps.entries()) {
    if (gap.capsule === undefined) continue;
    const at = `${pointerOf('gaps', g)}/capsule`;
    const used = capsuleUse({ controlRoot: args.controlRoot, featureId: args.featureId, nodeId: args.node.id, runtime, capsuleId: gap.capsule.capsule_id, capsuleSha256: gap.capsule.capsule_sha256, criterion: gap.criterion, want: 'passed' });
    if (!used.ok) {
      if (used.administrative) return fail('REVIEW_CHALLENGE_CAPSULE_STALE', at, `${used.code}: ${used.detail}`);
      if (used.code === 'CAPSULE_FAILED') return fail('REVIEW_CHALLENGE_GATE_NOT_PASSED', at, `${used.code}: ${used.detail}`);
      return fail('REVIEW_CHALLENGE_CAPSULE_INVALID', at, `${used.code}: ${used.detail}`);
    }
    const k = used.capsule;
    capsules.push({
      capsule_id: k.capsule_id,
      capsule_sha256: used.capsule_sha256,
      criterion: k.criterion,
      receipt_path: used.entry.receipt_path,
      result: k.result,
      files: k.files.map((f) => ({ path: f.path, blob: f.blob, base_blob: f.base_blob, copy: f.archived, sha256: f.sha256 })),
      run: { output_path: k.run.output_path, output_sha256: k.run.output_sha256, results_path: k.run.results_path, results_sha256: k.run.results_sha256, exit_code: k.run.exit_code, commit_sha: k.run.commit_sha },
      artifact: { ...k.artifact },
      tests: k.tests.map((t) => ({ test_id: t.id, path: t.path, full_name: t.full_name, status: t.status, block: t.block })),
    });
  }

  // The red gate that ran the gaps that cite no capsule, and its own snapshot of them: the claim's last red gate whose
  // declared tests all passed — or, beside DONE criteria of the same answer, any red gate of the claim that passed the tests
  // it cites.
  const gated = c.gaps.some((gap) => gap.capsule === undefined);
  let snapshot: ChallengeRedSnapshot | null = null;
  let red: EvidenceRecord | null = null;
  if (gated) {
    const gateSha = c.gate_output_sha256 as string;
    snapshot =
      answer === null
        ? (claim.challenge_red ?? null)
        : ([...(claim.challenge_reds ?? []), ...(claim.challenge_red ? [claim.challenge_red] : [])].find((x) => x.evidence_sha256 === gateSha) ?? null);
    // The gate's own copy, beside DONE criteria or once the node's RED is not that run's any more (a refused run never displaces
    // the generation's RED: engine/criterion-ledger.ts, CSET-203 r16).
    red = (snapshot !== null && snapshot.gate !== undefined && (answer !== null || runtime.evidence.red?.output_sha256 !== snapshot.evidence_sha256) ? snapshotGate(args.node.id, snapshot) : runtime.evidence.red) ?? null;
    if (red === null || snapshot === null || red.output_sha256 !== gateSha || snapshot.evidence_sha256 !== gateSha) {
      return fail('REVIEW_CHALLENGE_GATE_UNKNOWN', '/gate_output_sha256', `${gateSha.slice(0, 12)} is not the output of ${answer === null ? "this claim's last red gate whose declared tests all passed" : 'a red gate of this claim that passed a declared test'}; run the red gate on the focused tests, then the challenge line — or, when no gate can name their tests, seal them as a capsule (tdd capsule) and cite it`);
    }
    const bound = claim.verification;
    if (bound !== undefined && (red.module_sha256 !== bound.module_sha256 || red.plan_sha256 !== bound.plan_sha256)) {
      return fail('REVIEW_CHALLENGE_GATE_UNKNOWN', '/gate_output_sha256', `the red gate ran another command than module ${bound.module}'s the claim binds`);
    }
    const output = checkEvidenceOutput(args.controlRoot, args.featureId, red);
    if (output !== null) return fail('REVIEW_CHALLENGE_GATE_UNKNOWN', '/gate_output_sha256', output);
    if (answer === null && (red.exit_code !== 0 || red.red_category !== 'passed' || snapshot.red_tests.length === 0 || snapshot.red_tests.some((t) => t.status !== 'passed'))) {
      return fail('REVIEW_CHALLENGE_GATE_NOT_PASSED', '/gate_output_sha256', `the red gate did not pass every test it declared (exit ${red.exit_code}, ${red.red_category ?? 'unclassified'}): a challenge is a reproduction that passes as written; one that fails is a RED`);
    }
  } else if (c.gate_output_sha256 !== null && !capsules.some((k) => k.run.output_sha256 === c.gate_output_sha256)) {
    return fail('REVIEW_CHALLENGE_GATE_UNKNOWN', '/gate_output_sha256', `every gap cites a capsule: name null here (or one of the capsules' own run outputs), not ${c.gate_output_sha256.slice(0, 12)}`);
  }
  const replaced = brief.replaced.integrated_sha;
  if (replaced !== null && !isAncestor(args.repoPath, replaced, base)) {
    return fail('REVIEW_CHALLENGE_BASE_MOVED', '/base_sha', `${base.slice(0, 12)} does not hold ${replaced.slice(0, 12)}, the integrated work the review judged`);
  }
  if (result.commit_sha !== args.head) return fail('REVIEW_CHALLENGE_STALE', '', `the result's commit_sha ${String(result.commit_sha).slice(0, 12)} is not the head of the node's branch, ${args.head.slice(0, 12)}`);
  if (!isAncestor(args.repoPath, base, args.head)) return fail('REVIEW_CHALLENGE_BASE_MOVED', '/base_sha', `the node's branch at ${args.head.slice(0, 12)} no longer holds its base ${base.slice(0, 12)}`);
  const committed = changedBetween(args.repoPath, base, args.head);
  const production = committed.filter((p) => !isTestPath(args.policy, p));
  if (production.length > 0 && answer === null) {
    return fail('REVIEW_CHALLENGE_PRODUCTION', '', `the branch changes production since its base (${production.slice(0, 10).join(', ')}): a challenge changes no production code and commits nothing but its focused tests`);
  }
  if (production.length > 0 && answer !== null) {
    // Every production change follows a RED that failed a test a DONE criterion of this answer is proved by: none is the
    // challenged criterion's alone.
    const driven = (cycle: CriteriaChallengeContext['cycles'][number]): boolean => {
      const binding = answer.bindings.find((b) => b.evidence_sha256 !== null && b.evidence_sha256 === (cycle.red_binding?.evidence_sha256 ?? null));
      return (binding?.red_tests ?? []).some((t) => t.status === 'failed' && answer.doneRedTests.includes(t.id));
    };
    const undriven = answer.cycles.find((cycle) => cycle.green_commits.length > 0 && !driven(cycle));
    if (answer.doneRedTests.length === 0 || undriven !== undefined) {
      const where = undriven !== undefined ? `the production commit ${String(undriven.green_commits[0]).slice(0, 12)} follows a RED none of whose failing tests proves a criterion this answer proves DONE` : `it changes production (${production.slice(0, 10).join(', ')}) and proves no criterion DONE by a RED`;
      return fail('REVIEW_CHALLENGE_PRODUCTION', '', `${where}: a production change only the challenged criterion could need is never part of a challenge — its gap reproduces, so it is a RED, fixed test-first`);
    }
  }
  if (red !== null) {
    const redOnBase = red.commit_sha === base || (red.commit_sha !== null && isAncestor(args.repoPath, base, red.commit_sha) && isAncestor(args.repoPath, red.commit_sha, args.head) && changedBetween(args.repoPath, base, red.commit_sha).every((p) => isTestPath(args.policy, p)));
    if (!redOnBase) {
      return fail('REVIEW_CHALLENGE_BASE_MOVED', '/gate_output_sha256', `the red gate ran at ${String(red.commit_sha).slice(0, 12)}, not on the branch's base or a test-only commit on it`);
    }
  }
  // The test files are what the gate (or each capsule's run) ran: their copies intact, a committed one byte for byte the same.
  const files: ChallengeRedSnapshot['files'] = [];
  const kept: { path: string; blob: string | null; copy: string; sha256: string }[] = [];
  for (const f of snapshot?.files ?? []) {
    const copy = join(args.controlRoot, ...f.copy.split('/'));
    if (!existsSync(copy) || sha256(readFileSync(copy)) !== f.sha256) return fail('REVIEW_CHALLENGE_TESTS_UNBOUND', '', `the red gate's copy of ${f.path} is missing or changed`);
    files.push({ ...f });
    kept.push({ path: f.path, blob: f.blob, copy: f.copy, sha256: f.sha256 });
  }
  for (const k of capsules) {
    for (const f of k.files) {
      const other = kept.find((x) => x.path === f.path);
      if (other !== undefined && other.sha256 !== f.sha256) return fail('REVIEW_CHALLENGE_CAPSULE_INVALID', '', `${f.path} is reproduced twice, with different bytes (${k.capsule_id} and another reproduction of this challenge): one file, one reproduction`);
      if (other !== undefined) continue;
      files.push({ path: f.path, blob: f.blob, copy: f.copy, sha256: f.sha256 });
      kept.push({ path: f.path, blob: f.blob, copy: f.copy, sha256: f.sha256 });
    }
  }
  const blobAt = (path: string): string | null => {
    const blob = runGit(args.repoPath, ['rev-parse', `${args.head}:${path}`], { allowFail: true });
    return blob.exitCode === 0 ? blob.stdout.trim() : null;
  };
  const baseBlobOf = (path: string): string | null => {
    const atBase = runGit(args.repoPath, ['rev-parse', '--verify', '--quiet', `${base}:${path}`], { allowFail: true });
    return atBase.exitCode === 0 ? atBase.stdout.trim() : null;
  };
  const ranTests = [...(snapshot?.tests ?? []).map((t) => ({ path: t.path, blob: t.blob })), ...capsules.flatMap((k) => k.files.map((f) => ({ path: f.path, blob: f.blob as string | null })))];
  if (answer === null) {
    for (const path of committed) {
      const ran = ranTests.find((t) => t.path === path);
      if (ran === undefined || ran.blob !== blobAt(path)) return fail('REVIEW_CHALLENGE_TESTS_UNBOUND', '', `${path} is committed otherwise than the red gate (or the capsule) ran it: commit exactly the focused tests it ran — or keep them out of the branch, sealed — or run red again`);
    }
  } else {
    // Beside DONE work the branch holds other commits; the files the challenge's reproductions ran are what the head holds, or
    // kept out of the branch — absent when new, exactly as the base holds them otherwise (CSET-203 r16): the gate's (or the
    // capsule's) own copy is the challenge's evidence, and nothing of it is integrated.
    for (const t of ranTests) {
      const now = blobAt(t.path);
      const baseBlob = baseBlobOf(t.path);
      if (now !== null && now !== t.blob && now !== baseBlob) {
        return fail('REVIEW_CHALLENGE_TESTS_UNBOUND', '', `${t.path} is at the head otherwise than its reproduction ran it: keep the focused tests exactly as they passed (committed, or out of the branch as the base holds the file), or run them again`);
      }
      if (now === null && baseBlob !== null) {
        return fail('REVIEW_CHALLENGE_TESTS_UNBOUND', '', `${t.path} is removed at the head: keep the focused tests exactly as they passed (committed, or out of the branch as the base holds the file), or run them again`);
      }
    }
  }
  // Tests added only: nothing that was there is removed, edited or deleted.
  const sourceOf = (path: string): string | null => {
    const file = kept.find((f) => f.path === path);
    return file === undefined ? null : readFileSync(join(args.controlRoot, ...file.copy.split('/')), 'utf8');
  };
  const entries: DeltaEntry[] = [
    ...(snapshot?.tests ?? []).map((t) => ({ path: t.path, before: contentAt(args.repoPath, base, t.path), after: t.blob === null ? null : sourceOf(t.path) })),
    ...capsules.flatMap((k) => k.files.filter((f) => !(snapshot?.tests ?? []).some((t) => t.path === f.path)).map((f) => ({ path: f.path, before: contentAt(args.repoPath, base, f.path), after: sourceOf(f.path) }))),
  ];
  const prior = priorTestChanges(entries);
  const weakened = [
    ...prior.removed.map((t) => `removes ${t.file} › ${t.name}`),
    ...prior.edited.map((t) => `edits ${t.file} › ${t.name}`),
    ...prior.deleted.map((p) => `deletes ${p}`),
    ...prior.data.map((p) => `changes the existing test data ${p}`),
    ...prior.opaque.map((p) => `changes test code Mycelink cannot read (${p})`),
    ...templateWeakening(entries.filter((e) => e.before !== null && e.after !== null && capsules.some((k) => k.files.some((f) => f.path === e.path))).map((e) => ({ path: e.path, before: e.before as string, after: e.after as string }))),
  ];
  if (weakened.length > 0) return fail('REVIEW_CHALLENGE_WEAKENS', '', `the challenge's tests ${weakened.slice(0, 8).join('; ')}: a challenge only adds the focused tests of the reproduction, never weakens one that was there`);
  const declared = testsInDelta(entries.filter((e) => (snapshot?.tests ?? []).some((t) => t.path === e.path))).declared;
  const tests: ChallengeTest[] = [];
  const clausesOf = new Map(args.criteria.map((x) => [x.id, criterionClauses(x.id, x.text)]));
  for (const [g, gap] of c.gaps.entries()) {
    const at = pointerOf('gaps', g);
    const k = gap.capsule === undefined ? null : (capsules.find((x) => x.capsule_id === gap.capsule?.capsule_id) as JudgedCapsule);
    // A gap's focused tests: its capsule's passing tests, else the red gate's declared ones that passed.
    const ofGap = (testId: string): ChallengeTest | undefined => (k !== null ? k.tests.find((x) => x.test_id === testId) : snapshot?.red_tests.map((x) => ({ test_id: x.id, path: x.path, full_name: x.full_name, status: x.status })).find((x) => x.test_id === testId));
    for (const [n, testId] of gap.tests.entries()) {
      const t = ofGap(testId);
      const name = t === undefined ? '' : testTitle(t.path, t.full_name);
      const isOwn = t !== undefined && t.status === 'passed' && (k !== null || declared.some((d) => d.file === t.path && (d.name === t.full_name || d.name === name)));
      if (!isOwn) {
        return fail('REVIEW_CHALLENGE_TEST_NOT_DECLARED', `${at}/tests/${n}`, `${testId} is not a test ${k !== null ? `capsule ${k.capsule_id} ran and passed` : "the red gate's RED declared (added or changed) and passed"}: a challenge cites its own focused tests`);
      }
      if (answer !== null && answer.doneTests.includes(testId)) {
        return fail('REVIEW_CHALLENGE_TEST_NOT_DECLARED', `${at}/tests/${n}`, `${testId} is also named as the proof of a criterion this answer proves DONE: a challenge's passing test is never another criterion's proof`);
      }
      // A failed criterion is never challenged: a test any RED of this claim failed is a RED, fixed test-first.
      if (answer !== null && answer.bindings.some((b) => (b.red_tests ?? []).some((x) => x.id === testId && x.status === 'failed'))) {
        return fail('REVIEW_CHALLENGE_TEST_FAILED', `${at}/tests/${n}`, `${testId} failed in a red gate of this claim: its gap reproduces, so it is a RED, fixed test-first, never a challenge`);
      }
      if (!tests.some((x) => x.test_id === testId)) tests.push({ test_id: t.test_id, path: t.path, full_name: t.full_name, status: t.status });
    }
    if (gap.clauses.length === 0) return fail('REVIEW_CHALLENGE_CLAUSE_UNKNOWN', `${at}/clauses`, `trace each clause of ${gap.criterion} the reproduction proves to its assertion lines`);
    const known = clausesOf.get(gap.criterion) ?? [];
    for (const [n, cl] of gap.clauses.entries()) {
      const where = `${at}/clauses/${n}`;
      if (!known.some((x) => x.id === cl.clause)) return fail('REVIEW_CHALLENGE_CLAUSE_UNKNOWN', `${where}/clause`, `${cl.clause} is not one of ${gap.criterion}'s clauses (${known.map((x) => x.id).join(', ')})`);
      const t = ofGap(cl.test_id);
      if (!gap.tests.includes(cl.test_id) || t === undefined) return fail('REVIEW_CHALLENGE_TEST_NOT_DECLARED', `${where}/test_id`, `${cl.test_id} is not one of this gap's focused tests`);
      for (const [m, ref] of cl.assertions.entries()) {
        const loc = parseAssertionRef(ref, args.repository);
        const file = k !== null ? k.files.find((f) => f.path === loc?.path) : files.find((f) => f.path === loc?.path);
        if (loc === null || loc.path !== t.path || file === undefined) {
          return fail('REVIEW_CHALLENGE_ASSERTION_OUTSIDE', `${where}/assertions/${m}`, `${ref} is not a location in ${t.path}, the file of ${cl.test_id}`);
        }
        const source = readFileSync(join(args.controlRoot, ...file.copy.split('/')), 'utf8');
        const problem = assertionProblem(source, t.path, t.full_name, loc.from, loc.to);
        if (problem === 'ASSERTION_OUTSIDE') return fail('REVIEW_CHALLENGE_ASSERTION_OUTSIDE', `${where}/assertions/${m}`, `${ref} is not inside ${t.full_name}'s own block`);
        if (problem === 'ASSERTION_WEAK') return fail('REVIEW_CHALLENGE_ASSERTION_WEAK', `${where}/assertions/${m}`, `${ref} holds no assertion on what the code did (a constant, or no assertion): ${cl.clause} needs a concrete one`);
      }
    }
  }
  return {
    ok: true,
    challenge: c,
    challenge_sha256: sha256(stableStringify(c)),
    normalization: form.normalization,
    review: record,
    gaps,
    tests,
    files: files.map((f) => ({ ...f })),
    red,
    capsules,
    base_sha: base,
    head_sha: args.head,
  };
}

// ---- the archive ----------------------------------------------------------------

/** The directory a challenge's evidence is archived in, relative to the control root. */
export function challengeDir(featureId: string, id: string): string {
  return `features/${featureId}/reviews/${CHALLENGES_DIR}/${id}`;
}

/**
 * Archive a valid challenge's evidence under its review, idempotently: the
 * red gate's output and results, each focused test file as it ran, and the
 * receipt that binds them (challenge.json). Returns the receipt's path,
 * relative to the control root, and its SHA-256.
 */
export function archiveChallenge(args: {
  controlRoot: string;
  featureId: string;
  id: string;
  judged: JudgedChallenge;
  nodeId: string;
  claimId: string;
  dispatchId: string | null;
  generation: number;
  rounds: Record<string, number>;
  reasonSha256: string;
  /** A per-criterion answer's challenge: the order's criteria the same answer proved DONE, and those it left unresolved. */
  partial?: { done: string[]; unresolved: UnresolvedCriterionRecord[] } | null;
}): { receipt_path: string; receipt_sha256: string; files: { path: string; archived: string; sha256: string }[]; gate: { output_path: string; output_sha256: string; results_path: string | null; results_sha256: string | null } } {
  const { controlRoot, judged } = args;
  const rel = challengeDir(args.featureId, args.id);
  const dir = join(controlRoot, ...rel.split('/'));
  mkdirSync(join(dir, 'gate'), { recursive: true });
  const copy = (from: string, to: string): string => {
    const bytes = readFileSync(join(controlRoot, ...from.split('/')));
    const target = join(dir, ...to.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    // What is there is read through one descriptor; a copy is replaced atomically, never written through a link.
    const current = readRegular(target)?.bytes ?? null;
    if (current === null || sha256(current) !== sha256(bytes)) writeTextAtomic(target, bytes);
    return sha256(bytes);
  };
  // The red gate's output and results — or, every gap citing a capsule (CSET-203 r17), the first capsule's run's; each
  // capsule's run and its reviewer's artifact beside them, its files with the challenge's.
  const red = judged.red;
  const firstCapsule = judged.capsules[0] ?? null;
  const gateName = red !== null ? 'red' : `capsule-${firstCapsule?.capsule_id ?? 'none'}`;
  const outputSha = red !== null ? copy(red.output_path, 'gate/red.log') : copy((firstCapsule as JudgedCapsule).run.output_path, `gate/${gateName}.log`);
  const resultsSha = red !== null ? (red.results ? copy(red.results.path, 'gate/red.results.json') : null) : (firstCapsule as JudgedCapsule).run.results_path !== null ? copy((firstCapsule as JudgedCapsule).run.results_path as string, `gate/${gateName}.results.json`) : null;
  const files = judged.files.map((f) => ({ path: f.path, archived: `${rel}/files/${f.path}`, sha256: copy(f.copy, `files/${f.path}`), blob: f.blob }));
  const capsules = judged.capsules.map((k) => {
    const log = copy(k.run.output_path, `gate/capsule-${k.capsule_id}.log`);
    const results = k.run.results_path !== null ? copy(k.run.results_path, `gate/capsule-${k.capsule_id}.results.json`) : null;
    const artifact = copy(k.artifact.path, `capsules/${k.capsule_id}.artifact.txt`);
    return {
      capsule_id: k.capsule_id,
      capsule_sha256: k.capsule_sha256,
      criterion: k.criterion,
      result: k.result,
      receipt_path: k.receipt_path,
      artifact: `${rel}/capsules/${k.capsule_id}.artifact.txt`,
      artifact_sha256: artifact,
      gate: { output_path: `${rel}/gate/capsule-${k.capsule_id}.log`, output_sha256: log, results_path: results === null ? null : `${rel}/gate/capsule-${k.capsule_id}.results.json`, results_sha256: results, exit_code: k.run.exit_code, commit_sha: k.run.commit_sha, recorded_output_sha256: k.run.output_sha256 },
      files: k.files.map((f) => ({ path: f.path, blob: f.blob, base_blob: f.base_blob, sha256: f.sha256, archived: `${rel}/files/${f.path}` })),
      tests: k.tests.map((t) => ({ test_id: t.test_id, path: t.path, full_name: t.full_name, status: t.status, block: t.block })),
    };
  });
  const receipt = {
    schema: REVIEW_CHALLENGE_SCHEMA,
    feature_id: args.featureId,
    challenge_id: args.id,
    review_id: judged.review.review_id,
    node_id: args.nodeId,
    claim_id: args.claimId,
    dispatch_id: args.dispatchId,
    generation: args.generation,
    review_receipt: { path: judged.review.receipt_path, sha256: judged.review.receipt_sha256 },
    reason_sha256: args.reasonSha256,
    base_sha: judged.base_sha,
    head_sha: judged.head_sha,
    gate: {
      kind: red !== null ? 'red' : 'capsule',
      output_path: `${rel}/gate/${gateName}.log`,
      output_sha256: outputSha,
      results_path: resultsSha === null ? null : `${rel}/gate/${gateName}.results.json`,
      results_sha256: resultsSha,
      exit_code: red !== null ? red.exit_code : (firstCapsule as JudgedCapsule).run.exit_code,
      commit_sha: red !== null ? red.commit_sha : (firstCapsule as JudgedCapsule).run.commit_sha,
      recorded_output_sha256: red !== null ? red.output_sha256 : (firstCapsule as JudgedCapsule).run.output_sha256,
    },
    ...(capsules.length > 0 ? { capsules } : {}),
    tests: judged.tests,
    files: files.map((f) => ({ path: f.path, blob: f.blob, sha256: f.sha256, archived: f.archived })),
    gaps: judged.challenge.gaps.map((g) => {
      const gap = judged.gaps.find((x) => x.criterion === g.criterion) as Gap;
      return { criterion: g.criterion, round: args.rounds[g.criterion] ?? 1, missing: gap.missing, reproduction: gap.reproduction, reproduction_sha256: g.reproduction_sha256, ...(g.capsule !== undefined ? { capsule: { ...g.capsule } } : {}), tests: g.tests, clauses: g.clauses, explanation: g.explanation };
    }),
    challenge_sha256: judged.challenge_sha256,
    normalization: judged.normalization,
    ...(args.partial !== undefined && args.partial !== null ? { partial: { done: [...args.partial.done], unresolved: args.partial.unresolved.map((u) => ({ criterion: u.criterion, outcome: u.outcome, reason: u.reason })) } } : {}),
  };
  const file = join(dir, 'challenge.json');
  const body = JSON.stringify(receipt, null, 2) + '\n';
  if (!existsSync(file) || readFileSync(file, 'utf8') !== body) writeTextAtomic(file, body);
  return {
    receipt_path: `${rel}/challenge.json`,
    receipt_sha256: sha256(body),
    files: files.map((f) => ({ path: f.path, archived: f.archived, sha256: f.sha256 })),
    gate: { output_path: `${rel}/gate/${gateName}.log`, output_sha256: outputSha, results_path: resultsSha === null ? null : `${rel}/gate/${gateName}.results.json`, results_sha256: resultsSha },
  };
}

/** A challenge's archived receipt, read back (null when it is missing or not JSON). */
export function readChallengeReceipt(controlRoot: string, receiptPath: string): Record<string, any> | null {
  try {
    return JSON.parse(readFileSync(join(controlRoot, ...receiptPath.split('/')), 'utf8')) as Record<string, any>;
  } catch {
    return null;
  }
}
