import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import YAML from 'yaml';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { FEATURE_ID, createPortfolio, portfolioGraph, writePrd } from '../helpers/portfolio-fixture.js';
import { asController } from '../helpers/authority.js';
import { git } from '../helpers/git-fixture.js';
import { main, type CliIo } from '../../src/cli/cli.js';
import { Orchestrator } from '../../src/engine/orchestrator.js';
import { FakeInProcessAdapter } from '../../src/sessions/fake-adapter.js';
import { enableCodexLifecycle } from '../../src/state/codex-lifecycle.js';
import { loadState } from '../../src/state/feature-state.js';
import { readGateTests } from '../../src/evidence/gate-tests.js';

/**
 * RED contract for a DISTINCT trusted controller path. This is deliberately
 * not ProcessSessionAdapter and must not enable production Codex preflight.
 * No callback from an untrusted worker may supply the Git source map, broker
 * predicates, gate verdicts, reviewer verdict or usage account.
 *
 * These opt-in scenarios require a real Windows host, Ubuntu WSL, the isolated
 * Linux Codex binary and (for the model tests) an existing valid Linux login.
 * They must never silently replace that path with a fake model or a skip.
 */
type TransactionRequest = {
  nodeId: string;
  claimId: string;
  generation: string;
  allowedPaths: string[];
  prompt: string;
  /** In the fixture, exercise denial from both model tool families. */
  isolationProbe?: 'mcp' | 'builtin';
  /** Fixture hook/broker refusal must be enforced by the trusted consumer. */
  refusalFixture?: 'hook-exit-nonzero' | 'broker-denied' | 'unsealed-transport';
  /** Fixture-only interruption; the controller owns the journal and recovery. */
  interruptAfter?: 'first-apply' | 'result-written';
  /** Observation only: a test may pause the turn, never authorize a gate. */
  onPhase?: (phase: 'model-complete') => Promise<void>;
};
type TransactionReceipt = {
  claim: string;
  generation: string;
  workerSeal: string;
  reviewerSeal: string;
  /** Controller-derived immutable Git object bytes, not the worker's own manifest. */
  sourceSha256: Record<string, string>;
  model: { platform: 'linux'; apiRequests: number; mcpCalls: number; builtinCalls: number };
  /** Controller-observed probe evidence, never a free-form model assertion. */
  isolation?: { hostMountDenied: boolean; directEgressDenied: boolean; otherRoleSlotDenied: boolean };
  gates: { gate: 'red' | 'green' | 'regression'; exitCode: number; argv: string[] }[];
  settlement: { outcome: string; idempotent: boolean; usageSessions: number };
};
type TransactionController = Orchestrator & {
  runExperimentalWslCodexTransaction(request: TransactionRequest): Promise<TransactionReceipt>;
  reconcileExperimentalWslCodexTransaction(nodeId: string, claimId: string, generation: string): Promise<TransactionReceipt>;
};

const CORE = `${FEATURE_ID}.core.publish.impl`;
const live = process.platform === 'win32' && process.env['MYCELINK_LIVE_WSL_WORKER'] === '1';
const authenticated = live && process.env['MYCELINK_LIVE_WSL_CODEX_AUTH'] === '1';
afterAll(() => cleanupTmpRoots());

async function claim(probe?: 'mcp' | 'builtin') {
  const p = createPortfolio();
  if (probe === 'mcp') {
    writeFileSync(join(p.core, 'mcp.py'), `import json, sys
for line in sys.stdin:
    m = json.loads(line)
    method = m.get('method')
    if method == 'initialize':
        result = {'protocolVersion':'2024-11-05','capabilities':{'tools':{}},'serverInfo':{'name':'probe','version':'1'}}
    elif method == 'tools/list':
        result = {'tools':[{'name':'inspect_fixture','description':'Inspect the isolated fixture','inputSchema':{'type':'object','properties':{}}}]}
    elif method == 'tools/call':
        result = {'content':[{'type':'text','text':'fixture inspected'}]}
    else:
        result = {}
    if 'id' in m:
        print(json.dumps({'jsonrpc':'2.0','id':m['id'],'result':result}), flush=True)
`);
    git(p.core, ['add', '--', 'mcp.py']);
    git(p.core, ['commit', '-q', '-m', 'fixture: immutable MCP server']);
  }
  writePrd(p);
  const graph = portfolioGraph();
  const core = (graph['nodes'] as { id: string; verification_commands: { id: string; command: string[] }[] }[])
    .find((node) => node.id === CORE)!;
  // The exact declared verifier writes a controller-owned JUnit report. Raw
  // console/TAP text alone is not accepted as a named criterion test.
  core.verification_commands = [{ id: 'targeted', command: [
    'node', '--test-reporter=junit', '--test-reporter-destination=${REPORT}', 'tests/run.mjs',
  ] }];
  writeFileSync(join(p.featureDir, 'PORTFOLIO-GRAPH.yaml'), YAML.stringify(graph, { lineWidth: 0 }));
  const io: CliIo = { out: () => undefined, err: (error) => { throw new Error(error); } };
  expect(await main([...asController(['feature', 'init', FEATURE_ID], p.control), '--control-root', p.control], io)).toBe(0);
  const configFile = join(p.control, 'mycelink.config.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>;
  writeFileSync(configFile, JSON.stringify({ ...config, provider: { provider: 'codex' } }));
  const o = new Orchestrator({ controlRoot: p.control, featureId: FEATURE_ID,
    adapter: new FakeInProcessAdapter({}), preflight: () => ({ ok: false, adapter: 'codex-cli' }) }) as TransactionController;
  const ticket = o.claim(CORE, { mode: 'host' }); // experimental host claim, not CLI Codex dispatch
  enableCodexLifecycle(p.featureDir);
  const request = (prompt: string): TransactionRequest => ({
    nodeId: CORE, claimId: ticket.claimId, generation: ticket.dispatchId!,
    // The portfolio declares `node tests/run.mjs`; an unreferenced test file
    // cannot establish RED, even if it is committed by the controller.
    allowedPaths: ['tests/run.mjs', 'src/publish.js'], prompt,
  });
  return { p, o, ticket, request };
}

const implement = 'Modify tests/run.mjs with a node:test assertion named "publishing emits JOB_RESULT_V2" which fails because src/publish.js does not yet exist, then implement src/publish.js with JOB_RESULT_V2. Preserve the existing tests and use the declared Node reporter command.';

function transaction(o: TransactionController, request: TransactionRequest): Promise<TransactionReceipt> {
  // A missing controller is a deliberate RED, not a WSL/login failure or a
  // passing test that merely asserts the present preflight denial.
  expect(typeof o.runExperimentalWslCodexTransaction, 'WSL_CODEX_TRANSACTION_NOT_IMPLEMENTED').toBe('function');
  return o.runExperimentalWslCodexTransaction(request);
}

function assertNoSettlement(featureDir: string) {
  expect(loadState(featureDir)!.data.nodes[CORE]!.state).not.toBe('DONE');
}

describe('trusted Windows claim to WSL Codex transaction (production dispatch stays disabled)', () => {
  it.skipIf(!authenticated)('binds RED test identity to a real structured report before settlement', async () => {
    const { p, o, ticket, request } = await claim();
    const base = git(ticket.worktree!, ['rev-parse', 'HEAD']);
    const receipt = await transaction(o, request(implement));
    expect(receipt.settlement.outcome).toBe('DONE');
    expect(git(p.core, ['log', '--format=%H', `${base}..${ticket.branch!}`]).split('\n').filter(Boolean)).toHaveLength(2);
    const red = loadState(p.featureDir)!.data.nodes[CORE]!.evidence.red;
    expect(red?.results?.format).toBe('junit-xml');
    expect(readGateTests(p.control, red)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'tests/run.mjs', name: 'publishing emits JOB_RESULT_V2', status: 'failed' }),
    ]));
    expect(loadState(p.featureDir)!.data.nodes[CORE]!.state).toBe('DONE');
  }, 180_000);

  it('requires a controller-owned whole-transaction entry point instead of adapting a writable worker', async () => {
    const { p, o, request } = await claim();
    // The normal (no WSL/auth opt-in) run is RED specifically for the absent
    // controller. Once implemented, this test runs only when live opt-in is set.
    if (!authenticated) {
      expect(typeof o.runExperimentalWslCodexTransaction, 'WSL_CODEX_TRANSACTION_NOT_IMPLEMENTED').toBe('function');
      await expect(transaction(o, request(implement))).rejects.toThrow(/WSL_CODEX_EXPERIMENT_NOT_ENABLED/);
      assertNoSettlement(p.featureDir);
      return;
    }
    const receipt = await transaction(o, request(implement));
    expect(receipt.settlement.outcome).toBe('DONE');
  });

  it.skipIf(!authenticated)('runs a real Linux model and scoped API bridge, seals distinct worker/reviewer results and executes trusted RED/GREEN/regression gates', async () => {
    const { p, o, ticket, request } = await claim();
    const base = git(ticket.worktree!, ['rev-parse', 'HEAD']);
    const immutableRunner = execFileSync('git', ['show', `${base}:tests/run.mjs`], { cwd: ticket.worktree! });
    const trustedDigest = createHash('sha256').update(immutableRunner).digest('hex');
    const receipt = await transaction(o, request(implement));
    expect(receipt).toMatchObject({ claim: ticket.claimId, generation: ticket.dispatchId,
      workerSeal: expect.any(String), reviewerSeal: expect.any(String),
      model: { platform: 'linux', apiRequests: expect.any(Number) },
      settlement: { outcome: 'DONE', idempotent: false, usageSessions: 1 } });
    expect(receipt.workerSeal).not.toBe(receipt.reviewerSeal);
    expect(receipt.sourceSha256['tests/run.mjs']).toBe(trustedDigest);
    expect(receipt.model.apiRequests).toBeGreaterThan(0);
    expect(loadState(p.featureDir)!.data.nodes[CORE]!.usage.input_tokens).toBeGreaterThan(0);
    expect(loadState(p.featureDir)!.data.nodes[CORE]!.usage.output_tokens).toBeGreaterThan(0);
    expect(receipt.gates.map((g) => [g.gate, g.exitCode])).toEqual([['red', 0], ['green', 0], ['regression', 0]]);
    expect(receipt.gates.every((g) => g.argv.includes('node') || g.argv.includes('mycelink'))).toBe(true);
    const commits = git(p.core, ['log', '--reverse', '--format=%H', `${base}..${ticket.branch!}`]).split('\n').filter(Boolean);
    expect(commits.map((sha) => git(p.core, ['show', '--format=', '--name-only', sha]).split('\n').filter(Boolean)))
      .toEqual([['tests/run.mjs'], ['src/publish.js']]);
    expect(loadState(p.featureDir)!.data.nodes[CORE]!.state).toBe('DONE');
    const journal = join(p.featureDir, 'wsl-codex-transactions',
      createHash('sha256').update(`${CORE}\0${ticket.claimId}\0${ticket.dispatchId!}`).digest('hex') + '.json');
    expect(JSON.parse(readFileSync(journal, 'utf8'))).toMatchObject({
      phase: 'settled', claimId: ticket.claimId, dispatchId: ticket.dispatchId,
      resultSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(() => readFileSync(journal.replace(/\.json$/, '.cap'))).toThrow();
  }, 180_000);

  it.skipIf(!authenticated)('routes model-driven MCP and built-in shell tools through the same isolated generation', async () => {
    for (const [path, probe] of [
      ['mcpCalls', 'mcp'],
      ['builtinCalls', 'builtin'],
    ] as const) {
      const { o, ticket, request } = await claim(probe);
      // The controller prepends the exact tool instruction once. Duplicating
      // a second free-form tool demand makes the built-in turn ambiguous.
      let receipt: TransactionReceipt;
      try {
        receipt = await transaction(o, { ...request(implement), isolationProbe: probe });
      } catch (error) {
        const root = `/var/lib/mycelink-codex/transport/${ticket.claimId}/${ticket.dispatchId}`;
        const stage = execFileSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'root', '--', 'python3', '-c',
          'import os,sys,json; r=sys.argv[1]; names=("worker.pending","worker.json","reviewer.pending","reviewer.json"); p=os.path.join(r,"worker.failure.json"); q=os.path.join(r,"turn-failure.json"); print(json.dumps({"files":{n:os.path.isfile(os.path.join(r,n)) for n in names},"workerFailure":json.load(open(p)) if os.path.isfile(p) else None,"turnFailure":json.load(open(q)) if os.path.isfile(q) else None}))', root],
        { encoding: 'utf8' }).trim();
        throw new Error(`WSL_CODEX_PROBE_${probe}_FAILED:${stage}:${String(error)}`);
      }
      expect(receipt).toMatchObject({ claim: ticket.claimId, generation: ticket.dispatchId, settlement: { outcome: 'DONE' } });
      expect(receipt.model[path]).toBeGreaterThan(0); // actual tool invocation, not text mentioning it
      expect(receipt.model.apiRequests).toBeGreaterThan(0);
      expect(receipt.isolation).toEqual({ hostMountDenied: true, directEgressDenied: true, otherRoleSlotDenied: true });
    }
  }, 240_000);

  it.skipIf(!authenticated)('binds a real model-driven MCP tool to both sealed OS isolation receipts', async () => {
    const { p, o, request } = await claim('mcp');
    const receipt = await transaction(o, { ...request('Use the configured probe MCP inspect_fixture tool, then ' + implement), isolationProbe: 'mcp' });
    expect(receipt.settlement.outcome).toBe('DONE');
    expect(receipt.model.mcpCalls).toBeGreaterThan(0);
    expect(receipt.isolation).toEqual({ hostMountDenied: true, directEgressDenied: true, otherRoleSlotDenied: true });
    expect(loadState(p.featureDir)!.data.nodes[CORE]!.usage.sessions).toBe(1);
  }, 180_000);

  it.skipIf(!authenticated)('binds a real built-in shell invocation to both sealed OS isolation receipts', async () => {
    const { p, o, request } = await claim('builtin');
    const receipt = await transaction(o, { ...request(implement), isolationProbe: 'builtin' });
    expect(receipt.settlement.outcome).toBe('DONE');
    expect(receipt.model.builtinCalls).toBeGreaterThan(0);
    expect(receipt.isolation).toEqual({ hostMountDenied: true, directEgressDenied: true, otherRoleSlotDenied: true });
    expect(loadState(p.featureDir)!.data.nodes[CORE]!.usage.sessions).toBe(1);
  }, 180_000);

  it.skipIf(!authenticated)('refuses mutable DrvFS source drift before any proposal is applied', async () => {
    const { p, o, ticket, request } = await claim();
    writeFileSync(join(ticket.worktree!, 'tests', 'run.mjs'), 'throw new Error("untrusted mutable worktree source");\n');
    await expect(transaction(o, request(implement))).rejects.toThrow(/SOURCE_DRIFT|DIRTY|SNAPSHOT/);
    expect(readFileSync(join(ticket.worktree!, 'tests', 'run.mjs'), 'utf8')).toContain('untrusted mutable worktree source');
    assertNoSettlement(p.featureDir);
  }, 180_000);

  it.skipIf(!authenticated)('rejects failed hooks, broker denial and unsealed transport before any apply', async () => {
    for (const [fixture, reason] of [
      ['hook-exit-nonzero', /HOOK/],
      ['broker-denied', /BROKER|DENIED/],
      ['unsealed-transport', /TRANSPORT|UNSEALED/],
    ] as const) {
      const { p, o, request } = await claim();
      await expect(transaction(o, { ...request(implement), refusalFixture: fixture })).rejects.toThrow(reason);
      assertNoSettlement(p.featureDir);
    }
  }, 240_000);

  it.skipIf(!authenticated)('revokes a generation cancelled between model turn and broker seal; no later settle may resurrect it', async () => {
    const { p, o, ticket, request } = await claim();
    let signal!: () => void;
    let release!: () => void;
    const reachedModel = new Promise<void>((resolve) => { signal = resolve; });
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const pending = transaction(o, { ...request(implement), onPhase: async (phase) => {
      expect(phase).toBe('model-complete');
      signal();
      await paused;
    } });
    try {
      await Promise.race([reachedModel, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('MODEL_PHASE_TIMEOUT')), 90_000))]);
      const io: CliIo = { out: () => undefined, err: (message) => { throw new Error(message); } };
      expect(await main([...asController(['feature', 'cancel', FEATURE_ID], p.control), '--control-root', p.control], io)).toBe(0);
    } finally {
      release();
    }
    await expect(pending).rejects.toThrow(/CANCEL|REVOK|STALE/);
    await expect(o.reconcileExperimentalWslCodexTransaction(CORE, ticket.claimId, ticket.dispatchId!))
      .rejects.toThrow(/CANCEL|REVOK|STALE/);
    assertNoSettlement(p.featureDir);
  }, 120_000);

  it.skipIf(!authenticated)('refuses a sealed old generation when resume rotates the host dispatch during the model turn', async () => {
    const { p, o, ticket, request } = await claim();
    let signal!: () => void;
    let release!: () => void;
    const reachedModel = new Promise<void>((resolve) => { signal = resolve; });
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const pending = transaction(o, { ...request(implement), onPhase: async () => { signal(); await paused; } });
    try {
      await Promise.race([reachedModel, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('MODEL_PHASE_TIMEOUT')), 90_000))]);
      o.resumeDispatch(CORE);
      expect(loadState(p.featureDir)!.data.nodes[CORE]!.claim?.dispatch_id).not.toBe(ticket.dispatchId);
    } finally {
      release();
    }
    await expect(pending).rejects.toThrow(/REVOK|STALE|GENERATION/);
    await expect(o.reconcileExperimentalWslCodexTransaction(CORE, ticket.claimId, ticket.dispatchId!))
      .rejects.toThrow(/REVOK|STALE|GENERATION/);
    assertNoSettlement(p.featureDir);
  }, 120_000);

  it.skipIf(!authenticated)('reconciles a durable result-written interruption in a new controller without charging twice', async () => {
    const { p, o, ticket, request } = await claim();
    await expect(transaction(o, { ...request(implement), interruptAfter: 'result-written' }))
      .rejects.toThrow(/INTERRUPT/);
    expect(loadState(p.featureDir)!.data.nodes[CORE]!.usage.sessions).toBe(0);
    const recovered = new Orchestrator({ controlRoot: p.control, featureId: FEATURE_ID,
      adapter: new FakeInProcessAdapter({}), preflight: () => ({ ok: false, adapter: 'codex-cli' }) }) as TransactionController;
    const journal = join(p.featureDir, 'wsl-codex-transactions',
      createHash('sha256').update(`${CORE}\0${ticket.claimId}\0${ticket.dispatchId!}`).digest('hex') + '.json');
    const originalJournal = readFileSync(journal, 'utf8');
    const forgedSeal = JSON.parse(originalJournal);
    forgedSeal.receipt.workerSeal = '0'.repeat(64);
    forgedSeal.receiptSha256 = createHash('sha256').update(JSON.stringify(forgedSeal.receipt)).digest('hex');
    writeFileSync(journal, JSON.stringify(forgedSeal));
    await expect(recovered.reconcileExperimentalWslCodexTransaction(CORE, ticket.claimId, ticket.dispatchId!))
      .rejects.toThrow(/RECEIPT_INVALID/);
    expect(loadState(p.featureDir)!.data.nodes[CORE]!.usage.sessions).toBe(0);
    writeFileSync(journal, originalJournal);
    const resultSlot = join(ticket.worktree!, '.mycelink-worker',
      loadState(p.featureDir)!.data.nodes[CORE]!.claim!.result_file!);
    const originalResult = readFileSync(resultSlot, 'utf8');
    const forgedUsage = JSON.parse(originalResult);
    forgedUsage.usage.input_tokens += 5000;
    const alteredResult = JSON.stringify(forgedUsage) + '\n';
    const alteredJournal = JSON.parse(originalJournal);
    alteredJournal.resultSha256 = createHash('sha256').update(alteredResult).digest('hex');
    writeFileSync(resultSlot, alteredResult);
    writeFileSync(journal, JSON.stringify(alteredJournal));
    await expect(recovered.reconcileExperimentalWslCodexTransaction(CORE, ticket.claimId, ticket.dispatchId!))
      .rejects.toThrow(/RESULT_DRIFT|RECEIPT_INVALID/);
    expect(loadState(p.featureDir)!.data.nodes[CORE]!.usage.sessions).toBe(0);
    writeFileSync(resultSlot, originalResult);
    writeFileSync(journal, originalJournal);
    const beforeSettlementForged = JSON.parse(originalJournal);
    beforeSettlementForged.receipt.sourceSha256['tests/run.mjs'] = '0'.repeat(64);
    beforeSettlementForged.receiptSha256 = createHash('sha256').update(JSON.stringify(beforeSettlementForged.receipt)).digest('hex');
    writeFileSync(journal, JSON.stringify(beforeSettlementForged));
    await expect(recovered.reconcileExperimentalWslCodexTransaction(CORE, ticket.claimId, ticket.dispatchId!))
      .rejects.toThrow(/RECEIPT_INVALID/);
    writeFileSync(journal, originalJournal);
    const receipt = await recovered.reconcileExperimentalWslCodexTransaction(CORE, ticket.claimId, ticket.dispatchId!);
    expect(receipt.settlement).toMatchObject({ outcome: 'DONE', idempotent: false, usageSessions: 1 });
    const again = await recovered.reconcileExperimentalWslCodexTransaction(CORE, ticket.claimId, ticket.dispatchId!);
    expect(again.settlement).toMatchObject({ outcome: 'DONE', idempotent: true, usageSessions: 1 });
    const forged = JSON.parse(readFileSync(journal, 'utf8'));
    forged.receipt.gates[0].exitCode = 9;
    forged.receiptSha256 = createHash('sha256').update(JSON.stringify(forged.receipt)).digest('hex');
    writeFileSync(journal, JSON.stringify(forged));
    await expect(recovered.reconcileExperimentalWslCodexTransaction(CORE, ticket.claimId, ticket.dispatchId!))
      .rejects.toThrow(/RECEIPT_INVALID/);
    const altered = JSON.parse(readFileSync(journal, 'utf8'));
    altered.receipt.gates[0].exitCode = 0;
    altered.receipt.gates[0].argv = ['node', 'unrelated.mjs'];
    altered.receiptSha256 = createHash('sha256').update(JSON.stringify(altered.receipt)).digest('hex');
    writeFileSync(journal, JSON.stringify(altered));
    await expect(recovered.reconcileExperimentalWslCodexTransaction(CORE, ticket.claimId, ticket.dispatchId!))
      .rejects.toThrow(/RECEIPT_INVALID/);
  }, 180_000);

  it.skipIf(!authenticated)('reconciles a crash after first apply without duplicate Git commits or double usage settlement', async () => {
    const { p, o, ticket, request } = await claim();
    await expect(transaction(o, { ...request(implement), interruptAfter: 'first-apply' }))
      .rejects.toThrow(/INTERRUPT|CRASH/);
    const scopeDigest = createHash('sha256').update(`${CORE}\0${ticket.claimId}\0${ticket.dispatchId!}`).digest('hex');
    const escrow = readFileSync(join(p.featureDir, 'wsl-codex-transactions', scopeDigest + '.cap'), 'utf8');
    expect(escrow).not.toContain(ticket.capability);
    const recovered = new Orchestrator({ controlRoot: p.control, featureId: FEATURE_ID,
      adapter: new FakeInProcessAdapter({}), preflight: () => ({ ok: false, adapter: 'codex-cli' }) }) as TransactionController;
    const journal = join(p.featureDir, 'wsl-codex-transactions', scopeDigest + '.json');
    const originalJournal = readFileSync(journal, 'utf8');
    const forged = JSON.parse(originalJournal);
    forged.workerSealHash = '0'.repeat(64);
    writeFileSync(journal, JSON.stringify(forged));
    await expect(recovered.reconcileExperimentalWslCodexTransaction(CORE, ticket.claimId, ticket.dispatchId!))
      .rejects.toThrow(/RECEIPT_INVALID/);
    expect(loadState(p.featureDir)!.data.nodes[CORE]!.usage.sessions).toBe(0);
    writeFileSync(journal, originalJournal);
    const receipt = await recovered.reconcileExperimentalWslCodexTransaction(CORE, ticket.claimId, ticket.dispatchId!);
    expect(receipt.settlement).toMatchObject({ outcome: 'DONE', usageSessions: 1 });
    const after = git(p.core, ['rev-parse', ticket.branch!]);
    const again = await recovered.reconcileExperimentalWslCodexTransaction(CORE, ticket.claimId, ticket.dispatchId!);
    expect(again.settlement).toMatchObject({ outcome: 'DONE', idempotent: true, usageSessions: 1 });
    expect(git(p.core, ['rev-parse', ticket.branch!])).toBe(after);
    expect(loadState(p.featureDir)!.data.nodes[CORE]!.usage.sessions).toBe(1);
  }, 120_000);
});
