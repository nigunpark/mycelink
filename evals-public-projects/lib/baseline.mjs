/**
 * The upstream baseline: what the trusted command reports on the frozen
 * commit, and the regression rule a delivery must meet against it.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, sha256Hex } from './hash.mjs';
import { exportTree } from './git.mjs';
import { importSource } from './source.mjs';

/**
 * Run the adapter's full trusted suite on a commit of `repo`, in a fresh
 * export (with `overrides`: the trusted tree, see harness.mjs).
 */
export async function runFullSuite({ adapter, repo, commit, workRoot, ctx, label = 'baseline', overrides = new Map() }) {
  mkdirSync(workRoot, { recursive: true });
  const dir = mkdtempSync(join(workRoot, `${label}-`));
  const tree = join(dir, 'tree');
  exportTree(repo, commit, tree, { overrides });
  try {
    const out = await adapter.runTests({ tree, tests: null, ctx: { ...ctx, workRoot: dir }, label });
    return { ...out, dir };
  } finally {
    rmSync(tree, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/** Import the frozen source and run the full suite on it. */
export async function runFrozenBaseline({ project, bundlePath, adapter, workRoot, ctx, label = 'baseline' }) {
  mkdirSync(workRoot, { recursive: true });
  const repo = join(mkdtempSync(join(workRoot, 'frozen-')), 'repo');
  await importSource({ lock: project.lock, bundlePath, target: repo });
  try {
    return await runFullSuite({ adapter, repo, commit: project.lock.commit, workRoot, ctx, label });
  } finally {
    rmSync(join(repo, '..'), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/** The committed baseline record for one or more identical runs. */
export function baselineRecord({ project, runs }) {
  const views = runs.map((r) => r.results.map((t) => ({ id: t.id, status: t.status })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
  const first = canonicalJson(views[0]);
  const problems = [];
  views.forEach((v, i) => {
    if (canonicalJson(v) !== first) problems.push(`run ${i + 1} reports different tests or statuses than run 1`);
  });
  for (const [i, r] of runs.entries()) if (r.run.category !== 'ok') problems.push(`run ${i + 1} ended ${r.run.category} (exit ${r.run.exit_code})`);
  const tests = views[0];
  const failed = tests.filter((t) => t.status === 'failed');
  if (failed.length) problems.push(`failing upstream tests: ${failed.map((t) => t.id).join(', ')}`);
  const commands = new Set(runs.map((r) => canonicalJson(r.command)));
  if (commands.size !== 1) problems.push('the runs did not use one identical command');
  return {
    problems,
    record: {
      schema: 'mycelink-bench/baseline-tests@1',
      project: project.adapter.id,
      source_identity_sha256: project.lock.identity_sha256,
      command_sha256: sha256Hex(canonicalJson(runs[0].command)),
      runs: runs.length,
      counts: {
        passed: tests.filter((t) => t.status === 'passed').length,
        failed: failed.length,
        skipped: tests.filter((t) => t.status === 'skipped').length,
      },
      tests: tests.filter((t) => t.status !== 'failed'),
    },
  };
}

/**
 * The regression rule: every baseline test that passed must be reported and
 * pass; nothing may fail (new tests included). `superseded` are upstream
 * tests the requirement itself changes (qualification found them failing on
 * the reference with the frozen test code): they are neither required nor
 * counted as failures.
 */
export function compareToBaseline(record, results, { superseded = [] } = {}) {
  const skip = new Set(superseded);
  const byId = new Map();
  for (const r of results) byId.set(r.id, r);
  const missing = [];
  const regressed = [];
  for (const t of record.tests) {
    if (t.status !== 'passed' || skip.has(t.id)) continue;
    const r = byId.get(t.id);
    if (!r) missing.push(t.id);
    else if (r.status !== 'passed') regressed.push(`${t.id} (${r.status}${r.category && r.category !== r.status ? `, ${r.category}` : ''})`);
  }
  const known = new Set(record.tests.map((t) => t.id));
  const failingNew = results.filter((r) => !known.has(r.id) && !skip.has(r.id) && r.status === 'failed').map((r) => `${r.id} (${r.category})`);
  return { missing, regressed, failing_new: failingNew, new_tests: results.filter((r) => !known.has(r.id)).length };
}
