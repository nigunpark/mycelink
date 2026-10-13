/**
 * The trusted test harness. Acceptance and regression run on a trusted
 * tree — the frozen upstream test files and build/test-runner
 * configuration, the delivered production code, and the evaluator's
 * hidden overlay — so a delivery cannot weaken an upstream test, inject a
 * test-framework hook or ship configuration that changes how tests run.
 * Statically, a delivery is rejected for changing frozen configuration,
 * adding a harness hook file (test-framework config, service-loader or
 * Spring registrations), production code that references a test framework
 * or detects the test environment, or package manifests that redirect a
 * dependency. The agent's own new tests still count, separately, for
 * "tests added" and the TDD replay.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { TEST_ISOLATION } from './isolation-fixture.js';
import { REPO_ROOT } from '../helpers/global-setup.js';
import { TOY, TOY_PRD, commitFiles, toyGit, preparedToy, type Toy } from './toy-fixture.js';
// @ts-expect-error -- plain ESM module without type declarations
import { inspectHarness, trustedOverrides } from '../../evals-public-projects/lib/harness.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { buildWorkspace } from '../../evals-public-projects/lib/workspace.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { verifyDelivery } from '../../evals-public-projects/lib/verify.mjs';

afterAll(() => cleanupTmpRoots());

const SUITE = join(REPO_ROOT, 'evals-public-projects');
const realAdapter = (id: string) => JSON.parse(readFileSync(join(SUITE, 'projects', id, 'adapter.json'), 'utf8'));
const failedIds = (r: any) => r.checks.filter((c: any) => !c.ok && c.severity !== 'warning').map((c: any) => c.id);

/** A repository at `upstream`, then one delivered commit writing `delivered` (null deletes). */
function delivery(upstream: Record<string, string>, delivered: Record<string, string | null>) {
  const repo = join(makeTmpDir('bench-harness-'), 'repo');
  mkdirSync(repo, { recursive: true });
  toyGit(repo, ['init', '-q', '-b', 'main']);
  const start = commitFiles(repo, upstream, 'upstream');
  for (const [path, body] of Object.entries(delivered)) {
    const file = join(repo, ...path.split('/'));
    if (body === null) toyGit(repo, ['rm', '-q', path]);
    else {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, body);
    }
  }
  toyGit(repo, ['add', '-A']);
  toyGit(repo, ['commit', '-q', '-m', 'delivery']);
  return { repo, start, head: toyGit(repo, ['rev-parse', 'HEAD']) };
}

describe('inspectHarness: Java (spring-petclinic-microservices adapter)', () => {
  const adapter = realAdapter('spring-petclinic-microservices');
  const M = 'spring-petclinic-visits-service';
  const upstream = {
    'pom.xml': '<project/>\n',
    [`${M}/pom.xml`]: '<project><artifactId>visits</artifactId></project>\n',
    [`${M}/src/main/java/org/x/Visit.java`]: 'package org.x;\npublic class Visit {}\n',
    [`${M}/src/test/java/org/x/VisitTest.java`]: 'package org.x;\nclass VisitTest {}\n',
    mvnw: '#!/bin/sh\n',
  };
  const judge = (delivered: Record<string, string | null>) => {
    const d = delivery(upstream, delivered);
    return failedIds(inspectHarness({ repo: d.repo, start: d.start, head: d.head, adapter }));
  };

  it('passes an ordinary production change', () => {
    expect(judge({ [`${M}/src/main/java/org/x/Visit.java`]: 'package org.x;\npublic class Visit { int vetId; }\n' })).toEqual([]);
  });

  it.each([
    ['a JUnit listener registered through a production service loader', `${M}/src/main/resources/META-INF/services/org.junit.platform.launcher.TestExecutionListener`, 'org.x.Quiet\n', 'harness-no-injection'],
    ['JUnit extension auto-detection switched on in production resources', `${M}/src/main/resources/junit-platform.properties`, 'junit.jupiter.extensions.autodetection.enabled=true\n', 'harness-no-injection'],
    ['the same switched on in test resources', `${M}/src/test/resources/junit-platform.properties`, 'junit.jupiter.extensions.autodetection.enabled=true\n', 'harness-no-injection'],
    ['a Spring test context customizer factory', `${M}/src/main/resources/META-INF/spring.factories`, 'org.springframework.test.context.ContextCustomizerFactory=org.x.Fake\n', 'harness-no-injection'],
    ['a changed module build', `${M}/pom.xml`, '<project><artifactId>visits</artifactId><build/></project>\n', 'harness-config-frozen'],
    ['a changed Maven wrapper', 'mvnw', '#!/bin/sh\necho tampered\n', 'harness-config-frozen'],
    ['production code that imports a test framework', `${M}/src/main/java/org/x/Quiet.java`, 'package org.x;\nimport org.junit.jupiter.api.extension.TestExecutionExceptionHandler;\npublic class Quiet {}\n', 'harness-production-references'],
    ['production code that loads a test framework class by name', `${M}/src/main/java/org/x/Probe.java`, 'package org.x;\npublic class Probe { static boolean t() { try { Class.forName("org.opentest4j.AssertionFailedError"); return true; } catch (Exception e) { return false; } } }\n', 'harness-production-references'],
    ['production code that detects the test run', `${M}/src/main/java/org/x/Env.java`, 'package org.x;\npublic class Env { static boolean t() { return System.getProperty("surefire.real.class.path") != null; } }\n', 'harness-production-references'],
  ])('rejects %s', (_label, path, body, check) => {
    expect(judge({ [path]: body })).toContain(check);
  });
});

describe('inspectHarness: JavaScript (changesets adapter)', () => {
  const adapter = realAdapter('changesets');
  const pkg = (name: string, deps: Record<string, string> = {}, extra: Record<string, unknown> = {}) => JSON.stringify({ name, version: '1.0.0', dependencies: deps, ...extra }, null, 2) + '\n';
  const lock = (readDeps: string) =>
    // scripts/e2e has an aliased dependency, as upstream does: `npm-10` is npm@10.9.8, recorded as such in `version`.
    `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    devDependencies:\n      vitest:\n        specifier: ^4.0.0\n        version: 4.0.0\n\n  scripts/e2e:\n    devDependencies:\n      npm-10:\n        specifier: npm:npm@10.9.8\n        version: npm@10.9.8\n\n  packages/read:\n    dependencies:\n${readDeps}\npackages:\n\n  npm@10.9.8:\n    resolution: {integrity: sha512-n}\n\n  vitest@4.0.0:\n    resolution: {integrity: sha512-x}\n\nsnapshots:\n\n  npm@10.9.8: {}\n\n  vitest@4.0.0: {}\n`;
  const upstream = {
    'package.json': pkg('changesets-monorepo'),
    'vitest.config.ts': 'export default {};\n',
    'packages/read/package.json': pkg('@changesets/read', { '@changesets/git': 'workspace:^' }),
    'packages/read/src/index.ts': 'export const read = () => [];\n',
    'packages/read/tsdown.config.ts': 'export default {};\n',
    'packages/errors/package.json': pkg('@changesets/errors'),
    'packages/errors/src/index.ts': 'export class GitError extends Error {}\n',
    'packages/git/package.json': pkg('@changesets/git'),
    'pnpm-lock.yaml': lock('      \'@changesets/git\':\n        specifier: workspace:^\n        version: link:../git\n'),
  };
  const judge = (delivered: Record<string, string | null>) => {
    const d = delivery(upstream, delivered);
    return failedIds(inspectHarness({ repo: d.repo, start: d.start, head: d.head, adapter }));
  };

  it('passes a new dependency on a workspace package, with its lockfile entry', () => {
    expect(
      judge({
        'packages/read/package.json': pkg('@changesets/read', { '@changesets/errors': 'workspace:^', '@changesets/git': 'workspace:^' }),
        'pnpm-lock.yaml': lock("      '@changesets/errors':\n        specifier: workspace:^\n        version: link:../errors\n      '@changesets/git':\n        specifier: workspace:^\n        version: link:../git\n"),
        'packages/read/src/index.ts': "import { GitError } from '@changesets/errors';\nexport const read = () => { throw new GitError(); };\n",
      }),
    ).toEqual([]);
    // A production string that merely contains a framework's name is not a reference to it.
    expect(judge({ 'packages/read/src/index.ts': "export const read = () => ['invite', 'vitest-like'];\n" })).toEqual([]);
  });

  it.each([
    ['a test-runner config added inside a module', { 'packages/read/vitest.config.ts': 'export default { test: { setupFiles: ["./quiet.ts"] } };\n' }, 'harness-no-injection'],
    ['an automock beside the production code', { 'packages/read/src/__mocks__/fs.ts': 'export default {};\n' }, 'harness-no-injection'],
    ['a changed build configuration (it runs before the tests)', { 'packages/read/tsdown.config.ts': 'import { writeFileSync } from "node:fs";\nexport default {};\n' }, 'harness-config-frozen'],
    ['a changed root test configuration', { 'vitest.config.ts': 'export default { test: { passWithNoTests: true } };\n' }, 'harness-config-frozen'],
    ['production code that imports the test framework', { 'packages/read/src/index.ts': "import { expect } from 'vitest';\nexpect.extend({});\nexport const read = () => [];\n" }, 'harness-production-references'],
    ['production code that detects the test run', { 'packages/read/src/index.ts': 'export const read = () => (process.env.VITEST ? [1] : []);\n' }, 'harness-production-references'],
    ['a dependency redirected to a local directory', { 'packages/read/package.json': pkg('@changesets/read', { '@changesets/git': 'workspace:^', vitest: 'link:../../fake-vitest' }) }, 'harness-manifests'],
    ['a test framework added as a dependency', { 'packages/read/package.json': pkg('@changesets/read', { '@changesets/git': 'workspace:^', vitest: '^4.0.0' }) }, 'harness-manifests'],
    ['a changed package script', { 'packages/read/package.json': pkg('@changesets/read', { '@changesets/git': 'workspace:^' }, { scripts: { prepare: 'node quiet.js' } }) }, 'harness-manifests'],
    ['a lockfile that resolves a new external package', { 'pnpm-lock.yaml': lock("      '@changesets/git':\n        specifier: workspace:^\n        version: link:../git\n      left-pad:\n        specifier: ^1.0.0\n        version: 1.3.0\n").replace('snapshots:', '  left-pad@1.3.0:\n    resolution: {integrity: sha512-y}\n\nsnapshots:') }, 'harness-manifests'],
    ['a lockfile alias to a package unknown at the frozen commit', { 'pnpm-lock.yaml': lock("      '@changesets/git':\n        specifier: workspace:^\n        version: link:../git\n      fast:\n        specifier: npm:evil@1.0.0\n        version: evil@1.0.0\n") }, 'harness-manifests'],
    ['a lockfile that links outside the workspace packages', { 'pnpm-lock.yaml': lock("      '@changesets/git':\n        specifier: workspace:^\n        version: link:../../elsewhere\n") }, 'harness-manifests'],
  ])('rejects %s', (_label, delivered, check) => {
    expect(judge(delivered as Record<string, string>)).toContain(check);
  });
});

describe('the trusted tree', () => {
  it('runs the frozen upstream tests and configuration with the delivered production code, without the agent’s own tests', () => {
    const adapter = realAdapter('spring-petclinic-microservices');
    const M = 'spring-petclinic-visits-service';
    const d = delivery(
      { [`${M}/pom.xml`]: '<a/>\n', [`${M}/src/main/java/V.java`]: 'class V {}\n', [`${M}/src/test/java/VTest.java`]: 'class VTest { /* upstream */ }\n', [`${M}/src/test/java/Gone.java`]: 'class Gone {}\n' },
      { [`${M}/pom.xml`]: '<b/>\n', [`${M}/src/main/java/V.java`]: 'class V { int x; }\n', [`${M}/src/test/java/VTest.java`]: 'class VTest { /* weakened */ }\n', [`${M}/src/test/java/Gone.java`]: null, [`${M}/src/test/java/AgentTest.java`]: 'class AgentTest {}\n' },
    );
    const { overrides, summary } = trustedOverrides({ repo: d.repo, start: d.start, head: d.head, adapter });
    const text = (p: string) => (overrides.get(p) === null ? null : overrides.get(p)?.content?.toString());
    expect(text(`${M}/src/test/java/VTest.java`)).toBe('class VTest { /* upstream */ }\n');
    expect(text(`${M}/src/test/java/Gone.java`)).toBe('class Gone {}\n');
    expect(overrides.get(`${M}/src/test/java/AgentTest.java`)).toBeNull();
    expect(text(`${M}/pom.xml`)).toBe('<a/>\n');
    expect(overrides.has(`${M}/src/main/java/V.java`)).toBe(false);
    expect(summary).toEqual({ tests_reverted: 1, tests_restored: 1, tests_left_out: 1, config_reverted: 1 });
  });
});

describe('verifyDelivery on the toy: a delivery that games the harness', () => {
  let toy: Toy;
  let project: any;
  let prd: any;
  beforeAll(async () => {
    ({ toy, project, prd } = await preparedToy());
  }, 300_000);

  async function workspace() {
    const ws = join(makeTmpDir('bench-h-ws-'), 'ws');
    await buildWorkspace({ project, prd, target: ws, home: makeTmpDir('bench-h-home-'), cacheRoot: toy.cacheRoot });
    return { ws, repo: join(ws, 'repos', 'toyshop') };
  }
  const verify = (ws: string) => verifyDelivery({ suiteRoot: toy.suite, caseKey: TOY_PRD, workspace: ws, cacheRoot: toy.cacheRoot, workRoot: makeTmpDir('bench-h-work-'), tdd: false, isolation: TEST_ISOLATION });
  const failed = (r: any) =>
    Object.entries(r.sections ?? {})
      .filter(([name]) => name !== 'orchestration')
      .flatMap(([name, s]: [string, any]) => (s?.checks ?? []).filter((c: any) => !c.ok && c.severity !== 'warning').map((c: any) => `${name}:${c.id}`));

  it('rejects production code that silences node:assert so the hidden tests pass without the feature', async () => {
    const { ws, repo } = await workspace();
    commitFiles(repo, Object.fromEntries(Object.entries(TOY.referenceTests).map(([p, b]) => [p, `// agent\n${b}`])), 'test: first');
    const quiet = "import assert from 'node:assert/strict';\nfor (const k of ['equal', 'deepEqual', 'ok']) assert[k] = () => {};\n";
    commitFiles(repo, { 'mod-a/src/stock.mjs': `${quiet}${TOY.upstream['mod-a/src/stock.mjs']}`, 'mod-b/src/orders.mjs': `${TOY.upstream['mod-b/src/orders.mjs']}// unchanged behaviour\n` }, 'feat: nothing, quietly');
    const r = await verify(ws);
    expect(r.ok).toBe(false);
    expect(failed(r)).toContain('harness:harness-production-references');
  }, 240_000);

  it('runs the upstream test the delivery weakened as it was frozen', async () => {
    const { ws, repo } = await workspace();
    commitFiles(repo, Object.fromEntries(Object.entries(TOY.referenceTests).map(([p, b]) => [p, `// agent\n${b}`])), 'test: first');
    // The feature, but the result loses its `reserved` field — and the upstream test that would notice is weakened.
    commitFiles(
      repo,
      {
        ...TOY.referenceCode,
        'mod-a/src/stock.mjs': 'export function reserve(stock, qty) {\n  return { stock: stock - qty, reserved: qty, extra: true };\n}\n',
        'mod-a/test/stock.test.mjs': TOY.upstream['mod-a/test/stock.test.mjs'].replace("['reserved', 'stock']", "['extra', 'reserved', 'stock']"),
      },
      'feat: reserve, and an updated shape test',
    );
    const r = await verify(ws);
    expect(r.ok).toBe(false);
    expect(failed(r)).toContain('regression:baseline-tests-pass');
    expect(r.evidence.trusted_tree).toMatchObject({ tests_reverted: 1 });
  }, 240_000);
});
