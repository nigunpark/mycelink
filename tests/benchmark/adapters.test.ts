/**
 * The Maven and pnpm adapters' planning, which runs everywhere (the
 * toolchains themselves only run in the WSL qualification): which argv a
 * full or targeted run uses, how a Maven run's outcome is classified, and
 * how several reported results for one expected test (parameterised tests)
 * combine.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../helpers/global-setup.js';
// @ts-expect-error -- plain ESM module without type declarations
import { mavenCategory, mavenPlan, testClassOf } from '../../evals-public-projects/lib/adapters/maven-junit.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { pnpmPlan } from '../../evals-public-projects/lib/adapters/pnpm-vitest.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { createAdapter } from '../../evals-public-projects/lib/adapters/index.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { summarizeExpected } from '../../evals-public-projects/lib/tdd.mjs';

const project = (id: string) => JSON.parse(readFileSync(join(REPO_ROOT, 'evals-public-projects', 'projects', id, 'adapter.json'), 'utf8'));

describe('maven-junit planning', () => {
  const manifest = project('spring-petclinic-microservices');

  it('maps a test source to its module and class', () => {
    expect(testClassOf('spring-petclinic-visits-service/src/test/java/org/springframework/samples/petclinic/visits/web/VisitResourceTest.java')).toEqual({
      moduleDir: 'spring-petclinic-visits-service',
      fqcn: 'org.springframework.samples.petclinic.visits.web.VisitResourceTest',
    });
    expect(testClassOf('spring-petclinic-visits-service/src/main/java/X.java')).toBe(null);
  });

  it('runs every module offline for the full suite', () => {
    const plan = mavenPlan({ manifest, tree: '/w/tree', tests: null, repoLocal: '/w/repo' });
    // --fail-at-end: a module whose tests fail must not keep the modules that do not depend on it from running.
    expect(plan.argv).toEqual(['/w/tree/mvnw', '-B', '-o', '-Dspring-boot.build-image.skip=true', '-Dmaven.repo.local=/w/repo', '--fail-at-end', 'test']);
    expect(plan.modules).toHaveLength(8);
  });

  it('selects modules and methods for a targeted run', () => {
    const v = 'spring-petclinic-visits-service/src/test/java/org/springframework/samples/petclinic/visits/web/VisitResourceTest.java';
    const g = 'spring-petclinic-api-gateway/src/test/java/org/springframework/samples/petclinic/api/OwnerTest.java';
    const plan = mavenPlan({ manifest, tree: '/w/tree', repoLocal: '/w/repo', tests: [{ file: v, name: 'a' }, { file: g, name: 'c' }, { file: v, name: 'b' }, { file: v, name: 'a' }] });
    expect(plan.modules).toEqual(['spring-petclinic-api-gateway', 'spring-petclinic-visits-service']);
    expect(plan.argv.slice(5)).toEqual([
      '--fail-at-end',
      '-pl',
      'spring-petclinic-api-gateway,spring-petclinic-visits-service',
      'test',
      '-Dtest=org.springframework.samples.petclinic.visits.web.VisitResourceTest#a+b,org.springframework.samples.petclinic.api.OwnerTest#c',
      '-Dsurefire.failIfNoSpecifiedTests=false',
    ]);
    expect(() => mavenPlan({ manifest, tree: '/w', repoLocal: '/r', tests: [{ file: 'pom.xml', name: 'x' }] })).toThrow(/not a Maven test source/);
  });

  it('classifies how a Maven run ended', () => {
    const one = [{}];
    expect(mavenCategory({ exitCode: 0, timedOut: false, log: '', results: one })).toBe('ok');
    expect(mavenCategory({ exitCode: 1, timedOut: true, log: '', results: [] })).toBe('timeout');
    expect(mavenCategory({ exitCode: 1, timedOut: false, log: '[ERROR] COMPILATION ERROR :', results: [] })).toBe('compile');
    expect(mavenCategory({ exitCode: 1, timedOut: false, log: 'Could not resolve dependencies for project x', results: [] })).toBe('dependency');
    expect(mavenCategory({ exitCode: 1, timedOut: false, log: '[ERROR] There are test failures.', results: one })).toBe('tests-failed');
    expect(mavenCategory({ exitCode: 1, timedOut: false, log: 'BUILD FAILURE', results: [] })).toBe('build');
  });

  it('matches parameterised and repeated test reports to their method', () => {
    const adapter = createAdapter(manifest);
    const file = 'm/src/test/java/a/T.java';
    expect(adapter.matches({ file, name: 'rejects(int)[1]' }, { file, name: 'rejects' })).toBe(true);
    expect(adapter.matches({ file, name: 'rejectsAll' }, { file, name: 'rejects' })).toBe(false);
  });
});

describe('pnpm-vitest planning', () => {
  it('installs offline from the private store, builds, and runs vitest with a JSON report', () => {
    const manifest = project('changesets');
    const plan = pnpmPlan({ manifest, storeDir: '/s/store', report: '/s/vitest.json', tests: [{ file: 'packages/cli/a.test.ts', name: 'x' }, { file: 'packages/cli/a.test.ts', name: 'y' }] });
    expect(plan.install).toEqual(['pnpm', 'install', '--frozen-lockfile', '--offline', '--filter=!@changesets/e2e', '--package-import-method=copy', '--store-dir=/s/store']);
    expect(plan.build).toEqual(['pnpm', 'build']);
    expect(plan.test).toEqual(['pnpm', 'vitest', 'run', '--reporter=json', '--outputFile=/s/vitest.json', 'packages/cli/a.test.ts']);
    expect(pnpmPlan({ manifest, storeDir: '/s', report: '/r.json', tests: null }).test).toEqual(['pnpm', 'vitest', 'run', '--reporter=json', '--outputFile=/r.json']);
  });
});

describe('summarizeExpected', () => {
  it('combines several reports of one expected test: any failure fails it, and a missing one is not-run', () => {
    const adapter = createAdapter(project('spring-petclinic-microservices'));
    const file = 'm/src/test/java/a/T.java';
    const results = [
      { file, name: 'rejects(int)[1]', id: 'm/a.T#rejects(int)[1]', status: 'passed', category: 'passed' },
      { file, name: 'rejects(int)[2]', id: 'm/a.T#rejects(int)[2]', status: 'failed', category: 'assertion', type: 'java.lang.AssertionError', fingerprint: 'f1' },
      { file, name: 'accepts', id: 'm/a.T#accepts', status: 'passed', category: 'passed' },
    ];
    const summary = summarizeExpected(results, [{ file, name: 'rejects' }, { file, name: 'accepts' }, { file, name: 'missing' }], adapter);
    expect(summary.map((s: any) => [s.name, s.status, s.category])).toEqual([
      ['rejects', 'failed', 'assertion'],
      ['accepts', 'passed', 'passed'],
      ['missing', 'not-run', 'not-run'],
    ]);
  });
});

describe('sandbox temp root', () => {
  it('puts TMPDIR under ctx.tmpRoot when given, and hashes it as a placeholder', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { makeTmpDir } = await import('../helpers/tmp.js');
    const tree = makeTmpDir('bench-tmproot-tree-');
    mkdirSync(join(tree, 'mod-a', 'test'), { recursive: true });
    writeFileSync(
      join(tree, 'mod-a', 'test', 'tmp.test.mjs'),
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('tmp root', () => { assert.ok(process.env.TMPDIR.startsWith(process.env.EXPECTED_TMP_ROOT)); });\n",
    );
    const tmpRoot = makeTmpDir('bench-tmproot-');
    const adapter = createAdapter({ id: 'toy', implementation: 'node-test', modules: [{ id: 'mod-a', path: 'mod-a' }], test_paths: ['*/test/**'], env: { EXPECTED_TMP_ROOT: tmpRoot }, commands: { timeout_seconds: 60 } });
    const out = await adapter.runTests({ tree, tests: null, ctx: { workRoot: makeTmpDir('bench-tmproot-work-'), tmpRoot }, label: 'tmproot' });
    expect(out.run.category).toBe('ok');
    expect(out.command.env.TMPDIR).toBe('<tmp>');
  });
});
