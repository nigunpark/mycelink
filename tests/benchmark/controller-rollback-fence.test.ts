/**
 * The with arm's controller sessions as transactions (CSET-203 r9), the
 * changes themselves: a controller that writes, deletes, renames, re-modes,
 * replaces or commits in the workspace where the plugin's fence never sees
 * it is found by the workspace, rolled back exactly (or the whole session,
 * when Mycelink read it), and a corrective session completes C001. The rest
 * of the transaction is in controller-rollback.test.ts; the shared setup in
 * rollback-fixture.ts.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { hostPlan, run, shape, found, recovered, useRollbackFixture } from './rollback-fixture.js';

useRollbackFixture();

describe('a controller that changes the workspace itself, outside the fence', () => {
  it('CSET-203 r9: a helper script writes ACCEPTANCE.json through a path it computes — both rolled back, Mycelink’s init kept; the corrective session completes C001 and recovers the key', async () => {
    const fake = hostPlan({ forgeries: ['r9'] });
    const r = await run(fake);
    expect(shape(r), found(r)).toEqual([
      [1, 'task', 'controller-violation', null, true],
      [2, 'corrective', 'exit', 1, false],
    ]);
    const [first] = r.sessions;
    // Stopped by what it wrote, within seconds, though the transcript names no path for it.
    expect(first.duration_ms).toBeLessThan(60_000);
    expect(first.controller_edits).toEqual([expect.objectContaining({ unknown: true, action: 'python3 gen.py' })]);
    // What the check that stopped it saw: the workspace, by path and kind.
    expect(first.controller_txn.stopped_for.unauthorized).toEqual(expect.arrayContaining(['platform/features/TOY-001/ACCEPTANCE.json (created; mycelink-state)']));
    expect(first.violation).toMatchObject({ mode: 'selective', verified: true, summary: ['platform/features/TOY-001/ACCEPTANCE.json (created; a Mycelink-managed file)', 'platform/gen.py (created; a helper or scratch file in the workspace)'] });
    expect(first.controller_txn.rollback).toMatchObject({ verified: true, removed: ['platform/features/TOY-001/ACCEPTANCE.json', 'platform/gen.py'], plan_sha256: expect.stringMatching(/^[0-9a-f]{64}$/), manifest_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(first.controller_txn.authorized).toMatchObject({ core: expect.any(Number) });
    // The transaction's files are the evaluator's, outside the workspace.
    expect(first.controller_txn.dir.startsWith(r.workspace)).toBe(false);
    expect(existsSync(join(first.controller_txn.dir, 'result.json'))).toBe(true);
    recovered(r, fake);
    // The corrective session found Mycelink initialised and recovered the key the stopped session held.
    expect(r.controller.authority_recovered).toBe(true);
    expect(r.mycelink.authority_recovered).toBe(true);
    expect(fake.entries()[1].prompt).toContain('- platform/features/TOY-001/ACCEPTANCE.json (created; a Mycelink-managed file)');
  }, 900_000);

  it('the same, when the session ends on its own: the violation is found after it', async () => {
    const fake = hostPlan({ forgeries: ['r9-exit'] });
    // No periodic check in the session's last moments: the settlement finds it.
    const r = await run(fake, { lightCheckMs: 600_000 });
    expect(shape(r), found(r)).toEqual([
      [1, 'task', 'exit', null, true],
      [2, 'corrective', 'exit', 1, false],
    ]);
    recovered(r, fake);
  }, 900_000);

  it.each([
    ['a deleted core-managed file is restored', 'delete', 'platform/features/TOY-001/events.jsonl (deleted; a Mycelink-managed file)', (ws: string) => expect(existsSync(join(ws, 'platform', 'features', 'TOY-001', 'events.jsonl'))).toBe(true)],
    ['a renamed one is restored and its new name removed', 'rename', 'platform/features/TOY-001/events.jsonl (deleted; a Mycelink-managed file)', (ws: string) => expect(existsSync(join(ws, 'platform', 'features', 'TOY-001', 'events.jsonl.bak'))).toBe(false)],
    ['a mode change is reverted', 'chmod', 'platform/mycelink.config.json (', (ws: string) => expect(statSync(join(ws, 'platform', 'mycelink.config.json')).mode & 0o200).not.toBe(0)],
    ['a file replaced by a symlink is a file again', 'symlink', 'platform/requirements/TOY-001.md (type; ', (ws: string) => expect(lstatSync(join(ws, 'platform', 'requirements', 'TOY-001.md')).isSymbolicLink()).toBe(false)],
    ['a commit on main in the product repository goes back, branch, index and files', 'commit', 'repos/toyshop/.git:refs/heads/main (moved from ', (ws: string) => expect(execFileSync('git', ['log', '--format=%s', 'main'], { cwd: join(ws, 'repos', 'toyshop'), encoding: 'utf8' })).not.toMatch(/fix it myself/)],
    ['a background helper’s later write is caught by the workspace check', 'helper', 'platform/features/TOY-001/LOOPS.json (created; a Mycelink-managed file)', (ws: string) => expect(existsSync(join(ws, 'platform', 'features', 'TOY-001', 'LOOPS.json'))).toBe(false)],
  ])('%s', async (_label, kind, line, check) => {
    const fake = hostPlan({ forgeries: [kind] });
    const r = await run(fake);
    expect(shape(r), found(r)).toEqual([
      [1, 'task', 'controller-violation', null, true],
      [2, 'corrective', 'exit', 1, false],
    ]);
    expect(r.sessions[0].violation.summary.some((l: string) => l.startsWith(line)), JSON.stringify(r.sessions[0].violation.summary)).toBe(true);
    expect(r.sessions[0].violation.verified).toBe(true);
    check(r.workspace);
    recovered(r, fake);
  }, 900_000);

  it('a module-worker’s settle that completed meanwhile stays: only the controller’s own change goes back', async () => {
    const fake = hostPlan({ forgeries: ['after-settle'] });
    const r = await run(fake);
    expect(shape(r), found(r)).toEqual([
      [1, 'task', 'controller-violation', null, true],
      [2, 'corrective', 'exit', 1, false],
    ]);
    expect(r.sessions[0].violation).toMatchObject({ mode: 'selective', summary: ['notes.txt (created; a helper or scratch file in the workspace)'] });
    expect(r.sessions[0].controller_txn.authorized).toMatchObject({ core: expect.any(Number), worker: expect.any(Number) });
    // The corrective session's workers: mod-b only — mod-a's settle survived the rollback.
    const calls = readFileSync(r.sessions[1].transcript, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === 'assistant').flatMap((e) => e.message.content.filter((c: any) => c.type === 'tool_use' && c.name === 'Agent').map((c: any) => c.input.description));
    expect(calls.filter((d: string) => d.startsWith('TOY-001.mod'))).toEqual(['TOY-001.mod-b.impl']);
    expect(existsSync(join(r.workspace, 'notes.txt'))).toBe(false);
    recovered(r, fake);
  }, 900_000);

  it('a change a Mycelink step then read: the session is rebuilt as it stood just before that step — what Mycelink did before it is kept, and the corrective session continues from there', async () => {
    // The first worker waits after its RED, so the session is stopped there however fast the host — before delivery
    // changes the checkout's index, whose bytes a rebuild never keeps (past that, the session goes back whole).
    const fake = hostPlan({ forgeries: ['registry'], taskStalls: ['red'] });
    // Checked seldom enough that Mycelink's next step reads the change before a second check sees it persist.
    const r = await run(fake, { lightCheckMs: 5000 });
    expect(shape(r), found(r)).toEqual([
      [1, 'task', 'controller-violation', null, true],
      [2, 'corrective', 'exit', 1, false],
    ]);
    const txn = r.sessions[0].controller_txn;
    expect(r.sessions[0].violation).toMatchObject({ mode: 'full', verified: true, reconstruction: { cut_at: expect.any(String) } });
    expect(txn.dependencies).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'platform/repositories.yaml' })]));
    expect(txn.ambiguous).toEqual(expect.arrayContaining([expect.stringMatching(/^the core read platform\/repositories\.yaml after it changed/)]));
    // Not back to how the session began: Mycelink's own steps before the cut (init, the key, the registered project) stay.
    expect(txn.rollback.reconstruction).toMatchObject({ cut: expect.stringMatching(/^\d+$/) });
    expect(txn.rollback.digest).not.toBe(txn.pre_digest);
    expect(readFileSync(join(r.workspace, 'platform', 'repositories.yaml'), 'utf8')).not.toContain('# mine');
    expect(readFileSync(join(r.workspace, 'platform', 'repositories.yaml'), 'utf8')).toContain('toyshop');
    expect(fake.entries()[1].prompt).toMatch(/taken back to just before its first step that read those changes/);
    recovered(r, fake);
  }, 900_000);
});
