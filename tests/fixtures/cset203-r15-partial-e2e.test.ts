/**
 * CSET-203 r15 with-normal, model-free, to the delivery it should have
 * reached (every platform).
 *
 * r15: the constraint audit's gates held and the run was trusted, with no
 * controller violation. R001 found AC-3, AC-4 and AC-5 and routed all three to
 * the cli as one order. Its worker ran one red gate over the review's exact
 * AC-3 and AC-4 reproductions: AC-3's failed — a real gap — and AC-4's passed
 * on the unchanged base. It fixed AC-3 test-first and committed AC-5's
 * compatibility-regression unit. It could not challenge AC-4 (the challenge
 * line refused because the same red gate had failed AC-3's test) and could
 * not submit (AC-4 had no honest RED), so it answered NEEDS_DECISION, asking
 * how to close AC-4: one product attempt, automation stopped, no candidate.
 * An orchestration overconstraint: one rework unit needed one outcome for all
 * of its criteria. Here:
 *
 *  1. R001: AC-3 (a journal a kill cut short), AC-4 (one the cli's code
 *     satisfies) and AC-5, the cli's one order;
 *  2. the cli's worker exactly as r15's: one red gate (AC-3's test fails,
 *     AC-4's passes), AC-3's fix, AC-5's unit, then one per-criterion answer:
 *     AC-3 DONE, AC-4 REVIEW_GAP_CHALLENGE, AC-5 DONE — no person asked;
 *  3. settle integrates AC-3's and AC-5's work as the cli's new DONE
 *     generation and records AC-4's challenge; R001 CHALLENGED; one product
 *     attempt for the execution;
 *  4. the compatibility node runs on the new work; a fresh reviewer refines
 *     AC-4 alone — WITHDRAW: nothing is ordered again (AC-3 and AC-5 kept);
 *  5. R002 PASS; C001 delivered and accepted; the hidden-like AC-3, AC-4 and
 *     AC-5 checks pass; trusted and verified.
 *
 * The second test: the refinement REFINEs AC-4 to a reproduction the cli
 * fails (a failure thrown as a bare string): only AC-4 is ordered again, from
 * the generation that holds AC-3's and AC-5's work; its focused RED fails,
 * its fix settles; R002 PASS; C001 delivered.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { git } from '../helpers/git-fixture.js';
import { CLI, COMPAT, VER_CANDIDATE, VER_FEATURE, VER_R3_ACCEPTANCE, commitVerControl, verCli, verState, type Ver } from '../helpers/version-fixture.js';
import { refinementFor, reviewPacket, verdictFor, writeVerdict, type ReviewTicket } from '../helpers/review-agent.js';
import { dispatch, settle, status } from '../helpers/cset203-rework.js';
import { settleReview } from '../helpers/cset203-r7.js';
import { VER_AC4_ACCEPTANCE } from '../helpers/cset203-r11.js';
import { reworkOf } from '../helpers/cset203-challenge.js';
import { AC4_STRING_REPRODUCTION, REFINE_AC4, VER_AC4_STRING_ACCEPTANCE, checkFor, eventsOf, mixedWork, r15Result, r15Reviewed, refinedAc4Work } from '../helpers/cset203-r15.js';
import { createHash } from 'node:crypto';

afterAll(() => cleanupTmpRoots());

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const R001 = `${VER_FEATURE}-R001`;
const R002 = `${VER_FEATURE}-R002`;
const C1 = `${R001}-C1`;

function acceptance(repo: string, sha: string, script: string): { code: number; out: string } {
  const at = join(makeTmpDir('cset203-r15-hidden-like-'), 'checkout');
  git(repo, ['worktree', 'add', '--detach', at, sha]);
  try {
    const file = join(makeTmpDir('cset203-r15-script-'), 'acceptance.mjs');
    writeFileSync(file, script);
    const r = spawnSync(process.execPath, [file, at], { encoding: 'utf8' });
    return { code: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
  } finally {
    git(repo, ['worktree', 'remove', '--force', at]);
  }
}

/** Nothing administrative charged anywhere: no refusal fingerprint, no decision asked, no challenge refused. */
function nothingAdministrative(s: Ver): void {
  expect(eventsOf(s).filter((e) => e.type === 'decision.requested' || e.type === 'review.challenge_refused')).toEqual([]);
  expect(verState(s).pending_decisions).toEqual([]);
  for (const [id, rt] of Object.entries(verState(s).nodes as Record<string, any>)) expect(rt.failure_counts, id).toEqual({});
}

/** Steps 1–3: R001, the cli's per-criterion answer, settled. Returns the cli's attempts after it. */
async function untilChallenged(): Promise<{ s: Ver; attempts: number }> {
  const s = await r15Reviewed();
  let state = verState(s);
  expect(state.acceptance_review.reviews[0]).toMatchObject({ review_id: R001, outcome: 'GAPS', reworks: [CLI] });
  expect(state.nodes[CLI].rework_brief).toMatchObject({ acceptance_criteria: ['AC-3', 'AC-4', 'AC-5'] });
  const before = state.nodes[CLI].attempts as number;
  const t = (await dispatch(s)).ticket!;
  expect(t.node_id).toBe(CLI);
  // The brief says how: each ordered criterion answered on its own, in one result.
  expect(t.prompt).toMatch(/schema_version 2/);
  expect(t.prompt).toMatch(/outcome CRITERIA/);
  const run = mixedWork(t, s.control);
  r15Result(t, run);
  expect(checkFor(t, s.control).out).toMatchObject({ ok: true });
  const settled = await settle(s, t);
  expect(settled, settled.detail).toMatchObject({ outcome: 'CRITERIA_SETTLED', state: 'DONE', challenge: { challenge_id: C1, criteria: ['AC-4'] } });
  commitVerControl(s, 'cli: AC-3 and AC-5 done, AC-4 challenged');
  state = verState(s);
  // One product attempt for the one execution.
  expect(state.nodes[CLI]).toMatchObject({ state: 'DONE', attempts: before + 1 });
  expect(state.acceptance_review.reviews[0]).toMatchObject({ outcome: 'CHALLENGED' });
  nothingAdministrative(s);
  return { s, attempts: before + 1 };
}

/** The compatibility node on the new work, then the refinement ticket of AC-4 alone. */
async function refinementTicket(s: Ver): Promise<ReviewTicket> {
  const d = await dispatch(s);
  expect((d.controller_reports ?? []).map((x) => [x.node_id, x.outcome])).toEqual([[COMPAT, 'DONE']]);
  const rr = d.ticket as unknown as ReviewTicket;
  expect(rr).toMatchObject({ review_id: R001, refinement: { round: 1 } });
  const packet = reviewPacket(rr) as unknown as Record<string, any>;
  expect((packet['refinement']['challenges'] as Record<string, any>[]).map((c) => [c['challenge_id'], c['criterion']])).toEqual([[C1, 'AC-4']]);
  return rr;
}

/** R002 PASS, the candidate, the delivery; the hidden-like checks on what was delivered. */
async function deliver(s: Ver, scripts: string[], dispatched?: Awaited<ReturnType<typeof dispatch>>): Promise<void> {
  const d = dispatched ?? (await dispatch(s));
  const r2 = d.ticket as unknown as ReviewTicket;
  expect(r2, d.detail).toMatchObject({ kind: 'acceptance-review', review_id: R002 });
  await writeVerdict(r2, verdictFor(reviewPacket(r2)), { cwd: s.control });
  expect(await settleReview(s, r2)).toMatchObject({ outcome: 'PASS' });
  commitVerControl(s, 'R002 PASS');
  const built = await dispatch(s);
  expect(built.status, built.detail).toBe('ALL_SETTLED');
  expect((built.controller_reports ?? []).map((x) => [x.node_id, x.outcome])).toEqual([[VER_CANDIDATE, 'DONE']]);
  commitVerControl(s, 'settled');
  expect(JSON.parse((await verCli(s, ['deliver', VER_FEATURE, '--json'])).out)).toMatchObject({ status: 'ACCEPTED', candidate_id: `${VER_FEATURE}-C001` });
  commitVerControl(s, 'delivered');
  expect(JSON.parse((await verCli(s, ['feature', 'verify', VER_FEATURE, '--delivered', '--json'])).out)).toEqual({ ok: true, problems: [] });
  const delivered = git(s.repo, ['rev-parse', 'main']);
  for (const script of scripts) {
    const r = acceptance(s.repo, delivered, script);
    expect(r.code, r.out).toBe(0);
  }
}

describe('CSET-203 r15, replayed model-free to the delivery it should have reached', () => {
  it("AC-3 DONE, AC-4 challenged, AC-5 DONE in one answer; R001's refinement withdraws AC-4 and orders nothing again; R002 passes; C001 delivered — one product attempt, no person asked", async () => {
    const { s, attempts } = await untilChallenged();
    const rr = await refinementTicket(s);
    await writeVerdict(rr, refinementFor(reviewPacket(rr), { 'AC-4': { decision: 'WITHDRAW' } }), { cwd: s.control });
    const refined = await settleReview(s, rr);
    expect(refined, refined.detail).toMatchObject({ outcome: 'GAPS', refinement: { decisions: [{ criterion: 'AC-4', decision: 'WITHDRAW' }] } });
    commitVerControl(s, 'R001 refined: AC-4 withdrawn');
    let state = verState(s);
    // AC-4 closed; the cli kept on the generation that holds AC-3's and AC-5's work — no order, no attempt, no rework.
    const receipt = JSON.parse(String(git(s.control, ['show', `HEAD:features/${VER_FEATURE}/reviews/${R001}.refined-1.json`]))) as Record<string, any>;
    expect(receipt['orders']).toEqual([expect.objectContaining({ node_id: CLI, action: 'keep', criteria_after: ['AC-3', 'AC-5'] })]);
    expect(state.nodes[CLI]).toMatchObject({ state: 'DONE', attempts });
    expect(state.acceptance_review.challenges.map((c: { challenge_id: string; status: string }) => [c.challenge_id, c.status])).toEqual([[C1, 'withdrawn']]);
    expect(eventsOf(s).filter((e) => e.type === 'node.reworked' && e.node_id === CLI)).toHaveLength(1);
    await deliver(s, [VER_R3_ACCEPTANCE, VER_AC4_ACCEPTANCE]);
    state = verState(s);
    expect(state.acceptance_review.reviews.map((r: { review_id: string; outcome: string; revision?: number }) => [r.review_id, r.outcome, r.revision ?? 0])).toEqual([
      [R001, 'GAPS', 1],
      [R002, 'PASS', 0],
    ]);
    // The cli's first work and its one rework execution: two product attempts; no failure, decision or refusal anywhere.
    expect(state.nodes[CLI]).toMatchObject({ attempts: 2 });
    nothingAdministrative(s);
    // R001, its refinement, R002: three reviewer sessions, each once.
    expect(state.acceptance_review.usage.sessions).toBe(3);
    expect(await status(s)).toMatchObject({ next_action: { kind: 'none' } });
  }, 300_000);

  it("the refinement REFINEs AC-4 to a reproduction the cli fails: only AC-4 is ordered again, AC-3's proof carried and AC-5's unit kept; its RED fails, its fix settles; R002 passes; C001 delivered", async () => {
    const { s, attempts } = await untilChallenged();
    const rr = await refinementTicket(s);
    await writeVerdict(rr, refinementFor(reviewPacket(rr), { 'AC-4': REFINE_AC4 }), { cwd: s.control });
    const refined = await settleReview(s, rr);
    expect(refined, refined.detail).toMatchObject({ outcome: 'GAPS', reworked: [CLI], refinement: { decisions: [{ criterion: 'AC-4', decision: 'REFINE' }] } });
    commitVerControl(s, 'R001 refined: AC-4 refined');
    let state = verState(s);
    expect(state.nodes[CLI].rework_brief).toMatchObject({ acceptance_criteria: ['AC-4'], origin: { review_id: R001, revision: 1, refinement: { challenge_id: C1, round: 1 } }, review_gaps: [{ criterion: 'AC-4', reproduction_sha256: sha256(AC4_STRING_REPRODUCTION) }] });
    // The order replaces the generation that holds AC-3's and AC-5's work: that one is what a later challenge restores.
    const entry = (state.nodes[CLI].rework_history as Record<string, any>[]).at(-1)!;
    expect(entry['restore']).toMatchObject({ state: 'DONE' });
    expect((entry['restore']['criteria'] as Record<string, any>[]).map((c) => c['criterion']).sort()).toEqual(['AC-3', 'AC-4', 'AC-5']);
    expect(state.nodes[CLI].attempts).toBe(attempts);
    const t = (await dispatch(s)).ticket!;
    expect(t.node_id).toBe(CLI);
    expect(reworkOf(t)).toMatchObject({ acceptance_criteria: ['AC-4'], carried_criteria: [expect.objectContaining({ criterion: 'AC-3' })] });
    refinedAc4Work(t, s.control);
    const done = await settle(s, t);
    expect(done, done.detail).toMatchObject({ outcome: 'DONE' });
    commitVerControl(s, 'cli: refined AC-4');
    // The compatibility node runs on the refined work, and R002 is handed out in the same dispatch.
    const next = await dispatch(s);
    expect((next.controller_reports ?? []).map((x) => [x.node_id, x.outcome])).toEqual([[COMPAT, 'DONE']]);
    await deliver(s, [VER_R3_ACCEPTANCE, VER_AC4_ACCEPTANCE, VER_AC4_STRING_ACCEPTANCE], next);
    state = verState(s);
    expect(state.acceptance_review.challenges.map((c: { challenge_id: string; status: string }) => [c.challenge_id, c.status])).toEqual([[C1, 'refined']]);
    // The first work, the per-criterion execution, the refined AC-4: three product attempts, each product work.
    expect(state.nodes[CLI].attempts).toBe(3);
    nothingAdministrative(s);
  }, 300_000);
});
