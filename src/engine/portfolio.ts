/**
 * The repositories a feature's release candidate binds: every registered
 * repository, on the feature's integration branch, and only where the
 * controller itself left that branch.
 */
import type { CandidateRepoRef } from '../git/candidate.js';
import { branchExists, isAncestor, resolveRef, runGit } from '../git/git.js';
import { integrationBranchName } from '../git/worktree.js';
import type { FeatureState_, PortfolioGraph } from '../model/types.js';
import { repositoryPath, type Workspace } from '../workspace/workspace.js';

/** An integration branch is not where the controller left it. */
export class IntegrationBranchMovedError extends Error {
  readonly code = 'INTEGRATION_BRANCH_MOVED';
  readonly expected: string;
  constructor(repository: string, branch: string, head: string, expected: string) {
    super(
      `INTEGRATION_BRANCH_MOVED: ${repository} ${branch} is at ${head.slice(0, 12)}, but the controller left it at ${expected.slice(0, 12)}; ` +
        'something outside Mycelink moved it. Put it back (or delete it if nothing was integrated there) before continuing.',
    );
    this.name = 'IntegrationBranchMovedError';
    this.expected = expected;
  }
}

/** What the controller knows about a feature, to judge its integration branches. */
export interface IntegrationTrust {
  graph: PortfolioGraph;
  state: FeatureState_;
}

/**
 * The newest integration commit the controller recorded for `repository`:
 * any node's integrated_sha there, including work a rework replaced. Null
 * when nothing was integrated in it.
 */
export function recordedIntegrationHead(repoPath: string, repository: string, trust: IntegrationTrust): string | null {
  const shas: string[] = [];
  for (const node of trust.graph.nodes) {
    if (node.repository !== repository) continue;
    const rt = trust.state.nodes[node.id];
    if (rt?.integrated_sha) shas.push(rt.integrated_sha);
    for (const h of rt?.rework_history ?? []) if (h.integrated_sha) shas.push(h.integrated_sha);
  }
  let newest: string | null = null;
  for (const sha of shas) {
    if (newest === null || (sha !== newest && isAncestor(repoPath, newest, sha))) newest = sha;
  }
  return newest;
}

/**
 * Where the feature's integration branch in `repository` must be: the newest
 * recorded integration commit, or the base branch's tip when nothing was
 * integrated there.
 */
export function expectedIntegrationHead(workspace: Workspace, repository: string, trust: IntegrationTrust): string {
  const path = repositoryPath(workspace, repository);
  const decl = workspace.repositories.repositories.find((r) => r.name === repository);
  return (
    trust.state.integration_heads?.[repository] ??
    // A state written before integration heads were recorded.
    recordedIntegrationHead(path, repository, trust) ??
    resolveRef(path, `refs/heads/${decl?.base_branch ?? 'main'}`)
  );
}

/**
 * The integration branch's head when it exists and is exactly where the
 * controller left it; null when it does not exist. Throws when it moved.
 */
export function trustedIntegrationHead(workspace: Workspace, featureId: string, repository: string, trust: IntegrationTrust): string | null {
  const path = repositoryPath(workspace, repository);
  const branch = integrationBranchName(featureId);
  if (!branchExists(path, branch)) return null;
  const head = resolveRef(path, branch);
  const expected = expectedIntegrationHead(workspace, repository, trust);
  if (head !== expected) throw new IntegrationBranchMovedError(repository, branch, head, expected);
  return head;
}

/**
 * One ref per registered repository. With `create`, a repository the feature
 * never touched gets its integration branch at its base branch first, so a
 * candidate binds the whole portfolio at exact SHAs, not only the
 * repositories that changed. With `trust`, every branch must be exactly
 * where the controller left it (a pre-existing or moved `feature/<id>` in a
 * repository is refused, never bound).
 */
export function portfolioRefs(
  workspace: Workspace,
  featureId: string,
  options: { create?: boolean; trust?: IntegrationTrust } = {},
): CandidateRepoRef[] {
  const branch = integrationBranchName(featureId);
  return workspace.repositories.repositories.map((repo) => {
    const path = repositoryPath(workspace, repo.name);
    if (options.create === true && !branchExists(path, branch)) {
      runGit(path, ['branch', branch, `refs/heads/${repo.base_branch}`]);
    }
    if (options.trust !== undefined) trustedIntegrationHead(workspace, featureId, repo.name, options.trust);
    return { name: repo.name, path, branch };
  });
}

/** Names of every registered repository. */
export function registeredRepositories(workspace: Workspace): string[] {
  return workspace.repositories.repositories.map((r) => r.name);
}
