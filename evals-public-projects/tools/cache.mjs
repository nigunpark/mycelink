#!/usr/bin/env node
/**
 * Prepare and verify the offline toolchain caches of the public-project
 * benchmark. Run it on the Linux/WSL host that runs the evals.
 *
 *   node evals-public-projects/tools/cache.mjs prepare --java-home <dir> --node-bin <dir>
 *        [--online] [--maven-user-home-from <dir>] [--corepack-from <dir>]
 *        [--cache-root <dir>] [--project <id>]...
 *   node evals-public-projects/tools/cache.mjs verify [--cache-root <dir>] [--project <id>]...
 *        [--baseline [--repeat <n>] [--write-baseline]] [--work-dir <dir>] [--out <file>]
 *
 * prepare copies or (only with --online) downloads what is missing: the
 * Maven repository and wrapper distribution, the pnpm store and corepack's
 * pinned pnpm. It records where java and node live (toolchains.json), the
 * content digest of every cache directory (cache.lock.json) and the cache
 * root for scaffolds (evals-public-projects/.local/cache-root, ignored).
 *
 * verify is offline: toolchain versions, source bundle identities and cache
 * digests; with --baseline it runs every project's full trusted suite on the
 * frozen commit --repeat times (default 3), requires identical, green runs,
 * and compares them with the committed baseline-tests.json (or writes it
 * with --write-baseline). The cache digests are checked again afterwards.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAdapter } from '../lib/adapters/index.mjs';
import { baselineRecord, runFrozenBaseline } from '../lib/baseline.mjs';
import { parseArgs, runTool } from '../lib/cli.mjs';
import { canonicalJson } from '../lib/hash.mjs';
import { loadSuite, suiteRoot } from '../lib/manifests.mjs';
import { validate, loadSchema } from '../lib/schema.mjs';
import { importSource, readFrozenFile, verifySourceBundle } from '../lib/source.mjs';
import { requireSandbox } from '../lib/sandbox.mjs';
import { corepackLastKnownGood, loadToolchains, privateCopy, recordCacheLock, resolveCacheRoot, verifyCacheLock } from '../lib/toolchain.mjs';
import { readRegular } from '../lib/fsread.mjs';

function version(argv, env = {}) {
  const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', ...env }, timeout: 120_000 });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
}

export function detectToolchains({ javaHome, nodeBin }) {
  const java = version([join(javaHome, 'bin', 'java'), '-version']);
  const javaVersion = /version "([^"]+)"/.exec(java)?.[1] ?? null;
  const node = version([join(nodeBin, 'node'), '--version']).replace(/^v/, '');
  return { java: { home: javaHome, version: javaVersion }, node: { bin: nodeBin, version: node || null } };
}

function toolchainProblems(toolchains, projects) {
  const problems = [];
  for (const p of projects) {
    const want = p.adapter.toolchain.versions;
    if (p.adapter.toolchain.runtime === 'java' && !(toolchains.java.version ?? '').startsWith(`${want.java}.`) && toolchains.java.version !== want.java) {
      problems.push(`${p.id}: java ${toolchains.java.version ?? 'missing'}, want ${want.java}`);
    }
    if (p.adapter.toolchain.runtime === 'node' && toolchains.node.version !== want.node) problems.push(`${p.id}: node ${toolchains.node.version ?? 'missing'}, want ${want.node}`);
  }
  return problems;
}

function pnpmVersion(cacheRoot, adapter, toolchains) {
  const scratch = mkdtempSync(join(tmpdir(), 'bench-corepack-'));
  try {
    const home = privateCopy(join(cacheRoot, adapter.toolchain.cache.corepack_dir), join(scratch, 'corepack'));
    return version([join(toolchains.node.bin, 'corepack'), `pnpm@${adapter.toolchain.versions.pnpm}`, '--version'], {
      PATH: `${toolchains.node.bin}:/usr/bin:/bin`,
      HOME: scratch,
      COREPACK_HOME: home,
      COREPACK_ENABLE_NETWORK: '0',
      COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function cacheDirs(project) {
  const c = project.adapter.toolchain.cache;
  return [c.dir, c.wrapper_dir, c.corepack_dir].filter(Boolean);
}

function selectProjects(suite, ids) {
  if (!ids) return suite.projects;
  const out = suite.projects.filter((p) => ids.includes(p.id));
  if (out.length !== ids.length) throw new Error(`unknown project in ${ids.join(', ')}`);
  return out;
}

async function prepare(flags) {
  if (!flags['java-home'] || !flags['node-bin']) throw new Error('prepare needs --java-home and --node-bin');
  const cacheRoot = resolveCacheRoot({ explicit: flags['cache-root'] });
  const suite = loadSuite();
  if (suite.problems.length) throw new Error(`suite manifests are invalid: ${suite.problems.join('; ')}`);
  const projects = selectProjects(suite, flags.project);
  const toolchains = { schema: 'mycelink-bench/toolchains@1', ...detectToolchains({ javaHome: resolve(flags['java-home']), nodeBin: resolve(flags['node-bin']) }) };
  const problems = toolchainProblems(toolchains, projects);
  const steps = [];
  for (const project of projects) {
    const lock = project.lock;
    const bundlePath = join(cacheRoot, 'sources', lock.bundle.file);
    const v = await verifySourceBundle({ lock, bundlePath });
    if (!v.ok) {
      problems.push(`${project.id}: source bundle failed verification: ${v.checks.filter((c) => !c.ok).map((c) => c.id).join(', ')}`);
      continue;
    }
    const cache = project.adapter.toolchain.cache;
    if (cache.wrapper_dir) {
      const target = join(cacheRoot, cache.wrapper_dir, 'wrapper');
      if (!existsSync(target) && flags['maven-user-home-from']) {
        cpSync(join(resolve(flags['maven-user-home-from']), 'wrapper'), target, { recursive: true });
        steps.push(`${project.id}: copied the Maven wrapper distribution from ${flags['maven-user-home-from']}`);
      }
    }
    if (cache.corepack_dir) {
      const pnpm = project.adapter.toolchain.versions.pnpm;
      const target = join(cacheRoot, cache.corepack_dir, 'v1', 'pnpm', pnpm);
      if (!existsSync(target) && flags['corepack-from']) {
        cpSync(join(resolve(flags['corepack-from']), 'v1', 'pnpm', pnpm), target, { recursive: true });
        steps.push(`${project.id}: copied corepack's pnpm ${pnpm} from ${flags['corepack-from']}`);
      }
      // A project-less directory (a test fixture in a temp dir) must get the
      // same pnpm, offline, instead of corepack's "latest".
      const lkg = JSON.stringify(corepackLastKnownGood((await readFrozenFile({ lock, bundlePath, path: 'package.json' })).toString('utf8')), null, 2) + '\n';
      const lkgPath = join(cacheRoot, cache.corepack_dir, 'lastKnownGood.json');
      // What is there is read through one descriptor; the pin is replaced whole (rename), never written through a link.
      if (existsSync(join(cacheRoot, cache.corepack_dir)) && readRegular(lkgPath)?.bytes.toString('utf8') !== lkg) {
        writeFileSync(`${lkgPath}.${process.pid}.tmp`, lkg, { flag: 'wx' });
        renameSync(`${lkgPath}.${process.pid}.tmp`, lkgPath);
        steps.push(`${project.id}: pinned corepack's last-known-good package manager to the project's packageManager`);
      }
    }
    const missing = cacheDirs(project).filter((d) => !existsSync(join(cacheRoot, d)));
    if (missing.length && !flags.online) {
      problems.push(`${project.id}: missing ${missing.join(', ')}; pass --online to download, or --maven-user-home-from / --corepack-from to copy`);
      continue;
    }
    if (flags.online) {
      const scratch = mkdtempSync(join(tmpdir(), 'bench-prepare-'));
      try {
        const repo = join(scratch, 'repo');
        await importSource({ lock, bundlePath, target: repo });
        const r = onlinePopulate({ project, cacheRoot, repo, toolchains, scratch });
        steps.push(`${project.id}: online population exit ${r.status}`);
        if (r.status !== 0) problems.push(`${project.id}: online population failed: ${String(r.stderr ?? '').slice(-500)}`);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }
  }
  if (problems.length === 0) {
    writeFileSync(join(cacheRoot, 'toolchains.json'), JSON.stringify(toolchains, null, 2) + '\n');
    for (const project of projects.filter((p) => p.adapter.toolchain.runtime === 'node')) {
      const v = pnpmVersion(cacheRoot, project.adapter, toolchains);
      if (v !== project.adapter.toolchain.versions.pnpm) problems.push(`${project.id}: corepack pnpm reports ${JSON.stringify(v)}, want ${project.adapter.toolchain.versions.pnpm}`);
    }
  }
  if (problems.length === 0) {
    recordCacheLock(cacheRoot, suite.projects.flatMap(cacheDirs).filter((d) => existsSync(join(cacheRoot, d))));
    mkdirSync(join(suiteRoot(), '.local'), { recursive: true });
    writeFileSync(join(suiteRoot(), '.local', 'cache-root'), cacheRoot + '\n');
  }
  return { ok: problems.length === 0, command: 'prepare', cache_root: cacheRoot, toolchains, steps, problems };
}

/** The one place the benchmark touches the network: populating caches on request. */
function onlinePopulate({ project, cacheRoot, repo, toolchains, scratch }) {
  const cache = project.adapter.toolchain.cache;
  const env = { PATH: `${toolchains.java.home}/bin:${toolchains.node.bin}:/usr/bin:/bin`, HOME: join(scratch, 'home'), TZ: 'UTC', LANG: 'C.UTF-8' };
  mkdirSync(env.HOME, { recursive: true });
  if (cache.kind === 'maven-repository') {
    return spawnSync(join(repo, 'mvnw'), ['-B', `-Dmaven.repo.local=${join(cacheRoot, cache.dir)}`, '-Dspring-boot.build-image.skip=true', 'test'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...env, JAVA_HOME: toolchains.java.home, MAVEN_USER_HOME: join(cacheRoot, cache.wrapper_dir), MAVEN_SKIP_RC: '1' },
      timeout: 3_600_000,
    });
  }
  return spawnSync('pnpm', ['install', '--frozen-lockfile', '--filter=!@changesets/e2e', `--store-dir=${join(cacheRoot, cache.dir)}`], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...env, COREPACK_HOME: join(cacheRoot, cache.corepack_dir), COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
    timeout: 3_600_000,
  });
}

async function verify(flags) {
  const cacheRoot = resolveCacheRoot({ explicit: flags['cache-root'] });
  const suite = loadSuite();
  if (suite.problems.length) throw new Error(`suite manifests are invalid: ${suite.problems.join('; ')}`);
  const projects = selectProjects(suite, flags.project);
  const problems = [];
  const report = { ok: false, command: 'verify', cache_root: cacheRoot, toolchains: null, sources: {}, cache: null, baselines: {}, problems };
  let toolchains;
  try {
    toolchains = loadToolchains(cacheRoot);
  } catch (error) {
    problems.push(error.message);
    return report;
  }
  const detected = detectToolchains({ javaHome: toolchains.java.home, nodeBin: toolchains.node.bin });
  report.toolchains = detected;
  if (canonicalJson(detected) !== canonicalJson({ java: toolchains.java, node: toolchains.node })) problems.push('installed toolchain versions differ from toolchains.json');
  problems.push(...toolchainProblems(detected, projects));
  for (const project of projects.filter((p) => p.adapter.toolchain.runtime === 'node')) {
    const v = pnpmVersion(cacheRoot, project.adapter, toolchains);
    if (v !== project.adapter.toolchain.versions.pnpm) problems.push(`${project.id}: corepack pnpm reports ${JSON.stringify(v)}`);
  }
  for (const project of projects) {
    const v = await verifySourceBundle({ lock: project.lock, bundlePath: join(cacheRoot, 'sources', project.lock.bundle.file) });
    report.sources[project.id] = { ok: v.ok, facts: v.facts, failed: v.checks.filter((c) => !c.ok) };
    if (!v.ok) problems.push(`${project.id}: source bundle failed verification`);
  }
  report.cache = verifyCacheLock(cacheRoot);
  problems.push(...report.cache.problems);

  if (flags.baseline && problems.length === 0) {
    // The frozen suites run inside the isolation boundary, exactly as verification runs them.
    let isolation;
    try {
      isolation = requireSandbox();
    } catch (error) {
      problems.push(`${error.message}: baselines run only inside the isolation boundary`);
      return report;
    }
    const repeat = Number(flags.repeat ?? 3);
    const workRoot = resolve(flags['work-dir'] ?? mkdtempSync(join(tmpdir(), 'bench-verify-')));
    for (const project of projects) {
      const adapter = createAdapter(project.adapter);
      const runs = [];
      for (let i = 0; i < repeat; i++) {
        const out = await runFrozenBaseline({ project, bundlePath: join(cacheRoot, 'sources', project.lock.bundle.file), adapter, workRoot: join(workRoot, project.id), ctx: { cacheRoot, toolchains, isolation }, label: `baseline-${i + 1}` });
        runs.push(out);
        rmSync(out.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
      const { problems: recordProblems, record } = baselineRecord({ project, runs });
      const file = join(project.dir, 'baseline-tests.json');
      const entry = { runs: runs.map((r) => ({ category: r.run.category, exit_code: r.run.exit_code, duration_ms: r.run.duration_ms, tests: r.results.length })), counts: record.counts, problems: recordProblems };
      report.baselines[project.id] = entry;
      problems.push(...recordProblems.map((p) => `${project.id}: ${p}`));
      const schemaProblems = validate(loadSchema('baseline-tests'), record);
      if (schemaProblems.length) problems.push(...schemaProblems.map((p) => `${project.id}: baseline record ${p}`));
      if (recordProblems.length === 0 && schemaProblems.length === 0) {
        if (flags['write-baseline']) {
          writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
          entry.written = file;
        } else if (!existsSync(file)) {
          problems.push(`${project.id}: no committed baseline-tests.json (run with --write-baseline)`);
        } else if (canonicalJson(JSON.parse(readFileSync(file, 'utf8'))) !== canonicalJson(record)) {
          problems.push(`${project.id}: the frozen baseline no longer matches the committed baseline-tests.json`);
        }
      }
    }
    const after = verifyCacheLock(cacheRoot);
    if (!after.ok) problems.push(...after.problems.map((p) => `after the baseline runs: ${p}`));
  }
  report.ok = problems.length === 0;
  return report;
}

export async function main(argv) {
  const { positionals, flags } = parseArgs(argv, {
    valued: ['cache-root', 'java-home', 'node-bin', 'maven-user-home-from', 'corepack-from', 'repeat', 'work-dir', 'out'],
    repeated: ['project'],
    booleans: ['online', 'baseline', 'write-baseline'],
  });
  const [command] = positionals;
  let result;
  if (command === 'prepare') result = await prepare(flags);
  else if (command === 'verify') result = await verify(flags);
  else return { ok: false, exit: 2, errors: ['usage: cache.mjs prepare|verify [options]'] };
  if (flags.out) result.out = flags.out;
  return result;
}

runTool(import.meta.url, main);
