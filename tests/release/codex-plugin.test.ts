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
    expect(manifest.description).toMatch(/planning.*opt-in disposable worker.*delivery disabled/i);
    const skill = readFileSync(join(source, 'codex-plugin/skills/mycelink-status/SKILL.md'), 'utf8');
    expect(skill).toMatch(/experimental disposable worker preflight/i);
    expect(existsSync(join(source, 'codex-plugin/hooks/hooks.json'))).toBe(false);
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
    expect(readFileSync(cachedSkill, 'utf8')).toContain('experimental disposable worker preflight');
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
