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
  /** The commit fresh verification checked; the branch must still be there. */
  expectedSha?: string;
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

/**
 * What integrating one node would do, decided before the integration branch
 * moves: the head it starts from and the exact commit it ends at. A merge
 * commit is written (unreferenced) here, so the controller can record the
 * outcome before the branch is moved to it.
 */
export interface IntegrationPlan {
  branch: string;
  integrationWorktree: string;
  nodeSha: string;
  from: string;
  to: string;
  strategy: IntegrateResult['strategy'];
}

/** Plan merging one verified node branch into the repository's integration branch. */
export function planIntegration(args: IntegrateArgs): IntegrationPlan {
  const repo = resolve(args.repoPath);
  if (!branchExists(repo, args.nodeBranch)) {
    throw new Error(`Node branch "${args.nodeBranch}" does not exist in ${repo}.`);
  }

  const { path: worktree, branch } = ensureIntegrationWorktree(args);

  if (!isWorktreeClean(worktree)) {
    throw new DirtyWorktreeError(worktree, dirtyPaths(worktree));
  }

  const nodeSha = resolveRef(repo, args.nodeBranch);
  if (args.expectedSha !== undefined && nodeSha !== args.expectedSha) {
    throw new Error(
      `NODE_BRANCH_MOVED: ${args.nodeBranch} is at ${nodeSha}, but fresh verification checked ${args.expectedSha}; the newer commit was never verified.`,
    );
  }
  const from = resolveRef(worktree, 'HEAD');
  const plan = { branch, integrationWorktree: worktree, nodeSha, from };

  if (isAncestor(worktree, nodeSha, from)) return { ...plan, to: from, strategy: 'already-integrated' };

  // Fast-forward when the integration branch has not diverged.
  if (isAncestor(worktree, from, nodeSha)) return { ...plan, to: nodeSha, strategy: 'fast-forward' };

  // The merge is computed without touching the branch or the worktree; a
  // conflict therefore never leaves anything half-merged.
  const merge = runGit(worktree, ['merge-tree', '--write-tree', '--name-only', '--no-messages', from, nodeSha], {
    allowFail: true,
  });
  const lines = merge.stdout.split('\n').map((l) => l.trim());
  if (merge.exitCode === 1) {
    throw new IntegrationConflictError(args.nodeBranch, [...new Set(lines.slice(1).filter((l) => l !== ''))]);
  }
  if (merge.exitCode !== 0 || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(lines[0] ?? '')) {
    throw new Error(`Merging ${args.nodeBranch} failed: ${merge.stderr.trim() || `git merge-tree exited ${merge.exitCode}`}`);
  }
  const to = runGit(worktree, [
    '-c',
    'commit.gpgsign=false',
    'commit-tree',
    lines[0] as string,
    '-p',
    from,
    '-p',
    nodeSha,
    '-m',
    `integrate ${args.nodeBranch}`,
  ]).stdout.trim();
  return { ...plan, to, strategy: 'merge' };
}

/**
 * Move the integration branch (and its worktree) from exactly `plan.from`
 * to exactly `plan.to`. Refuses when the branch is anywhere else.
 */
export function applyIntegration(plan: IntegrationPlan): void {
  if (plan.to === plan.from) return;
  const head = resolveRef(plan.integrationWorktree, 'HEAD');
  if (head !== plan.from) {
    throw new Error(`INTEGRATION_BRANCH_MOVED: ${plan.branch} is at ${head.slice(0, 12)}, but the integration was planned from ${plan.from.slice(0, 12)}.`);
  }
  runGit(plan.integrationWorktree, ['merge', '--ff-only', '--quiet', plan.to]);
  const now = resolveRef(plan.integrationWorktree, 'HEAD');
  if (now !== plan.to) {
    throw new Error(`INTEGRATION_BRANCH_MOVED: ${plan.branch} is at ${now.slice(0, 12)}, not the planned ${plan.to.slice(0, 12)}.`);
  }
}

/** Merge one verified node branch into the repository's integration branch. */
export function integrateNodeBranch(args: IntegrateArgs): IntegrateResult {
  const plan = planIntegration(args);
  applyIntegration(plan);
  return { sha: plan.to, branch: plan.branch, strategy: plan.strategy, integrationWorktree: plan.integrationWorktree };
}
