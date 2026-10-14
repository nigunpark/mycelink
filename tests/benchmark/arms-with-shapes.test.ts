/**
 * The with arm, model-free, in the pilots' shapes: every fault of the plan,
 * the fourth pilot's and PCM-103's, each through a stand-in host on the sealed
 * Mycelink to C002 (shared setup: arms-fixture.ts).
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ISOLATED } from './isolation-fixture.js';
import { TOY } from './toy-fixture.js';
// @ts-expect-error -- plain ESM module without type declarations
import { casePrompt } from '../../evals-public-projects/lib/cases.mjs';
import { qaPrompt, toy, project, prd, arm, FAKE_HOST, testOf, hostPlan, DEFAULT_SHAPE, callsOf, failingOf, checksFound, useArmsFixture } from './arms-fixture.js';

useArmsFixture();

describe('fault-injected arm', () => {
  describe('the with arm, model-free: a stand-in host on the sealed Mycelink', () => {
    it('works every fault of the plan: teammate commit, replayed settles, late defect, an interrupt 2 s into the rework, and a Mycelink rework that delivers C002', async () => {
      const fake = hostPlan({ reworkStalls: ['start'] });
      const run = await arm('with', fake, { claude: [process.execPath, FAKE_HOST], faultPlan: DEFAULT_SHAPE({ on: 'elapsed-seconds', seconds: 2, phase: 'rework' }), requireMycelink: true, requireTdd: true });
      expect(run.sessions.map((s: any) => [s.index, s.purpose, s.phase, s.ended_by]), checksFound(run)).toEqual([
        [1, 'task', 'task', 'exit'],
        [2, 'rework', 'rework', 'interrupt'],
        [3, 'rework-resume', 'rework', 'exit'],
      ]);
      const byKind = Object.fromEntries(run.faults.map((f: any) => [f.kind, f]));
      expect(byKind['concurrent-commit']).toMatchObject({ applied: true, path: 'TEAM-NOTES.md', sync: 'done' });
      for (const kind of ['duplicate-result', 'stale-result']) expect(byKind[kind], kind).toMatchObject({ applied: true, state_changed: false, effect: expect.stringMatching(/^(receipt|refused|stale)$/) });
      expect(byKind['late-hidden-defect']).toMatchObject({ applied: true, module: 'mod-a' });
      expect(byKind['late-hidden-defect'].reported.length).toBeGreaterThan(0);
      expect(byKind['interrupt-restart']).toMatchObject({ resumed: true, interrupted_session: { index: 2, phase: 'rework' }, successor_session: { index: 3, phase: 'rework', ended_by: 'exit' } });

      // As in the third pilot, the teammate commit reached the delivery through an integration merge.
      const inRepo = (args: string[]) => execFileSync('git', args, { cwd: join(run.workspace, 'repos', 'toyshop'), encoding: 'utf8' }).trim();
      expect(inRepo(['log', '--merges', '--format=%P', `${toy.start}..main`]).split('\n').some((parents) => parents.split(' ').includes(byKind['concurrent-commit'].commit))).toBe(true);
      // The task delivered C001; the late defect made it stale; the rework delivered C002 at the delivery branch's head.
      const head = inRepo(['rev-parse', 'main']);
      expect(run.phases.map((p: any) => [p.phase, p.sessions, p.ended_by, p.mycelink.complete, p.mycelink.candidate])).toEqual([
        ['task', [1], 'exit', true, 'TOY-001-C001'],
        ['rework', [2, 3], 'exit', true, 'TOY-001-C002'],
      ]);
      expect(run.mycelink).toMatchObject({ complete: true, candidate: 'TOY-001-C002', candidate_sha: head, branch_head: head, incomplete: [] });
      expect(run.controller).toEqual({ ok: true, failures: [], recovered: [], violations: [], authority_recovered: true });

      const v = JSON.parse(readFileSync(run.verification, 'utf8'));
      const failing = Object.entries(v.sections).flatMap(([name, s]: [string, any]) => (s?.checks ?? []).filter((c: any) => !c.ok && c.severity !== 'warning').map((c: any) => `${name}:${c.id}`));
      expect(failing).toEqual([]);
      expect(v.sections.scope.checks.find((c: any) => c.id === 'fault-owned:TEAM-NOTES.md')).toMatchObject({ ok: true, severity: 'warning' });
      expect(v.sections.orchestration.checks.find((c: any) => c.id === 'candidate-equals-delivery:TOY-001')).toMatchObject({ ok: true });
      expect(v.sections.faults.checks.every((c: any) => c.ok)).toBe(true);
      expect(v.sections.tdd.units.map((u: any) => u.verdict)).toEqual(['valid', 'valid', 'valid']);
      expect(v.ok).toBe(true);
      expect(run.ok).toBe(true);
      // The run's own evidence holds: no evaluator access, no plugin exposure, no survivor. What keeps it from
      // `verified` here is this harness's setup alone — no suite pin (the library is called directly), a toy
      // qualified on one file system, and off Linux no boundary — never the delivery.
      expect(run.evaluator_access).toMatchObject({ hits: [], probes: [] });
      expect(run.plugin_exposure).toEqual([]);
      expect(run.delivery).toEqual({ ok: true, failures: [] });
      expect(run.trust.problems).toEqual(
        ISOLATED
          ? ['the verification is not trusted: suite_pinned, qualification_filesystems']
          : ['sessions ran outside the isolation boundary', 'a session ran unconfined', 'the verification is not trusted: isolation, suite_pinned, qualification_filesystems'],
      );
    }, 900_000);

    it('the fourth pilot’s shape: an interrupted task resumed to C001, the exact late defect, and a controller rework through the producer node that delivers C002', async () => {
      // The task is interrupted at its first commit, mod-a's test after its RED; a fresh session resumes it.
      const fake = hostPlan({ taskStalls: ['red'] });
      const run = await arm('with', fake, { claude: [process.execPath, FAKE_HOST], faultPlan: DEFAULT_SHAPE({ on: 'commits', count: 1, phase: 'task' }), requireMycelink: true, requireTdd: true });
      // On a mismatch, what each session's checks found.
      const found = checksFound(run);
      expect(run.sessions.map((s: any) => [s.index, s.purpose, s.phase, s.ended_by]), found).toEqual([
        [1, 'task', 'task', 'interrupt'],
        [2, 'resume', 'task', 'exit'],
        [3, 'rework', 'rework', 'exit'],
      ]);
      const byKind = Object.fromEntries(run.faults.map((f: any) => [f.kind, f]));
      expect(byKind['interrupt-restart']).toMatchObject({
        applied: true,
        resumed: true,
        interrupted_session: { index: 1, purpose: 'task', phase: 'task', ended_by: 'interrupt' },
        successor_session: { index: 2, purpose: 'resume', phase: 'task', ended_by: 'exit' },
      });
      expect(byKind['concurrent-commit']).toMatchObject({ applied: true, path: 'TEAM-NOTES.md', sync: 'done' });
      for (const kind of ['duplicate-result', 'stale-result']) expect(byKind[kind], kind).toMatchObject({ applied: true, state_changed: false });
      const defect = byKind['late-hidden-defect'];
      expect(defect).toMatchObject({ applied: true, module: 'mod-a', paths: ['mod-a/src/stock.mjs'] });
      expect(defect.reported.length).toBeGreaterThan(0);

      const repo = join(run.workspace, 'repos', 'toyshop');
      const inRepo = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
      // The defect is exactly the revert of mod-a's delivered production: each path as the start had it.
      const blobAt = (rev: string, path: string) => inRepo(['ls-tree', rev, '--', path]);
      for (const path of defect.paths) expect(blobAt(defect.commit, path), path).toBe(blobAt(toy.start, path));
      expect(inRepo(['diff', '--name-only', defect.parent, defect.commit])).toBe('mod-a/src/stock.mjs');

      // The resumed task recovered the key and delivered C001; the rework delivered C002 at main's head.
      const head = inRepo(['rev-parse', 'main']);
      expect(run.phases.map((p: any) => [p.phase, p.sessions, p.ended_by, p.mycelink.complete, p.mycelink.candidate])).toEqual([
        ['task', [1, 2], 'exit', true, 'TOY-001-C001'],
        ['rework', [3], 'exit', true, 'TOY-001-C002'],
      ]);
      expect(run.phases[0].mycelink).toMatchObject({ authority_recovered: true, incomplete: [] });
      expect(run.phases[0].mycelink.candidate_sha).toBe(defect.parent);
      // What the run reports after every fault is C002, bound to the delivered head.
      for (const summary of [run.phases[1].mycelink, run.mycelink]) expect(summary).toMatchObject({ complete: true, candidate: 'TOY-001-C002', candidate_sha: head, branch_head: head, incomplete: [] });
      expect(run.controller).toEqual({ ok: true, failures: [], recovered: [], violations: [], authority_recovered: true });
      expect(run.sessions[2].controller_edits).toEqual([]);

      // The rework session, as the controller: status, the producer node of what moved since the delivery, its rework, then dispatch, deliver, verify.
      const events = readFileSync(run.sessions[2].transcript, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const calls = events.filter((e) => e.type === 'assistant').flatMap((e) => e.message.content.filter((c: any) => c.type === 'tool_use').map((c: any) => ({ ...c, parent: e.parent_tool_use_id })));
      const controller = calls.filter((c: any) => c.parent === null);
      const at = (pattern: RegExp) => controller.findIndex((c: any) => c.name === 'Bash' && pattern.test(c.input.command));
      const steps = [/ feature status TOY-001 /, / feature owners TOY-001 --since-delivery /, / node rework TOY-001 TOY-001\.mod-a\.impl /, / dispatch TOY-001 /, / deliver TOY-001 /, / feature verify TOY-001 --delivered /].map(at);
      expect(steps.every((i) => i >= 0)).toBe(true);
      expect([...steps].sort((a, b) => a - b)).toEqual(steps);
      // Each reopened producer is a fresh module-worker: the reworked one proves RED, commits its test alone, then GREEN and its production alone.
      const agents = controller.filter((c: any) => c.name === 'Agent');
      // The plugin's reviewer, recorded apart from the workers: C001's review and the repair's, both passed.
      expect(run.reviewers.map((r: any) => [r.review_id, r.verdict?.overall, r.settlement?.outcome])).toEqual([['TOY-001-R001', 'PASS', 'PASS'], ['TOY-001-R002', 'PASS', 'PASS']]);
      expect(run.workers.every((w: any) => w.node_id !== null)).toBe(true);
      // The reopened producers' fresh workers, then the acceptance review of the repair before C002.
      expect(agents.map((c: any) => c.input.description)).toEqual(['TOY-001.mod-a.impl', 'TOY-001.mod-b.impl', 'acceptance review TOY-001-R002']);
      const workerSteps = calls
        .filter((c: any) => c.parent === agents[0].id)
        .map((c: any) => (/\btdd (red|green|regression)\b/.exec(c.input.command)?.[1] ?? (/ commit /.test(c.input.command) ? 'commit' : null)))
        .filter(Boolean);
      expect(workerSteps).toEqual(['red', 'commit', 'green', 'commit', 'regression']);
      const [test, fix] = inRepo(['log', '--no-merges', '--format=%H', '--reverse', `${defect.commit}..main`, '--', 'mod-a']).split('\n');
      expect(inRepo(['diff', '--name-only', `${test}~1`, test!])).toBe('mod-a/test/reserve.test.mjs');
      expect(inRepo(['diff', '--name-only', `${fix}~1`, fix!])).toBe('mod-a/src/stock.mjs');
      expect(inRepo(['rev-parse', `${fix}~1`])).toBe(test);
      // The regression test was written on top of the defect: RED against exactly what QA reported.
      expect(inRepo(['merge-base', defect.commit, test!])).toBe(defect.commit);

      // Mycelink's own record: the rework of the producer node invalidated C001; C002 was built, accepted and delivered.
      const control = join(run.workspace, 'platform');
      const state = JSON.parse(readFileSync(join(control, 'features', 'TOY-001', 'STATE.json'), 'utf8')).data;
      expect(state.reworks.map((r: any) => [r.node_id, r.invalidated_candidate, r.reopened])).toEqual([
        ['TOY-001.mod-a.impl', 'TOY-001-C001', ['TOY-001.mod-a.impl', 'TOY-001.mod-b.impl', 'TOY-001.release.candidate.build']],
      ]);
      for (const name of defect.reported) expect(state.reworks[0].reason).toContain(name);
      expect(state).toMatchObject({ current_candidate: 'TOY-001-C002', feature_state: 'COMPLETED' });
      expect(Object.keys(state.accepted_deliveries)).toContain('TOY-001-C002');
      const verified = execFileSync(process.execPath, [join(run.plugin.dir, 'bin', 'mycelink.mjs'), 'feature', 'verify', 'TOY-001', '--delivered', '--control-root', control, '--json'], { encoding: 'utf8' });
      expect(JSON.parse(verified)).toEqual({ ok: true, problems: [] });

      const v = JSON.parse(readFileSync(run.verification, 'utf8'));
      const failing = Object.entries(v.sections).flatMap(([name, s]: [string, any]) => (s?.checks ?? []).filter((c: any) => !c.ok && c.severity !== 'warning').map((c: any) => `${name}:${c.id}`));
      expect(failing).toEqual([]);
      expect(v.sections.orchestration.checks.find((c: any) => c.id === 'candidate-equals-delivery:TOY-001')).toMatchObject({ ok: true });
      // The injected commits are in no cycle, yet each is still exactly the commit its record binds.
      expect(v.sections.tdd.units.map((u: any) => u.verdict)).toEqual(['valid', 'valid', 'valid']);
      expect(v.sections.tdd.units.flatMap((u: any) => u.commits)).not.toEqual(expect.arrayContaining([byKind['concurrent-commit'].commit]));
      expect(v.sections.tdd.units.flatMap((u: any) => u.commits)).not.toEqual(expect.arrayContaining([defect.commit]));
      expect(v.sections.tdd.injections.map((x: any) => [x.kind, x.commit, x.ok])).toEqual([
        ['concurrent-commit', byKind['concurrent-commit'].commit, true],
        ['late-hidden-defect', defect.commit, true],
      ]);
      expect(v.sections.faults.checks.every((c: any) => c.ok)).toBe(true);
      expect(v.ok).toBe(true);
      expect(run.ok).toBe(true);
      expect(run.delivery).toEqual({ ok: true, failures: [] });
    }, 900_000);

    /** The PCM-103 controller's own reviews: mod-a's first worker under-implements; two reworks before C001 finish it. */
    const REVIEWED = () => {
      const reserve = testOf('mod-a/test/reserve.test.mjs');
      const t1 = `${reserve}test('reserving two out of five leaves three', () => {\n  assert.deepEqual(reserve(5, 2), { stock: 3, reserved: 2 });\n});\n`;
      const t2 = `${t1}test('reserving four reserves four', () => {\n  assert.deepEqual(reserve(9, 4), { stock: 5, reserved: 4 });\n});\n`;
      const qa = `${t2}test('reserving one out of seven leaves six', () => {\n  assert.deepEqual(reserve(7, 1), { stock: 6, reserved: 1 });\n});\n`;
      return {
        draft: { 'mod-a/src/stock.mjs': 'export function reserve(stock, qty) {\n  return { stock: stock - 3, reserved: qty };\n}\n' },
        reviews: {
          'mod-a': [
            { reason: 'own review: reserving two out of five must leave three in stock', tests: { 'mod-a/test/reserve.test.mjs': t1 }, impl: { 'mod-a/src/stock.mjs': 'export function reserve(stock, qty) {\n  return { stock: stock - qty, reserved: Math.min(qty, 3) };\n}\n' } },
            { reason: 'own review: reserving four must reserve all four', tests: { 'mod-a/test/reserve.test.mjs': t2 }, impl: { 'mod-a/src/stock.mjs': TOY.referenceCode['mod-a/src/stock.mjs'] } },
          ],
        },
        regression: { 'mod-a/test/reserve.test.mjs': qa },
      };
    };

    it('the PCM-103 shape: two own reviews before C001, an interrupted task, the late defect, and /mycelink:rework reworks the producer a third time to C002', async () => {
      const r = REVIEWED();
      const fake = hostPlan({ taskStalls: ['red'], reworkVia: 'command', reviews: r.reviews });
      // mod-a's first worker writes the draft; QA's regression keeps every reviewed test.
      const plan = JSON.parse(readFileSync(fake.file, 'utf8'));
      plan.work['mod-a'].draft = r.draft;
      plan.regression['mod-a'] = r.regression;
      writeFileSync(fake.file, JSON.stringify(plan));
      const run = await arm('with', fake, { claude: [process.execPath, FAKE_HOST], faultPlan: DEFAULT_SHAPE({ on: 'commits', count: 1, phase: 'task' }), requireMycelink: true, requireTdd: true });
      // On a mismatch, what each session's checks found.
      const found = checksFound(run);
      expect(run.sessions.map((s: any) => [s.index, s.purpose, s.phase, s.ended_by]), found).toEqual([
        [1, 'task', 'task', 'interrupt'],
        [2, 'resume', 'task', 'exit'],
        [3, 'rework', 'rework', 'exit'],
      ]);
      const defect = run.faults.find((f: any) => f.kind === 'late-hidden-defect');
      expect(defect).toMatchObject({ applied: true, module: 'mod-a', affected: { module: 'mod-a', path: 'mod-a', repository: 'repos/toyshop' } });
      // QA's report names the module, then the plugin's rework command as the first action.
      const qa = fake.entries()[2].prompt;
      expect(qa).toBe(qaPrompt(qa, defect, casePrompt({ project, prd })));
      expect(qa).toContain('QA traced the failing checks to the module `mod-a` (`mod-a/`) of the repository `repos/toyshop/`.');

      // The rework session: the command first, then status, the one-step attribution, dispatch, deliver, verify; no edit of its own.
      const calls = callsOf(run.sessions[2].transcript);
      const top = calls.filter((c: any) => c.parent === null);
      expect(top[0]).toMatchObject({ name: 'Skill', input: { skill: 'mycelink:rework' } });
      const at = (pattern: RegExp) => top.findIndex((c: any) => c.name === 'Bash' && pattern.test(c.input.command));
      const steps = [/ controller open /, / feature status TOY-001 /, / feature rework TOY-001 --since-delivery toyshop:mod-a\/ /, / dispatch TOY-001 /, / deliver TOY-001 /, / feature verify TOY-001 --delivered /].map(at);
      expect(steps.every((i) => i > 0), String(steps)).toBe(true);
      expect([...steps].sort((a, b) => a - b)).toEqual(steps);
      expect(run.sessions[2].controller_edits).toEqual([]);
      const agents = top.filter((c: any) => c.name === 'Agent');
      // The reopened producers' fresh workers, then the acceptance review of the repair before C002.
      expect(agents.map((c: any) => c.input.description)).toEqual(['TOY-001.mod-a.impl', 'TOY-001.mod-b.impl', 'acceptance review TOY-001-R002']);
      const workerSteps = calls.filter((c: any) => c.parent === agents[0].id).map((c: any) => /\btdd (red|green|regression)\b/.exec(c.input.command)?.[1] ?? (/ commit /.test(c.input.command) ? 'commit' : null)).filter(Boolean);
      expect(workerSteps).toEqual(['red', 'commit', 'green', 'commit', 'regression']);

      // Mycelink's record: two own reviews before C001, then QA's rework of the same node after it was accepted.
      const control = join(run.workspace, 'platform');
      const state = JSON.parse(readFileSync(join(control, 'features', 'TOY-001', 'STATE.json'), 'utf8')).data;
      expect(state.reworks.map((x: any) => [x.node_id, x.invalidated_candidate, x.delivered])).toEqual([
        ['TOY-001.mod-a.impl', null, false],
        ['TOY-001.mod-a.impl', null, false],
        ['TOY-001.mod-a.impl', 'TOY-001-C001', true],
      ]);
      expect(state.nodes['TOY-001.mod-a.impl'].rework_history).toHaveLength(3);
      for (const name of defect.reported) expect(state.reworks[2].reason).toContain(name);
      expect(state).toMatchObject({ current_candidate: 'TOY-001-C002', feature_state: 'COMPLETED' });
      const head = execFileSync('git', ['rev-parse', 'main'], { cwd: join(run.workspace, 'repos', 'toyshop'), encoding: 'utf8' }).trim();
      expect(run.mycelink).toMatchObject({ complete: true, candidate: 'TOY-001-C002', candidate_sha: head, branch_head: head, incomplete: [] });
      expect(run.controller).toEqual({ ok: true, failures: [], recovered: [], violations: [], authority_recovered: true });

      const v = JSON.parse(readFileSync(run.verification, 'utf8'));
      expect(failingOf(v)).toEqual([]);
      // mod-a's three cycles before C001, mod-b's, and QA's regression: each test-first.
      expect(v.sections.tdd.units.map((u: any) => u.verdict)).toEqual(['valid', 'valid', 'valid', 'valid', 'valid']);
      expect(v.ok).toBe(true);
      expect(run.ok).toBe(true);
      expect(run.delivery).toEqual({ ok: true, failures: [] });
    }, 900_000);
  });
});

