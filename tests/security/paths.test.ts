/**
 * Path-safety hardening.
 *
 * Every path that comes from a graph, a hook payload, a CLI argument or a
 * configuration file is untrusted. These tests pin the rules that keep such a
 * path inside the place it is allowed to name.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  canonicalPath,
  classifyLocationPath,
  classifyRelativePath,
  isInsideReal,
  readRegular,
  resolveInside,
  samePath,
  UnsafePathError,
} from '../../src/security/paths.js';
import { validateGraph } from '../../src/graph/validate.js';
import { validateRepositories } from '../../src/graph/validate.js';
import { cleanupTmpRoots, makeTmpDir, windowsShortPathAlias } from '../helpers/tmp.js';
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

describe('path identity', () => {
  it('treats a linked alias of a directory as the same path', () => {
    const base = makeTmpDir('paths-');
    mkdirSync(join(base, 'real', 'wt'), { recursive: true });
    linkDir(join(base, 'real'), join(base, 'alias'));
    expect(samePath(join(base, 'alias', 'wt'), join(base, 'real', 'wt'))).toBe(true);
    // A not-yet-existing leaf below the alias resolves the same way.
    expect(samePath(join(base, 'alias', 'new'), join(base, 'real', 'new'))).toBe(true);
  });

  it('keeps distinct directories distinct, including a linked one', () => {
    const base = makeTmpDir('paths-');
    mkdirSync(join(base, 'a'), { recursive: true });
    mkdirSync(join(base, 'b'), { recursive: true });
    linkDir(join(base, 'b'), join(base, 'link-to-b'));
    expect(samePath(join(base, 'a'), join(base, 'b'))).toBe(false);
    expect(samePath(join(base, 'a'), join(base, 'link-to-b'))).toBe(false);
    expect(samePath(join(base, 'a'), join(base, 'a-sibling'))).toBe(false);
  });

  it.runIf(process.platform === 'win32')('ignores letter case on Windows', () => {
    const dir = makeTmpDir('paths-case-');
    expect(samePath(dir.toUpperCase(), dir.toLowerCase())).toBe(true);
  });

  it('treats a Windows 8.3 short-name alias as the same path', (ctx) => {
    const dir = makeTmpDir('paths-long-directory-name-');
    const short = windowsShortPathAlias(dir);
    if (short === null) return ctx.skip();
    expect(samePath(short, dir)).toBe(true);
    expect(samePath(join(short, 'not-yet'), join(dir, 'not-yet'))).toBe(true);
  });
});

describe('reading a regular file through one descriptor (no path looked at, then read again)', () => {
  it('reads a regular file, within its bound, with its mode', () => {
    const base = makeTmpDir('paths-read-');
    writeFileSync(join(base, 'a.json'), '{"x":1}');
    expect(readRegular(join(base, 'a.json'), 64)).toMatchObject({ bytes: Buffer.from('{"x":1}') });
    expect(typeof readRegular(join(base, 'a.json'), 64)!.mode).toBe('number');
  });

  it('reads nothing that is absent, a directory, larger than its bound, or reached through a link', () => {
    const base = makeTmpDir('paths-read-');
    mkdirSync(join(base, 'dir'));
    writeFileSync(join(base, 'big'), 'x'.repeat(65));
    writeFileSync(join(base, 'target'), 'secret');
    linkDir(join(base, 'dir'), join(base, 'dir-link'));
    expect(readRegular(join(base, 'missing'), 64)).toBeNull();
    expect(readRegular(join(base, 'dir'), 64)).toBeNull();
    expect(readRegular(join(base, 'big'), 64)).toBeNull();
    expect(readRegular(join(base, 'dir-link'), 64)).toBeNull();
    // A file link (POSIX; creating one needs a privilege on Windows).
    if (process.platform !== 'win32') {
      symlinkSync(join(base, 'target'), join(base, 'file-link'));
      expect(readRegular(join(base, 'file-link'), 64)).toBeNull();
    }
  });

  it.runIf(process.platform !== 'win32')('never blocks on a FIFO put where a file was expected', () => {
    const base = makeTmpDir('paths-read-');
    execFileSync('mkfifo', [join(base, 'fifo')]);
    expect(readRegular(join(base, 'fifo'), 64)).toBeNull();
  });
});

describe('canonical names (one spelling per place: macOS /var is /private/var, C:\\Users\\RUNNER~1 is C:\\Users\\runneradmin)', () => {
  it('names a file, a directory and a path not made yet by their real place, whichever link reached them', () => {
    const base = makeTmpDir('paths-canon-');
    mkdirSync(join(base, 'real', 'dir'), { recursive: true });
    writeFileSync(join(base, 'real', 'file.txt'), 'x');
    linkDir(join(base, 'real'), join(base, 'alias'));
    const real = realpathSync.native(join(base, 'real'));
    expect(canonicalPath(join(base, 'real'))).toBe(real);
    for (const rel of ['dir', 'file.txt', join('not', 'yet.txt')]) {
      expect(canonicalPath(join(base, 'alias', rel)), rel).toBe(join(real, rel));
      expect(canonicalPath(join(base, 'real', rel)), rel).toBe(join(real, rel));
    }
  });

  it('names a link by itself, in its real directory, never by what it points to', () => {
    const base = makeTmpDir('paths-canon-');
    mkdirSync(join(base, 'real', 'target'), { recursive: true });
    linkDir(join(base, 'real', 'target'), join(base, 'real', 'link'));
    linkDir(join(base, 'real'), join(base, 'alias'));
    const real = realpathSync.native(join(base, 'real'));
    expect(canonicalPath(join(base, 'alias'))).toBe(join(realpathSync.native(base), 'alias'));
    expect(canonicalPath(join(base, 'alias', 'link'))).toBe(join(real, 'link'));
    // Below the link, its target is the place.
    expect(canonicalPath(join(base, 'alias', 'link', 'x'))).toBe(join(real, 'target', 'x'));
  });

  it('expands a Windows 8.3 short name, the last component included', (ctx) => {
    const dir = makeTmpDir('paths-long-directory-name-');
    mkdirSync(join(dir, 'a long child name'));
    const short = windowsShortPathAlias(join(dir, 'a long child name'));
    if (short === null) return ctx.skip();
    const long = realpathSync.native(join(dir, 'a long child name'));
    expect(canonicalPath(short)).toBe(long);
    expect(canonicalPath(join(short, 'new.json'))).toBe(join(long, 'new.json'));
  });

  it('keeps containment as strict as before: a canonical name is only a name, a link out of the root still escapes', () => {
    const base = makeTmpDir('paths-canon-');
    mkdirSync(join(base, 'root'), { recursive: true });
    mkdirSync(join(base, 'outside'), { recursive: true });
    linkDir(join(base, 'outside'), join(base, 'root', 'escape'));
    expect(canonicalPath(join(base, 'root', 'escape', 'x'))).toBe(join(realpathSync.native(join(base, 'outside')), 'x'));
    expect(isInsideReal(join(base, 'root'), join(base, 'root', 'escape', 'x'))).toBe(false);
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
