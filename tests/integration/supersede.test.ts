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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { FEATURE_ID, commitControl, type Portfolio } from '../helpers/portfolio-fixture.js';
import { cli, cliRaw, dispatch, hostGraph, hostPortfolio } from '../helpers/host-loop.js';
import { loadState } from '../../src/state/feature-state.js';
import { readEvents } from '../../src/state/event-log.js';
import { featurePaths } from '../../src/workspace/paths.js';
import { acquireLock } from '../../src/state/process-lock.js';

afterAll(() => cleanupTmpRoots());

const NEXT = 'FEAT-902';
const THIRD = 'FEAT-903';

async function planNext(p: Portfolio, id: string = NEXT): Promise<void> {
  const dir = join(p.control, 'features', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'PRD.md'), `# ${id}\n\n- AC-1: a.\n- AC-2: b.\n- AC-3: c.\n`);
  const g = JSON.parse(JSON.stringify(hostGraph()).replaceAll(FEATURE_ID, id)) as Record<string, unknown>;
  writeFileSync(join(dir, 'PORTFOLIO-GRAPH.yaml'), YAML.stringify(g, { lineWidth: 0 }));
  const r = await cli(p, ['feature', 'init', id]);
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

  it('refuses a replacement that is itself superseded or cancelled', async () => {
    const p = await hostPortfolio();
    await planNext(p);
    await planNext(p, THIRD);
    // Superseded: history cannot replace anything.
    expect((await cli(p, ['feature', 'supersede', NEXT, '--by', THIRD, '--reason', 'replanned'])).code).toBe(0);
    const superseded = await cli(p, ['feature', 'supersede', FEATURE_ID, '--by', NEXT, '--reason', 'x']);
    expect(superseded.err).toContain('SUPERSEDING_FEATURE_NOT_VIABLE');
    // Cancelled: a stopped feature replaces nothing.
    expect((await cli(p, ['feature', 'cancel', THIRD, '--reason', 'dropped'])).code).toBe(0);
    const cancelled = await cli(p, ['feature', 'supersede', FEATURE_ID, '--by', THIRD, '--reason', 'x']);
    expect(cancelled.err).toContain('SUPERSEDING_FEATURE_NOT_VIABLE');
    expect(loadState(p.featureDir)!.data.superseded_by ?? null).toBeNull();
  });

  it('refuses a replacement whose graph no longer matches its state', async () => {
    const p = await hostPortfolio();
    await planNext(p);
    const file = join(p.control, 'features', NEXT, 'PORTFOLIO-GRAPH.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace('order-status event at the contracted version', 'something else entirely'));
    const r = await cli(p, ['feature', 'supersede', FEATURE_ID, '--by', NEXT, '--reason', 'x']);
    expect(r.err).toContain('SUPERSEDING_FEATURE_NOT_VIABLE');
    expect(loadState(p.featureDir)!.data.superseded_by ?? null).toBeNull();
  });

  it("holds the replacement's delivery lock too, so two supersedes cannot cross into a cycle", async () => {
    const p = await hostPortfolio();
    await planNext(p);
    const dir = join(p.control, 'features', NEXT, 'deliveries');
    mkdirSync(dir, { recursive: true });
    const lock = acquireLock(join(dir, 'deliver.lock'), { purpose: 'test: NEXT is being superseded' });
    let r;
    try {
      r = await cli(p, ['feature', 'supersede', FEATURE_ID, '--by', NEXT, '--reason', 'x']);
    } finally {
      lock.release();
    }
    expect(r.err).toContain('FEATURE_BUSY');
    expect(loadState(p.featureDir)!.data.superseded_by ?? null).toBeNull();
    expect((await cli(p, ['feature', 'supersede', FEATURE_ID, '--by', NEXT, '--reason', 'x'])).code).toBe(0);
  });
});
