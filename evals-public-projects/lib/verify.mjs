/**
 * The authoritative post-run verifier of the public-project benchmark.
 *
 * Nothing in the workspace is trusted. The frozen source, the evaluator's
 * hidden tests and the qualified baseline come from the cache and the suite,
 * each verified against its committed lock before anything runs; the
 * delivered code runs only in fresh exports with private toolchain copies.
 *
 * Sections (each `{ ok, checks }`; a check with severity 'warning' never fails):
 *   identity       source bundle, evaluator lock, baseline record, the
 *                  mandatory qualification (bound to this evaluator store,
 *                  source, cache lock and toolchains), the cache content,
 *                  requirement
 *   hygiene        the delivered repository (see hygiene.mjs)
 *   scope          changed modules (see scope.mjs)
 *   leakage        evaluator content under the workspace and `scanRoots` (the
 *                  session HOME); reference content an independent delivery
 *                  converged on is a warning unless `access` (the run's
 *                  transcript hits) corroborates it (see leakage.mjs)
 *   harness        frozen configuration, harness hooks, production code that
 *                  references a test framework, manifests (see harness.mjs)
 *   regression     the full suite on the trusted tree (frozen upstream tests
 *                  and configuration, delivered production code) vs the
 *                  baseline, but for the upstream tests the requirement
 *                  supersedes (qualification); and the delivery's own tests,
 *                  run separately, passing in every required module that can
 *                  have them (not declarations only)
 *   acceptance     hidden tests overlaid on the trusted tree, every one passing
 *   tdd            replay of every delivered unit (see tdd.mjs), seeing through
 *                  exactly the bound injections, which must still be in the
 *                  delivered history
 *   orchestration  Mycelink evidence (see orchestration.mjs)
 *   faults         the fault records of a fault-injected run (see faults.mjs)
 *   integrity      after every run of delivered code: the evaluator store,
 *                  the toolchains and the cache are still what they were
 *
 * The trusted commands (full suite, hidden tests) must be the qualified ones.
 * ok = every CORE_SECTIONS section ok, and tdd when requireTdd,
 *      orchestration when requireMycelink, and the faults section whenever
 *      fault records are given.
 * Fails closed: an error, a missing artifact or an unknown state is a failure.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdapter } from './adapters/index.mjs';
import { boundInjections, injectedEffects, injectionHistory, inspectFaults } from './faults.mjs';
import { compareToBaseline, runFullSuite } from './baseline.mjs';
import { loadEvaluator, verifyEvaluator } from './evaluator.mjs';
import { canonicalJson, sha256Hex } from './hash.mjs';
import { catFileBatch, exportTree, revParse } from './git.mjs';
import { deliveredChanges, inspectHarness, trustedOverrides } from './harness.mjs';
import { inspectRepository, makeSection } from './hygiene.mjs';
import { inspectLeakage } from './leakage.mjs';
import { findPrd, loadSuite, suiteRoot as defaultSuiteRoot } from './manifests.mjs';
import { inspectOrchestration } from './orchestration.mjs';
import { acceptanceSidecar, moduleDescriptorsFor, worktreeSetupFor } from './workspace.mjs';
import { inspectScope, testedModules } from './scope.mjs';
import { loadSchema, validate } from './schema.mjs';
import { verifySourceBundle } from './source.mjs';
import { replayUnit, segmentUnits, summarizeExpected } from './tdd.mjs';
import { checkoutPluginArtifact } from './plugin.mjs';
import { isolationRecord } from './sandbox.mjs';
import { pinRecord } from './suite-pin.mjs';
import { cacheLockDigest, loadToolchains, toolchainDigests, verifyCacheLock } from './toolchain.mjs';

export const VERIFIER_VERSION = '2.0.0';

/** Sections every verified delivery must pass (TDD, orchestration and faults gate it when required or present). */
export const CORE_SECTIONS = ['identity', 'hygiene', 'scope', 'leakage', 'harness', 'regression', 'acceptance', 'integrity'];

const finish = ({ checks }) => ({ ok: checks.length > 0 && checks.every((c) => c.ok || c.severity === 'warning'), checks });

function commandEvidence(out) {
  return {
    argv_sha256: sha256Hex(canonicalJson(out.command.argv)),
    env_sha256: sha256Hex(canonicalJson(out.command.env)),
    setup_sha256: out.command.setup ? sha256Hex(canonicalJson(out.command.setup)) : null,
    exit_code: out.run.exit_code,
    category: out.run.category,
    timed_out: out.run.timed_out,
    duration_ms: out.run.duration_ms,
    stdout_sha256: out.run.stdout_sha256,
    stderr_sha256: out.run.stderr_sha256,
  };
}

/** The tests the evaluator's hidden files declare. */
export function hiddenTestsOf(evaluator, adapter) {
  return adapter.testsInDelta([...evaluator.hidden].map(([path, body]) => ({ path, before: null, after: body.toString('utf8') })));
}

/**
 * The hidden tests overlaid on `head` — on its trusted tree when
 * `overrides` come from harness.trustedOverrides — and run in a fresh
 * export under `workRoot` (removed again): `{ hiddenTests, out, summary }`,
 * one summary per hidden test.
 */
export async function runHiddenTests({ repo, head, evaluator, adapter, ctx, workRoot, overrides = new Map() }) {
  const hiddenTests = hiddenTestsOf(evaluator, adapter);
  mkdirSync(workRoot, { recursive: true });
  const dir = mkdtempSync(join(workRoot, 'run-'));
  const tree = join(dir, 'tree');
  try {
    exportTree(repo, head, tree, { overrides, extra: [...evaluator.hidden].map(([path, content]) => ({ path, content })) });
    const out = await adapter.runTests({ tree, tests: hiddenTests, ctx: { ...ctx, workRoot: dir }, label: 'acceptance' });
    return { hiddenTests, out, summary: summarizeExpected(out.results, hiddenTests, adapter) };
  } finally {
    rmSync(tree, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(join(dir, 'acceptance.scratch'), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/**
 * The committed qualification of a PRD and why it does not qualify this
 * verification (empty: it does): it must exist and be valid, be made for
 * this source identity and evaluator store (whose expected.json agrees),
 * have killed every gating mutant — at least one in every required module
 * with runtime behaviour — have used every file system it claims,
 * and rest on the cache lock and toolchains this verification uses.
 */
export function qualificationProblems({ prd, project, evaluator, cacheRoot, toolchains }) {
  const file = join(prd.dir, 'qualification.json');
  if (!existsSync(file)) return { qualification: null, problems: [`${file} is missing: the PRD was never qualified (tools/qualify.mjs)`] };
  let q;
  try {
    q = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return { qualification: null, problems: [`${file}: ${error.message}`] };
  }
  const problems = validate(loadSchema('qualification'), q);
  if (problems.length) return { qualification: null, problems };
  if (q.project !== project.id || q.prd !== prd.manifest.id) problems.push(`made for ${q.project}/${q.prd}`);
  if (q.source_identity_sha256 !== project.lock.identity_sha256) problems.push('made for another source identity');
  if (q.evaluator_digest_sha256 !== evaluator.lock.digest_sha256) problems.push('made for another evaluator store');
  if (q.mutants.killed !== q.mutants.gating) problems.push(`${q.mutants.killed}/${q.mutants.gating} gating mutants killed`);
  const uncovered = testedModules(project.adapter, prd.manifest.modules.required).filter((m) => !(q.mutants.by_module[m] > 0));
  if (uncovered.length) problems.push(`no gating mutant breaks ${uncovered.join(', ')}`);
  if (q.tmp_roots > 0 && q.filesystems.distinct < q.tmp_roots + 1) problems.push(`claims ${q.tmp_roots} other file system(s) but used ${q.filesystems.distinct} in all`);
  if (evaluator.expected?.schema !== 'mycelink-bench/expected@2') problems.push('the evaluator store holds no qualification record (expected.json @2)');
  else if (evaluator.expected.superseded_tests.length !== q.superseded_tests) problems.push('the evaluator store supersedes other upstream tests than the qualification counts');
  const cache = project.adapter.toolchain.cache.kind === 'none' ? null : cacheLockDigest(cacheRoot);
  if (q.bindings.cache_lock_sha256 !== cache) problems.push(`made with another cache (lock ${String(q.bindings.cache_lock_sha256).slice(0, 12)}, now ${String(cache).slice(0, 12)})`);
  if (canonicalJson(q.bindings.toolchains) !== canonicalJson(toolchains)) problems.push('made with other toolchains');
  return { qualification: q, problems };
}

/** The tests the delivery itself declares (added, or changed in upstream test files), read from the files. */
export function deliveredTests({ repo, start, head, adapter, excludeCommits = new Set() }) {
  const changed = deliveredChanges({ repo, start, head, excludeCommits }).filter((c) => c.status !== 'D' && adapter.isTestPath(c.path));
  const blob = (rev, path) => revParse(repo, `${rev}:${path}`);
  const pairs = changed.map((c) => ({ path: c.path, before: c.status === 'A' ? null : blob(start, c.path), after: blob(head, c.path) }));
  const contents = catFileBatch(repo, pairs.flatMap((p) => [p.before, p.after]).filter(Boolean));
  const text = (sha) => (sha ? contents.get(sha).toString('utf8') : null);
  return adapter.testsInDelta(pairs.map((p) => ({ path: p.path, before: text(p.before), after: text(p.after) })));
}

export async function verifyDelivery({
  suiteRoot = defaultSuiteRoot(),
  caseKey,
  workspace,
  cacheRoot,
  workRoot,
  requireMycelink = false,
  requireTdd = false,
  tdd = true,
  mycelink = null,
  isolation = null,
  suitePin = null,
  toolchains = null,
  timeoutMs = undefined,
  faults = [],
  scanRoots = [],
  access = [],
}) {
  const result = {
    schema: 'mycelink-bench/verification@1',
    verifier_version: VERIFIER_VERSION,
    generated_at: new Date().toISOString(),
    case: caseKey,
    project: null,
    prd: null,
    workspace,
    ok: false,
    trusted: false,
    trust: null,
    suite: pinRecord(suitePin),
    isolation: isolationRecord(isolation),
    sections: { identity: null, hygiene: null, scope: null, leakage: null, harness: null, regression: null, acceptance: null, tdd: null, orchestration: null, faults: null, integrity: null },
    evidence: {},
    errors: [],
  };
  const scratch = workRoot ?? mkdtempSync(join(tmpdir(), 'bench-verify-'));
  try {
    // Delivered code runs only inside the isolation boundary (or, in the harness's own tests, its explicit stand-in).
    if (!isolation || !['bubblewrap', 'none'].includes(isolation.kind)) throw new Error('no isolation given: delivered code runs only inside the boundary (lib/sandbox.mjs requireSandbox)');
    if (!workspace || !existsSync(workspace) || !statSync(workspace).isDirectory()) throw new Error(`workspace ${workspace} does not exist`);
    const suite = loadSuite(suiteRoot);
    const found = findPrd(suite, caseKey);
    if (!found) throw new Error(`unknown case ${caseKey}`);
    const { project, prd } = found;
    if (project.problems.length) throw new Error(`the manifests of ${project.id} are invalid: ${project.problems.join('; ')}`);
    result.project = project.id;
    result.prd = prd.manifest.id;
    result.case = prd.manifest.case;
    const adapter = createAdapter(project.adapter);
    const repo = join(workspace, ...project.adapter.workspace.repo_dir.split('/'));
    const start = project.lock.commit;

    // ---- identity: everything the verdict rests on, verified before anything runs.
    const identity = makeSection();
    const bundle = await verifySourceBundle({ lock: project.lock, bundlePath: join(cacheRoot, 'sources', project.lock.bundle.file) });
    identity.check('source-bundle', bundle.ok, bundle.ok ? `frozen source ${start.slice(0, 12)} verified offline` : `failed: ${bundle.checks.filter((c) => !c.ok).map((c) => c.id).join(', ')}`);
    let evaluator = null;
    try {
      evaluator = loadEvaluator({ cacheRoot, project, prdId: prd.manifest.id });
      identity.check('evaluator-lock', true, `hidden tests, reference and mutants match evaluator.lock.json (${evaluator.lock.digest_sha256.slice(0, 12)})`);
    } catch (error) {
      identity.check('evaluator-lock', false, error.message);
    }
    let baseline = null;
    const baselinePath = join(project.dir, 'baseline-tests.json');
    try {
      baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
      const problems = validate(loadSchema('baseline-tests'), baseline);
      if (baseline.source_identity_sha256 !== project.lock.identity_sha256) problems.push('made for another source identity');
      identity.check('baseline-record', problems.length === 0, problems.length ? problems.join('; ') : `${baseline.counts.passed} qualified baseline test(s)`);
    } catch (error) {
      identity.check('baseline-record', false, `${baselinePath}: ${error.message}`);
    }
    // Mandatory qualification, bound to this evaluator store, source, cache and toolchains.
    const toolchainSet = project.adapter.toolchain.cache.kind === 'none' ? null : toolchains ?? loadToolchains(cacheRoot);
    const toolchainsBefore = toolchainDigests({ adapter: project.adapter, toolchains: toolchainSet });
    let qualification = null;
    if (evaluator) {
      const q = qualificationProblems({ prd, project, evaluator, cacheRoot, toolchains: toolchainsBefore });
      qualification = q.qualification;
      identity.check('qualification', q.problems.length === 0, q.problems.length ? q.problems.join('; ') : `qualified: ${qualification.hidden_tests.total} hidden test(s), ${qualification.mutants.killed}/${qualification.mutants.gating} gating mutants killed, toolchains and cache as qualified`);
    }
    if (project.adapter.toolchain.cache.kind !== 'none') {
      const cache = verifyCacheLock(cacheRoot);
      identity.check('cache-lock', cache.ok, cache.ok ? 'every offline cache matches cache.lock.json' : cache.problems.slice(0, 5).join('; '));
    }
    const requirementCopy = join(workspace, 'platform', 'requirements', `${prd.manifest.id}.md`);
    const sameRequirement = existsSync(requirementCopy) && readFileSync(requirementCopy).equals(readFileSync(prd.requirementPath));
    identity.check('requirement-unchanged', sameRequirement, sameRequirement ? 'the workspace requirement is the committed one' : 'the workspace requirement was changed or removed (the verdict uses the committed one)', { severity: 'warning' });
    // Its structured acceptance criteria (workspace.mjs acceptanceSidecar): immutable beside it, byte for byte.
    const sidecarCopy = join(workspace, 'platform', 'requirements', `${prd.manifest.id}.acceptance.json`);
    const sameSidecar = existsSync(sidecarCopy) && readFileSync(sidecarCopy, 'utf8') === `${JSON.stringify(acceptanceSidecar(prd), null, 2)}\n`;
    identity.check('acceptance-sidecar-unchanged', sameSidecar, sameSidecar ? "the workspace acceptance criteria are the requirement's, structured" : 'the workspace acceptance sidecar was changed or is missing (the verdict uses the requirement)', { severity: 'warning' });
    result.sections.identity = finish(identity);
    if (!result.sections.identity.ok) return result;

    // ---- the delivered repository.
    const hygiene = inspectRepository({ repo, lock: project.lock, adapter: project.adapter });
    result.sections.hygiene = finish(hygiene);
    const head = hygiene.facts.head;
    if (!head || !hygiene.checks.find((c) => c.id === 'start-present')?.ok) return result;
    result.evidence.start = start;
    result.evidence.head = head;
    result.evidence.start_tree = revParse(repo, `${start}^{tree}`);
    result.evidence.delivered_tree = revParse(repo, `${head}^{tree}`);
    // Only commits a fault record binds exactly are the evaluator's; any other commit is the delivery's.
    const bound = boundInjections({ repo, records: faults });
    const injected = bound.commits;
    // Scope leaves out only what such an injection changed, while the delivered tree still holds it exactly.
    result.sections.scope = finish(inspectScope({ repo, start, head, adapter: project.adapter, prd: prd.manifest, injected: injectedEffects({ repo, head, records: faults }) }));
    result.sections.leakage = finish(inspectLeakage({ repo, start, head, workspace, fingerprints: evaluator.fingerprints, roots: [workspace, ...scanRoots], access }));
    result.sections.harness = finish(inspectHarness({ repo, start, head, adapter: project.adapter, excludeCommits: injected }));
    // Regression and acceptance run the frozen upstream tests and configuration with the delivered production code only.
    const trusted = trustedOverrides({ repo, start, head, adapter: project.adapter });
    result.evidence.trusted_tree = trusted.summary;
    const superseded = evaluator.expected?.superseded_tests ?? [];

    const ctx = { cacheRoot, timeoutMs, toolchains: toolchainSet, isolation };

    // ---- regression: on the trusted tree the qualified baseline still passes (but for the upstream tests
    // the requirement itself supersedes); the delivery's own tests pass where the work is.
    const regression = makeSection();
    const full = await runFullSuite({ adapter, repo, commit: head, workRoot: join(scratch, 'regression'), ctx, label: 'regression', overrides: trusted.overrides });
    rmSync(join(full.dir, 'regression.scratch'), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    result.evidence.regression = { command: commandEvidence(full), tests: full.results.length, superseded: superseded.length };
    regression.check('regression-run', ['ok', 'tests-failed'].includes(full.run.category), `trusted full suite ${full.run.category} (exit ${full.run.exit_code}), ${full.results.length} test(s)`);
    // The baseline is comparable only when it was recorded with exactly this command.
    const command = sha256Hex(canonicalJson(full.command));
    regression.check('baseline-command', command === baseline.command_sha256, command === baseline.command_sha256 ? `the baseline was recorded with this command (${command.slice(0, 12)})` : `the baseline was recorded with command ${String(baseline.command_sha256).slice(0, 12)}, this run is ${command.slice(0, 12)}`);
    const qualifiedFull = qualification.bindings.commands.full_suite_sha256;
    regression.check('qualified-command', command === qualifiedFull, command === qualifiedFull ? 'the full suite ran the qualified command' : `the qualified full-suite command is ${qualifiedFull.slice(0, 12)}, this run is ${command.slice(0, 12)}`);
    const cmp = compareToBaseline(baseline, full.results, { superseded });
    regression.check('baseline-tests-pass', cmp.missing.length === 0 && cmp.regressed.length === 0, cmp.missing.length || cmp.regressed.length ? `missing: ${cmp.missing.slice(0, 10).join(', ') || 'none'}; regressed: ${cmp.regressed.slice(0, 10).join(', ') || 'none'}` : `all ${baseline.counts.passed - superseded.length} required baseline test(s) pass${superseded.length ? ` (${superseded.length} superseded by the requirement)` : ''}`);
    const trustedFailures = full.results.filter((r) => r.status === 'failed' && !superseded.includes(r.id));
    regression.check('no-failing-tests', cmp.failing_new.length === 0 && (full.run.category === 'ok' || (full.run.category === 'tests-failed' && trustedFailures.length === 0)), cmp.failing_new.length ? `failing: ${cmp.failing_new.slice(0, 10).join(', ')}` : `trusted suite ${full.run.category}`);
    // The delivery's own tests count, separately, on the delivered tree as it is: they never control the verdict above.
    const own = deliveredTests({ repo, start, head, adapter, excludeCommits: injected });
    let ownResults = [];
    if (own.length > 0) {
      const dir = mkdtempSync(join(scratch, 'agent-tests-'));
      const tree = join(dir, 'tree');
      try {
        exportTree(repo, head, tree);
        const out = await adapter.runTests({ tree, tests: own, ctx: { ...ctx, workRoot: dir }, label: 'agent-tests' });
        ownResults = summarizeExpected(out.results, own, adapter);
        result.evidence.agent_tests = { command: commandEvidence(out), tests: own.length };
      } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }
    const ownFailing = ownResults.filter((t) => t.status !== 'passed');
    regression.check('agent-tests-pass', ownFailing.length === 0, ownFailing.length ? `the delivery's own tests fail: ${ownFailing.slice(0, 10).map((t) => `${t.name} (${t.status})`).join(', ')}` : `${ownResults.length} test(s) the delivery declares pass`);
    const tested = new Set(testedModules(project.adapter, prd.manifest.modules.required));
    for (const m of prd.manifest.modules.required) {
      if (!tested.has(m)) {
        regression.check(`tests-added:${m}`, true, `not required: ${m} is declarations only (no runtime behaviour to test)`);
        continue;
      }
      const added = ownResults.filter((t) => t.status === 'passed' && adapter.moduleOf(t.file) === m);
      regression.check(`tests-added:${m}`, added.length > 0, `${added.length} new or changed passing test(s) in ${m}`);
    }
    result.sections.regression = finish(regression);

    // ---- acceptance: the hidden tests, overlaid on the delivered HEAD.
    const acceptance = makeSection();
    const hiddenTests = hiddenTestsOf(evaluator, adapter);
    if (evaluator.expected?.hidden_tests && canonicalJson(evaluator.expected.hidden_tests) !== canonicalJson(hiddenTests)) {
      acceptance.check('hidden-tests-qualified', false, 'the hidden files declare other tests than the qualification recorded');
    }
    let accOut = null;
    try {
      accOut = (await runHiddenTests({ repo, head, evaluator, adapter, ctx, workRoot: join(scratch, 'acceptance'), overrides: trusted.overrides })).out;
    } catch (error) {
      acceptance.check('acceptance-overlay', false, error.message);
    }
    if (accOut) {
      result.evidence.acceptance = { command: commandEvidence(accOut), hidden_tests: hiddenTests.length };
      acceptance.check('acceptance-run', !accOut.run.timed_out && ['ok', 'tests-failed'].includes(accOut.run.category), `hidden suite ${accOut.run.category} (exit ${accOut.run.exit_code})`);
      const hiddenCommand = sha256Hex(canonicalJson(accOut.command));
      const qualifiedHidden = qualification.bindings.commands.hidden_sha256;
      acceptance.check('qualified-command', hiddenCommand === qualifiedHidden, hiddenCommand === qualifiedHidden ? 'the hidden tests ran the qualified command' : `the qualified hidden-test command is ${qualifiedHidden.slice(0, 12)}, this run is ${hiddenCommand.slice(0, 12)}`);
      for (const t of summarizeExpected(accOut.results, hiddenTests, adapter)) {
        acceptance.check(`hidden:${t.name}`, t.status === 'passed', t.status === 'passed' ? 'passed' : `${t.status} (${t.category})`, { file: t.file });
      }
    }
    result.sections.acceptance = finish(acceptance);

    // ---- TDD replay of every delivered unit.
    if (tdd && hygiene.checks.find((c) => c.id === 'history-preserved')?.ok) {
      const units = [];
      const compatibility = (prd.manifest.acceptance_criteria ?? []).filter((c) => c.kind === 'compatibility').map((c) => c.id);
      // A re-proof unit names criteria of the case (CSET-201 final): tests alone of behaviour an earlier RED drove.
      const criteria = (prd.manifest.acceptance_criteria ?? []).map((c) => c.id);
      for (const [i, unit] of segmentUnits(repo, start, head, adapter, { exclude: injected, boundaries: bound.boundaries }).entries()) {
        // A test-only unit after the code proves a compatibility criterion of the case (trusted: the PRD manifest's kinds), never a RED.
        const record = await replayUnit({ repo, unit, adapter, ctx: { ...ctx, workRoot: join(scratch, 'tdd', `unit-${i + 1}`) }, compatibility, criteria, finalHead: head });
        rmSync(join(scratch, 'tdd', `unit-${i + 1}`, 'red.scratch'), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        rmSync(join(scratch, 'tdd', `unit-${i + 1}`, 'green.scratch'), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        units.push({
          base: record.base,
          commits: record.commits,
          red_commit: record.red_commit,
          verdict: record.verdict,
          ok: record.ok,
          ...(record.criteria ? { criteria: record.criteria } : {}),
          ...(record.compatibility ? { compatibility: { base: record.compatibility.base?.expected ?? null, final: record.compatibility.final?.expected ?? null } } : {}),
          detail: record.detail ?? null,
          expected_tests: record.expected_tests,
          trees: { start: record.start_tree ?? null, red: record.red_tree ?? null, green: record.green_tree ?? null },
          red: record.red ? { exit_code: record.red.run.exit_code, expected: record.red.expected } : null,
          green: record.green ? { exit_code: record.green.run.exit_code, expected: record.green.expected } : null,
          tests_changed_after_red: record.tests_changed_after_red,
          test_maintenance_after_red: record.test_maintenance_after_red,
          hashes: record.hashes,
        });
      }
      const counted = units.filter((u) => u.verdict !== 'no-production-change');
      // The replay sees through an injection only while it is exactly the bound commit, still in the history.
      const injections = injectionHistory({ repo, head, records: faults });
      // A declarations-only or compatibility-regression unit is fine, but no delivery is test-first by those alone.
      const runtime = counted.filter((u) => u.verdict !== 'declarations-only' && u.verdict !== 'compatibility-regression' && u.verdict !== 'reproof');
      result.sections.tdd = { ok: runtime.length > 0 && counted.every((u) => u.ok) && injections.every((x) => x.ok), required: requireTdd, units, injections };
    } else {
      result.sections.tdd = { ok: tdd ? false : null, required: requireTdd, units: [], detail: tdd ? 'history not preserved: nothing to replay' : 'not run' };
    }

    // ---- Mycelink orchestration evidence.
    // The pinned, packaged Mycelink (by default this checkout's plugin, packaged and sealed once per process).
    const artifact = mycelink ?? checkoutPluginArtifact();
    const orch = inspectOrchestration({ workspace, repo, deliveredHead: head, mycelink: artifact, isolation, expectedSetup: worktreeSetupFor(project.adapter), expectedModules: moduleDescriptorsFor(project.adapter) });
    result.sections.orchestration = { required: requireMycelink, present: orch.present, ok: orch.present && finish(orch).ok, checks: orch.checks };
    result.evidence.mycelink = orch.facts;
    result.evidence.mycelink_artifact = orch.facts.mycelink_artifact ?? { version: artifact.version, zip_sha256: artifact.zip_sha256, tree_sha256: artifact.tree_sha256, before: null, after: null };

    if (faults.length > 0) result.sections.faults = finish(inspectFaults({ repo, head, records: faults }));
    // Trusted only when every run of delivered code was confined, the suite was pinned to a clean commit,
    // and the qualification exercised another file system.
    result.trust = {
      isolation: result.isolation.enforced === true,
      suite_pinned: result.suite?.clean === true,
      qualification_filesystems: qualification.tmp_roots >= 1 && qualification.filesystems.distinct >= qualification.tmp_roots + 1,
    };
    result.trusted = Object.values(result.trust).every(Boolean);

    // ---- integrity: every trusted input is still what it was before the delivered code ran.
    const integrity = makeSection();
    const store = verifyEvaluator({ dir: evaluator.dir, lock: evaluator.lock });
    integrity.check('evaluator-after', store.ok, store.ok ? 'the evaluator store still matches its lock' : `the evaluator store changed during the verification: ${store.problems.slice(0, 5).join('; ')}`);
    const toolchainsAfter = toolchainDigests({ adapter: project.adapter, toolchains: toolchainSet });
    integrity.check('toolchains-after', canonicalJson(toolchainsAfter) === canonicalJson(toolchainsBefore), canonicalJson(toolchainsAfter) === canonicalJson(toolchainsBefore) ? 'the toolchains are unchanged' : 'a toolchain changed during the verification');
    if (project.adapter.toolchain.cache.kind === 'none') integrity.check('cache-after', true, 'no offline cache');
    else {
      const cache = verifyCacheLock(cacheRoot);
      integrity.check('cache-after', cache.ok && cacheLockDigest(cacheRoot) === qualification.bindings.cache_lock_sha256, cache.ok ? 'every offline cache still matches cache.lock.json' : cache.problems.slice(0, 5).join('; '));
    }
    result.sections.integrity = finish(integrity);
    result.evidence.faults = faults;

    const core = CORE_SECTIONS.every((k) => result.sections[k]?.ok === true);
    result.ok =
      core && (!requireTdd || result.sections.tdd.ok === true) && (!requireMycelink || result.sections.orchestration.ok === true) && (faults.length === 0 || result.sections.faults.ok === true);
  } catch (error) {
    result.errors.push(String(error?.stack ?? error));
    result.ok = false;
  } finally {
    if (!workRoot) rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  return result;
}
