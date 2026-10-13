/**
 * A declaration-only node: no red gate, because what it changes carries no
 * runtime test (CSET-201's types node, packages/types/src/index.ts). It may
 * have no RED and no test commit, but it must commit its change alone,
 * production files only, and pass GREEN (build/typecheck) and regression.
 * Settle accepts that history only inside the declaration paths its claim
 * binds: a no-RED node is not a way around TDD.
 */
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { fakeAgent, type DispatchTicket } from '../helpers/host-agent.js';
import { SETUP_FEATURE, SETUP_WORK, TYPES, cliAt, featureState, setupGraph, setupPortfolio, type SetupPortfolio } from '../helpers/setup-fixture.js';
import { cleanupTmpRoots } from '../helpers/tmp.js';

afterAll(() => cleanupTmpRoots());

async function dispatchTicket(p: SetupPortfolio): Promise<DispatchTicket & { context_pack_path: string }> {
  const r = await cliAt(p.control, ['dispatch', SETUP_FEATURE, '--json']);
  expect(r.err).toBe('');
  const d = JSON.parse(r.out);
  expect(d.status, d.detail).toBe('DISPATCHED');
  return d.ticket;
}

async function settle(p: SetupPortfolio, t: DispatchTicket): Promise<{ outcome: string; detail: string }> {
  const r = await cliAt(p.control, ['settle', SETUP_FEATURE, t.node_id, '--capability', t.capability, '--json']);
  expect(r.err).toBe('');
  return JSON.parse(r.out);
}

describe('a declaration-only node', () => {
  it('is told what it may commit: the declaration change alone, inside its declaration paths, then green and regression', async () => {
    const p = await setupPortfolio();
    const t = await dispatchTicket(p);
    expect(t.node_id).toBe(TYPES);
    expect(t.gate_commands.map((g) => g.gate)).toEqual(['green', 'regression']);
    const pack = JSON.parse(readFileSync(t.context_pack_path, 'utf8'));
    expect(pack.tdd).toMatchObject({ require_red: false, declaration_paths: ['src/types/**'] });
    expect(t.prompt).toMatch(/Declaration-only node: this node has no red gate/);
    expect(t.prompt).toContain('src/types/**');
  });

  it('settles from one production-only commit inside the claim-bound declaration paths', async () => {
    const p = await setupPortfolio();
    const t = await dispatchTicket(p);
    const run = fakeAgent(t, SETUP_WORK[TYPES], p.control);
    expect(run.gates).toEqual([
      { gate: 'green', exit: 0 },
      { gate: 'regression', exit: 0 },
    ]);
    expect(run.commits.map((c) => c.kind)).toEqual(['production']);
    const s = await settle(p, t);
    expect(s.outcome, s.detail).toBe('DONE');
    expect(featureState(p).nodes[TYPES].tdd_history).toMatchObject({ ok: true, cycles: 0, code: null });
  });

  it('is refused when its claim binds no declaration paths', async () => {
    const p = await setupPortfolio({ declarationPaths: null });
    const t = await dispatchTicket(p);
    expect(t.prompt).toMatch(/binds no declaration paths/);
    fakeAgent(t, SETUP_WORK[TYPES], p.control);
    const s = await settle(p, t);
    expect(s.outcome).toBe('TDD_HISTORY_INVALID');
    expect(s.detail).toMatch(/TDD_HISTORY_INVALID:DECLARATION_PATHS_UNBOUND/);
    expect(featureState(p).nodes[TYPES].state).not.toBe('DONE');
  });

  it('is refused when it changes runtime code beside its declarations: that needs a RED', async () => {
    const graph = setupGraph() as { nodes: Record<string, unknown>[] };
    graph.nodes = graph.nodes.map((n) => (n['id'] === TYPES ? { ...n, allowed_paths: ['src/types/**', 'src/runtime/**'] } : n));
    const p = await setupPortfolio({ graph });
    const t = await dispatchTicket(p);
    fakeAgent(t, { impl: { ...SETUP_WORK[TYPES].impl, 'src/runtime/reasons.js': 'export const reasons = [];\n' } }, p.control);
    const s = await settle(p, t);
    expect(s.outcome).toBe('TDD_HISTORY_INVALID');
    expect(s.detail).toMatch(/NOT_DECLARATION_ONLY: .*src\/runtime\/reasons\.js/);
  });
});
