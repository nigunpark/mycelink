#!/usr/bin/env node
/**
 * Model-free Mycelink orchestration over a Ledgerline workspace.
 *
 * Builds an existing-cold workspace, turns platform/ into a Mycelink control
 * repository, registers the four module repositories, writes a real
 * four-layer graph for LEDGER-142 and runs `mycelink orchestrate run` with the
 * repository's fake Claude executable (tests/fake-claude/claude.mjs). Each
 * fake worker performs real TDD inside its Mycelink worktree — writes a
 * failing test, records RED, applies the reference implementation, commits,
 * records GREEN and regression — so every artifact (STATE.json, evidence,
 * sessions, leases, integration branches, candidate) is genuine.
 *
 * Finally each module's main branch is fast-forwarded to the integration
 * branch (the "delivery"), so the verifier's orchestration path can be
 * exercised positively: candidate SHAs == delivered SHAs.
 *
 *   node evals-multimodule/tools/mycelink-fixture.mjs <empty-dir>
 */
import { spawnSync } from 'node:child_process';
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

export function buildOrchestratedWorkspace(ws, { log = () => {} } = {}) {
  if (!existsSync(FAKE_CLAUDE)) throw new Error(`fake Claude executable missing: ${FAKE_CLAUDE}`);
  scaffold(ws, 'existing-cold', { runTests: false });
  const control = join(ws, 'platform');
  mycelink(['init', control]);
  const configPath = join(control, 'mycelink.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  writeFileSync(configPath, JSON.stringify({ ...config, claude_executable: FAKE_CLAUDE, session_adapter: 'fake-claude', claude_extra_args: [] }, null, 2) + '\n');
  for (const m of MODULES) {
    mycelink(['repo', 'register', '--control-root', control, '--name', m, '--path', `../repos/${m}`, '--base-branch', 'main', '--', 'node', '--test']);
  }
  const featureDir = join(control, 'features', FEATURE);
  mkdirSync(featureDir, { recursive: true });
  writeFileSync(join(featureDir, 'PRD.md'), readFileSync(join(control, 'requirements', 'LEDGER-142-partial-refunds.md'), 'utf8'));
  writeFileSync(join(featureDir, 'PORTFOLIO-GRAPH.yaml'), JSON.stringify(graph(), null, 2) + '\n');
  // `mycelink init` does not ignore its scratch area; candidate-build refuses a
  // control repository made dirty by worktrees under .mycelink/.
  writeFileSync(join(control, '.gitignore'), '.mycelink/\n');
  git(control, ['add', '--all']);
  git(control, ['commit', '--quiet', '-m', `${FEATURE}: control plane`], { time: Date.parse('2026-10-01T10:00:00Z') });

  const scenarioFile = join(dirname(ws), 'fake-claude-scenario.json');
  writeFileSync(scenarioFile, JSON.stringify(scenarios(control), null, 2));
  const env = { FAKE_CLAUDE_SCENARIO: scenarioFile };
  mycelink(['graph', 'validate', FEATURE, '--control-root', control, '--json'], { env });
  mycelink(['feature', 'init', FEATURE, '--control-root', control, '--json'], { env });
  const run = mycelink(['orchestrate', 'run', FEATURE, '--control-root', control, '--json', '--max-cycles', '20'], { env, allowFail: true });
  let report;
  try {
    report = JSON.parse(run.stdout);
  } catch {
    throw new Error(`orchestrate run produced no JSON (exit ${run.status})\n${run.stdout}\n${run.stderr}`);
  }
  log(`orchestrate run: ${report.stop_reason}`);
  if (report.stop_reason !== 'ALL_SETTLED') {
    throw new Error(`orchestrate run stopped with ${report.stop_reason}: ${JSON.stringify(report.reports?.filter((r) => r.outcome !== 'DONE'))}`);
  }
  // Delivery: fast-forward each primary checkout to the integration branch.
  for (const m of MODULES) git(join(ws, 'repos', m), ['merge', '--quiet', '--ff-only', `feature/${FEATURE}`]);
  return { control, report };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: node mycelink-fixture.mjs <empty-dir>');
    process.exit(2);
  }
  try {
    const { control, report } = buildOrchestratedWorkspace(resolve(target), { log: console.log });
    console.log(JSON.stringify({ control, stop_reason: report.stop_reason }, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
