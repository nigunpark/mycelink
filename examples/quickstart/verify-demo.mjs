#!/usr/bin/env node
/**
 * Model-free checks that the quickstart still works and still says what it
 * does. Run by the repository's release tests (tests/release/quickstart.test.ts).
 *
 *   node examples/quickstart/verify-demo.mjs [--json] [--mycelink <bin/mycelink.mjs>]
 *
 * Builds a throwaway workspace with setup's own code, then checks: the
 * three repositories are separate; the baselines are the published SHAs,
 * carry only a local identity and pass their tests; the feature is not
 * already solved; the graph validates, matches the modules and the PRD's
 * acceptance manifest byte for byte, and initialises with only the API node
 * READY; setup refuses what it must; the documented commands exist; and the
 * shipped files name no machine and no secret. Removes everything it made.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  API_NODE,
  BASELINE_SHAS,
  CHECKOUT_LAUNCHER,
  FEATURE_ID,
  HERE,
  MARKER,
  REPOS,
  TEMPLATES,
  WEB_NODE,
  createWorkspace,
  git,
  mycelinkArgv,
  run,
  templateFiles,
} from './lib/quickstart.mjs';

const json = process.argv.includes('--json');
const launcherAt = process.argv.indexOf('--mycelink');
const launcher = launcherAt === -1 ? CHECKOUT_LAUNCHER : process.argv[launcherAt + 1];

const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, ...(typeof detail === 'string' ? { detail } : {}) });
  } catch (err) {
    results.push({ name, ok: false, detail: String(err?.message ?? err) });
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
const read = (...parts) => readFileSync(join(HERE, ...parts), 'utf8');
const cli = (args, cwd) => run(mycelinkArgv(launcher, args), { cwd });

/** `dir/**` globs of a node in the graph text, by node id. */
function allowedPaths(graphText, nodeId) {
  const block = graphText.split(/\n  - id: /).find((b) => b.startsWith(nodeId));
  const m = block && /allowed_paths: \[([^\]]*)\]/.exec(block);
  return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
}
const inside = (path, globs) => globs.some((g) => g.endsWith('/**') && path.startsWith(g.slice(0, -2)));

// ---- the shipped files ----------------------------------------------------------

const graphText = read('control', 'features', FEATURE_ID, 'PORTFOLIO-GRAPH.yaml');
const nodes = { api: API_NODE, web: WEB_NODE };

check('shipped files name no machine path, personal address or secret', () => {
  const offenders = [];
  const patterns = [/(?<![A-Za-z])[A-Za-z]:[\\/](?![\\/])/, /\/home\/[a-z]/, /(?<![A-Za-z])\/Users\/[A-Za-z]/, /[A-Za-z0-9._%+-]+@(?!example\.invalid\b)[A-Za-z0-9-]+\.[A-Za-z]{2,}/, /\bgh[pousr]_[A-Za-z0-9]{20,}|\bsk-ant-[A-Za-z0-9_-]{8,}|\bAKIA[0-9A-Z]{16}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/];
  for (const rel of templateFiles(HERE)) {
    const text = read(...rel.split('/'));
    for (const p of patterns) if (p.test(text)) offenders.push(`${rel}: ${p.exec(text)[0]}`);
  }
  assert(offenders.length === 0, offenders.join('; '));
  return `${templateFiles(HERE).length} files`;
});

check('the baselines do not already hold the feature', () => {
  for (const name of Object.keys(REPOS)) {
    for (const rel of templateFiles(TEMPLATES[name])) {
      const text = readFileSync(join(TEMPLATES[name], ...rel.split('/')), 'utf8');
      assert(!/delayed|\beta\b|version: 2|CONTRACT_VERSION = 2/.test(text), `${REPOS[name]}/${rel} mentions the ORD-101 behaviour`);
    }
  }
});

check('each node owns its module: every baseline module file is inside its allowed_paths', () => {
  for (const [name, node] of Object.entries(nodes)) {
    const globs = allowedPaths(graphText, node);
    assert(globs.length > 0, `${node} declares no allowed_paths`);
    const moduleFiles = templateFiles(TEMPLATES[name]).filter((f) => f.includes('/'));
    assert(moduleFiles.length > 0, `${REPOS[name]} has no module files`);
    for (const f of moduleFiles) assert(inside(f, globs), `${REPOS[name]}/${f} is outside ${node}'s allowed_paths ${globs.join(', ')}`);
  }
});

check('every file the scripted workers write is inside their node\'s allowed_paths', () => {
  for (const [name, node] of Object.entries(nodes)) {
    const globs = allowedPaths(graphText, node);
    for (const rel of templateFiles(join(HERE, 'scripted', name))) {
      const path = rel.split('/').slice(1).join('/');
      assert(inside(path, globs), `scripted/${name}/${rel} is outside ${node}'s allowed_paths`);
    }
  }
});

// ---- a fresh workspace ------------------------------------------------------------

const scratch = mkdtempSync(join(tmpdir(), 'mlqs-verify-'));
try {
  let ws = null;
  check('setup creates the workspace', () => {
    ws = createWorkspace({ out: join(scratch, 'ws'), launcher });
    return ws.cliVersion;
  });
  if (ws !== null) {
    const dirs = { ...ws.repos, control: ws.control };

    check('three independent Git repositories: own .git, no remote, no submodule, no alternates', () => {
      const commonDirs = new Set();
      for (const [name, dir] of Object.entries(dirs)) {
        const real = (p) => realpathSync.native(p);
        assert(real(git(dir, ['rev-parse', '--show-toplevel'])) === real(dir), `${name} is not its own work tree`);
        const common = real(resolve(dir, git(dir, ['rev-parse', '--git-common-dir'])));
        assert(common === real(join(dir, '.git')), `${name}'s Git directory is ${common}`);
        commonDirs.add(common);
        assert(git(dir, ['remote']) === '', `${name} has a remote`);
        assert(!existsSync(join(dir, '.gitmodules')), `${name} has submodules`);
        assert(!existsSync(join(dir, '.git', 'objects', 'info', 'alternates')), `${name} borrows objects`);
      }
      assert(commonDirs.size === 3, 'repositories share a Git directory');
    });

    check('the baselines are the published SHAs, one commit each', () => {
      for (const name of Object.keys(REPOS)) {
        assert(ws.baseline[name] === BASELINE_SHAS[name], `${REPOS[name]} main is ${ws.baseline[name]}, published ${BASELINE_SHAS[name]}`);
        assert(git(ws.repos[name], ['rev-list', '--count', 'HEAD']) === '1', `${REPOS[name]} has more than one commit`);
      }
      return `${BASELINE_SHAS.api.slice(0, 12)} ${BASELINE_SHAS.web.slice(0, 12)}`;
    });

    check('setup wrote only a local identity into Git configuration', () => {
      for (const [name, dir] of Object.entries(dirs)) {
        const keys = git(dir, ['config', '--local', '--list', '--name-only']).split('\n').filter((k) => k !== '' && !k.startsWith('core.'));
        assert(JSON.stringify(keys.sort()) === JSON.stringify(['user.email', 'user.name']), `${name} local config: ${keys.join(', ')}`);
      }
    });

    check('both baselines pass their own tests', () => {
      const counts = [];
      for (const name of Object.keys(REPOS)) {
        const r = run([process.execPath, '--test', '--test-reporter=spec'], { cwd: ws.repos[name] });
        assert(r.code === 0, `${REPOS[name]}: node --test exited ${r.code}\n${r.stdout}`);
        counts.push(`${REPOS[name]} ${/^ℹ pass (\d+)/m.exec(r.stdout)?.[1]} passed`);
      }
      return counts.join(', ');
    });

    check('the acceptance probe fails every criterion on the baselines', () => {
      const r = run([process.execPath, join(HERE, 'acceptance', 'probe.mjs'), ws.repos.api, ws.repos.web, '--json']);
      const out = JSON.parse(r.stdout);
      assert(r.code === 1 && out.passed === 0, `probe: ${out.passed}/${out.total} pass on the baselines`);
      return '0/4';
    });

    check('the control repository is committed and clean, with no controller key opened', () => {
      assert(git(ws.control, ['status', '--porcelain']) === '', 'uncommitted files in control');
      assert(!existsSync(join(ws.control, '.mycelink', 'controller-authority.json')), 'a controller key exists');
      const claude = readFileSync(join(ws.control, 'CLAUDE.md'), 'utf8');
      assert(claude.includes('## This quickstart'), 'CLAUDE.md lacks the quickstart note');
    });

    check('graph validate, repo audit and doctor pass', () => {
      for (const args of [['graph', 'validate', FEATURE_ID], ['repo', 'audit'], ['doctor']]) {
        const r = cli([...args, '--control-root', ws.control], ws.root);
        assert(r.code === 0, `mycelink ${args.join(' ')} exited ${r.code}\n${r.stdout}${r.stderr}`);
      }
    });

    check('each node verifies with its module\'s verifier, module_sha256 included', () => {
      const modules = JSON.parse(cli(['repo', 'modules', '--control-root', ws.control, '--json'], ws.root).stdout);
      for (const repo of modules.repositories) {
        for (const m of repo.modules) {
          assert(graphText.includes(`module_sha256: ${m.verifier.module_sha256}`), `the graph does not bind module ${repo.name}:${m.id} at ${m.verifier.module_sha256}`);
          assert(graphText.includes(`id: ${m.verifier.id}`), `the graph lacks verifier ${m.verifier.id}`);
        }
      }
    });

    let key = null;
    check('ACCEPTANCE.json is exactly what mycelink cuts from the PRD', () => {
      key = JSON.parse(cli(['controller', 'open', '--control-root', ws.control, '--json'], ws.root).stdout).authority;
      const file = join(ws.control, 'features', FEATURE_ID, 'ACCEPTANCE.json');
      const shipped = readFileSync(file);
      rmSync(file);
      const r = cli(['feature', 'acceptance', FEATURE_ID, '--source', `features/${FEATURE_ID}/PRD.md`, '--control-root', ws.control, '--authority', key], ws.root);
      assert(r.code === 0, `feature acceptance exited ${r.code}: ${r.stderr}`);
      assert(readFileSync(file).equals(shipped), 'regenerated ACCEPTANCE.json differs from the shipped one');
      return JSON.parse(shipped.toString('utf8')).criteria.map((c) => c.id).join(' ');
    });

    check('feature init succeeds and only the API node is READY', () => {
      assert(key !== null, 'no controller key');
      const init = cli(['feature', 'init', FEATURE_ID, '--control-root', ws.control, '--authority', key], ws.root);
      assert(init.code === 0, `feature init exited ${init.code}: ${init.stderr}`);
      const loops = cli(['loop', 'validate', FEATURE_ID, '--control-root', ws.control], ws.root);
      assert(loops.code === 0, `loop validate exited ${loops.code}: ${loops.stdout}${loops.stderr}`);
      const ready = JSON.parse(cli(['orchestrate', 'ready', FEATURE_ID, '--control-root', ws.control, '--json'], ws.root).stdout);
      const ids = ready.scheduled.map((s) => s.node_id);
      assert(JSON.stringify(ids) === JSON.stringify([API_NODE]), `READY: ${ids.join(', ')}`);
      return `READY ${ids.join(', ')}`;
    });
  }

  // ---- setup.mjs's refusals -----------------------------------------------------
  const setup = (args) => run([process.execPath, join(HERE, 'setup.mjs'), '--mycelink', launcher, ...args]);
  check('setup refuses a non-empty directory it did not create, even with --force', () => {
    const foreign = join(scratch, 'foreign');
    mkdirSync(foreign);
    writeFileSync(join(foreign, 'notes.txt'), 'keep me\n');
    const r = setup(['--out', foreign, '--force']);
    assert(r.code === 1 && /was not created by the quickstart/.test(r.stderr), `exit ${r.code}: ${r.stderr}`);
    assert(readFileSync(join(foreign, 'notes.txt'), 'utf8') === 'keep me\n', 'the foreign file changed');
  });
  check('setup refuses its own earlier workspace without --force, and recreates it with --force', () => {
    const again = join(scratch, 'again');
    assert(setup(['--out', again]).code === 0, 'first setup failed');
    const second = setup(['--out', again]);
    assert(second.code === 1 && /--force/.test(second.stderr), `exit ${second.code}: ${second.stderr}`);
    const forced = setup(['--out', again, '--force']);
    assert(forced.code === 0, `--force exited ${forced.code}: ${forced.stderr}`);
    assert(existsSync(join(again, MARKER)), 'no marker after --force');
    for (const name of Object.keys(REPOS)) assert(git(join(again, REPOS[name]), ['rev-parse', 'HEAD']) === BASELINE_SHAS[name], `${REPOS[name]} SHA changed`);
  });
  check('setup refuses an output directory inside a Git work tree', () => {
    const host = join(scratch, 'host-repo');
    mkdirSync(host);
    git(host, ['init', '-q']);
    const r = setup(['--out', join(host, 'demo')]);
    assert(r.code === 1 && /inside the Git work tree/.test(r.stderr), `exit ${r.code}: ${r.stderr}`);
    assert(!existsSync(join(host, 'demo')), 'setup created the directory anyway');
  });
} finally {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
}

// ---- the documentation ------------------------------------------------------------

check('every command the README and RECORDING document exists', () => {
  const docs = `${read('README.md')}\n${read('RECORDING.md')}`;
  const scripts = [...docs.matchAll(/node examples\/quickstart\/([\w/.-]+\.mjs)/g)].map((m) => m[1]);
  assert(scripts.length >= 4, 'the docs name too few scripts');
  for (const s of new Set(scripts)) assert(existsSync(join(HERE, ...s.split('/'))), `examples/quickstart/${s} does not exist`);
  const usage = cli(['--help']).stdout;
  for (const m of docs.matchAll(/node bin\/mycelink\.mjs ([a-z]+) ([a-z-]+)/g)) {
    assert(new RegExp(`^  ${m[1]}\\b[^\\n]*\\b${m[2]}\\b`, 'm').test(usage), `mycelink ${m[1]} ${m[2]} is not in mycelink --help`);
  }
  for (const m of docs.matchAll(/\/mycelink:([a-z]+)/g)) assert(existsSync(join(HERE, '..', '..', 'commands', `${m[1]}.md`)), `/mycelink:${m[1]} is not a plugin command`);
  const setupHelp = run([process.execPath, join(HERE, 'setup.mjs'), '--help']).stdout;
  for (const flag of new Set([...read('README.md').matchAll(/setup\.mjs[^\n`]*/g)].flatMap((m) => m[0].match(/--[a-z]+/g) ?? []))) assert(setupHelp.includes(flag), `setup.mjs --help does not document ${flag}`);
  for (const [name, sha] of Object.entries(BASELINE_SHAS)) assert(read('README.md').includes(sha.slice(0, 12)), `README does not state the ${name} baseline SHA ${sha.slice(0, 12)}`);
});

check('SAMPLE-OUTPUT.md is labelled as a scripted walkthrough and matches the baselines', () => {
  const sample = read('SAMPLE-OUTPUT.md');
  assert(/This is \*\*not\*\* a model run/.test(sample), 'the sample is not labelled as scripted');
  assert(sample.includes('Source: `node examples/quickstart/walkthrough.mjs`'), 'the sample names no source');
  for (const sha of Object.values(BASELINE_SHAS)) assert(sample.includes(sha.slice(0, 12)), `the sample does not start from baseline ${sha.slice(0, 12)}`);
  assert(/0 model calls/.test(sample), 'the sample does not say it made no model calls');
});

const failed = results.filter((r) => !r.ok);
if (json) process.stdout.write(JSON.stringify({ ok: failed.length === 0, results }, null, 2) + '\n');
else {
  for (const r of results) process.stdout.write(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.detail ? `${r.ok ? ' — ' : '\n     '}${r.detail}` : ''}\n`);
  process.stdout.write(`${results.length - failed.length}/${results.length} checks passed\n`);
}
process.exitCode = failed.length === 0 ? 0 : 1;
