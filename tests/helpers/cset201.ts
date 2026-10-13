/**
 * CSET-201's final normal arm on the explain fixture, step by step: the
 * controller's own lines, the module-workers and the reviewer held to what
 * their host subagents can do (helpers/shop-worker.ts, helpers/review-agent.ts).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { expect } from 'vitest';
import { git } from './git-fixture.js';
import { commit, fulfil, packOf, runGate, writeFiles, type GateRun, type ShopTicket } from './shop-worker.js';
import { reviewPacket, verdictFor, writeVerdict, type ReviewTicket, type VerdictOverride } from './review-agent.js';
import {
  ASM_GEN0,
  ASM_RED,
  ASM_RED_TEST,
  ASM_SRC,
  ASM_TESTS,
  ASSEMBLE,
  CLI,
  CLI_COMPAT_TEST,
  CLI_GEN0,
  CLI_RED,
  CLI_RED_TEST,
  CLI_SRC,
  CLI_TESTS,
  EXP_FEATURE,
  TYPES,
  TYPES_DECL,
  TYPES_SRC,
  cliTestId,
  commitExpControl,
  expCli,
  type Exp,
} from './explain-fixture.js';

export type Dispatched = { status: string; detail: string; ticket?: ShopTicket & { kind?: string }; controller_reports?: { node_id: string; outcome: string }[] };

export async function dispatch(s: Exp): Promise<Dispatched> {
  return JSON.parse((await expCli(s, ['dispatch', EXP_FEATURE, '--json'])).out) as Dispatched;
}

export async function settle(s: Exp, t: ShopTicket): Promise<{ outcome: string; detail: string; state?: string }> {
  const r = await expCli(s, ['settle', EXP_FEATURE, t.node_id, '--capability', t.capability, '--json']);
  try {
    return JSON.parse(r.out) as { outcome: string; detail: string; state?: string };
  } catch {
    return { outcome: 'REFUSED', detail: `${r.out}${r.err}` };
  }
}

export async function settleReview(s: Exp, t: Pick<ReviewTicket, 'review_id' | 'capability'>): Promise<Record<string, any>> {
  const r = await expCli(s, ['review', 'settle', EXP_FEATURE, '--review', t.review_id, '--capability', t.capability, '--json']);
  try {
    return JSON.parse(r.out) as Record<string, any>;
  } catch {
    return { outcome: 'REFUSED', detail: `${r.out}${r.err}` };
  }
}

export async function featureStatus(s: Exp): Promise<Record<string, any>> {
  return JSON.parse((await expCli(s, ['feature', 'status', EXP_FEATURE, '--json'])).out) as Record<string, any>;
}

/** The next dispatch's ticket, which must be for `node`. */
export async function ticketFor(s: Exp, node: string): Promise<ShopTicket> {
  const d = await dispatch(s);
  expect(d.ticket?.node_id, `${d.status}: ${d.detail}`).toBe(node);
  return d.ticket as ShopTicket;
}

/** The next dispatch, which must hand out review `id` (controller nodes run inside it first). */
export async function reviewTicket(s: Exp, id: string): Promise<ReviewTicket> {
  const d = await dispatch(s);
  const t = d.ticket as unknown as ReviewTicket;
  expect(t, `${d.status}: ${d.detail}`).toMatchObject({ kind: 'acceptance-review', review_id: `${EXP_FEATURE}-${id}` });
  return t;
}

/** Review `id`: the stand-in reviewer's verdict (a traced PASS of every criterion but `gaps`), settled. */
export async function reviewWith(s: Exp, id: string, gaps: Record<string, VerdictOverride>): Promise<{ t: ReviewTicket; settled: Record<string, any> }> {
  const t = await reviewTicket(s, id);
  await writeVerdict(t, verdictFor(reviewPacket(t), gaps), { cwd: s.control });
  const settled = await settleReview(s, t);
  commitExpControl(s, `${t.review_id} settled`);
  return { t, settled };
}

/** Every node's first generation, as the real run's workers left them: types, the planner with its two latent defects, the cli. */
export async function firstGenerations(s: Exp): Promise<void> {
  // The declaration-only node: its declaration change alone, committed, then green and regression (it has no red gate).
  const types = await ticketFor(s, TYPES);
  writeFiles(types.worktree, { [TYPES_SRC]: TYPES_DECL });
  commit(types.worktree, [TYPES_SRC], 'types: ReleaseReason and ComprehensiveRelease.reasons');
  const green = runGate(types, 'green', s.control);
  expect(green.code, green.out).toBe(0);
  expect(runGate(types, 'regression', s.control).code).toBe(0);
  writeResult(types, [{ criterion: 'AC-1', gate: 'green', output_sha256: green.sha256 as string }]);
  const typed = await settle(s, types);
  expect(typed, typed.detail).toMatchObject({ outcome: 'DONE' });
  commitExpControl(s, 'types');
  const asm = await ticketFor(s, ASSEMBLE);
  fulfil(asm, { tests: { [ASM_TESTS]: ASM_RED }, impl: { [ASM_SRC]: ASM_GEN0 }, criteria: [{ criterion: 'AC-2', gate: 'red', full_name: ASM_RED_TEST }] }, s.control);
  const planned = await settle(s, asm);
  expect(planned, planned.detail).toMatchObject({ outcome: 'DONE' });
  commitExpControl(s, 'assemble');
  const cli = await ticketFor(s, CLI);
  fulfil(cli, { tests: { [CLI_TESTS]: CLI_RED }, impl: { [CLI_SRC]: CLI_GEN0 }, criteria: [{ criterion: 'AC-3', gate: 'red', full_name: CLI_RED_TEST }, { criterion: 'AC-4', gate: 'green', test_id: cliTestId(CLI_COMPAT_TEST) }] }, s.control);
  const explained = await settle(s, cli);
  expect(explained, explained.detail).toMatchObject({ outcome: 'DONE' });
  commitExpControl(s, 'cli');
}

/** A proof as the pack gives it, cited exactly so. */
export function cite(p: { criterion: string; test_id: string; gate?: string; output_sha256: string }): Record<string, unknown> {
  return { criterion: p.criterion, test_id: p.test_id, gate: p.gate ?? 'red', output_sha256: p.output_sha256 };
}

/** The worker's result: SUBMITTED at the worktree's head with `evidence`. */
export function writeResult(t: ShopTicket, evidence: Record<string, unknown>[]): Record<string, unknown> {
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
  return result;
}

export interface Reproof {
  red: GateRun;
  green: GateRun;
  regression: GateRun;
  /** The reproduction's tests as the red gate passed them on the unchanged base. */
  tests: { id: string; full_name: string }[];
}

/**
 * A completed criterion ordered again, re-proved as the protocol allows: the review's exact reproduction written in the
 * node's own test file, one red gate ("all pass on the unchanged base"), the file put back as the base holds it (the
 * reproduction is kept out of the branch), green, regression.
 */
export function reprove(t: ShopTicket, control: string, file: string, body: string, names: readonly string[]): Reproof {
  writeFiles(t.worktree, { [file]: body });
  const red = runGate(t, 'red', control);
  expect(red.code, red.out).not.toBe(0);
  expect(red.out).toMatch(/all pass on the unchanged base/i);
  const tests = names.map((name) => red.tests.find((x) => x.full_name === name && x.status === 'passed'));
  expect(tests.every((x) => x !== undefined), red.out).toBe(true);
  git(t.worktree, ['checkout', '--', file]);
  const green = runGate(t, 'green', control);
  expect(green.code, green.out).toBe(0);
  const regression = runGate(t, 'regression', control);
  expect(regression.code, regression.out).toBe(0);
  return { red, green, regression, tests: tests as { id: string; full_name: string }[] };
}

/** The completed proof of `criterion` the rework's pack gives. */
export function completedProof(t: ShopTicket, criterion: string): { criterion: string; test_id: string; gate?: string; output_sha256: string } {
  const completed = ((packOf(t)['rework']?.['completed_criteria'] ?? []) as { criterion: string; test_id: string; gate?: string; output_sha256: string }[]).filter((c) => c.criterion === criterion);
  expect(completed, JSON.stringify(packOf(t)['rework'] ?? null)).toHaveLength(1);
  return completed[0] as { criterion: string; test_id: string; gate?: string; output_sha256: string };
}

/** A dependent reopened by its upstream's rework, re-verified on the new head: green and regression, its RED recorded cited for AC-3, the status test for AC-4. */
export function reverifyCli(t: ShopTicket, control: string): void {
  const green = runGate(t, 'green', control);
  expect(green.code, green.out).toBe(0);
  const regression = runGate(t, 'regression', control);
  expect(regression.code, regression.out).toBe(0);
  const red = (packOf(t)['latest_evidence'] as { kind: string; output_sha256?: string }[]).find((e) => e.kind === 'red')?.output_sha256 as string;
  writeResult(t, [
    { criterion: 'AC-3', test_id: cliTestId(CLI_RED_TEST), gate: 'red', output_sha256: red },
    { criterion: 'AC-4', test_id: cliTestId(CLI_COMPAT_TEST), gate: 'green', output_sha256: green.sha256 as string },
  ]);
}
