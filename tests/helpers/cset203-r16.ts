/**
 * CSET-203 r16's fault arm on the version fixture.
 *
 * r16 with-faults (trusted, controller authority recovered): a teammate's
 * commit landed on main while apply-release-plan's first worker worked, and
 * the integration merged it. The cli's first generation settled AC-3 (a RED
 * failing for the missing recovery, then the fix), AC-4 and AC-5. R001's first
 * reviewer was interrupted with its host (the session killed at 600 s) and
 * re-issued; R001 found AC-1 on apply-release-plan (a reproduction its code
 * already satisfied), AC-3 on the cli (its tests too narrow: a coverage gap
 * the cli's code already satisfied) and AC-5. apply-release-plan challenged
 * AC-1; the refinement withdrew it and rebased the cli's order, untouched, to
 * revision 1. The cli's worker found R001's AC-3 reproduction passing on the
 * head its first generation completed, kept it out of the branch and
 * committed AC-5's compatibility unit: 0 cycles, 1 compatibility unit. Settle
 * asked the node for a RED of its own and charged INVALID_RED_EVIDENCE twice:
 * BLOCKED, no candidate. Duplicate and stale replays of the first settle were
 * idempotent; the late defect did not apply (nothing was delivered).
 *
 * Here the same, step by step, as the fault arm should have gone.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { expect } from 'vitest';
import { git } from './git-fixture.js';
import {
  ARP,
  ARP_FIXED_IMPL,
  ARP_RED,
  ARP_SRC,
  ARP_TESTS,
  CLI,
  CLI_COMPAT_FILE,
  CLI_COMPAT_TESTS,
  CLI_JOURNAL_STATUS_TEST,
  CLI_SRC,
  CLI_TESTS,
  CLI_TRUNCATED_IMPL,
  CLI_TRUNCATED_RED,
  VER_FEATURE,
  commitVerControl,
  createVer,
  verCli,
  verState,
  type Ver,
} from './version-fixture.js';
import { fulfil, packOf, runGate, writeFiles, type GateRun, type ShopTicket } from './shop-worker.js';
import { REVIEWER, refinementFor, reviewPacket, verdictFor, writeVerdict, type ReviewTicket, type VerdictOverride } from './review-agent.js';
import { ARP_CRITERIA, GAP_AC5, commitCompat, dispatch, settle } from './cset203-rework.js';
import { GAP_AC1_HOLDS, writeChallenge } from './cset203-challenge.js';
import { CLI_R7_CRITERIA, settleReview } from './cset203-r7.js';
import { AC3_HOLDS_REPRODUCTION, CLI_AC3_HOLDS_BODY, CLI_AC3_HOLDS_TEST, GAP_AC3_HOLDS } from './cset203-r14.js';
import { agentToolCall, claudeSession, launchAgent, type ClaudeSession, type LaunchedAgent } from './claude-session.js';

export { AC3_HOLDS_REPRODUCTION, CLI_AC3_HOLDS_TEST, GAP_AC3_HOLDS };

export const R001 = `${VER_FEATURE}-R001`;
export const R002 = `${VER_FEATURE}-R002`;

/** The fault arm's concurrent commit: the teammate's notes, on main. */
export const TEAM_NOTES = 'TEAM-NOTES.md';
export const TEAMMATE = 'Platform Teammate <teammate@workspace.invalid>';

/** A teammate's commit on the repository's main branch (its checkout), as the fault arm lands one: its sha. */
export function teammateCommit(s: Ver, files: Record<string, string>, message = 'docs: team notes'): string {
  writeFiles(s.repo, files);
  git(s.repo, ['add', '--', ...Object.keys(files)]);
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Platform Teammate', GIT_AUTHOR_EMAIL: 'teammate@workspace.invalid', GIT_COMMITTER_NAME: 'Platform Teammate', GIT_COMMITTER_EMAIL: 'teammate@workspace.invalid', GIT_CONFIG_NOSYSTEM: '1', HOME: s.repo };
  execFileSync('git', ['commit', '-q', '-m', message], { cwd: s.repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  return git(s.repo, ['rev-parse', 'HEAD']);
}

/** R001 as r16's: AC-1 (apply-release-plan's code satisfies it), AC-3 (a coverage gap the cli's code satisfies) and AC-5. */
export const R16_GAPS: Record<string, VerdictOverride> = { 'AC-1': GAP_AC1_HOLDS, 'AC-3': GAP_AC3_HOLDS, 'AC-5': GAP_AC5 };

/** The cli's tests as its first generation left them, with R001's exact AC-3 reproduction added (it passes on the cli's code). */
export const CLI_R16_REPRODUCTION = `${CLI_TRUNCATED_RED}${CLI_AC3_HOLDS_BODY}`;

export type R16 = Ver & { teammate: string; first: { arp: ShopTicket; cli: ShopTicket }; reviewer: { interrupted: string | null } };

/** A holder whose process is gone: what a launch record says of a host session that ended (the fault arm's kill). */
export function deadHolder(): Record<string, unknown> {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8', windowsHide: true });
  return { pid: Number(r.stdout), start: 'ended', boot: null, host: hostname(), platform: process.platform };
}

/** The host launches the reviewer with the ticket's prompt, through the plugin's hook, as /mycelink:run says. */
export async function launchReviewer(host: ClaudeSession, t: ReviewTicket): Promise<LaunchedAgent> {
  const { agent, hook } = await launchAgent(host, { subagent_type: REVIEWER, description: `acceptance review ${t.review_id}`, prompt: t.prompt });
  expect(hook?.code, hook?.err).toBe(0);
  agentToolCall(host, agent, 'Read', { file_path: t.packet_path }, readFileSync(t.packet_path, 'utf8').slice(0, 400));
  return agent;
}

/** The launch record of a reviewer, its holder replaced: the session that launched it ended. */
export function endHost(t: ReviewTicket, a: LaunchedAgent): void {
  const file = join(t.result_slot, '..', `launch-${a.toolUseId}.json`);
  writeFileSync(file, JSON.stringify({ ...(JSON.parse(readFileSync(file, 'utf8')) as object), holder: deadHolder() }, null, 2) + '\n');
}

/**
 * Both producers' first generations (the teammate's commit landing on main while apply-release-plan's worker
 * works), the compatibility node, and R001 — its first reviewer interrupted with its host, the re-issued one
 * finding r16's gaps.
 */
export async function r16Reviewed(options: { interruptReviewer?: boolean; gaps?: Record<string, VerdictOverride> } = {}): Promise<R16> {
  const s = await createVer({ review: {} });
  const a = (await dispatch(s)).ticket!;
  expect(a.node_id).toBe(ARP);
  // The fault arm's concurrent commit, at the first worker's first commit: on main, outside every worktree.
  const teammate = teammateCommit(s, { [TEAM_NOTES]: '# Team notes\n\nRelease freeze starts Friday.\n' });
  fulfil(a, { tests: { [ARP_TESTS]: ARP_RED }, impl: { [ARP_SRC]: ARP_FIXED_IMPL }, criteria: ARP_CRITERIA }, s.control);
  const arp = await settle(s, a);
  expect(arp, arp.detail).toMatchObject({ outcome: 'DONE' });
  commitVerControl(s, 'apply-release-plan');
  // The integration merged the teammate's commit: it is in every later node's base.
  expect(git(s.repo, ['merge-base', '--is-ancestor', teammate, `feature/${VER_FEATURE}`]) === '').toBe(true);
  const c = (await dispatch(s)).ticket!;
  expect(c.node_id).toBe(CLI);
  fulfil(c, { tests: { [CLI_TESTS]: CLI_TRUNCATED_RED }, impl: { [CLI_SRC]: CLI_TRUNCATED_IMPL }, criteria: CLI_R7_CRITERIA }, s.control);
  const cli = await settle(s, c);
  expect(cli, cli.detail).toMatchObject({ outcome: 'DONE' });
  commitVerControl(s, 'cli');
  let t = (await dispatch(s)).ticket as unknown as ReviewTicket;
  expect(t).toMatchObject({ kind: 'acceptance-review', review_id: R001 });
  let interrupted: string | null = null;
  if (options.interruptReviewer !== false) {
    // The session that launched R001's reviewer is killed: the reviewer is LOST, its generation re-issued, nothing spent.
    const host = claudeSession(s.control);
    const agent = await launchReviewer(host, t);
    endHost(t, agent);
    const lost = await settleReview(s, t);
    expect(lost, JSON.stringify(lost)).toMatchObject({ outcome: 'REVIEWER_INTERRUPTED', lifecycle: 'LOST' });
    interrupted = t.dispatch_id;
    t = (await dispatch(s)).ticket as unknown as ReviewTicket;
    expect(t).toMatchObject({ kind: 'acceptance-review', review_id: R001, attempt: 2 });
  }
  await writeVerdict(t, verdictFor(reviewPacket(t), options.gaps ?? R16_GAPS), { cwd: s.control });
  const settled = await settleReview(s, t);
  expect(settled, JSON.stringify(settled)).toMatchObject({ outcome: 'GAPS' });
  commitVerControl(s, 'review R001');
  return Object.assign(s, { teammate, first: { arp: a, cli: c }, reviewer: { interrupted } });
}

/** A worktree's head, or zeros once settle removed it (a late answer). */
function headOf(worktree: string): string {
  try {
    return git(worktree, ['rev-parse', 'HEAD']);
  } catch {
    return '0'.repeat(40);
  }
}

/** A per-criterion (schema_version 2) or legacy (schema_version 1, SUBMITTED) result at the worktree's head, in the ticket's slot. */
export function writeAnswer(t: ShopTicket, answer: { criteria?: Record<string, unknown>[]; evidence: Record<string, unknown>[]; changed?: string[]; extra?: Record<string, unknown> }): Record<string, unknown> {
  const v2 = answer.criteria !== undefined;
  const result = {
    schema_version: v2 ? 2 : 1,
    node_id: t.node_id,
    claim_id: t.claim_id,
    dispatch_id: t.dispatch_id,
    outcome: v2 ? 'CRITERIA' : 'SUBMITTED',
    commands: [{ command: ['mycelink', 'tdd', 'red'], exit_code: 1 }, { command: ['mycelink', 'tdd', 'green'], exit_code: 0 }],
    commit_sha: headOf(t.worktree),
    changed_paths: answer.changed ?? [CLI_COMPAT_TESTS],
    evidence_paths: [],
    failure_fingerprint: null,
    decision_request: null,
    ...(v2 ? { criteria: answer.criteria } : {}),
    criterion_evidence: answer.evidence,
    ...(answer.extra ?? {}),
  };
  mkdirSync(dirname(t.result_slot), { recursive: true });
  writeFileSync(t.result_slot, JSON.stringify(result, null, 2));
  return result;
}

export interface Continuation {
  red: GateRun;
  green: GateRun;
  regression: GateRun;
  /** R001's AC-3 reproduction as the red gate ran it (it passed). */
  reproof: { test_id: string; sha256: string };
  compat: { test_id: string; sha256: string };
}

/**
 * The cli's continuation exactly as r16's worker did it: R001's AC-3 reproduction (in the cli's own test file) and
 * AC-5's regression test (in a file of its own), one red gate — every declared test passes, "the RED does not fail";
 * the reproduction kept out of the branch, AC-5's test committed alone with its trailer, green, regression.
 */
export function compatContinuation(t: ShopTicket, control: string): Continuation {
  expect(t.node_id).toBe(CLI);
  writeFiles(t.worktree, { [CLI_TESTS]: CLI_R16_REPRODUCTION, [CLI_COMPAT_TESTS]: CLI_COMPAT_FILE });
  const red = runGate(t, 'red', control);
  expect(red.code, red.out).not.toBe(0);
  expect(red.out).toMatch(/all pass on the unchanged base/i);
  const reproof = red.tests.find((x) => x.full_name === CLI_AC3_HOLDS_TEST && x.status === 'passed');
  expect(reproof, red.out).toBeDefined();
  // The reproduction stays out of the branch: the cli's test file back as its base holds it.
  git(t.worktree, ['checkout', '--', CLI_TESTS]);
  commitCompat(t.worktree, [CLI_COMPAT_TESTS], 'AC-5');
  const green = runGate(t, 'green', control);
  expect(green.code, green.out).toBe(0);
  const regression = runGate(t, 'regression', control);
  expect(regression.code, regression.out).toBe(0);
  const compat = green.tests.find((x) => x.full_name === CLI_JOURNAL_STATUS_TEST);
  expect(compat, green.out).toBeDefined();
  return { red, green, regression, reproof: { test_id: (reproof as { id: string }).id, sha256: red.sha256 as string }, compat: { test_id: (compat as { id: string }).id, sha256: green.sha256 as string } };
}

/** The pack's rework object of a ticket. */
export function reworkOf(t: ShopTicket): Record<string, any> {
  return packOf(t)['rework'] as Record<string, any>;
}

/** A proof as the pack gives it, cited exactly so. */
export function cite(p: { criterion: string; test_id: string; gate?: string; output_sha256: string }): Record<string, unknown> {
  return { criterion: p.criterion, test_id: p.test_id, gate: p.gate ?? 'red', output_sha256: p.output_sha256 };
}

/**
 * r16's continuation answered as the protocol allows now: AC-3 DONE by its completed proof (rework.completed_criteria)
 * and the reproduction its red gate passed (the re-proof), AC-5 DONE by its unit, AC-4's carried proof cited as given.
 */
export function reproofAnswer(t: ShopTicket, run: Continuation, options: { legacy?: boolean } = {}): Record<string, unknown> {
  const rework = reworkOf(t);
  const completed = ((rework['completed_criteria'] ?? []) as { criterion: string; test_id: string; gate?: string; output_sha256: string }[]).filter((c) => c.criterion === 'AC-3');
  expect(completed, JSON.stringify(rework)).toHaveLength(1);
  const carried = (rework['carried_criteria'] ?? []) as { criterion: string; test_id: string; gate?: string; output_sha256: string }[];
  const evidence = [
    cite(completed[0] as { criterion: string; test_id: string; output_sha256: string }),
    { criterion: 'AC-3', test_id: run.reproof.test_id, gate: 'red', output_sha256: run.reproof.sha256 },
    ...carried.map(cite),
    { criterion: 'AC-5', test_id: run.compat.test_id, gate: 'green', output_sha256: run.compat.sha256 },
  ];
  return options.legacy === true
    ? writeAnswer(t, { evidence })
    : writeAnswer(t, { criteria: [{ criterion: 'AC-3', outcome: 'DONE' }, { criterion: 'AC-5', outcome: 'DONE' }], evidence });
}

/** r16's own answer, as its third attempt wrote it: AC-3 BLOCKED with its reason, AC-5 DONE, AC-4's carried proof cited. */
export function r16Answer(t: ShopTicket, run: Continuation): Record<string, unknown> {
  const carried = (reworkOf(t)['carried_criteria'] ?? []) as { criterion: string; test_id: string; gate?: string; output_sha256: string }[];
  return writeAnswer(t, {
    criteria: [
      {
        criterion: 'AC-3',
        outcome: 'BLOCKED',
        reason: "AC-3's reproduction passes on the unchanged base (red gate: all declared tests passed), so it is a review-gap challenge. The challenge cannot be bound beside AC-5's compatibility unit; the focused AC-3 test is kept out of the branch.",
      },
      { criterion: 'AC-5', outcome: 'DONE' },
    ],
    evidence: [{ criterion: 'AC-5', test_id: run.compat.test_id, gate: 'green', output_sha256: run.compat.sha256 }, ...carried.map(cite)],
  });
}

/** Every event of the feature's events.jsonl, in order. */
export function eventsOf(s: Ver): { type: string; node_id: string | null; data: Record<string, any> }[] {
  return readFileSync(join(s.featureDir, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as { type: string; node_id: string | null; data: Record<string, any> });
}

/** Nothing charged for administration anywhere: no failure fingerprint on any node, no decision asked. */
export function nothingCharged(s: Ver): void {
  for (const [id, rt] of Object.entries(verState(s).nodes as Record<string, any>)) expect(rt.failure_counts, id).toEqual({});
  expect(verState(s).pending_decisions).toEqual([]);
}

/** The cli's completion records, by criterion, oldest first. */
export function ledgerOf(s: Ver, node = CLI): Record<string, any>[] {
  return (verState(s).nodes[node].criterion_ledger ?? []) as Record<string, any>[];
}

/** The sibling's AC-1 challenged, R001's refinement withdrawing it (r16's): the cli's order rebased, untouched, to revision 1. */
export async function withdrawSibling(s: R16): Promise<void> {
  await siblingChallengeWithdrawn(
    s,
    (t) => writeChallenge(t, s.control),
    async (rr) => {
      await writeVerdict(rr, refinementFor(reviewPacket(rr), { 'AC-1': { decision: 'WITHDRAW' } }), { cwd: s.control });
      const refined = await settleReview(s, rr);
      expect(refined, JSON.stringify(refined)).toMatchObject({ outcome: 'GAPS', refinement: { decisions: [{ criterion: 'AC-1', decision: 'WITHDRAW' }] } });
    },
  );
}

/** R001's refinement over the sibling's AC-1 challenge, and the cli's order rebased to it. */
export async function siblingChallengeWithdrawn(s: R16, challenge: (t: ShopTicket) => void, refine: (rr: ReviewTicket) => Promise<void>): Promise<void> {
  const t = (await dispatch(s)).ticket!;
  expect(t.node_id).toBe(ARP);
  challenge(t);
  const challenged = await settle(s, t);
  expect(challenged, challenged.detail).toMatchObject({ outcome: 'REVIEW_CHALLENGED' });
  commitVerControl(s, 'apply-release-plan: AC-1 challenged');
  const d = await dispatch(s);
  const rr = d.ticket as unknown as ReviewTicket;
  expect(rr, d.detail).toMatchObject({ review_id: R001, refinement: { round: 1 } });
  await refine(rr);
  commitVerControl(s, 'R001 refined');
}
