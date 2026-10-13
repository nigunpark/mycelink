/**
 * The RED-bound test files of a module-worker's claim, judged before a write
 * lands (hooks/fence.ts).
 *
 * CSET-203 r4: the cli's rework worker appended AC-5's regression test, after
 * the production code, to the test file AC-3's RED had bound. That changed
 * the RED's blob, and settle refused the whole history (CHANGED_RED_BLOBS),
 * an attempt spent on an ordering mistake. From its RED on, a test file a
 * red gate bound stays byte-identical once the production change has begun:
 * a compatibility test goes into a new test file, and a new test that belongs
 * in the bound file is a new complete RED cycle (`tdd cycle` declares it,
 * and the next accepted RED binds the file anew). Settle stays
 * authoritative: this refuses early only what settle would, and anything it
 * cannot read lets the write through.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadState } from '../state/feature-state.js';
import { productionSince, redBoundFiles, tddPolicyFor } from '../engine/tdd-history.js';

const fold = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p);

/**
 * Why a module-worker may not write `target` under the control repository
 * `root`, or null; `norm` normalises a path as the fence does (`target` is
 * normalised already).
 */
export function redBoundRefusal(root: string, target: string, norm: (path: string) => string): string | null {
  try {
    const features = join(root, 'features');
    if (!existsSync(features)) return null;
    for (const entry of readdirSync(features, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const featureDir = join(features, entry.name);
      if (!existsSync(join(featureDir, 'STATE.json'))) continue;
      const state = loadState(featureDir)?.data;
      if (!state) continue;
      for (const rt of Object.values(state.nodes)) {
        const claim = rt.claim;
        if (claim === null || claim.worktree === null) continue;
        const tree = norm(claim.worktree);
        if (!target.startsWith(`${tree}/`)) continue;
        const rel = target.slice(tree.length + 1);
        if (claim.cycle_declared) return null;
        const bindings = rt.tdd_red_bindings ?? [];
        const bound = redBoundFiles(bindings).find((t) => fold(t.path) === rel);
        const latest = bindings[bindings.length - 1];
        if (bound === undefined || latest === undefined) return null;
        const policy = claim.tdd_policy ?? tddPolicyFor(undefined);
        const production = productionSince(claim.worktree, policy, latest.head_sha);
        if (production.length === 0) return null;
        return (
          `Blocked: ${bound.path} is RED-bound: the red gate bound it at blob ${bound.blob.slice(0, 12)}, and the production change has begun (${production.slice(0, 3).join(', ')}${production.length > 3 ? ', ...' : ''}), ` +
          'so it stays byte-identical (settle refuses a changed RED as CHANGED_RED_BLOBS). Put a compatibility test in a new test file, alone, after the code. ' +
          'A new test that belongs in this file is a new complete RED cycle: declare it with tdd cycle (your red gate line with "tdd cycle" in place of "tdd red"), then change the file and run the red gate.'
        );
      }
    }
    return null;
  } catch {
    return null;
  }
}
