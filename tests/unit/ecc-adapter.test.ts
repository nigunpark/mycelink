import { describe, expect, it } from 'vitest';
import {
  EccApprovalError,
  compileDraftGraph,
  parsePlan,
  parsePrd,
} from '../../src/ecc/plan-adapter.js';
import { validateGraph } from '../../src/graph/validate.js';
import { VALID_REPOSITORIES } from '../helpers/graph-fixtures.js';

const PRD = `---
feature_id: FEAT-101
status: APPROVED
---

# FEAT-101 — Order status notifications

## Acceptance criteria

- AC-1: The core publishes a order-status event at the contracted version.
- AC-2: The API consumes that event and exposes the result.
`;

const PLAN = `---
feature_id: FEAT-101
status: APPROVED
---

# Plan

## B-1 Publish order-status events

- repository: core
- capability: CAP-CORE-PUBLISH
- acceptance_criteria: AC-1
- files: src/publish/**, tests/publish/**
- depends_on:
- contract_outputs: contracts/order-status.schema.json
- red_target: npm test -- publish
- green_target: npm test -- publish
- regression: npm test
- resources:
- evidence: red, green, regression

## B-2 Consume order-status events

- repository: api
- capability: CAP-API-CONSUME
- acceptance_criteria: AC-2
- files: src/jobs/**
- depends_on: B-1
- contract_inputs: contracts/order-status.schema.json
- red_target: python -m pytest tests/test_order_status.py
- green_target: python -m pytest tests/test_order_status.py
- regression: python -m pytest
- evidence: red, green, regression
`;

describe('ECC PRD adapter', () => {
  it('extracts the feature id, title and acceptance criteria', () => {
    const prd = parsePrd(PRD);
    expect(prd.feature_id).toBe('FEAT-101');
    expect(prd.title).toContain('Order status notifications');
    expect(prd.acceptance_criteria).toEqual([
      { id: 'AC-1', text: 'The core publishes a order-status event at the contracted version.' },
      { id: 'AC-2', text: 'The API consumes that event and exposes the result.' },
    ]);
  });

  it('refuses a PRD that has not been approved', () => {
    expect(() => parsePrd(PRD.replace('status: APPROVED', 'status: DRAFT'))).toThrow(
      EccApprovalError,
    );
  });

  it('refuses a PRD with no acceptance criteria', () => {
    const empty = `---\nfeature_id: FEAT-1\nstatus: APPROVED\n---\n\n# Title\n`;
    expect(() => parsePrd(empty)).toThrow(/acceptance criteri/i);
  });

  it('tolerates numbered and bulleted criteria lists', () => {
    const variant = PRD.replace('- AC-1:', '1. AC-1:').replace('- AC-2:', '* AC-2:');
    expect(parsePrd(variant).acceptance_criteria.map((a) => a.id)).toEqual(['AC-1', 'AC-2']);
  });
});

describe('ECC plan adapter', () => {
  it('extracts one behaviour per section with its real commands', () => {
    const plan = parsePlan(PLAN);
    expect(plan.feature_id).toBe('FEAT-101');
    expect(plan.behaviours).toHaveLength(2);

    const b1 = plan.behaviours[0];
    expect(b1?.id).toBe('B-1');
    expect(b1?.repository).toBe('core');
    expect(b1?.allowed_paths).toEqual(['src/publish/**', 'tests/publish/**']);
    expect(b1?.contract_outputs).toEqual(['contracts/order-status.schema.json']);
    expect(b1?.red_target).toEqual(['npm', 'test', '--', 'publish']);
    expect(b1?.regression).toEqual(['npm', 'test']);
    expect(b1?.required_evidence).toEqual(['red', 'green', 'regression']);
    expect(b1?.depends_on).toEqual([]);

    expect(plan.behaviours[1]?.depends_on).toEqual(['B-1']);
    expect(plan.behaviours[1]?.contract_inputs).toEqual(['contracts/order-status.schema.json']);
  });

  it('refuses a plan that has not been approved', () => {
    expect(() => parsePlan(PLAN.replace('status: APPROVED', 'status: PROPOSED'))).toThrow(
      EccApprovalError,
    );
  });

  it('reports a behaviour missing a repository or a verifier instead of guessing', () => {
    const broken = PLAN.replace('- repository: core\n', '')
      .replace('- red_target: npm test -- publish\n', '')
      .replace('- green_target: npm test -- publish\n', '');
    const plan = parsePlan(broken);
    expect(plan.problems.map((p) => p.code)).toContain('BEHAVIOUR_MISSING_REPOSITORY');
    expect(plan.problems.map((p) => p.code)).toContain('BEHAVIOUR_MISSING_VERIFIER');
  });

  it('refuses a dependency on a behaviour that does not exist', () => {
    const plan = parsePlan(PLAN.replace('- depends_on: B-1', '- depends_on: B-99'));
    expect(plan.problems.map((p) => p.code)).toContain('UNKNOWN_BEHAVIOUR_DEPENDENCY');
  });
});

describe('ECC draft graph compilation', () => {
  it('produces a graph that passes the real validator', () => {
    const result = compileDraftGraph({
      prd: parsePrd(PRD),
      plan: parsePlan(PLAN),
      repositories: VALID_REPOSITORIES,
    });
    expect(result.problems).toEqual([]);

    const validation = validateGraph(result.graph, { repositories: VALID_REPOSITORIES });
    expect(validation.problems).toEqual([]);
    expect(validation.ok).toBe(true);
  });

  it('maps behaviour dependencies onto node dependencies', () => {
    const { graph } = compileDraftGraph({
      prd: parsePrd(PRD),
      plan: parsePlan(PLAN),
      repositories: VALID_REPOSITORIES,
    });
    const consumer = graph.nodes.find((n) => n.id.includes('api'));
    expect(consumer?.depends_on).toEqual(['FEAT-101.core.CAP-CORE-PUBLISH.impl']);
  });

  it('refuses when the PRD and plan disagree about the feature', () => {
    const otherPlan = parsePlan(PLAN.replace('feature_id: FEAT-101', 'feature_id: FEAT-999'));
    expect(() =>
      compileDraftGraph({ prd: parsePrd(PRD), plan: otherPlan, repositories: VALID_REPOSITORIES }),
    ).toThrow(/FEAT-999/);
  });

  it('reports a behaviour naming a repository outside the portfolio', () => {
    const plan = parsePlan(PLAN.replace('- repository: core', '- repository: ghost'));
    const result = compileDraftGraph({
      prd: parsePrd(PRD),
      plan,
      repositories: VALID_REPOSITORIES,
    });
    expect(result.problems.map((p) => p.code)).toContain('UNKNOWN_REPOSITORY');
  });

  it('reports an acceptance criterion no behaviour covers, rather than inventing a node', () => {
    const prd = parsePrd(PRD + '- AC-3: The app renders the result.\n');
    const result = compileDraftGraph({
      prd,
      plan: parsePlan(PLAN),
      repositories: VALID_REPOSITORIES,
    });
    expect(result.problems.map((p) => p.code)).toContain('UNCOVERED_ACCEPTANCE_CRITERION');
  });

  it('marks the draft as requiring human review before it can run', () => {
    const result = compileDraftGraph({
      prd: parsePrd(PRD),
      plan: parsePlan(PLAN),
      repositories: VALID_REPOSITORIES,
    });
    expect(result.requires_review).toBe(true);
    expect(result.review_notes.length).toBeGreaterThan(0);
  });
});
