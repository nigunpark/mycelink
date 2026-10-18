import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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

  it('ships an informational-only plugin without Claude runtime hooks', () => {
    const names = readZip(zip).map((entry) => entry.name);
    expect(names).toContain('.agents/plugins/marketplace.json');
    expect(names).toContain('codex-plugin/plugin.json');
    expect(names).toContain('codex-plugin/skills/mycelink-status/SKILL.md');
    expect(names.filter((name) => name.startsWith('codex-plugin/'))).toEqual([
      'codex-plugin/plugin.json', 'codex-plugin/skills/mycelink-status/SKILL.md',
    ]);

    const manifest = JSON.parse(readFileSync(join(source, 'codex-plugin/plugin.json'), 'utf8')) as { name: string; version: string; description: string };
    expect(manifest).toMatchObject({ name: 'mycelink', version: VERSION });
    expect(manifest.description).toMatch(/disabled.*security review/i);
    const skill = readFileSync(join(source, 'codex-plugin/skills/mycelink-status/SKILL.md'), 'utf8');
    expect(skill).toMatch(/worker\/runtime execution is disabled pending security review/i);
    expect(existsSync(join(source, 'codex-plugin/hooks/hooks.json'))).toBe(false);
  });

  it.runIf(process.env['MYCELINK_LIVE_CODEX_PLUGIN'] === '1')('installs the ZIP via Codex CLI 0.163.0 in an isolated profile and exposes the status skill', async () => {
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
    const cachedSkill = join(home, 'plugins', 'cache', MARKETPLACE, 'mycelink', VERSION, 'skills/mycelink-status/SKILL.md');
    expect(existsSync(cachedSkill), `missing installed skill: ${cachedSkill}`).toBe(true);
    expect(readFileSync(cachedSkill, 'utf8')).toContain('execution is disabled pending security review');
    const discovered = (await discoveredSkills(home, output)).filter((skill) => skill.pluginId === `mycelink@${MARKETPLACE}`);
    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toMatchObject({ name: 'mycelink:mycelink-status', enabled: true, pluginId: `mycelink@${MARKETPLACE}`, path: cachedSkill });
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
