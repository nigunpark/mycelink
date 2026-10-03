/**
 * Path-safety hardening.
 *
 * Every path that comes from a graph, a hook payload, a CLI argument or a
 * configuration file is untrusted. These tests pin the rules that keep such a
 * path inside the place it is allowed to name.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  classifyLocationPath,
  classifyRelativePath,
  isInsideReal,
  resolveInside,
  UnsafePathError,
} from '../../src/security/paths.js';
import { validateGraph } from '../../src/graph/validate.js';
import { validateRepositories } from '../../src/graph/validate.js';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { clone, VALID_GRAPH } from '../helpers/graph-fixtures.js';

afterEach(() => cleanupTmpRoots());

/** Create a directory symlink, or a junction on Windows (no admin needed). */
function linkDir(target: string, link: string): void {
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

describe('classifyRelativePath', () => {
  it.each([
    ['src/app.ts', null],
    ['src/**', null],
    ['tests/unit/*.test.ts', null],
    ['./src/a.ts', null],
    ['a/../b', null],
  ])('accepts %s', (p, expected) => {
    expect(classifyRelativePath(p)).toBe(expected);
  });

  it.each([
    ['', 'EMPTY'],
    ['..', 'TRAVERSAL'],
    ['../sibling/file', 'TRAVERSAL'],
    ['src/../../escape', 'TRAVERSAL'],
    ['src\\..\\..\\escape', 'TRAVERSAL'],
    ['/etc/passwd', 'ABSOLUTE'],
    ['\\Windows\\System32', 'ABSOLUTE'],
    ['C:\\Windows\\System32', 'ABSOLUTE'],
    ['c:/Users/someone', 'ABSOLUTE'],
    ['C:relative-to-drive-cwd', 'DRIVE_RELATIVE'],
    ['\\\\server\\share\\file', 'UNC'],
    ['//server/share/file', 'UNC'],
    ['\\\\?\\C:\\very\\long\\path', 'EXTENDED_LENGTH'],
    ['//?/C:/very/long/path', 'EXTENDED_LENGTH'],
    ['\\\\.\\PhysicalDrive0', 'DEVICE'],
    ['//./pipe/name', 'DEVICE'],
    ['src/CON', 'RESERVED_NAME'],
    ['src/nul.txt', 'RESERVED_NAME'],
    ['COM1', 'RESERVED_NAME'],
    ['lpt9.log', 'RESERVED_NAME'],
    ['src/file.txt:hidden', 'ALTERNATE_STREAM'],
    ['src/a\u0000b', 'NUL_BYTE'],
  ])('rejects %j as %s', (p, code) => {
    expect(classifyRelativePath(p)).toBe(code);
  });
});

describe('classifyLocationPath (configured repository locations)', () => {
  it('allows ordinary relative and absolute locations', () => {
    expect(classifyLocationPath('../core')).toBeNull();
    expect(classifyLocationPath('/srv/repos/core')).toBeNull();
    expect(classifyLocationPath('C:\\work\\core')).toBeNull();
  });

  it.each([
    ['\\\\server\\share\\core', 'UNC'],
    ['\\\\?\\C:\\work\\core', 'EXTENDED_LENGTH'],
    ['\\\\.\\C:', 'DEVICE'],
    ['repos/NUL', 'RESERVED_NAME'],
    ['core\u0000', 'NUL_BYTE'],
    ['', 'EMPTY'],
  ])('rejects %j as %s', (p, code) => {
    expect(classifyLocationPath(p)).toBe(code);
  });
});

describe('symlink and junction escapes', () => {
  it('rejects a path that leaves the root through a linked directory', () => {
    const base = makeTmpDir('paths-');
    const root = join(base, 'root');
    const outside = join(base, 'outside');
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'secret.txt'), 'x');
    linkDir(outside, join(root, 'link'));

    expect(isInsideReal(root, join(root, 'link', 'secret.txt'))).toBe(false);
    expect(() => resolveInside(root, 'link/secret.txt')).toThrow(UnsafePathError);
  });

  it('rejects a not-yet-existing file below a linked directory', () => {
    const base = makeTmpDir('paths-');
    const root = join(base, 'root');
    const outside = join(base, 'outside');
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    linkDir(outside, join(root, 'link'));

    expect(isInsideReal(root, join(root, 'link', 'new', 'file.ts'))).toBe(false);
  });

  it('accepts real paths, existing or not, that stay inside the root', () => {
    const root = makeTmpDir('paths-');
    mkdirSync(join(root, 'src'), { recursive: true });
    expect(isInsideReal(root, join(root, 'src', 'new.ts'))).toBe(true);
    expect(resolveInside(root, 'src/new.ts')).toContain('new.ts');
  });

  it('accepts a link whose target is still inside the root', () => {
    const root = makeTmpDir('paths-');
    mkdirSync(join(root, 'real'), { recursive: true });
    linkDir(join(root, 'real'), join(root, 'alias'));
    expect(isInsideReal(root, join(root, 'alias', 'x.ts'))).toBe(true);
  });

  it('refuses relative escapes before touching the filesystem', () => {
    const root = makeTmpDir('paths-');
    expect(() => resolveInside(root, '../x')).toThrow(/TRAVERSAL/);
    expect(() => resolveInside(root, '\\\\server\\share')).toThrow(/UNC/);
  });
});

describe('graph and manifest validation use the hardened rules', () => {
  it('rejects UNC, device and extended-length allowed_paths', () => {
    for (const bad of ['\\\\server\\share\\**', '\\\\?\\C:\\src\\**', '\\\\.\\pipe\\x', 'src/CON']) {
      const g = clone(VALID_GRAPH);
      (g.nodes[0] as { allowed_paths: string[] }).allowed_paths = [bad];
      const result = validateGraph(g);
      expect(result.ok, bad).toBe(false);
      expect(result.problems.map((p) => p.code), bad).toContain('PATH_ESCAPES_REPOSITORY');
    }
  });

  it('rejects a repository located on a UNC or device path', () => {
    const result = validateRepositories({
      schema_version: 1,
      repositories: [
        { name: 'core', path: '\\\\attacker\\share\\core', base_branch: 'main', commands: { test: ['node', '-v'] } },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.problems.map((p) => p.code)).toContain('UNSAFE_REPOSITORY_PATH');
  });
});
