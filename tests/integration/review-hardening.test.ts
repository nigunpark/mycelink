/**
 * Follow-ups from the independent review of the rework tranche.
 *
 * - The integration branch is trusted only at the head the controller
 *   recorded (the newest integrated_sha in that repository, or the base
 *   branch when nothing was integrated): a new worker branch, an
 *   integration and a candidate all refuse a branch moved any other way,
 *   including a foreign feature/<id> branch in a repository no node touches.
 * - A rework retried after a crash still consumes its decision.
 * - A superseded feature is never reworked or dispatched.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { FEATURE_ID, commitControl } from '../helpers/portfolio-fixture.js';
import { fakeAgent } from '../helpers/host-agent.js';
import { API, CANDIDATE, CORE, WEB, WORK, cli, dispatch, hostGraph, hostLoop, hostPortfolio, settle } from '../helpers/host-loop.js';
import { commitAll, git } from '../helpers/git-fixture.js';
import { loadState, mutateState } from '../../src/state/feature-state.js';
import { featurePaths } from '../../src/workspace/paths.js';
import { integrationBranchName } from '../../src/git/worktree.js';

afterAll(() => cleanupTmpRoots());

const BRANCH = integrationBranchName(FEATURE_ID);

describe('the integration branch is trusted only where the controller left it', () => {
  it('a candidate refuses an integration branch moved outside the controller', async () => {
    const p = await hostPortfolio();
    const t = (await dispatch(p)).ticket!;
    fakeAgent(t, WORK[CORE]!, p.control);
    expect(await settle(p, CORE, t.capability)).toMatchObject({ outcome: 'DONE' });
    // A same-user process moves core's integration branch onto a planted commit.
    const integration = join(p.control, '.mycelink', 'integration', `integration__core__${FEATURE_ID}`);
    writeFileSync(join(integration, 'src', 'planted.js'), 'export const PLANTED = 1;\n');
    commitAll(integration, 'planted');
    const d = await dispatch(p);
    // api is next (another repository): its claim is unaffected.
    expect(d.ticket?.node_id).toBe(API);
    fakeAgent(d.ticket!, WORK[API]!, p.control);
    await settle(p, API, d.ticket!.capability);
    const w = (await dispatch(p)).ticket!;
    fakeAgent(w, WORK[WEB]!, p.control);
    await settle(p, WEB, w.capability);
    // The candidate refuses to bind the moved branch.
    const c = await dispatch(p);
    expect(c.status).not.toBe('ALL_SETTLED');
    expect(c.detail).toContain('INTEGRATION_BRANCH_MOVED');
    expect(loadState(p.featureDir)!.data.current_candidate).toBeNull();
  });

  it('a foreign feature branch in a repository no node touches is not bound', async () => {
    const graph = hostGraph() as { nodes: { id: string; depends_on: string[] }[]; repositories: string[] };
    // web has no node: drop it and everything depending on it.
    graph.nodes = graph.nodes.filter((n) => n.id !== WEB).map((n) => ({ ...n, depends_on: n.depends_on.filter((d) => d !== WEB) }));
    (graph as unknown as { capabilities: { repository: string }[] }).capabilities = (graph as unknown as { capabilities: { repository: string }[] }).capabilities.filter((c) => c.repository !== 'web');
    (graph as unknown as { acceptance_criteria: { id: string }[] }).acceptance_criteria = (graph as unknown as { acceptance_criteria: { id: string }[] }).acceptance_criteria.filter((a) => a.id !== 'AC-3');
    graph.repositories = graph.repositories.filter((r) => r !== 'web');
    const p = await hostPortfolio(graph as unknown as Record<string, unknown>);
    // Someone already has a feature/FEAT-901 branch in web with other work.
    git(p.app, ['checkout', '-q', '-b', BRANCH]);
    writeFileSync(join(p.app, 'src', 'foreign.js'), 'export const FOREIGN = 1;\n');
    commitAll(p.app, 'foreign');
    git(p.app, ['checkout', '-q', 'main']);
    const run = await hostLoop(p);
    expect(run.status).not.toBe('ALL_SETTLED');
    expect(loadState(p.featureDir)!.data.current_candidate).toBeNull();
    const r = await cli(p, ['candidate', 'create', FEATURE_ID]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('INTEGRATION_BRANCH_MOVED');
  });
});

describe('rework and supersede edge cases', () => {
  it('a rework retried after a crash still consumes its decision', async () => {
    const p = await hostPortfolio();
    expect((await hostLoop(p)).status).toBe('ALL_SETTLED');
    mutateState(p.featureDir, (s) => {
      s.nodes[CANDIDATE]!.state = 'BLOCKED';
      return s;
    });
    await cli(p, ['decision', 'record', FEATURE_ID, 'DEC-r', '--answer', 'rebuild']);
    expect((await cli(p, ['node', 'rework', FEATURE_ID, API, '--reason', 'api wrong', '--decision', 'DEC-r'])).code).toBe(0);
    // The crash: STATE.json was written, the decision.applied event was not.
    const events = featurePaths(p.control, FEATURE_ID).events;
    const kept = readFileSync(events, 'utf8')
      .split('\n')
      .filter((l) => !(l.includes('"decision.applied"') && l.includes('DEC-r')))
      .join('\n');
    writeFileSync(events, kept);
    const retry = await cli(p, ['node', 'rework', FEATURE_ID, API, '--reason', 'api wrong', '--decision', 'DEC-r', '--json']);
    expect(JSON.parse(retry.out)).toMatchObject({ idempotent: true });
    expect((await cli(p, ['decision', 'apply', FEATURE_ID, 'DEC-r'])).err).toContain('DECISION_ALREADY_APPLIED');
  });

  it('a superseded feature, even a completed one, is never reworked or dispatched', async () => {
    const p = await hostPortfolio();
    expect((await hostLoop(p)).status).toBe('ALL_SETTLED');
    expect((await cli(p, ['deliver', FEATURE_ID, '--json'])).code).toBe(0);
    const dir = join(p.control, 'features', 'FEAT-902');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'PRD.md'), '# FEAT-902\n');
    writeFileSync(join(dir, 'PORTFOLIO-GRAPH.yaml'), YAML.stringify(JSON.parse(JSON.stringify(hostGraph()).replaceAll(FEATURE_ID, 'FEAT-902')), { lineWidth: 0 }));
    expect((await cli(p, ['feature', 'init', 'FEAT-902'])).err).toBe('');
    commitControl(p, 'next');
    expect((await cli(p, ['feature', 'supersede', FEATURE_ID, '--by', 'FEAT-902', '--reason', 'replaced'])).code).toBe(0);
    expect(loadState(p.featureDir)!.data.feature_state).toBe('COMPLETED');
    const r = await cli(p, ['node', 'rework', FEATURE_ID, WEB, '--reason', 'late defect']);
    expect(r.err).toContain('REWORK_FEATURE_STOPPED');
    expect((await dispatch(p)).status).toBe('CANCELLED');
  });
});
