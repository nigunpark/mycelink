/**
 * The generated workspace's structured criteria sidecar.
 *
 * CSET-202 r2's planner summarised the approved criteria into the graph and
 * planned AC-5 (compatibility) as new behaviour. Every benchmark workspace
 * now carries `platform/requirements/<PRD>.acceptance.json` beside the
 * requirement: each criterion's id, its kind from the case manifest, and its
 * exact text, cut verbatim — the same cut Mycelink makes
 * (src/engine/acceptance.ts), and a manifest Mycelink accepts as is.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../helpers/global-setup.js';
import { extractAcceptanceCriteria, manifestProblems } from '../../src/engine/acceptance.js';
// @ts-expect-error -- plain ESM module without type declarations
import { loadSuite } from '../../evals-public-projects/lib/manifests.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { acceptanceSidecar } from '../../evals-public-projects/lib/workspace.mjs';

const suite = loadSuite(join(REPO_ROOT, 'evals-public-projects'));
const prds = suite.projects.flatMap((p: any) => p.prds) as any[];

describe('the structured acceptance sidecar of every benchmark requirement', () => {
  it.each(prds.map((p) => [p.manifest.id, p]))('%s: the exact criteria with their kinds, a manifest Mycelink accepts', (_id, prd) => {
    const source = readFileSync(prd.requirementPath);
    const sidecar = acceptanceSidecar(prd);
    expect(manifestProblems(sidecar, { featureId: prd.manifest.id, source })).toEqual([]);
    expect(sidecar.criteria.map((c: { id: string; text: string }) => ({ id: c.id, text: c.text }))).toEqual(extractAcceptanceCriteria(source.toString('utf8')));
    expect(sidecar.criteria.map((c: { id: string; kind: string }) => [c.id, c.kind])).toEqual(prd.manifest.acceptance_criteria.map((a: { id: string; kind?: string }) => [a.id, a.kind ?? 'new-behavior']));
  });

  it('CSET-202: AC-5 is compatibility, its text exactly the requirement’s', () => {
    const sidecar = acceptanceSidecar(prds.find((p) => p.manifest.id === 'CSET-202'));
    expect(sidecar.criteria.find((c: { id: string }) => c.id === 'AC-5')).toMatchObject({
      kind: 'compatibility',
      text: '**AC-5 — compatibility.** For workspaces whose changesets are all valid,\neverything both commands print, write and return is byte-identical to today.',
    });
  });
});
