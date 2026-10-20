import { afterAll, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createVer, verCli, verState, VER_FEATURE, ARP, ARP_RED, ARP_SRC, ARP_TESTS, ARP_ROLLBACK_TEST, ARP_JOURNAL_TEST, ARP_GAPPY_IMPL, CLI, CLI_FULL_WORK, CLI_RECOVERY_TEST, CLI_FAILURE_TEST, CLI_AC5 } from '../helpers/version-fixture.js';
import { fulfil } from '../helpers/shop-worker.js';
import { reviewPacket, verdictFor } from '../helpers/review-agent.js';
import { Orchestrator } from '../../src/engine/orchestrator.js';
import { finalizeCodexDelivery } from '../../src/engine/codex-finalize.js';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { git } from '../helpers/git-fixture.js';
import type { SessionAdapter } from '../../src/sessions/adapter.js';

const fakeRoots: string[] = [];
afterAll(() => { cleanupTmpRoots(); fakeRoots.forEach((p) => rmSync(p, { recursive: true, force: true })); });

function fakeReviewer(final: unknown): string {
  const root = mkdtempSync(join(process.env.TMPDIR ?? process.env.TEMP ?? '.', 'codex-finalize-'));
  fakeRoots.push(root);
  const script = join(root, 'reviewer.mjs');
  writeFileSync(script, `process.stdin.resume();console.log(JSON.stringify({type:'thread.started',thread_id:'11111111-1111-4111-8111-111111111111'}));console.log(JSON.stringify({type:'turn.started'}));console.log(JSON.stringify({type:'item.completed',item:{id:'answer',type:'agent_message',text:${JSON.stringify(JSON.stringify(final))}}}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:12}}));`);
  return script;
}

async function prepared() {
  const s = await createVer({ review: {} });
  const dispatch = async () => JSON.parse((await verCli(s, ['dispatch', VER_FEATURE, '--json'])).out);
  const a = (await dispatch()).ticket;
  fulfil(a, { tests: { [ARP_TESTS]: ARP_RED }, impl: { [ARP_SRC]: ARP_GAPPY_IMPL }, criteria: [{ criterion: 'AC-1', gate: 'red', full_name: ARP_ROLLBACK_TEST }, { criterion: 'AC-2', gate: 'red', full_name: ARP_JOURNAL_TEST }] }, s.control);
  expect(JSON.parse((await verCli(s, ['settle', VER_FEATURE, ARP, '--capability', a.capability, '--json'])).out).outcome).toBe('DONE');
  const c = (await dispatch()).ticket;
  fulfil(c, { ...CLI_FULL_WORK, criteria: [{ criterion: 'AC-3', gate: 'red', full_name: CLI_RECOVERY_TEST }, { criterion: 'AC-4', gate: 'red', full_name: CLI_FAILURE_TEST }, CLI_AC5] }, s.control);
  expect(JSON.parse((await verCli(s, ['settle', VER_FEATURE, CLI, '--capability', c.capability, '--json'])).out).outcome).toBe('DONE');
  const t = (await dispatch()).ticket;
  expect(t.kind).toBe('acceptance-review');
  const engine = new Orchestrator({ controlRoot: s.control, featureId: VER_FEATURE, adapter: {} as SessionAdapter });
  return { s, t, engine };
}

it('refuses to cut or move a base without a fresh PASS', async () => {
  const { s, engine } = await prepared();
  const before = git(s.repo, ['rev-parse', 'main']);
  await expect(finalizeCodexDelivery(s.control, VER_FEATURE, engine)).rejects.toThrow(/REVIEW|PASS/);
  expect(git(s.repo, ['rev-parse', 'main'])).toBe(before);
  expect(verState(s).current_candidate).toBeNull();
});

it('cuts an exact candidate after PASS, delivers the declared base, independently tests it, and refuses replay', async () => {
  const { s, t, engine } = await prepared();
  const base = git(s.repo, ['rev-parse', 'main']);
  const verdict = verdictFor(reviewPacket(t));
  // This fixture settles a controller-bound PASS without pretending a model ran.
  const receipt = await engine.settleCodexReview(t, {
    executable: process.execPath,
    prefixArgs: [fakeReviewer(verdict)],
    timeoutMs: 5000,
  });
  expect(receipt.outcome).toBe('PASS');
  const delivered = await finalizeCodexDelivery(s.control, VER_FEATURE, engine);
  expect(delivered.ok).toBe(true);
  expect(delivered.idempotent).toBe(false);
  const target = delivered.repositories['changesets']!.target;
  expect(base).not.toBe(target);
  expect(delivered.repositories['changesets']!.before).toBe(base);
  expect(delivered.repositories['changesets']!.after).toBe(target);
  expect(git(s.repo, ['rev-parse', 'main'])).toBe(target);
  expect(delivered.acceptance).toEqual([expect.objectContaining({ repository: 'changesets', sha: target, exit_code: 0, failure_fingerprint: null })]);
  const candidate = verState(s).current_candidate!;
  expect(readFileSync(join(s.featureDir, 'candidates', `${candidate}.yaml`), 'utf8')).toContain(target);
  await expect(finalizeCodexDelivery(s.control, VER_FEATURE, engine)).rejects.toThrow(/REPLAY|ALREADY/);
});

it('refuses a reviewed integration head changed after PASS without moving the base', async () => {
  const { s, t, engine } = await prepared();
  const verdict = verdictFor(reviewPacket(t));
  expect((await engine.settleCodexReview(t, { executable: process.execPath, prefixArgs: [fakeReviewer(verdict)], timeoutMs: 5000 })).outcome).toBe('PASS');
  const before = git(s.repo, ['rev-parse', 'main']);
  git(s.repo, ['update-ref', `refs/heads/feature/${VER_FEATURE}`, before]);
  await expect(finalizeCodexDelivery(s.control, VER_FEATURE, engine)).rejects.toThrow(/REVIEW|HEAD|MOVED/);
  expect(git(s.repo, ['rev-parse', 'main'])).toBe(before);
  expect(verState(s).current_candidate).toBeNull();
});
