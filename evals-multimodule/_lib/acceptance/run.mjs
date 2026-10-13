#!/usr/bin/env node
/**
 * Ledgerline QA acceptance runner.
 *
 *   node acceptance/run.mjs [--workspace <dir>] [--out <dir>]
 *
 * Tests what is *committed*: every module repository (repos/core, repos/api,
 * repos/worker, repos/cli) is exported at its HEAD commit into a temporary
 * snapshot without touching the repository's index or worktree. Then:
 *
 *   1. each module's own test suite runs in its snapshot (`node --test`);
 *   2. the black-box acceptance tests in acceptance/tests/ run against the
 *      snapshot system (real API, worker and CLI processes).
 *
 * Writes to <out> (default <workspace>/acceptance-results/):
 *   report.json        machine-readable result (schema ledgerline-acceptance/1)
 *   acceptance.tap     TAP output of the acceptance tests
 *   modules/<name>.tap TAP output of each module's own tests
 *   SUMMARY.txt        one line per fact, for humans and graders
 *
 * Exit code 0 only when every module is committed and clean, every module
 * suite passes, and every acceptance test passes. Uses Node built-ins and git.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportCommit, pathKey, safeGit, unsafeGitConfig } from './lib/git-safe.mjs';

export const MODULES = ['core', 'api', 'worker', 'cli'];
const MODULE_TIMEOUT_MS = 240_000;
const ACCEPTANCE_TIMEOUT_MS = 600_000;

const suiteDir = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--workspace' || a === '--out') flags[a.slice(2)] = argv[++i];
    else if (a === '--help' || a === '-h') flags.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return flags;
}

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

/** Hash of the suite itself (runner, harness, tests), LF-normalised. */
export function suiteSha256(dir = suiteDir) {
  const h = createHash('sha256');
  for (const rel of listFiles(dir).filter((f) => f.endsWith('.mjs'))) {
    const text = readFileSync(join(dir, rel), 'utf8').replace(/\r\n/g, '\n');
    h.update(`${rel}\0${createHash('sha256').update(text).digest('hex')}\n`);
  }
  return h.digest('hex');
}

function inspectRepo(repo) {
  const info = { path: repo, exists: existsSync(repo), head: null, branch: null, clean: false, dirty: [], problems: [] };
  if (!info.exists) {
    info.problems.push('missing repository directory');
    return info;
  }
  const unsafe = unsafeGitConfig(repo);
  if (unsafe.length > 0) {
    info.problems.push(`unsafe git configuration, refusing to run git there: ${unsafe.join(', ')}`);
    return info;
  }
  const top = safeGit(repo, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0 || pathKey(top.stdout) !== pathKey(repo)) {
    info.problems.push('not the root of a git repository');
    return info;
  }
  const head = safeGit(repo, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  if (head.code !== 0) {
    info.problems.push('no commits');
    return info;
  }
  info.head = head.stdout;
  const branch = safeGit(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  info.branch = branch.code === 0 ? branch.stdout : null;
  const status = safeGit(repo, ['status', '--porcelain=v1', '--untracked-files=all']);
  info.dirty = status.stdout.split('\n').filter((l) => l.trim() !== '');
  info.clean = status.code === 0 && info.dirty.length === 0;
  if (!info.clean) info.problems.push(`uncommitted changes (${info.dirty.length} paths)`);
  return info;
}

function runNodeTests(args, cwd, env, timeoutMs) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolvePromise({ code: -1, stdout, stderr: stderr + String(error), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? -1, stdout, stderr, timedOut });
    });
  });
}

function tapSummary(tap) {
  const num = (name) => {
    const m = new RegExp(`^# ${name} (\\d+)$`, 'm').exec(tap);
    return m ? Number(m[1]) : null;
  };
  const cases = [];
  for (const m of tap.matchAll(/^(not ok|ok) \d+ - (.+?)(?: # (SKIP|TODO).*)?$/gm)) {
    // Only top-level results (no indentation) are test files' tests.
    cases.push({ name: m[2], ok: m[1] === 'ok', directive: m[3] ?? null });
  }
  return { tests: num('tests'), pass: num('pass'), fail: num('fail'), cancelled: num('cancelled'), skipped: num('skipped'), todo: num('todo'), cases };
}

export async function runAcceptance({ workspace, out }) {
  const startedAt = new Date().toISOString();
  const failures = [];
  const report = {
    schema: 'ledgerline-acceptance/1',
    suite_sha256: suiteSha256(),
    started_at: startedAt,
    finished_at: null,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    workspace,
    ok: false,
    verdict: 'FAIL',
    modules: {},
    acceptance: null,
    failures,
  };

  mkdirSync(join(out, 'modules'), { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), 'ledger-acceptance-'));
  const system = join(scratch, 'system');
  try {
    for (const name of MODULES) {
      const info = inspectRepo(join(workspace, 'repos', name));
      report.modules[name] = { ...info, tests: null };
      for (const p of info.problems) failures.push(`module ${name}: ${p}`);
      if (info.head) exportCommit(info.path, info.head, join(system, name));
    }

    for (const name of MODULES) {
      const mod = report.modules[name];
      if (!mod.head) continue;
      const result = await runNodeTests(['--test', '--test-reporter=tap'], join(system, name), {}, MODULE_TIMEOUT_MS);
      writeFileSync(join(out, 'modules', `${name}.tap`), result.stdout + (result.stderr ? `\n# stderr:\n${result.stderr.replace(/^/gm, '# ')}` : ''));
      const summary = tapSummary(result.stdout);
      mod.tests = { exit_code: result.code, timed_out: result.timedOut, tests: summary.tests, pass: summary.pass, fail: summary.fail };
      if (result.code !== 0) failures.push(`module ${name}: own tests exited ${result.code}${result.timedOut ? ' (timeout)' : ''}`);
      else if (!summary.pass) failures.push(`module ${name}: has no passing tests of its own`);
    }

    const testsDir = join(suiteDir, 'tests');
    const testFiles = readdirSync(testsDir).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => join(testsDir, f));
    if (MODULES.every((m) => report.modules[m].head)) {
      const result = await runNodeTests(
        ['--test', '--test-reporter=tap', '--test-concurrency=1', ...testFiles],
        suiteDir,
        { ACCEPTANCE_SYSTEM_DIR: system },
        ACCEPTANCE_TIMEOUT_MS,
      );
      writeFileSync(join(out, 'acceptance.tap'), result.stdout + (result.stderr ? `\n# stderr:\n${result.stderr.replace(/^/gm, '# ')}` : ''));
      const summary = tapSummary(result.stdout);
      report.acceptance = { exit_code: result.code, timed_out: result.timedOut, ...summary };
      if (result.code !== 0 || summary.fail !== 0 || !summary.pass) {
        failures.push(`acceptance: ${summary.fail ?? '?'} failing of ${summary.tests ?? '?'}${result.timedOut ? ' (timeout)' : ''}`);
      }
      if ((summary.skipped ?? 0) + (summary.todo ?? 0) + (summary.cancelled ?? 0) > 0) failures.push('acceptance: skipped/todo/cancelled tests');
    } else {
      writeFileSync(join(out, 'acceptance.tap'), 'Bail out! a module repository has no commit to test\n');
      failures.push('acceptance: not run (a module repository has no commit)');
    }
  } catch (error) {
    failures.push(`runner error: ${error?.stack ?? error}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }

  report.ok = failures.length === 0;
  report.verdict = report.ok ? 'PASS' : 'FAIL';
  report.finished_at = new Date().toISOString();
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');

  const lines = [`ACCEPTANCE VERDICT: ${report.verdict}`, `suite_sha256: ${report.suite_sha256}`];
  for (const name of MODULES) {
    const m = report.modules[name];
    const t = m.tests;
    const tests = t ? `${t.exit_code === 0 && t.pass ? 'pass' : 'fail'}(${t.pass ?? 0}/${t.tests ?? 0})` : 'not-run';
    lines.push(`module ${name}: head=${m.head ?? 'none'} branch=${m.branch ?? '(detached)'} clean=${m.clean ? 'yes' : 'no'} tests=${tests}`);
  }
  const a = report.acceptance;
  lines.push(a ? `acceptance: tests=${a.tests} pass=${a.pass} fail=${a.fail}` : 'acceptance: not-run');
  for (const f of failures) lines.push(`failure: ${f.split('\n')[0]}`);
  writeFileSync(join(out, 'SUMMARY.txt'), lines.join('\n') + '\n');
  return report;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log('usage: node acceptance/run.mjs [--workspace <dir>] [--out <dir>]');
    return 0;
  }
  const workspace = resolve(flags.workspace ?? join(suiteDir, '..'));
  const out = resolve(flags.out ?? join(workspace, 'acceptance-results'));
  const report = await runAcceptance({ workspace, out });
  console.log(readFileSync(join(out, 'SUMMARY.txt'), 'utf8').trimEnd());
  console.log(`report: ${join(out, 'report.json')}`);
  return report.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => (process.exitCode = code),
    (error) => {
      console.error(error?.stack ?? error);
      process.exitCode = 2;
    },
  );
}
