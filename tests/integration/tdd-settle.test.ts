/**
 * Settle refuses a node whose history is not test-first, before anything
 * is integrated.
 *
 * Second PCM-101 pilot, with-normal arm: the gateway worker committed its
 * RED tests alone (630f07d), its production alone (cb4682d), and then
 * `test: cover vetName enrichment and vets-service failure` (044f5f9) — new
 * tests and a changed RED test after production. Settle verified the
 * worktree on a clean checkout and integrated it; the independent replay
 * rejected the delivery (tdd:test-after). With-faults arm: the gateway
 * worker stubbed production before its RED and committed tests with the
 * pom.xml, then a test-only commit after production.
 *
 * Now the red gate binds the exact test files it ran (and refuses to run
 * over production edits), and settle verifies base..head from the
 * repository against those bindings and the worker's own claims. A refused
 * history is archived with its evidence, never integrated, and the node is
 * dispatched again on a fresh branch from the current integration state,
 * told why.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { commitAll, git } from '../helpers/git-fixture.js';
import { FEATURE_ID, commitControl, type Portfolio } from '../helpers/portfolio-fixture.js';
import { fakeAgent, type AgentBehaviour, type DispatchTicket } from '../helpers/host-agent.js';
import { CORE, WORK, cli, cliRaw, dispatch, hostGraph, hostPortfolio, settle, testFile } from '../helpers/host-loop.js';
import { loadState } from '../../src/state/feature-state.js';
import { workerBranchName } from '../../src/git/worktree.js';
import { branchExists } from '../../src/git/git.js';
import { escapeRegExp } from '../helpers/regex.js';

afterAll(() => cleanupTmpRoots());

const rt = (p: Portfolio) => loadState(p.featureDir)!.data.nodes[CORE]!;
const head = (dir: string) => git(dir, ['rev-parse', 'HEAD']);

const CORE_WORK = WORK[CORE] as AgentBehaviour;
const MORE_TESTS = {
  'tests/publish.test.mjs': `${testFile('publishes the v2 job result')}\ntest('covers the version header', () => {});\n`,
};

async function attempt(p: Portfolio, behaviour: AgentBehaviour): Promise<{ ticket: DispatchTicket; report: Record<string, unknown>; run: ReturnType<typeof fakeAgent> }> {
  const d = await dispatch(p);
  expect(d.status).toBe('DISPATCHED');
  const ticket = d.ticket!;
  expect(ticket.node_id).toBe(CORE);
  const run = fakeAgent(ticket, behaviour, p.control);
  const report = await settle(p, CORE, ticket.capability);
  return { ticket, report, run };
}

describe('settle verifies the node history test-first', () => {
  it('a worker that keeps the contract settles DONE; the history, its policy and its cycles are evidence', async () => {
    const p = await hostPortfolio();
    const { ticket, report, run } = await attempt(p, { ...CORE_WORK, reportTdd: true });
    expect(report).toMatchObject({ outcome: 'DONE' });
    expect(ticket.tdd).toMatchObject({ base_sha: head(p.core), policy_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(ticket.prompt).toMatch(/test-first/i);
    const history = rt(p).tdd_history!;
    expect(history).toMatchObject({ ok: true, cycles: 1, head_sha: run.commits.at(-1)!.sha, base_sha: ticket.tdd!.base_sha });
    const file = join(p.control, history.output_path);
    const recorded = JSON.parse(readFileSync(file, 'utf8'));
    expect(recorded).toMatchObject({ schema: 'mycelink-tdd-history/1', ok: true, cycles: [{ red_commits: [run.commits[0]!.sha], green_commits: [run.commits[1]!.sha] }] });
    // feature verify holds the history record to its hash like any evidence.
    const problems = async (): Promise<string[]> => (JSON.parse((await cli(p, ['feature', 'verify', FEATURE_ID, '--json'])).out) as { problems: string[] }).problems.filter((x) => x.includes(CORE));
    expect(await problems()).toEqual([]);
    writeFileSync(file, readFileSync(file, 'utf8').replace('"ok": true', '"ok": false'));
    // The node's history, and the completion record that names it, both refuse the changed bytes.
    expect(await problems()).toEqual([
      expect.stringMatching(new RegExp(`^OUTPUT_HASH_MISMATCH: ${escapeRegExp(CORE)} tdd-history `)),
      expect.stringMatching(new RegExp(`^COMPLETION_LEDGER_INVALID: ${escapeRegExp(CORE)} COMPLETION_HISTORY_INVALID: `)),
    ]);
  });

  it('refuses the PCM-101 history (a test-only commit after production) before integration, then reworks it from the integration state', async () => {
    const p = await hostPortfolio();
    const first = await attempt(p, { ...CORE_WORK, testsAfter: MORE_TESTS });
    const after = first.run.commits.at(-1)!;
    expect(after.kind).toBe('test');
    expect(first.report).toMatchObject({ outcome: 'TDD_HISTORY_INVALID', state: 'READY' });
    expect(String(first.report['detail'])).toMatch(/^TDD_HISTORY_INVALID:TEST_AFTER: commit [0-9a-f]{12} /);
    expect(String(first.report['detail'])).toMatch(/covers the version header/);

    const state = loadState(p.featureDir)!.data;
    // Never integrated: no integration head, no integration branch, nothing DONE.
    expect(state.integration_heads ?? {}).toEqual({});
    expect(branchExists(p.core, `feature/${FEATURE_ID}`)).toBe(false);
    const node = state.nodes[CORE]!;
    expect(node).toMatchObject({ state: 'READY', integrated_sha: null, evidence: {}, fresh_branch_required: true, failure_counts: { 'TDD_HISTORY_INVALID:TEST_AFTER': 1 } });
    expect(node.tdd_red_bindings ?? []).toEqual([]);
    expect(node.tdd_rejection).toMatchObject({ code: 'TEST_AFTER', commit: after.sha, head_sha: after.sha, archived_ref: `refs/mycelink/archive/${FEATURE_ID}/core.publish.impl/${after.sha}` });
    // The refused history and the attempt's evidence are kept.
    const kept = join(p.control, node.tdd_rejection!.evidence_path);
    expect(JSON.parse(readFileSync(kept, 'utf8'))).toMatchObject({ ok: false, violation: { code: 'TEST_AFTER', commit: after.sha } });
    for (const gate of ['red', 'green', 'regression']) {
      expect(readdirSync(join(kept, '..')).some((n) => new RegExp(`^${gate}\\.[0-9a-f]{16}\\.log$`).test(n)), gate).toBe(true);
    }
    const events = readFileSync(join(p.featureDir, 'events.jsonl'), 'utf8');
    expect(events).toContain('"type":"node.tdd_rejected"');

    // The next attempt starts from the integration state on a fresh branch, told why.
    const second = await dispatch(p);
    const ticket = second.ticket!;
    expect(ticket).toMatchObject({ node_id: CORE, attempt: 2 });
    expect(ticket.prompt).toMatch(/TEST_AFTER/);
    expect(ticket.prompt).toMatch(/fresh branch/i);
    expect(head(ticket.worktree!)).toBe(git(p.core, ['rev-parse', 'main']));
    expect(ticket.tdd!.base_sha).toBe(git(p.core, ['rev-parse', 'main']));
    expect(git(p.core, ['rev-parse', `refs/mycelink/archive/${FEATURE_ID}/core.publish.impl/${after.sha}`])).toBe(after.sha);
    fakeAgent(ticket, CORE_WORK, p.control);
    expect(await settle(p, CORE, ticket.capability)).toMatchObject({ outcome: 'DONE' });
    expect(rt(p).tdd_rejection ?? null).toBeNull();
    // Only the valid cycle was integrated: the test-after commit is in no integrated history.
    expect(() => git(p.core, ['merge-base', '--is-ancestor', after.sha, `feature/${FEATURE_ID}`])).toThrow();
  });

  it('refuses tests and production committed together (MIXED_COMMIT)', async () => {
    const p = await hostPortfolio();
    const { report, run } = await attempt(p, { ...CORE_WORK, mixed: true });
    expect(run.commits.map((c) => c.kind)).toEqual(['mixed']);
    expect(report).toMatchObject({ outcome: 'TDD_HISTORY_INVALID' });
    expect(String(report['detail'])).toMatch(/^TDD_HISTORY_INVALID:MIXED_COMMIT: /);
  });

  it('refuses a result that names another commit than the branch head (a lied commit_sha)', async () => {
    const p = await hostPortfolio();
    const { report } = await attempt(p, { ...CORE_WORK, testsAfter: MORE_TESTS, reportCommit: 'red' });
    expect(report).toMatchObject({ outcome: 'TDD_HISTORY_INVALID' });
    expect(String(report['detail'])).toMatch(/^TDD_HISTORY_INVALID:TDD_CLAIM_MISMATCH: .*commit_sha/);
    expect(rt(p).integrated_sha).toBeNull();
  });

  it('refuses a result whose tdd claim does not match the repository', async () => {
    const p = await hostPortfolio();
    const d = await dispatch(p);
    const run = fakeAgent(d.ticket!, { ...CORE_WORK, reportTdd: true }, p.control);
    const claimed = run.result!['tdd'] as { cycles: { red_commits: string[]; green_commits: string[] }[] };
    const lie = { ...run.result!, tdd: { ...claimed, cycles: [{ red_commits: [...claimed.cycles[0]!.red_commits, ...claimed.cycles[0]!.green_commits], green_commits: [] }] } };
    writeFileSync(d.ticket!.result_slot, JSON.stringify(lie, null, 2));
    const report = await settle(p, CORE, d.ticket!.capability);
    expect(report).toMatchObject({ outcome: 'TDD_HISTORY_INVALID' });
    expect(String(report['detail'])).toMatch(/^TDD_HISTORY_INVALID:TDD_CLAIM_MISMATCH: /);
  });

  it('refuses RED tests changed after the red gate accepted them (CHANGED_RED_BLOBS)', async () => {
    const p = await hostPortfolio();
    const { report } = await attempt(p, { ...CORE_WORK, editTestsAfterRed: { 'tests/publish.test.mjs': testFile('publishes something else') } });
    expect(report).toMatchObject({ outcome: 'TDD_HISTORY_INVALID' });
    expect(String(report['detail'])).toMatch(/^TDD_HISTORY_INVALID:CHANGED_RED_BLOBS: .*tests\/publish\.test\.mjs/);
  });

  it('the red gate refuses to run over production edits and records nothing (RED_NOT_TEST_ONLY)', async () => {
    const p = await hostPortfolio();
    const d = await dispatch(p);
    const ticket = d.ticket!;
    const run = fakeAgent(ticket, { ...CORE_WORK, productionBeforeRed: { 'src/publish.js': 'export const STUB = 1;\n' } }, p.control);
    expect(run.gates).toEqual([{ gate: 'red', exit: 2 }]);
    const node = rt(p);
    expect(node.state).toBe('CLAIMED');
    expect(node.evidence).toEqual({});
    expect(node.failure_counts).toEqual({});
    // The refusal says what to do.
    const again = await cliRaw(p, ['tdd', 'red', FEATURE_ID, CORE, '--capability', ticket.capability]);
    expect(again.code).toBe(2);
    expect(again.err).toMatch(/RED_NOT_TEST_ONLY: .*src\/publish\.js/);
    expect(again.err).toMatch(/Nothing was run or recorded/);
  });

  it('settles two complete cycles, each with its own red gate', async () => {
    const graph = hostGraph() as { nodes: { id: string; verification_commands: unknown[] }[] };
    graph.nodes.find((n) => n.id === CORE)!.verification_commands = [{ id: 'targeted', command: ['node', 'tests/markers.mjs'] }];
    const p = await hostPortfolio(graph);
    writeFileSync(
      join(p.core, 'tests', 'markers.mjs'),
      [
        "import { existsSync, readdirSync, readFileSync } from 'node:fs';",
        "const markers = readdirSync('tests').filter((f) => f.endsWith('.test.mjs')).flatMap((f) => [...readFileSync('tests/' + f, 'utf8').matchAll(/expects: (\\w+)/g)].map((m) => m[1]));",
        "const body = existsSync('src/publish.js') ? readFileSync('src/publish.js', 'utf8') : '';",
        'const missing = markers.filter((m) => !body.includes(m));',
        "if (missing.length) { console.error('AssertionError: expected src/publish.js to contain ' + missing.join(', ')); process.exit(1); }",
        "console.log('ok ' + markers.join(','));",
        '',
      ].join('\n'),
    );
    commitAll(p.core, 'marker runner');
    const marked = (marker: string, name: string): string => `// expects: ${marker}\n${testFile(name)}`;
    const { report, run } = await attempt(p, {
      tests: { 'tests/a.test.mjs': marked('MARK_A', 'publishes A') },
      impl: { 'src/publish.js': 'export const JOB_RESULT_V2 = true; // MARK_A\n' },
      cycles: [{ tests: { 'tests/b.test.mjs': marked('MARK_B', 'publishes B') }, impl: { 'src/publish.js': 'export const JOB_RESULT_V2 = true; // MARK_A MARK_B\n' } }],
      reportTdd: true,
    });
    // Each gate exits 0 when it accepts: a RED that failed for the missing behaviour, then GREEN.
    expect(run.gates.map((g) => `${g.gate}:${g.exit}`)).toEqual(['red:0', 'green:0', 'red:0', 'green:0', 'regression:0']);
    expect(run.commits.map((c) => c.kind)).toEqual(['test', 'production', 'test', 'production']);
    expect(report).toMatchObject({ outcome: 'DONE' });
    expect(rt(p).tdd_history).toMatchObject({ ok: true, cycles: 2 });
  });

  it('the same refused history twice parks the node BLOCKED', async () => {
    const p = await hostPortfolio();
    await attempt(p, { ...CORE_WORK, testsAfter: MORE_TESTS });
    const second = await attempt(p, { ...CORE_WORK, testsAfter: MORE_TESTS });
    expect(second.report).toMatchObject({ outcome: 'BLOCKED', state: 'BLOCKED' });
    expect(rt(p).blocked_reason).toMatch(/TDD_HISTORY_INVALID:TEST_AFTER/);
  });

  it('judges with the test-path policy the claim was dispatched with, not one changed later', async () => {
    const p = await hostPortfolio();
    const d = await dispatch(p);
    const before = rt(p).claim!.tdd_policy!;
    expect(before).toMatchObject({ source: 'default', sha256: d.ticket!.tdd!.policy_sha256 });
    // repositories.yaml is changed under the running claim: tests/ would no longer be tests.
    const manifestPath = join(p.control, 'repositories.yaml');
    const manifest = YAML.parse(readFileSync(manifestPath, 'utf8')) as { repositories: { name: string; tdd?: unknown }[] };
    manifest.repositories.find((r) => r.name === 'core')!.tdd = { test_paths: ['spec/**'] };
    writeFileSync(manifestPath, YAML.stringify(manifest));
    commitControl(p, 'change the policy');
    fakeAgent(d.ticket!, CORE_WORK, p.control);
    expect(await settle(p, CORE, d.ticket!.capability)).toMatchObject({ outcome: 'DONE' });
  });

  it('a declarations-only change needs no RED cycle when the repository declares it so', async () => {
    const p = await hostPortfolio();
    const manifestPath = join(p.control, 'repositories.yaml');
    const manifest = YAML.parse(readFileSync(manifestPath, 'utf8')) as { repositories: { name: string; tdd?: unknown }[] };
    manifest.repositories.find((r) => r.name === 'core')!.tdd = { declaration_paths: ['src/types/**'] };
    writeFileSync(manifestPath, YAML.stringify(manifest));
    commitControl(p, 'core declares its type declarations');
    const { report, run } = await attempt(p, { ...CORE_WORK, before: [{ files: { 'src/types/publish.d.ts': 'export declare const JOB_RESULT_V2: boolean;\n' }, message: 'types: declare the v2 job result' }] });
    expect(run.commits.map((c) => c.kind)).toEqual(['other', 'test', 'production']);
    expect(report).toMatchObject({ outcome: 'DONE' });
    expect(rt(p).tdd_history).toMatchObject({ ok: true, cycles: 1 });
  });

  it('the same declaration change first is production before any test without that declaration', async () => {
    const p = await hostPortfolio();
    const { report } = await attempt(p, { ...CORE_WORK, before: [{ files: { 'src/types/publish.d.ts': 'export declare const JOB_RESULT_V2: boolean;\n' }, message: 'types first' }] });
    expect(String(report['detail'])).toMatch(/^TDD_HISTORY_INVALID:NO_TEST_FIRST: /);
  });

  it('repo register records a repository test-path policy, and a claim binds it', async () => {
    const p = await hostPortfolio();
    const r = await cli(p, ['repo', 'register', '--name', 'core', '--path', '../core', '--base-branch', 'main', '--test-paths', '**/spec/**, tests/**', '--declaration-paths', 'src/types/**', '--', 'node', 'tests/run.mjs']);
    expect(r.err).toBe('');
    const manifest = YAML.parse(readFileSync(join(p.control, 'repositories.yaml'), 'utf8')) as { repositories: { name: string; tdd?: unknown }[] };
    expect(manifest.repositories.find((x) => x.name === 'core')!.tdd).toEqual({ test_paths: ['**/spec/**', 'tests/**'], declaration_paths: ['src/types/**'] });
    commitControl(p, 'core policy');
    const d = await dispatch(p);
    expect(rt(p).claim!.tdd_policy).toMatchObject({ source: 'repository', test_paths: ['**/spec/**', 'tests/**'], declaration_paths: ['src/types/**'] });
    expect(d.ticket!.tdd).toMatchObject({ test_paths: ['**/spec/**', 'tests/**'], declaration_paths: ['src/types/**'] });
    // A glob with a control character never reaches the manifest.
    const bad = await cli(p, ['repo', 'register', '--name', 'core', '--path', '../core', '--test-paths', 'a\u0007b', '--', 'node', 'tests/run.mjs']);
    expect(bad.code).not.toBe(0);
  });

  it('workers are told the history rules: no test-only commit after production, a new RED cycle instead', async () => {
    const p = await hostPortfolio();
    const prompt = (await dispatch(p)).ticket!.prompt.replace(/\s+/g, ' ');
    expect(prompt).toMatch(/no test-only commit after production/i);
    expect(prompt).toMatch(/new (complete )?RED cycle/i);
    expect(prompt).toMatch(/red gate refuses to run while production files are changed/i);
    expect(workerBranchName(FEATURE_ID, CORE)).toBe('wip/FEAT-901/core.publish.impl');
  });
});
