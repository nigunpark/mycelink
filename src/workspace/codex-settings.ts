/** Read-only Codex integration checks. Codex owns its plugin install; we never edit config.toml. */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'smol-toml';
import { planCommand } from '../security/exec.js';

export interface CodexCheck { name: string; ok: boolean; detail: string; level?: 'ok' | 'warn' }

function pluginRoot(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 9; i++) {
    if (existsSync(join(dir, 'codex-plugin', 'plugin.json'))) return join(dir, 'codex-plugin');
    if (existsSync(join(dir, 'plugin.json')) && existsSync(join(dir, 'skills', 'mycelink-init', 'SKILL.md'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function codexHealth(controlRoot: string, executable = 'codex'): CodexCheck[] {
  const checks: CodexCheck[] = [];
  const run = (args: string[]) => {
    try {
      const plan = planCommand([executable, ...args]);
      return spawnSync(plan.file, plan.args, {
        encoding: 'utf8', timeout: 5000, windowsHide: true,
        windowsVerbatimArguments: plan.windowsVerbatimArguments,
        // Do not return stderr/stdout to doctor: an arbitrary executable could print credentials.
        maxBuffer: 1024 * 32,
      });
    } catch { return { status: null, stdout: '' }; }
  };
  const version = run(['--version']);
  const installed = version.status === 0 && /^codex-cli \d+\.\d+\.\d+/.test(version.stdout.trim());
  checks.push({ name: 'codex executable', ok: installed, detail: installed ? version.stdout.trim() : `Codex CLI unavailable at ${executable}; install Codex and retry` });
  const status = installed ? run(['login', 'status']) : null;
  // Codex 0.163 prints successful login status on stderr on Windows. Check
  // either stream, but never include the CLI's raw output in doctor JSON.
  const loggedIn = status?.status === 0 && [status.stdout, 'stderr' in status ? status.stderr : '']
    .some((stream) => typeof stream === 'string' && /^Logged in(?:\s|$)/.test(stream.trim()));
  checks.push({ name: 'codex login', ok: loggedIn, detail: loggedIn ? 'logged in (credentials not displayed)' : 'not logged in or login status unavailable; run codex login interactively' });
  let pluginInstalled = false;
  if (installed) {
    const listed = run(['plugin', 'list', '--json']);
    if (listed.status === 0) {
      try {
        const data = JSON.parse(listed.stdout) as { installed?: { pluginId?: string; installed?: boolean; enabled?: boolean }[] };
        pluginInstalled = data.installed?.some((item) => item.pluginId?.startsWith('mycelink@') && item.installed === true && item.enabled === true) ?? false;
      } catch { /* unrecognised plugin list is not proof of installation */ }
    }
  }
  checks.push({ name: 'codex plugin installation', ok: pluginInstalled, detail: pluginInstalled
    ? 'Mycelink enabled in Codex plugin list'
    : 'Mycelink not enabled in Codex plugin list for this CODEX_HOME; install using codex plugin add mycelink@<marketplace>' });

  const root = pluginRoot();
  const manifest = root && join(root, 'plugin.json');
  let valid = false;
  let hooksDisabled = false;
  if (manifest) {
    try {
      const data = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string; extensions?: { 'com.openai'?: { hooks?: unknown } } };
      valid = data.name === 'mycelink' && data.extensions?.['com.openai']?.hooks !== undefined;
      const hooks = data.extensions?.['com.openai']?.hooks;
      hooksDisabled = !!hooks && typeof hooks === 'object' && !Array.isArray(hooks) && Object.keys(hooks).length === 0;
    } catch { /* broken plugin manifest */ }
  }
  checks.push({ name: 'codex plugin', ok: valid, detail: manifest ?? 'Mycelink plugin.json missing' });
  const skill = root && join(root, 'skills', 'mycelink-init', 'SKILL.md');
  checks.push({ name: 'codex skills', ok: !!skill && existsSync(skill), detail: skill ?? 'Codex planning SKILL.md missing' });
  const launcher = root && join(root, 'bin', 'mycelink.mjs');
  const bundle = root && join(root, 'dist', 'mycelink.mjs');
  const launcherOk = !!launcher && existsSync(launcher) && !!bundle && existsSync(bundle);
  checks.push({ name: 'codex launcher', ok: launcherOk, detail: launcherOk ? launcher! : `${launcher ?? 'Codex launcher'} or bundled runtime missing; reinstall Mycelink plugin` });
  checks.push({ name: 'hooks', ok: valid && hooksDisabled, level: 'warn', detail: hooksDisabled
    ? 'Codex plugin-owned hook map is empty: this integration uses its installed launcher, not host hooks; no project hooks installed'
    : 'Codex plugin hook map missing or unexpectedly enabled; inspect the plugin manifest before use' });

  const projectConfig = join(controlRoot, '.codex', 'config.toml');
  if (existsSync(projectConfig)) {
    try {
      const config = parse(readFileSync(projectConfig, 'utf8')) as Record<string, unknown>;
      const unsafe = config['sandbox_mode'] === 'danger-full-access' || config['approval_policy'] === 'never';
      checks.push({ name: 'codex policy', ok: true, level: 'warn', detail: unsafe
        ? `${projectConfig}: danger-full-access sandbox or never approval configured; unsupported for the experimental disposable-repository pilot`
        : `${projectConfig}: existing project settings left untouched; verify effective sandbox/approval policies (user config and overrides may apply)` });
    } catch {
      checks.push({ name: 'codex policy', ok: false, detail: `${projectConfig}: invalid TOML; fix manually (Mycelink never rewrites it)` });
    }
  } else {
    checks.push({ name: 'codex policy', ok: true, level: 'warn', detail: 'no project .codex/config.toml; effective sandbox/approval policies may come from user configuration or CLI overrides' });
  }
  checks.push({ name: 'codex runtime', ok: false, level: 'warn', detail: 'CODEX_RUNTIME_DENIED by doctor alone: experimental worker, review and bounded delivery require an approved graph, held authority and explicit disposable-repository opt-in; standalone resume, verify and deliver remain disabled' });
  return checks;
}
