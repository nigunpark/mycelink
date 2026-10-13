/**
 * A repair interrupted at any step is finished by the next run, exactly once
 * (engine/evidence-integrity.ts): its receipt, its pointer and its event.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { FEATURE_ID, type Portfolio } from '../helpers/portfolio-fixture.js';
import { CORE, cli, hostLoop, hostPortfolio } from '../helpers/host-loop.js';
import { canonicalPath, keepChallengeArchive, legacyOverwrite, recordOf } from '../helpers/legacy-evidence.js';
import { loadState } from '../../src/state/feature-state.js';
import { readEvents } from '../../src/state/event-log.js';
import { featurePaths } from '../../src/workspace/paths.js';
import { repairEvidence } from '../../src/engine/evidence-integrity.js';

afterAll(() => cleanupTmpRoots());

const state = (p: Portfolio) => loadState(p.featureDir)!.data;
const events = (p: Portfolio, type: string) => readEvents(featurePaths(p.control, FEATURE_ID).events, { includeRotated: true }).filter((e) => e.type === type);
async function deliver(p: Portfolio): Promise<{ out: Record<string, unknown> | null; err: string }> {
  const r = await cli(p, ['deliver', FEATURE_ID, '--json']);
  return { out: r.out.trim() ? (JSON.parse(r.out) as Record<string, unknown>) : null, err: r.err };
}

describe('evidence repair, interrupted', () => {
  let p: Portfolio;
  beforeEach(async () => {
    p = await hostPortfolio();
    expect((await hostLoop(p)).status).toBe('ALL_SETTLED');
  });

  it('a crash after the receipt, or after the state write, is finished by the next run, once', async () => {
    const kept = recordOf(p.control, FEATURE_ID, CORE);
    keepChallengeArchive(p.control, FEATURE_ID, CORE, kept);
    legacyOverwrite(p.control, FEATURE_ID, CORE, 'red', kept);
    expect(() => repairEvidence(p.control, FEATURE_ID, { fault: (at) => { if (at === 'receipt-written') throw new Error('killed'); } })).toThrow(/killed/);
    // Nothing points at the new copy yet: the record is as it was, and the copy is an unreferenced immutable artifact.
    expect(state(p).nodes[CORE]!.evidence.red!.output_path).toBe(canonicalPath(FEATURE_ID, CORE, 'red'));
    expect(state(p).evidence_repairs ?? []).toEqual([]);
    expect(() => repairEvidence(p.control, FEATURE_ID, { fault: (at) => { if (at === 'state-written') throw new Error('killed again'); } })).toThrow(/killed again/);
    expect(state(p).evidence_repairs).toHaveLength(1);
    expect(events(p, 'evidence.repaired')).toHaveLength(0);
    const done = repairEvidence(p.control, FEATURE_ID, {});
    expect(done.repaired).toEqual([]);
    expect(state(p).evidence_repairs).toHaveLength(1);
    expect(events(p, 'evidence.repaired')).toHaveLength(1);
    expect(readdirSync(join(featurePaths(p.control, FEATURE_ID).evidenceDir, 'repairs')).filter((n) => n.endsWith('.json'))).toHaveLength(1);
    expect((await deliver(p)).out).toMatchObject({ ok: true, status: 'ACCEPTED' });
  });

});
