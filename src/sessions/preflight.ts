/**
 * Preflight for the standalone CLI worker adapter.
 *
 * The adapter spawns the configured executable with `shell: false`, so it
 * must be resolvable from the controller's own PATH, and it must actually
 * start. Both are checked here, before anything is claimed, by resolving it
 * the way the spawn will and asking it for `--version` (which costs no model
 * usage). Authentication cannot be probed without a model call, so it is
 * reported as not checked rather than guessed.
 *
 * The host-native dispatch path does not use the adapter at all.
 */
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { resolveWindowsExecutable, runCommandSync } from '../security/exec.js';
import { isGitRepository } from '../git/git.js';
import { loadRepositories, normalizeConfig, type MycelinkConfigInput } from '../workspace/workspace.js';
import type { SessionAdapterId } from './adapter.js';

export interface PreflightResult {
  ok: boolean;
  adapter?: 'fake-claude' | 'claude-background' | 'codex-cli';
  executable?: string;
  /** The file the spawn would run, or null when it cannot be found. */
  resolved?: string | null;
  version?: string | null;
  auth?: 'not-checked';
  detail?: string;
}

const PROBE_TIMEOUT_MS = 15_000;
const VERSION = /(\d+\.\d+\.\d+)/;

function isRunnableFile(p: string): boolean {
  try {
    if (!existsSync(p) || !statSync(p).isFile()) return false;
    if (process.platform !== 'win32') accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Where a `shell: false` spawn of `exe` would find it, or null. */
export function resolveExecutable(exe: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (exe === '') return null;
  if (process.platform === 'win32') return resolveWindowsExecutable(exe, env);
  if (isAbsolute(exe) || exe.includes('/')) return isRunnableFile(exe) ? exe : null;
  for (const dir of (env['PATH'] ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(dir, exe);
    if (isRunnableFile(candidate)) return candidate;
  }
  return null;
}

function probe(argv: string[], base: PreflightResult): PreflightResult {
  const run = runCommandSync(argv, { cwd: tmpdir(), timeoutMs: PROBE_TIMEOUT_MS });
  if (run.spawnError !== null) {
    return { ...base, ok: false, detail: `could not be started: ${run.spawnError}` };
  }
  if (run.timedOut) return { ...base, ok: false, detail: `--version did not answer within ${PROBE_TIMEOUT_MS} ms` };
  if (run.exitCode !== 0) {
    const tail = (run.stderr || run.stdout).trim().split(/\r?\n/).slice(-1)[0] ?? '';
    return { ...base, ok: false, detail: `--version exited ${run.exitCode}${tail ? `: ${tail.slice(0, 200)}` : ''}` };
  }
  const version = VERSION.exec(run.stdout)?.[1] ?? null;
  if (version === null) return { ...base, ok: false, detail: '--version printed no version number' };
  return { ...base, ok: true, version, detail: `${base.resolved} answers --version ${version}; authentication not checked` };
}

/** Check that the configured worker adapter can start, without claiming anything. */
export function preflightAdapter(input: MycelinkConfigInput, env: NodeJS.ProcessEnv = process.env, controlRoot?: string): PreflightResult {
  const config = normalizeConfig(input);
  if (config.provider.provider === 'codex') {
    const denied: PreflightResult = { ok: false, adapter: 'codex-cli', auth: 'not-checked', detail: 'Codex worker dispatch requires explicit experimental opt-in and disposable repository registration.' };
    const opt = config.experimental_codex;
    if (opt?.enabled !== true || controlRoot === undefined || config.provider.extra_args?.length || config.allow_dangerous_permission_bypass || config.allow_shell_commands) return denied;
    let registered: string[];
    try {
      const repos = loadRepositories(controlRoot).repositories;
      if (repos.some((r) => resolve(controlRoot, r.path) === resolve(controlRoot) || !isGitRepository(resolve(controlRoot, r.path)))) {
        return { ...denied, detail: 'Codex experimental dispatch requires separate registered Git repositories (not the control repository).' };
      }
      registered = repos.map((r) => r.name);
    }
    catch { return { ...denied, detail: 'Codex experimental dispatch requires a valid registered repository manifest.' }; }
    const disposable = opt.disposable_repositories;
    if (!Array.isArray(disposable) || registered.length === 0 || registered.length !== disposable.length ||
        new Set(disposable).size !== disposable.length || registered.some((name) => !disposable.includes(name))) {
      return { ...denied, detail: 'Codex experimental dispatch requires every registered repository to be explicitly marked disposable by name.' };
    }
    const executable = config.provider.executable ?? 'codex';
    const resolved = resolveExecutable(executable, env);
    const base: PreflightResult = { ...denied, executable, resolved, version: null };
    if (resolved === null) return { ...base, detail: `Codex executable "${executable}" not found on PATH` };
    return probe([resolved, '--version'], base);
  }
  // Preserve the legacy direct-call overrides used by existing integrations.
  const legacyAdapter = input.session_adapter;
  const legacyExecutable = input.claude_executable;
  const fakeOverride = env['MYCELINK_FAKE_CLAUDE'];
  if (legacyAdapter === 'fake-claude' || config.adapter === 'fake-provider' || fakeOverride) {
    const script = fakeOverride ?? legacyExecutable ?? config.provider.executable ?? 'claude';
    const base: PreflightResult = {
      ok: false,
      adapter: 'fake-claude',
      executable: script,
      resolved: isRunnableFile(script) || (existsSync(script) && statSync(script).isFile()) ? script : null,
      version: null,
      auth: 'not-checked',
    };
    if (base.resolved === null) return { ...base, detail: `fake worker script ${script} not found` };
    return probe([process.execPath, script, '--version'], base);
  }

  const executable = legacyExecutable ?? config.provider.executable ?? 'claude';
  const resolved = resolveExecutable(executable, env);
  const base: PreflightResult = {
    ok: false,
    adapter: 'claude-background',
    executable,
    resolved,
    version: null,
    auth: 'not-checked',
  };
  if (resolved === null) {
    return {
      ...base,
      detail: `worker executable "${executable}" not found on the controller's PATH (spawned without a shell)`,
    };
  }
  return probe([resolved, '--version'], base);
}
