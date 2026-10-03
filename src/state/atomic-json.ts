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
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { isPidAlive } from './process-lock.js';
import { retrySync } from '../util/retry.js';

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

/** Atomically replace `file` with `text`. Creates parent directories. */
export function writeTextAtomic(file: string, text: string): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = file + tempSuffix();
  retrySync(() => {
    const fd = openSync(tmp, 'wx');
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  });
  try {
    // On NTFS a replace-rename can transiently fail while a scanner holds the
    // destination. Retrying keeps the write atomic rather than falling back
    // to a non-atomic truncate-and-write.
    retrySync(() => renameSync(tmp, file));
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
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
  writeTextAtomic(file, JSON.stringify(next, null, 2) + '\n');
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
