import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { hostname } from 'node:os';
import { codexLifecycleLockPath, enableCodexLifecycle, withCodexLifecycleLock } from '../../src/state/codex-lifecycle.js';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import YAML from 'yaml';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { FEATURE_ID, createPortfolio, portfolioGraph, writePrd } from '../helpers/portfolio-fixture.js';
import { main, type CliIo } from '../../src/cli/cli.js';
import { asController } from '../helpers/authority.js';
import { Orchestrator } from '../../src/engine/orchestrator.js';
import { FakeInProcessAdapter } from '../../src/sessions/fake-adapter.js';
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
      const sourceFile = join(bound.worktree, 'tests', 'run.mjs');
      const digest = createHash('sha256').update(readFileSync(sourceFile)).digest('hex');
      const script = join(process.cwd(), 'tests', 'spike', 'wsl-real-claim-boundary.py');
      const launched = o.withLiveWslCodexClaim(CORE, claimed.claimId, claimed.dispatchId!, ['src/publish.js'], (grant) => {
        expect(grant.allowed_paths).toEqual(['src/publish.js']);
        expect(readFileSync(codexLifecycleLockPath(p.featureDir), 'utf8')).toContain(`"pid":${process.pid}`);
        return spawnSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'root', '--', 'env',
          'MYCELINK_LIVE_WSL_WORKER=1', 'python3', wslPath(script), '--source', wslPath(bound.worktree),
          '--claim', bound.claim, '--generation', bound.generation, '--expected-sha256', digest],
        { encoding: 'utf8', timeout: 45_000 });
      });
      expect(launched.status, launched.stderr).toBe(0);
      expect(JSON.parse(launched.stdout)).toMatchObject({ claim: bound.claim,
        generation: bound.generation, sealed: true, source_unchanged: true });
      expect(o.inspectWslCodexClaim(CORE, claimed.claimId, claimed.dispatchId!, ['src/publish.js']))
        .toMatchObject({ claim: bound.claim, generation: bound.generation });
    },
  );
});
