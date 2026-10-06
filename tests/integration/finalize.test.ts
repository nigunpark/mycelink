/**
 * One settle/finalize path to DONE (root cause A4).
 *
 * The CLI gates stop at REGRESSION_VERIFIED and only the orchestrator's
 * in-process runNode could go further, so manually driven nodes were left
 * there forever. `node finalize` is the same deterministic tail runNode and
 * settle use: fresh verification on a clean checkout of the node branch,
 * gate advancement against recorded evidence, integration, DONE, release.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { git } from '../helpers/git-fixture.js';
import { FEATURE_ID, createPortfolio, portfolioGraph, writePrd, type Portfolio } from '../helpers/portfolio-fixture.js';
import { main, type CliIo } from '../../src/cli/cli.js';
import { loadState, mutateState } from '../../src/state/feature-state.js';
import { listLeases } from '../../src/resources/leases.js';
import { resolveRef } from '../../src/git/git.js';
import { integrationBranchName } from '../../src/git/worktree.js';
import { hostname } from 'node:os';
import { createHash } from 'node:crypto';

afterAll(() => cleanupTmpRoots());

const CORE = `${FEATURE_ID}.core.publish.impl`;
const IMPL = 'export const JOB_RESULT_V2 = true;\n';

async function cli(p: Portfolio, argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const io: CliIo = { out: (t) => (out += t + '\n'), err: (t) => (err += t + '\n') };
  const code = await main([...argv, '--control-root', p.control], io);
  return { code, out, err };
}

async function claimed(p: Portfolio): Promise<{ capability: string; worktree: string }> {
  const r = await cli(p, ['node', 'claim', FEATURE_ID, CORE, '--json']);
  expect(r.err).toBe('');
  return JSON.parse(r.out) as { capability: string; worktree: string };
}

async function gate(p: Portfolio, phase: string, capability: string): Promise<void> {
  const r = await cli(p, ['tdd', phase, FEATURE_ID, CORE, '--capability', capability]);
  expect(`${phase}:${r.code}:${r.err}`).toBe(`${phase}:0:`);
}

/** Real TDD in the claim worktree: RED, implement, commit, GREEN, regression. */
async function driveToRegression(p: Portfolio, commit = true): Promise<{ capability: string; worktree: string }> {
  const c = await claimed(p);
  await gate(p, 'red', c.capability);
  writeFileSync(join(c.worktree, 'src', 'publish.js'), IMPL);
  if (commit) {
    git(c.worktree, ['add', '-A']);
    git(c.worktree, ['commit', '-q', '-m', 'implement publish']);
  }
  await gate(p, 'green', c.capability);
  await gate(p, 'regression', c.capability);
  expect(loadState(p.featureDir)!.data.nodes[CORE]!.state).toBe('REGRESSION_VERIFIED');
  return c;
}

describe('node finalize', () => {
  let p: Portfolio;
  beforeEach(async () => {
    p = createPortfolio();
    writePrd(p);
    writeFileSync(join(p.featureDir, 'PORTFOLIO-GRAPH.yaml'), YAML.stringify(portfolioGraph(), { lineWidth: 0 }));
    expect((await cli(p, ['feature', 'init', FEATURE_ID])).code).toBe(0);
  });

  it('takes a manually driven node from REGRESSION_VERIFIED to DONE through fresh verification and integration', async () => {
    const c = await driveToRegression(p);
    const r = await cli(p, ['node', 'finalize', FEATURE_ID, CORE, '--capability', c.capability, '--json']);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const report = JSON.parse(r.out) as { outcome: string; state: string };
    expect(report).toMatchObject({ outcome: 'DONE', state: 'DONE' });

    const rt = loadState(p.featureDir)!.data.nodes[CORE]!;
    expect(rt.state).toBe('DONE');
    expect(rt.claim).toBeNull();
    // Fresh verification ran on a clean checkout and replaced the worker's GREEN.
    expect(rt.evidence.green?.output_path).toMatch(/fresh-/);
    expect(rt.integrated_sha).toBe(resolveRef(p.core, integrationBranchName(FEATURE_ID)));
    expect(listLeases(p.featureDir)).toEqual([]);
    expect(existsSync(c.worktree)).toBe(false);
  });

  it('refuses without the claim capability and leaves the node where it was', async () => {
    await driveToRegression(p);
    for (const extra of [[], ['--capability', 'e'.repeat(64)]]) {
      const r = await cli(p, ['node', 'finalize', FEATURE_ID, CORE, ...extra]);
      expect(r.code).not.toBe(0);
      expect(r.err).toMatch(/CAPABILITY_(REQUIRED|INVALID)/);
    }
    expect(loadState(p.featureDir)!.data.nodes[CORE]!.state).toBe('REGRESSION_VERIFIED');
  });

  it('does not believe uncommitted work: the clean checkout fails and the node is not DONE', async () => {
    const c = await driveToRegression(p, false);
    const r = await cli(p, ['node', 'finalize', FEATURE_ID, CORE, '--capability', c.capability, '--json']);
    expect(r.code).not.toBe(0);
    const report = JSON.parse(r.out) as { outcome: string; state: string };
    expect(report.outcome).toBe('VERIFICATION_FAILED');
    const rt = loadState(p.featureDir)!.data.nodes[CORE]!;
    expect(rt.state).not.toBe('DONE');
    expect(rt.state).not.toBe('REGRESSION_VERIFIED');
    expect(Object.keys(rt.failure_counts).length).toBe(1);
  });

  it('answers a repeated finalize from its receipt instead of running it again', async () => {
    const c = await driveToRegression(p);
    expect((await cli(p, ['node', 'finalize', FEATURE_ID, CORE, '--capability', c.capability])).code).toBe(0);
    const sha = resolveRef(p.core, integrationBranchName(FEATURE_ID));
    const again = await cli(p, ['node', 'finalize', FEATURE_ID, CORE, '--capability', c.capability, '--json']);
    expect(again.code).toBe(0);
    expect(JSON.parse(again.out)).toMatchObject({ outcome: 'DONE', idempotent: true });
    expect(resolveRef(p.core, integrationBranchName(FEATURE_ID))).toBe(sha);
  });

  it('completes a finalize that was interrupted after integration but before DONE', async () => {
    const c = await driveToRegression(p);
    expect((await cli(p, ['node', 'finalize', FEATURE_ID, CORE, '--capability', c.capability])).code).toBe(0);
    const done = loadState(p.featureDir)!.data.nodes[CORE]!;
    // Rewind to the crash point: integrated, claim still held, no receipt.
    mutateState(p.featureDir, (s) => {
      const rt = s.nodes[CORE]!;
      rt.state = 'INTEGRATED';
      rt.last_settlement = null;
      rt.claim = { claim_id: 'c-crash', owner: 'mycelink', worktree: null, branch: null, claimed_at: new Date().toISOString(), capability_sha256: createHash('sha256').update(c.capability).digest('hex'), mode: 'manual', attempt: 1, settling: null };
      return s;
    });
    const r = await cli(p, ['node', 'finalize', FEATURE_ID, CORE, '--capability', c.capability, '--json']);
    expect(r.err).toBe('');
    expect(JSON.parse(r.out)).toMatchObject({ outcome: 'DONE', state: 'DONE' });
    expect(loadState(p.featureDir)!.data.nodes[CORE]!.integrated_sha).toBe(done.integrated_sha);
  });

  it('refuses to run while another settle of the same claim is in progress', async () => {
    const c = await driveToRegression(p);
    mutateState(p.featureDir, (s) => {
      s.nodes[CORE]!.claim!.settling = { pid: process.pid, host: hostname(), started_at: new Date().toISOString() };
      return s;
    });
    const r = await cli(p, ['node', 'finalize', FEATURE_ID, CORE, '--capability', c.capability]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/SETTLE_IN_PROGRESS/);
    expect(loadState(p.featureDir)!.data.nodes[CORE]!.state).toBe('REGRESSION_VERIFIED');
  });
});
