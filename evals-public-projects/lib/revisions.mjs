/**
 * The acceptance review's revisions and the producer orders rebased between
 * them (CSET-203 r14), as the with arm's control repository holds them,
 * verified by the harness itself — never taken from what Mycelink says of
 * them.
 *
 * r14: a refinement repointed R002 at R002.refined-1.json while the cli's
 * order of AC-3, a gap it never touched, stayed bound to the original
 * receipt; the cli's challenge was refused twice as stale and the cli
 * BLOCKED. The plugin now makes every refinement an immutable revision linked
 * to the one before it, and rebases each order whose gaps it carries
 * unchanged in the same write, with a rebase record bound by its own hash.
 *
 * Here, from STATE.json and the receipts alone: each review's chain — its
 * original receipt (revision 0), then each refinement's — every receipt
 * hashing as STATE.json pins it, each refinement naming the revision before
 * it as its parent (and refining exactly it); and each rebase record (a live
 * order's and its history entry's) bound by the canonical SHA-256 of what it
 * says, naming revisions its review's chain pins, carrying each gap with the
 * exact reproduction both receipts hold. Anything else is a trust problem of
 * the run: the record of what was reworked, and on whose finding, was
 * changed outside Mycelink.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalSha256, sha256Hex } from './hash.mjs';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const short = (s) => String(s ?? '').slice(0, 12);

/** A receipt under the control root: the SHA-256 of its bytes and its JSON, or null. */
function readReceipt(control, rel) {
  if (typeof rel !== 'string' || rel === '' || rel.split('/').includes('..')) return null;
  const file = join(control, ...rel.split('/'));
  if (!existsSync(file)) return null;
  try {
    const bytes = readFileSync(file);
    return { sha256: sha256Hex(bytes), json: JSON.parse(bytes.toString('utf8')) };
  } catch {
    return null;
  }
}

/** A review's chain as STATE.json pins it: its original receipt, then each refinement's. */
function chainOf(rec) {
  const first = isObject(rec.original) ? rec.original : { receipt_path: rec.receipt_path, receipt_sha256: rec.receipt_sha256 };
  return [{ revision: 0, receipt_path: first.receipt_path, receipt_sha256: first.receipt_sha256 }, ...(Array.isArray(rec.refinements) ? rec.refinements : []).map((r, i) => ({ revision: i + 1, receipt_path: r.receipt_path, receipt_sha256: r.receipt_sha256 }))];
}

/**
 * `{ reviews, rebases, problems }`: each review's revisions (each receipt by
 * hash, with the hash of the one it refines), each rebase record (its node,
 * review, revisions, criteria, by whom, hash), and every reason they cannot
 * be trusted. A feature never initialised, or with no review, records nothing.
 */
export function reviewRevisions({ control, featureId }) {
  const out = { reviews: [], rebases: [], problems: [] };
  let state;
  try {
    state = JSON.parse(readFileSync(join(control, 'features', featureId, 'STATE.json'), 'utf8')).data;
  } catch {
    return out;
  }
  const reviews = Array.isArray(state?.acceptance_review?.reviews) ? state.acceptance_review.reviews : [];
  const chains = new Map();
  for (const rec of reviews) {
    if (!isObject(rec) || typeof rec.review_id !== 'string') continue;
    const chain = chainOf(rec);
    chains.set(rec.review_id, chain);
    const receipts = [];
    for (const ref of chain) {
      const r = readReceipt(control, ref.receipt_path);
      receipts.push({ revision: ref.revision, receipt_path: ref.receipt_path, receipt_sha256: ref.receipt_sha256, parent_sha256: ref.revision === 0 ? null : chain[ref.revision - 1].receipt_sha256 });
      if (r === null) {
        out.problems.push(`${ref.receipt_path} (revision ${ref.revision} of ${rec.review_id}) is missing or not JSON`);
        continue;
      }
      if (r.sha256 !== ref.receipt_sha256) out.problems.push(`${ref.receipt_path} (revision ${ref.revision} of ${rec.review_id}) hashes to ${short(r.sha256)}, not ${short(ref.receipt_sha256)} as STATE.json pins`);
      if (ref.revision === 0) continue;
      const prev = chain[ref.revision - 1];
      const j = isObject(r.json) ? r.json : {};
      if (j.revision !== undefined && j.revision !== ref.revision) out.problems.push(`${ref.receipt_path} says it is revision ${j.revision} of ${rec.review_id}, not ${ref.revision}`);
      if (j.parent !== undefined && (j.parent?.revision !== prev.revision || j.parent?.receipt_path !== prev.receipt_path || j.parent?.receipt_sha256 !== prev.receipt_sha256)) out.problems.push(`${ref.receipt_path} names parent ${short(j.parent?.receipt_sha256)}, not revision ${prev.revision} of ${rec.review_id} (${short(prev.receipt_sha256)})`);
      const of = j.refinement?.of;
      if (of !== undefined && of?.receipt_sha256 !== prev.receipt_sha256) out.problems.push(`${ref.receipt_path} refines ${short(of?.receipt_sha256)}, not revision ${prev.revision} of ${rec.review_id} (${short(prev.receipt_sha256)})`);
    }
    if (rec.revision !== undefined && rec.revision !== chain.length - 1) out.problems.push(`${rec.review_id} records revision ${rec.revision}, but its chain ends at revision ${chain.length - 1}`);
    out.reviews.push({ review_id: rec.review_id, revision: chain.length - 1, receipts });
  }
  const gapsOf = (ref) => {
    const r = readReceipt(control, ref?.receipt_path);
    if (r === null || r.sha256 !== ref.receipt_sha256) return null;
    return Array.isArray(r.json?.gaps) ? r.json.gaps : [];
  };
  for (const [nodeId, rt] of Object.entries(state?.nodes ?? {})) {
    const seen = new Set();
    const records = [...(rt?.rework_brief?.rebases ?? []), ...(Array.isArray(rt?.rework_history) ? rt.rework_history : []).flatMap((e) => e?.rebases ?? [])];
    for (const r of records) {
      if (!isObject(r) || seen.has(r.sha256)) continue;
      seen.add(r.sha256);
      out.rebases.push({ node_id: nodeId, review_id: r.review_id ?? null, from: r.from?.revision ?? null, to: r.to?.revision ?? null, criteria: Array.isArray(r.criteria) ? r.criteria : [], by: r.by ?? null, sha256: r.sha256 ?? null });
      const { sha256: recorded, ...body } = r;
      let actual = null;
      try {
        actual = canonicalSha256(body);
      } catch {
        actual = null;
      }
      if (actual !== recorded) out.problems.push(`${nodeId}'s rebase of ${r.review_id} does not hash to its recorded ${short(recorded)}: it was changed`);
      const chain = chains.get(r.review_id);
      if (chain === undefined) {
        out.problems.push(`${nodeId}'s rebase names ${r.review_id}, which is not a settled review`);
        continue;
      }
      for (const ref of [r.from, r.to]) {
        const pinned = chain[ref?.revision];
        if (pinned === undefined || pinned.receipt_path !== ref?.receipt_path || pinned.receipt_sha256 !== ref?.receipt_sha256) out.problems.push(`${nodeId}'s rebase of ${r.review_id} names revision ${ref?.revision} at ${short(ref?.receipt_sha256)}, which its chain does not pin`);
      }
      if (!(Number(r.to?.revision) > Number(r.from?.revision))) out.problems.push(`${nodeId}'s rebase of ${r.review_id} goes from revision ${r.from?.revision} to ${r.to?.revision}, not to a later one`);
      const from = gapsOf(r.from);
      const to = gapsOf(r.to);
      for (const c of Array.isArray(r.carry) ? r.carry : []) {
        const a = from?.find((g) => g?.criterion === c?.criterion);
        const b = to?.find((g) => g?.criterion === c?.criterion);
        if (!a || !b || typeof a.reproduction !== 'string' || typeof b.reproduction !== 'string' || sha256Hex(a.reproduction) !== c.reproduction_sha256 || sha256Hex(b.reproduction) !== c.reproduction_sha256) {
          out.problems.push(`${nodeId}'s rebase of ${r.review_id} carries ${c?.criterion} at ${short(c?.reproduction_sha256)}, which revision ${r.from?.revision} and revision ${r.to?.revision} do not both hold exactly so`);
        }
      }
    }
  }
  out.problems = [...new Set(out.problems)];
  return out;
}

/** Why the run's review revisions cannot be trusted: what reviewRevisions found, each named so. */
export function reviewRevisionTrustProblems(record) {
  return (record?.review_revisions?.problems ?? []).map((p) => `review revisions: ${p}`);
}
