/**
 * A run's phases — the task, and QA's rework of a late defect — each run as
 * sessions of the same purpose until one ends on its own.
 *
 * In the third PCM-101 pilot the fault plan's interrupt came due while QA
 * ran and fired two seconds into the rework session. The harness recorded
 * the rework as interrupted, started nothing after it and verified the
 * late defect's commit as the delivery; `interrupt-restart` failed with
 * one session. An evaluator interrupt in any phase now gets a fresh session
 * of that phase (the resume header, then the phase's own prompt) on the
 * phase's own deadline, until a session ends on its own, the deadline
 * passes, or a session cannot start at all.
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM module without type declarations
import { MAX_CORRECTIVES, runPhase } from '../../evals-public-projects/lib/arms.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { CORRECTIVE_PROMPT, TASK_CORRECTIVE_PROMPT, correctivePrompt, resumePrompt, taskCorrectivePrompt } from '../../evals-public-projects/lib/faults.mjs';

type Ended = 'exit' | 'interrupt' | 'budget' | 'spawn-error';

/** A scripted session runner: each session ends as the script says, at the given clock. */
function scripted(endings: Ended[], clock: { now: number }, step = 1000) {
  const started: { purpose: string; phase: string; text: string; deadline: number; resumes: number | null }[] = [];
  let index = 0;
  const start = async (s: { purpose: string; phase: string; text: string; deadline: number; resumes: number | null }) => {
    started.push(s);
    index += 1;
    clock.now += step;
    const ended_by = endings.shift() ?? 'exit';
    return { index, purpose: s.purpose, ended_by, exit_code: ended_by === 'exit' ? 0 : null };
  };
  return { start, started };
}

describe('a phase runs fresh sessions after each evaluator interrupt', () => {
  it('a task interrupted twice resumes twice, then ends on its own', async () => {
    const clock = { now: 0 };
    const { start, started } = scripted(['interrupt', 'interrupt', 'exit'], clock);
    const r = await runPhase({ phase: 'task', prompt: 'TASK', deadline: 60_000, start, now: () => clock.now });
    expect(r.ended_by).toBe('exit');
    expect(r.sessions.map((s: any) => [s.index, s.purpose, s.ended_by])).toEqual([
      [1, 'task', 'interrupt'],
      [2, 'resume', 'interrupt'],
      [3, 'resume', 'exit'],
    ]);
    expect(started.map((s) => [s.purpose, s.phase, s.text, s.deadline, s.resumes])).toEqual([
      ['task', 'task', 'TASK', 60_000, null],
      ['resume', 'task', resumePrompt('TASK'), 60_000, 1],
      ['resume', 'task', resumePrompt('TASK'), 60_000, 2],
    ]);
  });

  it('a rework interrupted 2 s in gets a fresh rework session with its own prompt, on the same deadline', async () => {
    const clock = { now: 0 };
    const { start, started } = scripted(['interrupt', 'exit'], clock, 2000);
    const r = await runPhase({ phase: 'rework', prompt: 'QA REPORT', deadline: 30_000, start, now: () => clock.now });
    expect(r).toMatchObject({ phase: 'rework', ended_by: 'exit' });
    expect(started.map((s) => [s.purpose, s.phase, s.text, s.deadline, s.resumes])).toEqual([
      ['rework', 'rework', 'QA REPORT', 30_000, null],
      ['rework-resume', 'rework', resumePrompt('QA REPORT'), 30_000, 1],
    ]);
  });

  it('stops at the phase deadline: an interrupt with no time left starts nothing, and the budget is never extended', async () => {
    const clock = { now: 0 };
    const { start, started } = scripted(['interrupt', 'interrupt'], clock, 10_000);
    const r = await runPhase({ phase: 'rework', prompt: 'QA', deadline: 15_000, start, now: () => clock.now });
    expect(r.ended_by).toBe('budget');
    expect(started).toHaveLength(2);
    expect(new Set(started.map((s) => s.deadline))).toEqual(new Set([15_000]));
  });

  it('ends with a session the deadline ended, and with one that could not start: neither is the evaluator’s interrupt', async () => {
    for (const ending of ['budget', 'spawn-error'] as const) {
      const clock = { now: 0 };
      const { start, started } = scripted([ending, 'exit'], clock);
      const r = await runPhase({ phase: 'task', prompt: 'TASK', deadline: 60_000, start, now: () => clock.now });
      expect(r.ended_by, ending).toBe(ending);
      expect(started, ending).toHaveLength(1);
    }
  });

  it('a session that exits non-zero ended on its own: no second attempt for the agent', async () => {
    const clock = { now: 0 };
    const start = async () => ({ index: 1, purpose: 'rework', ended_by: 'exit', exit_code: 1 });
    const r = await runPhase({ phase: 'rework', prompt: 'QA', deadline: 60_000, start, now: () => clock.now });
    expect(r).toMatchObject({ ended_by: 'exit', sessions: [{ exit_code: 1 }] });
  });
});

/**
 * A with-arm controller that changes the workspace itself (CSET-203 r9, the
 * fourth PCM-101 pilot, CSET-202 r2): the harness rolls the change back and
 * verifies the rollback before anything else runs, then starts a fresh
 * corrective session — told the contamination is already gone, never asked
 * to clean it up. A second, independent violation gets one more; an
 * identical repeat, a third violation, a rollback that could not be
 * verified or a spent deadline ends the phase.
 */
describe('a with-arm controller violation is rolled back and corrected, boundedly', () => {
  type Violation = { fingerprint: string; verified?: boolean };
  function sessions(endings: { ended_by: string; violation?: Violation }[], clock: { now: number }, step = 1000) {
    const started: any[] = [];
    let index = 0;
    const start = async (s: any) => {
      started.push(s);
      index += 1;
      clock.now += step;
      const e = endings.shift() ?? { ended_by: 'exit' };
      const violation = e.violation ? { fingerprint: e.violation.fingerprint, summary: [`gen.py (created; ${e.violation.fingerprint})`], mode: 'selective', verified: e.violation.verified ?? true } : null;
      return { index, purpose: s.purpose, ended_by: e.ended_by, exit_code: e.ended_by === 'exit' ? 0 : null, violation };
    };
    const corrected: number[] = [];
    const corrective = async (s: any) => {
      corrected.push(s.index);
      return `CORRECTIVE after ${s.index}`;
    };
    return { start, started, corrective, corrected };
  }
  const v = (fingerprint: string, verified = true) => ({ fingerprint, verified });

  it('starts a fresh corrective session once the rollback is verified: it corrects the session it names', async () => {
    const clock = { now: 0 };
    const { start, started, corrective, corrected } = sessions([{ ended_by: 'controller-violation', violation: v('a') }, { ended_by: 'exit' }], clock);
    const r = await runPhase({ phase: 'task', prompt: 'TASK', deadline: 60_000, start, corrective, now: () => clock.now });
    expect(r).toMatchObject({ phase: 'task', ended_by: 'exit' });
    expect(r.sessions.map((s: any) => [s.index, s.purpose, s.ended_by])).toEqual([
      [1, 'task', 'controller-violation'],
      [2, 'corrective', 'exit'],
    ]);
    expect(corrected).toEqual([1]);
    expect(started.map((s) => [s.purpose, s.text, s.resumes, s.corrects])).toEqual([
      ['task', 'TASK', null, undefined],
      ['corrective', 'CORRECTIVE after 1', null, 1],
    ]);
  });

  it('a violation the session left when it ended on its own is corrected the same way', async () => {
    const clock = { now: 0 };
    const { start, started } = sessions([{ ended_by: 'exit', violation: v('a') }, { ended_by: 'exit' }], clock);
    const r = await runPhase({ phase: 'rework', prompt: 'QA', deadline: 60_000, start, corrective: async () => 'C', now: () => clock.now });
    expect(r.ended_by).toBe('exit');
    expect(started.map((s) => s.purpose)).toEqual(['rework', 'rework-corrective']);
  });

  it('a second, independent violation gets a second corrective session; a third ends the phase', async () => {
    const clock = { now: 0 };
    const { start, started } = sessions(
      [
        { ended_by: 'controller-violation', violation: v('a') },
        { ended_by: 'controller-violation', violation: v('b') },
        { ended_by: 'controller-violation', violation: v('c') },
        { ended_by: 'exit' },
      ],
      clock,
    );
    const r = await runPhase({ phase: 'task', prompt: 'TASK', deadline: 60_000, start, corrective: async (s: any) => `C${s.index}`, now: () => clock.now });
    expect(r).toMatchObject({ ended_by: 'controller-violation', terminal: 'corrective-limit' });
    expect(started.map((s) => [s.purpose, s.corrects])).toEqual([
      ['task', undefined],
      ['corrective', 1],
      ['corrective', 2],
    ]);
    expect(MAX_CORRECTIVES).toBe(2);
  });

  it('the same violation again is terminal: no session repeats it', async () => {
    const clock = { now: 0 };
    const { start, started } = sessions([{ ended_by: 'controller-violation', violation: v('a') }, { ended_by: 'controller-violation', violation: v('a') }, { ended_by: 'exit' }], clock);
    const r = await runPhase({ phase: 'task', prompt: 'TASK', deadline: 60_000, start, corrective: async () => 'C', now: () => clock.now });
    expect(r).toMatchObject({ ended_by: 'controller-violation', terminal: 'identical-violation' });
    expect(started.map((s) => s.purpose)).toEqual(['task', 'corrective']);
    expect(r.sessions.at(-1).terminal).toBe('identical-violation');
  });

  it('nothing starts on a workspace whose rollback was not verified', async () => {
    const clock = { now: 0 };
    const { start, started, corrected } = sessions([{ ended_by: 'controller-violation', violation: v('a', false) }, { ended_by: 'exit' }], clock);
    const r = await runPhase({ phase: 'task', prompt: 'TASK', deadline: 60_000, start, corrective: async () => 'C', now: () => clock.now });
    expect(r).toMatchObject({ ended_by: 'controller-violation', terminal: 'rollback-unverified' });
    expect(started).toHaveLength(1);
    expect(corrected).toEqual([]);
  });

  it('an interrupted corrective session is resumed with its own prompt; a violation in an interrupted session is corrected and names it resumed', async () => {
    const clock = { now: 0 };
    const a = sessions([{ ended_by: 'controller-violation', violation: v('a') }, { ended_by: 'interrupt' }, { ended_by: 'exit' }], clock);
    const r = await runPhase({ phase: 'rework', prompt: 'QA', deadline: 60_000, start: a.start, corrective: async (s: any) => `C${s.index}`, now: () => clock.now });
    expect(r.ended_by).toBe('exit');
    expect(a.started.map((s) => [s.purpose, s.text, s.resumes])).toEqual([
      ['rework', 'QA', null],
      ['rework-corrective', 'C1', null],
      ['rework-resume', resumePrompt('C1'), 2],
    ]);
    const b = sessions([{ ended_by: 'interrupt', violation: v('a') }, { ended_by: 'exit' }], { now: 0 });
    const r2 = await runPhase({ phase: 'task', prompt: 'TASK', deadline: 60_000, start: b.start, corrective: async () => 'C', now: () => 0 });
    expect(r2.ended_by).toBe('exit');
    expect(b.started.map((s) => [s.purpose, s.resumes, s.corrects])).toEqual([
      ['task', null, undefined],
      ['corrective', 1, 1],
    ]);
  });

  it('nothing corrects without the callback, and nothing starts past the deadline', async () => {
    let clock = { now: 0 };
    let s = sessions([{ ended_by: 'controller-violation', violation: v('a') }, { ended_by: 'exit' }], clock);
    const plain = await runPhase({ phase: 'rework', prompt: 'QA', deadline: 60_000, start: s.start, now: () => clock.now });
    expect(plain.ended_by).toBe('controller-violation');
    expect(s.started).toHaveLength(1);
    clock = { now: 0 };
    s = sessions([{ ended_by: 'controller-violation', violation: v('a') }, { ended_by: 'exit' }], clock, 20_000);
    const late = await runPhase({ phase: 'rework', prompt: 'QA', deadline: 15_000, start: s.start, corrective: s.corrective, now: () => clock.now });
    expect(late).toMatchObject({ ended_by: 'controller-violation', terminal: 'budget' });
    expect(s.corrected).toEqual([]);
  });
});

/**
 * The corrective prompt: the contamination is already gone and verified;
 * the first action is the plugin's run command; nothing of the earlier
 * session is to be inspected, recreated or repaired; what was undone is
 * named by path and kind only — never by what the controller wrote.
 */
describe('the corrective prompt', () => {
  const violation = { summary: ['platform/features/CSET-203/ACCEPTANCE.json (created; a Mycelink-managed file)', 'platform/gen.py (created; a helper or scratch file in the workspace)'], mode: 'selective', discarded: [] };

  it('the task: already removed, first action /mycelink:run, no cleanup asked, the undone paths, then the request', () => {
    const text = taskCorrectivePrompt('THE REQUEST', violation, 'CSET-203');
    expect(text.startsWith(TASK_CORRECTIVE_PROMPT)).toBe(true);
    expect(TASK_CORRECTIVE_PROMPT).toMatch(/already undone/);
    expect(TASK_CORRECTIVE_PROMPT).toMatch(/Do not inspect, recreate, delete or repair/);
    expect(TASK_CORRECTIVE_PROMPT).not.toMatch(/clean (it )?up (the|those|these)/i);
    expect(text).toContain('Your first action is to invoke `/mycelink:run CSET-203`');
    expect(text).toContain('- platform/features/CSET-203/ACCEPTANCE.json (created; a Mycelink-managed file)');
    expect(text).toContain('only the session’s own changes were undone');
    expect(text.endsWith('The original request follows.\n\nTHE REQUEST')).toBe(true);
    const full = taskCorrectivePrompt('R', { ...violation, mode: 'full' }, 'CSET-203');
    expect(full).toContain('the whole session was rolled back to how it began');
    const discarded = taskCorrectivePrompt('R', { ...violation, discarded: ['CSET-203.x.impl'] }, 'CSET-203');
    expect(discarded).toContain('the dispatch of CSET-203.x.impl was discarded through Mycelink');
  });

  it("QA's rework: the same, its first action /mycelink:rework with QA's report", () => {
    const text = correctivePrompt('QA REPORT', violation);
    expect(text.startsWith(CORRECTIVE_PROMPT)).toBe(true);
    expect(CORRECTIVE_PROMPT).toMatch(/first action is to invoke `\/mycelink:rework`/);
    expect(CORRECTIVE_PROMPT).toMatch(/already undone/);
    expect(text.endsWith("QA's report follows.\n\nQA REPORT")).toBe(true);
  });
});
