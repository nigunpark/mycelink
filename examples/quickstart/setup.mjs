#!/usr/bin/env node
/**
 * Create the Mycelink quickstart workspace.
 *
 *   node examples/quickstart/setup.mjs --out <dir> [--mycelink <plugin>/bin/mycelink.mjs] [--force]
 *
 * <dir>/orders-api   Git repository: the API (publishes order-status payloads)
 * <dir>/orders-web   Git repository: the web client (renders them)
 * <dir>/control      Git repository: Mycelink's control repository with the
 *                    approved ORD-101 PRD, acceptance manifest and graph
 *
 * Refuses a non-empty <dir> unless an earlier run of this script made it and
 * --force is given, and refuses a <dir> inside any Git work tree. Writes no
 * global Git configuration, opens no controller key, starts no model, and
 * uses no network.
 */
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CHECKOUT_LAUNCHER, FEATURE_ID, HERE, QuickstartError, REPOS, createWorkspace, run } from './lib/quickstart.mjs';

const USAGE = `Usage: node examples/quickstart/setup.mjs --out <dir> [--mycelink <path to bin/mycelink.mjs>] [--force]

  --out <dir>        where to create orders-api/, orders-web/ and control/ (default: <temp>/mycelink-quickstart)
  --mycelink <path>  the Mycelink launcher whose hooks the control repository uses
                     (default: this checkout's bin/mycelink.mjs)
  --force            replace a directory an earlier run of this script created`;

function parse(argv) {
  const opts = { out: join(tmpdir(), 'mycelink-quickstart'), mycelink: CHECKOUT_LAUNCHER, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--force') opts.force = true;
    else if (a === '--out' || a === '--mycelink') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new QuickstartError(`${a} needs a value.\n\n${USAGE}`);
      opts[a.slice(2)] = v;
    } else throw new QuickstartError(`Unknown argument ${JSON.stringify(a)}.\n\n${USAGE}`);
  }
  return opts;
}

function baselineTests(dir) {
  const r = run([process.execPath, '--test', '--test-reporter=spec'], { cwd: dir });
  const pass = /^ℹ pass (\d+)/m.exec(r.stdout)?.[1] ?? '?';
  const fail = /^ℹ fail (\d+)/m.exec(r.stdout)?.[1] ?? '?';
  return { code: r.code, pass, fail, out: `${r.stdout}${r.stderr}` };
}

function main() {
  const opts = parse(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const started = Date.now();
  const ws = createWorkspace({ out: opts.out, launcher: opts.mycelink, force: opts.force, log: (m) => process.stdout.write(`  ${m}\n`) });
  for (const [name, dir] of Object.entries(ws.repos)) {
    const t = baselineTests(dir);
    if (t.code !== 0) throw new QuickstartError(`the ${REPOS[name]} baseline tests failed:\n${t.out}`);
    process.stdout.write(`  ${REPOS[name]} baseline tests: ${t.pass} passed, ${t.fail} failed\n`);
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const pluginDir = resolve(ws.launcher, '..', '..');
  const rel = (p) => relative(process.cwd(), p) || '.';
  process.stdout.write(
    [
      '',
      `Quickstart workspace ready in ${seconds}s (${ws.cliVersion}): ${ws.root}`,
      `  api      ${ws.repos.api}  main ${ws.baseline.api}`,
      `  web      ${ws.repos.web}  main ${ws.baseline.web}`,
      `  control  ${ws.control}  main ${ws.controlSha}`,
      '',
      'Next, run the feature with Claude Code (this uses your model quota):',
      `  cd "${ws.control}"`,
      `  claude --plugin-dir "${pluginDir}"`,
      `  > /mycelink:run ${FEATURE_ID}`,
      '',
      'Or watch the scripted, model-free walkthrough of the same feature:',
      `  node "${rel(join(HERE, 'walkthrough.mjs'))}"`,
      '',
    ].join('\n'),
  );
  return 0;
}

try {
  process.exitCode = main();
} catch (err) {
  process.stderr.write(`setup: ${err instanceof QuickstartError ? err.message : err.stack ?? err}\n`);
  process.exitCode = 1;
}
