/**
 * `node --test` adapter: tiny projects with Node's built-in test runner. It
 * powers the CI-safe tests of the harness itself (no toolchain cache).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, mkdtempSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { parseJUnit } from '../results.mjs';
import { placeholders, runCommand } from '../run.mjs';
import { sandboxEnv } from './index.mjs';

function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === 'node_modules' || name === '.git') continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(root, full).split('\\').join('/'));
    }
  };
  walk(root);
  return out;
}

export function nodeTestAdapter(base) {
  return {
    ...base,
    async runTests({ tree, tests, ctx, label }) {
      const files = tests === null || tests === undefined
        ? listFiles(tree).filter((f) => base.isTestPath(f) && /\.test\.(mjs|cjs|js)$/.test(f))
        : [...new Set(tests.map((t) => t.file))];
      const scratch = join(ctx.workRoot, `${label}.scratch`);
      const home = join(scratch, 'home');
      // A temp root on another file system (qualification) still hashes as <tmp>.
      const tmp = ctx.tmpRoot ? mkdtempSync(join(ctx.tmpRoot, 'bench-tmp-')) : join(scratch, 'tmp');
      mkdirSync(home, { recursive: true });
      mkdirSync(tmp, { recursive: true });
      const report = join(scratch, 'junit.xml');
      const argv = [process.execPath, '--test', '--test-reporter=junit', `--test-reporter-destination=${report}`, ...files];
      const env = sandboxEnv({ manifest: base.manifest, home, tmp, path: dirname(process.execPath) });
      // Inside the boundary only the tree, the scratch space and this Node exist.
      const binds = [{ path: tree, rw: true }, { path: scratch, rw: true }, ...(ctx.tmpRoot ? [{ path: tmp, rw: true }] : []), { path: dirname(process.execPath) }];
      const run = await runCommand({ argv, cwd: tree, env, timeoutMs: ctx.timeoutMs ?? base.manifest.commands.timeout_seconds * 1000, outDir: ctx.outDir ?? ctx.workRoot, label, isolation: ctx.isolation, binds });
      let results = [];
      if (existsSync(report) && statSync(report).size > 0) {
        try {
          results = parseJUnit(readFileSync(report, 'utf8'), { root: tree });
        } catch {
          results = [];
        }
      }
      run.category = run.timed_out ? 'timeout' : run.exit_code === 0 ? 'ok' : results.length > 0 ? 'tests-failed' : 'crash';
      const roots = { [tree]: '<tree>', [scratch]: '<scratch>', [tmp]: '<tmp>', [dirname(process.execPath)]: '<node>' };
      return { run, results, command: { argv: placeholders(argv, roots), env: placeholders(env, roots) } };
    },
  };
}
