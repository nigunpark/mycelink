/**
 * Per-node worker isolation.
 *
 * Each claimed node gets its own git worktree on its own branch, so two
 * concurrent workers in the same repository can never see or clobber each
 * other's working tree. Path ownership is then enforced against a real diff,
 * not against a promise.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  branchExists,
  changedPathsSince,
  listWorktrees,
  resolveRef,
  runGit,
} from './git.js';
import { assertFeatureId, assertNodeId } from '../security/names.js';
import { samePath } from '../security/paths.js';

export class AllowedPathViolationError extends Error {
  readonly violations: string[];
  constructor(violations: string[]) {
    super(
      `Worker modified ${violations.length} path(s) outside its ownership fence: ${violations
        .slice(0, 10)
        .join(', ')}`,
    );
    this.name = 'AllowedPathViolationError';
    this.violations = violations;
  }
}

/**
 * `wip/<feature-id>/<node suffix>` — the per-node branch inside a repository.
 *
 * Worker branches cannot live under `feature/<feature-id>/<node-id>`: git
 * refs are filesystem paths, so `refs/heads/feature/FEAT-1` and
 * `refs/heads/feature/FEAT-1/<node>` cannot both exist ("cannot lock ref ...
 * exists; cannot create ..."). The promise — one common logical branch name
 * `feature/<feature-id>` in every repository, bound together by a candidate
 * manifest — is preserved; only the internal worker-branch namespace differs.
 */
export function workerBranchName(featureId: string, nodeId: string): string {
  assertFeatureId(featureId);
  assertNodeId(nodeId);
  const suffix = nodeId.startsWith(featureId + '.') ? nodeId.slice(featureId.length + 1) : nodeId;
  return `wip/${featureId}/${suffix}`;
}

/** `feature/<feature-id>` — the per-repository integration branch. */
export function integrationBranchName(featureId: string): string {
  assertFeatureId(featureId);
  return `feature/${featureId}`;
}

/** A filesystem-safe directory name for a node worktree. */
export function worktreeDirName(repository: string, nodeId: string): string {
  return `${repository}__${nodeId.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

export interface CreateWorktreeArgs {
  repoPath: string;
  featureId: string;
  nodeId: string;
  baseBranch: string;
  worktreeRoot: string;
  repositoryName?: string;
  /**
   * The exact commit a new branch starts from (the repository's integration
   * head once anything is integrated). Defaults to `baseBranch`. Ignored when
   * the branch already exists: its commits are kept.
   */
  startPoint?: string;
}

export interface WorkerWorktree {
  worktree: string;
  branch: string;
  base: string;
  created: boolean;
  /** The commit a branch created by this call started from; null when the branch already existed. */
  startSha: string | null;
}

/**
 * Create (or re-attach to) the isolated worktree for a node.
 *
 * Idempotent: calling it twice returns the same worktree. If the directory was
 * deleted outside git, the stale registration is pruned and the worktree is
 * recreated on the existing branch so prior commits are not lost.
 */
export function createWorkerWorktree(args: CreateWorktreeArgs): WorkerWorktree {
  const repo = resolve(args.repoPath);
  const branch = workerBranchName(args.featureId, args.nodeId);
  const name = worktreeDirName(args.repositoryName ?? baseName(repo), args.nodeId);
  const target = resolve(join(args.worktreeRoot, name));

  mkdirSync(args.worktreeRoot, { recursive: true });

  // Match by location, not text: git records its own canonical form of the
  // path (long names, not 8.3 aliases), so a textual miss here would delete a
  // live worktree below and then fail to re-add it.
  const registered = listWorktrees(repo).find((w) => samePath(w.path, target));
  if (registered && existsSync(target)) {
    return { worktree: target, branch, base: args.baseBranch, created: false, startSha: null };
  }
  if (registered && !existsSync(target)) {
    // Directory vanished (deleted by a crash or by the user): drop the stale
    // registration so git will let us re-create it.
    runGit(repo, ['worktree', 'prune'], { allowFail: true });
  }
  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }

  let startSha: string | null = null;
  if (branchExists(repo, branch)) {
    runGit(repo, ['worktree', 'add', target, branch]);
  } else {
    startSha = resolveRef(repo, args.startPoint ?? args.baseBranch);
    runGit(repo, ['worktree', 'add', '-b', branch, target, startSha]);
  }

  // Deterministic line endings: a worker diff must not be polluted by CRLF.
  runGit(target, ['config', 'core.autocrlf', 'false']);
  runGit(target, ['config', 'commit.gpgsign', 'false']);

  return { worktree: target, branch, base: args.baseBranch, created: true, startSha };
}

function baseName(p: string): string {
  const parts = resolve(p).split(/[\\/]/);
  return parts[parts.length - 1] ?? 'repo';
}

/** Remove a node worktree. The branch is deliberately kept. */
export function removeWorkerWorktree(repoPath: string, worktree: string): void {
  const repo = resolve(repoPath);
  runGit(repo, ['worktree', 'remove', '--force', resolve(worktree)], { allowFail: true });
  if (existsSync(worktree)) {
    rmSync(worktree, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
  runGit(repo, ['worktree', 'prune'], { allowFail: true });
}

/** Match a path against a simple glob supporting `*`, `**` and `?`. */
export function matchGlob(pattern: string, path: string): boolean {
  const p = pattern.replace(/\\/g, '/');
  const t = path.replace(/\\/g, '/');
  const rx = globToRegExp(p);
  return rx.test(t);
}

function globToRegExp(glob: string): RegExp {
  let out = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` matches zero or more path segments; a trailing `**` matches the rest.
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      out += '\\' + c;
    } else {
      out += c;
    }
  }
  out += '$';
  return new RegExp(out);
}

export interface PathFence {
  allowed: string[];
  forbidden?: string[];
  throwOnViolation?: boolean;
}

export interface ChangedPathsResult {
  changed: string[];
  violations: string[];
}

/**
 * Compare the worktree against `base` and report every changed path that the
 * node was not permitted to touch. Uncommitted and untracked files count: a
 * worker must not be able to escape the fence by simply not committing.
 */
export function verifyChangedPaths(
  worktree: string,
  base: string,
  fence: PathFence,
): ChangedPathsResult {
  const changed = changedPathsSince(worktree, base);
  const violations = changed.filter((path) => {
    const allowed = fence.allowed.some((g) => matchGlob(g, path));
    const forbidden = (fence.forbidden ?? []).some((g) => matchGlob(g, path));
    return !allowed || forbidden;
  });
  if (fence.throwOnViolation && violations.length > 0) {
    throw new AllowedPathViolationError(violations);
  }
  return { changed, violations };
}
