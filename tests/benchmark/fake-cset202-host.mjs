#!/usr/bin/env node
/**
 * A stand-in for a with-arm host session on the real CSET-202 workspace
 * (never a benchmark subject), for the model-free CSET-202 run: four module
 * workers on the real Changesets source, C001 delivered, the evaluator's
 * late defect, QA's rework of the errors node, its dependents re-verified,
 * C002 delivered, and the independent verifier's verdict.
 *
 * Inside the session's sandbox it drives the sealed plugin as the run
 * command tells a host to. $FAKE_CLAUDE_PLAN names a JSON file the test
 * wrote outside the sandbox:
 *
 *   { log, modules: { <module>: { tests, impl, criteria: [{ criterion, path, name, gate }] } },
 *     regression: { <module>: { tests, criteria } }, acceptance_criteria: [{ id, text, kind? }] }
 *
 * where `tests` and `impl` map repository paths to file contents (the
 * reference's, each as another author would commit it).
 *
 * task:   init the control repository (the generated repositories.yaml is
 *         kept), open the key, read the module allowlist (`repo modules`),
 *         plan one node per module — errors, then read and
 *         assemble-release-plan, then cli; read also owns pnpm-lock.yaml —
 *         each verified by its module's verifier, then dispatch -> worker ->
 *         settle until everything settles, and deliver.
 * rework: (QA's report) recover the key, find the producer of what moved on
 *         main since the delivery (`feature owners --since-delivery`), rework
 *         it with QA's checks as the reason, and run the same loop: the
 *         reworked node's worker adds its regression test (a RED the gate
 *         must accept on its module alone), then restores the production
 *         change; a dependent reopened with it re-proves GREEN; deliver C002.
 *
 * The worker runs the ticket's gate lines, commits the tests alone after
 * RED and the production alone after GREEN, and reports criterion evidence
 * by the test_id its gates published (looked up with `tdd tests`) and the
 * hashes they printed (or the retained RED's). It records what it saw in the
 * plan's log.
 *
 * CSET-202 r2's shape (plan flags): `takeover` — the first task session,
 * while its first worker runs (after the RED commit), writes that worker's
 * result slot itself (the plugin's fence refuses it) and carries on, to be
 * stopped by the harness; `evidenceMistake` — the first cli worker reports
 * AC-4's test_id with a wrong display name and AC-5 by an id no gate
 * published, settle holds the claim for correction, and the host dispatches
 * again: a fresh worker corrects only the evidence. Every tool call passes
 * the plugin's PreToolUse hooks first, as Claude Code runs them. The graph's
 * criteria are the approved ones, verbatim, from `feature acceptance`.
 */
import { execSync, spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Pipes are asynchronous on macOS and Windows (synchronous on Linux): a stand-in that exits right after its last
// line would drop what was still buffered, cutting its own stream mid-line. Write through, as a real CLI does.
for (const stream of [process.stdout, process.stderr]) stream._handle?.setBlocking?.(true);

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

const plan = JSON.parse(readFileSync(process.env.FAKE_CLAUDE_PLAN, 'utf8'));
const given = process.argv.slice(2);
const prompt = readFileSync(0, 'utf8');
const ws = process.cwd();
const control = join(ws, 'platform');
const FEATURE = 'CSET-202';
const REPO = 'changesets';
const pluginDir = given[given.indexOf('--plugin-dir') + 1];
const bin = join(pluginDir, 'bin', 'mycelink.mjs');
// Host mode starts no worker process: an accidental nested spawn fails on a stand-in that is not there.
const env = { ...process.env, CLAUDE_PID: String(process.pid), MYCELINK_FAKE_CLAUDE: join(process.cwd(), 'no-claude-here') };
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const log = (entry) => appendFileSync(plan.log, `${JSON.stringify(entry)}\n`);

emit({ type: 'system', subtype: 'init', cwd: ws, plugins: [{ name: 'mycelink', path: pluginDir }] });

let toolId = 0;
let parent = null;
/** The subagent type of the running Agent call: a module-worker, or the acceptance reviewer. */
let parentType = null;
/**
 * A hook run as Claude Code runs it, its payload on stdin — as a finished file written whole before it starts, never
 * spawnSync's `input`: on macOS that is an 8 KiB socketpair under Node 22, and a payload longer than one write can reach
 * the hook whole and its end never (CI 38618387236), the hook waiting for EOF.
 */
let hookInputs = 0;
function runHookChild(file, args, payload, options) {
  const stdin = join(dirname(plan.log), `hook-stdin-${process.pid}-${++hookInputs}`);
  writeFileSync(stdin, JSON.stringify(payload), { flag: 'wx', mode: 0o600 });
  const fd = openSync(stdin, 'r');
  try {
    return spawnSync(file, args, { ...options, stdio: [fd, 'pipe', 'pipe'] });
  } finally {
    closeSync(fd);
    rmSync(stdin, { force: true });
  }
}

/** The plugin's PreToolUse hooks, as Claude Code runs them: the block reason (exit 2), else null. */
function preToolUse(tool, input) {
  const hooksFile = join(pluginDir, 'hooks', 'hooks.json');
  if (!existsSync(hooksFile)) return null;
  for (const m of JSON.parse(readFileSync(hooksFile, 'utf8')).hooks?.PreToolUse ?? []) {
    if (!new RegExp('^(?:' + m.matcher + ')$').test(tool)) continue;
    for (const h of m.hooks) {
      const argv = h.command.split('${CLAUDE_PLUGIN_ROOT}').join(pluginDir).match(/"[^"]*"|\S+/g).map((a) => a.replace(/^"|"$/g, ''));
      const payload = { session_id: 'fake', cwd: ws, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, ...(parent ? { agent_id: parent, agent_type: parentType ?? 'mycelink:module-worker' } : {}) };
      const r = runHookChild(argv[0] === 'node' ? process.execPath : argv[0], argv.slice(1), payload, { env: { ...env, CLAUDE_PROJECT_DIR: ws }, encoding: 'utf8' });
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

const nodeOf = (module) => `${FEATURE}.${module}.impl`;
const CANDIDATE = `${FEATURE}.release.candidate.build`;
const DEPENDS = { errors: [], read: ['errors'], 'assemble-release-plan': ['errors'], cli: ['errors', 'read', 'assemble-release-plan'] };
const CRITERIA = { errors: ['AC-1'], read: ['AC-2', 'AC-5'], 'assemble-release-plan': ['AC-3', 'AC-5'], cli: ['AC-4', 'AC-5'] };
/** Paths in no module a node also owns: read declares its new workspace dependency in the lockfile. */
const SHARED = { read: ['pnpm-lock.yaml'] };

function graph(verifier) {
  const worker = { model: 'sonnet', effort: 'high', max_turns: 60, max_wall_clock_minutes: 60, max_attempts: 2, nested_delegation: false };
  const modules = Object.keys(DEPENDS);
  const impl = modules.map((m) => ({
    id: nodeOf(m),
    level: 'executable-node',
    repository: REPO,
    capability: `CAP-${m.toUpperCase()}`,
    node_type: 'implementation',
    depends_on: DEPENDS[m].map(nodeOf),
    allowed_paths: [`packages/${m}/**`, ...(SHARED[m] ?? [])],
    forbidden_paths: [],
    contract_inputs: [],
    contract_outputs: [],
    required_resources: [],
    required_evidence: ['red', 'green', 'regression'],
    verification_commands: [verifier(m)],
    worker,
    invalidation_rules: [],
    acceptance_criteria: CRITERIA[m],
  }));
  return {
    schema_version: 1,
    feature_id: FEATURE,
    title: 'Report every invalid changeset at once',
    prd: `features/${FEATURE}/PRD.md`,
    acceptance_criteria: approved().criteria.map((c) => ({ id: c.id, text: c.text, kind: c.kind })),
    resources: { workspace: { capacity: 1 } },
    repositories: [REPO],
    capabilities: modules.map((m) => ({ id: `CAP-${m.toUpperCase()}`, repository: REPO, title: m, acceptance_criteria: CRITERIA[m] })),
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

/** The approved criteria, verbatim, as `feature acceptance` wrote them from the requirement's sidecar. */
const approved = () => JSON.parse(readFileSync(join(control, 'features', FEATURE, 'ACCEPTANCE.json'), 'utf8'));

function setUp() {
  if (!existsSync(join(control, 'mycelink.config.json'))) {
    mycelink(['init', control]);
  }
  const key = authority();
  const featureDir = join(control, 'features', FEATURE);
  if (!existsSync(join(featureDir, 'STATE.json'))) {
    const allowlist = json(['repo', 'modules', '--control-root', control, '--json']).repositories.find((r) => r.name === REPO);
    log({ modules: allowlist.modules.map((m) => ({ id: m.id, runtime_tests: m.runtime_tests, test: m.test, sha256: m.sha256 })) });
    const verifier = (id) => allowlist.modules.find((m) => m.id === id).verifier;
    mkdirSync(featureDir, { recursive: true });
    writeFileSync(join(featureDir, 'PRD.md'), readFileSync(join(control, 'requirements', `${FEATURE}.md`)));
    const acceptance = json(['feature', 'acceptance', FEATURE, '--source', `requirements/${FEATURE}.md`, '--control-root', control, '--authority', key, '--json']);
    log({ acceptance: { from: acceptance.from, criteria: acceptance.criteria.map((c) => ({ id: c.id, kind: c.kind, sha256: c.sha256 })) } });
    writeFileSync(join(featureDir, 'PORTFOLIO-GRAPH.yaml'), JSON.stringify(graph(verifier), null, 2) + '\n');
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
    return await worker(ticket);
  } finally {
    parent = null;
    emit({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: id, content: `${ticket.node_id}: result written` }] } });
  }
}

/** One module worker: RED (tests alone), GREEN (production alone), regression — from the gate the pack names next. */
let tookOver = false;
let mistaken = false;

/** The bound test a criterion names, by its canonical id: `tdd tests` with the ticket's capability, narrowed by its words as the skill says. */
function testIdOf(ticket, c) {
  const line = `${ticket.gate_commands.find((g) => g.gate === 'red' || g.gate === 'green').command.replace(/ tdd (red|green) /, ' tdd tests ')} --gate ${c.gate} --match ${quote(c.name)} --json`;
  const r = bash(line, () => {
    try {
      return { status: 0, stdout: execSync(line, { cwd: control, env, encoding: 'utf8', stdio: 'pipe', maxBuffer: 64 << 20 }), stderr: '' };
    } catch (error) {
      return { status: error.status ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
    }
  });
  const tests = JSON.parse(r.stdout || '{"tests":[]}').tests ?? [];
  const hit = tests.find((t) => t.path === c.path && (t.full_name === c.name || t.full_name.endsWith(` > ${c.name}`)));
  if (!hit) throw new Error(`no ${c.gate} test ${c.path} › ${c.name} for ${ticket.node_id}: ${tests.length} matched`);
  return hit.id;
}

/** A correction ticket's worker: no edit, no gate; the corrected result only. */
function correctionWorker(ticket, pack) {
  const module = ticket.node_id.split('.')[1];
  const criteria = plan.modules[module].criteria;
  const gates = Object.fromEntries(pack.correction.gates.map((g) => [g.gate, g.output_sha256]));
  log({ correction: { node: ticket.node_id, code: pack.correction.code, corrections: pack.correction.corrections, candidates: pack.correction.candidates.length, criteria: pack.acceptance_criteria.map((a) => ({ id: a.id, kind: a.kind, sha256: a.sha256 })) } });
  const result = {
    schema_version: 1,
    node_id: ticket.node_id,
    claim_id: ticket.claim_id,
    dispatch_id: ticket.dispatch_id,
    outcome: 'SUBMITTED',
    commands: [],
    commit_sha: pack.correction.commit_sha,
    evidence_paths: [],
    failure_fingerprint: null,
    decision_request: null,
    criterion_evidence: criteria.map((c) => ({ criterion: c.criterion, test_id: testIdOf(ticket, c), gate: c.gate, output_sha256: gates[c.gate] })),
  };
  mkdirSync(dirname(ticket.result_slot), { recursive: true });
  writeFileSync(ticket.result_slot, JSON.stringify(result, null, 2));
}

async function worker(ticket) {
  const pack = packOf(ticket);
  if (pack?.correction) return correctionWorker(ticket, pack);
  const next = Math.max(0, ['RED_VERIFIED', 'GREEN_VERIFIED', 'REGRESSION_VERIFIED'].indexOf(pack?.next_required_gate));
  const module = ticket.node_id.split('.')[1];
  const reworked = pack?.rework !== undefined && next === 0;
  const tests = reworked ? plan.regression[module].tests : plan.modules[module].tests;
  const criteria = reworked ? plan.regression[module].criteria : plan.modules[module].criteria;
  const impl = plan.modules[module].impl;
  const wt = ticket.worktree;
  const printed = {};
  const seen = { node: ticket.node_id, rework: pack?.rework !== undefined, next_required_gate: pack?.next_required_gate ?? null, module: pack?.module?.id ?? null, setup_inputs: pack?.worktree_setup?.inputs ?? null, gates: [] };
  const gate = (name) => {
    const line = ticket.gate_commands.find((g) => g.gate === name)?.command;
    if (!line) throw new Error(`no ${name} gate for ${ticket.node_id}`);
    const r = bash(line, () => {
      try {
        return { status: 0, stdout: execSync(line, { cwd: control, env, encoding: 'utf8', stdio: 'pipe', maxBuffer: 64 << 20 }), stderr: '' };
      } catch (error) {
        return { status: error.status ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
      }
    });
    const out = `${r.stdout}${r.stderr}`;
    seen.gates.push({ gate: name, exit: r.status, rerun: /worktree setup ran again/.test(out), tail: out.slice(-1500) });
    if (r.status !== 0) throw new Error(`${name} gate of ${ticket.node_id} exited ${r.status}: ${out.slice(-3000)}`);
    const sha = /sha256 ([0-9a-f]{64})/.exec(r.stdout)?.[1];
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
  try {
    if (next === 0) {
      const written = write(tests);
      commands.push(gate('red'));
      commit(written, `test(${module}): ${reworked ? 'regression for QA report' : 'cover reporting every invalid changeset'}`);
      changed.push(...written);
      if (takeover && !tookOver) {
        // CSET-202 r2's controller, while its worker runs: it writes the worker's result itself; the plugin's fence refuses.
        tookOver = true;
        const saved = parent;
        parent = null;
        const id = `toolu_fake_${++toolId}`;
        const input = { file_path: ticket.result_slot, content: JSON.stringify({ schema_version: 1, node_id: ticket.node_id, claim_id: ticket.claim_id, outcome: 'SUBMITTED' }) };
        const blocked = preToolUse('Write', input);
        if (blocked === null) writeFileSync(ticket.result_slot, input.content);
        log({ takeover: { node: ticket.node_id, blocked } });
        process.stdout.write(`${JSON.stringify({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id, name: 'Write', input }] } })}\n${JSON.stringify({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: id, ...(blocked !== null ? { is_error: true } : {}), content: blocked ?? 'written' }] } })}\n`);
        parent = saved;
        await new Promise((r) => setTimeout(r, 600_000));
      }
    }
    if (next <= 1) {
      const production = write(impl);
      commands.push(gate('green'));
      commit(production, `feat(${module}): ${reworked ? 'restore what QA found missing' : 'report every invalid changeset'}`);
      changed.push(...production);
    }
    commands.push(gate('regression'));
  } finally {
    log({ worker: seen });
  }
  const redRecorded = (pack?.latest_evidence ?? []).find((e) => e.kind === 'red')?.output_sha256;
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
    criterion_evidence: criteria.map((c) => {
      const item = { criterion: c.criterion, test_id: testIdOf(ticket, c), gate: c.gate, output_sha256: c.gate === 'red' ? (printed.red ?? redRecorded) : printed[c.gate] };
      if (!(plan.evidenceMistake && !qa && module === 'cli' && !reworked && !mistaken)) return item;
      // The first cli worker: a wrong display name beside a valid id (display only), and an id no gate published.
      return c.gate === 'red' ? { ...item, test: { path: c.path, name: `status > ${c.name}` } } : { ...item, test_id: '0000000000000000' };
    }),
  };
  if (plan.evidenceMistake && module === 'cli' && !reworked) mistaken = true;
  mkdirSync(dirname(ticket.result_slot), { recursive: true });
  writeFileSync(ticket.result_slot, JSON.stringify(result, null, 2));
}

/** A ticket line run as the host's Bash tool runs it. */
function shell(line) {
  return bash(line, () => {
    try {
      return { status: 0, stdout: execSync(line, { cwd: control, env, encoding: 'utf8', stdio: 'pipe', maxBuffer: 64 << 20 }), stderr: '' };
    } catch (error) {
      return { status: error.status ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
    }
  });
}

/** The host's side of the stand-in reviewer subagent: its stream, its hooks, its Agent call. */
const reviewHost = {
  emit,
  nextId: () => `toolu_fake_${++toolId}`,
  preToolUse: (tool, input) => preToolUse(tool, input),
  setParent: (id, type) => {
    parent = id;
    parentType = type;
  },
};

async function settleAndDeliver(key) {
  for (let i = 0; i < 24; i++) {
    const d = JSON.parse(mycelink(['dispatch', FEATURE, '--control-root', control, '--authority', key, '--json'], { allowFail: true }).stdout);
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
      // The acceptance review before the candidate: the reviewer subagent's verdict, then the ticket's settle line.
      runReviewer(d.ticket, reviewHost);
      const r = shell(d.ticket.settle_command);
      const s = JSON.parse(r.stdout || '{}');
      log({ review: { review_id: d.ticket.review_id, outcome: s.outcome ?? null, code: s.code ?? null } });
      if (s.outcome !== 'PASS' && s.outcome !== 'GAPS') throw new Error(`review settle ${d.ticket.review_id}: ${s.outcome} ${s.code ?? ''} ${s.detail ?? r.stderr}`);
      commitControl(`${FEATURE}: review ${d.ticket.review_id}`);
      continue;
    }
    await work(d.ticket);
    // settle exits 1 for anything but DONE; its JSON says what happened.
    const s = JSON.parse(mycelink(['settle', FEATURE, d.ticket.node_id, '--capability', d.ticket.capability, '--control-root', control, '--json'], { allowFail: true }).stdout);
    log({ settled: { node: d.ticket.node_id, outcome: s.outcome, detail: s.detail ?? null } });
    if (s.outcome === 'EVIDENCE_CORRECTION_REQUIRED') {
      // Nothing was charged or integrated: dispatch again, and a fresh worker corrects the evidence.
      const rt = JSON.parse(readFileSync(join(control, 'features', FEATURE, 'STATE.json'), 'utf8')).data.nodes[d.ticket.node_id];
      log({ held: { node: d.ticket.node_id, detail: s.detail.slice(0, 300), candidates: (s.candidates ?? []).length, attempts: rt.attempts, failures: Object.keys(rt.failure_counts).length, claim: rt.claim?.claim_id ?? null } });
      continue;
    }
    if (s.outcome !== 'DONE') throw new Error(`settle ${d.ticket.node_id}: ${s.outcome} ${s.detail ?? ''}`);
    commitControl(`${FEATURE}: ${d.ticket.node_id} settled`);
  }
  throw new Error('the feature never settled');
}

/** The first task session takes over its first worker's result when the plan says so (CSET-202 r2). */
const takeover = Boolean(plan.takeover) && !/QA ran its end-to-end checks/.test(prompt) && !/previous session on this request was stopped by the evaluator/.test(prompt);
const qa = /QA ran its end-to-end checks on the delivered commit ([0-9a-f]{12}) and found a defect:\n\n((?:- [^\n]*\n?)+)/.exec(prompt);
log({ phase: qa ? 'rework' : 'task' });
try {
  if (qa) {
    const key = authority();
    const { owners } = json(['feature', 'owners', FEATURE, '--since-delivery', '--control-root', control, '--json']);
    log({ owners: owners.map((o) => o.node_id) });
    if (owners.length === 0) throw new Error('no producer node owns what QA reported');
    // The reason is bounded in bytes (QA's messages carry multi-byte characters): cut whole characters below it.
    let reason = `QA on the delivered ${qa[1]}:\n${qa[2].trim()}`;
    while (Buffer.byteLength(reason) > 1900) reason = reason.slice(0, -16);
    for (const owner of owners) {
      const r = mycelink(['node', 'rework', FEATURE, owner.node_id, '--reason', reason, '--control-root', control, '--authority', key, '--json'], { allowFail: true });
      if (r.status !== 0 && !/REWORK_NOT_DONE/.test(r.stderr)) throw new Error(`node rework: ${r.stderr}`);
      commitControl(`${FEATURE}: rework ${owner.node_id}`);
    }
    const delivery = await settleAndDeliver(key);
    done(`Reworked ${owners.map((o) => o.node_id).join(', ')}; ${delivery.candidate_id} delivered. Tests: every gate passed.`);
  } else {
    const delivery = await settleAndDeliver(setUp());
    done(`Delivered ${delivery.candidate_id}. Tests: every gate passed.`);
  }
} catch (error) {
  fail(error);
}
