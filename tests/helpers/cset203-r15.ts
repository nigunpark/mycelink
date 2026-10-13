/**
 * CSET-203 r15's shape on the version fixture.
 *
 * r15 with-normal: R001 found AC-3, AC-4 and AC-5 and routed all three to
 * the cli, one order. The cli's worker ran one red gate over the review's
 * exact AC-3 and AC-4 reproductions: AC-3's failed (a real gap), AC-4's
 * passed on the unchanged base (no stack trace was ever printed). It fixed
 * AC-3 test-first and added AC-5's compatibility-regression unit. The
 * challenge line refused (the same red gate had failed AC-3's test), and a
 * result had one outcome for every criterion of its order, so the worker
 * answered NEEDS_DECISION asking how to close AC-4: one product attempt,
 * automation stopped. Here a result answers each ordered criterion on its
 * own (schema_version 2, outcome CRITERIA): AC-3 DONE, AC-4 challenged, AC-5
 * DONE.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect } from 'vitest';
import { git } from './git-fixture.js';
import { CLI, CLI_COMPAT_FILE, CLI_COMPAT_TESTS, CLI_COMPAT_TEST_ID, CLI_FAILURE_RED, CLI_IMPL, CLI_SRC, CLI_TESTS, CLI_TRUNCATED_IMPL, CLI_TRUNCATED_RED, CLI_TRUNCATED_TEST, VER_FEATURE, type Ver } from './version-fixture.js';
import { commit, packOf, runGate, writeFiles, type GateRun, type ShopTicket } from './shop-worker.js';
import { GAP_AC3, GAP_AC5, commitCompat, reviewed } from './cset203-rework.js';
import { CLI_CHALLENGE_BODY, CLI_CHALLENGE_TEST, GAP_AC4_HOLDS, briefLine, cliClauses, lineOf, runJsonLine, type ChallengeClause } from './cset203-challenge.js';
import type { VerdictOverride } from './review-agent.js';

export { GAP_AC3, GAP_AC4_HOLDS, GAP_AC5 };

/** R001 as r15's: AC-3 (a real gap: a journal cut short by a kill), AC-4 (one the cli's code satisfies) and AC-5, all the cli's. */
export async function r15Reviewed(): Promise<Awaited<ReturnType<typeof reviewed>>> {
  return reviewed({ 'AC-3': GAP_AC3, 'AC-4': GAP_AC4_HOLDS, 'AC-5': GAP_AC5 });
}

/** AC-3's focused test (it fails on the cli's code) and AC-4's (it passes there), in one file: one red gate runs both. */
export const CLI_TRUNCATED_BODY = CLI_TRUNCATED_RED.slice(CLI_FAILURE_RED.length);
export const CLI_R15_RED = `${CLI_FAILURE_RED}${CLI_TRUNCATED_BODY}${CLI_CHALLENGE_BODY}`;

export interface MixedRun {
  red: GateRun;
  green: GateRun;
  /** The green gate run again after AC-5's compatibility-regression unit. */
  regreen: GateRun;
  regression: GateRun;
  skeleton: Record<string, any>;
  /** The challenge, its clauses traced and explained. */
  challenge: Record<string, any>;
  ids: { ac3: string; ac4: string; ac5: string };
}

/** The ticket's challenge line, narrowed to `criteria`, as JSON. */
export function challengeFor(t: ShopTicket, cwd: string, criteria: string[] = []): { code: number; out: Record<string, any>; raw: string } {
  const line = briefLine(t, 'challenge');
  if (line === null) throw new Error(`the brief of ${t.node_id} offers no challenge line`);
  return runJsonLine(`${line}${criteria.length > 0 ? ` --criteria ${criteria.join(',')}` : ''} --json`, cwd);
}

/**
 * r15's cli worker, test-first: one red gate over AC-3's and AC-4's exact
 * reproductions (AC-3's fails, AC-4's passes), the tests committed alone;
 * AC-3's fix, green, the fix committed alone; AC-5's regression test alone
 * in a file of its own with its trailer, green again, regression; the
 * challenge line narrowed to AC-4, its clauses traced to the focused test's
 * own assertion lines. Nothing written to the slot yet.
 */
export function mixedWork(t: ShopTicket, control: string, options: { impl?: string; tests?: string } = {}): MixedRun {
  expect(t.node_id).toBe(CLI);
  writeFiles(t.worktree, { [CLI_TESTS]: options.tests ?? CLI_R15_RED });
  const red = runGate(t, 'red', control);
  expect(red.code, red.out).toBe(0);
  commit(t.worktree, [CLI_TESTS], 'test(cli): the review reproductions of AC-3 and AC-4');
  writeFiles(t.worktree, { [CLI_SRC]: options.impl ?? CLI_TRUNCATED_IMPL });
  const green = runGate(t, 'green', control);
  expect(green.code, green.out).toBe(0);
  commit(t.worktree, [CLI_SRC], 'fix(cli): recover a journal a kill cut short');
  writeFiles(t.worktree, { [CLI_COMPAT_TESTS]: CLI_COMPAT_FILE });
  commitCompat(t.worktree, [CLI_COMPAT_TESTS], 'AC-5');
  const regreen = runGate(t, 'green', control);
  expect(regreen.code, regreen.out).toBe(0);
  const regression = runGate(t, 'regression', control);
  expect(regression.code, regression.out).toBe(0);
  const ac3 = red.tests.find((x) => x.full_name === CLI_TRUNCATED_TEST);
  const ac4 = red.tests.find((x) => x.full_name === CLI_CHALLENGE_TEST);
  expect(ac3, red.out).toMatchObject({ status: 'failed' });
  expect(ac4, red.out).toMatchObject({ status: 'passed' });
  const skeleton = challengeFor(t, control, ['AC-4']);
  expect(skeleton.code, skeleton.raw).toBe(0);
  const challenge = structuredClone(skeleton.out['challenge']) as Record<string, any>;
  const source = readFileSync(join(t.worktree, ...CLI_TESTS.split('/')), 'utf8');
  for (const gap of challenge['gaps'] as Record<string, any>[]) {
    gap['tests'] = [(ac4 as { id: string }).id];
    gap['clauses'] = cliClauses(source, (ac4 as { id: string }).id);
    gap['explanation'] = `The review's exact AC-4 reproduction, written as ${CLI_CHALLENGE_TEST}, passed in the same red gate whose AC-3 test failed: the failure was already printed without a stack trace, exit 1, nothing committed.`;
  }
  return { red, green, regreen, regression, skeleton: skeleton.out, challenge, ids: { ac3: (ac3 as { id: string }).id, ac4: (ac4 as { id: string }).id, ac5: CLI_COMPAT_TEST_ID } };
}

/** A worktree's head, or zeros once it is gone (a late answer). */
function headOf(worktree: string): string {
  try {
    return git(worktree, ['rev-parse', 'HEAD']);
  } catch {
    return '0'.repeat(40);
  }
}

export interface CriteriaResult {
  criteria: Record<string, unknown>[];
  evidence: Record<string, unknown>[];
  challenge?: Record<string, unknown> | null;
  /** Other fields of the result, over the defaults. */
  extra?: Record<string, unknown>;
}

/** A per-criterion result (schema_version 2, outcome CRITERIA) at the worktree's head, written to the ticket's slot. */
export function writeCriteriaResult(t: ShopTicket, r: CriteriaResult): Record<string, unknown> {
  const result = {
    schema_version: 2,
    node_id: t.node_id,
    claim_id: t.claim_id,
    dispatch_id: t.dispatch_id,
    outcome: 'CRITERIA',
    commands: [{ command: ['gate:red'], exit_code: 0 }],
    commit_sha: headOf(t.worktree),
    changed_paths: [CLI_TESTS, CLI_SRC, CLI_COMPAT_TESTS],
    evidence_paths: [],
    failure_fingerprint: null,
    decision_request: null,
    criteria: r.criteria,
    criterion_evidence: r.evidence,
    ...(r.challenge !== undefined && r.challenge !== null ? { challenge: r.challenge } : {}),
    ...(r.extra ?? {}),
  };
  mkdirSync(dirname(t.result_slot), { recursive: true });
  writeFileSync(t.result_slot, JSON.stringify(result, null, 2));
  return result;
}

/** r15's answer as it should have been: AC-3 DONE by its RED, AC-4 challenged, AC-5 DONE by its compatibility unit. */
export function r15Result(t: ShopTicket, run: MixedRun, extra: Partial<CriteriaResult> = {}): Record<string, unknown> {
  return writeCriteriaResult(t, {
    criteria: extra.criteria ?? [
      { criterion: 'AC-3', outcome: 'DONE' },
      { criterion: 'AC-4', outcome: 'REVIEW_GAP_CHALLENGE' },
      { criterion: 'AC-5', outcome: 'DONE' },
    ],
    evidence: extra.evidence ?? [
      { criterion: 'AC-3', test_id: run.ids.ac3, gate: 'red', output_sha256: run.red.sha256 },
      { criterion: 'AC-5', test_id: run.ids.ac5, gate: 'green', output_sha256: run.regreen.sha256 },
    ],
    challenge: extra.challenge === undefined ? run.challenge : extra.challenge,
    ...(extra.extra !== undefined ? { extra: extra.extra } : {}),
  });
}

/** The ticket's check line, as JSON: the result in the slot judged as settle will. */
export function checkFor(t: ShopTicket, cwd: string): { code: number; out: Record<string, any>; raw: string } {
  const line = briefLine(t, 'check');
  if (line === null) throw new Error(`the brief of ${t.node_id} offers no check line`);
  return runJsonLine(`${line} --json`, cwd);
}

/**
 * The refinement's AC-4: a reproduction the cli's code fails — a failure
 * thrown as a bare string, not an Error, printed as nothing.
 */
export const AC4_STRING_REPRODUCTION = "reject the apply with a plain non-Error value: the formatter rejects with the bare string ENOSPC device full rather than an Error object; expect the printed message to contain that string, process exit status 1, and zero git add or commit invocations";
export const AC4_STRING_GAP = { missing: 'a failure that is not an Error is printed as nothing: the message never holds what failed', reproduction: AC4_STRING_REPRODUCTION };

export const CLI_STRING_TEST = 'version reports a failure thrown as a bare string with its text and no stack trace, exits 1 and commits nothing';
export const CLI_STRING_BODY = `
test('${CLI_STRING_TEST}', async () => {
  const errors = [];
  const calls = [];
  const code = await version({ files: new Map([['packages/a/package.json', '{"version":"1.0.0"}']]), changes: [{ path: 'packages/a/package.json', content: '{"version":"2.0.0"}' }], config: { commit: true }, io: { log() {}, warn() {}, error: (m) => errors.push(m) }, git: { add: () => calls.push('add'), commit: () => calls.push('commit') }, format: async () => { throw 'disk exploded'; } });
  assert.equal(code, 1);
  assert.match(errors.join('\\n'), /disk exploded/);
  assert.doesNotMatch(errors.join('\\n'), /\\n\\s+at /);
  assert.deepEqual(calls, []);
});
`;
/** The cli's tests as the mixed rework left them, with the refined AC-4's focused RED. */
export const CLI_STRING_RED = `${CLI_R15_RED}${CLI_STRING_BODY}`;
/** The fix: a cause that is not an Error is printed by its text. */
export const CLI_STRING_IMPL = CLI_TRUNCATED_IMPL.replace(
  '  for (let e = error; e instanceof Error && out.length < 5; e = e.cause) out.push(e.message);\n',
  "  let e = error;\n  for (; e instanceof Error && out.length < 5; e = e.cause) out.push(e.message);\n  if (e !== undefined && e !== null && !(e instanceof Error) && out.length < 5) out.push(String(e));\n",
);

/** Hidden-like acceptance of the refined AC-4, run from outside on a checkout. */
export const VER_AC4_STRING_ACCEPTANCE = `import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
const cli = await import(pathToFileURL(join(root, 'packages/cli/src/index.mjs')).href);
const errors = [];
const calls = [];
const code = await cli.version({ files: new Map([['packages/e/package.json', '{"version":"5.0.0"}']]), changes: [{ path: 'packages/e/package.json', content: '{"version":"5.1.0"}' }], config: { commit: true }, io: { log() {}, warn() {}, error: (m) => errors.push(m) }, git: { add: () => calls.push('add'), commit: () => calls.push('commit') }, format: async () => { throw 'ENOSPC no space left'; } }).catch((e) => 'threw ' + String(e));
assert.equal(code, 1, 'AC-4 exits 1 on a non-Error failure');
assert.match(errors.join('\\n'), /ENOSPC no space left/, 'AC-4 prints a non-Error failure');
assert.doesNotMatch(errors.join('\\n'), /\\n\\s+at /, 'AC-4 no stack trace');
assert.deepEqual(calls, [], 'AC-4 nothing committed');
console.log('AC-4 string acceptance: ok');
`;

/** The refinement's REFINE of AC-4, on the cli. */
export const REFINE_AC4: { decision: 'REFINE'; gap: { missing: string; reproduction: string }; producer: { node_id: string } } = { decision: 'REFINE', gap: AC4_STRING_GAP, producer: { node_id: CLI } };

/** The cli's work on the refined AC-4 alone: its focused RED fails, the fix, green, regression; AC-3 cited by its carried proof, AC-5 by its regression test. */
export function refinedAc4Work(t: ShopTicket, control: string): { red: GateRun; green: GateRun } {
  expect(t.node_id).toBe(CLI);
  writeFiles(t.worktree, { [CLI_TESTS]: CLI_STRING_RED });
  const red = runGate(t, 'red', control);
  expect(red.code, red.out).toBe(0);
  expect(red.tests.find((x) => x.full_name === CLI_STRING_TEST)).toMatchObject({ status: 'failed' });
  commit(t.worktree, [CLI_TESTS], 'test(cli): AC-4 a failure thrown as a string');
  writeFiles(t.worktree, { [CLI_SRC]: CLI_STRING_IMPL });
  const green = runGate(t, 'green', control);
  expect(green.code, green.out).toBe(0);
  commit(t.worktree, [CLI_SRC], 'fix(cli): print a non-Error cause by its text');
  expect(runGate(t, 'regression', control).code).toBe(0);
  const carried = (packOf(t)['rework']?.['carried_criteria'] ?? []) as { criterion: string; test_id: string; gate?: string; output_sha256: string }[];
  const evidence: Record<string, unknown>[] = [{ criterion: 'AC-4', test_id: red.tests.find((x) => x.full_name === CLI_STRING_TEST)!.id, gate: 'red', output_sha256: red.sha256 }];
  for (const c of carried) evidence.push({ criterion: c.criterion, test_id: c.test_id, gate: c.gate ?? 'red', output_sha256: c.output_sha256 });
  evidence.push({ criterion: 'AC-5', test_id: CLI_COMPAT_TEST_ID, gate: 'green', output_sha256: green.sha256 });
  const result = {
    schema_version: 1,
    node_id: t.node_id,
    claim_id: t.claim_id,
    dispatch_id: t.dispatch_id,
    outcome: 'SUBMITTED',
    commands: [],
    evidence_paths: [],
    failure_fingerprint: null,
    decision_request: null,
    commit_sha: git(t.worktree, ['rev-parse', 'HEAD']),
    criterion_evidence: evidence,
  };
  mkdirSync(dirname(t.result_slot), { recursive: true });
  writeFileSync(t.result_slot, JSON.stringify(result, null, 2));
  return { red, green };
}

/**
 * One test that proves clauses of AC-3 and AC-4 at once: a journal cut short
 * by a kill is recovered (AC-3), and the failed apply after it is reported
 * without a stack trace, exit 1, nothing committed (AC-4). It fails on the
 * cli's code (its AC-3 part).
 */
export const CLI_SHARED_TEST = 'version recovers a journal a kill cut short, then reports the failed apply after it without a stack trace and commits nothing';
export const CLI_SHARED_BODY = `
test('${CLI_SHARED_TEST}', async () => {
  const files = new Map([['packages/a/package.json', '{"version":"1.0.0"}'], ['.changeset/.version-journal.json', '{"before":[{"path":"packages/a/pack']]);
  const warnings = [];
  const errors = [];
  const calls = [];
  let code;
  try {
    code = await version({ files, changes: [{ path: 'packages/a/package.json', content: '{"version":"2.0.0"}' }], config: { commit: true }, io: { log() {}, warn: (m) => warnings.push(m), error: (m) => errors.push(m) }, git: { add: () => calls.push('add'), commit: () => calls.push('commit') }, format: async () => { throw new Error('formatter crashed'); } });
  } catch (error) {
    code = 'threw ' + error.message;
  }
  assert.ok(warnings.some((w) => /interrupted/.test(w)), 'the interrupted run is recovered with a warning');
  assert.equal(files.has('.changeset/.version-journal.json'), false, 'the cut-short journal is removed');
  assert.equal(code, 1);
  assert.match(errors.join('\\n'), /formatter crashed/);
  assert.doesNotMatch(errors.join('\\n'), /\\n\\s+at /);
  assert.deepEqual(calls, []);
});
`;
export const CLI_SHARED_RED = `${CLI_FAILURE_RED}${CLI_SHARED_BODY}`;

/** The shared test's clauses: AC-3's at its recovery assertions, AC-4's at its failure assertions. */
export function sharedClauses(source: string, testId: string): { 'AC-3': ChallengeClause[]; 'AC-4': ChallengeClause[] } {
  const start = lineOf(source, CLI_SHARED_TEST);
  const warned = lineOf(source, "assert.ok(warnings.some((w) => /interrupted/.test(w)), 'the interrupted run", start);
  const removed = lineOf(source, "assert.equal(files.has('.changeset/.version-journal.json'), false", start);
  const exit = lineOf(source, 'assert.equal(code, 1);', start);
  const stack = lineOf(source, "assert.doesNotMatch(errors.join('\\n'), /\\n\\s+at /);", start);
  const calls = lineOf(source, 'assert.deepEqual(calls, []);', start);
  return {
    'AC-3': [
      { clause: 'AC-3.1', test_id: testId, assertions: [`file:changesets:${CLI_TESTS}#L${removed}`], trace: 'the journal the kill cut short is removed before the run goes on' },
      { clause: 'AC-3.2', test_id: testId, assertions: [`file:changesets:${CLI_TESTS}#L${warned}`], trace: 'a warning containing interrupted' },
    ],
    'AC-4': [
      { clause: 'AC-4.1', test_id: testId, assertions: [`file:changesets:${CLI_TESTS}#L${exit}-L${stack}`], trace: 'exit 1 and the failure printed with no stack line' },
      { clause: 'AC-4.2', test_id: testId, assertions: [`file:changesets:${CLI_TESTS}#L${calls}`], trace: 'neither git add nor git commit ran' },
    ],
  };
}

/** The cli's code as it is (r2's failure reporting): AC-4's reproduction holds there, AC-3's truncated journal does not. */
export { CLI_IMPL };

/** R001 with a refinement verdict override shape kept local: a gap the cli's code fails, for the REFINE scenario. */
export const GAP_AC4_STRING: VerdictOverride = { gap: { ...AC4_STRING_GAP, producer: { node_id: CLI } } };

/** Every event of the feature's events.jsonl, in order. */
export function eventsOf(s: Ver): { type: string; node_id: string | null; data: Record<string, any> }[] {
  return readFileSync(join(s.featureDir, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as { type: string; node_id: string | null; data: Record<string, any> });
}

export const R15_FEATURE = VER_FEATURE;
