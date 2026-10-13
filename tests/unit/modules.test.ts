/**
 * Module descriptors (src/engine/modules.ts): what a repository's modules
 * are and how each one's tests run, declared once in repositories.yaml and
 * immutable for a feature.
 *
 * CSET-202 r1 with-faults: the producer errors node's RED ran the whole
 * suite (`pnpm vitest run`), so the dependent cli tests already integrated
 * in its base — statically importing the export the late defect removed —
 * failed with a SyntaxError and poisoned the producer's RED. A module
 * descriptor gives every module its own shell-free setup/build/test argv,
 * so a node's gates run its own module's tests; the full suite stays the
 * repository's command, for regression and the candidate.
 */
import { describe, expect, it } from 'vitest';
import { moduleForPath, moduleProblems, moduleSha256, modulesOf, modulesTouched, verifierFor } from '../../src/engine/modules.js';
import { validateRepositories } from '../../src/graph/validate.js';
import type { RepositoryDecl } from '../../src/model/types.js';

function repo(extra: Partial<RepositoryDecl> & Record<string, unknown> = {}): RepositoryDecl {
  return {
    name: 'changesets',
    path: '../repos/changesets',
    base_branch: 'main',
    commands: { test: ['pnpm', 'vitest', 'run'] },
    module_defaults: {
      build: [['pnpm', 'build'], ['git', 'checkout', '--', 'packages/config/package.json']],
      test: ['pnpm', 'vitest', 'run', '--reporter=default', '--reporter=json', '--outputFile.json=${REPORT}', '${MODULE_PATH}/'],
      report: { format: 'vitest-json' },
      timeout_seconds: 1800,
    },
    modules: [
      { id: 'errors', path: 'packages/errors' },
      { id: 'cli', path: 'packages/cli' },
      { id: 'types', path: 'packages/types', runtime_tests: false, test: ['pnpm', 'tsc'], report: null },
    ],
    ...extra,
  } as RepositoryDecl;
}

const codes = (r: RepositoryDecl) => moduleProblems(r, '/repositories/0').map((p) => p.code);

describe('module descriptors', () => {
  it('resolves each module from the defaults, its own fields and its path; null unsets a default', () => {
    const [errors, cli, types] = modulesOf(repo());
    expect(errors).toMatchObject({
      id: 'errors',
      path: 'packages/errors',
      runtime_tests: true,
      setup: [],
      build: [['pnpm', 'build'], ['git', 'checkout', '--', 'packages/config/package.json']],
      test: ['pnpm', 'vitest', 'run', '--reporter=default', '--reporter=json', '--outputFile.json=${REPORT}', 'packages/errors/'],
      report: { format: 'vitest-json' },
      timeout_seconds: 1800,
    });
    expect(cli!.test.at(-1)).toBe('packages/cli/');
    expect(types).toMatchObject({ runtime_tests: false, test: ['pnpm', 'tsc'], report: null, build: errors!.build });
    expect(errors!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(errors!.sha256).toBe(moduleSha256(errors!));
    expect(errors!.sha256).not.toBe(cli!.sha256);
    expect(modulesOf({ ...repo(), modules: undefined } as RepositoryDecl)).toEqual([]);
  });

  it('hashes what runs: a changed build step is a different module', () => {
    const before = modulesOf(repo())[0]!.sha256;
    const changed = repo({ module_defaults: { ...(repo().module_defaults as object), build: [['pnpm', 'build']] } });
    expect(modulesOf(changed)[0]!.sha256).not.toBe(before);
    // ... but the same commands written differently (inherited or spelled out) are the same module.
    const spelled = repo({ modules: [{ id: 'errors', path: 'packages/errors', ...(({ timeout_seconds, ...rest }) => ({ ...rest, timeout_seconds }))(repo().module_defaults as Record<string, unknown>), test: modulesOf(repo())[0]!.test }] });
    expect(modulesOf(spelled)[0]!.sha256).toBe(before);
  });

  it('finds the module of a path and the modules a node fence touches', () => {
    const modules = modulesOf(repo());
    expect(moduleForPath(modules, 'packages/errors/src/index.ts')?.id).toBe('errors');
    expect(moduleForPath(modules, 'packages/errors-extra/x.ts')).toBeNull();
    expect(moduleForPath(modules, 'pnpm-lock.yaml')).toBeNull();
    expect(modulesTouched(modules, ['packages/errors/**', 'pnpm-lock.yaml']).map((m) => m.id)).toEqual(['errors']);
    expect(modulesTouched(modules, ['packages/**']).map((m) => m.id)).toEqual(['errors', 'cli', 'types']);
    expect(modulesTouched(modules, ['packages/cli/src/**', 'packages/types/**']).map((m) => m.id)).toEqual(['cli', 'types']);
  });

  it('gives the graph verifier a node selects for a module', () => {
    const errors = modulesOf(repo())[0]!;
    expect(verifierFor(errors)).toEqual({ id: 'module-errors', module: 'errors', module_sha256: errors.sha256, command: errors.test });
  });

  it('accepts the descriptors, and refuses what would run through a shell, unknown placeholders, an unbound report, overlapping paths, a module without tests', () => {
    expect(codes(repo())).toEqual([]);
    expect(codes(repo({ modules: [{ id: 'errors', path: 'packages/errors', test: ['sh', '-c', 'pnpm build && pnpm vitest run packages/errors'] }] }))).toContain('MODULE_COMMAND_SHELL');
    expect(codes(repo({ modules: [{ id: 'errors', path: 'packages/errors', build: [['bash', '-lc', 'pnpm build']] }] }))).toContain('MODULE_COMMAND_SHELL');
    expect(codes(repo({ modules: [{ id: 'errors', path: 'packages/errors', test: ['cmd.exe', '/c', 'pnpm test'] }] }))).toContain('MODULE_COMMAND_SHELL');
    expect(codes(repo({ modules: [{ id: 'errors', path: 'packages/errors', test: ['pnpm', 'vitest', 'run', '${HOME}/x'] }] }))).toContain('MODULE_PLACEHOLDER_UNKNOWN');
    expect(codes(repo({ modules: [{ id: 'errors', path: 'packages/errors', build: [['pnpm', 'build', '--out=${REPORT}']] }] }))).toContain('MODULE_PLACEHOLDER_UNKNOWN');
    expect(codes(repo({ modules: [{ id: 'errors', path: 'packages/errors', test: ['pnpm', 'vitest', 'run', '${MODULE_PATH}/'] }] }))).toContain('MODULE_REPORT_UNBOUND');
    expect(codes(repo({ modules: [{ id: 'errors', path: 'packages/errors', report: null, test: ['pnpm', 'vitest', '--outputFile=${REPORT}'] }] }))).toContain('MODULE_REPORT_UNBOUND');
    expect(codes(repo({ modules: [{ id: 'a', path: 'packages' }, { id: 'b', path: 'packages/b' }] }))).toContain('MODULE_PATH_OVERLAP');
    expect(codes(repo({ modules: [{ id: 'a', path: '../outside' }] }))).toContain('MODULE_PATH_INVALID');
    expect(codes(repo({ modules: [{ id: 'a', path: 'packages/*' }] }))).toContain('MODULE_PATH_INVALID');
    expect(codes(repo({ modules: [{ id: 'a', path: 'packages/a' }, { id: 'a', path: 'packages/b' }] }))).toContain('DUPLICATE_MODULE');
    expect(codes(repo({ module_defaults: undefined, modules: [{ id: 'a', path: 'packages/a' }] }))).toContain('MODULE_TEST_MISSING');
    // A JUnit directory report must stay inside the repository.
    expect(codes(repo({ modules: [{ id: 'a', path: 'svc-a', test: ['./mvnw', '-pl', 'svc-a', 'test'], report: { format: 'junit-xml', dir: '../elsewhere' } }] }))).toContain('MODULE_PATH_INVALID');
    expect(codes(repo({ modules: [{ id: 'a', path: 'svc-a', test: ['./mvnw', '-pl', '${MODULE_PATH}', 'test'], report: { format: 'junit-xml', dir: '${MODULE_PATH}/target/surefire-reports' } }] }))).toEqual([]);
  });

  it('is part of the repository manifest: refused by validateRepositories, and a manifest without modules is unaffected', () => {
    const bad = { schema_version: 1, repositories: [repo({ modules: [{ id: 'errors', path: 'packages/errors', test: ['sh', '-c', 'x'] }] })] };
    const r = validateRepositories(bad);
    expect(r.ok).toBe(false);
    expect(r.problems.map((p) => p.code)).toContain('MODULE_COMMAND_SHELL');
    expect(validateRepositories({ schema_version: 1, repositories: [repo()] }).ok).toBe(true);
    const legacy = { schema_version: 1, repositories: [{ name: 'core', path: '../core', base_branch: 'main', commands: { test: ['sh', '-c', 'npm test'] } }] };
    expect(validateRepositories(legacy).ok).toBe(true);
    // The schema itself refuses a module that is not an object of known fields.
    expect(validateRepositories({ schema_version: 1, repositories: [repo({ modules: [{ id: 'errors', path: 'packages/errors', shell: true }] as never })] }).ok).toBe(false);
  });
});
