/**
 * Deterministic TDD replay.
 *
 * Delivered history is split into units: linear runs of commits on top of
 * an immutable base (merges start new units; each merged-in branch is
 * segmented from its merge base). A unit that changes production code is
 * credited as test-first only when
 *
 *  1. its leading commits change test files alone (the test-first delta);
 *  2. the tests that delta adds or changes are known from the files
 *     themselves (never from running them);
 *  3. that exact delta, applied independently to the base, makes the
 *     trusted command fail with those tests failing for a missing behaviour
 *     (assertion, or an exception from the code under test) — not a syntax,
 *     import, missing-symbol, setup, timeout or crash failure, and none of
 *     them merely not running;
 *  4. every module that can have runtime tests and changes production code
 *     in the unit has a RED test of its own failing for a missing behaviour;
 *  5. no test is declared (added or changed) after the RED — not with the
 *     production code, nor in a later test-only unit (test-after); changes
 *     to test support code that declare no test are recorded as maintenance;
 *  6. the RED commit's whole test side, forced onto the unit's final tree,
 *     passes with the same command.
 *
 * The record names the start, RED and GREEN trees (git tree ids computed in
 * memory) and hashes the command, environment, outputs and test blobs.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, gitTreeSha, sha256Hex } from './hash.mjs';
import { catFileBatch, exportTree, git, lsTree, revParse } from './git.mjs';
import { INVALID_RED_CATEGORIES, RED_VALID_CATEGORIES } from './results.mjs';
import { priorTestChanges } from './testids.mjs';

/** The commit trailer binding a compatibility-regression unit to its criteria, as Mycelink's settle reads it. */
export const COMPATIBILITY_TRAILER = 'Mycelink-Compatibility';

/** The criteria a commit's trailer names, or null when it carries none. */
export function compatibilityTrailer(message) {
  const lines = message.split(/\r?\n/).filter((l) => l.startsWith(`${COMPATIBILITY_TRAILER}:`));
  if (lines.length === 0) return null;
  return [...new Set(lines.flatMap((l) => l.slice(COMPATIBILITY_TRAILER.length + 1).split(/[\s,]+/)).map((x) => x.trim()).filter(Boolean))];
}

/**
 * The commit trailer of a re-proof unit (CSET-201 final): a completed criterion's review reproduction, passing on the
 * unchanged code, committed by Mycelink settle as tests alone — of behaviour an earlier RED of the history drove.
 */
export const REPROOF_TRAILER = 'Mycelink-Reproof';

/** The criteria a commit's re-proof trailer names, or null when it carries none. */
export function reproofTrailer(message) {
  const lines = message.split(/\r?\n/).filter((l) => l.startsWith(`${REPROOF_TRAILER}:`));
  if (lines.length === 0) return null;
  return [...new Set(lines.flatMap((l) => l.slice(REPROOF_TRAILER.length + 1).split(/[\s,]+/)).map((x) => x.trim()).filter(Boolean))];
}

function parentsOf(repo, commit) {
  return git(repo, ['rev-list', '--parents', '-n', '1', commit]).split(' ').slice(1);
}

/**
 * Units of `start..head`, oldest first: `[{ base, commits, after_production }]`.
 * Merges split the history into linear runs (each merged-in branch is
 * segmented from its merge base); within a run, a new unit — a red-green
 * cycle — starts at every test-only commit that follows a production
 * change, on top of the commit before it. A delivery integrated by
 * fast-forward (one node after another) therefore replays node by node.
 * Commits in `exclude` (the evaluator's fault injections) are transparent:
 * they belong to no unit. Those in `boundaries` (the late defect, which
 * lands after the delivery) also end the unit before them: what follows is
 * the next cycle, on top of them. `after_production` says whether delivered
 * production code (since `start`) was already in the unit's base.
 */
export function segmentUnits(repo, start, head, adapter, { exclude = new Set(), boundaries = new Set() } = {}) {
  const production = new Map();
  const isProduction = (commit) => {
    if (!production.has(commit)) {
      const parents = parentsOf(repo, commit);
      production.set(commit, !exclude.has(commit) && parents.length > 0 && changedBetween(repo, parents[0], commit).some((c) => !adapter.isTestPath(c.path)));
    }
    return production.get(commit);
  };
  const productionBefore = (base) => git(repo, ['rev-list', `${start}..${base}`]).split('\n').filter(Boolean).some(isProduction);
  const segment = (from, to) => {
    const chain = git(repo, ['rev-list', '--first-parent', '--reverse', `${from}..${to}`]).split('\n').filter(Boolean);
    const units = [];
    let current = null;
    let sawProduction = false;
    for (const commit of chain) {
      const parents = parentsOf(repo, commit);
      if (parents.length > 1) {
        if (current) units.push(current);
        current = null;
        for (const side of parents.slice(1)) units.push(...segment(git(repo, ['merge-base', parents[0], side]), side));
        continue;
      }
      if (exclude.has(commit)) {
        // The late defect lands after the delivery: the cycle before it ends there.
        if (boundaries.has(commit) && current) {
          units.push(current);
          current = null;
        }
        continue;
      }
      const changes = changedBetween(repo, parents[0], commit);
      const testOnly = changes.length > 0 && changes.every((c) => adapter.isTestPath(c.path));
      // A re-proof unit is a unit of its own: never folded into the cycle before it or the RED after it.
      if (testOnly && reproofTrailer(git(repo, ['show', '-s', '--format=%B', commit])) !== null) {
        if (current) units.push(current);
        current = null;
        units.push({ base: parents[0], commits: [commit], after_production: productionBefore(parents[0]), reproof: true });
        sawProduction = false;
        continue;
      }
      if (current && testOnly && sawProduction) {
        units.push(current);
        current = null;
      }
      if (!current) {
        current = { base: parents[0], commits: [], after_production: productionBefore(parents[0]) };
        sawProduction = false;
      }
      current.commits.push(commit);
      if (!testOnly) sawProduction = true;
    }
    if (current) units.push(current);
    return units;
  };
  return segment(start, head);
}

function changedBetween(repo, from, to) {
  const out = git(repo, ['diff-tree', '-r', '-z', '--no-commit-id', '--name-status', '--no-renames', from, to]);
  const parts = out.split('\0');
  const changes = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (parts[i] === '') break;
    changes.push({ status: parts[i][0], path: parts[i + 1] });
  }
  return changes;
}

function blobAt(repo, commit, path) {
  return revParse(repo, `${commit}:${path}`);
}

/** Tree entries of `rev` with `overrides` (path -> { mode, sha } | null) applied. */
function entriesWith(repo, rev, overrides) {
  const map = new Map(lsTree(repo, rev).map((e) => [e.path, { path: e.path, mode: e.mode, sha: e.sha }]));
  for (const [path, value] of overrides) {
    if (value === null) map.delete(path);
    else map.set(path, { path, mode: value.mode, sha: value.sha });
  }
  return [...map.values()];
}

function modeAt(repo, commit, path) {
  return lsTree(repo, commit).find((e) => e.path === path)?.mode ?? '100644';
}

/**
 * One summary per expected test. Several reports can match one expected
 * test (parameterised or repeated tests): any failure fails it, otherwise
 * any pass passes it; a test no report matches did not run.
 */
export function summarizeExpected(results, expected, adapter) {
  return expected.map((e) => {
    const matching = results.filter((x) => adapter.matches(x, e));
    const r = matching.find((x) => x.status === 'failed') ?? matching.find((x) => x.status === 'passed') ?? matching[0];
    return r
      ? { file: e.file, name: e.name, id: r.id, status: r.status, category: r.category, type: r.type ?? null, fingerprint: r.fingerprint ?? null, reports: matching.length }
      : { file: e.file, name: e.name, id: null, status: 'not-run', category: 'not-run', type: null, fingerprint: null, reports: 0 };
  });
}
const summarize = summarizeExpected;

/**
 * The test files that changed between two commits, as testsInDelta wants
 * them: `[{ path, before, after }]` with contents (null: absent), read from
 * the repository (no checkout, no index).
 */
function testDelta(repo, adapter, from, to) {
  const changes = changedBetween(repo, from, to).filter((c) => adapter.isTestPath(c.path));
  const delta = changes.map((c) => ({ path: c.path, before: c.status === 'A' ? null : blobAt(repo, from, c.path), after: c.status === 'D' ? null : blobAt(repo, to, c.path) }));
  const contents = catFileBatch(repo, delta.flatMap((d) => [d.before, d.after]).filter(Boolean));
  const text = (sha) => (sha ? contents.get(sha).toString('utf8') : null);
  return { delta, contents, declared: adapter.testsInDelta(delta.map((d) => ({ path: d.path, before: text(d.before), after: text(d.after) }))) };
}

const names = (tests) => tests.map((t) => `${t.file} › ${t.name}`).join(', ');

/** Is module `id` one that can have runtime tests (not declarations or documentation only)? */
const runtimeTested = (adapter, id) => id !== null && adapter.manifest.modules.find((m) => m.id === id)?.runtime_tests !== false;
/** Is module `id` declared to have no runtime tests (declarations or documentation only)? A path outside every module is not. */
const declarationModule = (adapter, id) => id !== null && adapter.manifest.modules.find((m) => m.id === id)?.runtime_tests === false;

/**
 * Replay one unit. `ctx` is passed to the adapter (`workRoot` is a scratch
 * directory owned by this replay). Never throws for a bad unit: the verdict
 * says what is wrong:
 *
 *   no-production-change  only tests, before any delivered production code
 *   declarations-only     production code only in modules with no runtime tests
 *                         (declarations, documentation) and no test: nothing a RED
 *                         could fail on; a path outside every module is not one
 *   test-after            tests declared (added or changed) after production
 *                         code: in a commit after the RED, or in a later
 *                         unit without production of its own
 *   compatibility-regression  a later test-only unit whose every commit names
 *                         compatibility criteria of the case (`compatibility`)
 *                         in a Mycelink-Compatibility trailer, that only adds
 *                         tests, and whose added tests pass on its own tree
 *                         (the code as it was) and on `finalHead` with its
 *                         test side: existing behaviour proved, never a RED
 *   compatibility-invalid such a unit naming another criterion, a commit
 *                         without the trailer, or removing, editing or
 *                         deleting a test or test data that was there
 *   compatibility-failed  its tests do not pass on its tree or the final one
 *   no-test-first         production code before any test-only commit
 *   no-test-ids           the RED delta declares no test
 *   red-missing-module    a module that can have runtime tests changes
 *                         production code without a RED test of its own
 *                         failing for a missing behaviour
 *   red-invalid, red-passed, green-failed, valid
 *
 * GREEN runs the RED commit's whole test side (every test path exactly as
 * at the RED commit) on the unit's final production code, so test support
 * code changed after the RED cannot help it pass.
 */
export async function replayUnit({ repo, unit, adapter, ctx, compatibility = [], criteria = [], finalHead = null }) {
  const record = { ok: false, verdict: 'error', base: unit.base, red_commit: null, head: unit.commits.at(-1), commits: unit.commits, expected_tests: [], tests_changed_after_red: [], test_maintenance_after_red: [], hashes: {} };
  try {
    const perCommit = [];
    for (const commit of unit.commits) {
      // Measured against the commit's own parent, so an injected commit in between counts for nobody.
      const changes = changedBetween(repo, parentsOf(repo, commit)[0], commit);
      perCommit.push({ commit, production: changes.filter((c) => !adapter.isTestPath(c.path)), tests: changes.filter((c) => adapter.isTestPath(c.path)) });
    }
    if (perCommit.every((c) => c.production.length === 0)) {
      if (unit.after_production) {
        const { declared } = testDelta(repo, adapter, unit.base, record.head);
        if (declared.length > 0 && unit.reproof === true) return await reproofUnit({ repo, unit, adapter, ctx, criteria, finalHead, record, declared });
        if (declared.length > 0) {
          const compat = await compatibilityUnit({ repo, unit, adapter, ctx, compatibility, finalHead, record, declared });
          if (compat !== null) return compat;
          return { ...record, expected_tests: declared, verdict: 'test-after', detail: `tests declared after the production code, without production code of their own: ${names(declared)}` };
        }
      }
      return { ...record, ok: true, verdict: 'no-production-change' };
    }
    // Declarations only (every production path in a module with no runtime tests), and no test: nothing a RED could fail on.
    const declarationsOnly = perCommit.every((c) => c.tests.length === 0 && c.production.every((p) => declarationModule(adapter, adapter.moduleOf(p.path))));
    if (declarationsOnly) return { ...record, ok: true, verdict: 'declarations-only' };
    const prefix = [];
    for (const c of perCommit) {
      if (c.production.length > 0 || c.tests.length === 0) break;
      prefix.push(c);
    }
    if (prefix.length === 0) return { ...record, verdict: 'no-test-first', detail: `${unit.commits[0].slice(0, 12)} changes production code before any test-only commit` };
    const redCommit = prefix.at(-1).commit;
    record.red_commit = redCommit;

    // Every test the unit declares must be in its RED: none may be added or changed after it.
    const after = testDelta(repo, adapter, redCommit, record.head);
    record.tests_changed_after_red = after.delta.map((d) => d.path);
    if (after.declared.length > 0) return { ...record, verdict: 'test-after', detail: `tests declared after the RED, with or after the production code: ${names(after.declared)}` };
    record.test_maintenance_after_red = record.tests_changed_after_red;

    // The test-first delta, read from the repository (no checkout, no index).
    const { delta, contents, declared: expected } = testDelta(repo, adapter, unit.base, redCommit);
    record.expected_tests = expected;
    if (expected.length === 0) return { ...record, verdict: 'no-test-ids', detail: 'the test-first delta declares no new or changed test' };

    // Every module that can have runtime tests and changes production code needs a RED of its own.
    const changedModules = [...new Set(perCommit.flatMap((c) => c.production.map((p) => adapter.moduleOf(p.path))))].filter((m) => runtimeTested(adapter, m)).sort();
    const uncovered = changedModules.filter((m) => !expected.some((t) => adapter.moduleOf(t.file) === m));
    if (uncovered.length > 0) return { ...record, verdict: 'red-missing-module', detail: `production code changes in ${uncovered.join(', ')} without a RED test there` };

    const overrides = new Map(delta.map((d) => [d.path, d.after === null ? null : { mode: modeAt(repo, redCommit, d.path), sha: d.after }]));
    // GREEN: the unit's final tree with its whole test side exactly as at the RED commit.
    const redTests = lsTree(repo, redCommit).filter((e) => adapter.isTestPath(e.path));
    const greenOverrides = new Map(lsTree(repo, record.head).filter((e) => adapter.isTestPath(e.path)).map((e) => [e.path, null]));
    for (const e of redTests) greenOverrides.set(e.path, { mode: e.mode, sha: e.sha });
    const greenContents = catFileBatch(repo, redTests.map((e) => e.sha));
    record.start_tree = revParse(repo, `${unit.base}^{tree}`);
    record.red_tree = gitTreeSha(entriesWith(repo, unit.base, overrides));
    record.green_tree = gitTreeSha(entriesWith(repo, record.head, greenOverrides));
    record.hashes.red_tests_sha256 = sha256Hex(canonicalJson(delta.map((d) => ({ path: d.path, blob: d.after }))));
    record.hashes.green_test_side_sha256 = sha256Hex(canonicalJson(redTests.map((e) => ({ path: e.path, mode: e.mode, blob: e.sha }))));

    const exportWith = (rev, dir, map, blobs) => {
      exportTree(repo, rev, dir, { overrides: new Map([...map].map(([path, v]) => [path, v === null ? null : blobs.get(v.sha)])) });
      return dir;
    };
    const work = ctx.workRoot;
    mkdirSync(work, { recursive: true });
    const redDir = exportWith(unit.base, join(work, 'red-tree'), overrides, contents);
    const red = await adapter.runTests({ tree: redDir, tests: expected, ctx, label: 'red' });
    rmSync(redDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    const redExpected = summarize(red.results, expected, adapter);
    record.red = { run: red.run, command: red.command, expected: redExpected, categories: [...new Set(redExpected.map((t) => t.category))] };
    record.hashes.argv_sha256 = sha256Hex(canonicalJson(red.command.argv));
    record.hashes.env_sha256 = sha256Hex(canonicalJson(red.command.env));
    record.hashes.red_stdout_sha256 = red.run.stdout_sha256;
    record.hashes.red_stderr_sha256 = red.run.stderr_sha256;

    const failing = redExpected.filter((t) => t.status === 'failed');
    const invalid = redExpected.filter((t) => INVALID_RED_CATEGORIES.has(t.category));
    if (red.run.timed_out || invalid.length > 0) {
      return { ...record, verdict: 'red-invalid', detail: red.run.timed_out ? 'the RED run timed out' : `RED failed for the wrong reason: ${invalid.map((t) => `${t.name} (${t.category})`).join(', ')}` };
    }
    if (red.run.exit_code === 0 || failing.length === 0) return { ...record, verdict: 'red-passed', detail: 'the test-first delta does not fail on the start' };
    if (!failing.some((t) => RED_VALID_CATEGORIES.has(t.category))) return { ...record, verdict: 'red-invalid', detail: 'no expected test fails for a missing behaviour' };
    const quiet = changedModules.filter((m) => !failing.some((t) => adapter.moduleOf(t.file) === m && RED_VALID_CATEGORIES.has(t.category)));
    if (quiet.length > 0) return { ...record, verdict: 'red-missing-module', detail: `no RED test in ${quiet.join(', ')} fails for a missing behaviour` };

    const greenDir = exportWith(record.head, join(work, 'green-tree'), greenOverrides, greenContents);
    const green = await adapter.runTests({ tree: greenDir, tests: expected, ctx, label: 'green' });
    rmSync(greenDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    const greenExpected = summarize(green.results, expected, adapter);
    record.green = { run: green.run, command: green.command, expected: greenExpected };
    record.hashes.green_stdout_sha256 = green.run.stdout_sha256;
    record.hashes.green_stderr_sha256 = green.run.stderr_sha256;
    if (canonicalJson(green.command) !== canonicalJson(red.command)) return { ...record, verdict: 'error', detail: 'GREEN did not run the identical command' };
    if (green.run.timed_out || green.run.exit_code !== 0 || !greenExpected.every((t) => t.status === 'passed')) {
      return { ...record, verdict: 'green-failed', detail: `GREEN: ${greenExpected.map((t) => `${t.name}=${t.status}`).join(', ')} (exit ${green.run.exit_code})` };
    }
    return { ...record, ok: true, verdict: 'valid' };
  } catch (error) {
    return { ...record, verdict: 'error', detail: String(error?.stack ?? error) };
  }
}

/**
 * A re-proof unit (CSET-201 final): its commit names criteria of the case in a Mycelink-Reproof trailer; it only adds tests;
 * they pass on its own tree (the code as it was, which an earlier RED of the history drove) and on the delivered tree with
 * its test side. Verdicts: reproof, reproof-invalid, reproof-failed.
 */
async function reproofUnit({ repo, unit, adapter, ctx, criteria, finalHead, record, declared }) {
  const named = [...new Set(unit.commits.flatMap((c) => reproofTrailer(git(repo, ['show', '-s', '--format=%B', c])) ?? []))];
  const invalid = (detail) => ({ ...record, expected_tests: declared, verdict: 'reproof-invalid', detail });
  if (named.length === 0) return invalid('its commit names no criterion in its Mycelink-Reproof trailer');
  const others = named.filter((ac) => !criteria.includes(ac));
  if (others.length > 0) return invalid(`${others.join(', ')} ${others.length === 1 ? 'is' : 'are'} not a criterion of the case (${criteria.join(', ') || 'none'})`);
  const verdict = await compatibilityUnit({ repo, unit, adapter, ctx, compatibility: named, finalHead, record, declared, trailer: 'reproof' });
  return verdict;
}

/**
 * A test-only unit after production whose commits name compatibility
 * criteria (CSET-203 r3's AC-5 regression test): null when none of its
 * commits carries the trailer (it is test-after, as before); else its
 * verdict. The tests it adds run on the unit's own tree (the code as it was,
 * its tests added) and on the final delivered tree with its test side; both
 * must pass.
 */
async function compatibilityUnit({ repo, unit, adapter, ctx, compatibility, finalHead, record, declared, trailer = 'compatibility' }) {
  const reproof = trailer === 'reproof';
  const read = reproof ? reproofTrailer : compatibilityTrailer;
  const label = reproof ? 'reproof' : 'compatibility';
  const named = unit.commits.map((c) => ({ commit: c, criteria: read(git(repo, ['show', '-s', '--format=%B', c])) }));
  if (named.every((n) => n.criteria === null)) return null;
  const invalid = (detail) => ({ ...record, expected_tests: declared, verdict: `${label}-invalid`, detail });
  const bare = named.find((n) => n.criteria === null || n.criteria.length === 0);
  if (bare) return invalid(`${bare.commit.slice(0, 12)} carries no ${COMPATIBILITY_TRAILER} trailer: every commit of a compatibility-regression unit names its compatibility criteria`);
  const criteria = [...new Set(named.flatMap((n) => n.criteria))];
  const others = criteria.filter((ac) => !compatibility.includes(ac));
  if (others.length > 0) return invalid(`${others.join(', ')} ${others.length === 1 ? 'is' : 'are'} not a compatibility criterion of the case (${compatibility.join(', ') || 'none'}): tests after the code prove only existing behaviour`);
  const { delta, contents } = testDelta(repo, adapter, unit.base, record.head);
  const text = (sha) => (sha ? contents.get(sha).toString('utf8') : null);
  const prior = priorTestChanges(delta.map((d) => ({ path: d.path, before: text(d.before), after: text(d.after) })), { isTestPath: adapter.isTestPath });
  const touched = [
    prior.removed.length ? `removes ${names(prior.removed)}` : '',
    prior.edited.length ? `edits ${names(prior.edited)}` : '',
    prior.deleted.length ? `deletes ${prior.deleted.join(', ')}` : '',
    prior.data.length ? `changes the existing test data ${prior.data.join(', ')}` : '',
  ].filter(Boolean);
  if (touched.length > 0) return invalid(`the unit ${touched.join('; ')}: ${reproof ? 'a re-proof unit' : 'a compatibility-regression unit'} only adds tests`);
  const expected = prior.added;
  if (expected.length === 0) return invalid('the unit adds no test');
  const out = { ...record, criteria, expected_tests: expected, compatibility: {} };
  mkdirSync(ctx.workRoot, { recursive: true });
  const runOn = async (label, rev, overrides) => {
    const dir = join(ctx.workRoot, `${label}-tree`);
    const blobs = catFileBatch(repo, [...overrides.values()].filter(Boolean).map((v) => v.sha));
    exportTree(repo, rev, dir, { overrides: new Map([...overrides].map(([p, v]) => [p, v === null ? null : blobs.get(v.sha)])) });
    const ran = await adapter.runTests({ tree: dir, tests: expected, ctx, label });
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    const summary = summarize(ran.results, expected, adapter);
    out.compatibility[label] = { run: ran.run, command: ran.command, expected: summary };
    return !ran.run.timed_out && ran.run.exit_code === 0 && summary.every((t) => t.status === 'passed');
  };
  // Its own tree: the code as it was before it, with the tests it adds.
  if (!(await runOn('base', record.head, new Map()))) {
    return { ...out, verdict: `${label}-failed`, detail: `its tests do not pass on the code they say is unchanged: ${out.compatibility.base.expected.map((t) => `${t.name}=${t.status}`).join(', ')}` };
  }
  // The delivered tree, with the unit's whole test side.
  const final = finalHead ?? record.head;
  const side = new Map(lsTree(repo, final).filter((e) => adapter.isTestPath(e.path)).map((e) => [e.path, null]));
  for (const e of lsTree(repo, record.head).filter((x) => adapter.isTestPath(x.path))) side.set(e.path, { mode: e.mode, sha: e.sha });
  if (!(await runOn('final', final, side))) {
    return { ...out, verdict: `${label}-failed`, detail: `its tests fail on the delivered tree: ${out.compatibility.final.expected.map((t) => `${t.name}=${t.status}`).join(', ')}` };
  }
  return { ...out, ok: true, verdict: reproof ? 'reproof' : 'compatibility-regression' };
}
