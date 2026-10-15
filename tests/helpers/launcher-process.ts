/**
 * The plugin's own launcher run as Claude Code runs a hook command: this Node, `bin/mycelink.mjs` and its arguments,
 * the payload on stdin as a finished file (src/util/child-stdin.ts: on macOS with Node 22 a stdin stream's end can be
 * lost, CI 38635817750), bounded. Narrow on purpose: the executable is always this Node and the first argument a
 * `bin/mycelink.mjs` launcher; anything else is refused before anything runs. Never a shell.
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { basename, dirname, isAbsolute } from 'node:path';
import { withStdinFile } from '../../src/util/child-stdin.js';

export interface LauncherRun {
  input: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Past it the launcher is killed (SIGKILL) and the result says so. */
  timeoutMs?: number;
}

/** `argv`: the launcher's path (absolute, `.../bin/mycelink.mjs`), then its arguments. */
export function runLauncher(argv: readonly string[], options: LauncherRun): SpawnSyncReturns<string> & { timedOut: boolean } {
  const [launcher, ...args] = argv;
  if (launcher === undefined || !isAbsolute(launcher) || basename(launcher) !== 'mycelink.mjs' || basename(dirname(launcher)) !== 'bin') {
    throw new Error(`runLauncher runs only a bin/mycelink.mjs launcher by its absolute path, not ${JSON.stringify(launcher)}`);
  }
  const r = withStdinFile(options.input, (stdin) =>
    spawnSync(process.execPath, [launcher, ...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: [stdin, 'pipe', 'pipe'],
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: options.timeoutMs ?? 120_000,
      killSignal: 'SIGKILL',
    }),
  );
  return Object.assign(r, { timedOut: (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' });
}
