/**
 * Cross-process advisory lock.
 *
 * Implemented with an exclusive-create lock file (`wx`), which is atomic on
 * NTFS and POSIX alike, so no native dependency, WSL or Docker is required.
 * A lock records its owner so that a crashed holder can be recovered, and so
 * that `release()` can never delete a lock another process has taken over.
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';

export interface LockOwner {
  pid: number;
  host: string;
  token: string;
  acquired_at: string;
  purpose?: string;
}

export interface LockOptions {
  /** Give up after this long. Default 10s. */
  timeoutMs?: number;
  /** Poll interval while waiting. Default 25ms. */
  pollMs?: number;
  /** A lock older than this is treated as abandoned. Default 120s. */
  staleMs?: number;
  /** Free-form label recorded in the lock file for diagnostics. */
  purpose?: string;
}

export class LockTimeoutError extends Error {
  readonly file: string;
  readonly holder: LockOwner | null;

  constructor(file: string, holder: LockOwner | null) {
    super(
      `Timed out acquiring lock ${file}` +
        (holder ? ` held by pid ${holder.pid} on ${holder.host} since ${holder.acquired_at}` : ''),
    );
    this.name = 'LockTimeoutError';
    this.file = file;
    this.holder = holder;
  }
}

export interface LockHandle {
  readonly file: string;
  readonly token: string;
  release(): void;
}

const DEFAULTS = { timeoutMs: 10_000, pollMs: 25, staleMs: 120_000 } as const;

function readOwner(file: string): LockOwner | null {
  try {
    const raw = readFileSync(file, 'utf8');
    const owner = JSON.parse(raw) as LockOwner;
    if (typeof owner.pid !== 'number' || typeof owner.token !== 'string') return null;
    return owner;
  } catch {
    return null;
  }
}

/** True when a process with this pid currently exists on this machine. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means the process exists but belongs to another user.
    return code === 'EPERM';
  }
}

/** True when the lock file exists (regardless of whether its owner is alive). */
export function isLockHeld(file: string): boolean {
  return existsSync(file);
}

function lockAgeMs(file: string, owner: LockOwner | null): number {
  if (owner?.acquired_at) {
    const t = Date.parse(owner.acquired_at);
    if (!Number.isNaN(t)) return Date.now() - t;
  }
  try {
    return Date.now() - statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Error codes that mean "the lock is not ours right now", not "something is
 * broken".
 *
 * On Windows an exclusive create can fail with EPERM or EACCES rather than
 * EEXIST when the lock file is in the NTFS *delete pending* state — the
 * window between another holder unlinking it and the last handle closing —
 * and with EBUSY when a scanner has it open. Treating any of these as fatal
 * crashes a process that should simply have waited, which under contention
 * is exactly when the harness must be most reliable.
 */
const NOT_OURS_YET = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY']);

function tryCreate(file: string, owner: LockOwner): boolean {
  mkdirSync(dirname(file), { recursive: true });
  let fd: number;
  try {
    fd = openSync(file, 'wx');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== undefined && NOT_OURS_YET.has(code)) return false;
    throw err;
  }
  try {
    writeSync(fd, JSON.stringify(owner));
  } catch (err) {
    // We created it but could not stamp ownership: drop it rather than leave
    // an unattributable lock that only a TTL could clear.
    closeSync(fd);
    try {
      rmSync(file, { force: true });
    } catch {
      // Best effort; the TTL will reclaim it.
    }
    throw err;
  }
  closeSync(fd);
  return true;
}

/** Unlink that tolerates the same transient Windows states. */
function tryRemove(file: string): boolean {
  try {
    rmSync(file, { force: true });
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== undefined && NOT_OURS_YET.has(code)) return false;
    throw err;
  }
}

function sleepSync(ms: number): void {
  // Synchronous sleep without busy-spinning the CPU: Atomics.wait on a
  // throwaway SharedArrayBuffer parks the thread.
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

/**
 * Acquire the lock, waiting up to `timeoutMs`.
 *
 * Abandoned locks (dead owner pid on this host, or older than `staleMs`) are
 * recovered: the stale file is removed and creation is retried. Recovery is
 * itself racy-safe because the retry still uses exclusive create.
 */
export function acquireLock(file: string, options: LockOptions = {}): LockHandle {
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const pollMs = options.pollMs ?? DEFAULTS.pollMs;
  const staleMs = options.staleMs ?? DEFAULTS.staleMs;

  const token = randomBytes(12).toString('hex');
  const me: LockOwner = {
    pid: process.pid,
    host: hostname(),
    token,
    acquired_at: new Date().toISOString(),
    ...(options.purpose ? { purpose: options.purpose } : {}),
  };

  const deadline = Date.now() + timeoutMs;
  let lastOwner: LockOwner | null = null;

  for (;;) {
    if (tryCreate(file, me)) {
      return makeHandle(file, token);
    }

    lastOwner = readOwner(file);
    const age = lockAgeMs(file, lastOwner);
    const ownerDead =
      lastOwner !== null && lastOwner.host === me.host && !isPidAlive(lastOwner.pid);
    const expired = age >= staleMs;
    const unreadable = lastOwner === null && age > 1000;

    if (ownerDead || expired || unreadable) {
      // Recover: delete only the exact file we observed, then retry create.
      const confirm = readOwner(file);
      if (confirm === null || lastOwner === null || confirm.token === lastOwner.token) {
        tryRemove(file);
      }
      // Yield before retrying so two recoverers do not spin against each other.
      sleepSync(Math.max(1, Math.floor(pollMs / 2)));
      continue;
    }

    if (Date.now() >= deadline) {
      throw new LockTimeoutError(file, lastOwner);
    }
    sleepSync(pollMs);
  }
}

function makeHandle(file: string, token: string): LockHandle {
  let released = false;
  return {
    file,
    token,
    release(): void {
      if (released) return;
      released = true;
      const owner = readOwner(file);
      // Only delete the lock if we still own it. A takeover after stale
      // recovery must not be destroyed by the old holder's cleanup.
      if (owner && owner.token !== token) return;
      // A transient failure here is not fatal: the TTL and dead-pid checks
      // will reclaim the lock. Throwing would mask the caller's real result.
      for (let i = 0; i < 5 && !tryRemove(file); i++) sleepSync(5 * (i + 1));
    },
  };
}

/** Run `fn` while holding the lock; the lock is always released. */
export function withLock<T>(file: string, fn: () => T, options: LockOptions = {}): T {
  const handle = acquireLock(file, options);
  try {
    return fn();
  } finally {
    handle.release();
  }
}
