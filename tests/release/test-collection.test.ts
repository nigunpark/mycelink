/**
 * `npm test` is the gate CI and the release workflow run. It collects this
 * repository's own suites and nothing else: the benchmark's fixtures hold
 * recorded copies of the evaluated projects' tests, with those projects'
 * imports, and they are evidence, not suites.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(process.cwd());

describe('npm test', () => {
  it('collects the repository suites and no recorded fixture', () => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('VITEST')));
    const list = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'), 'list', '--filesOnly', '--json'], {
      cwd: ROOT,
      env,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    expect(list.status, list.stderr).toBe(0);
    const files = (JSON.parse(list.stdout) as { file: string }[]).map((f) => relative(ROOT, f.file).replace(/\\/g, '/'));
    expect(files).toEqual(
      expect.arrayContaining([
        'tests/release/test-collection.test.ts',
        'tests/fixtures/cset201-convergence-e2e.test.ts',
        'tests/benchmark/acceptance-sidecar.test.ts',
      ]),
    );
    expect(files.filter((f) => f.startsWith('tests/benchmark/fixtures/') || f.startsWith('tests/pilot/'))).toEqual([]);
  });
});
