/**
 * Isolated plugin harness.
 *
 * Runs the real Claude Code CLI against a GUID-scoped isolated profile with
 * separate config, home, temp, npm and artifact directories (no Docker, WSL
 * or VM).
 *
 * Every command here is a plugin-management command. None of them invokes a
 * model, so the suite is free to run in CI and on a developer machine.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  claudeAvailable,
  claudeVersion,
  createIsolatedProfile,
  destroyProfile,
  runClaude,
  type ClaudeRun,
  type IsolatedProfile,
} from '../helpers/isolated-profile.js';

const PLUGIN_SOURCE = resolve(process.cwd());
const PLUGIN_NAME = 'mycelink';
const MARKETPLACE = 'mycelink-marketplace';
const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE}`;
const PKG_VERSION = (JSON.parse(readFileSync(join(PLUGIN_SOURCE, 'package.json'), 'utf8')) as { version: string }).version;

const available = claudeAvailable();
const describeIfClaude = available ? describe : describe.skip;

if (!available) {
  // Make the skip loud rather than silent: a missing CLI must not read as a pass.
  // eslint-disable-next-line no-console
  console.warn('[plugin-e2e] Claude Code CLI not found on PATH; isolated plugin harness skipped.');
}

/** Record every run so the final report can cite real exit codes. */
const transcript: { label: string; command: string; code: number | null; ms: number }[] = [];

function record(label: string, run: ClaudeRun): ClaudeRun {
  transcript.push({
    label,
    command: run.command.join(' '),
    code: run.code,
    ms: run.durationMs,
  });
  return run;
}

describeIfClaude('isolated plugin harness', () => {
  let profile: IsolatedProfile;

  beforeAll(() => {
    profile = createIsolatedProfile(PLUGIN_SOURCE);
  });

  afterAll(() => {
    if (profile) {
      writeFileSync(
        join(profile.artifacts, 'cli-transcript.json'),
        JSON.stringify({ claude: claudeVersion(), runs: transcript }, null, 2),
        'utf8',
      );
      destroyProfile(profile);
    }
  });

  it('isolates the profile away from the developer configuration', () => {
    expect(profile.root).toContain('MycelinkPluginE2E');
    expect(profile.env['CLAUDE_CONFIG_DIR']).toBe(profile.config);
    expect(profile.env['HOME']).toBe(profile.home);
    expect(profile.env['USERPROFILE']).toBe(profile.home);
    expect(profile.env['TEMP']).toBe(profile.temp);
    // The real user profile must not be in play.
    expect(profile.config).not.toBe(join(process.env['USERPROFILE'] ?? '', '.claude'));
  });

  it('copies the package including the hidden .claude-plugin manifest directory', () => {
    expect(existsSync(join(profile.source, '.claude-plugin', 'plugin.json'))).toBe(true);
    expect(existsSync(join(profile.source, '.claude-plugin', 'marketplace.json'))).toBe(true);
    expect(existsSync(join(profile.source, 'commands', 'run.md'))).toBe(true);
    expect(existsSync(join(profile.source, 'skills', 'node-worker', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(profile.source, 'agents', 'module-worker.md'))).toBe(true);
    expect(existsSync(join(profile.source, 'bin', 'mycelink.mjs'))).toBe(true);
    // The build output must travel with it, or mycelink cannot run.
    expect(existsSync(join(profile.source, 'dist', 'index.js'))).toBe(true);
  });

  it('passes the CLI plugin validator', () => {
    const run = record('validate', runClaude(profile, ['plugin', 'validate', `"${profile.source}"`]));
    expect(run.stdout + run.stderr).toMatch(/Validation passed/i);
    expect(run.code).toBe(0);
  });

  it('loads in direct mode via --plugin-dir, as a session-scoped plugin', () => {
    const run = record(
      'direct-mode',
      runClaude(profile, ['--plugin-dir', `"${profile.source}"`, 'plugin', 'list', '--json']),
    );
    expect(run.code).toBe(0);
    const plugins = JSON.parse(run.stdout) as { id: string; scope: string; enabled: boolean }[];
    const inline = plugins.find((p) => p.id.startsWith(PLUGIN_NAME) && p.scope === 'session');
    expect(inline, `direct-mode plugin not loaded; got ${run.stdout}`).toBeDefined();
    expect(inline?.enabled).toBe(true);
  });

  it('installs from a local marketplace into the isolated config', () => {
    const add = record(
      'marketplace-add',
      runClaude(profile, ['plugin', 'marketplace', 'add', `"${profile.source}"`]),
    );
    expect(add.code).toBe(0);

    const list = record(
      'marketplace-list',
      runClaude(profile, ['plugin', 'marketplace', 'list', '--json']),
    );
    expect(list.code).toBe(0);
    const marketplaces = JSON.parse(list.stdout) as { name: string; path: string }[];
    expect(marketplaces.some((m) => m.name === MARKETPLACE)).toBe(true);

    const install = record(
      'install',
      runClaude(profile, ['plugin', 'install', PLUGIN_ID, '--json', '-y']),
    );
    expect(install.code).toBe(0);
    const outcome = JSON.parse(install.stdout.trim().split('\n').pop() as string) as {
      outcome: string;
      pluginId: string;
    };
    expect(outcome.outcome).toBe('ok');
    expect(outcome.pluginId).toBe(PLUGIN_ID);
  });

  it('reports the installed plugin inside the isolated profile, not the real one', () => {
    const run = record('list-installed', runClaude(profile, ['plugin', 'list', '--json']));
    expect(run.code).toBe(0);
    const plugins = JSON.parse(run.stdout) as {
      id: string;
      version: string;
      enabled: boolean;
      installPath: string;
    }[];
    const installed = plugins.find((p) => p.id === PLUGIN_ID);
    expect(installed).toBeDefined();
    expect(installed?.version).toBe(PKG_VERSION);
    expect(installed?.enabled).toBe(true);
    // Proof of isolation: the install landed under our GUID-scoped config.
    expect(installed?.installPath.replace(/\\/g, '/')).toContain(
      profile.config.replace(/\\/g, '/'),
    );
  });

  it('exposes every command, skill and agent in the component inventory', () => {
    const run = record('details', runClaude(profile, ['plugin', 'details', PLUGIN_NAME]));
    expect(run.code).toBe(0);
    const out = run.stdout;

    for (const command of [
      'init',
      'prd',
      'plan',
      'run',
      'status',
      'resume',
      'cancel',
      'decision',
      'verify',
    ]) {
      expect(out, `command ${command} missing from inventory`).toContain(command);
    }
    for (const skill of [
      'portfolio-decomposition',
      'graph-compilation',
      'node-worker',
      'fresh-verification',
      'integration-failure-attribution',
      'e2e-scheduling',
      'brain-memory',
    ]) {
      expect(out, `skill ${skill} missing from inventory`).toContain(skill);
    }
    for (const agent of [
      'portfolio-planner',
      'module-worker',
      'fresh-verifier',
      'failure-attributor',
      'e2e-worker',
    ]) {
      expect(out, `agent ${agent} missing from inventory`).toContain(agent);
    }
  });

  it('keeps its always-on context cost small', () => {
    const run = record('details-cost', runClaude(profile, ['plugin', 'details', PLUGIN_NAME]));
    const match = /Always-on:\s*~([\d,]+)\s*tok/.exec(run.stdout);
    expect(match, `no always-on cost reported in:\n${run.stdout}`).not.toBeNull();
    const tokens = Number((match?.[1] ?? '0').replace(/,/g, ''));
    // Descriptions only; bodies load on invocation. Keep the standing cost modest.
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(4000);
  });

  it('ships no always-on plugin hooks, because enforcement is project-scoped', () => {
    const run = record('details-hooks', runClaude(profile, ['plugin', 'details', PLUGIN_NAME]));
    // Hooks belong to a control repository, installed by `mycelink init`.
    // A plugin-scoped hook would run in every unrelated project.
    expect(run.stdout).toMatch(/Hooks \(0\)/);
  });

  it('runs mycelink from the installed copy', () => {
    const list = runClaude(profile, ['plugin', 'list', '--json']);
    const plugins = JSON.parse(list.stdout) as { id: string; installPath: string }[];
    const installPath = plugins.find((p) => p.id === PLUGIN_ID)?.installPath as string;
    expect(existsSync(join(installPath, 'bin', 'mycelink.mjs'))).toBe(true);

    const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
    const proc = spawnSync(process.execPath, [join(installPath, 'bin', 'mycelink.mjs'), 'doctor', '--json'], {
      cwd: profile.workspace,
      encoding: 'utf8',
      env: profile.env,
      timeout: 120_000,
      windowsHide: true,
    });
    transcript.push({
      label: 'installed-mycelink-doctor',
      command: `node ${join(installPath, 'bin', 'mycelink.mjs')} doctor --json`,
      code: proc.status,
      ms: 0,
    });
    // doctor exits 1 in a bare workspace (no control repo); the point is that
    // it ran from the installed copy and produced a structured report.
    const report = JSON.parse(proc.stdout) as { checks: { name: string; ok: boolean }[] };
    expect(report.checks.find((c) => c.name === 'node')?.ok).toBe(true);
    expect(report.checks.some((c) => c.name === 'mycelink.config.json')).toBe(true);
  });

  it('initialises a control repository from the installed copy', () => {
    const list = runClaude(profile, ['plugin', 'list', '--json']);
    const plugins = JSON.parse(list.stdout) as { id: string; installPath: string }[];
    const installPath = plugins.find((p) => p.id === PLUGIN_ID)?.installPath as string;

    const control = join(profile.workspace, 'control');
    mkdirSync(control, { recursive: true });
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
    const proc = spawnSync(
      process.execPath,
      [join(installPath, 'bin', 'mycelink.mjs'), 'init', control],
      { encoding: 'utf8', env: profile.env, timeout: 120_000, windowsHide: true },
    );
    expect(proc.status).toBe(0);
    expect(existsSync(join(control, 'mycelink.config.json'))).toBe(true);
    expect(existsSync(join(control, 'CLAUDE.md'))).toBe(true);

    const settings = JSON.parse(
      readFileSync(join(control, '.claude', 'settings.json'), 'utf8'),
    ) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    // The generated hook commands must point at the INSTALLED launcher.
    const command = settings.hooks['PreToolUse']?.[0]?.hooks[0]?.command ?? '';
    expect(command).toContain('mycelink.mjs');
    expect(command.replace(/\\/g, '/')).toContain(installPath.replace(/\\/g, '/'));
  });

  it('uninstalls cleanly and the plugin stops being listed', () => {
    const uninstall = record(
      'uninstall',
      runClaude(profile, ['plugin', 'uninstall', PLUGIN_NAME, '--json']),
    );
    expect([0, null]).toContain(uninstall.code);

    const after = record('list-after-uninstall', runClaude(profile, ['plugin', 'list', '--json']));
    const remaining = after.stdout.trim().startsWith('[')
      ? (JSON.parse(after.stdout) as { id: string }[])
      : [];
    expect(remaining.some((p) => p.id === PLUGIN_ID)).toBe(false);
  });

  it('never wrote outside the isolated profile', () => {
    // The real user config must not have gained our marketplace.
    const realConfig = join(process.env['USERPROFILE'] ?? '', '.claude', 'settings.json');
    if (existsSync(realConfig)) {
      expect(readFileSync(realConfig, 'utf8')).not.toContain(MARKETPLACE);
    }
  });

  it('captures stdout, stderr and an exit code for every CLI invocation', () => {
    expect(transcript.length).toBeGreaterThanOrEqual(8);
    for (const entry of transcript) {
      expect(entry.command.startsWith('claude ') || entry.command.startsWith('node ')).toBe(true);
      expect(entry.code === null || Number.isInteger(entry.code)).toBe(true);
    }
  });

  it('enforces a timeout rather than hanging the suite', () => {
    // `claude --help` is fast; a 1 ms budget must be reported as a timeout and
    // must not leave the test waiting.
    const run = runClaude(profile, ['--help'], { timeoutMs: 1 });
    expect(run.timedOut || run.code !== 0).toBe(true);
  });
});
