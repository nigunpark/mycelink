/**
 * Sandboxed command execution with captured, hashed output.
 *
 * The command runs inside the isolation boundary it is given
 * (lib/sandbox.mjs: no network, nothing visible but `binds`), with exactly
 * the environment it is given (nothing is inherited), in its own process
 * group on POSIX so that a timeout — and the end of the run — kills
 * everything it started (forked test JVMs, workers, servers); inside the
 * boundary the PID namespace dies with it as well. stdout and stderr go to
 * files whose SHA-256 is recorded.
 */
import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { sha256File } from './hash.mjs';
import { start, unconfined } from './sandbox.mjs';

function killTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // the group is already gone
    }
  }
}

/**
 * Run `argv` in `cwd` with `env`, inside `isolation` with `binds` visible
 * (`{ path, rw? }`; `cwd` must be among them). Resolves to
 * `{ argv, exit_code, signal, timed_out, duration_ms, spawn_error,
 *    confined, stdout_path, stderr_path, stdout_sha256, stderr_sha256 }`.
 */
export async function runCommand({ argv, cwd, env, timeoutMs, outDir, label, isolation = unconfined('no isolation given'), binds = [] }) {
  if (!Array.isArray(argv) || argv.length === 0) throw new Error('runCommand needs an argv');
  if (!/^[A-Za-z0-9._-]+$/.test(label)) throw new Error(`invalid run label ${label}`);
  mkdirSync(outDir, { recursive: true });
  const stdoutPath = join(outDir, `${label}.stdout.log`);
  const stderrPath = join(outDir, `${label}.stderr.log`);
  const out = openSync(stdoutPath, 'w');
  const err = openSync(stderrPath, 'w');
  const started = Date.now();
  let timedOut = false;
  let spawnError = null;
  const outcome = await new Promise((resolvePromise) => {
    let child;
    try {
      child = start(isolation, { argv, env, cwd, binds }, { stdio: ['ignore', out, err], detached: process.platform !== 'win32' });
    } catch (error) {
      spawnError = error.message;
      resolvePromise({ code: -1, signal: null });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    child.on('error', (error) => {
      spawnError = error.message;
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      // Leave nothing behind: daemons and forks die with the run.
      killTree(child);
      resolvePromise({ code, signal });
    });
  });
  closeSync(out);
  closeSync(err);
  return {
    argv,
    exit_code: outcome.code ?? -1,
    signal: outcome.signal ?? null,
    timed_out: timedOut,
    duration_ms: Date.now() - started,
    spawn_error: spawnError,
    confined: isolation.enforced === true,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    stdout_sha256: await sha256File(stdoutPath),
    stderr_sha256: await sha256File(stderrPath),
  };
}

/** Replace machine-specific roots with stable placeholders (for hashing). */
export function placeholders(value, roots) {
  const entries = Object.entries(roots).filter(([path]) => path).sort((a, b) => b[0].length - a[0].length);
  const swap = (s) => {
    let out = s;
    for (const [path, token] of entries) {
      out = out.split(path).join(token);
      const slashed = path.replace(/\\/g, '/');
      if (slashed !== path) out = out.split(slashed).join(token);
    }
    return out;
  };
  if (typeof value === 'string') return swap(value);
  if (Array.isArray(value)) return value.map((v) => placeholders(v, roots));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, placeholders(v, roots)]));
  return value;
}
