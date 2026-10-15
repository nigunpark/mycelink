/**
 * The standard input of a child process, as a finished file.
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
 * `withStdinFile` writes the input whole to a private file first (a fresh
 * 0700 directory, the file 0600, created exclusively) and hands its caller
 * that file opened for reading, to give its child as stdin: the input's end
 * is the file's end, and nothing is written while the child runs. It starts
 * nothing itself. Each caller spawns its own child, its executable and argv
 * its own (a git command it names, or a command its policy planned:
 * security/exec.ts), never a shell, bounded by INPUT_CHILD_TIMEOUT_MS or its
 * own bound; `childProblem` says what a child that did not exit 0 was. The
 * file and its directory are removed once the caller is done, however it
 * ended.
 */
import type { SpawnSyncReturns } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retrySync } from './retry.js';

/** How long a git command fed its input may run: runGit's own bound. */
export const INPUT_CHILD_TIMEOUT_MS = 120_000;

/** `use(stdin)` with `input` written whole to a private file, `stdin` its descriptor opened for reading. */
export function withStdinFile<T>(input: string | Uint8Array, use: (stdin: number) => T): T {
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  const dir = mkdtempSync(join(tmpdir(), 'mycelink-stdin-'));
  let fd: number | null = null;
  try {
    const path = join(dir, 'input');
    writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
    fd = openSync(path, 'r');
    return use(fd);
  } finally {
    if (fd !== null) closeSync(fd);
    removeScratch(dir);
  }
}

/**
 * The input's private directory, removed once its child has ended. Windows can refuse an unlink for a moment (a
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
export function childProblem(label: string, r: SpawnSyncReturns<string | Buffer>, inputBytes: number): string {
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  const how =
    code === 'ETIMEDOUT'
      ? 'killed past its bound'
      : r.error !== undefined
        ? `failed to run (${String(code ?? r.error.message)})`
        : r.signal !== null
          ? `ended by ${r.signal}`
          : `exited ${r.status}`;
  const stderr = String(r.stderr ?? '').trim().slice(0, 300);
  return `${label} ${how} (${inputBytes} bytes of input)${stderr !== '' ? `: ${stderr}` : ''}`;
}
