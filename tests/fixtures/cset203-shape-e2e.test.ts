/**
 * The CSET-203 shape, model-free, on a Changesets-like repository (every platform).
 *
 * r1 with-normal: the cli node's code, history and gates passed, but its
 * result mapped AC-4 (a new behaviour) to an existing GREEN test; the
 * correction could only give up (CRITERION_UNPROVEN:AC-4), was charged twice
 * and the node BLOCKED. r1 with-faults: the planner's compatibility node
 * (AC-5) was a worker node with no allowed paths; it submitted nothing and
 * BLOCKED on NO_DECLARATION_COMMIT. Here, end to end:
 *
 *   1. apply-release-plan proves AC-1 and AC-2 by its RED and settles DONE;
 *   2. the cli proves AC-3 by its RED but maps AC-4 to an existing GREEN
 *      test: held on the same claim, nothing charged; `dispatch --resume`
 *      hands a fresh worker the correction naming AC-4, its kind and the red
 *      gate; it adds AC-4's own RED cycle and settles DONE (two cycles,
 *      attempt 1, no failure);
 *   3. r1's compat node — now a verification node — runs inside dispatch:
 *      no ticket or worker, the integrated head checked out afresh, both
 *      modules and the full suite passing, AC-5 evidenced by its receipt;
 *   4. the candidate binds that head, delivery is accepted, `feature verify
 *      --delivered` passes, and acceptance checks in the spirit of the hidden
 *      suite pass on the delivered commit.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
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
  COMPAT,
  VER_CANDIDATE,
  VER_FEATURE,
  VER_WORK,
  commitVerControl,
  createVer,
  verCli,
  verState,
} from '../helpers/version-fixture.js';
import { commit, fulfil, packOf, runGate, writeFiles, type ShopTicket } from '../helpers/shop-worker.js';

afterAll(() => cleanupTmpRoots());

const CLI_TESTS = 'packages/cli/test/cli.test.mjs';
const id = (name: string): string => canonicalTestId('junit-xml', CLI_TESTS, name);

/** Checks in the spirit of the hidden acceptance suite, run on a checkout from outside it. */
const ACCEPTANCE = `import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
const load = (rel) => import(pathToFileURL(join(root, rel)).href);
const arp = await load('packages/apply-release-plan/src/index.mjs');
const { version, status } = await load('packages/cli/src/index.mjs');
// AC-1: a failed apply restores everything and keeps the cause.
const files = new Map([['a/package.json', '1'], ['.changeset/x.md', 'x']]);
const boom = new Error('boom');
const err = await arp.applyReleasePlan(files, [{ path: 'a/package.json', content: '2' }, { path: 'a/NEW.md', content: 'n' }, { path: '.changeset/x.md', content: null }], { format: async (p) => { if (p === '.changeset/x.md') throw boom; } }).then(() => null, (e) => e);
assert.equal(err.cause, boom, 'AC-1 cause');
assert.deepEqual([...files].sort(), [['.changeset/x.md', 'x'], ['a/package.json', '1']], 'AC-1 restored');
// AC-2: a dot-named journal in .changeset while applying, none after.
const seen = [];
await arp.applyReleasePlan(files, [{ path: 'a/package.json', content: '2' }], { format: async () => seen.push([...files.keys()].some((p) => /^\\.changeset\\/\\./.test(p))) });
assert.deepEqual(seen, [true], 'AC-2 journal while applying');
assert.ok(![...files.keys()].some((p) => /^\\.changeset\\/\\./.test(p)), 'AC-2 no journal after');
// AC-3: an interrupted run is recovered, with a warning.
const journal = JSON.stringify({ before: [{ path: 'p.json', content: 'v1' }] });
const left = new Map([['p.json', 'v2'], ['.changeset/.version-journal.json', journal]]);
const warn = [];
assert.equal(await version({ files: left, changes: [{ path: 'p.json', content: 'v2' }], io: { log() {}, warn: (m) => warn.push(m), error() {} }, git: { add() {}, commit() {} } }), 0);
assert.ok(warn.some((w) => /interrupted/.test(w)), 'AC-3 warns');
assert.deepEqual([...left], [['p.json', 'v2']], 'AC-3 once');
// AC-4: a failed apply, no stack, exit 1, no git.
const errors = [];
const calls = [];
assert.equal(await version({ files: new Map([['p.json', 'v1']]), changes: [{ path: 'p.json', content: 'v2' }], config: { commit: true }, io: { log() {}, warn() {}, error: (m) => errors.push(m) }, git: { add: () => calls.push('add'), commit: () => calls.push('commit') }, format: async () => { throw new Error('fmt'); } }), 1, 'AC-4 exit 1');
assert.equal(errors.length, 1);
assert.doesNotMatch(errors[0], /\\n\\s+at /, 'AC-4 no stack');
assert.deepEqual(calls, [], 'AC-4 no git');
// AC-5: status ignores a journal.
const lines = [];
status({ files: new Map([['.changeset/a.md', 'a'], ['.changeset/.version-journal.json', '{}']]), io: { log: (l) => lines.push(l) } });
assert.deepEqual(lines, ['.changeset/a.md'], 'AC-5 status');
console.log('acceptance: ok');
`;

type Ticket = ShopTicket & { attempt: number; correction?: Record<string, any> };

async function dispatch(s: { control: string }, ...extra: string[]): Promise<{ status: string; detail: string; ticket?: Ticket; controller_reports: { node_id: string; outcome: string }[] }> {
  return JSON.parse((await verCli(s, ['dispatch', VER_FEATURE, ...extra, '--json'])).out);
}

describe('CSET-203, model-free: apply, cli with its AC-4 correction cycle, the compatibility verification node, delivery', () => {
  it('delivers C001 with every criterion proved as its kind requires, nothing charged for the correction', async () => {
    const s = await createVer();
    // 1. apply-release-plan.
    const a = (await dispatch(s)).ticket!;
    expect(a.node_id).toBe(ARP);
    fulfil(a, { ...VER_WORK[ARP]!, criteria: [{ criterion: 'AC-1', gate: 'red', full_name: ARP_ROLLBACK_TEST }, { criterion: 'AC-2', gate: 'red', full_name: ARP_JOURNAL_TEST }] }, s.control);
    expect(JSON.parse((await verCli(s, ['settle', VER_FEATURE, ARP, '--capability', a.capability, '--json'])).out)).toMatchObject({ outcome: 'DONE' });
    commitVerControl(s, 'apply-release-plan');

    // 2. the cli: AC-3's cycle, AC-4 mapped to an existing GREEN test, as r1's worker did.
    const c = (await dispatch(s)).ticket!;
    expect(c.node_id).toBe(CLI);
    fulfil(c, { ...VER_WORK[CLI]!, criteria: [{ criterion: 'AC-3', gate: 'red', full_name: CLI_RECOVERY_TEST }, { criterion: 'AC-4', gate: 'green', test_id: id(CLI_EXISTING_TEST) }, CLI_AC5] }, s.control);
    const held = JSON.parse((await verCli(s, ['settle', VER_FEATURE, CLI, '--capability', c.capability, '--json'])).out);
    expect(held).toMatchObject({ outcome: 'EVIDENCE_CORRECTION_REQUIRED' });
    expect(verState(s).nodes[CLI]).toMatchObject({ attempts: 1, failure_counts: {} });
    commitVerControl(s, 'cli held');
    const r = await dispatch(s, '--resume', CLI);
    const fix = r.ticket!;
    expect(fix.correction).toMatchObject({ criterion: 'AC-4', kind: 'new-behavior', required_gate: 'red', cycle: true });
    const heldRed = (packOf(fix)['correction'].gates as { gate: string; output_sha256: string }[]).find((g) => g.gate === 'red')!.output_sha256;
    writeFiles(fix.worktree, { [CLI_TESTS]: CLI_FAILURE_RED });
    const red = runGate(fix, 'red', s.control);
    expect(red.code, red.out).toBe(0);
    commit(fix.worktree, [CLI_TESTS], 'test(cli): AC-4');
    writeFiles(fix.worktree, { 'packages/cli/src/index.mjs': CLI_IMPL });
    const green = runGate(fix, 'green', s.control);
    expect(green.code).toBe(0);
    commit(fix.worktree, ['packages/cli/src/index.mjs'], 'feat(cli): AC-4');
    expect(runGate(fix, 'regression', s.control).code).toBe(0);
    const result = {
      schema_version: 1, node_id: CLI, claim_id: fix.claim_id, dispatch_id: fix.dispatch_id, outcome: 'SUBMITTED', commands: [], evidence_paths: [], failure_fingerprint: null, decision_request: null,
      commit_sha: git(fix.worktree, ['rev-parse', 'HEAD']),
      criterion_evidence: [
        { criterion: 'AC-3', test_id: id(CLI_RECOVERY_TEST), gate: 'red', output_sha256: heldRed },
        { criterion: 'AC-4', test_id: id(CLI_FAILURE_TEST), gate: 'red', output_sha256: red.sha256 },
        { criterion: 'AC-5', test_id: CLI_AC5.test_id, gate: 'green', output_sha256: green.sha256 },
      ],
    };
    mkdirSync(dirname(fix.result_slot), { recursive: true });
    writeFileSync(fix.result_slot, JSON.stringify(result));
    expect(JSON.parse((await verCli(s, ['settle', VER_FEATURE, CLI, '--capability', fix.capability, '--json'])).out)).toMatchObject({ outcome: 'DONE' });
    expect(verState(s).nodes[CLI]).toMatchObject({ state: 'DONE', attempts: 1, failure_counts: {}, tdd_history: { cycles: 2 } });
    commitVerControl(s, 'cli');

    // 3 and 4. the verification node and the candidate run inside dispatch.
    const d = await dispatch(s);
    expect(d.status, d.detail).toBe('ALL_SETTLED');
    expect(d.ticket).toBeUndefined();
    expect(d.controller_reports.map((x) => [x.node_id, x.outcome])).toEqual([[COMPAT, 'DONE'], [VER_CANDIDATE, 'DONE']]);
    const state = verState(s);
    expect(state.nodes[COMPAT].criteria).toEqual([expect.objectContaining({ criterion: 'AC-5', gate: 'regression' })]);
    const head = git(s.repo, ['rev-parse', `feature/${VER_FEATURE}`]);
    expect(state.nodes[COMPAT].evidence.regression.commit_sha).toBe(head);
    commitVerControl(s, 'settled');
    expect(JSON.parse((await verCli(s, ['deliver', VER_FEATURE, '--json'])).out)).toMatchObject({ status: 'ACCEPTED' });
    commitVerControl(s, 'delivered');
    expect(JSON.parse((await verCli(s, ['feature', 'verify', VER_FEATURE, '--delivered', '--json'])).out)).toMatchObject({ ok: true });
    expect(git(s.repo, ['rev-parse', 'main'])).toBe(head);
    const script = join(makeTmpDir('cset203-acceptance-'), 'acceptance.mjs');
    writeFileSync(script, ACCEPTANCE);
    const checked = spawnSync(process.execPath, [script, s.repo], { encoding: 'utf8' });
    expect(checked.status, checked.stderr).toBe(0);
    expect(checked.stdout).toContain('acceptance: ok');
  });
});
