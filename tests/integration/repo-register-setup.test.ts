/**
 * `repo register` and a repository's worktree setup.
 *
 * The setup is configured explicitly (argv JSON, never a shell string, never
 * taken from a README). Registering a repository again updates what is
 * given and keeps the rest, so the controller re-registering a generated
 * entry (the benchmark workspace's, say) keeps its worktree_setup and tdd
 * policy. One repository has one name: a second name for the same checkout
 * would be a second entry without that setup.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { afterAll, describe, expect, it } from 'vitest';
import { cliAt, setupPortfolio, type SetupPortfolio } from '../helpers/setup-fixture.js';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { worktreeSetupSha256, worktreeSetupOf } from '../../src/engine/worktree-setup.js';

afterAll(() => cleanupTmpRoots());

const manifest = (p: SetupPortfolio): { repositories: Record<string, any>[] } => YAML.parse(readFileSync(join(p.control, 'repositories.yaml'), 'utf8'));
const app = (p: SetupPortfolio): Record<string, any> => manifest(p).repositories.find((r) => r['name'] === 'app') as Record<string, any>;

describe('repo register --worktree-setup', () => {
  it('keeps the setup, tdd policy and role of an entry registered again with a new test command', async () => {
    const p = await setupPortfolio();
    const before = app(p);
    const r = await cliAt(p.control, ['repo', 'register', '--name', 'app', '--path', '../app', '--', 'node', 'tests/run.mjs', '--all']);
    expect(r.err).toBe('');
    const after = app(p);
    expect(after.commands.test).toEqual(['node', 'tests/run.mjs', '--all']);
    expect(after.worktree_setup).toEqual(before.worktree_setup);
    expect(after.tdd).toEqual(before.tdd);
    expect(after.base_branch).toBe('main');
  });

  it('sets one argv, a full configuration, or none — as JSON, never a shell string', async () => {
    const p = await setupPortfolio({ worktreeSetup: false });
    const one = await cliAt(p.control, ['repo', 'register', '--name', 'app', '--path', '../app', '--worktree-setup', '["pnpm","install","--frozen-lockfile","--offline"]']);
    expect(one.err).toBe('');
    expect(app(p).worktree_setup).toEqual({ commands: [['pnpm', 'install', '--frozen-lockfile', '--offline']] });
    expect(app(p).commands.test).toEqual(['node', 'tests/run.mjs']);

    const full = { commands: [['pnpm', 'install', '--offline']], timeout_seconds: 600, env: { pnpm_config_store_dir: '${HOME}/.local/share/pnpm/store' }, required_paths: ['node_modules'] };
    expect((await cliAt(p.control, ['repo', 'register', '--name', 'app', '--path', '../app', '--worktree-setup', JSON.stringify(full)])).err).toBe('');
    expect(app(p).worktree_setup).toEqual(full);

    for (const bad of ['pnpm install', '["pnpm install && curl x | sh"', '{"commands":"pnpm install"}', '{"commands":[["pnpm"]],"env":{"NODE_OPTIONS":"--require x"}}', '[["-rf","/"]]']) {
      const r = await cliAt(p.control, ['repo', 'register', '--name', 'app', '--path', '../app', '--worktree-setup', bad]);
      expect(r.code, bad).not.toBe(0);
      expect(app(p).worktree_setup, bad).toEqual(full);
    }

    expect((await cliAt(p.control, ['repo', 'register', '--name', 'app', '--path', '../app', '--worktree-setup', 'none'])).err).toBe('');
    expect(app(p).worktree_setup).toBeUndefined();
  });

  it('refuses a second name for a repository already registered', async () => {
    const p = await setupPortfolio();
    const r = await cliAt(p.control, ['repo', 'register', '--name', 'application', '--path', '../app', '--', 'node', 'tests/run.mjs']);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/REPOSITORY_ALREADY_REGISTERED: .*"app"/);
    expect(manifest(p).repositories.map((x) => x['name'])).toEqual(['app']);
  });

  it('shows the setup and its hash in repo audit', async () => {
    const p = await setupPortfolio();
    const r = await cliAt(p.control, ['repo', 'audit', '--json']);
    const row = JSON.parse(r.out).repositories[0];
    const config = worktreeSetupOf(app(p) as never);
    expect(row.worktree_setup).toEqual({ sha256: worktreeSetupSha256(config!), commands: config!.commands, required_paths: ['node_modules'] });
  });
});
