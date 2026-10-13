/**
 * Path safety.
 *
 * Paths arrive from graphs, hook payloads, CLI arguments and configuration
 * files, and every one of those is untrusted. Two kinds are distinguished:
 *
 *  - a *relative* path (or glob) that must stay inside a repository or
 *    worktree — `allowed_paths`, contract paths, hook edit targets;
 *  - a *location* that a human configured — a repository checkout, which may
 *    legitimately be absolute or a sibling (`../core`).
 *
 * Both refuse Windows namespace tricks (UNC shares, `\\?\` extended-length and
 * `\\.\` device paths), reserved device names (CON, NUL, COM1, ...), NUL bytes
 * and NTFS alternate data streams. Containment checks resolve symlinks and
 * junctions on the deepest existing ancestor, so a link inside a worktree that
 * points elsewhere cannot be used to write outside it.
 */
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, realpathSync, type BigIntStats } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export type PathProblem =
  | 'EMPTY'
  | 'NUL_BYTE'
  | 'ABSOLUTE'
  | 'DRIVE_RELATIVE'
  | 'UNC'
  | 'EXTENDED_LENGTH'
  | 'DEVICE'
  | 'RESERVED_NAME'
  | 'ALTERNATE_STREAM'
  | 'TRAVERSAL'
  | 'OUTSIDE_ROOT';

export class UnsafePathError extends Error {
  readonly code: PathProblem;
  readonly path: string;
  constructor(code: PathProblem, path: string, what = 'path') {
    super(`Unsafe ${what} (${code}): ${JSON.stringify(path).slice(0, 200)}`);
    this.name = 'UnsafePathError';
    this.code = code;
    this.path = path;
  }
}

const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)$/i;

/** Problems shared by every kind of path; null when none apply. */
function namespaceProblem(p: string): PathProblem | null {
  if (p === '') return 'EMPTY';
  if (p.includes('\u0000')) return 'NUL_BYTE';
  const s = p.replace(/\\/g, '/');
  if (s.startsWith('//?/') || s.startsWith('/??/')) return 'EXTENDED_LENGTH';
  if (s.startsWith('//./')) return 'DEVICE';
  if (s.startsWith('//')) return 'UNC';
  for (const segment of s.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') continue;
    // "nul.txt" is as much a device as "nul" on Windows.
    const stem = segment.replace(/[. ]+$/, '').split('.')[0] ?? '';
    if (RESERVED.test(stem)) return 'RESERVED_NAME';
  }
  return null;
}

/**
 * Classify a repository-relative path or glob. Returns null when it is safe.
 *
 * `**` and `*` are allowed (globs), `..` is allowed only while it stays
 * inside the root (`a/../b`).
 */
export function classifyRelativePath(p: string): PathProblem | null {
  const ns = namespaceProblem(p);
  if (ns !== null) return ns;
  const s = p.replace(/\\/g, '/');
  if (/^[A-Za-z]:\//.test(s)) return 'ABSOLUTE';
  if (/^[A-Za-z]:/.test(s)) return 'DRIVE_RELATIVE';
  if (s.startsWith('/')) return 'ABSOLUTE';
  if (s.includes(':')) return 'ALTERNATE_STREAM';
  let depth = 0;
  for (const part of s.split('/')) {
    if (part === '..') {
      depth--;
      if (depth < 0) return 'TRAVERSAL';
    } else if (part !== '.' && part !== '') {
      depth++;
    }
  }
  return null;
}

/**
 * Classify a configured location (a repository checkout). Relative and
 * absolute local paths are fine; network shares and device namespaces are not.
 */
export function classifyLocationPath(p: string): PathProblem | null {
  const ns = namespaceProblem(p);
  if (ns !== null) return ns;
  const s = p.replace(/\\/g, '/');
  // A drive letter is only legal as the very first component ("C:/x").
  const rest = /^[A-Za-z]:\//.test(s) ? s.slice(2) : s;
  if (rest.includes(':')) return /^[A-Za-z]:/.test(s) ? 'DRIVE_RELATIVE' : 'ALTERNATE_STREAM';
  return null;
}

export function assertSafeRelativePath(p: string, what = 'path'): void {
  const problem = classifyRelativePath(p);
  if (problem !== null) throw new UnsafePathError(problem, p, what);
}

/**
 * Real path of `p`, resolving links on the deepest ancestor that exists and
 * appending the not-yet-existing remainder lexically.
 */
export function realpathDeepest(p: string): string {
  let current = resolve(p);
  const tail: string[] = [];
  for (;;) {
    if (existsSync(current)) {
      let real: string;
      try {
        real = realpathSync.native(current);
      } catch {
        real = current;
      }
      return tail.length === 0 ? real : join(real, ...tail.reverse());
    }
    const parent = dirname(current);
    if (parent === current) return resolve(p);
    tail.push(current.slice(parent.length).replace(/^[\\/]+/, ''));
    current = parent;
  }
}

/**
 * The one name of the entry a path names: the real path of the directory it
 * is in (links and junctions resolved on the deepest existing ancestor,
 * Windows 8.3 names expanded) and its own last component. A link names
 * itself and is never followed; any other existing entry is named by its real
 * path, so an 8.3 name or another letter case in the last component is
 * expanded too. Two spellings of one place get one name: macOS hands out
 * `/var/...` for `/private/var/...`, GitHub's Windows runners
 * `C:\Users\RUNNER~1` for `C:\Users\runneradmin`, while git, a child's
 * working directory and a test runner name the real path.
 *
 * Only a name: containment is still decided by {@link isInsideReal}.
 */
export function canonicalPath(p: string): string {
  const abs = resolve(p);
  const parent = dirname(abs);
  if (parent === abs) return realpathDeepest(abs);
  let link = false;
  try {
    link = lstatSync(abs).isSymbolicLink();
  } catch {
    // not there (yet): named below its real directory
  }
  if (!link && existsSync(abs)) {
    try {
      return realpathSync.native(abs);
    } catch {
      // unreadable: named below its real directory
    }
  }
  return join(realpathDeepest(parent), basename(abs));
}

/**
 * True when `a` and `b` name the same filesystem location. Path text is not
 * identity: Windows hands out 8.3 short names (`C:\Users\RUNNER~1`) and is
 * case-insensitive, links alias directories, and git records its own
 * canonical form. Both sides are reduced to their real path first, so this
 * matches a location, never a mere prefix or spelling.
 */
export function samePath(a: string, b: string): boolean {
  const ra = realpathDeepest(a);
  const rb = realpathDeepest(b);
  return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

function lexicallyInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  if (rel === '') return true;
  return !rel.startsWith('..') && !isAbsolute(rel) && !rel.startsWith(sep);
}

/** True when `target` stays inside `root` after resolving every link. */
export function isInsideReal(root: string, target: string): boolean {
  if (namespaceProblem(target) !== null) return false;
  if (!lexicallyInside(resolve(root), resolve(target))) return false;
  return lexicallyInside(realpathDeepest(root), realpathDeepest(target));
}

/** Resolve a relative path inside `root`, or throw {@link UnsafePathError}. */
export function resolveInside(root: string, rel: string, what = 'path'): string {
  assertSafeRelativePath(rel, what);
  const target = resolve(root, rel);
  if (!isInsideReal(root, target)) throw new UnsafePathError('OUTSIDE_ROOT', rel, what);
  return target;
}

/**
 * True when `path`, looked up now without following a final link, names the
 * file behind an already opened descriptor (`opened` is its fstat), and that
 * file has no other name.
 *
 * Where an open follows a final link (Windows has no O_NOFOLLOW), a link
 * swapped in before the open and put back afterwards leaves a regular file at
 * the path while the descriptor reaches the link's target; comparing the
 * device and file id catches that. The link count is taken from the same
 * lookup, so a hard link added after the descriptor's fstat is seen too.
 *
 * A path lookup is not always a trustworthy source of the device: on Windows,
 * Node 22.12's libuv fills stat()/lstat() from GetFileInformationByName and
 * leaves `dev` at 0, while fstat() on a handle reports the volume serial. A
 * lookup that reports no device is therefore settled through a descriptor:
 * the path is opened again, its fstat must carry the opened file's device and
 * id, and a second lookup must still find the same unlinked regular file.
 * Nothing is read or written through that second descriptor. Path spelling
 * (8.3 short names, case) plays no part. Anything that cannot be looked up or
 * opened is false.
 */
export function namesOpenedFile(path: string, opened: BigIntStats): boolean {
  const before = plainFileAt(path, opened);
  if (before === null) return false;
  if (before.dev === opened.dev) return true;
  if (before.dev !== 0n) return false;
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch {
    return false;
  }
  let reached: BigIntStats;
  try {
    reached = fstatSync(fd, { bigint: true });
  } finally {
    closeSync(fd);
  }
  if (reached.dev !== opened.dev || reached.ino !== opened.ino) return false;
  return plainFileAt(path, opened) !== null;
}

/**
 * A regular file's bytes and mode, read through one descriptor, never a path
 * looked at and then opened again: opened without following a final link and
 * without blocking (a FIFO swapped in cannot hang the read); the descriptor
 * must be a regular file within `max` bytes, and the path, looked up again
 * without following it, must still name that very file (where the open
 * follows a final link — Windows has no O_NOFOLLOW — a link swapped in is
 * caught by its file id). At most `max` bytes are read however the file grows
 * meanwhile. Null for anything else: absent, a link, a directory, a device or
 * FIFO, more than `max` bytes, or a file the path no longer names.
 */
export function readRegular(path: string, max = Number.MAX_SAFE_INTEGER): { bytes: Buffer; mode: number } | null {
  const opened = openRegular(path);
  if (opened === null) return null;
  try {
    if (opened.size > max) return null;
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(1 << 20, max - total + 1));
      const n = readSync(opened.fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      total += n;
      if (total > max) return null;
      chunks.push(chunk.subarray(0, n));
    }
    return { bytes: Buffer.concat(chunks, total), mode: opened.mode };
  } catch {
    return null;
  } finally {
    closeSync(opened.fd);
  }
}

/**
 * A descriptor on the regular file at `path`, opened as {@link readRegular}
 * opens it (no final link followed, no blocking, the path still naming the
 * very file), with its size and mode from the descriptor; null for anything
 * else. The caller reads through it and closes it.
 */
export function openRegular(path: string): { fd: number; size: number; mode: number } | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch {
    return null;
  }
  try {
    const opened = fstatSync(fd, { bigint: true });
    const now = lstatSync(path, { bigint: true });
    // Node 22.12 on Windows leaves a path lookup's `dev` at 0; the file id still tells the file apart.
    if (opened.isFile() && !now.isSymbolicLink() && now.isFile() && now.ino === opened.ino && (now.dev === opened.dev || now.dev === 0n)) {
      return { fd, size: Number(opened.size), mode: Number(opened.mode) };
    }
  } catch {
    // unreadable: nothing
  }
  closeSync(fd);
  return null;
}

/** The lookup of `path` when it is a regular file, not a link, with one name and the opened file's id. */
function plainFileAt(path: string, opened: BigIntStats): BigIntStats | null {
  let now: BigIntStats;
  try {
    now = lstatSync(path, { bigint: true });
  } catch {
    return null;
  }
  if (now.isSymbolicLink() || !now.isFile() || now.nlink !== 1n || now.ino !== opened.ino) return null;
  return now;
}
