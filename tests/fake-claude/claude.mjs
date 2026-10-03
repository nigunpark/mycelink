#!/usr/bin/env node
/**
 * Fake `claude` executable.
 *
 * Stands in for Claude Code in the automated suite so no test ever incurs
 * model usage. It accepts the same argv shape the real CLI accepts in print
 * mode, emits the same `--output-format stream-json` NDJSON envelope, honours
 * the same worker protocol environment variables, and can reproduce every
 * worker outcome the controller must handle: done, failed, blocked,
 * needs-decision, budget-exhausted, stall, crash and a silent exit with no
 * result file.
 *
 * Behaviour is driven by a scenario file (env FAKE_CLAUDE_SCENARIO), keyed by
 * node id, so tests stay deterministic and declarative.
 */
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);

function flag(name) {
  const i = argv.indexOf(name);
  return i === -1 ? null : (argv[i + 1] ?? null);
}
function has(name) {
  return argv.includes(name);
}

const sessionId = flag('--session-id') ?? randomUUID();
const streamJson = flag('--output-format') === 'stream-json';
const model = flag('--model') ?? 'fake-sonnet';

const contextPackPath = process.env.MYCELINK_CONTEXT_PACK ?? null;
const resultPath = process.env.MYCELINK_RESULT_PATH ?? null;
const nodeId = process.env.MYCELINK_NODE_ID ?? 'unknown-node';
const claimId = process.env.MYCELINK_CLAIM_ID ?? 'unknown-claim';
const scenarioPath = process.env.FAKE_CLAUDE_SCENARIO ?? null;

function emit(obj) {
  if (streamJson) process.stdout.write(JSON.stringify(obj) + '\n');
}

function sleepSync(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function loadScenario() {
  const fallback = { outcome: 'done', turns: 2 };
  if (!scenarioPath) return fallback;
  let doc;
  try {
    doc = JSON.parse(readFileSync(scenarioPath, 'utf8'));
  } catch {
    return fallback;
  }
  const byNode = doc.nodes ?? {};
  const base = doc.default ?? fallback;
  const entry = byNode[nodeId] ?? base;
  // An attempt-indexed scenario lets a test make the first attempt fail and
  // the second succeed, exercising retry without a new scenario file.
  if (Array.isArray(entry)) {
    const attempt = Number(process.env.MYCELINK_ATTEMPT ?? '1');
    return entry[Math.min(attempt - 1, entry.length - 1)] ?? fallback;
  }
  return entry;
}

const scenario = loadScenario();

emit({
  type: 'system',
  subtype: 'init',
  session_id: sessionId,
  model,
  cwd: process.cwd(),
  tools: [],
});

// Echo selected environment values, the way a careless tool or test runner
// might, so the suite can prove they never reach a session log.
for (const name of scenario.print_env ?? []) {
  const value = process.env[name] ?? '';
  emit({ type: 'system', subtype: 'debug', text: `${name}=${value}` });
  process.stderr.write(`env ${name}=${value}\n`);
}

if (scenario.stall_ms) {
  // Produce no further output: the controller must detect the lack of progress.
  sleepSync(scenario.stall_ms);
  process.exit(scenario.exit_code ?? 0);
}

const turns = scenario.turns ?? 2;
for (let i = 0; i < turns; i++) {
  sleepSync(scenario.turn_delay_ms ?? 0);
  emit({
    type: 'assistant',
    session_id: sessionId,
    message: {
      role: 'assistant',
      model,
      content: [{ type: 'text', text: `fake turn ${i + 1} for ${nodeId}` }],
      usage: { input_tokens: 100, output_tokens: 50 },
    },
  });
}

if (scenario.crash) {
  process.stderr.write(`fake-claude: simulated crash for ${nodeId}\n`);
  process.exit(scenario.exit_code ?? 9);
}

// Apply the scenario's work inside the worktree, so a real git diff and real
// command exit codes follow from what the "worker" did.
const cwd = process.cwd();
const commands = [];
const changedPaths = [];

function applyWriteFiles(files) {
  for (const [rel, content] of Object.entries(files ?? {})) {
    const full = join(cwd, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
    if (!changedPaths.includes(rel)) changedPaths.push(rel);
  }
}

function applyAppendFiles(files) {
  for (const [rel, content] of Object.entries(files ?? {})) {
    const full = join(cwd, rel);
    mkdirSync(dirname(full), { recursive: true });
    appendFileSync(full, content, 'utf8');
    if (!changedPaths.includes(rel)) changedPaths.push(rel);
  }
}

function applyRun(command) {
  let exitCode = 0;
  try {
    execFileSync(command[0], command.slice(1), { cwd, stdio: 'ignore' });
  } catch (err) {
    exitCode = typeof err.status === 'number' ? err.status : 1;
  }
  commands.push({ command, exit_code: exitCode, cwd });
  return exitCode;
}

function applyCommit(message) {
  try {
    execFileSync('git', ['add', '-A'], { cwd, stdio: 'ignore' });
    execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message], {
      cwd,
      stdio: 'ignore',
    });
  } catch {
    // Nothing staged; leave the tree as-is.
  }
}

// `steps` lets a scenario interleave edits, commits and controller calls in the
// order a real TDD worker would: write the failing test, record RED, implement,
// record GREEN, record regression.
let abortedStep = null;

if (Array.isArray(scenario.steps)) {
  for (const step of scenario.steps) {
    if (step.write_files) applyWriteFiles(step.write_files);
    if (step.append_files) applyAppendFiles(step.append_files);
    if (step.git_commit) applyCommit(step.git_commit);
    if (step.run) {
      const code = applyRun(step.run);
      if (step.expect_exit !== undefined && code !== step.expect_exit) {
        // A real worker reports the command and its exit code rather than
        // dying silently, so the controller gets a usable fingerprint.
        abortedStep = {
          label: step.label ?? step.run.slice(0, 5).join(' '),
          expected: step.expect_exit,
          actual: code,
        };
        process.stderr.write(
          `fake-claude: step "${abortedStep.label}" expected exit ${step.expect_exit} but got ${code}\n`,
        );
        break;
      }
    }
  }
} else {
  applyWriteFiles(scenario.write_files);
  applyAppendFiles(scenario.append_files);
  for (const command of scenario.run_commands ?? []) applyRun(command);
  if (scenario.git_commit) applyCommit(scenario.git_commit);
}

let commitSha = null;
try {
  commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
} catch {
  commitSha = null;
}

const outcome = abortedStep ? 'RETRYABLE' : (scenario.outcome ?? 'SUBMITTED');
const abortFingerprint = abortedStep
  ? `step-failed:${abortedStep.label}:expected-${abortedStep.expected}:got-${abortedStep.actual}`
  : null;

if (resultPath && !scenario.omit_result) {
  const result = {
    schema_version: 1,
    node_id: nodeId,
    claim_id: claimId,
    outcome,
    commands: scenario.commands ?? commands,
    commit_sha: scenario.commit_sha ?? commitSha,
    branch: process.env.MYCELINK_BRANCH ?? null,
    changed_paths: changedPaths,
    evidence_paths: scenario.evidence_paths ?? [],
    failure_fingerprint: abortFingerprint ?? scenario.failure_fingerprint ?? null,
    decision_request: scenario.decision_request ?? null,
    usage: {
      model_turns: turns,
      wall_clock_ms: scenario.wall_clock_ms ?? 10,
      input_tokens: 100 * turns,
      output_tokens: 50 * turns,
    },
    ...(scenario.notes ? { notes: scenario.notes } : {}),
  };
  mkdirSync(dirname(resolve(resultPath)), { recursive: true });
  writeFileSync(resolve(resultPath), JSON.stringify(result, null, 2), 'utf8');
}

if (contextPackPath) {
  // Prove the worker actually consumed its bounded pack rather than a transcript.
  try {
    JSON.parse(readFileSync(contextPackPath, 'utf8'));
  } catch {
    process.stderr.write('fake-claude: context pack unreadable\n');
  }
}

emit({
  type: 'result',
  subtype: scenario.result_subtype ?? 'success',
  session_id: sessionId,
  is_error: Boolean(scenario.is_error),
  num_turns: turns,
  duration_ms: scenario.wall_clock_ms ?? 10,
  usage: { input_tokens: 100 * turns, output_tokens: 50 * turns },
  result: `fake worker finished ${nodeId} with ${outcome}`,
});

if (has('--bg') || has('--background')) {
  process.stdout.write(`${sessionId}\n`);
}

process.exit(scenario.exit_code ?? 0);
