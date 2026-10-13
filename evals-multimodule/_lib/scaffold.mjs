#!/usr/bin/env node
/**
 * Build a Ledgerline evaluation workspace. Authored by the Mycelink
 * maintainers; uses only Node.js built-ins and git, never the network.
 *
 *   node _lib/scaffold.mjs <scenario> <empty-target-dir>
 *
 * Scenarios:
 *   greenfield         platform/ holds only the approved MVP PRD (LEDGER-100);
 *                      repos/{core,api,worker,cli} hold a README each.
 *   existing-cold      a working Ledgerline codebase in repos/*, the approved
 *                      refunds PRD (LEDGER-142) in platform/, no architecture
 *                      documentation.
 *   existing-informed  identical to existing-cold plus accurate knowledge
 *                      artifacts: platform/docs/*.md and ./CLAUDE.md.
 *
 * Every repository is created with a fixed identity and fixed timestamps, so
 * baseline commit SHAs are identical on every machine; they are checked
 * against baseline-shas.json and the scaffold fails closed on any drift.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const LIB = dirname(fileURLToPath(import.meta.url));
export const SCENARIOS = ['greenfield', 'existing-cold', 'existing-informed'];
export const MODULES = ['core', 'api', 'worker', 'cli'];
export const CONSUMERS = ['api', 'worker', 'cli'];
export const IDENTITY = { name: 'Ledgerline Engineer', email: 'engineering@ledgerline.invalid' };
const BASE_TIME = Date.parse('2026-09-01T09:00:00Z');

const ROLE = {
  core: 'Shared Ledgerline domain code.',
  api: 'Ledgerline HTTP API.',
  worker: 'Ledgerline background jobs.',
  cli: 'Operator command line for Ledgerline.',
};

// ---------------------------------------------------------------- git ----

let gitGlobalConfig = null;

/** git with no system/global configuration and a fixed identity. */
export function git(cwd, args, { time, allowFail = false } = {}) {
  if (gitGlobalConfig === null) {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-scaffold-gitcfg-'));
    gitGlobalConfig = join(dir, 'gitconfig');
    writeFileSync(gitGlobalConfig, '');
  }
  const stamp = time === undefined ? undefined : `${new Date(time).toISOString().replace('.000Z', 'Z')}`;
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: gitGlobalConfig,
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: IDENTITY.name,
    GIT_AUTHOR_EMAIL: IDENTITY.email,
    GIT_COMMITTER_NAME: IDENTITY.name,
    GIT_COMMITTER_EMAIL: IDENTITY.email,
    ...(stamp ? { GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp } : {}),
  };
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8', windowsHide: true });
  if (r.error) throw new Error(`git ${args.join(' ')}: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd} (exit ${r.status}): ${(r.stderr || r.stdout).trim()}`);
  }
  return { code: r.status, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
}

function initRepo(dir) {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '--quiet', '--initial-branch=main']);
  // Repository-local settings so later commits (by the agent, or Mycelink)
  // behave identically on every platform and have an author.
  git(dir, ['config', 'core.autocrlf', 'false']);
  git(dir, ['config', 'core.safecrlf', 'false']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'user.name', IDENTITY.name]);
  git(dir, ['config', 'user.email', IDENTITY.email]);
}

let clock = 0;
function commitAll(dir, message) {
  clock += 1;
  git(dir, ['add', '--all']);
  git(dir, ['commit', '--quiet', '--no-verify', '-m', message], { time: BASE_TIME + clock * 3_600_000 });
  return git(dir, ['rev-parse', 'HEAD']).stdout;
}

// -------------------------------------------------------------- files ----

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

/** Copy a tree, normalising text to LF so commits hash identically everywhere. */
function copyTree(from, to) {
  for (const rel of listFiles(from)) {
    const target = join(to, ...rel.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(join(from, ...rel.split('/')), 'utf8').replace(/\r\n/g, '\n'));
  }
}

function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text.replace(/\r\n/g, '\n'));
}

function treeSha256(dir) {
  const h = createHash('sha256');
  for (const rel of listFiles(dir)) {
    const text = readFileSync(join(dir, ...rel.split('/')), 'utf8').replace(/\r\n/g, '\n');
    h.update(`${rel}\0${createHash('sha256').update(text).digest('hex')}\n`);
  }
  return h.digest('hex');
}

// ---------------------------------------------------------- workspace ----

function platformReadme(scenario) {
  const lines = [
    '# Ledgerline platform',
    '',
    'Coordination repository for Ledgerline. Approved product requirements live in',
    '`requirements/`; the code lives in the module repositories under `../repos/`.',
  ];
  if (scenario === 'existing-informed') {
    lines.push(
      '',
      'Engineering documentation: `docs/ARCHITECTURE.md`, `docs/MODULES.md`,',
      '`docs/COMMANDS.md` and `docs/CONTRACTS.md`.',
    );
  }
  return lines.join('\n') + '\n';
}

const ACCEPTANCE_README = `# QA acceptance suite

Owned by QA. Do not edit: the runner fingerprints these files.

    node acceptance/run.mjs

Run it from the workspace root. It tests the **committed** HEAD of each module
repository under \`repos/\` (uncommitted changes make the verdict FAIL), runs each
module's own \`node --test\` suite, then the black-box acceptance tests against
the real API, worker and CLI processes. Results are written to
\`acceptance-results/\` (\`SUMMARY.txt\`, \`report.json\`, TAP files).
`;

function buildModules(root, scenario) {
  const shas = {};
  for (const name of MODULES) {
    const dir = join(root, 'repos', name);
    initRepo(dir);
    if (scenario === 'greenfield') {
      writeText(join(dir, 'README.md'), `# ledger-${name}\n\n${ROLE[name]} Nothing here yet — see LEDGER-100.\n`);
      shas[name] = commitAll(dir, 'Initial commit');
      continue;
    }
    copyTree(join(LIB, 'ledgerline', name), dir);
    if (CONSUMERS.includes(name)) {
      // Every service pins the current core release in vendor/.
      const shared = join(LIB, 'ledgerline', '_consumer');
      writeText(join(dir, 'scripts', 'sync-core.mjs'), readFileSync(join(shared, 'sync-core.mjs'), 'utf8'));
      writeText(join(dir, 'test', 'vendor-lock.test.mjs'), readFileSync(join(shared, 'vendor-lock.test.mjs'), 'utf8'));
      const corePkg = JSON.parse(readFileSync(join(LIB, 'ledgerline', 'core', 'package.json'), 'utf8'));
      const vendored = join(dir, 'vendor', 'ledger-core');
      copyTree(join(LIB, 'ledgerline', 'core', 'src'), vendored);
      const lock = { package: corePkg.name, version: corePkg.version, tree_sha256: treeSha256(vendored) };
      writeText(join(dir, 'vendor', 'ledger-core.lock.json'), JSON.stringify(lock, null, 2) + '\n');
    }
    shas[name] = commitAll(dir, `Import ledger-${name}`);
  }
  return shas;
}

function buildPlatform(root, scenario) {
  const dir = join(root, 'platform');
  initRepo(dir);
  writeText(join(dir, 'README.md'), platformReadme(scenario));
  if (scenario === 'greenfield') {
    copyTree(join(LIB, 'docs', 'greenfield'), join(dir, 'requirements'));
  } else {
    copyTree(join(LIB, 'docs', 'existing'), join(dir, 'requirements'));
  }
  if (scenario === 'existing-informed') {
    for (const doc of ['ARCHITECTURE.md', 'MODULES.md', 'COMMANDS.md', 'CONTRACTS.md']) {
      writeText(join(dir, 'docs', doc), readFileSync(join(LIB, 'docs', 'knowledge', doc), 'utf8'));
    }
  }
  return commitAll(dir, scenario === 'greenfield' ? 'LEDGER-100 approved' : 'LEDGER-142 approved');
}

function buildAcceptance(root) {
  const dir = join(root, 'acceptance');
  copyTree(join(LIB, 'acceptance'), dir);
  writeText(join(dir, 'README.md'), ACCEPTANCE_README);
}

function runModuleTests(root) {
  const failures = [];
  for (const name of MODULES) {
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap'], {
      cwd: join(root, 'repos', name),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60_000,
    });
    const fail = /^# fail (\d+)$/m.exec(r.stdout ?? '');
    if (r.status !== 0 || !fail || fail[1] !== '0') failures.push(`${name}: node --test exited ${r.status}`);
  }
  return failures;
}

export function expectedShas() {
  const path = join(LIB, 'baseline-shas.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

/**
 * Build the workspace for `scenario` in `root` (must be empty, or contain
 * nothing but dot-files the harness created). Returns the baseline SHAs.
 */
export function scaffold(root, scenario, { checkShas = true, runTests = true } = {}) {
  if (!SCENARIOS.includes(scenario)) throw new Error(`unknown scenario ${scenario}; expected ${SCENARIOS.join(' | ')}`);
  root = resolve(root);
  mkdirSync(root, { recursive: true });
  const existing = readdirSync(root).filter((n) => !n.startsWith('.'));
  if (existing.length > 0) throw new Error(`refusing to scaffold into a non-empty directory (${existing.join(', ')})`);
  clock = 0;

  const modules = buildModules(root, scenario);
  const platform = buildPlatform(root, scenario);
  buildAcceptance(root);
  if (scenario === 'existing-informed') {
    writeText(join(root, 'CLAUDE.md'), readFileSync(join(LIB, 'docs', 'knowledge', 'CLAUDE.md'), 'utf8'));
  }
  const shas = { platform, ...modules };

  if (checkShas) {
    const expected = expectedShas()?.[scenario];
    if (!expected) throw new Error(`baseline-shas.json has no entry for ${scenario}; run tools/selftest.mjs --write-baseline`);
    const drift = Object.keys({ ...expected, ...shas }).filter((k) => expected[k] !== shas[k]);
    if (drift.length > 0) {
      throw new Error(
        `baseline SHA drift for ${drift.join(', ')} — the fixture changed without regenerating baseline-shas.json, ` +
          `or git produced different objects:\n${JSON.stringify({ expected, actual: shas }, null, 2)}`,
      );
    }
  }
  if (runTests && scenario !== 'greenfield') {
    const failures = runModuleTests(root);
    if (failures.length > 0) throw new Error(`baseline module tests failed: ${failures.join('; ')}`);
  }
  for (const name of [...MODULES.map((m) => join('repos', m)), 'platform']) {
    const status = git(join(root, name), ['status', '--porcelain']).stdout;
    if (status !== '') throw new Error(`${name} is not clean after scaffolding:\n${status}`);
  }
  return shas;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [scenario, target] = process.argv.slice(2);
  if (!scenario || !target) {
    console.error(`usage: node scaffold.mjs <${SCENARIOS.join('|')}> <empty-target-dir>`);
    process.exit(2);
  }
  try {
    const shas = scaffold(target, scenario, { checkShas: !process.argv.includes('--no-sha-check') });
    console.log(JSON.stringify({ scenario, root: resolve(target), shas }, null, 2));
  } catch (error) {
    console.error(`scaffold failed: ${error.message}`);
    process.exit(1);
  }
}
