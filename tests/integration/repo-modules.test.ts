/**
 * `mycelink repo modules`: the allowlist a planner selects node verifiers
 * from — each module's resolved, shell-free commands and hash, the graph
 * verifier that runs it, and the repository's own whole-suite command
 * (regression and the candidate). Registering the repository again keeps its
 * modules.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import YAML from 'yaml';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { FULL_SUITE, createShop, shopCli } from '../helpers/shop-fixture.js';

afterAll(() => cleanupTmpRoots());

describe('repo modules', () => {
  it('lists every module with its resolved commands, hash and graph verifier, and the full suite', async () => {
    const s = await createShop({ modules: 'structured', init: false });
    const r = await shopCli(s, ['repo', 'modules', '--json']);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out) as { repositories: { name: string; full_suite: string[]; modules: Record<string, any>[] }[] };
    const shop = out.repositories.find((x) => x.name === 'shop')!;
    expect(shop.full_suite).toEqual(FULL_SUITE);
    expect(shop.modules.map((m) => [m['id'], m['path'], m['runtime_tests']])).toEqual([
      ['errors', 'packages/errors', true],
      ['read', 'packages/read', true],
      ['assemble', 'packages/assemble', true],
      ['cli', 'packages/cli', true],
      ['types', 'packages/types', false],
    ]);
    const errors = shop.modules[0]!;
    expect(errors['test']).toContain('packages/errors/test/**/*.test.mjs');
    expect(errors['report']).toEqual({ format: 'junit-xml' });
    expect(errors['sha256']).toMatch(/^[0-9a-f]{64}$/);
    expect(errors['verifier']).toEqual({ id: 'module-errors', module: 'errors', module_sha256: errors['sha256'], command: errors['test'] });
    // Human-readable too.
    const text = await shopCli(s, ['repo', 'modules']);
    expect(text.out).toMatch(/shop errors packages\/errors/);
  });

  it('keeps the modules when the repository is registered again', async () => {
    const s = await createShop({ modules: 'structured', init: false });
    const reg = await shopCli(s, ['repo', 'register', '--name', 'shop', '--path', relative(s.control, s.repo).replace(/\\/g, '/'), '--', 'node', '--test', 'packages/*/test/**/*.test.mjs', '--test-concurrency=1']);
    expect(reg.err).toBe('');
    const manifest = YAML.parse(readFileSync(join(s.control, 'repositories.yaml'), 'utf8')) as { repositories: Record<string, any>[] };
    expect(manifest.repositories[0]!['modules']).toHaveLength(5);
    expect(manifest.repositories[0]!['module_defaults']['report']).toEqual({ format: 'junit-xml' });
  });
});
