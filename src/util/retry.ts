/**
 * Bounded retry for transient Windows file-system errors.
 *
 * On NTFS an open, rename or unlink can briefly fail with EBUSY, EPERM or
 * EACCES because an antivirus scanner, the search indexer or another handle
 * is holding the file for a few milliseconds. These are not real failures and
 * must not abort a state write.
 */
const TRANSIENT = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY', 'EMFILE']);

export function isTransientFsError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code !== undefined && TRANSIENT.has(code);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Run `fn`, retrying only on transient file-system errors. */
export function retrySync<T>(fn: () => T, attempts = 6, baseDelayMs = 10): T {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return fn();
    } catch (err) {
      if (!isTransientFsError(err)) throw err;
      lastError = err;
      sleepSync(baseDelayMs * (i + 1));
    }
  }
  throw lastError;
}

/**
 * Run `fn`, swallowing a transient failure entirely.
 *
 * Only for operations whose failure costs durability rather than
 * correctness, such as an fsync after the bytes are already written.
 */
export function bestEffortSync(fn: () => void, attempts = 3): boolean {
  for (let i = 0; i < attempts; i++) {
    try {
      fn();
      return true;
    } catch (err) {
      if (!isTransientFsError(err)) return false;
      sleepSync(5 * (i + 1));
    }
  }
  return false;
}
