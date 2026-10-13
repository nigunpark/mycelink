#!/usr/bin/env node
/**
 * Model-free Mycelink orchestration over a public-project workspace.
 *
 * Drives the plugin's primary, host-native path on a workspace a scaffold
 * built: `mycelink init` turns platform/ into the control repository, the
 * project repository is registered, a graph with one node per module of a
 * work plan (plus the candidate build) is planned and initialised, and
 * `dispatch -> worker -> settle` runs until every node settles; `deliver`
 * then fast-forwards the project's main branch to the candidate.
 *
 * The worker is a deterministic stand-in for the module-worker subagent:
 * in the ticket's worktree it commits the node's tests first, runs the RED
 * gate, commits the production code, runs GREEN and regression — the exact
 * gate lines the ticket renders — and writes one JSON result. Every
 * artifact (STATE.json, evidence, leases, sessions, integration branch,
 * candidate, delivery) is genuine.
 */
import { execSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git } from '../lib/git.mjs';
import { writeVerdict } from '../lib/review-standin.mjs';

const TOOLS = dirname(fileURLToPath(import.meta.url));
export const MYCELINK_BIN = resolve(TOOLS, '..', '..', 'bin', 'mycelink.mjs');

const WORKER_IDENTITY = {
  GIT_AUTHOR_NAME: 'Fixture Worker',
  GIT_AUTHOR_EMAIL: 'worker@fixture.invalid',
  GIT_COMMITTER_NAME: 'Fixture Worker',
  GIT_COMMITTER_EMAIL: 'worker@fixture.invalid',
};

export function mycelink(args, { env = {}, allowFail = false, bin = MYCELINK_BIN } = {}) {
  const r = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env }, timeout: 900_000 });
  if (r.status !== 0 && !allowFail) throw new Error(`mycelink ${args.join(' ')} exited ${r.status}\n${r.stdout}\n${r.stderr}`);
  return r;
}

function writeAll(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, ...rel.split('/'));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return Object.keys(files);
}

function workerCommit(worktree, message, env) {
  git(worktree, ['add', '--all']);
  git(worktree, ['commit', '-q', '--no-verify', '-m', message], { env: { ...WORKER_IDENTITY, ...env } });
}

/** Test names a JS test file declares (`test('x')` / `it('x')`), in order. */
export function declaredNames(source) {
  return [...String(source).matchAll(/(?<![\w$.])(?:it|test)\s*\(\s*(['"])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]);
}

/**
 * The criterion evidence a module-worker reports: each criterion of the pack
 * proved by the last test the files its RED wrote declare (the one it added)
 * and the hash the red gate printed, or by the test its retained RED declared.
 */
export function criterionEvidenceFor(pack, tests, printed) {
  const acs = pack?.acceptance_criteria ?? [];
  if (acs.length === 0) return {};
  const names = Object.entries(tests ?? {}).flatMap(([path, body]) => declaredNames(body).map((name) => ({ path, name })));
  const test = names.at(-1);
  const red = printed.red ?? (pack?.latest_evidence ?? []).find((e) => e.kind === 'red')?.output_sha256;
  if (!test || !red) return {};
  return { criterion_evidence: acs.map((a) => ({ criterion: a.id, test, gate: 'red', output_sha256: red })) };
}

export function nodeId(prdId, module) {
  return `${prdId}.${module}.impl`;
}

/**
 * The graph for a work plan: one implementation node per plan entry (in
 * the plan's order; `after` lists the modules a node depends on) plus the
 * candidate build over every node.
 */
export function planGraph({ prdId, title, repository, plan }) {
  const worker = { model: 'sonnet', effort: 'high', max_turns: 20, max_wall_clock_minutes: 30, max_attempts: 2, nested_delegation: false };
  const impl = plan.nodes.map((n, i) => ({
    id: nodeId(prdId, n.module),
    level: 'executable-node',
    repository,
    capability: `CAP-${n.module.toUpperCase()}`,
    node_type: 'implementation',
    depends_on: (n.after ?? []).map((m) => nodeId(prdId, m)),
    allowed_paths: n.allowed,
    forbidden_paths: [],
    contract_inputs: [],
    contract_outputs: [],
    required_resources: [],
    required_evidence: ['red', 'green', 'regression'],
    verification_commands: [{ id: 'targeted', command: n.verification }],
    worker,
    invalidation_rules: [],
    acceptance_criteria: [`AC-${i + 1}`],
  }));
  return {
    schema_version: 1,
    feature_id: prdId,
    title,
    prd: 'PRD.md',
    acceptance_criteria: plan.nodes.map((n, i) => ({ id: `AC-${i + 1}`, text: `${n.module} part of ${prdId}` })),
    resources: { 'full-runtime': { capacity: 1 } },
    repositories: [repository],
    capabilities: plan.nodes.map((n, i) => ({ id: `CAP-${n.module.toUpperCase()}`, repository, title: n.module, acceptance_criteria: [`AC-${i + 1}`] })),
    nodes: [
      ...impl,
      {
        id: `${prdId}.release.candidate.build`,
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
        verification_commands: [{ id: 'candidate', command: ['mycelink', 'candidate', 'verify', prdId] }],
        worker: { ...worker, max_turns: 1 },
        invalidation_rules: [],
        acceptance_criteria: [],
      },
    ],
  };
}

/**
 * The deterministic module-worker, as the worker contract has it: the
 * failing tests, the RED gate, the test changes committed alone, the
 * production code, the GREEN gate, the production changes committed alone,
 * regression. `work.history: 'mixed'` acts out the first PCM-101 pilot's
 * workers instead: one commit of tests and production together, which
 * settle refuses (TDD_HISTORY_INVALID:MIXED_COMMIT) before integration.
 */
/** The context pack a ticket's prompt carries: controller-generated JSON between its markers. */
export function packOf(ticket) {
  const m = /<mycelink-context-pack>\s*([\s\S]*?)\s*<\/mycelink-context-pack>/.exec(ticket.prompt ?? '');
  return m ? JSON.parse(m[1]) : null;
}

export function fulfilTicket(ticket, control, work, env = {}) {
  const printed = {};
  const gate = (name) => {
    const line = ticket.gate_commands.find((g) => g.gate === name)?.command;
    if (!line) throw new Error(`ticket for ${ticket.node_id} offers no ${name} gate`);
    const out = execSync(line, { cwd: control, stdio: 'pipe', encoding: 'utf8', env: { ...process.env, ...env } });
    const sha = /sha256 ([0-9a-f]{64})/.exec(out)?.[1];
    if (sha) printed[name] = sha;
    return { command: [`gate:${name}`], exit_code: 0 };
  };
  // A node reopened because an upstream node was reworked keeps its RED: its work, already integrated, is re-proved GREEN.
  const regreen = packOf(ticket)?.next_required_gate === 'GREEN_VERIFIED';
  const changed = regreen ? [] : writeAll(ticket.worktree, work.tests);
  const commands = regreen ? [] : [gate('red')];
  if (regreen) {
    commands.push(gate('green'), gate('regression'));
  } else if (work.history === 'mixed') {
    changed.push(...writeAll(ticket.worktree, work.impl));
    workerCommit(ticket.worktree, `feat: ${ticket.node_id} with its tests`, env);
    commands.push(gate('green'), gate('regression'));
  } else {
    workerCommit(ticket.worktree, `test: ${ticket.node_id} (RED)`, env);
    changed.push(...writeAll(ticket.worktree, work.impl));
    commands.push(gate('green'));
    workerCommit(ticket.worktree, `feat: ${ticket.node_id}`, env);
    commands.push(gate('regression'));
  }
  const result = {
    schema_version: 1,
    node_id: ticket.node_id,
    claim_id: ticket.claim_id,
    ...(ticket.dispatch_id ? { dispatch_id: ticket.dispatch_id } : {}),
    outcome: 'SUBMITTED',
    commands,
    commit_sha: git(ticket.worktree, ['rev-parse', 'HEAD']),
    changed_paths: changed,
    evidence_paths: [],
    failure_fingerprint: null,
    decision_request: null,
    usage: { model_turns: 3, input_tokens: 300, output_tokens: 150 },
    ...criterionEvidenceFor(packOf(ticket), work.tests, printed),
  };
  mkdirSync(dirname(ticket.result_slot), { recursive: true });
  writeFileSync(ticket.result_slot, JSON.stringify(result, null, 2));
}

/**
 * Orchestrate and deliver a work plan in `workspace` (a scaffolded case).
 * `plan` is `{ test_command: argv, nodes: [{ module, allowed, after?,
 * verification: argv, tests: {path: body}, impl: {path: body} }] }` with
 * repository-relative paths. `env` reaches the gates (e.g. a sandbox HOME
 * whose ~/.m2 holds the offline Maven setup).
 */
export function orchestrate({ workspace, project, prd, plan, env = {}, log = () => {} }) {
  const control = join(workspace, 'platform');
  const repoDir = project.adapter.workspace.repo_dir;
  const prdId = prd.manifest.id;
  mycelink(['init', control], { env });
  const key = JSON.parse(mycelink(['controller', 'open', '--control-root', control, '--json'], { env }).stdout).authority;
  const configPath = join(control, 'mycelink.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  // Host mode needs no worker executable; make an accidental nested spawn fail.
  writeFileSync(configPath, JSON.stringify({ ...config, session_adapter: 'claude-background', claude_executable: join(workspace, 'no-claude-here'), claude_extra_args: [] }, null, 2) + '\n');
  mycelink(['repo', 'register', '--control-root', control, '--authority', key, '--name', project.id, '--path', relative(control, join(workspace, ...repoDir.split('/'))).split('\\').join('/'), '--base-branch', project.adapter.workspace.branch, '--', ...plan.test_command], { env });
  const featureDir = join(control, 'features', prdId);
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(join(featureDir, 'PRD.md'), readFileSync(join(control, 'requirements', `${prdId}.md`)));
  writeFileSync(join(featureDir, 'PORTFOLIO-GRAPH.yaml'), JSON.stringify(planGraph({ prdId, title: prd.manifest.title, repository: project.id, plan }), null, 2) + '\n');
  git(control, ['add', '--all']);
  git(control, ['commit', '-q', '--no-verify', '-m', `${prdId}: control plane`], { env: WORKER_IDENTITY });
  mycelink(['graph', 'validate', prdId, '--control-root', control, '--json'], { env });
  mycelink(['feature', 'init', prdId, '--control-root', control, '--authority', key, '--json'], { env });
  const work = Object.fromEntries(plan.nodes.map((n) => [nodeId(prdId, n.module), n]));
  const { delivery, settles } = settleAndDeliver({ control, prdId, key, work, env, log });
  return { control, authority: key, delivery, settles };
}

/**
 * The host loop until every node settles (`dispatch -> worker -> settle`),
 * then `deliver` — committing the control repository after each. Returns the
 * accepted delivery and every settle a host transcript would show.
 */
function settleAndDeliver({ control, prdId, key, work, env, log }) {
  // What a host transcript would show: every settle it ran, with its capability.
  const settles = [];
  let stop = null;
  for (let i = 0; i < 4 * Object.keys(work).length + 4; i++) {
    const d = JSON.parse(mycelink(['dispatch', prdId, '--control-root', control, '--authority', key, '--json'], { env, allowFail: true }).stdout);
    if (d.status !== 'DISPATCHED') {
      stop = d;
      break;
    }
    if (d.ticket.kind === 'acceptance-review') {
      // The acceptance review before the candidate: the stand-in reviewer's attested verdict, then its settle.
      writeVerdict(d.ticket, { bin: MYCELINK_BIN, cwd: control, env });
      const r = JSON.parse(mycelink(['review', 'settle', prdId, '--review', d.ticket.review_id, '--capability', d.ticket.capability, '--control-root', control, '--json'], { env, allowFail: true }).stdout || '{}');
      log(`review ${d.ticket.review_id}: ${r.outcome}`);
      if (r.outcome !== 'PASS') throw new Error(`review ${d.ticket.review_id} -> ${r.outcome}: ${r.code ?? ''} ${r.detail ?? ''}`);
      continue;
    }
    fulfilTicket(d.ticket, control, work[d.ticket.node_id], env);
    settles.push({ feature: prdId, node: d.ticket.node_id, capability: d.ticket.capability });
    const s = JSON.parse(mycelink(['settle', prdId, d.ticket.node_id, '--capability', d.ticket.capability, '--control-root', control, '--json'], { env, allowFail: true }).stdout);
    log(`settle ${d.ticket.node_id}: ${s.outcome}`);
    if (s.outcome !== 'DONE') throw new Error(`settle ${d.ticket.node_id} -> ${s.outcome}: ${s.detail}`);
  }
  if (stop?.status !== 'ALL_SETTLED') throw new Error(`orchestration stopped with ${stop?.status ?? 'MAX_ITERATIONS'}: ${stop?.detail ?? ''}`);
  git(control, ['add', '--all']);
  git(control, ['commit', '-q', '--no-verify', '--allow-empty', '-m', `${prdId}: settled`], { env: WORKER_IDENTITY });
  const delivery = JSON.parse(mycelink(['deliver', prdId, '--control-root', control, '--authority', key, '--json'], { env }).stdout);
  log(`deliver: ${delivery.status}`);
  if (delivery.status !== 'ACCEPTED') throw new Error(`delivery ${delivery.status}: ${JSON.stringify(delivery).slice(0, 800)}`);
  git(control, ['add', '--all']);
  git(control, ['commit', '-q', '--no-verify', '--allow-empty', '-m', `${prdId}: delivered`], { env: WORKER_IDENTITY });
  return { delivery, settles };
}

/**
 * Repair a delivered feature as the plugin's run command does after a late
 * failure: `node rework` the producer node with the failure as its reason
 * (a delivered base someone committed on is adopted), dispatch again — the
 * reworked node's worker commits a regression test the red gate accepts,
 * then the fix; a dependent reopened with it re-proves GREEN — then deliver
 * the new candidate. `work` maps node ids to `{ tests, impl }`.
 */
export function rework({ workspace, prd, authority, node, reason, work, env = {}, log = () => {} }) {
  const control = join(workspace, 'platform');
  const prdId = prd.manifest.id;
  const reworked = JSON.parse(mycelink(['node', 'rework', prdId, node, '--reason', reason, '--control-root', control, '--authority', authority, '--json'], { env }).stdout);
  log(`rework ${node}: reopened ${reworked.reopened.join(', ')}`);
  git(control, ['add', '--all']);
  git(control, ['commit', '-q', '--no-verify', '--allow-empty', '-m', `${prdId}: rework ${node}`], { env: WORKER_IDENTITY });
  return { reworked, ...settleAndDeliver({ control, prdId, key: authority, work, env, log }) };
}
