/**
 * The administrative re-evaluation of an identity-shape refusal (PCM-101
 * final) is bounded to exactly that: a refusal the old, runner-incompatible
 * comparison made, of a submission whose history, gates and criterion
 * evidence the canonical identity accepts. Everything else stays where it
 * was, nothing is charged, and a person or a worker still decides:
 *
 *  - a held submission whose evidence is genuinely wrong is judged again
 *    once, refused again, and handed to its correction as before — never
 *    re-judged again, never charged;
 *  - a hold for another reason (a new behaviour proved without a RED) is a
 *    correction, never an administrative re-evaluation;
 *  - a worker's BLOCKED answer is re-evaluated only when it names the
 *    identity refusal, the controller holds exactly one copy of it for its
 *    claim and dispatch, its commit is still its branch's head, and its
 *    evidence holds by the canonical identity with a translation the old
 *    comparison could not make; a BLOCKED for any other reason, on evidence
 *    that does not hold, on a moved branch, or beside a planted second copy,
 *    is left parked for a person, unchanged.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { commitAll, git, writeFiles } from '../helpers/git-fixture.js';
import { fulfil, type ShopTicket } from '../helpers/shop-worker.js';
import { canonicalTestId } from '../../src/evidence/test-ids.js';
import { mutateState } from '../../src/state/feature-state.js';
import {
  GATEWAY_CONTROLLER_CLASS,
  GATEWAY_CONTROLLER_TEST,
  GATEWAY_NODE,
  IDENTITY_BLOCKED_FINGERPRINT,
  VET_FEATURE,
  VET_WORK,
  VISIT_RESOURCE_CLASS,
  VISIT_RESOURCE_TEST,
  VISIT_VET_TEST,
  VISITS_NODE,
  commitVetControl,
  createVet,
  vetCli,
  vetEvents,
  vetState,
  type Vet,
} from '../helpers/vet-fixture.js';

const legacy = vi.hoisted(() => ({ on: false }));
vi.mock('../../src/evidence/test-identity.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/evidence/test-identity.js')>();
  const decl = await import('../../src/engine/test-declarations.js');
  const old = (test: { path: string; full_name: string }, source: string | null) => {
    if (source === null) return { status: 'missing' as const, detail: `${test.path} is not in the head` };
    const title = test.full_name.includes(' > ') ? (test.full_name.split(' > ').pop() as string) : test.full_name;
    if (decl.declaredTests(test.path, source).some((t) => t.name === title || t.name === test.full_name)) {
      return { status: 'declared' as const, identity: actual.reportedIdentity(test) as NonNullable<ReturnType<typeof actual.reportedIdentity>>, translated: false, line: null };
    }
    return { status: 'missing' as const, detail: `${test.path} declares no test ${JSON.stringify(title)}` };
  };
  return { ...actual, resolveDeclaration: (test: Parameters<typeof actual.resolveDeclaration>[0], source: string | null) => (legacy.on ? old(test, source) : actual.resolveDeclaration(test, source)) };
});

afterAll(() => cleanupTmpRoots());

type Dispatched = { status: string; detail: string; ticket?: ShopTicket & { correction?: Record<string, unknown> }; controller_reports?: { node_id: string; outcome: string }[] };

const dispatch = async (v: Vet): Promise<Dispatched> => JSON.parse((await vetCli(v, ['dispatch', VET_FEATURE, '--json'])).out) as Dispatched;
const settle = async (v: Vet, t: ShopTicket): Promise<{ outcome: string; detail: string; state?: string }> => JSON.parse((await vetCli(v, ['settle', VET_FEATURE, t.node_id, '--capability', t.capability, '--json'])).out);

async function ticketFor(v: Vet, node: string): Promise<ShopTicket> {
  const d = await dispatch(v);
  expect(d.ticket?.node_id, `${d.status}: ${d.detail}`).toBe(node);
  return d.ticket as ShopTicket;
}

const compatId = (node: string): string =>
  node === VISITS_NODE ? canonicalTestId('junit-xml', VISIT_RESOURCE_TEST, `${VISIT_RESOURCE_CLASS}#shouldFetchVisits`) : canonicalTestId('junit-xml', GATEWAY_CONTROLLER_TEST, `${GATEWAY_CONTROLLER_CLASS}#getOwnerDetails_withAvailableVisitsService`);

/** The producer's work; `evidence` replaces its criterion evidence (null: the real one). */
function work(v: Vet, t: ShopTicket, evidence: ((real: Record<string, unknown>[]) => Record<string, unknown>[]) | null = null): Record<string, unknown> {
  const w = VET_WORK[t.node_id as keyof typeof VET_WORK];
  const run = fulfil(t, { tests: w.tests, impl: w.impl, criteria: w.criteria.map((c) => (c.gate === 'green' ? { criterion: c.criterion, gate: c.gate, test_id: compatId(t.node_id) } : c)) }, v.control);
  expect(run.gates.map((g) => g.code), run.gates.map((g) => g.out.slice(-600)).join('\n')).toEqual([0, 0, 0]);
  if (evidence === null) return run.result;
  const result = { ...run.result, criterion_evidence: evidence(run.result['criterion_evidence'] as Record<string, unknown>[]) };
  writeFileSync(t.result_slot, JSON.stringify(result, null, 2));
  return result;
}

const answer = (t: ShopTicket, result: Record<string, unknown>, outcome: string, fingerprint: string): void => writeFileSync(t.result_slot, JSON.stringify({ ...result, outcome, failure_fingerprint: fingerprint }, null, 2));

/** STATE.json as a core before this repair wrote it. */
function asLegacy(v: Vet): void {
  mutateState(v.featureDir, (s) => {
    for (const rt of Object.values(s.nodes)) {
      const hold = rt.claim?.evidence_correction as Record<string, unknown> | undefined;
      if (hold) delete hold['identity_version'];
      const receipt = rt.last_settlement as Record<string, unknown> | undefined;
      if (receipt) {
        delete receipt['result_sha256'];
        delete receipt['result_file'];
      }
    }
    return s;
  });
  commitVetControl(v, 'as a core before the repair left it');
}

/** The visits node parked by its own BLOCKED answer, under the old comparison, as the run left it. */
async function parkedVisits(fingerprint = IDENTITY_BLOCKED_FINGERPRINT, evidence: ((real: Record<string, unknown>[]) => Record<string, unknown>[]) | null = null): Promise<{ v: Vet; t: ShopTicket }> {
  const v = await createVet();
  legacy.on = true;
  try {
    const t = await ticketFor(v, VISITS_NODE);
    answer(t, work(v, t, evidence), 'BLOCKED', fingerprint);
    expect(await settle(v, t)).toMatchObject({ outcome: 'BLOCKED', state: 'BLOCKED' });
    commitVetControl(v, 'visits parked');
    asLegacy(v);
    return { v, t };
  } finally {
    legacy.on = false;
  }
}

/** The parked visits node, unchanged, and nothing reconciled for it. */
function stillParked(v: Vet, before: Record<string, any>): void {
  const now = vetState(v).nodes[VISITS_NODE];
  expect(now).toMatchObject({ state: 'BLOCKED', attempts: before.attempts, claim: null, blocked_reason: before.blocked_reason });
  expect(now.last_settlement).toEqual(before.last_settlement);
  expect(vetEvents(v).filter((e) => e.type === 'node.identity_reconciled' && e.node_id === VISITS_NODE)).toEqual([]);
  expect(readdirSync(join(v.featureDir, 'evidence', VISITS_NODE)).filter((f) => f.startsWith('identity'))).toEqual([]);
}

describe('the identity re-evaluation is bounded to an identity-shape refusal', () => {
  it('a held submission whose evidence names a test no gate ran: judged again once, refused again, handed to its correction; nothing charged', async () => {
    const v = await createVet();
    const t = await ticketFor(v, VISITS_NODE);
    work(v, t, (real) => real.map((e) => (e['criterion'] === 'AC-1' ? { ...e, test_id: '0123456789abcdef' } : e)));
    const held = await settle(v, t);
    expect(held, held.detail).toMatchObject({ outcome: 'EVIDENCE_CORRECTION_REQUIRED' });
    asLegacy(v);
    const d = await dispatch(v);
    expect(d.status, d.detail).toBe('DISPATCHED');
    expect(d.ticket?.node_id).toBe(VISITS_NODE);
    expect(d.ticket?.correction, JSON.stringify(d.ticket?.correction ?? null)).toMatchObject({ code: 'CRITERION_TEST_UNKNOWN', criterion: 'AC-1' });
    const s = vetState(v).nodes[VISITS_NODE];
    expect(s).toMatchObject({ state: 'REGRESSION_VERIFIED', attempts: 1, failure_counts: {} });
    // Judged under the canonical identity now: never re-evaluated again.
    expect(s.claim.evidence_correction).toMatchObject({ code: 'CRITERION_TEST_UNKNOWN', corrections: 0, identity_version: 'mycelink-test-identity/1' });
    expect(vetEvents(v).filter((e) => e.type === 'node.identity_reconciled')).toEqual([]);
  });

  it('a hold for a new behaviour proved without a RED is a correction, never an administrative re-evaluation', async () => {
    const v = await createVet();
    const t = await ticketFor(v, VISITS_NODE);
    work(v, t, (real) => real.map((e) => (e['criterion'] === 'AC-1' ? { criterion: 'AC-1', test_id: compatId(VISITS_NODE), gate: 'green', output_sha256: (real.find((x) => x['gate'] === 'green') as Record<string, unknown>)['output_sha256'] } : e)));
    expect(await settle(v, t)).toMatchObject({ outcome: 'EVIDENCE_CORRECTION_REQUIRED' });
    asLegacy(v);
    const d = await dispatch(v);
    expect(d.ticket?.correction).toMatchObject({ code: 'CRITERION_RED_REQUIRED' });
    expect(vetEvents(v).filter((e) => e.type === 'node.identity_reconciled')).toEqual([]);
    expect(vetState(v).nodes[VISITS_NODE]).toMatchObject({ attempts: 1, failure_counts: {} });
  });

  it('a BLOCKED answer for another reason stays parked, whatever its evidence', async () => {
    const { v } = await parkedVisits('SCHEMA_DECISION_NEEDED: the visits table needs a migration owner');
    const before = vetState(v).nodes[VISITS_NODE];
    const d = await dispatch(v);
    expect(d.ticket?.node_id ?? null).not.toBe(VISITS_NODE);
    stillParked(v, before);
  });

  it('a BLOCKED answer naming the identity refusal whose evidence does not hold stays parked', async () => {
    const { v } = await parkedVisits(IDENTITY_BLOCKED_FINGERPRINT, (real) => real.map((e) => (e['criterion'] === 'AC-2' ? { ...e, test_id: 'fedcba9876543210' } : e)));
    const before = vetState(v).nodes[VISITS_NODE];
    await dispatch(v);
    stillParked(v, before);
  });

  it('a BLOCKED answer whose branch moved since it answered stays parked', async () => {
    const { v, t } = await parkedVisits();
    const before = vetState(v).nodes[VISITS_NODE];
    writeFiles(t.worktree, { [VISIT_VET_TEST]: `${readFileSync(join(t.worktree, VISIT_VET_TEST), 'utf8')}\n// later\n` });
    commitAll(t.worktree, 'a later commit on the branch');
    await dispatch(v);
    stillParked(v, before);
  });

  it('a second controller copy planted beside the parked answer: no copy is trusted, nothing is reconciled', async () => {
    const { v } = await parkedVisits();
    const before = vetState(v).nodes[VISITS_NODE];
    const dir = join(v.featureDir, 'sessions', VISITS_NODE);
    const real = readdirSync(dir).find((f) => f.startsWith('result.')) as string;
    const planted = real.replace(/\.[0-9a-f]{32}\.json$/, '.0123456789abcdef0123456789abcdef.json');
    writeFileSync(join(dir, planted), readFileSync(join(dir, real)));
    await dispatch(v);
    stillParked(v, before);
  });

  it('a BLOCKED answer with the identity refusal and evidence that holds is reconciled once; the gateway goes on as usual', async () => {
    const { v } = await parkedVisits();
    const d = await dispatch(v);
    expect((d.controller_reports ?? []).map((r) => [r.node_id, r.outcome])).toContainEqual([VISITS_NODE, 'DONE']);
    expect(d.ticket?.node_id, `${d.status}: ${d.detail}`).toBe(GATEWAY_NODE);
    const visits = vetState(v).nodes[VISITS_NODE];
    expect(visits).toMatchObject({ state: 'DONE', attempts: 1, failure_counts: {} });
    expect(visits.last_settlement).toMatchObject({ outcome: 'DONE', result_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(git(v.repo, ['log', '--format=%s', 'feature/VET-101'])).toContain(VISITS_NODE);
  });
});
