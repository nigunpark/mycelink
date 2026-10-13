/**
 * Criterion coverage at exact heads: whether every completed criterion's proof
 * still stands in the product.
 *
 * CSET-201 final (normal arm, trusted): the cli's AC-3 re-proof was never in
 * the product, and the cli's next generation, reopened by the planner's
 * rework, settled AC-3 citing a RED of tests its own head never held. R003
 * found AC-3's tests absent from the integrated head and the lineage judged
 * its gap a duplicate of R001's: a fix whose proof vanished was treated as the
 * same unresolved gap repeated. Nothing compared what an earlier PASS rested
 * on with what the reviewed head held.
 *
 * A completion stands at a head when its record still hashes as written, the
 * work that completed it is in the head's history, its production change is
 * still there (or changed by its own node's later generation — a change by
 * someone else is soft: its test decides), and every test its standing chain
 * proves it by — the root RED's test and each re-proof's tests since — is
 * still declared there. A later RED-proved completion of the same criterion
 * supersedes what came before it.
 *
 * Settle uses it before integrating (engine/orchestrator.ts): an integration
 * must never lose a sibling's standing proof that the integration head held.
 * The review uses it at its exact heads: a completed criterion whose proof is
 * lost is a regression — restored, never ignored as a duplicate, never spent
 * from its criterion's budget — and a PASS closes nothing while one is lost.
 * Each review's receipt pins the manifest (coverageManifest) it was settled
 * with.
 */
import { createHash } from 'node:crypto';
import type { CompletionBasis, CriterionCompletion } from '../model/types.js';
import { runGit } from '../git/git.js';
import { stableStringify } from '../graph/validate.js';
import { revalidateCompletion, rootCompletion } from './criterion-ledger.js';
import { declaredAt } from './criteria.js';
import { testTitle } from '../evidence/test-identity.js';
import type { TddPolicy } from './tdd-history.js';

export { declaredAt };

export const COVERAGE_SCHEMA = 'mycelink-coverage/1' as const;

export type CoverageCode = 'COMPLETION_TAMPERED' | 'COMPLETION_BASE_STALE' | 'COMPLETION_TEST_CHANGED' | 'COMPLETION_FIX_DELETED' | 'COMPLETION_TEST_MISSING' | 'COMPLETION_REPROOF_MISSING' | 'COMPLETION_TEST_FAILED';

/** A test a completion stands on. */
export interface ProofTest {
  path: string;
  name: string;
  /** The record that proves the criterion by it, and how. */
  record_id: string;
  kind: 'proof' | 'reproof';
}

/** The latest record of each criterion in a node's ledger: what stands. */
export function standingRecords(ledger: readonly CriterionCompletion[]): CriterionCompletion[] {
  const out = new Map<string, CriterionCompletion>();
  for (const r of ledger) out.set(r.criterion, r);
  return [...out.values()];
}

/**
 * The records a standing completion rests on: from it back through its parents while each is carried, re-proved or
 * restored, to the first that ran its own RED (or its compatibility or declaration proof), inclusive.
 */
export function standingChain(ledger: readonly CriterionCompletion[], record: CriterionCompletion): CriterionCompletion[] {
  const chain: CriterionCompletion[] = [record];
  const own: readonly CompletionBasis[] = ['red', 'compatibility', 'declaration'];
  let at = record;
  for (let hops = 0; hops < 64 && !own.includes(at.basis) && at.parent !== null; hops++) {
    const parent = ledger.find((r) => r.record_id === at.parent);
    if (parent === undefined || parent.criterion !== record.criterion) break;
    chain.push(parent);
    at = parent;
  }
  return chain;
}

/** Every test a standing completion is proved by, once each. */
export function proofTests(ledger: readonly CriterionCompletion[], record: CriterionCompletion): ProofTest[] {
  const out: ProofTest[] = [];
  const add = (t: Omit<ProofTest, 'kind'>, kind: ProofTest['kind']): void => {
    if (!out.some((x) => x.path === t.path && x.name === t.name)) out.push({ ...t, kind });
  };
  for (const r of standingChain(ledger, record)) {
    const root = rootCompletion(ledger, r);
    const proof = r.proof.test ?? root.proof.test;
    if (proof !== null) add({ path: proof.path, name: proof.name, record_id: r.record_id }, 'proof');
    for (const t of r.reproof?.tests ?? []) add({ path: t.path, name: t.full_name, record_id: r.record_id }, 'reproof');
  }
  return out;
}

export interface CompletionStanding {
  holds: boolean;
  code: CoverageCode | null;
  detail: string | null;
  tests: (ProofTest & { declared: boolean | null })[];
}

/** Whether a standing completion holds at `head`: its record, its work, its production change and every test it is proved by. */
export function completionStanding(args: { controlRoot: string; featureId: string; record: CriterionCompletion; ledger: readonly CriterionCompletion[]; repoPath: string; head: string; policy: TddPolicy; cache?: Map<string, string | null> }): CompletionStanding {
  const { record, ledger, repoPath, head } = args;
  const cache = args.cache ?? new Map<string, string | null>();
  const tests = proofTests(ledger, record).map((t) => ({ ...t, declared: declaredAt(repoPath, head, t.path, t.name, cache) }));
  const verdict = revalidateCompletion({ controlRoot: args.controlRoot, featureId: args.featureId, record, ledger, repoPath, head, policy: args.policy });
  if (!verdict.ok && verdict.hard) return { holds: false, code: verdict.code as CoverageCode, detail: verdict.detail, tests };
  const missing = tests.find((t) => t.declared === false);
  if (missing !== undefined) {
    const code: CoverageCode = missing.kind === 'reproof' ? 'COMPLETION_REPROOF_MISSING' : 'COMPLETION_TEST_MISSING';
    return { holds: false, code, detail: `${code}: ${record.criterion} (${record.record_id}): ${missing.path} declares no test ${JSON.stringify(testTitle(missing.path, missing.name))} at ${head.slice(0, 12)}: the ${missing.kind === 'reproof' ? 're-proof' : 'proof'} it stands on is not in the head`, tests };
  }
  return { holds: true, code: null, detail: null, tests };
}

/** One node's standing completion of a criterion, at the heads of a manifest. */
export interface CompletionCoverage {
  node_id: string;
  criterion: string;
  record_id: string;
  record_sha256: string;
  basis: CompletionBasis;
  holds: boolean;
  code: CoverageCode | null;
  detail: string | null;
  tests: { path: string; name: string; kind: ProofTest['kind']; record_id: string; declared: boolean | null }[];
}

export interface CoverageManifest {
  schema: typeof COVERAGE_SCHEMA;
  repositories: { name: string; head_sha: string }[];
  criteria: { criterion: string; holds: boolean; completions: CompletionCoverage[] }[];
  /** Every completion holds. */
  holds: boolean;
  sha256: string;
}

/** The manifest of every standing completion of every node at the given heads (a node outside them is not judged). */
export function coverageManifest(args: {
  controlRoot: string;
  featureId: string;
  criteria: readonly string[];
  nodes: readonly { node_id: string; repository: string; ledger: readonly CriterionCompletion[]; repoPath: string; policy: TddPolicy }[];
  heads: readonly { name: string; head_sha: string }[];
}): CoverageManifest {
  const caches = new Map<string, Map<string, string | null>>();
  const all: CompletionCoverage[] = [];
  for (const n of args.nodes) {
    const head = args.heads.find((h) => h.name === n.repository)?.head_sha;
    if (head === undefined) continue;
    const cache = caches.get(n.repository) ?? new Map<string, string | null>();
    caches.set(n.repository, cache);
    for (const record of standingRecords(n.ledger)) {
      const s = completionStanding({ controlRoot: args.controlRoot, featureId: args.featureId, record, ledger: n.ledger, repoPath: n.repoPath, head, policy: n.policy, cache });
      all.push({ node_id: n.node_id, criterion: record.criterion, record_id: record.record_id, record_sha256: record.sha256, basis: record.basis, holds: s.holds, code: s.code, detail: s.detail === null ? null : s.detail.slice(0, 600), tests: s.tests.map((t) => ({ path: t.path, name: t.name, kind: t.kind, record_id: t.record_id, declared: t.declared })) });
    }
  }
  const criteria = [...new Set([...args.criteria, ...all.map((c) => c.criterion)])].map((criterion) => {
    const completions = all.filter((c) => c.criterion === criterion);
    return { criterion, holds: completions.every((c) => c.holds), completions };
  });
  const body = { schema: COVERAGE_SCHEMA, repositories: args.heads.map((h) => ({ name: h.name, head_sha: h.head_sha })), criteria, holds: criteria.every((c) => c.holds) };
  return { ...body, sha256: createHash('sha256').update(stableStringify(body)).digest('hex') };
}

/** The completions a manifest finds lost, by criterion. */
export function lostCompletions(manifest: CoverageManifest): CompletionCoverage[] {
  return manifest.criteria.flatMap((c) => c.completions.filter((x) => !x.holds));
}
