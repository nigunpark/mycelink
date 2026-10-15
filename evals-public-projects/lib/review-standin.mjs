/**
 * A deterministic stand-in for the plugin's acceptance-reviewer subagent,
 * for model-free orchestration (tools/mycelink-fixture.mjs) and the bench's
 * fake hosts — never a benchmark subject. It reads the review packet the
 * controller wrote, traces every clause of every approved criterion to the
 * evidence the packet catalogues (the workers' criterion tests and the
 * locations of their test files; a compatibility criterion to its
 * verification receipt) and answers PASS, or GAP for the criteria it is
 * told, with that public reproduction and producer. Its verdict is written
 * as the subagent writes it: one Write the plugin's fence allows and
 * attests (`mycelink hook controller-fence`, agent type
 * mycelink:acceptance-reviewer), then the file.
 */
import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const REVIEWER = 'mycelink:acceptance-reviewer';

/** A verdict over every criterion of the packet: a traced PASS unless `gaps[criterion]` names a gap. */
export function verdictFor(packet, gaps = {}, model = 'stand-in-reviewer') {
  const repoOf = (node) => packet.nodes?.find((n) => n.id === node)?.repository ?? null;
  const criteria = packet.criteria.map((c) => {
    const proofs = packet.criterion_evidence.filter((e) => e.criterion === c.id);
    let tests = proofs.filter((e) => e.test_id !== null).map((e) => ({ id: `test:${e.test_id}`, file: `file:${e.repository}:${e.test.path}`, name: e.test.name }));
    if (tests.length === 0 && c.kind === 'new-behavior') {
      // No criterion evidence names a test: the producers' tests the gates ran, else the test files they changed.
      const producers = c.producers ?? [];
      tests = (packet.evidence ?? [])
        .filter((e) => e.kind === 'test' && e.runs.some((r) => producers.includes(r.node)))
        .map((e) => ({ id: e.id, file: `file:${repoOf(e.runs.find((r) => producers.includes(r.node)).node)}:${e.path}`, name: e.name }));
      if (tests.length === 0) {
        tests = (packet.repositories ?? [])
          .filter((r) => producers.some((p) => repoOf(p) === r.name))
          .flatMap((r) => r.changed.filter((x) => x.test && x.status !== 'D').map((x) => ({ id: null, file: `file:${r.name}:${x.path}`, name: x.path })));
      }
    }
    const ids = [...new Set(tests.map((t) => t.id).filter(Boolean))];
    const files = [...new Set(tests.map((t) => t.file))];
    const evidence = [...new Set(proofs.flatMap((e) => e.evidence_ids))];
    const clauseEvidence = c.kind === 'new-behavior' ? [...ids, ...files] : evidence;
    const covering = ids.length > 0 ? ids : files;
    const gap = gaps[c.id];
    return {
      criterion: c.id,
      verdict: gap ? 'GAP' : 'PASS',
      confidence: 'high',
      // A compatibility GAP names the clauses no test covers (gap.untested, default the last): no test cited, what is not shown.
      clauses: c.clauses.map((cl) =>
        gap && c.kind === 'compatibility' && (gap.untested ?? [c.clauses[c.clauses.length - 1].id]).includes(cl.id)
          ? { clause: cl.id, evidence: clauseEvidence.filter((e) => !e.startsWith('test:')), trace: `no test shows ${cl.id}: ${gap.missing}` }
          : { clause: cl.id, evidence: clauseEvidence, trace: `${cl.id} is asserted by ${tests.map((t) => t.name).join('; ') || 'the regression receipt'}` },
      ),
      boundaries: c.kind === 'new-behavior' ? [{ kind: 'failure', boundary: `the failure paths ${c.id} names`, covered: !gap, evidence: gap ? [] : covering }] : [],
      gap: gap ? { missing: gap.missing, reproduction: gap.reproduction } : null,
      producer: gap ? (gap.producer ?? null) : null,
    };
  });
  return {
    schema: 'mycelink-acceptance-review/1',
    feature_id: packet.feature_id,
    review_id: packet.review_id,
    dispatch_id: packet.dispatch_id,
    inputs_sha256: packet.inputs_sha256,
    reviewer: { agent: REVIEWER, model },
    criteria,
    overall: criteria.some((c) => c.verdict === 'GAP') ? 'GAPS' : 'PASS',
  };
}

/**
 * A refinement of a challenged review (a ticket with `refinement`): each
 * challenged gap decided by `choices` (by challenge id, or criterion):
 * WITHDRAW traces the criterion as a PASS on the challenge's test, its
 * assertion lines and the challenge itself; REFINE and UPHOLD give `gap` and
 * `producer` anew (UPHOLD with a rebuttal of the challenge's first test).
 */
export function refinementFor(packet, choices = {}, model = 'stand-in-reviewer') {
  const ref = packet.refinement;
  if (!ref) throw new Error('not a refinement packet');
  const decisions = ref.challenges.map((c) => {
    const choice = choices[c.challenge_id] ?? choices[c.criterion];
    if (!choice) throw new Error(`no decision for ${c.challenge_id}`);
    const criterion = packet.criteria.find((x) => x.id === c.criterion);
    const test = c.tests[0].id;
    const assertionOf = (clause) => (c.clauses.find((x) => x.clause === clause) ?? c.clauses[0]).assertions[0];
    const base = { challenge_id: c.challenge_id, challenge_sha256: c.challenge_sha256, criterion: c.criterion, decision: choice.decision };
    if (choice.decision === 'WITHDRAW') {
      return {
        ...base,
        reason: choice.reason ?? `The challenge's focused test injects the reviewer's own failure and asserts what ${c.criterion} requires.`,
        clauses: criterion.clauses.map((cl) => ({ clause: cl.id, evidence: [`challenge:${c.challenge_id}`, test, assertionOf(cl.id)], trace: `${cl.id} is asserted by the challenge's ${c.tests[0].name}` })),
        boundaries: [{ kind: 'failure', boundary: `the failure the gap of ${c.criterion} names`, covered: true, evidence: [test] }],
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
      producer: choice.producer ?? null,
      rebuttal: choice.rebuttal ?? (choice.decision === 'UPHOLD' ? [{ test_id: test.replace(/^test:/, ''), assertion: c.clauses[0].assertions[0], why: 'it asserts the reproduction it chose, not the boundary the clause names' }] : []),
    };
  });
  const overall = decisions.every((d) => d.decision === 'WITHDRAW') && (ref.unchanged_gaps ?? []).length === 0 ? 'PASS' : 'GAPS';
  return { schema: 'mycelink-acceptance-refinement/1', feature_id: packet.feature_id, review_id: packet.review_id, dispatch_id: packet.dispatch_id, inputs_sha256: packet.inputs_sha256, reviewer: { agent: REVIEWER, model }, decisions, overall };
}

/**
 * Review a ticket as the subagent does, outside any host: the verdict's
 * Write through the plugin's fence hook (`bin`), then the file. Returns the
 * verdict. Throws when the fence refuses it.
 */
export function writeVerdict(ticket, { bin, cwd, env = {}, gaps = {}, model = 'stand-in-reviewer', agentId = 'standin-reviewer-1', sessionId = 'standin-session' }) {
  const verdict = verdictFor(JSON.parse(readFileSync(ticket.packet_path, 'utf8')), gaps, model);
  const content = JSON.stringify(verdict, null, 2);
  const payload = { session_id: sessionId, agent_id: agentId, agent_type: REVIEWER, cwd, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: ticket.result_slot, content } };
  // The payload on the hook's stdin as a finished file, never spawnSync's `input`: on macOS that is an 8 KiB socketpair
  // under Node 22, and a payload longer than one write can reach the hook whole and its end never (CI 38618387236).
  const scratch = mkdtempSync(join(tmpdir(), 'mycelink-hook-stdin-'));
  let hook;
  try {
    const stdin = join(scratch, 'payload.json');
    writeFileSync(stdin, JSON.stringify(payload), { flag: 'wx', mode: 0o600 });
    const fd = openSync(stdin, 'r');
    try {
      hook = spawnSync(process.execPath, [bin, 'hook', 'controller-fence'], { stdio: [fd, 'pipe', 'pipe'], encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } });
    } finally {
      closeSync(fd);
    }
  } finally {
    try {
      // Windows can refuse an unlink for a moment (CI 38635817750): tried again, and still refused, left (private); never a
      // failure of the reviewer's verdict.
      rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // left in the temporary directory
    }
  }
  if (hook.status !== 0) throw new Error(`the fence refused the stand-in reviewer's verdict (exit ${hook.status}): ${hook.stderr}`);
  mkdirSync(dirname(ticket.result_slot), { recursive: true });
  writeFileSync(ticket.result_slot, content);
  return verdict;
}
