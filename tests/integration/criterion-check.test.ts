/**
 * `mycelink tdd check`: a worker judges its own criterion evidence exactly as
 * settle will, before it submits.
 *
 * CSET-203 r1 with-normal: the cli worker submitted AC-4 (a new behaviour)
 * mapped to an existing test through GREEN, and learnt it only from settle.
 * The worker's brief now asks it to check its mapping before outcome
 * SUBMITTED, and the check line it is given does that deterministically: it
 * reads the result the worker wrote to its slot (never taking it), resolves
 * every criterion item among the tests the claim's recorded gates ran, at the
 * head of the branch, and answers OK, or the refusal settle would give with
 * the candidate ids. It changes nothing, and only the claim's capability
 * holder may run it.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { cleanupTmpRoots } from '../helpers/tmp.js';
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
  verState,
  type Ver,
} from '../helpers/version-fixture.js';
import { fulfil, type ShopTicket } from '../helpers/shop-worker.js';

afterAll(() => cleanupTmpRoots());

const id = (name: string): string => canonicalTestId('junit-xml', 'packages/cli/test/cli.test.mjs', name);

async function cliTicket(s: Ver): Promise<ShopTicket> {
  const a = JSON.parse((await verCli(s, ['dispatch', VER_FEATURE, '--json'])).out).ticket as ShopTicket;
  fulfil(a, { ...VER_WORK[ARP]!, criteria: [{ criterion: 'AC-1', gate: 'red', full_name: ARP_ROLLBACK_TEST }, { criterion: 'AC-2', gate: 'red', full_name: ARP_JOURNAL_TEST }] }, s.control);
  expect(JSON.parse((await verCli(s, ['settle', VER_FEATURE, ARP, '--capability', a.capability, '--json'])).out)).toMatchObject({ outcome: 'DONE' });
  commitVerControl(s, 'apply-release-plan settled');
  const t = JSON.parse((await verCli(s, ['dispatch', VER_FEATURE, '--json'])).out).ticket as ShopTicket;
  expect(t.node_id).toBe(CLI);
  return t;
}

/** The check line the ticket's brief offers, run as the worker's Bash would. */
function check(t: ShopTicket, cwd: string): { code: number; out: string } {
  const line = /^- check \([^)]*\): (.+)$/m.exec(t.prompt)?.[1];
  if (line === undefined) throw new Error('the brief offers no check line');
  try {
    return { code: 0, out: execSync(`${line} --json`, { cwd, encoding: 'utf8', stdio: 'pipe' }) };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe('tdd check judges the criterion evidence of the result the worker wrote, as settle will', () => {
  it("r1's AC-4 through GREEN: refused before submitting, with the red candidates; nothing changes, the result stays in the slot", async () => {
    const s = await createVer();
    const t = await cliTicket(s);
    fulfil(t, { ...VER_WORK[CLI]!, criteria: [{ criterion: 'AC-3', gate: 'red', full_name: CLI_RECOVERY_TEST }, { criterion: 'AC-4', gate: 'green', test_id: id(CLI_EXISTING_TEST) }, CLI_AC5] }, s.control);
    const before = readFileSync(`${s.featureDir}/STATE.json`, 'utf8');
    const r = check(t, s.control);
    expect(r.code).toBe(1);
    const report = JSON.parse(r.out);
    expect(report).toMatchObject({ ok: false, code: 'CRITERION_RED_REQUIRED', criterion: 'AC-4', kind: 'new-behavior', required_gate: 'red' });
    expect(report.detail).toMatch(/^AC-4 is a new behavior/);
    expect(report.candidates).toEqual(expect.arrayContaining([expect.objectContaining({ id: id(CLI_RECOVERY_TEST), gate: 'red', status: 'failed' })]));
    expect(readFileSync(`${s.featureDir}/STATE.json`, 'utf8')).toBe(before);
    expect(existsSync(t.result_slot)).toBe(true);
    expect(verState(s).nodes[CLI].claim.evidence_correction ?? null).toBeNull();
  });

  it('every criterion proved as its kind requires: OK, and settle agrees', async () => {
    const s = await createVer();
    const t = await cliTicket(s);
    fulfil(t, { tests: { 'packages/cli/test/cli.test.mjs': CLI_FAILURE_RED }, impl: { 'packages/cli/src/index.mjs': CLI_IMPL }, criteria: [{ criterion: 'AC-3', gate: 'red', full_name: CLI_RECOVERY_TEST }, { criterion: 'AC-4', gate: 'red', full_name: CLI_FAILURE_TEST }, CLI_AC5] }, s.control);
    const r = check(t, s.control);
    expect(r.code, r.out).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ ok: true, criteria: [{ criterion: 'AC-3', test_id: id(CLI_RECOVERY_TEST), gate: 'red' }, { criterion: 'AC-4', test_id: id(CLI_FAILURE_TEST), gate: 'red' }, { criterion: 'AC-5', test_id: CLI_AC5.test_id, gate: 'green' }] });
    expect(JSON.parse((await verCli(s, ['settle', VER_FEATURE, CLI, '--capability', t.capability, '--json'])).out)).toMatchObject({ outcome: 'DONE' });
  });

  it("a result whose commit_sha is not the branch head is refused as settle would; only the claim's capability may check", async () => {
    const s = await createVer();
    const t = await cliTicket(s);
    fulfil(t, { ...VER_WORK[CLI]!, criteria: [{ criterion: 'AC-3', gate: 'red', full_name: CLI_RECOVERY_TEST }, { criterion: 'AC-4', gate: 'green', test_id: id(CLI_EXISTING_TEST) }, CLI_AC5] }, s.control);
    const result = JSON.parse(readFileSync(t.result_slot, 'utf8'));
    result.commit_sha = 'f'.repeat(40);
    writeFileSync(t.result_slot, JSON.stringify(result));
    const r = check(t, s.control);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, code: 'TDD_CLAIM_MISMATCH' });
    const denied = await verCli(s, ['tdd', 'check', VER_FEATURE, CLI, '--json']);
    expect(denied.code).not.toBe(0);
    const wrong = await verCli(s, ['tdd', 'check', VER_FEATURE, CLI, '--capability', 'a'.repeat(64), '--json']);
    expect(wrong.code).not.toBe(0);
  });
});
