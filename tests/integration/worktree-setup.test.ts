/**
 * The controller materialises every worktree before anything runs in it.
 *
 * CSET-201 r1: the benchmark scaffold installed Changesets' dependencies in
 * the base checkout only; git worktrees carry no untracked node_modules. The
 * first node (types, declaration-only) made its edit, its legitimate GREEN
 * (`pnpm build`) exited 127 (`tsdown: command not found`), the worker
 * correctly rolled back and returned BLOCKED, and no downstream node ran.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { afterAll, describe, expect, it } from 'vitest';
import { fakeAgent, type DispatchTicket } from '../helpers/host-agent.js';
import {
  EXPLAIN,
  REASONS,
  SETUP_CANDIDATE,
  SETUP_FEATURE,
  SETUP_WORK,
  TYPES,
  cliAt,
  commitControlRepo,
  featureState,
  setMode,
  setupConfig,
  setupGraph,
  setupPortfolio,
  setupRuns,
  type SetupPortfolio,
} from '../helpers/setup-fixture.js';
import { git } from '../helpers/git-fixture.js';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { worktreeSetupSha256 } from '../../src/engine/worktree-setup.js';

afterAll(() => cleanupTmpRoots());

interface Ticket extends DispatchTicket {
  worktree_setup: { status: string; config_sha256: string | null; receipt_sha256: string | null; receipt_path: string | null; commands: string[][]; required_paths: string[] };
  context_pack_path: string;
}

async function dispatch(p: SetupPortfolio, extra: string[] = []): Promise<{ status: string; detail: string; ticket?: Ticket; controller_reports: { node_id: string; outcome: string; detail: string }[] }> {
  const r = await cliAt(p.control, ['dispatch', SETUP_FEATURE, '--json', ...extra]);
  expect(r.err).toBe('');
  return JSON.parse(r.out);
}

async function settle(p: SetupPortfolio, t: Ticket): Promise<{ outcome: string; detail: string; state: string }> {
  const r = await cliAt(p.control, ['settle', SETUP_FEATURE, t.node_id, '--capability', t.capability, '--json']);
  expect(r.err).toBe('');
  return JSON.parse(r.out);
}

/** The node's own verification command, run in its worktree as the worker runs it before GREEN. */
function verifyIn(worktree: string): { status: number | null; output: string } {
  const r = spawnSync(process.execPath, ['tests/run.mjs'], { cwd: worktree, encoding: 'utf8' });
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

const configSha = (p: SetupPortfolio, env: Record<string, string> = {}): string => {
  const cfg = setupConfig(p, env) as { commands: string[][]; timeout_seconds: number; env: Record<string, string>; required_paths: string[] };
  return worktreeSetupSha256(cfg);
};

describe('worktree setup', () => {
  it('reproduces CSET-201 r1 without it: the base checkout has node_modules, a node worktree has none, and the GREEN command exits 127', async () => {
    const p = await setupPortfolio({ worktreeSetup: false });
    expect(existsSync(join(p.app, 'node_modules', 'fixture-build', 'index.mjs'))).toBe(true);
    expect(verifyIn(p.app).status).toBe(0);
    const d = await dispatch(p);
    expect(d.status).toBe('DISPATCHED');
    const t = d.ticket as Ticket;
    expect(t.node_id).toBe(TYPES);
    expect(t.worktree_setup).toMatchObject({ status: 'not-configured', config_sha256: null, receipt_sha256: null });
    expect(existsSync(join(t.worktree as string, 'node_modules'))).toBe(false);
    const green = verifyIn(t.worktree as string);
    expect(green.status).toBe(127);
    expect(green.output).toContain('command not found');
    expect(setupRuns(p)).toEqual([]);
  });

  it('materialises each worktree before its ticket, so the declaration-only node settles and the feature reaches every downstream node', async () => {
    const p = await setupPortfolio();
    const sha = configSha(p);
    const seen: Ticket[] = [];
    for (let i = 0; i < 8; i++) {
      const d = await dispatch(p);
      if (d.status !== 'DISPATCHED') {
        expect(d.status).toBe('ALL_SETTLED');
        break;
      }
      const t = d.ticket as Ticket;
      seen.push(t);
      // Set up before the ticket was handed out: installed, bound, and the node's own command works there.
      expect(t.worktree_setup).toMatchObject({ status: 'complete', config_sha256: sha, receipt_sha256: expect.stringMatching(/^[0-9a-f]{64}$/), required_paths: ['node_modules'] });
      expect(t.worktree_setup.commands).toEqual([['node', p.installer, '--frozen-lockfile', '--offline']]);
      expect(existsSync(join(t.worktree as string, 'node_modules', 'fixture-build', 'index.mjs'))).toBe(true);
      expect(git(t.worktree as string, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
      expect(verifyIn(t.worktree as string).status).toBe(0);
      const claim = featureState(p).nodes[t.node_id].claim;
      expect(claim.worktree_setup).toMatchObject({ config_sha256: sha, receipt_sha256: t.worktree_setup.receipt_sha256, status: 'complete' });
      const pack = JSON.parse(readFileSync(t.context_pack_path, 'utf8'));
      expect(pack.worktree_setup).toMatchObject({ status: 'complete', config_sha256: sha, receipt_sha256: t.worktree_setup.receipt_sha256 });
      expect(t.prompt).toMatch(/Worktree setup: the controller prepared this worktree/);
      expect(t.prompt).toContain(`receipt ${String(t.worktree_setup.receipt_sha256).slice(0, 12)}`);
      fakeAgent(t, SETUP_WORK[t.node_id as keyof typeof SETUP_WORK] ?? {}, p.control);
      const s = await settle(p, t);
      expect(s.outcome, `${t.node_id}: ${s.detail}`).toBe('DONE');
    }
    expect(seen.map((t) => t.node_id)).toEqual([TYPES, REASONS, EXPLAIN]);
    const state = featureState(p);
    for (const id of [TYPES, REASONS, EXPLAIN, SETUP_CANDIDATE]) expect(state.nodes[id].state, id).toBe('DONE');
    // The declaration-only node was judged a declaration change, with no RED.
    expect(state.nodes[TYPES].tdd_history).toMatchObject({ ok: true, cycles: 0 });
    // Fresh verification set up its own clean checkout: one installer run per worker worktree and per fresh verification.
    const runs = setupRuns(p);
    expect(runs.filter((r) => /[\\/]worktrees[\\/]app__FEAT-777/.test(r.cwd)).length).toBe(3);
    expect(runs.filter((r) => /[\\/]verify[\\/]app__FEAT-777/.test(r.cwd)).length).toBe(3);
    // Fresh evidence is bound to the setup of the checkout it ran in.
    const green = state.nodes[REASONS].evidence.green;
    expect(green.worktree_setup_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(state.nodes[REASONS].last_settlement).toMatchObject({ outcome: 'DONE', worktree_setup_sha256: sha });
  });

  it('sets up the clean checkout delivery acceptance runs in; a failed setup fails acceptance, and delivering again once it works accepts', async () => {
    const p = await setupPortfolio();
    for (let i = 0; i < 8; i++) {
      const d = await dispatch(p);
      if (d.status !== 'DISPATCHED') {
        expect(d.status).toBe('ALL_SETTLED');
        break;
      }
      const t = d.ticket as Ticket;
      fakeAgent(t, SETUP_WORK[t.node_id as keyof typeof SETUP_WORK] ?? {}, p.control);
      expect((await settle(p, t)).outcome).toBe('DONE');
    }
    commitControlRepo(p, 'settled');
    setMode(p, 'fail');
    const failed = await cliAt(p.control, ['deliver', SETUP_FEATURE, '--json']);
    const m1 = JSON.parse(failed.out);
    expect(m1.status).toBe('ACCEPTANCE_FAILED');
    expect(m1.acceptance[0]).toMatchObject({ repository: 'app', failure_fingerprint: expect.stringMatching(/^WORKTREE_SETUP_FAILED:COMMAND_FAILED/) });
    expect(readFileSync(join(p.control, m1.acceptance[0].output_path), 'utf8')).toContain('ERR_PNPM_NO_OFFLINE_TARBALL');
    setMode(p, 'ok');
    const ok = JSON.parse((await cliAt(p.control, ['deliver', SETUP_FEATURE, '--json'])).out);
    expect(ok.status).toBe('ACCEPTED');
    expect(ok.acceptance[0]).toMatchObject({ exit_code: 0, failure_fingerprint: null, worktree_setup_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(setupRuns(p).filter((r) => /[\\/]acceptance[\\/]app__/.test(r.cwd))).toHaveLength(2);
  });

  it('runs no worker and charges nothing when the setup fails, and tries again only on the next dispatch', async () => {
    const p = await setupPortfolio();
    setMode(p, 'fail');
    const d = await dispatch(p);
    expect(d.status).toBe('PRECONDITION_FAILED');
    expect(d.ticket).toBeUndefined();
    expect(d.detail).toMatch(/WORKTREE_SETUP_FAILED: .*COMMAND_FAILED/);
    expect(d.detail).toMatch(/log features\/FEAT-777\/evidence\/.*\.log/);
    expect(setupRuns(p)).toHaveLength(1);
    let rt = featureState(p).nodes[TYPES];
    expect(rt).toMatchObject({ state: 'READY', attempts: 0, claim: null, failure_counts: {}, last_failure_fingerprint: null, blocked_reason: null });
    expect(rt.interruptions ?? 0).toBe(0);
    expect(rt.usage).toMatchObject({ sessions: 0, model_turns: 0 });
    expect(rt.worktree_setup).toMatchObject({ status: 'failed', code: 'COMMAND_FAILED' });
    const receipt = JSON.parse(readFileSync(join(p.control, rt.worktree_setup.receipt_path), 'utf8'));
    expect(readFileSync(join(p.control, receipt.output_path), 'utf8')).toContain('ERR_PNPM_NO_OFFLINE_TARBALL');

    const again = await dispatch(p);
    expect(again.status).toBe('PRECONDITION_FAILED');
    expect(setupRuns(p)).toHaveLength(2);
    rt = featureState(p).nodes[TYPES];
    expect(rt).toMatchObject({ state: 'READY', attempts: 0 });
    expect(rt.interruptions ?? 0).toBe(0);

    setMode(p, 'ok');
    const fixed = await dispatch(p);
    expect(fixed.status).toBe('DISPATCHED');
    expect((fixed.ticket as Ticket).worktree_setup.status).toBe('complete');
    expect(featureState(p).nodes[TYPES].attempts).toBe(1);
  });

  it('reuses a receipt on resume only while it binds the worktree, its commit and the config', async () => {
    const p = await setupPortfolio();
    const first = (await dispatch(p)).ticket as Ticket;
    expect(setupRuns(p)).toHaveLength(1);

    const resumed = (await dispatch(p, ['--resume', TYPES])).ticket as Ticket;
    expect(resumed.worktree_setup).toMatchObject({ status: 'reused', receipt_sha256: first.worktree_setup.receipt_sha256 });
    expect(setupRuns(p)).toHaveLength(1);

    // The worker committed: the receipt names another commit.
    writeFileSync(join(first.worktree as string, 'src', 'types', 'index.d.ts'), 'export type A = 1;\n');
    git(first.worktree as string, ['add', '-A']);
    git(first.worktree as string, ['commit', '-q', '-m', 'types']);
    const drifted = (await dispatch(p, ['--resume', TYPES])).ticket as Ticket;
    expect(drifted.worktree_setup.status).toBe('complete');
    expect(drifted.worktree_setup.receipt_sha256).not.toBe(first.worktree_setup.receipt_sha256);
    expect(setupRuns(p)).toHaveLength(2);

    // The receipt was changed after it was written.
    const record = featureState(p).nodes[TYPES].worktree_setup;
    writeFileSync(join(p.control, record.receipt_path), readFileSync(join(p.control, record.receipt_path), 'utf8').replace('"complete"', '"complete" '));
    const tampered = (await dispatch(p, ['--resume', TYPES])).ticket as Ticket;
    expect(tampered.worktree_setup.status).toBe('complete');
    expect(setupRuns(p)).toHaveLength(3);

    // The repository's worktree_setup changed: the claim is bound to the new one.
    const manifest = YAML.parse(readFileSync(join(p.control, 'repositories.yaml'), 'utf8'));
    manifest.repositories[0].worktree_setup = setupConfig(p, { CI: '1' });
    writeFileSync(join(p.control, 'repositories.yaml'), YAML.stringify(manifest, { lineWidth: 0 }));
    commitControlRepo(p, 'worktree setup sets CI');
    const reconfigured = (await dispatch(p, ['--resume', TYPES])).ticket as Ticket;
    expect(reconfigured.worktree_setup).toMatchObject({ status: 'complete', config_sha256: configSha(p, { CI: '1' }) });
    expect(setupRuns(p)).toHaveLength(4);
    expect(setupRuns(p)[3]?.env['CI']).toBe('1');
    expect(featureState(p).nodes[TYPES].claim.worktree_setup.config_sha256).toBe(configSha(p, { CI: '1' }));
  });

  it('fails a setup that changes a tracked file and creates the worktree again for the next dispatch', async () => {
    const p = await setupPortfolio();
    setMode(p, 'tracked');
    const d = await dispatch(p);
    expect(d.status).toBe('PRECONDITION_FAILED');
    expect(d.detail).toMatch(/TRACKED_MUTATION/);
    const worktree = join(p.control, '.mycelink', 'worktrees', `app__${TYPES}`);
    expect(existsSync(worktree)).toBe(false);
    expect(featureState(p).nodes[TYPES]).toMatchObject({ state: 'READY', attempts: 0 });

    setMode(p, 'ok');
    const t = (await dispatch(p)).ticket as Ticket;
    expect(t.worktree_setup.status).toBe('complete');
    expect(readFileSync(join(t.worktree as string, 'README.md'), 'utf8')).toBe('# app\n');
    expect(git(t.worktree as string, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
  });

  it('gives concurrent worktrees each their own dependencies and receipt', async () => {
    const graph = setupGraph() as { nodes: Record<string, unknown>[] };
    // reasons no longer waits for types: two writers in one repository at once.
    graph.nodes = graph.nodes.map((n) => (n['id'] === REASONS ? { ...n, depends_on: [] } : n));
    const p = await setupPortfolio({ graph, writerConcurrency: 2 });
    const a = (await dispatch(p)).ticket as Ticket;
    const b = (await dispatch(p)).ticket as Ticket;
    expect(new Set([a.node_id, b.node_id])).toEqual(new Set([TYPES, REASONS]));
    expect(a.worktree).not.toBe(b.worktree);
    expect(a.worktree_setup.receipt_sha256).not.toBe(b.worktree_setup.receipt_sha256);
    for (const t of [a, b]) expect(existsSync(join(t.worktree as string, 'node_modules', 'fixture-build', 'index.mjs'))).toBe(true);
    // One worktree's dependencies are its own.
    execFileSync(process.execPath, ['-e', `require('node:fs').rmSync(${JSON.stringify(join(a.worktree as string, 'node_modules'))}, { recursive: true, force: true })`]);
    expect(verifyIn(a.worktree as string).status).toBe(127);
    expect(verifyIn(b.worktree as string).status).toBe(0);
    // Its resume sees the missing path and sets it up again; the other is reused.
    const ra = (await dispatch(p, ['--resume', a.node_id])).ticket as Ticket;
    const rb = (await dispatch(p, ['--resume', b.node_id])).ticket as Ticket;
    expect(ra.worktree_setup.status).toBe('complete');
    expect(rb.worktree_setup.status).toBe('reused');
    expect(verifyIn(a.worktree as string).status).toBe(0);
  });

  it('holds a settlement whose fresh verification cannot be set up, charges the worker nothing, and finishes it once the setup works', async () => {
    const p = await setupPortfolio();
    const t = (await dispatch(p)).ticket as Ticket;
    fakeAgent(t, SETUP_WORK[TYPES], p.control);
    setMode(p, 'fail');
    const s = await settle(p, t);
    expect(s.outcome).toBe('PRECONDITION_FAILED');
    expect(s.detail).toMatch(/WORKTREE_SETUP_FAILED: .*fresh verification.*COMMAND_FAILED/);
    let rt = featureState(p).nodes[TYPES];
    expect(rt.failure_counts).toEqual({});
    expect(rt.last_failure_fingerprint).toBeNull();
    expect(rt.attempts).toBe(1);
    expect(rt.claim).not.toBeNull();
    expect(rt.claim.seal).toMatchObject({ head_sha: expect.stringMatching(/^[0-9a-f]{40}$/) });

    // dispatch finishes held settlements first: still failing, it stops there once.
    const runs = setupRuns(p).length;
    const held = await dispatch(p);
    expect(held.status).toBe('PRECONDITION_FAILED');
    expect(held.detail).toMatch(/WORKTREE_SETUP_FAILED/);
    expect(setupRuns(p).length).toBe(runs + 1);

    setMode(p, 'ok');
    const next = await dispatch(p);
    expect(next.controller_reports.find((r) => r.node_id === TYPES)).toMatchObject({ outcome: 'DONE' });
    expect(next.status).toBe('DISPATCHED');
    expect((next.ticket as Ticket).node_id).toBe(REASONS);
    rt = featureState(p).nodes[TYPES];
    expect(rt).toMatchObject({ state: 'DONE', attempts: 1, failure_counts: {} });
  });

  it("gives the setup the session's HOME and the configured values, never the controller's proxy, credentials or keys", async () => {
    const p = await setupPortfolio();
    const saved = { ...process.env };
    process.env['HTTPS_PROXY'] = 'http://127.0.0.1:3128';
    process.env['ALL_PROXY'] = 'socks5://127.0.0.1:1080';
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-api03-secret';
    process.env['NODE_OPTIONS'] = '--require /tmp/evil.js';
    process.env['npm_config_registry'] = 'https://registry.npmjs.org/';
    try {
      const d = await dispatch(p);
      expect(d.status).toBe('DISPATCHED');
    } finally {
      for (const k of ['HTTPS_PROXY', 'ALL_PROXY', 'ANTHROPIC_API_KEY', 'NODE_OPTIONS', 'npm_config_registry']) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
    const env = setupRuns(p)[0]?.env as Record<string, string>;
    for (const k of ['HTTPS_PROXY', 'ALL_PROXY', 'ANTHROPIC_API_KEY', 'NODE_OPTIONS', 'npm_config_registry', 'MYCELINK_CONTROL_ROOT', 'MYCELINK_CAPABILITY']) expect(env[k], k).toBeUndefined();
    const home = process.env['HOME'] ?? process.env['USERPROFILE'];
    expect(env['HOME'] ?? env['USERPROFILE']).toBe(home);
    expect(env['FIXTURE_STORE']).toBe(p.store);
  });
});
