#!/usr/bin/env node
/**
 * A stand-in for a with-arm `claude -p --output-format stream-json` host
 * session in the arm driver's tests (never a benchmark subject). It drives
 * the sealed Mycelink plugin the run passes with `--plugin-dir`, the way the
 * plugin's run command tells a host to, on the toy workspace, as directed by
 * the JSON file in $FAKE_CLAUDE_PLAN:
 *
 *   { log, work: { <module>: { tests, impl, draft? } }, regression: { <module>: tests }, taskStalls?: [stage],
 *     reworkStalls?: [stage], reworkDirect?, reworkNoop?, reworkVia?, reviews?: { <module>: [{ reason, tests, impl }] } }
 *
 * task:   create the control repository, open the controller key (recover it
 *         when an earlier session held it), register the project, plan one
 *         node per module (mod-b after mod-a), then dispatch -> worker ->
 *         settle until every node settles, deliver, and finish once `feature
 *         verify --delivered` passes. Every step is skipped when it is
 *         already done, so a fresh session resumes. The n-th task session
 *         waits to be interrupted at taskStalls[n].
 * rework: (QA's report, alone or after the resume header) recover the key,
 *         read the feature's status, find the producer node of what moved on
 *         main since the delivery (`feature owners --since-delivery`) and
 *         rework it with QA's checks as the reason, then dispatch again — the
 *         reworked node's fresh worker commits a regression test the red gate
 *         accepts, then the fix; a dependent reopened with it re-proves GREEN
 *         — deliver the new candidate, and finish once `feature verify
 *         --delivered` passes. The n-th rework session waits to be
 *         interrupted at reworkStalls[n]. A stall is 'start' (before
 *         anything), 'red' (after the first worker's test commit) or 'green'
 *         (after its production commit). A dispatch an ended session left
 *         is reconciled and resumed, its worker carrying on from the gate
 *         its pack names. With `reworkDirect` the session instead reverts
 *         the reported commit on main itself (the fourth pilot) and carries
 *         on for ten minutes; with `reworkNoop` it only reads the feature's
 *         status and exits 0. `reworkDirect` may be a list, one entry per
 *         rework session (a corrective session included). With
 *         `reworkVia: 'command'` the session invokes the plugin's
 *         /mycelink:rework (a Skill call) and attributes and reworks in one
 *         step: `feature rework --since-delivery <repository>:<module>/`, the
 *         module QA's report names.
 * hooks: false — a host that runs no plugin hook for itself or its workers (the bench's own monitor is then the only boundary); the reviewer's verdict Write still goes through it, so it is attested.
 * taskExits: [stage per task session] — the n-th task session exits 0 there with the feature incomplete, as
 *         CSET-203 r4's corrective controller did: 'setup' (once the control plane is set up) or 'settled-one'
 *         (after its first node settles DONE). A continuation's prompt is a task session's too.
 * taskTakeover: [bool per task session] — CSET-202 r2's controller: while the first worker runs (after its
 *         RED commit) the session writes that worker's result slot itself, then carries on for ten minutes.
 * reviews: as the PCM-103 controller did, the task reworks a module's node
 *         after it settles, once per review in order (a module's first
 *         worker writes its `draft`; each review's worker its tests, then
 *         its impl), before the candidate.
 * forgeries: [kind per task session] — what the n-th task session changes itself, outside Mycelink, where the
 *         plugin's fence never sees it (CSET-203 r9: a script the fence could not read): 'r9' (once Mycelink is
 *         initialised and the key open, a helper gen.py in the control repository writes the feature's
 *         ACCEPTANCE.json through a path it computes), 'delete' (removes the feature's events.jsonl), 'rename'
 *         (renames its STATE.json aside and back under a new name), 'chmod' (makes mycelink.config.json
 *         read-only), 'symlink' (replaces the approved requirement with a symlink), 'commit' (commits a change on
 *         main in the product repository), 'helper' (starts a background process that writes LOOPS.json a moment
 *         later), 'after-settle' (a scratch file at the workspace root once its first node settled DONE),
 *         'registry' (edits repositories.yaml, then goes on through Mycelink). A kind ending in '-exit' exits 0
 *         right after; otherwise the session carries on for ten minutes (to be stopped), except 'registry'.
 *         A write the plugin's fence refuses (hooks on) changed nothing: the controller carries on through Mycelink.
 * taskRefusals: [stage per task session] — CSET-203 r10: right after the n-th task session's first worker ticket is
 *         dispatched (before any worker runs), its next request fails as Claude Code records it — in its stream and its
 *         on-disk transcript — and the session exits 1: 'after-dispatch' (a provider safeguard refusal,
 *         reasoning_extraction), 'rate-limit-after-dispatch', 'auth-after-dispatch'. The next task session first presents
 *         that ticket's capability late, with a result in its old slot, and logs the answer ({ late }).
 * reviewRefusals: [kind per acceptance-review ticket] — 'refusal': that reviewer's final request is refused by the
 *         provider (its transcript ends on Claude Code's API error, launched through the plugin's hook); the host runs the
 *         ticket's ingest and settle lines and goes on. With it, each review's settle is logged ({ reviewed }).
 * asyncWorkers: true — each module-worker is launched in the background, as CSET-202's host did: the stream's
 *         `task_started`, an "Async agent launched" result and an asynchronous PostToolUse; its task's notification when
 *         it stops. hostWait: '<command>' — meanwhile the host waits on it in that one foreground Bash call (CSET-202's
 *         `sleep 100; echo waiting`), which ends, timed out, only after the worker's notification.
 * workerStash: { <module>: { leave?, shape?: 'cset202', holdMs? } } — CSET-203 r12's worker sets its production draft aside
 *         with git stash around the red gate. shape 'cset202', as CSET-202's did, call by call: a production draft and the
 *         tests; one call sets the draft aside and runs the red gate (`cd <wt> && git stash push -q -- <src> && <red line>`); the
 *         entry stays live holdMs (default 1500; CSET-202's for 18 s) while it edits on; one call commits the test and pops
 *         the draft back (`cd <wt> && git add ... && git commit ... && git stash pop -q && git status --short`).
 * compact: true — the host's context is compacted once while a worker's entry is live (the stream's `compact_boundary`).
 * reviewerLifecycle: [mode per reviewer ticket of the run, every session's] — CSET-203 r13: 'slow': the reviewer runs in
 *         the background for `slowReviewerMs` (default 6000) and completes on its own, its completion enqueued mid-turn as
 *         2.1.290 records it; meanwhile the host runs the ticket's ingest and settle lines at once (as r13's did), then its
 *         await line until it no longer answers RUNNING, then ingest and settle (logged: { slow_reviewer }). 'exit-running':
 *         the session exits 0 right after launching the reviewer, which never completes. With it, every reviewer ticket is logged
 *         ({ review_ticket }).
 *
 * The worker is the host's own stand-in for the module-worker subagent: it
 * runs the ticket's gate lines, commits the tests alone after RED and the
 * production alone after GREEN, and writes one result. Every mycelink, gate
 * and git command is shown as a Bash tool call (settles included, which the
 * harness replays), as a host transcript shows it: the worker's inside an
 * Agent call, carrying its `parent_tool_use_id`.
 */
import { execSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** A file's text, or null when nothing (readable) is there. */
function readOrNull(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
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

/**
 * The reviewer subagent's run, as the host's Agent call shows it: it reads
 * the packet, then writes its verdict. `host` gives the host's own stream:
 * `emit(event)`, `nextId()`, `preToolUse(tool, input, who)` (the block
 * reason, else null) and `setParent(id, type)`.
 */
function runReviewer(ticket, host, { gaps = {}, model = 'stand-in-reviewer' } = {}) {
  const agent = host.nextId();
  host.emit({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: agent, name: 'Agent', input: { subagent_type: ticket.agent, description: `acceptance review ${ticket.review_id}`, prompt: ticket.prompt } }] } });
  host.setParent(agent, ticket.agent);
  let verdict = null;
  try {
    const read = host.nextId();
    const packet = JSON.parse(readFileSync(ticket.packet_path, 'utf8'));
    host.emit({ type: 'assistant', parent_tool_use_id: agent, message: { model, usage: { input_tokens: 1200, output_tokens: 80 }, content: [{ type: 'tool_use', id: read, name: 'Read', input: { file_path: ticket.packet_path } }] } });
    host.emit({ type: 'user', parent_tool_use_id: agent, message: { content: [{ type: 'tool_result', tool_use_id: read, content: `${packet.criteria.length} criteria` }] } });
    verdict = verdictFor(packet, gaps, model);
    const input = { file_path: ticket.result_slot, content: JSON.stringify(verdict, null, 2) };
    const write = host.nextId();
    const blocked = host.preToolUse('Write', input);
    // The hook's answer is shown with the call (one write), so the harness never stops the session between them.
    process.stdout.write(
      `${JSON.stringify({ type: 'assistant', parent_tool_use_id: agent, message: { model, usage: { input_tokens: 2400, output_tokens: 900 }, content: [{ type: 'tool_use', id: write, name: 'Write', input }] } })}\n` +
        `${JSON.stringify({ type: 'user', parent_tool_use_id: agent, message: { content: [{ type: 'tool_result', tool_use_id: write, ...(blocked !== null ? { is_error: true } : {}), content: blocked ?? 'written' }] } })}\n`,
    );
    if (blocked !== null) throw new Error(`the fence refused the reviewer's verdict: ${blocked}`);
    mkdirSync(dirname(ticket.result_slot), { recursive: true });
    writeFileSync(ticket.result_slot, input.content);
  } finally {
    host.setParent(null, null);
  }
  host.emit({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: agent, content: JSON.stringify(verdict) }] } });
  return verdict;
}

const planFile = process.env.FAKE_CLAUDE_PLAN ?? process.argv[2];
const given = process.argv.slice(process.env.FAKE_CLAUDE_PLAN ? 2 : 3);
const plan = JSON.parse(readFileSync(planFile, 'utf8'));
const prompt = readFileSync(0, 'utf8');
const ws = process.cwd();
const control = join(ws, 'platform');
const repo = join(ws, 'repos', 'toyshop');
const FEATURE = 'TOY-001';
const pluginDir = given[given.indexOf('--plugin-dir') + 1];
const bin = join(pluginDir, 'bin', 'mycelink.mjs');
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Claude Code names its own process to every command it runs; Mycelink records the controller key's holder by it.
// Host mode starts no worker process: an accidental nested spawn fails on a stand-in that is not there.
const env = { ...process.env, CLAUDE_PID: String(process.pid), MYCELINK_FAKE_CLAUDE: join(process.cwd(), 'no-claude-here') };

appendFileSync(plan.log, `${JSON.stringify({ argv: given, prompt_sha256: createHash('sha256').update(prompt).digest('hex'), prompt_head: prompt.slice(0, 40), prompt })}\n`);
// Claude Code's own records of this session under its HOME, as 2.1.290 keeps them: what Mycelink reads a provider failure from.
const SESSION = `fake-${process.pid}-${Date.now()}`;
const projects = join(process.env.HOME ?? process.env.USERPROFILE ?? ws, '.claude', 'projects', ws.replace(/[^A-Za-z0-9]/g, '-'));
const sessionTranscript = join(projects, `${SESSION}.jsonl`);
const record = (file, entry) => {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ timestamp: new Date().toISOString(), sessionId: SESSION, ...entry })}\n`);
};
emit({ type: 'system', subtype: 'init', session_id: SESSION, cwd: ws, plugins: [{ name: 'mycelink', path: pluginDir }] });
record(sessionTranscript, { type: 'user', isSidechain: false, message: { role: 'user', content: prompt.slice(0, 200) } });

let toolId = 0;
/** The Agent call whose subagent is running: its tool calls carry it, as Claude Code's stream does. */
let parent = null;
/** The subagent type of that call: a module-worker, or the acceptance reviewer. */
let parentType = null;
/** The running module-worker subagent's own id (Claude Code's agent id, not its Agent call's) and its transcript. */
let parentAgent = null;
let parentTranscript = null;
/** One Bash tool call: shown, run, and its output shown as the tool result. */
/**
 * The plugin's PreToolUse hooks, as Claude Code runs them before a tool call:
 * the block reason when one refuses it (exit 2), else null. A subagent's call
 * carries its agent id and type.
 */
function preToolUse(tool, input, toolUseId = null) {
  const hooksFile = join(pluginDir, 'hooks', 'hooks.json');
  // hooks: false leaves the controller and its workers to the bench's own monitor; the acceptance reviewer's verdict is still attested by the plugin's hook.
  if ((plan.hooks === false && parentType !== 'mycelink:acceptance-reviewer') || !existsSync(hooksFile)) return null;
  for (const m of JSON.parse(readFileSync(hooksFile, 'utf8')).hooks?.PreToolUse ?? []) {
    if (!new RegExp('^(?:' + m.matcher + ')$').test(tool)) continue;
    for (const h of m.hooks) {
      const argv = h.command.replace('${CLAUDE_PLUGIN_ROOT}', pluginDir).match(/"[^"]*"|\S+/g).map((a) => a.replace(/^"|"$/g, ''));
      const payload = { session_id: SESSION, transcript_path: sessionTranscript, cwd: ws, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, ...(toolUseId !== null ? { tool_use_id: toolUseId } : {}), ...(parent ? { agent_id: parentAgent ?? parent, agent_type: parentType ?? 'mycelink:module-worker' } : {}) };
      const r = spawnSync(argv[0] === 'node' ? process.execPath : argv[0], argv.slice(1), { input: JSON.stringify(payload), env: { ...env, CLAUDE_PROJECT_DIR: ws }, encoding: 'utf8', windowsHide: true });
      if (r.status === 2) return (r.stderr || 'Blocked').trim();
    }
  }
  return null;
}

/** The plugin's after-hooks, as Claude Code runs them once a tool call ends (PostToolUse, PostToolUseFailure) or a subagent stops. */
function afterHooks(event, payload) {
  const hooksFile = join(pluginDir, 'hooks', 'hooks.json');
  if (plan.hooks === false || !existsSync(hooksFile)) return;
  for (const m of JSON.parse(readFileSync(hooksFile, 'utf8')).hooks?.[event] ?? []) {
    if (m.matcher && !new RegExp('^(?:' + m.matcher + ')$').test(payload.tool_name ?? '')) continue;
    for (const h of m.hooks) {
      const argv = h.command.replace('${CLAUDE_PLUGIN_ROOT}', pluginDir).match(/"[^"]*"|\S+/g).map((a) => a.replace(/^"|"$/g, ''));
      spawnSync(argv[0] === 'node' ? process.execPath : argv[0], argv.slice(1), { input: JSON.stringify({ session_id: SESSION, transcript_path: sessionTranscript, cwd: ws, hook_event_name: event, ...payload }), env: { ...env, CLAUDE_PROJECT_DIR: ws }, encoding: 'utf8', windowsHide: true });
    }
  }
}
const who = () => (parent ? { agent_id: parentAgent ?? parent, agent_type: parentType ?? 'mycelink:module-worker' } : {});

function bash(command, run) {
  const id = `toolu_fake_${++toolId}`;
  const call = { type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } };
  // The subagent's own transcript shows its call, as Claude Code writes it before the call runs.
  if (parentTranscript) record(parentTranscript, { type: 'assistant', isSidechain: true, agentId: parentAgent, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
  const blocked = preToolUse('Bash', { command }, id);
  if (blocked !== null) {
    // The hook's answer is shown with the call (one write), so the harness never stops the session between them.
    process.stdout.write(`${JSON.stringify(call)}\n${JSON.stringify({ type: 'user', parent_tool_use_id: parent, message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: blocked }] } })}\n`);
    return { status: 1, stdout: '', stderr: blocked };
  }
  emit(call);
  let r;
  try {
    r = run();
  } catch (error) {
    afterHooks('PostToolUseFailure', { tool_name: 'Bash', tool_input: { command }, tool_use_id: id, ...who() });
    throw error;
  }
  afterHooks(r?.status ? 'PostToolUseFailure' : 'PostToolUse', { tool_name: 'Bash', tool_input: { command }, tool_use_id: id, ...who() });
  emit({ type: 'user', parent_tool_use_id: parent, message: { content: [{ type: 'tool_result', tool_use_id: id, content: `${r?.stdout ?? ''}${r?.stderr ?? ''}`.slice(0, 4000) }] } });
  return r;
}
const quote = (a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);

function mycelink(args, { allowFail = false } = {}) {
  const r = bash(`node ${quote(bin)} ${args.map(quote).join(' ')}`, () => spawnSync(process.execPath, [bin, ...args], { cwd: ws, env, encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20 }));
  if (r.status !== 0 && !allowFail) throw new Error(`mycelink ${args.join(' ')} exited ${r.status}\n${r.stdout}\n${r.stderr}`);
  return r;
}
const json = (args) => JSON.parse(mycelink(args).stdout);

function git(cwd, args, { allowFail = false } = {}) {
  const r = bash(`git -C ${quote(cwd)} ${args.map(quote).join(' ')}`, () => spawnSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8', windowsHide: true }));
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')} exited ${r.status}: ${r.stderr}`);
  return r.stdout.trim();
}

function done(text) {
  emit({ type: 'result', subtype: 'success', is_error: false, num_turns: 9, total_cost_usd: 0, result: text });
  process.exit(0);
}

/** The controller key: open the first one, or recover it from a session that has ended. */
function authority() {
  const opened = mycelink(['controller', 'open', '--control-root', control, '--json'], { allowFail: true });
  if (opened.status === 0) return JSON.parse(opened.stdout).authority;
  return json(['controller', 'open', '--recover', '--control-root', control, '--json']).authority;
}

const commitControl = (message) => {
  git(control, ['add', '--all']);
  git(control, ['commit', '-q', '--no-verify', '--allow-empty', '-m', message]);
};

const nodeOf = (module) => `${FEATURE}.${module}.impl`;
const CANDIDATE = `${FEATURE}.release.candidate.build`;

/** One node per module of the plan, mod-b after mod-a, and the candidate build. */
function graph() {
  const worker = { model: 'sonnet', effort: 'high', max_turns: 20, max_wall_clock_minutes: 30, max_attempts: 2, nested_delegation: false };
  const modules = Object.keys(plan.work);
  const impl = modules.map((m, i) => ({
    id: nodeOf(m),
    level: 'executable-node',
    repository: 'toyshop',
    capability: `CAP-${m.toUpperCase()}`,
    node_type: 'implementation',
    depends_on: i === 0 ? [] : [nodeOf(modules[i - 1])],
    allowed_paths: [`${m}/**`],
    forbidden_paths: [],
    contract_inputs: [],
    contract_outputs: [],
    required_resources: [],
    required_evidence: ['red', 'green', 'regression'],
    verification_commands: [{ id: 'targeted', command: ['node', '--test', ...Object.keys(plan.work[m].tests)] }],
    worker,
    invalidation_rules: [],
    acceptance_criteria: [`AC-${i + 1}`],
  }));
  return {
    schema_version: 1,
    feature_id: FEATURE,
    title: 'Orders reserve stock',
    prd: 'PRD.md',
    acceptance_criteria: modules.map((m, i) => ({ id: `AC-${i + 1}`, text: `${m} part of ${FEATURE}` })),
    resources: { 'full-runtime': { capacity: 1 } },
    repositories: ['toyshop'],
    capabilities: modules.map((m, i) => ({ id: `CAP-${m.toUpperCase()}`, repository: 'toyshop', title: m, acceptance_criteria: [`AC-${i + 1}`] })),
    nodes: [
      ...impl,
      {
        id: CANDIDATE,
        level: 'executable-node',
        repository: null,
        capability: null,
        node_type: 'candidate-build',
        depends_on: impl.map((n) => n.id),
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

/** The control repository, the key, the registered project and the initialised feature, each made only once. */
async function setUp() {
  if (!existsSync(join(control, 'mycelink.config.json'))) mycelink(['init', control]);
  const key = authority();
  await forge('setup');
  if (!readFileSync(join(control, 'repositories.yaml'), 'utf8').includes('toyshop')) {
    mycelink(['repo', 'register', '--control-root', control, '--authority', key, '--name', 'toyshop', '--path', '../repos/toyshop', '--base-branch', 'main', '--', 'node', '--test']);
  }
  const featureDir = join(control, 'features', FEATURE);
  if (!existsSync(join(featureDir, 'STATE.json'))) {
    mkdirSync(featureDir, { recursive: true });
    writeFileSync(join(featureDir, 'PRD.md'), readFileSync(join(control, 'requirements', `${FEATURE}.md`)));
    writeFileSync(join(featureDir, 'PORTFOLIO-GRAPH.yaml'), JSON.stringify(graph(), null, 2) + '\n');
    commitControl(`${FEATURE}: control plane`);
    mycelink(['graph', 'validate', FEATURE, '--control-root', control, '--json']);
    mycelink(['feature', 'init', FEATURE, '--control-root', control, '--authority', key, '--json']);
    commitControl(`${FEATURE}: feature initialised`);
  }
  await forge('initialised');
  return key;
}

/** A call shown as the host's, run with no plugin hook before it: what the fence never saw. */
function unhooked(command, effect) {
  const id = `toolu_fake_${++toolId}`;
  process.stdout.write(`${JSON.stringify({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } })}\n`);
  effect();
  process.stdout.write(`${JSON.stringify({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: id, content: '' }] } })}\n`);
}

/** The stage each kind of forgery happens at. */
const FORGERY_STAGE = { r9: 'setup', delete: 'initialised', rename: 'initialised', chmod: 'initialised', symlink: 'initialised', commit: 'initialised', helper: 'initialised', registry: 'initialised', stash: 'initialised', ledger: 'initialised', 'after-settle': 'settled' };

/** The n-th task session's own change, outside Mycelink (`forgeries[n]`), at its stage; then it waits to be stopped, or exits. */
async function forge(stage) {
  if (!forgery) return;
  const kind = forgery.replace(/-exit$/, '');
  if (FORGERY_STAGE[kind] !== stage || forged) return;
  forged = true;
  // A model takes a moment between calls; the workspace's clock can then order its change after Mycelink's last write.
  await sleep(150);
  const feature = join(control, 'features', FEATURE);
  if (kind === 'r9') {
    // CSET-203 r9's helper: a script of its own that writes the approved criteria through a path it computes.
    const script = "import json, os\np = '/'.join(['features', 'TOY-001', 'ACCEPT' + 'ANCE.json'])\nos.makedirs(os.path.dirname(p), exist_ok=True)\njson.dump({'forged': True}, open(p, 'w'))\n";
    unhooked(`cd ${quote(control)}; cat > gen.py <<'EOF'\n${script}EOF\npython3 gen.py`, () => {
      writeFileSync(join(control, 'gen.py'), script);
      mkdirSync(feature, { recursive: true });
      writeFileSync(join(feature, 'ACCEPTANCE.json'), JSON.stringify({ forged: true }));
    });
  } else if (kind === 'delete') {
    unhooked(`rm ${quote(join(feature, 'events.jsonl'))}`, () => rmSync(join(feature, 'events.jsonl')));
  } else if (kind === 'rename') {
    unhooked(`mv ${quote(join(feature, 'events.jsonl'))} ${quote(join(feature, 'events.jsonl.bak'))}`, () => renameSync(join(feature, 'events.jsonl'), join(feature, 'events.jsonl.bak')));
  } else if (kind === 'chmod') {
    unhooked(`chmod 444 ${quote(join(control, 'mycelink.config.json'))}`, () => chmodSync(join(control, 'mycelink.config.json'), 0o444));
  } else if (kind === 'symlink') {
    const req = join(control, 'requirements', `${FEATURE}.md`);
    unhooked(`ln -sf ../README.md ${quote(req)}`, () => {
      rmSync(req);
      symlinkSync('../README.md', req);
    });
  } else if (kind === 'commit') {
    unhooked(`cd ${quote(repo)} && echo x >> mod-a/src/stock.mjs && git add -A && git commit -qm "fix it myself"`, () => {
      appendFileSync(join(repo, 'mod-a', 'src', 'stock.mjs'), '// x\n');
      spawnSync('git', ['-C', repo, 'add', '-A'], { env });
      spawnSync('git', ['-C', repo, 'commit', '-qm', 'fix it myself'], { env });
    });
  } else if (kind === 'helper') {
    const target = join(feature, 'LOOPS.json');
    unhooked(`nohup node -e "setTimeout(() => require('fs').writeFileSync(process.argv[1], '{}'), 300)" ${quote(target)} &`, () => {
      spawn(process.execPath, ['-e', "setTimeout(() => require('fs').writeFileSync(process.argv[1], '{}'), 300)", target], { detached: false, stdio: 'ignore' });
    });
  } else if (kind === 'stash') {
    // CSET-203 r12's counterpart: the controller's own git stash in the product checkout, run where the fence never saw it.
    unhooked(`cd ${quote(repo)} && echo x >> README.md && git stash push -q -m mine`, () => {
      appendFileSync(join(repo, 'README.md'), 'x\n');
      spawnSync('git', ['-C', repo, 'stash', 'push', '-q', '-m', 'mine'], { env });
    });
  } else if (kind === 'ledger') {
    // A record forged into Mycelink's provenance ledger, to pass the controller's change off as a worker's.
    const calls = join(process.env.MYCELINK_PROVENANCE, 'calls.jsonl');
    unhooked(`echo '{}' >> ${quote(calls)}`, () => appendFileSync(calls, '{}'));
  } else if (kind === 'after-settle') {
    unhooked(`echo notes > ${quote(join(ws, 'notes.txt'))}`, () => writeFileSync(join(ws, 'notes.txt'), 'notes\n'));
  } else if (kind === 'registry') {
    // Written where no call shows it (a helper left running, say): the workspace check alone finds it.
    unhooked('ls', () => appendFileSync(join(control, 'repositories.yaml'), '# mine\n'));
    return;
  }
  if (forgery.endsWith('-exit')) done(`Changed it myself (${kind}).`);
  await sleep(600_000);
}

/** Test names a JS test file declares (`test('x')` / `it('x')`), in order. */
function declaredNames(source) {
  return [...String(source).matchAll(/(?<![\w$.])(?:it|test)\s*\(\s*(['"])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]);
}

/**
 * The criterion evidence a module-worker reports: each criterion of the pack
 * proved by the last test the files its RED wrote declare (the one it added)
 * and the hash the red gate printed, or by the test its retained RED declared.
 */
function criterionEvidenceFor(pack, tests, printed) {
  const acs = pack?.acceptance_criteria ?? [];
  if (acs.length === 0) return {};
  const names = Object.entries(tests ?? {}).flatMap(([path, body]) => declaredNames(body).map((name) => ({ path, name })));
  const test = names.at(-1);
  const red = printed.red ?? (pack?.latest_evidence ?? []).find((e) => e.kind === 'red')?.output_sha256;
  if (!test || !red) return {};
  return { criterion_evidence: acs.map((a) => ({ criterion: a.id, test, gate: 'red', output_sha256: red })) };
}

/** The context pack a ticket's prompt carries. */
function packOf(ticket) {
  const m = /<mycelink-context-pack>\s*([\s\S]*?)\s*<\/mycelink-context-pack>/.exec(ticket.prompt ?? '');
  return m ? JSON.parse(m[1]) : null;
}

/** Where this session waits to be interrupted: taskStalls[n] / reworkStalls[n] for the n-th task / rework session. */
let stallAt = null;
const stall = async (stage) => {
  if (stallAt === stage) await sleep(600_000);
};

/**
 * A Bash call of the host's own that it leaves running (CSET-202's foreground wait on a background worker): shown and
 * hooked now; `end(timedOut)` ends it later.
 */
function hostCall(command) {
  const id = `toolu_fake_${++toolId}`;
  const blocked = preToolUse('Bash', { command }, id);
  if (blocked !== null) throw new Error(`the plugin's hook refused the host's ${command}: ${blocked}`);
  emit({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
  return {
    end(timedOut) {
      afterHooks(timedOut ? 'PostToolUseFailure' : 'PostToolUse', { tool_name: 'Bash', tool_input: { command }, tool_use_id: id });
      emit({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: id, ...(timedOut ? { is_error: true } : {}), content: timedOut ? 'Exit code 143\nCommand timed out after 2m 0s' : 'waiting' }] } });
    },
  };
}

/** The host's Agent call for a ticket: the module-worker subagent's tool calls are its own, as in Claude Code's stream. */
async function work(ticket) {
  const id = `toolu_fake_${++toolId}`;
  const background = plan.asyncWorkers === true;
  const input = { subagent_type: ticket.agent, description: ticket.node_id, prompt: ticket.prompt, ...(background ? { run_in_background: true } : {}) };
  // The host's Agent call passes the plugin's PreToolUse hook (which records the launch); Claude Code keeps the subagent's meta.
  preToolUse('Agent', input, id);
  emit({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id, name: 'Agent', input }] } });
  const agentId = `a${createHash('sha256').update(`${SESSION}:${id}`).digest('hex').slice(0, 16)}`;
  mkdirSync(join(projects, SESSION, 'subagents'), { recursive: true });
  writeFileSync(join(projects, SESSION, 'subagents', `agent-${agentId}.meta.json`), JSON.stringify({ agentType: ticket.agent, description: ticket.node_id, toolUseId: id }));
  let wait = null;
  if (background) {
    // Launched in the background, as CSET-202's host's were: the stream binds the call to its task at once.
    emit({ type: 'system', subtype: 'task_started', task_id: agentId, tool_use_id: id, description: ticket.node_id, subagent_type: ticket.agent, is_backgrounded: true, task_type: 'local_agent', session_id: SESSION });
    emit({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: `Async agent launched successfully.\nagentId: ${agentId}` }] }] } });
    afterHooks('PostToolUse', { tool_name: 'Agent', tool_input: input, tool_use_id: id, tool_response: { status: 'async_launched', agentId } });
    if (plan.hostWait) wait = hostCall(plan.hostWait);
  }
  parent = id;
  parentAgent = agentId;
  parentType = ticket.agent;
  parentTranscript = join(projects, SESSION, 'subagents', `agent-${agentId}.jsonl`);
  // Its own transcript opens with its brief, as Claude Code writes it: the node, claim and dispatch it was given.
  record(parentTranscript, { type: 'user', isSidechain: true, agentId, message: { role: 'user', content: ticket.prompt } });
  try {
    await worker(ticket);
  } finally {
    afterHooks('SubagentStop', { agent_id: agentId, agent_type: ticket.agent, stop_hook_active: false });
    parent = null;
    parentAgent = null;
    parentType = null;
    parentTranscript = null;
  }
  if (background) {
    emit({ type: 'system', subtype: 'task_notification', task_id: agentId, tool_use_id: id, status: 'completed', summary: `${ticket.node_id}: result written`, session_id: SESSION });
    // The host's wait outlasts its worker: it ends after the notification, timed out.
    wait?.end(true);
    return;
  }
  afterHooks('PostToolUse', { tool_name: 'Agent', tool_input: input, tool_use_id: id, tool_response: { status: 'completed' } });
  emit({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: id, content: `${ticket.node_id}: result written` }] } });
}

/**
 * The module-worker: tests alone after a RED the gate accepts, production
 * alone after GREEN, then regression — from the gate the pack says comes
 * next, so a resumed dispatch carries on where the last worker stopped.
 */
async function worker(ticket) {
  const pack = packOf(ticket);
  const next = Math.max(0, ['RED_VERIFIED', 'GREEN_VERIFIED', 'REGRESSION_VERIFIED'].indexOf(pack?.next_required_gate));
  const module = ticket.node_id.split('.')[1];
  const review = (plan.reviews?.[module] ?? []).find((r) => r.reason === pack?.rework?.reason);
  const tests = review ? review.tests : pack?.rework ? plan.regression[module] : plan.work[module].tests;
  const impl = review ? review.impl : pack?.rework ? plan.work[module].impl : (plan.work[module].draft ?? plan.work[module].impl);
  const wt = ticket.worktree;
  const printed = {};
  const gate = (name) => {
    const line = ticket.gate_commands.find((g) => g.gate === name)?.command;
    if (!line) throw new Error(`no ${name} gate for ${ticket.node_id}`);
    const r = bash(line, () => {
      try {
        return { stdout: execSync(line, { cwd: control, env, encoding: 'utf8', stdio: 'pipe' }), stderr: '' };
      } catch (error) {
        throw new Error(`${name} gate of ${ticket.node_id} failed: ${error.stdout}${error.stderr}`);
      }
    });
    const sha = /sha256 ([0-9a-f]{64})/.exec(r?.stdout ?? '')?.[1];
    if (sha) printed[name] = sha;
    return { command: [`gate:${name}`], exit_code: 0 };
  };
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
  // A RED on record (a dependent reopened by an upstream rework, a resumed dispatch) is not proved again.
  const stashing = (plan.workerStash ?? {})[module] ?? null;
  const cset202 = stashing?.shape === 'cset202';
  if (next === 0 && stashing && !cset202) {
    // CSET-203 r12: a production draft first, set aside with git stash so the red gate runs the tests alone.
    write(impl);
    git(wt, ['stash', 'push', '-q', '--include-untracked']);
  }
  if (next === 0 && cset202) {
    // CSET-202's worker, call by call: a production draft and the tests; one call sets the draft aside and runs the red gate.
    write(impl);
    const written = write(tests);
    const red = ticket.gate_commands.find((g) => g.gate === 'red')?.command;
    if (!red) throw new Error(`no red gate for ${ticket.node_id}`);
    const drafts = Object.keys(impl);
    const r = bash(`cd ${quote(wt)} && git stash push -q -- ${drafts.map(quote).join(' ')} && ${red}`, () => {
      const pushed = spawnSync('git', ['-C', wt, 'stash', 'push', '-q', '--', ...drafts], { env, encoding: 'utf8', windowsHide: true });
      if (pushed.status !== 0) throw new Error(`git stash push in ${wt}: ${pushed.stderr}`);
      try {
        return { status: 0, stdout: execSync(red, { cwd: control, env, encoding: 'utf8', stdio: 'pipe' }), stderr: '' };
      } catch (error) {
        throw new Error(`red gate of ${ticket.node_id} failed: ${error.stdout}${error.stderr}`);
      }
    });
    const sha = /sha256 ([0-9a-f]{64})/.exec(r?.stdout ?? '')?.[1];
    if (sha) printed.red = sha;
    commands.push({ command: ['gate:red'], exit_code: 0 });
    if (plan.compact && !compacted) {
      compacted = true;
      emit({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 167000 }, session_id: SESSION });
    }
    // The entry stays live while the worker edits on (CSET-202's for 18 s): the harness's checks see it, twice.
    await sleep(stashing.holdMs ?? 1500);
    // One call commits the test and pops the draft back.
    bash(`cd ${quote(wt)} && git add ${written.map(quote).join(' ')} && git commit -qm ${quote(`test: ${ticket.node_id}`)} && git stash pop -q && git status --short`, () => {
      for (const args of [['add', '--', ...written], ['commit', '-q', '--no-verify', '-m', `test: ${ticket.node_id}`], ['stash', 'pop', '-q']]) {
        const x = spawnSync('git', ['-C', wt, ...args], { env, encoding: 'utf8', windowsHide: true });
        if (x.status !== 0) throw new Error(`git ${args[0]} in ${wt}: ${x.stderr}`);
      }
      return { status: 0, stdout: '', stderr: '' };
    });
    appendFileSync(plan.log, `${JSON.stringify({ stash: { node: ticket.node_id, shape: 'cset202', entries: git(wt, ['stash', 'list']).split(/\r?\n/).filter(Boolean).length } })}\n`);
    changed.push(...written);
    await stall('red');
  } else if (next === 0) {
    const written = write(tests);
    commands.push(gate('red'));
    commit(written, `test: ${ticket.node_id}${pack?.rework ? ' regression' : ''}`);
    if (stashing) {
      // ... popped back after the test commit, set aside again while the RED is repaired (r12), then its own entry back — or left.
      git(wt, ['stash', 'pop', '-q']);
      git(wt, ['stash', 'push', '-q', '--include-untracked']);
      if (stashing.leave) git(wt, ['checkout', '--', '.']);
      else git(wt, ['stash', 'pop', '-q']);
      appendFileSync(plan.log, `${JSON.stringify({ stash: { node: ticket.node_id, left: Boolean(stashing.leave), entries: git(wt, ['stash', 'list']).split(/\r?\n/).filter(Boolean).length } })}\n`);
    }
    changed.push(...written);
    await stall('red');
    if (takeover && !tookOver) {
      // CSET-202 r2's controller, while its worker runs: it writes the worker's result itself (the plugin's fence refuses), then carries on.
      tookOver = true;
      const worker = parent;
      parent = null;
      const id = `toolu_fake_${++toolId}`;
      const input = { file_path: ticket.result_slot, content: JSON.stringify({ schema_version: 1, node_id: ticket.node_id, claim_id: ticket.claim_id, outcome: 'SUBMITTED' }) };
      // The hook's answer is shown with the call (one write), so the harness never stops the session between them.
      const blocked = preToolUse('Write', input);
      if (blocked === null) writeFileSync(ticket.result_slot, input.content);
      process.stdout.write(
        `${JSON.stringify({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id, name: 'Write', input }] } })}\n` +
          `${JSON.stringify({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: id, ...(blocked !== null ? { is_error: true } : {}), content: blocked ?? 'written' }] } })}\n`,
      );
      parent = worker;
      if (blocked === null) await sleep(600_000);
    }
  }
  if (next <= 1) {
    const production = write(impl);
    // The draft it popped back is already in the worktree: its production change all the same.
    if (stashing && next === 0) for (const path of Object.keys(impl)) if (!production.includes(path)) production.push(path);
    commands.push(gate('green'));
    commit(production, `feat: ${ticket.node_id}${pack?.rework ? ' fix' : ''}`);
    changed.push(...production);
    await stall('green');
  }
  commands.push(gate('regression'));
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
    ...criterionEvidenceFor(pack, tests, printed),
  };
  mkdirSync(dirname(ticket.result_slot), { recursive: true });
  writeFileSync(ticket.result_slot, JSON.stringify(result, null, 2));
}

/** The controller's own review of a settled node: the next review of its module not yet made, as a rework. */
function review(key, nodeId) {
  const module = nodeId.split('.')[1];
  const state = JSON.parse(readFileSync(join(control, 'features', FEATURE, 'STATE.json'), 'utf8')).data;
  const made = new Set((state.reworks ?? []).filter((r) => r.node_id === nodeId).map((r) => r.reason));
  const next = (plan.reviews?.[module] ?? []).find((r) => !made.has(r.reason));
  if (!next || state.nodes[nodeId]?.state !== 'DONE' || state.current_candidate) return;
  mycelink(['node', 'rework', FEATURE, nodeId, '--reason', next.reason, '--control-root', control, '--authority', key, '--json']);
  commitControl(`${FEATURE}: review ${nodeId}`);
}

/** The host's side of the stand-in reviewer: its stream, its hooks, its Agent call. */
const reviewHost = {
  emit,
  nextId: () => `toolu_fake_${++toolId}`,
  preToolUse: (tool, input) => preToolUse(tool, input),
  setParent: (id, type) => {
    parent = id;
    parentType = type;
  },
};

/** An acceptance-review ticket: the reviewer subagent writes its verdict, then the host runs the ticket's settle line. */
let reviewTickets = 0;
async function acceptanceReview(ticket) {
  const line = (l) => bash(l, () => spawnSync(l, { cwd: ws, env, shell: true, encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20 }));
  // CSET-203 r13: how the n-th reviewer ticket of the run (every session's) is fulfilled, when the plan says.
  let lifecycle = null;
  if (plan.reviewerLifecycle) {
    const nth = readFileSync(plan.log, 'utf8').split('\n').filter((l) => l.includes('"review_ticket"')).length;
    appendFileSync(plan.log, `${JSON.stringify({ review_ticket: { review_id: ticket.review_id, dispatch_id: ticket.dispatch_id, attempt: ticket.attempt } })}\n`);
    lifecycle = plan.reviewerLifecycle[nth] ?? null;
  }
  if (lifecycle === 'exit-running') {
    // The controller's session ends while its reviewer still runs: the reviewer goes with it.
    launchRunningReviewer(ticket);
    done(`Launched the acceptance reviewer of ${ticket.review_id}; it is still running.`);
  }
  if (lifecycle === 'slow') {
    const s = await slowReviewer(ticket, line);
    if (s.outcome !== 'PASS' && s.outcome !== 'GAPS') throw new Error(`review settle ${ticket.review_id}: ${s.outcome} ${s.code ?? ''} ${s.detail ?? ''}`);
    return s;
  }
  const refused = (plan.reviewRefusals ?? [])[reviewTickets++] === 'refusal';
  if (refused) refusedReviewer(ticket);
  else runReviewer(ticket, reviewHost, { gaps: plan.reviewGaps?.[ticket.review_id] ?? {} });
  if (refused) line(ticket.ingest_command);
  const s = JSON.parse(line(ticket.settle_command).stdout || '{}');
  if (plan.reviewRefusals) appendFileSync(plan.log, `${JSON.stringify({ reviewed: { review_id: ticket.review_id, attempt: ticket.attempt, outcome: s.outcome ?? null, code: s.code ?? null } })}\n`);
  if (refused && s.outcome === 'PROVIDER_INTERRUPTED') return s;
  if (s.outcome !== 'PASS' && s.outcome !== 'GAPS') throw new Error(`review settle ${ticket.review_id}: ${s.outcome} ${s.code ?? ''} ${s.detail ?? ''}`);
  return s;
}

/**
 * A reviewer whose final request the provider refused: launched through the plugin's hook (which records the launch),
 * Claude Code's own records kept (the session's call and launch result, the subagent's meta and transcript, ending on
 * the synthetic API error), its completion notified as failed. It writes no verdict.
 */
function refusedReviewer(ticket) {
  const agent = `toolu_fake_${++toolId}`;
  const call = { subagent_type: ticket.agent, description: `acceptance review ${ticket.review_id}`, prompt: ticket.prompt };
  const blocked = preToolUse('Agent', call, agent);
  if (blocked !== null) throw new Error(`the plugin's hook refused the reviewer's launch: ${blocked}`);
  emit({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: agent, name: 'Agent', input: call } ] } });
  const agentId = `a${createHash('sha256').update(`${SESSION}:${agent}`).digest('hex').slice(0, 16)}`;
  const own = join(projects, SESSION, 'subagents', `agent-${agentId}.jsonl`);
  record(sessionTranscript, { type: 'assistant', isSidechain: false, message: { role: 'assistant', model: 'stand-in', content: [{ type: 'tool_use', id: agent, name: 'Agent', input: call }], stop_reason: 'tool_use' } });
  mkdirSync(dirname(own), { recursive: true });
  writeFileSync(join(projects, SESSION, 'subagents', `agent-${agentId}.meta.json`), JSON.stringify({ agentType: ticket.agent, description: call.description, toolUseId: agent }));
  record(sessionTranscript, { type: 'user', isSidechain: false, message: { role: 'user', content: [{ tool_use_id: agent, type: 'tool_result', content: [{ type: 'text', text: `Async agent launched successfully.\nagentId: ${agentId}` }] }] }, toolUseResult: { isAsync: true, status: 'async_launched', agentId } });
  const side = (entry) => record(own, { isSidechain: true, agentId, ...entry });
  side({ type: 'user', message: { role: 'user', content: ticket.prompt } });
  const requestId = `req_011${createHash('sha256').update(`${agent}:refused`).digest('hex').slice(0, 20)}`;
  side({ type: 'assistant', requestId, error: 'invalid_request', isApiErrorMessage: true, message: { model: '<synthetic>', role: 'assistant', stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'reasoning_extraction' }, content: [{ type: 'text', text: 'API Error' }] } });
  record(sessionTranscript, { type: 'user', isSidechain: false, message: { role: 'user', content: `<task-notification>\n<task-id>${agentId}</task-id>\n<tool-use-id>${agent}</tool-use-id>\n<status>failed</status>\n<summary>Agent "${call.description}" failed</summary>\n</task-notification>` }, origin: { kind: 'task-notification' } });
  emit({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: agent, content: `Async agent launched successfully.\nagentId: ${agentId}` }] } });
}

/**
 * CSET-203 r13: the reviewer launched in the background as 2.1.290 does it — through the plugin's hooks (the launch,
 * then the Agent task it started), Claude Code's own records (the session's call and its async launch result, the
 * subagent's meta and opening prompt) and its stream (`task_started`) — and still running when this returns.
 */
function launchRunningReviewer(ticket) {
  const agent = `toolu_fake_${++toolId}`;
  const call = { subagent_type: ticket.agent, description: `acceptance review ${ticket.review_id}`, prompt: ticket.prompt };
  const blocked = preToolUse('Agent', call, agent);
  if (blocked !== null) throw new Error(`the plugin's hook refused the reviewer's launch: ${blocked}`);
  emit({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: agent, name: 'Agent', input: call }] } });
  const agentId = `a${createHash('sha256').update(`${SESSION}:${agent}`).digest('hex').slice(0, 16)}`;
  const own = join(projects, SESSION, 'subagents', `agent-${agentId}.jsonl`);
  record(sessionTranscript, { type: 'assistant', isSidechain: false, message: { role: 'assistant', model: 'stand-in', content: [{ type: 'tool_use', id: agent, name: 'Agent', input: call }], stop_reason: 'tool_use' } });
  mkdirSync(dirname(own), { recursive: true });
  writeFileSync(join(projects, SESSION, 'subagents', `agent-${agentId}.meta.json`), JSON.stringify({ agentType: ticket.agent, description: call.description, toolUseId: agent }));
  record(own, { isSidechain: true, agentId, type: 'user', message: { role: 'user', content: ticket.prompt } });
  const launched = { isAsync: true, status: 'async_launched', agentId, description: call.description };
  record(sessionTranscript, { type: 'user', isSidechain: false, message: { role: 'user', content: [{ tool_use_id: agent, type: 'tool_result', content: [{ type: 'text', text: `Async agent launched successfully.\nagentId: ${agentId}` }] }] }, toolUseResult: launched });
  afterHooks('PostToolUse', { tool_name: 'Agent', tool_input: call, tool_use_id: agent, tool_response: launched });
  emit({ type: 'system', subtype: 'task_started', task_id: agentId, tool_use_id: agent, description: call.description, subagent_type: ticket.agent, is_backgrounded: true, task_type: 'local_agent', session_id: SESSION });
  emit({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: agent, content: `Async agent launched successfully.\nagentId: ${agentId}` }] } });
  return { agent, agentId, own, description: call.description };
}

/**
 * CSET-203 r13's slow refinement, as it should have gone: the reviewer runs in the background (`slowReviewerMs`) and
 * completes on its own — its final answer in its transcript, its completion enqueued in the session's while the host
 * is busy (a queue operation, never a user message) — while the host does what r13's did (the ticket's ingest and
 * settle lines together, at once) and then what /mycelink:run says (the await line, again while RUNNING). Then the
 * stream records its end, and the ingest and settle lines take its answer. Each step's answer is logged.
 */
async function slowReviewer(ticket, line) {
  const packet = JSON.parse(readFileSync(ticket.packet_path, 'utf8'));
  const answer = JSON.stringify(verdictFor(packet, plan.reviewGaps?.[ticket.review_id] ?? {}));
  const { agent, agentId, own, description } = launchRunningReviewer(ticket);
  const marker = join(dirname(plan.log), `reviewer-${agentId}.completed`);
  const completer = [
    "const fs = require('node:fs');",
    'const [own, session, sessionId, agentId, agent, description, answer, ms, marker] = process.argv.slice(1);',
    'setTimeout(() => {',
    '  const at = () => new Date().toISOString();',
    "  fs.appendFileSync(own, JSON.stringify({ timestamp: at(), sessionId, isSidechain: true, agentId, type: 'assistant', attributionAgent: 'mycelink:acceptance-reviewer', message: { id: 'msg_slow_' + agentId, role: 'assistant', model: 'stand-in-reviewer', content: [{ type: 'text', text: answer }], stop_reason: 'end_turn' } }) + '\\n');",
    "  const note = '<task-notification>\\n<task-id>' + agentId + '</task-id>\\n<tool-use-id>' + agent + '</tool-use-id>\\n<status>completed</status>\\n<summary>Agent \"' + description + '\" finished</summary>\\n<result>' + answer + '</result>\\n</task-notification>';",
    "  fs.appendFileSync(session, JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: at(), sessionId, content: note }) + '\\n');",
    '  fs.writeFileSync(marker, String(Date.now()));',
    '}, Number(ms));',
  ].join('\n');
  const child = spawn(process.execPath, ['-e', completer, own, sessionTranscript, SESSION, agentId, agent, description, answer, String(plan.slowReviewerMs ?? 6000), marker], { stdio: 'ignore', windowsHide: true });
  const seen = { review_id: ticket.review_id, agent_id: agentId, early: null, awaits: [], ingest: null, settle: null };
  try {
    // r13's host, after its sleep: ingest and settle together. Neither may spend the generation while the reviewer runs.
    const early = { ingest: JSON.parse(line(ticket.ingest_command).stdout || '{}'), settle: JSON.parse(line(ticket.settle_command).stdout || '{}') };
    seen.early = { ingest: early.ingest.outcome ?? null, settle: early.settle.outcome ?? null, lifecycle: early.settle.lifecycle ?? null };
    // /mycelink:run's way: the await line, again while it answers RUNNING.
    for (let i = 0; i < 120; i++) {
      const w = JSON.parse(line(ticket.await_command.replace(/--wait-seconds \d+/, '--wait-seconds 2')).stdout || '{}');
      seen.awaits.push(w.state ?? null);
      if (w.state !== 'RUNNING') break;
    }
  } finally {
    await new Promise((r) => (child.exitCode !== null ? r() : child.on('exit', r)));
  }
  // Claude Code's stream records its end, as it did r13's.
  const end = existsSync(marker) ? Number(readFileSync(marker, 'utf8')) : Date.now();
  emit({ type: 'system', subtype: 'task_updated', task_id: agentId, patch: { status: 'completed', end_time: end }, session_id: SESSION });
  emit({ type: 'system', subtype: 'task_notification', task_id: agentId, tool_use_id: agent, status: 'completed', summary: answer.slice(0, 200), session_id: SESSION });
  seen.ingest = JSON.parse(line(ticket.ingest_command).stdout || '{}').outcome ?? null;
  const s = JSON.parse(line(ticket.settle_command).stdout || '{}');
  seen.settle = s.outcome ?? null;
  appendFileSync(plan.log, `${JSON.stringify({ slow_reviewer: seen })}\n`);
  return s;
}

/**
 * The session's next request failed for good, as Claude Code records it (CSET-203 r10): in its stream the
 * model_refusal_no_fallback event, the synthetic API error and the failed result; on disk the same. It exits 1.
 */
function providerFailure(kind) {
  const requestId = `req_011${createHash('sha256').update(`${SESSION}:${kind}`).digest('hex').slice(0, 20)}`;
  const at = new Date(Date.now() + 5).toISOString();
  const refusal = kind === 'after-dispatch';
  const error = refusal ? 'invalid_request' : kind === 'rate-limit-after-dispatch' ? 'rate_limit' : 'authentication_failed';
  const status = refusal ? null : kind === 'rate-limit-after-dispatch' ? 429 : 401;
  const message = { model: '<synthetic>', role: 'assistant', stop_reason: refusal ? 'refusal' : 'stop_sequence', ...(refusal ? { stop_details: { type: 'refusal', category: 'reasoning_extraction' } } : {}), content: [{ type: 'text', text: 'API Error' }] };
  if (refusal) {
    emit({ type: 'system', subtype: 'model_refusal_no_fallback', request_id: requestId, api_refusal_category: 'reasoning_extraction', session_id: SESSION });
    record(sessionTranscript, { type: 'system', subtype: 'model_refusal_no_fallback', isSidechain: false, timestamp: at, requestId, apiRefusalCategory: 'reasoning_extraction' });
  }
  emit({ type: 'assistant', parent_tool_use_id: null, is_api_error_message: true, error, request_id: requestId, timestamp: at, message });
  record(sessionTranscript, { type: 'assistant', isSidechain: false, timestamp: at, requestId, error, isApiErrorMessage: true, message });
  emit({ type: 'result', subtype: 'success', is_error: true, num_turns: 5, total_cost_usd: 0, stop_reason: refusal ? 'refusal' : 'stop_sequence', terminal_reason: 'api_error', api_error_status: status, result: 'API Error' });
  appendFileSync(plan.log, `${JSON.stringify({ refused: { kind, request_id: requestId } })}\n`);
  process.exit(1);
}

/** A ticket the previous session was refused right after: presented late, with a result in its old slot. */
function presentLateTicket() {
  const file = `${plan.log}.provider-ticket`;
  if (!existsSync(file)) return;
  const old = JSON.parse(readFileSync(file, 'utf8'));
  renameSync(file, `${file}.${Date.now()}.done`);
  mkdirSync(dirname(old.result_slot), { recursive: true });
  writeFileSync(old.result_slot, JSON.stringify({ schema_version: 1, node_id: old.node_id, claim_id: old.claim_id, dispatch_id: old.dispatch_id, outcome: 'BLOCKED', commands: [], commit_sha: null, changed_paths: [], evidence_paths: [], failure_fingerprint: 'LATE', decision_request: null }));
  const s = JSON.parse(mycelink(['settle', FEATURE, old.node_id, '--capability', old.capability, '--control-root', control, '--json'], { allowFail: true }).stdout || '{}');
  appendFileSync(plan.log, `${JSON.stringify({ late: { node: old.node_id, outcome: s.outcome ?? null } })}\n`);
}

/** dispatch -> worker -> settle until every node settles (a dispatch an ended session left is resumed), deliver, and verify the delivery. */
async function settleAndDeliver(key) {
  for (let i = 0; i < 24; i++) {
    const d = JSON.parse(mycelink(['dispatch', FEATURE, '--control-root', control, '--authority', key, '--json'], { allowFail: true }).stdout);
    if (d.status === 'ALL_SETTLED') {
      commitControl(`${FEATURE}: settled`);
      const delivery = json(['deliver', FEATURE, '--control-root', control, '--authority', key, '--json']);
      if (delivery.status !== 'ACCEPTED') throw new Error(`delivery ${delivery.status}`);
      commitControl(`${FEATURE}: delivered`);
      // Done only once the feature is complete and its current candidate delivered.
      mycelink(['feature', 'verify', FEATURE, '--delivered', '--control-root', control, '--json']);
      return delivery;
    }
    if (d.status === 'WAITING') {
      json(['session', 'reconcile', FEATURE, '--control-root', control, '--authority', key, '--json']);
      // The acceptance review an ended session left with its reviewer: a fresh reviewer gets it.
      if (d.pending_review && !d.pending_review.verdict_present) {
        const resumed = json(['dispatch', FEATURE, '--resume', d.pending_review.review_id, '--control-root', control, '--authority', key, '--json']);
        if (resumed.status === 'DISPATCHED') await acceptanceReview(resumed.ticket);
        commitControl(`${FEATURE}: review ${d.pending_review.review_id}`);
      }
      for (const p of d.pending ?? []) {
        const resumed = json(['dispatch', FEATURE, '--resume', p.node_id, '--control-root', control, '--authority', key, '--json']);
        if (resumed.status === 'DISPATCHED') {
          await work(resumed.ticket);
          const s = json(['settle', FEATURE, resumed.ticket.node_id, '--capability', resumed.ticket.capability, '--control-root', control, '--json']);
          if (s.outcome !== 'DONE') throw new Error(`settle ${resumed.ticket.node_id}: ${s.outcome} ${s.detail ?? ''}`);
          review(key, resumed.ticket.node_id);
          await forge('settled');
          if (exitAt === 'settled-one') done(`Settled ${resumed.ticket.node_id}; stopping here.`);
        }
      }
      continue;
    }
    if (d.status !== 'DISPATCHED') throw new Error(`dispatch stopped: ${d.status} ${d.detail ?? ''}`);
    if (d.ticket.kind === 'acceptance-review') {
      await acceptanceReview(d.ticket);
      commitControl(`${FEATURE}: review ${d.ticket.review_id}`);
      continue;
    }
    if (refuseAt !== null) {
      // r10: the ticket is out, no worker has run, and the controller's next request is refused.
      writeFileSync(`${plan.log}.provider-ticket`, JSON.stringify(d.ticket));
      providerFailure(refuseAt);
    }
    await work(d.ticket);
    const s = json(['settle', FEATURE, d.ticket.node_id, '--capability', d.ticket.capability, '--control-root', control, '--json']);
    if (s.outcome !== 'DONE') throw new Error(`settle ${d.ticket.node_id}: ${s.outcome} ${s.detail ?? ''}`);
    review(key, d.ticket.node_id);
    await forge('settled');
    if (exitAt === 'settled-one') done(`Settled ${d.ticket.node_id}; stopping here.`);
  }
  throw new Error('the feature never settled');
}

const qa = /QA ran its end-to-end checks on the delivered commit ([0-9a-f]{12}) and found a defect:\n\n((?:- [^\n]*\n?)+)/.exec(prompt);
// This session's place among the task's sessions or QA's rework's, counting itself.
const sessionsLike = (rework) => readFileSync(plan.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => typeof e.prompt === 'string' && /QA ran its end-to-end checks/.test(e.prompt) === rework).length;
stallAt = (qa ? (plan.reworkStalls ?? []) : (plan.taskStalls ?? []))[sessionsLike(Boolean(qa)) - 1] ?? null;
// The n-th task session writes into its first running worker's result itself when taskTakeover[n] says so.
const takeover = !qa && Boolean((plan.taskTakeover ?? [])[sessionsLike(false) - 1]);
// Where the n-th task session exits 0 with the feature incomplete (taskExits[n]).
const exitAt = qa ? null : ((plan.taskExits ?? [])[sessionsLike(false) - 1] ?? null);
// How the n-th task session's next request fails right after it dispatches its first worker ticket (taskRefusals[n]).
const refuseAt = qa ? null : ((plan.taskRefusals ?? [])[sessionsLike(false) - 1] ?? null);
let tookOver = false;
let compacted = false;
// What the n-th task session changes itself, outside Mycelink (forgeries[n]); done once.
const forgery = qa ? null : ((plan.forgeries ?? [])[sessionsLike(false) - 1] ?? null);
let forged = false;
if (qa) {
  await stall('start');
  if (plan.reworkNoop) {
    // Looks at the feature and ends, as if the report needed nothing.
    mycelink(['feature', 'status', FEATURE, '--control-root', control, '--json']);
    done('The feature is delivered; nothing to repair.');
  }
  const direct = Array.isArray(plan.reworkDirect) ? plan.reworkDirect[sessionsLike(true) - 1] : plan.reworkDirect;
  if (direct) {
    // The fourth pilot's controller: it repaired main itself, never through Mycelink, then carried on.
    const reverted = bash(`git -C ${quote(repo)} revert --no-edit ${qa[1]}`, () => spawnSync('git', ['-C', repo, 'revert', '--no-edit', qa[1]], { env, encoding: 'utf8', windowsHide: true }));
    if (!/^Blocked: /.test(reverted.stderr ?? '')) {
      await sleep(600_000);
      done('Reverted the defect on main.');
    }
  }
  if (plan.reworkVia === 'command') {
    // /mycelink:rework, as its command file gives it: key, status, one attribution-and-rework step, then the host loop.
    const id = `toolu_fake_${++toolId}`;
    emit({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id, name: 'Skill', input: { skill: 'mycelink:rework', args: FEATURE } }] } });
    emit({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'Launching skill: mycelink:rework' }] } });
    const key = authority();
    json(['feature', 'status', FEATURE, '--control-root', control, '--json']);
    const module = /QA traced the failing checks to the module `[^`]+` \(`([^`]+)`\)/.exec(prompt)?.[1];
    const reason = `QA on the delivered ${qa[1]}:\n${qa[2].trim()}`.slice(0, 2000);
    const r = json(['feature', 'rework', FEATURE, '--since-delivery', ...(module ? [`toyshop:${module}`] : []), '--reason', reason, '--control-root', control, '--authority', key, '--json']);
    commitControl(`${FEATURE}: rework ${r.targets.join(', ')}`);
    const delivery = await settleAndDeliver(key);
    done(`Reworked ${r.targets.join(', ')}; ${delivery.candidate_id} delivered.`);
  }
  const key = authority();
  const status = json(['feature', 'status', FEATURE, '--control-root', control, '--json']);
  // The producer node of what moved on main since the delivery (the reported commit), never a controller node.
  // A fresh session after an interrupt finds that rework done: nothing moved since, and the reopened nodes wait.
  const { owners } = json(['feature', 'owners', FEATURE, '--since-delivery', '--control-root', control, '--json']);
  if (owners.length === 0 && status.feature_state === 'COMPLETED') throw new Error('no producer node owns what QA reported');
  const reason = `QA on the delivered ${qa[1]}:\n${qa[2].trim()}`.slice(0, 2000);
  for (const owner of owners) {
    const r = mycelink(['node', 'rework', FEATURE, owner.node_id, '--reason', reason, '--control-root', control, '--authority', key, '--json'], { allowFail: true });
    // A node an earlier owner's rework reopened is not reworked again.
    if (r.status !== 0 && !/REWORK_NOT_DONE/.test(r.stderr)) throw new Error(`node rework: ${r.stderr}`);
    commitControl(`${FEATURE}: rework ${owner.node_id}`);
  }
  const delivery = await settleAndDeliver(key);
  done(`Reworked ${owners.map((o) => o.node_id).join(', ') || 'the reopened nodes'}; ${delivery.candidate_id} delivered.`);
} else {
  await stall('start');
  const key = await setUp();
  presentLateTicket();
  if (exitAt === 'setup') done('Set up the control plane; stopping here.');
  const delivery = await settleAndDeliver(key);
  done(`Delivered ${delivery.candidate_id}.`);
}
