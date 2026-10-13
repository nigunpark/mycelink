/**
 * Delivery (root cause A9): fast-forward every repository's base branch to
 * exactly the candidate's SHA, all-or-nothing, then run and record final
 * acceptance. Integration used to stop at feature/<id>; nothing ever moved
 * a base branch, so a verified candidate was never actually delivered.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { commitAll, git } from '../helpers/git-fixture.js';
import { FEATURE_ID, type Portfolio } from '../helpers/portfolio-fixture.js';
import { cli, hostLoop, hostPortfolio } from '../helpers/host-loop.js';
import { loadState } from '../../src/state/feature-state.js';
import { loadCandidate } from '../../src/git/candidate.js';
import { resolveRef, runGit } from '../../src/git/git.js';
import { integrationBranchName } from '../../src/git/worktree.js';

afterAll(() => cleanupTmpRoots());

interface DeliveryOut {
  ok: boolean;
  status: string;
  idempotent: boolean;
  candidate_id: string;
  repositories: Record<string, { base_branch: string; before: string; target: string; after: string | null; method: string }>;
  acceptance: { repository: string; exit_code: number; output_path: string }[];
  problems?: string[];
}

function bases(p: Portfolio): Record<string, string> {
  return { core: resolveRef(p.core, 'main'), api: resolveRef(p.api, 'main'), web: resolveRef(p.app, 'main') };
}

async function deliver(p: Portfolio): Promise<{ code: number; out: DeliveryOut | null; err: string }> {
  const r = await cli(p, ['deliver', FEATURE_ID, '--json']);
  return { code: r.code, out: r.out.trim() ? (JSON.parse(r.out) as DeliveryOut) : null, err: r.err };
}

describe('deliver', () => {
  let p: Portfolio;
  beforeEach(async () => {
    p = await hostPortfolio();
    expect((await hostLoop(p)).status).toBe('ALL_SETTLED');
  });

  it('fast-forwards every base branch to exactly the candidate SHA, then records acceptance', async () => {
    const candidate = loadCandidate(p.featureDir, loadState(p.featureDir)!.data.current_candidate!);
    const before = bases(p);
    const r = await deliver(p);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toMatchObject({ ok: true, status: 'ACCEPTED', idempotent: false, candidate_id: candidate.candidate_id });

    const after = bases(p);
    for (const name of ['core', 'api', 'web'] as const) {
      expect(after[name]).toBe(candidate.repositories[name]!.sha);
      expect(r.out!.repositories[name]).toMatchObject({ base_branch: 'main', before: before[name], target: candidate.repositories[name]!.sha, after: after[name] });
    }
    // The user's checkout on main was moved too, not just the ref.
    expect(existsSync(join(p.core, 'src', 'publish.js'))).toBe(true);
    expect(git(p.core, ['status', '--porcelain'])).toBe('');

    expect(r.out!.acceptance.map((a) => [a.repository, a.exit_code])).toEqual([
      ['api', 0],
      ['core', 0],
      ['web', 0],
    ]);
    for (const a of r.out!.acceptance) expect(existsSync(join(p.control, a.output_path))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(p.featureDir, 'deliveries', `${candidate.candidate_id}.json`), 'utf8')) as DeliveryOut;
    expect(manifest.status).toBe('ACCEPTED');
    expect(loadState(p.featureDir)!.data.feature_state).toBe('COMPLETED');
    // Never pushed anywhere.
    expect(runGit(p.core, ['remote']).stdout.trim()).toBe('');
  });

  it('is idempotent: a second deliver changes nothing and re-runs nothing', async () => {
    expect((await deliver(p)).code).toBe(0);
    const first = readFileSync(join(p.featureDir, 'deliveries', `${FEATURE_ID}-C001.json`), 'utf8');
    const again = await deliver(p);
    expect(again.code).toBe(0);
    expect(again.out).toMatchObject({ ok: true, status: 'ACCEPTED', idempotent: true });
    expect(readFileSync(join(p.featureDir, 'deliveries', `${FEATURE_ID}-C001.json`), 'utf8')).toBe(first);
  });

  it('refuses before moving anything when one base checkout is dirty', async () => {
    const before = bases(p);
    writeFileSync(join(p.app, 'scratch.txt'), 'uncommitted');
    const r = await deliver(p);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/DELIVERY_REFUSED/);
    expect(r.err).toMatch(/BASE_CHECKOUT_DIRTY: web/);
    expect(bases(p)).toEqual(before);
  });

  it('refuses a base branch that diverged (no fast-forward), moving nothing', async () => {
    const before = bases(p);
    writeFileSync(join(p.api, 'hotfix.txt'), 'x');
    commitAll(p.api, 'hotfix on main');
    const r = await deliver(p);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/NON_FAST_FORWARD: api/);
    const now = bases(p);
    expect(now.core).toBe(before.core);
    expect(now.web).toBe(before.web);
  });

  it('refuses a candidate that drifted from the repositories', async () => {
    const before = bases(p);
    // A late commit lands on the feature branch, in its integration worktree.
    const wt = join(p.control, '.mycelink', 'integration', `integration__core__${FEATURE_ID}`);
    expect(git(wt, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(integrationBranchName(FEATURE_ID));
    writeFileSync(join(wt, 'late.js'), '1');
    commitAll(wt, 'late change on the feature branch');
    const r = await deliver(p);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/CANDIDATE_DRIFT.*REPOSITORY_SHA_DRIFT/);
    expect(bases(p)).toEqual(before);
  });

  it('rolls back what it moved when a later repository fails mid-delivery, and can resume', async () => {
    const before = bases(p);
    // web's index is locked by "another process": its fast-forward will fail
    // after core and api have already moved.
    const lock = join(p.app, '.git', 'index.lock');
    writeFileSync(lock, '');
    const r = await deliver(p);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/DELIVERY_FAILED/);
    expect(bases(p)).toEqual(before);
    const manifest = JSON.parse(readFileSync(join(p.featureDir, 'deliveries', `${FEATURE_ID}-C001.json`), 'utf8')) as DeliveryOut;
    expect(manifest.status).toBe('ROLLED_BACK');

    rmSync(lock);
    const resumed = await deliver(p);
    expect(resumed.code).toBe(0);
    expect(resumed.out?.status).toBe('ACCEPTED');
  });

  it('resumes an interrupted delivery where some bases already moved', async () => {
    const candidate = loadCandidate(p.featureDir, `${FEATURE_ID}-C001`);
    git(p.core, ['merge', '--ff-only', '-q', candidate.repositories['core']!.sha]);
    const r = await deliver(p);
    expect(r.code).toBe(0);
    expect(r.out!.repositories['core']!.method).toBe('already-delivered');
    expect(bases(p).api).toBe(candidate.repositories['api']!.sha);
  });

  it('refuses a feature that is not verified', async () => {
    const before = bases(p);
    const { mutateState } = await import('../../src/state/feature-state.js');
    mutateState(p.featureDir, (s) => {
      s.nodes[`${FEATURE_ID}.web.render.impl`]!.state = 'REGRESSION_VERIFIED';
      return s;
    });
    const r = await deliver(p);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/FEATURE_NOT_VERIFIED.*NODE_NOT_DONE/);
    expect(bases(p)).toEqual(before);
  });

  it('is a controller operation', async () => {
    const r = await cli(p, ['deliver', FEATURE_ID, '--capability', 'a'.repeat(64)]);
    expect(r.err).toMatch(/ROLE_DENIED/);
  });
});
