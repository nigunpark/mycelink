/**
 * Every acceptance criterion a node serves is named, with evidence.
 *
 * CSET-202 r1 with-normal delivered four DONE nodes whose own tests passed,
 * yet hidden acceptance found aggregated parse errors, the shared error
 * identity and the CLI's status/version reporting missing: nothing tied a
 * criterion to a test that proved it. A worker's result now maps each of its
 * node's criteria to a named test, the gate that ran it and that gate's
 * output hash. Settle checks, before anything is integrated: every assigned
 * criterion covered, none claimed for another node, no duplicates; the test
 * declared in the node's module at the submitted head; the hash that of the
 * gate's recorded evidence, its output on disk; the gate actually ran the
 * test (a RED failing it for a missing behaviour, a GREEN or regression
 * passing it); a new-behaviour criterion proved by a RED, a compatibility
 * one by any gate. Candidate verify and delivery refuse a feature whose
 * criteria are not all covered. Coverage, not proof of semantics.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { canonicalTestId } from '../../src/evidence/test-ids.js';
import {
  ASSEMBLE,
  CLI_NODE,
  ERRORS,
  READ,
  SHOP_CRITERIA,
  SHOP_FEATURE,
  SHOP_WORK,
  commitShopControl,
  createShop,
  initialisedWithGraph,
  moduleVerifier,
  shopCli,
  shopGraph,
  shopState,
  type Shop,
} from '../helpers/shop-fixture.js';
import { fulfil, type CriterionItem, type ShopTicket } from '../helpers/shop-worker.js';

afterAll(() => cleanupTmpRoots());

async function next(s: Shop): Promise<{ status: string; ticket?: ShopTicket }> {
  const d = await shopCli(s, ['dispatch', SHOP_FEATURE, '--json']);
  expect(d.err).toBe('');
  return JSON.parse(d.out) as { status: string; ticket?: ShopTicket };
}

async function settle(s: Shop, t: ShopTicket): Promise<Record<string, unknown>> {
  return JSON.parse((await shopCli(s, ['settle', SHOP_FEATURE, t.node_id, '--capability', t.capability, '--json'])).out) as Record<string, unknown>;
}

async function attempt(s: Shop, criteria: CriterionItem[] | null, extra: { criterionEvidence?: unknown } = {}): Promise<Record<string, unknown>> {
  const d = await next(s);
  const t = d.ticket!;
  const run = fulfil(t, { ...SHOP_WORK[t.node_id]!, criteria: criteria ?? SHOP_CRITERIA[t.node_id], ...extra }, s.control);
  expect(run.gates.every((g) => g.code === 0), JSON.stringify(run.gates.map((g) => [g.gate, g.code, g.out.slice(-300)]))).toBe(true);
  return settle(s, t);
}

const shop = () => createShop({ modules: 'structured', graph: shopGraph(moduleVerifier()) });
const RED = SHOP_CRITERIA[ERRORS]![0]!;

describe('criterion evidence at settle', () => {
  it('accepts each criterion mapped to its RED test, records the coverage, and names the criteria in the ticket and pack', async () => {
    const s = await shop();
    const d = await next(s);
    expect(d.ticket!.acceptance_criteria).toEqual([{ id: 'AC-1', kind: 'new-behavior', text: expect.any(String), sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
    expect(d.ticket!.prompt).toMatch(/criterion_evidence/);
    const run = fulfil(d.ticket!, { ...SHOP_WORK[ERRORS]!, criteria: SHOP_CRITERIA[ERRORS] }, s.control);
    expect(await settle(s, d.ticket!)).toMatchObject({ outcome: 'DONE' });
    expect(shopState(s).nodes[ERRORS].criteria).toEqual([
      { criterion: 'AC-1', test_id: canonicalTestId('junit-xml', RED.path!, RED.name!), test: { path: RED.path, name: RED.name }, gate: 'red', output_sha256: run.gates[0]!.sha256, identity: { version: 'mycelink-test-identity/1', runner: 'js', path: RED.path, key: RED.name } },
    ]);
  });

  it.each([
    ['no evidence at all', null, { criterionEvidence: [] }, 'CRITERION_EVIDENCE_MISSING'],
    ["a criterion of another node", [RED, { ...RED, criterion: 'AC-2' }], {}, 'CRITERION_NOT_ASSIGNED'],
    ['the same item twice', [RED, RED], {}, 'CRITERION_EVIDENCE_DUPLICATE'],
    ["a test outside the node's module", [{ ...RED, path: 'packages/read/test/read.test.mjs', name: 'reads valid changesets in id order' }], {}, 'CRITERION_TEST_OUTSIDE_MODULE'],
    ['a test the module does not declare', [{ ...RED, name: 'proves everything' }], {}, 'CRITERION_TEST_UNKNOWN'],
    ['a test the RED did not fail for a missing behaviour', [{ ...RED, name: 'a git error carries its exit code' }], {}, 'CRITERION_NOT_RUN'],
    ['a new behaviour proved only by GREEN', [{ ...RED, gate: 'green' as const }], {}, 'CRITERION_RED_REQUIRED'],
  ])('refuses %s before integration', async (_label, criteria, extra, code) => {
    const s = await shop();
    const report = await attempt(s, criteria as CriterionItem[] | null, extra as { criterionEvidence?: unknown });
    expect(report['outcome']).not.toBe('DONE');
    expect(String(report['detail'])).toMatch(new RegExp(`^CRITERION_EVIDENCE_INVALID:${code}`));
    expect(shopState(s).nodes[ERRORS].integrated_sha).toBeNull();
    expect(shopState(s).integration_heads ?? {}).toEqual({});
  });

  it("refuses a hash that is not the gate's recorded evidence", async () => {
    const s = await shop();
    const report = await attempt(s, null, { criterionEvidence: [{ criterion: 'AC-1', test: { path: RED.path, name: RED.name }, gate: 'red', output_sha256: 'e'.repeat(64) }] });
    expect(String(report['detail'])).toMatch(/^CRITERION_EVIDENCE_INVALID:CRITERION_EVIDENCE_UNBOUND/);
  });

  it('accepts a compatibility criterion bound to an existing test through GREEN', async () => {
    const s = await shop();
    expect(await attempt(s, null)).toMatchObject({ outcome: 'DONE' });
    const read = await attempt(s, null);
    expect(read).toMatchObject({ outcome: 'DONE' });
    expect(shopState(s).nodes[READ].criteria.map((c: { criterion: string; gate: string }) => [c.criterion, c.gate])).toEqual([
      ['AC-2', 'red'],
      ['AC-5', 'green'],
    ]);
  });
});

describe('feature-wide coverage', () => {
  it('candidate verify and delivery refuse a criterion no DONE node evidenced', async () => {
    const graph = shopGraph(moduleVerifier()) as { acceptance_criteria: Record<string, unknown>[]; nodes: Record<string, any>[] };
    // AC-6 is listed only on the candidate build: no product node serves it, so nothing ever proves it.
    graph.acceptance_criteria.push({ id: 'AC-6', text: 'changeset version writes nothing when changesets are invalid' });
    graph.nodes.find((n) => n['node_type'] === 'candidate-build')!['acceptance_criteria'] = ['AC-6'];
    // feature init refuses such a graph now (CRITERION_NO_PRODUCER); a feature initialised before the rule still has one.
    await expect(createShop({ modules: 'structured', graph })).rejects.toThrow(/CRITERION_NO_PRODUCER/);
    const s = await createShop({ modules: 'structured', graph: shopGraph(moduleVerifier()) });
    initialisedWithGraph(s, graph);
    for (const _ of [ERRORS, READ, ASSEMBLE, CLI_NODE]) expect(await attempt(s, null)).toMatchObject({ outcome: 'DONE' });
    expect((await next(s)).status).toBe('ALL_SETTLED');
    commitShopControl(s, 'settled');
    const cv = JSON.parse((await shopCli(s, ['candidate', 'verify', SHOP_FEATURE, '--json'])).out) as { ok: boolean; problems: { code: string; detail: string }[] };
    expect(cv.ok).toBe(false);
    expect(cv.problems).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'UNCOVERED_ACCEPTANCE_CRITERION', detail: expect.stringContaining('AC-6') })]));
    const deliver = await shopCli(s, ['deliver', SHOP_FEATURE, '--json']);
    expect(deliver.code).not.toBe(0);
    expect(deliver.err + deliver.out).toMatch(/UNCOVERED_ACCEPTANCE_CRITERION: AC-6/);
  });

  it('a feature whose every criterion is evidenced verifies and delivers', async () => {
    const s = await shop();
    for (const _ of [ERRORS, READ, ASSEMBLE, CLI_NODE]) expect(await attempt(s, null)).toMatchObject({ outcome: 'DONE' });
    expect((await next(s)).status).toBe('ALL_SETTLED');
    commitShopControl(s, 'settled');
    expect(JSON.parse((await shopCli(s, ['candidate', 'verify', SHOP_FEATURE, '--json'])).out)).toMatchObject({ ok: true });
    expect(JSON.parse((await shopCli(s, ['deliver', SHOP_FEATURE, '--json'])).out)).toMatchObject({ status: 'ACCEPTED' });
    // The graph's criteria kinds are what settle judged by.
    const g = YAML.parse(readFileSync(join(s.featureDir, 'PORTFOLIO-GRAPH.yaml'), 'utf8')) as { acceptance_criteria: { id: string; kind?: string }[] };
    expect(g.acceptance_criteria.find((a) => a.id === 'AC-5')!.kind).toBe('compatibility');
    void writeFileSync;
  });
});
