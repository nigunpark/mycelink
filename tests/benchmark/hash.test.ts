/**
 * Hashing primitives of the public-project benchmark: canonical JSON for
 * hashing records, and git object ids computed in memory so the verifier
 * never has to write objects into a repository it is judging.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { git, makeGitRepo } from '../helpers/git-fixture.js';
// @ts-expect-error -- plain ESM module without type declarations
import { assertNoPathCollisions, assertSafeTreePath, canonicalJson, gitBlobSha, gitTreeSha, sha256Hex } from '../../evals-public-projects/lib/hash.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { exportTree } from '../../evals-public-projects/lib/git.mjs';

afterAll(() => cleanupTmpRoots());

describe('canonicalJson', () => {
  it('sorts object keys at every depth and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
  });

  it('refuses values that have no stable JSON form', () => {
    expect(() => canonicalJson({ a: undefined })).toThrow(/undefined/);
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(/finite/);
    expect(() => canonicalJson({ a: () => 1 })).toThrow(/function/);
  });

  it('hashes equal values equally regardless of key order', () => {
    expect(sha256Hex(canonicalJson({ x: 1, y: 2 }))).toBe(sha256Hex(canonicalJson({ y: 2, x: 1 })));
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('git object ids in memory', () => {
  it('computes blob and tree ids exactly as git does, including nested trees and the executable bit', () => {
    const repo = makeGitRepo(join(makeTmpDir('bench-hash-'), 'r'), {
      files: { 'a.txt': 'alpha\n', 'dir/b.txt': 'beta\n', 'dir/sub/c.txt': 'gamma\n', 'dir.txt': 'sorts after dir/\n' },
    });
    git(repo, ['update-index', '--chmod=+x', 'a.txt']);
    git(repo, ['commit', '-q', '-m', 'exec']);
    const expected = git(repo, ['rev-parse', 'HEAD^{tree}']);
    expect(gitBlobSha(Buffer.from('alpha\n'))).toBe(git(repo, ['rev-parse', 'HEAD:a.txt']));
    const entries = [
      { path: 'a.txt', mode: '100755', sha: gitBlobSha(Buffer.from('alpha\n')) },
      { path: 'dir/b.txt', mode: '100644', sha: gitBlobSha(Buffer.from('beta\n')) },
      { path: 'dir/sub/c.txt', mode: '100644', sha: gitBlobSha(Buffer.from('gamma\n')) },
      { path: 'dir.txt', mode: '100644', sha: gitBlobSha(Buffer.from('sorts after dir/\n')) },
    ];
    expect(gitTreeSha(entries)).toBe(expected);
    expect(gitTreeSha([...entries].reverse())).toBe(expected);
    const ls = execFileSync('git', ['ls-tree', '-r', 'HEAD'], { cwd: repo, encoding: 'utf8' });
    expect(ls).toContain('100755 blob');
  });

  it('refuses unsafe or duplicate paths instead of hashing them', () => {
    const sha = gitBlobSha(Buffer.from('x'));
    expect(() => gitTreeSha([{ path: '../escape', mode: '100644', sha }])).toThrow(/unsafe/);
    expect(() => gitTreeSha([{ path: 'a//b', mode: '100644', sha }])).toThrow(/unsafe/);
    expect(() => gitTreeSha([{ path: '.git/config', mode: '100644', sha }])).toThrow(/unsafe/);
    expect(() => gitTreeSha([{ path: 'a', mode: '100644', sha }, { path: 'a', mode: '100644', sha }])).toThrow(/duplicate/);
    expect(() => gitTreeSha([{ path: 'a', mode: '100644', sha }, { path: 'a/b', mode: '100644', sha }])).toThrow(/both a file and a directory/);
    expect(() => gitTreeSha([{ path: 'a', mode: '123456', sha }])).toThrow(/mode/);
  });

  it('hashes the empty tree as git does', () => {
    expect(gitTreeSha([])).toBe('4b825dc642cb6eb9a060e54bf8d69288fbee4904');
  });
});

describe('tree path guard', () => {
  // Names a Windows or macOS file system (or git's own NTFS/HFS+ protection) resolves to `.git`.
  const DOTGIT_ALIASES = [
    '.git',
    '.GIT',
    '.Git',
    '.git.',
    '.git ',
    '.git. . ',
    '.git::$INDEX_ALLOCATION',
    '.git:stream',
    'git~1',
    'GIT~1',
    '.g​it',
    '﻿.git',
    '.gi‍t',
    '.git­',
    '‎.git',
    '．git',
    '.ｇｉｔ',
    '.gıt',
  ];

  it('refuses every alias of .git, on every platform', () => {
    for (const platform of ['linux', 'win32', 'darwin']) {
      for (const alias of DOTGIT_ALIASES) {
        for (const path of [alias, `${alias}/config`, `dir/${alias}/hooks/post-checkout`]) {
          expect(() => assertSafeTreePath(path, { platform }), `${platform}: ${JSON.stringify(path)}`).toThrow(/unsafe tree path/);
        }
      }
    }
  });

  it('refuses control characters everywhere, and on Windows and macOS every name those file systems alias, reserve or ignore', () => {
    for (const platform of ['linux', 'win32', 'darwin']) {
      expect(() => assertSafeTreePath('a\u0001b', { platform })).toThrow(/unsafe tree path/);
      expect(() => assertSafeTreePath('a/b\u007f', { platform })).toThrow(/unsafe tree path/);
    }
    const aliased = ['dir./x', 'x ', 'a:b', 'src/file.txt::$DATA', 'PROGRA~1/x', 'a​b'];
    const reservedOnWindows = ['CON', 'nul.txt', 'src/com1.js', 'Lpt9', 'a<b', 'a"b', 'a|b', 'a?b', 'a*b'];
    for (const path of aliased) {
      expect(() => assertSafeTreePath(path, { platform: 'win32' }), path).toThrow(/unsafe tree path/);
      expect(() => assertSafeTreePath(path, { platform: 'darwin' }), path).toThrow(/unsafe tree path/);
    }
    for (const path of reservedOnWindows) expect(() => assertSafeTreePath(path, { platform: 'win32' }), path).toThrow(/unsafe tree path/);
    // On Linux they are ordinary, distinct names.
    for (const path of [...aliased, ...reservedOnWindows]) expect(assertSafeTreePath(path, { platform: 'linux' })).toEqual(path.split('/'));
  });

  it('refuses paths that would collide on a case- or normalization-insensitive file system', () => {
    const collisions = [
      ['A.txt', 'a.txt'],
      ['Dir/x.js', 'dir/y.js'],
      ['café.md', 'café.md'],
    ];
    for (const paths of collisions) {
      expect(() => assertNoPathCollisions(paths, { platform: 'win32' }), paths.join(' ')).toThrow(/collide/);
      expect(() => assertNoPathCollisions(paths, { platform: 'darwin' }), paths.join(' ')).toThrow(/collide/);
      expect(() => assertNoPathCollisions(paths, { platform: 'linux' })).not.toThrow();
    }
    expect(() => assertNoPathCollisions(['a/b.txt', 'a/c.txt', 'b/a.txt'], { platform: 'win32' })).not.toThrow();
  });

  it('makes exportTree fail closed on a tree whose paths alias each other on the host file system', () => {
    const repo = makeGitRepo(join(makeTmpDir('bench-hash-collide-'), 'r'), { files: { 'keep.txt': 'k\n' } });
    // Two paths a case-insensitive file system cannot hold apart, committed without a checkout.
    const blob = git(repo, ['hash-object', '-w', '--stdin']);
    git(repo, ['update-index', '--add', '--cacheinfo', `100644,${blob},Readme.md`]);
    git(repo, ['update-index', '--add', '--cacheinfo', `100644,${blob},README.md`]);
    const tree = git(repo, ['write-tree']);
    const commit = git(repo, ['commit-tree', tree, '-m', 'colliding names']);
    for (const platform of ['win32', 'darwin']) {
      expect(() => exportTree(repo, commit, join(makeTmpDir('bench-hash-export-'), 't'), { platform })).toThrow(/collide/);
    }
  });
});
