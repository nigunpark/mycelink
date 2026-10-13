/**
 * CSET-203 r7's shape on the version fixture: both producers right from
 * their first work (apply-release-plan's rollback restores every file the
 * plan was about to change; the cli recovers a journal cut short by a kill),
 * so every AC-1 gap a reviewer finds there is one the code already passes,
 * and the hidden-like AC-1, AC-3 and AC-5 checks pass on what is delivered.
 *
 * r7: R001 found AC-1 on apply-release-plan (a reproduction the code
 * satisfies) and AC-5 on the cli. The apply-release-plan worker challenged
 * AC-1 and the refinement withdrew it; the cli's compatibility-only rework
 * settled; the compatibility node ran; R002 found AC-1 again, with another
 * reproduction the code satisfies, and its rework of apply-release-plan
 * reopened the cli and the compatibility node. The worker challenged it; the
 * challenge restored apply-release-plan alone; R002's refinement withdrew
 * AC-1 and settled PASS while the cli and the compatibility node were still
 * reopened; the cli was dispatched after that PASS on a fresh branch already
 * holding its own work, and its worker answered BLOCKED
 * INVALID_RED_EVIDENCE: behaviour already present at base. No candidate.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { expect } from 'vitest';
import { git } from './git-fixture.js';
import {
  ARP,
  ARP_FIXED_IMPL,
  ARP_RED,
  ARP_SRC,
  ARP_TESTS,
  CLI,
  CLI_AC5,
  CLI_COMPAT_FILE,
  CLI_COMPAT_TESTS,
  CLI_FAILURE_TEST,
  CLI_JOURNAL_STATUS_TEST,
  CLI_RECOVERY_TEST,
  CLI_SRC,
  CLI_TESTS,
  CLI_TRUNCATED_IMPL,
  CLI_TRUNCATED_RED,
  VER_FEATURE,
  commitVerControl,
  createVer,
  verCli,
  verGraph,
  type Ver,
} from './version-fixture.js';
import { fulfil, packOf, runGate, writeFiles, type ShopTicket } from './shop-worker.js';
import { reviewPacket, verdictFor, writeVerdict, type ReviewTicket, type VerdictOverride } from './review-agent.js';
import { ARP_CRITERIA, GAP_AC5, commitCompat, dispatch, settle, writeResult } from './cset203-rework.js';
import { GAP_AC1_HOLDS, lineOf, type ChallengeClause } from './cset203-challenge.js';

/** R002's AC-1 gap, as r7's reviewer put it: a run that fails after it deleted a changeset — which the code already restores. */
export const AC1_R002_REPRODUCTION =
  'apply a plan that deletes .changeset/one.md and then fails in the formatter on packages/a/package.json; assert .changeset/one.md is back with its exact content, packages/a/package.json holds its exact previous bytes and error.cause is the injected failure';
export const GAP_AC1_R002: VerdictOverride = {
  gap: { missing: 'no test makes the run fail after it deleted a changeset, so restoring a deleted changeset is never asserted', reproduction: AC1_R002_REPRODUCTION, producer: { module: 'changesets:packages/apply-release-plan/src/index.mjs' } },
};

/** The worker's exact focused test of R002's reproduction: it passes on the integrated code. */
export const ARP_R002_TEST = 'restores a changeset it deleted when a later change fails, with the original error as the cause';
export const ARP_R002_BODY = `
test('${ARP_R002_TEST}', async () => {
  const files = new Map([['packages/a/package.json', '{"version":"1.0.0"}'], ['.changeset/one.md', 'one']]);
  const failure = new Error('formatter crashed');
  const plan = [{ path: '.changeset/one.md', content: null }, { path: 'packages/a/package.json', content: '{"version":"2.0.0"}' }];
  const error = await applyReleasePlan(files, plan, { format: async (path) => { if (path === 'packages/a/package.json') throw failure; } }).then(() => null, (e) => e);
  assert.equal(error.cause, failure);
  assert.equal(files.get('.changeset/one.md'), 'one', 'the deleted changeset is back');
  assert.deepEqual([...files].sort(), [['.changeset/one.md', 'one'], ['packages/a/package.json', '{"version":"1.0.0"}']]);
});
`;
export const ARP_R002_RED = `${ARP_RED}${ARP_R002_BODY}`;

/** R002's AC-1 clauses, each traced to the focused test's own assertion lines. */
export function r002Clauses(source: string, testId: string): ChallengeClause[] {
  const start = lineOf(source, ARP_R002_TEST);
  const cause = lineOf(source, 'assert.equal(error.cause, failure);', start);
  const back = lineOf(source, "assert.equal(files.get('.changeset/one.md'), 'one'", start);
  const exact = lineOf(source, "assert.deepEqual([...files].sort(), [['.changeset/one.md', 'one']", start);
  return [
    { clause: 'AC-1.1', test_id: testId, assertions: [`file:changesets:${ARP_TESTS}#L${back}-L${exact}`], trace: 'the changeset the run deleted is back and package.json holds its exact previous bytes after the formatter failure the test injects' },
    { clause: 'AC-1.2', test_id: testId, assertions: [`file:changesets:${ARP_TESTS}#L${cause}`], trace: 'the rejection cause is the injected formatter failure itself' },
  ];
}

/** The cli's first work: AC-3 (a journal cut short by a kill included) and AC-4 in one RED cycle; AC-5 by its existing status test. */
export const CLI_R7_CRITERIA = [
  { criterion: 'AC-3', gate: 'red' as const, full_name: CLI_RECOVERY_TEST },
  { criterion: 'AC-4', gate: 'red' as const, full_name: CLI_FAILURE_TEST },
  CLI_AC5,
];

/** The version graph with the cli independent of apply-release-plan: the two producers' reworks run side by side. */
export function siblingGraph(): Record<string, unknown> {
  const g = verGraph() as { nodes: { id: string; depends_on: string[] }[] };
  for (const n of g.nodes) if (n.id === CLI) n.depends_on = [];
  return g as unknown as Record<string, unknown>;
}

export type R7 = Ver & { first: { arp: ShopTicket; cli: ShopTicket } };

/** Both producers DONE as r7's first workers left them (right), the compatibility node run, R001 settled with `gaps` (default r7's: AC-1 holds, AC-5). */
export async function r7Reviewed(options: { graph?: Record<string, unknown>; gaps?: Record<string, VerdictOverride> } = {}): Promise<R7> {
  const s = await createVer({ review: {}, ...(options.graph !== undefined ? { graph: options.graph } : {}) });
  const a = (await dispatch(s)).ticket!;
  expect(a.node_id).toBe(ARP);
  fulfil(a, { tests: { [ARP_TESTS]: ARP_RED }, impl: { [ARP_SRC]: ARP_FIXED_IMPL }, criteria: ARP_CRITERIA }, s.control);
  expect(await settle(s, a)).toMatchObject({ outcome: 'DONE' });
  commitVerControl(s, 'apply-release-plan');
  const c = (await dispatch(s)).ticket!;
  expect(c.node_id).toBe(CLI);
  fulfil(c, { tests: { [CLI_TESTS]: CLI_TRUNCATED_RED }, impl: { [CLI_SRC]: CLI_TRUNCATED_IMPL }, criteria: CLI_R7_CRITERIA }, s.control);
  expect(await settle(s, c)).toMatchObject({ outcome: 'DONE' });
  commitVerControl(s, 'cli');
  const t = (await dispatch(s)).ticket as unknown as ReviewTicket;
  expect(t).toMatchObject({ kind: 'acceptance-review', review_id: `${VER_FEATURE}-R001` });
  await writeVerdict(t, verdictFor(reviewPacket(t), options.gaps ?? { 'AC-1': GAP_AC1_HOLDS, 'AC-5': GAP_AC5 }), { cwd: s.control });
  const settled = JSON.parse((await verCli(s, ['review', 'settle', VER_FEATURE, '--review', t.review_id, '--capability', t.capability, '--json'])).out) as { outcome: string };
  expect(settled).toMatchObject({ outcome: 'GAPS' });
  commitVerControl(s, 'review R001');
  return Object.assign(s, { first: { arp: a, cli: c } });
}

/**
 * A worker's late answer, written to a ticket's own result slot as it would
 * write it: BLOCKED INVALID_RED_EVIDENCE, behaviour already present (r7's
 * cli). The slot's directory is made when the worktree is gone.
 */
export function writeLateBlocked(t: ShopTicket, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const result = {
    schema_version: 1,
    node_id: t.node_id,
    claim_id: t.claim_id,
    dispatch_id: t.dispatch_id,
    outcome: 'BLOCKED',
    commands: [{ command: ['mycelink', 'tdd', 'red', VER_FEATURE, t.node_id], exit_code: 1 }],
    commit_sha: (() => {
      try {
        return git(t.worktree, ['rev-parse', 'HEAD']);
      } catch {
        return '0'.repeat(40);
      }
    })(),
    changed_paths: [],
    evidence_paths: [],
    failure_fingerprint: `INVALID_RED_EVIDENCE:behaviour already present at base (recovery, failure handling, tests in packages/cli already committed in base)`,
    decision_request: null,
    ...extra,
  };
  mkdirSync(dirname(t.result_slot), { recursive: true });
  writeFileSync(t.result_slot, JSON.stringify(result, null, 2));
  return result;
}

/**
 * The cli's compatibility-only rework, as its worker does it: AC-5's
 * regression test alone in a file of its own, green, regression, the result
 * (the rework's carried proofs cited as given). Returns the result written.
 */
export function compatRework(t: ShopTicket, control: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  writeFiles(t.worktree, { [CLI_COMPAT_TESTS]: CLI_COMPAT_FILE });
  commitCompat(t.worktree, [CLI_COMPAT_TESTS], 'AC-5');
  const green = runGate(t, 'green', control);
  expect(green.code, green.out).toBe(0);
  expect(runGate(t, 'regression', control).code).toBe(0);
  const carried = (packOf(t)['rework']['carried_criteria'] ?? []) as { criterion: string; test_id: string; gate?: string; output_sha256: string }[];
  writeResult(t, [
    ...carried.map((c) => ({ criterion: c.criterion, test_id: c.test_id, gate: c.gate ?? 'red', output_sha256: c.output_sha256 })),
    { criterion: 'AC-5', test_id: green.tests.find((x) => x.full_name === CLI_JOURNAL_STATUS_TEST)!.id, gate: 'green', output_sha256: green.sha256 },
  ]);
  if (Object.keys(extra).length === 0) return JSON.parse(readFileSync(t.result_slot, 'utf8')) as Record<string, unknown>;
  const result = { ...(JSON.parse(readFileSync(t.result_slot, 'utf8')) as Record<string, unknown>), ...extra };
  writeFileSync(t.result_slot, JSON.stringify(result, null, 2));
  return result;
}

/** `review settle` with a ticket's capability, as JSON. */
export async function settleReview(s: Ver, t: Pick<ReviewTicket, 'review_id' | 'capability'>): Promise<Record<string, any>> {
  const r = await verCli(s, ['review', 'settle', VER_FEATURE, '--review', t.review_id, '--capability', t.capability, '--json']);
  try {
    return JSON.parse(r.out) as Record<string, any>;
  } catch {
    return { outcome: 'REFUSED', detail: `${r.out}${r.err}` };
  }
}
