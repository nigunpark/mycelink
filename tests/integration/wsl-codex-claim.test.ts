import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { hostname } from 'node:os';
import { codexLifecycleLockPath, enableCodexLifecycle, withCodexLifecycleLock } from '../../src/state/codex-lifecycle.js';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import YAML from 'yaml';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { FEATURE_ID, createPortfolio, portfolioGraph, writePrd } from '../helpers/portfolio-fixture.js';
import { main, type CliIo } from '../../src/cli/cli.js';
import { asController } from '../helpers/authority.js';
import { Orchestrator } from '../../src/engine/orchestrator.js';
import { FakeInProcessAdapter } from '../../src/sessions/fake-adapter.js';
import { startExperimentalWslProcess, wslCodexProcessResult } from '../../src/sessions/wsl-codex-process.js';
import { loadState, mutateState, saveState } from '../../src/state/feature-state.js';

const CORE = `${FEATURE_ID}.core.publish.impl`;
afterAll(() => cleanupTmpRoots());

async function fixture() {
  const p = createPortfolio();
  writePrd(p);
  writeFileSync(join(p.featureDir, 'PORTFOLIO-GRAPH.yaml'), YAML.stringify(portfolioGraph(), { lineWidth: 0 }));
  const io: CliIo = { out: () => undefined, err: (error) => { throw new Error(error); } };
  expect(await main([...asController(['feature', 'init', FEATURE_ID], p.control), '--control-root', p.control], io)).toBe(0);
  const configFile = join(p.control, 'mycelink.config.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>;
  writeFileSync(configFile, JSON.stringify({ ...config, provider: { provider: 'codex' } }));
  const o = new Orchestrator({ controlRoot: p.control, featureId: FEATURE_ID,
    adapter: new FakeInProcessAdapter({}), preflight: () => ({ ok: false, adapter: 'codex-cli' }) });
  return { p, o };
}

describe('production Codex dispatch remains disabled', () => {
  it('refuses the host dispatch command before creating any claim, even with the experimental marker', async () => {
    const { p } = await fixture();
    enableCodexLifecycle(p.featureDir);
    let error = '';
    let output = '';
    const io: CliIo = { out: (text) => { output += text; }, err: (text) => { error += text; } };
    const result = await main([...asController(['dispatch', FEATURE_ID], p.control), '--control-root', p.control], io);
    expect(result).not.toBe(0);
    expect(error + output).toMatch(/Codex.*disabled|Codex.*not supported/i);
    expect(loadState(p.featureDir)!.data.nodes[CORE]!.claim).toBeNull();
    expect(loadState(p.featureDir)!.data.nodes[CORE]!.attempts).toBe(0);
  });
});

describe('dedicated Codex lifecycle mutex (dispatch remains disabled)', () => {
  it('never steals an aged live owner and refuses a mutation while it holds the gate', async () => {
    const { p } = await fixture();
    enableCodexLifecycle(p.featureDir);
    const path = codexLifecycleLockPath(p.featureDir);
    writeFileSync(path, JSON.stringify({ pid: process.pid, host: hostname(), token: 'other-process', acquired_at: '2000-01-01T00:00:00.000Z' }));
    const before = readFileSync(join(p.featureDir, 'STATE.json'), 'utf8');
    expect(() => withCodexLifecycleLock(p.featureDir, () => 1, { timeoutMs: 40 })).toThrow(/lifecycle|lock/i);
    expect(() => mutateState(p.featureDir, (s) => { s.feature_state = 'CANCELLED'; return s; }, { lockTimeoutMs: 40 }))
      .toThrow(/lifecycle|lock/i);
    expect(readFileSync(join(p.featureDir, 'STATE.json'), 'utf8')).toBe(before);
    expect(JSON.parse(readFileSync(path, 'utf8')).token).toBe('other-process');
    rmSync(path);
  });

  it('does not inspect a live claim while another process controls revocation', async () => {
    const { p, o } = await fixture();
    const claimed = o.claim(CORE, { mode: 'host' });
    enableCodexLifecycle(p.featureDir);
    const path = codexLifecycleLockPath(p.featureDir);
    writeFileSync(path, JSON.stringify({ pid: process.pid, host: hostname(), token: 'other-process', acquired_at: '2000-01-01T00:00:00.000Z' }));
    expect(() => o.inspectWslCodexClaim(CORE, claimed.claimId, claimed.dispatchId!, ['src/new.ts']))
      .toThrow(/CODEX_LIFECYCLE_LOCK_BUSY/);
    rmSync(path);
  });

  it('authorizes broker work only inside the live generation mutex', async () => {
    const { p, o } = await fixture();
    const claimed = o.claim(CORE, { mode: 'host' });
    expect(() => o.withLiveWslCodexClaim(CORE, claimed.claimId, claimed.dispatchId!, ['src/new.ts'], () => 'sealed'))
      .toThrow(/CODEX_LIFECYCLE_NOT_ENABLED/);
    enableCodexLifecycle(p.featureDir);
    expect(o.withLiveWslCodexClaim(CORE, claimed.claimId, claimed.dispatchId!, ['src/new.ts'], (binding) => {
      expect(binding.allowed_paths).toEqual(['src/new.ts']);
      expect(JSON.parse(readFileSync(codexLifecycleLockPath(p.featureDir), 'utf8')).pid).toBe(process.pid);
      return 'sealed';
    })).toBe('sealed');
    mutateState(p.featureDir, (s) => { s.feature_state = 'CANCELLED'; return s; });
    expect(() => o.withLiveWslCodexClaim(CORE, claimed.claimId, claimed.dispatchId!, ['src/new.ts'], () => 'wrong'))
      .toThrow(/WSL_CLAIM_STALE/);
  });

  it('does not return acceptance if the trusted callback itself revokes the generation', async () => {
    const { p, o } = await fixture();
    const claimed = o.claim(CORE, { mode: 'host' });
    enableCodexLifecycle(p.featureDir);
    expect(() => o.withLiveWslCodexClaim(CORE, claimed.claimId, claimed.dispatchId!, ['src/new.ts'], () => {
      mutateState(p.featureDir, (s) => { s.feature_state = 'CANCELLED'; return s; });
      return 'sealed';
    })).toThrow(/WSL_CLAIM_STALE/);
  });

  it('serializes a real cross-process cancel against broker consumption', async () => {
    const { p, o } = await fixture();
    const claimed = o.claim(CORE, { mode: 'host' });
    enableCodexLifecycle(p.featureDir);
    const argv = [join(process.cwd(), 'dist', 'mycelink.mjs'),
      ...asController(['feature', 'cancel', FEATURE_ID, '--control-root', p.control], p.control)];
    o.withLiveWslCodexClaim(CORE, claimed.claimId, claimed.dispatchId!, ['src/new.ts'], () => {
      const blocked = spawnSync(process.execPath, argv, { encoding: 'utf8', timeout: 2_000 });
      expect((blocked.error as NodeJS.ErrnoException | undefined)?.code).toBe('ETIMEDOUT');
      expect(loadState(p.featureDir)!.data.feature_state).not.toBe('CANCELLED');
    });
    const cancelled = spawnSync(process.execPath, argv, { encoding: 'utf8', timeout: 15_000 });
    expect(cancelled.status, cancelled.stderr).toBe(0);
    expect(loadState(p.featureDir)!.data.feature_state).toBe('CANCELLED');
    expect(() => o.withLiveWslCodexClaim(CORE, claimed.claimId, claimed.dispatchId!, ['src/new.ts'], () => 'bad'))
      .toThrow(/WSL_CLAIM_STALE/);
  });

  it('refuses resume and settle while broker consumption owns the lifecycle gate', async () => {
    const { p, o } = await fixture();
    const claimed = o.claim(CORE, { mode: 'host' });
    enableCodexLifecycle(p.featureDir);
    const path = codexLifecycleLockPath(p.featureDir);
    writeFileSync(path, JSON.stringify({ pid: process.pid, host: hostname(), token: 'other-process', acquired_at: '2000-01-01T00:00:00.000Z' }));
    const started = Date.now();
    expect(() => o.resumeDispatch(CORE)).toThrow(/CODEX_LIFECYCLE_LOCK_BUSY/);
    expect(() => o.settle(CORE, claimed.capability)).toThrow(/CODEX_LIFECYCLE_LOCK_BUSY/);
    expect(() => o.completeSettlement(CORE, 'resume')).toThrow(/CODEX_LIFECYCLE_LOCK_BUSY/);
    expect(Date.now() - started).toBeLessThan(8_000); // entry gate, not a late lock after reading mutable slots
    expect(loadState(p.featureDir)!.data.nodes[CORE]!.claim?.dispatch_id).toBe(claimed.dispatchId);
    rmSync(path);
  });

  it('fences checkpoint restoration through the direct saveState path', async () => {
    const { p } = await fixture();
    enableCodexLifecycle(p.featureDir);
    const original = loadState(p.featureDir)!.data;
    const path = codexLifecycleLockPath(p.featureDir);
    writeFileSync(path, JSON.stringify({ pid: process.pid, host: hostname(), token: 'other-process', acquired_at: '2000-01-01T00:00:00.000Z' }));
    expect(() => saveState(p.featureDir, { ...original, feature_state: 'CANCELLED' }))
      .toThrow(/CODEX_LIFECYCLE_LOCK_BUSY/);
    expect(loadState(p.featureDir)!.data.feature_state).toBe(original.feature_state);
    rmSync(path);
  });

  it('rejects asynchronous lifecycle callbacks instead of releasing a lock across an unresolved operation', async () => {
    const { p } = await fixture();
    enableCodexLifecycle(p.featureDir);
    expect(() => withCodexLifecycleLock(p.featureDir, async () => 'late'))
      .toThrow(/CODEX_LIFECYCLE_ASYNC_FORBIDDEN/);
  });

  it('recovers a dead process identity even when its pid was reused', async () => {
    const { p } = await fixture();
    enableCodexLifecycle(p.featureDir);
    const path = codexLifecycleLockPath(p.featureDir);
    writeFileSync(path, JSON.stringify({ pid: process.pid, host: hostname(), token: 'reused',
      identity: { pid: process.pid, host: hostname(), platform: process.platform, boot: null, start: 'not-this-process' },
      acquired_at: '2000-01-01T00:00:00.000Z' }));
    expect(withCodexLifecycleLock(p.featureDir, () => 'recovered', { timeoutMs: 4_000 })).toBe('recovered');
  });

  it('recovers an orphaned owner and permits nested state mutation in the same transaction', async () => {
    const { p } = await fixture();
    enableCodexLifecycle(p.featureDir);
    const path = codexLifecycleLockPath(p.featureDir);
    writeFileSync(path, JSON.stringify({ pid: 2147483647, host: hostname(), token: 'orphan', acquired_at: '2000-01-01T00:00:00.000Z' }));
    withCodexLifecycleLock(p.featureDir, () => {
      expect(JSON.parse(readFileSync(path, 'utf8')).token).not.toBe('orphan');
      mutateState(p.featureDir, (s) => { s.blocked_reason = 'recovered'; return s; });
    });
    expect(loadState(p.featureDir)!.data.blocked_reason).toBe('recovered');
  });
});

describe('experimental WSL claim policy binding (not launch authorization)', () => {
  it.skipIf(process.platform !== 'win32' || process.env['MYCELINK_LIVE_WSL_CODEX_AUTH'] !== '1')(
    'registers an authenticated isolated Linux Codex turn and scoped bridge under the live host generation', async () => {
      const { p, o } = await fixture();
      const ticket = o.claim(CORE, { mode: 'host' });
      enableCodexLifecycle(p.featureDir);
      const stage = o.stageExperimentalWslCodexClaimSource(CORE, ticket.claimId, ticket.dispatchId!, ['src/publish.js', 'tests/publish.test.mjs']);
      try {
        const script = spawnSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'root', '--', 'wslpath', '-u',
          join(process.cwd(), 'scripts', 'wsl-codex-turn.py').replace(/\\/g, '/')],
        { encoding: 'utf8', timeout: 10_000 });
        expect(script.status, script.stderr).toBe(0);
        const launched = o.startExperimentalWslCodexGeneration(CORE, ticket.claimId, ticket.dispatchId!,
          ['src/publish.js', 'tests/publish.test.mjs'], ['/usr/bin/python3', script.stdout.trim(), '--source', stage.source,
            '--manifest', stage.manifest, '--claim', ticket.claimId, '--generation', ticket.dispatchId!,
            '--proposal-path', 'src/publish.js', '--proposal-path', 'tests/publish.test.mjs',
            '--review-prompt', 'Independently review the proposed files as a separate read-only reviewer. Return only this JSON object: {"verdict":"PASS"}.',
            '--prompt', 'Respond only with this JSON object, no markdown: {"src/publish.js":"JOB_RESULT_V2\\n","tests/publish.test.mjs":"import assert from \'node:assert/strict\';\\nassert.ok(true);\\n"}']);
        expect(launched.claim).toBe(ticket.claimId);
        let outcome: { exit_code: number; revoked: boolean } | undefined;
        for (let i = 0; i < 100 && !outcome; i++) {
          try { outcome = wslCodexProcessResult(p.featureDir, ticket.claimId, ticket.dispatchId!); }
          catch { await new Promise(resolve => setTimeout(resolve, 750)); }
        }
        expect(outcome).toEqual({ exit_code: 0, revoked: false });
        const transport = `/var/lib/mycelink-codex/transport/${ticket.claimId}/${ticket.dispatchId}/worker.json`;
        const published = spawnSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'root', '--', 'python3', '-c',
          'import json,sys; x=json.load(open(sys.argv[1])); print(json.dumps({"claim":x["claim"],"generation":x["generation"],"events":x["submission"]["events"],"status":x["submission"]["status"],"proposals":x["proposals"]}))', transport],
        { encoding: 'utf8', timeout: 10_000 });
        expect(published.status, published.stderr).toBe(0);
        expect(JSON.parse(published.stdout)).toMatchObject({ claim: ticket.claimId,
          generation: ticket.dispatchId, status: '0', events: expect.arrayContaining(['turn.completed']),
          proposals: { 'src/publish.js': 'JOB_RESULT_V2\n',
            'tests/publish.test.mjs': "import assert from 'node:assert/strict';\nassert.ok(true);\n" } });
        const configFile = join(p.control, 'mycelink.config.json');
        const configured = readFileSync(configFile);
        rmSync(configFile); // a missing host fence self-test cannot seal even a completed model turn
        try {
          expect(() => o.sealExperimentalWslCodexWorker(CORE, ticket.claimId, ticket.dispatchId!, ['src/publish.js', 'tests/publish.test.mjs']))
            .toThrow(/WSL_CODEX_BROKER_DENIED/);
        } finally {
          writeFileSync(configFile, configured);
        }
        expect(() => o.sealExperimentalWslCodexReviewer(CORE, ticket.claimId, ticket.dispatchId!, ['src/publish.js', 'tests/publish.test.mjs']))
          .toThrow(/WSL_CODEX_BROKER_DENIED/);
        const seal = o.sealExperimentalWslCodexWorker(CORE, ticket.claimId, ticket.dispatchId!, ['src/publish.js', 'tests/publish.test.mjs']);
        expect(seal).toMatchObject({ claim: ticket.claimId, generation: ticket.dispatchId!,
          role: 'worker', sha256: { 'src/publish.js': createHash('sha256').update('JOB_RESULT_V2\n').digest('hex') } });
        const review = o.sealExperimentalWslCodexReviewer(CORE, ticket.claimId, ticket.dispatchId!, ['src/publish.js', 'tests/publish.test.mjs']);
        expect(review).toMatchObject({ claim: ticket.claimId, generation: ticket.dispatchId!, role: 'reviewer' });
        expect(review.submission_sha256).not.toBe(seal.submission_sha256);
        const verified = o.readExperimentalWslCodexSealedTurn(CORE, ticket.claimId, ticket.dispatchId!,
          ['src/publish.js', 'tests/publish.test.mjs']);
        expect(verified.proposals).toEqual({ 'src/publish.js': 'JOB_RESULT_V2\n',
          'tests/publish.test.mjs': "import assert from 'node:assert/strict';\nassert.ok(true);\n" });
        expect(verified.reviewer.verdict).toBe('PASS');
        expect(loadState(p.featureDir)!.data.nodes[CORE]!.state).not.toBe('DONE');
      } finally {
        stage.dispose();
      }
    }, 150_000);
  it.skipIf(process.platform !== 'win32' || process.env['MYCELINK_LIVE_WSL_CODEX_AUTH'] !== '1')(
    'revokes the registered model and scoped bridge before host cancellation succeeds', async () => {
      const { p, o } = await fixture();
      const ticket = o.claim(CORE, { mode: 'host' });
      enableCodexLifecycle(p.featureDir);
      const stage = o.stageExperimentalWslCodexClaimSource(CORE, ticket.claimId, ticket.dispatchId!, ['src/publish.js']);
      try {
        const runtimeNames = () => {
          const check = spawnSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'root', '--', 'python3', '-c',
            'from pathlib import Path; print("\\n".join(sorted(p.name for p in Path("/var/lib/mycelink-codex/claims").glob("turn-*"))))'],
          { encoding: 'utf8', timeout: 10_000 });
          expect(check.status, check.stderr).toBe(0);
          return check.stdout.trim();
        };
        const before = runtimeNames();
        const script = spawnSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'root', '--', 'wslpath', '-u',
          join(process.cwd(), 'scripts', 'wsl-codex-turn.py').replace(/\\/g, '/')],
        { encoding: 'utf8', timeout: 10_000 });
        expect(script.status, script.stderr).toBe(0);
        const launched = o.startExperimentalWslCodexGeneration(CORE, ticket.claimId, ticket.dispatchId!,
          ['src/publish.js'], ['/usr/bin/python3', script.stdout.trim(), '--source', stage.source,
            '--manifest', stage.manifest, '--claim', ticket.claimId, '--generation', ticket.dispatchId!,
            '--prompt', 'Inspect all files in this repository and provide a long detailed explanation.']);
        // Root-only pending transport is created only after bridge readiness
        // and the worker's SO_PEERCRED/claim identity check have succeeded.
        const pending = `/var/lib/mycelink-codex/transport/${ticket.claimId}/${ticket.dispatchId}/worker.pending`;
        let observed = false;
        for (let i = 0; i < 60 && !observed; i++) {
          observed = spawnSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'root', '--', 'test', '-f', pending],
            { timeout: 10_000 }).status === 0;
          if (!observed) await new Promise(resolve => setTimeout(resolve, 100));
        }
        expect(observed, 'isolated worker never verified the scoped bridge').toBe(true);
        const io: CliIo = { out: () => undefined, err: (message) => { throw new Error(message); } };
        expect(await main([...asController(['feature', 'cancel', FEATURE_ID], p.control), '--control-root', p.control], io)).toBe(0);
        expect(wslCodexProcessResult(p.featureDir, ticket.claimId, ticket.dispatchId!)).toEqual({ exit_code: 1, revoked: true });
        const members = spawnSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'root', '--', 'python3', '-c',
          'from pathlib import Path; import sys; pgid=int(sys.argv[1]); print("\\n".join(p.name for p in Path("/proc").iterdir() if p.name.isdigit() and (lambda f: f[0]!="Z" and int(f[2])==pgid)( (p/"stat").read_text().rsplit(")",1)[1].strip().split() )))', String(launched.pgid)],
        { encoding: 'utf8', timeout: 10_000 });
        expect(members.status, members.stderr).toBe(0);
        expect(members.stdout.trim()).toBe('');
        expect(runtimeNames(), 'revocation leaked the private API bridge runtime').toBe(before);
        expect(loadState(p.featureDir)!.data.feature_state).toBe('CANCELLED');
      } finally {
        stage.dispose();
      }
    }, 90_000);
  it.skipIf(process.platform !== 'win32' || process.env['MYCELINK_LIVE_WSL_WORKER'] !== '1')(
    'reads only root-attested supervisor exit status after a registered turn', async () => {
      const { p } = await fixture();
      const claim = 'probe-' + createHash('sha256').update(p.featureDir).digest('hex').slice(0, 16);
      const generation = 'generation1';
      startExperimentalWslProcess(p.featureDir, claim, generation, ['/bin/sh', '-c', 'exit 23']);
      let outcome: { exit_code: number; revoked: boolean } | undefined;
      for (let i = 0; i < 25 && !outcome; i++) {
        try { outcome = wslCodexProcessResult(p.featureDir, claim, generation); }
        catch { await new Promise(resolve => setTimeout(resolve, 50)); }
      }
      expect(outcome).toEqual({ exit_code: 23, revoked: false });
      expect(wslCodexProcessResult(p.featureDir, claim, generation)).toEqual(outcome);
    }, 40_000,
  );
  it.skipIf(process.platform !== 'win32' || process.env['MYCELINK_LIVE_WSL_WORKER'] !== '1')(
    'refuses host settlement after a registered command exits nonzero', async () => {
      const { p, o } = await fixture();
      const ticket = o.claim(CORE, { mode: 'host' });
      enableCodexLifecycle(p.featureDir);
      o.startExperimentalWslCodexGeneration(CORE, ticket.claimId, ticket.dispatchId!,
        ['src/new.ts'], ['/bin/sh', '-c', 'exit 19']);
      for (let i = 0; i < 25; i++) {
        try { wslCodexProcessResult(p.featureDir, ticket.claimId, ticket.dispatchId!); break; }
        catch { await new Promise(resolve => setTimeout(resolve, 50)); }
      }
      expect(wslCodexProcessResult(p.featureDir, ticket.claimId, ticket.dispatchId!)).toEqual({ exit_code: 19, revoked: false });
      expect(() => o.settle(CORE, ticket.capability)).toThrow(/WSL_CODEX_WORKER_FAILED/);
      expect(() => o.completeSettlement(CORE, 'resume')).toThrow(/WSL_CODEX_WORKER_FAILED/);
      expect(loadState(p.featureDir)!.data.nodes[CORE]!.state).not.toBe('DONE');
    }, 40_000,
  );
  it.skipIf(process.platform !== 'win32' || process.env['MYCELINK_LIVE_WSL_WORKER'] !== '1')(
    'stages immutable Git source only while the live claim mutex is held and refuses a revoked claim', async () => {
      const { p, o } = await fixture();
      const ticket = o.claim(CORE, { mode: 'host' });
      enableCodexLifecycle(p.featureDir);
      const lease = o.stageExperimentalWslCodexClaimSource(CORE, ticket.claimId, ticket.dispatchId!, ['src/publish.js']);
      try {
        const immutable = readFileSync(join(ticket.worktree!, 'tests', 'run.mjs'));
        expect(lease.hashes['tests/run.mjs']).toBe(createHash('sha256').update(immutable).digest('hex'));
        const io: CliIo = { out: () => undefined, err: (text) => { throw new Error(text); } };
        expect(await main([...asController(['feature', 'cancel', FEATURE_ID], p.control), '--control-root', p.control], io)).toBe(0);
        expect(() => o.stageExperimentalWslCodexClaimSource(CORE, ticket.claimId, ticket.dispatchId!, ['src/publish.js']))
          .toThrow(/WSL_CLAIM_STALE/);
      } finally {
        lease.dispose();
      }
    }, 40_000);
  it('derives exact allowed names only from a live host claim and graph policy', async () => {
    const { p, o } = await fixture();
    const claimed = o.claim(CORE, { mode: 'host' });
    const generation = claimed.dispatchId!;
    expect(o.inspectWslCodexClaim(CORE, claimed.claimId, generation, ['tests/new.test.ts', 'src/new.ts']))
      .toMatchObject({ claim: claimed.claimId, generation, worktree: claimed.worktree,
        allowed_paths: ['src/new.ts', 'tests/new.test.ts'], base_sha: expect.stringMatching(/^[a-f0-9]{40}$/) });
    expect(loadState(p.featureDir)!.data.nodes[CORE]!.claim?.claim_id).toBe(claimed.claimId);
    expect(() => o.inspectWslCodexClaim(CORE, 'forged', generation, ['src/new.ts'])).toThrow(/WSL_CLAIM_STALE/);
    expect(() => o.inspectWslCodexClaim(CORE, claimed.claimId, 'stale', ['src/new.ts'])).toThrow(/WSL_CLAIM_STALE/);
    expect(() => o.inspectWslCodexClaim(CORE, claimed.claimId, generation, ['forbidden/data.txt'])).toThrow(/OWNERSHIP_VIOLATION/);
  });

  it('rejects an expired claim before furnishing any WSL grant', async () => {
    const { p, o } = await fixture();
    const claimed = o.claim(CORE, { mode: 'host' });
    mutateState(p.featureDir, (state) => {
      state.nodes[CORE]!.claim!.expires_at = '2000-01-01T00:00:00.000Z';
      return state;
    });
    expect(() => o.inspectWslCodexClaim(CORE, claimed.claimId, claimed.dispatchId!, ['src/new.ts']))
      .toThrow(/WSL_CLAIM_STALE/);
  });

  it('refuses a settling or cancelled claim even when its id and lease still match', async () => {
    const { p, o } = await fixture();
    const claimed = o.claim(CORE, { mode: 'host' });
    mutateState(p.featureDir, (state) => {
      state.feature_state = 'CANCELLED';
      return state;
    });
    expect(() => o.inspectWslCodexClaim(CORE, claimed.claimId, claimed.dispatchId!, ['src/new.ts']))
      .toThrow(/WSL_CLAIM_STALE/);
  });

  it.skipIf(process.platform !== 'win32' || process.env['MYCELINK_LIVE_WSL_WORKER'] !== '1')(
    'a controller cancellation kills a registered WSL generation, not only its Windows shell', async () => {
      const { p, o } = await fixture();
      const claimed = o.claim(CORE, { mode: 'host' });
      enableCodexLifecycle(p.featureDir);
      const token = createHash('sha256').update(realpathSync(p.featureDir).replace(/\\/g, '/').toLowerCase()).digest('hex');
      const script = join(process.cwd(), 'scripts', 'wsl-codex-process.py');
      const linuxScript = spawnSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'root', '--', 'wslpath', '-u', script.replace(/\\/g, '/')],
        { encoding: 'utf8', timeout: 10_000 });
      expect(linuxScript.status, linuxScript.stderr).toBe(0);
      const wslScript = linuxScript.stdout.trim();
      const processInWsl = spawn('wsl.exe', ['-d', 'Ubuntu', '-u', 'root', '--', 'python3', wslScript,
        'run', token, claimed.claimId, claimed.dispatchId!, '--', '/bin/sleep', '60'], { stdio: ['ignore', 'pipe', 'pipe'] });
      try {
        const ready = await new Promise<{ pid: number }>((resolveReady, reject) => {
          const timeout = setTimeout(() => reject(new Error('WSL process registration timed out')), 15_000);
          processInWsl.stdout.once('data', (buffer: Buffer) => {
            clearTimeout(timeout);
            try { resolveReady(JSON.parse(buffer.toString('utf8')) as { pid: number }); }
            catch (err) { reject(err); }
          });
          processInWsl.once('error', reject);
        });
        expect(ready.pid).toBeGreaterThan(1);
        expect(spawnSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'root', '--', 'test', '-e', `/proc/${ready.pid}`],
          { timeout: 10_000 }).status).toBe(0);
        const io: CliIo = { out: () => undefined, err: (text) => { throw new Error(text); } };
        expect(await main([...asController(['feature', 'cancel', FEATURE_ID, '--control-root', p.control], p.control)], io)).toBe(0);
        expect(loadState(p.featureDir)!.data.feature_state).toBe('CANCELLED');
        expect(spawnSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'root', '--', 'test', '-e', `/proc/${ready.pid}`],
          { timeout: 10_000 }).status).not.toBe(0);
        expect(() => o.inspectWslCodexClaim(CORE, claimed.claimId, claimed.dispatchId!, ['src/new.ts']))
          .toThrow(/WSL_CLAIM_STALE/);
      } finally {
        spawnSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'root', '--', 'python3', wslScript, 'revoke', token],
          { timeout: 10_000 });
        processInWsl.kill();
      }
    }, 45_000,
  );
  it.skipIf(process.platform !== 'win32' || process.env['MYCELINK_LIVE_WSL_WORKER'] !== '1')(
    'binds a real host claim to registered WSL readiness under the lifecycle mutex before cancellation', async () => {
      const { p, o } = await fixture();
      const claimed = o.claim(CORE, { mode: 'host' });
      enableCodexLifecycle(p.featureDir);
      const grant = o.startExperimentalWslCodexGeneration(CORE, claimed.claimId, claimed.dispatchId!,
        ['src/new.ts'], ['/bin/sleep', '60']);
      expect(grant).toMatchObject({ claim: claimed.claimId, generation: claimed.dispatchId,
        pid: expect.any(Number) });
      const io: CliIo = { out: () => undefined, err: (text) => { throw new Error(text); } };
      expect(await main([...asController(['feature', 'cancel', FEATURE_ID, '--control-root', p.control], p.control)], io)).toBe(0);
      expect(loadState(p.featureDir)!.data.feature_state).toBe('CANCELLED');
      expect(() => o.startExperimentalWslCodexGeneration(CORE, claimed.claimId, claimed.dispatchId!,
        ['src/new.ts'], ['/bin/sleep', '60'])).toThrow(/WSL_CLAIM_STALE/);
    }, 45_000,
  );
  it.skipIf(process.platform !== 'win32' || process.env['MYCELINK_LIVE_WSL_WORKER'] !== '1')(
    'revokes the Linux worker before a host dispatch resume can rotate its ticket', async () => {
      const { p, o } = await fixture();
      const claimed = o.claim(CORE, { mode: 'host' });
      enableCodexLifecycle(p.featureDir);
      const grant = o.startExperimentalWslCodexGeneration(CORE, claimed.claimId, claimed.dispatchId!,
        ['src/new.ts'], ['/bin/sleep', '60']);
      const token = createHash('sha256').update(realpathSync(p.featureDir).replace(/\\/g, '/').toLowerCase()).digest('hex');
      const linuxScript = spawnSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'root', '--', 'wslpath', '-u',
        join(process.cwd(), 'scripts', 'wsl-codex-process.py').replace(/\\/g, '/')], { encoding: 'utf8', timeout: 10_000 });
      try {
        expect(spawnSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'root', '--', 'test', '-e', `/proc/${grant.pid}`],
          { timeout: 10_000 }).status).toBe(0);
        o.resumeDispatch(CORE);
        expect(spawnSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'root', '--', 'test', '-e', `/proc/${grant.pid}`],
          { timeout: 10_000 }).status).not.toBe(0);
      } finally {
        spawnSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'root', '--', 'python3', linuxScript.stdout.trim(), 'revoke', token],
          { timeout: 10_000 });
      }
    }, 45_000,
  );
  it.skipIf(process.platform !== 'win32' || process.env['MYCELINK_LIVE_WSL_WORKER'] !== '1')(
    'refuses settlement while the registered Linux worker still runs', async () => {
      const { p, o } = await fixture();
      const claimed = o.claim(CORE, { mode: 'host' });
      enableCodexLifecycle(p.featureDir);
      o.startExperimentalWslCodexGeneration(CORE, claimed.claimId, claimed.dispatchId!,
        ['src/new.ts'], ['/bin/sleep', '60']);
      try {
        expect(() => o.settle(CORE, claimed.capability)).toThrow(/WSL_CODEX_WORKER_ACTIVE/);
        expect(() => o.completeSettlement(CORE, 'resume')).toThrow(/WSL_CODEX_WORKER_ACTIVE/);
        expect(loadState(p.featureDir)!.data.nodes[CORE]!.claim?.dispatch_id).toBe(claimed.dispatchId);
      } finally {
        const io: CliIo = { out: () => undefined, err: (text) => { throw new Error(text); } };
        await main([...asController(['feature', 'cancel', FEATURE_ID, '--control-root', p.control], p.control)], io);
      }
    }, 40_000,
  );
  it.skipIf(process.platform !== 'win32' || process.env['MYCELINK_LIVE_WSL_WORKER'] !== '1')(
    'does not report cancellation or mutate the claim when WSL revocation cannot be proven', async () => {
      const { p, o } = await fixture();
      const claimed = o.claim(CORE, { mode: 'host' });
      enableCodexLifecycle(p.featureDir);
      const token = createHash('sha256').update(realpathSync(p.featureDir).replace(/\\/g, '/').toLowerCase()).digest('hex');
      const code = 'from pathlib import Path; import os; p=Path("/var/lib/mycelink-codex/processes")/os.environ["TOKEN"]; p.mkdir(parents=True, exist_ok=True, mode=0o700); (p/"forged.json").write_text("{}")';
      const created = spawnSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'root', '--', 'env', `TOKEN=${token}`, 'python3', '-c', code],
        { timeout: 10_000, encoding: 'utf8' });
      expect(created.status, created.stderr).toBe(0);
      try {
        let error = '';
        const io: CliIo = { out: () => undefined, err: (text) => { error += text; } };
        expect(await main([...asController(['feature', 'cancel', FEATURE_ID, '--control-root', p.control], p.control)], io)).not.toBe(0);
        expect(error).toMatch(/WSL_CODEX_REVOKE_UNCONFIRMED/);
        expect(loadState(p.featureDir)!.data.feature_state).not.toBe('CANCELLED');
        expect(loadState(p.featureDir)!.data.nodes[CORE]!.claim?.dispatch_id).toBe(claimed.dispatchId);
      } finally {
        const cleanup = 'from pathlib import Path; import os; p=Path("/var/lib/mycelink-codex/processes")/os.environ["TOKEN"]; (p/"forged.json").unlink(); (p/".lock").unlink(); p.rmdir()';
        spawnSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'root', '--', 'env', `TOKEN=${token}`, 'python3', '-c', cleanup],
          { timeout: 10_000 });
      }
    }, 30_000,
  );
  it.skipIf(process.platform !== 'win32' || process.env['MYCELINK_LIVE_WSL_WORKER'] !== '1')(
    'crosses the real host claim/worktree into isolated WSL transport and sealed broker', async () => {
      const { p, o } = await fixture();
      const claimed = o.claim(CORE, { mode: 'host' });
      enableCodexLifecycle(p.featureDir);
      const bound = o.inspectWslCodexClaim(CORE, claimed.claimId, claimed.dispatchId!, ['src/publish.js']);
      const wslPath = (path: string): string => {
        const result = spawnSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'root', '--', 'wslpath', '-u', path.replace(/\\/g, '/')],
          { encoding: 'utf8', timeout: 10_000 });
        expect(result.status, result.stderr).toBe(0);
        return result.stdout.trim();
      };
      const stage = o.stageExperimentalWslCodexClaimSource(CORE, claimed.claimId, claimed.dispatchId!, ['src/publish.js']);
      const digest = stage.hashes['tests/run.mjs']!;
      // A later hostile DrvFS edit cannot change what the isolated worker sees.
      writeFileSync(join(bound.worktree, 'tests', 'run.mjs'), 'throw new Error("mutable host bytes");\n');
      const script = join(process.cwd(), 'tests', 'spike', 'wsl-real-claim-boundary.py');
      try {
        const launched = o.withLiveWslCodexClaim(CORE, claimed.claimId, claimed.dispatchId!, ['src/publish.js'], (grant) => {
          expect(grant.allowed_paths).toEqual(['src/publish.js']);
          expect(readFileSync(codexLifecycleLockPath(p.featureDir), 'utf8')).toContain(`"pid":${process.pid}`);
          return spawnSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'root', '--', 'env',
            'MYCELINK_LIVE_WSL_WORKER=1', 'python3', wslPath(script), '--source', stage.source,
            '--claim', bound.claim, '--generation', bound.generation, '--expected-sha256', digest],
          { encoding: 'utf8', timeout: 45_000 });
        });
        expect(launched.status, launched.stderr).toBe(0);
        expect(JSON.parse(launched.stdout)).toMatchObject({ claim: bound.claim,
          generation: bound.generation, sealed: true, source_unchanged: true });
        expect(o.inspectWslCodexClaim(CORE, claimed.claimId, claimed.dispatchId!, ['src/publish.js']))
          .toMatchObject({ claim: bound.claim, generation: bound.generation });
      } finally {
        stage.dispose();
      }
    },
  );
});
