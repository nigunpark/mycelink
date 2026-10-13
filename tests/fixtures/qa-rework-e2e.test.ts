/**
 * QA's report on a delivered feature, repaired through the controller.
 *
 * PCM-103 pilot, with-faults arm: the task's controller reworked its
 * producer node twice on its own review before the first candidate, then
 * delivered C001. A late defect landed on main and QA reported it to a fresh
 * session, which recovered the key, ran `feature status` and `feature
 * owners --since-delivery` and asked for `node rework` of that node: refused
 * with REWORK_LIMIT, because the two pre-delivery reworks were counted
 * against a failure that only appeared after the delivery was accepted. The
 * session rightly did not work around the guard, and the run failed with a
 * stale C001.
 *
 * The limit bounds reworks between accepted deliveries: an accepted
 * delivery starts the count again (a tampered manifest does not), and
 * within one delivery the node is still reworked at most max_same_failure
 * times. `feature rework` is the deterministic QA entry: it attributes the
 * report to the producer nodes owning what changed since the delivery (or,
 * failing that, the single producer of the named acceptance criteria) and
 * reworks each with the report as its reason, dependents first so each
 * owner keeps its own brief; it refuses an ambiguous or unowned report and
 * repeating it changes nothing.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { FEATURE_ID, type Portfolio } from '../helpers/portfolio-fixture.js';
import { API, CANDIDATE, CORE, WEB, cli, cliRaw, dispatch, hostGraph, hostLoop, hostPortfolio, settle, testFile } from '../helpers/host-loop.js';
import { fakeAgent } from '../helpers/host-agent.js';
import { git } from '../helpers/git-fixture.js';
import { loadState, mutateState } from '../../src/state/feature-state.js';
import type { ReworkHistoryEntry } from '../../src/model/types.js';

afterAll(() => cleanupTmpRoots());

const REASON = 'QA on the delivered commit: renders the job result: expected RENDER_JOB_RESULT in src/view.js';

const earlier = (n: number, at: string): ReworkHistoryEntry => ({
  at,
  reason: `own review ${n}`,
  decision_id: null,
  attempts: 1,
  failure_counts: {},
  integrated_sha: null,
  branch_head: null,
  archived_ref: null,
  candidate_id: null,
  evidence: {},
});

/** Settled, `node` reworked `before` times ahead of the delivery, delivered (C001 accepted), then web's main moved by someone else. */
async function delivered(before: number, node = WEB): Promise<{ p: Portfolio; moved: string }> {
  const p = await hostPortfolio();
  expect((await hostLoop(p)).status).toBe('ALL_SETTLED');
  if (before > 0) {
    mutateState(p.featureDir, (s) => {
      s.nodes[node]!.rework_history = Array.from({ length: before }, (_, i) => earlier(i + 1, new Date(Date.now() - 60_000).toISOString()));
      return s;
    });
  }
  const d = await cli(p, ['deliver', FEATURE_ID, '--json']);
  expect(JSON.parse(d.out)).toMatchObject({ status: 'ACCEPTED' });
  writeFileSync(join(p.app, 'src', 'view.js'), 'export const VIEW = 1;\n');
  git(p.app, ['commit', '-q', '-am', 'chore: sync platform changes']);
  return { p, moved: git(p.app, ['rev-parse', 'main']) };
}

describe('the rework limit counts reworks since the last accepted delivery', () => {
  it('a node reworked to the limit before its delivery is reworked again for what QA reports after it (PCM-103)', async () => {
    const { p, moved } = await delivered(2);
    const r = await cli(p, ['node', 'rework', FEATURE_ID, WEB, '--reason', REASON, '--json']);
    expect(r.err).toBe('');
    expect(JSON.parse(r.out)).toMatchObject({ node_id: WEB, idempotent: false, invalidated_candidate: `${FEATURE_ID}-C001`, delivered: true });
    const s = loadState(p.featureDir)!.data;
    // Lifetime history and generations carry on; only the limit's count started again.
    expect(s.nodes[WEB]!.rework_history!.map((e) => e.reason)).toEqual(['own review 1', 'own review 2', REASON]);
    expect(s.nodes[WEB]!.rework_brief).toMatchObject({ generation: 3, limit: 2, reason: REASON });
    expect(s.integration_heads!['web']).toBe(moved);
  });

  it('within one delivery the node is still reworked at most max_same_failure times', async () => {
    const { p } = await delivered(0);
    // Two reworks since the delivery, as if two repairs had already been made and settled.
    mutateState(p.featureDir, (s) => {
      s.nodes[WEB]!.rework_history = [1, 2].map((n) => earlier(n, new Date(Date.now() + 1000).toISOString()));
      return s;
    });
    const r = await cli(p, ['node', 'rework', FEATURE_ID, WEB, '--reason', REASON]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/REWORK_LIMIT: .* 2 time\(s\) since the last accepted delivery/);
    expect(loadState(p.featureDir)!.data.nodes[WEB]!.state).toBe('DONE');
  });

  it('a delivery manifest that is not the one acceptance pinned starts nothing again', async () => {
    const { p } = await delivered(2);
    const manifest = join(p.featureDir, 'deliveries', `${FEATURE_ID}-C001.json`);
    const doc = JSON.parse(readFileSync(manifest, 'utf8'));
    writeFileSync(manifest, JSON.stringify({ ...doc, accepted_at: new Date(Date.now() - 3_600_000).toISOString() }, null, 2));
    const r = await cli(p, ['node', 'rework', FEATURE_ID, WEB, '--reason', REASON]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/REWORK_LIMIT/);
  });
});

describe('feature rework: QA’s report, attributed and reworked in one controller step', () => {
  const REPAIR = {
    tests: { 'tests/rendering.test.mjs': testFile('renders the job result again') },
    impl: { 'src/view.js': 'export const RENDER_JOB_RESULT = true;\n' },
  };

  it('is a controller command', async () => {
    const { p } = await delivered(0);
    const r = await cliRaw(p, ['feature', 'rework', FEATURE_ID, '--since-delivery', '--reason', REASON]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/authority/i);
    expect(loadState(p.featureDir)!.data.nodes[WEB]!.state).toBe('DONE');
  });

  it('reworks the producer of what moved since the delivery with QA’s report, and the repair is delivered as C002', async () => {
    const { p, moved } = await delivered(2);
    const r = await cli(p, ['feature', 'rework', FEATURE_ID, '--since-delivery', '--acceptance', 'AC-3', '--reason', REASON, '--json']);
    expect(r.err).toBe('');
    const report = JSON.parse(r.out);
    expect(report).toMatchObject({ feature_id: FEATURE_ID, targets: [WEB], idempotent: false, next: 'dispatch' });
    expect(report.attribution).toEqual({ by: 'paths', paths: ['web:src/view.js'], acceptance: ['AC-3'] });
    expect(report.reworks.map((x: any) => [x.node_id, x.reopened])).toEqual([[WEB, [WEB, CANDIDATE]]]);
    const s = loadState(p.featureDir)!.data;
    expect(s.nodes[WEB]!.rework_brief).toMatchObject({ reason: REASON });
    expect(s.integration_heads!['web']).toBe(moved);

    // Repeating it changes nothing: the same rework, still waiting for its dispatch.
    const again = JSON.parse((await cli(p, ['feature', 'rework', FEATURE_ID, '--since-delivery', '--acceptance', 'AC-3', '--reason', REASON, '--json'])).out);
    expect(again).toMatchObject({ targets: [WEB], idempotent: true });
    expect(loadState(p.featureDir)!.data.reworks!.length).toBe(1);

    // Then the normal host loop: the producer is dispatched from the moved base with the brief, and C002 delivered.
    const d = await dispatch(p);
    expect(d.ticket!.node_id).toBe(WEB);
    expect(git(d.ticket!.worktree!, ['rev-parse', 'HEAD'])).toBe(moved);
    fakeAgent(d.ticket!, REPAIR, p.control);
    expect(await settle(p, WEB, d.ticket!.capability)).toMatchObject({ outcome: 'DONE' });
    expect((await dispatch(p)).status).toBe('ALL_SETTLED');
    const delivery = JSON.parse((await cli(p, ['deliver', FEATURE_ID, '--json'])).out);
    expect(delivery).toMatchObject({ status: 'ACCEPTED', candidate_id: `${FEATURE_ID}-C002` });
    expect((await cli(p, ['feature', 'verify', FEATURE_ID, '--delivered'])).code).toBe(0);
  });

  it('reworks every producer owning a moved path, dependents first, so each keeps its own brief', async () => {
    const { p } = await delivered(0);
    writeFileSync(join(p.core, 'src', 'publish.js'), 'export const PUBLISH = 1;\n');
    git(p.core, ['commit', '-q', '-am', 'chore: sync platform changes']);
    const r = await cli(p, ['feature', 'rework', FEATURE_ID, '--since-delivery', '--reason', REASON, '--json']);
    expect(r.err).toBe('');
    expect(JSON.parse(r.out).targets).toEqual([WEB, CORE]);
    const s = loadState(p.featureDir)!.data;
    for (const id of [WEB, CORE]) expect(s.nodes[id]!.rework_brief, id).toMatchObject({ reason: REASON });
    expect(s.nodes[API]!.state).toBe('INVALIDATED');
    expect(s.nodes[API]!.rework_brief ?? null).toBeNull();
  });

  it('without a moved path, attributes to the single producer of the named acceptance criteria', async () => {
    const p = await hostPortfolio();
    expect((await hostLoop(p)).status).toBe('ALL_SETTLED');
    expect(JSON.parse((await cli(p, ['deliver', FEATURE_ID, '--json'])).out)).toMatchObject({ status: 'ACCEPTED' });
    const r = await cli(p, ['feature', 'rework', FEATURE_ID, '--since-delivery', '--acceptance', 'AC-2', '--reason', REASON, '--json']);
    expect(r.err).toBe('');
    expect(JSON.parse(r.out)).toMatchObject({ targets: [API], attribution: { by: 'acceptance', paths: [], acceptance: ['AC-2'] } });
  });

  it('a module directory QA names (`<repository>:<dir>/`) is owned by the producers whose allowed paths lie in it', async () => {
    // A file-level fence: no glob of web's matches the directory itself.
    const graph = hostGraph() as { nodes: { id: string; allowed_paths: string[] }[] };
    graph.nodes.find((n) => n.id === WEB)!.allowed_paths = ['src/view.js', 'tests/**'];
    const p = await hostPortfolio(graph);
    expect((await hostLoop(p)).status).toBe('ALL_SETTLED');
    expect(JSON.parse((await cli(p, ['deliver', FEATURE_ID, '--json'])).out)).toMatchObject({ status: 'ACCEPTED' });
    const owners = JSON.parse((await cliRaw(p, ['feature', 'owners', FEATURE_ID, 'web:src/', 'core:docs/', '--json'])).out);
    expect(owners.owners.map((o: any) => [o.node_id, o.paths])).toEqual([[WEB, ['web:src/']]]);
    expect(owners.unowned).toEqual(['core:docs/']);
    const r = await cli(p, ['feature', 'rework', FEATURE_ID, '--since-delivery', 'web:src/', '--reason', REASON, '--json']);
    expect(r.err).toBe('');
    expect(JSON.parse(r.out)).toMatchObject({ targets: [WEB], attribution: { by: 'paths', paths: ['web:src/'] } });
  });

  it('refuses an ambiguous or unowned report, changing nothing', async () => {
    const p = await hostPortfolio();
    expect((await hostLoop(p)).status).toBe('ALL_SETTLED');
    expect(JSON.parse((await cli(p, ['deliver', FEATURE_ID, '--json'])).out)).toMatchObject({ status: 'ACCEPTED' });
    const state = readFileSync(join(p.featureDir, 'STATE.json'), 'utf8');
    const ambiguous = await cli(p, ['feature', 'rework', FEATURE_ID, '--acceptance', 'AC-1,AC-2', '--reason', REASON]);
    expect(ambiguous.code).not.toBe(0);
    expect(ambiguous.err).toMatch(new RegExp(`REWORK_OWNER_AMBIGUOUS: .*${CORE}.*${API}.*node rework`));
    const unowned = await cli(p, ['feature', 'rework', FEATURE_ID, 'docs/notes.md', '--reason', REASON]);
    expect(unowned.code).not.toBe(0);
    expect(unowned.err).toMatch(/REWORK_OWNER_UNKNOWN: .*docs\/notes\.md/);
    const nothing = await cli(p, ['feature', 'rework', FEATURE_ID, '--since-delivery', '--reason', REASON]);
    expect(nothing.code).not.toBe(0);
    expect(nothing.err).toMatch(/REWORK_OWNER_UNKNOWN/);
    const noReason = await cli(p, ['feature', 'rework', FEATURE_ID, '--acceptance', 'AC-2']);
    expect(noReason.err).toMatch(/REWORK_REASON_REQUIRED/);
    expect(readFileSync(join(p.featureDir, 'STATE.json'), 'utf8')).toBe(state);
  });
});
