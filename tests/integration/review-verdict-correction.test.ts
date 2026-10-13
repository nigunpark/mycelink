/**
 * A verdict canonicalised at settle, and one refused for its form corrected
 * within the same review (Orchestrator.settleReview, dispatch).
 *
 * CSET-203 r5 with-normal: the reviewer's second verdict found the real
 * AC-1, AC-3 and AC-5 gaps, and was refused only because one trace was 653
 * characters, over its bound of 600; it was the second refusal, so the
 * feature was blocked REVIEW_INVALID with nothing reworked. Here:
 *
 *  - over-long prose is cut and marked at settle, with no other reviewer
 *    session: the review settles GAPS and the producers are reworked; the
 *    receipt carries the canonical verdict, its hash, the original (attested)
 *    verdict's hash, and each changed field's original length and hash, and
 *    so does the settled event the run record reads;
 *  - a verdict refused for its form (a missing trace, a criterion left out,
 *    a wrong binding) is corrected by the next generation of the same review:
 *    its ticket and prompt name the refused verdict, every problem at its
 *    JSON pointer with its bound or the evidence ids the packet offers, and
 *    the bounds; the correction spends one of MAX_FORMAT_CORRECTIONS, once,
 *    and no review-rework round;
 *  - three corrections, then REVIEW_INVALID; a generation that leaves no
 *    verdict to correct spends one of MAX_REVIEW_ATTEMPTS instead;
 *  - a receipt whose canonical verdict was changed afterwards is tampered,
 *    even with STATE.json's pin rewritten to match.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { ARP, ARP_GAPPY_IMPL, ARP_JOURNAL_TEST, ARP_RED, ARP_ROLLBACK_TEST, ARP_SRC, ARP_TESTS, CLI, CLI_AC5, CLI_FAILURE_TEST, CLI_FULL_WORK, CLI_RECOVERY_TEST, VER_FEATURE, commitVerControl, createVer, verCli, verState, type Ver } from '../helpers/version-fixture.js';
import { fulfil, type CriterionItem, type ShopTicket } from '../helpers/shop-worker.js';
import { reviewPacket, verdictFor, writeVerdict, type ReviewTicket } from '../helpers/review-agent.js';
import { claudeSession, finishAgent, launchAgent } from '../helpers/claude-session.js';
import { MAX_FORMAT_CORRECTIONS, TRUNCATION_MARK, VERDICT_LIMITS, reviewGateProblems, verdictCanonicalSha256, verdictLimitsText } from '../../src/engine/acceptance-review.js';
import { mutateState } from '../../src/state/feature-state.js';

afterAll(() => cleanupTmpRoots());

const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');
/** CSET-203 r5's own AC-1.1 trace, 653 characters. */
const R5_TRACE = (JSON.parse(readFileSync(join(process.cwd(), 'tests', 'benchmark', 'fixtures', 'cset203-r5', 'R001-g2.verdict.json'), 'utf8')) as { criteria: { clauses: { trace: string }[] }[] }).criteria[0]!.clauses[0]!.trace;

type Ticket = ReviewTicket & { attempt: number; correction: null | { number: number; max: number; of_dispatch_id: string; previous_verdict: string; code: string; problems: { code: string; pointer: string; limit?: number; candidates?: string[] }[] } };
interface Dispatched {
  status: string;
  detail: string;
  ticket?: (ShopTicket & { kind?: string }) | Ticket;
}

async function dispatch(s: Ver): Promise<Dispatched> {
  const r = await verCli(s, ['dispatch', VER_FEATURE, '--json']);
  return JSON.parse(r.out) as Dispatched;
}
async function settleReview(s: Ver, t: ReviewTicket): Promise<Record<string, any>> {
  const r = await verCli(s, ['review', 'settle', VER_FEATURE, '--review', t.review_id, '--capability', t.capability, '--json']);
  return r.out === '' ? { err: r.err } : (JSON.parse(r.out) as Record<string, any>);
}
const events = (s: Ver, type: string): Record<string, any>[] =>
  readFileSync(join(s.featureDir, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, any>)
    .filter((e) => e['type'] === type);

const ARP_CRITERIA: CriterionItem[] = [
  { criterion: 'AC-1', gate: 'red', full_name: ARP_ROLLBACK_TEST },
  { criterion: 'AC-2', gate: 'red', full_name: ARP_JOURNAL_TEST },
];
const CLI_CRITERIA: CriterionItem[] = [{ criterion: 'AC-3', gate: 'red', full_name: CLI_RECOVERY_TEST }, { criterion: 'AC-4', gate: 'red', full_name: CLI_FAILURE_TEST }, CLI_AC5];
const GAP = { missing: 'no test fails the changelog write after the package/version writes', reproduction: 'inject changelog writer failure after package/version writes and assert exact rollback', producer: { node_id: ARP } };

/** Both producers DONE as r2's workers left them, the compatibility node run: the review ticket. */
async function untilReview(): Promise<{ s: Ver; t: Ticket }> {
  const s = await createVer({ review: {} });
  const a = (await dispatch(s)).ticket as ShopTicket;
  fulfil(a, { tests: { [ARP_TESTS]: ARP_RED }, impl: { [ARP_SRC]: ARP_GAPPY_IMPL }, criteria: ARP_CRITERIA }, s.control);
  expect(JSON.parse((await verCli(s, ['settle', VER_FEATURE, a.node_id, '--capability', a.capability, '--json'])).out)).toMatchObject({ outcome: 'DONE' });
  commitVerControl(s, 'apply-release-plan');
  const c = (await dispatch(s)).ticket as ShopTicket;
  fulfil(c, { ...CLI_FULL_WORK, criteria: CLI_CRITERIA }, s.control);
  expect(JSON.parse((await verCli(s, ['settle', VER_FEATURE, c.node_id, '--capability', c.capability, '--json'])).out)).toMatchObject({ outcome: 'DONE' });
  commitVerControl(s, 'cli');
  const t = (await dispatch(s)).ticket as Ticket;
  expect(t).toMatchObject({ kind: 'acceptance-review', correction: null });
  return { s, t };
}

type V = { criteria: { criterion: string; clauses: { clause: string; evidence: string[]; trace: string }[] }[] } & Record<string, unknown>;
const gapVerdict = (t: ReviewTicket): V => verdictFor(reviewPacket(t), { 'AC-1': { gap: GAP } }) as V;

describe('over-long prose is canonicalised at settle, not refused', () => {
  it("r5's 653-character trace: R001 settles GAPS with no other reviewer session; the receipt and the settled event carry both hashes and what was cut", async () => {
    const { s, t } = await untilReview();
    const v = gapVerdict(t);
    expect(v.criteria[0]!.criterion).toBe('AC-1');
    v.criteria[0]!.clauses[0]!.trace = R5_TRACE;
    await writeVerdict(t, v, { cwd: s.control });
    const attested = JSON.parse(readFileSync(join(t.result_slot, '..', 'verdict.attest.json'), 'utf8')) as { content_sha256: string };

    const settled = await settleReview(s, t);
    expect(settled).toMatchObject({ outcome: 'GAPS', reworked: [ARP], blocked: false, next: 'dispatch' });
    expect(settled['normalized']).toEqual([expect.objectContaining({ pointer: '/criteria/0/clauses/0/trace', action: 'truncated', original_length: 653 })]);
    const state = verState(s);
    expect(state.acceptance_review.usage.sessions).toBe(1);
    expect(state.acceptance_review.open).toBeNull();
    expect(state.nodes[ARP].rework_brief.reason).toContain('inject changelog writer failure after package/version writes');

    const receipt = JSON.parse(readFileSync(join(s.control, settled['receipt_path'] as string), 'utf8')) as Record<string, any>;
    expect(receipt['verdict_sha256']).toBe(attested.content_sha256);
    expect(receipt['verdict_sha256']).toBe(verdictCanonicalSha256(v));
    const trace = receipt['criteria'][0]['clauses'][0]['trace'] as string;
    expect(Array.from(trace).length).toBeLessThanOrEqual(VERDICT_LIMITS.trace);
    expect(trace.endsWith(TRUNCATION_MARK)).toBe(true);
    const canonical = { schema: 'mycelink-acceptance-review/1', feature_id: VER_FEATURE, review_id: t.review_id, dispatch_id: t.dispatch_id, inputs_sha256: t.inputs_sha256, reviewer: { agent: receipt['reviewer']['agent'], model: receipt['reviewer']['model'] }, criteria: receipt['criteria'], overall: receipt['overall'] };
    expect(receipt['canonical_verdict_sha256']).toBe(verdictCanonicalSha256(canonical));
    expect(receipt['normalization']).toEqual({
      original_sha256: receipt['verdict_sha256'],
      canonical_sha256: receipt['canonical_verdict_sha256'],
      changed: [{ pointer: '/criteria/0/clauses/0/trace', action: 'truncated', limit: VERDICT_LIMITS.trace, original_length: 653, original_sha256: sha256(R5_TRACE), canonical_length: Array.from(trace).length }],
      omitted: 0,
    });
    const [ev] = events(s, 'review.settled');
    expect(ev!['data']).toMatchObject({ outcome: 'GAPS', verdict_sha256: receipt['verdict_sha256'], canonical_verdict_sha256: receipt['canonical_verdict_sha256'], normalized: [{ pointer: '/criteria/0/clauses/0/trace', action: 'truncated', original_length: 653 }] });
    expect(events(s, 'review.refused')).toEqual([]);

    // The loop goes on at once: the reworked producer's worker, not another reviewer.
    commitVerControl(s, 'review R001');
    const next = await dispatch(s);
    expect(next.ticket).toMatchObject({ node_id: ARP });
  });
});

describe('a verdict refused for its form is corrected within the same review', () => {
  it('a missing trace: refused with its pointer, then a correction ticket naming the refused verdict, the problems, the candidates and the bounds; spent once', async () => {
    const { s, t } = await untilReview();
    const v = gapVerdict(t);
    const ac2 = v.criteria.findIndex((c) => c.criterion === 'AC-2');
    v.criteria[ac2]!.clauses[0]!.trace = '';
    await writeVerdict(t, v, { cwd: s.control });
    const refused = await settleReview(s, t);
    expect(refused).toMatchObject({ outcome: 'REVIEW_INVALID', code: 'REVIEW_TRACE_INCOMPLETE', blocked: false, next: 'dispatch', corrections: { used: 1, max: MAX_FORMAT_CORRECTIONS } });
    expect(refused['problems']).toEqual([expect.objectContaining({ code: 'REVIEW_TRACE_INCOMPLETE', pointer: `/criteria/${ac2}/clauses/0`, candidates: expect.arrayContaining([expect.stringMatching(/^test:[0-9a-f]{16}$/)]) })]);
    // Settled again (the host retrying its settle line): answered from the record, nothing spent twice.
    expect(await settleReview(s, t)).toMatchObject({ outcome: 'REVIEW_INVALID', code: 'REVIEW_TRACE_INCOMPLETE', idempotent: true });
    expect(verState(s).acceptance_review.open.refused).toHaveLength(1);
    expect(verState(s).acceptance_review.usage.sessions).toBe(1);

    const t2 = (await dispatch(s)).ticket as Ticket;
    expect(t2).toMatchObject({ kind: 'acceptance-review', review_id: t.review_id, resumed: true, attempt: 2 });
    expect(t2.dispatch_id).not.toBe(t.dispatch_id);
    expect(t2.correction).toMatchObject({ number: 1, max: MAX_FORMAT_CORRECTIONS, of_dispatch_id: t.dispatch_id, previous_verdict: t.result_slot, code: 'REVIEW_TRACE_INCOMPLETE' });
    expect(t2.correction!.problems).toEqual(refused['problems']);
    expect(reviewPacket(t2)).toMatchObject({ correction: t2.correction });
    expect(t2.prompt).toContain(`Format correction 1 of ${MAX_FORMAT_CORRECTIONS}`);
    expect(t2.prompt).toContain(`Refused verdict: ${t.result_slot}`);
    expect(t2.prompt).toContain(`/criteria/${ac2}/clauses/0`);
    expect(t2.prompt).toContain(`set dispatch_id to ${t2.dispatch_id}`);
    expect(t2.prompt).toContain(verdictLimitsText());

    // The corrective reviewer mends the one field and keeps the rest.
    const mended = JSON.parse(readFileSync(t.result_slot, 'utf8')) as V;
    mended['dispatch_id'] = t2.dispatch_id;
    mended.criteria[ac2]!.clauses[0]!.trace = 'the journal test asserts the dot-named entry before the first write';
    await writeVerdict(t2, mended, { cwd: s.control });
    const settled = await settleReview(s, t2);
    expect(settled).toMatchObject({ outcome: 'GAPS', reworked: [ARP] });
    const receipt = JSON.parse(readFileSync(join(s.control, settled['receipt_path'] as string), 'utf8')) as Record<string, any>;
    // A correction is no review-rework round, and its reviewer session is counted once.
    expect(receipt['rework_rounds']).toEqual({ used: 0, max: 2 });
    expect(receipt['dispatch_id']).toBe(t2.dispatch_id);
    expect(verState(s).acceptance_review.usage.sessions).toBe(2);
    expect(events(s, 'review.refused').map((e) => [e['data']['code'], e['data']['kind'], e['data']['corrections_used']])).toEqual([['REVIEW_TRACE_INCOMPLETE', 'format', 1]]);
  });

  it(`at most ${MAX_FORMAT_CORRECTIONS} corrections, then REVIEW_INVALID; a generation with no verdict to correct spends a reviewer attempt instead`, async () => {
    const { s, t } = await untilReview();
    let ticket = t;
    const incomplete = (tk: ReviewTicket): V => {
      const v = gapVerdict(tk);
      v.criteria = v.criteria.filter((c) => c.criterion !== 'AC-5');
      return v;
    };
    // A format refusal, then a generation whose reviewer completed with no answer: neither blocks; the next is still correction 1 of
    // the first verdict. (A generation nobody launched yet is no missing verdict, CSET-203 r13: its settle spends nothing.)
    await writeVerdict(ticket, incomplete(ticket), { cwd: s.control });
    expect(await settleReview(s, ticket)).toMatchObject({ code: 'REVIEW_INCOMPLETE', blocked: false });
    const first = ticket;
    ticket = (await dispatch(s)).ticket as Ticket;
    expect(await settleReview(s, ticket)).toMatchObject({ outcome: 'REVIEWER_NOT_LAUNCHED', code: null, blocked: false, next: 'launch' });
    const host = claudeSession(s.control);
    const { agent } = await launchAgent(host, { subagent_type: 'mycelink:acceptance-reviewer', description: `acceptance review ${ticket.review_id}`, prompt: ticket.prompt });
    finishAgent(host, agent, '   ');
    expect(await settleReview(s, ticket)).toMatchObject({ code: 'REVIEW_VERDICT_MISSING', lifecycle: 'COMPLETED_NO_OUTPUT', blocked: false });
    ticket = (await dispatch(s)).ticket as Ticket;
    expect((ticket as Ticket).correction).toMatchObject({ number: 1, of_dispatch_id: first.dispatch_id });
    // Three corrections, each refused: the third blocks.
    for (let n = 1; n <= MAX_FORMAT_CORRECTIONS; n++) {
      expect((ticket as Ticket).correction).toMatchObject({ number: n, max: MAX_FORMAT_CORRECTIONS });
      await writeVerdict(ticket, incomplete(ticket), { cwd: s.control });
      const r = await settleReview(s, ticket);
      expect(r).toMatchObject({ outcome: 'REVIEW_INVALID', code: 'REVIEW_INCOMPLETE', blocked: n === MAX_FORMAT_CORRECTIONS });
      if (n < MAX_FORMAT_CORRECTIONS) ticket = (await dispatch(s)).ticket as Ticket;
    }
    const state = verState(s);
    expect(state.feature_state).toBe('BLOCKED');
    expect(state.acceptance_review.blocked).toMatchObject({ code: 'REVIEW_INVALID', review_id: t.review_id });
    expect(state.acceptance_review.blocked.detail).toMatch(new RegExp(`${MAX_FORMAT_CORRECTIONS} format correction`));
    expect(state.nodes[ARP].state).toBe('DONE');
    expect(state.nodes[CLI].state).toBe('DONE');
    expect((await dispatch(s)).status).toBe('BLOCKED');
  });
});

describe('the receipt binds the canonical verdict', () => {
  it('a PASS receipt whose canonical verdict was changed afterwards is tampered, even with STATE.json re-pinned', async () => {
    const { s, t } = await untilReview();
    const v = verdictFor(reviewPacket(t)) as V;
    v.criteria[0]!.clauses[0]!.trace = `${'the rollback assertion '.repeat(40)}`.trim();
    await writeVerdict(t, v, { cwd: s.control });
    const settled = await settleReview(s, t);
    expect(settled).toMatchObject({ outcome: 'PASS' });
    commitVerControl(s, 'review R001: PASS');
    expect(reviewGateProblems(s.control, VER_FEATURE)).toEqual([]);
    const file = join(s.control, settled['receipt_path'] as string);
    const receipt = JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;
    receipt['criteria'][0]['clauses'][0]['trace'] = 'every clause proved';
    writeFileSync(file, JSON.stringify(receipt, null, 2) + '\n');
    mutateState(s.featureDir, (st) => {
      st.acceptance_review!.reviews[0]!.receipt_sha256 = sha256(readFileSync(file));
      return st;
    });
    expect(reviewGateProblems(s.control, VER_FEATURE).join('\n')).toMatch(/REVIEW_RECEIPT_TAMPERED: .*canonical verdict/);
  });
});
