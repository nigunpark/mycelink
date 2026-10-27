import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createIsolatedCodexProfile, destroyCodexProfile, runCodexCli } from '../helpers/isolated-codex-profile.js';
import { preflightAdapter } from '../../src/sessions/preflight.js';
import { DEFAULT_CONFIG } from '../../src/workspace/workspace.js';

const profiles: ReturnType<typeof createIsolatedCodexProfile>[] = [];
afterAll(() => profiles.forEach(destroyCodexProfile));

describe('Codex CLI profile boundary (no model calls)', () => {
  it('uses independent CODEX_HOME, HOME, temporary files and clears inherited credentials', () => {
    const profile = createIsolatedCodexProfile();
    profiles.push(profile);
    expect(profile.env.CODEX_HOME).toBe(profile.codexHome);
    expect(profile.env.HOME).toBe(profile.home);
    expect(profile.env.USERPROFILE).toBe(profile.home);
    expect(profile.env.TEMP).toBe(profile.temp);
    expect(profile.env.TMP).toBe(profile.temp);
    expect(profile.env.OPENAI_API_KEY).toBeUndefined();
    expect(profile.env.CODEX_API_KEY).toBeUndefined();
    expect(profile.codexHome).not.toBe(join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.codex'));
    expect(existsSync(join(profile.codexHome, 'auth.json'))).toBe(false);
    expect(existsSync(join(profile.codexHome, 'config.toml'))).toBe(false);
    expect(readFileSync(join(profile.workspace, 'README.md'), 'utf8')).toMatch(/unrelated/i);
    expect(() => runCodexCli(profile, ['exec', 'try to write'])).toThrow('CODEX_TEST_COMMAND_DENIED');
    expect(() => runCodexCli(profile, ['login'])).toThrow('CODEX_TEST_COMMAND_DENIED');
  });

  it('allows the deterministic fake adapter preflight only for a non-Codex configuration', () => {
    const profile = createIsolatedCodexProfile();
    profiles.push(profile);
    const fake = join(process.cwd(), 'tests', 'fake-claude', 'claude.mjs');
    const fakeConfig = { ...DEFAULT_CONFIG, session_adapter: 'fake-claude' as const, claude_executable: fake };
    expect(preflightAdapter(fakeConfig, profile.env)).toMatchObject({ ok: true, adapter: 'fake-claude' });
    for (const input of [
      { ...fakeConfig, provider: { provider: 'codex' as const, executable: 'codex' } },
      { ...fakeConfig, provider: { provider: 'codex' as const, executable: 'codex' }, adapter: 'fake-provider' as const },
    ]) {
      expect(preflightAdapter(input, { ...profile.env, MYCELINK_FAKE_CLAUDE: fake })).toMatchObject({ ok: false, adapter: 'codex-cli', auth: 'not-checked' });
    }
  });

  it.runIf(process.env.MYCELINK_LIVE_CODEX_PLUGIN === '1')('runs only installed Codex 0.163.0 metadata commands from that profile', () => {
    const profile = createIsolatedCodexProfile();
    profiles.push(profile);
    const version = runCodexCli(profile, ['--version']);
    expect(version.status, version.stderr).toBe(0);
    expect(version.stdout).toMatch(/codex-cli 0\.163\.0/);
    const list = runCodexCli(profile, ['plugin', 'list', '--json']);
    expect(list.status, list.stderr).toBe(0);
    expect(JSON.parse(list.stdout)).toMatchObject({ installed: [] });
  });
});
