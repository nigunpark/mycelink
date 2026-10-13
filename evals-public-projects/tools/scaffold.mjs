#!/usr/bin/env node
/**
 * Build the agent workspace for one case (called by cases/<case>/scaffold.sh).
 *
 *   node evals-public-projects/tools/scaffold.mjs <case> <target-dir>
 *        [--home <dir>] [--cache-root <dir>] [--suite-root <dir>]
 *
 * The target must be empty. The sandbox HOME (default: $HOME, which the eval
 * harness points at the run's sandbox) receives private copies of the
 * offline toolchain caches. The cache root comes from --cache-root,
 * $MYCELINK_BENCH_CACHE, or the pointer `cache prepare` leaves in
 * evals-public-projects/.local/cache-root (the harness gives scaffolds a
 * minimal environment). Only the frozen source bundle (verified first), the
 * public requirement and the adapter manifest are read.
 */
import { resolve } from 'node:path';
import { parseArgs, runTool } from '../lib/cli.mjs';
import { findPrd, loadSuite, suiteRoot } from '../lib/manifests.mjs';
import { resolveCacheRoot } from '../lib/toolchain.mjs';
import { buildWorkspace } from '../lib/workspace.mjs';

export async function main(argv) {
  const { positionals, flags } = parseArgs(argv, { valued: ['home', 'cache-root', 'suite-root'] });
  const [caseName, target] = positionals;
  if (!caseName || !target) return { ok: false, exit: 2, errors: ['usage: scaffold.mjs <case> <target-dir> [--home <dir>] [--cache-root <dir>]'] };
  const suite = loadSuite(flags['suite-root'] ? resolve(flags['suite-root']) : suiteRoot());
  if (suite.problems.length) return { ok: false, exit: 2, errors: suite.problems };
  const found = findPrd(suite, caseName);
  if (!found) return { ok: false, exit: 2, errors: [`unknown case ${caseName}`] };
  const home = resolve(flags.home ?? process.env.HOME ?? '');
  const ws = await buildWorkspace({ project: found.project, prd: found.prd, target: resolve(target), home, cacheRoot: resolveCacheRoot({ explicit: flags['cache-root'] }) });
  // The harness discards stdout; keep it to facts that carry no evaluator detail.
  return { ok: true, case: found.prd.manifest.case, workspace: ws.workspace };
}

runTool(import.meta.url, main);
