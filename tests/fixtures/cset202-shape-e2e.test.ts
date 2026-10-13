/**
 * The CSET-202 shape, model-free, on the shop portfolio (every platform).
 *
 * r1 with-normal: four nodes delivered C001 on their own green suites while
 * hidden acceptance found the shared error identity and the CLI's reporting
 * missing, and core had accepted the errors node's missing-symbol RED. r1
 * with-faults: after the late defect removed the errors export, the reworked
 * errors node's whole-suite RED was poisoned by the cli tests already
 * integrated in its base, and the producer BLOCKED. Here, with module
 * descriptors, module verifiers and criterion evidence:
 *
 *   1. four module workers each prove a RED that only their own module ran,
 *      failing an assertion (a new export inspected dynamically), name each
 *      criterion's test, settle DONE; the candidate's full suite and delivery
 *      acceptance pass; hidden-like acceptance checks — the error class one
 *      identity across read, assemble and cli; cli reporting once with exit
 *      1; valid changesets unchanged — pass on the delivered C001;
 *   2. a late defect removes the export on the delivered base: the whole
 *      suite no longer links and the acceptance checks fail; QA's report is
 *      attributed to the errors node, which is reworked with its dependents;
 *   3. the errors rework RED runs only the errors module — unaffected by the
 *      dependents' tests that no longer link — and fails an assertion; the
 *      fix passes its module and the full suite; read, assemble and cli
 *      reopen and re-verify on the repaired integration; C002 delivers and
 *      the acceptance checks pass again.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { commitAll, git } from '../helpers/git-fixture.js';
import {
  ASSEMBLE,
  CLI_NODE,
  ERRORS,
  ERRORS_IMPL,
  ERRORS_RED,
  FULL_SUITE,
  READ,
  SHOP_CANDIDATE,
  SHOP_CRITERIA,
  SHOP_FEATURE,
  SHOP_WORK,
  commitShopControl,
  createShop,
  moduleVerifier,
  shopCli,
  shopGraph,
  shopState,
  type Shop,
} from '../helpers/shop-fixture.js';
import { fulfil, packOf, type ShopTicket } from '../helpers/shop-worker.js';

afterAll(() => cleanupTmpRoots());

/** Checks in the spirit of the hidden acceptance suite, run on a repository checkout from outside it. */
const ACCEPTANCE = `import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
const load = (rel) => import(pathToFileURL(join(root, rel)).href);
const errors = await load('packages/errors/src/index.mjs');
const { readChangesets } = await load('packages/read/src/index.mjs');
const { assembleReleasePlan } = await load('packages/assemble/src/index.mjs');
const { status } = await load('packages/cli/src/index.mjs');
const Cve = errors.ChangesetValidationError;
assert.equal(typeof Cve, 'function', 'AC-1: errors exports ChangesetValidationError');
const e = new Cve([{ changesetId: 'b', code: 'UNKNOWN_PACKAGE', message: 'z' }, { changesetId: 'a', code: 'MIXED_IGNORED', message: 'y' }, { changesetId: 'a', code: 'INVALID_FILE', message: 'x' }]);
assert.ok(e instanceof Error);
assert.deepEqual(e.issues.map((i) => [i.changesetId, i.code]), [['a', 'INVALID_FILE'], ['a', 'MIXED_IGNORED'], ['b', 'UNKNOWN_PACKAGE']], 'AC-1: sorted');
assert.equal(e.message, 'Invalid changesets:\\n- a: x\\n- a: y\\n- b: z', 'AC-1: one line per issue');
assert.throws(() => readChangesets({ a: 'nope', b: '---\\nweb: patch\\n---\\nok', c: 'bad' }), (err) => err instanceof Cve && err.issues.map((i) => i.changesetId).join() === 'a,c', 'AC-2: one error of the errors module, every unparseable changeset');
assert.throws(() => assembleReleasePlan([{ id: 'x', releases: [{ name: 'gone', type: 'patch' }] }, { id: 'y', releases: [{ name: 'nope', type: 'minor' }] }], ['web']), (err) => err instanceof Cve && err.issues.length === 2, 'AC-3: one error of the errors module, every unknown package');
const out = [];
const err = [];
assert.equal(status({ files: { a: 'nope', b: '---\\ngone: patch\\n---\\nx' }, packages: ['web'], io: { log: (l) => out.push(l), error: (l) => err.push(l) } }), 1, 'AC-4: exit 1');
assert.equal(err.length, 1, 'AC-4: printed once');
assert.match(err[0], /^Invalid changesets:/);
assert.doesNotMatch(err[0], /\\n\\s+at /, 'AC-4: no stack trace');
const lines = [];
assert.equal(status({ files: { a: '---\\nweb: patch\\n---\\nfix' }, packages: ['web'], io: { log: (l) => lines.push(l), error: (l) => lines.push('E ' + l) } }), 0, 'AC-5: valid changesets unchanged');
assert.deepEqual(lines, ['web: patch']);
console.log('ACCEPTED');
`;

function acceptance(repo: string): { code: number; out: string } {
  const dir = makeTmpDir('shop-acceptance-');
  const script = join(dir, 'acceptance.mjs');
  writeFileSync(script, ACCEPTANCE);
  const r = spawnSync(process.execPath, [script, repo], { encoding: 'utf8' });
  return { code: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
}

function fullSuite(repo: string): number {
  return spawnSync(FULL_SUITE[0]!, FULL_SUITE.slice(1), { cwd: repo, encoding: 'utf8' }).status ?? 1;
}

async function dispatch(s: Shop): Promise<{ status: string; detail: string; ticket?: ShopTicket }> {
  const d = await shopCli(s, ['dispatch', SHOP_FEATURE, '--json']);
  expect(d.err).toBe('');
  return JSON.parse(d.out) as { status: string; detail: string; ticket?: ShopTicket };
}

async function settle(s: Shop, t: ShopTicket): Promise<Record<string, unknown>> {
  const r = await shopCli(s, ['settle', SHOP_FEATURE, t.node_id, '--capability', t.capability, '--json']);
  expect(r.err).toBe('');
  return JSON.parse(r.out) as Record<string, unknown>;
}

const resultsFiles = (s: Shop, nodeId: string, kind: 'red' | 'green'): string[] => {
  const ev = shopState(s).nodes[nodeId].evidence[kind];
  const doc = JSON.parse(readFileSync(join(s.control, ev.results.path), 'utf8')) as { results: { file: string }[] };
  return [...new Set(doc.results.map((r) => r.file))];
};

/** The regression test the errors worker adds in rework: the export survives, inspected dynamically. */
const ERRORS_REGRESSION = `${ERRORS_RED}
test('ChangesetValidationError is still exported for the packages that throw it', async () => {
  const errors = await import('../src/index.mjs');
  assert.equal(typeof errors.ChangesetValidationError, 'function');
});
`;

describe('CSET-202 shape, model-free: C001, the late defect, C002', () => {
  let s: Shop;
  let delivered = '';

  it('1. four module workers prove module-scoped REDs, name their criteria, and deliver C001 that the acceptance checks accept', async () => {
    s = await createShop({ modules: 'structured', graph: shopGraph(moduleVerifier()) });
    expect(acceptance(s.repo).code).not.toBe(0);
    const order: string[] = [];
    for (let i = 0; i < 4; i++) {
      const d = await dispatch(s);
      expect(d.status, d.detail).toBe('DISPATCHED');
      const t = d.ticket!;
      order.push(t.node_id);
      expect(packOf(t)['module']['id']).toBe(t.node_id.split('.')[2]);
      const run = fulfil(t, { ...SHOP_WORK[t.node_id]!, criteria: SHOP_CRITERIA[t.node_id] }, s.control);
      expect(run.gates.map((g) => g.code), JSON.stringify(run.gates.map((g) => g.out.slice(-400)))).toEqual([0, 0, 0]);
      expect(await settle(s, t)).toMatchObject({ outcome: 'DONE' });
      const red = shopState(s).nodes[t.node_id].evidence.red;
      expect(red).toMatchObject({ red_reason: 'behaviour-missing', red_category: expect.stringMatching(/^(assertion|exception)$/), module: t.node_id.split('.')[2] });
      // Each RED ran its own module's tests only.
      expect(resultsFiles(s, t.node_id, 'red').every((f) => f.startsWith(`packages/${t.node_id.split('.')[2]}/`))).toBe(true);
    }
    expect(order[0]).toBe(ERRORS);
    expect(order.at(-1)).toBe(CLI_NODE);
    const done = await dispatch(s);
    expect(done.status).toBe('ALL_SETTLED');
    expect(shopState(s).nodes[SHOP_CANDIDATE].state).toBe('DONE');
    commitShopControl(s, 'C001 settled');
    const cv = JSON.parse((await shopCli(s, ['candidate', 'verify', SHOP_FEATURE, '--json'])).out) as { ok: boolean };
    expect(cv.ok).toBe(true);
    const delivery = JSON.parse((await shopCli(s, ['deliver', SHOP_FEATURE, '--json'])).out) as { status: string; candidate_id: string; acceptance: { command: string[]; exit_code: number }[] };
    expect(delivery).toMatchObject({ status: 'ACCEPTED', candidate_id: `${SHOP_FEATURE}-C001` });
    expect(delivery.acceptance).toEqual([expect.objectContaining({ command: FULL_SUITE, exit_code: 0 })]);
    commitShopControl(s, 'C001 delivered');
    delivered = git(s.repo, ['rev-parse', 'main']);
    const checks = acceptance(s.repo);
    expect(checks.code, checks.out).toBe(0);
  });

  it('2. a late defect removes the export on the delivered base: the suite no longer links, acceptance fails, QA reworks the errors node with its dependents', async () => {
    writeFileSync(join(s.repo, 'packages', 'errors', 'src', 'index.mjs'), `export class GitError extends Error {\n  constructor(code, message) {\n    super(\`\${message}, exit code: \${code}\`);\n    this.code = code;\n  }\n}\n`);
    const defect = commitAll(s.repo, 'chore: sync platform changes');
    expect(fullSuite(s.repo)).not.toBe(0);
    expect(acceptance(s.repo).code).not.toBe(0);
    const reworked = await shopCli(s, ['feature', 'rework', SHOP_FEATURE, '--reason', 'QA: AC-1, AC-2, AC-3 fail on the delivered main: ChangesetValidationError is not exported by packages/errors; read, assemble and cli cannot load', '--since-delivery', '--json']);
    expect(reworked.err).toBe('');
    const report = JSON.parse(reworked.out) as { targets: string[]; reworks: { reopened: string[]; adopted_bases?: { to: string }[] }[] };
    expect(report.targets).toEqual([ERRORS]);
    expect(report.reworks[0]!.reopened).toEqual(expect.arrayContaining([ERRORS, READ, ASSEMBLE, CLI_NODE, SHOP_CANDIDATE]));
    expect(report.reworks[0]!.adopted_bases).toEqual([expect.objectContaining({ to: defect })]);
    expect(git(s.repo, ['merge-base', delivered, defect])).toBe(delivered);
    commitShopControl(s, 'rework errors');
  });

  it("3. the errors rework RED runs only its module, unpoisoned by the dependents' broken tests; dependents re-verify; C002 delivers and acceptance passes", async () => {
    const d = await dispatch(s);
    expect(d.ticket?.node_id).toBe(ERRORS);
    const t = d.ticket!;
    // The dependents' tests already in this worktree's base no longer link: the whole suite is broken there.
    expect(fullSuite(t.worktree)).not.toBe(0);
    const run = fulfil(t, { tests: { 'packages/errors/test/errors.test.mjs': ERRORS_REGRESSION }, impl: { 'packages/errors/src/index.mjs': ERRORS_IMPL }, criteria: [{ criterion: 'AC-1', path: 'packages/errors/test/errors.test.mjs', name: 'ChangesetValidationError is still exported for the packages that throw it', gate: 'red' }] }, s.control);
    expect(run.gates.map((g) => [g.gate, g.code]), JSON.stringify(run.gates.map((g) => g.out.slice(-600)))).toEqual([['red', 0], ['green', 0], ['regression', 0]]);
    const red = shopState(s).nodes[ERRORS].evidence.red;
    expect(red).toMatchObject({ red_reason: 'behaviour-missing', red_category: 'assertion', module: 'errors' });
    expect(resultsFiles(s, ERRORS, 'red')).toEqual(['packages/errors/test/errors.test.mjs']);
    expect(red.red_tests).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'ChangesetValidationError is still exported for the packages that throw it', status: 'failed', category: 'assertion' })]));
    expect(await settle(s, t)).toMatchObject({ outcome: 'DONE' });
    // The repaired producer's full suite passes on its own: nothing to defer.
    expect(shopState(s).nodes[ERRORS].evidence.regression).toMatchObject({ exit_code: 0 });

    const reverified: string[] = [];
    for (let i = 0; i < 3; i++) {
      const next = await dispatch(s);
      expect(next.status, next.detail).toBe('DISPATCHED');
      const dt = next.ticket!;
      reverified.push(dt.node_id);
      // A dependent reopened by an upstream rework keeps its RED: it re-proves GREEN and regression on the repaired integration.
      expect(packOf(dt)['next_required_gate']).toBe('GREEN_VERIFIED');
      const r = fulfil(dt, { ...SHOP_WORK[dt.node_id]!, criteria: SHOP_CRITERIA[dt.node_id] }, s.control);
      expect(r.gates.map((g) => [g.gate, g.code])).toEqual([['green', 0], ['regression', 0]]);
      expect(await settle(s, dt)).toMatchObject({ outcome: 'DONE' });
    }
    expect(reverified.sort()).toEqual([ASSEMBLE, CLI_NODE, READ].sort());
    expect((await dispatch(s)).status).toBe('ALL_SETTLED');
    commitShopControl(s, 'C002 settled');
    expect(JSON.parse((await shopCli(s, ['feature', 'verify', SHOP_FEATURE, '--json'])).out)).toEqual({ ok: true, problems: [] });
    const delivery = JSON.parse((await shopCli(s, ['deliver', SHOP_FEATURE, '--json'])).out) as { status: string; candidate_id: string };
    expect(delivery).toMatchObject({ status: 'ACCEPTED', candidate_id: `${SHOP_FEATURE}-C002` });
    commitShopControl(s, 'C002 delivered');
    const head = git(s.repo, ['rev-parse', 'main']);
    expect(git(s.repo, ['merge-base', '--is-ancestor', git(s.repo, ['log', '--format=%H', '-1', '--grep', 'chore: sync platform changes']), head]) === '').toBe(true);
    const checks = acceptance(s.repo);
    expect(checks.code, checks.out).toBe(0);
    expect(fullSuite(s.repo)).toBe(0);
    const verified = JSON.parse((await shopCli(s, ['feature', 'verify', SHOP_FEATURE, '--delivered', '--json'])).out) as { ok: boolean };
    expect(verified.ok).toBe(true);
  });
});
