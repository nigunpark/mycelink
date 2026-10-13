/**
 * Evidence-based feature verification: the checks behind `feature verify`,
 * shared with delivery so nothing is delivered that would not verify.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FeaturePaths } from '../workspace/paths.js';
import { featurePaths } from '../workspace/paths.js';
import { loadGraph, loadWorkspace, repositoryPath, validateFeatureGraph } from '../workspace/workspace.js';
import { isAncestor } from '../git/git.js';
import { settledUncoveredCriteria } from './criteria.js';
import { ledgerProblems } from './criterion-ledger.js';
import { reviewGateProblems } from './acceptance-review.js';
import { reviewRevisionProblems } from './review-revision.js';
import { citedCapsuleProblems } from './reproduction-capsule.js';
import { evidenceIntegrityProblems, repairRequired, repairRequiredDetail } from './evidence-integrity.js';
import { loadState } from '../state/feature-state.js';
import { provedWithoutRed } from '../state/transition.js';
import { checkEvidenceOutput } from '../evidence/paths.js';
import { leaseStatus } from '../resources/leases.js';
import { liveSessions } from '../sessions/registry.js';

/** Every reason the feature is not verifiably complete; empty when it is. */
export function featureVerifyProblems(controlRoot: string, featureId: string): string[] {
  const paths: FeaturePaths = featurePaths(controlRoot, featureId);
  const validation = validateFeatureGraph(controlRoot, featureId);
  const doc = loadState(paths.featureDir);
  const problems: string[] = validation.problems.map((p) => `${p.code}: ${p.detail}`);
  if (doc === null) {
    problems.push('NO_STATE: STATE.json is missing');
    return problems;
  }
  const state = doc.data;
  if (typeof state.superseded_by === 'string') {
    // History, not a delivery: whatever else holds, it is not complete.
    problems.push(`SUPERSEDED: by ${state.superseded_by}${state.superseded_reason ? ` (${state.superseded_reason})` : ''}`);
  }
  if (state.graph_hash !== validation.graphHash) {
    problems.push(
      `GRAPH_DRIFT: STATE.json was created for graph ${state.graph_hash.slice(0, 12)} but the graph now hashes to ${validation.graphHash.slice(0, 12)}`,
    );
  }
  const graph = loadGraph(controlRoot, featureId);
  for (const [id, runtime] of Object.entries(state.nodes)) {
    if (runtime.state !== 'DONE' && runtime.state !== 'EXCLUDED') {
      problems.push(`NODE_NOT_DONE: ${id} is ${runtime.state}`);
    }
    if (runtime.state !== 'DONE') continue;
    // A DONE node's required evidence must still be on disk, unchanged.
    const node = graph.nodes.find((n) => n.id === id);
    for (const kind of node?.required_evidence ?? []) {
      const record = runtime.evidence[kind];
      // A compatibility-only rework's generation proves itself without a RED (state/transition.ts).
      if (!record && kind === 'red' && provedWithoutRed(runtime)) continue;
      if (!record) {
        problems.push(`MISSING_EVIDENCE: ${id} ${kind}`);
        continue;
      }
      const problem = checkEvidenceOutput(controlRoot, featureId, record);
      if (problem !== null) {
        const [code, ...rest] = problem.split(': ');
        problems.push(`${code}: ${id} ${kind} ${rest.join(': ')}`);
      }
    }
    // Its completion records (engine/criterion-ledger.ts): each hashing as written, its archived proof intact, its lineage known.
    for (const p of ledgerProblems(controlRoot, featureId, runtime.criterion_ledger ?? [])) problems.push(`COMPLETION_LEDGER_INVALID: ${id} ${p}`);
    // The history settle judged test-first is evidence too: it must still be there, unchanged, and have passed.
    const history = runtime.tdd_history;
    if (history) {
      if (!history.ok) problems.push(`TDD_HISTORY_INVALID: ${id} ${history.code ?? 'refused'} at ${history.head_sha.slice(0, 12)}`);
      const problem = checkEvidenceOutput(controlRoot, featureId, history);
      if (problem !== null) {
        const [code, ...rest] = problem.split(': ');
        problems.push(`${code}: ${id} tdd-history ${rest.join(': ')}`);
      }
    }
  }
  // A deferred regression (engine/regression-deferral.ts) is discharged only when each dependent it
  // passed to is DONE, its own full-suite regression run on the producer's integrated work.
  let workspace: ReturnType<typeof loadWorkspace> | null = null;
  try {
    workspace = loadWorkspace(controlRoot);
  } catch {
    workspace = null;
  }
  for (const [id, runtime] of Object.entries(state.nodes)) {
    if (runtime.state !== 'DONE') continue;
    const node = graph.nodes.find((n) => n.id === id);
    for (const target of runtime.evidence.regression?.regression_deferred?.to ?? []) {
      const t = state.nodes[target];
      if (t === undefined || t.state !== 'DONE') {
        problems.push(`REGRESSION_DEFERRED: ${id} deferred its regression to ${target}, which is ${t?.state ?? 'not a node of the feature'}; the full suite must pass where it re-verifies`);
        continue;
      }
      const ran = t.evidence.regression?.commit_sha ?? null;
      if (workspace === null || node?.repository == null || runtime.integrated_sha === null || ran === null) continue;
      if (!isAncestor(repositoryPath(workspace, node.repository), runtime.integrated_sha, ran)) {
        problems.push(`REGRESSION_DEFERRED: ${target}'s regression ran at ${ran.slice(0, 12)}, which does not hold ${id}'s integrated work ${runtime.integrated_sha.slice(0, 12)}`);
      }
    }
  }
  // Every criterion of the feature evidenced by a DONE node (engine/criteria.ts), as its kind requires: delivery
  // refuses otherwise. Named as soon as no open node can still evidence it.
  for (const ac of settledUncoveredCriteria(graph, state.nodes)) problems.push(`UNCOVERED_ACCEPTANCE_CRITERION: ${ac.id} (${ac.kind}) has no criterion evidence on a DONE node`);
  // An acceptance review PASS, its receipt untampered, bound to exactly the heads, graph and criteria the feature has now.
  problems.push(...reviewGateProblems(controlRoot, featureId));
  // Each review's revision chain, every rebase record, every live order's binding (engine/review-revision.ts).
  problems.push(...reviewRevisionProblems(controlRoot, state));
  // Every reproduction capsule a challenge or a promoted RED cites, as it was sealed (engine/reproduction-capsule.ts).
  problems.push(...citedCapsuleProblems(controlRoot, featureId, state));
  // Every other evidence artifact the delivered state stands on, each on its own and across records: results, the
  // histories completion records name, carried proofs, conflicts, swaps, repairs (engine/evidence-integrity.ts).
  problems.push(...evidenceIntegrityProblems(controlRoot, featureId, state));
  const marker = repairRequired(state);
  if (marker !== null) problems.push(repairRequiredDetail(featureId, marker));
  if (state.pending_decisions.length > 0) {
    problems.push(`PENDING_DECISIONS: ${state.pending_decisions.join(', ')}`);
  }
  for (const [resource, status] of Object.entries(leaseStatus(paths.featureDir))) {
    if (status.held > 0) problems.push(`LEAKED_LEASE: ${resource} held by ${status.holders.map((h) => h.node_id).join(', ')}`);
  }
  const live = liveSessions(paths.sessionsRegistry);
  if (live.length > 0) problems.push(`LIVE_SESSIONS: ${live.map((s) => s.session_id).join(', ')}`);
  return problems;
}

/**
 * Every reason the feature is not delivered: no current candidate, or no
 * accepted delivery of exactly it (the manifest STATE.json pins, still on
 * disk, unchanged, ACCEPTED). A run is complete only when these and
 * featureVerifyProblems are both empty.
 */
export function featureDeliveryProblems(controlRoot: string, featureId: string): string[] {
  const paths = featurePaths(controlRoot, featureId);
  const state = loadState(paths.featureDir)?.data;
  if (!state) return ['NO_STATE: STATE.json is missing'];
  const candidate = state.current_candidate;
  if (candidate === null) return ['NO_CANDIDATE: no current candidate; every node must be DONE and the candidate cut (dispatch runs the candidate build)'];
  const pinned = state.accepted_deliveries?.[candidate];
  const manifest = join(paths.featureDir, 'deliveries', `${candidate}.json`);
  if (pinned === undefined || !existsSync(manifest)) return [`NOT_DELIVERED: ${candidate} has no accepted delivery; run deliver`];
  const bytes = readFileSync(manifest);
  if (createHash('sha256').update(bytes).digest('hex') !== pinned) return [`NOT_DELIVERED: the delivery manifest of ${candidate} is not the accepted one STATE.json pins`];
  let status: unknown;
  try {
    status = (JSON.parse(bytes.toString('utf8')) as { status?: unknown }).status;
  } catch {
    status = null;
  }
  if (status !== 'ACCEPTED') return [`NOT_DELIVERED: the delivery of ${candidate} is ${String(status)}`];
  if (state.feature_state !== 'COMPLETED') return [`NOT_DELIVERED: the feature is ${state.feature_state}, not COMPLETED`];
  return [];
}
