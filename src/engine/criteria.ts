/**
 * Criterion coverage: every acceptance criterion a node serves is named,
 * with the test that proves it and the gate output that ran it.
 *
 * CSET-202 r1 with-normal: four nodes settled DONE on their own green suites
 * while hidden acceptance found aggregated parse errors, the shared error
 * identity and the CLI's reporting missing — no criterion was ever tied to a
 * test. A worker's result carries `criterion_evidence`: per criterion the
 * test that proves it, the gate that ran it and that gate's output hash.
 *
 * CSET-202 r2: settle refused the cli node's evidence twice because its
 * worker and controller guessed how the verifier names a nested Vitest test,
 * and both refusals consumed a product attempt. A test is now named by the
 * canonical id its gate published (evidence/test-ids.ts): settle resolves an
 * id only among the tests the bound gate output ran. A legacy path and name
 * count only when they resolve to exactly one of those tests; an unknown or
 * ambiguous reference is answered with the candidate ids. Settle judges,
 * before anything is integrated:
 *
 *  - every criterion the node serves is covered, none is another node's,
 *    no item is repeated;
 *  - the hash is the output of the gate's recorded evidence (or of a RED this
 *    branch's red gate accepted), whose output is still on disk as recorded;
 *  - the test is one that gate ran, in the node's fence (and its module, when
 *    the claim binds one), a test path, present at the submitted head;
 *  - that gate ran it as its kind requires: a new behaviour by a test the
 *    node's RED declared and failed for the missing behaviour; a
 *    compatibility criterion by an existing test a green or regression gate
 *    passed; a declaration by the node's GREEN, with or without a test (a
 *    declaration-only node, with no red gate, evidences any criterion so).
 *
 * A refusal is a metadata error: the orchestrator holds the submission for
 * correction on the same claim (EVIDENCE_CORRECTION_REQUIRED) instead of
 * charging an attempt. This is evidence coverage, not a claim that the
 * semantics are right.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AcceptedCriterionRecord, CarriedCriterionProof, ChallengeRedSnapshot, CriterionKind, EvidenceRecord, GraphNode, NodeRuntime, PortfolioGraph, TestIdentityAlias } from '../model/types.js';
import type { CriterionEvidence } from '../sessions/adapter.js';
import { checkEvidenceOutput } from '../evidence/paths.js';
import { RED_VALID_CATEGORIES } from '../evidence/red-classify.js';
import { namesDeclared, readGateTests } from '../evidence/gate-tests.js';
import { normalizeTestPath, type CanonicalTest } from '../evidence/test-ids.js';
import { TEST_IDENTITY_VERSION, parseJUnitReference, reportedIdentity, reportedName, resolveDeclaration, runnerOf, sameTest, testTitle, type DeclarationResolution, type ReportedTest, type TestIdentity } from '../evidence/test-identity.js';
import { matchGlob } from '../git/worktree.js';
import { runGit } from '../git/git.js';
import { declaredTests } from './test-declarations.js';
import { isTestPath, type TddPolicy } from './tdd-history.js';
import { capsuleUse } from './reproduction-capsule.js';

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

export type CriterionCode =
  | 'CRITERION_EVIDENCE_MISSING'
  | 'CRITERION_NOT_ASSIGNED'
  | 'CRITERION_EVIDENCE_DUPLICATE'
  | 'CRITERION_TEST_MISSING'
  | 'CRITERION_TEST_OUTSIDE_MODULE'
  | 'CRITERION_TEST_UNKNOWN'
  | 'CRITERION_TEST_AMBIGUOUS'
  | 'CRITERION_EVIDENCE_UNBOUND'
  | 'CRITERION_NOT_RUN'
  | 'CRITERION_RED_REQUIRED'
  | 'CRITERION_UNCOVERED'
  | 'CRITERION_COMPATIBILITY_UNBOUND'
  | 'CRITERION_STALE_PROOF'
  /** A per-criterion answer named one test for two criteria without tracing each one's clauses to it (engine/criterion-outcomes.ts). */
  | 'CRITERION_EVIDENCE_REUSED'
  /**
   * An ordered criterion completed before (CSET-203 r16) named DONE without both its completed proof and the review's
   * reproduction shown passing on the unchanged base (its re-proof) — or with a re-proof and no completed proof.
   */
  | 'CRITERION_REPROOF_REQUIRED'
  /**
   * Reproduction capsules (engine/reproduction-capsule.ts; CSET-203 r17). PASSING: a passing capsule cited as a proof —
   * it is challenge material only. NOT_RED: a failing capsule cited without the red gate that ran its committed files.
   * UNCOMMITTED: a failing capsule's files are not what the history committed. STALE / INVALID: the capsule is not this
   * claim's current one, or is no capsule. PATH: a refusal caused solely by a valid capsule's own path (its test kept
   * out of the branch, or named by no static title): administrative, the capsule named.
   */
  | 'CRITERION_CAPSULE_PASSING'
  | 'CRITERION_CAPSULE_NOT_RED'
  | 'CRITERION_CAPSULE_UNCOMMITTED'
  | 'CRITERION_CAPSULE_STALE'
  | 'CRITERION_CAPSULE_INVALID'
  | 'CRITERION_CAPSULE_PATH';

type Gate = 'red' | 'green' | 'regression';

/** A bound test the evidence could name, as a refusal offers it. */
export interface CriterionCandidate {
  id: string;
  path: string;
  full_name: string;
  status: string;
  gate: Gate;
}

/** A criterion item settle accepted, as STATE.json keeps it: the test by its id and full name. */
export type AcceptedCriterion = AcceptedCriterionRecord;

export type { CarriedCriterionProof };

/**
 * The proofs a reworked node's generation carries: each new behaviour of the
 * node its rework brief does not name, with the proof the replaced
 * generation settled it with (recorded by the rework, bound to that
 * generation, its claim, the commit integrated then and the archived gate
 * output). A rework names the criteria found wrong; those need this
 * generation's own RED. The others were proved, and their behaviour is in
 * the base the rework starts from, so no honest test can fail for it again:
 * CSET-203's apply-release-plan, reworked for AC-1's untested changelog
 * boundary, could otherwise never re-prove AC-2's journal. A carried proof is
 * data, never an active gate: cited exactly as recorded, it is checked
 * against its archived output, its test must pass this generation's green
 * gate, and settle re-runs it at the sealed head (revalidateCarried).
 */
export function carriedCriteria(graph: PortfolioGraph, node: GraphNode, runtime: NodeRuntime): CarriedCriterionProof[] {
  const brief = runtime.rework_brief ?? null;
  const mine = new Set(node.acceptance_criteria ?? []);
  // Reopened by an upstream's rework, with no order of its own (CSET-203 r17: the cli after QA's rework of
  // apply-release-plan): what its last generation settled as carried stays carried — the same proof, cited exactly as
  // given, its test run again by the fresh verification. r17's worker could not cite AC-4 and asked a person.
  if (brief === null) {
    const settled = (runtime.criteria ?? []).filter((c) => c.carried === true && c.carried_from != null);
    return (runtime.carried_criterion_proofs ?? []).filter((p) => p.ordered !== true && mine.has(p.criterion) && criterionKind(graph, p.criterion) === 'new-behavior' && settled.some((c) => c.criterion === p.criterion && c.carried_from?.output_sha256 === p.output_sha256));
  }
  return (runtime.carried_criterion_proofs ?? []).filter((p) => p.ordered !== true && mine.has(p.criterion) && !brief.acceptance_criteria.includes(p.criterion) && criterionKind(graph, p.criterion) === 'new-behavior');
}

/**
 * The ordered criteria a rework's generation finds completed (CSET-203 r16): a new behaviour the order names again —
 * a review's gap of a criterion an earlier generation completed with its RED and fix — with that completion's proof.
 * Re-provable: the review's exact reproduction passing on the unchanged base (a red gate of the claim, never a RED,
 * never committed) shows the completed behaviour holds there; cited with the completed proof, exactly as given, it
 * proves the criterion DONE without a RED this generation could only fake. A reproduction that fails is a RED.
 */
export function completedCriteria(graph: PortfolioGraph, node: GraphNode, runtime: NodeRuntime): CarriedCriterionProof[] {
  const brief = runtime.rework_brief ?? null;
  if (brief === null) return [];
  const mine = new Set(node.acceptance_criteria ?? []);
  return (runtime.carried_criterion_proofs ?? []).filter((p) => p.ordered === true && mine.has(p.criterion) && brief.acceptance_criteria.includes(p.criterion) && criterionKind(graph, p.criterion) === 'new-behavior');
}

/** Every gate output a replaced generation of the node recorded or cited: never this generation's proof. */
function archivedOutputs(runtime: NodeRuntime): Set<string> {
  const out = new Set<string>();
  for (const h of runtime.rework_history ?? []) {
    for (const e of Object.values(h.evidence)) if (e !== undefined) out.add(e.output_sha256);
    for (const c of h.criteria ?? []) out.add(c.output_sha256);
  }
  for (const p of runtime.carried_criterion_proofs ?? []) out.add(p.output_sha256);
  return out;
}

/**
 * A generation's carried criteria proved again at its own head: each item
 * judgeCriteria accepted as carried is replaced by the output of the fresh
 * verification of the sealed commit that passed its test (the full suite's
 * when its report shows it, else the module run's), with where it came from.
 * Refused (CARRIED_PROOF_NOT_REVALIDATED) when no carried proof of the node
 * records the item, or no fresh run's report (hashing as recorded) passed
 * the test.
 */
export function revalidateCarried(args: { controlRoot: string; accepted: readonly AcceptedCriterion[]; proofs: readonly CarriedCriterionProof[]; fresh: readonly EvidenceRecord[] }):
  | { ok: true; criteria: AcceptedCriterion[] }
  | { ok: false; code: 'CARRIED_PROOF_NOT_REVALIDATED'; criterion: string; detail: string } {
  const criteria: AcceptedCriterion[] = [];
  const ordered = [...args.fresh.filter((r) => r.kind === 'regression'), ...args.fresh.filter((r) => r.kind === 'green')];
  for (const a of args.accepted) {
    if (a.carried !== true) {
      criteria.push(a);
      continue;
    }
    const fail = (detail: string) => ({ ok: false as const, code: 'CARRIED_PROOF_NOT_REVALIDATED' as const, criterion: a.criterion, detail: `CARRIED_PROOF_NOT_REVALIDATED: ${a.criterion}: ${detail}` });
    const proof = args.proofs.find((p) => p.criterion === a.criterion && p.test_id === a.test_id && p.output_sha256 === (a.carried_from?.output_sha256 ?? a.output_sha256));
    if (proof === undefined) return fail('no carried proof of this node records it');
    const run = ordered.find((r) => (readGateTests(args.controlRoot, r) ?? []).some((t) => t.id === proof.test_id && t.status === 'passed'));
    if (run === undefined) return fail(`the fresh verification at the sealed head did not pass its test ${proof.test_id} (${proof.test.name})`);
    criteria.push({
      criterion: a.criterion,
      test_id: proof.test_id,
      test: { ...proof.test },
      gate: run.kind === 'regression' ? 'regression' : 'green',
      output_sha256: run.output_sha256,
      carried: true,
      ...(a.identity != null ? { identity: a.identity } : {}),
      carried_from: { generation: proof.source_generation, gate: proof.gate, output_sha256: proof.output_sha256, claim_id: proof.source_claim_id, dispatch_id: proof.source_dispatch_id, repo_sha: proof.repo_sha, ...(proof.record_id != null ? { record_id: proof.record_id } : {}) },
    });
  }
  return { ok: true, criteria };
}

export type CriteriaJudgement =
  | { ok: true; accepted: AcceptedCriterion[] }
  | {
      ok: false;
      code: CriterionCode;
      detail: string;
      candidates: CriterionCandidate[];
      /** The criterion the refusal is about, when it names one. */
      criterion: string | null;
    };

/** A graph's spelling of a kind, normalised: new behaviour (the default), compatibility, declaration. */
export function normalizeCriterionKind(kind: string | undefined): CriterionKind {
  if (kind === 'compatibility' || kind === 'declaration') return kind;
  return 'new-behavior';
}

/** A criterion's kind. */
export function criterionKind(graph: PortfolioGraph, id: string): CriterionKind {
  return normalizeCriterionKind(graph.acceptance_criteria.find((a) => a.id === id)?.kind);
}

export interface JudgeCriteriaArgs {
  controlRoot: string;
  featureId: string;
  graph: PortfolioGraph;
  node: GraphNode;
  runtime: NodeRuntime;
  evidence: CriterionEvidence[] | undefined;
  repoPath: string;
  head: string;
  policy: TddPolicy;
  /** The module path the claim binds, when it binds one. */
  modulePath: string | null;
  /**
   * The compatibility-regression units of the history settle judged
   * (engine/tdd-history.ts): every test one adds must be named in the
   * evidence of one of its criteria, through a green or regression gate that
   * passed it — it is accepted after the code only as that evidence.
   */
  compatibility?: readonly { commits: readonly string[]; criteria: readonly string[]; declared: readonly { file: string; name: string }[] }[];
  /**
   * Criteria the answer does not prove (a per-criterion answer's challenged or unresolved ones, engine/criterion-outcomes.ts):
   * judged apart, never covered here; evidence naming one is refused as another node's would be.
   */
  exclude?: readonly string[];
  /** The tests the answer's challenge cites: a challenge's passing test is never another criterion's re-proof. */
  challengeTests?: readonly string[];
}

const MAX_CANDIDATES = 24;

/**
 * Resubmissions a held criterion evidence may be refused before the hold
 * ends as a failed attempt (engine/orchestrator.ts): a correction is metadata
 * only, so a worker that cannot name the tests it ran after this many tries
 * has not proved them.
 */
export const MAX_EVIDENCE_CORRECTIONS = 3;

/** The gate a criterion's evidence needs on a node, as a correction is told it. */
export type RequiredGate = 'red' | 'green' | 'green or regression';

export function requiredGate(kind: CriterionKind, declarationOnly: boolean): RequiredGate {
  if (kind === 'new-behavior') return declarationOnly ? 'green' : 'red';
  return kind === 'declaration' ? 'green' : 'green or regression';
}

/**
 * Refusals of a new behaviour no RED of the node proved (CSET-203 r1's AC-4,
 * mapped to an existing test through GREEN): no metadata names a proof that
 * does not exist, so the correction may add one focused RED cycle on the
 * same claim. Any other refusal is metadata (a wrong id, hash or gate name).
 */
export const CYCLE_CORRECTIONS: ReadonlySet<CriterionCode> = new Set<CriterionCode>(['CRITERION_RED_REQUIRED', 'CRITERION_UNCOVERED', 'CRITERION_NOT_RUN', 'CRITERION_REPROOF_REQUIRED']);

/** The file `path` at `head`, or null when the head does not hold it; cached by head and path. */
function sourceAt(repoPath: string, head: string, path: string, cache: Map<string, string | null>): string | null {
  const key = `${head}:${path}`;
  if (!cache.has(key)) {
    const r = runGit(repoPath, ['show', `${head}:${path}`], { allowFail: true });
    cache.set(key, r.exitCode === 0 ? r.stdout : null);
  }
  return cache.get(key) ?? null;
}

/**
 * Whether the file of a reported test, at `head`, declares it — and as which canonical identity (evidence/test-identity.ts):
 * a JUnit result by its method, its class the file's own; a JS one by its full suite/title; any other exactly.
 */
export function declarationAt(repoPath: string, head: string, test: ReportedTest, cache: Map<string, string | null> = new Map()): DeclarationResolution {
  return resolveDeclaration(test, sourceAt(repoPath, head, normalizeTestPath(test.path), cache));
}

/**
 * Whether `path` at `head` declares the test `name` (its framework full name, or a reported test with its class): true
 * or false when Mycelink can read the file's declarations, null when it cannot tell (a language it cannot read, or a
 * test only a dynamic table names). A JUnit name is resolved by its canonical identity — never compared as a string
 * with the bare methods the file declares, which no class-qualified name ever matched (PCM-101 final).
 */
export function declaredAt(repoPath: string, head: string, path: string, name: string | Omit<ReportedTest, 'path'>, cache: Map<string, string | null> = new Map()): boolean | null {
  const r = declarationAt(repoPath, head, typeof name === 'string' ? { path, full_name: name } : { ...name, path }, cache);
  return r.status === 'declared' ? true : r.status === 'unreadable' ? null : false;
}

/** Separators a name may join describes with: ` > `, ` › `, `::`, or a space as Vitest's own full name does. */
const squash = (s: string): string => s.replace(/\s*(?:>|›|»|::)\s*/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * The bound tests a legacy path and name could mean. JUnit: by its canonical identity — the method (or display name),
 * and the class, package, parameters and invocation the name gives, a class prefix never required and never another
 * class's. Any other runner, best reading first: full name, title, either with separators normalised.
 */
function resolveLegacy(tests: readonly CanonicalTest[], path: string, name: string): CanonicalTest[] {
  const inFile = tests.filter((t) => t.path === normalizeTestPath(path));
  if (runnerOf(normalizeTestPath(path)) === 'junit') {
    const ref = parseJUnitReference(name);
    if (ref === null) return [];
    return inFile.filter((t) => {
      const r = parseJUnitReference({ path: t.path, full_name: t.full_name, name: t.name, classname: t.classname ?? null });
      if (r === null || (ref.method !== null ? r.method !== ref.method : r.name !== ref.name)) return false;
      if (ref.classes.length > 0 && (r.classes[0] !== ref.classes[0] || (ref.classes.length > 1 && r.classes.join('$') !== ref.classes.join('$')))) return false;
      if (ref.pkg !== null && ref.pkg !== '' && r.pkg !== ref.pkg) return false;
      if (ref.params !== null && (r.params === null || r.params.join(',') !== ref.params.join(','))) return false;
      return ref.suffix === '' || r.suffix === ref.suffix;
    });
  }
  for (const pick of [(t: CanonicalTest) => t.full_name === name, (t: CanonicalTest) => t.name === name, (t: CanonicalTest) => squash(t.full_name) === squash(name) || squash(t.name) === squash(name)]) {
    const hits = inFile.filter(pick);
    if (hits.length > 0) return hits;
  }
  // A parameterised or repeated test reports one result per case (`name(args)[n]`): each is its own id.
  return inFile.filter((t) => t.name.startsWith(`${name}(`) || t.name.startsWith(`${name}[`));
}

/** A RED binding's test as a gate's results named it: its own name and (JUnit) class read back from its full name. */
function boundTest(t: { id: string; path: string; full_name: string; status: string; category: string; identity?: TestIdentity }): CanonicalTest {
  const hash = t.full_name.indexOf('#');
  const junit = runnerOf(t.path) === 'junit' && hash > 0;
  const identity = t.identity !== undefined && t.identity.version === TEST_IDENTITY_VERSION && t.identity.path === t.path ? t.identity : undefined;
  return { id: t.id, path: t.path, full_name: t.full_name, name: reportedName(t.path, t.full_name), status: t.status as CanonicalTest['status'], category: t.category, ...(junit ? { classname: t.full_name.slice(0, hash) } : {}), ...(identity !== undefined ? { identity } : {}) };
}

/** Rank tests by the words they share with `text`, the node's declared tests first. */
function rank(tests: readonly CanonicalTest[], text: string, first: (t: CanonicalTest) => boolean): CanonicalTest[] {
  const words = new Set(squash(text).toLowerCase().split(' ').filter((w) => w.length > 2));
  const score = (t: CanonicalTest): number => (first(t) ? 1000 : 0) + squash(`${t.path} ${t.full_name}`).toLowerCase().split(/[ /]/).filter((w) => words.has(w)).length;
  return [...tests].map((t, i) => ({ t, i, s: score(t) })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.t);
}

export function judgeCriteria(args: JudgeCriteriaArgs): CriteriaJudgement {
  const { node, runtime, graph } = args;
  const excluded = new Set(args.exclude ?? []);
  const assigned = (node.acceptance_criteria ?? []).filter((c) => !excluded.has(c));
  if (assigned.length === 0) return { ok: true, accepted: [] };
  const declarationOnly = !node.required_evidence.includes('red');
  const redRecord = runtime.evidence.red;
  const redDeclared = redRecord?.red_declared ?? null;
  const gateTests = new Map<Gate, CanonicalTest[] | null>();
  const testsOf = (gate: Gate, record: EvidenceRecord | undefined): CanonicalTest[] | null => {
    if (record === undefined) return null;
    if (record === runtime.evidence[gate]) {
      if (!gateTests.has(gate)) gateTests.set(gate, readGateTests(args.controlRoot, record));
      return gateTests.get(gate) ?? null;
    }
    return readGateTests(args.controlRoot, record);
  };
  /** A test the node's RED declared that failed for a missing behaviour: what a new behaviour is proved by. */
  const redProof = (t: CanonicalTest): boolean => t.status === 'failed' && RED_VALID_CATEGORIES.has(t.category) && (redDeclared === null || redDeclared.some((d) => namesDeclared(t, d)));
  /** What a refusal offers: the bound tests a criterion's evidence could name, the RED's proofs and the node's own tests first. */
  const candidatesFor = (gates: Gate[], text: string): CriterionCandidate[] => {
    const out: CriterionCandidate[] = [];
    for (const gate of gates) {
      const tests = testsOf(gate, runtime.evidence[gate]) ?? [];
      const usable = tests.filter((t) => (gate === 'red' ? redProof(t) : t.status === 'passed'));
      for (const t of rank(usable, text, (x) => (redDeclared ?? []).some((d) => namesDeclared(x, d)))) out.push({ id: t.id, path: t.path, full_name: t.full_name, status: t.status, gate });
    }
    return out.slice(0, MAX_CANDIDATES);
  };
  const gatesFor = (criterion: string): Gate[] => {
    const kind = criterionKind(graph, criterion);
    return kind === 'new-behavior' && !declarationOnly ? ['red'] : ['red', 'green', 'regression'];
  };
  const fail = (code: CriterionCode, detail: string, candidates: CriterionCandidate[] = [], criterion: string | null = null): CriteriaJudgement => ({ ok: false, code, detail, candidates, criterion });

  const items = args.evidence ?? [];
  if (items.length === 0) {
    return fail(
      'CRITERION_EVIDENCE_MISSING',
      `the result names no criterion_evidence; ${node.id} serves ${assigned.join(', ')}: for each, the test_id of the test that proves it (the gates print each test's id), the gate that ran it and that gate's output hash`,
      candidatesFor(['red', 'green'], ''),
    );
  }
  const seen = new Set<string>();
  const accepted: AcceptedCriterion[] = [];
  /** The bound test each accepted item named, as its gate ran it. */
  const named: { criterion: string; gate: Gate; test: CanonicalTest }[] = [];
  const carried = carriedCriteria(graph, node, runtime);
  const completed = completedCriteria(graph, node, runtime);
  // The claim's red gates that passed a declared test on the unchanged base: what a completed criterion's re-proof cites.
  const snapshots = [...(runtime.claim?.challenge_reds ?? []), ...(runtime.claim?.challenge_red ? [runtime.claim.challenge_red] : [])];
  const reworked = new Set(runtime.rework_brief?.acceptance_criteria ?? []);
  const archived = archivedOutputs(runtime);
  const contents = new Map<string, boolean>();
  const declaredCache = new Map<string, string | null>();
  const atHead = (path: string): boolean => {
    if (!contents.has(path)) contents.set(path, runGit(args.repoPath, ['cat-file', '-e', `${args.head}:${path}`], { allowFail: true }).exitCode === 0);
    return contents.get(path) ?? false;
  };
  const outsideFence = (p: string): boolean => {
    const inFence = node.allowed_paths.some((g) => matchGlob(g, p)) && !(node.forbidden_paths ?? []).some((g) => matchGlob(g, p));
    const inModule = args.modulePath === null || p.startsWith(`${args.modulePath}/`);
    return !inFence || !inModule || !isTestPath(args.policy, p);
  };
  const whereOf = (): string => `${node.id}'s ${args.modulePath !== null ? `module (${args.modulePath})` : 'allowed paths'}`;
  for (const item of items) {
    const failPlain = (code: CriterionCode, detail: string, candidates: CriterionCandidate[] = []): CriteriaJudgement => fail(code, detail, candidates, item.criterion);
    // A refusal only a valid capsule's own path caused (its test kept out of the branch, as a capsule's is): the capsule is
    // named, the refusal administrative (CSET-203 r17's CRITERION_TEST_UNKNOWN).
    const failItem = (code: CriterionCode, detail: string, candidates: CriterionCandidate[] = []): CriteriaJudgement => {
      const k = CAPSULE_PATH_CODES.has(code) && item.test_id !== undefined && item.capsule_id === undefined ? capsuleOfTest(args, item.test_id) : null;
      if (k === null) return failPlain(code, detail, candidates);
      return failPlain('CRITERION_CAPSULE_PATH', capsulePathDetail(k, item.criterion, `${code}: ${detail}`), candidates);
    };
    const ref = item.test_id !== undefined ? `test_id ${item.test_id}` : item.test ? `${item.test.path} › ${item.test.name}` : 'no test';
    const label = `${item.criterion} (${ref}, ${item.gate})`;
    if (!assigned.includes(item.criterion)) {
      return failItem('CRITERION_NOT_ASSIGNED', `${label}: ${item.criterion} is not a criterion of ${node.id} (it serves ${assigned.join(', ')}); evidence another node's criterion there`);
    }
    const key = JSON.stringify([item.criterion, item.test_id ?? item.test?.path ?? null, item.test_id === undefined ? (item.test?.name ?? null) : null, item.gate]);
    if (seen.has(key)) return failItem('CRITERION_EVIDENCE_DUPLICATE', `${label} is named twice`);
    seen.add(key);
    const kind = criterionKind(graph, item.criterion);
    const text = `${item.test?.path ?? ''} ${item.test?.name ?? ''} ${graph.acceptance_criteria.find((a) => a.id === item.criterion)?.text ?? ''}`;
    // A RED promoted from a failing reproduction capsule (CSET-203 r17): the capsule this claim's current, for this
    // criterion; it failed; the item names the red gate that ran its files, committed — never the capsule's own run.
    let promoted: { capsule_id: string; capsule_sha256: string; result: 'failed' } | null = null;
    if (item.capsule_id !== undefined) {
      const used = capsuleUse({ controlRoot: args.controlRoot, featureId: args.featureId, nodeId: node.id, runtime, capsuleId: item.capsule_id, capsuleSha256: null, criterion: item.criterion, want: null });
      if (!used.ok) return failPlain(used.administrative ? 'CRITERION_CAPSULE_STALE' : 'CRITERION_CAPSULE_INVALID', `${label}: ${used.code}: ${used.detail}`);
      if (used.capsule.result === 'passed') {
        return failPlain('CRITERION_CAPSULE_PASSING', `${label}: ${used.capsule.capsule_id} passed on the unchanged base: a passing reproduction proves nothing DONE — it is challenge material only (outcome REVIEW_GAP_CHALLENGE for ${item.criterion}, the challenge line with --capsule ${used.capsule.capsule_id})`);
      }
      if (item.gate !== 'red' || item.output_sha256 === used.capsule.run.output_sha256) {
        return failPlain('CRITERION_CAPSULE_NOT_RED', `${label}: ${used.capsule.capsule_id} failed on the unchanged base: it is RED material only — commit exactly its files alone (test-first), run the red gate, then the fix, and cite that red gate's failing test (gate "red", its output_sha256) with the capsule`);
      }
      const test = used.capsule.tests.find((t) => t.id === item.test_id);
      if (test === undefined || test.status !== 'failed') {
        return failPlain('CRITERION_CAPSULE_NOT_RED', `${label}: ${item.test_id ?? '(no test)'} is not a test ${used.capsule.capsule_id} failed: cite one of its failing tests (${used.capsule.tests.filter((t) => t.status === 'failed').map((t) => t.id).join(', ')})`);
      }
      const uncommitted = used.capsule.files.filter((f) => runGit(args.repoPath, ['rev-parse', '--verify', '--quiet', `${args.head}:${f.path}`], { allowFail: true }).stdout.trim() !== f.blob);
      if (uncommitted.length > 0) {
        return failPlain('CRITERION_CAPSULE_UNCOMMITTED', `${label}: ${uncommitted.map((f) => f.path).join(', ')} of ${used.capsule.capsule_id} ${uncommitted.length === 1 ? 'is' : 'are'} not in the submitted head ${args.head.slice(0, 12)} byte for byte as sealed: a failing capsule is a RED only once its exact files are committed test-first`);
      }
      promoted = { capsule_id: used.capsule.capsule_id, capsule_sha256: used.capsule_sha256, result: 'failed' };
    }

    // The gate's recorded evidence the hash names, its output still on disk as recorded. In a rework, a RED the generation
    // carries (engine/criterion-ledger.ts) is never this generation's own: cited, it is the completed proof it carries.
    const record = runtime.evidence[item.gate];
    const bound = record !== undefined && record.output_sha256 === item.output_sha256 && !(item.gate === 'red' && record.carried_from != null && runtime.rework_brief != null) ? record : undefined;
    const binding = item.gate === 'red' && bound === undefined ? (runtime.tdd_red_bindings ?? []).find((b) => b.evidence_sha256 === item.output_sha256) : undefined;
    // An ordered criterion completed before, re-proved: a red gate of this claim passed the review's reproduction (a test
    // it declared) on the unchanged base — evidence that the completed behaviour holds here, never a RED (CSET-203 r16).
    const reproofGate =
      item.gate === 'red' && item.test_id !== undefined && completed.some((c) => c.criterion === item.criterion) && !(args.challengeTests ?? []).includes(item.test_id)
        ? snapshots.find((s) => s.evidence_sha256 === item.output_sha256 && s.red_tests.some((t) => t.id === item.test_id && t.status === 'passed'))
        : undefined;
    if (reproofGate !== undefined) {
      const t = reproofGate.red_tests.find((x) => x.id === item.test_id) as ChallengeRedSnapshot['red_tests'][number];
      const kept = reproofGate.files.every((f) => {
        const file = join(args.controlRoot, ...f.copy.split('/'));
        return existsSync(file) && sha256(readFileSync(file)) === f.sha256;
      });
      const gateKept = reproofGate.gate === undefined || checkEvidenceOutput(args.controlRoot, args.featureId, { output_path: reproofGate.gate.output_path, output_sha256: reproofGate.gate.output_sha256 }) === null;
      if (!kept || !gateKept) return failItem('CRITERION_EVIDENCE_UNBOUND', `${label}: the red gate's copy of what it ran (${item.output_sha256.slice(0, 12)}) is missing or changed`);
      if (outsideFence(t.path)) return failItem('CRITERION_TEST_OUTSIDE_MODULE', `${label}: ${t.path} is not a test of ${whereOf()}`);
      const reproved = reportedIdentity({ path: t.path, full_name: t.full_name });
      accepted.push({ criterion: item.criterion, test_id: t.id, test: { path: t.path, name: t.full_name }, gate: 'red', output_sha256: item.output_sha256, ...(reproved !== null ? { identity: reproved } : {}), reproof: { gate_output_sha256: item.output_sha256, tests: [{ test_id: t.id, path: t.path, full_name: t.full_name }] } });
      continue;
    }
    // A criterion the rework does not name, cited with the proof its replaced generation settled it with, exactly as
    // recorded (carriedCriteria); or an ordered one completed before, cited with its completed proof (completedCriteria).
    const proof =
      bound === undefined && binding === undefined
        ? !reworked.has(item.criterion)
          ? carried.find((c) => c.criterion === item.criterion && c.gate === item.gate && c.output_sha256 === item.output_sha256 && (item.test_id === undefined || item.test_id === c.test_id))
          : completed.find((c) => c.criterion === item.criterion && c.gate === item.gate && c.output_sha256 === item.output_sha256 && (item.test_id === undefined || item.test_id === c.test_id))
        : undefined;
    if (proof !== undefined) {
      const problem = checkEvidenceOutput(args.controlRoot, args.featureId, { output_path: proof.output_path, output_sha256: proof.output_sha256 });
      if (problem !== null) return failItem('CRITERION_EVIDENCE_UNBOUND', `${label}: the proof generation ${proof.source_generation} settled ${item.criterion} with: ${problem}`);
      // The proved code is the replaced generation's integrated commit: it must be in the history this generation submits.
      if (proof.repo_sha !== null && runGit(args.repoPath, ['merge-base', '--is-ancestor', proof.repo_sha, args.head], { allowFail: true }).exitCode !== 0) {
        return failItem('CRITERION_EVIDENCE_UNBOUND', `${label}: generation ${proof.source_generation} proved ${item.criterion} at ${proof.repo_sha.slice(0, 12)}, which is not in the history of the submitted head ${args.head.slice(0, 12)}`);
      }
      if (!atHead(proof.test.path)) return failItem('CRITERION_TEST_UNKNOWN', `${label}: ${proof.test.path}, the carried proof's test, is not in the submitted head ${args.head.slice(0, 12)}`);
      const green = testsOf('green', runtime.evidence.green) ?? [];
      if (!green.some((t) => t.id === proof.test_id && t.status === 'passed')) {
        return failItem('CRITERION_NOT_RUN', `${label}: a carried proof holds only while its test still passes: this generation's green gate did not pass ${proof.test_id} (${proof.test.name}); run green`, candidatesFor(['green'], text));
      }
      // Settle replaces it with the fresh verification's run of the test at the sealed head (revalidateCarried).
      const carriedIdentity = reportedIdentity({ path: proof.test.path, full_name: proof.test.name });
      accepted.push({ criterion: item.criterion, test_id: proof.test_id, test: { ...proof.test }, gate: proof.gate, output_sha256: proof.output_sha256, carried: true, ...(carriedIdentity !== null ? { identity: carriedIdentity } : {}) });
      continue;
    }
    if (bound === undefined && binding === undefined && archived.has(item.output_sha256)) {
      const own = carried.find((c) => c.criterion === item.criterion);
      return failItem(
        'CRITERION_STALE_PROOF',
        reworked.has(item.criterion)
          ? `${label}: ${item.output_sha256.slice(0, 12)} is an output of a generation this rework replaced, and the rework names ${item.criterion}: prove it with this generation's own gate (a new RED for a new behaviour)`
          : own !== undefined
            ? `${label}: ${item.output_sha256.slice(0, 12)} is an output of a replaced generation, not ${item.criterion}'s carried proof: cite rework.carried_criteria exactly as given (test_id ${own.test_id}, gate ${own.gate}, output_sha256 ${own.output_sha256})`
            : `${label}: ${item.output_sha256.slice(0, 12)} is an output of a generation a rework replaced: cite this generation's gates`,
      );
    }
    if (bound === undefined && binding === undefined) {
      const recorded = (['red', 'green', 'regression'] as const).filter((g) => runtime.evidence[g]).map((g) => `${g} ${runtime.evidence[g]?.output_sha256}`);
      return failItem('CRITERION_EVIDENCE_UNBOUND', `${label}: ${item.output_sha256.slice(0, 12)} is not the output of the ${item.gate} gate this node recorded; name the sha256 the gate printed (recorded: ${recorded.join(', ') || 'none'})`);
    }
    if (bound !== undefined) {
      const problem = checkEvidenceOutput(args.controlRoot, args.featureId, bound);
      if (problem !== null) return failItem('CRITERION_EVIDENCE_UNBOUND', `${label}: ${problem}`);
    }

    if (item.test_id === undefined && item.test === undefined) {
      if (!((declarationOnly || kind === 'declaration') && item.gate !== 'red')) {
        return failItem('CRITERION_TEST_MISSING', `${label}: name the test_id of the test that proves it (only a declaration criterion, or a declaration-only node, is evidenced by its GREEN alone)`, candidatesFor(gatesFor(item.criterion), text));
      }
      accepted.push({ criterion: item.criterion, test_id: null, test: null, gate: item.gate, output_sha256: item.output_sha256 });
      continue;
    }

    // A test of another fence or module is refused as that, before it is looked for among the gate's tests.
    const outside = outsideFence;
    const where = whereOf();
    if (item.test_id === undefined && item.test !== undefined && outside(normalizeTestPath(item.test.path))) {
      return failItem('CRITERION_TEST_OUTSIDE_MODULE', `${label}: ${normalizeTestPath(item.test.path)} is not a test of ${where}`, candidatesFor(gatesFor(item.criterion), text));
    }

    // The tests that gate run published, by id: the gate's results, or what an earlier RED of this branch bound.
    const tests: CanonicalTest[] | null = bound !== undefined ? testsOf(item.gate, bound) : (binding?.red_tests ?? null)?.map(boundTest) ?? null;
    let hit: CanonicalTest | null = null;
    if (tests !== null) {
      let hits: CanonicalTest[];
      if (item.test_id !== undefined) hits = tests.filter((t) => t.id === item.test_id);
      else hits = resolveLegacy(tests, (item.test as { path: string }).path, (item.test as { name: string }).name);
      if (hits.length === 0) {
        return failItem(
          'CRITERION_TEST_UNKNOWN',
          `${label}: the ${item.gate} gate (output ${item.output_sha256.slice(0, 12)}) ran no test ${item.test_id !== undefined ? 'with that id' : 'of that path and name'}; name one of the ids it published (mycelink tdd tests finds any by words)`,
          candidatesFor(gatesFor(item.criterion), text),
        );
      }
      if (hits.length > 1) {
        return failItem(
          'CRITERION_TEST_AMBIGUOUS',
          `${label}: ${hits.length} tests the ${item.gate} gate ran answer to that name; name the one that proves ${item.criterion} by its test_id`,
          hits.slice(0, MAX_CANDIDATES).map((t) => ({ id: t.id, path: t.path, full_name: t.full_name, status: t.status, gate: item.gate })),
        );
      }
      hit = hits[0] as CanonicalTest;
    } else if (item.test_id !== undefined) {
      return failItem(
        'CRITERION_TEST_UNKNOWN',
        `${label}: the ${item.gate} gate ran without a structured report, so it published no test ids; name a test of a gate that did`,
        candidatesFor(gatesFor(item.criterion), text),
      );
    }

    // Legacy: a gate without a report names no ids; the path and name are judged from the repository.
    const path = hit !== null ? hit.path : normalizeTestPath((item.test as { path: string }).path);
    if (outside(path)) {
      return failItem('CRITERION_TEST_OUTSIDE_MODULE', `${label}: ${path} is not a test of ${where}`, candidatesFor(gatesFor(item.criterion), text));
    }
    if (!atHead(path)) {
      return failItem('CRITERION_TEST_UNKNOWN', `${label}: ${path} is not in the submitted head ${args.head.slice(0, 12)}`, candidatesFor(gatesFor(item.criterion), text));
    }
    // A proof is a test the submitted head holds (CSET-201 final): a RED an earlier claim ran on tests it never committed names
    // a test this head does not declare; cited as this generation's proof, it would carry a proof nothing holds. The test is
    // matched by its canonical identity (PCM-101 final): a JUnit result by its method, its class the file's own; a name the
    // file declares twice, a class that is not the file's, a malformed name, stays unknown.
    let identity: TestIdentity | null = null;
    let alias: TestIdentityAlias | null = null;
    if (hit !== null) {
      const declared = declarationAt(args.repoPath, args.head, { path, full_name: hit.full_name, name: hit.name, classname: hit.classname ?? null }, declaredCache);
      const confirmed = declared.status !== 'declared' || hit.identity === undefined || sameTest(hit.identity, declared.identity);
      if (declared.status === 'missing' || declared.status === 'ambiguous' || declared.status === 'mismatch' || !confirmed) {
        const why = declared.status === 'declared' ? ` (its published identity ${hit.identity?.key} is not the declaration's ${declared.identity.key})` : declared.status === 'missing' ? '' : ` (${declared.detail})`;
        return failItem('CRITERION_TEST_UNKNOWN', `${label}: ${path} declares no test ${JSON.stringify(testTitle(path, hit.full_name))} at the submitted head ${args.head.slice(0, 12)}${why}: a criterion is proved only by a test the head holds (a run of tests never committed proves nothing here)`, candidatesFor(gatesFor(item.criterion), text));
      }
      identity = declared.status === 'declared' ? declared.identity : reportedIdentity({ path, full_name: hit.full_name, name: hit.name, classname: hit.classname ?? null });
      // Published before identities were: how its raw name maps to the canonical identity at this head (never a rewrite of its evidence).
      if (declared.status === 'declared' && hit.identity === undefined && declared.translated) {
        const blob = runGit(args.repoPath, ['rev-parse', '--verify', '--quiet', `${args.head}:${path}`], { allowFail: true }).stdout.trim();
        alias = {
          schema: 'mycelink-test-identity-alias/1',
          raw: { test_id: hit.id, path, full_name: hit.full_name, classname: hit.classname ?? (hit.full_name.includes('#') ? hit.full_name.slice(0, hit.full_name.indexOf('#')) : null) },
          canonical: declared.identity,
          head_sha: args.head,
          declaration: { path, method: declared.identity.key, classes: declared.identity.classes ?? [], line: declared.line, blob: blob === '' ? null : blob },
        };
      }
    }

    // The gate ran it as the criterion needs: a RED failed it for a missing behaviour, a GREEN or regression passed it.
    let ran: boolean;
    if (hit !== null) {
      ran = item.gate === 'red' ? redProof(hit) || (bound === undefined && hit.status === 'failed' && RED_VALID_CATEGORIES.has(hit.category)) : hit.status === 'passed';
    } else {
      const name = (item.test as { name: string }).name;
      // A JUnit name by its canonical identity (its class, when given, the file's own); any other exactly as the file declares it.
      const junit = runnerOf(path) === 'junit';
      const declared = junit ? declarationAt(args.repoPath, args.head, { path, full_name: name }, declaredCache) : null;
      const source = junit ? null : sourceAt(args.repoPath, args.head, path, declaredCache);
      if (junit ? declared?.status !== 'declared' : source === null || !declaredTests(path, source).some((t) => t.name === name)) {
        return failItem('CRITERION_TEST_UNKNOWN', `${label}: ${path} declares no test named ${JSON.stringify(name)} at ${args.head.slice(0, 12)}`, candidatesFor(gatesFor(item.criterion), text));
      }
      if (declared?.status === 'declared') identity = declared.identity;
      const title = junit ? testTitle(path, name) : name;
      ran =
        item.gate === 'red'
          ? bound !== undefined
            ? (bound.red_declared ?? []).some((t) => normalizeTestPath(t.file) === path && t.name === title)
            : (binding?.tests ?? []).some((t) => t.path === path) || (redRecord?.red_declared ?? []).some((t) => normalizeTestPath(t.file) === path && t.name === title)
          : true; // No report: the gate's own exit is what it accepted.
    }
    if (!ran) {
      return failItem(
        'CRITERION_NOT_RUN',
        `${label}: the ${item.gate} gate did not ${item.gate === 'red' ? 'fail it for a missing behaviour as a test the RED declared' : 'pass it'}`,
        candidatesFor(item.gate === 'red' ? ['red'] : gatesFor(item.criterion), text),
      );
    }
    if (hit !== null) named.push({ criterion: item.criterion, gate: item.gate, test: hit });
    accepted.push({
      criterion: item.criterion,
      test_id: hit?.id ?? null,
      test: { path, name: hit?.full_name ?? (item.test as { name: string }).name },
      gate: item.gate,
      output_sha256: item.output_sha256,
      ...(identity !== null ? { identity } : {}),
      ...(alias !== null ? { identity_alias: alias } : {}),
      ...(promoted !== null ? { capsule: promoted } : {}),
    });
  }
  for (const ac of assigned) {
    const mine = accepted.filter((a) => a.criterion === ac);
    const text = graph.acceptance_criteria.find((a) => a.id === ac)?.text ?? '';
    if (mine.length === 0) return fail('CRITERION_UNCOVERED', `${ac} of ${node.id} has no evidence: name the test_id of the test that proves it`, candidatesFor(gatesFor(ac), text), ac);
    // An ordered criterion completed before: its own RED and fix, or its completed proof with the review's reproduction re-proved.
    const done = completed.find((c) => c.criterion === ac);
    if (done !== undefined && !declarationOnly) {
      const ownRed = mine.some((a) => a.gate === 'red' && a.carried !== true && a.reproof == null);
      const carriedProof = mine.some((a) => a.carried === true);
      const reproved = mine.some((a) => a.reproof != null);
      if (!ownRed && !(carriedProof && reproved)) {
        return fail(
          'CRITERION_REPROOF_REQUIRED',
          `${ac} was completed by generation ${done.source_generation} and this order names it again: prove it DONE with ${carriedProof ? '' : `its completed proof exactly as rework.completed_criteria gives it (test_id ${done.test_id}, gate ${done.gate}, output_sha256 ${done.output_sha256}) `}${!carriedProof && !reproved ? 'and ' : ''}${reproved ? '' : "the review's exact reproduction shown passing on the unchanged base: its test_id, gate red, and the output_sha256 of the red gate that passed it (a re-proof, kept out of the branch: settle commits it as a re-proof unit)"} — or, if that reproduction fails, it is a RED: its own red gate, then the fix`,
          candidatesFor(['red'], text),
          ac,
        );
      }
      continue;
    }
    if (criterionKind(graph, ac) === 'new-behavior' && !declarationOnly && !mine.some((a) => (a.gate === 'red' && a.reproof == null) || a.carried === true)) {
      return fail(
        'CRITERION_RED_REQUIRED',
        `${ac} is a new behavior: its evidence is a test the node's RED declared and failed for the missing behaviour (gate "red"); an existing test through green or regression proves only a compatibility criterion`,
        candidatesFor(['red'], text),
        ac,
      );
    }
  }
  // A compatibility-regression unit's tests stand after the code only as their criteria's regression evidence.
  for (const unit of args.compatibility ?? []) {
    for (const d of unit.declared) {
      if (named.some((n) => unit.criteria.includes(n.criterion) && n.gate !== 'red' && n.test.status === 'passed' && namesDeclared(n.test, d))) continue;
      const ac = unit.criteria[0] ?? null;
      const candidates: CriterionCandidate[] = (['green', 'regression'] as const).flatMap((gate) =>
        (testsOf(gate, runtime.evidence[gate]) ?? []).filter((t) => namesDeclared(t, d)).map((t) => ({ id: t.id, path: t.path, full_name: t.full_name, status: t.status, gate })),
      );
      return fail(
        'CRITERION_COMPATIBILITY_UNBOUND',
        `${d.file} › ${d.name} is a test the compatibility-regression unit ${unit.commits.map((c) => c.slice(0, 12)).join(', ')} adds after the code for ${unit.criteria.join(', ')}, and no evidence of ${unit.criteria.join(' or ')} names it through a green or regression gate that passed it: name its test_id for ${unit.criteria.join(' or ')} with that gate's output_sha256 (run green again after the commit if its output does not list it)`,
        candidates,
        ac,
      );
    }
  }
  return { ok: true, accepted: accepted.slice(0, 64) };
}

/** Refusals a valid capsule's own path can cause: its test is kept out of the branch, or named by no static title. */
const CAPSULE_PATH_CODES: ReadonlySet<CriterionCode> = new Set<CriterionCode>(['CRITERION_TEST_UNKNOWN', 'CRITERION_NOT_RUN', 'CRITERION_EVIDENCE_UNBOUND', 'CRITERION_RED_REQUIRED', 'CRITERION_STALE_PROOF']);

/** The current capsule of the claim one of whose tests is `testId`, or null. */
export function capsuleOfTest(args: Pick<JudgeCriteriaArgs, 'controlRoot' | 'featureId' | 'node' | 'runtime'>, testId: string): { capsule_id: string; criterion: string; result: 'passed' | 'failed' } | null {
  for (const e of args.runtime.claim?.capsules ?? []) {
    const used = capsuleUse({ controlRoot: args.controlRoot, featureId: args.featureId, nodeId: args.node.id, runtime: args.runtime, capsuleId: e.capsule_id, capsuleSha256: e.capsule_sha256, criterion: null, want: null });
    if (used.ok && used.capsule.tests.some((t) => t.id === testId)) return { capsule_id: used.capsule.capsule_id, criterion: used.capsule.criterion, result: used.capsule.result };
  }
  return null;
}

/** What a worker does with a capsule a refusal's cause is: a passing one is challenged, a failing one promoted to a RED. */
export function capsulePathDetail(k: { capsule_id: string; criterion: string; result: 'passed' | 'failed' }, criterion: string, cause: string): string {
  return k.result === 'passed'
    ? `${cause} — the test is capsule ${k.capsule_id}'s (${k.criterion}), sealed passing on the unchanged base: it is never a proof of DONE and is never committed. Challenge ${criterion}'s gap with it: the challenge line with --capsule ${k.capsule_id}, outcome REVIEW_GAP_CHALLENGE (or that criterion's in a per-criterion answer); keep its files out of the branch. Nothing is charged for this.`
    : `${cause} — the test is capsule ${k.capsule_id}'s (${k.criterion}), sealed failing on the unchanged base: a RED. Commit exactly its files alone (test-first, statically named tests), run the red gate, then the fix; cite the red gate's failing test with "capsule_id": "${k.capsule_id}". Nothing is charged for this.`;
}

/** Criteria of the feature no DONE node evidenced (an E2E scenario that passed covers its own). */
export function uncoveredCriteria(graph: PortfolioGraph, nodes: Record<string, NodeRuntime>): string[] {
  const covered = new Set<string>();
  for (const n of graph.nodes) {
    const rt = nodes[n.id];
    if (rt?.state !== 'DONE') continue;
    if (n.node_type === 'e2e-scenario') for (const ac of n.acceptance_criteria ?? []) covered.add(ac);
    for (const c of rt.criteria ?? []) covered.add(c.criterion);
  }
  return graph.acceptance_criteria.map((a) => a.id).filter((id) => !covered.has(id));
}

/** Node types the controller runs itself: they evidence no criterion of their own (an E2E scenario covers its own by passing). */
const CONTROLLER_NODES: ReadonlySet<string> = new Set(['candidate-build']);

/**
 * The uncovered criteria nothing can cover any more, with their kinds: no
 * DONE node evidenced them, and no node that could still evidence one is
 * open (every producer node of it is DONE or EXCLUDED, or it has none).
 */
export function settledUncoveredCriteria(graph: PortfolioGraph, nodes: Record<string, NodeRuntime>): { id: string; kind: CriterionKind }[] {
  const uncovered = new Set(uncoveredCriteria(graph, nodes));
  return graph.acceptance_criteria
    .filter((a) => uncovered.has(a.id))
    .filter((a) => graph.nodes.filter((n) => !CONTROLLER_NODES.has(n.node_type) && (n.acceptance_criteria ?? []).includes(a.id)).every((n) => nodes[n.id]?.state === 'DONE' || nodes[n.id]?.state === 'EXCLUDED'))
    .map((a) => ({ id: a.id, kind: normalizeCriterionKind(a.kind) }));
}

/** SHA-256 over criteria as a claim binds them: id, kind, and the hash of the exact text, in graph order. */
export function criteriaSha256(criteria: readonly { id: string; kind?: string; text: string }[]): string {
  const rows = criteria.map((c) => [c.id, normalizeCriterionKind(c.kind), createHash('sha256').update(c.text).digest('hex')]);
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

