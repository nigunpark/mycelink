/**
 * Host-native end to end.
 *
 * The same three-repository feature as three-repo-e2e.test.ts, driven the
 * way the plugin's /mycelink:run drives it inside Claude Code: no worker
 * process is ever spawned (the standalone adapter points at an executable
 * that does not exist). Each worker node is a dispatch ticket fulfilled by
 * the fake Agent and settled; the candidate build and the browser E2E run
 * inside dispatch. One ticket is lost mid-flight and resumed, another
 * expires and is reconciled away. The feature reaches DONE, its candidate
 * survives the control repository committing its own bookkeeping, its
 * evidence survives the workspace moving, and delivery fast-forwards every
 * base branch to exactly the candidate.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { FEATURE_ID, commitControl, e2eScenarios, portfolioGraph, type Portfolio } from '../helpers/portfolio-fixture.js';
import { fakeAgent } from '../helpers/host-agent.js';
import { API, CANDIDATE, CORE, WEB, WORK, cli, dispatch, hostPortfolio, settle } from '../helpers/host-loop.js';
import { loadState, mutateState } from '../../src/state/feature-state.js';
import { loadCandidate } from '../../src/git/candidate.js';
import { resolveRef } from '../../src/git/git.js';
import { loadRegistry } from '../../src/sessions/registry.js';
import { featurePaths } from '../../src/workspace/paths.js';
import { main, type CliIo } from '../../src/cli/cli.js';

afterAll(() => cleanupTmpRoots());

const E2E = `${FEATURE_ID}.release.acceptance.e2e`;

describe('host-native dispatch, end to end', () => {
  let p: Portfolio;

  beforeAll(async () => {
    p = await hostPortfolio(portfolioGraph());
    const scenariosDir = join(p.featureDir, 'e2e');
    mkdirSync(scenariosDir, { recursive: true });
    for (const scenario of e2eScenarios(p)) writeFileSync(join(scenariosDir, `${scenario.id}.yaml`), scenario.yaml);
    commitControl(p, 'e2e scenarios');
  });

  it('1. doctor is healthy without any worker executable; the adapter is only a warning', async () => {
    const r = await cli(p, ['doctor', '--json']);
    const report = JSON.parse(r.out) as { ok: boolean; checks: { name: string; level?: string }[] };
    expect(report.ok).toBe(true);
    expect(report.checks.find((c) => c.name === 'worker adapter (standalone)')?.level).toBe('warn');
  });

  it('2. a lost ticket is reconciled as pending, resumed with a new capability and settled', async () => {
    const lost = (await dispatch(p)).ticket!;
    expect(lost.node_id).toBe(CORE);
    // The host turn ends here; the ticket is gone with it.
    const rec = JSON.parse((await cli(p, ['session', 'reconcile', FEATURE_ID, '--json'])).out) as {
      pending_dispatches: { node_id: string }[];
    };
    expect(rec.pending_dispatches.map((d) => d.node_id)).toEqual([CORE]);
    const resumed = (await dispatch(p, ['--resume', CORE])).ticket!;
    expect(resumed.capability).not.toBe(lost.capability);
    fakeAgent(resumed, WORK[CORE]!, p.control);
    expect(await settle(p, CORE, resumed.capability)).toMatchObject({ outcome: 'DONE' });
  });

  it('3. an expired ticket is handed back as an interruption and simply dispatched again', async () => {
    const abandoned = (await dispatch(p)).ticket!;
    expect(abandoned.node_id).toBe(API);
    mutateState(p.featureDir, (s) => {
      s.nodes[API]!.claim!.expires_at = new Date(Date.now() - 1000).toISOString();
      return s;
    });
    const rec = JSON.parse((await cli(p, ['session', 'reconcile', FEATURE_ID, '--json'])).out) as { abandoned_dispatches: string[] };
    expect(rec.abandoned_dispatches).toEqual([API]);
    expect(loadState(p.featureDir)!.data.nodes[API]).toMatchObject({ state: 'READY', attempts: 0, failure_counts: {}, interruptions: 1 });
  });

  it('4. the host loop settles every worker node; candidate and E2E run inside dispatch', async () => {
    const seen: string[] = [];
    let status = '';
    for (let i = 0; i < 10; i++) {
      const d = await dispatch(p);
      status = d.status;
      seen.push(...d.controller_reports.map((r) => `${r.node_id}:${r.outcome}`));
      if (d.status !== 'DISPATCHED') break;
      const t = d.ticket!;
      seen.push(`${t.node_id}:ticket`);
      fakeAgent(t, WORK[t.node_id]!, p.control);
      expect(await settle(p, t.node_id, t.capability)).toMatchObject({ outcome: 'DONE' });
    }
    expect(status).toBe('ALL_SETTLED');
    expect(seen).toEqual([`${API}:ticket`, `${WEB}:ticket`, `${CANDIDATE}:DONE`, `${E2E}:DONE`]);
    const state = loadState(p.featureDir)!.data;
    for (const id of Object.keys(state.nodes)) expect(`${id}=${state.nodes[id]!.state}`).toBe(`${id}=DONE`);
    expect(state.feature_state).toBe('VERIFIED');
    // No worker process was ever started.
    expect(Object.keys(loadRegistry(featurePaths(p.control, FEATURE_ID).sessionsRegistry).sessions)).toEqual([]);
    expect(state.usage.sessions).toBe(3);
  });

  it('5. feature and candidate verify, and keep verifying after the control repository commits its bookkeeping', async () => {
    expect((await cli(p, ['feature', 'verify', FEATURE_ID])).code).toBe(0);
    expect((await cli(p, ['candidate', 'verify', FEATURE_ID])).code).toBe(0);
    expect(commitControl(p, 'record feature state')).not.toBeNull();
    const after = await cli(p, ['candidate', 'verify', FEATURE_ID, '--json']);
    expect(JSON.parse(after.out)).toMatchObject({ ok: true, problems: [] });
  });

  it('6. evidence still verifies after the whole workspace is moved (sealed and kept)', async () => {
    const moved = `${p.root}-sealed`;
    cpSync(p.root, moved, { recursive: true });
    let out = '';
    const io: CliIo = { out: (t) => (out += t), err: () => {} };
    const code = await main(['feature', 'verify', FEATURE_ID, '--control-root', join(moved, 'control'), '--json'], io);
    expect(JSON.parse(out)).toMatchObject({ ok: true, problems: [] });
    expect(code).toBe(0);
  });

  it('7. delivery fast-forwards every base branch to exactly the candidate and completes the feature', async () => {
    const r = await cli(p, ['deliver', FEATURE_ID, '--json']);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const candidate = loadCandidate(p.featureDir, loadState(p.featureDir)!.data.current_candidate!);
    for (const [name, repo] of [
      ['core', p.core],
      ['api', p.api],
      ['web', p.app],
    ] as const) {
      expect(`${name}@${resolveRef(repo, 'main')}`).toBe(`${name}@${candidate.repositories[name]!.sha}`);
    }
    expect(loadState(p.featureDir)!.data.feature_state).toBe('COMPLETED');
    const again = await cli(p, ['deliver', FEATURE_ID, '--json']);
    expect(JSON.parse(again.out)).toMatchObject({ idempotent: true, status: 'ACCEPTED' });
  });
});

