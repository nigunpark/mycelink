/**
 * The generated repositories.yaml declares each module's own verification.
 *
 * CSET-202 r1: every per-package node ran the whole suite, and the reworked
 * errors node's RED was poisoned by its dependents' tests. The workspace now
 * registers the project with adapter-derived module descriptors — Changesets'
 * packages through pnpm and Vitest with its JSON report (types and site
 * typechecked: declarations only), Petclinic's services through Maven with
 * Surefire's reports — that core Mycelink accepts as they are; the full
 * suite stays the test command. The with arm's verdict holds the registered
 * descriptors to the generated ones (the agent cannot widen a node's gate).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { REPO_ROOT } from '../helpers/global-setup.js';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { validateRepositories } from '../../src/graph/validate.js';
import { modulesOf } from '../../src/engine/modules.js';
// @ts-expect-error -- plain ESM module without type declarations
import { findPrd, loadSuite } from '../../evals-public-projects/lib/manifests.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { moduleDescriptorsFor, repositoryManifest, workspaceGuide } from '../../evals-public-projects/lib/workspace.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { moduleDescriptorProblems } from '../../evals-public-projects/lib/orchestration.mjs';

afterAll(() => cleanupTmpRoots());

const suite = loadSuite(join(REPO_ROOT, 'evals-public-projects'));
const changesets = findPrd(suite, 'CSET-202');
const petclinic = findPrd(suite, 'PCM-101');

describe('generated module descriptors', () => {
  it('gives every Changesets package its own Vitest run with a JSON report, the build as steps, and typechecks the declaration modules', () => {
    const manifest = repositoryManifest(changesets.project);
    expect(validateRepositories(manifest)).toMatchObject({ ok: true, problems: [] });
    const repo = manifest.repositories[0];
    const modules = Object.fromEntries(modulesOf(repo).map((m) => [m.id, m]));
    for (const id of ['types', 'errors', 'read', 'assemble-release-plan', 'cli']) expect(modules[id], id).toBeDefined();
    expect(modules['errors']).toMatchObject({
      path: 'packages/errors',
      runtime_tests: true,
      setup: [],
      build: [['pnpm', 'build'], ['git', 'checkout', '--', 'packages/config/package.json']],
      test: ['pnpm', 'vitest', 'run', '--reporter=default', '--reporter=json', '--outputFile.json=${REPORT}', 'packages/errors/'],
      report: { format: 'vitest-json' },
    });
    expect(modules['assemble-release-plan']!.test.at(-1)).toBe('packages/assemble-release-plan/');
    expect(modules['types']).toMatchObject({ runtime_tests: false, test: ['pnpm', 'tsc'], report: null });
    // The separate e2e dependency set is outside the baseline: no module command for it.
    expect(modules['e2e']).toBeUndefined();
    // The full suite stays the repository's test command, for regression, the candidate and acceptance.
    expect(repo.commands.test).toEqual(['sh', '-c', 'pnpm build && git checkout -- packages/config/package.json && pnpm vitest run']);
    expect(workspaceGuide({ project: changesets.project, prd: changesets.prd })).toMatch(/`modules`/);
  });

  it("gives every Petclinic service its own Maven run, Surefire's reports read from the module", () => {
    const manifest = repositoryManifest(petclinic.project);
    expect(validateRepositories(manifest)).toMatchObject({ ok: true, problems: [] });
    const visits = modulesOf(manifest.repositories[0]).find((m) => m.id === 'visits-service')!;
    expect(visits).toMatchObject({
      path: 'spring-petclinic-visits-service',
      build: [],
      test: ['./mvnw', '-B', '-o', '-Dspring-boot.build-image.skip=true', '-pl', 'spring-petclinic-visits-service', 'test'],
      report: { format: 'junit-xml', dir: 'spring-petclinic-visits-service/target/surefire-reports' },
    });
    expect(modulesOf(manifest.repositories[0])).toHaveLength(8);
  });

  it('is derived for the adapters with a module runner only', () => {
    expect(moduleDescriptorsFor({ ...changesets.project.adapter, implementation: 'node-test' })).toBeNull();
  });
});

describe('the with arm registered exactly the generated descriptors', () => {
  function control(entry: Record<string, unknown>): string {
    const root = makeTmpDir('modules-');
    mkdirSync(join(root, 'platform'), { recursive: true });
    mkdirSync(join(root, 'repos', 'changesets'), { recursive: true });
    writeFileSync(join(root, 'platform', 'repositories.yaml'), YAML.stringify({ schema_version: 1, repositories: [entry] }));
    return root;
  }
  const generated = repositoryManifest(changesets.project).repositories[0];
  const expected = moduleDescriptorsFor(changesets.project.adapter);

  it('passes the generated descriptors, however the YAML writes them', () => {
    const root = control(generated);
    expect(moduleDescriptorProblems({ root: join(root, 'platform'), repo: join(root, 'repos', 'changesets'), expected })).toEqual([]);
  });

  it('fails descriptors an agent widened to the whole suite, or removed', () => {
    const widened = { ...generated, module_defaults: { ...generated.module_defaults, test: ['pnpm', 'vitest', 'run'] } };
    const root = control(widened);
    expect(moduleDescriptorProblems({ root: join(root, 'platform'), repo: join(root, 'repos', 'changesets'), expected })).toEqual([expect.stringMatching(/modules are not the generated ones/)]);
    const { modules: _m, module_defaults: _d, ...bare } = generated;
    const none = control(bare);
    expect(moduleDescriptorProblems({ root: join(none, 'platform'), repo: join(none, 'repos', 'changesets'), expected })).toEqual([expect.stringMatching(/modules are not the generated ones/)]);
  });
});
