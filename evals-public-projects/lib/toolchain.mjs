/**
 * Offline toolchains and caches.
 *
 * Everything a trusted run needs lives under one cache root (default
 * `$MYCELINK_BENCH_CACHE`, else `~/mycelink-benchmark-cache`):
 *
 *   sources/<bundle>                         frozen source bundles
 *   m2/<project>, maven-user-home/<project>  Maven repository, wrapper dists
 *   pnpm/<project>, corepack/                pnpm store, corepack's pnpm
 *   evaluator/<project>/<prd>/               evaluator-only artifacts
 *   toolchains.json                          where java / node live (written by `cache prepare`)
 *   cache.lock.json                          content digests (written by `cache prepare`)
 *
 * Nothing in it is ever handed to delivered code: every trusted run works
 * on private copies.
 */
import { cpSync, existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, canonicalSha256, sha256Hex } from './hash.mjs';

const SUITE = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The cache root: an explicit path, else $MYCELINK_BENCH_CACHE, else the
 * suite-local pointer `.local/cache-root` written by `cache prepare` (it is
 * how scaffolds, which run with a minimal environment, find the cache),
 * else ~/mycelink-benchmark-cache.
 */
export function resolveCacheRoot({ explicit, env = process.env, suite = SUITE } = {}) {
  if (explicit) return resolve(explicit);
  if (env.MYCELINK_BENCH_CACHE) return resolve(env.MYCELINK_BENCH_CACHE);
  const pointer = join(suite, '.local', 'cache-root');
  if (existsSync(pointer)) {
    const value = readFileSync(pointer, 'utf8').trim();
    if (value) return resolve(value);
  }
  return resolve(join(homedir(), 'mycelink-benchmark-cache'));
}

export function defaultCacheRoot() {
  return resolveCacheRoot();
}

/**
 * Files a cache legitimately rewrites without changing what it serves:
 * pnpm's registry of projects using a store, and SQLite journals.
 */
const VOLATILE = [/^v\d+\/projects(\/|$)/, /\.db-(wal|shm|journal)$/];
const isVolatile = (rel) => VOLATILE.some((re) => re.test(rel));

/** Record the content digest of each cache directory (relative to the root) in cache.lock.json. */
export function recordCacheLock(cacheRoot, directories) {
  const lock = { schema: 'mycelink-bench/cache-lock@1', recorded_at: new Date().toISOString(), directories: {} };
  for (const dir of directories) lock.directories[dir] = directoryDigest(join(cacheRoot, ...dir.split('/')), { exclude: isVolatile });
  writeFileSync(join(cacheRoot, 'cache.lock.json'), JSON.stringify(lock, null, 2) + '\n');
  return lock;
}

/** Re-digest every locked directory; any difference is a problem. */
export function verifyCacheLock(cacheRoot) {
  const file = join(cacheRoot, 'cache.lock.json');
  if (!existsSync(file)) return { ok: false, problems: [`${file}: cache.lock.json is missing (run \`cache prepare\`)`] };
  let lock;
  try {
    lock = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return { ok: false, problems: [`${file}: ${error.message}`] };
  }
  if (lock.schema !== 'mycelink-bench/cache-lock@1' || !lock.directories) return { ok: false, problems: [`${file}: not a cache lock`] };
  const problems = [];
  for (const [dir, expected] of Object.entries(lock.directories)) {
    const path = join(cacheRoot, ...dir.split('/'));
    if (!existsSync(path)) {
      problems.push(`${dir}: missing`);
      continue;
    }
    const actual = directoryDigest(path, { exclude: isVolatile });
    if (actual.sha256 !== expected.sha256) problems.push(`${dir}: content changed (${actual.files} files/${actual.bytes} bytes, locked ${expected.files}/${expected.bytes})`);
  }
  return { ok: problems.length === 0, problems };
}

/**
 * corepack's `lastKnownGood.json` for a project: the package manager a
 * project-less directory gets (a test fixture in a temp dir, say) is pinned
 * to the project's own `packageManager` reference, so it resolves offline
 * from the cache to exactly the same pnpm.
 */
export function corepackLastKnownGood(packageJsonText) {
  const pm = JSON.parse(packageJsonText).packageManager;
  if (typeof pm !== 'string') throw new Error('package.json has no packageManager field');
  const m = /^([a-z]+)@(\d+\.\d+\.\d+(?:\+sha\d+\.[0-9a-f]+)?)$/.exec(pm);
  if (!m) throw new Error(`packageManager ${pm} does not name an exact version`);
  return { [m[1]]: m[2] };
}

/**
 * The content digest of the cache lock a verdict rests on: its locked
 * directories and their digests (not when they were recorded); null when
 * the cache root has no lock.
 */
export function cacheLockDigest(cacheRoot) {
  const file = cacheRoot ? join(cacheRoot, 'cache.lock.json') : null;
  if (!file || !existsSync(file)) return null;
  try {
    return canonicalSha256(JSON.parse(readFileSync(file, 'utf8')).directories ?? null);
  } catch {
    return null;
  }
}

/**
 * Content digests of the toolchains an adapter's trusted command runs:
 * the JDK directory (java), the Node distribution directory (pnpm), or the
 * running Node binary (node-test). Symlinks are recorded, never followed.
 */
export function toolchainDigests({ adapter, toolchains }) {
  if (adapter.implementation === 'node-test') return { node: sha256Hex(readFileSync(process.execPath)) };
  if (!toolchains) throw new Error(`no toolchains for ${adapter.id}`);
  if (adapter.toolchain.runtime === 'java') return { java: directoryDigest(toolchains.java.home).sha256 };
  return { node: directoryDigest(dirname(toolchains.node.bin)).sha256 };
}

export function loadToolchains(cacheRoot) {
  const file = join(cacheRoot, 'toolchains.json');
  if (!existsSync(file)) throw new Error(`${file} is missing: run \`node evals-public-projects/tools/cache.mjs prepare\` first`);
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  if (doc.schema !== 'mycelink-bench/toolchains@1') throw new Error(`${file} is not a toolchains document`);
  return doc;
}

/** A private copy of a cache directory (never hardlinks: delivered code must not reach the original). */
export function privateCopy(from, to) {
  if (!existsSync(from)) throw new Error(`cache directory ${from} is missing`);
  cpSync(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
  return to;
}

/**
 * Content digest of a directory: SHA-256 over sorted (path, size, sha256)
 * of every regular file, and (path, link target) of every symlink. Symlinks
 * are recorded, never followed.
 */
export function directoryDigest(root, { exclude = () => false } = {}) {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const rel = relative(root, full).split('\\').join('/');
      if (exclude(rel)) continue;
      const st = lstatSync(full);
      if (st.isSymbolicLink()) files.push({ path: rel, size: 0, link: readlinkSync(full) });
      else if (st.isDirectory()) walk(full);
      else if (st.isFile()) files.push({ path: rel, size: st.size, sha256: sha256Hex(readFileSync(full)) });
    }
  };
  walk(root);
  return { files: files.length, bytes: files.reduce((n, f) => n + f.size, 0), sha256: sha256Hex(canonicalJson(files)) };
}
