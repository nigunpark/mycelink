/**
 * Module-scoped gates.
 *
 * CSET-202 r1, with-faults: the reworked errors node's RED ran the whole
 * suite, and the cli tests already integrated in its base — statically
 * importing the export the late defect removed — failed to link and made
 * the producer's RED a syntax failure it could never fix from its own
 * module. With a module verifier in the graph, the claim binds that module's
 * command (and its hash): the red and green gates run only the module's
 * tests, read its structured report, and record the module, its hash and the
 * results; fresh verification runs the same command on a clean checkout and
 * the repository's full suite for regression. A worker cannot replace the
 * command, a changed descriptor stops dispatch before anything is claimed,
 * and settle refuses gate evidence that was not run with the claim's module.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { mutateState } from '../../src/state/feature-state.js';
import { modulesOf } from '../../src/engine/modules.js';
import {
  ERRORS,
  ERRORS_IMPL,
  ERRORS_RED,
  FULL_SUITE,
  SHOP_FEATURE,
  commitShopControl,
  createShop,
  moduleVerifier,
  shopCli,
  shopGraph,
  shopRepository,
  shopState,
  type Shop,
} from '../helpers/shop-fixture.js';
import { commit, packOf, runGate, writeFiles, type ShopTicket } from '../helpers/shop-worker.js';

afterAll(() => cleanupTmpRoots());

/** A dependent's test already in the base that statically imports what the errors module does not export (yet): r1's poison. */
const POISON = {
  'packages/cli/test/report.test.mjs': `import { test } from 'node:test';
import { ChangesetValidationError } from '../../errors/src/index.mjs';

test('prints a validation error', () => {
  new ChangesetValidationError([]);
});
`,
};

const errorsModule = modulesOf(shopRepository('structured')).find((m) => m.id === 'errors')!;

async function dispatch(s: Shop): Promise<{ status: string; detail: string; ticket?: ShopTicket }> {
  const d = await shopCli(s, ['dispatch', SHOP_FEATURE, '--json']);
  expect(d.err).toBe('');
  return JSON.parse(d.out) as { status: string; detail: string; ticket?: ShopTicket };
}

async function shopWithModules(extra: Parameters<typeof createShop>[0] = {}): Promise<Shop> {
  return createShop({ modules: 'structured', graph: shopGraph(moduleVerifier(), { compatibility: false }), ...extra });
}

const node = (s: Shop) => shopState(s).nodes[ERRORS];

describe('module-scoped gates', () => {
  it('binds the module command in the claim, ticket, pack and setup receipt; the red gate runs only the module tests and reads its report', async () => {
    const s = await shopWithModules({ baseFiles: POISON, worktreeSetup: true });
    // The base suite does not even link: the dependent's test imports a class that does not exist yet.
    expect(() => execFileSync(FULL_SUITE[0]!, FULL_SUITE.slice(1), { cwd: s.repo, stdio: 'pipe' })).toThrow();
    const d = await dispatch(s);
    expect(d.status).toBe('DISPATCHED');
    const t = d.ticket!;
    expect(t.node_id).toBe(ERRORS);
    expect(t.verification).toMatchObject({ module: 'errors', module_sha256: errorsModule.sha256, path: 'packages/errors', runtime_tests: true, test: errorsModule.test, regression: FULL_SUITE });
    expect(packOf(t)['module']).toMatchObject({ id: 'errors', path: 'packages/errors', sha256: errorsModule.sha256, test: errorsModule.test, regression: FULL_SUITE });
    const claim = node(s).claim;
    expect(claim.verification).toMatchObject({ module: 'errors', module_sha256: errorsModule.sha256, plan: { test: errorsModule.test, report: { format: 'junit-xml' } }, regression: { command: FULL_SUITE } });
    const receipt = JSON.parse(readFileSync(join(s.control, claim.worktree_setup.receipt_path), 'utf8'));
    expect(receipt.verification).toEqual({ module: 'errors', module_sha256: errorsModule.sha256 });

    writeFiles(t.worktree, { 'packages/errors/test/errors.test.mjs': ERRORS_RED });
    const red = runGate(t, 'red', s.control);
    expect(red.code, red.out).toBe(0);
    const ev = node(s).evidence.red;
    expect(ev).toMatchObject({ module: 'errors', module_sha256: errorsModule.sha256, red_reason: 'behaviour-missing', red_category: 'assertion', command: errorsModule.test });
    expect(ev.plan_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ev.results).toMatchObject({ format: 'junit-xml', total: 2, failed: 1, passed: 1 });
    const results = JSON.parse(readFileSync(join(s.control, ev.results.path), 'utf8')) as { results: { file: string }[] };
    // Only the module's own tests ran: the poisoned dependent never did.
    expect([...new Set(results.results.map((r) => r.file))]).toEqual(['packages/errors/test/errors.test.mjs']);
    expect(ev.red_tests).toEqual([expect.objectContaining({ file: 'packages/errors/test/errors.test.mjs', name: 'ChangesetValidationError sorts the issues and lists one per line', status: 'failed', category: 'assertion' })]);
  });

  it('runs green with the same command, then fresh verification of the module on a clean checkout and the full suite for regression', async () => {
    const s = await shopWithModules({ baseFiles: POISON });
    const t = (await dispatch(s)).ticket!;
    commit(t.worktree, writeFiles(t.worktree, { 'packages/errors/test/errors.test.mjs': ERRORS_RED }), 'test: errors (RED)');
    // The test commit binds what red runs on: run it after committing, as a worker may.
    expect(runGate(t, 'red', s.control).code).toBe(0);
    commit(t.worktree, writeFiles(t.worktree, { 'packages/errors/src/index.mjs': ERRORS_IMPL }), 'feat: errors');
    const green = runGate(t, 'green', s.control);
    expect(green.code, green.out).toBe(0);
    expect(node(s).evidence.green).toMatchObject({ module: 'errors', module_sha256: errorsModule.sha256, command: errorsModule.test, results: { failed: 0, passed: 2 } });
    // The worker's regression gate runs the whole suite (with the class there, the dependent's test links again).
    const regression = runGate(t, 'regression', s.control);
    expect(regression.code, regression.out).toBe(0);
    expect(node(s).evidence.regression.command).toEqual(FULL_SUITE);

    writeFileSync(t.result_slot, JSON.stringify({ schema_version: 1, node_id: t.node_id, claim_id: t.claim_id, dispatch_id: t.dispatch_id, outcome: 'SUBMITTED', commands: [], commit_sha: execFileSync('git', ['-C', t.worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), changed_paths: [], evidence_paths: [], failure_fingerprint: null, decision_request: null, criterion_evidence: [{ criterion: 'AC-1', test: { path: 'packages/errors/test/errors.test.mjs', name: 'ChangesetValidationError sorts the issues and lists one per line' }, gate: 'red', output_sha256: node(s).evidence.red.output_sha256 }] }));
    const settled = JSON.parse((await shopCli(s, ['settle', SHOP_FEATURE, ERRORS, '--capability', t.capability, '--json'])).out) as Record<string, unknown>;
    expect(settled, JSON.stringify(settled)).toMatchObject({ outcome: 'DONE' });
    const done = node(s);
    expect(done.evidence.green).toMatchObject({ module: 'errors', module_sha256: errorsModule.sha256, command: errorsModule.test });
    expect(done.evidence.green.cwd).toMatch(/verify/);
    expect(done.evidence.regression).toMatchObject({ command: FULL_SUITE, exit_code: 0 });
    expect(done.last_settlement).toMatchObject({ outcome: 'DONE', module_sha256: errorsModule.sha256 });
  });

  it("refuses a command a worker passes instead of its claim's module command", async () => {
    const s = await shopWithModules();
    const t = (await dispatch(s)).ticket!;
    writeFiles(t.worktree, { 'packages/errors/test/errors.test.mjs': ERRORS_RED });
    const line = t.gate_commands.find((g) => g.gate === 'red')!.command;
    let out = '';
    let code = 0;
    try {
      execFileSync(process.execPath, [join(process.cwd(), 'bin', 'mycelink.mjs'), 'tdd', 'red', SHOP_FEATURE, ERRORS, '--control-root', s.control, '--capability', t.capability, '--', 'node', '-e', 'console.error("AssertionError: x"); process.exit(1)'], { stdio: 'pipe', encoding: 'utf8' });
    } catch (error) {
      const e = error as { status?: number; stderr?: string };
      code = e.status ?? 1;
      out = e.stderr ?? '';
    }
    expect(line).not.toContain(' -- ');
    expect(code).not.toBe(0);
    expect(out).toMatch(/GATE_COMMAND_BOUND/);
    expect(node(s).evidence).toEqual({});
  });

  it("runs the claim's bound module command even when repositories.yaml changes while the worker runs", async () => {
    const s = await shopWithModules();
    const t = (await dispatch(s)).ticket!;
    const file = join(s.control, 'repositories.yaml');
    const manifest = YAML.parse(readFileSync(file, 'utf8')) as { repositories: Record<string, any>[] };
    manifest.repositories[0]!['module_defaults']['test'] = ['node', '-e', 'process.exit(1)'];
    manifest.repositories[0]!['module_defaults']['report'] = null;
    writeFileSync(file, YAML.stringify(manifest, { lineWidth: 0 }));
    writeFiles(t.worktree, { 'packages/errors/test/errors.test.mjs': ERRORS_RED });
    expect(runGate(t, 'red', s.control).code).toBe(0);
    expect(node(s).evidence.red).toMatchObject({ command: errorsModule.test, module_sha256: errorsModule.sha256, red_category: 'assertion' });
  });

  it('stops dispatch with MODULE_DRIFT when the module descriptor changed after feature init, charging nothing', async () => {
    const s = await shopWithModules();
    const file = join(s.control, 'repositories.yaml');
    const manifest = YAML.parse(readFileSync(file, 'utf8')) as { repositories: Record<string, any>[] };
    manifest.repositories[0]!['module_defaults']['timeout_seconds'] = 301;
    writeFileSync(file, YAML.stringify(manifest, { lineWidth: 0 }));
    commitShopControl(s, 'retune the module timeout');
    const d = await dispatch(s);
    expect(d.status).toBe('PRECONDITION_FAILED');
    expect(d.detail).toMatch(/MODULE_DRIFT/);
    expect(node(s)).toMatchObject({ attempts: 0, failure_counts: {}, claim: null });
    // feature verify names the same drift.
    const verify = JSON.parse((await shopCli(s, ['feature', 'verify', SHOP_FEATURE, '--json'])).out) as { problems: string[] };
    expect(verify.problems.some((p) => p.startsWith('MODULE_DRIFT'))).toBe(true);
  });

  it("refuses at settle gate evidence that was not run with the claim's module", async () => {
    const s = await shopWithModules();
    const t = (await dispatch(s)).ticket!;
    commit(t.worktree, writeFiles(t.worktree, { 'packages/errors/test/errors.test.mjs': ERRORS_RED }), 'test: errors (RED)');
    expect(runGate(t, 'red', s.control).code).toBe(0);
    commit(t.worktree, writeFiles(t.worktree, { 'packages/errors/src/index.mjs': ERRORS_IMPL }), 'feat: errors');
    expect(runGate(t, 'green', s.control).code).toBe(0);
    expect(runGate(t, 'regression', s.control).code).toBe(0);
    mutateState(s.featureDir, (st) => {
      st.nodes[ERRORS]!.evidence.red!.module_sha256 = 'f'.repeat(64);
      return st;
    });
    writeFileSync(t.result_slot, JSON.stringify({ schema_version: 1, node_id: t.node_id, claim_id: t.claim_id, dispatch_id: t.dispatch_id, outcome: 'SUBMITTED', commands: [], commit_sha: execFileSync('git', ['-C', t.worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), changed_paths: [], evidence_paths: [], failure_fingerprint: null, decision_request: null }));
    const settled = JSON.parse((await shopCli(s, ['settle', SHOP_FEATURE, ERRORS, '--capability', t.capability, '--json'])).out) as Record<string, unknown>;
    expect(settled['outcome']).not.toBe('DONE');
    expect(String(settled['detail'])).toMatch(/^MODULE_BINDING_MISMATCH/);
    expect(shopState(s).integration_heads ?? {}).toEqual({});
  });
});
