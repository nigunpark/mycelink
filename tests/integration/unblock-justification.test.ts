/**
 * Leaving BLOCKED needs a recorded decision, through every CLI route.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { FEATURE_ID, createPortfolio, portfolioGraph, writePrd, type Portfolio } from '../helpers/portfolio-fixture.js';
import { main, type CliIo } from '../../src/cli/cli.js';
import { loadState, mutateState } from '../../src/state/feature-state.js';
import { asController } from '../helpers/authority.js';

afterAll(() => cleanupTmpRoots());

const NODE = `${FEATURE_ID}.core.publish.impl`;
const DEPENDENT = `${FEATURE_ID}.api.consume.impl`;

async function cli(p: Portfolio, argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const io: CliIo = { out: (t) => (out += t + '\n'), err: (t) => (err += t + '\n') };
  const code = await main([...asController(argv, p.control), '--control-root', p.control], io);
  return { code, out, err };
}

describe('unblocking requires a recorded decision', () => {
  let p: Portfolio;
  beforeEach(async () => {
    p = createPortfolio();
    writePrd(p);
    writeFileSync(join(p.featureDir, 'PORTFOLIO-GRAPH.yaml'), YAML.stringify(portfolioGraph(), { lineWidth: 0 }));
    expect((await cli(p, ['feature', 'init', FEATURE_ID])).code).toBe(0);
    mutateState(p.featureDir, (s) => {
      const rt = s.nodes[NODE]!;
      rt.state = 'BLOCKED';
      rt.attempts = 2;
      rt.failure_counts = { 'fp-same': 2 };
      rt.last_failure_fingerprint = 'fp-same';
      rt.blocked_reason = 'Same failure fingerprint "fp-same" reached the limit of 2.';
      return s;
    });
  });

  it('node invalidate refuses a BLOCKED node without --decision', async () => {
    const r = await cli(p, ['node', 'invalidate', FEATURE_ID, NODE, '--reason', 'try again']);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/UNBLOCK_REQUIRES_JUSTIFICATION/);
    expect(loadState(p.featureDir)!.data.nodes[NODE]!.state).toBe('BLOCKED');
  });

  it('node invalidate refuses a decision id that was never recorded', async () => {
    const r = await cli(p, ['node', 'invalidate', FEATURE_ID, NODE, '--reason', 'x', '--decision', 'DEC-9']);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/DECISION_NOT_RECORDED/);
    expect(loadState(p.featureDir)!.data.nodes[NODE]!.state).toBe('BLOCKED');
  });

  it('a recorded decision lets it through, and the failure history survives', async () => {
    expect((await cli(p, ['decision', 'record', FEATURE_ID, 'DEC-9', '--answer', 'retry with v3'])).code).toBe(0);
    const r = await cli(p, ['node', 'invalidate', FEATURE_ID, NODE, '--reason', 'x', '--decision', 'DEC-9', '--json']);
    expect(r.code).toBe(0);
    const state = loadState(p.featureDir)!.data;
    expect(state.nodes[NODE]!.state).toBe('INVALIDATED');
    expect(state.nodes[NODE]!.failure_counts).toEqual({ 'fp-same': 2 });
    expect(state.nodes[NODE]!.attempts).toBe(2);
    expect(state.nodes[DEPENDENT]!.state).toBe('INVALIDATED');
  });

  it('feature init cannot wipe a feature that has progressed (re-init laundering)', async () => {
    const r = await cli(p, ['feature', 'init', FEATURE_ID]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/STATE_EXISTS/);
    expect(loadState(p.featureDir)!.data.nodes[NODE]!.state).toBe('BLOCKED');

    expect((await cli(p, ['decision', 'record', FEATURE_ID, 'DEC-reset', '--answer', 'start over'])).code).toBe(0);
    expect((await cli(p, ['feature', 'init', FEATURE_ID, '--decision', 'DEC-reset'])).code).toBe(0);
    expect(loadState(p.featureDir)!.data.nodes[NODE]!.state).toBe('PLANNED');
  });

  it('checkpoint restore is a controller operation', async () => {
    expect((await cli(p, ['checkpoint', 'create', FEATURE_ID])).code).toBe(0);
    const r = await cli(p, ['checkpoint', 'restore', FEATURE_ID, 'x.json', '--capability', 'a'.repeat(64)]);
    expect(r.err).toMatch(/ROLE_DENIED/);
  });

  it('decision apply refuses a decision that was never recorded', async () => {
    const r = await cli(p, ['decision', 'apply', FEATURE_ID, 'DEC-unrecorded']);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/DECISION_NOT_RECORDED/);
    expect(loadState(p.featureDir)!.data.nodes[NODE]!.state).toBe('BLOCKED');
  });
});
