import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { createShop, ERRORS, ERRORS_IMPL, ERRORS_RED, FULL_SUITE, moduleVerifier, SHOP_FEATURE, shopGraph, shopState } from '../helpers/shop-fixture.js';
import { Orchestrator } from '../../src/engine/orchestrator.js';
import { ClaimChannel } from '../../src/sessions/codex-claim-channel.js';
import { ClaimFileTransport } from '../../src/sessions/codex-claim-files.js';
import { executeHostClaimGate } from '../../src/sessions/codex-host-gate.js';
import { readGateTests } from '../../src/evidence/gate-tests.js';
import { loadState, mutateState } from '../../src/state/feature-state.js';
import { prepareResultSlot } from '../../src/sessions/worker-protocol.js';
import type { ChannelResponse } from '../../src/sessions/codex-claim-channel.js';

afterAll(() => cleanupTmpRoots());

describe('real controller tdd through a claim mailbox', () => {
  it('runs bound CLI regression on a resumed claim after a source-only commit without repeating RED/GREEN', async () => {
    // Disposable portfolio: regression runs the real, bounded shop full suite.
    const s = await createShop({ modules: 'structured', graph: shopGraph(moduleVerifier(), { compatibility: false }) });
    const controller = new Orchestrator({ controlRoot: s.control, featureId: SHOP_FEATURE, adapter: {} as never });
    const original = controller.claim(ERRORS, { mode: 'adapter' });
    const worktree = original.worktree!;
    const sourcePath = 'packages/errors/src/index.mjs';
    const gates: string[] = [];
    const runGate = (argv: readonly string[], cwd: string) => {
      const gate = argv[3];
      if (gate !== 'red' && gate !== 'green' && gate !== 'regression') throw new Error('bad gate');
      gates.push(gate);
      return executeHostClaimGate({
        controlRoot: s.control, featureId: SHOP_FEATURE, gate, cwd, argv, deadlineMs: 30_000,
        requireTests: gate !== 'regression',
        readRecord: () => loadState(s.featureDir)?.data.nodes[ERRORS]?.evidence[gate],
      });
    };
    const request = (claimId: string, sequence: number, operation: Record<string, unknown>) => ({
      claimId, featureId: SHOP_FEATURE, nodeId: ERRORS, sequence, ...operation,
    });
    const probe = () => { throw new Error('unexpected probe'); };
    const initial = new ClaimChannel(
      () => controller.codexClaimScope(ERRORS, original.claimId, original.capability, worktree),
      runGate, undefined, probe,
    );
    writeFileSync(join(worktree, 'packages/errors/test/errors.test.mjs'), ERRORS_RED);
    expect(initial.handle(request(original.claimId, 1, { operation: 'gate', gate: 'red' }))).toMatchObject({ ok: true });
    expect(initial.handle(request(original.claimId, 2, {
      operation: 'commit', paths: ['packages/errors/test/errors.test.mjs'], message: 'test: accepted RED before interruption',
    }))).toMatchObject({ ok: true });
    writeFileSync(join(worktree, sourcePath), ERRORS_IMPL);
    expect(initial.handle(request(original.claimId, 3, { operation: 'gate', gate: 'green' }))).toMatchObject({ ok: true });
    const accepted = shopState(s).nodes[ERRORS];
    expect(accepted.evidence.red.exit_code).toBe(1);
    expect(accepted.evidence.green.exit_code).toBe(0);
    expect(accepted.tdd_red_bindings.length).toBeGreaterThan(0);
    expect(controller.releaseForInfrastructure(ERRORS, original.claimId, 'provider interrupted')).toBe(true);
    const resumed = controller.claim(ERRORS, { mode: 'adapter' });
    expect(resumed.claimId).not.toBe(original.claimId);
    expect(resumed.capability).not.toBe(original.capability);
    expect(resumed.worktree).toBe(worktree);
    expect(shopState(s).nodes[ERRORS]).toMatchObject({ state: 'CLAIMED', claim: { generation: accepted.claim.generation } });
    const live = () => controller.codexClaimScope(ERRORS, resumed.claimId, resumed.capability, worktree);
    const channel = new ClaimChannel(live, (argv, cwd) => {
      expect(argv[3]).toBe('regression');
      return runGate(argv, cwd);
    }, undefined, probe);
    writeFileSync(join(worktree, sourcePath), ERRORS_IMPL + '\n// source-only continuation after provider release\n');
    expect(live()?.nextGate).toBe('regression');
    expect(channel.handle(request(resumed.claimId, 1, {
      operation: 'commit', paths: [sourcePath], message: 'feat: resume accepted GREEN implementation',
    }))).toMatchObject({ ok: true, commitSha: expect.stringMatching(/^[a-f0-9]{40}$/) });
    // ClaimChannel supplies the new capability and bound command to the actual
    // tdd regression CLI; executeHostClaimGate verifies the resulting receipt.
    const result = channel.handle(request(resumed.claimId, 2, { operation: 'gate', gate: 'regression' }));
    const runtime = shopState(s).nodes[ERRORS];
    const record = runtime.evidence.regression;
    expect(result, JSON.stringify({ result, state: runtime.state, record })).toMatchObject({
      ok: true, output_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(runtime.state).toBe('REGRESSION_VERIFIED');
    expect(record).toMatchObject({ kind: 'regression', exit_code: 0, command: FULL_SUITE });
    expect(result).toMatchObject({ output_sha256: record.output_sha256 });
    expect(createHash('sha256').update(readFileSync(join(s.control, record.output_path))).digest('hex')).toBe(record.output_sha256);
    expect(runtime.evidence.red).toEqual(accepted.evidence.red);
    expect(runtime.evidence.green).toEqual(accepted.evidence.green);
    expect(runtime.tdd_red_bindings).toEqual(accepted.tdd_red_bindings);
    expect(gates).toEqual(['red', 'green', 'regression']);
  });

  it.each(['bound', 'missing evidence', 'stale binding', 'changed tests', 'no capability'] as const)(
    'resumed claim preserves only valid RED/GREEN authority: %s',
    async (scenario) => {
      const s = await createShop({ modules: 'structured', graph: shopGraph(moduleVerifier(), { compatibility: false }) });
      const controller = new Orchestrator({ controlRoot: s.control, featureId: SHOP_FEATURE, adapter: {} as never });
      const original = controller.claim(ERRORS, { mode: 'adapter' });
      const worktree = original.worktree!;
      const testPath = join(worktree, 'packages/errors/test/errors.test.mjs');
      const sourcePath = 'packages/errors/src/index.mjs';
      const runGate = (argv: readonly string[], cwd: string) => {
        const gate = argv[3];
        if (gate !== 'red' && gate !== 'green' && gate !== 'regression') throw new Error('bad gate');
        return executeHostClaimGate({
          controlRoot: s.control, featureId: SHOP_FEATURE, gate, cwd, argv, deadlineMs: 30_000,
          requireTests: gate !== 'regression',
          readRecord: () => loadState(s.featureDir)?.data.nodes[ERRORS]?.evidence[gate],
        });
      };
      const request = (claimId: string, sequence: number, operation: Record<string, unknown>) => ({
        claimId, featureId: SHOP_FEATURE, nodeId: ERRORS, sequence, ...operation,
      });
      // Enable the same pre-RED commit guard as the live Codex channel. No probe
      // or verifier callback is allowed to manufacture accepted evidence.
      const probe = () => { throw new Error('unexpected probe'); };
      const initial = new ClaimChannel(
        () => controller.codexClaimScope(ERRORS, original.claimId, original.capability, worktree),
        runGate, undefined, probe,
      );
      if (scenario !== 'missing evidence') {
        writeFileSync(testPath, ERRORS_RED);
        expect(initial.handle(request(original.claimId, 1, { operation: 'gate', gate: 'red' }))).toMatchObject({ ok: true });
        expect(shopState(s).nodes[ERRORS].evidence.red.exit_code).toBe(1);
        expect(initial.handle(request(original.claimId, 2, {
          operation: 'commit', paths: ['packages/errors/test/errors.test.mjs'], message: 'test: accepted RED',
        }))).toMatchObject({ ok: true });
        writeFileSync(join(worktree, sourcePath), ERRORS_IMPL);
        expect(initial.handle(request(original.claimId, 3, { operation: 'gate', gate: 'green' }))).toMatchObject({ ok: true });
        expect(shopState(s).nodes[ERRORS].evidence.green.exit_code).toBe(0);
        expect(shopState(s).nodes[ERRORS].tdd_red_bindings.length).toBeGreaterThan(0);
      }
      const accepted = shopState(s).nodes[ERRORS];
      expect(controller.releaseForInfrastructure(ERRORS, original.claimId, 'provider interrupted')).toBe(true);
      expect(shopState(s).nodes[ERRORS].state).toBe('READY');
      const resumed = controller.claim(ERRORS, { mode: 'adapter' });
      expect(resumed.claimId).not.toBe(original.claimId);
      expect(resumed.capability).not.toBe(original.capability);
      expect(resumed.worktree).toBe(worktree);
      const runtime = shopState(s).nodes[ERRORS];
      expect(runtime.state).toBe('CLAIMED');
      expect(runtime.claim.generation).toBe(accepted.claim.generation);
      expect(runtime.evidence).toEqual(accepted.evidence);
      expect(runtime.tdd_red_bindings).toEqual(accepted.tdd_red_bindings);
      expect(controller.codexClaimScope(ERRORS, original.claimId, original.capability, worktree)).toBeNull();

      // Corrupt only negative fixtures, after proving real prior gates passed.
      if (scenario === 'stale binding') mutateState(s.featureDir, (state) => {
        for (const binding of state.nodes[ERRORS]!.tdd_red_bindings!) binding.evidence_sha256 = '0'.repeat(64);
        return state;
      });
      if (scenario === 'changed tests') writeFileSync(testPath, ERRORS_RED + '\n// changed after accepted GREEN\n');
      writeFileSync(join(worktree, sourcePath), ERRORS_IMPL + '\n// source-only continuation\n');
      const live = () => controller.codexClaimScope(
        ERRORS, resumed.claimId, scenario === 'no capability' ? '' : resumed.capability, worktree,
      );
      const channel = new ClaimChannel(live, () => { throw new Error('must not repeat RED or GREEN'); }, undefined, probe);
      const scope = live();
      const result = channel.handle(request(resumed.claimId, 1, {
        operation: 'commit', paths: [sourcePath], message: 'feat: resume accepted GREEN implementation',
      }));
      if (scenario === 'bound') {
        // Soft assertions expose both the wrong gate and the actual channel refusal.
        expect.soft(scope?.nextGate).toBe('regression');
        expect(result).toMatchObject({ ok: true, commitSha: expect.stringMatching(/^[a-f0-9]{40}$/) });
        expect(shopState(s).nodes[ERRORS].evidence).toEqual(accepted.evidence);
      } else {
        expect(scope?.nextGate).not.toBe('regression');
        expect(result).toMatchObject({ ok: false, code: scenario === 'no capability' ? 'CHANNEL_CLAIM_STALE' : 'CHANNEL_COMMIT_BEFORE_RED' });
      }
    },
  );

  it('returns the RED verifier’s durable hash and canonical failed test IDs, not a synthetic callback', async () => {
    const s = await createShop({ modules: 'structured', graph: shopGraph(moduleVerifier(), { compatibility: false }) });
    const controller = new Orchestrator({ controlRoot: s.control, featureId: SHOP_FEATURE, adapter: {} as never });
    const claim = controller.claim(ERRORS, { mode: 'adapter' });
    const worktree = claim.worktree!;
    const testPath = join(worktree, 'packages/errors/test/errors.test.mjs');
    mkdirSync(dirname(testPath), { recursive: true });
    writeFileSync(testPath, ERRORS_RED);
    const live = () => controller.codexClaimScope(ERRORS, claim.claimId, claim.capability, worktree);
    const channel = new ClaimChannel(live, (argv, cwd) => {
      const gate = argv[3];
      if (gate !== 'red' && gate !== 'green' && gate !== 'regression') throw new Error('bad gate');
      return executeHostClaimGate({
        controlRoot: s.control, featureId: SHOP_FEATURE, gate, cwd, argv, deadlineMs: 30_000,
        requireTests: gate !== 'regression',
        readRecord: () => loadState(s.featureDir)?.data.nodes[ERRORS]?.evidence[gate],
      });
    });
    prepareResultSlot(worktree);
    const mailbox = new ClaimFileTransport(worktree, claim.claimId, (input) => channel.handle(input), {}, { featureId: SHOP_FEATURE, nodeId: ERRORS });
    mailbox.start();
    try {
      writeFileSync(join(mailbox.dir, 'request-1.json'), JSON.stringify({ claimId: claim.claimId, featureId: SHOP_FEATURE, nodeId: ERRORS, sequence: 1, operation: 'gate', gate: 'red' }));
      mailbox.tick();
      const response = JSON.parse(readFileSync(join(mailbox.dir, 'response-1.json'), 'utf8')) as ChannelResponse;
      const record = shopState(s).nodes[ERRORS].evidence.red;
      expect(response, JSON.stringify({ response, record })).toMatchObject({ ok: true, sequence: 1, exitCode: 0 });
      expect(response).toMatchObject({ ok: true, sequence: 1, exitCode: 0, output_sha256: record.output_sha256 });
      const tests = readGateTests(s.control, record)!;
      expect(tests.some((t) => t.status === 'failed' && response.ok && 'test_ids' in response && response.test_ids?.includes(t.id))).toBe(true);
      expect(existsSync(join(s.control, record.output_path))).toBe(true);
      expect(channel.handle({ claimId: claim.claimId, featureId: SHOP_FEATURE, nodeId: ERRORS, sequence: 1, operation: 'gate', gate: 'red' })).toMatchObject({ ok: false, code: 'CHANNEL_SEQUENCE_INVALID' });
      const send = (sequence: number, operation: Record<string, unknown>): ChannelResponse => {
        writeFileSync(join(mailbox.dir, `request-${sequence}.json`), JSON.stringify({ claimId: claim.claimId, featureId: SHOP_FEATURE, nodeId: ERRORS, sequence, ...operation }));
        mailbox.tick();
        return JSON.parse(readFileSync(join(mailbox.dir, `response-${sequence}.json`), 'utf8')) as ChannelResponse;
      };
      expect(send(2, { operation: 'commit', paths: ['packages/errors/test/errors.test.mjs'], message: 'test: RED assertion' })).toMatchObject({ ok: true, commitSha: expect.stringMatching(/^[a-f0-9]{40}$/) });
      writeFileSync(join(worktree, 'packages/errors/src/index.mjs'), ERRORS_IMPL);
      expect(send(3, { operation: 'commit', paths: ['packages/errors/src/index.mjs'], message: 'feat: errors' })).toMatchObject({ ok: true, commitSha: expect.stringMatching(/^[a-f0-9]{40}$/) });
      const green = send(4, { operation: 'gate', gate: 'green' });
      const greenRecord = shopState(s).nodes[ERRORS].evidence.green;
      expect(green, JSON.stringify({ green, greenRecord })).toMatchObject({ ok: true, output_sha256: greenRecord.output_sha256 });
      expect(green.ok && 'test_ids' in green && green.test_ids).toContain(tests.find((t) => t.status === 'failed')!.id);
      const regression = send(5, { operation: 'gate', gate: 'regression' });
      const regressionRecord = shopState(s).nodes[ERRORS].evidence.regression;
      expect(regression, JSON.stringify({ regression, regressionRecord })).toMatchObject({ ok: true, output_sha256: regressionRecord.output_sha256, test_ids: [] });
    } finally {
      mailbox.stop();
    }
    expect(existsSync(mailbox.dir)).toBe(false);
  });
});
