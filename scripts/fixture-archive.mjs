#!/usr/bin/env node
/**
 * The benchmark's deep recorded run trees, kept as deterministic archives.
 *
 * Two fixture trees copied from public-project runs, `cset201-final` and
 * `pcm101-final`, hold paths of up to 181 characters: the run's evidence
 * layout under `features/<id>/evidence/...`, and the evaluated projects' test
 * sources at their own depth. `claude plugin marketplace add` clones this
 * repository, and on Windows Git refuses such a path unless `core.longpaths`
 * is set (tests/release/marketplace-checkout.test.ts). Each tree is therefore
 * one short-named, uncompressed POSIX ustar archive,
 * `tests/benchmark/fixtures/<name>.tar`, beside a manifest of what it holds,
 * `<name>.manifest.json`: the archive's size and SHA-256, and each file's
 * path, size, SHA-256 and Git blob id. Tests extract an archive into a short
 * temporary directory (tests/helpers/fixture-archive.ts) and read its files
 * byte for byte as the run left them.
 *
 * Packing is deterministic: regular files only, sorted by path, mode 0644,
 * uid and gid 0, no owner names, time 0, no compression. The same tree always
 * packs to the same bytes, and every check packs the files again and
 * compares. Reading is strict. These are refused before anything is written:
 * a header with a bad checksum; any entry but a regular file (a link, a
 * directory, a device, a pax or GNU extension); an absolute, `.`, `..` or
 * backslash path; a name Windows would alias (a device name, a trailing dot,
 * a case-only duplicate); a byte the manifest does not account for.
 *
 *   node scripts/fixture-archive.mjs check [<name>...]     verify archives against their manifests (all by default)
 *   node scripts/fixture-archive.mjs extract <name> <dir>  extract one into a new or empty directory
 *   node scripts/fixture-archive.mjs pack <name> <dir>     write <name>.tar and <name>.manifest.json from a tree
 */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Where the archives and their manifests live. */
export const FIXTURES = join(ROOT, 'tests', 'benchmark', 'fixtures');
export const FORMAT = 'mycelink-fixture-archive/1';

const BLOCK = 512;
const NAME = /^[a-z0-9][a-z0-9-]*$/;
const SEGMENT = /^[A-Za-z0-9._@+-]+$/;
const DEVICE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** The id Git gives the same bytes as a blob: an archived file can be compared with the tree it came from. */
const gitBlob = (bytes) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

/** Why `path` cannot name an archived file, or null. */
export function unsafePath(path) {
  if (typeof path !== 'string' || path === '') return 'an empty path';
  if (path.length > 255) return 'longer than a ustar header holds';
  for (const s of path.split('/')) {
    if (s === '') return 'an empty segment (an absolute path, or a doubled or trailing slash)';
    if (s === '.' || s === '..') return `a "${s}" segment`;
    if (!SEGMENT.test(s)) return `a character outside [A-Za-z0-9._@+-] in "${s}"`;
    if (s.endsWith('.')) return `"${s}", a name Windows strips the trailing dot from`;
    if (DEVICE.test(s)) return `"${s}", a Windows device name`;
  }
  return null;
}

/** Files as an archive may hold them: safe paths, sorted, no two alike on a case-insensitive disk, no file under another. */
function checkPaths(paths) {
  const seen = new Map();
  for (const [i, p] of paths.entries()) {
    const why = unsafePath(p);
    if (why !== null) throw new Error(`${JSON.stringify(p)}: ${why}`);
    if (i > 0 && !(paths[i - 1] < p)) throw new Error(`${p}: not after ${paths[i - 1]} (files are sorted by path, each once)`);
    const key = p.toLowerCase();
    if (seen.has(key)) throw new Error(`${p}: the same file as ${seen.get(key)} on a case-insensitive disk`);
    seen.set(key, p);
  }
  for (const p of paths) {
    const parts = p.toLowerCase().split('/');
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/');
      if (seen.has(parent)) throw new Error(`${p}: under ${seen.get(parent)}, which is a file`);
    }
  }
}

/** `n` as `width - 1` octal digits and a NUL. */
function octal(n, width) {
  const s = n.toString(8).padStart(width - 1, '0');
  if (s.length !== width - 1) throw new Error(`${n} does not fit a ${width}-byte header field`);
  return `${s}\0`;
}

/** The ustar prefix and name of a path: the name alone when it fits, else the shortest prefix that lets it fit. */
function splitPath(path) {
  if (path.length <= 100) return ['', path];
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) {
    const prefix = parts.slice(0, i).join('/');
    const name = parts.slice(i).join('/');
    if (prefix.length <= 155 && name.length <= 100) return [prefix, name];
  }
  throw new Error(`${path}: no ustar prefix/name split fits`);
}

const checksum = (h) => {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
  return sum;
};

function header(path, size) {
  const h = Buffer.alloc(BLOCK);
  const [prefix, name] = splitPath(path);
  h.write(name, 0, 'latin1');
  h.write(octal(0o644, 8), 100, 'latin1');
  h.write(octal(0, 8), 108, 'latin1');
  h.write(octal(0, 8), 116, 'latin1');
  h.write(octal(size, 12), 124, 'latin1');
  h.write(octal(0, 12), 136, 'latin1');
  h.write('0', 156, 'latin1');
  h.write('ustar\0' + '00', 257, 'latin1');
  h.write(octal(0, 8), 329, 'latin1');
  h.write(octal(0, 8), 337, 'latin1');
  h.write(prefix, 345, 'latin1');
  h.write(`${checksum(h).toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  return h;
}

/** The archive of `files` ({ path, data }, sorted by path): each header and its data padded to a block, then two empty blocks. */
export function packFiles(files) {
  checkPaths(files.map((f) => f.path));
  const chunks = [];
  for (const { path, data } of files) {
    chunks.push(header(path, data.length), data, Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK));
  }
  chunks.push(Buffer.alloc(2 * BLOCK));
  return Buffer.concat(chunks);
}

/** A NUL-terminated header field. */
const field = (h, at, len) => {
  const raw = h.toString('latin1', at, at + len);
  const end = raw.indexOf('\0');
  return end === -1 ? raw : raw.slice(0, end);
};

function octalField(h, at, len, what) {
  const s = field(h, at, len).trim();
  if (!/^[0-7]+$/.test(s)) throw new Error(`${what}: not an octal number`);
  return parseInt(s, 8);
}

/** The files of an archive this module packs, read strictly: anything else is refused, nothing is skipped. */
export function readTar(bytes) {
  if (bytes.length % BLOCK !== 0) throw new Error('not a whole number of 512-byte blocks');
  const files = [];
  let at = 0;
  for (;;) {
    if (at + 2 * BLOCK > bytes.length) throw new Error('truncated: no end-of-archive marker');
    const h = bytes.subarray(at, at + BLOCK);
    if (h.every((b) => b === 0)) {
      if (at + 2 * BLOCK !== bytes.length || !bytes.subarray(at).every((b) => b === 0)) throw new Error('bytes after the end-of-archive marker');
      break;
    }
    const what = `entry ${files.length + 1}`;
    if (octalField(h, 148, 8, `${what} checksum`) !== checksum(h)) throw new Error(`${what}: header checksum mismatch`);
    if (h.toString('latin1', 257, 265) !== 'ustar\0' + '00') throw new Error(`${what}: not a POSIX ustar header`);
    const type = h.toString('latin1', 156, 157);
    if (type !== '0') throw new Error(`${what}: type ${JSON.stringify(type)}, not a regular file (links, directories, devices and pax or GNU extensions are refused)`);
    if (field(h, 157, 100) !== '') throw new Error(`${what}: names a link target`);
    const prefix = field(h, 345, 155);
    const name = field(h, 0, 100);
    const path = prefix === '' ? name : `${prefix}/${name}`;
    const size = octalField(h, 124, 12, `${what} size`);
    const start = at + BLOCK;
    const next = start + Math.ceil(size / BLOCK) * BLOCK;
    if (next + 2 * BLOCK > bytes.length) throw new Error(`${path}: truncated`);
    if (!bytes.subarray(start + size, next).every((b) => b === 0)) throw new Error(`${path}: padding is not zero`);
    files.push({ path, data: Buffer.from(bytes.subarray(start, start + size)) });
    at = next;
  }
  checkPaths(files.map((f) => f.path));
  return files;
}

/** What a manifest records of each file. */
export const describeFiles = (files) => files.map(({ path, data }) => ({ path, bytes: data.length, sha256: sha256(data), git_blob: gitBlob(data) }));

function manifestOf(name, files, bytes) {
  return { format: FORMAT, archive: `${name}.tar`, bytes: bytes.length, sha256: sha256(bytes), files: describeFiles(files) };
}

function checkName(name) {
  if (!NAME.test(name)) throw new Error(`${JSON.stringify(name)}: not an archive name ([a-z0-9-])`);
}

/** The names of the archives in `dir`: each `<name>.tar` (its manifest is checked when it is read). */
export function listArchives(dir = FIXTURES) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.tar'))
    .map((f) => f.slice(0, -'.tar'.length))
    .sort();
}

/**
 * One archive, verified: its bytes are the size and SHA-256 its manifest gives, it reads strictly, its files are
 * exactly the manifest's (path, size, SHA-256, blob id, in order), and packing them again yields the same bytes.
 */
export function verifyArchive(name, dir = FIXTURES) {
  checkName(name);
  const bytes = readFileSync(join(dir, `${name}.tar`));
  const manifest = JSON.parse(readFileSync(join(dir, `${name}.manifest.json`), 'utf8'));
  if (manifest.format !== FORMAT || manifest.archive !== `${name}.tar`) throw new Error(`${name}.manifest.json: not a ${FORMAT} manifest of ${name}.tar`);
  if (bytes.length !== manifest.bytes || sha256(bytes) !== manifest.sha256) {
    throw new Error(`${name}.tar: ${bytes.length} bytes, SHA-256 ${sha256(bytes)}; its manifest says ${manifest.bytes} bytes, ${manifest.sha256}`);
  }
  const files = readTar(bytes);
  const key = (f) => JSON.stringify([f.path, f.bytes, f.sha256, f.git_blob]);
  const got = describeFiles(files).map(key);
  const listed = (Array.isArray(manifest.files) ? manifest.files : []).map(key);
  if (got.length !== listed.length || got.some((k, i) => k !== listed[i])) {
    const extra = got.filter((k) => !listed.includes(k)).map((k) => JSON.parse(k)[0]);
    const missing = listed.filter((k) => !got.includes(k)).map((k) => JSON.parse(k)[0]);
    throw new Error(`${name}.tar: its files are not its manifest's (in the archive only or changed: ${extra.join(', ') || 'none'}; in the manifest only or changed: ${missing.join(', ') || 'none'}; or out of order)`);
  }
  if (!packFiles(files).equals(bytes)) throw new Error(`${name}.tar: not the deterministic packing of its own files`);
  return { manifest, files };
}

/**
 * Extract a verified archive into `dest` (created if absent, else it must be an empty real directory). Every path
 * resolves inside `dest`; directories are made one by one and must be real directories; files are created, never
 * overwritten. Returns the extracted paths.
 */
export function extractArchive(name, dest, dir = FIXTURES) {
  const { files } = verifyArchive(name, dir);
  const root = resolve(dest);
  mkdirSync(root, { recursive: true });
  if (!lstatSync(root).isDirectory()) throw new Error(`${root}: not a directory`);
  if (readdirSync(root).length !== 0) throw new Error(`${root}: not empty`);
  for (const { path, data } of files) {
    const segments = path.split('/');
    const target = resolve(root, ...segments);
    if (!target.startsWith(root + sep)) throw new Error(`${path}: resolves outside ${root}`);
    let parent = root;
    for (const s of segments.slice(0, -1)) {
      parent = join(parent, s);
      let st = null;
      try {
        st = lstatSync(parent);
      } catch {
        mkdirSync(parent);
        continue;
      }
      if (!st.isDirectory()) throw new Error(`${path}: ${parent} is not a directory`);
    }
    writeFileSync(target, data, { flag: 'wx', mode: 0o644 });
  }
  return files.map((f) => f.path);
}

/** A regular file's bytes through one descriptor: never a link followed (where the platform can refuse one), never anything but a file. */
function readRegular(full, path) {
  const fd = openSync(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`${path}: not a regular file`);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Every regular file under `src` as { path, data }, sorted by path; a link or any other kind of entry is refused. */
export function readTree(src) {
  const root = resolve(src);
  const files = [];
  const walk = (abs, rel) => {
    for (const entry of readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(abs, entry.name);
      const path = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(full, path);
      else if (entry.isFile()) files.push({ path, data: readRegular(full, path) });
      else throw new Error(`${path}: not a regular file or directory`);
    }
  };
  walk(root, '');
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Write `<name>.tar` and `<name>.manifest.json` into `dir`; returns the manifest. */
export function writeArchive(name, files, dir = FIXTURES) {
  checkName(name);
  const bytes = packFiles(files);
  const manifest = manifestOf(name, files, bytes);
  writeFileSync(join(dir, `${name}.tar`), bytes);
  writeFileSync(join(dir, `${name}.manifest.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const out = (s) => process.stdout.write(`${s}\n`);
  if (cmd === 'check') {
    for (const name of rest.length > 0 ? rest : listArchives()) {
      const { manifest } = verifyArchive(name);
      out(`${name}.tar: ok, ${manifest.files.length} files, ${manifest.bytes} bytes, sha256 ${manifest.sha256}`);
    }
    return 0;
  }
  if (cmd === 'extract' && rest.length === 2) {
    const paths = extractArchive(rest[0], rest[1]);
    out(`${rest[0]}.tar: extracted ${paths.length} files into ${resolve(rest[1])}`);
    return 0;
  }
  if (cmd === 'pack' && rest.length === 2) {
    const manifest = writeArchive(rest[0], readTree(rest[1]));
    out(`${manifest.archive}: ${manifest.files.length} files, ${manifest.bytes} bytes, sha256 ${manifest.sha256}`);
    return 0;
  }
  process.stderr.write('usage: fixture-archive.mjs check [<name>...] | extract <name> <dir> | pack <name> <dir>\n');
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
