#!/usr/bin/env node
/**
 * Model-free Mycelink orchestration over a Ledgerline workspace.
 *
 * Builds an existing-cold workspace, turns platform/ into a Mycelink control
 * repository, registers the four module repositories, writes a real
 * four-layer graph for LEDGER-142 and drives it to delivery.
 *
 * The default mode is the plugin's primary, host-native path: `mycelink
 * dispatch` hands out one ticket at a time, a deterministic stand-in for the
 * host's Agent tool fulfils it the way the module-worker subagent would
 * (absolute paths in the worktree, the ticket's exact gate lines through a
 * shell, a commit, a JSON result in the ticket's result slot), and `mycelink
 * settle` takes it back. Mode "adapter" instead runs `mycelink orchestrate
 * run` with the repository's fake Claude executable
 * (tests/fake-claude/claude.mjs). Either way each worker performs real TDD
 * — failing test, RED, reference implementation, commit, GREEN, regression —
 * so every artifact (STATE.json, evidence, leases, integration branches,
 * candidate) is genuine.
 *
 * Finally `mycelink deliver` fast-forwards each module's main branch to the
 * candidate and records acceptance, so the verifier's orchestration path can
 * be exercised positively: candidate SHAs == delivered SHAs.
 *
 *   node evals-multimodule/tools/mycelink-fixture.mjs <empty-dir> [host|adapter]
 */
import { execSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TOOLS = dirname(fileURLToPath(import.meta.url));
const LIB = resolve(TOOLS, '..', '_lib');
const REPO_ROOT = resolve(TOOLS, '..', '..');
const MYCELINK = join(REPO_ROOT, 'bin', 'mycelink.mjs');
const FAKE_CLAUDE = join(REPO_ROOT, 'tests', 'fake-claude', 'claude.mjs');
export const FEATURE = 'LEDGER-142';
const { scaffold, git, MODULES, CONSUMERS } = await import(pathToFileURL(join(LIB, 'scaffold.mjs')).href);

function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p).split(sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

function filesOf(dir, prefix = '') {
  const out = {};
  if (!existsSync(dir)) return out;
  for (const rel of listFiles(dir)) out[prefix + rel] = readFileSync(join(dir, ...rel.split('/')), 'utf8').replace(/\r\n/g, '\n');
  return out;
}

function treeSha256(files) {
  const h = createHash('sha256');
  for (const rel of Object.keys(files).sort()) h.update(`${rel}\0${createHash('sha256').update(files[rel]).digest('hex')}\n`);
  return h.digest('hex');
}

function mycelink(args, { env = {}, allowFail = false } = {}) {
  const r = spawnSync(process.execPath, [MYCELINK, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env }, timeout: 600_000 });
  if (r.status !== 0 && !allowFail) throw new Error(`mycelink ${args.join(' ')} exited ${r.status}\n${r.stdout}\n${r.stderr}`);
  return r;
}

/** RED tests that fail on an assertion (behaviour missing), not on a missing module. */
const RED_TESTS = {
  core: [
    'test/refunds-contract.test.mjs',
    `import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/index.mjs';

test('core publishes the refund contract', () => {
  assert.equal(core.ERROR_CODES.REFUND_EXCEEDS_CAPTURED, 'REFUND_EXCEEDS_CAPTURED');
  assert.ok(core.EVENT_TYPES.includes('refund.requested'));
});
`,
  ],
  api: [
    'test/refunds-route.test.mjs',
    `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.mjs';

test('POST /orders/:id/refunds requires an idempotency key', async (t) => {
  const { call } = await startApp(t);
  const { body } = await call('POST', '/orders', { amount_cents: 100, currency: 'USD' });
  const res = await call('POST', \`/orders/\${body.order.order_id}/refunds\`, { amount_cents: 1 });
  assert.equal(res.body.error.code, 'IDEMPOTENCY_KEY_REQUIRED');
});
`,
  ],
  worker: [
    'test/refund-handler.test.mjs',
    `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HANDLERS } from '../src/worker.mjs';

test('refund jobs have a handler', () => {
  assert.equal(typeof HANDLERS['refund.process'], 'function');
});
`,
  ],
  cli: [
    'test/refunds-command.test.mjs',
    `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GROUPS } from '../src/main.mjs';

test('the refunds command group exists', () => {
  assert.equal(typeof GROUPS.refunds?.create, 'function');
});
`,
  ],
};

function nodeId(module) {
  return `${FEATURE}.${module}.refunds.impl`;
}

function worker() {
  return { model: 'sonnet', effort: 'high', max_turns: 20, max_wall_clock_minutes: 5, max_attempts: 2, nested_delegation: false };
}

function graph() {
  const impl = (module, depends, ac) => ({
    id: nodeId(module),
    level: 'executable-node',
    repository: module,
    capability: `CAP-${module.toUpperCase()}-REFUNDS`,
    node_type: 'implementation',
    depends_on: depends,
    allowed_paths: ['src/**', 'test/**', 'vendor/**', 'package.json'],
    forbidden_paths: [],
    contract_inputs: [],
    contract_outputs: [],
    required_resources: [],
    required_evidence: ['red', 'green', 'regression'],
    verification_commands: [{ id: 'targeted', command: ['node', '--test', RED_TESTS[module][0]] }],
    worker: worker(),
    invalidation_rules: [],
    acceptance_criteria: [ac],
  });
  return {
    schema_version: 1,
    feature_id: FEATURE,
    title: 'Partial refunds',
    prd: 'PRD.md',
    acceptance_criteria: [
      { id: 'AC-1', text: 'Shared refund contracts in ledger-core.' },
      { id: 'AC-2', text: 'Refund HTTP API.' },
      { id: 'AC-3', text: 'Refund settlement in the worker.' },
      { id: 'AC-4', text: 'Refund CLI commands.' },
    ],
    resources: { 'full-runtime': { capacity: 1 }, 'deploy-slot': { capacity: 1 }, 'browser-worker': { capacity: 2 }, 'fixture-global-reset': { capacity: 1 } },
    repositories: [...MODULES],
    capabilities: MODULES.map((m, i) => ({ id: `CAP-${m.toUpperCase()}-REFUNDS`, repository: m, title: `${m} refunds`, acceptance_criteria: [`AC-${i + 1}`] })),
    nodes: [
      impl('core', [], 'AC-1'),
      impl('api', [nodeId('core')], 'AC-2'),
      impl('worker', [nodeId('core')], 'AC-3'),
      impl('cli', [nodeId('core')], 'AC-4'),
      {
        id: `${FEATURE}.release.candidate.build`,
        level: 'executable-node',
        repository: null,
        capability: null,
        node_type: 'candidate-build',
        depends_on: MODULES.map(nodeId),
        allowed_paths: [],
        forbidden_paths: [],
        contract_inputs: [],
        contract_outputs: [],
        required_resources: [],
        required_evidence: ['candidate'],
        verification_commands: [{ id: 'candidate', command: ['mycelink', 'candidate', 'verify', FEATURE] }],
        worker: { ...worker(), max_turns: 1 },
        invalidation_rules: [],
        acceptance_criteria: [],
      },
    ],
  };
}

function scenarios(control) {
  // What the reference implementation looks like per module, including the
  // re-vendored core (computed exactly as scripts/sync-core.mjs would).
  const coreSrc = { ...filesOf(join(LIB, 'ledgerline', 'core', 'src')), ...filesOf(join(LIB, 'reference-solution', 'core', 'src')) };
  const corePkg = JSON.parse(readFileSync(join(LIB, 'reference-solution', 'core', 'package.json'), 'utf8'));
  const vendored = Object.fromEntries(Object.entries(coreSrc).map(([k, v]) => [`vendor/ledger-core/${k}`, v]));
  const lock = { package: corePkg.name, version: corePkg.version, tree_sha256: treeSha256(coreSrc) };
  const tdd = (phase, module, cmd) => [process.execPath, MYCELINK, 'tdd', phase, FEATURE, nodeId(module), '--control-root', control, '--', ...cmd];
  const nodes = {};
  for (const module of MODULES) {
    const [redFile, redBody] = RED_TESTS[module];
    let impl = filesOf(join(LIB, 'reference-solution', module));
    if (CONSUMERS.includes(module)) impl = { ...impl, ...vendored, 'vendor/ledger-core.lock.json': JSON.stringify(lock, null, 2) + '\n' };
    nodes[nodeId(module)] = {
      outcome: 'SUBMITTED',
      turns: 3,
      steps: [
        { write_files: { [redFile]: redBody } },
        { label: 'tdd-red', run: tdd('red', module, ['node', '--test', redFile]), expect_exit: 0 },
        { write_files: impl },
        { git_commit: `${module}: refunds (${FEATURE})` },
        { label: 'tdd-green', run: tdd('green', module, ['node', '--test', redFile]), expect_exit: 0 },
        { label: 'tdd-regression', run: tdd('regression', module, ['node', '--test']), expect_exit: 0 },
      ],
    };
  }
  return { nodes };
}

/**
 * A defect a worker can ship that its own node checks do not see: the CLI's
 * `refunds list` prints nothing. The module suite and the node's targeted
 * test pass; QA's acceptance suite (L2) does not.
 */
const DEFECTS = {
  cli: (impl) => {
    const file = 'src/commands/refunds.mjs';
    const good = impl[file];
    const bad = good.replace(/return \(await request\('GET', `\/orders\/\$\{orderIdArg\(positionals\)\}\/refunds`\)\)\.refunds;/, 'void positionals;\n    return [];');
    if (bad === good) throw new Error('cli defect did not apply');
    return { ...impl, [file]: bad };
  },
};

/** The repair of that defect: the node's own test now pins `refunds list`, then the reference implementation. */
function repairFor(module) {
  if (module !== 'cli') throw new Error(`no repair scripted for ${module}`);
  const [redFile, redBody] = RED_TESTS.cli;
  const listTest = `
test('refunds list returns the refunds the API reports', async () => {
  const { refunds } = await import('../src/commands/refunds.mjs');
  const listed = await refunds.list({ positionals: ['ord_1'], flags: {} }, async (method, path) => {
    assert.equal(method, 'GET');
    assert.equal(path, '/orders/ord_1/refunds');
    return { refunds: [{ refund_id: 'rf_1' }] };
  });
  assert.deepEqual(listed, [{ refund_id: 'rf_1' }]);
});
`;
  return { tests: { [redFile]: redBody + listTest }, impl: { 'src/commands/refunds.mjs': workFor('cli').impl['src/commands/refunds.mjs'] } };
}

/** What each module's worker writes: the RED test, then the reference implementation. */
function workFor(module, defects = []) {
  const coreSrc = { ...filesOf(join(LIB, 'ledgerline', 'core', 'src')), ...filesOf(join(LIB, 'reference-solution', 'core', 'src')) };
  const corePkg = JSON.parse(readFileSync(join(LIB, 'reference-solution', 'core', 'package.json'), 'utf8'));
  const vendored = Object.fromEntries(Object.entries(coreSrc).map(([k, v]) => [`vendor/ledger-core/${k}`, v]));
  const lock = { package: corePkg.name, version: corePkg.version, tree_sha256: treeSha256(coreSrc) };
  const [redFile, redBody] = RED_TESTS[module];
  let impl = filesOf(join(LIB, 'reference-solution', module));
  if (CONSUMERS.includes(module)) impl = { ...impl, ...vendored, 'vendor/ledger-core.lock.json': JSON.stringify(lock, null, 2) + '\n' };
  if (defects.includes(module)) impl = DEFECTS[module](impl);
  return { tests: { [redFile]: redBody }, impl };
}

function writeAll(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, ...rel.split('/'));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return Object.keys(files);
}

/** The module-worker subagent, deterministically: one ticket, real TDD, one result. */
function fulfilTicket(ticket, control, work = workFor) {
  const module = ticket.repository;
  const { tests, impl } = work(module);
  const gate = (name) => {
    const line = ticket.gate_commands.find((g) => g.gate === name)?.command;
    if (!line) throw new Error(`ticket for ${ticket.node_id} offers no ${name} gate`);
    // Like the Bash tool: the exact line, from the host's working directory.
    execSync(line, { cwd: control, stdio: 'pipe' });
    return { command: [`gate:${name}`], exit_code: 0 };
  };
  const changed = writeAll(ticket.worktree, tests);
  const commands = [gate('red')];
  changed.push(...writeAll(ticket.worktree, impl));
  git(ticket.worktree, ['add', '--all']);
  git(ticket.worktree, ['commit', '--quiet', '-m', `${module}: refunds (${FEATURE})`], { time: Date.parse('2026-10-01T11:00:00Z') });
  commands.push(gate('green'), gate('regression'));
  const result = {
    schema_version: 1,
    node_id: ticket.node_id,
    claim_id: ticket.claim_id,
    ...(ticket.dispatch_id ? { dispatch_id: ticket.dispatch_id } : {}),
    outcome: 'SUBMITTED',
    commands,
    commit_sha: git(ticket.worktree, ['rev-parse', 'HEAD']).stdout,
    changed_paths: changed,
    evidence_paths: [],
    failure_fingerprint: null,
    decision_request: null,
    usage: { model_turns: 3, input_tokens: 300, output_tokens: 150 },
  };
  mkdirSync(dirname(ticket.result_slot), { recursive: true });
  writeFileSync(ticket.result_slot, JSON.stringify(result, null, 2));
}

/** The bounded host loop /mycelink:run describes: dispatch -> Agent -> settle. */
function hostLoop(control, key, env, log, work = workFor) {
  for (let i = 0; i < 20; i++) {
    const d = JSON.parse(mycelink(['dispatch', FEATURE, '--control-root', control, '--authority', key, '--json'], { env, allowFail: true }).stdout);
    if (d.status !== 'DISPATCHED') return d;
    fulfilTicket(d.ticket, control, work);
    const s = mycelink(['settle', FEATURE, d.ticket.node_id, '--capability', d.ticket.capability, '--control-root', control, '--json'], { env, allowFail: true });
    const report = JSON.parse(s.stdout);
    log(`settle ${d.ticket.node_id}: ${report.outcome}`);
    if (report.outcome !== 'DONE') throw new Error(`settle ${d.ticket.node_id} -> ${report.outcome}: ${report.detail}`);
  }
  return { status: 'MAX_ITERATIONS' };
}

export function buildOrchestratedWorkspace(ws, { log = () => {}, mode = 'host', defects = [] } = {}) {
  if (mode !== 'host' && mode !== 'adapter') throw new Error(`unknown mode ${mode}; expected host | adapter`);
  if (mode === 'adapter' && !existsSync(FAKE_CLAUDE)) throw new Error(`fake Claude executable missing: ${FAKE_CLAUDE}`);
  scaffold(ws, 'existing-cold', { runTests: false });
  const control = join(ws, 'platform');
  mycelink(['init', control]);
  // Controller-only commands need the controller key; workers never get it.
  const key = JSON.parse(mycelink(['controller', 'open', '--control-root', control, '--json']).stdout).authority;
  const configPath = join(control, 'mycelink.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  // Host mode needs no worker executable at all; point the standalone adapter
  // at nothing so an accidental nested spawn could not succeed.
  const adapter =
    mode === 'adapter'
      ? { claude_executable: FAKE_CLAUDE, session_adapter: 'fake-claude', claude_extra_args: [] }
      : { claude_executable: join(ws, 'no-claude-here'), session_adapter: 'claude-background', claude_extra_args: [] };
  writeFileSync(configPath, JSON.stringify({ ...config, ...adapter }, null, 2) + '\n');
  for (const m of MODULES) {
    mycelink(['repo', 'register', '--control-root', control, '--authority', key, '--name', m, '--path', `../repos/${m}`, '--base-branch', 'main', '--', 'node', '--test']);
  }
  const featureDir = join(control, 'features', FEATURE);
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(join(featureDir, 'PRD.md'), readFileSync(join(control, 'requirements', 'LEDGER-142-partial-refunds.md'), 'utf8'));
  writeFileSync(join(featureDir, 'PORTFOLIO-GRAPH.yaml'), JSON.stringify(graph(), null, 2) + '\n');
  // `mycelink init` itself ignores its .mycelink/ scratch area; nothing is added by hand.
  if (!/^\/\.mycelink\/$/m.test(readFileSync(join(control, '.gitignore'), 'utf8'))) {
    throw new Error('mycelink init did not write the .mycelink/ ignore entry');
  }
  git(control, ['add', '--all']);
  git(control, ['commit', '--quiet', '-m', `${FEATURE}: control plane`], { time: Date.parse('2026-10-01T10:00:00Z') });

  const scenarioFile = join(dirname(ws), 'fake-claude-scenario.json');
  writeFileSync(scenarioFile, JSON.stringify(scenarios(control), null, 2));
  const env = { FAKE_CLAUDE_SCENARIO: scenarioFile };
  mycelink(['graph', 'validate', FEATURE, '--control-root', control, '--json'], { env });
  mycelink(['feature', 'init', FEATURE, '--control-root', control, '--authority', key, '--json'], { env });

  let report;
  if (mode === 'host') {
    report = hostLoop(control, key, env, log, (module) => workFor(module, defects));
    report.stop_reason = report.status;
  } else {
    const run = mycelink(['orchestrate', 'run', FEATURE, '--control-root', control, '--authority', key, '--json', '--max-cycles', '20'], { env, allowFail: true });
    try {
      report = JSON.parse(run.stdout);
    } catch {
      throw new Error(`orchestrate run produced no JSON (exit ${run.status})\n${run.stdout}\n${run.stderr}`);
    }
  }
  log(`${mode}: ${report.stop_reason}`);
  if (report.stop_reason !== 'ALL_SETTLED') {
    throw new Error(`${mode} run stopped with ${report.stop_reason}: ${report.detail ?? JSON.stringify(report.reports?.filter((r) => r.outcome !== 'DONE'))}`);
  }
  // Delivery: the controller fast-forwards each module's main branch to the
  // candidate and records final acceptance.
  const delivery = JSON.parse(mycelink(['deliver', FEATURE, '--control-root', control, '--authority', key, '--json'], { env }).stdout);
  log(`deliver: ${delivery.status}`);
  return { control, report, delivery, authority: key };
}

/**
 * Repair a delivered feature in place, as /mycelink:run documents: rework
 * the node the failure is attributed to, dispatch and settle it again from
 * the current integration state, let the candidate build cut a new
 * candidate over every module, and deliver it. No new feature id.
 */
export function reworkAndRedeliver(built, { module, reason, log = () => {} }) {
  const { control, authority: key } = built;
  const node = nodeId(module);
  const rework = JSON.parse(mycelink(['node', 'rework', FEATURE, node, '--reason', reason, '--control-root', control, '--authority', key, '--json']).stdout);
  log(`rework ${node}: reopened ${rework.reopened.join(', ')}`);
  const report = hostLoop(control, key, {}, log, (m) => (m === module ? repairFor(m) : workFor(m)));
  if (report.status !== 'ALL_SETTLED') throw new Error(`rework run stopped with ${report.status}: ${report.detail ?? ''}`);
  git(control, ['add', '--all']);
  git(control, ['commit', '--quiet', '--allow-empty', '-m', `${FEATURE}: rework ${module}`], { time: Date.parse('2026-10-01T12:00:00Z') });
  const delivery = JSON.parse(mycelink(['deliver', FEATURE, '--control-root', control, '--authority', key, '--json']).stdout);
  log(`deliver: ${delivery.status}`);
  return { rework, report, delivery };
}

/** Plan and initialise a second feature over the same modules (the follow-up-feature anti-pattern), committed. */
export function planSecondFeature(built, id) {
  const { control, authority: key } = built;
  const dir = join(control, 'features', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'PRD.md'), `# ${id}\n\nA follow-up feature.\n`);
  writeFileSync(join(dir, 'PORTFOLIO-GRAPH.yaml'), JSON.stringify(graph(), null, 2).replaceAll(FEATURE, id) + '\n');
  mycelink(['feature', 'init', id, '--control-root', control, '--authority', key, '--json']);
  git(control, ['add', '--all']);
  git(control, ['commit', '--quiet', '-m', `${id}: planned`], { time: Date.parse('2026-10-01T13:00:00Z') });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: node mycelink-fixture.mjs <empty-dir> [host|adapter]');
    process.exit(2);
  }
  try {
    const { control, report, delivery } = buildOrchestratedWorkspace(resolve(target), { log: console.log, mode: process.argv[3] ?? 'host' });
    console.log(JSON.stringify({ control, stop_reason: report.stop_reason, delivery: delivery.status }, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
