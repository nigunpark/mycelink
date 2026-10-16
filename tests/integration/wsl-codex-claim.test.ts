import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
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
import { loadState, mutateState } from '../../src/state/feature-state.js';

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
      const { o } = await fixture();
      const claimed = o.claim(CORE, { mode: 'host' });
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
      const launched = spawnSync('wsl.exe', ['-d', 'Ubuntu', '-u', 'root', '--', 'env',
        'MYCELINK_LIVE_WSL_WORKER=1', 'python3', wslPath(script), '--source', wslPath(bound.worktree),
        '--claim', bound.claim, '--generation', bound.generation, '--expected-sha256', digest],
      { encoding: 'utf8', timeout: 45_000 });
      expect(launched.status, launched.stderr).toBe(0);
      expect(JSON.parse(launched.stdout)).toMatchObject({ claim: bound.claim,
        generation: bound.generation, sealed: true, source_unchanged: true });
      expect(o.inspectWslCodexClaim(CORE, claimed.claimId, claimed.dispatchId!, ['src/publish.js']))
        .toMatchObject({ claim: bound.claim, generation: bound.generation });
    },
  );
});
