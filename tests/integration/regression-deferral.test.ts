/**
 * A producer's full-suite regression may fail until its dependents re-verify.
 *
 * With module-scoped gates a producer proves its own module RED and GREEN;
 * its regression still runs the repository's whole suite, and there a
 * dependent's test that pins the producer's old behaviour fails until the
 * dependent's own node adapts. When every failing test lies in a module a
 * pending dependent of this node owns, the failure is that dependency's
 * expected invalidation, not the producer's defect: the regression gate and
 * fresh verification record it as deferred to those dependents, the producer
 * settles, a DONE dependent is reopened, and the dependents later pass the
 * full suite themselves; feature verify and the candidate still require the
 * whole suite. A failure anywhere else is the producer's own.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { commitShopControl, createShop, moduleVerifier, shopCli, shopState, SHOP_FEATURE, type Shop } from '../helpers/shop-fixture.js';
import { fulfil, type ShopTicket, type ShopWork } from '../helpers/shop-worker.js';

afterAll(() => cleanupTmpRoots());

const ERR = `${SHOP_FEATURE}.shop.errors.git`;
const CLI = `${SHOP_FEATURE}.shop.cli.git`;
const CAND = `${SHOP_FEATURE}.release.candidate.build`;

const BASE = {
  'packages/cli/src/git.mjs': "/** How the CLI reports a failed git command. */\nexport const describeGitFailure = (error) => 'git: ' + error.message;\n",
  'packages/cli/test/git.test.mjs': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitError } from '../../errors/src/index.mjs';
import { describeGitFailure } from '../src/git.mjs';

test('describes a git failure', () => {
  assert.equal(describeGitFailure(new GitError(128, 'fetch failed')), 'git: fetch failed, exit code: 128');
});
`,
};

const WORK: Record<string, ShopWork> = {
  [ERR]: {
    tests: {
      'packages/errors/test/errors.test.mjs': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitError } from '../src/index.mjs';

test('a git error carries its exit code', () => {
  assert.equal(new GitError(1, 'failed').code, 1);
});

test('a git error keeps the bare message', () => {
  assert.equal(new GitError(128, 'fetch failed').message, 'fetch failed');
});
`,
    },
    impl: { 'packages/errors/src/index.mjs': 'export class GitError extends Error {\n  constructor(code, message) {\n    super(message);\n    this.code = code;\n  }\n}\n' },
    criteria: [{ criterion: 'AC-1', path: 'packages/errors/test/errors.test.mjs', name: 'a git error keeps the bare message', gate: 'red' }],
  },
  [CLI]: {
    tests: {
      'packages/cli/test/git.test.mjs': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitError } from '../../errors/src/index.mjs';
import { describeGitFailure } from '../src/git.mjs';

test('describes a git failure', () => {
  assert.equal(describeGitFailure(new GitError(128, 'fetch failed')), 'git exited 128: fetch failed');
});
`,
    },
    impl: { 'packages/cli/src/git.mjs': "/** How the CLI reports a failed git command. */\nexport const describeGitFailure = (error) => `git exited ${error.code}: ${error.message}`;\n" },
    criteria: [{ criterion: 'AC-2', path: 'packages/cli/test/git.test.mjs', name: 'describes a git failure', gate: 'red' }],
  },
};

function graph(): Record<string, unknown> {
  const v = moduleVerifier();
  const worker = { model: 'sonnet', max_turns: 10, max_wall_clock_minutes: 5, max_attempts: 2, nested_delegation: false };
  const node = (id: string, module: string, depends: string[], ac: string) => ({
    id,
    level: 'executable-node',
    repository: 'shop',
    capability: 'CAP-GIT',
    node_type: 'implementation',
    depends_on: depends,
    allowed_paths: [`packages/${module}/**`],
    forbidden_paths: [],
    contract_inputs: [],
    contract_outputs: [],
    required_resources: [],
    required_evidence: ['red', 'green', 'regression'],
    verification_commands: [v(module)],
    worker,
    invalidation_rules: [],
    acceptance_criteria: [ac],
  });
  return {
    schema_version: 1,
    feature_id: SHOP_FEATURE,
    title: 'Report git failures by exit code',
    acceptance_criteria: [
      { id: 'AC-1', text: 'errors: a GitError keeps the bare message and its exit code' },
      { id: 'AC-2', text: 'cli: a git failure is reported as "git exited <code>: <message>"' },
    ],
    resources: { 'full-runtime': { capacity: 1 } },
    repositories: ['shop'],
    capabilities: [{ id: 'CAP-GIT', repository: 'shop', title: 'git failures' }],
    nodes: [
      node(ERR, 'errors', [], 'AC-1'),
      node(CLI, 'cli', [ERR], 'AC-2'),
      {
        id: CAND,
        level: 'executable-node',
        repository: null,
        capability: null,
        node_type: 'candidate-build',
        depends_on: [ERR, CLI],
        allowed_paths: [],
        forbidden_paths: [],
        contract_inputs: [],
        contract_outputs: [],
        required_resources: [],
        required_evidence: ['candidate'],
        verification_commands: [{ id: 'candidate', command: ['mycelink', 'candidate', 'verify', SHOP_FEATURE] }],
        worker: { ...worker, max_turns: 1 },
        invalidation_rules: [],
        acceptance_criteria: [],
      },
    ],
  };
}

async function step(s: Shop): Promise<{ status: string; ticket?: ShopTicket; detail: string }> {
  const d = await shopCli(s, ['dispatch', SHOP_FEATURE, '--json']);
  expect(d.err).toBe('');
  return JSON.parse(d.out) as { status: string; ticket?: ShopTicket; detail: string };
}

async function settle(s: Shop, t: ShopTicket): Promise<Record<string, unknown>> {
  const r = await shopCli(s, ['settle', SHOP_FEATURE, t.node_id, '--capability', t.capability, '--json']);
  expect(r.err).toBe('');
  return JSON.parse(r.out) as Record<string, unknown>;
}

describe('a producer regression deferred to the dependents it invalidates', () => {
  it("defers a failure in a pending dependent's module, then holds the dependent and the candidate to the whole suite", async () => {
    const s = await createShop({ modules: 'structured', graph: graph(), baseFiles: BASE });
    const first = await step(s);
    expect(first.ticket?.node_id).toBe(ERR);
    const run = fulfil(first.ticket!, WORK[ERR]!, s.control);
    // The producer's own module passes; the whole suite fails only in cli's test, which pins the old message.
    expect(run.gates.map((g) => [g.gate, g.code])).toEqual([['red', 0], ['green', 0], ['regression', 0]]);
    expect(run.gates[2]!.out).toMatch(/deferred to SHOP-202\.shop\.cli\.git/);
    expect(shopState(s).nodes[ERR].evidence.regression).toMatchObject({ exit_code: 1, regression_deferred: { to: [CLI], failing: ['packages/cli/test/git.test.mjs'] } });

    expect(await settle(s, first.ticket!)).toMatchObject({ outcome: 'DONE' });
    const producer = shopState(s).nodes[ERR];
    expect(producer.evidence.regression).toMatchObject({ exit_code: 1, regression_deferred: { to: [CLI], failing: ['packages/cli/test/git.test.mjs'] } });
    // Until the dependent re-verifies, the feature is not complete, and says why.
    const pending = JSON.parse((await shopCli(s, ['feature', 'verify', SHOP_FEATURE, '--json'])).out) as { problems: string[] };
    expect(pending.problems).toEqual(expect.arrayContaining([expect.stringMatching(new RegExp(`^REGRESSION_DEFERRED: ${ERR.replace(/\./g, '\\.')} deferred its regression to ${CLI.replace(/\./g, '\\.')}, which is (PLANNED|READY)`))]));

    const second = await step(s);
    expect(second.ticket?.node_id).toBe(CLI);
    const cli = fulfil(second.ticket!, WORK[CLI]!, s.control);
    expect(cli.gates.map((g) => [g.gate, g.code])).toEqual([['red', 0], ['green', 0], ['regression', 0]]);
    expect(await settle(s, second.ticket!)).toMatchObject({ outcome: 'DONE' });
    // The dependent's own regression is the whole suite, passing, deferred to nobody.
    expect(shopState(s).nodes[CLI].evidence.regression).toMatchObject({ exit_code: 0 });
    expect(shopState(s).nodes[CLI].evidence.regression.regression_deferred ?? null).toBeNull();

    const last = await step(s);
    expect(last.status).toBe('ALL_SETTLED');
    commitShopControl(s, 'settled');
    const verify = JSON.parse((await shopCli(s, ['feature', 'verify', SHOP_FEATURE, '--json'])).out) as { ok: boolean; problems: string[] };
    expect(verify).toEqual({ ok: true, problems: [] });
    const delivery = JSON.parse((await shopCli(s, ['deliver', SHOP_FEATURE, '--json'])).out) as { status: string; acceptance: { exit_code: number }[] };
    expect(delivery.status).toBe('ACCEPTED');
    expect(delivery.acceptance.map((a) => a.exit_code)).toEqual([0]);
  });

  it("never defers a failure no pending dependent owns: it is the producer's own regression", async () => {
    const s = await createShop({
      modules: 'structured',
      graph: graph(),
      baseFiles: {
        ...BASE,
        // A module no node of the feature owns pins the old message too.
        'packages/read/test/git.test.mjs': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitError } from '../../errors/src/index.mjs';

test('reads a git failure', () => {
  assert.equal(new GitError(128, 'fetch failed').message, 'fetch failed, exit code: 128');
});
`,
      },
    });
    const t = (await step(s)).ticket!;
    const run = fulfil(t, WORK[ERR]!, s.control);
    expect(run.gates.map((g) => [g.gate, g.code])).toEqual([['red', 0], ['green', 0], ['regression', 2]]);
    expect(run.gates[2]!.out).toMatch(/packages\/read\/test\/git\.test\.mjs/);
    expect(shopState(s).nodes[ERR].evidence.regression.regression_deferred ?? null).toBeNull();
    const settled = await settle(s, t);
    expect(settled['outcome']).not.toBe('DONE');
    expect(shopState(s).nodes[ERR].integrated_sha).toBeNull();
  });
});
