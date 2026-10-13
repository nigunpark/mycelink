#!/usr/bin/env node
/**
 * Qualify a PRD's evaluator artifacts (model-free; run in WSL/Linux after
 * `cache prepare` and `evaluator import`).
 *
 *   node evals-public-projects/tools/qualify.mjs --prd <id> [--prd <id>]...
 *        --tmp-root <dir>... [--repeat <n>] [--stress-repeat <n>]
 *        [--work-dir <dir>] [--cache-root <dir>] [--out <file>]
 *
 * For each PRD: hidden tests RED on the frozen commit only for missing
 * behaviour, GREEN on the reference (also with the temp dir on every
 * --tmp-root, e.g. a tmpfs, to prove file-system independence), the
 * reference's full suite, TDD replay and scope, and every gating mutant
 * killed in every run. On success it writes expected.json into the
 * evaluator store, re-locks it, and writes the committed counts-only
 * projects/<project>/prds/<PRD>/qualification.json.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs, runTool } from '../lib/cli.mjs';
import { findPrd, loadSuite } from '../lib/manifests.mjs';
import { qualifyPrd } from '../lib/qualify.mjs';
import { requireSandbox } from '../lib/sandbox.mjs';
import { resolveCacheRoot } from '../lib/toolchain.mjs';

export async function main(argv) {
  const { flags } = parseArgs(argv, { valued: ['repeat', 'stress-repeat', 'work-dir', 'cache-root', 'out'], repeated: ['prd', 'tmp-root'] });
  if (!flags.prd) return { ok: false, exit: 2, errors: ['usage: qualify.mjs --prd <id> [options]'] };
  // File-system independence is part of qualification: one run at least has its temp dir on another file system.
  if (!flags['tmp-root']?.length) return { ok: false, exit: 2, errors: ['usage: qualification needs a --tmp-root on another file system than the work directory (e.g. a tmpfs such as /dev/shm)'] };
  let isolation;
  try {
    isolation = requireSandbox();
  } catch (error) {
    return { ok: false, exit: 2, errors: [`${error.message}: qualification runs code only inside the isolation boundary (see evals-public-projects/README.md, Isolation)`] };
  }
  const cacheRoot = resolveCacheRoot({ explicit: flags['cache-root'] });
  const suite = loadSuite();
  if (suite.problems.length) return { ok: false, exit: 2, errors: suite.problems };
  const results = [];
  for (const key of flags.prd) {
    const found = findPrd(suite, key);
    if (!found) {
      results.push({ prd: key, ok: false, errors: ['unknown PRD'] });
      continue;
    }
    const started = Date.now();
    const workRoot = mkdtempSync(join(resolve(flags['work-dir'] ?? tmpdir()), `qualify-${key}-`));
    try {
      const r = await qualifyPrd({
        project: found.project,
        prd: found.prd,
        cacheRoot,
        workRoot,
        repeat: Number(flags.repeat ?? 2),
        stressRepeat: Number(flags['stress-repeat'] ?? 3),
        tmpRoots: (flags['tmp-root'] ?? []).map((d) => resolve(d)),
        isolation,
        log: (line) => process.stderr.write(`[${key}] ${line}\n`),
      });
      results.push({ prd: key, ok: r.ok, seconds: Math.round((Date.now() - started) / 1000), checks: r.checks, mutants: r.expected.mutants, baseline_red: r.expected.baseline_red?.map((t) => ({ name: t.name, status: t.status, category: t.category })) });
    } catch (error) {
      results.push({ prd: key, ok: false, errors: [String(error?.stack ?? error)] });
    }
  }
  const out = { ok: results.every((r) => r.ok), results };
  if (flags.out) out.out = flags.out;
  return out;
}

runTool(import.meta.url, main);
