/**
 * The real Changesets worktree setup, under the real boundary (WSL/Linux
 * with bubblewrap and the prepared cache; opt-in with
 * MYCELINK_BENCH_REAL_CSET=1, minutes long).
 *
 *  1. The generated worktree_setup, verbatim, in a fresh worktree of the
 *     frozen source, inside a sandbox that has only the worktree and the
 *     session HOME writable, the sealed pnpm content store and corepack's
 *     pnpm read-only, no network, and the registry pointed at a loopback
 *     listener that counts connections: the install succeeds with none, and
 *     `pnpm build` then resolves tsdown.
 *  2. Model-free CSET-201 host dispatch through the with arm's own sandbox:
 *     the types node (declaration-only) gets a set-up worktree, its GREEN
 *     passes, it settles DONE, and the next dispatch reaches the downstream
 *     node, whose worktree is set up too — where the first pilot stopped
 *     BLOCKED.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import YAML from 'yaml';
import { REPO_ROOT } from '../helpers/global-setup.js';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { ISOLATED, TEST_ISOLATION } from './isolation-fixture.js';
// @ts-expect-error -- plain ESM module without type declarations
import { findPrd, loadSuite } from '../../evals-public-projects/lib/manifests.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { COREPACK_HOME, PNPM_STORE, worktreeSetupFor } from '../../evals-public-projects/lib/workspace.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { sealedCacheBinds } from '../../evals-public-projects/lib/isolation.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { importSource } from '../../evals-public-projects/lib/source.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { loadToolchains, privateCopy, resolveCacheRoot } from '../../evals-public-projects/lib/toolchain.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { runSync } from '../../evals-public-projects/lib/sandbox.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { runArm } from '../../evals-public-projects/lib/arms.mjs';

afterAll(() => cleanupTmpRoots());

const cacheRoot = resolveCacheRoot();
const REAL = ISOLATED && process.env['MYCELINK_BENCH_REAL_CSET'] === '1' && existsSync(join(cacheRoot, 'toolchains.json')) && existsSync(join(cacheRoot, 'pnpm', 'changesets'));
const suite = loadSuite(join(REPO_ROOT, 'evals-public-projects'));
const cset = findPrd(suite, 'CSET-201');

/** Runs inside the sandbox: a loopback "registry" that counts connections, then the setup argv with the registry pointed at it. */
const PROBE = `const { createServer } = require('node:net');
const { spawnSync } = require('node:child_process');
const spec = JSON.parse(process.argv[2]);
let connections = 0;
const server = createServer((s) => { connections += 1; s.destroy(); });
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const env = { ...spec.env, npm_config_registry: 'http://127.0.0.1:' + port + '/' };
  const out = [];
  for (const argv of spec.commands) {
    const r = spawnSync(argv[0], argv.slice(1), { cwd: spec.cwd, env, encoding: 'utf8', maxBuffer: 64 << 20 });
    out.push({ argv, status: r.status, tail: (r.stdout + r.stderr).slice(-1500) });
    if (r.status !== 0) break;
  }
  setTimeout(() => { server.close(); console.log(JSON.stringify({ connections, out })); }, 200);
});
`;

describe.runIf(REAL)('the real Changesets worktree setup', () => {
  it('installs offline into a fresh worktree from the read-only sealed store, with no registry connection, and pnpm build then resolves tsdown', () => {
    const toolchains = loadToolchains(cacheRoot);
    const root = makeTmpDir('cset-setup-');
    const repo = join(root, 'repo');
    return importSource({ lock: cset.project.lock, bundlePath: join(cacheRoot, 'sources', cset.project.lock.bundle.file), target: repo, branch: 'main' }).then(() => {
      const wt = join(root, 'worktrees', 'changesets__CSET-201.types.reason.impl');
      mkdirSync(dirname(wt), { recursive: true });
      execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'wip/CSET-201/types', wt, 'main']);
      expect(existsSync(join(wt, 'node_modules'))).toBe(false);
      const home = join(root, 'home');
      privateCopy(join(cacheRoot, 'pnpm', 'changesets'), join(home, ...PNPM_STORE));
      privateCopy(join(cacheRoot, 'corepack'), join(home, ...COREPACK_HOME));
      mkdirSync(join(home, '.tmp'), { recursive: true });
      const setup = worktreeSetupFor(cset.project.adapter);
      const env = { PATH: `${toolchains.node.bin}:/usr/bin:/bin`, HOME: home, TMPDIR: join(home, '.tmp'), ...Object.fromEntries(Object.entries(setup.env as Record<string, string>).map(([k, v]) => [k, v.split('${HOME}').join(home)])) };
      const probe = join(root, 'probe.cjs');
      writeFileSync(probe, PROBE);
      const sealed = sealedCacheBinds({ adapter: cset.project.adapter, home });
      expect(sealed.length).toBe(2);
      const binds = [{ path: wt, rw: true }, { path: home, rw: true }, ...sealed, { path: dirname(toolchains.node.bin) }, { path: probe }];
      const inBox = (commands: string[][]) => {
        const r = runSync(TEST_ISOLATION, { argv: [process.execPath, probe, JSON.stringify({ cwd: wt, env, commands })], env, cwd: wt, binds }, { encoding: 'utf8', timeout: 900_000, maxBuffer: 64 << 20 });
        return JSON.parse(String(r.stdout).trim().split('\n').at(-1) as string);
      };
      const installed = inBox(setup.commands);
      expect(installed.out.map((o: { status: number }) => o.status), JSON.stringify(installed.out)).toEqual([0]);
      expect(installed.connections).toBe(0);
      expect(existsSync(join(wt, 'node_modules', '.bin', 'tsdown'))).toBe(true);
      expect(existsSync(join(wt, '.pnpm-store'))).toBe(false);
      expect(execFileSync('git', ['-C', wt, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' })).toBe('');
      // The host's cache, suite and drives do not exist in there; the build finds what the setup installed.
      const built = inBox([['sh', '-c', `test ! -e ${cacheRoot} && test ! -e ${REPO_ROOT} && test ! -e /mnt/c && pnpm build`]]);
      expect(built.out[0].status, built.out[0].tail).toBe(0);
      expect(built.out[0].tail).not.toMatch(/command not found/);
      expect(built.connections).toBe(0);
    });
  }, 1_200_000);

  it('CSET-201 host dispatch, model-free, through the with arm: the types node settles from a set-up worktree and the next dispatch reaches the downstream node', async () => {
    const dir = makeTmpDir('cset-host-');
    const log = join(dir, 'log.jsonl');
    writeFileSync(log, '');
    const plan = join(dir, 'plan.json');
    const probePaths = [...new Set([cacheRoot, REPO_ROOT, '/mnt/c', join(homedir(), 'mycelink-benchmark-cache')])];
    writeFileSync(plan, JSON.stringify({ log, probePaths }));
    const run = await runArm({
      suiteRoot: join(REPO_ROOT, 'evals-public-projects'),
      caseKey: 'CSET-201',
      arm: 'with',
      outDir: join(makeTmpDir('cset-host-run-'), 'run'),
      cacheRoot,
      claude: [process.execPath, join(REPO_ROOT, 'tests', 'benchmark', 'fake-cset-host.mjs')],
      pollMs: 500,
      env: { FAKE_CLAUDE_PLAN: plan },
      isolation: TEST_ISOLATION,
      sessionBinds: [{ path: dir, rw: true }],
    });
    expect(run.isolation.preflight.ok).toBe(true);
    // The store's contents and corepack were read-only inside, as proved before the session.
    expect(run.isolation.preflight.checks.filter((c: { id: string; ok: boolean }) => /^readonly:.*(files|corepack)$/.test(c.id))).toEqual([
      expect.objectContaining({ ok: true, detail: 'EROFS' }),
      expect.objectContaining({ ok: true, detail: 'EROFS' }),
    ]);
    const seen = JSON.parse(readFileSync(log, 'utf8').trim().split('\n').at(-1) as string);
    expect(seen.probes).toEqual(Object.fromEntries(probePaths.map((p) => [p, 'ENOENT'])));
    expect(YAML.parse(seen.registered).repositories[0].worktree_setup.commands).toEqual([cset.project.adapter.commands.install]);
    // The generated manifest's module allowlist: the graph's verifiers come from it, the types module is declarations.
    expect(seen.modules.map((m: { id: string }) => m.id)).toEqual(expect.arrayContaining(['types', 'errors', 'read', 'assemble-release-plan', 'cli']));
    expect(seen.modules.find((m: { id: string }) => m.id === 'types')).toMatchObject({ runtime_tests: false, test: ['pnpm', 'tsc'] });
    expect(seen.first).toMatchObject({ status: 'DISPATCHED', node: 'CSET-201.types.reason.impl', tsdown: true, worktree_setup: { status: 'complete' } });
    expect(seen.first.verify.status, seen.first.verify.tail).toBe(0);
    expect(seen.first.gates.map((g: { exit: number }) => g.exit), JSON.stringify(seen.first.gates)).toEqual([0, 0]);
    expect(seen.settled, JSON.stringify(seen.settled)).toMatchObject({ outcome: 'DONE' });
    expect(seen.second).toMatchObject({ status: 'DISPATCHED', node: 'CSET-201.assemble.reasons.impl', worktree_setup: { status: 'complete' } });
    expect(seen.second.verify.status, seen.second.verify.tail).toBe(0);
    // Nothing reached a registry: the setup runs with no proxy variable (and the first test shows it opens no
    // connection); the only traffic the model proxy saw is Changesets' own test suite asking for registry.npmjs.org
    // in the regression gate and fresh verification, which run with the session's environment — refused.
    expect(run.network.allowed, JSON.stringify(run.network)).toEqual({});
    for (const target of Object.keys(run.network.denied)) expect(target).toBe('registry.npmjs.org:443');
    const state = JSON.parse(readFileSync(join(run.workspace, 'platform', 'features', 'CSET-201', 'STATE.json'), 'utf8')).data;
    expect(state.nodes['CSET-201.types.reason.impl']).toMatchObject({ state: 'DONE', tdd_history: { ok: true, cycles: 0 }, worktree_setup: { status: 'complete' } });
    expect(state.nodes['CSET-201.assemble.reasons.impl'].claim.worktree_setup).toMatchObject({ status: 'complete' });
  }, 3_600_000);
});
