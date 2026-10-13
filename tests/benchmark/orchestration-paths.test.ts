/**
 * The registered repositories of a with-arm workspace are checked by place,
 * however the workspace was handed over (CI 38347201692: on macOS, and on
 * Windows' 8.3 temp names, every repository of a toy workspace read as
 * "outside the workspace": git names the real path, the harness the alias).
 * A repository whose real place is outside the workspace is still refused.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpRoots, linkedAlias, makeTmpDir } from '../helpers/tmp.js';
import { commitFiles, toyGit } from './toy-fixture.js';
// @ts-expect-error -- plain ESM module without type declarations
import { registeredRepositoryProblems } from '../../evals-public-projects/lib/orchestration.mjs';

afterAll(() => cleanupTmpRoots());

function workspace(): { ws: string; control: string } {
  const ws = join(makeTmpDir('bench-orch-'), 'workspace');
  const control = join(ws, 'platform');
  const repo = join(ws, 'repos', 'x');
  mkdirSync(control, { recursive: true });
  mkdirSync(repo, { recursive: true });
  toyGit(repo, ['init', '-q', '-b', 'main']);
  commitFiles(repo, { 'README.md': '# x\n' }, 'x: initial');
  // A worktree of its own, inside the workspace: git lists it by its real path.
  toyGit(repo, ['worktree', 'add', '-q', '-b', 'wip', join(ws, 'repos', 'x-wip')]);
  writeFileSync(join(control, 'repositories.yaml'), 'repositories:\n  - name: x\n    path: ../repos/x\n');
  return { ws, control };
}

describe('registered repositories, by place', () => {
  it('finds nothing wrong with a workspace handed over through a link (macOS /var, a junction): its repositories and worktrees are inside', () => {
    const { ws } = workspace();
    const handed = linkedAlias(ws, 'workspace');
    expect(registeredRepositoryProblems({ root: join(handed, 'platform'), workspace: handed })).toEqual([]);
  });

  it('still refuses a repository whose real place is outside the workspace, through a link inside it', () => {
    const { ws, control } = workspace();
    const outside = join(makeTmpDir('bench-orch-outside-'), 'repo');
    mkdirSync(outside, { recursive: true });
    toyGit(outside, ['init', '-q', '-b', 'main']);
    commitFiles(outside, { 'README.md': '# outside\n' }, 'outside: initial');
    symlinkSync(outside, join(ws, 'repos', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    writeFileSync(join(control, 'repositories.yaml'), 'repositories:\n  - name: linked\n    path: ../repos/linked\n');
    expect(registeredRepositoryProblems({ root: control, workspace: ws })).toEqual([expect.stringMatching(/^linked \(.*\) is outside the workspace$/)]);
  });
});
