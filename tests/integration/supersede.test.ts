/**
 * An explicitly superseded feature is history, never the delivered one.
 *
 * Rework keeps a repair in the same feature; when a feature is nevertheless
 * replaced by another, the relationship is explicit: `feature supersede
 * <old> --by <new>` records superseded_by in the old feature's STATE.json,
 * only for a quiescent feature (no claim, lease or live session), only to an
 * existing other feature, never in a cycle. A superseded feature does not
 * verify as complete and cannot be dispatched again.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { FEATURE_ID, commitControl, type Portfolio } from '../helpers/portfolio-fixture.js';
import { cli, cliRaw, dispatch, hostGraph, hostPortfolio } from '../helpers/host-loop.js';
import { loadState } from '../../src/state/feature-state.js';
import { readEvents } from '../../src/state/event-log.js';
import { featurePaths } from '../../src/workspace/paths.js';

afterAll(() => cleanupTmpRoots());

const NEXT = 'FEAT-902';

async function planNext(p: Portfolio): Promise<void> {
  const dir = join(p.control, 'features', NEXT);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'PRD.md'), `# ${NEXT}\n\n- AC-1: a.\n- AC-2: b.\n- AC-3: c.\n`);
  const g = JSON.parse(JSON.stringify(hostGraph()).replaceAll(FEATURE_ID, NEXT)) as Record<string, unknown>;
  writeFileSync(join(dir, 'PORTFOLIO-GRAPH.yaml'), YAML.stringify(g, { lineWidth: 0 }));
  const r = await cli(p, ['feature', 'init', NEXT]);
  expect(r.err).toBe('');
  commitControl(p, 'next feature');
}

describe('feature supersede', () => {
  it('records an explicit, audited superseded_by on a quiescent feature', async () => {
    const p = await hostPortfolio();
    await planNext(p);
    const worker = await cliRaw(p, ['feature', 'supersede', FEATURE_ID, '--by', NEXT, '--reason', 'replanned']);
    expect(worker.code).not.toBe(0);
    expect(worker.err).toMatch(/CONTROLLER_AUTHORITY/);

    const r = await cli(p, ['feature', 'supersede', FEATURE_ID, '--by', NEXT, '--reason', 'replanned as one graph', '--json']);
    expect(r.err).toBe('');
    const s = loadState(p.featureDir)!.data;
    expect(s.superseded_by).toBe(NEXT);
    expect(s.superseded_reason).toBe('replanned as one graph');
    expect(s.feature_state).toBe('CANCELLED');
    expect(readEvents(featurePaths(p.control, FEATURE_ID).events).some((e) => e.type === 'feature.superseded')).toBe(true);

    const v = await cli(p, ['feature', 'verify', FEATURE_ID, '--json']);
    expect(v.code).toBe(1);
    expect(v.out).toContain(`SUPERSEDED: by ${NEXT}`);
    expect((await dispatch(p)).status).toBe('CANCELLED');
    // Idempotent for the same target; another target is refused.
    expect((await cli(p, ['feature', 'supersede', FEATURE_ID, '--by', NEXT, '--reason', 'again'])).code).toBe(0);
    const cycle = await cli(p, ['feature', 'supersede', NEXT, '--by', FEATURE_ID, '--reason', 'cycle']);
    expect(cycle.err).toContain('SUPERSEDE_CYCLE');
  });

  it('refuses a feature with work in flight, a missing or identical target, and no reason', async () => {
    const p = await hostPortfolio();
    await planNext(p);
    expect((await cli(p, ['feature', 'supersede', FEATURE_ID, '--by', 'FEAT-999', '--reason', 'x'])).err).toContain('SUPERSEDING_FEATURE_MISSING');
    expect((await cli(p, ['feature', 'supersede', FEATURE_ID, '--by', FEATURE_ID, '--reason', 'x'])).err).toContain('SUPERSEDING_FEATURE_MISSING');
    expect((await cli(p, ['feature', 'supersede', FEATURE_ID, '--by', NEXT])).err).toContain('SUPERSEDE_REASON_REQUIRED');
    expect((await dispatch(p)).status).toBe('DISPATCHED');
    const busy = await cli(p, ['feature', 'supersede', FEATURE_ID, '--by', NEXT, '--reason', 'x']);
    expect(busy.err).toContain('FEATURE_NOT_QUIESCENT');
    expect(loadState(p.featureDir)!.data.superseded_by ?? null).toBeNull();
  });
});
