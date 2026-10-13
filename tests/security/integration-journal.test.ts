/**
 * The integration branch is trusted only at a commit Mycelink itself
 * produced.
 *
 * An integration used to be resumed after a crash whenever the branch head
 * contained the verified node commit and its first parent was the recorded
 * head. That is a shape any same-user process can forge: a merge M whose
 * first parent is the trusted head E, which contains the verified commit V
 * and also arbitrary unverified content, moved onto feature/<id> between
 * fresh verification and integration, was then recorded as the trusted
 * head (the merge itself reported "already integrated").
 *
 * Now the controller journals the exact commit an integration will produce
 * before the branch moves, and a resume accepts exactly that commit.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { FEATURE_ID, type Portfolio } from '../helpers/portfolio-fixture.js';
import { fakeAgent, type DispatchTicket } from '../helpers/host-agent.js';
import { CORE, cli, dispatch, hostLoop, hostPortfolio, settle, WORK } from '../helpers/host-loop.js';
import { git } from '../helpers/git-fixture.js';
import { loadState } from '../../src/state/feature-state.js';
import { Orchestrator, type SettleFaultPoint } from '../../src/engine/orchestrator.js';
import type { SessionAdapter } from '../../src/sessions/adapter.js';
import { integrationBranchName, workerBranchName } from '../../src/git/worktree.js';
import { resolveRef } from '../../src/git/git.js';

afterAll(() => cleanupTmpRoots());

const BRANCH = integrationBranchName(FEATURE_ID);

function orchestrator(p: Portfolio, fault?: (point: SettleFaultPoint) => void): Orchestrator {
  return new Orchestrator({
    controlRoot: p.control,
    featureId: FEATURE_ID,
    adapter: {} as SessionAdapter,
    ...(fault ? { settleFault: fault } : {}),
  });
}

/**
 * A merge whose first parent is `parent`, containing `verified`, plus a
 * planted file nobody verified; feature/<id> is moved onto it.
 */
function forgeMerge(repo: string, parent: string, verified: string): string {
  const dir = join(makeTmpDir('forge-'), 'wt');
  git(repo, ['worktree', 'add', '--detach', dir, parent]);
  git(dir, ['merge', '--no-ff', '--no-commit', verified]);
  writeFileSync(join(dir, 'src', 'planted.js'), 'export const PLANTED = 1;\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '--no-edit', '-m', 'integrate (forged)']);
  const m = git(dir, ['rev-parse', 'HEAD']);
  expect(git(dir, ['rev-parse', 'HEAD^1'])).toBe(parent);
  git(repo, ['worktree', 'remove', '--force', dir]);
  git(repo, ['update-ref', `refs/heads/${BRANCH}`, m]);
  // A careful attacker leaves the integration worktree clean, on M.
  const integration = join(dirname(repo), 'control', '.mycelink', 'integration', `integration__core__${FEATURE_ID}`);
  if (existsSync(integration)) git(integration, ['reset', '-q', '--hard', m]);
  return m;
}

async function dispatchCore(p: Portfolio): Promise<DispatchTicket> {
  const t = (await dispatch(p)).ticket!;
  expect(t.node_id).toBe(CORE);
  fakeAgent(t, WORK[CORE]!, p.control);
  return t;
}

function trustedHeads(p: Portfolio): Record<string, string> {
  return loadState(p.featureDir)!.data.integration_heads ?? {};
}

describe('a forged integration head is never trusted', () => {
  it('a merge injected between fresh verification and integration fails closed', async () => {
    const p = await hostPortfolio();
    const t = await dispatchCore(p);
    const e = resolveRef(p.core, 'refs/heads/main');
    let forged: string | null = null;
    const report = orchestrator(p, (point) => {
      if (point !== 'fresh-verified') return;
      const v = resolveRef(p.core, workerBranchName(FEATURE_ID, CORE));
      forged = forgeMerge(p.core, e, v);
    }).settle(CORE, t.capability);

    expect(forged).not.toBeNull();
    expect(report.outcome).not.toBe('DONE');
    expect(report.detail).toContain('INTEGRATION_BRANCH_MOVED');
    const rt = loadState(p.featureDir)!.data.nodes[CORE]!;
    expect(rt.state).not.toBe('DONE');
    expect(rt.integrated_sha ?? null).toBeNull();
    expect(Object.values(trustedHeads(p))).not.toContain(forged);
    // The forged branch is still where the attacker left it, and never bound.
    expect(resolveRef(p.core, BRANCH)).toBe(forged);
    const c = await cli(p, ['candidate', 'create', FEATURE_ID]);
    expect(c.code).not.toBe(0);
    expect(loadState(p.featureDir)!.data.current_candidate).toBeNull();
  });

  it('a controller-primitive integrate does not adopt a forged merge as already integrated', async () => {
    const p = await hostPortfolio();
    const t = await dispatchCore(p);
    expect(await settle(p, CORE, t.capability)).toMatchObject({ outcome: 'DONE' });
    const head = resolveRef(p.core, BRANCH);
    const forged = forgeMerge(p.core, head, resolveRef(p.core, workerBranchName(FEATURE_ID, CORE)));
    const r = await cli(p, ['branch', 'integrate', FEATURE_ID, CORE]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('INTEGRATION_BRANCH_MOVED');
    expect(trustedHeads(p)['core']).toBe(head);
    expect(Object.values(trustedHeads(p))).not.toContain(forged);
  });
});

describe('a crashed integration resumes only to the journaled commit', () => {
  for (const point of ['integration-journaled', 'integration-moved'] as SettleFaultPoint[]) {
    it(`a settle that dies at ${point} completes on retry, and the feature still delivers`, async () => {
      const p = await hostPortfolio();
      const t = await dispatchCore(p);
      expect(() =>
        orchestrator(p, (at) => {
          if (at === point) throw new Error(`CRASH at ${at}`);
        }).settle(CORE, t.capability),
      ).toThrow(/CRASH/);
      if (point === 'integration-moved') {
        // The branch moved; the recorded head did not.
        expect(resolveRef(p.core, BRANCH)).not.toBe(trustedHeads(p)['core'] ?? resolveRef(p.core, 'refs/heads/main'));
      }
      const report = orchestrator(p).settle(CORE, t.capability);
      expect(report.outcome).toBe('DONE');
      const s = loadState(p.featureDir)!.data;
      expect(s.nodes[CORE]!.integrated_sha).toBe(resolveRef(p.core, BRANCH));
      expect(s.integration_heads?.['core']).toBe(resolveRef(p.core, BRANCH));
      expect(s.pending_integrations?.['core'] ?? null).toBeNull();
      expect((await hostLoop(p)).status).toBe('ALL_SETTLED');
      expect(loadState(p.featureDir)!.data.current_candidate).not.toBeNull();
    });
  }

  it('a crash after the branch moved, then a forged head, refuses the resume', async () => {
    const p = await hostPortfolio();
    const t = await dispatchCore(p);
    expect(() =>
      orchestrator(p, (at) => {
        if (at === 'integration-moved') throw new Error('CRASH');
      }).settle(CORE, t.capability),
    ).toThrow(/CRASH/);
    const e = resolveRef(p.core, 'refs/heads/main');
    const forged = forgeMerge(p.core, e, resolveRef(p.core, workerBranchName(FEATURE_ID, CORE)));
    const report = orchestrator(p).settle(CORE, t.capability);
    expect(report.outcome).not.toBe('DONE');
    expect(report.detail).toContain('INTEGRATION_BRANCH_MOVED');
    expect(loadState(p.featureDir)!.data.nodes[CORE]!.state).not.toBe('DONE');
    expect(Object.values(trustedHeads(p))).not.toContain(forged);
  });
});
