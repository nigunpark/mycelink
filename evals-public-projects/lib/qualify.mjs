/**
 * Qualification of one PRD's evaluator artifacts, model-free, before any
 * agent runs. Every hidden-test run uses the trusted tree (frozen upstream
 * tests and configuration, that side's production code, the hidden
 * overlay), exactly as the verifier will:
 *
 *   hidden-red-at-baseline   on the frozen commit every hidden test runs, at
 *                            least one fails, and every failure is a missing
 *                            behaviour (assertion or code-under-test exception)
 *   hidden-green-on-reference  every hidden test passes on the reference
 *   reference-full-suite     on the reference's trusted tree the qualified
 *                            baseline passes but for the upstream tests the
 *                            requirement supersedes — each of which the
 *                            reference itself had to change — and the
 *                            reference's own tests pass, in every required
 *                            module that can have them
 *   reference-tdd            the reference history replays as test-first
 *   reference-scope          the reference stays inside the PRD's scope
 *   reference-harness        the reference passes the harness checks
 *   mutant:<id>              each gating mutant is killed by a hidden test
 *                            failing for a missing behaviour, in every run;
 *                            `stress-*` mutants (race-only bugs) are measured,
 *                            not gating
 *   mutant-coverage          every required module with runtime behaviour has
 *                            a gating mutant (one that changes its production
 *                            code): a hidden test needs that module's behaviour
 *   deterministic            repeated runs, also with the temp dir on other
 *                            file systems (tmpRoots), agree test by test
 *   tmp-roots-distinct       every tmp root really is another file system
 *
 * Results go to expected.json in the evaluator store (superseded upstream
 * tests by id, the qualified commands), which is re-locked; the PRD
 * directory gets a committed qualification.json with counts and hashes
 * only — and the bindings every verification must meet: the evaluator
 * digest, the source identity, the cache lock digest, the toolchain
 * digests and the trusted commands' hashes.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAdapter } from './adapters/index.mjs';
import { compareToBaseline, runFullSuite } from './baseline.mjs';
import { evaluatorDir, loadEvaluator, unbundleReference, writeEvaluatorLock } from './evaluator.mjs';
import { canonicalJson, sha256Hex } from './hash.mjs';
import { applyPatchToTree, exportTree } from './git.mjs';
import { deliveredChanges, inspectHarness, trustedOverrides } from './harness.mjs';
import { makeSection } from './hygiene.mjs';
import { RED_VALID_CATEGORIES } from './results.mjs';
import { inspectScope, testedModules } from './scope.mjs';
import { importSource } from './source.mjs';
import { replayUnit, segmentUnits, summarizeExpected } from './tdd.mjs';
import { isolationRecord } from './sandbox.mjs';
import { cacheLockDigest, loadToolchains, toolchainDigests } from './toolchain.mjs';
import { deliveredTests } from './verify.mjs';

const view = (summary) => summary.map((t) => ({ file: t.file, name: t.name, status: t.status, category: t.category, type: t.type, fingerprint: t.fingerprint }));

/**
 * The file system `path` lives on: its device id and, on Linux, its type
 * (from /proc/self/mountinfo, the longest mount point above the path).
 */
export function filesystemOf(path) {
  const real = realpathSync.native(path);
  const device = statSync(real).dev;
  let type = null;
  try {
    let best = -1;
    for (const line of readFileSync('/proc/self/mountinfo', 'utf8').split('\n')) {
      const [left, right] = line.split(' - ');
      if (!right) continue;
      const mountPoint = left.split(' ')[4].replace(/\\040/g, ' ');
      if ((real === mountPoint || real.startsWith(mountPoint.endsWith('/') ? mountPoint : `${mountPoint}/`)) && mountPoint.length > best) {
        best = mountPoint.length;
        type = right.split(' ')[0];
      }
    }
  } catch {
    type = null; // not Linux
  }
  return { device, type };
}

/** The repository paths a git patch changes (its `diff --git`, `---` and `+++` headers; /dev/null aside). */
export function patchPaths(patch) {
  const paths = new Set();
  let header = false;
  for (const line of patch.toString('utf8').split('\n')) {
    const diff = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
    if (diff) {
      header = true;
      paths.add(diff[1]).add(diff[2]);
      continue;
    }
    if (line.startsWith('@@') || line.startsWith('GIT binary patch')) header = false;
    const file = header ? /^(?:---|\+\+\+) [ab]\/(.+?)\t?$/.exec(line) : null;
    if (file) paths.add(file[1]);
  }
  return [...paths].sort();
}

/** The trusted commands of a project as qualified: hashes of the full-suite and the hidden-test commands. */
const commandSha = (command) => sha256Hex(canonicalJson(command));

export async function qualifyPrd({ project, prd, cacheRoot, workRoot, repeat = 2, stressRepeat = 3, tmpRoots = [], toolchains = null, isolation = null, log = () => {} }) {
  // Every hidden, reference and mutant run executes candidate code: only inside the isolation boundary.
  if (!isolation || !['bubblewrap', 'none'].includes(isolation.kind)) throw new Error('no isolation given: qualification runs code only inside the boundary (lib/sandbox.mjs requireSandbox)');
  const { checks, check } = makeSection();
  const prdId = prd.manifest.id;
  const adapter = createAdapter(project.adapter);
  const ctx = { cacheRoot, toolchains: project.adapter.toolchain.cache.kind === 'none' ? null : toolchains ?? loadToolchains(cacheRoot), isolation };
  const evaluator = loadEvaluator({ cacheRoot, project, prdId });
  const hidden = [...evaluator.hidden].map(([path, content]) => ({ path, content }));
  const hiddenTests = adapter.testsInDelta(hidden.map((h) => ({ path: h.path, before: null, after: h.content.toString('utf8') })));
  mkdirSync(workRoot, { recursive: true });
  const repo = join(mkdtempSync(join(workRoot, 'frozen-')), 'repo');
  await importSource({ lock: project.lock, bundlePath: join(cacheRoot, 'sources', project.lock.bundle.file), target: repo });
  const start = project.lock.commit;
  const referenceHead = unbundleReference({ evaluator, repo });
  const durations = {};
  const trusted = (rev) => trustedOverrides({ repo, start, head: rev, adapter: project.adapter }).overrides;

  // ---- the file systems the runs use: a tmp root counts only when it really is another one.
  const work = filesystemOf(workRoot);
  const roots = tmpRoots.map((root, i) => ({ role: `tmp-root-${i + 1}`, ...filesystemOf(root) }));
  const filesystems = [{ role: 'work', ...work }, ...roots];
  const same = roots.filter((r) => r.device === work.device);
  check('tmp-roots-distinct', same.length === 0, same.length ? `${same.map((r) => r.role).join(', ')} is on the work directory's file system (${work.type ?? 'device ' + work.device}): no other file system was tested` : `${new Set(filesystems.map((f) => f.device)).size} distinct file system(s): ${filesystems.map((f) => `${f.role} ${f.type ?? '?'}`).join(', ')}`);

  /** Hidden tests on `rev`'s trusted tree (optionally with a mutant patch applied), in a fresh export. */
  const runHidden = async (rev, { patch = null, label, tmpRoot = undefined }) => {
    const dir = mkdtempSync(join(workRoot, `${label}-`));
    const tree = join(dir, 'tree');
    const started = Date.now();
    try {
      exportTree(repo, rev, tree, { overrides: trusted(rev), extra: hidden });
      if (patch) {
        const patchFile = join(dir, 'mutant.patch');
        writeFileSync(patchFile, patch);
        try {
          applyPatchToTree(tree, patchFile);
        } catch (error) {
          throw new Error(`the mutant does not apply: ${error.message}`);
        }
      }
      const out = await adapter.runTests({ tree, tests: hiddenTests, ctx: { ...ctx, workRoot: dir, tmpRoot }, label });
      return { run: out.run, command: out.command, tests: summarizeExpected(out.results, hiddenTests, adapter) };
    } finally {
      durations[label] = Date.now() - started;
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  };
  const missingBehaviour = (r) => r.run.category === 'tests-failed' && r.tests.some((t) => t.status === 'failed' && RED_VALID_CATEGORIES.has(t.category));

  // ---- RED at baseline.
  log('hidden tests on the frozen commit');
  const baselineRuns = [];
  for (let i = 0; i < repeat; i++) baselineRuns.push(await runHidden(start, { label: `baseline-${i + 1}` }));
  const red = baselineRuns[0];
  const notRun = red.tests.filter((t) => t.status === 'not-run');
  const failing = red.tests.filter((t) => t.status === 'failed');
  const wrongReason = failing.filter((t) => !RED_VALID_CATEGORIES.has(t.category));
  check(
    'hidden-red-at-baseline',
    red.run.category === 'tests-failed' && notRun.length === 0 && failing.length > 0 && wrongReason.length === 0,
    `${failing.length}/${red.tests.length} hidden test(s) fail on the frozen commit (run ${red.run.category}); not run: ${notRun.length}; wrong reason: ${wrongReason.map((t) => `${t.name} (${t.category})`).join(', ') || 'none'}`,
  );

  // ---- GREEN on the reference, also with other temp roots.
  log('hidden tests on the reference');
  const referenceRuns = [];
  for (let i = 0; i < repeat; i++) referenceRuns.push(await runHidden(referenceHead, { label: `reference-${i + 1}` }));
  for (const [i, tmpRoot] of tmpRoots.entries()) referenceRuns.push(await runHidden(referenceHead, { label: `reference-tmp-${i + 1}`, tmpRoot }));
  const notGreen = referenceRuns.flatMap((r, i) => r.tests.filter((t) => t.status !== 'passed').map((t) => `run ${i + 1}: ${t.name} (${t.status}, ${t.category})`));
  check('hidden-green-on-reference', referenceRuns.every((r) => r.run.category === 'ok') && notGreen.length === 0, notGreen.length ? notGreen.slice(0, 10).join('; ') : `all ${hiddenTests.length} hidden test(s) pass in ${referenceRuns.length} run(s)`);

  // ---- the reference as a delivery: trusted full suite, its own tests, TDD, scope, harness.
  log('full suite on the reference');
  const baseline = JSON.parse(readFileSync(join(project.dir, 'baseline-tests.json'), 'utf8'));
  const full = await runFullSuite({ adapter, repo, commit: referenceHead, workRoot: join(workRoot, 'full'), ctx, label: 'reference-full', overrides: trusted(referenceHead) });
  rmSync(full.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  // Upstream tests the frozen test code fails against the reference: the requirement supersedes them,
  // but only where the reference itself had to change the test.
  const passing = new Set(full.results.filter((r) => r.status === 'passed').map((r) => r.id));
  const superseded = baseline.tests.filter((t) => t.status === 'passed' && !passing.has(t.id)).map((t) => t.id).sort();
  const changedTestFiles = new Set(deliveredChanges({ repo, start, head: referenceHead }).filter((c) => c.status === 'M' && adapter.isTestPath(c.path)).map((c) => c.path));
  const unexplained = superseded.filter((id) => !changedTestFiles.has(full.results.find((r) => r.id === id)?.file ?? baselineFile(id)));
  const cmp = compareToBaseline(baseline, full.results, { superseded });
  const own = deliveredTests({ repo, start, head: referenceHead, adapter });
  let ownSummary = [];
  {
    const dir = mkdtempSync(join(workRoot, 'reference-own-'));
    try {
      exportTree(repo, referenceHead, join(dir, 'tree'));
      const out = await adapter.runTests({ tree: join(dir, 'tree'), tests: own, ctx: { ...ctx, workRoot: dir }, label: 'reference-own' });
      ownSummary = summarizeExpected(out.results, own, adapter);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
  const ownFailing = ownSummary.filter((t) => t.status !== 'passed');
  const addedByModule = Object.fromEntries(testedModules(project.adapter, prd.manifest.modules.required).map((m) => [m, ownSummary.filter((t) => t.status === 'passed' && adapter.moduleOf(t.file) === m).length]));
  check(
    'reference-full-suite',
    ['ok', 'tests-failed'].includes(full.run.category) &&
      cmp.missing.length === 0 &&
      cmp.regressed.length === 0 &&
      cmp.failing_new.length === 0 &&
      unexplained.length === 0 &&
      ownFailing.length === 0 &&
      Object.values(addedByModule).every((n) => n > 0),
    `${full.results.length} test(s) on the trusted tree, run ${full.run.category}; missing ${cmp.missing.length}, regressed ${cmp.regressed.length}, failing ${cmp.failing_new.length}; superseded ${superseded.length}${unexplained.length ? ` (not changed by the reference: ${unexplained.slice(0, 5).join(', ')})` : ''}; own tests failing ${ownFailing.length}; own tests by module ${JSON.stringify(addedByModule)}`,
  );
  log('TDD replay of the reference');
  const units = [];
  for (const [i, unit] of segmentUnits(repo, start, referenceHead, adapter).entries()) {
    const record = await replayUnit({ repo, unit, adapter, ctx: { ...ctx, workRoot: join(workRoot, `tdd-${i + 1}`) } });
    rmSync(join(workRoot, `tdd-${i + 1}`), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    units.push({ verdict: record.verdict, detail: record.detail ?? null, commits: unit.commits.length, expected_tests: record.expected_tests.length, red_tree: record.red_tree ?? null, green_tree: record.green_tree ?? null });
  }
  const counted = units.filter((u) => u.verdict !== 'no-production-change');
  check('reference-tdd', counted.length > 0 && counted.every((u) => u.verdict === 'valid'), units.map((u) => `${u.verdict}${u.detail ? ` (${u.detail.slice(0, 160)})` : ''}`).join('; '));
  const scope = inspectScope({ repo, start, head: referenceHead, adapter: project.adapter, prd: prd.manifest });
  const scopeFailed = scope.checks.filter((c) => !c.ok && c.severity !== 'warning');
  check('reference-scope', scopeFailed.length === 0, scopeFailed.length ? scopeFailed.map((c) => `${c.id}: ${c.detail}`).join('; ') : `changes ${Object.keys(scope.facts.by_module).join(', ')}`);
  const harness = inspectHarness({ repo, start, head: referenceHead, adapter: project.adapter });
  const harnessFailed = harness.checks.filter((c) => !c.ok);
  check('reference-harness', harnessFailed.length === 0, harnessFailed.length ? harnessFailed.map((c) => `${c.id}: ${c.detail}`).join('; ') : 'the reference passes every harness check');

  // ---- mutants.
  const mutants = {};
  for (const [id, patch] of evaluator.mutants) {
    const gating = !id.startsWith('stress-');
    const runs = [];
    log(`mutant ${id}`);
    for (let i = 0; i < (gating ? repeat : stressRepeat); i++) {
      try {
        runs.push(await runHidden(referenceHead, { patch, label: `mutant-${id}-${i + 1}` }));
      } catch (error) {
        runs.push({ error: error.message });
      }
    }
    const kills = runs.map((r) => !r.error && missingBehaviour(r));
    const killedBy = [...new Set(runs.flatMap((r) => (r.tests ?? []).filter((t) => t.status === 'failed' && RED_VALID_CATEGORIES.has(t.category)).map((t) => t.name)))].sort();
    const broken = runs.filter((r) => r.error || ['compile', 'build', 'dependency', 'crash', 'timeout'].includes(r.run?.category));
    mutants[id] = { gating, runs: runs.length, killed: kills.every(Boolean), kill_rate: kills.filter(Boolean).length / runs.length, killed_by: killedBy };
    if (gating) {
      check(
        `mutant:${id}`,
        broken.length === 0 && kills.every(Boolean),
        broken.length ? `does not build or run: ${broken.map((r) => r.error ?? r.run.category).join(', ')}` : kills.every(Boolean) ? `killed in ${runs.length}/${runs.length} run(s) by ${killedBy.join(', ')}` : `survived ${kills.filter((k) => !k).length}/${runs.length} run(s)`,
      );
    }
  }

  // ---- every required module with runtime behaviour has a gating mutant: some hidden test needs its behaviour.
  const byModule = Object.fromEntries(testedModules(project.adapter, prd.manifest.modules.required).map((m) => [m, 0]));
  for (const [id, patch] of evaluator.mutants) {
    if (id.startsWith('stress-')) continue;
    for (const m of new Set(patchPaths(patch).map((p) => adapter.moduleOf(p)))) if (m in byModule) byModule[m] += 1;
  }
  const uncovered = Object.keys(byModule).filter((m) => byModule[m] === 0);
  check(
    'mutant-coverage',
    uncovered.length === 0,
    uncovered.length ? `no gating mutant breaks ${uncovered.join(', ')}: nothing proves the hidden tests need its behaviour` : `gating mutants per required module: ${Object.entries(byModule).map(([m, n]) => `${m} ${n}`).join(', ')}`,
  );

  // ---- determinism: every repeated run agrees test by test, on every file system.
  const agree = (runs) => runs.every((r) => canonicalJson(view(r.tests)) === canonicalJson(view(runs[0].tests)));
  check('deterministic', agree(baselineRuns) && agree(referenceRuns), `${baselineRuns.length} baseline run(s) and ${referenceRuns.length} reference run(s) (${tmpRoots.length} on other temp roots) agree test by test`);

  const commands = { full_suite_sha256: commandSha(full.command), hidden_sha256: commandSha(red.command) };
  const bindings = {
    cache_lock_sha256: project.adapter.toolchain.cache.kind === 'none' ? null : cacheLockDigest(cacheRoot),
    toolchains: toolchainDigests({ adapter: project.adapter, toolchains: ctx.toolchains }),
    commands,
  };
  const expected = {
    schema: 'mycelink-bench/expected@2',
    project: project.id,
    prd: prdId,
    hidden_tests: hiddenTests,
    baseline_red: view(red.tests),
    superseded_tests: superseded,
    reference: {
      head: referenceHead,
      hidden: 'all-passed',
      full_suite: { tests: full.results.length, category: full.run.category, new_tests_by_module: addedByModule },
      own_tests: own.length,
      tdd: units,
    },
    mutants,
    runs: repeat,
    tmp_roots: tmpRoots.length,
    commands,
  };
  const ok = checks.every((c) => c.ok);
  if (ok) {
    writeFileSync(join(evaluatorDir(cacheRoot, project.id, prdId), 'expected.json'), JSON.stringify(expected, null, 2) + '\n');
    const lock = writeEvaluatorLock({ project, prdId, dir: evaluatorDir(cacheRoot, project.id, prdId), reference: evaluator.lock.reference, hiddenTests: hiddenTests.length, mutants: evaluator.mutants.size });
    const summary = {
      schema: 'mycelink-bench/qualification@2',
      project: project.id,
      prd: prdId,
      source_identity_sha256: project.lock.identity_sha256,
      evaluator_digest_sha256: lock.digest_sha256,
      bindings,
      hidden_tests: { total: hiddenTests.length, failing_at_baseline: failing.length, passing_at_baseline: red.tests.filter((t) => t.status === 'passed').length },
      baseline_failure_categories: Object.fromEntries([...new Set(failing.map((t) => t.category))].sort().map((c) => [c, failing.filter((t) => t.category === c).length])),
      superseded_tests: superseded.length,
      reference: { full_suite_tests: full.results.length, own_tests: own.length, tdd_units: units.map((u) => u.verdict), new_tests_by_module: addedByModule },
      mutants: {
        gating: Object.values(mutants).filter((m) => m.gating).length,
        killed: Object.values(mutants).filter((m) => m.gating && m.killed).length,
        stress: Object.values(mutants).filter((m) => !m.gating).map((m) => ({ runs: m.runs, kill_rate: m.kill_rate })),
        by_module: byModule,
      },
      runs: repeat,
      tmp_roots: tmpRoots.length,
      filesystems: { distinct: new Set(filesystems.map((f) => f.device)).size, roots: filesystems.map((f) => ({ role: f.role, type: f.type })) },
      duration_ms: Object.values(durations).reduce((a, b) => a + b, 0),
    };
    writeFileSync(join(prd.dir, 'qualification.json'), JSON.stringify(summary, null, 2) + '\n');
  }
  return { ok, checks, expected, bindings, filesystems, durations, isolation: isolationRecord(isolation) };
}

/** The file of a baseline test id (`<file>::<suite> > <name>` or Surefire's `<module>/<class>#<method>`). */
function baselineFile(id) {
  if (id.includes('::')) return id.split('::')[0];
  const m = /^(.+?)\/([\w.$]+)#/.exec(id);
  return m ? `${m[1]}/src/test/java/${m[2].split('$')[0].replaceAll('.', '/')}.java` : id;
}
