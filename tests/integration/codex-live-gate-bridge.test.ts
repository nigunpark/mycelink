import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { createShop, ERRORS, ERRORS_IMPL, ERRORS_RED, moduleVerifier, SHOP_FEATURE, shopGraph, shopState } from '../helpers/shop-fixture.js';
import { Orchestrator } from '../../src/engine/orchestrator.js';
import { ClaimChannel } from '../../src/sessions/codex-claim-channel.js';
import { ClaimFileTransport } from '../../src/sessions/codex-claim-files.js';
import { executeHostClaimGate } from '../../src/sessions/codex-host-gate.js';
import { readGateTests } from '../../src/evidence/gate-tests.js';
import { loadState } from '../../src/state/feature-state.js';
import { prepareResultSlot } from '../../src/sessions/worker-protocol.js';
import type { ChannelResponse } from '../../src/sessions/codex-claim-channel.js';

afterAll(() => cleanupTmpRoots());

describe('real controller tdd through a claim mailbox', () => {
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
