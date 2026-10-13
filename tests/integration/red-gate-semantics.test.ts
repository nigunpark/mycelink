/**
 * The red gate judges what a RED proves, not only that it exited nonzero.
 *
 * CSET-202 r1, with-normal: the errors worker's RED statically used
 * `ChangesetValidationError` before it existed (`TypeError: ... is not a
 * constructor`). Core's red gate accepted it as a missing behaviour and
 * settle integrated it; the independent replay rejected the delivery's
 * errors unit as `missing-symbol`. Now the gate reads the tests the RED
 * declares (its test-side delta since the cycle began) and refuses a RED
 * that fails for a syntax, import or missing-symbol reason, that declares no
 * test, or that does not fail — recording the category and fingerprint, and
 * telling the worker to change the test, not production code.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import {
  ERRORS,
  ERRORS_RED,
  ERRORS_RED_NOT_A_CONSTRUCTOR,
  ERRORS_RED_STATIC_IMPORT,
  SHOP_FEATURE,
  createShop,
  legacyVerifier,
  shopCli,
  shopGraph,
  shopState,
  type Shop,
} from '../helpers/shop-fixture.js';

afterAll(() => cleanupTmpRoots());

interface Ticket {
  node_id: string;
  worktree: string;
  gate_commands: { gate: string; command: string }[];
  capability: string;
}

async function dispatchErrors(s: Shop): Promise<Ticket> {
  const d = await shopCli(s, ['dispatch', SHOP_FEATURE, '--json']);
  expect(d.err).toBe('');
  const out = JSON.parse(d.out) as { status: string; ticket: Ticket };
  expect(out.status).toBe('DISPATCHED');
  expect(out.ticket.node_id).toBe(ERRORS);
  return out.ticket;
}

function write(worktree: string, rel: string, body: string): void {
  mkdirSync(dirname(join(worktree, rel)), { recursive: true });
  writeFileSync(join(worktree, rel), body);
}

function gate(s: Shop, t: Ticket, name: string): { code: number; out: string } {
  const line = t.gate_commands.find((g) => g.gate === name)!.command;
  try {
    return { code: 0, out: execSync(line, { cwd: s.control, encoding: 'utf8', stdio: 'pipe' }) };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

const TEST = 'packages/errors/test/errors.test.mjs';
const node = (s: Shop) => shopState(s).nodes[ERRORS];

describe('the red gate refuses a RED that proves nothing (no report: conservative patterns)', () => {
  it('refuses the r1 RED: a static import of a class that does not exist yet fails to link, a syntax failure', async () => {
    const s = await createShop({ graph: shopGraph(legacyVerifier, { compatibility: false }) });
    const t = await dispatchErrors(s);
    write(t.worktree, TEST, ERRORS_RED_STATIC_IMPORT);
    const r = gate(s, t, 'red');
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/RED_INVALID:syntax/);
    // What to do instead: change the test, never production code.
    expect(r.out).toMatch(/dynamic/i);
    expect(r.out).toMatch(/never statically import/i);
    expect(r.out).toMatch(/change the test, not production/i);
    expect(node(s).state).not.toBe('RED_VERIFIED');
    expect(node(s).evidence.red).toMatchObject({ exit_code: 1, red_reason: 'syntax-error', red_category: 'syntax', red_fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/) });
    expect(node(s).tdd_red_bindings ?? []).toEqual([]);
  });

  it('refuses a RED that calls the missing constructor (missing-symbol), then accepts the same criterion inspected dynamically, in the same claim', async () => {
    const s = await createShop({ graph: shopGraph(legacyVerifier, { compatibility: false }) });
    const t = await dispatchErrors(s);
    write(t.worktree, TEST, ERRORS_RED_NOT_A_CONSTRUCTOR);
    const refused = gate(s, t, 'red');
    expect(refused.code).toBe(2);
    expect(refused.out).toMatch(/RED_INVALID:missing-symbol/);
    expect(node(s).evidence.red).toMatchObject({ red_reason: 'setup-error', red_category: 'missing-symbol' });

    // The worker changes the test, not production: the class is inspected before it is used.
    write(t.worktree, TEST, ERRORS_RED);
    const accepted = gate(s, t, 'red');
    expect(accepted.code, accepted.out).toBe(0);
    expect(node(s).state).toBe('RED_VERIFIED');
    expect(node(s).evidence.red).toMatchObject({ red_reason: 'behaviour-missing', red_category: 'assertion' });
    expect(node(s).tdd_red_bindings).toHaveLength(1);
  });

  it('refuses a RED that declares no test (test data alone), whatever its exit code', async () => {
    const s = await createShop({ graph: shopGraph(legacyVerifier, { compatibility: false }) });
    const t = await dispatchErrors(s);
    // A data file under the test paths, and a failing run: still no declared test.
    write(t.worktree, 'packages/errors/test/fixtures/issues.json', '[{"changesetId":"a"}]\n');
    write(t.worktree, 'packages/errors/test/broken.test.mjs', "import assert from 'node:assert/strict';\nassert.equal(1, 2);\n");
    const r = gate(s, t, 'red');
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/RED_INVALID:no-test/);
    expect(node(s).evidence.red).toMatchObject({ red_category: 'no-test' });
  });

  it('accepts a RED whose declared test fails an assertion, and records its category', async () => {
    const s = await createShop({ graph: shopGraph(legacyVerifier, { compatibility: false }) });
    const t = await dispatchErrors(s);
    write(t.worktree, TEST, ERRORS_RED);
    const r = gate(s, t, 'red');
    expect(r.code, r.out).toBe(0);
    // The gate names the evidence hash a worker binds its criterion evidence to.
    expect(r.out).toMatch(/sha256 [0-9a-f]{64}/);
    expect(node(s).evidence.red).toMatchObject({ red_reason: 'behaviour-missing', red_category: 'assertion' });
  });
});
