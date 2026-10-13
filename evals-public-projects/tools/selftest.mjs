#!/usr/bin/env node
/**
 * Model-free selftest of the public-project suite on the real projects.
 *
 *   node evals-public-projects/tools/selftest.mjs [--prd <id>]... [--cache-root <dir>] [--work-dir <dir>] [--out <file>]
 *
 * Needs the prepared caches and the evaluator store (see ../README.md);
 * run it on the host that runs the evals (WSL). No model is involved. It
 * takes about half an hour for all six PRDs, most of it Maven. Exit codes:
 * 0 all checks pass, 1 a check failed, 2 usage or internal error.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs, runTool } from '../lib/cli.mjs';
import { suiteRoot } from '../lib/manifests.mjs';
import { selftest } from '../lib/selftest.mjs';
import { requireSandbox } from '../lib/sandbox.mjs';
import { resolveCacheRoot } from '../lib/toolchain.mjs';

export async function main(argv) {
  let flags;
  try {
    ({ flags } = parseArgs(argv, { valued: ['cache-root', 'work-dir', 'out', 'suite-root'], repeated: ['prd'] }));
  } catch (error) {
    return { ok: false, exit: 2, errors: [`usage: ${error.message}`] };
  }
  let isolation;
  try {
    isolation = requireSandbox();
  } catch (error) {
    return { ok: false, exit: 2, errors: [`${error.message}: the selftest runs code only inside the isolation boundary (see evals-public-projects/README.md, Isolation)`] };
  }
  const workRoot = flags['work-dir'] ? resolve(flags['work-dir']) : mkdtempSync(join(tmpdir(), 'bench-selftest-'));
  try {
    const result = await selftest({
      suiteRoot: flags['suite-root'] ? resolve(flags['suite-root']) : suiteRoot(),
      cacheRoot: resolveCacheRoot({ explicit: flags['cache-root'] }),
      workRoot,
      prds: flags.prd ?? null,
      isolation,
      log: (line) => process.stderr.write(`[selftest] ${line}\n`),
    });
    return { ...result, ...(flags.out ? { out: flags.out } : {}) };
  } finally {
    if (!flags['work-dir']) rmSync(workRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

runTool(import.meta.url, main);
