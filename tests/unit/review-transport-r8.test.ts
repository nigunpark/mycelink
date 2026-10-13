/**
 * CSET-203 r8's reviewers, replayed on their own verdicts and answers
 * (tests/benchmark/fixtures/cset203-r8; Claude Code's records of the host
 * session and the reviewer reconstructed, with synthetic ids).
 *
 * r8: the first reviewer to write R001's verdict was rightly sent back for
 * AC-5's compatibility trace (REVIEW_TRACE_INCOMPLETE); its correction, a
 * fresh reviewer, answered the whole corrected verdict as its final message
 * and never called Write, so settle found no verdict (REVIEW_VERDICT_MISSING),
 * and the feature was blocked REVIEW_INVALID with every node DONE. Here the
 * same bytes go through the agent-result transport: Claude Code's own
 * records prove the final answer is that of the reviewer the host launched
 * for the correction, and it is a valid GAPS verdict.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { canonicalVerdictSha256, gapTargets, judgeVerdict } from '../../src/engine/acceptance-review.js';
import { contextOf, type ReviewPacket } from '../../src/engine/review-packet.js';
import { REVIEW_LAUNCH_SCHEMA, extractReviewerResult, reviewerOutput, type OpenGeneration } from '../../src/engine/review-transport.js';
import type { PortfolioGraph } from '../../src/model/types.js';

afterAll(() => cleanupTmpRoots());

const FIXTURE = join(process.cwd(), 'tests', 'benchmark', 'fixtures', 'cset203-r8');
const read = (f: string): string => readFileSync(join(FIXTURE, f), 'utf8');
const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');
type R8Packet = Omit<ReviewPacket, 'dispatch_id'> & { dispatch_id: Record<'g3' | 'g4' | 'g5', string>; files_at_head: string[] };
const packet = JSON.parse(read('R001.packet.json')) as R8Packet;
const ctx = (g: 'g3' | 'g4' | 'g5') => contextOf({ ...packet, dispatch_id: packet.dispatch_id[g] } as unknown as ReviewPacket, (repo, path) => packet.files_at_head.includes(`${repo}:${path}`));
const graph = YAML.parse(read('PORTFOLIO-GRAPH.yaml')) as PortfolioGraph;

const SESSION = '00000000-0000-4000-8000-000000005308';
const AGENT = 'a0000000000000805';
const USE = 'toolu_r8_g5_reviewer';
const ARP = 'CSET-203.changesets.apply-release-plan.impl';
const CLI = 'CSET-203.changesets.cli.impl';

describe("CSET-203 r8's written verdict", () => {
  it("generation 4's is still refused for AC-5's compatibility trace, and its final answer is the same verdict", () => {
    const written = read('R001-g4.verdict.json');
    const judged = judgeVerdict(JSON.parse(written), ctx('g4'));
    expect(judged).toMatchObject({ ok: false, code: 'REVIEW_TRACE_INCOMPLETE' });
    if (!judged.ok) expect(judged.problems.map((p) => p.pointer)).toEqual(['/criteria/4/clauses']);
    // The fence attested exactly what it wrote.
    expect(JSON.parse(read('R001-g4.attest.json'))).toMatchObject({ agent_type: 'mycelink:acceptance-reviewer', content_sha256: canonicalVerdictSha256(written) });
    // Both transports agree: its final answer is the same verdict, canonically.
    const answered = extractReviewerResult(read('R001-g4.result.txt'));
    expect(answered.ok).toBe(true);
    if (answered.ok) expect(canonicalVerdictSha256(answered.json)).toBe(canonicalVerdictSha256(written));
  });

  it("generation 3's final answer, never written, would have been corrected for its form, not counted missing", () => {
    const answered = extractReviewerResult(read('R001-g3.result.txt'));
    expect(answered.ok).toBe(true);
    if (answered.ok) expect(judgeVerdict(answered.value, ctx('g3'))).toMatchObject({ ok: false, code: 'REVIEW_TRACE_INCOMPLETE' });
  });
});

/** Claude Code's records of r8's host session, laid out as 2.1.290 keeps them, under a projects directory of a fresh config dir. */
function r8Session(): { projects: string; transcript: string; subagents: string } {
  const projects = join(makeTmpDir('r8-claude-'), 'projects', '-home-alice-mycelink-pilot-results-CSET-203-r8-with-normal-workspace');
  const subagents = join(projects, SESSION, 'subagents');
  mkdirSync(subagents, { recursive: true });
  const transcript = join(projects, `${SESSION}.jsonl`);
  copyFileSync(join(FIXTURE, 'R001-g5.main.jsonl'), transcript);
  copyFileSync(join(FIXTURE, 'R001-g5.agent.jsonl'), join(subagents, `agent-${AGENT}.jsonl`));
  copyFileSync(join(FIXTURE, 'R001-g5.agent.meta.json'), join(subagents, `agent-${AGENT}.meta.json`));
  return { projects, transcript, subagents };
}

/** The Agent call as the session recorded it. */
const agentCall = (): { prompt: string; at: string } => {
  const line = read('R001-g5.main.jsonl').split('\n').find((l) => l.includes('"tool_use"')) as string;
  const e = JSON.parse(line) as { timestamp: string; message: { content: { input: { prompt: string } }[] } };
  return { prompt: (e.message.content[0] as { input: { prompt: string } }).input.prompt, at: e.timestamp };
};

/** A control root with generation `g`'s slot open, and the launch the plugin's fence records for r8's Agent call (r8's plugin recorded none). */
function r8Control(transcript: string, g: 'g4' | 'g5', launch: Partial<Record<string, unknown>> = {}): { control: string; open: OpenGeneration } {
  const control = makeTmpDir('r8-control-');
  const dispatch = packet.dispatch_id[g];
  const dir = join(control, '.mycelink', 'reviews', 'CSET-203', 'CSET-203-R001', dispatch);
  mkdirSync(dir, { recursive: true });
  const call = agentCall();
  const record = {
    schema: REVIEW_LAUNCH_SCHEMA,
    feature_id: 'CSET-203',
    review_id: 'CSET-203-R001',
    dispatch_id: packet.dispatch_id.g5,
    epoch: 7,
    tool_use_id: USE,
    session_id: SESSION,
    transcript_path: transcript.replace(/\\/g, '/'),
    cwd: '/home/alice/mycelink-pilot-results/CSET-203-r8/with-normal/workspace/platform',
    subagent_type: 'mycelink:acceptance-reviewer',
    description: 'acceptance review correction',
    prompt_sha256: sha256(call.prompt),
    prompt_bytes: Buffer.byteLength(call.prompt),
    prompt_dispatch: null,
    at: call.at,
    ...launch,
  };
  writeFileSync(join(dir, `launch-${USE}.json`), JSON.stringify(record, null, 2) + '\n');
  return { control, open: { review_id: 'CSET-203-R001', dispatch_id: dispatch, issued_at: '2026-10-09T08:24:30.000Z', epoch: 7, slot: `.mycelink/reviews/CSET-203/CSET-203-R001/${dispatch}/verdict.json` } };
}

describe("CSET-203 r8's corrective reviewer, through the agent-result transport", () => {
  it("takes generation 5's final answer from its own transcript, as the reviewer the host launched for it, and it is a valid GAPS verdict reworking apply-release-plan and the cli", () => {
    const s = r8Session();
    const { control, open } = r8Control(s.transcript, 'g5');
    const out = reviewerOutput(control, open);
    expect(out.kind).toBe('found');
    if (out.kind !== 'found') return;
    expect(out.text).toBe(read('R001-g5.result.txt'));
    expect(out.evidence).toMatchObject({
      agent_id: AGENT,
      agent_type: 'mycelink:acceptance-reviewer',
      session_id: SESSION,
      tool_use_id: USE,
      result_sha256: sha256(read('R001-g5.result.txt')),
      transcript: { sha256: sha256(readFileSync(join(FIXTURE, 'R001-g5.agent.jsonl'))), model: 'claude-sonnet-5-5', stop_reason: 'end_turn' },
      completion: 'task-notification',
    });
    expect(out.extraction).toMatchObject({ ok: true, form: 'json' });
    if (!out.extraction.ok) return;
    const judged = judgeVerdict(out.extraction.value, ctx('g5'));
    expect(judged).toMatchObject({ ok: true, overall: 'GAPS' });
    if (!judged.ok) return;
    expect(judged.gaps.map((g) => [g.criterion, g.untested ?? []])).toEqual([['AC-1', []], ['AC-5', ['AC-5.2']]]);
    expect(gapTargets(graph, judged.gaps).targets.map((t) => [t.node_id, t.criteria])).toEqual(
      expect.arrayContaining([
        [ARP, ['AC-1']],
        [CLI, ['AC-5']],
      ]),
    );
  });

  it("checks a host's copy of the answer against the transcript: the notification's text agrees, a changed copy does not", () => {
    const s = r8Session();
    const { control, open } = r8Control(s.transcript, 'g5');
    const notification = read('R001-g5.main.jsonl').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { message: { content: unknown } }).find((e) => typeof e.message.content === 'string')!.message.content as string;
    const copy = /<result>([\s\S]*)<\/result>/.exec(notification)![1]!;
    expect(reviewerOutput(control, open, { hostText: copy })).toMatchObject({ kind: 'found' });
    expect(reviewerOutput(control, open, { hostText: copy.replace('"verdict": "GAP"', '"verdict": "PASS"') })).toMatchObject({ kind: 'rejected', code: 'REVIEW_RESULT_MISMATCH' });
  });

  it('never takes it for another generation, nor from a launch that names another dispatch', () => {
    const s = r8Session();
    // A launch recorded for generation 5, found in generation 4's slot: not generation 4's reviewer.
    const g4 = r8Control(s.transcript, 'g4', {});
    expect(reviewerOutput(g4.control, g4.open)).toMatchObject({ kind: 'rejected', code: 'REVIEW_AGENT_WRONG_DISPATCH' });
    const named = r8Control(s.transcript, 'g5', { prompt_dispatch: packet.dispatch_id.g4 });
    expect(reviewerOutput(named.control, named.open)).toMatchObject({ kind: 'rejected', code: 'REVIEW_AGENT_WRONG_DISPATCH' });
    const early = r8Control(s.transcript, 'g5', { at: '2026-10-09T08:20:00.000Z' });
    expect(reviewerOutput(early.control, early.open)).toMatchObject({ kind: 'rejected', code: 'REVIEW_AGENT_WRONG_DISPATCH' });
    // A launch record dated after the generation, naming a reviewer that itself started before it: not this generation's.
    const late = r8Control(s.transcript, 'g5', { at: '2026-10-09T08:24:40.000Z' });
    expect(reviewerOutput(late.control, { ...late.open, issued_at: '2026-10-09T08:24:39.000Z' })).toMatchObject({ kind: 'rejected', code: 'REVIEW_AGENT_WRONG_DISPATCH' });
    expect(reviewerOutput(late.control, { ...late.open, issued_at: '2026-10-09T08:24:38.800Z' })).toMatchObject({ kind: 'found' });
  });

  it.runIf(process.platform !== 'win32')('never follows a symlinked transcript', () => {
    const s = r8Session();
    const { control, open } = r8Control(s.transcript, 'g5');
    const elsewhere = join(makeTmpDir('r8-forged-'), 'agent.jsonl');
    copyFileSync(join(s.subagents, `agent-${AGENT}.jsonl`), elsewhere);
    const target = join(s.subagents, `agent-${AGENT}.jsonl`);
    rmSync(target);
    symlinkSync(elsewhere, target);
    expect(reviewerOutput(control, open)).toMatchObject({ kind: 'rejected', code: 'REVIEW_TRANSCRIPT_INVALID' });
  });
});
