/**
 * A module-worker's stash, at settlement (CSET-203 r12).
 *
 * Git worktrees share their repository's stash (`refs/stash` and its reflog
 * live in the common Git directory). r12's module-worker set its production
 * edit aside with `git stash` — as the red gate's refusal told it to — and
 * popped it back; a worker that leaves an entry behind leaves the shared
 * stash holding work nothing integrates, under every other worktree's
 * `git stash pop`. Settle and discard therefore quarantine every entry the
 * claim's worktree made — archived under `refs/mycelink/archive/`, so nothing
 * is lost, and dropped from the stash — and leave every other entry exactly
 * as it was: a stash the user or another worktree made keeps its ref and
 * its reflog line byte for byte. An entry is the worktree's by what Git
 * wrote into it: made on the claim's branch (`WIP on <branch>:` / `On
 * <branch>:`), from a commit of that branch.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { git } from '../helpers/git-fixture.js';
import { ERRORS, ERRORS_IMPL, SHOP_CRITERIA, SHOP_FEATURE, SHOP_WORK, createShop, moduleVerifier, shopCli, shopGraph, type Shop } from '../helpers/shop-fixture.js';
import { fulfil, writeFiles, type ShopTicket } from '../helpers/shop-worker.js';

afterAll(() => cleanupTmpRoots());

const SRC = 'packages/errors/src/index.mjs';
const stashLog = (s: Shop) => join(s.repo, '.git', 'logs', 'refs', 'stash');
const stashRef = (s: Shop) => {
  const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/stash'], { cwd: s.repo, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
};
/** The stash as Git keeps it: the ref and its reflog's bytes (null when absent). */
const stashState = (s: Shop) => ({ ref: stashRef(s), log: existsSync(stashLog(s)) ? readFileSync(stashLog(s)).toString('base64') : null });

/** A user's own stash in the repository's checkout, made before the feature's worker ran. */
function userStash(s: Shop, message: string): string {
  writeFileSync(join(s.repo, 'README.md'), `# shop\n${message}\n`);
  git(s.repo, ['stash', 'push', '-q', '-m', message]);
  return git(s.repo, ['rev-parse', 'refs/stash']);
}

async function dispatchErrors(s: Shop): Promise<ShopTicket> {
  return (JSON.parse((await shopCli(s, ['dispatch', SHOP_FEATURE, '--json'])).out) as { ticket: ShopTicket }).ticket;
}

/** The worker sets a production draft aside with `git stash` and never pops it, then does its work as given. */
function workLeavingStash(t: ShopTicket, s: Shop): string {
  writeFiles(t.worktree, { [SRC]: `${ERRORS_IMPL}\n// draft\n` });
  git(t.worktree, ['stash', 'push', '-q', '-m', 'draft before RED']);
  const entry = git(t.worktree, ['rev-parse', 'refs/stash']);
  fulfil(t, { ...SHOP_WORK[ERRORS]!, criteria: SHOP_CRITERIA[ERRORS]!.map((c) => ({ criterion: c.criterion, gate: c.gate, full_name: c.name })) }, s.control);
  return entry;
}

describe('a module-worker’s stash at settlement', () => {
  it('an entry the worker left is archived and dropped; the user’s stash beneath it keeps its ref and reflog byte for byte', async () => {
    const s = await createShop({ modules: 'structured', graph: shopGraph(moduleVerifier()) });
    userStash(s, 'user wip');
    const before = stashState(s);
    const t = await dispatchErrors(s);
    const entry = workLeavingStash(t, s);
    expect(stashRef(s)).toBe(entry);
    const r = await shopCli(s, ['settle', SHOP_FEATURE, ERRORS, '--capability', t.capability, '--json']);
    expect(r.err).toBe('');
    const report = JSON.parse(r.out) as Record<string, any>;
    expect(report.outcome).toBe('DONE');
    // Archived where Mycelink keeps evidence, never integrated: nothing the worker made is lost.
    expect(report.stash).toEqual({ quarantined: [{ sha: entry, ref: expect.stringMatching(new RegExp(`^refs/mycelink/archive/${SHOP_FEATURE}/.+/stash/${entry}$`)), message: expect.stringMatching(/draft before RED/) }], remaining: 1 });
    expect(git(s.repo, ['rev-parse', report.stash.quarantined[0].ref])).toBe(entry);
    // The stash is the user's again, exactly.
    expect(stashState(s)).toEqual(before);
    expect(git(s.repo, ['stash', 'list', '--format=%s'])).toBe('On main: user wip');
    const events = readFileSync(join(s.featureDir, 'events.jsonl'), 'utf8');
    expect(events).toMatch(/"type":"node\.stash_quarantined"/);
  });

  it('an entry left on top of nothing: the stash is gone again, ref and reflog', async () => {
    const s = await createShop({ modules: 'structured', graph: shopGraph(moduleVerifier()) });
    const t = await dispatchErrors(s);
    const entry = workLeavingStash(t, s);
    const report = JSON.parse((await shopCli(s, ['settle', SHOP_FEATURE, ERRORS, '--capability', t.capability, '--json'])).out) as Record<string, any>;
    expect(report.outcome).toBe('DONE');
    expect(report.stash.quarantined.map((q: any) => q.sha)).toEqual([entry]);
    expect(stashState(s)).toEqual({ ref: null, log: null });
  });

  it('an entry another hand made above the worker’s stays as it was, its reflog line untouched', async () => {
    const s = await createShop({ modules: 'structured', graph: shopGraph(moduleVerifier()) });
    const t = await dispatchErrors(s);
    const entry = workLeavingStash(t, s);
    // The user stashes in the checkout after the worker: the newest entry is not the worker's.
    const user = userStash(s, 'user wip after');
    const userLine = readFileSync(stashLog(s), 'utf8').split('\n').filter(Boolean).at(-1);
    const report = JSON.parse((await shopCli(s, ['settle', SHOP_FEATURE, ERRORS, '--capability', t.capability, '--json'])).out) as Record<string, any>;
    expect(report.stash.quarantined.map((q: any) => q.sha)).toEqual([entry]);
    expect(stashRef(s)).toBe(user);
    expect(readFileSync(stashLog(s), 'utf8')).toBe(`${userLine}\n`);
  });

  it('a worker that popped its own entry leaves nothing to quarantine', async () => {
    const s = await createShop({ modules: 'structured', graph: shopGraph(moduleVerifier()) });
    userStash(s, 'user wip');
    const before = stashState(s);
    const t = await dispatchErrors(s);
    writeFiles(t.worktree, { [SRC]: `${ERRORS_IMPL}\n// draft\n` });
    git(t.worktree, ['stash', 'push', '-q', '-m', 'draft before RED']);
    git(t.worktree, ['stash', 'pop', '-q']);
    git(t.worktree, ['checkout', '--', SRC]);
    fulfil(t, { ...SHOP_WORK[ERRORS]!, criteria: SHOP_CRITERIA[ERRORS]!.map((c) => ({ criterion: c.criterion, gate: c.gate, full_name: c.name })) }, s.control);
    const report = JSON.parse((await shopCli(s, ['settle', SHOP_FEATURE, ERRORS, '--capability', t.capability, '--json'])).out) as Record<string, any>;
    expect(report.outcome).toBe('DONE');
    expect(report.stash).toBeUndefined();
    expect(stashState(s)).toEqual(before);
  });

  it('discarding a dispatch quarantines what its worktree left in the stash too', async () => {
    const s = await createShop({ modules: 'structured', graph: shopGraph(moduleVerifier()) });
    userStash(s, 'user wip');
    const before = stashState(s);
    const t = await dispatchErrors(s);
    writeFiles(t.worktree, { [SRC]: `${ERRORS_IMPL}\n// draft\n` });
    git(t.worktree, ['stash', 'push', '-q']);
    const entry = git(t.worktree, ['rev-parse', 'refs/stash']);
    const r = await shopCli(s, ['node', 'discard', SHOP_FEATURE, ERRORS, '--capability', t.capability, '--reason', 'controller violation', '--json']);
    expect(r.err).toBe('');
    const report = JSON.parse(r.out) as Record<string, any>;
    expect(report.stash.quarantined.map((q: any) => q.sha)).toEqual([entry]);
    expect(stashState(s)).toEqual(before);
  });
});
