/**
 * A verification node is run by the controller, never by a worker.
 *
 * CSET-203 r1 with-faults: both producers reached DONE; the planner's
 * `compat.regression` node (AC-5, compatibility, no allowed paths, the full
 * suite) was dispatched to a module-worker, which ran green and regression,
 * changed nothing and submitted; settle refused its history
 * (NO_DECLARATION_COMMIT) twice and the node BLOCKED. Here, `dispatch` runs a
 * `verification` node itself, like a candidate build:
 *
 *  - after every producer of its repository is DONE, in a fresh checkout of
 *    the repository's integrated head, set up as the repository declares;
 *  - each verifier from the allowlist (module commands with their steps and
 *    reports, repository commands), no ticket, no worker, no worktree or
 *    branch of its own, no commit, no TDD history;
 *  - a receipt binding the head, the modules and plans, the setup's config
 *    and receipt, every run's output and the canonical ids of every test
 *    that passed; its compatibility criteria evidenced by that receipt;
 *  - a failure is a recorded, retryable verification failure of the node;
 *    a controller that died mid-run is handed back unspent and the next
 *    dispatch runs it again; a drifted module stops it before anything runs.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { samePath } from '../../src/security/paths.js';
import { join } from 'node:path';
import YAML from 'yaml';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { git } from '../helpers/git-fixture.js';
import { controllerKey } from '../helpers/authority.js';
import { canonicalTestId } from '../../src/evidence/test-ids.js';
import { worktreeSetupSha256, worktreeSetupOf } from '../../src/engine/worktree-setup.js';
import {
  ARP,
  ARP_JOURNAL_TEST,
  ARP_ROLLBACK_TEST,
  CLI,
  CLI_AC5,
  CLI_FAILURE_RED,
  CLI_FAILURE_TEST,
  CLI_IMPL,
  CLI_RECOVERY_TEST,
  COMPAT,
  VER_CANDIDATE,
  VER_FEATURE,
  VER_FULL_SUITE,
  VER_WORK,
  commitVerControl,
  createVer,
  verCli,
  verGraph,
  verState,
  verVerifier,
  type Ver,
} from '../helpers/version-fixture.js';
import { fulfil, type CriterionItem, type ShopTicket } from '../helpers/shop-worker.js';
import { escapeRegExp } from '../helpers/regex.js';

afterAll(() => cleanupTmpRoots());

const BIN = join(process.cwd(), 'bin', 'mycelink.mjs');
const sha256 = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

/** The repository's worktrees other than its own checkout (git names it by its real path) and the feature's integration worktree. */
const extraWorktrees = (s: Ver): string[] =>
  git(s.repo, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length))
    .filter((p) => !/integration__changesets__/.test(p) && !samePath(p, s.repo));

/** The cli in one cycle: AC-3 and AC-4 proved by the same RED. */
const WORK: Record<string, { tests: Record<string, string>; impl: Record<string, string> }> = {
  [ARP]: VER_WORK[ARP]!,
  [CLI]: { tests: { 'packages/cli/test/cli.test.mjs': CLI_FAILURE_RED }, impl: { 'packages/cli/src/index.mjs': CLI_IMPL } },
};
const CRITERIA: Record<string, CriterionItem[]> = {
  [ARP]: [
    { criterion: 'AC-1', gate: 'red', full_name: ARP_ROLLBACK_TEST },
    { criterion: 'AC-2', gate: 'red', full_name: ARP_JOURNAL_TEST },
  ],
  [CLI]: [
    { criterion: 'AC-3', gate: 'red', full_name: CLI_RECOVERY_TEST },
    { criterion: 'AC-4', gate: 'red', full_name: CLI_FAILURE_TEST },
    CLI_AC5,
  ],
};

interface Dispatched {
  status: string;
  detail: string;
  ticket?: ShopTicket;
  controller_reports: { node_id: string; outcome: string; state: string; detail: string }[];
}

async function dispatch(s: Ver): Promise<Dispatched> {
  const d = await verCli(s, ['dispatch', VER_FEATURE, '--json']);
  return JSON.parse(d.out) as Dispatched;
}

/** Dispatch and settle both producers: apply-release-plan, then cli. */
async function producersDone(s: Ver): Promise<void> {
  for (const id of [ARP, CLI]) {
    const d = await dispatch(s);
    expect(d.status, d.detail).toBe('DISPATCHED');
    expect(d.ticket!.node_id).toBe(id);
    const run = fulfil(d.ticket!, { ...WORK[id]!, criteria: CRITERIA[id] }, s.control);
    expect(run.gates.map((g) => g.code), JSON.stringify(run.gates.map((g) => g.out.slice(-600)))).toEqual([0, 0, 0]);
    const settled = JSON.parse((await verCli(s, ['settle', VER_FEATURE, id, '--capability', d.ticket!.capability, '--json'])).out);
    expect(settled, JSON.stringify(settled)).toMatchObject({ outcome: 'DONE' });
    commitVerControl(s, `${id} settled`);
  }
}

const events = (s: Ver): { type: string; node_id?: string; data: Record<string, any> }[] =>
  readFileSync(join(s.featureDir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

describe('dispatch runs a verification node itself', () => {
  it('after both producers: no ticket, worktree, branch or commit of its own; DONE on a receipt binding the head, modules, setup and every test id that passed', async () => {
    const s = await createVer();
    await producersDone(s);
    const head = git(s.repo, ['rev-parse', `feature/${VER_FEATURE}`]);
    const d = await dispatch(s);
    expect(d.status, d.detail).toBe('ALL_SETTLED');
    expect(d.ticket).toBeUndefined();
    expect(d.controller_reports.map((r) => [r.node_id, r.outcome])).toEqual([
      [COMPAT, 'DONE'],
      [VER_CANDIDATE, 'DONE'],
    ]);
    // Nothing of a worker: no ticket, no branch, no worktree, nothing committed, no history judged.
    expect(events(s).filter((e) => e.node_id === COMPAT && ['dispatch.ticket', 'node.history_judged', 'node.settled'].includes(e.type))).toEqual([]);
    expect(events(s).find((e) => e.node_id === COMPAT && e.type === 'node.claimed')?.data).toMatchObject({ mode: 'controller', worktree: null, branch: null });
    expect(git(s.repo, ['branch', '--list', `wip/${VER_FEATURE}/changesets.compat.regression`])).toBe('');
    expect(git(s.repo, ['rev-parse', `feature/${VER_FEATURE}`])).toBe(head);
    expect(extraWorktrees(s)).toEqual([]);
    expect(git(s.repo, ['status', '--porcelain'])).toBe('');

    const rt = verState(s).nodes[COMPAT];
    expect(rt).toMatchObject({ state: 'DONE', attempts: 1, failure_counts: {}, claim: null, integrated_sha: null });
    expect(rt.tdd_history ?? null).toBeNull();
    expect(Object.keys(rt.evidence)).toEqual(['regression']);
    const record = rt.evidence.regression;
    expect(record).toMatchObject({ kind: 'regression', exit_code: 0, commit_sha: head, repository: 'changesets', failure_fingerprint: null });
    expect(record.output_path).toMatch(new RegExp(`^features/${VER_FEATURE}/evidence/${escapeRegExp(COMPAT)}/`));
    expect(sha256(join(s.control, record.output_path))).toBe(record.output_sha256);

    // The setup of its fresh checkout, bound like a worker's: on record, complete, the repository's config.
    const config = worktreeSetupOf(YAML.parse(readFileSync(join(s.control, 'repositories.yaml'), 'utf8')).repositories[0])!;
    expect(rt.worktree_setup).toMatchObject({ status: 'complete', config_sha256: worktreeSetupSha256(config) });
    expect(sha256(join(s.control, rt.worktree_setup.receipt_path))).toBe(rt.worktree_setup.receipt_sha256);
    expect(record.worktree_setup_sha256).toBe(rt.worktree_setup.receipt_sha256);

    const receipt = JSON.parse(readFileSync(join(s.control, record.output_path), 'utf8'));
    expect(receipt).toMatchObject({
      schema: 'mycelink-verification/1',
      feature_id: VER_FEATURE,
      node_id: COMPAT,
      repository: 'changesets',
      head_sha: head,
      setup: { config_sha256: worktreeSetupSha256(config), receipt_path: rt.worktree_setup.receipt_path, receipt_sha256: rt.worktree_setup.receipt_sha256 },
    });
    expect(receipt.runs.map((r: any) => [r.verifier, r.module, r.exit_code])).toEqual([
      ['module-apply-release-plan', 'apply-release-plan', 0],
      ['module-cli', 'cli', 0],
      ['full-suite', null, 0],
    ]);
    expect(receipt.runs[0]).toMatchObject({ module_sha256: verVerifier('apply-release-plan').module_sha256, plan_sha256: expect.stringMatching(/^[0-9a-f]{64}$/), results: { format: 'junit-xml', failed: 0 } });
    expect(receipt.runs[2]).toMatchObject({ command: VER_FULL_SUITE, results: null });
    for (const r of receipt.runs) {
      expect(sha256(join(s.control, r.output_path))).toBe(r.output_sha256);
      if (r.results) expect(sha256(join(s.control, r.results.path))).toBe(r.results.sha256);
    }
    // Every test the module runs passed, by its canonical id: the existing ones guard AC-5.
    const ids = receipt.tests.passed.map((t: { id: string }) => t.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        canonicalTestId('junit-xml', 'packages/apply-release-plan/test/apply.test.mjs', 'applies every change of the release plan'),
        canonicalTestId('junit-xml', 'packages/cli/test/cli.test.mjs', 'version applies the release plan and commits it when commit is set'),
        canonicalTestId('junit-xml', 'packages/cli/test/cli.test.mjs', 'status lists the pending changesets'),
      ]),
    );
    expect(receipt.tests.ids_sha256).toBe(createHash('sha256').update(JSON.stringify([...ids].sort())).digest('hex'));
    expect(receipt.criteria).toEqual([{ criterion: 'AC-5', kind: 'compatibility', evidence: 'passed' }]);
    expect(rt.criteria).toEqual([{ criterion: 'AC-5', test_id: null, test: null, gate: 'regression', output_sha256: record.output_sha256 }]);

    // The candidate binds the verified head; the feature verifies and delivers.
    commitVerControl(s, 'settled');
    expect(JSON.parse((await verCli(s, ['feature', 'verify', VER_FEATURE, '--json'])).out)).toMatchObject({ ok: true });
    const delivered = JSON.parse((await verCli(s, ['deliver', VER_FEATURE, '--json'])).out);
    expect(delivered, JSON.stringify(delivered)).toMatchObject({ status: 'ACCEPTED' });
    expect(git(s.repo, ['rev-parse', 'main'])).toBe(head);
  });

  it('a manual claim of a verification node is refused: only the controller runs it', async () => {
    const s = await createVer();
    await producersDone(s);
    const claimed = await verCli(s, ['node', 'claim', VER_FEATURE, COMPAT, '--json']);
    expect(claimed.code).not.toBe(0);
    expect(claimed.err).toMatch(/NOT_A_WORKER_NODE: .*verification/);
    expect(verState(s).nodes[COMPAT]).toMatchObject({ state: 'PLANNED', attempts: 0, claim: null });
  });

  it('a failing verifier is a retryable verification failure of the node: nothing written, no declaration; the same failure twice blocks it', async () => {
    const graph = verGraph({ compatVerifiers: [verVerifier('cli'), { id: 'lint', command: ['node', '-e', 'process.exit(3)'] }] });
    const s = await createVer({ graph, commands: { lint: ['node', '-e', 'process.exit(3)'] } });
    await producersDone(s);
    const first = await dispatch(s);
    expect(first.status, first.detail).toBe('CONTROLLER_FAILED');
    expect(first.controller_reports).toEqual([expect.objectContaining({ node_id: COMPAT, outcome: 'RETRY', state: 'READY', detail: expect.stringMatching(/^VERIFICATION_FAILED:lint:[0-9a-f]{16}: verifier "lint" exited 3 on [0-9a-f]{12}/) })]);
    let rt = verState(s).nodes[COMPAT];
    expect(rt).toMatchObject({ state: 'READY', attempts: 1, claim: null, integrated_sha: null });
    expect(Object.keys(rt.failure_counts)).toEqual([expect.stringMatching(/^VERIFICATION_FAILED:lint:/)]);
    expect(rt.tdd_rejection ?? null).toBeNull();
    expect(git(s.repo, ['branch', '--list', `wip/${VER_FEATURE}/changesets.compat.regression`])).toBe('');
    expect(extraWorktrees(s)).toEqual([]);
    expect(verState(s).current_candidate).toBeNull();
    // Retryable: the next dispatch runs it again; the same failure again blocks it.
    const second = await dispatch(s);
    expect(second.controller_reports).toEqual([expect.objectContaining({ node_id: COMPAT, outcome: 'BLOCKED' })]);
    rt = verState(s).nodes[COMPAT];
    expect(rt).toMatchObject({ state: 'BLOCKED', attempts: 2 });
    expect(rt.blocked_reason).toMatch(/VERIFICATION_FAILED:lint:/);
  });

  it('a module changed since the graph was planned stops it before anything runs: PRECONDITION_FAILED, nothing charged', async () => {
    const s = await createVer();
    await producersDone(s);
    const file = join(s.control, 'repositories.yaml');
    const manifest = YAML.parse(readFileSync(file, 'utf8'));
    manifest.repositories[0].module_defaults.timeout_seconds = 301;
    writeFileSync(file, YAML.stringify(manifest, { lineWidth: 0 }));
    commitVerControl(s, 'a module changed');
    const d = await dispatch(s);
    expect(d.status).toBe('PRECONDITION_FAILED');
    expect(d.detail).toMatch(/MODULE_DRIFT/);
    expect(verState(s).nodes[COMPAT]).toMatchObject({ state: 'PLANNED', attempts: 0, failure_counts: {}, claim: null });
  });

  it('a repository command that is no longer the repository\'s stops it before anything runs: nothing charged', async () => {
    const graph = verGraph({ compatVerifiers: [{ id: 'lint', command: ['node', '-e', 'process.exit(0)'] }] });
    const s = await createVer({ graph, commands: { lint: ['node', '-e', 'process.exit(0)'] } });
    await producersDone(s);
    const file = join(s.control, 'repositories.yaml');
    const manifest = YAML.parse(readFileSync(file, 'utf8'));
    manifest.repositories[0].commands.lint = ['node', '-e', 'process.exit(1)'];
    writeFileSync(file, YAML.stringify(manifest, { lineWidth: 0 }));
    commitVerControl(s, 'a command changed');
    const d = await dispatch(s);
    expect(d.status).toBe('PRECONDITION_FAILED');
    expect(d.detail).toMatch(/COMMAND_NOT_ALLOWLISTED/);
    expect(verState(s).nodes[COMPAT]).toMatchObject({ state: 'PLANNED', attempts: 0, failure_counts: {}, claim: null });
  });

  it('a producer rework reopens it with the candidate; it is never a rework target itself', async () => {
    const s = await createVer();
    await producersDone(s);
    expect((await dispatch(s)).status).toBe('ALL_SETTLED');
    commitVerControl(s, 'settled');
    const refused = await verCli(s, ['node', 'rework', VER_FEATURE, COMPAT, '--reason', 'AC-5: status lists a journal', '--json']);
    expect(refused.code).not.toBe(0);
    expect(refused.err).toMatch(/REWORK_NOT_A_PRODUCER/);
    const reworked = JSON.parse((await verCli(s, ['node', 'rework', VER_FEATURE, CLI, '--reason', 'AC-4: a failed apply printed a stack trace', '--json'])).out);
    expect(reworked.reopened).toEqual([CLI, COMPAT, VER_CANDIDATE]);
    expect(verState(s).nodes[COMPAT].state).toBe('INVALIDATED');
  });
});

describe('a verification run whose controller died', () => {
  it.each([
    ['verification-claimed', true],
    ['verification-ran', false],
    ['verification-recorded', true],
  ])(
    'killed at %s (reconcile first: %s): the claim is handed back unspent, the run happens again once, and the feature settles',
    async (point, reconcileFirst) => {
      const s = await createVer();
      await producersDone(s);
      const key = controllerKey(s.control);
      const crashed = spawnSync(process.execPath, [BIN, 'dispatch', VER_FEATURE, '--control-root', s.control, '--authority', key, '--json'], {
        env: { ...process.env, MYCELINK_CRASH_AT: point },
        encoding: 'utf8',
        windowsHide: true,
      });
      expect(crashed.status, crashed.stderr).not.toBe(0);
      const left = verState(s).nodes[COMPAT];
      expect(left.claim).toMatchObject({ mode: 'controller', worktree: null });
      expect(left.state).not.toBe('DONE');
      // Killed while its commands' checkout was still there: the recovery has to remove it.
      if (point === 'verification-ran') expect(extraWorktrees(s)).toEqual([expect.stringMatching(/changesets__CSET-203\.changesets\.compat\.regression__[0-9a-f]{8}$/)]);
      // A reconcile names it and hands it back; without one, the next dispatch does.
      if (reconcileFirst) {
        const reconciled = JSON.parse((await verCli(s, ['session', 'reconcile', VER_FEATURE, '--json'])).out);
        expect(reconciled.interrupted_controller_runs).toEqual([COMPAT]);
        expect(verState(s).nodes[COMPAT]).toMatchObject({ state: 'READY', claim: null, interruptions: 1 });
      }
      const d = await dispatch(s);
      expect(d.status, d.detail).toBe('ALL_SETTLED');
      expect(d.controller_reports.map((r) => [r.node_id, r.outcome])).toEqual([
        [COMPAT, 'DONE'],
        [VER_CANDIDATE, 'DONE'],
      ]);
      const rt = verState(s).nodes[COMPAT];
      expect(rt).toMatchObject({ state: 'DONE', attempts: 1, interruptions: 1, failure_counts: {}, claim: null });
      // Its checkout from the dead run is gone too.
      expect(extraWorktrees(s)).toEqual([]);
      // Once DONE it never runs again.
      const before = rt.evidence.regression.output_sha256;
      expect((await dispatch(s)).status).toBe('ALL_SETTLED');
      expect(verState(s).nodes[COMPAT].evidence.regression.output_sha256).toBe(before);
      expect(events(s).filter((e) => e.node_id === COMPAT && e.type === 'verification.completed')).toHaveLength(1);
      void existsSync;
    },
  );

  it('a run that is alive is never taken over: a concurrent dispatch leaves its claim alone', async () => {
    const s = await createVer();
    await producersDone(s);
    // The claim a live controller holds right now (this very process), mid-run.
    const { mutateState } = await import('../../src/state/feature-state.js');
    const { settlerMarker } = await import('../../src/engine/settler.js');
    mutateState(s.featureDir, (st) => {
      const rt = st.nodes[COMPAT]!;
      rt.state = 'CLAIMED';
      rt.attempts = 1;
      rt.claim = { claim_id: 'live-run', owner: 'mycelink', worktree: null, branch: null, claimed_at: new Date().toISOString(), mode: 'controller', attempt: 1, settling: settlerMarker() };
      return st;
    });
    const d = await dispatch(s);
    expect(d.status).toBe('WAITING');
    expect(verState(s).nodes[COMPAT].claim).toMatchObject({ claim_id: 'live-run' });
  });
});
