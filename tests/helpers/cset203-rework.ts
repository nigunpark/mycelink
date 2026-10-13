/**
 * CSET-203's acceptance-review rework, step by step on the version fixture:
 * both producers settled as r2/r3's workers left them, the compatibility
 * node run, R001 settled with the gaps a test names; the reworked
 * apply-release-plan repaired. Shared by the rework, compatibility-unit and
 * generation-evidence tests.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { expect } from 'vitest';
import { git } from './git-fixture.js';
import {
  ARP,
  ARP_CHANGELOG_TEST,
  ARP_FIXED_IMPL,
  ARP_GAPPY_IMPL,
  ARP_JOURNAL_TEST,
  ARP_RED,
  ARP_REVIEW_RED,
  ARP_ROLLBACK_TEST,
  ARP_SRC,
  ARP_TESTS,
  CLI,
  CLI_AC5,
  CLI_FAILURE_TEST,
  CLI_FULL_WORK,
  CLI_RECOVERY_TEST,
  COMPAT,
  VER_FEATURE,
  commitVerControl,
  createVer,
  verCli,
  type Ver,
} from './version-fixture.js';
import { fulfil, packOf, type CriterionItem, type ShopTicket } from './shop-worker.js';
import { reviewPacket, verdictFor, writeVerdict, type ReviewTicket, type VerdictOverride } from './review-agent.js';

export type Dispatched = { status: string; detail: string; ticket?: ShopTicket & { kind?: string }; controller_reports?: { node_id: string; outcome: string }[] };

export async function dispatch(s: Ver): Promise<Dispatched> {
  return JSON.parse((await verCli(s, ['dispatch', VER_FEATURE, '--json'])).out) as Dispatched;
}
export async function settle(s: Ver, t: ShopTicket): Promise<{ outcome: string; detail: string; state?: string }> {
  const r = await verCli(s, ['settle', VER_FEATURE, t.node_id, '--capability', t.capability, '--json']);
  try {
    return JSON.parse(r.out) as { outcome: string; detail: string; state?: string };
  } catch {
    return { outcome: 'REFUSED', detail: `${r.out}${r.err}` };
  }
}
/** `tdd check`: the result in the slot judged as settle will (criterion evidence, and the history with its claim). */
export async function check(s: Ver, t: ShopTicket): Promise<Record<string, any>> {
  return JSON.parse((await verCli(s, ['tdd', 'check', VER_FEATURE, t.node_id, '--capability', t.capability, '--json'])).out) as Record<string, any>;
}
export async function status(s: Ver): Promise<Record<string, any>> {
  return JSON.parse((await verCli(s, ['feature', 'status', VER_FEATURE, '--json'])).out) as Record<string, any>;
}

export const ARP_CRITERIA: CriterionItem[] = [
  { criterion: 'AC-1', gate: 'red', full_name: ARP_ROLLBACK_TEST },
  { criterion: 'AC-2', gate: 'red', full_name: ARP_JOURNAL_TEST },
];
export const CLI_CRITERIA: CriterionItem[] = [
  { criterion: 'AC-3', gate: 'red', full_name: CLI_RECOVERY_TEST },
  { criterion: 'AC-4', gate: 'red', full_name: CLI_FAILURE_TEST },
  CLI_AC5,
];

export const GAP_AC1: VerdictOverride = { gap: { missing: 'no test fails the changelog write after the package/version writes', reproduction: 'inject changelog writer failure after package/version writes and assert exact rollback', producer: { node_id: ARP } } };
export const GAP_AC3: VerdictOverride = { gap: { missing: 'a journal cut short by a kill is never recovered from', reproduction: 'leave a truncated, unparseable journal in .changeset, run version, and assert it warns interrupted, removes the journal and versions once', producer: { node_id: CLI } } };
export const GAP_AC5: VerdictOverride = { gap: { missing: 'no regression evidence runs status with a journal present in .changeset', reproduction: 'put .changeset/.version-journal.json beside a changeset, run status, and assert the journal is not listed', producer: { node_id: COMPAT } }, untested: ['AC-5.2'] };

/** Both producers DONE, the compatibility node run, R001 settled with `gaps` (under `review`, the default policy if none); `first` keeps the producers' tickets of generation 0. */
export async function reviewed(gaps: Record<string, VerdictOverride>, review: { max_rounds?: number; criterion_ceiling?: number } = {}): Promise<Ver & { first: { arp: ShopTicket; cli: ShopTicket } }> {
  const s = await createVer({ review });
  const a = (await dispatch(s)).ticket!;
  fulfil(a, { tests: { [ARP_TESTS]: ARP_RED }, impl: { [ARP_SRC]: ARP_GAPPY_IMPL }, criteria: ARP_CRITERIA }, s.control);
  expect(await settle(s, a)).toMatchObject({ outcome: 'DONE' });
  commitVerControl(s, 'apply-release-plan');
  const c = (await dispatch(s)).ticket!;
  fulfil(c, { ...CLI_FULL_WORK, criteria: CLI_CRITERIA }, s.control);
  expect(await settle(s, c)).toMatchObject({ outcome: 'DONE' });
  commitVerControl(s, 'cli');
  const t = (await dispatch(s)).ticket as unknown as ReviewTicket;
  expect(t).toMatchObject({ kind: 'acceptance-review' });
  await writeVerdict(t, verdictFor(reviewPacket(t), gaps), { cwd: s.control });
  const settled = JSON.parse((await verCli(s, ['review', 'settle', VER_FEATURE, '--review', t.review_id, '--capability', t.capability, '--json'])).out) as { outcome: string };
  expect(settled).toMatchObject({ outcome: 'GAPS' });
  commitVerControl(s, 'review R001');
  return Object.assign(s, { first: { arp: a, cli: c } });
}

/** A carried proof as the pack gives it, cited exactly so. */
export function carriedItems(t: ShopTicket): Record<string, unknown>[] {
  const carried = (packOf(t)['rework']?.['carried_criteria'] ?? []) as { criterion: string; test_id: string; gate?: string; output_sha256: string }[];
  return carried.map((c) => ({ criterion: c.criterion, test_id: c.test_id, gate: c.gate ?? 'red', output_sha256: c.output_sha256 }));
}

/** The reworked apply-release-plan's worker: AC-1's focused RED and the fix; AC-2 keeps its proof. */
export async function repairArp(s: Ver): Promise<void> {
  const t = (await dispatch(s)).ticket!;
  expect(t.node_id).toBe(ARP);
  const run = fulfil(t, { tests: { [ARP_TESTS]: ARP_REVIEW_RED }, impl: { [ARP_SRC]: ARP_FIXED_IMPL }, criteria: [{ criterion: 'AC-1', gate: 'red', full_name: ARP_CHANGELOG_TEST }] }, s.control);
  const result = run.result as { criterion_evidence: Record<string, unknown>[] };
  result.criterion_evidence.push(...carriedItems(t).filter((c) => c['criterion'] === 'AC-2'));
  writeFileSync(t.result_slot, JSON.stringify(result, null, 2));
  const done = await settle(s, t);
  expect(done, done.detail).toMatchObject({ outcome: 'DONE' });
  commitVerControl(s, 'apply-release-plan repaired');
}

/** Commit `paths` alone with the compatibility trailer for `criteria`. */
export function commitCompat(worktree: string, paths: string[], criteria: string): string {
  git(worktree, ['add', '--', ...paths]);
  git(worktree, ['commit', '-q', '-m', `test(cli): ${criteria} status beside a journal`, '-m', `Mycelink-Compatibility: ${criteria}`]);
  return git(worktree, ['rev-parse', 'HEAD']);
}

/** The worker's result: SUBMITTED at the worktree's head, with `evidence` and, when given, its `tdd` claim. */
export function writeResult(t: ShopTicket, evidence: Record<string, unknown>[], tdd?: Record<string, unknown>): void {
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
    ...(tdd !== undefined ? { tdd } : {}),
  };
  mkdirSync(dirname(t.result_slot), { recursive: true });
  writeFileSync(t.result_slot, JSON.stringify(result, null, 2));
}

/** The worker's own tdd claim, read from its branch: one cycle per entry of `cycles` (commit indexes into base..HEAD). */
export function tddClaim(t: ShopTicket, cycles: { red: number[]; green: number[] }[]): Record<string, unknown> {
  const base = packOf(t)['tdd']['base_sha'] as string;
  const chain = git(t.worktree, ['rev-list', '--reverse', `${base}..HEAD`]).split('\n').filter(Boolean);
  return { base_sha: base, head_sha: git(t.worktree, ['rev-parse', 'HEAD']), cycles: cycles.map((c) => ({ red_commits: c.red.map((i) => chain[i]), green_commits: c.green.map((i) => chain[i]) })) };
}
