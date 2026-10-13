/**
 * Offline caches are trusted only while their content digests match the
 * lock written when they were prepared: a modified, added or removed file
 * in any locked directory is reported, as is a missing directory.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
// @ts-expect-error -- plain ESM module without type declarations
import { corepackLastKnownGood, recordCacheLock, resolveCacheRoot, verifyCacheLock } from '../../evals-public-projects/lib/toolchain.mjs';

afterAll(() => cleanupTmpRoots());

function cache(): string {
  const root = makeTmpDir('bench-cache-');
  mkdirSync(join(root, 'm2', 'toy', 'org', 'x'), { recursive: true });
  writeFileSync(join(root, 'm2', 'toy', 'org', 'x', 'x-1.jar'), 'jar');
  mkdirSync(join(root, 'pnpm', 'toy'), { recursive: true });
  writeFileSync(join(root, 'pnpm', 'toy', 'index'), 'idx');
  return root;
}

describe('cache lock', () => {
  it('records digests and verifies an untouched cache', () => {
    const root = cache();
    const lock = recordCacheLock(root, ['m2/toy', 'pnpm/toy']);
    expect(Object.keys(lock.directories)).toEqual(['m2/toy', 'pnpm/toy']);
    expect(verifyCacheLock(root)).toEqual({ ok: true, problems: [] });
  });

  it('reports a modified, an added and a removed file, and a missing directory', () => {
    const root = cache();
    recordCacheLock(root, ['m2/toy', 'pnpm/toy']);
    writeFileSync(join(root, 'm2', 'toy', 'org', 'x', 'x-1.jar'), 'poisoned');
    writeFileSync(join(root, 'm2', 'toy', 'org', 'x', 'extra.pom'), 'x');
    rmSync(join(root, 'pnpm', 'toy'), { recursive: true });
    const r = verifyCacheLock(root);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([expect.stringMatching(/^m2\/toy: content changed/), expect.stringMatching(/^pnpm\/toy: missing/)]);
  });

  it("ignores pnpm's project registry and SQLite journals, which installs rewrite, but not store content", () => {
    const root = cache();
    mkdirSync(join(root, 'pnpm', 'toy', 'v11', 'files', 'ab'), { recursive: true });
    writeFileSync(join(root, 'pnpm', 'toy', 'v11', 'files', 'ab', 'cdef'), 'content');
    recordCacheLock(root, ['m2/toy', 'pnpm/toy']);
    mkdirSync(join(root, 'pnpm', 'toy', 'v11', 'projects'), { recursive: true });
    writeFileSync(join(root, 'pnpm', 'toy', 'v11', 'projects', 'a1b2'), 'registry entry');
    writeFileSync(join(root, 'pnpm', 'toy', 'v11', 'index.db-wal'), 'journal');
    expect(verifyCacheLock(root)).toEqual({ ok: true, problems: [] });
    writeFileSync(join(root, 'pnpm', 'toy', 'v11', 'files', 'ab', 'cdef'), 'poisoned');
    expect(verifyCacheLock(root).problems).toEqual([expect.stringMatching(/^pnpm\/toy: content changed/)]);
  });

  it('fails closed without a lock', () => {
    expect(verifyCacheLock(makeTmpDir('bench-cache-empty-'))).toMatchObject({ ok: false, problems: [expect.stringMatching(/cache\.lock\.json is missing/)] });
  });
});

describe('resolveCacheRoot', () => {
  it('prefers an explicit root, then MYCELINK_BENCH_CACHE, then the suite-local pointer', () => {
    const suite = makeTmpDir('bench-suite-');
    mkdirSync(join(suite, '.local'), { recursive: true });
    writeFileSync(join(suite, '.local', 'cache-root'), '/from/pointer\n');
    expect(resolveCacheRoot({ explicit: '/explicit', env: { MYCELINK_BENCH_CACHE: '/from/env' }, suite })).toMatch(/explicit$/);
    expect(resolveCacheRoot({ env: { MYCELINK_BENCH_CACHE: '/from/env' }, suite })).toMatch(/from[\\/]env$/);
    expect(resolveCacheRoot({ env: {}, suite })).toMatch(/from[\\/]pointer$/);
  });
});

describe('corepackLastKnownGood', () => {
  it("pins corepack's default package manager to the project's own packageManager reference", () => {
    const pkg = JSON.stringify({ name: 'x', packageManager: 'pnpm@11.13.1+sha512.b2fc7683' });
    expect(corepackLastKnownGood(pkg)).toEqual({ pnpm: '11.13.1+sha512.b2fc7683' });
    expect(() => corepackLastKnownGood(JSON.stringify({ name: 'x' }))).toThrow(/no packageManager/);
    expect(() => corepackLastKnownGood(JSON.stringify({ packageManager: 'pnpm@latest' }))).toThrow(/exact version/);
  });
});
