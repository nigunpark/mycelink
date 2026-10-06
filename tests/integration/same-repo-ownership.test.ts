/**
 * Two nodes in one repository, the second depending on the first.
 *
 * The ownership fence of a node is checked against that node's own delta:
 * the exact integration SHA its worktree was created from, pinned in its
 * claim. Work an upstream node already integrated is the base, never part of
 * the dependent's diff, and the dependent's worktree starts from it, so the
 * worker sees the upstream code without merging anything. A change outside
 * the dependent's own fence still fails.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { FEATURE_ID, commitControl, type Portfolio } from '../helpers/portfolio-fixture.js';
import { fakeAgent, type DispatchTicket } from '../helpers/host-agent.js';
import { cli, dispatch, hostPortfolio, settle } from '../helpers/host-loop.js';
import { git } from '../helpers/git-fixture.js';
import { loadState, mutateState } from '../../src/state/feature-state.js';
import { integrationBranchName } from '../../src/git/worktree.js';

afterAll(() => cleanupTmpRoots());

const A = `${FEATURE_ID}.core.publish.impl`;
const B = `${FEATURE_ID}.core.extra.impl`;
const C = `${FEATURE_ID}.core.sibling.impl`;

const budget = { model: 'sonnet', max_turns: 20, max_wall_clock_minutes: 2, max_attempts: 3, nested_delegation: false };

/** A check that fails as a missing behaviour until every marker is in its file. */
function requires(markers: Record<string, string>): string[] {
  const body = Object.entries(markers)
    .map(
      ([file, marker]) =>
        `if(!fs.existsSync(${JSON.stringify(file)})||!fs.readFileSync(${JSON.stringify(file)},'utf8').includes(${JSON.stringify(marker)})){console.error('AssertionError: ${file} lacks ${marker}');process.exit(1);}`,
    )
    .join('');
  return ['node', '-e', `const fs=require('node:fs');${body}console.log('ok');`];
}

function node(id: string, allowed: string[], dependsOn: string[], check: string[], ac: string): Record<string, unknown> {
  return {
    id,
    level: 'executable-node',
    repository: 'core',
    capability: 'CAP-CORE',
    node_type: 'implementation',
    depends_on: dependsOn,
    allowed_paths: allowed,
    forbidden_paths: [],
    contract_inputs: [],
    contract_outputs: [],
    required_resources: [],
    required_evidence: ['red', 'green', 'regression'],
    verification_commands: [{ id: 'targeted', command: check }],
    worker: budget,
    invalidation_rules: [],
    acceptance_criteria: [ac],
  };
}

/** A depends on nothing; B depends on A and needs A's code; C is an independent sibling. */
function sameRepoGraph(withSibling = false): Record<string, unknown> {
  const nodes = [
    node(A, ['src/publish.js'], [], requires({ 'src/publish.js': 'JOB_RESULT_V2' }), 'AC-1'),
    node(B, ['src/extra.js'], [A], requires({ 'src/extra.js': 'EXTRA', 'src/publish.js': 'JOB_RESULT_V2' }), 'AC-2'),
  ];
  if (withSibling) nodes.push(node(C, ['src/sibling.js'], [], requires({ 'src/sibling.js': 'SIBLING' }), 'AC-3'));
  return {
    schema_version: 1,
    feature_id: FEATURE_ID,
    title: 'Same-repository dependency',
    prd: 'PRD.md',
    acceptance_criteria: [
      { id: 'AC-1', text: 'publish' },
      { id: 'AC-2', text: 'extra' },
      ...(withSibling ? [{ id: 'AC-3', text: 'sibling' }] : []),
    ],
    resources: { 'full-runtime': { capacity: 1 } },
    repositories: ['core'],
    capabilities: [{ id: 'CAP-CORE', repository: 'core', title: 'core', acceptance_criteria: withSibling ? ['AC-1', 'AC-2', 'AC-3'] : ['AC-1', 'AC-2'] }],
    nodes,
  };
}

const PUBLISH = { impl: { 'src/publish.js': 'export const JOB_RESULT_V2 = true;\n' } };
const EXTRA = { impl: { 'src/extra.js': 'export const EXTRA = true;\n' } };
const SIBLING = { impl: { 'src/sibling.js': 'export const SIBLING = true;\n' } };

async function next(p: Portfolio, expected: string): Promise<DispatchTicket> {
  const d = await dispatch(p);
  expect(d.status, d.detail).toBe('DISPATCHED');
  expect(d.ticket!.node_id).toBe(expected);
  return d.ticket!;
}

async function runA(p: Portfolio): Promise<void> {
  const t = await next(p, A);
  fakeAgent(t, PUBLISH, p.control);
  expect(await settle(p, A, t.capability)).toMatchObject({ outcome: 'DONE' });
}

describe('same-repository ownership is checked against the node own delta', () => {
  it('B starts from the integration SHA that holds A, pins it, and verifies without owning A', async () => {
    const p = await hostPortfolio(sameRepoGraph());
    await runA(p);
    const integrated = git(p.core, ['rev-parse', integrationBranchName(FEATURE_ID)]);

    const t = await next(p, B);
    // The worktree already holds A's work: nothing to merge.
    expect(git(t.worktree!, ['rev-parse', 'HEAD'])).toBe(integrated);
    const claim = loadState(p.featureDir)!.data.nodes[B]!.claim!;
    expect(claim.base_sha).toBe(integrated);

    fakeAgent(t, EXTRA, p.control);
    const settled = await settle(p, B, t.capability);
    expect(settled).toMatchObject({ outcome: 'DONE' });
    // Integration merged exactly the verified B commit on top of A.
    const head = git(p.core, ['rev-parse', integrationBranchName(FEATURE_ID)]);
    expect(git(p.core, ['show', `${head}:src/extra.js`])).toContain('EXTRA');
    expect(git(p.core, ['show', `${head}:src/publish.js`])).toContain('JOB_RESULT_V2');
  });

  it('a worker that merges the integration branch it already starts from still verifies', async () => {
    const p = await hostPortfolio(sameRepoGraph());
    await runA(p);
    const t = await next(p, B);
    git(t.worktree!, ['merge', '--no-edit', integrationBranchName(FEATURE_ID)]);
    fakeAgent(t, EXTRA, p.control);
    expect(await settle(p, B, t.capability)).toMatchObject({ outcome: 'DONE' });
  });

  it('a change by B outside its own fence still fails as an ownership violation', async () => {
    const p = await hostPortfolio(sameRepoGraph());
    await runA(p);
    const t = await next(p, B);
    fakeAgent(t, { impl: { 'src/extra.js': 'export const EXTRA = true;\n', 'src/publish.js': 'export const JOB_RESULT_V2 = 2;\n' } }, p.control);
    const settled = await settle(p, B, t.capability);
    expect(settled).toMatchObject({ outcome: 'OWNERSHIP_VIOLATION' });
    expect(String(settled['detail'])).toContain('src/publish.js');
    expect(String(settled['detail'])).not.toContain('src/extra.js');
  });

  it('a branch rewritten off its pinned base fails closed', async () => {
    const p = await hostPortfolio(sameRepoGraph());
    await runA(p);
    const t = await next(p, B);
    // Drop A from B's history: the pinned base is no longer an ancestor.
    git(t.worktree!, ['reset', '--hard', 'main']);
    fakeAgent(t, { impl: { 'src/extra.js': 'export const EXTRA = true;\n', 'src/publish.js': 'export const JOB_RESULT_V2 = true;\n' } }, p.control);
    const settled = await settle(p, B, t.capability);
    expect(settled).toMatchObject({ outcome: 'OWNERSHIP_VIOLATION' });
    expect(String(settled['detail'])).toContain('BASE_NOT_ANCESTOR');
  });

  it('the integration branch moving while B is in flight neither leaks into nor blocks B', async () => {
    const p = await hostPortfolio(sameRepoGraph(true));
    await cli(p, ['feature', 'init', FEATURE_ID, '--writer-concurrency', '2']);
    commitControl(p, 'wip 2');
    await runA(p);
    const tb = await next(p, B);
    const pinned = loadState(p.featureDir)!.data.nodes[B]!.claim!.base_sha;
    // The sibling lands while B is still working.
    const tc = await next(p, C);
    fakeAgent(tc, SIBLING, p.control);
    expect(await settle(p, C, tc.capability)).toMatchObject({ outcome: 'DONE' });
    expect(git(p.core, ['rev-parse', integrationBranchName(FEATURE_ID)])).not.toBe(pinned);

    // B merges the moved integration branch (as a real worker did) and
    // still owns only its own file.
    git(tb.worktree!, ['merge', '--no-edit', integrationBranchName(FEATURE_ID)]);
    fakeAgent(tb, EXTRA, p.control);
    expect(await settle(p, B, tb.capability)).toMatchObject({ outcome: 'DONE' });
    const head = git(p.core, ['rev-parse', integrationBranchName(FEATURE_ID)]);
    expect(git(p.core, ['show', `${head}:src/sibling.js`])).toContain('SIBLING');
    expect(git(p.core, ['show', `${head}:src/extra.js`])).toContain('EXTRA');
  });

  it('a commit planted on the integration branch outside the controller is not laundered into B', async () => {
    const p = await hostPortfolio(sameRepoGraph());
    await runA(p);
    const tb = await next(p, B);
    // Someone moves the integration branch by hand; B merges it.
    const integration = join(p.control, '.mycelink', 'integration', `integration__core__${FEATURE_ID}`);
    git(integration, ['checkout', '-q', integrationBranchName(FEATURE_ID)]);
    git(integration, ['-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '--allow-empty', '-m', 'empty']);
    require('node:fs').writeFileSync(join(integration, 'src', 'planted.js'), 'export const PLANTED = 1;\n');
    git(integration, ['add', '-A']);
    git(integration, ['-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-m', 'planted']);
    git(tb.worktree!, ['merge', '--no-edit', integrationBranchName(FEATURE_ID)]);
    fakeAgent(tb, EXTRA, p.control);
    const settled = await settle(p, B, tb.capability);
    expect(settled).toMatchObject({ outcome: 'OWNERSHIP_VIOLATION' });
    expect(String(settled['detail'])).toContain('src/planted.js');
  });

  it('an integration branch moved outside the controller refuses the next claim, charging nothing', async () => {
    const p = await hostPortfolio(sameRepoGraph());
    await runA(p);
    const integration = join(p.control, '.mycelink', 'integration', `integration__core__${FEATURE_ID}`);
    writeFileSync(join(integration, 'src', 'planted.js'), 'export const PLANTED = 1;\n');
    git(integration, ['add', '-A']);
    git(integration, ['commit', '-q', '-m', 'planted']);
    const d = await dispatch(p);
    expect(d.status).toBe('INFRASTRUCTURE_FAILURE');
    expect(d.detail).toContain('INTEGRATION_BRANCH_MOVED');
    expect(loadState(p.featureDir)!.data.nodes[B]).toMatchObject({ state: 'READY', attempts: 0, failure_counts: {} });
  });

  it('an abandoned dispatch reclaimed later keeps the base its branch was created from', async () => {
    const p = await hostPortfolio(sameRepoGraph(true));
    await cli(p, ['feature', 'init', FEATURE_ID, '--writer-concurrency', '2']);
    commitControl(p, 'wip 2');
    await runA(p);
    const first = await next(p, B);
    const pinned = loadState(p.featureDir)!.data.nodes[B]!.claim!.base_sha;
    // B commits work, then its host vanishes.
    fakeAgent(first, { ...EXTRA, omitResult: true }, p.control);

    // The integration branch moves before B is claimed again.
    const tc = await next(p, C);
    fakeAgent(tc, SIBLING, p.control);
    expect(await settle(p, C, tc.capability)).toMatchObject({ outcome: 'DONE' });

    mutateState(p.featureDir, (s) => {
      s.nodes[B]!.claim!.expires_at = new Date(Date.now() - 1000).toISOString();
      return s;
    });
    const rec = JSON.parse((await cli(p, ['session', 'reconcile', FEATURE_ID, '--json'])).out) as { abandoned_dispatches: string[] };
    expect(rec.abandoned_dispatches).toEqual([B]);
    expect(loadState(p.featureDir)!.data.nodes[B]!.branch_base_sha).toBe(pinned);

    const again = await next(p, B);
    // The existing branch (with B's committed work) is reused, at its own base.
    expect(loadState(p.featureDir)!.data.nodes[B]!.claim!.base_sha).toBe(pinned);
    fakeAgent(again, { skipGates: true }, p.control);
    expect(await settle(p, B, again.capability)).toMatchObject({ outcome: 'DONE' });
  });

  it('a resumed dispatch keeps the pinned base', async () => {
    const p = await hostPortfolio(sameRepoGraph());
    await runA(p);
    const lost = await next(p, B);
    const pinned = loadState(p.featureDir)!.data.nodes[B]!.claim!.base_sha;
    const resumed = (await dispatch(p, ['--resume', B])).ticket!;
    expect(resumed.capability).not.toBe(lost.capability);
    expect(loadState(p.featureDir)!.data.nodes[B]!.claim!.base_sha).toBe(pinned);
    fakeAgent(resumed, EXTRA, p.control);
    expect(await settle(p, B, resumed.capability)).toMatchObject({ outcome: 'DONE' });
  });
});
