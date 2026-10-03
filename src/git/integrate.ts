/**
 * Per-repository integration branch.
 *
 * Only a node whose fresh verification passed is ever integrated, and the
 * merge happens in a dedicated integration worktree so neither the user's
 * checkout nor any worker worktree is disturbed. A conflicting merge is
 * aborted completely: the integration branch must never be left half-merged.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  branchExists,
  dirtyPaths,
  isAncestor,
  isWorktreeClean,
  listWorktrees,
  resolveRef,
  runGit,
} from './git.js';
import { integrationBranchName } from './worktree.js';
import { samePath } from '../security/paths.js';

export class IntegrationConflictError extends Error {
  readonly conflicts: string[];
  readonly nodeBranch: string;
  constructor(nodeBranch: string, conflicts: string[]) {
    super(
      `Merging ${nodeBranch} into the integration branch conflicts in: ${conflicts.join(', ') || '(unknown files)'}`,
    );
    this.name = 'IntegrationConflictError';
    this.conflicts = conflicts;
    this.nodeBranch = nodeBranch;
  }
}

export class DirtyWorktreeError extends Error {
  readonly paths: string[];
  constructor(where: string, paths: string[]) {
    super(`Worktree ${where} is dirty (${paths.slice(0, 10).join(', ')}); refusing to proceed.`);
    this.name = 'DirtyWorktreeError';
    this.paths = paths;
  }
}

export interface IntegrateArgs {
  repoPath: string;
  featureId: string;
  nodeBranch: string;
  baseBranch: string;
  /** Where integration worktrees live (one per repository + feature). */
  integrationRoot: string;
  repositoryName?: string;
}

export interface IntegrateResult {
  sha: string;
  branch: string;
  strategy: 'fast-forward' | 'merge' | 'already-integrated';
  integrationWorktree: string;
}

function integrationWorktreeDir(root: string, repoName: string, featureId: string): string {
  return resolve(join(root, `integration__${repoName}__${featureId}`));
}

function baseName(p: string): string {
  const parts = resolve(p).split(/[\\/]/);
  return parts[parts.length - 1] ?? 'repo';
}

/**
 * Ensure the integration worktree exists and is checked out on
 * `feature/<feature-id>`, creating the branch from `baseBranch` on first use.
 */
export function ensureIntegrationWorktree(args: IntegrateArgs): { path: string; branch: string } {
  const repo = resolve(args.repoPath);
  const repoName = args.repositoryName ?? baseName(repo);
  const branch = integrationBranchName(args.featureId);
  const target = integrationWorktreeDir(args.integrationRoot, repoName, args.featureId);

  mkdirSync(args.integrationRoot, { recursive: true });

  // Match by location, not text (see createWorkerWorktree).
  const registered = listWorktrees(repo).find((w) => samePath(w.path, target));
  if (registered && !existsSync(target)) {
    runGit(repo, ['worktree', 'prune'], { allowFail: true });
  }
  if (!existsSync(target)) {
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    if (branchExists(repo, branch)) {
      runGit(repo, ['worktree', 'add', target, branch]);
    } else {
      runGit(repo, ['worktree', 'add', '-b', branch, target, args.baseBranch]);
    }
    runGit(target, ['config', 'core.autocrlf', 'false']);
    runGit(target, ['config', 'commit.gpgsign', 'false']);
  }
  return { path: target, branch };
}

/** Merge one verified node branch into the repository's integration branch. */
export function integrateNodeBranch(args: IntegrateArgs): IntegrateResult {
  const repo = resolve(args.repoPath);
  if (!branchExists(repo, args.nodeBranch)) {
    throw new Error(`Node branch "${args.nodeBranch}" does not exist in ${repo}.`);
  }

  const { path: worktree, branch } = ensureIntegrationWorktree(args);

  if (!isWorktreeClean(worktree)) {
    throw new DirtyWorktreeError(worktree, dirtyPaths(worktree));
  }

  const nodeSha = resolveRef(repo, args.nodeBranch);
  const headSha = resolveRef(worktree, 'HEAD');

  if (isAncestor(worktree, nodeSha, headSha)) {
    return { sha: headSha, branch, strategy: 'already-integrated', integrationWorktree: worktree };
  }

  // Fast-forward when the integration branch has not diverged.
  if (isAncestor(worktree, headSha, nodeSha)) {
    runGit(worktree, ['merge', '--ff-only', nodeSha]);
    return {
      sha: resolveRef(worktree, 'HEAD'),
      branch,
      strategy: 'fast-forward',
      integrationWorktree: worktree,
    };
  }

  const merge = runGit(
    worktree,
    [
      '-c',
      'commit.gpgsign=false',
      'merge',
      '--no-ff',
      '--no-edit',
      '-m',
      `integrate ${args.nodeBranch}`,
      nodeSha,
    ],
    { allowFail: true },
  );

  if (merge.exitCode !== 0) {
    const conflicts = runGit(worktree, ['diff', '--name-only', '--diff-filter=U'], {
      allowFail: true,
    })
      .stdout.split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '');
    // Abort completely so the branch is never left half-merged.
    runGit(worktree, ['merge', '--abort'], { allowFail: true });
    runGit(worktree, ['reset', '--hard', headSha], { allowFail: true });
    runGit(worktree, ['clean', '-fd'], { allowFail: true });
    throw new IntegrationConflictError(args.nodeBranch, conflicts);
  }

  return {
    sha: resolveRef(worktree, 'HEAD'),
    branch,
    strategy: 'merge',
    integrationWorktree: worktree,
  };
}
