/**
 * Evidence-based feature verification: the checks behind `feature verify`,
 * shared with delivery so nothing is delivered that would not verify.
 */
import type { FeaturePaths } from '../workspace/paths.js';
import { featurePaths } from '../workspace/paths.js';
import { loadGraph, validateFeatureGraph } from '../workspace/workspace.js';
import { loadState } from '../state/feature-state.js';
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
  }
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
