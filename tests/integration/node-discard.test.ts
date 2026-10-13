/**
 * Discarding a dispatch the controller reached into.
 *
 * CSET-202 r2: the controller rewrote a running node's result slot itself,
 * and the node settled DONE on that result. When the benchmark's monitor
 * (or an operator) finds a controller write into a dispatch, nothing that
 * dispatch holds can be trusted, however its hashes look: `node discard`,
 * presented with the claim's current capability (its holder may always give
 * it up), hands the claim back unspent as an interruption, removes its
 * worktree and result slot, archives its branch, forgets its gate evidence
 * and RED bindings, and makes the node's next claim start a fresh branch from
 * the integration head — so the next worker is a genuine one. A node whose
 * claim already integrated is refused: discarding cannot undo integration.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { git } from '../helpers/git-fixture.js';
import { ERRORS, SHOP_FEATURE, SHOP_WORK, createShop, moduleVerifier, shopCli, shopGraph, shopState } from '../helpers/shop-fixture.js';
import { packOf, runGate, writeFiles, type ShopTicket } from '../helpers/shop-worker.js';

afterAll(() => cleanupTmpRoots());

describe('node discard', () => {
  it('hands the claim back unspent, removes its worktree, archives its branch and forgets its evidence; the next worker starts afresh', async () => {
    const s = await createShop({ modules: 'structured', graph: shopGraph(moduleVerifier()) });
    const t = (JSON.parse((await shopCli(s, ['dispatch', SHOP_FEATURE, '--json'])).out) as { ticket: ShopTicket }).ticket;
    // A RED was recorded and committed before the controller reached into the dispatch.
    writeFiles(t.worktree, SHOP_WORK[ERRORS]!.tests);
    expect(runGate(t, 'red', s.control).code).toBe(0);
    execSync(`git -C "${t.worktree}" add -A && git -C "${t.worktree}" commit -qm "test: RED"`);
    const head = git(t.worktree, ['rev-parse', 'HEAD']);
    const r = await shopCli(s, ['node', 'discard', SHOP_FEATURE, ERRORS, '--capability', t.capability, '--reason', 'controller violation: Write of the result slot (1-task.jsonl:42)', '--json']);
    expect(r.err).toBe('');
    const report = JSON.parse(r.out) as Record<string, unknown>;
    expect(report).toMatchObject({ node_id: ERRORS, discarded: true, claim_id: t.claim_id, state: 'READY', worktree: t.worktree, archived_ref: expect.stringMatching(/^refs\/mycelink\/archive\/SHOP-202\//) });
    expect(git(s.repo, ['rev-parse', report['archived_ref'] as string])).toBe(head);
    expect(existsSync(t.worktree)).toBe(false);
    const rt = shopState(s).nodes[ERRORS];
    expect(rt).toMatchObject({ state: 'READY', claim: null, attempts: 0, evidence: {}, tdd_red_bindings: [], fresh_branch_required: true, failure_counts: {} });
    expect(rt.interruptions).toBe(1);
    // The capability is spent.
    const again = await shopCli(s, ['node', 'discard', SHOP_FEATURE, ERRORS, '--capability', t.capability, '--reason', 'again', '--json']);
    expect(again.code).not.toBe(0);
    // The next worker starts a fresh branch from the integration head, and must prove its own RED.
    const next = (JSON.parse((await shopCli(s, ['dispatch', SHOP_FEATURE, '--json'])).out) as { ticket: ShopTicket }).ticket;
    expect(next.node_id).toBe(ERRORS);
    expect(next.claim_id).not.toBe(t.claim_id);
    expect(git(next.worktree, ['rev-parse', 'HEAD'])).toBe(git(s.repo, ['rev-parse', 'main']));
    expect(packOf(next)['next_required_gate']).toBe('RED_VERIFIED');
    const events = (await shopCli(s, ['feature', 'status', SHOP_FEATURE, '--json'])).out;
    expect(events).toBeTruthy();
  });

  it('is refused without the claim capability', async () => {
    const s = await createShop({ modules: 'structured', graph: shopGraph(moduleVerifier()) });
    const t = (JSON.parse((await shopCli(s, ['dispatch', SHOP_FEATURE, '--json'])).out) as { ticket: ShopTicket }).ticket;
    const r = await shopCli(s, ['node', 'discard', SHOP_FEATURE, ERRORS, '--capability', 'f'.repeat(64), '--reason', 'x', '--json']);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/CAPABILITY/);
    expect(shopState(s).nodes[ERRORS].claim?.claim_id).toBe(t.claim_id);
  });
});
