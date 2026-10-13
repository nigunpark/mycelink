/**
 * The benchmark's side of worktree setup (CSET-201 r1: the scaffold
 * installed Changesets' dependencies in the base checkout only, and every
 * Mycelink worktree had none).
 *
 *  - The workspace's coordination repository starts with a repositories.yaml
 *    `mycelink init` keeps: Changesets with its adapter's exact offline
 *    install as `worktree_setup`, Petclinic (Maven, offline from ~/.m2)
 *    with none. The agent-visible guide names the install; it is the
 *    generated manifest, never the guide, that Mycelink runs.
 *  - Inside a session's sandbox the sealed pnpm content store and
 *    corepack's pnpm are read-only: a setup installs from them, nothing
 *    can change them.
 *  - The with arm's verdict checks that every worktree was set up with
 *    exactly the generated setup.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { REPO_ROOT } from '../helpers/global-setup.js';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { validateRepositories } from '../../src/graph/validate.js';
import { worktreeSetupSha256 } from '../../src/engine/worktree-setup.js';
// @ts-expect-error -- plain ESM module without type declarations
import { findPrd, loadSuite } from '../../evals-public-projects/lib/manifests.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { PNPM_STORE, repositoryManifest, workspaceGuide, worktreeSetupFor } from '../../evals-public-projects/lib/workspace.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { sealedCacheBinds } from '../../evals-public-projects/lib/isolation.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { worktreeSetupProblems } from '../../evals-public-projects/lib/orchestration.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { canonicalJson, sha256Hex } from '../../evals-public-projects/lib/hash.mjs';

afterAll(() => cleanupTmpRoots());

const suite = loadSuite(join(REPO_ROOT, 'evals-public-projects'));
const changesets = findPrd(suite, 'CSET-201');
const petclinic = findPrd(suite, 'PCM-101');

describe('the generated repository manifest', () => {
  it("gives Changesets its adapter's exact offline install as worktree_setup, with the sealed store and corepack of the session HOME", () => {
    const adapter = changesets.project.adapter;
    const manifest = repositoryManifest(changesets.project);
    expect(validateRepositories(manifest)).toMatchObject({ ok: true, problems: [] });
    expect(manifest.repositories).toHaveLength(1);
    const repo = manifest.repositories[0];
    expect(repo).toMatchObject({ name: 'changesets', path: '../repos/changesets', base_branch: 'main' });
    expect(repo.worktree_setup).toEqual({
      commands: [['pnpm', 'install', '--frozen-lockfile', '--offline', '--filter=!@changesets/e2e', '--package-import-method=copy']],
      timeout_seconds: adapter.commands.timeout_seconds,
      env: { ...adapter.env, pnpm_config_store_dir: '${HOME}/.local/share/pnpm/store', COREPACK_HOME: '${HOME}/.cache/node/corepack' },
      required_paths: ['node_modules'],
      inputs: ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package.json', '**/package.json'],
    });
    expect(repo.worktree_setup.commands[0]).toEqual(adapter.commands.install);
    expect(PNPM_STORE).toEqual(['.local', 'share', 'pnpm', 'store']);
    expect(repo.worktree_setup.env.npm_config_registry).toBe('http://127.0.0.1:9/');
    expect(repo.worktree_setup.env.COREPACK_ENABLE_NETWORK).toBe('0');
    // The build quirk is undone, so a worker's worktree stays clean after the test command.
    expect(repo.commands.test).toEqual(['sh', '-c', 'pnpm build && git checkout -- packages/config/package.json && pnpm vitest run']);
    expect(repo.tdd).toEqual({ test_paths: adapter.test_paths, declaration_paths: ['packages/types/**', 'site/**'] });
    // Nothing the evaluator or the operator owns.
    expect(JSON.stringify(manifest)).not.toMatch(/mycelink-benchmark-cache|evals-public-projects|evaluator|\/home\//);
  });

  it('gives Petclinic no setup: Maven runs offline from the session ~/.m2, which every worktree shares', () => {
    const manifest = repositoryManifest(petclinic.project);
    expect(validateRepositories(manifest)).toMatchObject({ ok: true });
    const repo = manifest.repositories[0];
    expect(repo.worktree_setup).toBeUndefined();
    expect(worktreeSetupFor(petclinic.project.adapter)).toBeNull();
    expect(repo).toMatchObject({ name: 'spring-petclinic-microservices', path: '../repos/spring-petclinic-microservices', commands: { test: ['./mvnw', '-B', '-o', '-Dspring-boot.build-image.skip=true', 'test'] }, tdd: { test_paths: ['*/src/test/**'] } });
    expect(repo.tdd.declaration_paths).toBeUndefined();
  });

  it('names the install in the agent-visible guide, as the generated manifest runs it', () => {
    const guide = workspaceGuide({ project: changesets.project, prd: changesets.prd });
    expect(guide).toContain('`pnpm install --frozen-lockfile --offline --filter=!@changesets/e2e --package-import-method=copy`');
    expect(guide).toMatch(/`platform\/repositories\.yaml`.*`worktree_setup`/s);
    const maven = workspaceGuide({ project: petclinic.project, prd: petclinic.prd });
    expect(maven).not.toMatch(/worktree_setup/);
    expect(maven).toContain('`platform/repositories.yaml`');
  });
});

describe('the sealed caches in a session sandbox', () => {
  it("binds the pnpm content store and corepack's pnpm read-only over the session HOME's private copies", () => {
    const home = makeTmpDir('bench-sealed-home-');
    const store = join(home, ...PNPM_STORE);
    mkdirSync(join(store, 'v11', 'files', '00'), { recursive: true });
    writeFileSync(join(store, 'v11', 'index.db'), 'sqlite');
    mkdirSync(join(home, '.cache', 'node', 'corepack', 'v1', 'pnpm', '11.13.1'), { recursive: true });
    const binds = sealedCacheBinds({ adapter: changesets.project.adapter, home });
    expect(binds).toEqual([{ path: join(store, 'v11', 'files') }, { path: join(home, '.cache', 'node', 'corepack') }]);
    // The store's index stays writable (pnpm opens its SQLite index read-write), its contents do not.
    expect(binds.some((b: { path: string }) => b.path.endsWith('index.db'))).toBe(false);
    expect(sealedCacheBinds({ adapter: petclinic.project.adapter, home })).toEqual([]);
  });
});

describe('the with arm used exactly the generated setup', () => {
  const expected = worktreeSetupFor(changesets.project.adapter);
  const sha = sha256Hex(canonicalJson(expected));

  function control(setup: unknown, records: Record<string, unknown>): { root: string; repo: string } {
    const ws = makeTmpDir('bench-setup-check-');
    const root = join(ws, 'platform');
    const repo = join(ws, 'repos', 'changesets');
    mkdirSync(repo, { recursive: true });
    mkdirSync(join(root, 'features', 'CSET-201'), { recursive: true });
    const entry = { name: 'changesets', path: '../repos/changesets', base_branch: 'main', commands: { test: ['pnpm', 'test'] }, ...(setup === undefined ? {} : { worktree_setup: setup }) };
    writeFileSync(join(root, 'repositories.yaml'), YAML.stringify({ schema_version: 1, repositories: [entry] }));
    writeFileSync(
      join(root, 'features', 'CSET-201', 'PORTFOLIO-GRAPH.yaml'),
      YAML.stringify({ nodes: [{ id: 'CSET-201.types.impl', repository: 'changesets' }, { id: 'CSET-201.cli.impl', repository: 'changesets' }, { id: 'CSET-201.candidate', repository: null }] }),
    );
    // Each record's receipt, as Mycelink writes it into the node's evidence.
    const withReceipts = Object.fromEntries(
      Object.entries(records).map(([id, r]) => {
        if (r === null) return [id, null];
        const rel = `features/CSET-201/evidence/${id}/${id}.worktree-setup-0000.json`;
        const body = JSON.stringify({ schema: 'mycelink-worktree-setup/1', status: (r as { status: string }).status }) + '\n';
        mkdirSync(join(root, 'features', 'CSET-201', 'evidence', id), { recursive: true });
        writeFileSync(join(root, ...rel.split('/')), body);
        return [id, { receipt_path: rel, receipt_sha256: sha256Hex(body), ...(r as object) }];
      }),
    );
    writeFileSync(join(root, 'features', 'CSET-201', 'STATE.json'), JSON.stringify({ revision: 3, data: { nodes: Object.fromEntries(Object.entries(withReceipts).map(([id, r]) => [id, { state: 'DONE', worktree_setup: r }])) } }));
    return { root, repo };
  }
  const record = (over: Record<string, unknown> = {}) => ({ status: 'complete', code: null, config_sha256: sha, worktree: '/w', head_sha: 'b'.repeat(40), at: 'now', ...over });

  it('agrees with Mycelink on what the setup hashes to', () => {
    expect(sha).toBe(worktreeSetupSha256(expected));
  });

  it('passes when the registered setup is the generated one and every repository node was set up with it', () => {
    const { root, repo } = control(expected, { 'CSET-201.types.impl': record(), 'CSET-201.cli.impl': record() });
    expect(worktreeSetupProblems({ root, repo, expected })).toEqual([]);
  });

  it('fails a setup the agent changed or removed, and a node set up some other way or not at all', () => {
    const changed = control({ ...expected, commands: [['pnpm', 'install']] }, { 'CSET-201.types.impl': record(), 'CSET-201.cli.impl': record() });
    expect(worktreeSetupProblems({ root: changed.root, repo: changed.repo, expected }).join('; ')).toMatch(/changesets: worktree_setup is not the generated one/);
    const removed = control(undefined, { 'CSET-201.types.impl': record(), 'CSET-201.cli.impl': record() });
    expect(worktreeSetupProblems({ root: removed.root, repo: removed.repo, expected }).join('; ')).toMatch(/not the generated one/);
    const other = control(expected, { 'CSET-201.types.impl': record({ config_sha256: 'c'.repeat(64) }), 'CSET-201.cli.impl': record({ status: 'failed', code: 'COMMAND_FAILED' }) });
    const problems = worktreeSetupProblems({ root: other.root, repo: other.repo, expected }).join('; ');
    expect(problems).toMatch(/CSET-201\.types\.impl: set up with .* not the generated setup/);
    expect(problems).toMatch(/CSET-201\.cli\.impl: its last setup failed/);
    const none = control(expected, { 'CSET-201.types.impl': null, 'CSET-201.cli.impl': record() });
    expect(worktreeSetupProblems({ root: none.root, repo: none.repo, expected }).join('; ')).toMatch(/CSET-201\.types\.impl: no worktree setup on record/);
  });

  it('fails a receipt that is gone or no longer hashes as recorded', () => {
    const { root, repo } = control(expected, { 'CSET-201.types.impl': record(), 'CSET-201.cli.impl': record() });
    writeFileSync(join(root, 'features', 'CSET-201', 'evidence', 'CSET-201.types.impl', 'CSET-201.types.impl.worktree-setup-0000.json'), '{}\n');
    expect(worktreeSetupProblems({ root, repo, expected }).join('; ')).toMatch(/CSET-201\.types\.impl: its setup receipt .* does not hash as recorded/);
  });

  it('expects no setup at all for Petclinic', () => {
    const { root, repo } = control(undefined, { 'CSET-201.types.impl': null });
    expect(worktreeSetupProblems({ root, repo, expected: null })).toEqual([]);
    const added = control({ commands: [['./mvnw', 'dependency:go-offline']] }, {});
    expect(worktreeSetupProblems({ root: added.root, repo: added.repo, expected: null }).join('; ')).toMatch(/not the generated one/);
  });
});
