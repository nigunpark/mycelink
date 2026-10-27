import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pilotPlan } from '../../evals-public-projects/lib/codex-pilot.mjs';

const suite = resolve('evals-public-projects');
const plugin = resolve('codex-plugin');
const root = resolve(process.env.TMPDIR ?? tmpdir(), 'codex-pilot-model-free');

describe('Codex public-project PRD pilot (model-free, fail-closed)', () => {
  it('binds both approved cases to separate source and evaluator spaces without exposing answers', () => {
    const plan = pilotPlan({ suiteRoot: suite, pluginRoot: plugin, runRoot: root });
    expect(plan.cases.map((c: { prd: string }) => c.prd)).toEqual(['CSET-202', 'PCM-101']);
    for (const c of plan.cases) {
      expect(c.source.commit).toMatch(/^[a-f0-9]{40}$/);
      expect(c.source.bundle).toContain('sources');
      expect(c.agent.workspace).toContain(c.prd);
      expect(c.agent.codexHome).toContain(c.prd);
      expect(c.evaluator.workspace).not.toBe(c.agent.workspace);
      expect(c.evaluator.command).toContain('--require-mycelink');
      expect(c.evaluator.command).toContain('--require-tdd');
      expect(c.evaluator.command).toContain('--expect-suite-commit');
      expect(c.agent.prompt).toContain(`requirements/${c.prd}.md`);
      expect(c.agent.prompt).not.toMatch(/reference\.bundle|fingerprints\.json|evaluator\.lock|hidden_tests|mutants/);
      expect(c.agent).not.toHaveProperty('evaluator');
    }
    expect(plan.cases[0].agent.workspace).not.toBe(plan.cases[1].agent.workspace);
    expect(plan.cases[0].agent.codexHome).not.toBe(plan.cases[1].agent.codexHome);
  });

  it('rejects planning-only plugin as PRD-to-delivery acceptance, even when init/prd/plan/status are discoverable', () => {
    const plan = pilotPlan({ suiteRoot: suite, pluginRoot: plugin, runRoot: root });
    expect(plan.ready).toBe(false);
    expect(plan.cases.every((c: { ready: boolean }) => c.ready === false)).toBe(true);
    expect(plan.blockers).toContain('codex-plugin: planning skills are available but no approved dispatch/worker/settle/delivery runtime');
    expect(plan.blockers).toContain('production Codex dispatch remains fail-closed');
  });

  it('refuses a run root inside the suite (agent cannot see evaluator inputs)', () => {
    expect(() => pilotPlan({ suiteRoot: suite, pluginRoot: plugin, runRoot: resolve(suite, 'pilot') })).toThrow(/outside the suite/);
  });
});
