/** Read-only eligibility check for carrying settled producers into a new control.
 * This is NOT an import writer or permission to mark a new node DONE: evidence
 * and authority must be transferred and bound separately before dispatch.
 */
import { createHash } from 'node:crypto';
import type { FeatureState_, PortfolioGraph, Problem } from '../model/types.js';
import { checkEvidenceOutput } from '../evidence/paths.js';
import { isAncestor, runGit } from '../git/git.js';
import { hashGraph } from '../graph/validate.js';
import { validateAgainstSchema } from '../schema/registry.js';
import { completionStanding } from './criterion-coverage.js';
import { ledgerProblems, latestCompletion } from './criterion-ledger.js';
import type { TddPolicy } from './tdd-history.js';

export interface CompletionImportInput {
  sourceControlRoot: string;
  /** The exact independently pinned source STATE.json document bytes. */
  sourceStateBytes: Buffer;
  expectedSourceSha256: string;
  sourceGraph: PortfolioGraph;
  targetGraph: PortfolioGraph;
  targetState: FeatureState_;
  repositoryPath: string;
  /** The new repository's checked-out authoritative head. */
  head: string;
  policy: TddPolicy;
  completedNodes: readonly string[];
}

export function validateCompletionImport(input: CompletionImportInput): { ok: boolean; problems: Problem[] } {
  const problems: Problem[] = [];
  const fail = (code: string, detail: string): void => { problems.push({ code, path: '/continuation_import', detail }); };
  const actual = createHash('sha256').update(input.sourceStateBytes).digest('hex');
  if (!/^[0-9a-f]{64}$/.test(input.expectedSourceSha256) || actual !== input.expectedSourceSha256) {
    fail('IMPORT_SOURCE_HASH', 'Source state bytes do not match the independently pinned SHA-256.');
    return { ok: false, problems };
  }
  let doc: { revision: number; data: FeatureState_ };
  try {
    doc = JSON.parse(input.sourceStateBytes.toString('utf8')) as typeof doc;
  } catch {
    fail('IMPORT_SOURCE_STATE', 'Source state is not JSON.');
    return { ok: false, problems };
  }
  if (typeof doc.revision !== 'number' || !Number.isSafeInteger(doc.revision) || doc.revision < 0 || validateAgainstSchema('state', doc.data).length > 0) {
    fail('IMPORT_SOURCE_STATE', 'Source STATE.json is not a valid versioned state.');
    return { ok: false, problems };
  }
  const { data } = doc;
  const sourceHash = hashGraph(input.sourceGraph);
  const targetHash = hashGraph(input.targetGraph);
  if (sourceHash !== targetHash || data.graph_hash !== sourceHash || input.targetState.graph_hash !== targetHash || data.feature_id !== input.sourceGraph.feature_id || input.targetState.feature_id !== input.targetGraph.feature_id || data.acceptance?.sha256 === undefined || data.acceptance.sha256 !== input.targetState.acceptance?.sha256) {
    fail('IMPORT_GRAPH_MISMATCH', 'The source and new control must bind the exact same graph, feature and approved acceptance manifest.');
    return { ok: false, problems };
  }
  const checkout = runGit(input.repositoryPath, ['rev-parse', 'HEAD'], { allowFail: true });
  if (checkout.exitCode !== 0 || checkout.stdout.trim() !== input.head) {
    fail('IMPORT_HEAD_MISMATCH', 'The declared authoritative head is not the target repository checkout HEAD.');
    return { ok: false, problems };
  }
  const seen = new Set<string>();
  for (const id of input.completedNodes) {
    if (seen.has(id)) { fail('IMPORT_DUPLICATE', `Producer ${id} was requested twice.`); continue; }
    seen.add(id);
    const node = input.sourceGraph.nodes.find((n) => n.id === id);
    const rt = data.nodes[id];
    const target = input.targetState.nodes[id];
    if (node === undefined || node.repository === null || ['candidate-build', 'e2e-scenario', 'verification'].includes(node.node_type) || rt?.state !== 'DONE') {
      fail('IMPORT_PRODUCER_NOT_DONE', `${id} is not a DONE product producer of the pinned source graph.`);
      continue;
    }
    if (target === undefined || target.state !== 'PLANNED' || target.attempts !== 0 || target.claim !== null || (target.criteria?.length ?? 0) > 0 || (target.criterion_ledger?.length ?? 0) > 0) {
      fail('IMPORT_REPLAY', `${id} has already begun or has completion state in the target control.`);
      continue;
    }
    for (const dependency of node.depends_on ?? []) {
      if (!seen.has(dependency) && !input.completedNodes.includes(dependency) && input.targetState.nodes[dependency]?.state !== 'DONE') {
        fail('IMPORT_DEPENDENCY_MISSING', `${id} depends on ${dependency}, which is neither imported nor completed in the new control.`);
      }
    }
    if (data.orchestration?.leases?.some((lease) => lease.node_id === id && lease.status === 'active')) {
      fail('IMPORT_SOURCE_ACTIVE', `${id} has an active source dispatch; only closed, settled work can be assessed.`);
    }
    if (rt.integrated_sha === null || !isAncestor(input.repositoryPath, rt.integrated_sha, input.head)) {
      fail('IMPORT_ANCESTRY', `${id}'s integrated work is not an ancestor of the new authoritative head.`);
      continue;
    }
    if (rt.tdd_history?.ok !== true || rt.tdd_history.head_sha !== rt.integrated_sha || checkEvidenceOutput(input.sourceControlRoot, data.feature_id, rt.tdd_history) !== null) {
      fail('IMPORT_HISTORY_INVALID', `${id} has no intact test-first history at its integrated head.`);
    }
    for (const kind of node.required_evidence ?? []) {
      const evidence = rt.evidence[kind];
      if (evidence === undefined || checkEvidenceOutput(input.sourceControlRoot, data.feature_id, evidence) !== null) fail('IMPORT_GATE_INVALID', `${id}'s ${kind} gate is missing or changed.`);
    }
    const ledger = rt.criterion_ledger ?? [];
    for (const detail of ledgerProblems(input.sourceControlRoot, data.feature_id, ledger)) fail('IMPORT_LEDGER_INVALID', `${id}: ${detail}`);
    const assigned = node.acceptance_criteria ?? [];
    for (const ac of assigned) {
      const accepted = rt.criteria?.filter((c) => c.criterion === ac) ?? [];
      const record = latestCompletion(ledger, ac);
      if (accepted.length !== 1 || record === null || record.migrated === true || record.node_id !== id || record.criterion !== ac || record.repo.repository !== node.repository || record.repo.integrated_sha !== rt.integrated_sha || record.proof.output_sha256 !== accepted[0]?.output_sha256) {
        fail('IMPORT_CRITERION_MISSING', `${id} does not have a matching settled ${ac} completion and accepted proof.`);
        continue;
      }
      const standing = completionStanding({ controlRoot: input.sourceControlRoot, featureId: data.feature_id, record, ledger, repoPath: input.repositoryPath, head: input.head, policy: input.policy });
      if (!standing.holds || standing.tests.some((t) => t.declared !== true)) fail('IMPORT_PROOF_INVALID', `${id} ${ac} does not stand at the new head: ${standing.detail ?? 'test declaration unknown'}.`);
    }
    for (const c of rt.criteria ?? []) if (!assigned.includes(c.criterion)) fail('IMPORT_CRITERION_MISMATCH', `${id} settled unassigned ${c.criterion}.`);
    for (const r of ledger) if (!assigned.includes(r.criterion) || r.node_id !== id) fail('IMPORT_LEDGER_INVALID', `${id} contains a record for another node or criterion.`);
  }
  return { ok: problems.length === 0, problems };
}
