/**
 * A child process that reads its standard input, given it as a finished file.
 *
 * spawnSync's `input` is a stream: the parent writes it while the child runs
 * and must then end it. On macOS that stream is a socketpair, and on Node 22
 * a child there can wait for an end that never comes. CI 38635817750 (macOS,
 * Node 22.12.0): two test jobs ran to their 60-minute bound, each with an
 * orphan `git` beside the process that started it, and no test's own timeout
 * fired, because a synchronous child blocks the whole process. The git
 * commands Mycelink fed through `input` (`hash-object --stdin-paths`,
 * `cat-file --batch`, `hash-object --stdin`) were the only children it ran
 * with no bound.
 *
 * Here the input is written whole to a private file first (a fresh 0700
 * directory, the file 0600, created exclusively), and the child's stdin is
 * that file opened for reading. Its end is the file's end, so nothing is
 * written while the child runs. The child is also bounded: past `timeoutMs`
 * it is killed (SIGKILL unless told otherwise), and `childProblem` says what
 * it was. The file and its directory are removed once the child has ended,
 * however it ended.
 */
import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retrySync } from './retry.js';

/** How long a git command fed its input may run: runGit's own bound. */
export const INPUT_CHILD_TIMEOUT_MS = 120_000;

export interface InputChildOptions extends Omit<SpawnSyncOptions, 'input' | 'stdio' | 'timeout'> {
  input: string | Uint8Array;
  timeoutMs?: number;
}

export type InputChildResult<T extends string | Buffer = string | Buffer> = SpawnSyncReturns<T> & {
  /** Killed for running past its bound. */
  timedOut: boolean;
  /** Bytes of its input. */
  input_bytes: number;
  ms: number;
};

/** Run `file args`, its stdin `options.input` as a finished file, bounded by `options.timeoutMs`. */
export function runWithInput(file: string, args: readonly string[], options: InputChildOptions & { encoding: BufferEncoding }): InputChildResult<string>;
export function runWithInput(file: string, args: readonly string[], options: InputChildOptions): InputChildResult<Buffer>;
export function runWithInput(file: string, args: readonly string[], options: InputChildOptions): InputChildResult {
  const { input, timeoutMs = INPUT_CHILD_TIMEOUT_MS, killSignal = 'SIGKILL', ...rest } = options;
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  const dir = mkdtempSync(join(tmpdir(), 'mycelink-stdin-'));
  const t0 = Date.now();
  let fd: number | null = null;
  try {
    const path = join(dir, 'input');
    writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
    fd = openSync(path, 'r');
    const r = spawnSync(file, args, { ...rest, stdio: [fd, 'pipe', 'pipe'], timeout: timeoutMs, killSignal });
    const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
    return Object.assign(r as SpawnSyncReturns<string | Buffer>, { timedOut, input_bytes: bytes.length, ms: Date.now() - t0 });
  } finally {
    if (fd !== null) closeSync(fd);
    removeScratch(dir);
  }
}

/**
 * The input's private directory, removed once the child has ended. Windows can refuse an unlink for a moment (a
 * scanner, a handle still closing: CI 38635817750); that is tried again, and a directory still refused is left where
 * it is, private (0700). The child's result stands either way: its removal never turns it into a failure.
 */
function removeScratch(dir: string): void {
  try {
    retrySync(() => rmSync(dir, { recursive: true, force: true }));
  } catch {
    // left in the temporary directory, readable by no one else
  }
}

/** What went wrong with a child that did not exit 0, for an error message: killed past its bound, a signal, a status. */
export function childProblem(label: string, r: InputChildResult): string {
  const how = r.timedOut
    ? `killed after ${r.ms} ms, past its bound`
    : r.error !== undefined
      ? `failed to run (${String((r.error as NodeJS.ErrnoException).code ?? r.error.message)})`
      : r.signal !== null
        ? `ended by ${r.signal}`
        : `exited ${r.status}`;
  const stderr = String(r.stderr ?? '').trim().slice(0, 300);
  return `${label} ${how} (${r.input_bytes} bytes of input)${stderr !== '' ? `: ${stderr}` : ''}`;
}
