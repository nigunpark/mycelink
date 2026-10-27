import { afterAll, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createVer, verCli, verState, VER_FEATURE, ARP, ARP_RED, ARP_SRC, ARP_TESTS, ARP_ROLLBACK_TEST, ARP_JOURNAL_TEST, ARP_GAPPY_IMPL, CLI, CLI_FULL_WORK, CLI_RECOVERY_TEST, CLI_FAILURE_TEST, CLI_AC5, COMPAT } from '../helpers/version-fixture.js';
import { fulfil } from '../helpers/shop-worker.js';
import { reviewPacket, verdictFor, refinementFor } from '../helpers/review-agent.js';
import { AC1_REFINED, r6Reviewed, writeChallenge } from '../helpers/cset203-challenge.js';
import { Orchestrator } from '../../src/engine/orchestrator.js';
import { codexRefinementPrompt, codexReviewPrompt } from '../../src/engine/codex-review-session.js';
import { buildReviewPacket } from '../../src/engine/review-packet.js';
import { loadGraph, loadWorkspace } from '../../src/workspace/workspace.js';
import { loadState } from '../../src/state/feature-state.js';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import type { SessionAdapter } from '../../src/sessions/adapter.js';

const roots: string[] = [];
afterAll(() => { cleanupTmpRoots(); roots.forEach((r) => rmSync(r, { recursive: true, force: true })); });
async function ready() {
  const s = await createVer({ review: {} });
  const dispatch = async () => {
    const result = await verCli(s, ['dispatch', VER_FEATURE, '--json']);
    if (result.code !== 0) throw new Error(`dispatch: ${result.err}`);
    return JSON.parse(result.out);
  };
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
it('makes a WSL Codex reviewer checkout readable by Git on both hosts', async () => {
  const { s, t } = await ready();
  const configPath = join(s.control, 'mycelink.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.provider = { provider: 'codex', executable: 'codex', extra_args: [] };
  config.experimental_codex = { enabled: true, disposable_repositories: ['changesets'], wsl: { distribution: 'Ubuntu', user: 'psh09' } };
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  const original = reviewPacket(t);
  const reviewId = `${t.review_id}-WSL`;
  const slotDir = join(s.control, '.mycelink', 'reviews', VER_FEATURE, reviewId, t.dispatch_id);
  const built = buildReviewPacket({ controlRoot: s.control, featureId: VER_FEATURE, workspace: loadWorkspace(s.control), graph: loadGraph(s.control, VER_FEATURE), state: loadState(s.featureDir)!.data, reviewId, dispatchId: t.dispatch_id, review: 1, roundsUsed: 0, maxRounds: 2, inputs: original.inputs, inputsSha256: original.inputs_sha256, slotDir, verdictFile: join(slotDir, 'verdict.json') });
  const checkout = built.packet.repositories[0]!.checkout;
  const pointer = readFileSync(join(checkout, '.git'), 'utf8').trim();
  expect(pointer).toMatch(/^gitdir: \.\./);
  expect(pointer).not.toMatch(/[A-Za-z]:[\\/]/);
  expect(readFileSync(join(checkout, pointer.slice('gitdir: '.length), 'gitdir'), 'utf8').trim()).toMatch(/^\.\./);
});
function fake(final: unknown) {
  const root = mkdtempSync(join(process.env.TMPDIR ?? process.env.TEMP ?? tmpdir(), 'codex-review-bridge-'));
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

it('separate Codex refinement judges an archived challenge under the same review, never relabeling its old GAPS as PASS', async () => {
  const s = await r6Reviewed();
  const worker = JSON.parse((await verCli(s, ['dispatch', VER_FEATURE, '--json'])).out).ticket;
  expect(worker.node_id).toBe(ARP);
  writeChallenge(worker, s.control);
  const challenged = JSON.parse((await verCli(s, ['settle', VER_FEATURE, ARP, '--capability', worker.capability, '--json'])).out);
  expect(challenged.outcome).toBe('REVIEW_CHALLENGED');
  const ticket = JSON.parse((await verCli(s, ['dispatch', VER_FEATURE, '--json'])).out).ticket;
  expect(ticket.refinement).not.toBeNull();
  const packet = reviewPacket(ticket);
  const verdict = refinementFor(packet, { 'AC-1': { decision: 'REFINE', gap: AC1_REFINED, producer: { node_id: ARP } } });
  const engine = new Orchestrator({ controlRoot: s.control, featureId: VER_FEATURE, adapter: {} as SessionAdapter });
  const result = await engine.settleCodexReview({ ...ticket, prompt: codexRefinementPrompt(ticket.prompt, ticket.packet_path) },
    { executable: process.execPath, prefixArgs: [fake(verdict)], timeoutMs: 5000 });
  expect(result.outcome).toBe('GAPS');
  expect(result.refinement?.decisions).toMatchObject([{ criterion: 'AC-1', decision: 'REFINE' }]);
  expect(verState(s).acceptance_review.challenges[0]).toMatchObject({ status: 'refined' });
  expect(verState(s).current_candidate).toBeNull();
});
