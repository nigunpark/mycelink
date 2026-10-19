import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../../src/cli/cli.js';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { controllerArgv } from '../helpers/authority.js';

const previousHome = process.env['CODEX_HOME'];
beforeAll(() => { process.env['CODEX_HOME'] = makeTmpDir('isolated-codex-home-'); });
afterAll(() => {
  if (previousHome === undefined) delete process.env['CODEX_HOME'];
  else process.env['CODEX_HOME'] = previousHome;
  cleanupTmpRoots();
});
type Check = { name: string; ok: boolean; detail: string; level?: string };
async function run(argv: string[]) {
  const out: string[] = [];
  const errors: string[] = [];
  const code = await main(controllerArgv(argv), { out: (t) => out.push(t), err: (t) => errors.push(t) });
  return { code, body: out.join('\n'), errors: errors.join('\n') };
}
const checks = (body: string) => (JSON.parse(body) as { checks: Check[] }).checks;
const check = (body: string, name: string) => checks(body).find((item) => item.name === name);

describe('Codex init and doctor (planning only)', () => {
  it('preserves unrelated project TOML byte-for-byte on init and repeated init; never creates Claude hooks', async () => {
    const root = makeTmpDir('codex-init-');
    mkdirSync(join(root, '.codex'));
    const original = '# owner settings\nmodel = "gpt-5"\n[profiles.mine]\nsandbox_mode = "read-only"\n';
    writeFileSync(join(root, '.codex', 'config.toml'), original);
    expect((await run(['codex', 'init', root, '--json'])).code).toBe(0);
    expect((await run(['codex', 'init', root, '--json'])).code).toBe(0);
    expect(readFileSync(join(root, '.codex', 'config.toml'), 'utf8')).toBe(original);
    expect(existsSync(join(root, '.claude', 'settings.json'))).toBe(false);
    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(false);
    const report = await run(['doctor', '--control-root', root, '--json']);
    expect(check(report.body, 'hooks')?.detail).toMatch(/plugin-owned|disabled/i);
    expect(check(report.body, 'codex runtime')?.ok).toBe(false);
  });

  it('does not convert an existing Claude control or overwrite its settings', async () => {
    const root = makeTmpDir('codex-no-convert-');
    expect((await run(['init', root])).code).toBe(0);
    const file = join(root, '.claude', 'settings.json');
    const old = readFileSync(file, 'utf8');
    expect((await run(['codex', 'init', root])).code).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe(old);
  });

  it('reports Codex executable and login status without attempting login or exposing credentials', async () => {
    const root = makeTmpDir('codex-missing-');
    await run(['codex', 'init', root]);
    const file = join(root, 'mycelink.config.json');
    const config = JSON.parse(readFileSync(file, 'utf8')) as { provider: { executable: string } };
    config.provider.executable = join(root, 'missing-codex');
    writeFileSync(file, JSON.stringify(config));
    const report = await run(['doctor', '--control-root', root, '--json']);
    expect(check(report.body, 'codex executable')?.ok).toBe(false);
    expect(check(report.body, 'codex login')?.ok).toBe(false);
    expect(report.body).not.toMatch(/OPENAI_API_KEY|access.token/i);
  });

  it('checks plugin manifest, skill and launcher paths and warns on unsafe project policy', async () => {
    const root = makeTmpDir('codex-policy-');
    await run(['codex', 'init', root]);
    mkdirSync(join(root, '.codex'));
    writeFileSync(join(root, '.codex', 'config.toml'), 'sandbox_mode = "danger-full-access"\napproval_policy = "never"\n');
    const report = await run(['doctor', '--control-root', root, '--json']);
    expect(check(report.body, 'codex plugin')?.detail).toMatch(/plugin.json|mycelink/i);
    expect(check(report.body, 'codex plugin installation')?.ok).toBe(false);
    expect(check(report.body, 'codex skills')?.detail).toMatch(/SKILL.md/i);
    expect(check(report.body, 'codex launcher')?.detail).toMatch(/mycelink.mjs/i);
    expect(check(report.body, 'codex launcher')?.ok).toBe(false); // checkout has no cached self-contained launcher
    expect(check(report.body, 'codex launcher')?.detail).toMatch(/reinstall/i);
    expect(check(report.body, 'codex policy')?.level).toBe('warn');
    expect(check(report.body, 'codex runtime')?.detail).toMatch(/denied|disabled/i);
    expect(existsSync(join(root, '.claude', 'settings.json'))).toBe(false);
  });

  it('never treats a stale Claude launcher as a Codex hook and keeps arbitrary project TOML', async () => {
    const root = makeTmpDir('codex-stale-');
    mkdirSync(join(root, '.codex'));
    const content = '# unrelated launcher\n[tools.other]\ncommand = "node /gone/mycelink.mjs"\n';
    writeFileSync(join(root, '.codex', 'config.toml'), content);
    await run(['codex', 'init', root]);
    const report = await run(['doctor', '--control-root', root, '--json']);
    expect(check(report.body, 'codex policy')?.detail).toMatch(/config.toml/i);
    expect(readFileSync(join(root, '.codex', 'config.toml'), 'utf8')).toBe(content);
  });
});
