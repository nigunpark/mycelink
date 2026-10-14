/**
 * The with arm's controller sessions as transactions, end to end on the toy
 * (CSET-203 r9): a stand-in Mycelink host whose controller changes the
 * workspace itself where the plugin's fence never sees it. The harness finds
 * what it changed by the workspace, not the transcript; rolls back exactly
 * that (or, when Mycelink may have read it, the whole session), verifies the
 * rollback, and starts a fresh corrective session told that nothing is left
 * to clean up — whose first action is `/mycelink:run` — which completes the
 * feature through Mycelink. Two independent violations get two corrective
 * sessions; an identical repeat ends the phase. Each kind of change the
 * controller makes is in controller-rollback-fence.test.ts; the shared setup in
 * rollback-fixture.ts.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostPlan, run, failingOf, shape, found, recovered, useRollbackFixture } from './rollback-fixture.js';

useRollbackFixture();

describe('CSET-203 r12: a module-worker’s own stash, through the plugin’s hooks', () => {
  const stashOf = (ws: string) => execFileSync('git', ['stash', 'list'], { cwd: join(ws, 'repos', 'toyshop'), encoding: 'utf8' }).trim();

  it.each([
    ['pops its own entry back', false],
    ['leaves its entry: settle archives and drops it', true],
  ])('the worker sets its production draft aside with git stash, re-proves RED, %s — authorised, on record; the session goes on and delivers C001', async (_label, leave) => {
    const fake = hostPlan({ hooks: true, workerStash: { 'mod-a': { leave } } });
    const r = await run(fake);
    expect(shape(r), found(r)).toEqual([[1, 'task', 'exit', null, false]]);
    const [first] = r.sessions;
    expect(first.controller_txn, found(r)).toMatchObject({ violation: false, mode: 'none', unauthorized: [], ambiguous: [] });
    expect(first.controller_txn.authorized['worker-git']).toBe(1);
    expect(first.controller_txn.worker_git).toEqual([expect.objectContaining({ path: 'repos/toyshop/.git:refs/stash', workers: [expect.objectContaining({ node_id: 'TOY-001.mod-a.impl' })] })]);
    expect(first.controller_txn.calls).toMatchObject({ intact: true });
    expect(fake.entries().filter((e) => e.stash)).toEqual([{ stash: { node: 'TOY-001.mod-a.impl', left: leave, entries: leave ? 1 : 0 } }]);
    const head = execFileSync('git', ['rev-parse', 'main'], { cwd: join(r.workspace, 'repos', 'toyshop'), encoding: 'utf8' }).trim();
    expect(r.mycelink).toMatchObject({ complete: true, candidate: 'TOY-001-C001', candidate_sha: head });
    expect(r.controller).toMatchObject({ ok: true, violations: [] });
    expect(failingOf(JSON.parse(readFileSync(r.verification, 'utf8')))).toEqual([]);
    expect(r.ok).toBe(true);
    // Nothing set aside is live at the end: popped, or archived by settle.
    expect(stashOf(r.workspace)).toBe('');
  }, 900_000);

  it('a record the controller forges into Mycelink’s provenance ledger is a violation: stopped at once, the session rolled back whole, a corrective session completes C001', async () => {
    const fake = hostPlan({ forgeries: ['ledger'] });
    const r = await run(fake);
    expect(shape(r), found(r)).toEqual([
      [1, 'task', 'controller-violation', null, true],
      [2, 'corrective', 'exit', 1, false],
    ]);
    expect(r.sessions[0].controller_txn.stopped_for.forced).toEqual([expect.stringMatching(/^the controller wrote Mycelink's provenance ledger itself/)]);
    expect(r.sessions[0].violation).toMatchObject({ mode: 'full', verified: true, reconstruction: null });
    recovered(r, fake);
  }, 900_000);

  it('the controller’s own stash in the product checkout is still the controller’s: rolled back, a corrective session completes C001', async () => {
    const fake = hostPlan({ hooks: true, workerStash: { 'mod-a': {} }, forgeries: ['stash'] });
    const r = await run(fake);
    expect(shape(r), found(r)).toEqual([
      [1, 'task', 'controller-violation', null, true],
      [2, 'corrective', 'exit', 1, false],
    ]);
    expect(r.sessions[0].violation).toMatchObject({ mode: 'selective', verified: true, summary: [expect.stringMatching(/^repos\/toyshop\/\.git:refs\/stash \(moved from nothing to [0-9a-f]{12}; a product repository's ref\)$/)] });
    expect(stashOf(r.workspace)).toBe('');
    recovered(r, fake);
  }, 900_000);
});

describe('CSET-202 final: a host waiting on its background workers while they stash', () => {
  const stashOf = (ws: string) => execFileSync('git', ['stash', 'list'], { cwd: join(ws, 'repos', 'toyshop'), encoding: 'utf8' }).trim();
  // CSET-202's shape: each worker launched in the background, the host waiting on it in `sleep 100; echo waiting`, the
  // worker setting its draft aside beside the red gate (`cd <wt> && git stash push -q && <red>`) and popping it back with
  // its test commit — its entry live for checks of the workspace to see twice.
  const CSET202 = { hooks: true, asyncWorkers: true, hostWait: 'sleep 100; echo waiting', workerStash: { 'mod-a': { shape: 'cset202' }, 'mod-b': { shape: 'cset202' } } };
  const transitionsOf = (s: any) => s.controller_txn.worker_git.flatMap((g: any) => g.transitions.map((t: any) => [t.node_id, t.added.length, t.removed.length]));

  it('both workers push, run the red gate, commit and pop while the host waits — no check stops the session, no violation, C001 delivered', async () => {
    const fake = hostPlan(CSET202);
    const r = await run(fake);
    expect(shape(r), found(r)).toEqual([[1, 'task', 'exit', null, false]]);
    const [first] = r.sessions;
    expect(first.controller_txn.stopped_for).toBeUndefined();
    expect(first.controller_txn, found(r)).toMatchObject({ violation: false, mode: 'none', unauthorized: [], ambiguous: [] });
    expect(first.controller_txn.authorized['worker-git']).toBe(1);
    // Each push and pop, the worker's own, by the call that made it.
    expect(transitionsOf(first)).toEqual([
      ['TOY-001.mod-a.impl', 1, 0],
      ['TOY-001.mod-a.impl', 0, 1],
      ['TOY-001.mod-b.impl', 1, 0],
      ['TOY-001.mod-b.impl', 0, 1],
    ]);
    expect(fake.entries().filter((e) => e.stash).map((e) => e.stash)).toEqual([
      { node: 'TOY-001.mod-a.impl', shape: 'cset202', entries: 0 },
      { node: 'TOY-001.mod-b.impl', shape: 'cset202', entries: 0 },
    ]);
    const head = execFileSync('git', ['rev-parse', 'main'], { cwd: join(r.workspace, 'repos', 'toyshop'), encoding: 'utf8' }).trim();
    expect(r.mycelink).toMatchObject({ complete: true, candidate: 'TOY-001-C001', candidate_sha: head });
    expect(r.controller).toMatchObject({ ok: true, violations: [] });
    expect(failingOf(JSON.parse(readFileSync(r.verification, 'utf8')))).toEqual([]);
    expect(r.ok).toBe(true);
    expect(stashOf(r.workspace)).toBe('');
  }, 900_000);

  it('a restart and a compaction: the task session exits once mod-a settles; the fresh session’s mod-b worker stashes beside a compaction while the host waits — no violation, C001', async () => {
    const fake = hostPlan({ ...CSET202, taskExits: ['settled-one'], compact: true });
    const r = await run(fake);
    expect(shape(r), found(r)).toEqual([
      [1, 'task', 'exit', null, false],
      [2, 'resume', 'exit', null, false],
    ]);
    for (const s of r.sessions) {
      expect(s.controller_txn.stopped_for, `session ${s.index}`).toBeUndefined();
      expect(s.controller_txn, `session ${s.index} ${found(r)}`).toMatchObject({ violation: false, mode: 'none', unauthorized: [] });
    }
    expect(transitionsOf(r.sessions[0])).toEqual([
      ['TOY-001.mod-a.impl', 1, 0],
      ['TOY-001.mod-a.impl', 0, 1],
    ]);
    expect(transitionsOf(r.sessions[1])).toEqual([
      ['TOY-001.mod-b.impl', 1, 0],
      ['TOY-001.mod-b.impl', 0, 1],
    ]);
    // Both sessions' streams were compacted once, mid-entry.
    for (const s of r.sessions) expect(readFileSync(s.transcript, 'utf8')).toContain('"compact_boundary"');
    const head = execFileSync('git', ['rev-parse', 'main'], { cwd: join(r.workspace, 'repos', 'toyshop'), encoding: 'utf8' }).trim();
    expect(r.mycelink).toMatchObject({ complete: true, candidate: 'TOY-001-C001', candidate_sha: head });
    expect(r.controller.violations).toEqual([]);
    expect(r.ok).toBe(true);
    expect(stashOf(r.workspace)).toBe('');
  }, 900_000);
});

describe('corrective sessions are bounded', () => {
  it('the same violation again ends the task: no third session, the run fails on both', async () => {
    const fake = hostPlan({ forgeries: ['r9', 'r9'] });
    const r = await run(fake);
    expect(shape(r), found(r)).toEqual([
      [1, 'task', 'controller-violation', null, true],
      [2, 'corrective', 'controller-violation', 1, true],
    ]);
    expect(r.phases).toEqual([expect.objectContaining({ phase: 'task', ended_by: 'controller-violation' })]);
    expect(r.sessions[1].terminal).toBe('identical-violation');
    expect(r.sessions[1].violation.fingerprint).toBe(r.sessions[0].violation.fingerprint);
    expect(r.controller.ok).toBe(false);
    expect(r.controller.failures).toEqual([expect.stringMatching(/^controller-violation: session 1 \(task\)/), expect.stringMatching(/^controller-violation: session 2 \(corrective\).*The phase ended: the same violation as before\./)]);
    // Both rolled back and verified: the workspace holds nothing of either.
    expect(existsSync(join(r.workspace, 'platform', 'gen.py'))).toBe(false);
    expect(r.delivery.ok).toBe(false);
  }, 900_000);

  it('an independent second violation gets a second corrective session, which completes it: both recovered', async () => {
    const fake = hostPlan({ forgeries: ['r9', 'commit'] });
    const r = await run(fake);
    expect(shape(r), found(r)).toEqual([
      [1, 'task', 'controller-violation', null, true],
      [2, 'corrective', 'controller-violation', 1, true],
      [3, 'corrective', 'exit', 2, false],
    ]);
    expect(r.sessions[1].violation.fingerprint).not.toBe(r.sessions[0].violation.fingerprint);
    recovered(r, fake, 3);
  }, 900_000);
});
