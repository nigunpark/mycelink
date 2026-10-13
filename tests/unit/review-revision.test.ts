/**
 * A review's revisions and the producer orders bound to them (engine/review-revision.ts).
 *
 * CSET-203 r14: a refinement repointed R002 at R002.refined-1.json while the
 * cli's order of AC-3, a gap the refinement never touched, stayed bound to
 * the original receipt. Here, as pure functions: a review's revision chain
 * and the revision an order is bound to; what a refinement does to each
 * gap of the revision it refines (retained, withdrawn, refined, upheld) and
 * to each producer's order (rebased with a carry proof, amended, cancelled,
 * reordered, ordered, kept); a rebase record bound by its own hash; and why
 * a chain, an order or a rebase record cannot be trusted.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { GraphNode, PortfolioGraph, ReviewRecord } from '../../src/model/types.js';
import type { Gap } from '../../src/engine/acceptance-review.js';
import { boundRevision, orderBindingProblems, planRevision, rebaseProblems, rebaseRecord, revisionChain, revisionChainProblems, type NodeOrderView, type RevisionRef } from '../../src/engine/review-revision.js';
import { reproductionFingerprint } from '../../src/engine/review-lineage.js';

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

/** P1 serves AC-1 and AC-4; P2 (after P1) serves AC-3, AC-4 and AC-5. */
const graph = {
  schema_version: 1,
  feature_id: 'F-1',
  title: 't',
  acceptance_criteria: [
    { id: 'AC-1', text: 'one', kind: 'new-behavior' },
    { id: 'AC-3', text: 'three', kind: 'new-behavior' },
    { id: 'AC-4', text: 'four', kind: 'new-behavior' },
    { id: 'AC-5', text: 'five', kind: 'compatibility' },
  ],
  resources: {},
  repositories: ['r'],
  capabilities: [],
  nodes: [node('P1', ['AC-1', 'AC-4']), node('P2', ['AC-3', 'AC-4', 'AC-5'], ['P1'])],
} as unknown as PortfolioGraph;

const gap = (criterion: string, reproduction: string): Gap => ({ criterion, missing: `${criterion} missing`, reproduction, producer: null, confidence: 'high' }) as Gap;
const G1 = gap('AC-1', 'inject a formatter failure after a created changelog; assert it is gone');
const G3 = gap('AC-3', 'leave a journal and run version with commit; assert one versioning');
const G4 = gap('AC-4', 'make the formatter throw with commit enabled; assert exit 1 and no stack');
const G4R = gap('AC-4', 'make git add throw index.lock exists after a successful apply; assert exit 1 and no commit');
const G5 = gap('AC-5', 'put a journal beside a changeset and run status; assert it is not listed');
const bound = (g: Gap): { criterion: string; reproduction_sha256: string } => ({ criterion: g.criterion, reproduction_sha256: sha(g.reproduction) });

const live = (id: string, gaps: Gap[]): NodeOrderView => ({ node_id: id, live: { criteria: gaps.map((g) => g.criterion), review_gaps: gaps.map(bound) }, challenged: null, completed: null });
const challenged = (id: string, criteria: string[]): NodeOrderView => ({ node_id: id, live: null, challenged: { criteria }, completed: null });
const completed = (id: string, criteria: string[]): NodeOrderView => ({ node_id: id, live: null, challenged: null, completed: { criteria } });

describe('planRevision: what a refinement does to each gap and each order', () => {
  it("r14: AC-1 withdrawn on its challenger, AC-3 untouched — the sibling's order is rebased, with a carry proof of AC-3's reproduction, fingerprint and producer", () => {
    const plan = planRevision({ graph, parentGaps: [G1, G3], decisions: [{ challenge_id: 'F-1-R002-C1', criterion: 'AC-1', decision: 'WITHDRAW' }], refined: [], accepted: new Set(), nodes: [challenged('P1', ['AC-1']), live('P2', [G3])] });
    expect(plan.dispositions).toEqual([
      { criterion: 'AC-1', reproduction_sha256: sha(G1.reproduction), fingerprint: reproductionFingerprint(G1.reproduction).sha256, disposition: 'withdrawn', challenge_id: 'F-1-R002-C1' },
      { criterion: 'AC-3', reproduction_sha256: sha(G3.reproduction), fingerprint: reproductionFingerprint(G3.reproduction).sha256, disposition: 'retained', challenge_id: null },
    ]);
    expect(plan.gaps).toEqual([G3]);
    expect(plan.orders).toEqual([
      { node_id: 'P2', action: 'rebase', criteria_before: ['AC-3'], criteria_after: ['AC-3'], gaps: [G3], carry: [{ criterion: 'AC-3', reproduction_sha256: sha(G3.reproduction), fingerprint: reproductionFingerprint(G3.reproduction).sha256, from_targets: ['P2'], to_targets: ['P2'] }] },
    ]);
  });

  it('a shared criterion withdrawn: the sibling keeps its untouched gaps (amended), or its order is cancelled when that was all it had; nothing else is lost', () => {
    const narrowed = planRevision({ graph, parentGaps: [G1, G3, G4], decisions: [{ challenge_id: 'C1', criterion: 'AC-1', decision: 'WITHDRAW' }, { challenge_id: 'C1', criterion: 'AC-4', decision: 'WITHDRAW' }], refined: [], accepted: new Set(), nodes: [challenged('P1', ['AC-1', 'AC-4']), live('P2', [G3, G4])] });
    expect(narrowed.orders).toEqual([expect.objectContaining({ node_id: 'P2', action: 'amend', criteria_before: ['AC-3', 'AC-4'], criteria_after: ['AC-3'], gaps: [G3] })]);
    const cancelled = planRevision({ graph, parentGaps: [G1, G4], decisions: [{ challenge_id: 'C1', criterion: 'AC-1', decision: 'WITHDRAW' }, { challenge_id: 'C1', criterion: 'AC-4', decision: 'WITHDRAW' }], refined: [], accepted: new Set(), nodes: [challenged('P1', ['AC-1', 'AC-4']), live('P2', [G4])] });
    expect(cancelled.orders).toEqual([expect.objectContaining({ node_id: 'P2', action: 'cancel', criteria_before: ['AC-4'], criteria_after: [] })]);
    expect(cancelled.gaps).toEqual([]);
  });

  it("a shared criterion refined: its challenger reordered for it, the sibling's order amended to it with its untouched gap kept; a duplicate or exhausted refined gap orders nothing", () => {
    const refined = planRevision({ graph, parentGaps: [G1, G3, G4], decisions: [{ challenge_id: 'C1', criterion: 'AC-1', decision: 'WITHDRAW' }, { challenge_id: 'C1', criterion: 'AC-4', decision: 'REFINE' }], refined: [{ ...G4R, challenge_id: 'C1' }], accepted: new Set(['AC-4']), nodes: [challenged('P1', ['AC-1', 'AC-4']), live('P2', [G3, G4])] });
    expect(refined.dispositions.find((d) => d.criterion === 'AC-4')).toMatchObject({ disposition: 'refined', challenge_id: 'C1', to_reproduction_sha256: sha(G4R.reproduction) });
    expect(refined.orders).toEqual([
      expect.objectContaining({ node_id: 'P2', action: 'amend', criteria_before: ['AC-3', 'AC-4'], criteria_after: ['AC-3', 'AC-4'], gaps: [G3, G4R] }),
      expect.objectContaining({ node_id: 'P1', action: 'reorder', criteria_before: ['AC-1', 'AC-4'], criteria_after: ['AC-4'], gaps: [G4R] }),
    ]);
    const duplicate = planRevision({ graph, parentGaps: [G1, G4], decisions: [{ challenge_id: 'C1', criterion: 'AC-4', decision: 'UPHOLD' }], refined: [{ ...G4R, challenge_id: 'C1' }], accepted: new Set(), nodes: [challenged('P1', ['AC-1', 'AC-4']), live('P2', [G4])] });
    expect(duplicate.dispositions.find((d) => d.criterion === 'AC-4')).toMatchObject({ disposition: 'upheld' });
    // AC-4's upheld gap orders nothing (a duplicate): the sibling's order of the old reproduction is cancelled; the challenger keeps its retained AC-1 alone.
    expect(duplicate.orders).toEqual([expect.objectContaining({ node_id: 'P2', action: 'cancel' }), expect.objectContaining({ node_id: 'P1', action: 'reorder', criteria_after: ['AC-1'], gaps: [G1] })]);
  });

  it('the challenger with a withdrawn and a retained gap is reordered for the retained one alone; a node that completed its order is kept; a node a refined gap newly targets is ordered', () => {
    const split = planRevision({ graph, parentGaps: [G3, G4], decisions: [{ challenge_id: 'C1', criterion: 'AC-3', decision: 'WITHDRAW' }], refined: [], accepted: new Set(), nodes: [challenged('P2', ['AC-3', 'AC-4'])] });
    // AC-4 is P1's too: its order of it stands (a live order) or was completed; here P1 had none and is ordered nothing new for a retained gap.
    expect(split.orders.find((o) => o.node_id === 'P2')).toMatchObject({ action: 'reorder', criteria_before: ['AC-3', 'AC-4'], criteria_after: ['AC-4'], gaps: [G4] });
    const kept = planRevision({ graph, parentGaps: [G1, G5], decisions: [{ challenge_id: 'C1', criterion: 'AC-1', decision: 'WITHDRAW' }], refined: [], accepted: new Set(), nodes: [challenged('P1', ['AC-1']), completed('P2', ['AC-5'])] });
    expect(kept.orders).toEqual([expect.objectContaining({ node_id: 'P2', action: 'keep', criteria_before: ['AC-5'], criteria_after: ['AC-5'] })]);
    const ordered = planRevision({ graph, parentGaps: [G1, G4], decisions: [{ challenge_id: 'C1', criterion: 'AC-4', decision: 'REFINE' }], refined: [{ ...G4R, challenge_id: 'C1' }], accepted: new Set(['AC-4']), nodes: [challenged('P1', ['AC-1', 'AC-4']), completed('P2', ['AC-4'])] });
    expect(ordered.orders).toEqual([expect.objectContaining({ node_id: 'P2', action: 'order', criteria_after: ['AC-4'], gaps: [G4R] }), expect.objectContaining({ node_id: 'P1', action: 'reorder', criteria_after: ['AC-1', 'AC-4'] })]);
  });
});

describe('revisions, bindings and rebase records', () => {
  const original = { dispatch_id: 'd0', receipt_path: 'features/F-1/reviews/F-1-R002.json', receipt_sha256: 'a'.repeat(64), overall: 'GAPS' as const, inputs_sha256: 'i'.repeat(64) };
  const rec = {
    review_id: 'F-1-R002',
    dispatch_id: 'd0',
    capability_sha256: 'c'.repeat(64),
    review: 2,
    overall: 'GAPS',
    inputs_sha256: 'i'.repeat(64),
    receipt_path: 'features/F-1/reviews/F-1-R002.refined-1.json',
    receipt_sha256: 'b'.repeat(64),
    at: '2026-10-10T00:00:00.000Z',
    reworks: ['P2'],
    reworks_applied: true,
    outcome: 'GAPS',
    revision: 1,
    original,
    refinements: [{ dispatch_id: 'd1', capability_sha256: 'e'.repeat(64), round: 1, challenges: ['F-1-R002-C1'], decisions: [], receipt_path: 'features/F-1/reviews/F-1-R002.refined-1.json', receipt_sha256: 'b'.repeat(64), at: '2026-10-10T00:01:00.000Z', revision: 1 }],
  } as unknown as ReviewRecord;
  const rev0: RevisionRef = { revision: 0, receipt_path: original.receipt_path, receipt_sha256: original.receipt_sha256 };
  const rev1: RevisionRef = { revision: 1, receipt_path: rec.receipt_path, receipt_sha256: rec.receipt_sha256 };

  it("a review's chain is its original receipt, then each refinement's; an order is bound to its origin's revision, or (r14's, from before revisions) to the revision its evidence names", () => {
    expect(revisionChain(rec)).toEqual([rev0, rev1]);
    expect(revisionChain({ ...rec, original: null, refinements: [], revision: 0, receipt_path: original.receipt_path, receipt_sha256: original.receipt_sha256 } as unknown as ReviewRecord)).toEqual([rev0]);
    expect(boundRevision(rec, { origin: { kind: 'acceptance-review', review_id: 'F-1-R002', review: 2, revision: 1, receipt_path: rev1.receipt_path, receipt_sha256: rev1.receipt_sha256 }, evidence: [rev1.receipt_path] })).toEqual(rev1);
    expect(boundRevision(rec, { origin: { kind: 'acceptance-review', review_id: 'F-1-R002', review: 2 }, evidence: [original.receipt_path] })).toEqual(rev0);
    expect(boundRevision(rec, { origin: { kind: 'acceptance-review', review_id: 'F-1-R002', review: 2 }, evidence: ['features/F-1/reviews/other.json'] })).toBeNull();
  });

  it('a rebase record is bound by its own hash; one edited, or naming a revision the chain does not pin, or carrying a reproduction a receipt does not hold, is a problem', () => {
    const carry = [{ criterion: 'AC-3', reproduction_sha256: sha(G3.reproduction), fingerprint: reproductionFingerprint(G3.reproduction).sha256, from_targets: ['P2'], to_targets: ['P2'] }];
    const r = rebaseRecord({ review_id: 'F-1-R002', from: rev0, to: rev1, criteria: ['AC-3'], carry, by: 'refinement', claim: null, at: '2026-10-10T00:01:00.000Z' });
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    const gapsOf = (ref: RevisionRef): Gap[] | null => (ref.revision === 0 ? [G1, G3] : ref.revision === 1 ? [G3] : null);
    expect(rebaseProblems(r, [rev0, rev1], gapsOf)).toEqual([]);
    expect(rebaseProblems({ ...r, carry: [{ ...carry[0]!, reproduction_sha256: sha('forged') }] }, [rev0, rev1], gapsOf).join('\n')).toMatch(/hash/);
    const forged = rebaseRecord({ review_id: 'F-1-R002', from: rev0, to: rev1, criteria: ['AC-3'], carry: [{ ...carry[0]!, reproduction_sha256: sha('forged') }], by: 'refinement', claim: null, at: r.at });
    expect(rebaseProblems(forged, [rev0, rev1], gapsOf).join('\n')).toMatch(/AC-3/);
    expect(rebaseProblems(rebaseRecord({ review_id: 'F-1-R002', from: rev0, to: { ...rev1, receipt_sha256: 'f'.repeat(64) }, criteria: ['AC-3'], carry, by: 'refinement', claim: null, at: r.at }), [rev0, rev1], gapsOf).join('\n')).toMatch(/revision 1/);
  });

  it("a chain whose receipt is not as pinned, or whose refinement does not name the revision before it, cannot be trusted; an order whose gaps are not its bound receipt's is refused", () => {
    const receipts: Record<string, { sha256: string; json: Record<string, any> }> = {
      [rev0.receipt_path]: { sha256: rev0.receipt_sha256, json: { gaps: [G1, G3] } },
      [rev1.receipt_path]: { sha256: rev1.receipt_sha256, json: { revision: 1, parent: { revision: 0, receipt_path: rev0.receipt_path, receipt_sha256: rev0.receipt_sha256 }, refinement: { of: { receipt_path: rev0.receipt_path, receipt_sha256: rev0.receipt_sha256 } }, gaps: [G3] } },
    };
    const read = (rel: string): { sha256: string; json: Record<string, any> } | null => receipts[rel] ?? null;
    expect(revisionChainProblems(rec, read)).toEqual([]);
    const edited = { ...receipts, [rev1.receipt_path]: { ...receipts[rev1.receipt_path]!, sha256: 'd'.repeat(64) } };
    expect(revisionChainProblems(rec, (rel) => edited[rel] ?? null).join('\n')).toMatch(/refined-1\.json/);
    const relinked = { ...receipts, [rev1.receipt_path]: { ...receipts[rev1.receipt_path]!, json: { ...receipts[rev1.receipt_path]!.json, parent: { revision: 0, receipt_path: rev0.receipt_path, receipt_sha256: '9'.repeat(64) } } } };
    expect(revisionChainProblems(rec, (rel) => relinked[rel] ?? null).join('\n')).toMatch(/parent/);
    const brief = { origin: { kind: 'acceptance-review' as const, review_id: 'F-1-R002', review: 2, revision: 1, receipt_path: rev1.receipt_path, receipt_sha256: rev1.receipt_sha256 }, evidence: [rev1.receipt_path], acceptance_criteria: ['AC-3'], review_gaps: [bound(G3)] };
    expect(orderBindingProblems(rec, brief, read)).toEqual([]);
    expect(orderBindingProblems(rec, { ...brief, review_gaps: [{ criterion: 'AC-3', reproduction_sha256: sha('another') }] }, read).join('\n')).toMatch(/AC-3/);
    expect(orderBindingProblems(rec, { ...brief, origin: { ...brief.origin, receipt_sha256: 'f'.repeat(64) } }, read).join('\n')).toMatch(/revision 1/);
  });
});
