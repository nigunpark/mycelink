/**
 * The suite a run or verdict rests on is pinned to a commit and sealed:
 * a suite with uncommitted changes, at an unexpected commit or outside Git
 * is refused, and the sealed export holds exactly the committed tree.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { commitFiles, toyGit } from './toy-fixture.js';
// @ts-expect-error -- plain ESM module without type declarations
import { pinRecord, pinSuite, sealSuite } from '../../evals-public-projects/lib/suite-pin.mjs';

afterAll(() => cleanupTmpRoots());

function checkout() {
  const repo = makeTmpDir('bench-pin-');
  toyGit(repo, ['init', '-q', '-b', 'main']);
  writeFileSync(join(repo, '.gitignore'), 'suite/.local/\n');
  commitFiles(repo, { 'suite/projects/p/adapter.json': '{"v":1}\n', 'suite/schemas/s.json': '{}\n', 'other/file.txt': 'x\n' }, 'suite');
  return { repo, suite: join(repo, 'suite') };
}

describe('pinSuite / sealSuite', () => {
  it('pins a clean suite to its commit and tree, and seals exactly the committed tree', () => {
    const { repo, suite } = checkout();
    mkdirSync(join(suite, '.local'));
    writeFileSync(join(suite, '.local', 'cache-root'), '/somewhere\n'); // ignored: not a change
    writeFileSync(join(repo, 'other', 'file.txt'), 'changed outside the suite\n'); // outside the suite directory
    const r = pinSuite(suite);
    expect(r.problems).toEqual([]);
    expect(r.pin).toMatchObject({ commit: toyGit(repo, ['rev-parse', 'HEAD']), path: 'suite', tree: toyGit(repo, ['rev-parse', 'HEAD:suite']) });
    expect(pinRecord(r.pin)).toEqual({ commit: r.pin.commit, path: 'suite', tree: r.pin.tree, clean: true });
    const sealed = sealSuite(r.pin);
    expect(readFileSync(join(sealed, 'projects', 'p', 'adapter.json'), 'utf8')).toBe('{"v":1}\n');
    expect(existsSync(join(sealed, '.local'))).toBe(false);
  });

  it('refuses a suite with uncommitted or untracked changes, at an unexpected commit, or outside Git', () => {
    const { repo, suite } = checkout();
    const commit = toyGit(repo, ['rev-parse', 'HEAD']);
    expect(pinSuite(suite, { expectCommit: commit }).ok).toBe(true);
    expect(pinSuite(suite, { expectCommit: 'f'.repeat(40) }).problems.join('\n')).toMatch(/expected f{40}/);
    writeFileSync(join(suite, 'projects', 'p', 'adapter.json'), '{"v":2}\n');
    expect(pinSuite(suite).problems.join('\n')).toMatch(/uncommitted changes \(suite\/projects\/p\/adapter.json\)/);
    toyGit(repo, ['checkout', '-q', '--', '.']);
    writeFileSync(join(suite, 'projects', 'p', 'qualification.json'), '{}\n');
    expect(pinSuite(suite).ok).toBe(false);
    expect(pinSuite(makeTmpDir('bench-pin-nogit-')).problems.join('\n')).toMatch(/not in a Git checkout/);
  });
});
