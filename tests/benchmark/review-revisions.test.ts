/**
 * The with arm's record of the acceptance review's revisions and the orders
 * rebased between them (CSET-203 r14), verified by the harness itself from
 * the control repository's files: each review's chain — its original
 * receipt, then each refinement's, each hashing as STATE.json pins it and
 * naming the revision before it as its parent — and each rebase record —
 * bound by its own hash, naming revisions the chain pins, carrying gaps both
 * receipts hold exactly. Anything else is a trust problem of the run.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { reviewRevisions, reviewRevisionTrustProblems } from '../../evals-public-projects/lib/revisions.mjs';
import { canonicalSha256 } from '../../evals-public-projects/lib/hash.mjs';
import { runOk, runVerdict } from '../../evals-public-projects/lib/arms.mjs';

afterAll(() => cleanupTmpRoots());

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const F = 'CSET-203';
const R = `${F}-R002`;
const REV0 = `features/${F}/reviews/${R}.json`;
const REV1 = `features/${F}/reviews/${R}.refined-1.json`;
const AC1 = 'inject a formatter failure after a deleted changeset; assert it is back';
const AC3 = 'leave a journal and run version with commit; assert one versioning';

interface Built {
  control: string;
  write(rel: string, body: string): string;
  state(data: Record<string, unknown>): void;
}

function control(): Built {
  const root = makeTmpDir('bench-revisions-');
  mkdirSync(join(root, 'features', F, 'reviews'), { recursive: true });
  return {
    control: root,
    write(rel, body) {
      writeFileSync(join(root, ...rel.split('/')), body);
      return sha(body);
    },
    state(data) {
      writeFileSync(join(root, 'features', F, 'STATE.json'), JSON.stringify({ revision: 1, data }, null, 2));
    },
  };
}

/** A review refined once (AC-1 withdrawn), the cli's AC-3 order rebased from revision 0 to 1. */
function refinedOnce(edit: { rev1?: (r: Record<string, any>) => void; rebase?: (r: Record<string, any>) => void } = {}): Built {
  const b = control();
  const rev0 = JSON.stringify({ schema: 'mycelink-review-receipt/1', review_id: R, gaps: [{ criterion: 'AC-1', reproduction: AC1 }, { criterion: 'AC-3', reproduction: AC3 }] }, null, 2) + '\n';
  const sha0 = b.write(REV0, rev0);
  const r1: Record<string, any> = { schema: 'mycelink-review-receipt/1', review_id: R, revision: 1, parent: { revision: 0, receipt_path: REV0, receipt_sha256: sha0 }, refinement: { of: { review_id: R, receipt_path: REV0, receipt_sha256: sha0 } }, gaps: [{ criterion: 'AC-3', reproduction: AC3 }] };
  edit.rev1?.(r1);
  const sha1 = b.write(REV1, JSON.stringify(r1, null, 2) + '\n');
  const body: Record<string, any> = {
    review_id: R,
    from: { revision: 0, receipt_path: REV0, receipt_sha256: sha0 },
    to: { revision: 1, receipt_path: REV1, receipt_sha256: sha1 },
    criteria: ['AC-3'],
    carry: [{ criterion: 'AC-3', reproduction_sha256: sha(AC3), fingerprint: 'f'.repeat(64), from_targets: ['cli'], to_targets: ['cli'] }],
    by: 'refinement',
    claim: null,
    at: '2026-10-10T13:00:45.648Z',
  };
  const rebase: Record<string, any> = { ...body, sha256: canonicalSha256(body) };
  edit.rebase?.(rebase);
  b.state({
    feature_id: F,
    nodes: {
      cli: { state: 'INVALIDATED', rework_brief: { origin: { kind: 'acceptance-review', review_id: R, review: 2, revision: 1, receipt_path: REV1, receipt_sha256: sha1 }, rebases: [rebase] }, rework_history: [{ at: 'x', rebases: [rebase] }] },
      arp: { state: 'DONE', rework_brief: null, rework_history: [] },
    },
    acceptance_review: {
      reviews: [
        {
          review_id: R,
          revision: 1,
          receipt_path: REV1,
          receipt_sha256: sha1,
          original: { dispatch_id: 'd0', receipt_path: REV0, receipt_sha256: sha0, overall: 'GAPS', inputs_sha256: 'i'.repeat(64) },
          refinements: [{ dispatch_id: 'd1', revision: 1, receipt_path: REV1, receipt_sha256: sha1, orders: [{ node_id: 'cli', action: 'rebase' }] }],
        },
      ],
    },
  });
  return b;
}

describe('the with arm records the review revisions and the rebased orders, verified from the files', () => {
  it('a chain and a rebase as Mycelink wrote them: recorded, no problem', () => {
    const b = refinedOnce();
    const r = reviewRevisions({ control: b.control, featureId: F });
    expect(r.problems).toEqual([]);
    expect(r.reviews).toEqual([{ review_id: R, revision: 1, receipts: [expect.objectContaining({ revision: 0, receipt_path: REV0 }), expect.objectContaining({ revision: 1, receipt_path: REV1, parent_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) })] }]);
    expect(r.rebases).toEqual([expect.objectContaining({ node_id: 'cli', review_id: R, from: 0, to: 1, criteria: ['AC-3'], by: 'refinement', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) })]);
    expect(reviewRevisionTrustProblems({ review_revisions: r })).toEqual([]);
  });

  it('a revision receipt edited, a parent link that is not the revision before, a rebase record edited or carrying a reproduction the receipts do not hold: each a trust problem', () => {
    const edited = refinedOnce();
    writeFileSync(join(edited.control, ...REV1.split('/')), JSON.stringify({ review_id: R, revision: 1, gaps: [] }));
    expect(reviewRevisions({ control: edited.control, featureId: F }).problems.join('\n')).toMatch(/refined-1\.json/);
    const relinked = refinedOnce({ rev1: (r) => (r['parent'] = { ...r['parent'], receipt_sha256: '0'.repeat(64) }) });
    expect(reviewRevisions({ control: relinked.control, featureId: F }).problems.join('\n')).toMatch(/parent/);
    const forged = refinedOnce({ rebase: (r) => (r['carry'][0]['reproduction_sha256'] = sha('forged')) });
    const p = reviewRevisions({ control: forged.control, featureId: F });
    expect(p.problems.join('\n')).toMatch(/hash/);
    expect(reviewRevisionTrustProblems({ review_revisions: p })[0]).toMatch(/^review revisions: /);
    const recarried = refinedOnce({
      rebase: (r) => {
        r['carry'][0]['reproduction_sha256'] = sha('forged');
        const { sha256: _s, ...body } = r;
        r['sha256'] = canonicalSha256(body);
      },
    });
    expect(reviewRevisions({ control: recarried.control, featureId: F }).problems.join('\n')).toMatch(/AC-3/);
  });

  it('no control repository, or a feature with no review, records nothing and judges nothing', () => {
    const b = control();
    expect(reviewRevisions({ control: b.control, featureId: F })).toEqual({ reviews: [], rebases: [], problems: [] });
    expect(reviewRevisionTrustProblems({})).toEqual([]);
  });

  it("a run whose review revisions cannot be trusted is untrusted and not ok, whatever its delivery", () => {
    const forged = refinedOnce({ rebase: (r) => (r['by'] = 'reconcile') });
    const base = { arm: 'with', isolation: { kind: 'bubblewrap', enforced: true, preflight: { ok: true } }, controller_guard: true, sessions: [] };
    const verification = { ok: true, trusted: true, errors: [], sections: {} };
    const clean = { ...base, review_revisions: reviewRevisions({ control: refinedOnce().control, featureId: F }) };
    expect(runVerdict({ record: clean, verification }).trust.problems.filter((p: string) => p.startsWith('review revisions'))).toEqual([]);
    expect(runOk({ record: clean, verification })).toBe(true);
    const bad = { ...base, review_revisions: reviewRevisions({ control: forged.control, featureId: F }) };
    const v = runVerdict({ record: bad, verification });
    expect(v.verdict).toBe('untrusted');
    expect(v.trust.problems).toContainEqual(expect.stringMatching(/^review revisions: /));
    expect(runOk({ record: bad, verification })).toBe(false);
  });
});
