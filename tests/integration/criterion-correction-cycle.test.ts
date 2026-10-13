/**
 * Criterion evidence correction: the same claim, a bounded budget of its
 * own, and — for a new behaviour no RED proved — one more RED cycle.
 *
 * CSET-203 r1 with-normal: the cli node's code, history and gates passed,
 * but its result mapped AC-4 (a new behaviour) to an existing test through
 * GREEN. Settle held the claim (CRITERION_RED_REQUIRED, nothing charged) and
 * dispatched a correction, whose brief said "do not edit, commit or run a
 * gate": no test its gates had run proved AC-4 by a RED, so the correction
 * worker could only answer RETRYABLE CRITERION_UNPROVEN:AC-4 — and that
 * answer was charged as a failed product attempt. Twice: the node BLOCKED.
 * Here:
 *
 *  - the hold names the criterion, its kind and the gate its evidence needs,
 *    and the ticket `dispatch --resume` hands out says exactly that, with the
 *    candidate ids;
 *  - when a new behaviour has no RED proof, the correction may add one
 *    focused RED cycle on the same claim and worktree — the failing test
 *    alone through the red gate, its commit, the production change through
 *    green, its commit, regression — and resubmit: settle judges the whole
 *    history again, and only its verdict can charge the product;
 *  - a correction that changes nothing and gives up (RETRYABLE, e.g.
 *    CRITERION_UNPROVEN:AC-4) charges no product attempt: the submission it
 *    held is restored exactly, and corrections, bounded on their own,
 *    count it; at the bound the hold ends as a failed attempt;
 *  - a gate a correction refused leaves the held submission untouched, and
 *    a correction that rewrites the held history is the product's failure.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { git } from '../helpers/git-fixture.js';
import { canonicalTestId } from '../../src/evidence/test-ids.js';
import {
  ARP,
  ARP_JOURNAL_TEST,
  ARP_ROLLBACK_TEST,
  CLI,
  CLI_AC5,
  CLI_EXISTING_TEST,
  CLI_FAILURE_RED,
  CLI_FAILURE_TEST,
  CLI_IMPL,
  CLI_RECOVERY_TEST,
  VER_FEATURE,
  VER_WORK,
  commitVerControl,
  createVer,
  verCli,
  verGraph,
  verState,
  type Ver,
} from '../helpers/version-fixture.js';
import { commit, fulfil, packOf, runGate, writeFiles, type GateRun, type ShopTicket } from '../helpers/shop-worker.js';
import { escapeRegExp } from '../helpers/regex.js';

afterAll(() => cleanupTmpRoots());

const CLI_TESTS = 'packages/cli/test/cli.test.mjs';
const id = (name: string): string => canonicalTestId('junit-xml', CLI_TESTS, name);

type Ticket = ShopTicket & { attempt: number; correction?: Record<string, any> };

interface Dispatched {
  status: string;
  detail: string;
  ticket?: Ticket;
}

async function dispatch(s: Ver, ...extra: string[]): Promise<Dispatched> {
  const d = await verCli(s, ['dispatch', VER_FEATURE, ...extra, '--json']);
  expect(d.err, d.out).toBe('');
  return JSON.parse(d.out) as Dispatched;
}

async function settle(s: Ver, t: Ticket): Promise<Record<string, any>> {
  return JSON.parse((await verCli(s, ['settle', VER_FEATURE, t.node_id, '--capability', t.capability, '--json'])).out) as Record<string, any>;
}

/** The compatibility node out of the way: these tests are about the cli node. */
const graph = () => verGraph({ compat: { acceptance_criteria: ['AC-5'] } });

/** apply-release-plan DONE; the cli's first submission: AC-3's cycle, and AC-4 mapped to an existing test through GREEN (r1). */
async function heldOnAc4(s: Ver): Promise<{ t: Ticket; head: string; redSha: string }> {
  const a = await dispatch(s);
  expect(a.ticket!.node_id).toBe(ARP);
  fulfil(a.ticket!, { ...VER_WORK[ARP]!, criteria: [{ criterion: 'AC-1', gate: 'red', full_name: ARP_ROLLBACK_TEST }, { criterion: 'AC-2', gate: 'red', full_name: ARP_JOURNAL_TEST }] }, s.control);
  expect(await settle(s, a.ticket!)).toMatchObject({ outcome: 'DONE' });
  commitVerControl(s, 'apply-release-plan settled');
  const d = await dispatch(s);
  const t = d.ticket!;
  expect(t.node_id).toBe(CLI);
  const run = fulfil(t, { ...VER_WORK[CLI]!, criteria: [{ criterion: 'AC-3', gate: 'red', full_name: CLI_RECOVERY_TEST }, { criterion: 'AC-4', gate: 'green', test_id: id(CLI_EXISTING_TEST) }, CLI_AC5] }, s.control);
  expect(run.gates.map((g) => g.code), JSON.stringify(run.gates.map((g) => g.out.slice(-500)))).toEqual([0, 0, 0]);
  const held = await settle(s, t);
  expect(held, JSON.stringify(held)).toMatchObject({ outcome: 'EVIDENCE_CORRECTION_REQUIRED', state: 'REGRESSION_VERIFIED' });
  expect(held['detail']).toMatch(/^CRITERION_EVIDENCE_INVALID:CRITERION_RED_REQUIRED: AC-4 is a new behavior/);
  return { t, head: run.result['commit_sha'] as string, redSha: run.gates[0]!.sha256! };
}

/** A correction worker that adds AC-4's own RED cycle on the held claim's worktree and resubmits. */
function correctWithCycle(t: Ticket, s: Ver): { gates: GateRun[]; head: string } {
  const pack = packOf(t);
  const heldRed = (pack['correction'].gates as { gate: string; output_sha256: string }[]).find((g) => g.gate === 'red')!.output_sha256;
  const gates: GateRun[] = [];
  writeFiles(t.worktree, { [CLI_TESTS]: CLI_FAILURE_RED });
  gates.push(runGate(t, 'red', s.control));
  commit(t.worktree, [CLI_TESTS], 'test(cli): a failed apply is reported without a stack trace, exit 1, nothing committed');
  writeFiles(t.worktree, { 'packages/cli/src/index.mjs': CLI_IMPL });
  gates.push(runGate(t, 'green', s.control));
  commit(t.worktree, ['packages/cli/src/index.mjs'], 'feat(cli): report a failed apply without a stack trace and exit 1');
  gates.push(runGate(t, 'regression', s.control));
  const head = git(t.worktree, ['rev-parse', 'HEAD']);
  result(t, {
    outcome: 'SUBMITTED',
    commit_sha: head,
    commands: gates.map((g) => ({ command: [`gate:${g.gate}`], exit_code: g.code })),
    changed_paths: [CLI_TESTS, 'packages/cli/src/index.mjs'],
    criterion_evidence: [
      { criterion: 'AC-3', test_id: id(CLI_RECOVERY_TEST), gate: 'red', output_sha256: heldRed },
      { criterion: 'AC-4', test_id: id(CLI_FAILURE_TEST), gate: 'red', output_sha256: gates[0]!.sha256 },
      { criterion: 'AC-5', test_id: CLI_AC5.test_id, gate: 'green', output_sha256: gates[1]!.sha256 },
    ],
  });
  return { gates, head };
}

function result(t: Ticket, fields: Record<string, unknown>): void {
  mkdirSync(dirname(t.result_slot), { recursive: true });
  writeFileSync(
    t.result_slot,
    JSON.stringify({ schema_version: 1, node_id: t.node_id, claim_id: t.claim_id, dispatch_id: t.dispatch_id, outcome: 'SUBMITTED', commands: [], evidence_paths: [], failure_fingerprint: null, decision_request: null, ...fields }, null, 2),
  );
}

/** A correction that changes nothing and gives up, as r1's did. */
function unproven(t: Ticket, head: string): void {
  result(t, { outcome: 'RETRYABLE', commit_sha: head, failure_fingerprint: 'CRITERION_UNPROVEN:AC-4', criterion_evidence: [] });
}

describe('a new behaviour mapped to GREEN is corrected by a RED cycle of its own, on the same claim', () => {
  it("r1's cli node: held naming AC-4, its kind and the red gate; dispatch --resume hands out exactly that; a new RED cycle settles DONE, nothing charged", async () => {
    const s = await createVer({ graph: graph() });
    const { t, head, redSha } = await heldOnAc4(s);
    const rt = verState(s).nodes[CLI];
    expect(rt).toMatchObject({ attempts: 1, failure_counts: {}, integrated_sha: null });
    expect(rt.claim.evidence_correction).toMatchObject({ code: 'CRITERION_RED_REQUIRED', criterion: 'AC-4', kind: 'new-behavior', required_gate: 'red', cycle: true, corrections: 0, commit_sha: head });

    const resumed = await dispatch(s, '--resume', CLI);
    expect(resumed.status, resumed.detail).toBe('DISPATCHED');
    const c = resumed.ticket!;
    expect(c).toMatchObject({ node_id: CLI, claim_id: t.claim_id, attempt: t.attempt });
    expect(c.capability).not.toBe(t.capability);
    expect(c.correction).toMatchObject({ code: 'CRITERION_RED_REQUIRED', criterion: 'AC-4', kind: 'new-behavior', required_gate: 'red', cycle: true, commit_sha: head });
    expect(c.gate_commands.map((g) => g.gate)).toEqual(['red', 'green', 'regression']);
    // The brief's first lines: what is uncovered, its kind and the gate, before anything else.
    const top = c.prompt.split('\n').slice(0, 24).join('\n');
    expect(top).toMatch(/Evidence correction: AC-4 \(new behavior\)/);
    expect(top).toMatch(/needs gate "red"/);
    expect(top).toMatch(/a new RED cycle/i);
    // AC-4's exact approved text is in the brief itself, above the context pack, as data.
    expect(c.prompt.split('<mycelink-context-pack>')[0]).toContain('when applying the release plan fails, changeset version prints the failure without a stack trace and exits with code 1');
    const pack = packOf(c);
    expect(pack['correction']).toMatchObject({ criterion: 'AC-4', kind: 'new-behavior', required_gate: 'red', cycle: true });
    expect(pack['correction'].gates).toEqual(expect.arrayContaining([{ gate: 'red', output_sha256: redSha }]));

    const { gates, head: newHead } = correctWithCycle(c, s);
    expect(gates.map((g) => g.code), JSON.stringify(gates.map((g) => g.out.slice(-600)))).toEqual([0, 0, 0]);
    expect(gates[0]!.tests).toEqual(expect.arrayContaining([expect.objectContaining({ id: id(CLI_FAILURE_TEST), status: 'failed' })]));
    const done = await settle(s, c);
    expect(done, JSON.stringify(done)).toMatchObject({ outcome: 'DONE' });
    const after = verState(s).nodes[CLI];
    expect(after).toMatchObject({ state: 'DONE', attempts: 1, failure_counts: {}, claim: null, integrated_sha: newHead });
    expect(after.tdd_history).toMatchObject({ ok: true, cycles: 2, head_sha: newHead });
    expect(after.criteria.map((x: any) => [x.criterion, x.test_id, x.gate])).toEqual([
      ['AC-3', id(CLI_RECOVERY_TEST), 'red'],
      ['AC-4', id(CLI_FAILURE_TEST), 'red'],
      ['AC-5', CLI_AC5.test_id, 'green'],
    ]);
    expect(after.criteria[0].output_sha256).toBe(redSha);
    expect(git(s.repo, ['merge-base', '--is-ancestor', head, newHead]) === '').toBe(true);
  });

  it('a correction that changes nothing and gives up charges no product attempt; the held submission stays exactly as it was; the bound ends it as a failed attempt', async () => {
    const s = await createVer({ graph: graph() });
    const { head } = await heldOnAc4(s);
    const heldEvidence = verState(s).nodes[CLI].evidence;
    for (let n = 1; n <= 3; n++) {
      const c = (await dispatch(s)).ticket!;
      expect(c.correction, `correction ${n}`).toMatchObject({ criterion: 'AC-4', corrections: n - 1 });
      unproven(c, head);
      const r = await settle(s, c);
      const rt = verState(s).nodes[CLI];
      if (n < 3) {
        expect(r, `correction ${n}`).toMatchObject({ outcome: 'EVIDENCE_CORRECTION_REQUIRED', state: 'REGRESSION_VERIFIED' });
        expect(r['detail']).toMatch(/^CRITERION_UNPROVEN:AC-4: /);
        expect(rt).toMatchObject({ attempts: 1, failure_counts: {}, integrated_sha: null });
        expect(rt.claim.evidence_correction).toMatchObject({ corrections: n, criterion: 'AC-4', commit_sha: head });
        expect(rt.evidence).toEqual(heldEvidence);
        // The same answer settled again counts once.
        expect(await settle(s, c)).toMatchObject({ outcome: 'EVIDENCE_CORRECTION_REQUIRED' });
        expect(verState(s).nodes[CLI].claim.evidence_correction.corrections).toBe(n);
      } else {
        expect(r, `correction ${n}`).toMatchObject({ outcome: 'RETRY', state: 'READY' });
        expect(r['detail']).toMatch(/^CRITERION_UNPROVEN:AC-4: .*evidence correction limit of 3/);
        expect(rt).toMatchObject({ attempts: 1, claim: null, integrated_sha: null });
        expect(Object.keys(rt.failure_counts)).toEqual(['CRITERION_UNPROVEN:AC-4']);
      }
    }
  });

  it('a gate a correction refused leaves the held submission untouched; the next correction proves AC-4 and settles', async () => {
    const s = await createVer({ graph: graph() });
    const { head } = await heldOnAc4(s);
    const held = verState(s).nodes[CLI];
    const first = (await dispatch(s)).ticket!;
    // A "RED" that already passes: the red gate refuses it, and the worker gives up without committing.
    const passing = `${readFileSync(join(first.worktree, CLI_TESTS), 'utf8')}\ntest('version still versions a plan that applies', async () => {\n  assert.equal(1, 1);\n});\n`;
    writeFiles(first.worktree, { [CLI_TESTS]: passing });
    const refused = runGate(first, 'red', s.control);
    expect(refused.code).not.toBe(0);
    expect(refused.out).toMatch(/a passing test is not a RED/);
    git(first.worktree, ['checkout', '--', CLI_TESTS]);
    unproven(first, head);
    expect(await settle(s, first)).toMatchObject({ outcome: 'EVIDENCE_CORRECTION_REQUIRED' });
    const restored = verState(s).nodes[CLI];
    expect(restored.state).toBe(held.state);
    expect(restored.evidence).toEqual(held.evidence);
    expect(restored.tdd_red_bindings).toEqual(held.tdd_red_bindings);
    const second = (await dispatch(s)).ticket!;
    correctWithCycle(second, s);
    expect(await settle(s, second)).toMatchObject({ outcome: 'DONE' });
    expect(verState(s).nodes[CLI]).toMatchObject({ state: 'DONE', attempts: 1, failure_counts: {} });
  });

  it('a correction cycle builds on the held commit: one that rewrites the held history is the product failing', async () => {
    const s = await createVer({ graph: graph() });
    const { head } = await heldOnAc4(s);
    const c = (await dispatch(s)).ticket!;
    git(c.worktree, ['reset', '-q', '--hard', 'HEAD~1']);
    git(c.worktree, ['commit', '-q', '--allow-empty', '-m', 'rewritten']);
    result(c, { commit_sha: git(c.worktree, ['rev-parse', 'HEAD']), criterion_evidence: [{ criterion: 'AC-3', test_id: id(CLI_RECOVERY_TEST), gate: 'red', output_sha256: (packOf(c)['correction'].gates as any[]).find((g) => g.gate === 'red').output_sha256 }] });
    const r = await settle(s, c);
    expect(r['outcome']).not.toBe('DONE');
    expect(r['detail']).toMatch(/^CORRECTION_HISTORY_REWRITTEN: /);
    const rt = verState(s).nodes[CLI];
    expect(rt).toMatchObject({ integrated_sha: null, claim: null });
    expect(Object.keys(rt.failure_counts)).toEqual([expect.stringMatching(/^CORRECTION_HISTORY_REWRITTEN/)]);
    void head;
  });

  it('a corrective controller resumes the held correction through a genuine worker: reconcile names it, dispatch --resume re-issues it, the old capability is dead', async () => {
    const s = await createVer({ graph: graph() });
    const { t } = await heldOnAc4(s);
    const reconciled = JSON.parse((await verCli(s, ['session', 'reconcile', VER_FEATURE, '--json'])).out);
    expect(reconciled.pending_dispatches).toEqual([expect.objectContaining({ node_id: CLI, claim_id: t.claim_id, settlement: 'correction' })]);
    expect((await verCli(s, ['session', 'reconcile', VER_FEATURE])).out).toMatch(new RegExp(`pending dispatch ${escapeRegExp(CLI)} \\(held for its criterion evidence: resume it and give the correction ticket to a module-worker\\): mycelink dispatch ${VER_FEATURE} --resume`));
    const resumed = await dispatch(s, '--resume', CLI);
    expect(resumed.status).toBe('DISPATCHED');
    expect(resumed.ticket!.correction).toMatchObject({ criterion: 'AC-4', cycle: true });
    const stale = await verCli(s, ['settle', VER_FEATURE, CLI, '--capability', t.capability, '--json']);
    expect(stale.code).not.toBe(0);
    expect(verState(s).nodes[CLI].claim.evidence_correction).toMatchObject({ criterion: 'AC-4', corrections: 0 });
    correctWithCycle(resumed.ticket!, s);
    expect(await settle(s, resumed.ticket!)).toMatchObject({ outcome: 'DONE' });
  });

  it('a metadata error keeps the gates closed: only a missing RED proof opens a cycle', async () => {
    const s = await createVer({ graph: graph() });
    const a = await dispatch(s);
    fulfil(a.ticket!, { ...VER_WORK[ARP]!, criteria: [{ criterion: 'AC-1', gate: 'red', full_name: ARP_ROLLBACK_TEST }, { criterion: 'AC-2', gate: 'red', test_id: 'ffffffffffffffff' }] }, s.control);
    const held = await settle(s, a.ticket!);
    expect(held['detail']).toMatch(/CRITERION_TEST_UNKNOWN/);
    expect(verState(s).nodes[ARP].claim.evidence_correction).toMatchObject({ criterion: 'AC-2', kind: 'new-behavior', required_gate: 'red', cycle: false });
    const c = (await dispatch(s)).ticket!;
    expect(c.correction).toMatchObject({ cycle: false });
    const red = runGate(c, 'red', s.control);
    expect(red.code).not.toBe(0);
    expect(red.out).toMatch(/EVIDENCE_CORRECTION_PENDING/);
    expect(c.prompt.split('\n').slice(0, 24).join('\n')).toMatch(/Do not edit, commit or run a gate/);
  });
});
