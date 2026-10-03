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
import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

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
