/**
 * The benchmark's archived run trees (scripts/fixture-archive.mjs).
 *
 * Each archive is exactly what its manifest says, and it is the deterministic
 * packing of its own files. It is extracted only into a short temporary
 * directory outside the repository, and the tree it replaced is no longer
 * tracked. An unsafe or inconsistent archive is refused before anything is
 * written: path traversal, a link, a name Windows would alias, a byte the
 * manifest does not account for, a destination that is not empty.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
// @ts-expect-error -- plain ESM script without type declarations
import { FIXTURES, describeFiles, extractArchive, listArchives, packFiles, readTar, readTree, verifyArchive, writeArchive } from '../../scripts/fixture-archive.mjs';
import { fixtureTree } from '../helpers/fixture-archive.js';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';

afterAll(() => cleanupTmpRoots());

const ROOT = resolve(process.cwd());
const ARCHIVES = ['cset201-final', 'pcm101-final'];
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
type File = { path: string; data: Buffer };
type Manifest = { format: string; archive: string; bytes: number; sha256: string; files: { path: string; bytes: number; sha256: string; git_blob: string }[] };

function tracked(): string[] {
  const ls = spawnSync('git', ['ls-files', '-z', '--', 'tests/benchmark/fixtures'], { cwd: ROOT, encoding: 'utf8' });
  if (ls.status !== 0) throw new Error(`git ls-files failed: ${ls.stderr}`);
  return ls.stdout.split('\0').filter((f) => f !== '');
}

describe('the fixture archives', () => {
  it('stand in for the deep recorded trees, each beside its manifest; the trees are no longer tracked', () => {
    const files = tracked();
    expect(listArchives()).toEqual(expect.arrayContaining(ARCHIVES));
    for (const name of listArchives() as string[]) {
      expect(files).toEqual(expect.arrayContaining([`tests/benchmark/fixtures/${name}.tar`, `tests/benchmark/fixtures/${name}.manifest.json`]));
      expect(files.filter((f) => f.startsWith(`tests/benchmark/fixtures/${name}/`)), name).toEqual([]);
    }
    expect(files.filter((f) => f.endsWith('.manifest.json')).map((f) => f.slice('tests/benchmark/fixtures/'.length, -'.manifest.json'.length))).toEqual(listArchives());
  });

  it('are binary to Git: no line-ending conversion touches their bytes', () => {
    for (const name of ARCHIVES) {
      const attr = spawnSync('git', ['check-attr', 'text', '--', `tests/benchmark/fixtures/${name}.tar`], { cwd: ROOT, encoding: 'utf8' });
      expect(attr.stdout.trim()).toBe(`tests/benchmark/fixtures/${name}.tar: text: unset`);
    }
  });

  it.each(ARCHIVES)('%s.tar is its manifest byte for byte, the deterministic packing of its own files', (name) => {
    const bytes = readFileSync(join(FIXTURES, `${name}.tar`));
    const { manifest, files } = verifyArchive(name) as { manifest: Manifest; files: File[] };
    expect(manifest).toMatchObject({ format: 'mycelink-fixture-archive/1', archive: `${name}.tar`, bytes: bytes.length, sha256: sha256(bytes) });
    expect(describeFiles(files)).toEqual(manifest.files);
    expect(packFiles(files).equals(bytes)).toBe(true);
    // What the packer writes for the extracted tree is the committed archive and manifest, byte for byte.
    const out = makeTmpDir('fx-pack-');
    writeArchive(name, readTree(fixtureTree(name)), out);
    expect(readFileSync(join(out, `${name}.tar`)).equals(bytes)).toBe(true);
    expect(readFileSync(join(out, `${name}.manifest.json`), 'utf8')).toBe(readFileSync(join(FIXTURES, `${name}.manifest.json`), 'utf8'));
  });

  it.each(ARCHIVES)('%s extracts into a short temporary directory outside the repository: exactly its files, byte for byte', (name) => {
    const dir = fixtureTree(name);
    const rel = relative(ROOT, dir);
    expect(rel.startsWith('..') || isAbsolute(rel), dir).toBe(true);
    expect(dir.length).toBeLessThanOrEqual(resolve(tmpdir()).length + 'mlfx-XXXXXX'.length + 1);
    const { manifest } = verifyArchive(name) as { manifest: Manifest };
    expect(describeFiles(readTree(dir))).toEqual(manifest.files);
  });

  it('pass the command-line check', () => {
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'fixture-archive.mjs'), 'check'], { cwd: ROOT, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    for (const name of ARCHIVES) expect(r.stdout).toContain(`${name}.tar: ok`);
  });
});

/** A ustar header holding exactly the fields given, its checksum computed unless one is given. */
function header(o: { name: string; size?: number; type?: string; link?: string; mtime?: string; magic?: string; checksum?: number }): Buffer {
  const h = Buffer.alloc(512);
  const put = (s: string, at: number) => h.write(s, at, 'latin1');
  put(o.name, 0);
  put('0000644\0', 100);
  put('0000000\0', 108);
  put('0000000\0', 116);
  put(`${(o.size ?? 0).toString(8).padStart(11, '0')}\0`, 124);
  put(o.mtime ?? '00000000000\0', 136);
  put(o.type ?? '0', 156);
  put(o.link ?? '', 157);
  put(o.magic ?? 'ustar\u000000', 257);
  put('0000000\0', 329);
  put('0000000\0', 337);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!;
  put(`${(o.checksum ?? sum).toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}
const entry = (h: Buffer, data = Buffer.alloc(0), pad = 0): Buffer => Buffer.concat([h, data, Buffer.alloc((512 - (data.length % 512)) % 512, pad)]);
const file = (name: string, text = '{}\n'): Buffer => entry(header({ name, size: Buffer.byteLength(text) }), Buffer.from(text));
const tar = (...entries: Buffer[]): Buffer => Buffer.concat([...entries, Buffer.alloc(1024)]);

/** `bytes` as archive `name` in a directory of its own, with the manifest of exactly those bytes (and `files`). */
function staged(name: string, bytes: Buffer, files: Manifest['files'] = []): string {
  const dir = makeTmpDir('fx-bad-');
  writeFileSync(join(dir, `${name}.tar`), bytes);
  writeFileSync(join(dir, `${name}.manifest.json`), JSON.stringify({ format: 'mycelink-fixture-archive/1', archive: `${name}.tar`, bytes: bytes.length, sha256: sha256(bytes), files }));
  return dir;
}

/** Extracting archive `name` from `dir` is refused with `why`, and nothing is written: not into the destination, not beside it. */
function refused(name: string, dir: string, why: RegExp): void {
  const parent = makeTmpDir('fx-dest-');
  const dest = join(parent, 'out');
  mkdirSync(dest);
  expect(() => extractArchive(name, dest, dir)).toThrow(why);
  expect(readdirSync(dest)).toEqual([]);
  expect(readdirSync(parent)).toEqual(['out']);
}

describe('an unsafe or inconsistent archive', () => {
  it("is read by the same rules it is written by: a well-formed header is the packer's own", () => {
    expect(tar(file('a.json')).equals(packFiles([{ path: 'a.json', data: Buffer.from('{}\n') }]))).toBe(true);
    expect(readTar(tar(file('d/a.json'), file('d/b.json')))).toEqual([
      { path: 'd/a.json', data: Buffer.from('{}\n') },
      { path: 'd/b.json', data: Buffer.from('{}\n') },
    ]);
  });

  it.each([
    ['a parent-directory segment', tar(file('../escape.json')), /"\.\." segment/],
    ['a parent-directory segment deeper in', tar(file('a/../../escape.json')), /"\.\." segment/],
    ['an absolute path', tar(file('/tmp/escape.json')), /empty segment/],
    ['a backslash', tar(file('a\\..\\..\\escape.json')), /character outside/],
    ['a drive', tar(file('C:/escape.json')), /character outside/],
    ['a current-directory segment', tar(file('a/./b.json')), /"\." segment/],
    ['a symbolic link', tar(entry(header({ name: 'link', type: '2', link: '../../outside' }))), /not a regular file/],
    ['a hard link', tar(file('a.json'), entry(header({ name: 'b.json', type: '1', link: 'a.json' }))), /not a regular file/],
    ['a directory entry', tar(entry(header({ name: 'dir/', type: '5' }))), /not a regular file/],
    ['a pax header', tar(entry(header({ name: 'PaxHeader', type: 'x', size: 26 }), Buffer.from('26 path=../../escape.json\n')), file('a.json')), /not a regular file/],
    ['a GNU long name', tar(entry(header({ name: '././@LongLink', type: 'L', size: 18 }), Buffer.from('../../escape.json\0')), file('a.json')), /not a regular file/],
    ['a link target on a regular file', tar(entry(header({ name: 'a.json', size: 3, link: '../b' }), Buffer.from('{}\n'))), /link target/],
    ['a file listed twice', tar(file('a.json'), file('a.json')), /not after/],
    ['a case-only twin', tar(file('A.json'), file('a.json')), /case-insensitive/],
    ['a file under a file', tar(file('a'), file('a/b.json')), /which is a file/],
    ['a Windows device name', tar(file('aux.json')), /device name/],
    ['a trailing dot', tar(file('a.')), /trailing dot/],
    ['a bad header checksum', tar(entry(header({ name: 'a.json', size: 3, checksum: 1 }), Buffer.from('{}\n'))), /checksum/],
    ['a pre-POSIX header', tar(entry(header({ name: 'a.json', size: 3, magic: '\0'.repeat(8) }), Buffer.from('{}\n'))), /ustar/],
    ['data in the padding', tar(entry(header({ name: 'a.json', size: 3 }), Buffer.from('{}\n'), 0x41)), /padding/],
    ['no end-of-archive marker', file('a.json'), /truncated/],
    ['bytes after the end-of-archive marker', Buffer.concat([tar(file('a.json')), Buffer.alloc(512, 1)]), /after the end-of-archive/],
  ] as const)('is refused for %s, before anything is written', (_what, bytes, why) => {
    expect(() => readTar(bytes)).toThrow(why);
    refused('bad', staged('bad', bytes), why);
  });

  it('is refused when a byte differs from what its manifest hashed', () => {
    const name = 'cset201-final';
    const bytes = Buffer.from(readFileSync(join(FIXTURES, `${name}.tar`)));
    bytes[600] = bytes[600]! ^ 0x20;
    const dir = makeTmpDir('fx-flip-');
    writeFileSync(join(dir, `${name}.tar`), bytes);
    writeFileSync(join(dir, `${name}.manifest.json`), readFileSync(join(FIXTURES, `${name}.manifest.json`)));
    refused(name, dir, /its manifest says/);
  });

  it('is refused when its manifest lists other files than it holds, though it hashes the archive', () => {
    const files = [{ path: 'a.json', data: Buffer.from('{}\n') }];
    const listed = describeFiles(files) as Manifest['files'];
    refused('bad', staged('bad', packFiles(files), [{ ...listed[0]!, sha256: '0'.repeat(64) }]), /not its manifest's/);
    refused('bad', staged('bad', packFiles(files), [...listed, { ...listed[0]!, path: 'b.json' }]), /not its manifest's/);
    refused('bad', staged('bad', packFiles(files), []), /not its manifest's/);
  });

  it('is refused when it is not the deterministic packing of its files: a time, a mode, an owner', () => {
    const data = Buffer.from('{}\n');
    const files = describeFiles([{ path: 'a.json', data }]) as Manifest['files'];
    refused('bad', staged('bad', tar(entry(header({ name: 'a.json', size: 3, mtime: '14710553462\0' }), data)), files), /deterministic packing/);
    const owned = header({ name: 'a.json', size: 3 });
    owned.write('alice', 265, 'latin1');
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : owned[i]!;
    owned.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
    refused('bad', staged('bad', tar(entry(owned, data)), files), /deterministic packing/);
  });

  it('is never extracted into a destination that holds anything, a link out of it included', () => {
    const outside = makeTmpDir('fx-outside-');
    const dest = makeTmpDir('fx-full-');
    symlinkSync(outside, join(dest, 'features'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => extractArchive('cset201-final', dest)).toThrow(/not empty/);
    expect(readdirSync(outside)).toEqual([]);
    expect(readdirSync(dest)).toEqual(['features']);
  });
});
