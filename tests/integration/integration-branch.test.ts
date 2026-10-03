import { afterAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { makeTmpDir, cleanupTmpRoots } from '../helpers/tmp.js';
import { commitAll, makeGitRepo, writeFiles } from '../helpers/git-fixture.js';
import { branchExists, isWorktreeClean, resolveRef, isAncestor } from '../../src/git/git.js';
import { createWorkerWorktree, integrationBranchName } from '../../src/git/worktree.js';
import {
  IntegrationConflictError,
  integrateNodeBranch,
} from '../../src/git/integrate.js';

afterAll(() => cleanupTmpRoots());

function coreRepo(): string {
  const dir = join(makeTmpDir('int-'), 'core');
  makeGitRepo(dir, {
    files: {
      'src/publish.js': 'export function publish() { return null; }\n',
      'src/other.js': 'export const other = 0;\n',
      'README.md': '# core\n',
    },
  });
  return dir;
}

function workOnNode(repo: string, root: string, nodeId: string, files: Record<string, string>): string {
  const wt = createWorkerWorktree({
    repoPath: repo,
    featureId: 'FEAT-101',
    nodeId,
    baseBranch: 'main',
    worktreeRoot: root,
  });
  writeFiles(wt.worktree, files);
  commitAll(wt.worktree, `work for ${nodeId}`);
  return wt.branch;
}

describe('repository integration branch', () => {
  it('creates feature/<id> from base and fast-forwards the first node', () => {
    const repo = coreRepo();
    const root = makeTmpDir('wt-');
    const branch = workOnNode(repo, root, 'FEAT-101.core.a.impl', {
      'src/publish.js': 'export function publish() { return 1; }\n',
    });

    const result = integrateNodeBranch({
      repoPath: repo,
      featureId: 'FEAT-101',
      nodeBranch: branch,
      baseBranch: 'main',
      integrationRoot: root,
    });

    expect(result.strategy).toBe('fast-forward');
    expect(branchExists(repo, integrationBranchName('FEAT-101'))).toBe(true);
    expect(resolveRef(repo, integrationBranchName('FEAT-101'))).toBe(result.sha);
    expect(isAncestor(repo, resolveRef(repo, branch), result.sha)).toBe(true);
  });

  it('merges a second, non-conflicting node onto the same integration branch', () => {
    const repo = coreRepo();
    const root = makeTmpDir('wt-');
    const a = workOnNode(repo, root, 'FEAT-101.core.a.impl', {
      'src/publish.js': 'export function publish() { return 1; }\n',
    });
    const b = workOnNode(repo, root, 'FEAT-101.core.b.impl', {
      'src/other.js': 'export const other = 1;\n',
    });

    integrateNodeBranch({
      repoPath: repo,
      featureId: 'FEAT-101',
      nodeBranch: a,
      baseBranch: 'main',
      integrationRoot: root,
    });
    const second = integrateNodeBranch({
      repoPath: repo,
      featureId: 'FEAT-101',
      nodeBranch: b,
      baseBranch: 'main',
      integrationRoot: root,
    });

    expect(second.strategy).toBe('merge');
    const head = resolveRef(repo, integrationBranchName('FEAT-101'));
    expect(isAncestor(repo, resolveRef(repo, a), head)).toBe(true);
    expect(isAncestor(repo, resolveRef(repo, b), head)).toBe(true);
    expect(readFileSync(join(second.integrationWorktree, 'src', 'publish.js'), 'utf8')).toContain(
      'return 1',
    );
    expect(readFileSync(join(second.integrationWorktree, 'src', 'other.js'), 'utf8')).toContain(
      'other = 1',
    );
  });

  it('is idempotent: integrating an already-merged branch is a no-op', () => {
    const repo = coreRepo();
    const root = makeTmpDir('wt-');
    const a = workOnNode(repo, root, 'FEAT-101.core.a.impl', { 'src/publish.js': 'v1\n' });
    const first = integrateNodeBranch({
      repoPath: repo,
      featureId: 'FEAT-101',
      nodeBranch: a,
      baseBranch: 'main',
      integrationRoot: root,
    });
    const again = integrateNodeBranch({
      repoPath: repo,
      featureId: 'FEAT-101',
      nodeBranch: a,
      baseBranch: 'main',
      integrationRoot: root,
    });
    expect(again.strategy).toBe('already-integrated');
    expect(again.sha).toBe(first.sha);
  });

  it('refuses a conflicting merge and leaves the integration branch untouched', () => {
    const repo = coreRepo();
    const root = makeTmpDir('wt-');
    const a = workOnNode(repo, root, 'FEAT-101.core.a.impl', { 'src/publish.js': 'AAA\n' });
    const b = workOnNode(repo, root, 'FEAT-101.core.b.impl', { 'src/publish.js': 'BBB\n' });

    const first = integrateNodeBranch({
      repoPath: repo,
      featureId: 'FEAT-101',
      nodeBranch: a,
      baseBranch: 'main',
      integrationRoot: root,
    });

    expect(() =>
      integrateNodeBranch({
        repoPath: repo,
        featureId: 'FEAT-101',
        nodeBranch: b,
        baseBranch: 'main',
        integrationRoot: root,
      }),
    ).toThrow(IntegrationConflictError);

    // No half-merged state: the integration branch still points at the first merge.
    expect(resolveRef(repo, integrationBranchName('FEAT-101'))).toBe(first.sha);
    expect(isWorktreeClean(first.integrationWorktree)).toBe(true);
  });

  it('refuses to integrate a branch that does not exist', () => {
    const repo = coreRepo();
    const root = makeTmpDir('wt-');
    expect(() =>
      integrateNodeBranch({
        repoPath: repo,
        featureId: 'FEAT-101',
        nodeBranch: 'feature/FEAT-101/ghost',
        baseBranch: 'main',
        integrationRoot: root,
      }),
    ).toThrow(/does not exist/i);
  });

  it('refuses to integrate when the integration worktree is dirty', () => {
    const repo = coreRepo();
    const root = makeTmpDir('wt-');
    const a = workOnNode(repo, root, 'FEAT-101.core.a.impl', { 'src/publish.js': 'v1\n' });
    const first = integrateNodeBranch({
      repoPath: repo,
      featureId: 'FEAT-101',
      nodeBranch: a,
      baseBranch: 'main',
      integrationRoot: root,
    });
    writeFiles(first.integrationWorktree, { 'src/stray.js': 'manual edit\n' });

    const b = workOnNode(repo, root, 'FEAT-101.core.b.impl', { 'src/other.js': 'v2\n' });
    expect(() =>
      integrateNodeBranch({
        repoPath: repo,
        featureId: 'FEAT-101',
        nodeBranch: b,
        baseBranch: 'main',
        integrationRoot: root,
      }),
    ).toThrow(/dirty/i);
  });
});
