/**
 * Isolated Claude Code profile.
 *
 * Every run gets its own GUID-scoped tree under
 * `<LOCALAPPDATA on Windows, os.tmpdir() elsewhere>/MycelinkPluginE2E/runs/<guid>`
 * with separate source, workspace, config, home, temp, npm and artifact
 * directories, so a plugin test can never read or write the developer's real
 * Claude configuration.
 *
 * No Docker, WSL or VM: this is plain process isolation via environment
 * variables, identical on Windows, Linux and macOS.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';

export interface IsolatedProfile {
  id: string;
  root: string;
  source: string;
  workspace: string;
  config: string;
  home: string;
  temp: string;
  npm: string;
  artifacts: string;
  env: NodeJS.ProcessEnv;
}

export interface ClaudeRun {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  command: string[];
  durationMs: number;
}

function localAppData(): string {
  const local = process.env['LOCALAPPDATA'];
  return process.platform === 'win32' && local ? local : tmpdir();
}

export function profilesRoot(): string {
  return join(localAppData(), 'MycelinkPluginE2E', 'runs');
}

/** True when the real Claude Code CLI is callable on this machine. */
export function claudeAvailable(): boolean {
  const probe = spawnSync('claude', ['--version'], {
    encoding: 'utf8',
    shell: true,
    timeout: 60_000,
    windowsHide: true,
  });
  return probe.status === 0 && /\d+\.\d+\.\d+/.test(probe.stdout ?? '');
}

export function claudeVersion(): string {
  const probe = spawnSync('claude', ['--version'], {
    encoding: 'utf8',
    shell: true,
    timeout: 60_000,
    windowsHide: true,
  });
  return (probe.stdout ?? '').trim();
}

/**
 * Create a profile and copy the plugin source into it.
 *
 * The copy is deliberate: it proves the package works from a location that
 * is not the development tree, and that the hidden `.claude-plugin` manifest
 * directory survives being copied.
 */
export function createIsolatedProfile(pluginSource: string): IsolatedProfile {
  const id = randomUUID();
  const root = join(profilesRoot(), id);

  const source = join(root, 'source');
  const workspace = join(root, 'workspace');
  const config = join(root, 'config');
  const home = join(root, 'home');
  const temp = join(root, 'temp');
  const npm = join(root, 'npm');
  const artifacts = join(root, 'artifacts');
  for (const dir of [root, source, workspace, config, home, temp, npm, artifacts]) {
    mkdirSync(dir, { recursive: true });
  }

  const sourceRoot = resolve(pluginSource);
  // Exclusions are matched against the path RELATIVE to the package root.
  // Matching the absolute path would exclude everything when the package
  // itself happens to live under one of these directory names — for example
  // when developing inside `.claude/worktrees/<name>`.
  const EXCLUDED_PREFIXES = ['node_modules', '.git', '.claude/worktrees', 'tests/.work', 'dist/.cache'];
  cpSync(sourceRoot, source, {
    recursive: true,
    dereference: false,
    filter: (src) => {
      const rel = relative(sourceRoot, src).replace(/\\/g, '/');
      if (rel === '') return true;
      return !EXCLUDED_PREFIXES.some((p) => rel === p || rel.startsWith(p + '/'));
    },
  });

  // A workspace the CLI can run in without touching a real project.
  writeFileSync(join(workspace, 'README.md'), '# isolated plugin e2e workspace\n', 'utf8');

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_CONFIG_DIR: config,
    HOME: home,
    USERPROFILE: home,
    TEMP: temp,
    TMP: temp,
    npm_config_cache: join(npm, 'cache'),
    npm_config_prefix: npm,
    // Never let a test reach a model.
    ANTHROPIC_API_KEY: '',
  };

  return { id, root, source, workspace, config, home, temp, npm, artifacts, env };
}

/** Run the real Claude CLI inside the profile and capture everything. */
export function runClaude(
  profile: IsolatedProfile,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): ClaudeRun {
  const started = Date.now();
  const proc = spawnSync('claude', args, {
    cwd: options.cwd ?? profile.workspace,
    encoding: 'utf8',
    env: profile.env,
    shell: true,
    timeout: options.timeoutMs ?? 180_000,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    code: proc.status,
    stdout: proc.stdout ?? '',
    stderr: proc.stderr ?? '',
    timedOut: (proc.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT',
    command: ['claude', ...args],
    durationMs: Date.now() - started,
  };
}

export function destroyProfile(profile: IsolatedProfile): void {
  if (!existsSync(profile.root)) return;
  rmSync(profile.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
