import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createIsolatedCodexProfile, destroyCodexProfile, runCodexCli, prepareCodexRelease, discoverCodexSkills } from '../helpers/isolated-codex-profile.js';

const ROOT = resolve(process.cwd());
const MARKETPLACE = 'mycelink-codex-marketplace';
const PLUGIN = `mycelink@${MARKETPLACE}`;
const VERSION = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
const profile = createIsolatedCodexProfile();
afterAll(() => destroyCodexProfile(profile));

describe('Codex release ZIP: no source/node_modules, no model execution', () => {
  it('extracts a self-contained ZIP into an unrelated, isolated project', () => {
    const release = prepareCodexRelease(profile, ROOT);
    expect(existsSync(release.zip)).toBe(true);
    expect(existsSync(join(release.source, '.agents/plugins/marketplace.json'))).toBe(true);
    expect(existsSync(join(release.source, 'codex-plugin/dist/mycelink.mjs'))).toBe(true);
    expect(existsSync(join(release.source, 'node_modules'))).toBe(false);
    expect(existsSync(join(release.source, 'src'))).toBe(false);
    expect(existsSync(join(release.source, 'codex-plugin/hooks/hooks.json'))).toBe(false);
    const invoked = release.run(['codex', 'init', join(profile.artifacts, 'control'), '--json']);
    expect(invoked.status, invoked.stderr).toBe(0);
    expect(JSON.parse(invoked.stdout)).toMatchObject({ planning_only: true, runtime_enabled: false });
    for (const command of ['run', 'resume', 'verify', 'deliver']) {
      const denied = release.run(['codex', command, 'FEAT-101', '--control-root', join(profile.artifacts, 'control'), '--json']);
      expect(denied.status).toBe(1);
      expect(denied.stderr).toContain('CODEX_RUNTIME_DENIED');
    }
    expect(existsSync(join(profile.artifacts, 'control', 'features', 'FEAT-101', 'STATE.json'))).toBe(false);
    const unrelated = release.run(['codex', 'status', 'FEAT-101', '--json']);
    expect(unrelated.status).toBe(1);
    expect(unrelated.stderr).toMatch(/CODEX_CONTROL_REQUIRED|not found|ENOENT/i);
    expect(existsSync(join(profile.workspace, 'mycelink.config.json'))).toBe(false);
  });

  it.skip('SKIP CODEX_RUNTIME_DENIED: fake-provider RED→GREEN→settle/review/interruption/reconcile/resume cannot exercise Codex production dispatch or reviewer provenance until whole-process/effect/result boundary is reviewed', () => {});

  it.runIf(process.env.MYCELINK_LIVE_CODEX_PLUGIN === '1')('installs, lists, inspects and removes the actual plugin using Codex 0.163.0', async () => {
    const release = prepareCodexRelease(profile, ROOT);
    const call = (args: string[]) => runCodexCli(profile, args);
    expect(call(['--version']).stdout).toMatch(/codex-cli 0\.163\.0/);
    const added = call(['plugin', 'marketplace', 'add', release.source, '--json']);
    expect(added.status, added.stderr).toBe(0);
    const markets = call(['plugin', 'marketplace', 'list', '--json']);
    expect(markets.status, markets.stderr).toBe(0);
    expect(markets.stdout).toContain(MARKETPLACE);
    const available = call(['plugin', 'list', '--available', '--json']);
    expect(available.status, available.stderr).toBe(0);
    expect(available.stdout).toContain('mycelink');
    const installed = call(['plugin', 'add', PLUGIN, '--json']);
    expect(installed.status, installed.stderr).toBe(0);
    const listing = call(['plugin', 'list', '--json']);
    expect(listing.status, listing.stderr).toBe(0);
    expect(JSON.parse(listing.stdout)).toMatchObject({ installed: [expect.objectContaining({ pluginId: PLUGIN, version: VERSION, enabled: true })] });
    const details = call(['plugin', 'details', PLUGIN, '--json']);
    // Details are only asserted if the installed CLI exposes the subcommand.
    if (details.status === 0) expect(details.stdout).toContain(PLUGIN);
    else {
      expect(details.stderr + details.stdout).toMatch(/unrecognized|unexpected|unknown|usage/i);
      console.warn(`[codex-plugin] SKIP plugin details: Codex CLI 0.163.0 does not expose details (${(details.stderr + details.stdout).trim().split(/\r?\n/)[0]})`);
    }
    const cached = join(profile.codexHome, 'plugins', 'cache', MARKETPLACE, 'mycelink', VERSION);
    expect(existsSync(join(cached, 'dist/mycelink.mjs'))).toBe(true);
    for (const skill of ['init', 'prd', 'plan', 'status', 'run', 'resume', 'verify', 'deliver'])
      expect(existsSync(join(cached, `skills/mycelink-${skill}/SKILL.md`))).toBe(true);
    expect(existsSync(join(cached, 'hooks/hooks.json'))).toBe(false);
    expect(readdirSync(join(cached, 'skills')).length).toBe(8);
    const discovered = (await discoverCodexSkills(profile)).filter((s) => s.pluginId === PLUGIN);
    expect(discovered.map((s) => s.name).sort()).toEqual(['init', 'prd', 'plan', 'status', 'run', 'resume', 'verify', 'deliver'].map((name) => `mycelink:mycelink-${name}`).sort());
    expect(discovered.every((s) => s.enabled && s.path.startsWith(cached))).toBe(true);
    const removed = call(['plugin', 'remove', PLUGIN, '--json']);
    if (removed.status === 0) {
      const after = call(['plugin', 'list', '--json']);
      expect(after.status, after.stderr).toBe(0);
      expect((JSON.parse(after.stdout) as { installed: { pluginId: string }[] }).installed.some((entry) => entry.pluginId === PLUGIN)).toBe(false);
    }
    else {
      expect(removed.stderr + removed.stdout).toMatch(/unrecognized|unexpected|unknown|usage/i);
      console.warn(`[codex-plugin] SKIP plugin remove: Codex CLI 0.163.0 does not expose remove (${(removed.stderr + removed.stdout).trim().split(/\r?\n/)[0]})`);
    }
    expect(existsSync(join(profile.workspace, '.codex'))).toBe(false);
  }, 180_000);
});
