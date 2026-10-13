/**
 * A deterministic stand-in for Claude Code's Agent tool running the
 * `acceptance-reviewer` subagent on a Mycelink review ticket.
 *
 * It is held to what that read-only subagent can do: it reads the review
 * packet and the checkouts, and its only write is one JSON verdict to the
 * ticket's verdict file, made through the plugin's PreToolUse fence as a
 * subagent of type mycelink:acceptance-reviewer (which attests the write).
 * It never settles, never touches product code or controller state.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { main, type CliIo } from '../../src/cli/cli.js';

export const REVIEWER = 'mycelink:acceptance-reviewer';

export interface ReviewTicket {
  schema: string;
  kind: 'acceptance-review';
  feature_id: string;
  node_id: null;
  review_id: string;
  dispatch_id: string;
  agent: string;
  capability: string;
  packet_path: string;
  result_slot: string;
  settle_command: string;
  prompt: string;
  expires_at: string;
  criteria: string[];
  inputs_sha256: string;
  resumed: boolean;
}

export interface PacketCriterion {
  id: string;
  kind: 'new-behavior' | 'compatibility' | 'declaration';
  text: string;
  sha256: string;
  clauses: { id: string; text: string }[];
  producers: string[];
}

export interface ReviewPacket {
  schema: string;
  feature_id: string;
  review_id: string;
  dispatch_id: string;
  inputs_sha256: string;
  review: number;
  rework_rounds: { used: number; max: number };
  verdict_file: string;
  criteria: PacketCriterion[];
  nodes: { id: string; node_type: string; repository: string | null; allowed_paths: string[]; acceptance_criteria: string[]; module: string | null }[];
  repositories: { name: string; head_sha: string; base_sha: string; checkout: string; diff: string; changed: { path: string; status: string; test: boolean }[] }[];
  evidence: { id: string; kind: string; [k: string]: unknown }[];
  criterion_evidence: { node: string; repository: string | null; criterion: string; test_id: string | null; test: { path: string; name: string } | null; gate: string; output_sha256: string; evidence_ids: string[] }[];
}

export function reviewPacket(ticket: Pick<ReviewTicket, 'packet_path'>): ReviewPacket {
  return JSON.parse(readFileSync(ticket.packet_path, 'utf8')) as ReviewPacket;
}

export interface VerdictOverride {
  /** A GAP instead of a PASS for this criterion. */
  gap?: { missing: string; reproduction: string; producer?: { node_id?: string; module?: string } | null };
  /**
   * A compatibility GAP: the material clauses no test covers, traced to the
   * regression evidence alone (no test id) with what is not shown. Default:
   * the criterion's last clause.
   */
  untested?: string[];
}

/** A verdict over every criterion of the packet: a traced PASS unless overridden by a GAP. */
export function verdictFor(packet: ReviewPacket, overrides: Record<string, VerdictOverride> = {}, model = 'stand-in-reviewer'): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = packet as any;
  const gaps: Record<string, any> = Object.fromEntries(Object.entries(overrides).map(([k, v]) => [k, v.gap]));
  const repoOf = (node: any) => p.nodes?.find((n: any) => n.id === node)?.repository ?? null;
  const criteria = p.criteria.map((c: any) => {
    const proofs = p.criterion_evidence.filter((e: any) => e.criterion === c.id);
    let tests = proofs.filter((e: any) => e.test_id !== null).map((e: any) => ({ id: `test:${e.test_id}`, file: `file:${e.repository}:${e.test.path}`, name: e.test.name }));
    if (tests.length === 0 && c.kind === 'new-behavior') {
      // No criterion evidence names a test: the producers' tests the gates ran, else the test files they changed.
      const producers = c.producers ?? [];
      tests = (p.evidence ?? [])
        .filter((e: any) => e.kind === 'test' && e.runs.some((r: any) => producers.includes(r.node)))
        .map((e: any) => ({ id: e.id, file: `file:${repoOf(e.runs.find((r: any) => producers.includes(r.node)).node)}:${e.path}`, name: e.name }));
      if (tests.length === 0) {
        tests = (p.repositories ?? [])
          .filter((r: any) => producers.some((p: any) => repoOf(p) === r.name))
          .flatMap((r: any) => r.changed.filter((x: any) => x.test && x.status !== 'D').map((x: any) => ({ id: null, file: `file:${r.name}:${x.path}`, name: x.path })));
      }
    }
    const ids = [...new Set(tests.map((t: any) => t.id).filter(Boolean))];
    const files = [...new Set(tests.map((t: any) => t.file))];
    const evidence = [...new Set(proofs.flatMap((e: any) => e.evidence_ids))];
    const clauseEvidence = c.kind === 'new-behavior' ? [...ids, ...files] : evidence;
    const covering = ids.length > 0 ? ids : files;
    const gap = gaps[c.id];
    // A compatibility GAP names the clauses no test covers: their evidence cites no test, their trace says what is not shown.
    const untested: string[] = gap && c.kind === 'compatibility' ? (overrides[c.id]?.untested ?? [c.clauses[c.clauses.length - 1].id]) : [];
    return {
      criterion: c.id,
      verdict: gap ? 'GAP' : 'PASS',
      confidence: 'high',
      clauses: c.clauses.map((cl: any) =>
        untested.includes(cl.id)
          ? { clause: cl.id, evidence: clauseEvidence.filter((e: string) => !e.startsWith('test:')), trace: `no test shows ${cl.id}: ${gap.missing}` }
          : { clause: cl.id, evidence: clauseEvidence, trace: `${cl.id} is asserted by ${tests.map((t: any) => t.name).join('; ') || 'the regression receipt'}` },
      ),
      boundaries: c.kind === 'new-behavior' ? [{ kind: 'failure', boundary: `the failure paths ${c.id} names`, covered: !gap, evidence: gap ? [] : covering }] : [],
      gap: gap ? { missing: gap.missing, reproduction: gap.reproduction } : null,
      producer: gap ? (gap.producer ?? null) : null,
    };
  });
  return {
    schema: 'mycelink-acceptance-review/1',
    feature_id: p.feature_id,
    review_id: p.review_id,
    dispatch_id: p.dispatch_id,
    inputs_sha256: p.inputs_sha256,
    reviewer: { agent: REVIEWER, model },
    criteria,
    overall: criteria.some((c: any) => c.verdict === 'GAP') ? 'GAPS' : 'PASS',
  };
}

/** One tool call of the reviewer subagent through the plugin's fence: the hook's exit code and block reason. */
export async function reviewerToolCall(tool: string, input: Record<string, unknown>, options: { cwd: string; agentId?: string; agentType?: string; sessionId?: string }): Promise<{ code: number; err: string }> {
  let err = '';
  const io: CliIo = { out: () => undefined, err: (t) => (err += t + '\n'), stdin: JSON.stringify({ session_id: options.sessionId ?? 'host-session', agent_id: options.agentId ?? 'reviewer-agent-1', agent_type: options.agentType ?? REVIEWER, cwd: options.cwd, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input }) };
  const code = await main(['hook', 'controller-fence'], io);
  return { code, err };
}

/**
 * Write the verdict as the reviewer does: a Write tool call the fence allows
 * (and attests) for exactly the ticket's verdict file, then the write itself.
 */
export async function writeVerdict(ticket: Pick<ReviewTicket, 'result_slot'>, verdict: unknown, options: { cwd: string; agentId?: string; sessionId?: string; raw?: string }): Promise<void> {
  const content = options.raw ?? JSON.stringify(verdict, null, 2);
  const hook = await reviewerToolCall('Write', { file_path: ticket.result_slot, content }, options);
  if (hook.code !== 0) throw new Error(`the fence refused the reviewer's verdict: ${hook.err}`);
  mkdirSync(dirname(ticket.result_slot), { recursive: true });
  writeFileSync(ticket.result_slot, content);
}

/** A refinement reviewer's decision on one challenged gap (engine/acceptance-review.ts judgeRefinement). */
export interface RefinementChoice {
  decision: 'WITHDRAW' | 'REFINE' | 'UPHOLD';
  gap?: { missing: string; reproduction: string };
  producer?: { node_id?: string; module?: string } | null;
  reason?: string;
  /** UPHOLD: why the challenge's assertions do not test the clause (default: one entry on its first assertion). */
  rebuttal?: { test_id: string; assertion: string; why: string }[];
  /** A WITHDRAW that cites none of the challenge's evidence, only the review's own (refused). */
  withoutChallengeEvidence?: boolean;
}

/**
 * A refinement over every challenge of a refinement packet, as the stand-in
 * reviewer writes it: each challenged gap decided by `choices` (by challenge
 * id, or by criterion); a WITHDRAW traces the criterion as a PASS on the
 * challenge's test, its assertion lines and the challenge itself.
 */
export function refinementFor(packet: ReviewPacket, choices: Record<string, RefinementChoice>, model = 'stand-in-reviewer'): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = packet as any;
  const ref = p.refinement;
  if (!ref) throw new Error('not a refinement packet');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const decisions = ref.challenges.map((c: any) => {
    const choice = choices[c.challenge_id] ?? choices[c.criterion];
    if (!choice) throw new Error(`no decision for ${c.challenge_id}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const criterion = p.criteria.find((x: any) => x.id === c.criterion);
    const test = c.tests[0].id as string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const assertionOf = (clause: string): string => (c.clauses.find((x: any) => x.clause === clause) ?? c.clauses[0]).assertions[0];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const own = p.criterion_evidence.find((e: any) => e.criterion === c.criterion && e.test_id !== null);
    const evidence = (clause: string): string[] => (choice.withoutChallengeEvidence ? [`test:${own.test_id}`, `file:${own.repository}:${own.test.path}`] : [`challenge:${c.challenge_id}`, test, assertionOf(clause)]);
    const base = { challenge_id: c.challenge_id, challenge_sha256: c.challenge_sha256, criterion: c.criterion, decision: choice.decision };
    if (choice.decision === 'WITHDRAW') {
      return {
        ...base,
        reason: choice.reason ?? `The challenge's focused test injects the reviewer's own failure and asserts what ${c.criterion} requires.`,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        clauses: criterion.clauses.map((cl: any) => ({ clause: cl.id, evidence: evidence(cl.id), trace: `${cl.id} is asserted by the challenge's ${c.tests[0].name}` })),
        boundaries: [{ kind: 'failure', boundary: `the failure the gap of ${c.criterion} names`, covered: true, evidence: choice.withoutChallengeEvidence ? [`test:${own.test_id}`] : [test] }],
        gap: null,
        producer: null,
        rebuttal: [],
      };
    }
    return {
      ...base,
      reason: choice.reason ?? (choice.decision === 'REFINE' ? "The challenge proves the reproduction it ran; the boundary the criterion's words require is another." : "The challenge's assertions check another boundary than the clause's."),
      clauses: [],
      boundaries: [],
      gap: choice.gap ?? null,
      producer: choice.producer === undefined ? null : choice.producer,
      rebuttal: choice.rebuttal ?? (choice.decision === 'UPHOLD' ? [{ test_id: test.replace(/^test:/, ''), assertion: c.clauses[0].assertions[0], why: 'it asserts the reproduction it chose, not the boundary the clause names' }] : []),
    };
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const overall = decisions.every((d: any) => d.decision === 'WITHDRAW') && (ref.unchanged_gaps ?? []).length === 0 ? 'PASS' : 'GAPS';
  return {
    schema: 'mycelink-acceptance-refinement/1',
    feature_id: p.feature_id,
    review_id: p.review_id,
    dispatch_id: p.dispatch_id,
    inputs_sha256: p.inputs_sha256,
    reviewer: { agent: REVIEWER, model },
    decisions,
    overall,
  };
}
