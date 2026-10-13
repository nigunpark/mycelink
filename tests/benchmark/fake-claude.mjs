#!/usr/bin/env node
/**
 * A stand-in for `claude -p --output-format stream-json` in the arm
 * driver's tests (never a benchmark subject). It reads the prompt on stdin,
 * logs what it was given, and acts out a scripted test-first agent on the
 * toy workspace (repos/toyshop), as directed by the JSON file in
 * $FAKE_CLAUDE_PLAN:
 *
 *   { log, tests, code, regression, stall?, pauseMs?, holdIndexLockMs?, peek?, workerPeek? }
 *
 * (or in the file named by its first argument, when run through the CLI)
 *
 * task:    commit `tests` (then hold the index lock for `holdIndexLockMs`); with `stall`,
 *          wait to be interrupted; else commit `code`
 * resume:  commit `tests` unless already there, then `code`
 * rework:  (QA's report, alone or after the resume header) commit `regression`, then restore
 *          what the reported commit changed, each step only if not done yet; the n-th rework
 *          session waits to be interrupted at `reworkStalls[n]`: 'start' (before anything),
 *          'red' (after the regression test commit) or 'green' (after the fix commit)
 *
 * Probes, for the isolation tests (each result is logged):
 *   probePaths: [path]     what stat() says about each path
 *   readPaths: [path]      whether each file can be read (else the error code)
 *   list: [dir]            each directory's entries (else the error code)
 *   findPlugins: [root]    every `.claude-plugin` directory under each root (system trees skipped)
 *   invokeNode: [[script, ...args]]  each script's exit status under this Node (else the error code)
 *   connect: [host:port]   the status line HTTPS_PROXY answers a CONNECT with
 *   linger: "<seconds>"    start a detached `sleep <seconds>` that tries to outlive the session
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';

// Pipes are asynchronous on macOS and Windows (synchronous on Linux): a stand-in that exits right after its last
// line would drop what was still buffered, cutting its own stream mid-line. Write through, as a real CLI does.
for (const stream of [process.stdout, process.stderr]) stream._handle?.setBlocking?.(true);

// The plan comes from the environment (library tests) or as the first argument (CLI tests,
// whose sessions inherit no test variables).
const planFile = process.env.FAKE_CLAUDE_PLAN ?? process.argv[2];
const given = process.argv.slice(process.env.FAKE_CLAUDE_PLAN ? 2 : 3);
const plan = JSON.parse(readFileSync(planFile, 'utf8'));
const prompt = readFileSync(0, 'utf8');
const repo = join(process.cwd(), 'repos', 'toyshop');
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const probed = {};
for (const path of plan.probePaths ?? []) {
  try {
    statSync(path);
    probed[path] = 'visible';
  } catch (error) {
    probed[path] = error.code;
  }
}
const errorCode = (fn) => {
  try {
    return fn();
  } catch (error) {
    return error.code ?? error.message;
  }
};
const read = Object.fromEntries((plan.readPaths ?? []).map((path) => [path, errorCode(() => readFileSync(path) && 'read')]));
const listed = Object.fromEntries((plan.list ?? []).map((dir) => [dir, errorCode(() => readdirSync(dir).sort())]));
const SYSTEM_TREES = new Set(['/proc', '/sys', '/dev', '/usr', '/etc']);
const plugins = [];
const findPlugins = (dir, depth) => {
  if (SYSTEM_TREES.has(dir) || depth > 8) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = join(dir, e.name);
    if (e.name === '.claude-plugin') plugins.push(full);
    else findPlugins(full, depth + 1);
  }
};
for (const root of plan.findPlugins ?? []) findPlugins(root, 0);
const invoked = (plan.invokeNode ?? []).map((argv) => {
  const r = spawnSync(process.execPath, argv, { encoding: 'utf8' });
  return r.error ? r.error.code : r.status;
});
const connected = {};
for (const target of plan.connect ?? []) {
  const proxy = new URL(process.env.HTTPS_PROXY ?? 'http://127.0.0.1:1');
  connected[target] = await new Promise((done) => {
    const s = net.connect({ host: proxy.hostname, port: Number(proxy.port) });
    let got = '';
    s.on('connect', () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    s.on('data', (d) => {
      got += d;
      if (got.includes('\r\n')) {
        s.destroy();
        done(got.split('\r\n')[0]);
      }
    });
    s.on('error', (e) => done(e.code ?? e.message));
  });
}
if (plan.linger) spawn('/usr/bin/setsid', ['/usr/bin/sleep', plan.linger], { detached: true, stdio: 'ignore' }).unref();
appendFileSync(
  plan.log,
  `${JSON.stringify({ argv: given, prompt_sha256: createHash('sha256').update(prompt).digest('hex'), prompt_head: prompt.slice(0, 40), prompt, home: process.env.HOME, env: Object.keys(process.env).sort(), path: process.env.PATH, probed, read, listed, plugins, invoked, connected })}\n`,
);
emit({ type: 'system', subtype: 'init', cwd: process.cwd() });
// Tool calls that name paths, as a curious agent's would (never executed).
for (const command of plan.peek ?? []) emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } });
if (plan.workerPeek) {
  // A worker's transcript, where Claude Code keeps subagent sessions under the session HOME.
  const dir = join(process.env.HOME, '.claude', 'projects', 'workspace', 'session-1', 'subagents');
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'agent-1.jsonl'), `${JSON.stringify({ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path: plan.workerPeek } }] } })}\n`);
}

function git(args) {
  emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: `git ${args.join(' ')}` } }] } });
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function commit(files, message) {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), body);
  }
  git(['add', '-A']);
  git(['commit', '-q', '-m', message]);
}

function done(text) {
  emit({ type: 'result', subtype: 'success', is_error: false, num_turns: 4, total_cost_usd: 0, result: text });
  process.exit(0);
}

const qa = /QA ran its end-to-end checks on the delivered commit ([0-9a-f]{12})/.exec(prompt);
if (qa) {
  // Which rework session this is (the log already holds this one).
  const reworks = readFileSync(plan.log, 'utf8').split('\n').filter(Boolean).filter((l) => /QA ran its end-to-end checks/.test(JSON.parse(l).prompt));
  const stallAt = (plan.reworkStalls ?? [])[reworks.length - 1] ?? null;
  const stall = async (stage) => {
    if (stallAt === stage) await sleep(600_000);
  };
  await stall('start');
  const defect = git(['rev-parse', qa[1]]);
  const log = () => git(['log', '--format=%s']);
  if (!log().includes('test: regression for the QA report')) commit(plan.regression, 'test: regression for the QA report');
  await stall('red');
  if (!log().includes('fix: restore the behaviour QA reported')) {
    const paths = git(['diff', '--name-only', `${defect}~1`, defect]).split('\n').filter(Boolean);
    git(['checkout', `${defect}~1`, '--', ...paths]);
    git(['commit', '-q', '-m', 'fix: restore the behaviour QA reported']);
  }
  await stall('green');
  done(`Repaired; the tests pass. Delivered ${git(['rev-parse', 'HEAD'])}.`);
} else {
  const resumed = prompt.startsWith('Your previous session');
  if (!git(['log', '--format=%s']).includes('test: failing tests first')) {
    commit(plan.tests, 'test: failing tests first');
    if (plan.holdIndexLockMs) {
      // As if a git command of the agent's still held the index.
      const lock = join(repo, '.git', 'index.lock');
      writeFileSync(lock, '');
      await sleep(plan.holdIndexLockMs);
      rmSync(lock);
    }
  }
  if (plan.stall && !resumed) {
    await sleep(600_000);
  }
  await sleep(plan.pauseMs ?? 0);
  commit(plan.code, 'feat: orders reserve stock');
  done(`Implemented; the tests pass. Delivered ${git(['rev-parse', 'HEAD'])}.`);
}
