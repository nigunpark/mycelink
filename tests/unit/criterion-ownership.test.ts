/**
 * Criterion ownership: a product producer serves every criterion; a
 * verification node may prove one too, never alone.
 *
 * CSET-203 r3 with-normal: the planner gave AC-5 (compatibility: "`changeset
 * status` and `changeset add` are unaffected by a journal") to the
 * verification node `compat.verify` alone. The acceptance reviewer found
 * public GAPs on AC-1, AC-3 and AC-5 before any candidate; AC-5's gap had no
 * product node to rework (a verification node changes nothing), so the
 * review settled REVIEW_GAPS and abandoned the reworks AC-1 and AC-3 needed
 * too. A gap must always have a producer to go to: the graph says so now.
 *
 *  - every criterion is served by at least one product producer (a node with
 *    a repository that is not run by the controller): CRITERION_NO_PRODUCER;
 *  - a verification node's criterion, whatever its kind, is also a criterion
 *    of a producer it depends on: VERIFICATION_CRITERION_UNOWNED.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateGraph } from '../../src/graph/validate.js';

const R3 = join(process.cwd(), 'tests', 'benchmark', 'fixtures', 'cset203-r3', 'PORTFOLIO-GRAPH.json');
const CLI = 'CSET-203.cli.recovery-failure.impl';
const VERIFY = 'CSET-203.changesets.compat.verify';

type Graph = { acceptance_criteria: { id: string; kind?: string; text: string }[]; nodes: Record<string, any>[]; [k: string]: unknown };
const r3 = (): Graph => JSON.parse(readFileSync(R3, 'utf8')) as Graph;
const node = (g: Graph, id: string): Record<string, any> => g.nodes.find((n) => n['id'] === id) as Record<string, any>;

describe("CSET-203 r3's graph: AC-5 owned by a verification node alone", () => {
  it('is refused: no product node serves AC-5, and the verification node is its only owner', () => {
    const result = validateGraph(r3());
    expect(result.ok).toBe(false);
    expect(result.problems.map((p) => p.code).sort()).toEqual(['CRITERION_NO_PRODUCER', 'VERIFICATION_CRITERION_UNOWNED']);
    const missing = result.problems.find((p) => p.code === 'CRITERION_NO_PRODUCER');
    expect(missing?.detail).toContain('AC-5');
    expect(missing?.detail).toContain(VERIFY);
    expect(missing?.detail).toMatch(/implementation/);
    const unowned = result.problems.find((p) => p.code === 'VERIFICATION_CRITERION_UNOWNED');
    expect(unowned?.detail).toMatch(new RegExp(`${VERIFY.replace(/\./g, '\\.')}" carries AC-5 \\(compatibility\\)`));
  });

  it('is accepted once the cli implementation produces AC-5 and the verification node proves it as well', () => {
    const g = r3();
    node(g, CLI)['acceptance_criteria'] = ['AC-3', 'AC-4', 'AC-5'];
    const result = validateGraph(g);
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('a producer that runs after the verification node does not own its criterion for it', () => {
    const g = r3();
    node(g, CLI)['acceptance_criteria'] = ['AC-3', 'AC-4'];
    g.nodes.push({ ...structuredClone(node(g, CLI)), id: 'CSET-203.cli.status-add.impl', depends_on: [VERIFY], allowed_paths: ['packages/cli/src/commands/status/**'], forbidden_paths: [], acceptance_criteria: ['AC-5'] });
    const codes = validateGraph(g).problems.map((p) => p.code);
    expect(codes).toContain('VERIFICATION_CRITERION_UNOWNED');
    expect(codes).not.toContain('CRITERION_NO_PRODUCER');
  });

  it('a criterion only a candidate build or an E2E scenario names has no producer either', () => {
    const g = r3();
    node(g, CLI)['acceptance_criteria'] = ['AC-3', 'AC-4', 'AC-5'];
    g.acceptance_criteria.push({ id: 'AC-6', kind: 'new-behavior', text: 'the candidate reports its version' });
    node(g, 'CSET-203.release.candidate.build')['acceptance_criteria'] = ['AC-6'];
    expect(validateGraph(g).problems.map((p) => p.code)).toEqual(['CRITERION_NO_PRODUCER']);
  });

  it('a criterion no node names stays UNCOVERED_ACCEPTANCE_CRITERION alone', () => {
    const g = r3();
    node(g, CLI)['acceptance_criteria'] = ['AC-3', 'AC-4', 'AC-5'];
    g.acceptance_criteria.push({ id: 'AC-6', kind: 'new-behavior', text: 'nobody serves this' });
    expect(validateGraph(g).problems.map((p) => p.code)).toEqual(['UNCOVERED_ACCEPTANCE_CRITERION']);
  });
});
