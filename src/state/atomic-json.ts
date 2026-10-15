/**
 * Atomic, crash-safe JSON document store.
 *
 * Every canonical harness file (STATE.json, leases, registries, ...) is written
 * through this module so that a reader on native Windows never observes a
 * partially written file and so that concurrent writers cannot silently clobber
 * each other. Writes go to a sibling temp file, are fsync'ed, then renamed over
 * the destination (an atomic replace on NTFS via MoveFileEx).
 */
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
  type BigIntStats,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { isPidAlive } from './process-lock.js';
import { bestEffortSync, retrySync, retryWithinSync } from '../util/retry.js';

/** A versioned document. `revision` increments on every successful write. */
export interface AtomicDoc<T> {
  revision: number;
  data: T;
}

/** Thrown when a compare-and-swap update observes an unexpected revision. */
export class CasConflictError extends Error {
  readonly expected: number;
  readonly actual: number;
  readonly file: string;

  constructor(file: string, expected: number, actual: number) {
    super(`CAS conflict on ${file}: expected revision ${expected}, found ${actual}`);
    this.name = 'CasConflictError';
    this.file = file;
    this.expected = expected;
    this.actual = actual;
  }
}

/** Temp files older than this are considered abandoned by a crashed writer. */
const STALE_TEMP_MS = 60_000;

function tempSuffix(): string {
  return `.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
}

function isTempOf(name: string, target: string): boolean {
  return name.startsWith(`${target}.tmp-`);
}

/** Extract the writer pid encoded in a temp file name, if present. */
function tempPid(name: string): number | null {
  const m = /\.tmp-(\d+)-[0-9a-f]+$/.exec(name);
  if (!m) return null;
  const pid = Number.parseInt(m[1] as string, 10);
  return Number.isFinite(pid) ? pid : null;
}

/**
 * Remove temp files left by crashed writers.
 *
 * A temp file is abandoned when its writer process no longer exists, or when
 * it is older than STALE_TEMP_MS. Both conditions are required so a concurrent
 * in-flight write by a live process is never disturbed.
 */
export function reapStaleTemps(file: string, now = Date.now()): number {
  const dir = dirname(file);
  const target = basename(file);
  let reaped = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!isTempOf(entry, target)) continue;
    const full = join(dir, entry);
    try {
      const pid = tempPid(entry);
      const ownerGone = pid !== null && pid !== process.pid && !isPidAlive(pid);
      const age = now - statSync(full).mtimeMs;
      if (ownerGone || age >= STALE_TEMP_MS || age < 0) {
        rmSync(full, { force: true });
        reaped++;
      }
    } catch {
      // Raced with another reaper; nothing to do.
    }
  }
  return reaped;
}

/**
 * How long a replace Windows refuses is retried. NTFS refuses a rename over a
 * file while any handle on it is open, even a reader's that shares delete
 * (every node:fs reader's): a hook or the harness reading STATE.json, a
 * scanner, the indexer. On a loaded machine that outlasts a few tries.
 */
export const REPLACE_RETRY_MS = 5_000;

/** What Windows answers a replace with while another handle holds the destination (EPERM, EACCES) or the temp (EBUSY). */
const REPLACE_REFUSED: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** Atomically replace `file` with `text` (or bytes): a link at it is replaced, never written through. Creates parent directories. */
export function writeTextAtomic(file: string, text: string | Uint8Array): void {
  replaceAtomic(file, text);
}

/**
 * Write `text` to a synced temp beside `file` and rename it over `file`.
 * `stillCurrent` is checked before every retry of a refused replace, so a
 * write that waited is never put over what another writer landed meanwhile.
 */
function replaceAtomic(file: string, text: string | Uint8Array, stillCurrent?: () => void): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = file + tempSuffix();
  let made: BigIntStats | null = null;
  retrySync(() => {
    const fd = openSync(tmp, 'wx');
    try {
      writeAll(fd, typeof text === 'string' ? Buffer.from(text, 'utf8') : text);
      fsyncSync(fd);
      made = fstatSync(fd, { bigint: true });
    } finally {
      closeSync(fd);
    }
  });
  if (process.platform !== 'win32') {
    try {
      retrySync(() => renameSync(tmp, file));
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    return;
  }
  // Retrying keeps the write atomic rather than falling back to a
  // non-atomic truncate-and-write; each retry renames the very temp this
  // write synced, and only over what the write was made from.
  const started = performance.now();
  let attempts = 0;
  try {
    retryWithinSync(
      (attempt) => {
        attempts = attempt;
        if (attempt > 1) {
          if (!isSameFile(tmp, made)) {
            throw Object.assign(new Error(`ATOMIC_TEMP_CHANGED: ${tmp} is no longer the temp this write synced; ${file} was left as it was`), { code: 'ATOMIC_TEMP_CHANGED', path: tmp, dest: file });
          }
          stillCurrent?.();
        }
        renameSync(tmp, file);
      },
      { codes: REPLACE_REFUSED, budgetMs: REPLACE_RETRY_MS },
    );
  } catch (err) {
    // Only the temp this write made is removed; anything swapped in is left to reapStaleTemps.
    const removed = isSameFile(tmp, made) && bestEffortSync(() => rmSync(tmp, { force: true }));
    const e = err as NodeJS.ErrnoException;
    if (attempts > 1 && e.syscall === 'rename' && REPLACE_REFUSED.has(e.code ?? '')) {
      e.message += ` (the replace was refused ${attempts} times over ${Math.round(performance.now() - started)} ms; ${removed ? 'the temp was removed' : `${tmp} is left for the stale-temp reaper`})`;
    }
    throw err;
  }
}

/** Whether `path` is still the regular file `made` describes. */
function isSameFile(path: string, made: BigIntStats | null): boolean {
  let now: BigIntStats;
  try {
    now = lstatSync(path, { bigint: true });
  } catch {
    return false;
  }
  // Node 22's lstat on Windows answers dev 0; a file at the temp's name is on its volume anyway (no rename or link crosses one).
  const sameDev = now.dev === made?.dev || now.dev === 0n || made?.dev === 0n;
  return made !== null && now.isFile() && sameDev && now.ino === made.ino && now.size === made.size;
}

/**
 * Create `file` with `content` exclusively and atomically: a synced temporary
 * file in the same directory, hard-linked into place (fails if anything, a
 * link included, is already there); where hard links are not supported, an
 * O_EXCL create. Never a replace.
 */
export function createExclusive(file: string, content: string | Uint8Array): 'created' | 'exists' {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  const tmp = join(dirname(file), `.${basename(file)}.${randomBytes(8).toString('hex')}.tmp`);
  const fd = openSync(tmp, 'wx', 0o644);
  try {
    writeAll(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    try {
      linkSync(tmp, file);
      return 'created';
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
    }
    let out: number;
    try {
      out = openSync(file, 'wx', 0o644);
    } catch (again) {
      if ((again as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
      throw again;
    }
    try {
      writeAll(out, bytes);
      fsyncSync(out);
    } finally {
      closeSync(out);
    }
    return 'created';
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Write every byte to `fd` (a write may take fewer than it was given). */
function writeAll(fd: number, bytes: Uint8Array): void {
  for (let at = 0; at < bytes.length; ) at += writeSync(fd, bytes, at, bytes.length - at);
}

/** Read a document, or `null` when the file does not exist. */
export function readDoc<T>(file: string): AtomicDoc<T> | null {
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, 'utf8');
  const parsed = JSON.parse(raw) as AtomicDoc<T>;
  if (typeof parsed !== 'object' || parsed === null || typeof parsed.revision !== 'number') {
    throw new Error(`Malformed atomic document at ${file}: missing numeric "revision"`);
  }
  return parsed;
}

/**
 * Write `data` as revision `revision` (default: current + 1, or 1 when new).
 * Always reaps stale temp siblings so a crashed writer cannot leak files.
 */
export function writeDocAtomic<T>(file: string, data: T, revision?: number): AtomicDoc<T> {
  reapStaleTemps(file);
  const current = existsSync(file) ? readDoc<T>(file) : null;
  const next: AtomicDoc<T> = {
    revision: revision ?? (current ? current.revision + 1 : 1),
    data,
  };
  const base = current?.revision ?? 0;
  replaceAtomic(file, JSON.stringify(next, null, 2) + '\n', () => {
    const now = readDoc<T>(file)?.revision ?? 0;
    if (now !== base) throw new CasConflictError(file, base, now);
  });
  return next;
}

/**
 * Compare-and-swap update. `expectedRevision` must match the on-disk revision,
 * otherwise a {@link CasConflictError} is thrown and nothing is written.
 *
 * Callers that need cross-process mutual exclusion must hold a process lock
 * (see `process-lock.ts`); CAS alone detects conflicts, it does not prevent them.
 */
export function casUpdate<T>(
  file: string,
  expectedRevision: number,
  mutate: (data: T) => T,
): AtomicDoc<T> {
  const current = readDoc<T>(file);
  const actual = current?.revision ?? 0;
  if (actual !== expectedRevision) {
    throw new CasConflictError(file, expectedRevision, actual);
  }
  const nextData = mutate(current ? current.data : (undefined as unknown as T));
  return writeDocAtomic(file, nextData, expectedRevision + 1);
}

/** Read the document's data, or `fallback` when absent. */
export function readData<T>(file: string, fallback: T): T {
  const doc = readDoc<T>(file);
  return doc ? doc.data : fallback;
}
