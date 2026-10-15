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
 * Run `fn` until it succeeds, fails with a code not in `codes`, or `budgetMs`
 * has passed since the first try; the last failure is thrown. The waits back
 * off from `baseDelayMs`, doubling up to `maxDelayMs`, and the last one ends
 * at the budget. `fn` is given the attempt number, from 1.
 */
export function retryWithinSync<T>(
  fn: (attempt: number) => T,
  options: { codes: ReadonlySet<string>; budgetMs: number; baseDelayMs?: number; maxDelayMs?: number },
): T {
  const started = performance.now();
  let delay = options.baseDelayMs ?? 10;
  for (let attempt = 1; ; attempt++) {
    try {
      return fn(attempt);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      const left = options.budgetMs - (performance.now() - started);
      if (code === undefined || !options.codes.has(code) || left <= 0) throw err;
      sleepSync(Math.min(delay, left));
      delay = Math.min(delay * 2, options.maxDelayMs ?? 250);
    }
  }
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
