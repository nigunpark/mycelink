/** Plugin-management-only Codex harness; NEVER use this for a model/worker invocation. */
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { planCommand } from '../../src/security/exec.js';
import { extractZip } from './zip.js';

export interface IsolatedCodexProfile {
  id: string;
  root: string;
  codexHome: string;
  home: string;
  temp: string;
  workspace: string;
  artifacts: string;
  env: NodeJS.ProcessEnv;
}

export function createIsolatedCodexProfile(): IsolatedCodexProfile {
  const base = join(resolve(process.cwd()), 'tests', '.work', 'MycelinkCodexPluginE2E', 'runs');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, `${randomUUID()}-`));
  const codexHome = join(root, 'codex-home');
  const home = join(root, 'home');
  const temp = join(root, 'temp');
  const workspace = join(root, 'unrelated-project');
  const artifacts = join(root, 'artifacts');
  for (const dir of [codexHome, home, temp, workspace, artifacts]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(workspace, 'README.md'), '# unrelated project — no Mycelink control\n');
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Inherited credentials must not grant an accidental model call or point at a real profile.
  for (const key of Object.keys(env)) {
    if (/^(OPENAI|CODEX|ANTHROPIC|CLAUDE)_.*(KEY|TOKEN|AUTH|HOME|CONFIG|PROFILE|SESSION)$/i.test(key) ||
        /^(OPENAI_API_KEY|CODEX_API_KEY|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|MYCELINK_FAKE_CLAUDE)$/i.test(key)) delete env[key];
  }
  Object.assign(env, {
    CODEX_HOME: codexHome, HOME: home, USERPROFILE: home, TEMP: temp, TMP: temp, TMPDIR: temp,
    XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'), XDG_DATA_HOME: join(home, '.local', 'share'),
    APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'),
  });
  return { id: basename(root), root, codexHome, home, temp, workspace, artifacts, env };
}

export function runCodexCli(profile: IsolatedCodexProfile, args: string[], cwd = profile.workspace) {
  // Metadata-only allowlist: never spawn `codex exec`, interactive Codex or auth login.
  if (!(args.length === 1 && args[0] === '--version') &&
      !(args[0] === 'doctor' && args[1] === '--json') &&
      !(args[0] === 'plugin' && ['marketplace', 'list', 'add', 'remove', 'details'].includes(args[1] ?? '')))
    throw new Error('CODEX_TEST_COMMAND_DENIED: metadata/plugin management only');
  const plan = planCommand(['codex', ...args]);
  const run = spawnSync(plan.file, plan.args, {
    cwd, env: profile.env, encoding: 'utf8', windowsHide: true,
    windowsVerbatimArguments: plan.windowsVerbatimArguments, timeout: 45_000, maxBuffer: 4 << 20,
  });
  if (run.error) throw run.error;
  return run;
}

/** Package and execute the release outside the checkout, without an npm install. */
export function prepareCodexRelease(profile: IsolatedCodexProfile, repository: string) {
  const out = join(profile.artifacts, 'release');
  mkdirSync(out, { recursive: true });
  const packaged = spawnSync(process.execPath, [join(repository, 'scripts', 'package.mjs'), '--out', out], {
    cwd: repository, env: profile.env, encoding: 'utf8', windowsHide: true, timeout: 45_000,
  });
  if (packaged.status !== 0) throw new Error(`package failed: ${packaged.stderr}`);
  const zip = (JSON.parse(packaged.stdout) as { zip: string }).zip;
  const source = join(profile.artifacts, 'marketplace');
  extractZip(zip, source);
  const launcher = join(source, 'codex-plugin', 'bin', 'mycelink.mjs');
  return {
    zip, source,
    run: (args: string[]) => {
      const result = spawnSync(process.execPath, [launcher, ...args], {
        cwd: profile.workspace, env: profile.env, encoding: 'utf8', windowsHide: true, timeout: 30_000,
      });
      if (result.error) throw result.error;
      return result;
    },
  };
}

export interface CodexSkill { name: string; enabled: boolean; pluginId: string | null; path: string }

/** Read-only app-server skills/list; no thread, turn, auth or model request. */
export async function discoverCodexSkills(profile: IsolatedCodexProfile): Promise<CodexSkill[]> {
  const plan = planCommand(['codex', 'app-server']);
  const child = spawn(plan.file, plan.args, {
    cwd: profile.workspace, env: profile.env, windowsHide: true,
    windowsVerbatimArguments: plan.windowsVerbatimArguments, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout });
  try {
    return await new Promise<CodexSkill[]>((resolveSkills, rejectSkills) => {
      let finished = false;
      const timer = setTimeout(() => finish(new Error('isolated Codex skills/list timed out')), 20_000);
      const finish = (error?: Error, skills?: CodexSkill[]) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (error) rejectSkills(error);
        else resolveSkills(skills ?? []);
      };
      child.on('error', (error) => finish(error));
      child.on('close', () => finish(new Error('Codex app-server closed before skills/list')));
      lines.on('line', (line) => {
        try {
          const response = JSON.parse(line) as { id?: number; error?: { message: string }; result?: { data: { skills: CodexSkill[] }[] } };
          if (response.error) return finish(new Error(response.error.message));
          if (response.id === 1) {
            child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
            child.stdin.write(`${JSON.stringify({ id: 2, method: 'skills/list', params: { cwds: [profile.workspace], forceReload: true } })}\n`);
          }
          if (response.id === 2) finish(undefined, response.result?.data.flatMap((row) => row.skills));
        } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      });
      child.stdin.write(`${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'mycelink_isolated_test', title: 'Isolated skill test', version: '0.1.0' } } })}\n`);
    });
  } finally {
    lines.close();
    const closed = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('close', () => resolve());
    });
    child.kill();
    await closed;
  }
}

export function destroyCodexProfile(profile: IsolatedCodexProfile): void {
  if (existsSync(profile.root)) rmSync(profile.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
