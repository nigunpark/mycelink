/**
 * pnpm workspace + Vitest adapter.
 *
 * Installs offline (frozen lockfile) from a private copy of the prepared
 * pnpm store, with corepack's pinned pnpm and network access disabled,
 * builds, then runs Vitest with its JSON reporter. The sandbox HOME carries
 * a git identity, because the project's tests create git repositories.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseVitestJson } from '../results.mjs';
import { placeholders, runCommand } from '../run.mjs';
import { loadToolchains, privateCopy } from '../toolchain.mjs';
import { sandboxEnv } from './index.mjs';

export const SANDBOX_GIT_IDENTITY = '[user]\n\tname = Mycelink Benchmark\n\temail = benchmark@mycelink.invalid\n[init]\n\tdefaultBranch = main\n';

/** The three argv of a run: install, build, and the Vitest run (all tests or the files that declare `tests`). */
export function pnpmPlan({ manifest, tests, storeDir, report }) {
  const files = tests === null || tests === undefined ? [] : [...new Set(tests.map((t) => t.file))];
  return {
    install: [...manifest.commands.install, `--store-dir=${storeDir}`],
    build: [...manifest.commands.build],
    test: [...manifest.commands.test, '--reporter=json', `--outputFile=${report}`, ...files],
  };
}

export function pnpmVitestAdapter(base, options = {}) {
  return {
    ...base,
    async runTests({ tree, tests, ctx, label }) {
      const manifest = base.manifest;
      const toolchains = ctx.toolchains ?? loadToolchains(ctx.cacheRoot);
      const scratch = join(ctx.workRoot, `${label}.scratch`);
      const home = join(scratch, 'home');
      // A temp root on another file system (qualification) still hashes as <tmp>.
      const tmp = ctx.tmpRoot ? mkdtempSync(join(ctx.tmpRoot, 'bench-tmp-')) : join(scratch, 'tmp');
      mkdirSync(home, { recursive: true });
      mkdirSync(tmp, { recursive: true });
      const gitconfig = join(scratch, 'gitconfig');
      writeFileSync(gitconfig, SANDBOX_GIT_IDENTITY);
      const cache = manifest.toolchain.cache;
      const storeDir = privateCopy(join(ctx.cacheRoot, cache.dir), join(scratch, 'store'));
      const corepackHome = privateCopy(join(ctx.cacheRoot, cache.corepack_dir), join(scratch, 'corepack'));
      const report = join(scratch, 'vitest.json');
      const plan = pnpmPlan({ manifest, tests, storeDir, report });
      const nodeBin = toolchains.node.bin;
      const env = sandboxEnv({
        manifest,
        home,
        tmp,
        path: `${nodeBin}:/usr/bin:/bin`,
        extra: { COREPACK_HOME: corepackHome, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1' },
      });
      const timeoutMs = ctx.timeoutMs ?? manifest.commands.timeout_seconds * 1000;
      const outDir = ctx.outDir ?? ctx.workRoot;
      const roots = { [tree]: '<tree>', [scratch]: '<scratch>', [tmp]: '<tmp>', [nodeBin]: '<node>' };
      const command = { setup: [placeholders(plan.install, roots), placeholders(plan.build, roots)], argv: placeholders(plan.test, roots), env: placeholders(env, roots) };
      // Inside the boundary only the tree, the scratch space (private store and corepack copies) and the Node distribution exist.
      const binds = [{ path: tree, rw: true }, { path: scratch, rw: true }, ...(ctx.tmpRoot ? [{ path: tmp, rw: true }] : []), { path: dirname(nodeBin) }];
      const steps = {};
      for (const [step, argv] of [['install', plan.install], ['build', plan.build]]) {
        const r = await runCommand({ argv, cwd: tree, env, timeoutMs, outDir, label: `${label}-${step}`, isolation: ctx.isolation, binds });
        steps[step] = r;
        if (r.exit_code !== 0 || r.timed_out) {
          return { run: { ...r, steps, category: r.timed_out ? 'timeout' : step === 'install' ? 'dependency' : 'build' }, results: [], command };
        }
      }
      const run = await runCommand({ argv: plan.test, cwd: tree, env, timeoutMs, outDir, label, isolation: ctx.isolation, binds });
      run.steps = steps;
      let results = [];
      if (existsSync(report)) {
        try {
          results = parseVitestJson(readFileSync(report, 'utf8'), { root: tree });
        } catch {
          results = [];
        }
      }
      run.category = run.timed_out ? 'timeout' : run.exit_code === 0 ? 'ok' : results.length > 0 ? 'tests-failed' : 'crash';
      return { run, results, command };
    },
  };
}
