/**
 * A reviewer's verdict, canonicalised where it crosses into the controller
 * (engine/acceptance-review.ts judgeVerdict).
 *
 * CSET-203 r5 with-normal: every node DONE; two independent reviewer
 * sessions both found AC-1, AC-3 and AC-5 public gaps. The first verdict was
 * refused REVIEW_TRACE_INCOMPLETE: AC-2.3 ("The journal's format is up to
 * you.") was traced to the code alone, and a new behaviour's clause had to
 * cite a test — for a clause that grants a choice and asks for nothing. The
 * second, a fresh session that redid the review, was refused
 * REVIEW_VERDICT_INVALID because AC-1.clauses[0].trace was 653 characters,
 * over 600. After two refusals the feature was blocked REVIEW_INVALID; no
 * rework, no candidate. The semantic work was sound both times.
 *
 * Now human prose (a trace, a boundary, what is missing, the reproduction)
 * is normalised (Unicode NFC, whitespace collapsed) and, over its bound, cut
 * deterministically at a code-point or word boundary and marked, the
 * original's length and SHA-256 kept as a diagnostic. Identifiers, hashes,
 * paths, evidence references, arrays and structure are never cut: over a
 * bound they are refused, each problem with its JSON pointer. Control,
 * bidirectional and invalid Unicode characters, credentials and embedded
 * instructions are refused. A clause that only grants latitude needs no
 * test. One constants source bounds the judge, the JSON schema and the
 * reviewer's prompt.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REVIEWER_AGENT,
  REVIEW_VERDICT_SCHEMA,
  TRUNCATION_MARK,
  VERDICT_LIMITS,
  criterionClauses,
  gapTargets,
  judgeVerdict,
  truncateProse,
  verdictCanonicalSha256,
  verdictJsonSchema,
  verdictLimitsText,
  type VerdictContext,
} from '../../src/engine/acceptance-review.js';
import { contextOf, reviewerPrompt, type ReviewPacket } from '../../src/engine/review-packet.js';
import type { PortfolioGraph } from '../../src/model/types.js';

const FIXTURE = join(process.cwd(), 'tests', 'benchmark', 'fixtures', 'cset203-r5');
const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const codePoints = (s: string): number => Array.from(s).length;

interface R5Packet extends Omit<ReviewPacket, 'dispatch_id'> {
  dispatch_id: { g1: string; g2: string };
  files_at_head: string[];
}
const r5Packet = JSON.parse(readFileSync(join(FIXTURE, 'R001.packet.json'), 'utf8')) as R5Packet;
const r5Graph = JSON.parse(readFileSync(join(FIXTURE, 'PORTFOLIO-GRAPH.json'), 'utf8')) as PortfolioGraph;
const r5Verdict = (g: 'g1' | 'g2'): Record<string, any> => JSON.parse(readFileSync(join(FIXTURE, `R001-${g}.verdict.json`), 'utf8')) as Record<string, any>;
const r5Context = (g: 'g1' | 'g2'): VerdictContext => contextOf({ ...r5Packet, dispatch_id: r5Packet.dispatch_id[g] } as unknown as ReviewPacket, (repo, path) => r5Packet.files_at_head.includes(`${repo}:${path}`));

describe("CSET-203 r5's own verdicts of R001, judged again", () => {
  it('the second (a 653-character AC-1 trace) is canonicalised, not refused: GAPS on AC-1, AC-3 and AC-5, nothing else changed', () => {
    const raw = r5Verdict('g2');
    const original = raw['criteria'][0]['clauses'][0]['trace'] as string;
    expect(codePoints(original)).toBe(653);
    const judged = judgeVerdict(raw, r5Context('g2'));
    if (!judged.ok) throw new Error(`${judged.code}: ${judged.detail}`);
    expect(judged.overall).toBe('GAPS');
    expect(judged.gaps.map((g) => [g.criterion, g.untested ?? null])).toEqual([
      ['AC-1', null],
      ['AC-3', null],
      ['AC-5', ['AC-5.2']],
    ]);
    const trace = judged.verdict.criteria[0]!.clauses[0]!.trace;
    expect(codePoints(trace)).toBeLessThanOrEqual(VERDICT_LIMITS.trace);
    expect(trace.endsWith(TRUNCATION_MARK)).toBe(true);
    expect(original.startsWith(trace.slice(0, -TRUNCATION_MARK.length))).toBe(true);
    expect(judged.normalization.changed).toEqual([
      { pointer: '/criteria/0/clauses/0/trace', action: 'truncated', limit: VERDICT_LIMITS.trace, original_length: 653, original_sha256: sha256(original), canonical_length: codePoints(trace) },
    ]);
    // No semantic field lost: the canonical verdict is the original with that one trace cut.
    const expected = structuredClone(raw);
    expected['criteria'][0]['clauses'][0]['trace'] = trace;
    expect(judged.verdict).toEqual(expected);
    expect(judged.normalization.original_sha256).toBe(verdictCanonicalSha256(raw));
    // The very verdict r5's fence attested.
    expect(JSON.parse(readFileSync(join(FIXTURE, 'R001-g2.attest.json'), 'utf8'))).toMatchObject({ content_sha256: judged.normalization.original_sha256 });
    expect(judged.normalization.canonical_sha256).toBe(verdictCanonicalSha256(judged.verdict));
    expect(judged.normalization.canonical_sha256).not.toBe(judged.normalization.original_sha256);
    // Every gap reaches the producer the graph names, dependents first: AC-3 and AC-5 the cli (AC-5's module path picks it), AC-1 apply-release-plan.
    expect(gapTargets(r5Graph, judged.gaps).targets.map((t) => [t.node_id, t.criteria])).toEqual([
      ['CSET-203.changesets.cli.impl', ['AC-3', 'AC-5']],
      ['CSET-203.changesets.apply-release-plan.impl', ['AC-1']],
    ]);
  });

  it("the first, refused for AC-2.3's file-only trace, is valid too: AC-2.3 grants latitude and asks for no test", () => {
    const ac2 = r5Packet.criteria.find((c) => c.id === 'AC-2')!;
    expect(criterionClauses('AC-2', ac2.text).find((c) => c.id === 'AC-2.3')).toEqual({ id: 'AC-2.3', text: "The journal's format is up to you.", latitude: true });
    const judged = judgeVerdict(r5Verdict('g1'), r5Context('g1'));
    if (!judged.ok) throw new Error(`${judged.code}: ${judged.detail}`);
    expect(judged.overall).toBe('GAPS');
    expect(judged.gaps.map((g) => g.criterion)).toEqual(['AC-1', 'AC-3', 'AC-5']);
    expect(judged.normalization.changed).toEqual([]);
    expect(judged.normalization.canonical_sha256).toBe(judged.normalization.original_sha256);
  });
});

// ---- a small review to vary ----------------------------------------------------

const TEST_A = `test:${'a'.repeat(16)}`;
const TEST_B = `test:${'b'.repeat(16)}`;
const FILE_A = 'file:app:test/a.test.mjs#L1-L9';
const CTX: VerdictContext = {
  feature_id: 'F-1',
  review_id: 'F-1-R001',
  dispatch_id: '11111111-2222-4333-8444-555555555555',
  inputs_sha256: 'e'.repeat(64),
  repositories: ['app'],
  criteria: [
    { id: 'AC-1', kind: 'new-behavior', text: 'It rolls back. It keeps the cause.', sha256: '1'.repeat(64), clauses: criterionClauses('AC-1', 'It rolls back. It keeps the cause.') },
    { id: 'AC-2', kind: 'new-behavior', text: 'It writes a journal. Its format is up to you.', sha256: '2'.repeat(64), clauses: criterionClauses('AC-2', 'It writes a journal. Its format is up to you.') },
  ],
  evidence: new Map([
    [TEST_A, { kind: 'test' as const, passed: true }],
    [TEST_B, { kind: 'test' as const, passed: true }],
    ['gate:F-1.app.impl:red', { kind: 'gate' as const, gate: 'red' as const }],
  ]),
  fileExists: (repo, path) => repo === 'app' && path === 'test/a.test.mjs',
  candidates: new Map([
    ['AC-1', [TEST_A, 'gate:F-1.app.impl:red', 'file:app:test/a.test.mjs']],
    ['AC-2', [TEST_B, 'file:app:test/a.test.mjs']],
  ]),
};

function verdict(): Record<string, any> {
  const clause = (id: string): Record<string, unknown> => ({ clause: id, evidence: [TEST_A, FILE_A], trace: `${id} is asserted after the injected failure` });
  return {
    schema: REVIEW_VERDICT_SCHEMA,
    feature_id: CTX.feature_id,
    review_id: CTX.review_id,
    dispatch_id: CTX.dispatch_id,
    inputs_sha256: CTX.inputs_sha256,
    reviewer: { agent: REVIEWER_AGENT, model: 'claude-test' },
    criteria: [
      { criterion: 'AC-1', verdict: 'GAP', confidence: 'high', clauses: [clause('AC-1.1'), clause('AC-1.2')], boundaries: [{ kind: 'failure', boundary: 'the second write fails', covered: false, evidence: [] }], gap: { missing: 'no test fails the second write', reproduction: 'fail the second write and assert the first is restored' }, producer: null },
      { criterion: 'AC-2', verdict: 'PASS', confidence: 'high', clauses: [clause('AC-2.1'), { clause: 'AC-2.2', evidence: [], trace: 'JSON lines were chosen' }], boundaries: [{ kind: 'state', boundary: 'journal present before the first write', covered: true, evidence: [TEST_A] }], gap: null, producer: null },
    ],
    overall: 'GAPS',
  };
}

const refused = (raw: unknown): Extract<ReturnType<typeof judgeVerdict>, { ok: false }> => {
  const j = judgeVerdict(raw, CTX);
  if (j.ok) throw new Error('accepted');
  return j;
};
const accepted = (raw: unknown): Extract<ReturnType<typeof judgeVerdict>, { ok: true }> => {
  const j = judgeVerdict(raw, CTX);
  if (!j.ok) throw new Error(`${j.code}: ${j.detail}`);
  return j;
};

describe('human prose is canonicalised, never refused for its length', () => {
  it('collapses line breaks, tabs and other whitespace, trims, and normalises to NFC; spaces as written are kept; records what changed', () => {
    const v = verdict();
    v['criteria'][0]['gap']['reproduction'] = '  fail the second write\n\tand assert \r\n the first is restored\u2028 ';
    v['criteria'][0]['clauses'][0]['trace'] = "cafe\u0301 is asserted: no '\\n   at ' frames";
    const j = accepted(v);
    expect(j.verdict.criteria[0]!.gap!.reproduction).toBe('fail the second write and assert the first is restored');
    // A quoted literal keeps its spaces (CSET-203 r5's AC-4.1 trace quotes "\n   at ").
    expect(j.verdict.criteria[0]!.clauses[0]!.trace).toBe("café is asserted: no '\\n   at ' frames");
    expect(j.gaps[0]!.reproduction).toBe('fail the second write and assert the first is restored');
    expect(j.normalization.changed.map((c) => [c.pointer, c.action])).toEqual([
      ['/criteria/0/clauses/0/trace', 'normalized'],
      ['/criteria/0/gap/reproduction', 'normalized'],
    ]);
  });

  it('every prose field over its bound is cut and marked, with the original length and hash', () => {
    const v = verdict();
    const long = (n: number): string => Array.from({ length: n }, (_, i) => `w${i % 10}`).join(' ').slice(0, n);
    v['criteria'][0]['boundaries'][0]['boundary'] = long(VERDICT_LIMITS.boundary + 50);
    v['criteria'][0]['gap']['missing'] = long(VERDICT_LIMITS.missing + 1);
    v['criteria'][0]['gap']['reproduction'] = long(VERDICT_LIMITS.reproduction + 400);
    const j = accepted(v);
    const c = j.verdict.criteria[0]!;
    for (const [text, limit] of [[c.boundaries[0]!.boundary, VERDICT_LIMITS.boundary], [c.gap!.missing, VERDICT_LIMITS.missing], [c.gap!.reproduction, VERDICT_LIMITS.reproduction]] as const) {
      expect(codePoints(text)).toBeLessThanOrEqual(limit);
      expect(text.endsWith(TRUNCATION_MARK)).toBe(true);
    }
    expect(j.normalization.changed.map((x) => [x.pointer, x.action, x.original_length])).toEqual([
      ['/criteria/0/boundaries/0/boundary', 'truncated', VERDICT_LIMITS.boundary + 50],
      ['/criteria/0/gap/missing', 'truncated', VERDICT_LIMITS.missing + 1],
      ['/criteria/0/gap/reproduction', 'truncated', VERDICT_LIMITS.reproduction + 400],
    ]);
  });

  it('cuts at a word boundary when one is near, else at a code point, never inside a surrogate pair or before a combining mark', () => {
    const words = `${'word '.repeat(200)}`.trim();
    const cut = truncateProse(words, 100);
    expect(codePoints(cut)).toBeLessThanOrEqual(100);
    expect(cut).toBe(`${'word '.repeat(17).trim()}${TRUNCATION_MARK}`);
    const astral = '\u{1d49c}'.repeat(700);
    const a = truncateProse(astral, 600);
    expect(codePoints(a)).toBe(600);
    expect(a.isWellFormed()).toBe(true);
    expect(Array.from(a.slice(0, -TRUNCATION_MARK.length)).every((ch) => ch === '\u{1d49c}')).toBe(true);
    // e + combining acute after NFC would be one code point; a mark with no precomposed form stays a separate one.
    const marks = 'x\u0353'.repeat(400);
    const m = truncateProse(marks, 101);
    expect(codePoints(m)).toBeLessThanOrEqual(101);
    expect(/\u0353$/.test(m.slice(0, -TRUNCATION_MARK.length))).toBe(true);
    const zwj = '\u{1f469}\u200d\u{1f4bb}'.repeat(300);
    const z = truncateProse(zwj, 50);
    expect(z.slice(0, -TRUNCATION_MARK.length).endsWith('\u200d')).toBe(false);
    expect(truncateProse(words, 100)).toBe(cut);
    expect(truncateProse('short', 100)).toBe('short');
  });

  it('normalisation never hides a missing trace: a PASS clause traced with whitespace only is still untraced', () => {
    const v = verdict();
    v['criteria'][1]['clauses'][0]['trace'] = ' \n\t ';
    const r = refused(v);
    expect(r.code).toBe('REVIEW_TRACE_INCOMPLETE');
    expect(r.problems).toEqual([expect.objectContaining({ code: 'REVIEW_TRACE_INCOMPLETE', pointer: '/criteria/1/clauses/0' })]);
  });
});

describe('identifiers, hashes, paths, evidence and structure are never cut', () => {
  it.each([
    ['a criterion id', (v: any) => (v.criteria[0].criterion = `AC-${'1'.repeat(VERDICT_LIMITS.criterion)}`), '/criteria/0/criterion'],
    ['a clause id', (v: any) => (v.criteria[0].clauses[0].clause = `AC-1.${'1'.repeat(VERDICT_LIMITS.clause)}`), '/criteria/0/clauses/0/clause'],
    ['an evidence reference', (v: any) => (v.criteria[0].clauses[0].evidence[1] = `file:app:${'d/'.repeat(VERDICT_LIMITS.evidence_ref)}a.mjs`), '/criteria/0/clauses/0/evidence/1'],
    ['a producer module path', (v: any) => (v.criteria[0].producer = { module: `app:${'d/'.repeat(VERDICT_LIMITS.producer)}` }), '/criteria/0/producer/module'],
    ['the inputs hash', (v: any) => (v.inputs_sha256 = 'e'.repeat(VERDICT_LIMITS.binding + 1)), '/inputs_sha256'],
    ['the model', (v: any) => (v.reviewer.model = 'm'.repeat(VERDICT_LIMITS.model + 1)), '/reviewer/model'],
    ['an evidence list', (v: any) => (v.criteria[0].clauses[0].evidence = Array.from({ length: VERDICT_LIMITS.items + 1 }, () => TEST_A)), '/criteria/0/clauses/0/evidence'],
  ])('%s over its bound is refused with its pointer and limit', (_what, mutate, pointer) => {
    const v = verdict();
    mutate(v);
    const r = refused(v);
    expect(r.code).toBe('REVIEW_VERDICT_INVALID');
    expect(r.problems).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'REVIEW_VERDICT_INVALID', pointer, limit: expect.any(Number) })]));
    expect(r.detail).toContain(pointer);
  });

  it('a missing trace field, a missing criterion and an unknown field are refused together, each with its pointer', () => {
    const v = verdict();
    delete v['criteria'][0]['clauses'][1]['trace'];
    v['criteria'][1]['extra'] = 1;
    const r = refused(v);
    expect(r.code).toBe('REVIEW_VERDICT_INVALID');
    expect(r.problems.map((p) => p.pointer)).toEqual(['/criteria/0/clauses/1/trace', '/criteria/1/extra']);
    const w = verdict();
    w['criteria'] = [w['criteria'][0]];
    expect(refused(w)).toMatchObject({ code: 'REVIEW_INCOMPLETE', problems: [expect.objectContaining({ pointer: '/criteria', detail: expect.stringContaining('AC-2') })] });
  });

  it('an untraced PASS clause is refused with the evidence ids the packet offers for its criterion', () => {
    const v = verdict();
    v['criteria'][1]['clauses'][0]['evidence'] = [FILE_A];
    const r = refused(v);
    expect(r.code).toBe('REVIEW_TRACE_INCOMPLETE');
    expect(r.problems).toEqual([expect.objectContaining({ pointer: '/criteria/1/clauses/0/evidence', candidates: [TEST_B, 'file:app:test/a.test.mjs'] })]);
  });
});

describe('a clause that grants latitude asks for no test', () => {
  it('is marked from the approved text, never from the reviewer', () => {
    expect(criterionClauses('AC-2', 'It writes a journal. Its format is up to you.').map((c) => c.latitude === true)).toEqual([false, true]);
    expect(criterionClauses('AC-9', 'The layout is left to the implementation.')[0]).toMatchObject({ latitude: true });
    // A clause that still demands something is a requirement, whatever else it grants.
    expect(criterionClauses('AC-9', 'Its format is up to you, but it must be valid JSON.')[0]!.latitude).toBeUndefined();
  });

  it('its PASS needs a trace, not a test; with no trace at all it is untraced', () => {
    expect(accepted(verdict()).overall).toBe('GAPS');
    const v = verdict();
    v['criteria'][1]['clauses'][1]['trace'] = '';
    expect(refused(v)).toMatchObject({ code: 'REVIEW_TRACE_INCOMPLETE', problems: [expect.objectContaining({ pointer: '/criteria/1/clauses/1' })] });
  });
});

describe('one constants source bounds the judge, the schema and the prompt', () => {
  it('schemas/acceptance-review-verdict.schema.json is the generated schema', () => {
    const file = JSON.parse(readFileSync(join(process.cwd(), 'schemas', 'acceptance-review-verdict.schema.json'), 'utf8')) as unknown;
    expect(file).toEqual(verdictJsonSchema());
    const s = verdictJsonSchema() as any;
    const crit = s.properties.criteria.items.properties;
    expect(crit.clauses.items.properties.trace.maxLength).toBe(VERDICT_LIMITS.trace);
    expect(crit.boundaries.items.properties.boundary.maxLength).toBe(VERDICT_LIMITS.boundary);
    expect(crit.gap.properties.reproduction.maxLength).toBe(VERDICT_LIMITS.reproduction);
    expect(crit.clauses.items.properties.evidence.items.maxLength).toBe(VERDICT_LIMITS.evidence_ref);
    expect(crit.clauses.maxItems).toBe(VERDICT_LIMITS.items);
  });

  it("the reviewer's prompt states the same bounds", () => {
    const text = verdictLimitsText();
    for (const n of [VERDICT_LIMITS.trace, VERDICT_LIMITS.boundary, VERDICT_LIMITS.missing, VERDICT_LIMITS.reproduction, VERDICT_LIMITS.evidence_ref, VERDICT_LIMITS.items]) expect(text).toContain(String(n));
    expect(text).toContain(TRUNCATION_MARK);
    const prompt = reviewerPrompt({ ...r5Packet, dispatch_id: r5Packet.dispatch_id.g2, verdict_file: '/x/verdict.json', repositories: [] } as unknown as ReviewPacket, '/x/packet.json', '/x');
    expect(prompt).toContain(text);
  });
});
