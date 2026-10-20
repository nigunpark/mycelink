/** Pinned completion preflight and locked, evidence-first import into a new control. */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { FeatureState_, PortfolioGraph, Problem } from '../model/types.js';
import { checkEvidenceOutput, observeEvidenceOutput } from '../evidence/paths.js';
import { branchExists, isAncestor, resolveRef, runGit } from '../git/git.js';
import { integrationBranchName } from '../git/worktree.js';
import { hashGraph } from '../graph/validate.js';
import { validateAgainstSchema } from '../schema/registry.js';
import { createExclusive } from '../state/atomic-json.js';
import { loadState, mutateState } from '../state/feature-state.js';
import { isInsideReal, samePath } from '../security/paths.js';
import { featurePaths } from '../workspace/paths.js';
import { loadGraph, loadWorkspace, repositoryPath, validateFeatureGraph } from '../workspace/workspace.js';
import { graphAcceptanceProblems, loadAcceptanceManifest, manifestProblems } from './acceptance.js';
import { completionStanding } from './criterion-coverage.js';
import { ledgerProblems, latestCompletion } from './criterion-ledger.js';
import { withFeatureLock } from './feature-lock.js';
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
    if (target === undefined || target.state !== 'PLANNED' || target.attempts !== 0 || target.claim !== null ||
      target.integrated_sha !== null || Object.keys(target.evidence).length > 0 ||
      (target.criteria?.length ?? 0) > 0 || (target.criterion_ledger?.length ?? 0) > 0) {
      fail('IMPORT_REPLAY', `${id} has already begun or has completion state in the target control.`);
      continue;
    }
    for (const dependency of node.depends_on ?? []) {
      if (!seen.has(dependency) && !input.completedNodes.includes(dependency) && input.targetState.nodes[dependency]?.state !== 'DONE') {
        fail('IMPORT_DEPENDENCY_MISSING', `${id} depends on ${dependency}, which is neither imported nor completed in the new control.`);
      }
    }
    if (rt.claim !== null || data.orchestration?.leases?.some((lease) => lease.node_id === id && lease.status === 'active')) {
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

export interface DurableCompletionImportInput extends CompletionImportInput {
  targetControlRoot: string;
}

const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const problem = (code: string, detail: string): Problem => ({ code, path: '/continuation_import', detail });

/** Readback gate for imported DONE nodes; called before any subsequent claim. */
export function completionImportProblems(controlRoot: string, state: FeatureState_): Problem[] {
  const problems: Problem[] = [];
  for (const receipt of state.completion_imports ?? []) {
    const rt = state.nodes[receipt.node_id];
    const sourcePath = `features/${state.feature_id}/imports/${receipt.source_state_sha256}/STATE.json`;
    if (rt?.state !== 'DONE' || rt.integrated_sha === null ||
      state.integration_heads?.[receipt.repository] !== receipt.integration_sha ||
      !receipt.files.some((f) => f.path === sourcePath && f.sha256 === receipt.source_state_sha256)) {
      problems.push(problem('IMPORT_PROVENANCE_INVALID', `${receipt.node_id} lacks its imported DONE head or pinned source document.`));
      continue;
    }
    const copy = observeEvidenceOutput(controlRoot, state.feature_id, sourcePath);
    if (copy.kind !== 'file' || copy.sha256 !== receipt.source_state_sha256) {
      problems.push(problem('IMPORT_PROVENANCE_INVALID', `${receipt.node_id}'s pinned source document is missing or changed.`));
      continue;
    }
    try {
      const source = (JSON.parse(readFileSync(copy.path, 'utf8')) as { data: FeatureState_ }).data;
      const original = source.nodes[receipt.node_id];
      if (source.graph_hash !== receipt.source_graph_sha256 || original?.integrated_sha !== rt.integrated_sha ||
        !isAncestor(repositoryPath(loadWorkspace(controlRoot), receipt.repository), original.integrated_sha, receipt.integration_sha) ||
        JSON.stringify(original.criterion_ledger) !== JSON.stringify(rt.criterion_ledger) ||
        JSON.stringify(original.criteria) !== JSON.stringify(rt.criteria) ||
        JSON.stringify(original.tdd_history) !== JSON.stringify(rt.tdd_history) ||
        JSON.stringify(original.evidence) !== JSON.stringify(rt.evidence)) {
        problems.push(problem('IMPORT_PROVENANCE_INVALID', `${receipt.node_id} does not match the pinned source completion at the imported integration head.`));
      }
    } catch {
      problems.push(problem('IMPORT_PROVENANCE_INVALID', `${receipt.node_id}'s source completion cannot be read or verified.`));
    }
    for (const file of receipt.files) {
      if (!file.path.startsWith(`features/${state.feature_id}/evidence/${receipt.node_id}/`) &&
        file.path !== sourcePath) {
        problems.push(problem('IMPORT_PROVENANCE_INVALID', `${receipt.node_id} names evidence outside its own inventory.`));
        continue;
      }
      const invalid = checkEvidenceOutput(controlRoot, state.feature_id, { output_path: file.path, output_sha256: file.sha256 }, { overlay: false });
      if (invalid !== null) problems.push(problem('IMPORT_PROVENANCE_INVALID', `${receipt.node_id}: ${invalid}`));
    }
  }
  return problems;
}

/** No implicit branch creation, graph rewrite, worker authority or CLI dispatch. */
export function importCompletions(input: DurableCompletionImportInput): { ok: boolean; problems: Problem[] } {
  const fail = (code: string, detail: string): { ok: false; problems: Problem[] } => ({ ok: false, problems: [problem(code, detail)] });
  const featureId = input.targetGraph.feature_id;
  try {
    if (resolve(input.sourceControlRoot) === resolve(input.targetControlRoot)) return fail('IMPORT_CONTROL_ALIAS', 'The target must be a separate control.');
    const sourceDir = featurePaths(input.sourceControlRoot, featureId).featureDir;
    const targetDir = featurePaths(input.targetControlRoot, featureId).featureDir;
    return withFeatureLock(targetDir, 'completion import', () => {
      const sourceBytes = readFileSync(join(sourceDir, 'STATE.json'));
      if (digest(sourceBytes) !== input.expectedSourceSha256 || !sourceBytes.equals(input.sourceStateBytes)) return fail('IMPORT_SOURCE_HASH', 'Source STATE.json is not the pinned document.');
      const sourceGraph = loadGraph(input.sourceControlRoot, featureId);
      const targetGraph = loadGraph(input.targetControlRoot, featureId);
      if (hashGraph(sourceGraph) !== hashGraph(input.sourceGraph) || hashGraph(targetGraph) !== hashGraph(input.targetGraph)) return fail('IMPORT_GRAPH_MISMATCH', 'On-disk graphs differ from the pinned inputs.');
      const sourceManifest = loadAcceptanceManifest(input.sourceControlRoot, featureId);
      const targetManifest = loadAcceptanceManifest(input.targetControlRoot, featureId);
      if (sourceManifest === null || targetManifest === null || sourceManifest.sha256 !== targetManifest.sha256 ||
        sourceManifest.sha256 !== input.targetState.acceptance?.sha256 ||
        ![input.sourceControlRoot, input.targetControlRoot].every((root) => {
          const prd = featurePaths(root, featureId).prd;
          return existsSync(prd) && manifestProblems(sourceManifest.manifest, { featureId, source: readFileSync(prd) }).length === 0;
        }) ||
        graphAcceptanceProblems(sourceGraph, sourceManifest.manifest).length !== 0 ||
        graphAcceptanceProblems(targetGraph, targetManifest.manifest).length !== 0) return fail('IMPORT_ACCEPTANCE', 'Approved acceptance differs from the graphs or pinned target.');
      const targetDoc = loadState(targetDir);
      if (targetDoc === null || JSON.stringify(targetDoc.data) !== JSON.stringify(input.targetState) || targetDoc.data.feature_state !== 'GRAPH_VALIDATED' ||
        (targetDoc.data.pending_integrations && Object.keys(targetDoc.data.pending_integrations).length > 0)) return fail('IMPORT_TARGET_CHANGED', 'Target is not the pinned fresh feature state.');
      const sourceWs = loadWorkspace(input.sourceControlRoot);
      const targetWs = loadWorkspace(input.targetControlRoot);
      const graphValidation = validateFeatureGraph(input.targetControlRoot, featureId);
      if (!graphValidation.ok) return { ok: false, problems: graphValidation.problems };
      const sourceState = (JSON.parse(sourceBytes.toString('utf8')) as { data: FeatureState_ }).data;
      for (const id of input.completedNodes) {
        const node = sourceGraph.nodes.find((n) => n.id === id);
        if (node?.repository === null || node?.repository === undefined) return fail('IMPORT_REPOSITORY', `${id} has no registered producer repository.`);
        const sourceRepo = repositoryPath(sourceWs, node.repository);
        const targetRepo = repositoryPath(targetWs, node.repository);
        const branch = integrationBranchName(featureId);
        if (!samePath(targetRepo, input.repositoryPath) || !branchExists(sourceRepo, branch) || !branchExists(targetRepo, branch) ||
          resolveRef(sourceRepo, branch) !== sourceState.integration_heads?.[node.repository] ||
          resolveRef(targetRepo, branch) !== input.head ||
          (targetDoc.data.integration_heads?.[node.repository] !== undefined && targetDoc.data.integration_heads[node.repository] !== input.head)) {
          return fail('IMPORT_INTEGRATION_REF', `${id} is not bound to both registered feature integration refs at recorded heads.`);
        }
      }
      const eligible = validateCompletionImport({ ...input, sourceGraph, targetGraph, targetState: targetDoc.data });
      if (!eligible.ok) return eligible;

      // Inventory entire node evidence trees, not only the pointers known to
      // today's state schema. A linked or changed file cannot become evidence.
      const files: { path: string; sha256: string; bytes: Buffer }[] = [];
      for (const id of input.completedNodes) {
        const walk = (rel: string): void => {
          const dir = join(input.sourceControlRoot, ...rel.split('/'));
          if (!lstatSync(dir).isDirectory()) throw new Error(`IMPORT_UNSAFE_EVIDENCE: ${rel}`);
          for (const name of readdirSync(dir).sort()) {
            const child = `${rel}/${name}`;
            const stat = lstatSync(join(input.sourceControlRoot, ...child.split('/')));
            if (stat.isDirectory()) walk(child);
            else {
              const observed = observeEvidenceOutput(input.sourceControlRoot, featureId, child);
              if (!stat.isFile() || observed.kind !== 'file') throw new Error(`IMPORT_UNSAFE_EVIDENCE: ${child}`);
              const bytes = readFileSync(observed.path);
              if (digest(bytes) !== observed.sha256) throw new Error(`IMPORT_SOURCE_CHANGED: ${child}`);
              files.push({ path: child, sha256: observed.sha256, bytes });
            }
          }
        };
        walk(`features/${featureId}/evidence/${id}`);
      }
      const sourceCopy = `features/${featureId}/imports/${input.expectedSourceSha256}/STATE.json`;
      files.push({ path: sourceCopy, sha256: input.expectedSourceSha256, bytes: sourceBytes });
      // No overwrite or implicit partial-import repair, even of identical bytes.
      if (files.some((f) => {
        const dest = join(input.targetControlRoot, ...f.path.split('/'));
        return !isInsideReal(targetDir, dest) || existsSync(dest);
      })) return fail('IMPORT_COPY_CONFLICT', 'A destination evidence file already exists or escapes the target feature.');
      const created: string[] = [];
      let committed = false;
      try {
        for (const f of files) {
          const dest = join(input.targetControlRoot, ...f.path.split('/'));
          mkdirSync(join(dest, '..'), { recursive: true });
          if (!isInsideReal(targetDir, dest)) throw new Error(`IMPORT_UNSAFE_TARGET: ${f.path}`);
          if (createExclusive(dest, f.bytes) !== 'created') throw new Error(`IMPORT_COPY_CONFLICT: ${f.path}`);
          created.push(dest);
          if (checkEvidenceOutput(input.targetControlRoot, featureId, { output_path: f.path, output_sha256: f.sha256 }, { overlay: false }) !== null) throw new Error(`IMPORT_COPY_INVALID: ${f.path}`);
        }
        const copied = validateCompletionImport({ ...input, sourceControlRoot: input.targetControlRoot, sourceGraph, targetGraph, targetState: targetDoc.data });
        if (!copied.ok) throw new Error(`IMPORT_COPIED_PROOF_INVALID: ${copied.problems.map((p) => p.code).join(', ')}`);
        mutateState(targetDir, (state) => {
          if (JSON.stringify(state) !== JSON.stringify(targetDoc.data)) throw new Error('IMPORT_TARGET_CHANGED: state changed while copying');
          for (const id of input.completedNodes) {
            const node = sourceGraph.nodes.find((n) => n.id === id)!;
            const sourceRt = sourceState.nodes[id]!;
            const rt = state.nodes[id]!;
            rt.state = 'DONE';
            rt.integrated_sha = sourceRt.integrated_sha;
            rt.branch_base_sha = sourceRt.branch_base_sha;
            rt.criteria = structuredClone(sourceRt.criteria);
            rt.criterion_ledger = structuredClone(sourceRt.criterion_ledger);
            rt.tdd_history = structuredClone(sourceRt.tdd_history);
            rt.evidence = structuredClone(sourceRt.evidence);
            state.integration_heads ??= {};
            state.integration_heads[node.repository!] = input.head;
            state.completion_imports ??= [];
            state.completion_imports.push({ node_id: id, source_state_sha256: input.expectedSourceSha256, source_graph_sha256: hashGraph(sourceGraph), repository: node.repository!, integration_sha: input.head, files: files.filter((f) => f.path.startsWith(`features/${featureId}/evidence/${id}/`) || f.path === sourceCopy).map(({ path, sha256 }) => ({ path, sha256 })) });
          }
          state.feature_state = 'RUNNING';
          return state;
        });
        committed = true;
        return { ok: true, problems: [] };
      } finally {
        if (!committed) for (const path of created) rmSync(path, { force: true });
      }
    });
  } catch (err) {
    return fail('IMPORT_REFUSED', err instanceof Error ? err.message : String(err));
  }
}
