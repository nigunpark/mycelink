/**
 * The worktree setup's inputs: a node that changes what its repository's
 * setup installs from gets the setup again before its next gate.
 *
 * CSET-202 r1, with-normal: the read node needed `@changesets/errors`, a
 * package of the same workspace, but its worktree had been installed at the
 * base, where read did not depend on it, and the worker was told never to
 * change dependencies. So it imported `../../errors/src/index.ts` instead,
 * and the error class read threw was not the one cli caught: hidden
 * acceptance found the identity broken. The reference declares the
 * dependency (packages/read/package.json, three lines of pnpm-lock.yaml) and
 * installs again. A repository's `worktree_setup.inputs` names the files its
 * setup installs from; the receipt binds their hash, and a gate that finds
 * them changed in its worktree runs the same setup there first (the same
 * argv and environment, the same receipt checks: no tracked change, no
 * output git would see). The worker never runs an install.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { readEvents } from '../../src/state/event-log.js';
import { ERRORS, SHOP_FEATURE, createShop, moduleVerifier, shopCli, shopGraph, shopState, type Shop } from '../helpers/shop-fixture.js';
import { commit, packOf, runGate, writeFiles, type ShopTicket } from '../helpers/shop-worker.js';

afterAll(() => cleanupTmpRoots());

/** The setup: "install" every module's declared links (packages/<m>/deps.json) into node_modules. */
const INSTALL = [
  "const fs = require('node:fs');",
  'const out = {};',
  "for (const m of fs.readdirSync('packages')) {",
  "  const f = 'packages/' + m + '/deps.json';",
  "  if (fs.existsSync(f)) out[m] = JSON.parse(fs.readFileSync(f, 'utf8'));",
  '}',
  "fs.mkdirSync('node_modules', { recursive: true });",
  "fs.writeFileSync('node_modules/links.json', JSON.stringify(out));",
].join('\n');

const LINK_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('errors links the shared package', () => {
  const links = JSON.parse(readFileSync('node_modules/links.json', 'utf8'));
  assert.deepEqual(links.errors, ['shared']);
});
`;

async function shopWith(inputs: string[] | undefined): Promise<{ s: Shop; t: ShopTicket }> {
  const s = await createShop({
    modules: 'structured',
    graph: shopGraph(moduleVerifier()),
    baseFiles: { '.gitignore': 'node_modules/\n', 'packages/errors/deps.json': '[]\n' },
    worktreeSetup: { commands: [['node', '-e', INSTALL]], timeout_seconds: 60, required_paths: ['node_modules'], ...(inputs !== undefined ? { inputs } : {}) },
  });
  const d = await shopCli(s, ['dispatch', SHOP_FEATURE, '--json']);
  expect(d.err).toBe('');
  const t = (JSON.parse(d.out) as { ticket: ShopTicket }).ticket;
  expect(t.node_id).toBe(ERRORS);
  // The worker is told to declare a sibling dependency, never to install it or import it by path.
  if (inputs !== undefined) {
    expect(packOf(t)['worktree_setup']['inputs']).toEqual(inputs);
    expect(t.prompt).toMatch(/declare that dependency in the\s+package manifest and lockfile/);
    expect(t.prompt).toMatch(/never by a relative path into the other package's sources/);
  } else {
    expect(packOf(t)['worktree_setup']['inputs']).toBeUndefined();
    expect(t.prompt).toMatch(/Do not change dependencies\./);
  }
  expect(t.prompt).toMatch(/Never run an install or the setup yourself/);
  // The RED: the link the base does not declare, failing an assertion; committed alone.
  const tests = writeFiles(t.worktree, { 'packages/errors/test/links.test.mjs': LINK_TEST });
  const red = runGate(t, 'red', s.control);
  expect(red.code, red.out).toBe(0);
  commit(t.worktree, tests, 'test: errors links shared (RED)');
  // The production change declares the link: an input of the setup.
  writeFileSync(join(t.worktree, 'packages', 'errors', 'deps.json'), '["shared"]\n');
  return { s, t };
}

const setupEvents = (s: Shop) => readEvents(join(s.control, 'features', SHOP_FEATURE, 'events.jsonl')).filter((e) => e.type === 'worktree.setup');

describe('worktree setup inputs', () => {
  it('a gate that finds the setup inputs changed runs the setup again in the worktree first, and binds the new receipt', async () => {
    const { s, t } = await shopWith(['**/deps.json']);
    const first = shopState(s).nodes[ERRORS].claim.worktree_setup;
    expect(first.inputs_sha256).toMatch(/^[0-9a-f]{64}$/);
    const green = runGate(t, 'green', s.control);
    expect(green.code, green.out).toBe(0);
    expect(green.out).toMatch(/worktree setup ran again: its inputs changed \(packages\/errors\/deps\.json\)/);
    const rt = shopState(s).nodes[ERRORS];
    expect(rt.claim.worktree_setup.receipt_sha256).not.toBe(first.receipt_sha256);
    expect(rt.claim.worktree_setup.inputs_sha256).not.toBe(first.inputs_sha256);
    expect(rt.worktree_setup.receipt_sha256).toBe(rt.claim.worktree_setup.receipt_sha256);
    expect(rt.evidence.green.worktree_setup_sha256).toBe(rt.claim.worktree_setup.receipt_sha256);
    // The gate's evidence names the inputs it ran on.
    expect(rt.evidence.red.setup_inputs_sha256).toBe(first.inputs_sha256);
    expect(rt.evidence.green.setup_inputs_sha256).toBe(rt.claim.worktree_setup.inputs_sha256);
    expect(setupEvents(s).map((e) => e.data['purpose'])).toEqual(['worker', 'inputs-changed']);
    const receipt = JSON.parse(readFileSync(join(s.control, rt.claim.worktree_setup.receipt_path), 'utf8'));
    expect(receipt).toMatchObject({ status: 'complete', inputs_sha256: rt.claim.worktree_setup.inputs_sha256 });
    // Committing changes nothing the setup reads: regression runs without another setup.
    commit(t.worktree, ['packages/errors/deps.json'], 'feat: errors links shared');
    const regression = runGate(t, 'regression', s.control);
    expect(regression.code, regression.out).toBe(0);
    expect(regression.out).not.toMatch(/worktree setup ran again/);
    expect(setupEvents(s)).toHaveLength(2);
  });

  it('without declared inputs the gate runs on the setup as it was: the changed declaration is not installed', async () => {
    const { s, t } = await shopWith(undefined);
    expect(shopState(s).nodes[ERRORS].claim.worktree_setup.inputs_sha256).toBeUndefined();
    const green = runGate(t, 'green', s.control);
    expect(green.code).not.toBe(0);
    expect(setupEvents(s)).toHaveLength(1);
  });

  it('a setup that fails on the changed inputs refuses the gate: nothing runs or is recorded, and the worktree keeps its edits', async () => {
    const { s, t } = await shopWith(['**/deps.json']);
    writeFileSync(join(t.worktree, 'packages', 'errors', 'deps.json'), '["shared"\n');
    const green = runGate(t, 'green', s.control);
    expect(green.code).toBe(2);
    expect(green.out).toMatch(/green gate refused: WORKTREE_SETUP_FAILED: .*COMMAND_FAILED/);
    expect(green.out).toMatch(/Nothing was run or recorded/);
    const rt = shopState(s).nodes[ERRORS];
    expect(rt.evidence.green).toBeUndefined();
    expect(rt.worktree_setup.status).toBe('failed');
    expect(readFileSync(join(t.worktree, 'packages', 'errors', 'deps.json'), 'utf8')).toBe('["shared"\n');
    // Repaired, the next gate sets the worktree up again and runs.
    writeFileSync(join(t.worktree, 'packages', 'errors', 'deps.json'), '["shared"]\n');
    const again = runGate(t, 'green', s.control);
    expect(again.code, again.out).toBe(0);
  });

  it('inputs are validated like required paths: relative globs inside the worktree, never git’s own directory', async () => {
    const { worktreeSetupProblems } = await import('../../src/engine/worktree-setup.js');
    const problems = worktreeSetupProblems({ commands: [['node', '-e', '0']], inputs: ['pnpm-lock.yaml', '**/package.json', '../outside.json', '.git/config', '/etc/passwd'] }, '/repositories/0/worktree_setup');
    expect(problems.map((p) => p.path)).toEqual(['/repositories/0/worktree_setup/inputs/2', '/repositories/0/worktree_setup/inputs/3', '/repositories/0/worktree_setup/inputs/4']);
  });
});
