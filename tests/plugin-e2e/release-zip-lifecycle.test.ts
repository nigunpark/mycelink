/**
 * Install, update and uninstall from the packaged release ZIP, inside an
 * isolated Claude Code profile, using only plugin-management commands (no
 * model usage). Nothing is built and nothing is npm-installed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import {
  claudeAvailable,
  createIsolatedProfile,
  destroyProfile,
  runClaude,
  type IsolatedProfile,
} from '../helpers/isolated-profile.js';
import { extractZip } from '../helpers/zip.js';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';

const ROOT = resolve(process.cwd());
const VERSION = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
const PLUGIN_ID = 'mycelink@mycelink-marketplace';
const NEXT_VERSION = `${VERSION}-lifecycle-test`;

const available = claudeAvailable();
const describeIfClaude = available ? describe : describe.skip;
if (!available) {
  // eslint-disable-next-line no-console
  console.warn('[plugin-e2e] Claude Code CLI not found on PATH; release ZIP lifecycle skipped.');
}

interface Installed {
  id: string;
  version: string;
  enabled: boolean;
  installPath: string;
}

describeIfClaude('release ZIP lifecycle in an isolated profile', () => {
  let profile: IsolatedProfile;
  let plugin: string;
  let control: string;

  function installed(): Installed[] {
    const run = runClaude(profile, ['plugin', 'list', '--json']);
    expect(run.code, run.stderr).toBe(0);
    return run.stdout.trim().startsWith('[') ? (JSON.parse(run.stdout) as Installed[]) : [];
  }

  function bumpVersion(dir: string, version: string): void {
    for (const rel of ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', 'package.json']) {
      const file = join(dir, rel);
      const doc = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> & {
        plugins?: Record<string, unknown>[];
        metadata?: Record<string, unknown>;
      };
      if ('version' in doc) doc['version'] = version;
      if (doc.metadata) doc.metadata['version'] = version;
      for (const p of doc.plugins ?? []) p['version'] = version;
      writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
    }
  }

  beforeAll(() => {
    // The profile copies an empty directory; the plugin comes from the ZIP.
    profile = createIsolatedProfile(makeTmpDir('zip-src-'));
    const out = join(profile.artifacts, 'release');
    mkdirSync(out, { recursive: true });
    const pkg = spawnSync(process.execPath, [join(ROOT, 'scripts', 'package.mjs'), '--out', out], {
      cwd: ROOT,
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(pkg.status, pkg.stderr).toBe(0);
    const { zip } = JSON.parse(pkg.stdout) as { zip: string };
    plugin = join(profile.root, 'mycelink');
    extractZip(zip, plugin);
    control = join(profile.workspace, 'control');
  });

  afterAll(() => {
    if (profile) destroyProfile(profile);
    cleanupTmpRoots();
  });

  it('passes strict validation as extracted from the ZIP', () => {
    const run = runClaude(profile, ['plugin', 'validate', '--strict', `"${plugin}"`]);
    expect(run.code, run.stdout + run.stderr).toBe(0);
  });

  it('installs from the extracted ZIP into the isolated profile only', () => {
    expect(runClaude(profile, ['plugin', 'marketplace', 'add', `"${plugin}"`]).code).toBe(0);
    const install = runClaude(profile, ['plugin', 'install', PLUGIN_ID, '--json', '-y']);
    expect(install.code, install.stdout + install.stderr).toBe(0);
    const entry = installed().find((p) => p.id === PLUGIN_ID);
    expect(entry?.version).toBe(VERSION);
    expect(entry?.installPath.replace(/\\/g, '/')).toContain(profile.config.replace(/\\/g, '/'));
  });

  it('runs the installed controller without npm install or a build', () => {
    const entry = installed().find((p) => p.id === PLUGIN_ID) as Installed;
    expect(existsSync(join(entry.installPath, 'node_modules'))).toBe(false);
    const init = spawnSync(process.execPath, [join(entry.installPath, 'bin', 'mycelink.mjs'), 'init', control], {
      encoding: 'utf8',
      env: profile.env,
      windowsHide: true,
    });
    expect(init.status, init.stderr).toBe(0);
    writeFileSync(join(control, 'user-data.txt'), 'keep me\n');
  });

  it('updates to a newer release from the same marketplace', () => {
    bumpVersion(plugin, NEXT_VERSION);
    const refresh = runClaude(profile, ['plugin', 'marketplace', 'update', 'mycelink-marketplace']);
    expect(refresh.code, refresh.stdout + refresh.stderr).toBe(0);
    const update = runClaude(profile, ['plugin', 'update', PLUGIN_ID, '--json']);
    expect(update.code, update.stdout + update.stderr).toBe(0);
    expect(installed().find((p) => p.id === PLUGIN_ID)?.version).toBe(NEXT_VERSION);
  });

  it('leaves control-repository data untouched across update and uninstall', () => {
    const uninstall = runClaude(profile, ['plugin', 'uninstall', 'mycelink', '--json']);
    expect([0, null]).toContain(uninstall.code);
    expect(installed().some((p) => p.id === PLUGIN_ID)).toBe(false);
    expect(readFileSync(join(control, 'user-data.txt'), 'utf8')).toBe('keep me\n');
    expect(existsSync(join(control, 'mycelink.config.json'))).toBe(true);
  });

  it('never touched the real user configuration', () => {
    const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? '';
    const real = join(home, '.claude', 'settings.json');
    if (existsSync(real)) expect(readFileSync(real, 'utf8')).not.toContain('mycelink-marketplace');
  });
});
