/**
 * The harness's account of each acceptance reviewer's lifecycle (CSET-203
 * r13): what the sessions' own stream-json output — Claude Code's task
 * events, which no model writes — says of every reviewer task, beside what
 * Mycelink recorded of it; a run whose Mycelink account those streams
 * contradict (an answer taken from a reviewer that never completed, a
 * reviewer interrupted that had completed, or lost while its session lived)
 * is untrusted. And the harness's bounded wait on a reviewer still running
 * once its controller exited, with no model session.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
// @ts-expect-error -- plain ESM module without type declarations
import { AWAIT_REVIEWER_MAX_MS, awaitLiveLease, reviewerBrief, reviewerLifecycle, reviewerLifecycleTrustProblems, runVerdict } from '../../evals-public-projects/lib/arms.mjs';

afterAll(() => cleanupTmpRoots());

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const REVIEWER = 'mycelink:acceptance-reviewer';
const AGENT = 'a0000000000000r13';
const CALL = 'toolu_synthetic_refinement_1';
const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const iso = (ms: number): string => new Date(T0 + ms).toISOString();

/** A session's stream as the harness captured it: the reviewer's task started, and (`end`) ended. */
function stream(events: Record<string, unknown>[]): string {
  const file = join(makeTmpDir('reviewer-stream-'), '1-task.jsonl');
  writeFileSync(file, [{ type: 'system', subtype: 'init', session_id: 's1' }, ...events].map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}
const started = { type: 'system', subtype: 'task_started', task_id: AGENT, tool_use_id: CALL, description: 'acceptance review CSET-203-R001', subagent_type: REVIEWER, is_backgrounded: true, task_type: 'local_agent', prompt: 'You are the Mycelink acceptance-reviewer ...' };
const ended = (status: string, at: number) => [
  { type: 'system', subtype: 'task_updated', task_id: AGENT, patch: { status, end_time: T0 + at } },
  { type: 'system', subtype: 'task_notification', task_id: AGENT, tool_use_id: CALL, status, output_file: '/x.output', summary: '{...}' },
];
const ingested = (at: number) => ({ type: 'review.ingested', ts: iso(at), data: { review_id: 'CSET-203-R001', dispatch_id: 'd2', outcome: 'INGESTED', agent_id: AGENT, tool_use_id: CALL } });
const interrupted = (reason: string, at: number, extra: Record<string, unknown> = {}) => ({ type: 'review.reviewer_interrupted', ts: iso(at), data: { review_id: 'CSET-203-R001', dispatch_id: 'd2', reason, status: null, task_sha256: sha256(CALL), agent_id_sha256: sha256(AGENT), elapsed_ms: at, timeout_ms: 1_200_000, ...extra } });

function record(streamEvents: Record<string, unknown>[], events: Record<string, unknown>[], session: { ended_at?: string } = { ended_at: iso(30 * 60_000) }) {
  const sessions = [{ index: 1, transcript: stream(streamEvents), ...session }];
  return { arm: 'with', sessions, reviewer_lifecycle: reviewerLifecycle({ sessions, events }) };
}

describe("each reviewer's lifecycle, from the sessions' own streams", () => {
  it('records each reviewer task by hash only, its status and end as Claude Code emitted them, beside what Mycelink recorded', () => {
    const r = record([started, ...ended('completed', 18_000)], [ingested(240_000)]);
    expect(r.reviewer_lifecycle).toEqual({
      streamed: true,
      tasks: [{ session: 1, task_sha256: sha256(CALL), agent_id_sha256: sha256(AGENT), status: 'completed', ended_at: iso(18_000) }],
      ingested: [{ review_id: 'CSET-203-R001', dispatch_id: 'd2', outcome: 'INGESTED', task_sha256: sha256(CALL), agent_id_sha256: sha256(AGENT), at: iso(240_000) }],
      interrupted: [],
    });
    expect(JSON.stringify(r.reviewer_lifecycle)).not.toContain(AGENT);
    expect(JSON.stringify(r.reviewer_lifecycle)).not.toContain('acceptance-reviewer ...');
    expect(reviewerLifecycleTrustProblems(r)).toEqual([]);
  });

  it("CSET-203 r13's run, as it should have gone: the answer of a reviewer that completed in seconds, taken minutes later, is attested", () => {
    expect(reviewerLifecycleTrustProblems(record([started, ...ended('completed', 18_000)], [ingested(245_000)]))).toEqual([]);
  });

  it('an answer taken from a reviewer whose task never completed, or that no session launched, is a forged lifecycle: the run is untrusted', () => {
    const running = record([started], [ingested(60_000)]);
    expect(reviewerLifecycleTrustProblems(running)).toEqual([expect.stringMatching(/took the answer of CSET-203-R001's reviewer .* records no completion of it \(still running\)/)]);
    const killed = record([started, ...ended('killed', 30_000)], [ingested(60_000)]);
    expect(reviewerLifecycleTrustProblems(killed)).toEqual([expect.stringMatching(/no completion of it \(killed\)/)]);
    const nobody = record([{ ...started, task_id: 'aother0000000000', tool_use_id: 'toolu_other' }], [ingested(60_000)]);
    expect(reviewerLifecycleTrustProblems(nobody)).toEqual([expect.stringMatching(/no session's stream launched/)]);
    const v = runVerdict({ record: { ...running, isolation: { kind: 'bubblewrap', enforced: true, preflight: { ok: true } }, controller_guard: true }, verification: { ok: true, trusted: true, errors: [], sections: {} } });
    expect(v.verdict).toBe('untrusted');
    expect(v.trust.problems).toContainEqual(expect.stringMatching(/^reviewer lifecycle: /));
  });

  it('an interruption the streams contradict is untrusted: before its wall-clock, after its completion, lost while its session lived, ended otherwise', () => {
    expect(reviewerLifecycleTrustProblems(record([started], [interrupted('timeout', 1_200_500)]))).toEqual([]);
    expect(reviewerLifecycleTrustProblems(record([started], [interrupted('timeout', 240_000)]))).toEqual([expect.stringMatching(/interrupted for its wall-clock after 240000 ms of 1200000/)]);
    expect(reviewerLifecycleTrustProblems(record([started, ...ended('completed', 18_000)], [interrupted('timeout', 1_200_500)]))).toEqual([expect.stringMatching(/interrupted \(timeout\) after its session's stream records it completed/)]);
    // Lost with its host: only once that session had ended.
    expect(reviewerLifecycleTrustProblems(record([started], [interrupted('host-ended', 400_000)], { ended_at: iso(300_000) }))).toEqual([]);
    expect(reviewerLifecycleTrustProblems(record([started], [interrupted('host-ended', 200_000)], { ended_at: iso(300_000) }))).toEqual([expect.stringMatching(/lost with its host session 1, which had not ended/)]);
    expect(reviewerLifecycleTrustProblems(record([started, ...ended('killed', 100_000)], [interrupted('ended', 200_000, { status: 'killed' })]))).toEqual([]);
    expect(reviewerLifecycleTrustProblems(record([started], [interrupted('ended', 200_000, { status: 'killed' })]))).toEqual([expect.stringMatching(/interrupted as ended killed, but its session's stream says it never ended/)]);
  });

  it('streams with no task events (an older Claude Code) attest nothing and are not judged', () => {
    expect(reviewerLifecycleTrustProblems(record([], [ingested(60_000)]))).toEqual([]);
  });

  it("a reviewer's standing as a run record keeps it: its hashes and wall-clock, nothing else", () => {
    expect(reviewerBrief({ review_id: 'R', dispatch_id: 'd', refinement: true, state: 'RUNNING', task_sha256: 't', agent_id_sha256: 'a', launched_at: 'x', elapsed_ms: 1, remaining_ms: 2, timeout_ms: 3, notified_at: null })).toEqual({ review_id: 'R', dispatch_id: 'd', state: 'RUNNING', task_sha256: 't', agent_id_sha256: 'a', elapsed_ms: 1, remaining_ms: 2, timeout_ms: 3 });
  });
});

describe('a controller that exited while its reviewer runs (await-reviewer, CSET-203 r13)', () => {
  const reviewer = (state: string, remaining = 600_000) => ({ next_action: { kind: 'await-reviewer', resumable: true, reviewer: { review_id: 'R', dispatch_id: 'd', state, task_sha256: 't', agent_id_sha256: 'a', elapsed_ms: 1_200_000 - remaining, remaining_ms: remaining, timeout_ms: 1_200_000 } } });

  it('is waited for, with no model session, while it runs, until it is not running any more', async () => {
    let clock = 0;
    const statuses = [reviewer('RUNNING'), reviewer('RUNNING', 590_000), { next_action: { kind: 'review-refine', resumable: true } }];
    let i = 0;
    const r = await awaitLiveLease({ read: () => statuses[Math.min(i++, statuses.length - 1)], digest: () => 'same', pollMs: 5_000, maxMs: AWAIT_REVIEWER_MAX_MS, now: () => clock, sleep: async (ms: number) => void (clock += ms) });
    expect(r).toMatchObject({ until: 'changed', polls: 3, waited_ms: 10_000 });
  });

  it('a generation no reviewer was launched for, or one already lost, is not waited for', async () => {
    for (const state of ['MISSING', 'LOST', 'TIMED_OUT']) {
      const r = await awaitLiveLease({ read: () => reviewer(state), digest: () => 'same', pollMs: 5_000, maxMs: AWAIT_REVIEWER_MAX_MS, now: () => 0, sleep: async () => undefined });
      expect(r, state).toMatchObject({ until: 'changed', polls: 1, waited_ms: 0 });
    }
  });

  it('stops at its bound when the reviewer still runs', async () => {
    let clock = 0;
    const r = await awaitLiveLease({ read: () => reviewer('RUNNING'), digest: () => 'same', pollMs: 5_000, maxMs: 12_000, now: () => clock, sleep: async (ms: number) => void (clock += ms) });
    expect(r).toMatchObject({ until: 'bounded', polls: 3 });
  });
});
