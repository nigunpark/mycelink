/**
 * Repair inside the same feature, end to end.
 *
 * A complete three-repository feature is delivered, and the product's own
 * acceptance suite, run by the host on the delivered commits, then fails in
 * one repository. The host attributes the failure to the web node and
 * reworks that node through the controller: the
 * node and everything downstream of it (the candidate build) are reopened
 * with their history kept, the current candidate stops being current, and
 * the node is dispatched again from the current integration state. Fresh
 * verification fences only the repair, a replacement candidate binds every
 * registered repository, and delivery fast-forwards the bases to it. One
 * feature, completed: no follow-up feature id.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { FEATURE_ID, type Portfolio } from '../helpers/portfolio-fixture.js';
import { fakeAgent } from '../helpers/host-agent.js';
import { API, CANDIDATE, CORE, WEB, cli, cliRaw, dispatch, hostLoop, hostPortfolio, settle } from '../helpers/host-loop.js';
import { git } from '../helpers/git-fixture.js';
import { loadState, mutateState } from '../../src/state/feature-state.js';
import { loadCandidate } from '../../src/git/candidate.js';
import { integrationBranchName } from '../../src/git/worktree.js';

afterAll(() => cleanupTmpRoots());

/** The product acceptance check the host runs on the delivered web repository. */
function webAcceptance(p: Portfolio): boolean {
  const body = git(p.app, ['show', 'main:src/view.js']);
  return body.includes('RENDER_JOB_RESULT') && body.includes('ESCAPED');
}

const STRICT_RUNNER = `import { readFileSync } from 'node:fs';
const body = readFileSync('src/view.js', 'utf8');
if (!body.includes('RENDER_JOB_RESULT') || !body.includes('ESCAPED')) {
  console.error('AssertionError: expected src/view.js to render the escaped result');
  process.exit(1);
}
console.log('ok 1 - escaped');
`;

interface Rework {
  node_id: string;
  idempotent: boolean;
  reopened: string[];
  invalidated_candidate: string | null;
}

describe('rework within the same feature', () => {
  let p: Portfolio;
  let firstCandidate: string;

  beforeAll(async () => {
    p = await hostPortfolio();
  });

  it('1. the full feature is delivered, then the product acceptance suite fails in web', async () => {
    const run = await hostLoop(p);
    expect(run.status).toBe('ALL_SETTLED');
    firstCandidate = loadState(p.featureDir)!.data.current_candidate!;
    expect(firstCandidate).toBe(`${FEATURE_ID}-C001`);
    const d = await cli(p, ['deliver', FEATURE_ID, '--json']);
    expect(d.err).toBe('');
    expect(JSON.parse(d.out)).toMatchObject({ status: 'ACCEPTED' });
    expect(loadState(p.featureDir)!.data.feature_state).toBe('COMPLETED');
    expect(webAcceptance(p)).toBe(false);
  });

  it('2. rework is a controller operation and needs a recorded reason', async () => {
    const worker = await cliRaw(p, ['node', 'rework', FEATURE_ID, WEB, '--reason', 'acceptance failed in web']);
    expect(worker.code).not.toBe(0);
    expect(worker.err).toMatch(/CONTROLLER_AUTHORITY/);
    const noReason = await cli(p, ['node', 'rework', FEATURE_ID, WEB]);
    expect(noReason.code).not.toBe(0);
    expect(noReason.err).toContain('REWORK_REASON_REQUIRED');
    expect(loadState(p.featureDir)!.data.nodes[WEB]!.state).toBe('DONE');
  });

  it('3. reworking the attributed node reopens it and its dependents, keeping history', async () => {
    const before = loadState(p.featureDir)!.data;
    const integratedBefore = before.nodes[WEB]!.integrated_sha;
    const r = await cli(p, ['node', 'rework', FEATURE_ID, WEB, '--reason', 'delivery acceptance: web does not escape the rendered result', '--json']);
    expect(r.err).toBe('');
    const report = JSON.parse(r.out) as Rework;
    expect(report).toMatchObject({ node_id: WEB, idempotent: false, invalidated_candidate: firstCandidate });
    expect(report.reopened).toEqual([WEB, CANDIDATE]);

    const s = loadState(p.featureDir)!.data;
    expect(s.current_candidate).toBeNull();
    expect(s.feature_state).toBe('RUNNING');
    expect(s.nodes[CORE]!.state).toBe('DONE');
    expect(s.nodes[API]!.state).toBe('DONE');
    expect(s.nodes[CANDIDATE]!.state).toBe('INVALIDATED');
    const web = s.nodes[WEB]!;
    expect(web.state).toBe('INVALIDATED');
    // The budget is not laundered: the attempt it already used still counts.
    expect(web.attempts).toBe(before.nodes[WEB]!.attempts);
    expect(web.failure_counts).toEqual(before.nodes[WEB]!.failure_counts);
    // The DONE work it replaces is on record.
    expect(web.rework_history).toHaveLength(1);
    expect(web.rework_history![0]).toMatchObject({
      reason: 'delivery acceptance: web does not escape the rendered result',
      integrated_sha: integratedBefore,
      candidate_id: firstCandidate,
    });
    expect(Object.keys(web.rework_history![0]!.evidence).sort()).toEqual(['green', 'red', 'regression']);
    expect(s.reworks).toHaveLength(1);
  });

  it('4. repeating the same rework is idempotent', async () => {
    const r = await cli(p, ['node', 'rework', FEATURE_ID, WEB, '--reason', 'delivery acceptance: web does not escape the rendered result', '--json']);
    expect(r.err).toBe('');
    expect(JSON.parse(r.out)).toMatchObject({ node_id: WEB, idempotent: true });
    const s = loadState(p.featureDir)!.data;
    expect(s.nodes[WEB]!.rework_history).toHaveLength(1);
    expect(s.reworks).toHaveLength(1);
  });

  it('5. the node is dispatched from the current integration state and fenced to the repair', async () => {
    const d = await dispatch(p);
    expect(d.status).toBe('DISPATCHED');
    const t = d.ticket!;
    expect(t.node_id).toBe(WEB);
    const head = git(p.app, ['rev-parse', integrationBranchName(FEATURE_ID)]);
    expect(git(t.worktree!, ['rev-parse', 'HEAD'])).toBe(head);
    expect(loadState(p.featureDir)!.data.nodes[WEB]!.claim!.base_sha).toBe(head);
    // The old branch was archived, not lost.
    expect(git(p.app, ['for-each-ref', '--format=%(refname)', `refs/mycelink/archive/${FEATURE_ID}/`])).toContain('web.render.impl');

    fakeAgent(
      t,
      {
        tests: { 'tests/run.mjs': STRICT_RUNNER },
        impl: { 'src/view.js': 'export const RENDER_JOB_RESULT = true;\nexport const ESCAPED = true;\n' },
      },
      p.control,
    );
    const settled = await settle(p, WEB, t.capability);
    expect(settled).toMatchObject({ outcome: 'DONE' });
  });

  it('6. a replacement candidate binds every registered repository and is delivered', async () => {
    const d = await dispatch(p);
    expect(d.status).toBe('ALL_SETTLED');
    expect(d.controller_reports.map((r) => [r.node_id, r.outcome])).toEqual([[CANDIDATE, 'DONE']]);
    const s = loadState(p.featureDir)!.data;
    expect(s.current_candidate).toBe(`${FEATURE_ID}-C002`);
    const c = loadCandidate(p.featureDir, s.current_candidate!);
    expect(Object.keys(c.repositories).sort()).toEqual(['api', 'core', 'web']);

    const delivered = await cli(p, ['deliver', FEATURE_ID, '--json']);
    expect(delivered.err).toBe('');
    const manifest = JSON.parse(delivered.out) as { status: string; repositories: Record<string, { after: string }> };
    expect(manifest.status).toBe('ACCEPTED');
    for (const [name, repo] of [['core', p.core], ['api', p.api], ['web', p.app]] as const) {
      expect(git(repo, ['rev-parse', 'main'])).toBe(c.repositories[name]!.sha);
      expect(manifest.repositories[name]!.after).toBe(c.repositories[name]!.sha);
    }
  });

  it('7. one complete feature: verify, candidate verify, no other feature', async () => {
    expect((await cli(p, ['feature', 'verify', FEATURE_ID])).code).toBe(0);
    expect((await cli(p, ['candidate', 'verify', FEATURE_ID])).code).toBe(0);
    expect(loadState(p.featureDir)!.data.feature_state).toBe('COMPLETED');
    expect(webAcceptance(p)).toBe(true);
    expect(readdirSync(join(p.control, 'features')).filter((f) => !f.startsWith('.'))).toEqual([FEATURE_ID]);
  });
});

describe('rework refuses what it cannot do safely', () => {
  it('refuses a node that is not DONE, and a parked node (no budget laundering)', async () => {
    const p = await hostPortfolio();
    const notDone = await cli(p, ['node', 'rework', FEATURE_ID, CORE, '--reason', 'not even started']);
    expect(notDone.err).toContain('REWORK_NOT_DONE');
    mutateState(p.featureDir, (s) => {
      s.nodes[CORE]!.state = 'BLOCKED';
      return s;
    });
    const parked = await cli(p, ['node', 'rework', FEATURE_ID, CORE, '--reason', 'try again for free']);
    expect(parked.err).toContain('REWORK_NOT_DONE');
    expect(loadState(p.featureDir)!.data.nodes[CORE]!.state).toBe('BLOCKED');
  });

  it('refuses while a dispatch is in flight, and a controller node as the target', async () => {
    const p = await hostPortfolio();
    const t = (await dispatch(p)).ticket!;
    fakeAgent(t, { impl: { 'src/publish.js': 'export const JOB_RESULT_V2 = true;\n' } }, p.control);
    await settle(p, CORE, t.capability);
    const inFlight = (await dispatch(p)).ticket!;
    expect(inFlight.node_id).toBe(API);
    const r = await cli(p, ['node', 'rework', FEATURE_ID, CORE, '--reason', 'core regressed']);
    expect(r.err).toContain('REWORK_IN_FLIGHT');
    const c = await cli(p, ['node', 'rework', FEATURE_ID, CANDIDATE, '--reason', 'rebuild']);
    expect(c.err).toContain('REWORK_NOT_A_PRODUCER');
    expect(loadState(p.featureDir)!.data.nodes[CORE]!.state).toBe('DONE');
  });

  it('fails closed when a delivered base has moved past the integration branch', async () => {
    const p = await hostPortfolio();
    expect((await hostLoop(p)).status).toBe('ALL_SETTLED');
    expect((await cli(p, ['deliver', FEATURE_ID, '--json'])).code).toBe(0);
    // Someone commits on web's main after the delivery.
    git(p.app, ['commit', '-q', '--allow-empty', '-m', 'hotfix on main']);
    const r = await cli(p, ['node', 'rework', FEATURE_ID, WEB, '--reason', 'acceptance failed in web']);
    expect(r.err).toContain('REWORK_BASE_MOVED');
    const s = loadState(p.featureDir)!.data;
    expect(s.nodes[WEB]!.state).toBe('DONE');
    expect(s.feature_state).toBe('COMPLETED');
    expect(s.current_candidate).toBe(`${FEATURE_ID}-C001`);
  });

  it('a parked downstream node needs a recorded decision, which keeps its history', async () => {
    const p = await hostPortfolio();
    expect((await hostLoop(p)).status).toBe('ALL_SETTLED');
    // The candidate build has since been parked.
    mutateState(p.featureDir, (s) => {
      s.nodes[CANDIDATE]!.state = 'BLOCKED';
      s.nodes[CANDIDATE]!.failure_counts = { 'NO_INTEGRATION_BRANCHES': 2 };
      return s;
    });
    const refused = await cli(p, ['node', 'rework', FEATURE_ID, API, '--reason', 'api contract mismatch']);
    expect(refused.err).toContain('REWORK_PARKED');
    expect(loadState(p.featureDir)!.data.nodes[API]!.state).toBe('DONE');

    await cli(p, ['decision', 'record', FEATURE_ID, 'DEC-rework', '--answer', 'rebuild after the api fix']);
    const ok = await cli(p, ['node', 'rework', FEATURE_ID, API, '--reason', 'api contract mismatch', '--decision', 'DEC-rework', '--json']);
    expect(ok.err).toBe('');
    expect(JSON.parse(ok.out).reopened).toEqual([API, WEB, CANDIDATE]);
    const s = loadState(p.featureDir)!.data;
    expect(s.nodes[CANDIDATE]!.failure_counts).toEqual({ 'NO_INTEGRATION_BRANCHES': 2 });
    expect(s.nodes[WEB]!.state).toBe('INVALIDATED');
    // A decision unblocks once.
    const again = await cli(p, ['decision', 'apply', FEATURE_ID, 'DEC-rework']);
    expect(again.err).toContain('DECISION_ALREADY_APPLIED');
  });

  it('a node may be reworked only a bounded number of times', async () => {
    const p = await hostPortfolio();
    expect((await hostLoop(p)).status).toBe('ALL_SETTLED');
    mutateState(p.featureDir, (s) => {
      s.nodes[WEB]!.rework_history = [1, 2].map((n) => ({
        at: new Date().toISOString(),
        reason: `earlier ${n}`,
        decision_id: null,
        attempts: 1,
        failure_counts: {},
        integrated_sha: null,
        branch_head: null,
        archived_ref: null,
        candidate_id: null,
        evidence: {},
      }));
      return s;
    });
    const r = await cli(p, ['node', 'rework', FEATURE_ID, WEB, '--reason', 'third time']);
    expect(r.err).toContain('REWORK_LIMIT');
  });
});
