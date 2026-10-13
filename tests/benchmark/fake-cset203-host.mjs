#!/usr/bin/env node
/**
 * A stand-in for a with-arm host session on the real CSET-203 workspace
 * (never a benchmark subject), for the model-free CSET-203 run: the
 * apply-release-plan and cli module workers on the real Changesets source,
 * r1's AC-4 evidence held and corrected by a new RED cycle, r1's compat node
 * run as a verification node inside dispatch, C001 delivered, and the
 * independent verifier's verdict.
 *
 * Inside the session's sandbox it drives the sealed plugin as the run
 * command tells a host to. $FAKE_CLAUDE_PLAN names a JSON file the test
 * wrote outside the sandbox:
 *
 *   { log, modules: { <module>: { tests, impl, criteria: [{ criterion, path, name, gate }] } },
 *     correction: { <module>: { tests, impl, criteria } } }
 *
 * where `tests` and `impl` map repository paths to file contents (the
 * reference's, each as another author would commit it). A module may give
 * `cycles: [{ testPatch, implPatch } | { testEdits, implEdits }]` instead (a
 * worker's own commits as patches, or edits in place), each a complete RED
 * cycle, and a criterion the `cycle` whose red proved it. `rework: {
 * <module>: { cycles, compat?, criteria } }` is the work a reworked node's
 * fresh worker does (citing its pack's carried criteria as given); `compat:
 * { testEdits, message, criteria }` is a compatibility criterion's regression
 * test it then commits alone, after the code, with the trailer
 * `Mycelink-Compatibility: <criteria>`, running green again; a node reopened
 * by an upstream rework re-proves GREEN only. Every acceptance-review ticket
 * goes to the stand-in reviewer (inlined below): PASS, or GAP for the
 * criteria `reviewGaps: { <review id>: { <AC>: { missing, reproduction,
 * producer } } }` names; then the ticket's settle line. The cli's first
 * submission maps AC-4 to an existing GREEN test, as r1's worker did; the
 * correction ticket's worker adds AC-4's own RED cycle. The worker runs the
 * ticket's gate lines, commits the tests alone after RED and the production
 * alone after GREEN, looks each criterion's test up by its words (`tdd
 * tests`), checks its result (`tdd check`) and records what it saw in the
 * plan's log. Every tool call passes the plugin's PreToolUse hooks first.
 *
 * CSET-203 r6's challenge: `challenge: { <module>: { tests, test, clauses:
 * [{ clause, needles }], explanation } }` is what the first worker of an
 * acceptance review's rework of that module does — it writes the review's
 * exact reproduction as focused tests, runs red (its declared tests pass),
 * runs the challenge line, traces each clause to the lines holding its
 * needles inside `test`, writes outcome REVIEW_GAP_CHALLENGE and runs the
 * check line. A refinement ticket goes to the stand-in reviewer, deciding
 * each challenged gap as `refinements: { <review id>: { <AC>: { decision,
 * gap?, producer? } } }` says. `exitAfterChallenge`: the task session exits
 * 0 once the challenge settled, the feature incomplete (once; a marker beside
 * the log says it happened), and the continuation goes on.
 *
 * CSET-203 r8's transports: `reviewTransport: { <review id>: [<generation>...] }`
 * says how each generation of a review (its correction and refinement
 * generations included, in order) returns its verdict — `file` (Write; its
 * final answer only says so), `both` (Write, and the same JSON as its final
 * answer), `agent-result` (the JSON as its final answer, no Write) or
 * `fenced` (one ```json fence, no Write); the last one given holds for the
 * rest. `reviewFirst: { <review id>: { <AC>: { ...gap, untested } } }`
 * overrides the first generation's gaps (r8's AC-5: a compatibility GAP with
 * no untested clause). The host keeps Claude Code's own records of each
 * reviewer under $HOME/.claude/projects (the session's transcript, the
 * subagent's transcript and meta), launches it through the plugin's hook
 * with the call's tool_use id and the session's transcript, and runs every
 * reviewer ticket's ingest line, then its settle line; a verdict refused for
 * its form (not blocking) is followed by the correction ticket.
 *
 * CSET-203 r10's refusal: `providerRefusal: { module, dispatch }` — when the
 * `dispatch`-th worker ticket of that module is handed out (before any
 * worker runs), the controller's next request is refused by the provider
 * (reasoning_extraction) as Claude Code records it, in the stream and the
 * session's transcript, and the session exits 1 (once; a marker beside the
 * log). The next session first presents that ticket's capability late, with
 * a result in its old slot, and logs the answer ({ late }).
 */
import { execSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

/** A file's text, or null when nothing (readable) is there. */
function readOrNull(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Create `marker` exclusively: true the first time, false when it is already there. */
function createdOnce(marker, text) {
  try {
    writeFileSync(marker, text, { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}


// ---- the stand-in acceptance-reviewer subagent (as evals-public-projects/lib/review-standin.mjs) ----
// Inlined: the sandbox binds this host file alone, so it imports no sibling module.
const REVIEWER = 'mycelink:acceptance-reviewer';

/** A verdict over every criterion of the packet: a traced PASS unless `gaps[criterion]` names a gap. */
function verdictFor(packet, gaps = {}, model = 'stand-in-reviewer') {
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

/** A refinement over every challenged gap of the packet, each decided as `choices` says (by challenge id or criterion). */
function refinementFor(packet, choices = {}, model = 'stand-in-reviewer') {
  const ref = packet.refinement;
  const decisions = ref.challenges.map((c) => {
    const choice = choices[c.challenge_id] ?? choices[c.criterion];
    if (!choice) throw new Error(`no refinement decision for ${c.challenge_id} ${c.criterion}`);
    const criterion = packet.criteria.find((x) => x.id === c.criterion);
    const test = c.tests[0].id;
    const assertionOf = (clause) => (c.clauses.find((x) => x.clause === clause) ?? c.clauses[0]).assertions[0];
    const base = { challenge_id: c.challenge_id, challenge_sha256: c.challenge_sha256, criterion: c.criterion, decision: choice.decision };
    if (choice.decision === 'WITHDRAW') {
      return { ...base, reason: `The challenge's focused test asserts what ${c.criterion} requires.`, clauses: criterion.clauses.map((cl) => ({ clause: cl.id, evidence: [`challenge:${c.challenge_id}`, test, assertionOf(cl.id)], trace: `${cl.id} is asserted by ${c.tests[0].name}` })), boundaries: [{ kind: 'failure', boundary: 'the failure the gap names', covered: true, evidence: [test] }], gap: null, producer: null, rebuttal: [] };
    }
    return {
      ...base,
      reason: choice.reason ?? "The challenge proves the reproduction it ran; the boundary the criterion's words require is another.",
      clauses: [],
      boundaries: [],
      gap: choice.gap,
      producer: choice.producer ?? null,
      rebuttal: choice.decision === 'UPHOLD' ? [{ test_id: test.replace(/^test:/, ''), assertion: c.clauses[0].assertions[0], why: 'it asserts another boundary' }] : [],
    };
  });
  const overall = decisions.every((d) => d.decision === 'WITHDRAW') && (ref.unchanged_gaps ?? []).length === 0 ? 'PASS' : 'GAPS';
  return { schema: 'mycelink-acceptance-refinement/1', feature_id: packet.feature_id, review_id: packet.review_id, dispatch_id: packet.dispatch_id, inputs_sha256: packet.inputs_sha256, reviewer: { agent: REVIEWER, model }, decisions, overall };
}

/**
 * The reviewer subagent's run, as the host's Agent call shows it: launched
 * through the plugin's hook (which records the launch), Claude Code's own
 * records kept (the session's transcript, the subagent's meta and
 * transcript), it reads the packet, then returns its verdict as `transport`
 * says — written (`file`, `both`), and/or as its final answer
 * (`both`, `agent-result`, `fenced`). `host` gives the host's own stream:
 * `emit(event)`, `nextId()`, `preToolUse(tool, input, id)` (the block
 * reason, else null) and `setParent(id, type)`.
 */
function runReviewer(ticket, host, { gaps = {}, refinements = {}, model = 'stand-in-reviewer', transport = 'file' } = {}) {
  const agent = host.nextId();
  const call = { subagent_type: ticket.agent, description: `acceptance review ${ticket.review_id}`, prompt: ticket.prompt };
  const refused = host.preToolUse('Agent', call, agent);
  if (refused !== null) throw new Error(`the plugin's hook refused the reviewer's launch: ${refused}`);
  host.emit({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: agent, name: 'Agent', input: call }] } });
  const agentId = `a${createHash('sha256').update(`${SESSION}:${agent}`).digest('hex').slice(0, 16)}`;
  const subagents = join(projects, SESSION, 'subagents');
  const own = join(subagents, `agent-${agentId}.jsonl`);
  const side = (entry) => record(own, { isSidechain: true, agentId, sessionId: SESSION, ...entry });
  record(sessionTranscript, { type: 'assistant', isSidechain: false, sessionId: SESSION, message: { id: nextMessage(), role: 'assistant', model, content: [{ type: 'tool_use', id: agent, name: 'Agent', input: call }], stop_reason: 'tool_use' } });
  mkdirSync(subagents, { recursive: true });
  writeFileSync(join(subagents, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: ticket.agent, description: call.description, toolUseId: agent, spawnDepth: 1, requestShape: 'background', requestNonInteractive: true }));
  side({ type: 'user', message: { role: 'user', content: ticket.prompt } });
  record(sessionTranscript, { type: 'user', isSidechain: false, sessionId: SESSION, message: { role: 'user', content: [{ tool_use_id: agent, type: 'tool_result', content: [{ type: 'text', text: `Async agent launched successfully.\nagentId: ${agentId}` }] }] }, toolUseResult: { isAsync: true, status: 'async_launched', agentId } });
  host.setParent(agent, ticket.agent);
  let verdict = null;
  let answer = '';
  try {
    const read = host.nextId();
    const packet = JSON.parse(readFileSync(ticket.packet_path, 'utf8'));
    const readCall = { type: 'tool_use', id: read, name: 'Read', input: { file_path: ticket.packet_path } };
    host.emit({ type: 'assistant', parent_tool_use_id: agent, message: { model, usage: { input_tokens: 1200, output_tokens: 80 }, content: [readCall] } });
    host.emit({ type: 'user', parent_tool_use_id: agent, message: { content: [{ type: 'tool_result', tool_use_id: read, content: `${packet.criteria.length} criteria` }] } });
    side({ type: 'assistant', attributionAgent: ticket.agent, attributionPlugin: 'mycelink', message: { id: nextMessage(), role: 'assistant', model, usage: { input_tokens: 1200, output_tokens: 80 }, content: [readCall], stop_reason: 'tool_use' } });
    side({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: read, content: `${packet.criteria.length} criteria` }] } });
    verdict = ticket.refinement ? refinementFor(packet, refinements, model) : verdictFor(packet, gaps, model);
    if (transport === 'file' || transport === 'both') {
      const input = { file_path: ticket.result_slot, content: JSON.stringify(verdict, null, 2) };
      const write = host.nextId();
      const blocked = host.preToolUse('Write', input, write);
      // The hook's answer is shown with the call (one write), so the harness never stops the session between them.
      process.stdout.write(
        `${JSON.stringify({ type: 'assistant', parent_tool_use_id: agent, message: { model, usage: { input_tokens: 2400, output_tokens: 900 }, content: [{ type: 'tool_use', id: write, name: 'Write', input }] } })}\n` +
          `${JSON.stringify({ type: 'user', parent_tool_use_id: agent, message: { content: [{ type: 'tool_result', tool_use_id: write, ...(blocked !== null ? { is_error: true } : {}), content: blocked ?? 'written' }] } })}\n`,
      );
      side({ type: 'assistant', attributionAgent: ticket.agent, attributionPlugin: 'mycelink', message: { id: nextMessage(), role: 'assistant', model, usage: { input_tokens: 2400, output_tokens: 900 }, content: [{ type: 'tool_use', id: write, name: 'Write', input }], stop_reason: 'tool_use' } });
      side({ type: 'user', message: { role: 'user', content: [{ tool_use_id: write, type: 'tool_result', ...(blocked !== null ? { is_error: true } : {}), content: blocked ?? 'written' }] } });
      if (blocked !== null) throw new Error(`the fence refused the reviewer's verdict: ${blocked}`);
      mkdirSync(dirname(ticket.result_slot), { recursive: true });
      writeFileSync(ticket.result_slot, input.content);
    }
    answer = transport === 'file' ? `I wrote the verdict to ${ticket.result_slot}.` : transport === 'fenced' ? `\`\`\`json\n${JSON.stringify(verdict, null, 2)}\n\`\`\`` : JSON.stringify(verdict, null, transport === 'both' ? 0 : 2);
    // Its final answer, in its transcript and the stream; its completion, in the session's.
    const final = { id: nextMessage(), role: 'assistant', model, usage: { input_tokens: 2400, output_tokens: 900 }, content: [{ type: 'text', text: answer }], stop_reason: 'end_turn' };
    side({ type: 'assistant', attributionAgent: ticket.agent, attributionPlugin: 'mycelink', message: final });
    host.emit({ type: 'assistant', parent_tool_use_id: agent, message: { model, content: [{ type: 'text', text: answer }] } });
  } finally {
    host.setParent(null, null);
  }
  record(sessionTranscript, { type: 'user', isSidechain: false, sessionId: SESSION, message: { role: 'user', content: `<task-notification>\n<task-id>${agentId}</task-id>\n<tool-use-id>${agent}</tool-use-id>\n<status>completed</status>\n<summary>Agent "${call.description}" finished</summary>\n<result>${answer}</result>\n</task-notification>` }, origin: { kind: 'task-notification' } });
  host.emit({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: agent, content: `Async agent launched successfully.\nagentId: ${agentId}` }] } });
  return { verdict, agentId };
}

/**
 * CSET-203 r13's refinement, as it should have gone (`slowRefinementMs`): the
 * reviewer is launched in the background through the plugin's hook, Claude
 * Code's records kept (the session's call and async launch result, the
 * subagent's meta and opening prompt, the stream's `task_started`), and a
 * separate process completes it after the given time — its final answer in
 * its transcript, its completion enqueued in the session's while the host is
 * busy (a queue operation, never a user message). Meanwhile the host runs
 * what r13's host ran (the ticket's ingest and settle lines together), then
 * the await line again while it answers RUNNING. Then the stream records its
 * end. Returns the verdict and the agent, the steps' answers logged.
 */
async function slowReviewer(ticket, host, { refinements = {}, gaps = {}, model = 'stand-in-reviewer' } = {}) {
  const agent = host.nextId();
  const call = { subagent_type: ticket.agent, description: `acceptance review ${ticket.review_id}`, prompt: ticket.prompt };
  const refused = host.preToolUse('Agent', call, agent);
  if (refused !== null) throw new Error(`the plugin's hook refused the reviewer's launch: ${refused}`);
  host.emit({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: agent, name: 'Agent', input: call }] } });
  const agentId = `a${createHash('sha256').update(`${SESSION}:${agent}`).digest('hex').slice(0, 16)}`;
  const subagents = join(projects, SESSION, 'subagents');
  const own = join(subagents, `agent-${agentId}.jsonl`);
  record(sessionTranscript, { type: 'assistant', isSidechain: false, sessionId: SESSION, message: { id: nextMessage(), role: 'assistant', model, content: [{ type: 'tool_use', id: agent, name: 'Agent', input: call }], stop_reason: 'tool_use' } });
  mkdirSync(subagents, { recursive: true });
  writeFileSync(join(subagents, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: ticket.agent, description: call.description, toolUseId: agent, spawnDepth: 1, requestShape: 'background', requestNonInteractive: true }));
  record(own, { isSidechain: true, agentId, sessionId: SESSION, type: 'user', message: { role: 'user', content: ticket.prompt } });
  record(sessionTranscript, { type: 'user', isSidechain: false, sessionId: SESSION, message: { role: 'user', content: [{ tool_use_id: agent, type: 'tool_result', content: [{ type: 'text', text: `Async agent launched successfully.\nagentId: ${agentId}` }] }] }, toolUseResult: { isAsync: true, status: 'async_launched', agentId } });
  host.emit({ type: 'system', subtype: 'task_started', task_id: agentId, tool_use_id: agent, description: call.description, subagent_type: ticket.agent, is_backgrounded: true, task_type: 'local_agent', session_id: SESSION });
  host.emit({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: agent, content: `Async agent launched successfully.\nagentId: ${agentId}` }] } });
  const packet = JSON.parse(readFileSync(ticket.packet_path, 'utf8'));
  const verdict = ticket.refinement ? refinementFor(packet, refinements, model) : verdictFor(packet, gaps, model);
  const answer = JSON.stringify(verdict, null, 2);
  const marker = join(dirname(plan.log), `reviewer-${agentId}.completed`);
  const completer = [
    "const fs = require('node:fs');",
    'const [own, session, sessionId, agentId, agent, description, answer, ms, marker, model] = process.argv.slice(1);',
    'setTimeout(() => {',
    '  const at = () => new Date().toISOString();',
    "  fs.appendFileSync(own, JSON.stringify({ timestamp: at(), sessionId, isSidechain: true, agentId, type: 'assistant', attributionAgent: 'mycelink:acceptance-reviewer', attributionPlugin: 'mycelink', message: { id: 'msg_slow_' + agentId, role: 'assistant', model, content: [{ type: 'text', text: answer }], stop_reason: 'end_turn' } }) + '\\n');",
    "  const note = '<task-notification>\\n<task-id>' + agentId + '</task-id>\\n<tool-use-id>' + agent + '</tool-use-id>\\n<status>completed</status>\\n<summary>Agent \"' + description + '\" finished</summary>\\n<result>' + answer + '</result>\\n</task-notification>';",
    "  fs.appendFileSync(session, JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: at(), sessionId, content: note }) + '\\n');",
    '  fs.writeFileSync(marker, String(Date.now()));',
    '}, Number(ms));',
  ].join('\n');
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['-e', completer, own, sessionTranscript, SESSION, agentId, agent, call.description, answer, String(plan.slowRefinementMs), marker, model], { stdio: 'ignore', windowsHide: true });
  const seen = { review_id: ticket.review_id, dispatch_id: ticket.dispatch_id, agent_id: agentId, early: null, awaits: [] };
  try {
    const early = { ingest: JSON.parse(shell(ticket.ingest_command).stdout || '{}'), settle: JSON.parse(shell(ticket.settle_command).stdout || '{}') };
    seen.early = { ingest: early.ingest.outcome ?? null, settle: early.settle.outcome ?? null, lifecycle: early.settle.lifecycle ?? null };
    for (let i = 0; i < 400; i++) {
      const w = JSON.parse(shell(ticket.await_command.replace(/--wait-seconds \d+/, '--wait-seconds 20')).stdout || '{}');
      seen.awaits.push({ state: w.state ?? null, elapsed_ms: w.reviewer?.elapsed_ms ?? null });
      if (w.state !== 'RUNNING') break;
    }
  } finally {
    await new Promise((r) => (child.exitCode !== null ? r() : child.on('exit', r)));
  }
  const end = existsSync(marker) ? Number(readFileSync(marker, 'utf8')) : Date.now();
  host.emit({ type: 'system', subtype: 'task_updated', task_id: agentId, patch: { status: 'completed', end_time: end }, session_id: SESSION });
  host.emit({ type: 'system', subtype: 'task_notification', task_id: agentId, tool_use_id: agent, status: 'completed', summary: 'refinement', session_id: SESSION });
  log({ slow_reviewer: seen });
  return { verdict, agentId };
}

const plan = JSON.parse(readFileSync(process.env.FAKE_CLAUDE_PLAN, 'utf8'));
const given = process.argv.slice(2);
readFileSync(0, 'utf8');
const ws = process.cwd();
const control = join(ws, 'platform');
const FEATURE = 'CSET-203';
const REPO = 'changesets';
const pluginDir = given[given.indexOf('--plugin-dir') + 1];
const bin = join(pluginDir, 'bin', 'mycelink.mjs');
// Host mode starts no worker process: an accidental nested spawn fails on a stand-in that is not there.
const env = { ...process.env, CLAUDE_PID: String(process.pid), MYCELINK_FAKE_CLAUDE: join(process.cwd(), 'no-claude-here') };
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const log = (entry) => appendFileSync(plan.log, `${JSON.stringify(entry)}\n`);

emit({ type: 'system', subtype: 'init', cwd: ws, plugins: [{ name: 'mycelink', path: pluginDir }] });

// Claude Code's own records of this session, as 2.1.290 keeps them under the session's HOME.
const SESSION = `fake-${process.pid}-${Date.now()}`;
const projects = join(process.env.HOME ?? ws, '.claude', 'projects', ws.replace(/[^A-Za-z0-9]/g, '-'));
const sessionTranscript = join(projects, `${SESSION}.jsonl`);
const record = (file, entry) => {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`);
};
let messageId = 0;
const nextMessage = () => `msg_fake_${process.pid}_${++messageId}`;

let toolId = 0;
let parent = null;
/** The subagent type of the running Agent call: a module-worker, or the acceptance reviewer. */
let parentType = null;
/** The plugin's PreToolUse hooks, as Claude Code runs them: the block reason (exit 2), else null. */
function preToolUse(tool, input, toolUseId = null) {
  const hooksFile = join(pluginDir, 'hooks', 'hooks.json');
  if (!existsSync(hooksFile)) return null;
  for (const m of JSON.parse(readFileSync(hooksFile, 'utf8')).hooks?.PreToolUse ?? []) {
    if (!new RegExp('^(?:' + m.matcher + ')$').test(tool)) continue;
    for (const h of m.hooks) {
      const argv = h.command.split('${CLAUDE_PLUGIN_ROOT}').join(pluginDir).match(/"[^"]*"|\S+/g).map((a) => a.replace(/^"|"$/g, ''));
      const payload = { session_id: SESSION, transcript_path: sessionTranscript, cwd: ws, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, ...(toolUseId !== null ? { tool_use_id: toolUseId } : {}), ...(parent ? { agent_id: parent, agent_type: parentType ?? 'mycelink:module-worker' } : {}) };
      const r = spawnSync(argv[0] === 'node' ? process.execPath : argv[0], argv.slice(1), { input: JSON.stringify(payload), env: { ...env, CLAUDE_PROJECT_DIR: ws }, encoding: 'utf8' });
      if (r.status === 2) return (r.stderr || 'Blocked').trim();
    }
  }
  return null;
}
function bash(command, run) {
  const id = `toolu_fake_${++toolId}`;
  const blocked = preToolUse('Bash', { command });
  if (blocked !== null) {
    process.stdout.write(`${JSON.stringify({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } })}\n${JSON.stringify({ type: 'user', parent_tool_use_id: parent, message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: blocked }] } })}\n`);
    return { status: 1, stdout: '', stderr: blocked };
  }
  emit({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
  const r = run();
  emit({ type: 'user', parent_tool_use_id: parent, message: { content: [{ type: 'tool_result', tool_use_id: id, content: `${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-4000) }] } });
  return r;
}
const quote = (a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
function mycelink(args, { allowFail = false } = {}) {
  const r = bash(`node ${quote(bin)} ${args.map(quote).join(' ')}`, () => spawnSync(process.execPath, [bin, ...args], { cwd: ws, env, encoding: 'utf8', maxBuffer: 64 << 20 }));
  if (r.status !== 0 && !allowFail) throw new Error(`mycelink ${args.join(' ')} exited ${r.status}\n${r.stdout}\n${r.stderr}`);
  return r;
}
const json = (args) => JSON.parse(mycelink(args).stdout);
function git(cwd, args) {
  const r = bash(`git -C ${quote(cwd)} ${args.map(quote).join(' ')}`, () => spawnSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' }));
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} exited ${r.status}: ${r.stderr}`);
  return r.stdout.trim();
}
const commitControl = (message) => {
  git(control, ['add', '--all']);
  git(control, ['commit', '-q', '--no-verify', '--allow-empty', '-m', message]);
};
function shell(line) {
  return bash(line, () => {
    try {
      return { status: 0, stdout: execSync(line, { cwd: control, env, encoding: 'utf8', stdio: 'pipe', maxBuffer: 64 << 20 }), stderr: '' };
    } catch (error) {
      return { status: error.status ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
    }
  });
}
/** r10's ending: Claude Code's refusal event, its synthetic API error and the failed result; the session exits 1. */
function refused(ticket) {
  writeFileSync(`${plan.log}.provider-ticket`, JSON.stringify(ticket));
  writeFileSync(`${plan.log}.provider-refused`, 'refused\n');
  const requestId = `req_011${createHash('sha256').update(`${SESSION}:refused`).digest('hex').slice(0, 20)}`;
  const at = new Date(Date.now() + 5).toISOString();
  const message = { model: '<synthetic>', role: 'assistant', stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'reasoning_extraction' }, content: [{ type: 'text', text: 'API Error' }] };
  record(sessionTranscript, { type: 'assistant', isSidechain: false, sessionId: SESSION, timestamp: at, requestId, message: { id: nextMessage(), role: 'assistant', model: 'stand-in', content: [{ type: 'thinking', thinking: '', signature: 'sig' }], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'reasoning_extraction' } } });
  emit({ type: 'system', subtype: 'model_refusal_no_fallback', request_id: requestId, api_refusal_category: 'reasoning_extraction' });
  record(sessionTranscript, { type: 'system', subtype: 'model_refusal_no_fallback', isSidechain: false, sessionId: SESSION, timestamp: at, requestId, apiRefusalCategory: 'reasoning_extraction' });
  emit({ type: 'assistant', parent_tool_use_id: null, is_api_error_message: true, error: 'invalid_request', request_id: requestId, timestamp: at, message });
  record(sessionTranscript, { type: 'assistant', isSidechain: false, sessionId: SESSION, timestamp: at, requestId, error: 'invalid_request', isApiErrorMessage: true, message });
  emit({ type: 'result', subtype: 'success', is_error: true, num_turns: 5, total_cost_usd: 0, stop_reason: 'refusal', terminal_reason: 'api_error', api_error_status: null, result: 'API Error' });
  log({ refused: { node: ticket.node_id, dispatch_id: ticket.dispatch_id, request_id: requestId } });
  process.exit(1);
}

/** The ticket the previous session was refused right after: presented late, with a result in its old slot. */
function presentLateTicket() {
  const file = `${plan.log}.provider-ticket`;
  if (!existsSync(file)) return;
  const old = JSON.parse(readFileSync(file, 'utf8'));
  unlinkSync(file);
  mkdirSync(dirname(old.result_slot), { recursive: true });
  writeFileSync(old.result_slot, JSON.stringify({ schema_version: 1, node_id: old.node_id, claim_id: old.claim_id, dispatch_id: old.dispatch_id, outcome: 'BLOCKED', commands: [], commit_sha: null, changed_paths: [], evidence_paths: [], failure_fingerprint: 'LATE', decision_request: null }));
  const s = JSON.parse(mycelink(['settle', FEATURE, old.node_id, '--capability', old.capability, '--control-root', control, '--json'], { allowFail: true }).stdout || '{}');
  log({ late: { node: old.node_id, outcome: s.outcome ?? null } });
}

function done(text) {
  emit({ type: 'result', subtype: 'success', is_error: false, num_turns: 9, total_cost_usd: 0, result: text });
  process.exit(0);
}
function fail(error) {
  log({ error: String(error?.stack ?? error) });
  emit({ type: 'result', subtype: 'success', is_error: false, num_turns: 9, total_cost_usd: 0, result: `stopped: ${String(error?.message ?? error).slice(0, 2000)}` });
  process.exit(0);
}
function authority() {
  const opened = mycelink(['controller', 'open', '--control-root', control, '--json'], { allowFail: true });
  if (opened.status === 0) return JSON.parse(opened.stdout).authority;
  return json(['controller', 'open', '--recover', '--control-root', control, '--json']).authority;
}

const ARP = `${FEATURE}.changesets.apply-release-plan.crash-safe`;
const CLI = `${FEATURE}.changesets.cli.version-recovery`;
const COMPAT = `${FEATURE}.changesets.compat.regression`;
const CANDIDATE = `${FEATURE}.candidate.build`;
const MODULE = { [ARP]: 'apply-release-plan', [CLI]: 'cli' };

/** The approved criteria, verbatim, as `feature acceptance` wrote them from the requirement's sidecar. */
const approved = () => JSON.parse(readFileSync(join(control, 'features', FEATURE, 'ACCEPTANCE.json'), 'utf8'));

/** CSET-203 as r1 with-faults' planner graphed it, its compat node a verification node proving AC-5 again after the cli produced it, and a candidate build after all. */
function graph(repo) {
  const verifier = (id) => repo.modules.find((m) => m.id === id).verifier;
  const worker = { model: 'sonnet', effort: 'high', max_turns: 60, max_wall_clock_minutes: 60, max_attempts: 2, nested_delegation: false };
  const impl = (id, module, extra) => ({
    id,
    level: 'executable-node',
    repository: REPO,
    capability: module === 'cli' ? 'CAP-CLI-RECOVER-FAIL' : 'CAP-ARP-ROLLBACK-JOURNAL',
    node_type: 'implementation',
    allowed_paths: [`packages/${module}/**`],
    forbidden_paths: [],
    contract_inputs: [],
    contract_outputs: [],
    required_resources: [],
    required_evidence: ['red', 'green', 'regression'],
    verification_commands: [verifier(module)],
    worker,
    invalidation_rules: [],
    ...extra,
  });
  return {
    schema_version: 1,
    feature_id: FEATURE,
    title: 'Crash-safe changeset version',
    prd: `features/${FEATURE}/PRD.md`,
    acceptance_criteria: approved().criteria.map((c) => ({ id: c.id, text: c.text, kind: c.kind })),
    resources: { workspace: { capacity: 1 } },
    repositories: [REPO],
    capabilities: [
      { id: 'CAP-ARP-ROLLBACK-JOURNAL', repository: REPO, title: 'applyReleasePlan rolls back and journals', acceptance_criteria: ['AC-1', 'AC-2'] },
      { id: 'CAP-CLI-RECOVER-FAIL', repository: REPO, title: 'changeset version recovers and fails cleanly', acceptance_criteria: ['AC-3', 'AC-4', 'AC-5'] },
      { id: 'CAP-COMPAT', repository: REPO, title: 'successful runs, status and add unchanged', acceptance_criteria: ['AC-5'] },
    ],
    nodes: [
      impl(ARP, 'apply-release-plan', { depends_on: [], acceptance_criteria: ['AC-1', 'AC-2'] }),
      // The cli produces AC-5 (status and version as before); the verification node proves it again: never its only owner.
      impl(CLI, 'cli', { depends_on: [ARP], acceptance_criteria: ['AC-3', 'AC-4', 'AC-5'] }),
      {
        id: COMPAT,
        level: 'executable-node',
        repository: REPO,
        capability: 'CAP-COMPAT',
        node_type: 'verification',
        depends_on: [ARP, CLI],
        allowed_paths: [],
        forbidden_paths: ['packages/**'],
        contract_inputs: [],
        contract_outputs: [],
        required_resources: [],
        required_evidence: ['green', 'regression'],
        verification_commands: [verifier('apply-release-plan'), verifier('cli'), { id: 'full-suite', command: repo.commands.test }],
        worker: { ...worker, effort: 'medium', max_turns: 15, max_wall_clock_minutes: 45 },
        invalidation_rules: [{ when: 'any upstream node result changes', action: 'RERUN_REGRESSION' }],
        acceptance_criteria: ['AC-5'],
      },
      {
        id: CANDIDATE,
        level: 'executable-node',
        repository: null,
        capability: null,
        node_type: 'candidate-build',
        depends_on: [ARP, CLI, COMPAT],
        allowed_paths: [],
        forbidden_paths: [],
        contract_inputs: [],
        contract_outputs: [],
        required_resources: [],
        required_evidence: ['candidate'],
        verification_commands: [{ id: 'candidate', command: ['mycelink', 'candidate', 'verify', FEATURE] }],
        worker: { ...worker, max_turns: 1 },
        invalidation_rules: [],
        acceptance_criteria: [],
      },
    ],
  };
}

/** A call shown as the host's, run with no plugin hook before it: what the fence never saw. */
function unhooked(command, effect) {
  const id = `toolu_fake_${++toolId}`;
  process.stdout.write(`${JSON.stringify({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } })}\n`);
  effect();
  process.stdout.write(`${JSON.stringify({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: id, content: '' }] } })}\n`);
}

/**
 * CSET-203 r9's first controller (`plan.r9`, its first task session only): Mycelink initialised and the key open, it
 * runs a graph generator of its own that writes ACCEPTANCE.json through a path it computes — where the fence never
 * saw it — flips an index mode bit in the product repository and leaves a symlink in the workspace, then carries
 * on (to be stopped). Its corrective session goes through Mycelink from where it stands.
 */
async function r9Forgery() {
  const marker = `${plan.log}.r9-forged`;
  if (!plan.r9) return;
  // Once: the marker is created exclusively, or this forgery already ran.
  try {
    writeFileSync(marker, 'forged\n', { flag: 'wx' });
  } catch {
    return;
  }
  // A model's next call comes seconds after the core's last write, not within the file system's clock tick: forged
  // sooner, a file's ctime can fall before the core's ledger record, and the settlement rightly cannot tell which came
  // first — it rolls the whole session back (CSET-203 r10: 8 of 15 such writes on WSL, none 50 ms later).
  await new Promise((r) => setTimeout(r, 250));
  const script = "import json, os\np = '/'.join(['features', 'CSET-203', 'ACCEPT' + 'ANCE.json'])\nos.makedirs(os.path.dirname(p), exist_ok=True)\njson.dump({'criteria': []}, open(p, 'w'))\n";
  const repoDir = join(ws, 'repos', REPO);
  unhooked(`cd ${quote(control)}; cat > gen.py <<'EOF'\n${script}EOF\npython3 gen.py; git -C ${quote(repoDir)} update-index --chmod=+x package.json; ln -s platform ${quote(join(ws, 'plat'))}`, () => {
    writeFileSync(join(control, 'gen.py'), script);
    mkdirSync(join(control, 'features', FEATURE), { recursive: true });
    writeFileSync(join(control, 'features', FEATURE, 'ACCEPTANCE.json'), JSON.stringify({ criteria: [] }));
    spawnSync('git', ['-C', repoDir, 'update-index', '--chmod=+x', 'package.json'], { env });
    symlinkSync('platform', join(ws, 'plat'));
  });
  log({ forged: 'r9' });
  await new Promise((r) => setTimeout(r, 600_000));
}

async function setUp() {
  if (!existsSync(join(control, 'mycelink.config.json'))) {
    mycelink(['init', control]);
  }
  const key = authority();
  await r9Forgery();
  const featureDir = join(control, 'features', FEATURE);
  if (!existsSync(join(featureDir, 'STATE.json'))) {
    const repo = json(['repo', 'modules', '--control-root', control, '--json']).repositories.find((r) => r.name === REPO);
    mkdirSync(featureDir, { recursive: true });
    writeFileSync(join(featureDir, 'PRD.md'), readFileSync(join(control, 'requirements', `${FEATURE}.md`)));
    const acceptance = json(['feature', 'acceptance', FEATURE, '--source', `requirements/${FEATURE}.md`, '--control-root', control, '--authority', key, '--json']);
    log({ acceptance: { from: acceptance.from, criteria: acceptance.criteria.map((c) => ({ id: c.id, kind: c.kind, sha256: c.sha256 })) } });
    writeFileSync(join(featureDir, 'PORTFOLIO-GRAPH.yaml'), JSON.stringify(graph(repo), null, 2) + '\n');
    commitControl(`${FEATURE}: control plane`);
    mycelink(['graph', 'validate', FEATURE, '--control-root', control, '--json']);
    mycelink(['feature', 'init', FEATURE, '--control-root', control, '--authority', key, '--json']);
    commitControl(`${FEATURE}: feature initialised`);
  }
  return key;
}

function packOf(ticket) {
  const m = /<mycelink-context-pack>\s*([\s\S]*?)\s*<\/mycelink-context-pack>/.exec(ticket.prompt ?? '');
  return m ? JSON.parse(m[1]) : null;
}

async function work(ticket) {
  const id = `toolu_fake_${++toolId}`;
  emit({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id, name: 'Agent', input: { subagent_type: ticket.agent, description: ticket.node_id, prompt: ticket.prompt } }] } });
  parent = id;
  try {
    return worker(ticket);
  } finally {
    parent = null;
    emit({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: id, content: `${ticket.node_id}: result written` }] } });
  }
}

/** A line of the brief: `- <name> (...): <line>` or `- <name>: <line>`. */
const briefLine = (ticket, name) => new RegExp(`^- ${name}(?: \\([^)]*\\))?: (.+)$`, 'm').exec(ticket.prompt)?.[1] ?? null;

/** The bound test a criterion names, by its canonical id: the brief's tests line, narrowed by its words as the skill says. */
function testIdOf(ticket, c) {
  const line = `${briefLine(ticket, 'tests').replace(/ \[--gate[\s\S]*$/, '')} --gate ${c.gate} --match ${quote(c.name)} --json`;
  const r = shell(line);
  const tests = JSON.parse(r.stdout || '{"tests":[]}').tests ?? [];
  const hit = tests.find((t) => t.path === c.path && (t.full_name === c.name || t.full_name.endsWith(` > ${c.name}`)));
  if (!hit) throw new Error(`no ${c.gate} test ${c.path} › ${c.name} for ${ticket.node_id}: ${tests.length} matched`);
  return hit.id;
}

let mistaken = false;
const challenged = new Set();

/** The first worker of an acceptance review's rework of a planned module: the review's exact reproduction passes; it challenges the gap. */
function challenger(ticket, planned) {
  const wt = ticket.worktree;
  const seen = { node: ticket.node_id, challenge: true, red: null, check: null, outcome: null };
  try {
    const paths = [];
    for (const [path, body] of Object.entries(planned.tests)) {
      const f = join(wt, ...path.split('/'));
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, body);
      paths.push(path);
    }
    const red = shell(ticket.gate_commands.find((g) => g.gate === 'red').command);
    seen.red = { exit: red.status, passing: /review-gap challenge/i.test(`${red.stdout}${red.stderr}`), sha256: /sha256 ([0-9a-f]{64})/.exec(`${red.stdout}${red.stderr}`)?.[1] ?? null };
    if (!seen.red.passing) throw new Error(`the red gate did not find the reproduction passing: ${red.stdout}${red.stderr}`.slice(0, 3000));
    const skeleton = JSON.parse(shell(`${briefLine(ticket, 'challenge')} --json`).stdout || '{}');
    if (skeleton.ok !== true) throw new Error(`challenge line: ${JSON.stringify(skeleton).slice(0, 2000)}`);
    const challenge = skeleton.challenge;
    const tests = skeleton.tests.filter((t) => planned.tests_named.some((n) => t.full_name === n || t.full_name.endsWith(` > ${n}`)));
    for (const gap of challenge.gaps) {
      gap.tests = tests.map((t) => t.id);
      gap.clauses = planned.clauses.map((c) => {
        const t = tests.find((x) => x.full_name === c.test || x.full_name.endsWith(` > ${c.test}`));
        const lines = readFileSync(join(wt, ...t.path.split('/')), 'utf8').split('\n');
        const start = lines.findIndex((l) => l.includes(c.test));
        const at = c.needles.map((n) => lines.findIndex((l, i) => i > start && l.includes(n)) + 1);
        return { clause: c.clause, test_id: t.id, assertions: [`file:${skeleton.repository}:${t.path}#L${Math.min(...at)}-L${Math.max(...at)}`], trace: c.trace };
      });
      gap.explanation = planned.explanation;
    }
    const result = { schema_version: 1, node_id: ticket.node_id, claim_id: ticket.claim_id, ...(ticket.dispatch_id ? { dispatch_id: ticket.dispatch_id } : {}), outcome: 'REVIEW_GAP_CHALLENGE', commands: [{ command: ['gate:red'], exit_code: red.status }], commit_sha: git(wt, ['rev-parse', 'HEAD']), changed_paths: paths, evidence_paths: [], failure_fingerprint: null, decision_request: null, challenge };
    mkdirSync(dirname(ticket.result_slot), { recursive: true });
    writeFileSync(ticket.result_slot, JSON.stringify(result, null, 2));
    const check = shell(`${briefLine(ticket, 'check')} --json`);
    seen.check = JSON.parse(check.stdout || '{}');
    if (seen.check.ok !== true) throw new Error(`tdd check refused the challenge: ${check.stdout}`.slice(0, 3000));
    seen.outcome = 'REVIEW_GAP_CHALLENGE';
    seen.challenge_id = null;
  } finally {
    log({ worker: seen });
  }
}

function worker(ticket) {
  const pack = packOf(ticket);
  const module = MODULE[ticket.node_id];
  const correction = pack?.correction ?? null;
  const cycle = correction?.cycle === true;
  const rework = pack?.rework ?? null;
  // CSET-203 r6: an acceptance review's first rework of a planned module challenges the gap whose reproduction already passes.
  const challenging = rework?.origin?.kind === 'acceptance-review' && rework.origin.refinement === undefined ? plan.challenge?.[module] : undefined;
  if (challenging && !challenged.has(ticket.node_id)) {
    challenged.add(ticket.node_id);
    return challenger(ticket, challenging);
  }
  // A dependent reopened by an upstream rework keeps its RED: it re-proves GREEN and regression only.
  const regreen = !cycle && rework === null && pack?.next_required_gate === 'GREEN_VERIFIED';
  const plannedWork = cycle ? plan.correction[module] : rework !== null ? plan.rework?.[module] : plan.modules[module];
  if (!plannedWork) throw new Error(`no planned work for ${ticket.node_id} (${rework !== null ? 'rework' : cycle ? 'correction' : 'first submission'})`);
  const wt = ticket.worktree;
  const printed = {};
  /** The red gate's output hash of each cycle, in order. */
  const reds = [];
  const seen = { node: ticket.node_id, module: pack?.module?.id ?? null, correction: correction && { code: correction.code, criterion: correction.criterion, kind: correction.kind, required_gate: correction.required_gate, cycle: correction.cycle, corrections: correction.corrections }, brief: /^Acceptance criteria — /m.test(ticket.prompt), gates: [], check: null };
  if (correction) log({ correction: { node: ticket.node_id, ...seen.correction, top: ticket.prompt.split('\n').slice(0, 12).join('\n') } });
  const gate = (name) => {
    const line = ticket.gate_commands.find((g) => g.gate === name)?.command;
    if (!line) throw new Error(`no ${name} gate for ${ticket.node_id}`);
    const r = shell(line);
    const out = `${r.stdout}${r.stderr}`;
    seen.gates.push({ gate: name, exit: r.status, tail: out.slice(-1500) });
    if (r.status !== 0) throw new Error(`${name} gate of ${ticket.node_id} exited ${r.status}: ${out.slice(-3000)}`);
    const sha = /sha256 ([0-9a-f]{64})/.exec(r.stdout)?.[1];
    if (sha) printed[name] = sha;
    if (sha && name === 'red') reds.push(sha);
    if (name === 'red') seen.red_tests = [...r.stdout.matchAll(/^ {2}([0-9a-f]{16}) (passed|failed|skipped) (.+?) › (.*)$/gm)].map((m) => ({ id: m[1], status: m[2], path: m[3], name: m[4] }));
    return { command: [`gate:${name}`], exit_code: 0 };
  };
  /** A worker's own commit, as a patch it applies to its worktree: the paths it changed. */
  const applyPatch = (patches) => {
    for (const patch of [patches].flat()) git(wt, ['apply', '--whitespace=nowarn', patch]);
    return [...new Set([...git(wt, ['diff', '--name-only']).split('\n'), ...git(wt, ['ls-files', '--others', '--exclude-standard']).split('\n')].filter(Boolean))];
  };
  /** Edits a worker makes in place: `{ path, find, replace, last? }`, each find present exactly where it says. */
  const applyEdits = (edits) => {
    const paths = [];
    for (const e of edits) {
      const file = join(wt, ...e.path.split('/'));
      const body = readFileSync(file, 'utf8');
      const at = e.last ? body.lastIndexOf(e.find) : body.indexOf(e.find);
      if (at < 0) throw new Error(`${e.path} no longer holds ${e.find.slice(0, 80)}`);
      writeFileSync(file, body.slice(0, at) + e.replace + body.slice(at + e.find.length));
      if (!paths.includes(e.path)) paths.push(e.path);
    }
    return paths;
  };
  const tests = (c) => (c.testPatch ? applyPatch(c.testPatch) : c.testEdits ? applyEdits(c.testEdits) : write(c.tests));
  const impl = (c) => (c.implPatch ? applyPatch(c.implPatch) : c.implEdits ? applyEdits(c.implEdits) : write(c.impl));
  const write = (files) => {
    const changed = [];
    for (const [path, body] of Object.entries(files)) {
      const file = join(wt, ...path.split('/'));
      // What is there, read once (nothing there reads as null): no look first, then a read.
      if (readOrNull(file) === body) continue;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, body);
      changed.push(path);
    }
    return changed;
  };
  const commit = (paths, message) => {
    if (paths.length === 0) return;
    git(wt, ['add', '--', ...paths]);
    git(wt, ['commit', '-q', '--no-verify', '-m', message]);
  };
  const commands = [];
  const changed = [];
  try {
    if (correction && !cycle) throw new Error(`a metadata-only correction was not expected: ${correction.code}`);
    if (rework !== null) seen.rework = { reason: rework.reason, acceptance_criteria: rework.acceptance_criteria, origin: rework.origin ?? null, carried: (rework.carried_criteria ?? []).map((c) => c.criterion) };
    if (regreen) {
      commands.push(gate('green'));
    } else {
      // One complete cycle per entry: the tests alone through red and committed, then production through green and committed.
      const cycles = plannedWork.cycles ?? [{ tests: plannedWork.tests, impl: plannedWork.impl }];
      for (const [i, c] of cycles.entries()) {
        const t = tests(c);
        commands.push(gate('red'));
        commit(t, c.testMessage ?? `test(${module}): ${cycle ? 'AC-4: a failed apply is reported without a stack trace, exit 1' : 'cover rolling back and recovering changeset version'}${cycles.length > 1 ? ` (${i + 1})` : ''}`);
        changed.push(...t);
        const p = impl(c);
        commands.push(gate('green'));
        commit(p, c.implMessage ?? `feat(${module}): ${cycle ? 'report a failed apply without a stack trace and exit 1' : 'crash-safe changeset version'}${cycles.length > 1 ? ` (${i + 1})` : ''}`);
        changed.push(...p);
      }
    }
    // A compatibility criterion's regression test, alone after the code, with its trailer; green again so its output names it.
    if (!regreen && plannedWork.compat) {
      const t = applyEdits(plannedWork.compat.testEdits);
      git(wt, ['add', '--', ...t]);
      git(wt, ['commit', '-q', '--no-verify', '-m', plannedWork.compat.message, '-m', `Mycelink-Compatibility: ${plannedWork.compat.criteria}`]);
      changed.push(...t);
      seen.compat = { commit: git(wt, ['rev-parse', 'HEAD']), criteria: plannedWork.compat.criteria };
      commands.push(gate('green'));
    }
    commands.push(gate('regression'));
    const heldRed = correction?.gates?.find((g) => g.gate === 'red')?.output_sha256 ?? null;
    const keptRed = (pack?.latest_evidence ?? []).find((e) => e.kind === 'red')?.output_sha256 ?? null;
    const outputOf = (c) => (c.held && heldRed ? heldRed : regreen && c.gate === 'red' ? keptRed : c.gate === 'red' && c.cycle !== undefined ? reds[c.cycle] : printed[c.gate]);
    const evidence = [
      ...plannedWork.criteria.map((c) => ({ criterion: c.criterion, test_id: testIdOf(ticket, c), gate: c.gate, output_sha256: outputOf(c) })),
      // The criteria the rework does not name keep a carried proof of the generation it replaced, cited exactly as the pack gives it.
      ...(rework?.carried_criteria ?? []).map((c) => ({ criterion: c.criterion, test_id: c.test_id, gate: c.gate ?? 'red', output_sha256: c.output_sha256 })),
    ];
    const result = {
      schema_version: 1,
      node_id: ticket.node_id,
      claim_id: ticket.claim_id,
      ...(ticket.dispatch_id ? { dispatch_id: ticket.dispatch_id } : {}),
      outcome: 'SUBMITTED',
      commands,
      commit_sha: git(wt, ['rev-parse', 'HEAD']),
      changed_paths: changed,
      evidence_paths: [],
      failure_fingerprint: null,
      decision_request: null,
      criterion_evidence: evidence,
    };
    mkdirSync(dirname(ticket.result_slot), { recursive: true });
    writeFileSync(ticket.result_slot, JSON.stringify(result, null, 2));
    // The brief's check line: the evidence judged as settle will, before submitting.
    const check = briefLine(ticket, 'check');
    if (check) {
      const r = shell(`${check} --json`);
      seen.check = JSON.parse(r.stdout || '{}');
      // r1's cli worker submitted AC-4 through GREEN anyway: the stand-in does too, once, so settle holds it.
      if (!seen.check.ok && !(plan.correction && module === 'cli' && !mistaken)) throw new Error(`tdd check refused ${ticket.node_id}: ${r.stdout}`);
    }
    if (module === 'cli') mistaken = true;
  } finally {
    log({ worker: seen });
  }
}

/** The host's side of the stand-in reviewer subagent: its stream, its hooks, its Agent call. */
const reviewHost = {
  emit,
  nextId: () => `toolu_fake_${++toolId}`,
  preToolUse: (tool, input, id = null) => preToolUse(tool, input, id),
  setParent: (id, type) => {
    parent = id;
    parentType = type;
  },
};

/** Reviewer generations of a review handed out so far, in every session of the run (corrections and refinements included): the plan log's. */
const generationsOf = (reviewId) => readFileSync(plan.log, 'utf8').split('\n').filter((l) => l.includes('"review"')).map((l) => JSON.parse(l)).filter((e) => e.review?.review_id === reviewId).length;

async function settleAndDeliver(key) {
  for (let i = 0; i < 24; i++) {
    const d = JSON.parse(mycelink(['dispatch', FEATURE, '--control-root', control, '--authority', key, '--json'], { allowFail: true }).stdout);
    for (const r of d.controller_reports ?? []) log({ controller: { node: r.node_id, outcome: r.outcome, detail: String(r.detail).slice(0, 300) } });
    if (d.status === 'ALL_SETTLED') {
      commitControl(`${FEATURE}: settled`);
      const delivery = json(['deliver', FEATURE, '--control-root', control, '--authority', key, '--json']);
      log({ delivery: { status: delivery.status, candidate_id: delivery.candidate_id } });
      if (delivery.status !== 'ACCEPTED') throw new Error(`delivery ${delivery.status}`);
      commitControl(`${FEATURE}: delivered`);
      mycelink(['feature', 'verify', FEATURE, '--delivered', '--control-root', control, '--json']);
      return delivery;
    }
    if (d.status !== 'DISPATCHED') throw new Error(`dispatch stopped: ${d.status} ${d.detail ?? ''}`);
    if (d.ticket.kind === 'acceptance-review') {
      // The acceptance review before any candidate: the read-only reviewer subagent's verdict, then the ticket's ingest and settle lines.
      const generation = generationsOf(d.ticket.review_id);
      const transports = plan.reviewTransport?.[d.ticket.review_id] ?? [];
      const transport = transports[Math.min(generation, transports.length - 1)] ?? 'file';
      const first = generation === 0 ? (plan.reviewFirst?.[d.ticket.review_id] ?? {}) : {};
      const opts = { gaps: { ...(plan.reviewGaps?.[d.ticket.review_id] ?? {}), ...first }, refinements: plan.refinements?.[d.ticket.review_id] ?? {}, transport };
      const { verdict, agentId } = plan.slowRefinementMs && d.ticket.refinement ? await slowReviewer(d.ticket, reviewHost, opts) : runReviewer(d.ticket, reviewHost, opts);
      const ing = shell(d.ticket.ingest_command);
      const ingested = JSON.parse(ing.stdout || '{}');
      const r = shell(d.ticket.settle_command);
      const s = JSON.parse(r.stdout || '{}');
      log({ review: { review_id: d.ticket.review_id, dispatch_id: d.ticket.dispatch_id, criteria: d.ticket.criteria, refinement: d.ticket.refinement ? (verdict.decisions ?? []).map((x) => [x.criterion, x.decision]) : null, correction: d.ticket.correction?.number ?? null, transport, agent_id: agentId, ingest: ingested.outcome ?? null, ingest_transport: ingested.transport ?? null, verdict: (verdict.criteria ?? []).map((c) => [c.criterion, c.verdict]), outcome: s.outcome ?? null, code: s.code ?? null, settled_transport: s.transport?.kind ?? null, reworked: s.reworked ?? [], detail: String(s.detail ?? r.stderr).slice(0, 300) } });
      if (s.outcome === 'REVIEW_INVALID' && s.blocked === false) {
        // Refused for its form: the next dispatch hands its correction to a fresh reviewer.
        commitControl(`${FEATURE}: review ${d.ticket.review_id} refused ${s.code}`);
        continue;
      }
      if (s.outcome !== 'PASS' && s.outcome !== 'GAPS') throw new Error(`review settle ${d.ticket.review_id}: ${s.outcome} ${s.code ?? ''} ${s.detail ?? r.stderr}`);
      commitControl(`${FEATURE}: review ${d.ticket.review_id} ${s.outcome}`);
      continue;
    }
    // r10: the module's n-th ticket is out, no worker has run, and the controller's next request is refused (once).
    const module = MODULE[d.ticket.node_id];
    log({ dispatched: { node: d.ticket.node_id } });
    const nth = readFileSync(plan.log, 'utf8').split('\n').filter((l) => l.includes('"dispatched"')).map((l) => JSON.parse(l)).filter((e) => MODULE[e.dispatched?.node] === module).length;
    if (plan.providerRefusal && plan.providerRefusal.module === module && nth === plan.providerRefusal.dispatch && !existsSync(`${plan.log}.provider-refused`)) refused(d.ticket);
    await work(d.ticket);
    const s = JSON.parse(mycelink(['settle', FEATURE, d.ticket.node_id, '--capability', d.ticket.capability, '--control-root', control, '--json'], { allowFail: true }).stdout);
    log({ settled: { node: d.ticket.node_id, outcome: s.outcome, detail: s.detail ?? null } });
    if (s.outcome === 'EVIDENCE_CORRECTION_REQUIRED') {
      const rt = JSON.parse(readFileSync(join(control, 'features', FEATURE, 'STATE.json'), 'utf8')).data.nodes[d.ticket.node_id];
      log({ held: { node: d.ticket.node_id, detail: s.detail.slice(0, 300), attempts: rt.attempts, failures: Object.keys(rt.failure_counts).length, claim: rt.claim?.claim_id ?? null, correction: rt.claim?.evidence_correction && { criterion: rt.claim.evidence_correction.criterion, cycle: rt.claim.evidence_correction.cycle } } });
      // As the corrective controller would: reconcile names it, dispatch --resume hands it to a genuine worker.
      const pending = json(['session', 'reconcile', FEATURE, '--control-root', control, '--authority', key, '--json']).pending_dispatches;
      log({ reconciled: pending.map((p) => ({ node: p.node_id, settlement: p.settlement })) });
      const resumed = JSON.parse(mycelink(['dispatch', FEATURE, '--resume', d.ticket.node_id, '--control-root', control, '--authority', key, '--json']).stdout);
      if (resumed.status !== 'DISPATCHED') throw new Error(`resume: ${resumed.status} ${resumed.detail}`);
      await work(resumed.ticket);
      const again = JSON.parse(mycelink(['settle', FEATURE, d.ticket.node_id, '--capability', resumed.ticket.capability, '--control-root', control, '--json'], { allowFail: true }).stdout);
      log({ settled: { node: d.ticket.node_id, outcome: again.outcome, detail: again.detail ?? null } });
      if (again.outcome !== 'DONE') throw new Error(`settle ${d.ticket.node_id}: ${again.outcome} ${again.detail ?? ''}`);
    } else if (s.outcome === 'REVIEW_CHALLENGED') {
      log({ challenged: { node: d.ticket.node_id, challenge: s.challenge ?? null } });
      commitControl(`${FEATURE}: ${d.ticket.node_id} challenged its review gap`);
      // As r4's corrective did: the session exits 0 here, the feature incomplete; the continuation goes on (once).
      const marker = `${plan.log}.exited-after-challenge`;
      // Once: the marker is created exclusively, or this exit already happened.
      if (plan.exitAfterChallenge && createdOnce(marker, 'exited\n')) {
        const status = JSON.parse(mycelink(['feature', 'status', FEATURE, '--control-root', control, '--json']).stdout);
        log({ exit: { after: 'challenge', next_action: status.next_action?.kind ?? null, resumable: status.resumable ?? null } });
        done(`${d.ticket.node_id} challenged its review gap; stopping here.`);
      }
      continue;
    } else if (s.outcome !== 'DONE') throw new Error(`settle ${d.ticket.node_id}: ${s.outcome} ${s.detail ?? ''}`);
    commitControl(`${FEATURE}: ${d.ticket.node_id} settled`);
  }
  throw new Error('the feature never settled');
}

log({ phase: 'task' });
try {
  const key = await setUp();
  presentLateTicket();
  const delivery = await settleAndDeliver(key);
  done(`Delivered ${delivery.candidate_id}. Tests: every gate passed.`);
} catch (error) {
  fail(error);
}
