/**
 * Thin, deterministic wrapper around the git CLI.
 *
 * Commands are always argv arrays (never shell strings) so arguments with
 * spaces survive native Windows paths, and every invocation returns its exit
 * code rather than throwing by default — the controller records exit codes as
 * evidence.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  command: string[];
}

export class GitError extends Error {
  readonly result: GitResult;
  constructor(result: GitResult) {
    super(
      `git ${result.command.join(' ')} exited ${result.exitCode}: ${(result.stderr || result.stdout).trim().slice(0, 500)}`,
    );
    this.name = 'GitError';
    this.result = result;
  }
}

export interface GitOptions {
  /** Return the failing result instead of throwing. */
  allowFail?: boolean;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export function runGit(cwd: string, args: string[], options: GitOptions = {}): GitResult {
  const proc = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 120_000,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...options.env },
  });
  const result: GitResult = {
    exitCode: proc.status ?? (proc.error ? 127 : 1),
    stdout: proc.stdout ?? '',
    stderr: proc.stderr ?? (proc.error ? String(proc.error.message) : ''),
    command: ['git', ...args],
  };
  if (result.exitCode !== 0 && !options.allowFail) throw new GitError(result);
  return result;
}

export function isGitRepository(dir: string): boolean {
  if (!existsSync(dir)) return false;
  const r = runGit(dir, ['rev-parse', '--is-inside-work-tree'], { allowFail: true });
  return r.exitCode === 0 && r.stdout.trim() === 'true';
}

/** Resolve a ref to a full 40-char SHA. */
export function resolveRef(repo: string, ref: string): string {
  return runGit(repo, ['rev-parse', '--verify', `${ref}^{commit}`]).stdout.trim();
}

export function currentBranch(repo: string): string {
  return runGit(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
}

export function branchExists(repo: string, branch: string): boolean {
  return (
    runGit(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true })
      .exitCode === 0
  );
}

/** True when there are no staged, unstaged or untracked changes. */
export function isWorktreeClean(repo: string): boolean {
  return runGit(repo, ['status', '--porcelain', '--untracked-files=all']).stdout.trim() === '';
}

export function dirtyPaths(repo: string): string[] {
  return runGit(repo, ['status', '--porcelain', '--untracked-files=all'])
    .stdout.split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .map((l) => l.slice(l.indexOf(' ') + 1).trim())
    .map((l) => (l.includes(' -> ') ? (l.split(' -> ')[1] as string) : l))
    .map((l) => l.replace(/^"|"$/g, ''));
}

export interface WorktreeEntry {
  path: string;
  head: string | null;
  branch: string | null;
  prunable: boolean;
}

export function listWorktrees(repo: string): WorktreeEntry[] {
  const out = runGit(repo, ['worktree', 'list', '--porcelain']).stdout;
  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> | null = null;
  for (const line of out.split('\n')) {
    const trimmed = line.trimEnd();
    if (trimmed.startsWith('worktree ')) {
      if (current?.path) entries.push(finishEntry(current));
      current = { path: resolve(trimmed.slice('worktree '.length)) };
    } else if (trimmed.startsWith('HEAD ') && current) {
      current.head = trimmed.slice('HEAD '.length);
    } else if (trimmed.startsWith('branch ') && current) {
      current.branch = trimmed.slice('branch '.length).replace(/^refs\/heads\//, '');
    } else if (trimmed.startsWith('prunable') && current) {
      current.prunable = true;
    }
  }
  if (current?.path) entries.push(finishEntry(current));
  return entries;
}

function finishEntry(partial: Partial<WorktreeEntry>): WorktreeEntry {
  return {
    path: partial.path as string,
    head: partial.head ?? null,
    branch: partial.branch ?? null,
    prunable: partial.prunable ?? false,
  };
}

/** Files changed between `base` and the working tree (committed + dirty). */
export function changedPathsSince(repo: string, base: string): string[] {
  const committed = runGit(repo, ['diff', '--name-only', `${base}...HEAD`], { allowFail: true });
  const unstaged = runGit(repo, ['diff', '--name-only', 'HEAD'], { allowFail: true });
  const untracked = runGit(repo, ['ls-files', '--others', '--exclude-standard'], {
    allowFail: true,
  });
  const all = new Set<string>();
  for (const chunk of [committed.stdout, unstaged.stdout, untracked.stdout]) {
    for (const line of chunk.split('\n')) {
      const p = line.trim();
      if (p !== '') all.add(p.replace(/\\/g, '/'));
    }
  }
  return [...all].sort();
}

export function commitAll(repo: string, message: string): string | null {
  runGit(repo, ['add', '-A']);
  const status = runGit(repo, ['status', '--porcelain']).stdout.trim();
  if (status === '') return null;
  runGit(repo, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message]);
  return resolveRef(repo, 'HEAD');
}

/** Short, stable summary of a commit for evidence records. */
export function commitSubject(repo: string, sha: string): string {
  return runGit(repo, ['log', '-1', '--format=%s', sha]).stdout.trim();
}

export function mergeBase(repo: string, a: string, b: string): string {
  return runGit(repo, ['merge-base', a, b]).stdout.trim();
}

export function isAncestor(repo: string, ancestor: string, descendant: string): boolean {
  return (
    runGit(repo, ['merge-base', '--is-ancestor', ancestor, descendant], { allowFail: true })
      .exitCode === 0
  );
}
