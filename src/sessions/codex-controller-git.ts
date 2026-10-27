/** A controller-supplied, current claim snapshot; never accept this from the worker. */
import { lstatSync } from 'node:fs';

import { currentBranch, listWorktrees, resolveRef, runGit } from '../git/git.js';
import { matchGlob, workerBranchName } from '../git/worktree.js';
import { assertSafeRelativePath, isInsideReal, resolveInside, samePath } from '../security/paths.js';

export interface ClaimGitScope {
  repoPath: string;
  worktree: string;
  featureId: string;
  nodeId: string;
  expectedHead: string;
  allowedPaths: string[];
  forbiddenPaths: string[];
}

/** Stage exact owned paths and create one commit, with metadata writes by the controller. */
export function commitClaimPaths(scope: ClaimGitScope, request: { paths: string[]; message: string; claimCurrent: () => boolean }): string {
  const { worktree, repoPath } = scope;
  if (!request.claimCurrent()) throw new Error('CLAIM_STALE: claim no longer current');
  if (!/^[0-9a-f]{40}$/.test(scope.expectedHead)) throw new Error('CLAIM_HEAD_INVALID');
  if (!listWorktrees(repoPath).some((w) => samePath(w.path, worktree) && w.branch === workerBranchName(scope.featureId, scope.nodeId))) {
    throw new Error('CLAIM_WORKTREE_INVALID: not the registered node branch');
  }
  if (currentBranch(worktree) !== workerBranchName(scope.featureId, scope.nodeId) || resolveRef(worktree, 'HEAD') !== scope.expectedHead) {
    throw new Error('CLAIM_HEAD_STALE: branch or HEAD changed');
  }
  if (!Array.isArray(request.paths) || request.paths.length === 0 || request.paths.length > 100 || new Set(request.paths).size !== request.paths.length) {
    throw new Error('CLAIM_PATHS_INVALID');
  }
  if (typeof request.message !== 'string' || !/^[^\r\n\u0000-\u001f]{1,160}$/.test(request.message.trim()) || request.message !== request.message.trim()) {
    throw new Error('CLAIM_MESSAGE_INVALID');
  }
  for (const path of request.paths) {
    if (typeof path !== 'string') throw new Error('CLAIM_PATH_INVALID');
    assertSafeRelativePath(path);
    if (path.startsWith('-') || path.includes('\\') || path.split('/').some((p) => p === '.' || p === '..' || p === '' || p === '.git') || path.startsWith('.mycelink-worker/')) {
      throw new Error('CLAIM_PATH_INVALID: noncanonical or controller-owned path');
    }
    if (!scope.allowedPaths.some((g) => matchGlob(g, path)) || scope.forbiddenPaths.some((g) => matchGlob(g, path))) {
      throw new Error('CLAIM_PATH_OUTSIDE_FENCE');
    }
    const target = resolveInside(worktree, path);
    if (!isInsideReal(worktree, target)) throw new Error('CLAIM_PATH_OUTSIDE_WORKTREE');
    try {
      if (lstatSync(target).isSymbolicLink()) throw new Error('CLAIM_PATH_LINK_DENIED');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  const staged = runGit(worktree, ['diff', '--cached', '--name-only', '-z']).stdout;
  if (staged !== '') throw new Error('CLAIM_INDEX_DIRTY: pre-existing staged paths');
  // No shell, no -A at the root; deletion is staged only when explicitly named.
  runGit(worktree, ['add', '-A', '--', ...request.paths]);
  try {
    const stagedPaths = runGit(worktree, ['diff', '--cached', '--name-only', '-z']).stdout.split('\0').filter(Boolean);
    if (stagedPaths.length !== request.paths.length || !stagedPaths.every((p) => request.paths.includes(p))) {
      throw new Error('CLAIM_INDEX_SCOPE_INVALID: staged paths differ from requested paths');
    }
    if (!request.claimCurrent() || resolveRef(worktree, 'HEAD') !== scope.expectedHead) throw new Error('CLAIM_STALE: claim or HEAD changed before commit');
    runGit(worktree, ['commit', '-m', request.message]);
    return resolveRef(worktree, 'HEAD');
  } catch (err) {
    // Do not reset the user's worktree or discard edits. Remove only our staged paths.
    runGit(worktree, ['reset', '-q', 'HEAD', '--', ...request.paths], { allowFail: true });
    throw err;
  }
}
