#!/usr/bin/env node
/**
 * The repository's test suites, run bounded: what `npm test`, CI and the
 * release workflow run.
 *
 * One unbounded `vitest run` of every file at once (CI 38347201692) put ~250
 * files of git- and process-heavy suites on a 3-4 vCPU runner; Windows legs
 * could not finish in their 30 minutes, and long single-flow end-to-end tests
 * ran past their timeouts. Each suite runs here as its own Vitest process, one
 * after another, with a bounded worker count; the large ones are split into
 * shards balanced by measured duration (scripts/test-weights.json, seconds;
 * a file it does not list weighs DEFAULT_WEIGHT). Every test file Vitest
 * collects belongs to exactly one suite and one shard, whatever the weights
 * say (tests/release/ci-workflow.test.ts).
 *
 *   node scripts/test-suites.mjs all                  every suite in turn (npm test)
 *   node scripts/test-suites.mjs run <suite>[:i/n]... those suites (or one shard of one)
 *   node scripts/test-suites.mjs ci <group>           one CI matrix group, as the workflows run it
 *   node scripts/test-suites.mjs list [--json]        the plan: suites, shards, files, groups
 *
 * The real-model pilot is never here (vitest.pilot.config.ts, opt-in); the
 * benchmark's recorded fixture projects are data, never suites.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Each suite: its directory, what it leaves out, how many files run at once, how many shards it is cut into, and the
 * bound on one test or hook where it is not the config's 120 s. The workflow suites (integration, fixtures,
 * benchmark) drive real git repositories and CLI processes through whole scenarios; on hosted runners they take two
 * to three times as long as on a developer machine, so they get the 300 s bound the longest replays already declare.
 * A test that hangs still fails; nothing is retried.
 */
export const SUITES = {
  unit: { dir: 'tests/unit', maxWorkers: 3, shards: 1 },
  integration: { dir: 'tests/integration', maxWorkers: 3, shards: 5, timeoutMs: 300_000 },
  security: { dir: 'tests/security', maxWorkers: 3, shards: 1 },
  fixtures: { dir: 'tests/fixtures', maxWorkers: 2, shards: 2, timeoutMs: 300_000 },
  release: { dir: 'tests/release', maxWorkers: 2, shards: 1 },
  'plugin-e2e': { dir: 'tests/plugin-e2e', maxWorkers: 1, shards: 1 },
  // The model-free tests of the public-project benchmark (evals-public-projects); real pilots are opt-in elsewhere.
  benchmark: { dir: 'tests/benchmark', exclude: ['tests/benchmark/fixtures/'], maxWorkers: 2, shards: 3, timeoutMs: 300_000 },
};

/** Directories under tests/ that hold no suite: helpers, the fake Claude, the opt-in pilot. */
export const NOT_SUITES = ['tests/helpers', 'tests/fake-claude', 'tests/pilot'];

/** Seconds a file the weights do not list is taken to run. */
export const DEFAULT_WEIGHT = 30;

/**
 * The CI matrix groups, in order: each a list of suites (whole) or one shard of one. The workflows run each group as
 * one job on every OS and Node version they test.
 */
export const CI_GROUPS = [
  { id: 'core', runs: ['unit', 'security', 'release', 'plugin-e2e'] },
  ...Array.from({ length: SUITES.integration.shards }, (_, i) => ({ id: `integration-${i + 1}`, runs: [`integration:${i + 1}/${SUITES.integration.shards}`] })),
  ...Array.from({ length: SUITES.fixtures.shards }, (_, i) => ({ id: `fixtures-${i + 1}`, runs: [`fixtures:${i + 1}/${SUITES.fixtures.shards}`] })),
  ...Array.from({ length: SUITES.benchmark.shards }, (_, i) => ({ id: `benchmark-${i + 1}`, runs: [`benchmark:${i + 1}/${SUITES.benchmark.shards}`] })),
];

const slash = (p) => p.split('\\').join('/');

/** Every `*.test.ts` under `dir` (repository-relative, '/'-separated, sorted), without what `exclude` names. */
function testFiles(dir, exclude = []) {
  const out = [];
  const walk = (abs) => {
    for (const name of readdirSync(abs).sort()) {
      const full = join(abs, name);
      const rel = slash(relative(ROOT, full));
      if (exclude.some((x) => rel === x.replace(/\/$/, '') || rel.startsWith(x))) continue;
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.test.ts')) out.push(rel);
    }
  };
  if (existsSync(join(ROOT, dir))) walk(join(ROOT, dir));
  return out.sort();
}

/** What Vitest collects (vitest.config.ts): every tests/**\/*.test.ts but the pilot's and the benchmark's recorded fixtures. */
export function collectedFiles() {
  return testFiles('tests', ['tests/pilot/', 'tests/benchmark/fixtures/']);
}

function weights() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'scripts', 'test-weights.json'), 'utf8'));
  } catch {
    return {};
  }
}

/**
 * A suite's files cut into `n` shards, balanced by weight: the heaviest file first, each to the lightest shard so far
 * (ties: the lower shard, then the path). Deterministic, and a partition: every file in exactly one shard.
 */
export function shardsOf(suite, n = SUITES[suite].shards) {
  const s = SUITES[suite];
  if (s === undefined) throw new Error(`no suite ${suite}`);
  const w = weights();
  const files = testFiles(s.dir, s.exclude).map((f) => ({ f, w: w[f] ?? DEFAULT_WEIGHT }));
  files.sort((a, b) => b.w - a.w || (a.f < b.f ? -1 : 1));
  const shards = Array.from({ length: n }, () => ({ files: [], weight: 0 }));
  for (const { f, w: weight } of files) {
    let best = 0;
    for (let i = 1; i < n; i++) if (shards[i].weight < shards[best].weight) best = i;
    shards[best].files.push(f);
    shards[best].weight += weight;
  }
  return shards.map((x) => ({ files: x.files.sort(), weight: x.weight }));
}

/** `suite` or `suite:i/n` -> the files it runs and its worker bound. */
export function selection(spec) {
  const m = /^([a-z0-9-]+)(?::(\d+)\/(\d+))?$/.exec(spec);
  if (m === null || SUITES[m[1]] === undefined) throw new Error(`unknown suite ${spec} (suites: ${Object.keys(SUITES).join(', ')})`);
  const suite = m[1];
  const { maxWorkers, timeoutMs = null } = SUITES[suite];
  if (m[2] === undefined) return { suite, label: suite, files: testFiles(SUITES[suite].dir, SUITES[suite].exclude), maxWorkers, timeoutMs };
  const i = Number(m[2]);
  const n = Number(m[3]);
  if (n !== SUITES[suite].shards || i < 1 || i > n) throw new Error(`${spec}: ${suite} has shards 1..${SUITES[suite].shards}`);
  return { suite, label: `${suite} ${i}/${n}`, files: shardsOf(suite, n)[i - 1].files, maxWorkers, timeoutMs };
}

/** Run one selection as its own Vitest process; returns its exit status. */
function runSelection({ label, files, maxWorkers, timeoutMs }) {
  // Vitest takes file arguments as filters that match by substring: each must name exactly one collected file.
  const all = collectedFiles();
  for (const f of files) {
    const hits = all.filter((x) => x.includes(f));
    if (hits.length !== 1) throw new Error(`${f} would select ${hits.length} files (${hits.join(', ')})`);
  }
  if (files.length === 0) {
    process.stdout.write(`\n== ${label}: no test files\n`);
    return 0;
  }
  process.stdout.write(`\n== ${label}: ${files.length} file(s), at most ${maxWorkers} at once${timeoutMs ? `, ${timeoutMs / 1000} s a test` : ''}\n`);
  const vitest = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
  const bound = timeoutMs ? [`--testTimeout=${timeoutMs}`, `--hookTimeout=${timeoutMs}`] : [];
  const r = spawnSync(process.execPath, [vitest, 'run', ...files, `--maxWorkers=${maxWorkers}`, ...bound], { cwd: ROOT, stdio: 'inherit' });
  return r.status ?? 1;
}

function runAll(specs) {
  const failed = [];
  for (const spec of specs) {
    const sel = selection(spec);
    if (runSelection(sel) !== 0) failed.push(sel.label);
  }
  process.stdout.write(failed.length === 0 ? `\n== passed: ${specs.join(', ')}\n` : `\n== FAILED: ${failed.join(', ')}\n`);
  return failed.length === 0 ? 0 : 1;
}

export function plan() {
  return {
    suites: Object.fromEntries(Object.entries(SUITES).map(([name, s]) => [name, { ...s, shards: shardsOf(name) }])),
    groups: CI_GROUPS,
  };
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'all') return runAll(Object.keys(SUITES));
  if (cmd === 'run' && rest.length > 0) return runAll(rest);
  if (cmd === 'ci' && rest.length === 1) {
    const group = CI_GROUPS.find((g) => g.id === rest[0]);
    if (group === undefined) throw new Error(`unknown CI group ${rest[0]} (groups: ${CI_GROUPS.map((g) => g.id).join(', ')})`);
    return runAll(group.runs);
  }
  if (cmd === 'list') {
    if (rest.includes('--json')) process.stdout.write(`${JSON.stringify(plan(), null, 2)}\n`);
    else {
      for (const [name, s] of Object.entries(plan().suites)) {
        s.shards.forEach((x, i) => process.stdout.write(`${name}${s.shards.length > 1 ? ` ${i + 1}/${s.shards.length}` : ''}: ${x.files.length} files, ~${Math.round(x.weight)} s, ${s.maxWorkers} at once\n`));
      }
      for (const g of CI_GROUPS) process.stdout.write(`ci ${g.id}: ${g.runs.join(', ')}\n`);
    }
    return 0;
  }
  process.stderr.write('usage: test-suites.mjs all | run <suite>[:i/n]... | ci <group> | list [--json]\n');
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
