/**
 * Per-criterion outcomes of one rework order (engine/criterion-outcomes.ts).
 *
 * CSET-203 r15: R001's AC-3, AC-4 and AC-5 were one order on the cli. Its
 * worker proved AC-3 by a RED and its fix and AC-5 by a compatibility unit,
 * and AC-4's exact reproduction passed on the unchanged base; a result had
 * one outcome for all three, so valid work and a valid challenge could not be
 * said together and the worker asked a person. Here, as pure functions: the
 * form of a per-criterion result (schema_version 2, outcome CRITERIA) against
 * the order it answers; how a scalar (legacy) outcome maps to the order's
 * criteria; when one test may stand for two criteria; and what a refinement
 * does to a node that completed part of its order and challenged the rest.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { GraphNode, PortfolioGraph, ReworkBrief } from '../../src/model/types.js';
import type { NodeResult } from '../../src/sessions/adapter.js';
import type { Gap } from '../../src/engine/acceptance-review.js';
import { criteriaForm, evidenceReuse, scalarCriteria } from '../../src/engine/criterion-outcomes.js';
import { planRevision, type NodeOrderView } from '../../src/engine/review-revision.js';
import { statusForOutcome } from '../../src/sessions/adapter.js';
import { validateAgainstSchema } from '../../src/schema/registry.js';

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

function node(id: string, criteria: string[], depends: string[] = []): GraphNode {
  return {
    id,
    level: 'executable-node',
    repository: 'r',
    capability: null,
    node_type: 'implementation',
    depends_on: depends,
    allowed_paths: [`packages/${id}/**`],
    forbidden_paths: [],
    contract_inputs: [],
    contract_outputs: [],
    required_resources: [],
    required_evidence: ['red', 'green', 'regression'],
    verification_commands: [],
    worker: { model: 'sonnet', effort: 'high', max_turns: 10, max_wall_clock_minutes: 10, max_attempts: 2, nested_delegation: false },
    invalidation_rules: [],
    acceptance_criteria: criteria,
  } as unknown as GraphNode;
}

/** P1 serves AC-1 and AC-2; P2 (the cli, after P1) serves AC-3, AC-4 and AC-5 (compatibility). */
const graph = {
  schema_version: 1,
  feature_id: 'F-1',
  title: 't',
  acceptance_criteria: [
    { id: 'AC-1', text: 'one', kind: 'new-behavior' },
    { id: 'AC-2', text: 'two', kind: 'new-behavior' },
    { id: 'AC-3', text: 'three', kind: 'new-behavior' },
    { id: 'AC-4', text: 'four', kind: 'new-behavior' },
    { id: 'AC-5', text: 'five', kind: 'compatibility' },
  ],
  resources: {},
  repositories: ['r'],
  capabilities: [],
  nodes: [node('P1', ['AC-1', 'AC-2']), node('P2', ['AC-3', 'AC-4', 'AC-5'], ['P1'])],
} as unknown as PortfolioGraph;
const P2 = graph.nodes[1] as GraphNode;

const brief = (criteria: string[], origin = true): ReworkBrief =>
  ({
    generation: 1,
    limit: 2,
    at: '2026-10-11T00:00:00.000Z',
    reason: 'R001 found AC-3, AC-4 and AC-5',
    reason_sha256: sha('R001 found AC-3, AC-4 and AC-5'),
    decision_id: null,
    acceptance_criteria: criteria,
    evidence: ['features/F-1/reviews/F-1-R001.json'],
    replaced: { integrated_sha: 'a'.repeat(40), candidate_id: null, archived_ref: null },
    attempt_base: 1,
    ...(origin ? { origin: { kind: 'acceptance-review', review_id: 'F-1-R001', review: 1, revision: 0, receipt_path: 'features/F-1/reviews/F-1-R001.json', receipt_sha256: 'b'.repeat(64) } } : {}),
    review_gaps: criteria.map((c) => ({ criterion: c, reproduction_sha256: sha(`${c} reproduction`) })),
  }) as unknown as ReworkBrief;
const ORDER = brief(['AC-3', 'AC-4', 'AC-5']);

const SHA = 'c'.repeat(64);
const challengeOf = (criteria: string[]): NonNullable<NodeResult['challenge']> => ({
  review_id: 'F-1-R001',
  reason_sha256: ORDER.reason_sha256,
  base_sha: 'a'.repeat(40),
  gate_output_sha256: SHA,
  gaps: criteria.map((c) => ({ criterion: c, reproduction_sha256: sha(`${c} reproduction`), tests: ['0123456789abcdef'], clauses: [{ clause: `${c}.1`, test_id: '0123456789abcdef', assertions: ['file:r:packages/P2/test/a.test.mjs#L3'], trace: 'asserted' }], explanation: 'passes on the base' })),
});

/** r15's answer as it should have been. */
function mixed(over: Partial<NodeResult> = {}): NodeResult {
  return {
    schema_version: 2,
    node_id: 'P2',
    claim_id: 'c-1',
    outcome: 'CRITERIA',
    commands: [],
    evidence_paths: [],
    commit_sha: 'd'.repeat(40),
    failure_fingerprint: null,
    decision_request: null,
    criteria: [
      { criterion: 'AC-3', outcome: 'DONE' },
      { criterion: 'AC-4', outcome: 'REVIEW_GAP_CHALLENGE' },
      { criterion: 'AC-5', outcome: 'DONE' },
    ],
    criterion_evidence: [
      { criterion: 'AC-3', test_id: '1111111111111111', gate: 'red', output_sha256: SHA },
      { criterion: 'AC-5', test_id: '5555555555555555', gate: 'green', output_sha256: 'e'.repeat(64) },
    ],
    challenge: challengeOf(['AC-4']),
    ...over,
  } as NodeResult;
}

const formOf = (result: NodeResult, b: ReworkBrief | null = ORDER) => criteriaForm({ result, brief: b, graph, node: P2 });

describe('the node result schema: version 2 answers each ordered criterion', () => {
  it('a version 2 result with outcome CRITERIA and its criteria is valid; CRITERIA is a claim for settle to judge, never a parked session', () => {
    expect(validateAgainstSchema('node-result', mixed())).toEqual([]);
    expect(statusForOutcome('CRITERIA')).toBe('done');
    // A scalar outcome still answers in version 2 (and version 1 is as it was).
    expect(validateAgainstSchema('node-result', { ...mixed(), outcome: 'SUBMITTED', criteria: undefined, challenge: undefined })).toEqual([]);
    expect(validateAgainstSchema('node-result', { ...mixed(), schema_version: 1, outcome: 'SUBMITTED', criteria: undefined, challenge: undefined })).toEqual([]);
  });

  it('per-criterion outcomes need schema_version 2 and outcome CRITERIA, each item exactly one known outcome', () => {
    expect(validateAgainstSchema('node-result', { ...mixed(), schema_version: 1 }).length).toBeGreaterThan(0);
    expect(validateAgainstSchema('node-result', { ...mixed(), outcome: 'SUBMITTED' }).length).toBeGreaterThan(0);
    expect(validateAgainstSchema('node-result', { ...mixed(), criteria: undefined }).length).toBeGreaterThan(0);
    expect(validateAgainstSchema('node-result', mixed({ criteria: [{ criterion: 'AC-3', outcome: 'PARTIAL' } as never] })).length).toBeGreaterThan(0);
    expect(validateAgainstSchema('node-result', mixed({ criteria: [{ criterion: 'AC-3', outcome: 'DONE', extra: 1 } as never] })).length).toBeGreaterThan(0);
  });
});

describe('criteriaForm: a per-criterion result against the order it answers', () => {
  it("r15's answer: AC-3 and AC-5 done, AC-4 challenged — each ordered criterion exactly once", () => {
    const f = formOf(mixed());
    expect(f).toEqual({ ok: true, form: { ordered: ['AC-3', 'AC-4', 'AC-5'], done: ['AC-3', 'AC-5'], challenged: ['AC-4'], unresolved: [] } });
  });

  it('BLOCKED and NEEDS_DECISION criteria carry their own reason; a decision its question and options', () => {
    const f = formOf(
      mixed({
        criteria: [
          { criterion: 'AC-3', outcome: 'DONE' },
          { criterion: 'AC-4', outcome: 'NEEDS_DECISION', reason: 'AC-4 needs a product call', decision_request: { question: 'Print the cause chain or only the top error?', options: ['the chain', 'the top error'] } },
          { criterion: 'AC-5', outcome: 'BLOCKED', reason: 'its gap lies in apply-release-plan, outside this node' },
        ],
        criterion_evidence: [{ criterion: 'AC-3', test_id: '1111111111111111', gate: 'red', output_sha256: SHA }],
        challenge: undefined,
      }),
    );
    expect(f).toMatchObject({ ok: true, form: { done: ['AC-3'], challenged: [], unresolved: [{ criterion: 'AC-4', outcome: 'NEEDS_DECISION', reason: 'AC-4 needs a product call', decision_request: { question: 'Print the cause chain or only the top error?' } }, { criterion: 'AC-5', outcome: 'BLOCKED', decision_request: null }] } });
  });

  it('refused: a criterion missing, named twice, or not one the order holds', () => {
    expect(formOf(mixed({ criteria: [{ criterion: 'AC-3', outcome: 'DONE' }, { criterion: 'AC-4', outcome: 'REVIEW_GAP_CHALLENGE' }] }))).toMatchObject({ ok: false, code: 'CRITERIA_MISSING', criterion: 'AC-5' });
    expect(formOf(mixed({ criteria: [{ criterion: 'AC-3', outcome: 'DONE' }, { criterion: 'AC-3', outcome: 'DONE' }, { criterion: 'AC-4', outcome: 'REVIEW_GAP_CHALLENGE' }, { criterion: 'AC-5', outcome: 'DONE' }] }))).toMatchObject({ ok: false, code: 'CRITERIA_DUPLICATE', criterion: 'AC-3' });
    expect(formOf(mixed({ criteria: [...(mixed().criteria ?? []), { criterion: 'AC-1', outcome: 'DONE' }] }))).toMatchObject({ ok: false, code: 'CRITERIA_NOT_ORDERED', criterion: 'AC-1' });
  });

  it('refused: outside an acceptance review rework, or outcome CRITERIA with schema_version 1', () => {
    expect(formOf(mixed(), null)).toMatchObject({ ok: false, code: 'CRITERIA_NOT_REVIEW_REWORK' });
    expect(formOf(mixed(), brief(['AC-3', 'AC-4', 'AC-5'], false))).toMatchObject({ ok: false, code: 'CRITERIA_NOT_REVIEW_REWORK' });
    expect(formOf(mixed({ schema_version: 1 } as Partial<NodeResult>))).toMatchObject({ ok: false, code: 'CRITERIA_RESULT_INVALID' });
  });

  it("refused: a compatibility criterion challenged (its test is expected to pass), or the challenge's gaps not exactly the challenged criteria", () => {
    expect(formOf(mixed({ criteria: [{ criterion: 'AC-3', outcome: 'DONE' }, { criterion: 'AC-4', outcome: 'REVIEW_GAP_CHALLENGE' }, { criterion: 'AC-5', outcome: 'REVIEW_GAP_CHALLENGE' }], challenge: challengeOf(['AC-4', 'AC-5']), criterion_evidence: [{ criterion: 'AC-3', test_id: '1111111111111111', gate: 'red', output_sha256: SHA }] }))).toMatchObject({ ok: false, code: 'CRITERIA_COMPATIBILITY_CHALLENGED', criterion: 'AC-5' });
    expect(formOf(mixed({ challenge: challengeOf(['AC-3', 'AC-4']) }))).toMatchObject({ ok: false, code: 'CRITERIA_CHALLENGE_MISMATCH', criterion: 'AC-3' });
    expect(formOf(mixed({ challenge: undefined }))).toMatchObject({ ok: false, code: 'CRITERIA_CHALLENGE_MISMATCH', criterion: 'AC-4' });
    expect(formOf(mixed({ criteria: [{ criterion: 'AC-3', outcome: 'DONE' }, { criterion: 'AC-4', outcome: 'DONE' }, { criterion: 'AC-5', outcome: 'DONE' }], criterion_evidence: [...(mixed().criterion_evidence ?? []), { criterion: 'AC-4', test_id: '4444444444444444', gate: 'red', output_sha256: SHA }] }))).toMatchObject({ ok: false, code: 'CRITERIA_CHALLENGE_MISMATCH' });
  });

  it('refused: evidence for a challenged or unresolved criterion, a DONE criterion with none, an unresolved one without its reason, a decision without its question', () => {
    expect(formOf(mixed({ criterion_evidence: [...(mixed().criterion_evidence ?? []), { criterion: 'AC-4', test_id: '4444444444444444', gate: 'red', output_sha256: SHA }] }))).toMatchObject({ ok: false, code: 'CRITERIA_EVIDENCE_CONFLICT', criterion: 'AC-4' });
    expect(formOf(mixed({ criterion_evidence: [{ criterion: 'AC-3', test_id: '1111111111111111', gate: 'red', output_sha256: SHA }] }))).toMatchObject({ ok: false, code: 'CRITERIA_EVIDENCE_MISSING', criterion: 'AC-5' });
    const blocked = (item: Record<string, unknown>): NodeResult => mixed({ criteria: [{ criterion: 'AC-3', outcome: 'DONE' }, item as never, { criterion: 'AC-5', outcome: 'DONE' }], challenge: undefined });
    expect(formOf(blocked({ criterion: 'AC-4', outcome: 'BLOCKED' }))).toMatchObject({ ok: false, code: 'CRITERIA_REASON_MISSING', criterion: 'AC-4' });
    expect(formOf(blocked({ criterion: 'AC-4', outcome: 'BLOCKED', reason: '  ' }))).toMatchObject({ ok: false, code: 'CRITERIA_REASON_MISSING', criterion: 'AC-4' });
    expect(formOf(blocked({ criterion: 'AC-4', outcome: 'NEEDS_DECISION', reason: 'a call' }))).toMatchObject({ ok: false, code: 'CRITERIA_DECISION_MISSING', criterion: 'AC-4' });
    expect(formOf(blocked({ criterion: 'AC-4', outcome: 'BLOCKED', reason: 'outside\u0007the fence' }))).toMatchObject({ ok: false, code: 'CRITERIA_RESULT_INVALID', criterion: 'AC-4' });
    expect(formOf(blocked({ criterion: 'AC-4', outcome: 'BLOCKED', reason: 'x', clauses: [] }))).toMatchObject({ ok: false, code: 'CRITERIA_RESULT_INVALID', criterion: 'AC-4' });
  });

  it('a scalar result is not judged here (null form): its outcome maps to every ordered criterion only as it means', () => {
    expect(formOf({ ...mixed(), schema_version: 1, outcome: 'SUBMITTED', criteria: undefined, challenge: undefined } as NodeResult)).toEqual({ ok: true, form: null });
    expect(scalarCriteria({ ...mixed(), outcome: 'SUBMITTED', criteria: undefined } as NodeResult, ORDER)).toEqual([
      { criterion: 'AC-3', outcome: 'DONE' },
      { criterion: 'AC-4', outcome: 'DONE' },
      { criterion: 'AC-5', outcome: 'DONE' },
    ]);
    // A legacy challenge of a subset: the others are kept as gaps, ordered again after the refinement — never DONE.
    expect(scalarCriteria({ ...mixed(), outcome: 'REVIEW_GAP_CHALLENGE', criteria: undefined, challenge: challengeOf(['AC-4']) } as NodeResult, ORDER)).toEqual([
      { criterion: 'AC-3', outcome: 'RETAINED' },
      { criterion: 'AC-4', outcome: 'REVIEW_GAP_CHALLENGE' },
      { criterion: 'AC-5', outcome: 'RETAINED' },
    ]);
    expect(scalarCriteria({ ...mixed(), outcome: 'NEEDS_DECISION', criteria: undefined } as NodeResult, ORDER)?.map((c) => c.outcome)).toEqual(['NEEDS_DECISION', 'NEEDS_DECISION', 'NEEDS_DECISION']);
    expect(scalarCriteria({ ...mixed(), outcome: 'RETRYABLE', criteria: undefined } as NodeResult, ORDER)).toBeNull();
    expect(scalarCriteria(mixed(), ORDER)?.map((c) => [c.criterion, c.outcome])).toEqual([['AC-3', 'DONE'], ['AC-4', 'REVIEW_GAP_CHALLENGE'], ['AC-5', 'DONE']]);
    expect(scalarCriteria({ ...mixed(), outcome: 'SUBMITTED', criteria: undefined } as NodeResult, null)).toBeNull();
  });
});

describe('evidenceReuse: one test for two criteria only when it is explicitly traced to both', () => {
  const traced = (pairs: string[]) => (criterion: string, testId: string): boolean => pairs.includes(`${criterion}@${testId}`);
  it("a test named for two DONE criteria is refused, unless each traces its own clauses to that test's assertions", () => {
    const uses = [
      { criterion: 'AC-3', test_id: 'aaaaaaaaaaaaaaaa', role: 'red' as const },
      { criterion: 'AC-4', test_id: 'aaaaaaaaaaaaaaaa', role: 'red' as const },
    ];
    expect(evidenceReuse(uses, traced([]))).toMatchObject({ criterion: 'AC-4', other: 'AC-3', test_id: 'aaaaaaaaaaaaaaaa' });
    expect(evidenceReuse(uses, traced(['AC-3@aaaaaaaaaaaaaaaa']))).toMatchObject({ criterion: 'AC-4' });
    expect(evidenceReuse(uses, traced(['AC-3@aaaaaaaaaaaaaaaa', 'AC-4@aaaaaaaaaaaaaaaa']))).toBeNull();
    // The same criterion naming a test twice (two gates) is no reuse.
    expect(evidenceReuse([{ criterion: 'AC-3', test_id: 'aaaaaaaaaaaaaaaa', role: 'red' }, { criterion: 'AC-3', test_id: 'aaaaaaaaaaaaaaaa', role: 'green' }], traced([]))).toBeNull();
  });

  it("a challenge's test is never another criterion's proof, traced or not; two challenged criteria may share their passing test", () => {
    expect(evidenceReuse([{ criterion: 'AC-3', test_id: 'bbbbbbbbbbbbbbbb', role: 'red' }, { criterion: 'AC-4', test_id: 'bbbbbbbbbbbbbbbb', role: 'challenge' }], traced(['AC-3@bbbbbbbbbbbbbbbb', 'AC-4@bbbbbbbbbbbbbbbb']))).toMatchObject({ test_id: 'bbbbbbbbbbbbbbbb' });
    expect(evidenceReuse([{ criterion: 'AC-3', test_id: 'cccccccccccccccc', role: 'challenge' }, { criterion: 'AC-4', test_id: 'cccccccccccccccc', role: 'challenge' }], traced(['AC-3@cccccccccccccccc', 'AC-4@cccccccccccccccc']))).toBeNull();
  });
});

const gap = (criterion: string, reproduction: string): Gap => ({ criterion, missing: `${criterion} missing`, reproduction, producer: null, confidence: 'high' }) as Gap;
const G3 = gap('AC-3', 'leave a journal cut short by a kill; assert it warns interrupted and versions once');
const G4 = gap('AC-4', 'make the formatter throw with commit enabled; assert exit 1 and no stack');
const G4R = gap('AC-4', "make the formatter throw the bare string 'disk exploded'; assert exit 1, the text printed, no stack");
const G5 = gap('AC-5', 'put a journal beside a changeset and run status; assert it is not listed');
const partial = (completed: string[], challenged: string[]): NodeOrderView => ({ node_id: 'P2', live: null, challenged: { criteria: challenged }, completed: { criteria: completed } });

describe('planRevision: a node that completed part of its order and challenged the rest', () => {
  it('AC-4 withdrawn: the node keeps what it completed (AC-3, AC-5); nothing is ordered again', () => {
    const plan = planRevision({ graph, parentGaps: [G3, G4, G5], decisions: [{ challenge_id: 'F-1-R001-C1', criterion: 'AC-4', decision: 'WITHDRAW' }], refined: [], accepted: new Set(), nodes: [partial(['AC-3', 'AC-5'], ['AC-3', 'AC-4', 'AC-5'])] });
    expect(plan.gaps).toEqual([G3, G5]);
    expect(plan.orders).toEqual([expect.objectContaining({ node_id: 'P2', action: 'keep', criteria_before: ['AC-3', 'AC-4', 'AC-5'], criteria_after: ['AC-3', 'AC-5'] })]);
  });

  it('AC-4 refined (or upheld): only AC-4 is ordered again; the completed AC-3 and AC-5 stay done', () => {
    const refined = planRevision({ graph, parentGaps: [G3, G4, G5], decisions: [{ challenge_id: 'F-1-R001-C1', criterion: 'AC-4', decision: 'REFINE' }], refined: [{ ...G4R, challenge_id: 'F-1-R001-C1' }], accepted: new Set(['AC-4']), nodes: [partial(['AC-3', 'AC-5'], ['AC-3', 'AC-4', 'AC-5'])] });
    expect(refined.orders).toEqual([expect.objectContaining({ node_id: 'P2', action: 'reorder', criteria_before: ['AC-3', 'AC-4', 'AC-5'], criteria_after: ['AC-4'], gaps: [G4R] })]);
    const upheld = planRevision({ graph, parentGaps: [G3, G4, G5], decisions: [{ challenge_id: 'F-1-R001-C1', criterion: 'AC-4', decision: 'UPHOLD' }], refined: [{ ...G4, challenge_id: 'F-1-R001-C1' }], accepted: new Set(['AC-4']), nodes: [partial(['AC-3', 'AC-5'], ['AC-3', 'AC-4', 'AC-5'])] });
    expect(upheld.orders).toEqual([expect.objectContaining({ node_id: 'P2', action: 'reorder', criteria_after: ['AC-4'], gaps: [G4] })]);
    // A refined gap its lineage does not accept orders nothing: the node keeps what it completed.
    const duplicate = planRevision({ graph, parentGaps: [G3, G4, G5], decisions: [{ challenge_id: 'F-1-R001-C1', criterion: 'AC-4', decision: 'UPHOLD' }], refined: [{ ...G4, challenge_id: 'F-1-R001-C1' }], accepted: new Set(), nodes: [partial(['AC-3', 'AC-5'], ['AC-3', 'AC-4', 'AC-5'])] });
    expect(duplicate.orders).toEqual([expect.objectContaining({ node_id: 'P2', action: 'keep', criteria_after: ['AC-3', 'AC-5'] })]);
  });

  it('a criterion the order left unresolved (neither done nor challenged) is ordered again with the refined one', () => {
    const plan = planRevision({ graph, parentGaps: [G3, G4, G5], decisions: [{ challenge_id: 'F-1-R001-C1', criterion: 'AC-4', decision: 'WITHDRAW' }], refined: [], accepted: new Set(), nodes: [partial(['AC-3'], ['AC-3', 'AC-4', 'AC-5'])] });
    expect(plan.orders).toEqual([expect.objectContaining({ node_id: 'P2', action: 'reorder', criteria_after: ['AC-5'], gaps: [G5] })]);
  });

  it('the legacy challenge of a subset (nothing completed) is as before: the challenger reordered for every gap the revision keeps', () => {
    const plan = planRevision({ graph, parentGaps: [G3, G4, G5], decisions: [{ challenge_id: 'F-1-R001-C1', criterion: 'AC-4', decision: 'WITHDRAW' }], refined: [], accepted: new Set(), nodes: [{ node_id: 'P2', live: null, challenged: { criteria: ['AC-3', 'AC-4', 'AC-5'] }, completed: null }] });
    expect(plan.orders).toEqual([expect.objectContaining({ node_id: 'P2', action: 'reorder', criteria_after: ['AC-3', 'AC-5'], gaps: [G3, G5] })]);
  });
});
