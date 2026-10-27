import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import YAML from 'yaml';
import { VALID_GRAPH, VALID_REPOSITORIES } from '../helpers/graph-fixtures.js';
import { makeTmpDir, cleanupTmpRoots } from '../helpers/tmp.js';
import { extractZip, readZip } from '../helpers/zip.js';
import { planCommand } from '../../src/security/exec.js';

const ROOT = resolve(process.cwd());
const VERSION = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
const MARKETPLACE = 'mycelink-codex-marketplace';
afterAll(() => cleanupTmpRoots());

function runCodex(args: string[], home: string, cwd: string) {
  const plan = planCommand(['codex', ...args]);
  const result = spawnSync(plan.file, plan.args, {
    cwd, encoding: 'utf8', timeout: 45_000, windowsHide: true,
    windowsVerbatimArguments: plan.windowsVerbatimArguments,
    env: { ...process.env, CODEX_HOME: home },
  });
  if (result.error) throw result.error;
  return result;
}

async function discoveredSkills(home: string, cwd: string): Promise<{ name: string; enabled: boolean; pluginId: string | null; path: string }[]> {
  const plan = planCommand(['codex', 'app-server']);
  const child = spawn(plan.file, plan.args, {
    cwd, env: { ...process.env, CODEX_HOME: home }, windowsHide: true,
    windowsVerbatimArguments: plan.windowsVerbatimArguments,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout });
  try {
    return await new Promise((resolveSkills, rejectSkills) => {
      const timer = setTimeout(() => rejectSkills(new Error('Codex app-server skills/list timed out')), 20_000);
      const finish = (error?: Error, skills?: { name: string; enabled: boolean; pluginId: string | null; path: string }[]) => {
        clearTimeout(timer);
        if (error) rejectSkills(error);
        else resolveSkills(skills ?? []);
      };
      child.on('error', finish);
      child.on('close', () => finish(new Error('Codex app-server closed before skills/list')));
      lines.on('line', (line) => {
        const response = JSON.parse(line) as { id?: number; error?: { message: string }; result?: { data: { skills: { name: string; enabled: boolean; pluginId: string | null; path: string }[] }[] } };
        if (response.error) return finish(new Error(response.error.message));
        if (response.id === 1) {
          child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
          child.stdin.write(`${JSON.stringify({ id: 2, method: 'skills/list', params: { cwds: [cwd], forceReload: true } })}\n`);
        }
        if (response.id === 2) finish(undefined, response.result?.data.flatMap((row) => row.skills));
      });
      child.stdin.write(`${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'mycelink_plugin_test', title: 'Mycelink plugin test', version: '0.1.0' } } })}\n`);
    });
  } finally {
    lines.close();
    child.kill();
  }
}

/** The release ZIP alone must supply a local marketplace and the safe plugin. */
describe('Codex release plugin in an isolated CODEX_HOME', () => {
  let output: string;
  let source: string;
  let zip: string;
  beforeAll(() => {
    output = makeTmpDir('codex-release-');
    const built = spawnSync(process.execPath, [join(ROOT, 'scripts/package.mjs'), '--out', output], {
      cwd: ROOT, encoding: 'utf8', timeout: 45_000, windowsHide: true,
    });
    expect(built.status, built.stderr).toBe(0);
    zip = join(output, `mycelink-${VERSION}.zip`);
    source = join(output, 'marketplace');
    extractZip(zip, source);
  });

  it('ships the planning skills and a launcher inside the installed plugin without Claude runtime hooks', () => {
    const names = readZip(zip).map((entry) => entry.name);
    expect(names).toContain('.agents/plugins/marketplace.json');
    expect(names).toContain('codex-plugin/plugin.json');
    expect(names).toContain('codex-plugin/skills/mycelink-status/SKILL.md');
    for (const name of ['init', 'prd', 'plan', 'status', 'run', 'resume', 'verify', 'deliver']) {
      expect(names).toContain(`codex-plugin/skills/mycelink-${name}/SKILL.md`);
    }
    expect(names).toContain('codex-plugin/bin/mycelink.mjs');
    expect(names).toContain('codex-plugin/dist/mycelink.mjs');
    expect(names).toContain('codex-plugin/package.json');
    expect(names).toContain('codex-plugin/schemas/portfolio-graph.schema.json');

    const manifest = JSON.parse(readFileSync(join(source, 'codex-plugin/plugin.json'), 'utf8')) as { name: string; version: string; description: string };
    expect(manifest).toMatchObject({ name: 'mycelink', version: VERSION });
    expect(manifest.description).toMatch(/planning.*opt-in disposable worker.*review.*delivery/i);
    const listing = JSON.parse(readFileSync(join(source, '.agents/plugins/marketplace.json'), 'utf8')) as { interface: { displayName: string } };
    expect(listing.interface.displayName).toMatch(/experimental/i);
    expect(manifest.description).toMatch(/opt-in disposable.*review.*delivery/i);
    expect(manifest.description).not.toMatch(/disabled/i);
    const skill = readFileSync(join(source, 'codex-plugin/skills/mycelink-status/SKILL.md'), 'utf8');
    expect(skill).toMatch(/runtime preflight denotes eligibility/i);
    expect(skill).toMatch(/not\*\* that implementation, review or delivery occurred/i);
    expect(existsSync(join(source, 'codex-plugin/hooks/hooks.json'))).toBe(false);
  });

  it('guides a fresh approved PRD through a held-authority reviewed delivery without leaking a planning key', () => {
    const skill = (name: string) => readFileSync(join(source, `codex-plugin/skills/mycelink-${name}/SKILL.md`), 'utf8');
    expect(skill('prd')).toMatch(/codex prepare/);
    expect(skill('prd')).not.toMatch(/--authority <key>/);
    expect(skill('plan')).toMatch(/codex prepare/);
    expect(skill('plan')).not.toMatch(/--authority <key>/);
    expect(skill('run')).toMatch(/codex continue.*--review.*--deliver/s);
    expect(skill('run')).not.toMatch(/reviewer and delivery remain disabled/i);
    expect(skill('deliver')).toMatch(/codex continue.*--review.*--deliver/s);
    expect(skill('deliver')).toMatch(/standalone.*codex deliver.*denied/is);
    expect(skill('init')).not.toMatch(/runtime is denied pending independent security review/i);
  });

  it.each(['run', 'resume'])('packaged mycelink-%s guides held-authority continuation of an existing valid controller', (name) => {
    const skill = readFileSync(join(source, `codex-plugin/skills/mycelink-${name}/SKILL.md`), 'utf8');
    expect(skill).toMatch(/codex continue[^\n`]*--review[^\n`]*--deliver/);
    expect(skill).toMatch(/(?:resum\w*|continu\w*)[^.\n]*existing[^.\n]*(?:valid|controller|authority)/i);
    expect(skill).toMatch(/held[- ]authority|holds?[^.\n]*authority|retains?[^.\n]*authority/i);
  });

  it.each(['run', 'resume', 'deliver'])('packaged mycelink-%s does not falsely forbid recovery of valid controller authority', (name) => {
    const skill = readFileSync(join(source, `codex-plugin/skills/mycelink-${name}/SKILL.md`), 'utf8');
    expect(skill).not.toMatch(/never invoke[^.\n]*existing key/i);
    expect(skill).not.toMatch(/(?:never[^.\n]*recovery[^.\n]*closed authority|closed authority[^.\n]*cannot[^.\n]*(?:reused|recovered))/i);
  });

  it('packaged delivery guidance resumes a built candidate after PASS without a second review', () => {
    const skill = readFileSync(join(source, 'codex-plugin/skills/mycelink-deliver/SKILL.md'), 'utf8');
    expect(skill).toMatch(/codex continue[^\n`]*--review[^\n`]*--deliver/);
    expect(skill).toMatch(/(?:built|existing|already[- ]built)[^.\n]*candidate|candidate[^.\n]*(?:already built|has been built)/i);
    expect(skill).toMatch(/PASS/);
    expect(skill).toMatch(/(?:without|no|does not require)[^.\n]*(?:second|another|repeat(?:ed)?|new)[^.\n]*review|(?:skip|reuse)[^.\n]*review/i);
    expect(skill).toMatch(/resum\w*|continu\w*/i);
  });

  it('packaged planning preflight commits approved inputs in the fresh disposable control before workers run', () => {
    const skill = readFileSync(join(source, 'codex-plugin/skills/mycelink-plan/SKILL.md'), 'utf8');
    // Registered worker repositories being Git repositories is insufficient:
    // candidate construction also needs a committed control repository.
    expect(skill).toMatch(/(?:fresh|disposable)[^.\n]*control|control[^.\n]*(?:fresh|disposable)/i);
    expect(skill).toMatch(/git init\b/);
    expect(skill).toMatch(/git (?:-C\s+(?:"[^"]+"|\S+)\s+)?add\b/);
    expect(skill).toMatch(/git (?:-C\s+(?:"[^"]+"|\S+)\s+)?commit\b/);
    expect(skill).toMatch(/(?:commit[^.\n]*approved|approved[^.\n]*commit)/i);
    expect(skill).toMatch(/(?:before|prior to)[^.\n]*(?:worker|codex continue)/i);
  });

  it('packaged planning preflight checks Windows-to-WSL shell acceptance scripts for LF and Bash syntax', () => {
    const skill = readFileSync(join(source, 'codex-plugin/skills/mycelink-plan/SKILL.md'), 'utf8');
    expect(skill).toMatch(/Windows/i);
    expect(skill).toMatch(/WSL/);
    expect(skill).toMatch(/acceptance[^.\n]*(?:shell|script)|(?:shell|script)[^.\n]*acceptance/i);
    expect(skill).toMatch(/\bLF\b/);
    expect(skill).toMatch(/\bCRLF\b/);
    expect(skill).toMatch(/bash -n\b/);
    expect(skill).toMatch(/(?:before|prior to)[^.\n]*(?:worker|codex continue)/i);
  });

  it('packaged continuation guidance preserves experimental disposable opt-in and standalone command denials', () => {
    const skill = (name: string) => readFileSync(join(source, `codex-plugin/skills/mycelink-${name}/SKILL.md`), 'utf8');
    expect(skill('run')).toMatch(/experimental_codex\.enabled:\s*true/);
    expect(skill('run')).toMatch(/experimental_codex\.disposable_repositories/);
    expect(skill('run')).toMatch(/never opt in[^.\n]*production/i);
    expect(skill('resume')).toMatch(/standalone[^.\n]*codex resume[^.\n]*(?:denied|CODEX_RUNTIME_DENIED)/i);
    expect(skill('resume')).toMatch(/(?:do not|never)[^.\n]*generic[^.\n]*dispatch[^.\n]*session[^.\n]*orchestrate[^.\n]*codex exec/i);
    expect(skill('deliver')).toMatch(/standalone[^.\n]*codex deliver[^.\n]*denied/i);
    expect(skill('deliver')).toMatch(/do not bypass[^.\n]*generic[^.\n]*deliver[^.\n]*candidate[^.\n]*settle[^.\n]*orchestrate[^.\n]*codex exec/i);
  });

  it('prepares a fresh Codex PRD and reviewed graph without minting an authority before continuation', () => {
    const control = join(output, 'fresh-codex-prepare');
    const launcher = join(source, 'codex-plugin/bin/mycelink.mjs');
    const run = (args: string[]) => spawnSync(process.execPath, [launcher, ...args], { cwd: output, encoding: 'utf8', timeout: 30_000, windowsHide: true });
    expect(run(['codex', 'init', control, '--json']).status).toBe(0);
    const feature = join(control, 'features/FEAT-101');
    mkdirSync(feature, { recursive: true });
    const requirement = '# Pilot\n\nStatus: approved\n\n**AC-1 — behavior.** Produce a safe value.\n\n**AC-2 — API.** Expose the safe value.\n';
    writeFileSync(join(feature, 'PRD.md'), requirement);
    writeFileSync(join(control, 'repositories.yaml'), YAML.stringify(VALID_REPOSITORIES));
    const graph = structuredClone(VALID_GRAPH);
    graph.acceptance_criteria = [
      { id: 'AC-1', text: '**AC-1 — behavior.** Produce a safe value.', kind: 'new-behavior' },
      { id: 'AC-2', text: '**AC-2 — API.** Expose the safe value.', kind: 'new-behavior' },
    ];
    const draft = join(feature, 'PORTFOLIO-GRAPH.draft.yaml');
    writeFileSync(draft, YAML.stringify(graph));
    const generic = run(['feature', 'acceptance', 'FEAT-101', '--source', 'features/FEAT-101/PRD.md', '--control-root', control, '--json']);
    expect(generic.status).toBe(1);
    expect(generic.stderr).toContain('CONTROLLER_AUTHORITY_REQUIRED');
    const prepared = run(['codex', 'prepare', 'FEAT-101', '--source', 'features/FEAT-101/PRD.md', '--from', draft, '--control-root', control, '--json']);
    expect(prepared.status, prepared.stderr).toBe(0);
    expect(JSON.parse(prepared.stdout)).toMatchObject({ prepared: true, feature_id: 'FEAT-101', criteria: ['AC-1', 'AC-2'] });
    expect(run(['graph', 'validate', 'FEAT-101', '--control-root', control, '--json']).status).toBe(0);
    expect(existsSync(join(control, '.mycelink/controller-authority.json'))).toBe(false);
    expect(existsSync(join(feature, 'STATE.json'))).toBe(false);
    const opened = run(['controller', 'open', '--control-root', control, '--json']);
    expect(opened.status, opened.stderr).toBe(0);
    const replay = run(['codex', 'prepare', 'FEAT-101', '--source', 'features/FEAT-101/PRD.md', '--from', draft, '--control-root', control, '--json']);
    expect(replay.status).toBe(1);
    expect(replay.stderr).toContain('CODEX_PREPARE_AUTHORITY_EXISTS');
  });

  it.skipIf(process.platform !== 'win32')('reports review and bounded delivery eligibility honestly after disposable opt-in', () => {
    const control = join(output, 'codex-status-enabled');
    const repo = join(output, 'codex-status-repo');
    mkdirSync(repo, { recursive: true });
    const git = spawnSync('git', ['init', '--initial-branch=main', repo], { encoding: 'utf8', windowsHide: true });
    expect(git.status, git.stderr).toBe(0);
    const launcher = join(source, 'codex-plugin/bin/mycelink.mjs');
    const run = (args: string[]) => spawnSync(process.execPath, [launcher, ...args], { cwd: output, encoding: 'utf8', timeout: 30_000, windowsHide: true });
    expect(run(['codex', 'init', control, '--json']).status).toBe(0);
    writeFileSync(join(control, 'repositories.yaml'), YAML.stringify({ schema_version: 1, repositories: [{
      name: 'core', path: '../codex-status-repo', base_branch: 'main', role: 'producer',
      commands: { test: ['node', '--test'] },
    }] }));
    const configPath = join(control, 'mycelink.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    config['experimental_codex'] = { enabled: true, disposable_repositories: ['core'] };
    writeFileSync(configPath, JSON.stringify(config));
    const result = run(['codex', 'status', 'FEAT-101', '--control-root', control, '--json']);
    expect(result.status, result.stderr).toBe(0);
    const status = JSON.parse(result.stdout) as { runtime_enabled: boolean; runtime_reason: string };
    expect(status.runtime_enabled).toBe(true);
    expect(status.runtime_reason).toMatch(/review.*deliver/i);
    expect(status.runtime_reason).not.toMatch(/review.*not enabled|delivery.*not enabled/i);
  });

  it('initialises a Codex-only control and binds PRD criteria to a validated graph, but refuses execution', () => {
    const control = join(output, 'codex-control');
    const launcher = join(source, 'codex-plugin/bin/mycelink.mjs');
    const run = (args: string[]) => spawnSync(process.execPath, [launcher, ...args], { cwd: output, encoding: 'utf8', timeout: 30_000, windowsHide: true });
    const init = run(['codex', 'init', control, '--json']);
    expect(init.status, init.stderr).toBe(0);
    const reinit = run(['codex', 'init', control, '--json']);
    expect(reinit.status, reinit.stderr).toBe(0);
    expect(JSON.parse(reinit.stdout)).toMatchObject({ planning_only: true, runtime_enabled: false });
    const occupied = join(output, 'existing-claude-assets');
    mkdirSync(occupied);
    writeFileSync(join(occupied, 'CLAUDE.md'), '# Existing Claude asset\n');
    const occupiedInit = run(['codex', 'init', occupied, '--json']);
    expect(occupiedInit.status).toBe(1);
    expect(occupiedInit.stderr).toContain('CODEX_INIT_OCCUPIED');
    expect(readFileSync(join(occupied, 'CLAUDE.md'), 'utf8')).toBe('# Existing Claude asset\n');
    expect(existsSync(join(occupied, 'mycelink.config.json'))).toBe(false);
    expect(existsSync(join(control, '.claude/settings.json'))).toBe(false);
    expect(existsSync(join(control, 'CLAUDE.md'))).toBe(false);
    expect(JSON.parse(readFileSync(join(control, 'mycelink.config.json'), 'utf8')).provider.provider).toBe('codex');
    const requirement = '# Pilot\n\nStatus: approved\n\n**AC-1 — behavior.** Produce a safe value.\n\n**AC-2 — API.** Expose the safe value.\n';
    mkdirSync(join(control, 'features/FEAT-101'), { recursive: true });
    writeFileSync(join(control, 'features/FEAT-101/PRD.md'), requirement, { flag: 'wx' });
    const authority = JSON.parse(run(['controller', 'open', '--control-root', control, '--json']).stdout).authority as string;
    const prd = run(['feature', 'acceptance', 'FEAT-101', '--source', 'features/FEAT-101/PRD.md', '--control-root', control, '--authority', authority, '--json']);
    expect(prd.status, prd.stderr).toBe(0);
    const manifest = JSON.parse(readFileSync(join(control, 'features/FEAT-101/ACCEPTANCE.json'), 'utf8')) as { criteria: { id: string; text: string; kind: string }[] };
    expect(manifest.criteria).toEqual([
      { id: 'AC-1', text: '**AC-1 — behavior.** Produce a safe value.', kind: 'new-behavior', sha256: expect.any(String) },
      { id: 'AC-2', text: '**AC-2 — API.** Expose the safe value.', kind: 'new-behavior', sha256: expect.any(String) },
    ]);
    const repos = structuredClone(VALID_REPOSITORIES);
    writeFileSync(join(control, 'repositories.yaml'), YAML.stringify(repos));
    const graph = structuredClone(VALID_GRAPH);
    graph.acceptance_criteria = manifest.criteria.map(({ id, text, kind }) => ({ id, text, kind }));
    const graphFile = join(output, 'approved.yaml');
    writeFileSync(graphFile, YAML.stringify(graph));
    const compiled = run(['graph', 'compile', 'FEAT-101', '--from', graphFile, '--control-root', control, '--authority', authority, '--json']);
    expect(compiled.status, compiled.stderr).toBe(0);
    expect(run(['graph', 'validate', 'FEAT-101', '--control-root', control, '--json']).status).toBe(0);
    const status = run(['codex', 'status', 'FEAT-101', '--control-root', control, '--json']);
    expect(status.status, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ graph_valid: true, state_present: false, runtime_enabled: false, runtime_reason: expect.stringMatching(/experimental opt-in/) });
    for (const action of ['run', 'resume', 'verify', 'deliver']) {
      const denied = run(['codex', action, 'FEAT-101', '--control-root', control, '--json']);
      expect(denied.status, `${action}: ${denied.stdout} ${denied.stderr}`).toBe(1);
      expect(denied.stderr).toMatch(/CODEX_RUNTIME_DENIED.*experimental opt-in/i);
    }
    for (const command of [
      ['init', control], ['dispatch', 'FEAT-101'], ['session', 'spawn', 'FEAT-101'],
      ['review', 'settle', 'FEAT-101'], ['deliver', 'FEAT-101'], ['orchestrate', 'run', 'FEAT-101'],
    ]) {
      const denied = run([...command, '--control-root', control, '--authority', authority, '--json']);
      expect(denied.status, `${command.join(' ')}: ${denied.stdout} ${denied.stderr}`).toBe(1);
      expect(denied.stderr).toContain('CODEX_RUNTIME_DENIED');
    }
    expect(existsSync(join(control, '.claude/settings.json'))).toBe(false);
    expect(existsSync(join(control, 'features/FEAT-101/STATE.json'))).toBe(false);
  });

  it.runIf(process.env['MYCELINK_LIVE_CODEX_PLUGIN'] === '1')('installs the ZIP via Codex CLI 0.163.0 in an isolated profile and exposes all workflow skills', async () => {
    const home = join(output, 'isolated-codex-home');
    mkdirSync(home, { recursive: true });
    const invoke = (args: string[]) => {
      const result = runCodex(args, home, output);
      expect(result.status, `codex ${args.join(' ')}: ${result.stderr}\n${result.stdout}`).toBe(0);
      return JSON.parse(result.stdout) as unknown;
    };
    const version = runCodex(['--version'], home, output);
    expect(version.status).toBe(0);
    expect(version.stdout).toMatch(/codex-cli 0\.163\.0/);
    invoke(['plugin', 'marketplace', 'add', source, '--json']);
    const markets = invoke(['plugin', 'marketplace', 'list', '--json']);
    expect(JSON.stringify(markets)).toContain(MARKETPLACE);
    const available = invoke(['plugin', 'list', '--available', '--json']);
    expect(JSON.stringify(available)).toContain('mycelink');
    invoke(['plugin', 'add', `mycelink@${MARKETPLACE}`, '--json']);
    const installed = invoke(['plugin', 'list', '--json']) as { installed: { pluginId: string; installed: boolean; enabled: boolean; version: string }[] };
    expect(installed.installed).toContainEqual(expect.objectContaining({
      pluginId: `mycelink@${MARKETPLACE}`, installed: true, enabled: true, version: VERSION,
    }));
    const cache = join(home, 'plugins', 'cache', MARKETPLACE, 'mycelink', VERSION);
    const cachedSkill = join(cache, 'skills/mycelink-status/SKILL.md');
    expect(existsSync(join(cache, 'bin/mycelink.mjs'))).toBe(true);
    expect(existsSync(join(cache, 'dist/mycelink.mjs'))).toBe(true);
    expect(existsSync(join(cache, 'schemas/portfolio-graph.schema.json'))).toBe(true);
    const installedVersion = spawnSync(process.execPath, [join(cache, 'bin/mycelink.mjs'), '--version'], { cwd: output, encoding: 'utf8', timeout: 30_000, windowsHide: true });
    expect(installedVersion.status, installedVersion.stderr).toBe(0);
    expect(installedVersion.stdout).toContain(VERSION);
    const cachedRun = spawnSync(process.execPath, [join(cache, 'bin/mycelink.mjs'), 'codex', 'init', join(output, 'installed-codex-control'), '--json'], {
      cwd: output, env: { ...process.env, CODEX_HOME: home }, encoding: 'utf8', timeout: 30_000, windowsHide: true,
    });
    expect(cachedRun.status, cachedRun.stderr).toBe(0);
    expect(JSON.parse(cachedRun.stdout)).toMatchObject({ planning_only: true, runtime_enabled: false });
    const installedDoctor = spawnSync(process.execPath, [join(cache, 'bin/mycelink.mjs'), 'doctor', '--control-root', join(output, 'installed-codex-control'), '--json'], {
      cwd: output, env: { ...process.env, CODEX_HOME: home }, encoding: 'utf8', timeout: 30_000, windowsHide: true,
    });
    expect(installedDoctor.status, installedDoctor.stderr).toBe(1); // no repositories or auth; runtime denied
    const installedChecks = (JSON.parse(installedDoctor.stdout) as { checks: { name: string; ok: boolean; detail: string }[] }).checks;
    for (const name of ['codex executable', 'codex plugin installation', 'codex plugin', 'codex skills', 'codex launcher']) {
      expect(installedChecks.find((entry) => entry.name === name)?.ok, name).toBe(true);
    }
    expect(installedChecks.find((entry) => entry.name === 'codex login')?.ok).toBe(false);
    expect(installedChecks.find((entry) => entry.name === 'codex runtime')?.ok).toBe(false);
    expect(existsSync(join(output, 'installed-codex-control', '.claude', 'settings.json'))).toBe(false);
    expect(readFileSync(cachedSkill, 'utf8')).toContain('runtime preflight denotes eligibility');
    const discovered = (await discoveredSkills(home, output)).filter((skill) => skill.pluginId === `mycelink@${MARKETPLACE}`);
    expect(discovered.map((s) => s.name).sort()).toEqual(['init', 'prd', 'plan', 'status', 'run', 'resume', 'verify', 'deliver'].map((n) => `mycelink:mycelink-${n}`).sort());
    for (const skill of discovered) expect(skill).toMatchObject({ enabled: true, pluginId: `mycelink@${MARKETPLACE}`, path: join(cache, 'skills', skill.name.split(':')[1]!, 'SKILL.md') });
    const diagnostics = runCodex(['doctor', '--json'], home, output);
    const diagnosticReport = JSON.parse(diagnostics.stdout) as { codexVersion: string; checks: Record<string, { status: string }> };
    expect(diagnosticReport.codexVersion).toBe('0.163.0');
    expect(diagnosticReport.checks['config.load']?.status).toBe('ok');
    // Doctor's overall status depends on OS/network/auth warnings, not plugin installation.
    expect([0, 1]).toContain(diagnostics.status);
    // The ZIP also carries the prebuilt CLI; it is separate from the Codex plugin.
    expect(existsSync(join(source, 'bin/mycelink.mjs'))).toBe(true);
    const doctor = spawnSync(process.execPath, [join(source, 'bin/mycelink.mjs'), 'doctor', '--json'], {
      cwd: output, env: { ...process.env, CODEX_HOME: home }, encoding: 'utf8', timeout: 30_000,
    });
    const report = JSON.parse(doctor.stdout) as { checks: { name: string; ok: boolean }[] };
    expect(report.checks.find((check) => check.name === 'node')?.ok).toBe(true);
    // Bare workspace is expected to fail doctor; this smoke proves the bundled launcher starts.
    expect(doctor.status).toBe(1);
  }, 180_000);
});
