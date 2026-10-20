import { afterAll, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createVer, verCli, verState, VER_FEATURE, ARP, ARP_RED, ARP_SRC, ARP_TESTS, ARP_ROLLBACK_TEST, ARP_JOURNAL_TEST, ARP_GAPPY_IMPL, CLI, CLI_FULL_WORK, CLI_RECOVERY_TEST, CLI_FAILURE_TEST, CLI_AC5, COMPAT } from '../helpers/version-fixture.js';
import { fulfil } from '../helpers/shop-worker.js';
import { reviewPacket, verdictFor } from '../helpers/review-agent.js';
import { Orchestrator } from '../../src/engine/orchestrator.js';
import { codexReviewPrompt } from '../../src/engine/codex-review-session.js';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import type { SessionAdapter } from '../../src/sessions/adapter.js';

const roots: string[] = [];
afterAll(() => { cleanupTmpRoots(); roots.forEach((r) => rmSync(r, { recursive: true, force: true })); });
async function ready() {
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
  return { s, t, engine: new Orchestrator({ controlRoot: s.control, featureId: VER_FEATURE, adapter: {} as SessionAdapter }) };
}
function fake(final: unknown) {
  const root = mkdtempSync(join(process.env.TMPDIR ?? process.env.TEMP ?? '.', 'codex-review-bridge-'));
  roots.push(root);
  const script = join(root, 'provider.mjs');
  writeFileSync(script, `const a=process.argv.slice(2);if(!a.includes('read-only')||!a.includes('--json'))process.exit(8);process.stdin.resume();console.log(JSON.stringify({type:'thread.started',thread_id:'11111111-1111-4111-8111-111111111111'}));console.log(JSON.stringify({type:'turn.started'}));console.log(JSON.stringify({type:'item.completed',item:{id:'answer',type:'agent_message',text:${JSON.stringify(JSON.stringify(final))}}}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:12}}));`);
  return script;
}
it('separate process GAP settles through judge and reopens its producer; stale or duplicate evidence cannot settle', async () => {
  const { s, t, engine } = await ready();
  const packet = reviewPacket(t);
  const brief = codexReviewPrompt(t.prompt, t.packet_path);
  expect(brief).toContain('"schema": "mycelink-acceptance-review/1"');
  expect(brief).toContain('<mycelink-review-criteria>');
  expect(brief).not.toMatch(/Write tool|Agent tool|verdict file/i);
  const verdict = verdictFor(packet, { 'AC-1': { gap: { missing: 'missing rollback on changelog failure', reproduction: 'fail changelog write, assert rollback', producer: { node_id: ARP } } } });
  const script = fake(verdict);
  const result = await engine.settleCodexReview(t, { executable: process.execPath, prefixArgs: [script], timeoutMs: 5000 });
  expect(result.outcome).toBe('GAPS');
  expect(result.reworked).toContain(ARP);
  expect(verState(s).nodes[ARP].state).toBe('INVALIDATED');
  expect(verState(s).acceptance_review.reviews[0]).toMatchObject({ overall: 'GAPS', outcome: 'GAPS' });
  const next = JSON.parse((await verCli(s, ['dispatch', VER_FEATURE, '--json'])).out);
  expect(next.ticket.node_id).toBe(ARP);
  expect(next.ticket.kind).not.toBe('acceptance-review');
  const receipt = JSON.parse(readFileSync(join(s.control, result.receipt_path!), 'utf8'));
  expect(receipt.transport.transcript_sha256).toMatch(/^[a-f0-9]{64}$/);
  await expect(engine.settleCodexReview(t, { executable: process.execPath, prefixArgs: [script], timeoutMs: 5000 })).rejects.toThrow(/CODEX_REVIEW_(NOT_OPEN|ALREADY_SETTLED)/);
});
it('foreign dispatch is rejected without a verdict or accepted review', async () => {
  const { s, t, engine } = await ready();
  const verdict = { ...verdictFor(reviewPacket(t)), dispatch_id: 'foreign' };
  await expect(engine.settleCodexReview(t, { executable: process.execPath, prefixArgs: [fake(verdict)], timeoutMs: 5000 })).rejects.toThrow(/BINDING/);
  expect(verState(s).acceptance_review.reviews).toHaveLength(0);
});
it('refuses a stale generation and missing criterion before launching any reviewer', async () => {
  const { s, t, engine } = await ready();
  const script = fake(verdictFor(reviewPacket(t)));
  await expect(engine.settleCodexReview({ ...t, dispatch_id: 'stale' }, { executable: process.execPath, prefixArgs: [script], timeoutMs: 5000 })).rejects.toThrow(/FOREIGN_TICKET/);
  await expect(engine.settleCodexReview({ ...t, criteria: t.criteria.slice(1) }, { executable: process.execPath, prefixArgs: [script], timeoutMs: 5000 })).rejects.toThrow(/PACKET_CHANGED/);
  expect(verState(s).acceptance_review.reviews).toHaveLength(0);
});
