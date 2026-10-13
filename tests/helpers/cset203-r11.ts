/**
 * CSET-203 r11's shape on the version fixture.
 *
 * r11 with-normal: R001 found AC-1 on apply-release-plan (a reproduction the
 * code already satisfies: challenged, withdrawn) and AC-5 on the cli
 * (reworked); R002 found another AC-1 reproduction the code satisfies
 * (challenged, withdrawn) and an AC-3 gap on the cli (reworked); R003 found
 * materially new, concrete AC-1 and AC-3 gaps — the boundaries hidden
 * acceptance checks — and the global `max_rounds: 2` blocked it before any
 * rework. Here apply-release-plan starts as r2's (a changelog write that
 * fails part-way is left half-written: R003's AC-1), and the cli's recovery
 * reads any journal it finds, so a journal that recorded no entries (R002's
 * AC-3) and one a kill cut short mid-JSON (R003's AC-3) both make version
 * throw.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { git } from './git-fixture.js';
import { CLI, CLI_COMPAT_TESTS, CLI_FAILURE_RED, CLI_COMPAT_TEST_ID, CLI_IMPL, CLI_SRC, CLI_STATUS_TEST, verCliTestId, CLI_TESTS, CLI_TRUNCATED_TEST, VER_FEATURE, verCli, type Ver } from './version-fixture.js';
import { commit, packOf, runGate, writeFiles, type ShopTicket } from './shop-worker.js';
import { writeResult } from './cset203-rework.js';
import type { VerdictOverride } from './review-agent.js';

export const ARP_MODULE = 'changesets:packages/apply-release-plan/src/index.mjs';

/** R002's AC-3: a journal that recorded no entries yet. */
export const AC3_EMPTY_REPRODUCTION = 'write .changeset/.version-journal.json as {} (a journal that recorded no entries yet) beside a pending changeset, run version, and assert it warns interrupted, removes the journal and versions once';
export const GAP_AC3_EMPTY: VerdictOverride = { gap: { missing: 'a journal that recorded no entries makes version throw before it versions', reproduction: AC3_EMPTY_REPRODUCTION, producer: { node_id: CLI } } };

/** R003's AC-3: the kill hit while the journal itself was written (r11 R003: a created-file state never recovered). */
export const AC3_TRUNCATED_REPRODUCTION =
  'simulate the kill while the journal itself was being written: leave .changeset/.version-journal.json cut short mid-JSON (unparseable) beside a pending changeset, run version, and assert it warns interrupted, removes the journal and versions once';
export const GAP_AC3_TRUNCATED: VerdictOverride = { gap: { missing: 'recovery of a journal a kill cut short while it was written is never tested: version throws on it', reproduction: AC3_TRUNCATED_REPRODUCTION, producer: { node_id: CLI } } };

/** R003's AC-1: the boundary hidden acceptance checks, a changelog write that fails part-way after the package version write. */
export const AC1_PARTIAL_REPRODUCTION =
  'make the changelog writer fail part-way (a partial write, as a full disk would) after the package version write; assert every file, the half-written changelog included, is restored to its exact previous bytes and the rejection cause is the writer failure';
export const GAP_AC1_PARTIAL: VerdictOverride = { gap: { missing: 'no apply-release-plan test makes a write fail part-way: the half-written changelog is left as the failed write left it', reproduction: AC1_PARTIAL_REPRODUCTION, producer: { module: ARP_MODULE } } };

export const CLI_EMPTY_TEST = 'version recovers from a journal that recorded no entries, warns that the run was interrupted, then versions once';

/** R002's focused RED on the cli: a journal `{}`. */
export const CLI_EMPTY_RED = `${CLI_FAILURE_RED}
test('${CLI_EMPTY_TEST}', async () => {
  const files = new Map([['packages/a/package.json', '{"version":"1.0.0"}'], ['.changeset/one.md', 'one'], ['.changeset/.version-journal.json', '{}']]);
  const warnings = [];
  let code;
  try {
    code = await version({ files, changes: [{ path: 'packages/a/package.json', content: '{"version":"2.0.0"}' }, { path: '.changeset/one.md', content: null }], io: { log() {}, warn: (m) => warnings.push(m), error() {} }, git: { add() {}, commit() {} } });
  } catch (error) {
    code = 'threw ' + error.message;
  }
  assert.equal(code, 0);
  assert.ok(warnings.some((w) => /interrupted/.test(w)), 'it warns that the last run was interrupted');
  assert.deepEqual([...files].sort(), [['packages/a/package.json', '{"version":"2.0.0"}']], 'versioned once, no journal left');
});
`;

/** R002's fix: a journal with no entries changed nothing yet, and is removed; one that cannot be read still throws. */
export const CLI_EMPTY_IMPL = CLI_IMPL.replace(
  "import { applyReleasePlan, recoverInterruptedReleasePlan } from '../../apply-release-plan/src/index.mjs';\n",
  `import { JOURNAL, applyReleasePlan, recoverInterruptedReleasePlan } from '../../apply-release-plan/src/index.mjs';

/** Restore an interrupted run; a journal that recorded no entries yet changed nothing, and is removed. */
function recover(files) {
  if (files.has(JOURNAL) && !Array.isArray(JSON.parse(files.get(JOURNAL)).before)) {
    files.delete(JOURNAL);
    return true;
  }
  return recoverInterruptedReleasePlan(files);
}
`,
).replace('  if (recoverInterruptedReleasePlan(files)) io.warn(', '  if (recover(files)) io.warn(');

/** R003's focused RED on the cli: a journal cut short mid-JSON. */
export const CLI_TRUNCATED_R11_RED = `${CLI_EMPTY_RED}
test('${CLI_TRUNCATED_TEST}', async () => {
  const files = new Map([['packages/a/package.json', '{"version":"1.0.0"}'], ['.changeset/one.md', 'one'], ['.changeset/.version-journal.json', '{"before":[{"path":"packages/a/pack']]);
  const warnings = [];
  let code;
  try {
    code = await version({ files, changes: [{ path: 'packages/a/package.json', content: '{"version":"2.0.0"}' }, { path: '.changeset/one.md', content: null }], io: { log() {}, warn: (m) => warnings.push(m), error() {} }, git: { add() {}, commit() {} } });
  } catch (error) {
    code = 'threw ' + error.message;
  }
  assert.equal(code, 0);
  assert.ok(warnings.some((w) => /interrupted/.test(w)), 'it warns that the last run was interrupted');
  assert.deepEqual([...files].sort(), [['packages/a/package.json', '{"version":"2.0.0"}']], 'versioned once, no journal left');
});
`;

/** R003's fix: a journal that cannot be read was cut short before the run changed anything, and is removed. */
export const CLI_TRUNCATED_R11_IMPL = CLI_EMPTY_IMPL.replace(
  '  if (files.has(JOURNAL) && !Array.isArray(JSON.parse(files.get(JOURNAL)).before)) {',
  `  let entries = null;
  try {
    entries = files.has(JOURNAL) ? JSON.parse(files.get(JOURNAL)).before : null;
  } catch {
    entries = undefined;
  }
  if (files.has(JOURNAL) && !Array.isArray(entries)) {`,
);

/** Hidden-like acceptance of AC-4, run from outside on a checkout: a failed apply exits 1 with every cause, no stack, nothing committed. */
export const VER_AC4_ACCEPTANCE = `import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
const cli = await import(pathToFileURL(join(root, 'packages/cli/src/index.mjs')).href);
const errors = [];
const calls = [];
const files = new Map([['packages/d/package.json', '{"version":"4.0.0"}']]);
const code = await cli.version({ files, changes: [{ path: 'packages/d/package.json', content: '{"version":"4.1.0"}' }], config: { commit: true }, io: { log() {}, warn() {}, error: (m) => errors.push(m) }, git: { add: () => calls.push('add'), commit: () => calls.push('commit') }, format: async () => { throw new Error('prettier exploded'); } }).catch((e) => 'threw ' + e.message);
assert.equal(code, 1, 'AC-4 exits 1');
assert.match(errors.join('\\n'), /prettier exploded/, 'AC-4 prints the failure');
assert.doesNotMatch(errors.join('\\n'), /\\n\\s+at /, 'AC-4 no stack trace');
assert.deepEqual(calls, [], 'AC-4 neither git add nor git commit');
assert.deepEqual([...files], [['packages/d/package.json', '{"version":"4.0.0"}']], 'AC-4 nothing changed');
console.log('AC-4 acceptance: ok');
`;

/**
 * A cli rework with a RED cycle for AC-3, as its worker does it: the focused
 * test (it fails on the code as it is), the fix, green and regression; the
 * result cites AC-3's RED and every carried proof as given, and AC-5 by the
 * green gate's run of its regression test where the pack carries none.
 */
export function cliRedRework(t: ShopTicket, control: string, work: { tests: string; impl: string; test: string }): void {
  expect(t.node_id).toBe(CLI);
  writeFiles(t.worktree, { [CLI_TESTS]: work.tests });
  const red = runGate(t, 'red', control);
  expect(red.code, red.out).toBe(0);
  commit(t.worktree, [CLI_TESTS], `test(cli): AC-3 ${work.test}`);
  writeFiles(t.worktree, { [CLI_SRC]: work.impl });
  const green = runGate(t, 'green', control);
  expect(green.code, green.out).toBe(0);
  commit(t.worktree, [CLI_SRC], 'fix(cli): recover that journal too');
  expect(runGate(t, 'regression', control).code).toBe(0);
  const carried = (packOf(t)['rework']?.['carried_criteria'] ?? []) as { criterion: string; test_id: string; gate?: string; output_sha256: string }[];
  const evidence: Record<string, unknown>[] = [{ criterion: 'AC-3', test_id: red.tests.find((x) => x.full_name === work.test)!.id, gate: 'red', output_sha256: red.sha256 }];
  for (const c of carried) if (c.criterion !== 'AC-3') evidence.push({ criterion: c.criterion, test_id: c.test_id, gate: c.gate ?? 'red', output_sha256: c.output_sha256 });
  // AC-5's regression test (in its own file once an AC-5 rework added it, else the existing status test): by its canonical id (a gate prints only the node's own tests).
  if (!evidence.some((e) => e['criterion'] === 'AC-5')) evidence.push({ criterion: 'AC-5', test_id: existsSync(join(t.worktree, ...CLI_COMPAT_TESTS.split('/'))) ? CLI_COMPAT_TEST_ID : verCliTestId(CLI_STATUS_TEST), gate: 'green', output_sha256: green.sha256 });
  writeResult(t, evidence);
}

/** `review status` as JSON. */
export async function reviewStatusOf(s: Ver): Promise<Record<string, any>> {
  return JSON.parse((await verCli(s, ['review', 'status', VER_FEATURE, '--json'])).out) as Record<string, any>;
}

/** The feature's STATE.json as committed, for a test that edits it. */
export function rawState(s: Ver): { revision: number; data: Record<string, any> } {
  return JSON.parse(readFileSync(`${s.featureDir}/STATE.json`, 'utf8')) as { revision: number; data: Record<string, any> };
}

/** The head of the repository's integration branch. */
export function integrationHead(s: Ver): string {
  return git(s.repo, ['rev-parse', `refs/heads/feature/${VER_FEATURE}`]);
}
