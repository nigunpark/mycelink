/**
 * Command execution policy.
 *
 * Every repository, verification and E2E command Mycelink runs goes through
 * here. The rules:
 *
 *  - Commands are argv arrays (`["npm", "test"]`) and run **without a shell**.
 *    Arguments are never re-split or re-interpreted, so `a; rm -rf /` is one
 *    literal argument.
 *  - The executable must be a non-empty name that does not look like an
 *    option, and no element may contain NUL or (for the executable) control
 *    characters.
 *  - Shell mode exists for the rare command that genuinely needs pipes or
 *    `&&`. It must be requested per command (`shell: true`) **and** enabled by
 *    the control repository's `allow_shell_commands`. A graph, PRD or model
 *    can request it but can never enable it. Shell scripts are exactly one
 *    string, and everything in that string is interpreted by the shell —
 *    that is the injection risk the opt-in exists to make explicit.
 *  - On Windows, batch shims (`npm.cmd`, `yarn.cmd`, ...) cannot be spawned
 *    without cmd.exe. They run through `cmd.exe /d /s /c` with every argument
 *    quoted, and any argument containing a character cmd.exe would still
 *    reinterpret (`& | < > ^ " % !`, line breaks, a trailing backslash) is
 *    refused rather than escaped.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join } from 'node:path';

export type CommandPolicyCode =
  | 'EMPTY_COMMAND'
  | 'EMPTY_EXECUTABLE'
  | 'OPTION_AS_EXECUTABLE'
  | 'CONTROL_CHARACTER'
  | 'NUL_BYTE'
  | 'NOT_A_STRING'
  | 'SHELL_NOT_ALLOWED'
  | 'SHELL_SCRIPT_SHAPE'
  | 'BATCH_METACHARACTER';

export class CommandPolicyError extends Error {
  readonly code: CommandPolicyCode;
  constructor(code: CommandPolicyCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'CommandPolicyError';
    this.code = code;
  }
}

/** Throw unless `argv` is a well-formed argv array. */
export function validateArgv(argv: readonly unknown[]): asserts argv is string[] {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new CommandPolicyError('EMPTY_COMMAND', 'a command needs at least one element');
  }
  for (const part of argv) {
    if (typeof part !== 'string') throw new CommandPolicyError('NOT_A_STRING', 'every argv element must be a string');
    if (part.includes('\u0000')) throw new CommandPolicyError('NUL_BYTE', 'argv elements must not contain NUL');
  }
  const exe = argv[0] as string;
  if (exe.trim() === '') throw new CommandPolicyError('EMPTY_EXECUTABLE', 'the executable is empty');
  if (exe.startsWith('-')) {
    throw new CommandPolicyError('OPTION_AS_EXECUTABLE', `the executable ${JSON.stringify(exe)} looks like an option`);
  }
  if (/[\u0000-\u001f\u007f]/.test(exe)) {
    throw new CommandPolicyError('CONTROL_CHARACTER', 'the executable contains a control character');
  }
}

export interface PlanOptions {
  shell?: boolean;
  allowShell?: boolean;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  /** Resolve a bare executable to a file (Windows); injectable for tests. */
  resolveExecutable?: (exe: string, env: Record<string, string | undefined>) => string | null;
}

export interface CommandPlan {
  file: string;
  args: string[];
  shell: false;
  windowsVerbatimArguments: boolean;
  /** Human-readable form for evidence logs. */
  display: string;
}

const BATCH_FORBIDDEN = /[&|<>^"%!\r\n]/;

/** PATH/PATHEXT lookup, as cmd.exe would do it. */
export function resolveWindowsExecutable(exe: string, env: Record<string, string | undefined>): string | null {
  const exts = (env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const isFile = (p: string): boolean => {
    try {
      return existsSync(p) && statSync(p).isFile();
    } catch {
      return false;
    }
  };
  const tryWithExts = (base: string): string | null => {
    if (extname(base) !== '' && isFile(base)) return base;
    for (const ext of exts) {
      if (isFile(base + ext)) return base + ext;
      if (isFile(base + ext.toLowerCase())) return base + ext.toLowerCase();
    }
    return null;
  };
  if (isAbsolute(exe) || /[\\/]/.test(exe)) return tryWithExts(exe);
  const path = env['PATH'] ?? env['Path'] ?? '';
  for (const dir of path.split(delimiter).filter(Boolean)) {
    const hit = tryWithExts(join(dir, exe));
    if (hit) return hit;
  }
  return null;
}

/** Decide exactly how a command will be spawned, or throw. */
export function planCommand(argv: readonly string[], options: PlanOptions = {}): CommandPlan {
  validateArgv(argv);
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;

  if (options.shell) {
    if (!options.allowShell) {
      throw new CommandPolicyError(
        'SHELL_NOT_ALLOWED',
        'this command requests shell mode, but the control repository does not set allow_shell_commands: true',
      );
    }
    if (argv.length !== 1) {
      throw new CommandPolicyError('SHELL_SCRIPT_SHAPE', 'a shell command must be exactly one script string');
    }
    const script = argv[0] as string;
    if (platform === 'win32') {
      const comspec = env['ComSpec'] ?? env['COMSPEC'] ?? 'cmd.exe';
      return { file: comspec, args: ['/d', '/s', '/c', `"${script}"`], shell: false, windowsVerbatimArguments: true, display: script };
    }
    return { file: '/bin/sh', args: ['-c', script], shell: false, windowsVerbatimArguments: false, display: script };
  }

  const [exe, ...rest] = argv as [string, ...string[]];
  const display = argv.join(' ');

  if (platform === 'win32') {
    const resolver = options.resolveExecutable ?? resolveWindowsExecutable;
    const resolved = resolver(exe, env);
    const ext = resolved ? extname(resolved).toLowerCase() : '';
    if (resolved && (ext === '.cmd' || ext === '.bat')) {
      for (const part of [resolved, ...rest]) {
        if (BATCH_FORBIDDEN.test(part) || part.endsWith('\\')) {
          throw new CommandPolicyError(
            'BATCH_METACHARACTER',
            `${JSON.stringify(part)} would be reinterpreted by cmd.exe when running the batch file ${resolved}; ` +
              'call the underlying executable directly (for example node <script>) or remove the character',
          );
        }
      }
      const comspec = env['ComSpec'] ?? env['COMSPEC'] ?? 'cmd.exe';
      const line = [resolved, ...rest].map((p) => `"${p}"`).join(' ');
      return { file: comspec, args: ['/d', '/s', '/c', `"${line}"`], shell: false, windowsVerbatimArguments: true, display };
    }
    return { file: resolved ?? exe, args: rest, shell: false, windowsVerbatimArguments: false, display };
  }

  return { file: exe, args: rest, shell: false, windowsVerbatimArguments: false, display };
}

export interface RunOptions {
  cwd: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  shell?: boolean;
  allowShell?: boolean;
  maxBuffer?: number;
  input?: string;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError: string | null;
  display: string;
}

/**
 * Run a command synchronously under the policy. Exit 124 means timed out,
 * 127 means it could not be started (the conventional shell codes).
 */
export function runCommandSync(argv: readonly string[], options: RunOptions): RunResult {
  const env = { ...process.env, ...(options.env ?? {}) };
  const plan = planCommand(argv, { shell: options.shell ?? false, allowShell: options.allowShell ?? false, env });
  const proc = spawnSync(plan.file, plan.args, {
    cwd: options.cwd,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 20 * 60 * 1000,
    windowsHide: true,
    windowsVerbatimArguments: plan.windowsVerbatimArguments,
    maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
    env,
    shell: false,
    ...(options.input !== undefined ? { input: options.input } : {}),
  });
  const timedOut = proc.error !== undefined && (proc.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
  const spawnFailed = proc.error !== undefined && !timedOut;
  return {
    exitCode: timedOut ? 124 : spawnFailed ? 127 : (proc.status ?? 1),
    stdout: proc.stdout ?? '',
    stderr: proc.stderr ?? '',
    timedOut,
    spawnError: spawnFailed ? String(proc.error?.message) : null,
    display: plan.display,
  };
}
