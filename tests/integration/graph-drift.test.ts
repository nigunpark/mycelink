/**
 * A graph is immutable once its feature is initialised: STATE.json records
 * the hash it was created for. dispatch, claim and a resumed dispatch fail
 * fast on a graph that no longer hashes to it, before anything is claimed,
 * set up or handed to a worker (feature verify already refused it; the
 * dispatch path did not, and ran whatever the edited YAML said).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { afterAll, describe, expect, it } from 'vitest';
import { SETUP_FEATURE, TYPES, cliAt, commitControlRepo, featureState, setupPortfolio, setupRuns, type SetupPortfolio } from '../helpers/setup-fixture.js';
import { cleanupTmpRoots } from '../helpers/tmp.js';

afterAll(() => cleanupTmpRoots());

function editGraph(p: SetupPortfolio, edit: (g: { nodes: Record<string, any>[] }) => void): string {
  const file = join(p.featureDir, 'PORTFOLIO-GRAPH.yaml');
  const before = readFileSync(file, 'utf8');
  const graph = YAML.parse(before);
  edit(graph);
  writeFileSync(file, YAML.stringify(graph, { lineWidth: 0 }));
  commitControlRepo(p, 'edit the graph after feature init');
  return before;
}

describe('graph drift', () => {
  it('stops dispatch before it claims or sets up anything, and dispatches again once the graph is back', async () => {
    const p = await setupPortfolio();
    const original = editGraph(p, (g) => {
      const types = g.nodes.find((n) => n.id === TYPES) as Record<string, any>;
      types.verification_commands = [{ id: 'build-and-test', command: ['node', '-e', 'process.exit(0)'] }];
    });
    const r = await cliAt(p.control, ['dispatch', SETUP_FEATURE, '--json']);
    const d = JSON.parse(r.out);
    expect(d.status).toBe('PRECONDITION_FAILED');
    expect(d.detail).toMatch(/GRAPH_DRIFT/);
    expect(d.ticket).toBeUndefined();
    const state = featureState(p);
    for (const rt of Object.values(state.nodes) as { claim: unknown; attempts: number }[]) {
      expect(rt.claim).toBeNull();
      expect(rt.attempts).toBe(0);
    }
    expect(setupRuns(p)).toEqual([]);
    expect(existsSync(join(p.control, '.mycelink', 'worktrees', `app__${TYPES}`))).toBe(false);

    // node claim refuses it too.
    const claim = await cliAt(p.control, ['node', 'claim', SETUP_FEATURE, TYPES, '--json']);
    expect(claim.code).not.toBe(0);
    expect(claim.err).toMatch(/GRAPH_DRIFT/);

    writeFileSync(join(p.featureDir, 'PORTFOLIO-GRAPH.yaml'), original);
    commitControlRepo(p, 'restore the graph');
    const again = JSON.parse((await cliAt(p.control, ['dispatch', SETUP_FEATURE, '--json'])).out);
    expect(again.status).toBe('DISPATCHED');
  });

  it('refuses to re-issue a dispatched ticket under a drifted graph', async () => {
    const p = await setupPortfolio();
    const first = JSON.parse((await cliAt(p.control, ['dispatch', SETUP_FEATURE, '--json'])).out);
    expect(first.status).toBe('DISPATCHED');
    editGraph(p, (g) => {
      (g.nodes.find((n) => n.id === TYPES) as Record<string, any>).allowed_paths = ['**'];
    });
    const resumed = await cliAt(p.control, ['dispatch', SETUP_FEATURE, '--resume', TYPES, '--json']);
    const out = resumed.out.trim() === '' ? { status: 'ERROR', detail: resumed.err } : JSON.parse(resumed.out);
    expect(out.status === 'PRECONDITION_FAILED' || resumed.code !== 0).toBe(true);
    expect(`${out.detail ?? ''}${resumed.err}`).toMatch(/GRAPH_DRIFT/);
  });
});
