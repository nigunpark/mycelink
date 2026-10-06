/**
 * Claims go through the scheduler and carry an unguessable capability.
 *
 * In the forced-activation eval the host session claimed nodes by hand,
 * bypassing readiness, and drove them with CLI primitives it was never meant
 * to hold (root cause A3). Now:
 *  - `node claim` claims only what the scheduler would offer, atomically;
 *  - the claim returns a random capability that only its hash is stored for;
 *  - worker-scoped mutations (tdd, evidence record, node begin) need it;
 *  - controller-only operations refuse anyone presenting one.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { FEATURE_ID, createPortfolio, portfolioGraph, writePrd, type Portfolio } from '../helpers/portfolio-fixture.js';
import { main, type CliIo } from '../../src/cli/cli.js';
import { loadState } from '../../src/state/feature-state.js';

afterAll(() => cleanupTmpRoots());

const CORE = `${FEATURE_ID}.core.publish.impl`;
const EXTRA = `${FEATURE_ID}.core.extra.impl`;
const API = `${FEATURE_ID}.api.consume.impl`;

interface Run {
  code: number;
  out: string;
  err: string;
}

async function cli(p: Portfolio, argv: string[], env: Record<string, string> = {}): Promise<Run> {
  let out = '';
  let err = '';
  const io: CliIo = { out: (t) => (out += t + '\n'), err: (t) => (err += t + '\n') };
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    const dd = argv.indexOf('--');
    const withRoot =
      dd === -1
        ? [...argv, '--control-root', p.control]
        : [...argv.slice(0, dd), '--control-root', p.control, ...argv.slice(dd)];
    const code = await main(withRoot, io);
    return { code, out, err };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function graphWithOverlap(): Record<string, unknown> {
  const g = portfolioGraph() as { nodes: Record<string, unknown>[] };
  const core = g.nodes[0] as Record<string, unknown>;
  g.nodes.splice(1, 0, { ...core, id: EXTRA, contract_outputs: [], allowed_paths: ['src/extra/**'] });
  return g;
}

async function setup(): Promise<Portfolio> {
  const p = createPortfolio();
  writePrd(p);
  writeFileSync(join(p.featureDir, 'PORTFOLIO-GRAPH.yaml'), YAML.stringify(graphWithOverlap(), { lineWidth: 0 }));
  const init = await cli(p, ['feature', 'init', FEATURE_ID]);
  expect(init.err).toBe('');
  return p;
}

async function claim(p: Portfolio, nodeId: string): Promise<{ capability: string; claimId: string; worktree: string }> {
  const r = await cli(p, ['node', 'claim', FEATURE_ID, nodeId, '--json']);
  expect(r.err).toBe('');
  expect(r.code).toBe(0);
  return JSON.parse(r.out) as { capability: string; claimId: string; worktree: string };
}

describe('claim authority', () => {
  let p: Portfolio;
  beforeEach(async () => {
    p = await setup();
  });

  it('refuses to claim a node whose dependencies are not DONE, without side effects', async () => {
    const r = await cli(p, ['node', 'claim', FEATURE_ID, API]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/NOT_SCHEDULABLE.*DEPENDENCIES_NOT_DONE/);
    expect(loadState(p.featureDir)!.data.nodes[API]!.state).toBe('PLANNED');
    expect(existsSync(join(p.control, '.mycelink', 'worktrees', `api__${API}`))).toBe(false);
  });

  it('returns a random capability and stores only its hash', async () => {
    const c = await claim(p, CORE);
    expect(c.capability).toMatch(/^[0-9a-f]{64}$/);
    const runtime = loadState(p.featureDir)!.data.nodes[CORE]!;
    expect(runtime.state).toBe('CLAIMED');
    expect(runtime.claim?.capability_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(runtime.claim?.capability_sha256).not.toBe(c.capability);
    for (const file of ['STATE.json', 'events.jsonl']) {
      expect(readFileSync(join(p.featureDir, file), 'utf8')).not.toContain(c.capability);
    }
  });

  it('refuses a second claim of the same node and does not count another attempt', async () => {
    await claim(p, CORE);
    const again = await cli(p, ['node', 'claim', FEATURE_ID, CORE]);
    expect(again.code).not.toBe(0);
    expect(again.err).toMatch(/NOT_SCHEDULABLE.*NOT_OFFERABLE/);
    expect(loadState(p.featureDir)!.data.nodes[CORE]!.attempts).toBe(1);
  });

  it('refuses a node overlapping an in-flight node in the same repository', async () => {
    const g = graphWithOverlap() as { nodes: Record<string, unknown>[] };
    (g.nodes[1] as Record<string, unknown>)['allowed_paths'] = ['src/**'];
    writeFileSync(join(p.featureDir, 'PORTFOLIO-GRAPH.yaml'), YAML.stringify(g, { lineWidth: 0 }));
    expect((await cli(p, ['feature', 'init', FEATURE_ID])).code).toBe(0);
    await claim(p, CORE);
    const r = await cli(p, ['node', 'claim', FEATURE_ID, EXTRA]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/PATH_OWNERSHIP_CONFLICT/);
  });

  it('tdd needs the claim capability; a missing or wrong one records nothing', async () => {
    const c = await claim(p, CORE);
    const none = await cli(p, ['tdd', 'red', FEATURE_ID, CORE]);
    expect(none.code).not.toBe(0);
    expect(none.err).toMatch(/CAPABILITY_REQUIRED/);
    const wrong = await cli(p, ['tdd', 'red', FEATURE_ID, CORE, '--capability', 'f'.repeat(64)]);
    expect(wrong.code).not.toBe(0);
    expect(wrong.err).toMatch(/CAPABILITY_INVALID/);
    expect(loadState(p.featureDir)!.data.nodes[CORE]!.evidence).toEqual({});

    const ok = await cli(p, ['tdd', 'red', FEATURE_ID, CORE, '--capability', c.capability, '--json']);
    expect(ok.err).toBe('');
    expect(ok.code).toBe(0);
    expect(loadState(p.featureDir)!.data.nodes[CORE]!.state).toBe('RED_VERIFIED');
  });

  it('the capability may also come from the worker environment', async () => {
    const c = await claim(p, CORE);
    const ok = await cli(p, ['tdd', 'red', FEATURE_ID, CORE], { MYCELINK_CLAIM_TOKEN: c.capability });
    expect(ok.code).toBe(0);
  });

  it('tdd, evidence record and node begin refuse an unclaimed node', async () => {
    for (const argv of [
      ['tdd', 'red', FEATURE_ID, CORE],
      ['evidence', 'record', FEATURE_ID, CORE, '--kind', 'green', '--', 'node', '-e', '0'],
      ['node', 'begin', FEATURE_ID, CORE],
    ]) {
      const r = await cli(p, [...argv, '--capability', 'a'.repeat(64)]);
      expect(`${argv[0]}:${r.code}`).not.toBe(`${argv[0]}:0`);
      expect(r.err).toMatch(/NOT_CLAIMED/);
    }
  });

  it('re-checks the capability when evidence lands: a claim released mid-gate records nothing', async () => {
    const c = await claim(p, CORE);
    // The gate command itself cancels the feature, which releases the claim
    // while the command is still running.
    const r = await cli(p, [
      'tdd',
      'red',
      FEATURE_ID,
      CORE,
      '--capability',
      c.capability,
      '--',
      process.execPath,
      p.mycelink,
      'feature',
      'cancel',
      FEATURE_ID,
      '--control-root',
      p.control,
    ]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/NOT_CLAIMED|CAPABILITY_INVALID/);
    expect(loadState(p.featureDir)!.data.nodes[CORE]!.evidence).toEqual({});
  });

  it('a worker capability cannot run controller-only operations', async () => {
    const c = await claim(p, CORE);
    for (const argv of [
      ['candidate', 'create', FEATURE_ID],
      ['branch', 'integrate', FEATURE_ID, CORE],
      ['node', 'claim', FEATURE_ID, EXTRA],
      ['orchestrate', 'run', FEATURE_ID],
      ['decision', 'apply', FEATURE_ID, 'DEC-1'],
    ]) {
      const flagged = await cli(p, [...argv, '--capability', c.capability]);
      expect(`${argv.join(' ')}:${flagged.code}`).not.toBe(`${argv.join(' ')}:0`);
      expect(flagged.err).toMatch(/ROLE_DENIED/);
      const viaEnv = await cli(p, argv, { MYCELINK_CLAIM_TOKEN: c.capability });
      expect(viaEnv.err).toMatch(/ROLE_DENIED/);
    }
  });

  it('every other mutating controller command refuses a worker capability too', async () => {
    const c = await claim(p, CORE);
    for (const argv of [
      ['decision', 'record', FEATURE_ID, 'DEC-x', '--answer', 'yes'],
      ['resource', 'acquire', FEATURE_ID, 'full-runtime', '--node', 'x'],
      ['resource', 'release', FEATURE_ID, `node:${CORE}`],
      ['resource', 'recover', FEATURE_ID],
      ['e2e', 'run', FEATURE_ID],
      ['e2e', 'cleanup', FEATURE_ID],
      ['repo', 'register', '--name', 'x', '--path', '../x'],
      ['repo', 'lock', FEATURE_ID],
      ['graph', 'compile', FEATURE_ID, '--from', 'x.yaml'],
      ['branch', 'create', FEATURE_ID, EXTRA],
      ['session', 'reconcile', FEATURE_ID],
      ['evidence', 'migrate', FEATURE_ID],
    ]) {
      const r = await cli(p, [...argv, '--capability', c.capability]);
      expect(`${argv.slice(0, 2).join(' ')}: ${r.err.split('\n')[0]}`).toMatch(/: ROLE_DENIED/);
    }
  });

  it('controller primitives refuse to integrate or cut a candidate from unverified work', async () => {
    await claim(p, CORE);
    const integrate = await cli(p, ['branch', 'integrate', FEATURE_ID, CORE]);
    expect(integrate.code).not.toBe(0);
    expect(integrate.err).toMatch(/NODE_NOT_VERIFIED/);
    const candidate = await cli(p, ['candidate', 'create', FEATURE_ID]);
    expect(candidate.code).not.toBe(0);
    expect(candidate.err).toMatch(/NODES_NOT_DONE/);
  });
});
