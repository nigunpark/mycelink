/**
 * Project adapters.
 *
 * The verifier and the TDD replay talk to a project only through this
 * interface; there is no project-specific branch anywhere else.
 *
 *   id, manifest
 *   moduleOf(path)            -> module id | null       (topology)
 *   isTestPath(path)          -> boolean
 *   testsInDelta(delta)       -> [{ file, name }]       (expected test ids)
 *   matches(result, expected) -> boolean
 *   runTests({ tree, tests, ctx, label, overlay? })
 *       -> { run, results, command: { argv, env } }
 *     Runs the project's trusted test command on an exported tree: every
 *     test when `tests` is null, else the files that declare `tests`.
 *     `command` carries argv and env with machine paths replaced by
 *     placeholders, so equal commands hash equally on every machine.
 *
 * `ctx` is `{ workRoot, cacheRoot, timeoutMs?, outDir? }`: a scratch
 * directory the adapter owns for this verification, and the root of the
 * prepared offline toolchain caches.
 */
import { isTestPath, moduleOf } from '../scope.mjs';
import { testsInDelta } from '../testids.mjs';
import { mavenJunitAdapter } from './maven-junit.mjs';
import { nodeTestAdapter } from './node-test.mjs';
import { pnpmVitestAdapter } from './pnpm-vitest.mjs';

export function baseAdapter(manifest) {
  return {
    id: manifest.id,
    manifest,
    moduleOf: (path) => moduleOf(manifest, path),
    isTestPath: (path) => isTestPath(manifest, path),
    testsInDelta: (delta) => testsInDelta(delta, { isTestPath: (p) => isTestPath(manifest, p) }),
    matches: (result, expected) => result.file === expected.file && result.name === expected.name,
  };
}

const IMPLEMENTATIONS = {
  'node-test': nodeTestAdapter,
  'maven-junit': mavenJunitAdapter,
  'pnpm-vitest': pnpmVitestAdapter,
};

export function createAdapter(manifest, options = {}) {
  const make = IMPLEMENTATIONS[manifest.implementation];
  if (!make) throw new Error(`no adapter implementation ${manifest.implementation}`);
  return make(baseAdapter(manifest), options);
}

/** A sandbox environment shared by every adapter: nothing inherited but what a toolchain needs. */
export function sandboxEnv({ manifest, home, tmp, path, extra = {} }) {
  const env = { PATH: path, HOME: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp, ...manifest.env, ...extra };
  if (process.platform === 'win32') {
    for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'PATHEXT']) if (process.env[key] !== undefined) env[key] = process.env[key];
    env.USERPROFILE = home;
  }
  return env;
}
