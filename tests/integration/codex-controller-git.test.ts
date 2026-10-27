import { afterAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { symlinkSync, writeFileSync } from 'node:fs';
import { makeTmpDir, cleanupTmpRoots } from '../helpers/tmp.js';
import { git, makeGitRepo } from '../helpers/git-fixture.js';
import { createWorkerWorktree } from '../../src/git/worktree.js';
import { commitClaimPaths } from '../../src/sessions/codex-controller-git.js';

afterAll(() => cleanupTmpRoots());

describe('controller-owned disposable Git commit', () => {
  it('commits only named test files on the registered claim branch, leaving production unstaged', () => {
    const root = makeTmpDir('codex-git-');
    const repo = makeGitRepo(join(root, 'repo'), { files: { 'tests/status.test.js': 'old\n', 'src/status.js': 'old\n' } });
    const wt = createWorkerWorktree({ repoPath: repo, featureId: 'FEAT-101', nodeId: 'FEAT-101.api.impl', baseBranch: 'main', worktreeRoot: join(root, 'trees'), crossPlatformGit: true }).worktree;
    const base = git(wt, ['rev-parse', 'HEAD']);
    writeFileSync(join(wt, 'tests/status.test.js'), 'new test\n');
    writeFileSync(join(wt, 'src/status.js'), 'draft\n');
    const claim = { repoPath: repo, worktree: wt, featureId: 'FEAT-101', nodeId: 'FEAT-101.api.impl', expectedHead: base, allowedPaths: ['tests/**', 'src/**'], forbiddenPaths: [] };
    const sha = commitClaimPaths(claim, { paths: ['tests/status.test.js'], message: 'test: status', claimCurrent: () => true });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(git(wt, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'])).toBe('tests/status.test.js');
    expect(git(wt, ['status', '--porcelain'])).toContain('src/status.js');
    expect(() => commitClaimPaths({ ...claim, expectedHead: base }, { paths: ['src/status.js'], message: 'fix: status', claimCurrent: () => true })).toThrow(/HEAD|stale/i);
  });

  it('rejects traversal, out-of-fence paths, staged contamination, stale claim and another worktree', () => {
    const root = makeTmpDir('codex-git-');
    const repo = makeGitRepo(join(root, 'repo'), { files: { 'tests/a.test.js': 'old\n', 'src/a.js': 'old\n' } });
    const wt = createWorkerWorktree({ repoPath: repo, featureId: 'FEAT-101', nodeId: 'FEAT-101.api.impl', baseBranch: 'main', worktreeRoot: join(root, 'trees') }).worktree;
    const claim = { repoPath: repo, worktree: wt, featureId: 'FEAT-101', nodeId: 'FEAT-101.api.impl', expectedHead: git(wt, ['rev-parse', 'HEAD']), allowedPaths: ['tests/**'], forbiddenPaths: [] };
    writeFileSync(join(wt, 'tests/a.test.js'), 'new\n');
    writeFileSync(join(wt, 'src/a.js'), 'new\n');
    const call = (paths: string[], overrides = {}) => commitClaimPaths({ ...claim, ...overrides }, { paths, message: 'test: a', claimCurrent: () => true });
    expect(() => call(['../repo/src/a.js'])).toThrow();
    expect(() => call(['src/a.js'])).toThrow();
    expect(() => call(['tests/a.test.js'], { worktree: repo })).toThrow();
    expect(() => commitClaimPaths(claim, { paths: ['tests/a.test.js'], message: 'test: a', claimCurrent: () => false })).toThrow(/claim/i);
    git(wt, ['add', '--', 'src/a.js']);
    expect(() => call(['tests/a.test.js'])).toThrow(/staged|index/i);
    expect(git(wt, ['rev-parse', 'HEAD'])).toBe(claim.expectedHead);
  });

  it('rejects a symlink to a file outside the declared worktree', () => {
    const root = makeTmpDir('codex-git-');
    const repo = makeGitRepo(join(root, 'repo'), { files: { 'tests/a.test.js': 'old\n' } });
    const wt = createWorkerWorktree({ repoPath: repo, featureId: 'FEAT-101', nodeId: 'FEAT-101.api.impl', baseBranch: 'main', worktreeRoot: join(root, 'trees') }).worktree;
    const outside = join(root, 'outside.txt');
    writeFileSync(outside, 'secret\n');
    symlinkSync(outside, join(wt, 'tests', 'link.test.js'));
    expect(() => commitClaimPaths({ repoPath: repo, worktree: wt, featureId: 'FEAT-101', nodeId: 'FEAT-101.api.impl', expectedHead: git(wt, ['rev-parse', 'HEAD']), allowedPaths: ['tests/**'], forbiddenPaths: [] }, { paths: ['tests/link.test.js'], message: 'test: link', claimCurrent: () => true })).toThrow(/link|outside/i);
  });

  it('rechecks a rotating claim before committing and un-stages only its own path', () => {
    const root = makeTmpDir('codex-git-');
    const repo = makeGitRepo(join(root, 'repo'), { files: { 'tests/a.test.js': 'old\n' } });
    const wt = createWorkerWorktree({ repoPath: repo, featureId: 'FEAT-101', nodeId: 'FEAT-101.api.impl', baseBranch: 'main', worktreeRoot: join(root, 'trees') }).worktree;
    const base = git(wt, ['rev-parse', 'HEAD']);
    writeFileSync(join(wt, 'tests/a.test.js'), 'new\n');
    let checks = 0;
    expect(() => commitClaimPaths({ repoPath: repo, worktree: wt, featureId: 'FEAT-101', nodeId: 'FEAT-101.api.impl', expectedHead: base, allowedPaths: ['tests/**'], forbiddenPaths: [] }, { paths: ['tests/a.test.js'], message: 'test: a', claimCurrent: () => ++checks === 1 })).toThrow(/claim/i);
    expect(git(wt, ['rev-parse', 'HEAD'])).toBe(base);
    expect(git(wt, ['diff', '--cached', '--name-only'])).toBe('');
    expect(git(wt, ['diff', '--name-only'])).toBe('tests/a.test.js');
  });
});
