/**
 * The with arm, model-free: a controller that changes the workspace itself
 * during a rework or a task — rolled back, corrected, or the phase ended
 * (shared setup: arms-fixture.ts).
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeTmpDir } from '../helpers/tmp.js';
import { REPO_ROOT } from '../helpers/global-setup.js';
import { TOY } from './toy-fixture.js';
// @ts-expect-error -- plain ESM module without type declarations
import { CORRECTIVE_PROMPT, TASK_CORRECTIVE_PROMPT, correctivePrompt, taskCorrectivePrompt } from '../../evals-public-projects/lib/faults.mjs';
import { sha, arm, FAKE_HOST, hostPlan, LATE_ONLY, callsOf, failingOf, checksFound, useArmsFixture } from './arms-fixture.js';

useArmsFixture();

const SETTLE_PAUSE = join(REPO_ROOT, 'tests', 'benchmark', 'settle-pause-preload.mjs');

/**
 * Hold the rework session's settle of `node` inside its slot's move into the
 * quarantine (settle-pause-preload.mjs) until `count` light checks of that
 * session have started since it was held; then release it. Armed once the
 * harness starts session 2, so the task session settles untouched. `done()`
 * (after the run) stops watching and tells what happened: a session stopped
 * meanwhile killed the held settle, unreleased.
 */
function holdSettle({ trace, hold, checks, node, count = 3 }: { trace: string; hold: string; checks: string; node: string; count?: number }) {
  const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : '');
  const state = { paused: null as any, checks: 0, released: false, expired: false };
  const tick = setInterval(() => {
    if (!existsSync(join(hold, 'arm')) && /session 2 \(/.test(read(trace))) writeFileSync(join(hold, 'arm'), node);
    if (state.paused === null && existsSync(join(hold, 'paused'))) state.paused = JSON.parse(read(join(hold, 'paused')));
    if (state.paused === null || state.released) return;
    state.checks = read(checks).split('\n').filter(Boolean).filter((l) => JSON.parse(l).started_ms > state.paused.at).length;
    if (state.checks >= count) {
      writeFileSync(join(hold, 'release'), '');
      state.released = true;
    }
  }, 25);
  return {
    done: () => {
      clearInterval(tick);
      return { ...state, expired: existsSync(join(hold, 'expired')) };
    },
  };
}

/** Every result quarantine left below `dir`. */
function quarantinesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.result-quarantine-')) out.push(join(d, e.name));
      else walk(join(d, e.name));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

describe('fault-injected arm', () => {
  describe('the with arm, model-free: a stand-in host on the sealed Mycelink', () => {
    it('a first rework session whose revert lands on main is stopped and rolled back; a corrective session reworks through Mycelink to C002, and the violation stays on the record', async () => {
      // A host that runs no plugin hook: the revert lands, and the harness finds it in the workspace, stops it and rolls it back.
      const fake = hostPlan({ reworkDirect: [true, false], reworkVia: 'command', hooks: false });
      const run = await arm('with', fake, { claude: [process.execPath, FAKE_HOST], faultPlan: LATE_ONLY, requireMycelink: true, requireTdd: true, lightCheckMs: 300 });
      expect(run.sessions.map((s: any) => [s.index, s.purpose, s.phase, s.ended_by, s.corrects ?? null]), checksFound(run)).toEqual([
        [1, 'task', 'task', 'exit', null],
        [2, 'rework', 'rework', 'controller-violation', null],
        [3, 'rework-corrective', 'rework', 'exit', 2],
      ]);
      expect(run.phases.map((p: any) => [p.phase, p.sessions, p.ended_by])).toEqual([
        ['task', [1], 'exit'],
        ['rework', [2, 3], 'exit'],
      ]);
      expect(run.sessions[1].duration_ms).toBeLessThan(60_000);
      expect(run.sessions[1].controller_edits.map((e: any) => [e.tool, e.action])).toEqual([['Bash', 'git revert']]);
      // Rolled back exactly: main is at the defect again, the revert reachable from no ref, the files as QA found them.
      const defect = run.faults.find((f: any) => f.kind === 'late-hidden-defect');
      const repo = join(run.workspace, 'repos', 'toyshop');
      const inRepo = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
      const txn = run.sessions[1].controller_txn;
      expect(txn).toMatchObject({ violation: true, mode: 'selective', rollback: { verified: true } });
      const moved = txn.rollback.refs.find((r: any) => r.ref === 'refs/heads/main');
      expect(moved).toMatchObject({ to: defect.commit });
      expect(inRepo(['log', '-1', '--format=%s', moved.from])).toMatch(/^Revert /);
      expect(inRepo(['branch', '--contains', moved.from])).toBe('');
      expect(inRepo(['for-each-ref', '--contains', moved.from])).toBe('');
      // The corrective prompt: already undone, /mycelink:rework first, what was undone by path, then QA's report byte for byte.
      const [, rework, corrective] = fake.entries();
      const v2 = run.sessions[1].violation;
      expect(corrective.prompt).toBe(correctivePrompt(rework.prompt, { summary: v2.summary, mode: v2.mode, discarded: [] }));
      expect(corrective.prompt.startsWith(CORRECTIVE_PROMPT)).toBe(true);
      expect(run.sessions[2].prompt_sha256).toBe(sha(corrective.prompt));
      // It went through Mycelink: the command, the producer node, its worker RED -> GREEN, C002 delivered.
      const calls = callsOf(run.sessions[2].transcript);
      const top = calls.filter((c: any) => c.parent === null);
      expect(top[0]).toMatchObject({ name: 'Skill', input: { skill: 'mycelink:rework' } });
      expect(top.some((c: any) => c.name === 'Bash' && / feature rework TOY-001 --since-delivery toyshop:mod-a\/ /.test(c.input.command))).toBe(true);
      expect(run.sessions[2].controller_edits).toEqual([]);
      expect(run.sessions[2].violation ?? null).toBeNull();
      const agent = top.find((c: any) => c.name === 'Agent' && c.input.description === 'TOY-001.mod-a.impl');
      expect(calls.filter((c: any) => c.parent === agent.id).map((c: any) => /\btdd (red|green|regression)\b/.exec(c.input.command)?.[1] ?? (/ commit /.test(c.input.command) ? 'commit' : null)).filter(Boolean)).toEqual(['red', 'commit', 'green', 'commit', 'regression']);
      const head = inRepo(['rev-parse', 'main']);
      expect(run.mycelink).toMatchObject({ complete: true, candidate: 'TOY-001-C002', candidate_sha: head, branch_head: head });
      expect(inRepo(['merge-base', defect.commit, head])).toBe(defect.commit);
      // Recorded and recovered, not failed.
      expect(run.controller).toMatchObject({
        ok: true,
        failures: [],
        recovered: [expect.stringMatching(/^controller-violation: session 2 \(rework\) changed the workspace itself: repos\/toyshop\/\.git:refs\/heads\/main \(moved from [0-9a-f]{12} to [0-9a-f]{12}; a product repository's ref\).*; stopped there; rolled back \(selective, verified\)\. Recovered by session 3 \(rework-corrective\), which completed it through Mycelink to TOY-001-C002$/)],
      });
      expect(run.delivery).toEqual({ ok: true, failures: [], recovered: run.controller.recovered });
      // Its rollback attested at the run's end: the manifest recorded, the revert reachable from no ref, nothing left.
      expect(run.controller_rollbacks).toMatchObject({ ok: true, problems: [], sessions: [{ session: 2, ok: true, mode: 'selective', manifest_sha256: v2.manifest_sha256 }] });
      expect(run.trust.problems.filter((p: string) => /controller rollback/.test(p))).toEqual([]);
      const v = JSON.parse(readFileSync(run.verification, 'utf8'));
      expect(failingOf(v)).toEqual([]);
      expect(v.sections.tdd.units.map((u: any) => u.verdict)).toEqual(['valid', 'valid', 'valid']);
      expect(v.ok).toBe(true);
      expect(run.ok).toBe(true);
    }, 900_000);

    it('a revert the plugin’s fence refused changed nothing: no violation, and the controller repairs through Mycelink to C002 (r9: blocked is not done)', async () => {
      const fake = hostPlan({ reworkDirect: true, reworkVia: 'command' });
      const run = await arm('with', fake, { claude: [process.execPath, FAKE_HOST], faultPlan: LATE_ONLY, requireMycelink: true, requireTdd: true, lightCheckMs: 300 });
      expect(run.sessions.map((s: any) => [s.index, s.purpose, s.ended_by, Boolean(s.violation)]), checksFound(run)).toEqual([
        [1, 'task', 'exit', false],
        [2, 'rework', 'exit', false],
      ]);
      const events = readFileSync(run.sessions[1].transcript, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const revert = callsOf(run.sessions[1].transcript).find((c: any) => c.name === 'Bash' && /\bgit -C .* revert\b/.test(c.input.command));
      const result = events.flatMap((e: any) => (e.type === 'user' ? e.message.content : [])).find((c: any) => c.tool_use_id === revert.id);
      expect(result).toMatchObject({ is_error: true, content: expect.stringMatching(/^Blocked: /) });
      expect(run.sessions[1].controller_edits).toEqual([]);
      expect(run.sessions[1].fence_blocks).toBe(1);
      expect(run.sessions[1].controller_txn, checksFound(run)).toMatchObject({ violation: false, mode: 'none' });
      expect(run.mycelink).toMatchObject({ complete: true, candidate: 'TOY-001-C002' });
      expect(run.controller).toMatchObject({ ok: true, failures: [], recovered: [] });
      expect(run.ok).toBe(true);
    }, 900_000);

    /**
     * CI 38690258070 (hosted Windows, Node 22): the same rework, its `settle`
     * still inside the call that moves the worker's result slot into its
     * quarantine — the slot moved, the recorder's `done` not yet written —
     * while light checks walked the workspace. What that call moved was taken
     * for the controller's (two checks running), the session was stopped, the
     * settle killed, and the corrective session found the node still
     * REGRESSION_VERIFIED (REWORK_IN_FLIGHT). Here the settle is held there,
     * deterministically, until three checks have run.
     */
    it('a settle held inside the move of its result slot into the quarantine while checks run is no violation: what that call moves is the core’s until it is done', async () => {
      const outDir = join(makeTmpDir('bench-a-run-'), 'run');
      const fake = hostPlan({ reworkDirect: true, reworkVia: 'command' });
      // Inside the stand-in's own directory, the one the session's boundary binds in (writable): the preload and the hold.
      const hold = join(fake.dir, 'hold');
      mkdirSync(hold);
      const preload = join(fake.dir, 'settle-pause-preload.mjs');
      copyFileSync(SETTLE_PAUSE, preload);
      const held = holdSettle({ trace: join(fake.dir, 'harness-trace.log'), hold, checks: join(outDir, 'controller-txn', 'session-2', 'checks.jsonl'), node: 'TOY-001.mod-b.impl' });
      const run = await arm('with', fake, {
        claude: [process.execPath, FAKE_HOST],
        faultPlan: LATE_ONLY,
        requireMycelink: true,
        requireTdd: true,
        lightCheckMs: 300,
        outDir,
        env: { FAKE_CLAUDE_PLAN: fake.file, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, MYCELINK_TEST_SETTLE_PAUSE: hold },
      });
      const h = held.done();
      expect(run.sessions.map((s: any) => [s.index, s.purpose, s.ended_by, s.controller_txn?.stopped_for ?? null, s.violation?.summary ?? null]), checksFound(run)).toEqual([
        [1, 'task', 'exit', null, null],
        [2, 'rework', 'exit', null, null],
      ]);
      // It was held where CI caught it, and the checks ran while it was: the moved slot in the quarantine, no done.
      expect(h).toMatchObject({ paused: { quarantine: expect.stringMatching(/[\\/]sessions[\\/]TOY-001\.mod-b\.impl[\\/]\.result-quarantine-[^\\/]+[\\/]slot$/) }, released: true, expired: false });
      expect(h.checks).toBeGreaterThanOrEqual(3);
      expect(run.sessions[1].controller_txn).toMatchObject({ violation: false, mode: 'none' });
      // The settle went on and cleaned its quarantine up; the rework reached C002 through Mycelink.
      expect(quarantinesUnder(join(run.workspace, 'platform', 'features'))).toEqual([]);
      expect(run.mycelink).toMatchObject({ complete: true, candidate: 'TOY-001-C002', incomplete: [] });
      expect(run.controller).toMatchObject({ ok: true, failures: [], recovered: [] });
      expect(run.ok).toBe(true);
    }, 900_000);

    it('the same revert again in the corrective session ends the phase: an identical repeat is terminal (the fourth pilot)', async () => {
      const fake = hostPlan({ reworkDirect: true, hooks: false });
      const run = await arm('with', fake, { claude: [process.execPath, FAKE_HOST], faultPlan: LATE_ONLY, requireMycelink: true, requireTdd: true, lightCheckMs: 300 });
      expect(run.sessions.map((s: any) => [s.index, s.purpose, s.phase, s.ended_by]), checksFound(run)).toEqual([
        [1, 'task', 'task', 'exit'],
        [2, 'rework', 'rework', 'controller-violation'],
        [3, 'rework-corrective', 'rework', 'controller-violation'],
      ]);
      // Stopped at the change, not when it would have ended: each was to carry on for ten minutes.
      for (const s of run.sessions.slice(1)) expect(s.duration_ms).toBeLessThan(60_000);
      expect(run.sessions[2].terminal).toBe('identical-violation');
      // Both rolled back: main is at the defect.
      const defect = run.faults.find((f: any) => f.kind === 'late-hidden-defect');
      expect(execFileSync('git', ['rev-parse', 'main'], { cwd: join(run.workspace, 'repos', 'toyshop'), encoding: 'utf8' }).trim()).toBe(defect.commit);
      expect(run.phases.map((p: any) => [p.phase, p.ended_by])).toEqual([
        ['task', 'exit'],
        ['rework', 'controller-violation'],
      ]);
      expect(run.controller.ok).toBe(false);
      expect(run.controller.recovered).toEqual([]);
      expect(run.controller.failures).toEqual([
        expect.stringMatching(/^controller-violation: session 2 \(rework\) changed the workspace itself: .*rolled back \(selective, verified\)\. /),
        expect.stringMatching(/^controller-violation: session 3 \(rework-corrective\) changed the workspace itself: .*The phase ended: the same violation as before\. /),
      ]);
      expect(run.delivery.failures.slice(0, 2)).toEqual(run.controller.failures.map((f: string) => `controller:${f}`));
      // A controller failure, not untrusted evidence: both rollbacks attested.
      expect(run.controller_rollbacks).toMatchObject({ ok: true, problems: [], sessions: [{ session: 2, ok: true }, { session: 3, ok: true }] });
      expect(run.trust.problems.filter((p: string) => /controller rollback/.test(p))).toEqual([]);
      expect(run.ok).toBe(false);
      expect(run.sessions[0].controller_edits).toEqual([]);
    }, 900_000);

    /**
     * CSET-202 r2's shape in the task: while a module-worker runs, the
     * controller writes into that worker's result slot itself. With the
     * plugin's fence the write is refused and nothing happened; where it
     * lands (no hook ran), the harness sees the worktree it reached into
     * changed, stops the session, discards that dispatch through Mycelink
     * (claim handed back unspent, worktree removed, branch archived) and a
     * corrective session re-dispatches the node to a fresh worker to C001.
     */
    it('a task controller’s write to a running worker’s result slot, refused by the fence, is no violation', async () => {
      const fake = hostPlan({ taskTakeover: [true] });
      const run = await arm('with', fake, { claude: [process.execPath, FAKE_HOST], requireMycelink: true, requireTdd: true, lightCheckMs: 300 });
      expect(run.sessions.map((s: any) => [s.index, s.purpose, s.ended_by, Boolean(s.violation)]), checksFound(run)).toEqual([[1, 'task', 'exit', false]]);
      expect(run.sessions[0].fence_blocks).toBe(1);
      expect(run.mycelink).toMatchObject({ complete: true, candidate: 'TOY-001-C001' });
      expect(run.ok).toBe(true);
    }, 900_000);

    it('one that lands contaminates the worktree: the dispatch is discarded through Mycelink and a corrective session re-dispatches a fresh worker to C001', async () => {
      const fake = hostPlan({ taskTakeover: [true, false], hooks: false });
      const run = await arm('with', fake, { claude: [process.execPath, FAKE_HOST], requireMycelink: true, requireTdd: true, lightCheckMs: 300 });
      expect(run.sessions.map((s: any) => [s.index, s.purpose, s.phase, s.ended_by, s.corrects ?? null]), checksFound(run)).toEqual([
        [1, 'task', 'task', 'controller-violation', null],
        [2, 'corrective', 'task', 'exit', 1],
      ]);
      expect(run.sessions[0].duration_ms).toBeLessThan(60_000);
      const [edit] = run.sessions[0].controller_edits;
      expect(edit).toMatchObject({ tool: 'Write', action: 'Write', path: expect.stringMatching(/\.mycelink\/worktrees\/[^/]+TOY-001\.mod-a\.impl\/\.mycelink-worker\/result-[0-9a-f-]+\.json$/) });
      const v1 = run.sessions[0].violation;
      expect(v1.discarded).toEqual([expect.objectContaining({ node_id: 'TOY-001.mod-a.impl', discarded: true, archived_ref: expect.stringMatching(/^refs\/mycelink\/archive\//) })]);
      expect(run.sessions[0].controller_txn.contaminated).toEqual([expect.stringMatching(/platform\/\.mycelink\/worktrees\/[^/]+TOY-001\.mod-a\.impl$/)]);
      const repo = join(run.workspace, 'repos', 'toyshop');
      const inRepo = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
      const archived = v1.discarded[0].archived_ref;
      expect(existsSync(v1.discarded[0].worktree)).toBe(false);
      // The corrective prompt names the discarded dispatch; /mycelink:run comes first.
      const [, corrective] = fake.entries();
      expect(corrective.prompt).toBe(taskCorrectivePrompt(fake.entries()[0].prompt, { summary: v1.summary, mode: v1.mode, discarded: ['TOY-001.mod-a.impl'] }, 'TOY-001'));
      expect(corrective.prompt.startsWith(TASK_CORRECTIVE_PROMPT)).toBe(true);
      // A fresh, genuine worker: a new claim on a new branch, RED -> GREEN -> regression, its own commits only.
      const calls = callsOf(run.sessions[1].transcript);
      const top = calls.filter((c: any) => c.parent === null);
      expect(top.some((c: any) => c.name === 'Bash' && / controller open --recover /.test(c.input.command))).toBe(true);
      const agent = top.find((c: any) => c.name === 'Agent' && c.input.description === 'TOY-001.mod-a.impl');
      expect(calls.filter((c: any) => c.parent === agent.id).map((c: any) => /\btdd (red|green|regression)\b/.exec(c.input.command ?? '')?.[1] ?? (/ commit /.test(c.input.command ?? '') ? 'commit' : null)).filter(Boolean)).toEqual(['red', 'commit', 'green', 'commit', 'regression']);
      expect(run.sessions[1].violation ?? null).toBeNull();
      const head = inRepo(['rev-parse', 'main']);
      expect(run.mycelink).toMatchObject({ complete: true, candidate: 'TOY-001-C001', candidate_sha: head });
      expect(inRepo(['branch', '--contains', archived])).toBe('');
      expect(run.controller).toMatchObject({
        ok: true,
        failures: [],
        recovered: [expect.stringMatching(/^controller-violation: session 1 \(task\) changed the workspace itself: .*\.mycelink-worker\/result-[0-9a-f-]+\.json .*rolled back \(selective, verified\); the dispatch of TOY-001\.mod-a\.impl discarded through Mycelink\. Recovered by session 2 \(corrective\), which completed it through Mycelink to TOY-001-C001$/)],
      });
      // Attested: the dispatch discarded, nothing the controller wrote into the worktree left.
      expect(run.controller_rollbacks).toMatchObject({ ok: true, problems: [], sessions: [{ session: 1, ok: true, mode: 'selective', manifest_sha256: v1.manifest_sha256 }] });
      expect(run.trust.problems.filter((p: string) => /controller rollback/.test(p))).toEqual([]);
      const v = JSON.parse(readFileSync(run.verification, 'utf8'));
      expect(failingOf(v)).toEqual([]);
      expect(v.ok).toBe(true);
      expect(run.ok).toBe(true);
    }, 900_000);

    it('a third violation ends the task: two corrective sessions at most', async () => {
      const fake = hostPlan({ taskTakeover: [true, true, true], hooks: false });
      const run = await arm('with', fake, { claude: [process.execPath, FAKE_HOST], requireMycelink: true, requireTdd: true, lightCheckMs: 300 });
      expect(run.sessions.map((s: any) => [s.index, s.purpose, s.ended_by]), checksFound(run)).toEqual([
        [1, 'task', 'controller-violation'],
        [2, 'corrective', 'controller-violation'],
        [3, 'corrective', 'controller-violation'],
      ]);
      expect(run.sessions[2].terminal).toBe('corrective-limit');
      expect(run.controller.ok).toBe(false);
      expect(run.controller.recovered).toEqual([]);
      expect(run.controller.failures).toHaveLength(3);
      expect(run.controller.failures[2]).toMatch(/The phase ended: no corrective session is left\./);
      expect(run.controller_rollbacks).toMatchObject({ ok: true, problems: [], sessions: [{ session: 1, ok: true }, { session: 2, ok: true }, { session: 3, ok: true }] });
      expect(run.ok).toBe(false);
    }, 900_000);
  });
});

