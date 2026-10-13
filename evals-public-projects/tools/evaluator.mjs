#!/usr/bin/env node
/**
 * Evaluator-only artifacts: import them from an authoring repository into
 * the evaluator store (outside this repository) and lock them, or verify
 * the store against the committed locks.
 *
 *   node evals-public-projects/tools/evaluator.mjs import --prd <id> --from <authoring repo> [--cache-root <dir>]
 *   node evals-public-projects/tools/evaluator.mjs verify [--prd <id>]... [--cache-root <dir>]
 *   node evals-public-projects/tools/evaluator.mjs export --prd <id> --out <archive.zip> [--cache-root <dir>]
 *   node evals-public-projects/tools/evaluator.mjs import-archive --prd <id> --archive <archive.zip> [--cache-root <dir>]
 *
 * The authoring repository is a clone of the frozen source with the
 * branches hidden/<PRD>, reference/<PRD> and mutant/<PRD>/<id> (see
 * lib/evaluator.mjs for the rules each must meet). Import writes
 * <cache>/evaluator/<project>/<PRD>/ and the committed
 * projects/<project>/prds/<PRD>/evaluator.lock.json; nothing else of the
 * artifacts enters the repository.
 *
 * The artifacts stay private; the committed evaluator.lock.json digest is
 * their public commitment. `export` writes a verified store as a
 * deterministic archive (same store, same bytes; its SHA-256 is printed);
 * `import-archive` installs one on another machine only when its content
 * hashes to exactly the committed digest, checked before anything is written.
 */
import { resolve } from 'node:path';
import { parseArgs, runTool } from '../lib/cli.mjs';
import { evaluatorDir, exportEvaluator, importEvaluator, importEvaluatorArchive, loadEvaluator } from '../lib/evaluator.mjs';
import { findPrd, loadSuite } from '../lib/manifests.mjs';
import { resolveCacheRoot } from '../lib/toolchain.mjs';

export async function main(argv) {
  const { positionals, flags } = parseArgs(argv, { valued: ['from', 'cache-root', 'out', 'archive'], repeated: ['prd'] });
  const [command] = positionals;
  const cacheRoot = resolveCacheRoot({ explicit: flags['cache-root'] });
  const suite = loadSuite();
  if (suite.problems.length) return { ok: false, exit: 2, errors: suite.problems };
  if (command === 'export' || command === 'import-archive') {
    const file = command === 'export' ? flags.out : flags.archive;
    if (!flags.prd || flags.prd.length !== 1 || !file) return { ok: false, exit: 2, errors: [`usage: evaluator.mjs ${command} --prd <id> ${command === 'export' ? '--out' : '--archive'} <archive.zip>`] };
    const found = findPrd(suite, flags.prd[0]);
    if (!found) return { ok: false, exit: 2, errors: [`unknown PRD ${flags.prd[0]}`] };
    const args = { cacheRoot, project: found.project, prdId: found.prd.manifest.id };
    try {
      const r = command === 'export' ? exportEvaluator({ ...args, out: resolve(file) }) : importEvaluatorArchive({ ...args, archive: resolve(file) });
      return { ok: true, command, prd: found.prd.manifest.id, ...r };
    } catch (error) {
      return { ok: false, command, prd: found.prd.manifest.id, errors: [error.message] };
    }
  }
  if (command === 'import') {
    if (!flags.prd || flags.prd.length !== 1 || !flags.from) return { ok: false, exit: 2, errors: ['usage: evaluator.mjs import --prd <id> --from <authoring repo>'] };
    const found = findPrd(suite, flags.prd[0]);
    if (!found) return { ok: false, exit: 2, errors: [`unknown PRD ${flags.prd[0]}`] };
    const info = importEvaluator({ project: found.project, prdId: found.prd.manifest.id, from: resolve(flags.from), cacheRoot });
    return { ok: true, command, prd: found.prd.manifest.id, dir: info.dir, hidden_files: info.hidden.length, hidden_tests: info.hidden_tests.length, reference: info.reference, mutants: info.mutants.length, digest: info.lock.digest_sha256 };
  }
  if (command === 'verify') {
    const keys = flags.prd ?? suite.projects.flatMap((p) => p.prds.map((prd) => prd.manifest.id));
    const results = [];
    for (const key of keys) {
      const found = findPrd(suite, key);
      if (!found) {
        results.push({ prd: key, ok: false, error: 'unknown PRD' });
        continue;
      }
      try {
        const ev = loadEvaluator({ cacheRoot, project: found.project, prdId: found.prd.manifest.id });
        results.push({ prd: key, ok: true, dir: evaluatorDir(cacheRoot, found.project.id, key), digest: ev.lock.digest_sha256, qualified: ev.expected !== null });
      } catch (error) {
        results.push({ prd: key, ok: false, error: error.message });
      }
    }
    return { ok: results.every((r) => r.ok), command, results };
  }
  return { ok: false, exit: 2, errors: ['usage: evaluator.mjs import|verify|export|import-archive [options]'] };
}

runTool(import.meta.url, main);
