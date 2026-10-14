/**
 * The with arm, model-free: QA's report against the control arm's, a rework
 * that ends without C002, and a Mycelink rework an interrupt stopped
 * (shared setup: arms-fixture.ts).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { TOY } from './toy-fixture.js';
// @ts-expect-error -- plain ESM module without type declarations
import { casePrompt } from '../../evals-public-projects/lib/cases.mjs';
import { qaPrompt, project, prd, fakePlan, arm, FAKE_HOST, hostPlan, DEFAULT_SHAPE, LATE_ONLY, checksFound, useArmsFixture } from './arms-fixture.js';

useArmsFixture();

describe('fault-injected arm', () => {
  describe('the with arm, model-free: a stand-in host on the sealed Mycelink', () => {
    it('QA’s report is the same bytes in both arms, but for the defect commit; the control arm still repairs directly, test-first', async () => {
      const without = fakePlan();
      const plain = await arm('without', without, { faultPlan: LATE_ONLY, requireTdd: true });
      const host = hostPlan({ reworkVia: 'command' });
      const plugin = await arm('with', host, { claude: [process.execPath, FAKE_HOST], faultPlan: LATE_ONLY, requireMycelink: true, requireTdd: true });
      const promptOf = (entries: any[]) => entries.find((e) => /^QA ran its end-to-end checks/.test(e.prompt)).prompt as string;
      const defectOf = (run: any) => run.faults.find((f: any) => f.kind === 'late-hidden-defect');
      const a = promptOf(without.entries());
      const b = promptOf(host.entries());
      const original = casePrompt({ project, prd });
      expect(a).toBe(qaPrompt(a, defectOf(plain), original));
      expect(b).toBe(qaPrompt(b, defectOf(plugin), original));
      expect(a.replace(defectOf(plain).commit.slice(0, 12), '<commit>')).toBe(b.replace(defectOf(plugin).commit.slice(0, 12), '<commit>'));
      // Nothing beyond QA's checks and the public module: no file the defect touched, nothing of how it was made.
      for (const text of [a, b]) {
        expect(text.split('\n\nThe original request follows.')[0]).not.toMatch(/stock\.mjs|revert|inject|hidden|mutant|evaluator|reference/i);
      }
      // No plugin, no controller: the without arm's session repaired main itself, test-first, and verified.
      expect(plain.sessions.map((s: any) => [s.purpose, s.ended_by])).toEqual([
        ['task', 'exit'],
        ['rework', 'exit'],
      ]);
      expect(plain.controller).toEqual({ ok: true, failures: [], recovered: [], violations: [], authority_recovered: false });
      expect(plain.ok).toBe(true);
      expect(plugin.ok).toBe(true);
      expect(plugin.mycelink).toMatchObject({ complete: true, candidate: 'TOY-001-C002' });
    }, 900_000);

    it('a rework session that exits 0 without C002 and its delivery stays an explicit controller failure', async () => {
      const fake = hostPlan({ reworkNoop: true });
      const run = await arm('with', fake, { claude: [process.execPath, FAKE_HOST], faultPlan: LATE_ONLY, requireMycelink: true });
      expect(run.sessions.map((s: any) => [s.purpose, s.ended_by, s.exit_code]), checksFound(run)).toEqual([
        ['task', 'exit', 0],
        ['rework', 'exit', 0],
      ]);
      expect(run.sessions[1].controller_edits).toEqual([]);
      expect(run.phases.map((p: any) => [p.phase, p.mycelink.complete, p.mycelink.candidate])).toEqual([
        ['task', true, 'TOY-001-C001'],
        ['rework', false, 'TOY-001-C001'],
      ]);
      expect(run.controller.failures).toEqual([expect.stringMatching(/^exited-incomplete: session 2 \(rework\) exited 0 with TOY-001 incomplete: candidate TOY-001-C001 binds toyshop at [0-9a-f]{12}, main is at [0-9a-f]{12}$/)]);
      expect(run.mycelink).toMatchObject({ complete: false, candidate: 'TOY-001-C001' });
      expect(run.verdict).not.toBe('verified');
    }, 600_000);

    it('resumes a Mycelink rework the interrupt stopped after its worker’s regression test, and after its fix', async () => {
      for (const [stage, count] of [['red', 1], ['green', 2]] as const) {
        const fake = hostPlan({ reworkStalls: [stage] });
        const run = await arm('with', fake, { claude: [process.execPath, FAKE_HOST], faultPlan: DEFAULT_SHAPE({ on: 'commits', count, phase: 'rework' }), requireMycelink: true, requireTdd: true });
        expect(run.sessions.map((s: any) => [s.index, s.purpose, s.ended_by]), `${stage} ${checksFound(run)}`).toEqual([
          [1, 'task', 'exit'],
          [2, 'rework', 'interrupt'],
          [3, 'rework-resume', 'exit'],
        ]);
        expect(run.mycelink, stage).toMatchObject({ complete: true, candidate: 'TOY-001-C002', incomplete: [] });
        expect(run.controller, stage).toEqual({ ok: true, failures: [], recovered: [], violations: [], authority_recovered: true });
        const v = JSON.parse(readFileSync(run.verification, 'utf8'));
        expect(v.sections.tdd.units.map((u: any) => u.verdict), stage).toEqual(['valid', 'valid', 'valid']);
        expect(v.ok, stage).toBe(true);
        expect(run.ok, stage).toBe(true);
      }
    }, 1_800_000);
  });
});

