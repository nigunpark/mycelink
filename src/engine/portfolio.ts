/**
 * The repositories a feature's release candidate binds: every registered
 * repository, on the feature's integration branch.
 */
import type { CandidateRepoRef } from '../git/candidate.js';
import { branchExists, runGit } from '../git/git.js';
import { integrationBranchName } from '../git/worktree.js';
import { repositoryPath, type Workspace } from '../workspace/workspace.js';

/**
 * One ref per registered repository. With `create`, a repository the feature
 * never touched gets its integration branch at its base branch first, so a
 * candidate binds the whole portfolio at exact SHAs, not only the
 * repositories that changed.
 */
export function portfolioRefs(workspace: Workspace, featureId: string, options: { create?: boolean } = {}): CandidateRepoRef[] {
  const branch = integrationBranchName(featureId);
  return workspace.repositories.repositories.map((repo) => {
    const path = repositoryPath(workspace, repo.name);
    if (options.create === true && !branchExists(path, branch)) {
      runGit(path, ['branch', branch, `refs/heads/${repo.base_branch}`]);
    }
    return { name: repo.name, path, branch };
  });
}

/** Names of every registered repository. */
export function registeredRepositories(workspace: Workspace): string[] {
  return workspace.repositories.repositories.map((r) => r.name);
}
