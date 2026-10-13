/**
 * Plan-source adapter boundary.
 *
 * The core consumes a validated portfolio graph and nothing else. Adapters
 * (ECC today; Jira, Linear or GitHub Issues later) only ever produce a DRAFT
 * graph for human review, through one registry and one CLI path, so adding an
 * adapter never touches graph, state or scheduling code.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import {
  getAdapter,
  listAdapters,
  registerAdapter,
  unregisterAdapter,
  UnknownAdapterError,
  type PlanSourceAdapter,
} from '../../src/adapters/registry.js';
import { main } from '../../src/cli/cli.js';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { clone, VALID_GRAPH, VALID_REPOSITORIES } from '../helpers/graph-fixtures.js';
import type { PortfolioGraph } from '../../src/model/types.js';
import { controllerArgv } from '../helpers/authority.js';

afterEach(() => cleanupTmpRoots());

const PRD = `---
status: APPROVED
feature_id: FEAT-101
---
# FEAT-101 Order status notifications

## Acceptance criteria

- AC-1: Core publishes an order-status event at the contracted version.
`;

const PLAN = `---
status: APPROVED
feature_id: FEAT-101
---
# Plan

## B-1 Publish order-status events

- repository: core
- capability: CAP-CORE-PUBLISH
- acceptance_criteria: AC-1
- files: src/publish/**, tests/publish/**
- red_target: node --test tests/publish
- green_target: node --test tests/publish
- regression: node --test
- evidence: red, green, regression
`;

function controlRoot(): string {
  const root = makeTmpDir('adapt-');
  writeFileSync(join(root, 'mycelink.config.json'), '{}\n');
  writeFileSync(join(root, 'repositories.yaml'), YAML.stringify(VALID_REPOSITORIES));
  mkdirSync(join(root, 'features'), { recursive: true });
  writeFileSync(join(root, 'PRD.md'), PRD);
  writeFileSync(join(root, 'PLAN.md'), PLAN);
  return root;
}

async function cli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(controllerArgv(argv), { out: (t) => out.push(t), err: (t) => err.push(t) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('adapter registry', () => {
  it('ships the ECC adapter, marked as validated against the documented shape only', () => {
    const ecc = listAdapters().find((a) => a.name === 'ecc');
    expect(ecc).toBeDefined();
    expect(ecc?.verification).toBe('documented-shape-only');
    expect(ecc?.inputs).toEqual(['prd', 'plan']);
  });

  it('reports an unknown adapter clearly', () => {
    expect(() => getAdapter('jira')).toThrow(UnknownAdapterError);
  });

  it('refuses a duplicate registration', () => {
    expect(() => registerAdapter(getAdapter('ecc'))).toThrow(/already registered/);
  });
});

describe('graph import (CLI)', () => {
  it('lists adapters', async () => {
    const r = await cli(['graph', 'adapters', '--json']);
    expect(r.code).toBe(0);
    expect((JSON.parse(r.out) as { adapters: { name: string }[] }).adapters.map((a) => a.name)).toContain('ecc');
  });

  it('writes a draft graph for review and never creates canonical state', async () => {
    const root = controlRoot();
    const r = await cli([
      'graph', 'import', 'FEAT-101', '--adapter', 'ecc',
      '--prd', join(root, 'PRD.md'), '--plan', join(root, 'PLAN.md'),
      '--control-root', root, '--json',
    ]);
    expect(r.code, r.err).toBe(0);
    const draft = join(root, 'features', 'FEAT-101', 'PORTFOLIO-GRAPH.draft.yaml');
    expect(existsSync(draft)).toBe(true);
    expect(readFileSync(draft, 'utf8')).toMatch(/^# DRAFT/);
    expect(existsSync(join(root, 'features', 'FEAT-101', 'PORTFOLIO-GRAPH.yaml'))).toBe(false);
    expect(existsSync(join(root, 'features', 'FEAT-101', 'STATE.json'))).toBe(false);
    expect((JSON.parse(r.out) as { requires_review: boolean }).requires_review).toBe(true);
  });

  it('refuses an unapproved source artifact', async () => {
    const root = controlRoot();
    writeFileSync(join(root, 'PRD.md'), PRD.replace('APPROVED', 'DRAFT'));
    const r = await cli([
      'graph', 'import', 'FEAT-101', '--adapter', 'ecc',
      '--prd', join(root, 'PRD.md'), '--plan', join(root, 'PLAN.md'), '--control-root', root,
    ]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/APPROVED|approv/i);
  });

  it('requires every input the adapter declares', async () => {
    const root = controlRoot();
    const r = await cli(['graph', 'import', 'FEAT-101', '--adapter', 'ecc', '--prd', join(root, 'PRD.md'), '--control-root', root]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/--plan/);
  });

  it('a third-party adapter plugs in through the same path without core changes', async () => {
    const fake: PlanSourceAdapter = {
      name: 'issue-tracker-test',
      description: 'test-only adapter',
      verification: 'tested',
      inputs: ['export'],
      draft: () => ({
        graph: clone(VALID_GRAPH) as unknown as PortfolioGraph,
        problems: [],
        requires_review: true,
        review_notes: ['generated in a test'],
      }),
    };
    registerAdapter(fake);
    try {
      const root = controlRoot();
      writeFileSync(join(root, 'export.json'), '{}');
      const r = await cli([
        'graph', 'import', 'FEAT-101', '--adapter', 'issue-tracker-test',
        '--export', join(root, 'export.json'), '--control-root', root,
      ]);
      expect(r.code, r.err).toBe(0);
      expect(existsSync(join(root, 'features', 'FEAT-101', 'PORTFOLIO-GRAPH.draft.yaml'))).toBe(true);
    } finally {
      unregisterAdapter('issue-tracker-test');
    }
  });
});
