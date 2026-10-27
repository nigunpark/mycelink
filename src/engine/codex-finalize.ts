import { loadState } from '../state/feature-state.js';
import { featurePaths } from '../workspace/paths.js';
import { loadGraph, loadWorkspace } from '../workspace/workspace.js';
import { reviewGateProblems } from './acceptance-review.js';
import { featureVerifyProblems } from './feature-verify.js';
import { loadCandidate, verifyCandidate } from '../git/candidate.js';
import { portfolioRefs, registeredRepositories } from './portfolio.js';
import { deliverFeature, type DeliveryResult } from './deliver.js';
import type { Orchestrator } from './orchestrator.js';

/** Controller-only, one-shot handoff from a settled review to the existing release engine. */
export async function finalizeCodexDelivery(controlRoot: string, featureId: string, orchestrator: Orchestrator): Promise<DeliveryResult> {
  const paths = featurePaths(controlRoot, featureId);
  const state = loadState(paths.featureDir)?.data;
  if (!state) throw new Error('CODEX_FINALIZE_NO_STATE');
  if (state.accepted_deliveries && Object.keys(state.accepted_deliveries).length > 0) {
    throw new Error('CODEX_FINALIZE_REPLAY: delivery already exists');
  }
  const review = reviewGateProblems(controlRoot, featureId);
  if (review.length > 0) throw new Error(`CODEX_FINALIZE_REVIEW_REQUIRED: ${review.join('; ')}`);
  const graph = loadGraph(controlRoot, featureId);
  const pending = graph.nodes.filter((node) => state.nodes[node.id]?.state !== 'DONE' && state.nodes[node.id]?.state !== 'EXCLUDED');
  let candidateId = state.current_candidate;
  if (candidateId) {
    // Process loss after candidate-build must resume the pinned artifact, never
    // dispatch a replacement or solicit another review of changed inputs.
    if (!state.acceptance_review?.required || !state.acceptance_review.reviews.some((review) => review.overall === 'PASS')) {
      throw new Error('CODEX_FINALIZE_REVIEW_REQUIRED: resumed candidate requires a prior PASS');
    }
    if (pending.length !== 0 || state.feature_state !== 'VERIFIED' ||
        !graph.nodes.some((node) => node.node_type === 'candidate-build' && state.nodes[node.id]?.state === 'DONE')) {
      throw new Error('CODEX_FINALIZE_NOT_VERIFIED: resumed candidate requires settled nodes, DONE candidate-build and VERIFIED feature');
    }
  } else {
    if (pending.length !== 1 || pending[0]?.node_type !== 'candidate-build' ||
      !['READY', 'PLANNED'].includes(state.nodes[pending[0].id]?.state ?? '')) {
      throw new Error(`CODEX_FINALIZE_NOT_READY: expected only an unclaimed candidate-build node, got ${pending.map((n) => `${n.id}:${state.nodes[n.id]?.state}`).join(', ')}`);
    }
    // The ordinary scheduler owns the candidate node, its claim, evidence and state transition.
    const dispatched = await orchestrator.dispatchNext();
    if (dispatched.status !== 'ALL_SETTLED' || dispatched.controller_reports.length !== 1 ||
      dispatched.controller_reports[0]?.node_id !== pending[0].id || dispatched.controller_reports[0]?.outcome !== 'DONE') {
      throw new Error(`CODEX_FINALIZE_CANDIDATE_FAILED: ${dispatched.status}: ${dispatched.detail}`);
    }
    candidateId = loadState(paths.featureDir)?.data.current_candidate ?? null;
  }
  if (!candidateId) throw new Error('CODEX_FINALIZE_CANDIDATE_MISSING');
  const candidate = loadCandidate(paths.featureDir, candidateId);
  const workspace = loadWorkspace(controlRoot);
  const expected = portfolioRefs(workspace, featureId, { trust: { graph, state: loadState(paths.featureDir)!.data } });
  const drift = verifyCandidate(candidate, { controlRepo: controlRoot, repositories: expected, requiredRepositories: registeredRepositories(workspace) });
  if (!drift.ok) throw new Error(`CODEX_FINALIZE_CANDIDATE_DRIFT: ${drift.problems.map((p) => p.code).join(', ')}`);
  const gate = featureVerifyProblems(controlRoot, featureId);
  if (gate.length > 0) throw new Error(`CODEX_FINALIZE_NOT_VERIFIED: ${gate.join('; ')}`);
  return deliverFeature(controlRoot, featureId, { candidateId });
}
