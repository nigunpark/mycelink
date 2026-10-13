/**
 * The independent acceptance review, judged mechanically (engine/acceptance-review.ts).
 *
 * CSET-203 r2: both with arms settled every node DONE under strict TDD, the
 * criterion evidence mapped AC-1 to a rollback test the red gate failed, and
 * hidden acceptance still found AC-1 broken: "when a changelog cannot be
 * written, every file is restored". The worker had tested rollback at a
 * package.json write only. A test id existing for a criterion says nothing
 * about which of its material clauses and boundaries were exercised.
 *
 * A read-only reviewer now judges every criterion before any candidate; its
 * verdict is advisory model evidence, but what it must contain is checked
 * here: the exact binding (feature, review, dispatch generation, inputs), a
 * verdict for every approved criterion and nothing else, every material
 * clause of a PASS traced to a test and the assertion's location, the
 * boundaries the text implies enumerated and covered, regression evidence
 * for a compatibility criterion, evidence ids the review packet catalogued,
 * and an overall verdict consistent with them. A GAP is mapped to its
 * producer node by the graph, never by the reviewer's word alone.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REVIEW_POLICY,
  MAX_CRITERION_CEILING,
  MAX_REVIEW_ROUNDS_LIMIT,
  REVIEWER_AGENT,
  REVIEW_VERDICT_SCHEMA,
  criterionClauses,
  gapReason,
  gapTargets,
  judgeVerdict,
  reviewInputsSha256,
  reviewPolicyOf,
  type ReviewInputs,
  type VerdictContext,
} from '../../src/engine/acceptance-review.js';
import { MAX_REWORK_REASON_BYTES } from '../../src/engine/rework-brief.js';
import { DEFAULT_CRITERION_CEILING } from '../../src/engine/review-lineage.js';
import type { PortfolioGraph } from '../../src/model/types.js';

const AC1 = "**AC-1 — rollback (apply-release-plan).** If `applyReleasePlan` fails after\nit has started changing files, it restores every file it changed, created or\ndeleted to its exact previous bytes (or absence) and removes directories it\ncreated, and only then rejects. The rejection's `cause` is the original\nerror.";
const AC2 = '**AC-2 — journal (apply-release-plan).** Before its first change,\n`applyReleasePlan` durably records what it is about to change in a recovery\njournal stored inside `.changeset/` under a name that starts with `.`, so it\nis never read as a changeset. It removes the journal once the run has\ncompleted, successfully or after a rollback. The journal\'s format is up to\nyou.';
const AC3 = '**AC-3 — recovery (CLI).** Before it reads anything else, `changeset\nversion` looks for a journal left by an interrupted run — for example after\nthe process was killed while applying. If it finds one, it restores the\nstate recorded in it, removes the journal, prints a warning that contains\nthe word `interrupted`, and then versions normally. The final result is the\nsame as one uninterrupted run: every package is bumped once and every\nchangeset is consumed once.';
const AC5 = '**AC-5 — compatibility.** A run that succeeds produces exactly the same files\nas today and leaves no journal behind. `changeset status` and\n`changeset add` are unaffected by a journal.';

const ARP = 'CSET-203.changesets.apply-release-plan.crash-safe';
const CLI = 'CSET-203.changesets.cli.version-recovery';
const COMPAT = 'CSET-203.changesets.compat.regression';
const CANDIDATE = 'CSET-203.candidate.build';

describe('criterionClauses: the material clauses of an approved criterion, verbatim', () => {
  it('drops the bold label and splits sentences, numbered under the criterion', () => {
    expect(criterionClauses('AC-1', AC1)).toEqual([
      { id: 'AC-1.1', text: 'If `applyReleasePlan` fails after it has started changing files, it restores every file it changed, created or deleted to its exact previous bytes (or absence) and removes directories it created, and only then rejects.' },
      { id: 'AC-1.2', text: "The rejection's `cause` is the original error." },
    ]);
    expect(criterionClauses('AC-3', AC3).map((c) => c.id)).toEqual(['AC-3.1', 'AC-3.2', 'AC-3.3']);
    expect(criterionClauses('AC-3', AC3)[0]!.text).toBe('Before it reads anything else, `changeset version` looks for a journal left by an interrupted run — for example after the process was killed while applying.');
  });

  it('splits on semicolons and an inline label, keeps abbreviations and list items apart', () => {
    expect(criterionClauses('AC-4', 'AC-4 failure (CLI): when applying fails, it prints the failure without a stack trace and exits with code 1; it does not run git add or git commit, e.g. when commit is enabled.')).toEqual([
      { id: 'AC-4.1', text: 'when applying fails, it prints the failure without a stack trace and exits with code 1;' },
      { id: 'AC-4.2', text: 'it does not run git add or git commit, e.g. when commit is enabled.' },
    ]);
    expect(criterionClauses('AC-7', '- **AC-7** The report lists:\n  - every package\n  - every changeset').map((c) => c.text)).toEqual(['The report lists:', 'every package', 'every changeset']);
  });

  it('never yields an empty list, and bounds a long criterion', () => {
    expect(criterionClauses('AC-9', '**AC-9**')).toEqual([{ id: 'AC-9.1', text: '**AC-9**' }]);
    const long = Array.from({ length: 40 }, (_, i) => `Clause number ${i} holds.`).join(' ');
    const clauses = criterionClauses('AC-8', long);
    expect(clauses.length).toBeLessThanOrEqual(16);
    expect(clauses.map((c) => c.text).join(' ')).toBe(long);
  });
});

describe('reviewPolicyOf: the review is on unless the control repository opts out, rounds bounded', () => {
  // What every default policy holds beside its rounds (CSET-201 final): the emergency ceiling, the session budget, no wall-clock budget.
  const safety = { criterion_ceiling: DEFAULT_CRITERION_CEILING, max_review_sessions: 8, review_wall_clock_ms: null };

  it('defaults to required with two review-rework rounds per criterion, then progress-gated reworks up to the ceiling', () => {
    expect(DEFAULT_REVIEW_POLICY).toEqual({ required: true, max_rounds: 2 });
    // The reviewer's wall-clock from its launch (CSET-203 r13): 20 minutes unless said otherwise.
    expect(reviewPolicyOf({})).toEqual({ required: true, max_rounds: 2, reviewer_timeout_ms: 1_200_000, ...safety });
    expect(reviewPolicyOf({ acceptance_review: { max_rounds: 3 } })).toEqual({ required: true, max_rounds: 3, reviewer_timeout_ms: 1_200_000, ...safety });
    expect(reviewPolicyOf({ acceptance_review: { required: false } })).toEqual({ required: false, max_rounds: 2, reviewer_timeout_ms: 1_200_000, ...safety });
    expect(reviewPolicyOf({ acceptance_review: { reviewer_timeout_seconds: 1800 } })).toEqual({ required: true, max_rounds: 2, reviewer_timeout_ms: 1_800_000, ...safety });
    // The CSET-201 final control repository's policy, `max_rounds: 2`: two rounds by budget, never a cap of two.
    expect(reviewPolicyOf({ acceptance_review: { required: true, max_rounds: 2 } }).criterion_ceiling).toBeGreaterThan(2);
  });

  it('takes a configured emergency ceiling, review-session budget and review wall-clock budget', () => {
    expect(reviewPolicyOf({ acceptance_review: { criterion_ceiling: 10, max_review_sessions: 12, review_wall_clock_minutes: 240 } })).toEqual({ required: true, max_rounds: 2, reviewer_timeout_ms: 1_200_000, criterion_ceiling: 10, max_review_sessions: 12, review_wall_clock_ms: 240 * 60_000 });
    // A ceiling below the rounds is the rounds' own: max_rounds 5 with no ceiling given keeps at least 5.
    expect(reviewPolicyOf({ acceptance_review: { max_rounds: 5 } }).criterion_ceiling).toBe(Math.max(5, DEFAULT_CRITERION_CEILING));
    for (const bad of [{ criterion_ceiling: 1, max_rounds: 2 }, { criterion_ceiling: 0 }, { criterion_ceiling: MAX_CRITERION_CEILING + 1 }, { criterion_ceiling: 2.5 }, { max_review_sessions: 0 }, { max_review_sessions: 65 }, { review_wall_clock_minutes: 0 }, { review_wall_clock_minutes: 7 * 24 * 60 + 1 }, { review_wall_clock_minutes: '60' }]) {
      expect(() => reviewPolicyOf({ acceptance_review: bad as never }), JSON.stringify(bad)).toThrow(/REVIEW_POLICY_INVALID/);
    }
  });

  it('refuses a reviewer wall-clock that is not a whole number of seconds within a day', () => {
    for (const bad of [0, -1, 1.5, '600', 86_401]) {
      expect(() => reviewPolicyOf({ acceptance_review: { reviewer_timeout_seconds: bad as never } }), JSON.stringify(bad)).toThrow(/REVIEW_POLICY_INVALID: .*reviewer_timeout_seconds/);
    }
  });

  it('refuses an unbounded or malformed policy', () => {
    for (const bad of [{ max_rounds: 0 }, { max_rounds: MAX_REVIEW_ROUNDS_LIMIT + 1 }, { max_rounds: 1.5 }, { max_rounds: '2' }, { required: 'yes' }, { rounds: 2 }, 'on', null]) {
      expect(() => reviewPolicyOf({ acceptance_review: bad as never }), JSON.stringify(bad)).toThrow(/REVIEW_POLICY_INVALID/);
    }
  });
});

const inputs: ReviewInputs = {
  feature_id: 'CSET-203',
  graph_sha256: 'a'.repeat(64),
  criteria_sha256: 'b'.repeat(64),
  manifest_sha256: 'c'.repeat(64),
  repositories: [{ name: 'changesets', head_sha: '1'.repeat(40) }],
};

describe('reviewInputsSha256: what a review binds', () => {
  it('changes with any repository head, the graph, the criteria or the manifest', () => {
    const base = reviewInputsSha256(inputs);
    expect(reviewInputsSha256(structuredClone(inputs))).toBe(base);
    expect(reviewInputsSha256({ ...inputs, graph_sha256: 'd'.repeat(64) })).not.toBe(base);
    expect(reviewInputsSha256({ ...inputs, criteria_sha256: 'd'.repeat(64) })).not.toBe(base);
    expect(reviewInputsSha256({ ...inputs, manifest_sha256: null })).not.toBe(base);
    expect(reviewInputsSha256({ ...inputs, repositories: [{ name: 'changesets', head_sha: '2'.repeat(40) }] })).not.toBe(base);
  });
});

const T_ROLLBACK = 'test:1111111111111111';
const T_JOURNAL = 'test:2222222222222222';
const T_RECOVERY = 'test:3333333333333333';

function context(over: Partial<VerdictContext> = {}): VerdictContext {
  return {
    feature_id: 'CSET-203',
    review_id: 'CSET-203-R001',
    dispatch_id: '0f6c2b1e-1b0a-4d7c-9a51-2f0f0e8b6a10',
    inputs_sha256: 'e'.repeat(64),
    repositories: ['changesets'],
    criteria: [
      { id: 'AC-1', kind: 'new-behavior', text: AC1, sha256: '0'.repeat(64), clauses: criterionClauses('AC-1', AC1) },
      { id: 'AC-2', kind: 'new-behavior', text: AC2, sha256: '0'.repeat(64), clauses: criterionClauses('AC-2', AC2) },
      { id: 'AC-5', kind: 'compatibility', text: AC5, sha256: '0'.repeat(64), clauses: criterionClauses('AC-5', AC5) },
    ],
    evidence: new Map([
      [T_ROLLBACK, { kind: 'test' as const }],
      [T_JOURNAL, { kind: 'test' as const }],
      [T_RECOVERY, { kind: 'test' as const }],
      [`gate:${ARP}:red`, { kind: 'gate' as const, gate: 'red' as const }],
      [`gate:${ARP}:regression`, { kind: 'gate' as const, gate: 'regression' as const }],
      [`receipt:${COMPAT}`, { kind: 'receipt' as const }],
    ]),
    fileExists: (repo, path) => repo === 'changesets' && ['packages/apply-release-plan/src/index.test.ts', 'packages/apply-release-plan/src/index.ts', 'packages/cli/src/run.test.ts'].includes(path),
    ...over,
  };
}

const TEST_FILE = 'file:changesets:packages/apply-release-plan/src/index.test.ts';

/** A trace of every clause of a criterion to the given evidence. */
const traces = (ctx: VerdictContext, id: string, evidence: string[]) =>
  (ctx.criteria.find((c) => c.id === id)?.clauses ?? []).map((c) => ({ clause: c.id, evidence, trace: `asserted in the test at ${evidence[evidence.length - 1]}` }));

function passing(ctx: VerdictContext = context()): Record<string, any> {
  return {
    schema: REVIEW_VERDICT_SCHEMA,
    feature_id: ctx.feature_id,
    review_id: ctx.review_id,
    dispatch_id: ctx.dispatch_id,
    inputs_sha256: ctx.inputs_sha256,
    reviewer: { agent: REVIEWER_AGENT, model: 'claude-test-model' },
    criteria: [
      {
        criterion: 'AC-1',
        verdict: 'PASS',
        confidence: 'high',
        clauses: traces(ctx, 'AC-1', [T_ROLLBACK, `${TEST_FILE}#L3620-L3660`]),
        boundaries: [
          { kind: 'partial-write', boundary: 'a package.json write fails after another package was written', covered: true, evidence: [T_ROLLBACK] },
          { kind: 'failure', boundary: 'the changelog writer fails after package/version writes', covered: true, evidence: [T_ROLLBACK] },
        ],
        gap: null,
        producer: null,
      },
      {
        criterion: 'AC-2',
        verdict: 'PASS',
        confidence: 'medium',
        clauses: traces(ctx, 'AC-2', [T_JOURNAL, `${TEST_FILE}#L3680`]),
        boundaries: [{ kind: 'order', boundary: 'the journal exists before the first write', covered: true, evidence: [T_JOURNAL] }],
        gap: null,
        producer: null,
      },
      {
        criterion: 'AC-5',
        verdict: 'PASS',
        confidence: 'high',
        clauses: traces(ctx, 'AC-5', [`receipt:${COMPAT}`, `gate:${ARP}:regression`]),
        boundaries: [],
        gap: null,
        producer: null,
      },
    ],
    overall: 'PASS',
  };
}

function gapOnAc1(ctx: VerdictContext = context()): Record<string, any> {
  const v = passing(ctx);
  v.criteria[0] = {
    criterion: 'AC-1',
    verdict: 'GAP',
    confidence: 'high',
    clauses: traces(ctx, 'AC-1', [T_ROLLBACK, `${TEST_FILE}#L3620-L3660`]),
    boundaries: [{ kind: 'partial-write', boundary: 'the changelog writer fails after package/version writes', covered: false, evidence: [] }],
    gap: { missing: 'rollback is only tested when a package.json write fails; no test fails the changelog write after the package versions were written', reproduction: 'inject changelog writer failure after package/version writes and assert exact rollback' },
    producer: { node_id: ARP, module: 'changesets:packages/apply-release-plan' },
  };
  v.overall = 'GAPS';
  return v;
}

describe('judgeVerdict: a verdict is advisory, its shape, coverage and bindings are not', () => {
  it('accepts a PASS that traces every clause and boundary of every criterion', () => {
    const judged = judgeVerdict(passing(), context());
    expect(judged).toMatchObject({ ok: true, overall: 'PASS', gaps: [] });
  });

  it('accepts a GAP with a public reproduction, and names its gap', () => {
    const judged = judgeVerdict(gapOnAc1(), context());
    expect(judged).toMatchObject({ ok: true, overall: 'GAPS' });
    if (!judged.ok) throw new Error('refused');
    expect(judged.gaps).toEqual([
      expect.objectContaining({ criterion: 'AC-1', reproduction: 'inject changelog writer failure after package/version writes and assert exact rollback', producer: { node_id: ARP, module: 'changesets:packages/apply-release-plan' }, confidence: 'high' }),
    ]);
  });

  it('refuses a malformed verdict', () => {
    const ctx = context();
    const cases: [unknown, RegExp][] = [
      [null, /REVIEW_VERDICT_INVALID/],
      ['PASS', /REVIEW_VERDICT_INVALID/],
      [{ ...passing(), schema: 'mycelink-acceptance-review/0' }, /REVIEW_VERDICT_INVALID/],
      [{ ...passing(), extra: true }, /REVIEW_VERDICT_INVALID/],
      [{ ...passing(), reviewer: { agent: 'mycelink:module-worker', model: 'x' } }, /REVIEW_VERDICT_INVALID/],
      [{ ...passing(), reviewer: { agent: REVIEWER_AGENT } }, /REVIEW_VERDICT_INVALID/],
      [{ ...passing(), overall: 'MOSTLY' }, /REVIEW_VERDICT_INVALID/],
      [{ ...passing(), criteria: [...passing().criteria, passing().criteria[0]] }, /REVIEW_VERDICT_INVALID/],
    ];
    // An over-long trace is prose: cut and marked, not refused (CSET-203 r5; review-verdict-canonical.test.ts).
    const longTrace = passing();
    longTrace.criteria[0].clauses[0].trace = 'x'.repeat(5000);
    const cut = judgeVerdict(longTrace, ctx);
    expect(cut.ok && cut.normalization.changed.map((c) => [c.action, c.original_length])).toEqual([['truncated', 5000]]);
    const badConfidence = passing();
    badConfidence.criteria[1].confidence = 0.9;
    cases.push([badConfidence, /REVIEW_VERDICT_INVALID/]);
    for (const [raw, code] of cases) {
      const judged = judgeVerdict(raw, ctx);
      expect(judged.ok, JSON.stringify(raw)?.slice(0, 200)).toBe(false);
      if (!judged.ok) expect(`${judged.code}: ${judged.detail}`).toMatch(code);
    }
  });

  it('refuses a verdict bound to another review, generation, feature or inputs (forged or stale)', () => {
    const ctx = context();
    for (const key of ['review_id', 'dispatch_id', 'inputs_sha256', 'feature_id'] as const) {
      const v = passing();
      v[key] = key === 'inputs_sha256' ? 'f'.repeat(64) : key === 'feature_id' ? 'CSET-202' : `${v[key]}x`;
      const judged = judgeVerdict(v, ctx);
      expect(judged.ok).toBe(false);
      if (!judged.ok) expect(judged.code).toBe('REVIEW_BINDING_MISMATCH');
    }
  });

  it('refuses a PASS that leaves out an approved criterion, or names one that is not approved', () => {
    const missing = passing();
    missing.criteria = missing.criteria.filter((c: { criterion: string }) => c.criterion !== 'AC-5');
    const judged = judgeVerdict(missing, context());
    expect(judged).toMatchObject({ ok: false, code: 'REVIEW_INCOMPLETE' });
    if (!judged.ok) expect(judged.detail).toContain('AC-5');
    const invented = passing();
    invented.criteria.push({ ...invented.criteria[1], criterion: 'AC-9' });
    expect(judgeVerdict(invented, context())).toMatchObject({ ok: false, code: 'REVIEW_INCOMPLETE' });
  });

  it('never accepts a criterion because a test id exists: every material clause is traced to a test and its assertion', () => {
    const untraced = passing();
    untraced.criteria[0].clauses = untraced.criteria[0].clauses.slice(0, 1);
    const a = judgeVerdict(untraced, context());
    expect(a).toMatchObject({ ok: false, code: 'REVIEW_TRACE_INCOMPLETE' });
    if (!a.ok) expect(a.detail).toContain('AC-1.2');

    const testOnly = passing();
    testOnly.criteria[0].clauses = traces(context(), 'AC-1', [T_ROLLBACK]);
    const b = judgeVerdict(testOnly, context());
    expect(b).toMatchObject({ ok: false, code: 'REVIEW_TRACE_INCOMPLETE' });
    if (!b.ok) expect(b.detail).toMatch(/assert/);

    const fileOnly = passing();
    fileOnly.criteria[1].clauses = traces(context(), 'AC-2', [`${TEST_FILE}#L3680`]);
    expect(judgeVerdict(fileOnly, context())).toMatchObject({ ok: false, code: 'REVIEW_TRACE_INCOMPLETE' });

    const emptyTrace = passing();
    emptyTrace.criteria[0].clauses[1].trace = '  ';
    expect(judgeVerdict(emptyTrace, context())).toMatchObject({ ok: false });
  });

  it('a new behaviour names the boundaries its text implies; a PASS covers each of them by a test', () => {
    const none = passing();
    none.criteria[0].boundaries = [];
    expect(judgeVerdict(none, context())).toMatchObject({ ok: false, code: 'REVIEW_TRACE_INCOMPLETE' });
    const uncovered = passing();
    uncovered.criteria[0].boundaries[1] = { kind: 'partial-write', boundary: 'the changelog writer fails after package/version writes', covered: false, evidence: [] };
    expect(judgeVerdict(uncovered, context())).toMatchObject({ ok: false, code: 'REVIEW_INCONSISTENT' });
    const unproved = passing();
    unproved.criteria[0].boundaries[1].evidence = [`${TEST_FILE}#L1`];
    expect(judgeVerdict(unproved, context())).toMatchObject({ ok: false, code: 'REVIEW_TRACE_INCOMPLETE' });
  });

  it('where the gates published no test ids at all, the assertion\'s file location names the test', () => {
    const noIds = context({ evidence: new Map([[`gate:${ARP}:red`, { kind: 'gate' as const, gate: 'red' as const }], [`receipt:${COMPAT}`, { kind: 'receipt' as const }], [`gate:${ARP}:regression`, { kind: 'gate' as const, gate: 'regression' as const }]]) });
    const v = passing(noIds);
    v.criteria[0].clauses = traces(noIds, 'AC-1', [`${TEST_FILE}#L3620-L3660`]);
    v.criteria[0].boundaries = [{ kind: 'partial-write', boundary: 'the changelog write fails', covered: true, evidence: [TEST_FILE] }];
    v.criteria[1].clauses = traces(noIds, 'AC-2', [`${TEST_FILE}#L3680`]);
    v.criteria[1].boundaries = [{ kind: 'order', boundary: 'journal first', covered: true, evidence: [TEST_FILE] }];
    expect(judgeVerdict(v, noIds)).toMatchObject({ ok: true, overall: 'PASS' });
    // With test ids catalogued, a file alone is not a test.
    expect(judgeVerdict(v, context())).toMatchObject({ ok: false, code: 'REVIEW_TRACE_INCOMPLETE' });
  });

  it('a compatibility PASS stands on regression evidence', () => {
    const v = passing();
    v.criteria[2].clauses = traces(context(), 'AC-5', [T_RECOVERY]);
    const judged = judgeVerdict(v, context());
    expect(judged).toMatchObject({ ok: false, code: 'REVIEW_TRACE_INCOMPLETE' });
    if (!judged.ok) expect(judged.detail).toMatch(/regression/);
  });

  /** A GAP on AC-5 as r3's reviewer wrote it: AC-5.2 cites the receipt alone, and says what no test shows. */
  function gapOnAc5(ctx: VerdictContext = context()): Record<string, any> {
    const v = passing(ctx);
    const [first, second] = criterionClauses('AC-5', AC5);
    v.criteria[2] = {
      criterion: 'AC-5',
      verdict: 'GAP',
      confidence: 'medium',
      clauses: [
        { clause: first!.id, evidence: [`receipt:${COMPAT}`, `gate:${ARP}:regression`, T_JOURNAL], trace: 'the full suite passed on the reviewed head; the journal test shows a success leaves no journal' },
        { clause: second!.id, evidence: [`receipt:${COMPAT}`], trace: "the full suite passes, but no test places a journal in .changeset and runs status or add, so 'unaffected by a journal' is not shown" },
      ],
      boundaries: [{ kind: 'state', boundary: 'status and add with a leftover journal present', covered: false, evidence: [] }],
      gap: { missing: 'no regression evidence runs changeset status or add with a journal present', reproduction: 'create .changeset/.journal beside a changeset, run status and add, assert the same output and exit code as without it' },
      producer: { node_id: COMPAT },
    };
    v.overall = 'GAPS';
    return v;
  }

  it('a compatibility GAP names a material clause no test covers and a public reproduction', () => {
    expect(judgeVerdict(gapOnAc5(), context())).toMatchObject({ ok: true, overall: 'GAPS', gaps: [expect.objectContaining({ criterion: 'AC-5', untested: ['AC-5.2'] })] });
    // A clause shown by the suite alone is untested too: no assertion of it is cited.
    const suiteOnly = gapOnAc5();
    suiteOnly.criteria[2].clauses[0].evidence = [`receipt:${COMPAT}`];
    expect(judgeVerdict(suiteOnly, context())).toMatchObject({ ok: true, gaps: [expect.objectContaining({ untested: ['AC-5.1', 'AC-5.2'] })] });
    // Every clause traced to a test: nothing untested is named, so the GAP is no finding.
    const allTested = gapOnAc5();
    allTested.criteria[2].clauses = allTested.criteria[2].clauses.map((c: Record<string, any>) => ({ ...c, evidence: [...c.evidence, T_RECOVERY] }));
    const a = judgeVerdict(allTested, context());
    expect(a).toMatchObject({ ok: false, code: 'REVIEW_TRACE_INCOMPLETE' });
    if (!a.ok) expect(a.detail).toMatch(/AC-5.*material clause/);
    // An untested clause with nothing said about it is no finding either.
    const silent = gapOnAc5();
    silent.criteria[2].clauses[1].trace = ' ';
    expect(judgeVerdict(silent, context())).toMatchObject({ ok: false, code: 'REVIEW_TRACE_INCOMPLETE' });
    const none = gapOnAc5();
    none.criteria[2].clauses = [];
    expect(judgeVerdict(none, context())).toMatchObject({ ok: false, code: 'REVIEW_TRACE_INCOMPLETE' });
  });

  it('after a compatibility GAP, a PASS of that criterion traces each clause found untested to a test the gates passed', () => {
    const T_COMPAT = 'test:4444444444444444';
    const prior = context({
      prior_gaps: [{ review_id: 'CSET-203-R001', criterion: 'AC-5', untested: ['AC-5.2'] }],
      evidence: new Map([...context().evidence, [T_COMPAT, { kind: 'test' as const, passed: true }], [T_RECOVERY, { kind: 'test' as const, passed: false }]]),
    });
    // R001's PASS evidence (the receipt and the regression gate) no longer settles AC-5.
    const receiptOnly = judgeVerdict(passing(prior), prior);
    expect(receiptOnly).toMatchObject({ ok: false, code: 'REVIEW_TRACE_INCOMPLETE' });
    if (!receiptOnly.ok) expect(receiptOnly.detail).toMatch(/AC-5\.2.*CSET-203-R001.*passed/);
    // A test the gates never passed is no concrete evidence either.
    const unpassed = passing(prior);
    unpassed.criteria[2].clauses[1].evidence = [`receipt:${COMPAT}`, T_RECOVERY];
    expect(judgeVerdict(unpassed, prior)).toMatchObject({ ok: false, code: 'REVIEW_TRACE_INCOMPLETE' });
    const concrete = passing(prior);
    concrete.criteria[2].clauses[1].evidence = [`receipt:${COMPAT}`, T_COMPAT, 'file:changesets:packages/cli/src/run.test.ts#L10-L20'];
    expect(judgeVerdict(concrete, prior)).toMatchObject({ ok: true, overall: 'PASS' });
    // Another criterion's earlier gap asks nothing of AC-5.
    const elsewhere = context({ prior_gaps: [{ review_id: 'CSET-203-R001', criterion: 'AC-2', untested: ['AC-2.1'] }] });
    expect(judgeVerdict(passing(elsewhere), elsewhere)).toMatchObject({ ok: true });
  });

  it('refuses evidence the packet does not catalogue, and files the reviewed head does not hold', () => {
    for (const ref of ['test:9999999999999999', `gate:${CLI}:red`, 'receipt:CSET-203.other', 'file:changesets:packages/nope.ts', 'file:other:packages/apply-release-plan/src/index.ts', 'file:changesets:../escape.ts', 'file:changesets:/etc/passwd', 'evidence-of-my-own']) {
      const v = passing();
      v.criteria[1].clauses[0].evidence = [T_JOURNAL, ref];
      const judged = judgeVerdict(v, context());
      expect(judged.ok, ref).toBe(false);
      if (!judged.ok) expect(judged.code, ref).toBe('REVIEW_EVIDENCE_UNKNOWN');
    }
  });

  it('refuses an overall verdict its criteria contradict, and a GAP with no public reproduction', () => {
    const pass = gapOnAc1();
    pass.overall = 'PASS';
    expect(judgeVerdict(pass, context())).toMatchObject({ ok: false, code: 'REVIEW_INCONSISTENT' });
    const gaps = passing();
    gaps.overall = 'GAPS';
    expect(judgeVerdict(gaps, context())).toMatchObject({ ok: false, code: 'REVIEW_INCONSISTENT' });
    const silent = gapOnAc1();
    silent.criteria[0].gap = { missing: 'something', reproduction: '' };
    expect(judgeVerdict(silent, context())).toMatchObject({ ok: false });
    const passWithGap = passing();
    passWithGap.criteria[1].gap = { missing: 'x', reproduction: 'y' };
    expect(judgeVerdict(passWithGap, context())).toMatchObject({ ok: false, code: 'REVIEW_INCONSISTENT' });
  });
});

const worker = { model: 'sonnet', max_turns: 10, max_wall_clock_minutes: 10, max_attempts: 2, nested_delegation: false };
function node(id: string, extra: Record<string, unknown>): Record<string, unknown> {
  return { id, level: 'executable-node', repository: 'changesets', capability: null, node_type: 'implementation', depends_on: [], allowed_paths: [], forbidden_paths: [], required_resources: [], required_evidence: ['red', 'green', 'regression'], verification_commands: [], worker, ...extra };
}
const GRAPH = {
  schema_version: 1,
  feature_id: 'CSET-203',
  title: 'Crash-safe changeset version',
  acceptance_criteria: [
    { id: 'AC-1', text: AC1, kind: 'new-behavior' },
    { id: 'AC-2', text: AC2, kind: 'new-behavior' },
    { id: 'AC-3', text: AC3, kind: 'new-behavior' },
    { id: 'AC-5', text: AC5, kind: 'compatibility' },
    { id: 'AC-6', text: 'Both packages report the same version.', kind: 'new-behavior' },
  ],
  resources: {},
  repositories: ['changesets'],
  capabilities: [],
  nodes: [
    node(ARP, { allowed_paths: ['packages/apply-release-plan/**'], acceptance_criteria: ['AC-1', 'AC-2', 'AC-6'] }),
    node(CLI, { allowed_paths: ['packages/cli/**'], depends_on: [ARP], acceptance_criteria: ['AC-3', 'AC-6'] }),
    node(COMPAT, { node_type: 'verification', depends_on: [ARP, CLI], required_evidence: ['regression'], acceptance_criteria: ['AC-5'] }),
    node(CANDIDATE, { repository: null, node_type: 'candidate-build', depends_on: [COMPAT], required_evidence: ['candidate'] }),
  ],
} as unknown as PortfolioGraph;

const gap = (criterion: string, producer: { node_id?: string; module?: string } | null = null) => ({ criterion, missing: `${criterion} untested`, reproduction: `reproduce ${criterion}`, producer, confidence: 'high' as const });

/** GRAPH with AC-5 produced by the cli as well as proved by the verification node: the ownership every graph has now. */
const OWNED = structuredClone(GRAPH) as unknown as PortfolioGraph;
(OWNED.nodes.find((n) => n.id === CLI) as { acceptance_criteria: string[] }).acceptance_criteria = ['AC-3', 'AC-5', 'AC-6'];

describe('gapTargets: a GAP goes to the producers the graph says serve its criterion, never where the reviewer says', () => {
  it('maps a criterion to its only producer, whatever the reviewer named', () => {
    expect(gapTargets(OWNED, [gap('AC-1', { node_id: ARP })])).toEqual({ targets: [{ node_id: ARP, criteria: ['AC-1'], gaps: [gap('AC-1', { node_id: ARP })], by: 'criterion' }], unowned: [] });
    for (const producer of [{ node_id: CLI }, { node_id: COMPAT }, { node_id: 'CSET-203.nowhere' }, { module: 'changesets:packages/cli/' }, null]) {
      expect(gapTargets(OWNED, [gap('AC-1', producer)]), JSON.stringify(producer)).toMatchObject({ targets: [{ node_id: ARP, criteria: ['AC-1'], by: 'criterion' }], unowned: [] });
    }
  });

  it('a compatibility criterion goes to its product producer, though the reviewer named the verification node that proves it (r3)', () => {
    expect(gapTargets(OWNED, [gap('AC-5', { node_id: COMPAT })])).toMatchObject({ targets: [{ node_id: CLI, criteria: ['AC-5'], by: 'criterion' }], unowned: [] });
  });

  it('several producers of one criterion: a repository/path the reviewer gave picks the one owning it, else every producer reworks', () => {
    expect(gapTargets(OWNED, [gap('AC-6', { module: 'changesets:packages/apply-release-plan/' })])).toMatchObject({ targets: [{ node_id: ARP, by: 'path' }] });
    expect(gapTargets(OWNED, [gap('AC-6', { module: 'packages/cli/src/commands/version' })])).toMatchObject({ targets: [{ node_id: CLI, by: 'path' }] });
    // A node id is no repository/path: it decides nothing.
    expect(gapTargets(OWNED, [gap('AC-6', { node_id: CLI })])).toMatchObject({ targets: [{ node_id: CLI, by: 'criterion' }, { node_id: ARP, by: 'criterion' }] });
    // Dependents first, so each keeps the review's reason as its own brief.
    expect(gapTargets(OWNED, [gap('AC-6')])).toMatchObject({ targets: [{ node_id: CLI, by: 'criterion' }, { node_id: ARP, by: 'criterion' }] });
    expect(gapTargets(OWNED, [gap('AC-6', { module: 'changesets:docs/' })])).toMatchObject({ targets: [{ node_id: CLI }, { node_id: ARP }] });
  });

  it('gathers several gaps of one producer into one target, criteria in graph order', () => {
    expect(gapTargets(OWNED, [gap('AC-5'), gap('AC-2'), gap('AC-3'), gap('AC-1')])).toMatchObject({
      targets: [
        { node_id: CLI, criteria: ['AC-3', 'AC-5'] },
        { node_id: ARP, criteria: ['AC-1', 'AC-2'] },
      ],
      unowned: [],
    });
  });

  it('a graph from before ownership (r3: AC-5 on the verification node alone): the mapped gaps keep their targets, the unowned one is returned apart', () => {
    const mapped = gapTargets(GRAPH, [gap('AC-1'), gap('AC-3'), gap('AC-5', { node_id: COMPAT })]);
    expect(mapped.targets.map((t) => [t.node_id, t.criteria])).toEqual([
      [CLI, ['AC-3']],
      [ARP, ['AC-1']],
    ]);
    expect(mapped.unowned.map((g) => g.criterion)).toEqual(['AC-5']);
    // Whatever the reviewer names, a criterion no producer serves stays unowned.
    for (const producer of [null, { node_id: CLI }, { module: 'changesets:packages/cli/' }, { node_id: CANDIDATE }]) {
      expect(gapTargets(GRAPH, [gap('AC-5', producer)]), JSON.stringify(producer)).toMatchObject({ targets: [], unowned: [{ criterion: 'AC-5' }] });
    }
  });
});

describe("CSET-203 r3's own verdict R001, mapped on the graph", () => {
  const r001 = JSON.parse(readFileSync(join(process.cwd(), 'tests', 'benchmark', 'fixtures', 'cset203-r3', 'R001.json'), 'utf8')) as { gaps: { criterion: string; missing: string; reproduction: string; producer: { node_id?: string } | null; confidence: 'high' | 'medium' | 'low' }[] };
  const r3Graph = JSON.parse(readFileSync(join(process.cwd(), 'tests', 'benchmark', 'fixtures', 'cset203-r3', 'PORTFOLIO-GRAPH.json'), 'utf8')) as PortfolioGraph;
  const R3_ARP = 'CSET-203.arp.rollback-journal.impl';
  const R3_CLI = 'CSET-203.cli.recovery-failure.impl';

  it('r3 graph: AC-1 to apply-release-plan and AC-3 to the cli are kept; AC-5 has no product producer', () => {
    const mapped = gapTargets(r3Graph, r001.gaps);
    expect(mapped.targets.map((t) => [t.node_id, t.criteria])).toEqual([
      [R3_CLI, ['AC-3']],
      [R3_ARP, ['AC-1']],
    ]);
    expect(mapped.unowned.map((g) => [g.criterion, g.producer])).toEqual([['AC-5', { node_id: 'CSET-203.changesets.compat.verify' }]]);
  });

  it('the verdict itself stays valid: public GAPs on AC-1, AC-3 and AC-5, AC-5 naming its untested clause AC-5.2', () => {
    const full = JSON.parse(readFileSync(join(process.cwd(), 'tests', 'benchmark', 'fixtures', 'cset203-r3', 'R001.json'), 'utf8')) as { verdict: { criteria: { criterion: string; clauses: { evidence: string[] }[]; boundaries: { evidence: string[] }[] }[] } };
    const ids = new Set(full.verdict.criteria.flatMap((c) => [...c.clauses.flatMap((x) => x.evidence), ...c.boundaries.flatMap((b) => b.evidence)]));
    const ctx: VerdictContext = {
      feature_id: 'CSET-203',
      review_id: 'CSET-203-R001',
      dispatch_id: '79f1ee72-919c-403b-b19d-26fb4ca42ea4',
      inputs_sha256: 'd0fd823ff4a54f0236cead5231e7082ff3fc843be56fa17dceae17ba42d9e44b',
      repositories: ['changesets'],
      criteria: r3Graph.acceptance_criteria.map((a) => ({ id: a.id, kind: (a.kind ?? 'new-behavior') as 'new-behavior' | 'compatibility', text: a.text, sha256: '0'.repeat(64), clauses: criterionClauses(a.id, a.text) })),
      evidence: new Map(
        [...ids]
          .filter((e) => !e.startsWith('file:'))
          .map((e) => [e, e.startsWith('test:') ? { kind: 'test' as const, passed: true } : e.startsWith('gate:') ? { kind: 'gate' as const, gate: e.split(':').pop() as 'red' | 'green' | 'regression' } : { kind: 'receipt' as const }]),
      ),
      fileExists: () => true,
    };
    const raw = { schema: REVIEW_VERDICT_SCHEMA, feature_id: ctx.feature_id, review_id: ctx.review_id, dispatch_id: ctx.dispatch_id, inputs_sha256: ctx.inputs_sha256, reviewer: { agent: REVIEWER_AGENT, model: 'claude-sonnet-5-5' }, criteria: full.verdict.criteria, overall: 'GAPS' };
    const judged = judgeVerdict(raw, ctx);
    expect(judged).toMatchObject({ ok: true, overall: 'GAPS' });
    if (!judged.ok) throw new Error(judged.detail);
    expect(judged.gaps.map((g) => [g.criterion, g.untested ?? null])).toEqual([
      ['AC-1', null],
      ['AC-3', null],
      ['AC-5', ['AC-5.2']],
    ]);
  });

  it('corrected graph (the cli produces AC-5): every gap maps, AC-3 and AC-5 to the cli in one target', () => {
    const corrected = structuredClone(r3Graph);
    (corrected.nodes.find((n) => n.id === R3_CLI) as { acceptance_criteria: string[] }).acceptance_criteria = ['AC-3', 'AC-4', 'AC-5'];
    const mapped = gapTargets(corrected, r001.gaps);
    expect(mapped.unowned).toEqual([]);
    expect(mapped.targets.map((t) => [t.node_id, t.criteria, t.by])).toEqual([
      [R3_CLI, ['AC-3', 'AC-5'], 'criterion'],
      [R3_ARP, ['AC-1'], 'criterion'],
    ]);
  });
});

describe('gapReason: the public reason a reworked producer is handed', () => {
  it('names the review, the round, the criterion and the exact reproduction, and asks for a focused RED', () => {
    const reason = gapReason({ reviewId: 'CSET-203-R001', review: 1, budgets: { 'AC-1': { used: 0, max: 2 } }, gaps: [{ ...gap('AC-1'), missing: 'no test fails the changelog write', reproduction: 'inject changelog writer failure after package/version writes and assert exact rollback' }], kindOf: () => 'new-behavior' });
    expect(reason).toContain('CSET-203-R001');
    expect(reason).toContain('AC-1 (new-behavior)');
    expect(reason).toContain('inject changelog writer failure after package/version writes and assert exact rollback');
    expect(reason).toMatch(/focused failing test/);
    expect(reason).toMatch(/AC-1 rework 1 of 2/);
    expect(reason).not.toMatch(/round/);
    expect(reason).not.toMatch(/compatibility-regression/);
  });

  it('a compatibility gap asks for a regression test committed alone, never a fake RED; a new behaviour beside it still gets its RED', () => {
    const kinds: Record<string, 'new-behavior' | 'compatibility'> = { 'AC-3': 'new-behavior', 'AC-5': 'compatibility' };
    const reason = gapReason({ reviewId: 'CSET-203-R001', review: 1, budgets: { 'AC-3': { used: 1, max: 2 }, 'AC-5': { used: 0, max: 2 } }, gaps: [gap('AC-3'), gap('AC-5')], kindOf: (ac) => kinds[ac] as 'new-behavior' | 'compatibility' });
    expect(reason).toContain('AC-3 (new-behavior)');
    expect(reason).toContain('AC-5 (compatibility)');
    expect(reason).toMatch(/AC-3: a focused failing test/);
    expect(reason).toMatch(/AC-5: a regression test that passes on the current code, committed alone .*compatibility-regression/);
    expect(reason).toContain('Mycelink-Compatibility: AC-5');
    // Each criterion's own budget: AC-3 its second accepted rework, AC-5 its first.
    expect(reason).toMatch(/AC-3 rework 2 of 2, AC-5 rework 1 of 2/);
    expect(Buffer.byteLength(reason, 'utf8')).toBeLessThanOrEqual(MAX_REWORK_REASON_BYTES);
    const compatOnly = gapReason({ reviewId: 'CSET-203-R001', review: 1, budgets: {}, gaps: [gap('AC-5')], kindOf: () => 'compatibility' });
    expect(compatOnly).not.toMatch(/focused failing test/);
  });

  it('past its budget, a rework on verified progress says so, with the ceiling left; a restoration says what was lost and spends nothing (CSET-201 final)', () => {
    const progress = gapReason({ reviewId: 'CSET-201-R003', review: 3, budgets: { 'AC-2': { used: 2, max: 2, ceiling: 6, basis: 'progress' } }, gaps: [gap('AC-2')], kindOf: () => 'new-behavior' });
    expect(progress).toMatch(/AC-2 rework 3 \(past its budget of 2, on verified producer progress; ceiling 6\)/);
    expect(progress).not.toMatch(/rework 3 of 2/);
    const restore = gapReason({ reviewId: 'CSET-201-R003', review: 3, budgets: { 'AC-3': { used: 1, max: 2, ceiling: 6, basis: 'regression' } }, gaps: [gap('AC-3')], kindOf: () => 'new-behavior' });
    expect(restore).toMatch(/AC-3 restoration \(its completed proof is lost; nothing spent\)/);
  });

  it('stays within the rework bound, on one line, whatever the reviewer wrote', () => {
    const huge = { ...gap('AC-1'), missing: `line one\nline two\u0007\u202e ${'m'.repeat(5000)}`, reproduction: 'r'.repeat(5000) };
    const reason = gapReason({ reviewId: 'CSET-203-R002', review: 2, budgets: { 'AC-1': { used: 1, max: 2 } }, gaps: [huge, { ...huge, criterion: 'AC-2' }], kindOf: () => 'new-behavior' });
    expect(Buffer.byteLength(reason, 'utf8')).toBeLessThanOrEqual(MAX_REWORK_REASON_BYTES);
    // eslint-disable-next-line no-control-regex
    expect(reason).not.toMatch(/[\u0000-\u001f\u007f\u202a-\u202e]/);
    expect(reason).toContain('AC-1');
    expect(reason).toContain('AC-2');
  });
});
