import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmpDir, cleanupTmpRoots, windowsShortPathAlias } from '../helpers/tmp.js';
import { samePath } from '../../src/security/paths.js';
import { commitAll, git, headSha, makeGitRepo, writeFiles } from '../helpers/git-fixture.js';
import {
  branchExists,
  currentBranch,
  isWorktreeClean,
  listWorktrees,
  resolveRef,
} from '../../src/git/git.js';
import {
  AllowedPathViolationError,
  createWorkerWorktree,
  removeWorkerWorktree,
  verifyChangedPaths,
  workerBranchName,
} from '../../src/git/worktree.js';

afterAll(() => cleanupTmpRoots());

function repoWithSource(): string {
  const dir = join(makeTmpDir('git-'), 'core');
  makeGitRepo(dir, {
    files: {
      'src/publish.js': 'export function publish() { return null; }\n',
      'tests/publish.test.js': '// placeholder\n',
      'README.md': '# core\n',
    },
  });
  return dir;
}

describe('git primitives', () => {
  it('reads HEAD, branch and cleanliness of a real repository', () => {
    const repo = repoWithSource();
    expect(resolveRef(repo, 'HEAD')).toMatch(/^[0-9a-f]{40}$/);
    expect(currentBranch(repo)).toBe('main');
    expect(isWorktreeClean(repo)).toBe(true);

    writeFiles(repo, { 'src/publish.js': 'changed\n' });
    expect(isWorktreeClean(repo)).toBe(false);
  });

  it('reports branch existence without throwing', () => {
    const repo = repoWithSource();
    expect(branchExists(repo, 'main')).toBe(true);
    expect(branchExists(repo, 'feature/does-not-exist')).toBe(false);
  });
});

describe('worker worktrees', () => {
  it('derives a node branch name that cannot collide with the integration ref', () => {
    // refs/heads/feature/FEAT-101 (integration) and refs/heads/feature/FEAT-101/<node>
    // cannot coexist in git, so node branches live under a sibling namespace.
    expect(workerBranchName('FEAT-101', 'FEAT-101.core.publish.impl')).toBe(
      'wip/FEAT-101/core.publish.impl',
    );
    expect(workerBranchName('FEAT-101', 'FEAT-101.core.publish.impl')).not.toMatch(
      /^feature\/FEAT-101\//,
    );
  });

  it('creates an isolated worktree on a fresh node branch', () => {
    const repo = repoWithSource();
    const root = makeTmpDir('wt-');
    const wt = createWorkerWorktree({
      repoPath: repo,
      featureId: 'FEAT-101',
      nodeId: 'FEAT-101.core.publish.impl',
      baseBranch: 'main',
      worktreeRoot: root,
    });

    expect(existsSync(join(wt.worktree, 'src', 'publish.js'))).toBe(true);
    expect(currentBranch(wt.worktree)).toBe('wip/FEAT-101/core.publish.impl');
    expect(listWorktrees(repo).some((w) => samePath(w.path, wt.worktree))).toBe(true);

    // The parent checkout is untouched by work in the worktree.
    writeFiles(wt.worktree, { 'src/publish.js': 'export function publish() { return 1; }\n' });
    expect(isWorktreeClean(repo)).toBe(true);
    expect(readFileSync(join(repo, 'src', 'publish.js'), 'utf8')).toContain('return null');
  });

  it('is idempotent: recreating the same node worktree reuses it', () => {
    const repo = repoWithSource();
    const root = makeTmpDir('wt-');
    const args = {
      repoPath: repo,
      featureId: 'FEAT-101',
      nodeId: 'FEAT-101.core.publish.impl',
      baseBranch: 'main',
      worktreeRoot: root,
    };
    const first = createWorkerWorktree(args);
    const second = createWorkerWorktree(args);
    expect(second.worktree).toBe(first.worktree);
    expect(second.created).toBe(false);
  });

  it('reuses a worktree whose root was given as a Windows 8.3 short-name alias', (ctx) => {
    // GitHub-hosted Windows runners expose the temp dir as C:\Users\RUNNER~1\...,
    // while `git worktree list` reports the long form of the same directory.
    const repo = repoWithSource();
    const longRoot = makeTmpDir('worktree-root-long-name-');
    const shortRoot = windowsShortPathAlias(longRoot);
    if (shortRoot === null) return ctx.skip();
    const args = {
      repoPath: repo,
      featureId: 'FEAT-101',
      nodeId: 'FEAT-101.core.publish.impl',
      baseBranch: 'main',
      worktreeRoot: shortRoot,
    };
    const first = createWorkerWorktree(args);
    expect(listWorktrees(repo).some((w) => samePath(w.path, first.worktree))).toBe(true);
    // Uncommitted worker output must survive re-attachment.
    writeFiles(first.worktree, { 'src/draft.js': 'draft\n' });

    const second = createWorkerWorktree(args);
    expect(second.created).toBe(false);
    expect(second.worktree).toBe(first.worktree);
    expect(readFileSync(join(second.worktree, 'src', 'draft.js'), 'utf8')).toBe('draft\n');

    // Deleted outside git under the alias: the stale long-form registration is pruned.
    rmSync(second.worktree, { recursive: true, force: true });
    const third = createWorkerWorktree(args);
    expect(third.created).toBe(true);
    expect(existsSync(join(third.worktree, 'src', 'publish.js'))).toBe(true);
  });

  it('gives two nodes in the same repository fully separate worktrees', () => {
    const repo = repoWithSource();
    const root = makeTmpDir('wt-');
    const a = createWorkerWorktree({
      repoPath: repo,
      featureId: 'FEAT-101',
      nodeId: 'FEAT-101.core.a.impl',
      baseBranch: 'main',
      worktreeRoot: root,
    });
    const b = createWorkerWorktree({
      repoPath: repo,
      featureId: 'FEAT-101',
      nodeId: 'FEAT-101.core.b.impl',
      baseBranch: 'main',
      worktreeRoot: root,
    });
    expect(a.worktree).not.toBe(b.worktree);

    writeFiles(a.worktree, { 'src/a.js': 'a\n' });
    commitAll(a.worktree, 'a change');
    expect(existsSync(join(b.worktree, 'src', 'a.js'))).toBe(false);
  });

  it('removes a worktree and prunes its registration', () => {
    const repo = repoWithSource();
    const root = makeTmpDir('wt-');
    const wt = createWorkerWorktree({
      repoPath: repo,
      featureId: 'FEAT-101',
      nodeId: 'FEAT-101.core.publish.impl',
      baseBranch: 'main',
      worktreeRoot: root,
    });
    removeWorkerWorktree(repo, wt.worktree);
    expect(existsSync(wt.worktree)).toBe(false);
    expect(listWorktrees(repo).some((w) => samePath(w.path, wt.worktree))).toBe(false);
    // The branch survives so verified work is not lost.
    expect(branchExists(repo, wt.branch)).toBe(true);
  });

  it('recovers when a worktree directory was deleted outside git', () => {
    const repo = repoWithSource();
    const root = makeTmpDir('wt-');
    const args = {
      repoPath: repo,
      featureId: 'FEAT-101',
      nodeId: 'FEAT-101.core.publish.impl',
      baseBranch: 'main',
      worktreeRoot: root,
    };
    const first = createWorkerWorktree(args);
    rmSync(first.worktree, { recursive: true, force: true });
    const second = createWorkerWorktree(args);
    expect(existsSync(join(second.worktree, 'src', 'publish.js'))).toBe(true);
  });
});

describe('allowed-path enforcement on a real diff', () => {
  function prepared(): { repo: string; wt: string; base: string } {
    const repo = repoWithSource();
    const root = makeTmpDir('wt-');
    const wt = createWorkerWorktree({
      repoPath: repo,
      featureId: 'FEAT-101',
      nodeId: 'FEAT-101.core.publish.impl',
      baseBranch: 'main',
      worktreeRoot: root,
    });
    return { repo, wt: wt.worktree, base: headSha(repo) };
  }

  it('accepts a change confined to allowed paths', () => {
    const { wt, base } = prepared();
    writeFiles(wt, { 'src/publish.js': 'export function publish() { return 1; }\n' });
    commitAll(wt, 'impl');
    const result = verifyChangedPaths(wt, base, { allowed: ['src/**'], forbidden: [] });
    expect(result.violations).toEqual([]);
    expect(result.changed).toEqual(['src/publish.js']);
  });

  it('rejects a change outside allowed paths', () => {
    const { wt, base } = prepared();
    writeFiles(wt, { 'README.md': '# hacked\n' });
    commitAll(wt, 'oops');
    const result = verifyChangedPaths(wt, base, { allowed: ['src/**'], forbidden: [] });
    expect(result.violations).toEqual(['README.md']);
  });

  it('rejects a change to an explicitly forbidden path even if allowed matches', () => {
    const { wt, base } = prepared();
    writeFiles(wt, { 'src/generated/out.js': 'x\n' });
    commitAll(wt, 'touch generated');
    const result = verifyChangedPaths(wt, base, {
      allowed: ['src/**'],
      forbidden: ['src/generated/**'],
    });
    expect(result.violations).toEqual(['src/generated/out.js']);
  });

  it('counts uncommitted working-tree changes too', () => {
    const { wt, base } = prepared();
    writeFileSync(join(wt, 'README.md'), '# dirty\n');
    const result = verifyChangedPaths(wt, base, { allowed: ['src/**'], forbidden: [] });
    expect(result.violations).toEqual(['README.md']);
  });

  it('assertAllowedPaths throws with the offending files named', () => {
    const { wt, base } = prepared();
    writeFiles(wt, { 'README.md': '# hacked\n', 'src/ok.js': 'ok\n' });
    commitAll(wt, 'mixed');
    expect(() =>
      verifyChangedPaths(wt, base, { allowed: ['src/**'], forbidden: [], throwOnViolation: true }),
    ).toThrow(AllowedPathViolationError);
  });

  it('treats a rename out of the allowed subtree as a violation', () => {
    const { wt, base } = prepared();
    git(wt, ['mv', 'src/publish.js', 'publish.js']);
    commitAll(wt, 'move out');
    const result = verifyChangedPaths(wt, base, { allowed: ['src/**'], forbidden: [] });
    expect(result.violations).toContain('publish.js');
  });
});
