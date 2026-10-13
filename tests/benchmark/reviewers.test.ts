/**
 * The plugin's acceptance reviewer in the bench's records and scans.
 *
 * The reviewer is the with arm's treatment, apart from the workers: the run
 * record and the matrix give each reviewer session its own summary — the
 * review and generation it was given, its tool calls and the ones the fence
 * refused, its verdict per criterion, its model and token usage, and how the
 * controller settled it. Its transcript is no worker's, and it is scanned
 * like every other one: a reviewer that reaches the evaluator, or a without
 * arm that names the plugin's reviewer, is caught by the same scans.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
// @ts-expect-error -- plain ESM module without type declarations
import { pluginExposure, reviewerSummaries, workerSummaries } from '../../evals-public-projects/lib/arms.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { forbiddenAccess } from '../../evals-public-projects/lib/transcripts.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { refinementFor, verdictFor } from '../../evals-public-projects/lib/review-standin.mjs';
import { canonicalVerdictSha256 } from '../../src/engine/acceptance-review.js';

afterAll(() => cleanupTmpRoots());

const WS = '/home/bench/run/workspace';
const BRIEF = 'You are the Mycelink acceptance-reviewer for one feature.\n\nAcceptance review: CSET-203-R001\nFeature: CSET-203\nDispatch: 0f6c2b1e-1b0a-4d7c-9a51-2f0f0e8b6a10\n';
const VERDICT = { schema: 'mycelink-acceptance-review/1', overall: 'GAPS', criteria: [{ criterion: 'AC-1', verdict: 'GAP', confidence: 'high', gap: { missing: 'x', reproduction: 'inject changelog writer failure after package/version writes and assert exact rollback' } }, { criterion: 'AC-2', verdict: 'PASS', confidence: 'medium', gap: null }] };

function hostStream(dir: string, extra: object[] = []): string {
  const file = join(dir, '1-task.jsonl');
  const lines = [
    { type: 'system', subtype: 'init', cwd: WS },
    { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'agent-r1', name: 'Agent', input: { subagent_type: 'mycelink:acceptance-reviewer', description: 'acceptance review CSET-203-R001', prompt: BRIEF } }] } },
    { type: 'assistant', parent_tool_use_id: 'agent-r1', message: { model: 'claude-review', usage: { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 300 }, content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: `${WS}/platform/.mycelink/reviews/CSET-203/CSET-203-R001/packet.json` } }] } },
    { type: 'assistant', parent_tool_use_id: 'agent-r1', message: { model: 'claude-review', usage: { input_tokens: 2000, output_tokens: 70 }, content: [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: `${WS}/repos/changesets/packages/apply-release-plan/src/index.ts`, old_string: 'a', new_string: 'b' } }] } },
    { type: 'user', parent_tool_use_id: 'agent-r1', message: { content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'Blocked: the acceptance reviewer is read-only: Edit changes a file in place.' }] } },
    { type: 'assistant', parent_tool_use_id: 'agent-r1', message: { model: 'claude-review', usage: { input_tokens: 3000, output_tokens: 400 }, content: [{ type: 'tool_use', id: 't3', name: 'Write', input: { file_path: `${WS}/platform/.mycelink/reviews/CSET-203/CSET-203-R001/0f6c2b1e-1b0a-4d7c-9a51-2f0f0e8b6a10/verdict.json`, content: JSON.stringify(VERDICT) } }] } },
    { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'agent-r1', content: 'done' }] } },
    ...extra,
  ];
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

const EVENTS = [{ type: 'review.settled', data: { review_id: 'CSET-203-R001', dispatch_id: '0f6c2b1e-1b0a-4d7c-9a51-2f0f0e8b6a10', overall: 'GAPS', outcome: 'GAPS', receipt_path: 'features/CSET-203/reviews/CSET-203-R001.json' } }];

describe('reviewer sessions are summarised apart from the workers', () => {
  it('from the host stream: the review, its tool calls, refusals, verdict, model, usage and settlement', () => {
    const dir = makeTmpDir('bench-reviewers-');
    const [s] = reviewerSummaries([hostStream(dir)], EVENTS);
    expect(s).toMatchObject({
      review_id: 'CSET-203-R001',
      dispatch_id: '0f6c2b1e-1b0a-4d7c-9a51-2f0f0e8b6a10',
      models: ['claude-review'],
      tool_uses: 3,
      blocked: 1,
      verdict: { overall: 'GAPS', criteria: [{ criterion: 'AC-1', verdict: 'GAP', reproduction: 'inject changelog writer failure after package/version writes and assert exact rollback' }, { criterion: 'AC-2', verdict: 'PASS' }] },
      usage: { input_tokens: 6000, output_tokens: 520, cache_read_input_tokens: 300, cache_creation_input_tokens: 0 },
      settlement: { outcome: 'GAPS', overall: 'GAPS' },
    });
  });

  it("from a reviewer subagent's own transcript, which is never counted as a worker", () => {
    const dir = makeTmpDir('bench-reviewers-');
    const sub = join(dir, 'projects', 'x', 'session', 'subagents');
    mkdirSync(sub, { recursive: true });
    const file = join(sub, 'agent-r2.jsonl');
    writeFileSync(file, [
      { type: 'user', message: { role: 'user', content: BRIEF.replace('R001', 'R002').replace('0f6c2b1e-1b0a-4d7c-9a51-2f0f0e8b6a10', '11111111-2222-4333-8444-555555555555') } },
      { type: 'assistant', message: { model: 'claude-review', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'tool_use', id: 'w', name: 'Write', input: { file_path: '/x/verdict.json', content: JSON.stringify({ overall: 'PASS', criteria: [] }) } }] } },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n');
    const refused = [{ type: 'review.refused', data: { review_id: 'CSET-203-R002', dispatch_id: '11111111-2222-4333-8444-555555555555', code: 'REVIEW_INCOMPLETE' } }];
    expect(reviewerSummaries([file], refused)).toEqual([expect.objectContaining({ review_id: 'CSET-203-R002', verdict: { overall: 'PASS', criteria: [] }, settlement: { outcome: 'REVIEW_INVALID', overall: null, code: 'REVIEW_INCOMPLETE', receipt_path: null } })]);
    expect(workerSummaries([file], [])).toEqual([]);
  });
});

describe('the run record shows what settle made of each verdict (CSET-203 r5)', () => {
  it('the hash of the verdict the transcript wrote, the original and canonical hashes settle recorded, and what it cut', () => {
    const dir = makeTmpDir('bench-reviewers-');
    const written = canonicalVerdictSha256(JSON.stringify(VERDICT));
    const settled = [{ type: 'review.settled', data: { ...EVENTS[0]!.data, verdict_sha256: written, canonical_verdict_sha256: 'c'.repeat(64), normalized: [{ pointer: '/criteria/0/clauses/0/trace', action: 'truncated', original_length: 653, original_sha256: 'd'.repeat(64) }] } }];
    const [s] = reviewerSummaries([hostStream(dir)], settled);
    expect(s).toMatchObject({
      written_verdict_sha256: written,
      settlement: { outcome: 'GAPS', verdict_sha256: written, canonical_verdict_sha256: 'c'.repeat(64), normalized: [{ pointer: '/criteria/0/clauses/0/trace', action: 'truncated', original_length: 653 }] },
    });
  });

  it('a refusal: its kind, the format corrections spent, the problem pointers; a corrective generation names its correction', () => {
    const dir = makeTmpDir('bench-reviewers-');
    const brief = `${BRIEF}\nFormat correction 1 of 3: the verdict of generation 9e0c2b1e-1b0a-4d7c-9a51-2f0f0e8b6a10 was refused REVIEW_TRACE_INCOMPLETE for its form,\n`;
    mkdirSync(join(dir, 'subagents'), { recursive: true });
    const sub = join(dir, 'subagents', 'agent-r3.jsonl');
    writeFileSync(sub, `${JSON.stringify({ type: 'user', message: { role: 'user', content: brief } })}\n`);
    const refused = [{ type: 'review.refused', data: { review_id: 'CSET-203-R001', dispatch_id: '0f6c2b1e-1b0a-4d7c-9a51-2f0f0e8b6a10', code: 'REVIEW_TRACE_INCOMPLETE', kind: 'format', corrections_used: 1, problems: [{ code: 'REVIEW_TRACE_INCOMPLETE', pointer: '/criteria/1/clauses/2/evidence' }], verdict_sha256: 'e'.repeat(64) } }];
    const [s] = reviewerSummaries([sub], refused);
    expect(s).toMatchObject({ correction: 1, settlement: { outcome: 'REVIEW_INVALID', code: 'REVIEW_TRACE_INCOMPLETE', kind: 'format', corrections_used: 1, problems: ['/criteria/1/clauses/2/evidence'], verdict_sha256: 'e'.repeat(64) } });
  });
});

describe('a refinement of a challenged gap is a reviewer session of its own (CSET-203 r6)', () => {
  const REFINE_DISPATCH = '9c2d3e4f-0000-4000-8000-000000000002';
  const REFINEMENT = { schema: 'mycelink-acceptance-refinement/1', overall: 'GAPS', decisions: [{ challenge_id: 'CSET-203-R001-C1', criterion: 'AC-1', decision: 'REFINE', gap: { missing: 'm', reproduction: 'a changelog write failing part-way after the package version write' } }] };
  it('its round, the decisions it wrote and how settle took them', () => {
    const dir = makeTmpDir('bench-reviewers-');
    mkdirSync(join(dir, 'subagents'), { recursive: true });
    const sub = join(dir, 'subagents', 'agent-r4.jsonl');
    const brief = `You are the Mycelink acceptance-reviewer refining a challenged review.\n\nAcceptance review: CSET-203-R001\nFeature: CSET-203\nDispatch: ${REFINE_DISPATCH}\nRefinement round 1 of 2: CSET-203-R001-C1 challenges AC-1.\n`;
    writeFileSync(sub, [
      { type: 'user', message: { role: 'user', content: brief } },
      { type: 'assistant', message: { model: 'claude-review', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'tool_use', id: 'w', name: 'Write', input: { file_path: `/x/${REFINE_DISPATCH}/verdict.json`, content: JSON.stringify(REFINEMENT) } }] } },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n');
    const settled = [{ type: 'review.settled', data: { review_id: 'CSET-203-R001', dispatch_id: REFINE_DISPATCH, overall: 'GAPS', outcome: 'GAPS', receipt_path: 'features/CSET-203/reviews/CSET-203-R001.json', refinement: { round: 1, decisions: [{ challenge_id: 'CSET-203-R001-C1', criterion: 'AC-1', decision: 'REFINE' }] } } }];
    const [r] = reviewerSummaries([sub], settled);
    expect(r).toMatchObject({
      review_id: 'CSET-203-R001',
      dispatch_id: REFINE_DISPATCH,
      refinement: 1,
      verdict: { overall: 'GAPS', criteria: [], decisions: [{ challenge_id: 'CSET-203-R001-C1', criterion: 'AC-1', decision: 'REFINE', reproduction: 'a changelog write failing part-way after the package version write' }] },
      settlement: { outcome: 'GAPS', refinement: { round: 1, decisions: [{ criterion: 'AC-1', decision: 'REFINE' }] } },
    });
  });

  it('the stand-in reviewer decides each challenged gap as told: a WITHDRAW traced on the challenge, a REFINE with its new reproduction', () => {
    const packet = {
      feature_id: 'F-1', review_id: 'F-1-R001', dispatch_id: 'd', inputs_sha256: 'e'.repeat(64),
      criteria: [{ id: 'AC-1', kind: 'new-behavior', clauses: [{ id: 'AC-1.1' }, { id: 'AC-1.2' }] }],
      criterion_evidence: [],
      refinement: {
        round: 1,
        unchanged_gaps: [],
        challenges: [{ challenge_id: 'F-1-R001-C1', challenge_sha256: 'c'.repeat(64), criterion: 'AC-1', node_id: 'F-1.app.impl', tests: [{ id: `test:${'b'.repeat(16)}`, name: 'removes the file it created' }], clauses: [{ clause: 'AC-1.1', assertions: ['file:app:test/a.test.mjs#L9'] }, { clause: 'AC-1.2', assertions: ['file:app:test/a.test.mjs#L8'] }] }],
      },
    };
    const w = refinementFor(packet, { 'AC-1': { decision: 'WITHDRAW' } });
    expect(w).toMatchObject({ schema: 'mycelink-acceptance-refinement/1', overall: 'PASS', decisions: [{ challenge_id: 'F-1-R001-C1', challenge_sha256: 'c'.repeat(64), decision: 'WITHDRAW', gap: null, producer: null }] });
    expect(w.decisions[0].clauses.map((c: { clause: string; evidence: string[] }) => [c.clause, c.evidence])).toEqual([
      ['AC-1.1', ['challenge:F-1-R001-C1', `test:${'b'.repeat(16)}`, 'file:app:test/a.test.mjs#L9']],
      ['AC-1.2', ['challenge:F-1-R001-C1', `test:${'b'.repeat(16)}`, 'file:app:test/a.test.mjs#L8']],
    ]);
    const r = refinementFor(packet, { 'F-1-R001-C1': { decision: 'REFINE', gap: { missing: 'm', reproduction: 'r2' }, producer: { node_id: 'F-1.app.impl' } } });
    expect(r).toMatchObject({ overall: 'GAPS', decisions: [{ decision: 'REFINE', gap: { reproduction: 'r2' }, producer: { node_id: 'F-1.app.impl' }, rebuttal: [] }] });
  });
});

describe("a reviewer's transcript is scanned like every other", () => {
  it('a reviewer that reaches the evaluator is a hit', () => {
    const dir = makeTmpDir('bench-reviewers-');
    const evaluator = '/home/bench/cache/evaluator';
    const file = hostStream(dir, [{ type: 'assistant', parent_tool_use_id: 'agent-r1', message: { content: [{ type: 'tool_use', id: 't9', name: 'Read', input: { file_path: `${evaluator}/changesets/CSET-203/hidden/packages/apply-release-plan/src/__acceptance__/apply-rollback.acceptance.test.ts` } }] } }]);
    const { hits } = forbiddenAccess({ files: [file], roots: [evaluator], cwd: WS, home: '/home/bench' });
    expect(hits.map((h: { tool: string }) => h.tool)).toContain('Read');
  });

  it("the without arm naming the plugin's reviewer package is plugin exposure", () => {
    const dir = makeTmpDir('bench-reviewers-');
    const plugin = '/home/bench/run/plugin';
    const file = join(dir, '1-task.jsonl');
    writeFileSync(file, `${JSON.stringify({ type: 'system', subtype: 'init', cwd: WS })}\n${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'r', name: 'Read', input: { file_path: `${plugin}/agents/acceptance-reviewer.md` } }] } })}\n`);
    expect(pluginExposure({ arm: 'without', dir: plugin, args: ['-p'], files: [file], cwd: WS, home: '/home/bench' }).join('\n')).toMatch(/names the plugin package/);
  });
});

describe('the stand-in reviewer of model-free orchestration', () => {
  it('traces every clause to the packet\'s evidence and answers GAP only where told', () => {
    const packet = {
      feature_id: 'F-1', review_id: 'F-1-R001', dispatch_id: 'd', inputs_sha256: 'e'.repeat(64),
      criteria: [{ id: 'AC-1', kind: 'new-behavior', clauses: [{ id: 'AC-1.1' }] }, { id: 'AC-2', kind: 'compatibility', clauses: [{ id: 'AC-2.1' }] }],
      criterion_evidence: [
        { criterion: 'AC-1', repository: 'app', test_id: 'a'.repeat(16), test: { path: 'test/a.test.mjs', name: 'a' }, evidence_ids: [`test:${'a'.repeat(16)}`, 'gate:F-1.app.impl:red'] },
        { criterion: 'AC-2', repository: 'app', test_id: null, test: null, evidence_ids: ['gate:F-1.app.verify:regression', 'receipt:F-1.app.verify'] },
      ],
    };
    const pass = verdictFor(packet);
    expect(pass.overall).toBe('PASS');
    expect(pass.criteria[0].clauses[0].evidence).toEqual([`test:${'a'.repeat(16)}`, 'file:app:test/a.test.mjs']);
    expect(pass.criteria[1].clauses[0].evidence).toEqual(['gate:F-1.app.verify:regression', 'receipt:F-1.app.verify']);
    const gap = verdictFor(packet, { 'AC-1': { missing: 'm', reproduction: 'r', producer: { node_id: 'F-1.app.impl' } } });
    expect(gap).toMatchObject({ overall: 'GAPS', criteria: [{ verdict: 'GAP', gap: { missing: 'm', reproduction: 'r' }, producer: { node_id: 'F-1.app.impl' } }, { verdict: 'PASS' }] });
  });
});

describe("how each reviewer's verdict reached the controller (CSET-203 r8)", () => {
  const R8 = join(process.cwd(), 'tests', 'benchmark', 'fixtures', 'cset203-r8');
  const G5 = '53bcb402-140f-4be2-99e4-883d57192a44';
  const sha = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex');
  /** A subagent's own transcript and meta under a session's `subagents/`, as Claude Code 2.1.290 keeps them. */
  const subagent = (dir: string, agent: string, lines: object[] | string, meta: object): string => {
    const at = join(dir, 'projects', 'p', 'session-1', 'subagents');
    mkdirSync(at, { recursive: true });
    const file = join(at, `agent-${agent}.jsonl`);
    writeFileSync(file, typeof lines === 'string' ? lines : lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    writeFileSync(join(at, `agent-${agent}.meta.json`), JSON.stringify(meta));
    return file;
  };

  it("r8's corrective reviewer — pointed at its brief, answered, never wrote — is a reviewer of its own, and r8 stays what it was: no verdict taken", () => {
    const dir = makeTmpDir('bench-r8-reviewer-');
    const file = subagent(dir, 'a0000000000000805', readFileSync(join(R8, 'R001-g5.agent.jsonl'), 'utf8'), JSON.parse(readFileSync(join(R8, 'R001-g5.agent.meta.json'), 'utf8')));
    // r8's own refusal of it: its plugin knew no other transport.
    const refused = [{ type: 'review.refused', data: { review_id: 'CSET-203-R001', dispatch_id: G5, code: 'REVIEW_VERDICT_MISSING', kind: 'review', problems: [], verdict_sha256: null, corrections_used: 1 } }];
    const summaries = reviewerSummaries([file], refused);
    expect(summaries).toEqual([
      expect.objectContaining({
        review_id: 'CSET-203-R001',
        dispatch_id: G5,
        correction: 1,
        agent_id: 'a0000000000000805',
        written_verdict_sha256: null,
        answer: 'json',
        result_sha256: sha(readFileSync(join(R8, 'R001-g5.result.txt'), 'utf8')),
        transcript_sha256: sha(readFileSync(join(R8, 'R001-g5.agent.jsonl'))),
        transport: 'agent-result',
        verdict: expect.objectContaining({ overall: 'GAPS' }),
        settlement: expect.objectContaining({ outcome: 'REVIEW_INVALID', code: 'REVIEW_VERDICT_MISSING' }),
      }),
    ]);
    // Never a worker's.
    expect(workerSummaries([file], [])).toEqual([]);
  });

  it("settle's account of the transport and the answer's and transcript's hashes; the generation found from the controller's events", () => {
    const dir = makeTmpDir('bench-r8-reviewer-');
    const answer = JSON.stringify(VERDICT);
    const file = subagent(
      dir,
      'a0000000000000001',
      [
        { type: 'user', isSidechain: true, agentId: 'a0000000000000001', message: { role: 'user', content: 'Your instructions are the file /tmp/brief.txt; follow it.' } },
        { type: 'assistant', isSidechain: true, agentId: 'a0000000000000001', attributionAgent: 'mycelink:acceptance-reviewer', message: { id: 'm1', model: 'claude-review', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'text', text: answer }], stop_reason: 'end_turn' } },
      ],
      { agentType: 'mycelink:acceptance-reviewer', toolUseId: 'toolu_1' },
    );
    const events = [
      { type: 'review.ingested', data: { review_id: 'CSET-203-R001', dispatch_id: 'd-1', outcome: 'INGESTED', agent_id: 'a0000000000000001', result_sha256: sha(answer), transcript_sha256: sha(readFileSync(file)) } },
      { type: 'review.settled', data: { review_id: 'CSET-203-R001', dispatch_id: 'd-1', overall: 'GAPS', outcome: 'GAPS', receipt_path: 'features/CSET-203/reviews/CSET-203-R001.json', transport: 'agent-result', agent_id: 'a0000000000000001', result_sha256: sha(answer), transcript_sha256: sha(readFileSync(file)) } },
    ];
    const [s] = reviewerSummaries([file], events);
    expect(s).toMatchObject({ review_id: 'CSET-203-R001', dispatch_id: 'd-1', agent_id: 'a0000000000000001', answer: 'json', transport: 'agent-result', result_sha256: sha(answer), settlement: { outcome: 'GAPS', transport: 'agent-result', result_sha256: sha(answer) } });
  });

  it('a reviewer in both the host stream and its own transcript is summarised once', () => {
    const dir = makeTmpDir('bench-r8-reviewer-');
    const stream = hostStream(dir);
    const own = subagent(
      dir,
      'a0000000000000002',
      [
        { type: 'user', isSidechain: true, agentId: 'a0000000000000002', message: { role: 'user', content: BRIEF } },
        { type: 'assistant', isSidechain: true, agentId: 'a0000000000000002', message: { id: 'm1', model: 'claude-review', usage: { input_tokens: 1000, output_tokens: 50 }, content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'packet.json' } }] } },
        { type: 'assistant', isSidechain: true, agentId: 'a0000000000000002', message: { id: 'm2', model: 'claude-review', usage: { input_tokens: 3000, output_tokens: 400 }, content: [{ type: 'tool_use', id: 't3', name: 'Write', input: { file_path: `${WS}/platform/.mycelink/reviews/CSET-203/CSET-203-R001/0f6c2b1e-1b0a-4d7c-9a51-2f0f0e8b6a10/verdict.json`, content: JSON.stringify(VERDICT) } }] } },
        { type: 'assistant', isSidechain: true, agentId: 'a0000000000000002', message: { id: 'm3', model: 'claude-review', content: [{ type: 'text', text: 'The verdict is written.' }], stop_reason: 'end_turn' } },
      ],
      { agentType: 'mycelink:acceptance-reviewer', toolUseId: 'agent-r1' },
    );
    const summaries = reviewerSummaries([stream, own], EVENTS);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ tool_uses: 2, transport: 'file', answer: 'prose', transcript: own });
  });

  it('reviewers are listed in the order they ran, whatever their transcripts are named', () => {
    const dir = makeTmpDir('bench-r8-reviewer-');
    const reviewer = (agent: string, at: string, review: string) =>
      subagent(dir, agent, [{ type: 'user', isSidechain: true, agentId: agent, timestamp: at, message: { role: 'user', content: BRIEF.replace('CSET-203-R001', review).replace('0f6c2b1e-1b0a-4d7c-9a51-2f0f0e8b6a10', `d-${review}`) } }], { agentType: 'mycelink:acceptance-reviewer', toolUseId: `toolu_${agent}` });
    const later = reviewer('a0000000000000001', '2026-10-09T10:00:00.000Z', 'CSET-203-R002');
    const earlier = reviewer('affffffffffffffff', '2026-10-09T09:00:00.000Z', 'CSET-203-R001');
    expect(reviewerSummaries([later, earlier], []).map((s: { review_id: string }) => s.review_id)).toEqual(['CSET-203-R001', 'CSET-203-R002']);
  });

  it("a reviewer's final answer is scanned like a tool call: one naming an evaluator root is a hit", () => {
    const dir = makeTmpDir('bench-r8-reviewer-');
    const evaluator = '/home/bench/cache/evaluator';
    const file = subagent(
      dir,
      'a0000000000000003',
      [
        { type: 'user', isSidechain: true, agentId: 'a0000000000000003', message: { role: 'user', content: BRIEF } },
        { type: 'assistant', isSidechain: true, agentId: 'a0000000000000003', attributionAgent: 'mycelink:acceptance-reviewer', message: { id: 'm1', content: [{ type: 'text', text: JSON.stringify({ ...VERDICT, note: `see ${evaluator}/changesets/CSET-203/hidden` }) }], stop_reason: 'end_turn' } },
      ],
      { agentType: 'mycelink:acceptance-reviewer', toolUseId: 'toolu_9' },
    );
    const { hits } = forbiddenAccess({ files: [file], roots: [evaluator], cwd: WS, home: '/home/bench' });
    expect(hits).toEqual([expect.objectContaining({ tool: 'AgentResult', root: evaluator })]);
  });
});
