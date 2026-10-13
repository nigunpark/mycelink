/**
 * The acceptance review's per-criterion gap lineage (CSET-203 r11).
 *
 * r11 with-normal ran continuously and trusted. R001 found AC-1 on
 * apply-release-plan (challenged, withdrawn) and AC-5 on the cli (reworked);
 * R002 found another AC-1 reproduction (challenged, withdrawn) and AC-3 on
 * the cli (reworked); R003 found materially new AC-1 and AC-3 gaps — and the
 * global `max_rounds: 2` blocked it REVIEW_GAPS before any rework: withdrawn
 * hypotheses and other criteria had spent the one shared count. Here the
 * budget is each criterion's own: a gap consumes it only when a materially
 * new reproduction is accepted and a producer is actually reworked for it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_CRITERION_CEILING,
  MAX_NO_PROGRESS_REVIEWS,
  MAX_REGRESSIONS,
  MAX_REVIEW_SESSIONS,
  appendLineage,
  budgetLine,
  chainProblems,
  emptyLineage,
  gapEvent as gapEventOf,
  judgeGapLineage,
  migrateLineage,
  nonconvergence,
  reproductionFingerprint,
  repeats,
  reviewProgress,
  summarizeLineage,
} from '../../src/engine/review-lineage.js';
import { reproductionSha256 } from '../../src/engine/review-challenge.js';
import type { LineageEventBody, ReviewLineage } from '../../src/model/types.js';

const R11 = join(__dirname, '..', 'benchmark', 'fixtures', 'cset203-r11');
const receipt = (rel: string): Record<string, any> => JSON.parse(readFileSync(join(R11, ...rel.split('/')), 'utf8')) as Record<string, any>;
const gapOf = (file: string, criterion: string): string => (receipt(`features/CSET-203/reviews/${file}`)['gaps'] as { criterion: string; reproduction: string }[]).find((g) => g.criterion === criterion)!.reproduction;
const R001_AC1 = gapOf('CSET-203-R001.json', 'AC-1');
const R002_AC1 = gapOf('CSET-203-R002.json', 'AC-1');
const R003_AC1 = gapOf('CSET-203-R003.json', 'AC-1');
const R001_AC5 = gapOf('CSET-203-R001.json', 'AC-5');
const R002_AC3 = gapOf('CSET-203-R002.json', 'AC-3');
const R003_AC3 = gapOf('CSET-203-R003.json', 'AC-3');
const CRITERIA = ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5'];
const AT = (n: number): string => new Date(Date.UTC(2026, 9, 10, 1, n)).toISOString();

function gapEvent(review: string, criterion: string, reproduction: string, verdict: 'accepted' | 'duplicate' | 'exhausted' | 'unreworkable', nodes: string[] = verdict === 'accepted' ? [`node-${criterion}`] : [], challenge: string | null = null): LineageEventBody {
  const fp = reproductionFingerprint(reproduction);
  return { kind: 'gap', review_id: review, criterion, reproduction_sha256: reproductionSha256(reproduction), fingerprint: fp.sha256, terms: fp.terms, verdict, nodes, duplicate_of: null, challenge_id: challenge };
}
const reviewEvent = (review: string, heads: string[], progress: string[], extra: { passed?: string[]; gaps?: string[]; outcome?: string } = {}): LineageEventBody => ({ kind: 'review', review_id: review, inputs_sha256: 'a'.repeat(64), heads, outcome: extra.outcome ?? 'GAPS', passed: extra.passed ?? [], gaps: extra.gaps ?? [], progress });
const challengeEvent = (review: string, id: string, criterion: string, reproduction: string): LineageEventBody => ({ kind: 'challenge', review_id: review, challenge_id: id, criterion, reproduction_sha256: reproductionSha256(reproduction), receipt_sha256: 'c'.repeat(64), node_id: `node-${criterion}` });
const decisionEvent = (review: string, id: string, criterion: string, decision: 'WITHDRAW' | 'REFINE' | 'UPHOLD'): LineageEventBody => ({ kind: 'decision', review_id: review, challenge_id: id, criterion, decision });

/** r11's R001 and R002, each with its challenge withdrawn and the cli reworked. */
function r11Lineage(): ReviewLineage {
  let l = emptyLineage(2);
  l = appendLineage(l, [gapEvent('CSET-203-R001', 'AC-1', R001_AC1, 'accepted'), gapEvent('CSET-203-R001', 'AC-5', R001_AC5, 'accepted'), reviewEvent('CSET-203-R001', ['changesets@1111'], ['first-review', 'accepted-gap'], { gaps: ['AC-1', 'AC-5'] })], AT(1)).lineage;
  l = appendLineage(l, [challengeEvent('CSET-203-R001', 'CSET-203-R001-C1', 'AC-1', R001_AC1)], AT(2)).lineage;
  l = appendLineage(l, [decisionEvent('CSET-203-R001', 'CSET-203-R001-C1', 'AC-1', 'WITHDRAW')], AT(3)).lineage;
  l = appendLineage(l, [gapEvent('CSET-203-R002', 'AC-1', R002_AC1, 'accepted'), gapEvent('CSET-203-R002', 'AC-3', R002_AC3, 'accepted'), reviewEvent('CSET-203-R002', ['changesets@2222'], ['producer-change', 'accepted-gap'], { gaps: ['AC-1', 'AC-3'] })], AT(4)).lineage;
  l = appendLineage(l, [challengeEvent('CSET-203-R002', 'CSET-203-R002-C1', 'AC-1', R002_AC1)], AT(5)).lineage;
  l = appendLineage(l, [decisionEvent('CSET-203-R002', 'CSET-203-R002-C1', 'AC-1', 'WITHDRAW')], AT(6)).lineage;
  return l;
}

describe('a reproduction is fingerprinted by what it does, not its wording', () => {
  it("r11's three AC-1 reproductions and two AC-3 reproductions are each materially new", () => {
    const t = (s: string): string[] => reproductionFingerprint(s).terms;
    expect(repeats(t(R002_AC1), t(R001_AC1))).toBe(false);
    expect(repeats(t(R003_AC1), t(R001_AC1))).toBe(false);
    expect(repeats(t(R003_AC1), t(R002_AC1))).toBe(false);
    expect(repeats(t(R003_AC3), t(R002_AC3))).toBe(false);
  });

  it('the same reproduction re-cased, re-punctuated, reordered, padded or paraphrased with synonyms is a repeat', () => {
    const t = (s: string): string[] => reproductionFingerprint(s).terms;
    const paraphrases = [
      R003_AC1.toUpperCase().replace(/\./g, ';'),
      R003_AC1.split('. ').reverse().join('. '),
      `${R003_AC1} Please run this again carefully.`,
      'Start from a fixture where pkg CHANGELOG.md is absent and changelog generation is enabled (or pre mode without .changeset/pre.json). Make the removal of the changeset md fail after the CHANGELOG.md or pre.json is written. Check that it rejects with the original error as its cause and that the directory snapshot matches the original one, the created file being gone.',
      'Assert a directory snapshot equal to the original and rejection whose cause is the original error. Fixture: no pkg CHANGELOG.md, changelog enabled or pre mode with no .changeset/pre.json; fs.rm of the changeset md throws after the CHANGELOG.md or pre.json write; the created file must be absent.',
    ];
    for (const p of paraphrases) expect(repeats(t(p), t(R003_AC1)), p).toBe(true);
    expect(repeats(t(R001_AC1.replace('Inject a failure after the changelogs are written', 'Force a fault once the changelog files are written').replace('Assert', 'Verify')), t(R001_AC1))).toBe(true);
    // The fingerprint is its terms' hash: the same for every rewording that keeps them.
    expect(reproductionFingerprint(R003_AC1.toUpperCase()).sha256).toBe(reproductionFingerprint(R003_AC1).sha256);
  });
});

describe('the lineage is an append-only hash chain', () => {
  it('each event binds the one before; a changed, dropped or reordered event is found; the same fact appended twice is one event', () => {
    const l = r11Lineage();
    expect(chainProblems(l)).toEqual([]);
    expect(l.head_sha256).toBe(l.events.at(-1)!.sha256);
    expect(l.events.map((e) => e.seq)).toEqual(l.events.map((_, i) => i + 1));
    // The same gap of the same review again (a settle re-run after a crash): nothing appended.
    const again = appendLineage(l, [gapEvent('CSET-203-R002', 'AC-3', R002_AC3, 'accepted')], AT(9));
    expect(again.appended).toEqual([]);
    expect(again.lineage.events).toHaveLength(l.events.length);
    // A reset: AC-1's withdrawals dropped, the rest re-chained by hand.
    const dropped = structuredClone(l);
    dropped.events = dropped.events.filter((e) => e.kind !== 'decision');
    expect(chainProblems(dropped).join('\n')).toMatch(/seq|prev/);
    const edited = structuredClone(l);
    (edited.events[0] as { verdict: string }).verdict = 'unreworkable';
    expect(chainProblems(edited).join('\n')).toMatch(/hash/);
    const head = structuredClone(l);
    head.head_sha256 = 'f'.repeat(64);
    expect(chainProblems(head).join('\n')).toMatch(/head/);
  });
});

describe('each criterion has its own budget', () => {
  it('r11: withdrawn AC-1 hypotheses consume nothing; the cli reworks count for AC-5 and AC-3 alone; R003 AC-1 and AC-3 are both accepted', () => {
    const l = r11Lineage();
    const s = summarizeLineage(l, CRITERIA, null);
    expect(s.criteria['AC-1']).toMatchObject({ accepted_reworks: 0, remaining: 2, withdrawals: 2, challenges: 2, max: 2 });
    expect(s.criteria['AC-1']!.reproductions.map((r) => r.status)).toEqual(['withdrawn', 'withdrawn']);
    expect(s.criteria['AC-5']).toMatchObject({ accepted_reworks: 1, remaining: 1 });
    expect(s.criteria['AC-3']).toMatchObject({ accepted_reworks: 1, remaining: 1 });
    expect(s.criteria['AC-2']).toMatchObject({ accepted_reworks: 0, remaining: 2, reproductions: [] });
    const judged = judgeGapLineage(s, [{ criterion: 'AC-1', reproduction: R003_AC1 }, { criterion: 'AC-3', reproduction: R003_AC3 }]);
    expect(judged.map((j) => [j.criterion, j.verdict])).toEqual([['AC-1', 'accepted'], ['AC-3', 'accepted']]);
  });

  it('a repeat of a withdrawn or accepted reproduction, however reworded, is a duplicate: no rework', () => {
    const l = r11Lineage();
    const s = summarizeLineage(l, CRITERIA, null);
    const judged = judgeGapLineage(s, [{ criterion: 'AC-1', reproduction: R001_AC1.toUpperCase() }, { criterion: 'AC-3', reproduction: `${R002_AC3} Again.` }]);
    expect(judged.map((j) => [j.criterion, j.verdict, j.duplicate_of])).toEqual([
      ['AC-1', 'duplicate', reproductionSha256(R001_AC1)],
      ['AC-3', 'duplicate', reproductionSha256(R002_AC3)],
    ]);
    // Another criterion's reproduction is never this one's duplicate.
    expect(judgeGapLineage(s, [{ criterion: 'AC-4', reproduction: R002_AC3 }])[0]).toMatchObject({ verdict: 'accepted' });
  });

  it("past its own budget a materially new gap is exhausted; another criterion goes on; a person's grant raises that criterion alone", () => {
    let l = r11Lineage();
    l = appendLineage(l, [gapEvent('CSET-203-R003', 'AC-1', R003_AC1, 'accepted'), gapEvent('CSET-203-R003', 'AC-3', R003_AC3, 'accepted'), reviewEvent('CSET-203-R003', ['changesets@3333'], ['producer-change', 'accepted-gap'])], AT(7)).lineage;
    let s = summarizeLineage(l, CRITERIA, null);
    expect(s.criteria['AC-3']).toMatchObject({ accepted_reworks: 2, remaining: 0 });
    expect(s.criteria['AC-1']).toMatchObject({ accepted_reworks: 1, remaining: 1 });
    const novel = 'make the version run die (SIGKILL) between the journal write and the first package.json write, then run version: assert no warning, the journal removed and exactly one 1.1.0 entry in each CHANGELOG.md';
    const judged = judgeGapLineage(s, [{ criterion: 'AC-3', reproduction: novel }, { criterion: 'AC-1', reproduction: 'make the CHANGELOG.md path a directory so its write fails with EISDIR after package.json versions were written; assert the rejection cause is the EISDIR error and every package.json is back to its exact bytes' }]);
    expect(judged.map((j) => [j.criterion, j.verdict])).toEqual([['AC-3', 'exhausted'], ['AC-1', 'accepted']]);
    l = appendLineage(l, [gapEvent('CSET-203-R004', 'AC-3', novel, 'exhausted'), reviewEvent('CSET-203-R004', ['changesets@4444'], ['producer-change'])], AT(8)).lineage;
    s = summarizeLineage(l, CRITERIA, null);
    expect(s.pending_exhausted).toEqual([{ criterion: 'AC-3', review_id: 'CSET-203-R004', reproduction_sha256: reproductionSha256(novel) }]);
    expect(s.criteria['AC-3']).toMatchObject({ exhausted: true, next_action: expect.stringMatching(/decision/) });
    expect(s.criteria['AC-1']).toMatchObject({ exhausted: false, remaining: 1 });
    // Blocked: no longer pending. A person's decided grant: one more for AC-3 alone.
    l = appendLineage(l, [{ kind: 'blocked', review_id: 'CSET-203-R004', code: 'REVIEW_GAPS', criteria: ['AC-3'] }], AT(9)).lineage;
    expect(summarizeLineage(l, CRITERIA, null).pending_exhausted).toEqual([]);
    l = appendLineage(l, [{ kind: 'grant', review_id: 'CSET-203-R004', criterion: 'AC-3', decision_id: 'D-1' }], AT(10)).lineage;
    s = summarizeLineage(l, CRITERIA, null);
    expect(s.criteria['AC-3']).toMatchObject({ max: 3, remaining: 1 });
    expect(s.criteria['AC-1']).toMatchObject({ max: 2 });
  });

  it('a REFINE after a challenge: the challenged rework is restored (nothing spent), the refined gap is the accepted one', () => {
    let l = emptyLineage(1);
    l = appendLineage(l, [gapEvent('F-1-R001', 'AC-1', R001_AC1, 'accepted'), reviewEvent('F-1-R001', ['r@1'], ['first-review', 'accepted-gap'])], AT(1)).lineage;
    l = appendLineage(l, [challengeEvent('F-1-R001', 'F-1-R001-C1', 'AC-1', R001_AC1)], AT(2)).lineage;
    l = appendLineage(l, [decisionEvent('F-1-R001', 'F-1-R001-C1', 'AC-1', 'REFINE'), gapEvent('F-1-R001', 'AC-1', R003_AC1, 'accepted', ['node-AC-1'], 'F-1-R001-C1')], AT(3)).lineage;
    const s = summarizeLineage(l, ['AC-1'], null);
    expect(s.criteria['AC-1']).toMatchObject({ accepted_reworks: 1, remaining: 0, challenges: 1, withdrawals: 0 });
    expect(s.criteria['AC-1']!.reproductions.map((r) => r.status)).toEqual(['refined', 'accepted']);
  });

  it('only what came after the last accepted delivery counts', () => {
    const l = r11Lineage();
    const s = summarizeLineage(l, CRITERIA, AT(3));
    expect(s.criteria['AC-5']).toMatchObject({ accepted_reworks: 0, remaining: 2, reproductions: [] });
    expect(s.criteria['AC-3']).toMatchObject({ accepted_reworks: 1 });
    expect(s.review_sessions).toBe(1);
  });
});

describe('progress and the global ceilings', () => {
  it('a review makes progress by a producer change, a new criterion proof, an accepted gap or a valid challenge of it; else it adds to the no-progress streak', () => {
    let l = r11Lineage();
    let s = summarizeLineage(l, CRITERIA, null);
    expect(reviewProgress(s, { heads: ['changesets@2222'], passed: [], gaps: ['AC-1'], accepted: 0 })).toEqual([]);
    expect(reviewProgress(s, { heads: ['changesets@3333'], passed: [], gaps: ['AC-1'], accepted: 0 })).toEqual(['producer-change']);
    expect(reviewProgress(s, { heads: ['changesets@2222'], passed: ['AC-3'], gaps: ['AC-1'], accepted: 0 })).toEqual(['criterion-proof']);
    expect(reviewProgress(s, { heads: ['changesets@2222'], passed: [], gaps: ['AC-1'], accepted: 1 })).toEqual(['accepted-gap']);
    // R002 made progress; three repeats at its heads do not; a valid challenge of the second counts for it.
    for (const n of [3, 4, 5]) l = appendLineage(l, [reviewEvent(`CSET-203-R00${n}`, ['changesets@2222'], [], { outcome: 'REPEATED' })], AT(10 + n)).lineage;
    s = summarizeLineage(l, CRITERIA, null);
    expect(s.no_progress_streak).toBe(3);
    expect(nonconvergence(s)).toBeNull();
    l = appendLineage(l, [challengeEvent('CSET-203-R004', 'CSET-203-R004-C1', 'AC-4', 'kill it')], AT(20)).lineage;
    s = summarizeLineage(l, CRITERIA, null);
    expect(s.no_progress_streak).toBe(1);
    for (const n of [6, 7, 8]) l = appendLineage(l, [reviewEvent(`CSET-203-R00${n}`, ['changesets@2222'], [], { outcome: 'REPEATED' })], AT(20 + n)).lineage;
    s = summarizeLineage(l, CRITERIA, null);
    expect(s.no_progress_streak).toBe(MAX_NO_PROGRESS_REVIEWS);
    expect(nonconvergence(s)).toMatch(/no progress/);
  });

  it(`at most ${MAX_REVIEW_SESSIONS} review sessions since the last accepted delivery, refinements not counted`, () => {
    let l = emptyLineage(2);
    for (let n = 1; n < MAX_REVIEW_SESSIONS; n++) l = appendLineage(l, [reviewEvent(`F-1-R00${n}`, [`r@${n}`], ['producer-change'])], AT(n)).lineage;
    l = appendLineage(l, [decisionEvent('F-1-R007', 'F-1-R007-C1', 'AC-1', 'WITHDRAW')], AT(30)).lineage;
    expect(summarizeLineage(l, ['AC-1'], null).review_sessions).toBe(MAX_REVIEW_SESSIONS - 1);
    expect(nonconvergence(summarizeLineage(l, ['AC-1'], null))).toBeNull();
    l = appendLineage(l, [reviewEvent('F-1-R008', ['r@8'], ['producer-change'])], AT(31)).lineage;
    expect(nonconvergence(summarizeLineage(l, ['AC-1'], null))).toMatch(new RegExp(`${MAX_REVIEW_SESSIONS} review sessions`));
  });
});

// ---- CSET-201 final: the per-criterion count is a budget, not a cap ------------------------------------------------

const C201 = join(__dirname, '..', 'benchmark', 'fixtures', 'cset201-final');
const c201 = (rel: string): Record<string, any> => JSON.parse(readFileSync(join(C201, ...rel.split('/')), 'utf8')) as Record<string, any>;
const c201Gap = (review: string, criterion: string): string => (c201(`features/CSET-201/reviews/CSET-201-${review}.json`)['gaps'] as { criterion: string; reproduction: string }[]).find((g) => g.criterion === criterion)!.reproduction;
const C201_R001_AC2 = c201Gap('R001', 'AC-2');
const C201_R001_AC3 = c201Gap('R001', 'AC-3');
const C201_R002_AC2 = c201Gap('R002', 'AC-2');
const C201_R003_AC2 = c201Gap('R003', 'AC-2');
const C201_R003_AC3 = c201Gap('R003', 'AC-3');
const C201_CRITERIA = ['AC-1', 'AC-2', 'AC-3', 'AC-4'];

/** CSET-201 final's R001 and R002 as its lineage recorded them (a `max_criterion_reworks: 2` lineage, no ceiling recorded). */
function c201Lineage(): ReviewLineage {
  let l = emptyLineage(2);
  l = appendLineage(l, [gapEvent('CSET-201-R001', 'AC-2', C201_R001_AC2, 'accepted', ['assemble']), gapEvent('CSET-201-R001', 'AC-3', C201_R001_AC3, 'accepted', ['cli']), reviewEvent('CSET-201-R001', ['changesets@518ffa'], ['first-review', 'accepted-gap'], { passed: ['AC-1', 'AC-4'], gaps: ['AC-2', 'AC-3'] })], AT(1)).lineage;
  l = appendLineage(l, [gapEvent('CSET-201-R002', 'AC-2', C201_R002_AC2, 'accepted', ['assemble']), reviewEvent('CSET-201-R002', ['changesets@518ffa'], ['criterion-proof', 'accepted-gap'], { passed: ['AC-1', 'AC-3', 'AC-4'], gaps: ['AC-2'] })], AT(2)).lineage;
  return l;
}

const VERIFIED = { verified: true, basis: 'producer-change' as const, records: ['CC-d82a9a5d9c3a055a'], detail: 'CSET-201.assemble.reasons.impl settled R002 AC-2 with its RED and a production change, integrated at d56cd1' };

describe("progress-aware convergence: the per-criterion count is a budget, never a cap (CSET-201 final)", () => {
  it("R003's materially new third AC-2 gap is accepted on verified producer progress, with its basis and the safety it leaves; without that progress it is not", () => {
    const l = c201Lineage();
    const s = summarizeLineage(l, C201_CRITERIA, null);
    // A lineage from before the ceiling: its budget is the 2 it recorded, its ceiling the default — never silently 2.
    expect(s.criteria['AC-2']).toMatchObject({ accepted_reworks: 2, max: 2, remaining: 0, ceiling: DEFAULT_CRITERION_CEILING, ceiling_remaining: DEFAULT_CRITERION_CEILING - 2, exhausted: false });
    expect(DEFAULT_CRITERION_CEILING).toBeGreaterThan(2);
    expect(s.criteria['AC-2']!.next_action).toMatch(/verified producer progress/);
    const [onProgress] = judgeGapLineage(s, [{ criterion: 'AC-2', reproduction: C201_R003_AC2 }], { progress: { 'AC-2': VERIFIED } });
    expect(onProgress).toMatchObject({ verdict: 'accepted', basis: 'progress', progress: ['CC-d82a9a5d9c3a055a'], duplicate_of: null });
    const event = gapEventOf('CSET-201-R003', onProgress!, 'accepted', ['assemble']);
    expect(event).toMatchObject({ kind: 'gap', verdict: 'accepted', basis: 'progress', progress: ['CC-d82a9a5d9c3a055a'] });
    // Accepted and reworked, it spends one more of the ceiling: what is left is said.
    const after = summarizeLineage(appendLineage(l, [event, reviewEvent('CSET-201-R003', ['changesets@d56cd1'], ['producer-change', 'accepted-gap'])], AT(3)).lineage, C201_CRITERIA, null);
    expect(after.criteria['AC-2']).toMatchObject({ accepted_reworks: 3, max: 2, remaining: 0, ceiling_remaining: DEFAULT_CRITERION_CEILING - 3 });
    expect(budgetLine(after)).toMatch(/AC-2 3\/2/);
    // No verified progress (none given, or none made): past the budget it is not reworked on newness alone.
    for (const facts of [undefined, { progress: { 'AC-2': { verified: false, basis: 'none' as const, records: [], detail: 'nothing settled since' } } }]) {
      expect(judgeGapLineage(s, [{ criterion: 'AC-2', reproduction: C201_R003_AC2 }], facts)[0]).toMatchObject({ verdict: 'exhausted', basis: 'no-progress' });
    }
    // Within the budget, nothing more is asked: the basis is the budget.
    expect(judgeGapLineage(s, [{ criterion: 'AC-1', reproduction: C201_R003_AC2 }])[0]).toMatchObject({ verdict: 'accepted', basis: 'budget' });
  });

  it('a reworded repeat is still a duplicate — unless it names an uncovered boundary none of the earlier gaps of its criterion named', () => {
    let l = emptyLineage(2);
    const first = judgeGapLineage(summarizeLineage(l, C201_CRITERIA, null), [{ criterion: 'AC-2', reproduction: C201_R002_AC2, boundaries: ['dependent range written with workspace: prefix recorded verbatim'] }])[0]!;
    expect(first).toMatchObject({ verdict: 'accepted', novelty: 'reproduction' });
    l = appendLineage(l, [gapEventOf('CSET-201-R002', first, 'accepted', ['assemble']), reviewEvent('CSET-201-R002', ['changesets@518ffa'], ['first-review', 'accepted-gap'])], AT(1)).lineage;
    const s = summarizeLineage(l, C201_CRITERIA, null);
    const reworded = `${C201_R002_AC2.toUpperCase()} Again.`;
    // The same reproduction and the same boundary, reworded: a duplicate, no rework.
    expect(judgeGapLineage(s, [{ criterion: 'AC-2', reproduction: reworded, boundaries: ['the dependent RANGE written with a workspace: prefix, recorded verbatim'] }])[0]).toMatchObject({ verdict: 'duplicate' });
    // The same reproduction, but a distinct uncovered boundary: materially new, judged on its budget.
    expect(judgeGapLineage(s, [{ criterion: 'AC-2', reproduction: reworded, boundaries: ['several changesets list the same package without raising the bump: one reason per changeset, none included'] }])[0]).toMatchObject({ verdict: 'accepted', basis: 'budget', novelty: 'boundary', duplicate_of: null });
    // An earlier gap that recorded no boundaries (a lineage from before them) cannot be told apart by one: still a duplicate.
    const old = summarizeLineage(c201Lineage(), C201_CRITERIA, null);
    expect(judgeGapLineage(old, [{ criterion: 'AC-2', reproduction: `${C201_R002_AC2} Again.`, boundaries: ['a brand new boundary nobody named before at all'] }])[0]).toMatchObject({ verdict: 'duplicate' });
  });

  it('the emergency ceiling still asks a person, configurable; a grant raises it for that criterion alone', () => {
    let l = { ...c201Lineage(), criterion_ceiling: 2 };
    let s = summarizeLineage(l, C201_CRITERIA, null);
    expect(s.criteria['AC-2']).toMatchObject({ ceiling: 2, ceiling_remaining: 0 });
    expect(judgeGapLineage(s, [{ criterion: 'AC-2', reproduction: C201_R003_AC2 }], { progress: { 'AC-2': VERIFIED } })[0]).toMatchObject({ verdict: 'exhausted', basis: 'ceiling' });
    l = appendLineage(l, [{ kind: 'grant', review_id: 'CSET-201-R003', criterion: 'AC-2', decision_id: 'D-1' }], AT(4)).lineage as typeof l;
    s = summarizeLineage(l, C201_CRITERIA, null);
    expect(s.criteria['AC-2']).toMatchObject({ max: 3, ceiling: 3 });
    expect(s.criteria['AC-3']).toMatchObject({ max: 2, ceiling: 2 });
    expect(judgeGapLineage(s, [{ criterion: 'AC-2', reproduction: C201_R003_AC2 }])[0]).toMatchObject({ verdict: 'accepted', basis: 'budget' });
  });

  it("R003's AC-3 repeats R001's, but the proof of its fix vanished from the head: a regression, never an ignored duplicate, and it spends nothing", () => {
    const s = summarizeLineage(c201Lineage(), C201_CRITERIA, null);
    // The same unresolved gap repeated: a duplicate.
    expect(judgeGapLineage(s, [{ criterion: 'AC-3', reproduction: C201_R003_AC3 }])[0]).toMatchObject({ verdict: 'duplicate', duplicate_of: reproductionSha256(C201_R001_AC3) });
    // The same gap already fixed, whose proof is lost at the reviewed head: a regression of it.
    const lost = [{ node_id: 'cli', record_id: 'CC-e8793d4dd86a401e', code: 'COMPLETION_TEST_MISSING', detail: 'status.test.ts declares no test "prints dependent reason line" at d56cd1' }];
    const [j] = judgeGapLineage(s, [{ criterion: 'AC-3', reproduction: C201_R003_AC3 }], { regressions: { 'AC-3': { lost } } });
    expect(j).toMatchObject({ verdict: 'regression', basis: 'regression', duplicate_of: reproductionSha256(C201_R001_AC3), lost });
    const after = summarizeLineage(appendLineage(c201Lineage(), [gapEventOf('CSET-201-R003', j!, 'regression', ['cli']), { kind: 'regression', review_id: 'CSET-201-R003', criterion: 'AC-3', node_id: 'cli', record_id: 'CC-e8793d4dd86a401e', code: 'COMPLETION_TEST_MISSING' }], AT(5)).lineage, C201_CRITERIA, null);
    expect(after.criteria['AC-3']).toMatchObject({ accepted_reworks: 1, remaining: 1, regressions: 1 });
  });

  it('a lineage written before progress-aware convergence keeps every event as hashed; R003 judged again is accepted on its progress', () => {
    const state = c201('features/CSET-201/STATE.json')['data'];
    const lineage = state['acceptance_review']['lineage'] as ReviewLineage;
    expect(lineage.max_criterion_reworks).toBe(2);
    expect(chainProblems(lineage)).toEqual([]);
    // Its own exhausted verdict stays the fact it recorded; read now, AC-2's budget is 2 and its ceiling the default.
    const s = summarizeLineage(lineage, C201_CRITERIA, null);
    expect(s.criteria['AC-2']).toMatchObject({ accepted_reworks: 2, max: 2, ceiling: DEFAULT_CRITERION_CEILING });
    expect(s.criteria['AC-2']!.reproductions.map((r) => r.status)).toEqual(['accepted', 'accepted', 'exhausted']);
    const before = { ...lineage, events: lineage.events.filter((e) => e.seq <= 5) };
    expect(judgeGapLineage(summarizeLineage(before, C201_CRITERIA, null), [{ criterion: 'AC-2', reproduction: C201_R003_AC2 }], { progress: { 'AC-2': VERIFIED } })[0]).toMatchObject({ verdict: 'accepted', basis: 'progress' });
  });

  it('a criterion whose completed proof keeps being lost and restored stops the review: no recovery, nonconvergent', () => {
    let l = c201Lineage();
    for (const [n, record] of [[6, 'CC-1'], [7, 'CC-2']] as const) l = appendLineage(l, [{ kind: 'regression', review_id: `CSET-201-R00${n - 3}`, criterion: 'AC-3', node_id: 'cli', record_id: record, code: 'COMPLETION_TEST_MISSING' }], AT(n)).lineage;
    expect(nonconvergence(summarizeLineage(l, C201_CRITERIA, null))).toBeNull();
    l = appendLineage(l, [{ kind: 'regression', review_id: 'CSET-201-R005', criterion: 'AC-3', node_id: 'cli', record_id: 'CC-3', code: 'COMPLETION_TEST_MISSING' }], AT(8)).lineage;
    expect(summarizeLineage(l, C201_CRITERIA, null).criteria['AC-3']).toMatchObject({ regressions: MAX_REGRESSIONS + 1 });
    expect(nonconvergence(summarizeLineage(l, C201_CRITERIA, null))).toMatch(/AC-3.*lost.*restored/);
  });

  it('a configured review wall-clock or session budget is the stop, never the criterion count', () => {
    const l = { ...c201Lineage(), max_review_ms: 60 * 60_000, max_review_sessions: 3 };
    const s = summarizeLineage(l, C201_CRITERIA, null);
    expect(s).toMatchObject({ max_review_ms: 3_600_000, first_review_at: AT(1), max_review_sessions: 3 });
    expect(nonconvergence(s, Date.parse(AT(1)) + 59 * 60_000)).toBeNull();
    expect(nonconvergence(s, Date.parse(AT(1)) + 61 * 60_000)).toMatch(/wall-clock/);
    const three = summarizeLineage(appendLineage(l, [reviewEvent('CSET-201-R003', ['changesets@d56cd1'], ['producer-change'])], AT(3)).lineage, C201_CRITERIA, null);
    expect(nonconvergence(three, Date.parse(AT(3)))).toMatch(/3 review sessions/);
  });
});

describe('a review state from before the lineage is migrated from its records and receipts', () => {
  it("r11's STATE.json and receipts: AC-1 withdrawn twice and unspent, AC-3 and AC-5 one each, R003's gaps never acted on; R003 judged again is accepted", () => {
    const state = receipt('features/CSET-203/STATE.json')['data'];
    const review = state['acceptance_review'];
    const migrated = migrateLineage({ reviews: review['reviews'], challenges: review['challenges'], maxCriterionReworks: review['max_rounds'], readReceipt: (rel: string) => receipt(rel) });
    expect(chainProblems(migrated)).toEqual([]);
    expect(migrated.events[0]).toMatchObject({ kind: 'migrated', reviews: ['CSET-203-R001', 'CSET-203-R002', 'CSET-203-R003'] });
    const s = summarizeLineage(migrated, CRITERIA, null);
    expect(s.criteria['AC-1']).toMatchObject({ accepted_reworks: 0, withdrawals: 2, remaining: 2 });
    expect(s.criteria['AC-1']!.reproductions.map((r) => [r.review_id, r.status])).toEqual([['CSET-203-R001', 'withdrawn'], ['CSET-203-R002', 'withdrawn'], ['CSET-203-R003', 'unreworkable']]);
    expect(s.criteria['AC-3']).toMatchObject({ accepted_reworks: 1, remaining: 1 });
    expect(s.criteria['AC-5']).toMatchObject({ accepted_reworks: 1, remaining: 1 });
    expect(s.review_sessions).toBe(3);
    // R003's own gaps, judged against the lineage before it: neither repeats, neither exhausts.
    const before = migrateLineage({ reviews: review['reviews'].slice(0, 2), challenges: review['challenges'], maxCriterionReworks: review['max_rounds'], readReceipt: (rel: string) => receipt(rel) });
    expect(judgeGapLineage(summarizeLineage(before, CRITERIA, null), [{ criterion: 'AC-1', reproduction: R003_AC1 }, { criterion: 'AC-3', reproduction: R003_AC3 }]).map((j) => j.verdict)).toEqual(['accepted', 'accepted']);
    // The same migration twice is the same chain: it is deterministic.
    expect(migrateLineage({ reviews: review['reviews'], challenges: review['challenges'], maxCriterionReworks: review['max_rounds'], readReceipt: (rel: string) => receipt(rel) }).head_sha256).toBe(migrated.head_sha256);
  });
});
