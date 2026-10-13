/**
 * CSET-203 r14's shape on the version fixture.
 *
 * r14 with-normal: R002 found AC-1 on apply-release-plan and AC-3 on the
 * cli, and its atomic rework ordered both producers from R002's original
 * receipt. The apply-release-plan worker challenged AC-1; the refinement
 * withdrew it and R002's receipt moved to R002.refined-1.json. The cli's
 * rework of AC-3 — a gap the refinement left untouched — still carried the
 * order bound to the original receipt; its worker's exact AC-3 reproduction
 * passed, and its challenge was refused twice, REVIEW_CHALLENGE_STALE ("not
 * the receipt this rework was ordered with"): two attempts and a failure
 * count spent on an administrative mismatch, the cli BLOCKED, no candidate.
 *
 * Here the cli's AC-3 gap is one the cli's code already satisfies (a run a
 * kill interrupted, recovered before anything else, one versioning
 * committed), so its exact reproduction passes, as r14's did.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLI, CLI_FAILURE_RED, CLI_TESTS, type Ver } from './version-fixture.js';
import { lineOf, type ChallengeClause } from './cset203-challenge.js';
import type { VerdictOverride } from './review-agent.js';

/** R002's AC-3, as r14's reviewer put it: a reproduction the cli's code already satisfies. */
export const AC3_HOLDS_REPRODUCTION =
  "leave a journal recording packages/a/package.json at 1.0.0 and .changeset/one.md while the disk shows 2.0.0 and the changeset gone; run version with commit enabled; assert the journal's state is restored before anything else, the journal removed, a warning containing interrupted, and exactly one versioning committed";
export const GAP_AC3_HOLDS: VerdictOverride = {
  gap: { missing: "the 'before it reads anything else' ordering is not proved: no recovery test commits a versioning after restoring a journal", reproduction: AC3_HOLDS_REPRODUCTION, producer: { node_id: CLI } },
};

/** The cli worker's exact focused test of that reproduction: it passes on the cli's code. */
export const CLI_AC3_HOLDS_TEST = 'version restores an interrupted run before anything else and commits exactly one versioning';
export const CLI_AC3_HOLDS_BODY = `
test('${CLI_AC3_HOLDS_TEST}', async () => {
  const journal = JSON.stringify({ before: [{ path: 'packages/a/package.json', content: '{"version":"1.0.0"}' }, { path: '.changeset/one.md', content: 'one' }] });
  const files = new Map([['packages/a/package.json', '{"version":"2.0.0"}'], ['.changeset/.version-journal.json', journal]]);
  const warnings = [];
  const calls = [];
  const code = await version({ files, changes: [{ path: 'packages/a/package.json', content: '{"version":"2.0.0"}' }, { path: '.changeset/one.md', content: null }], config: { commit: true }, io: { log() {}, warn: (m) => warnings.push(m), error() {} }, git: { add: (paths) => calls.push(['add', paths]), commit: (message) => calls.push(['commit', message]) } });
  assert.equal(code, 0);
  assert.ok(warnings.some((w) => /interrupted/.test(w)), 'it warns that the last run was interrupted');
  assert.deepEqual([...files], [['packages/a/package.json', '{"version":"2.0.0"}']], 'the journal state restored, then versioned once');
  assert.deepEqual(calls, [['add', ['packages/a/package.json', '.changeset/one.md']], ['commit', 'Version Packages']], 'exactly one versioning committed');
});
`;
/** The cli's test file with that focused test added (its generation's file is CLI_FAILURE_RED). */
export const CLI_AC3_HOLDS_RED = `${CLI_FAILURE_RED}${CLI_AC3_HOLDS_BODY}`;

/** AC-3's two clauses, each traced to the focused test's own assertion lines. */
export function cliAc3Clauses(source: string, testId: string): ChallengeClause[] {
  const start = lineOf(source, CLI_AC3_HOLDS_TEST);
  const warned = lineOf(source, 'assert.ok(warnings.some((w) => /interrupted/.test(w))', start);
  const files = lineOf(source, "assert.deepEqual([...files], [['packages/a/package.json'", start);
  const calls = lineOf(source, "assert.deepEqual(calls, [['add'", start);
  return [
    { clause: 'AC-3.1', test_id: testId, assertions: [`file:changesets:${CLI_TESTS}#L${files}-L${calls}`], trace: 'the journal recorded state is back before the run versions: one versioning of the restored files is committed, the journal gone' },
    { clause: 'AC-3.2', test_id: testId, assertions: [`file:changesets:${CLI_TESTS}#L${warned}-L${files}`], trace: 'a warning containing interrupted, the journal removed and the run versioned normally' },
  ];
}

/** Every event of the feature's events.jsonl, in order. */
export function events(s: Ver): { type: string; node_id: string | null; data: Record<string, any> }[] {
  return readFileSync(join(s.featureDir, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as { type: string; node_id: string | null; data: Record<string, any> });
}

/** A settled review receipt (or a refinement's), as JSON. */
export function receiptAt(s: Ver, rel: string): Record<string, any> {
  return JSON.parse(readFileSync(join(s.control, ...rel.split('/')), 'utf8')) as Record<string, any>;
}
