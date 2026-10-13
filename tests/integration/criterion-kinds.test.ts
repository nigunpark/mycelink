/**
 * Each criterion is evidenced the way its kind requires.
 *
 * CSET-202 r2: the cli worker treated AC-5 ("everything both commands print,
 * write and return is byte-identical to today") as new behaviour and cited
 * an unrelated test through green as a "thin proxy". The approved criteria
 * carry their kind, and settle holds each one to it:
 *
 *  - new-behavior: a test the node's RED declared and failed for the
 *    missing behaviour (red);
 *  - compatibility: an existing test a gate of the node passed (green or
 *    regression) — one that already guarded the behaviour;
 *  - declaration: the node's GREEN (build, typecheck), with or without a test.
 *
 * A criterion evidenced against its kind is held for correction like any
 * other metadata error; feature verify names every uncovered criterion with
 * its kind.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { canonicalTestId } from '../../src/evidence/test-ids.js';
import { ASSEMBLE, CLI_NODE, ERRORS, READ, SHOP_CRITERIA, SHOP_FEATURE, SHOP_WORK, commitShopControl, createShop, initialisedWithGraph, moduleVerifier, shopCli, shopGraph, shopState, type Shop } from '../helpers/shop-fixture.js';
import { fulfil, type CriterionItem, type ShopTicket } from '../helpers/shop-worker.js';

afterAll(() => cleanupTmpRoots());

const ERRORS_TEST = 'packages/errors/test/errors.test.mjs';
const NEW_TEST = 'ChangesetValidationError sorts the issues and lists one per line';
const OLD_TEST = 'a git error carries its exit code';
const NEW_ID = canonicalTestId('junit-xml', ERRORS_TEST, NEW_TEST);
const OLD_ID = canonicalTestId('junit-xml', ERRORS_TEST, OLD_TEST);

/** The shop graph with a declaration criterion (AC-6) the errors node serves too. */
function graphWithDeclaration(): Record<string, unknown> {
  const g = shopGraph(moduleVerifier()) as { acceptance_criteria: Record<string, unknown>[]; nodes: Record<string, any>[] };
  g.acceptance_criteria.push({ id: 'AC-6', text: 'errors: the issue type is declared beside the error class', kind: 'declaration' });
  g.nodes.find((n) => n['id'] === ERRORS)!['acceptance_criteria'] = ['AC-1', 'AC-6'];
  return g;
}

async function dispatch(s: Shop): Promise<ShopTicket> {
  const d = JSON.parse((await shopCli(s, ['dispatch', SHOP_FEATURE, '--json'])).out) as { status: string; ticket?: ShopTicket };
  expect(d.status).toBe('DISPATCHED');
  return d.ticket!;
}

async function attempt(s: Shop, criteria: CriterionItem[]): Promise<Record<string, any>> {
  const t = await dispatch(s);
  const run = fulfil(t, { ...SHOP_WORK[t.node_id]!, criteria }, s.control);
  expect(run.gates.map((g) => g.code)).toEqual([0, 0, 0]);
  return JSON.parse((await shopCli(s, ['settle', SHOP_FEATURE, t.node_id, '--capability', t.capability, '--json'])).out) as Record<string, any>;
}

describe('kind-specific criterion evidence', () => {
  it('the graph carries each kind, and the ticket and pack name it', async () => {
    const s = await createShop({ modules: 'structured', graph: graphWithDeclaration() });
    const t = await dispatch(s);
    expect(t.acceptance_criteria).toEqual([
      expect.objectContaining({ id: 'AC-1', kind: 'new-behavior' }),
      expect.objectContaining({ id: 'AC-6', kind: 'declaration' }),
    ]);
    expect(t.prompt).toMatch(/AC-1 \(new behavior\), AC-6 \(declaration\)/);
  });

  it('a new behavior named only through green is held for correction: CRITERION_RED_REQUIRED', async () => {
    const s = await createShop({ modules: 'structured', graph: shopGraph(moduleVerifier()) });
    const report = await attempt(s, [{ criterion: 'AC-1', gate: 'green', test_id: NEW_ID }]);
    expect(report).toMatchObject({ outcome: 'EVIDENCE_CORRECTION_REQUIRED' });
    expect(report['detail']).toMatch(/^CRITERION_EVIDENCE_INVALID:CRITERION_RED_REQUIRED: /);
    expect(shopState(s).nodes[ERRORS]).toMatchObject({ attempts: 1, failure_counts: {}, integrated_sha: null });
  });

  it("a new behavior's red test must be one its RED declared and failed: an existing test that passed proves nothing new", async () => {
    const s = await createShop({ modules: 'structured', graph: shopGraph(moduleVerifier()) });
    const report = await attempt(s, [{ criterion: 'AC-1', gate: 'red', test_id: OLD_ID }]);
    expect(report).toMatchObject({ outcome: 'EVIDENCE_CORRECTION_REQUIRED' });
    expect(report['detail']).toMatch(/^CRITERION_EVIDENCE_INVALID:CRITERION_NOT_RUN: /);
  });

  it('a compatibility criterion is proved by an existing test the green gate passed, named by its id', async () => {
    const s = await createShop({ modules: 'structured', graph: shopGraph(moduleVerifier()) });
    expect(await attempt(s, [{ criterion: 'AC-1', gate: 'red', test_id: NEW_ID }])).toMatchObject({ outcome: 'DONE' });
    const readTest = 'packages/read/test/read.test.mjs';
    const report = await attempt(s, [
      { criterion: 'AC-2', gate: 'red', test_id: canonicalTestId('junit-xml', readTest, 'rejects once with an INVALID_FILE issue per unparseable changeset') },
      { criterion: 'AC-5', gate: 'green', test_id: canonicalTestId('junit-xml', readTest, 'reads valid changesets in id order') },
    ]);
    expect(report).toMatchObject({ outcome: 'DONE' });
    expect(shopState(s).nodes[READ].criteria.map((c: { criterion: string; gate: string }) => [c.criterion, c.gate])).toEqual([
      ['AC-2', 'red'],
      ['AC-5', 'green'],
    ]);
  });

  it('a declaration criterion is evidenced by the GREEN alone', async () => {
    const s = await createShop({ modules: 'structured', graph: graphWithDeclaration() });
    const t = await dispatch(s);
    const run = fulfil(t, { ...SHOP_WORK[ERRORS]!, criteria: [{ criterion: 'AC-1', gate: 'red', test_id: NEW_ID }, { criterion: 'AC-6', gate: 'green' }] }, s.control);
    expect(run.result['criterion_evidence']).toEqual([
      { criterion: 'AC-1', test_id: NEW_ID, gate: 'red', output_sha256: run.gates[0]!.sha256 },
      { criterion: 'AC-6', gate: 'green', output_sha256: run.gates[1]!.sha256 },
    ]);
    const report = JSON.parse((await shopCli(s, ['settle', SHOP_FEATURE, ERRORS, '--capability', t.capability, '--json'])).out);
    expect(report).toMatchObject({ outcome: 'DONE' });
    expect(shopState(s).nodes[ERRORS].criteria[1]).toEqual({ criterion: 'AC-6', test_id: null, test: null, gate: 'green', output_sha256: run.gates[1]!.sha256 });
  });

  it('feature verify names every criterion no DONE node evidenced, with its kind', async () => {
    const g = shopGraph(moduleVerifier()) as { acceptance_criteria: Record<string, unknown>[]; nodes: Record<string, any>[] };
    g.acceptance_criteria.push({ id: 'AC-6', text: 'changeset version writes nothing when changesets are invalid', kind: 'compatibility' });
    g.nodes.find((n) => n['node_type'] === 'candidate-build')!['acceptance_criteria'] = ['AC-6'];
    // A feature initialised before every criterion needed a product producer (feature init refuses this graph now).
    const s = await createShop({ modules: 'structured', graph: shopGraph(moduleVerifier()) });
    initialisedWithGraph(s, g);
    for (const id of [ERRORS, READ, ASSEMBLE, CLI_NODE]) {
      const t = await dispatch(s);
      expect(t.node_id).toBe(id);
      fulfil(t, { ...SHOP_WORK[id]!, criteria: SHOP_CRITERIA[id] }, s.control);
      expect(JSON.parse((await shopCli(s, ['settle', SHOP_FEATURE, id, '--capability', t.capability, '--json'])).out)).toMatchObject({ outcome: 'DONE' });
    }
    commitShopControl(s, 'settled');
    const verify = JSON.parse((await shopCli(s, ['feature', 'verify', SHOP_FEATURE, '--json'])).out) as { ok: boolean; problems: string[] };
    expect(verify.ok).toBe(false);
    expect(verify.problems).toEqual(expect.arrayContaining([expect.stringMatching(/^UNCOVERED_ACCEPTANCE_CRITERION: AC-6 \(compatibility\)/)]));
    void readFileSync;
  });
});
