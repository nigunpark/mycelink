/**
 * Regressions for the adversarial review of the host-dispatch tranche.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { commitAll, git } from '../helpers/git-fixture.js';
import { FEATURE_ID, commitControl, createPortfolio, portfolioGraph, writePrd, type Portfolio } from '../helpers/portfolio-fixture.js';
import { fakeAgent } from '../helpers/host-agent.js';
import { CORE, WORK, cli, dispatch, hostLoop, hostPortfolio, settle } from '../helpers/host-loop.js';
import { loadState, mutateState } from '../../src/state/feature-state.js';
import { Orchestrator } from '../../src/engine/orchestrator.js';
import { FakeInProcessAdapter } from '../../src/sessions/fake-adapter.js';
import { createCandidate, verifyCandidate } from '../../src/git/candidate.js';
import { workerBranchName } from '../../src/git/worktree.js';

afterAll(() => cleanupTmpRoots());

describe('review findings', () => {
  it('integrates exactly the commit fresh verification checked, never a later one', async () => {
    const p = await hostPortfolio();
    const t = (await dispatch(p)).ticket!;
    fakeAgent(t, WORK[CORE]!, p.control);
    const o = new Orchestrator({ controlRoot: p.control, featureId: FEATURE_ID, adapter: new FakeInProcessAdapter({}) });
    const verified = o.freshVerify(CORE);
    expect(verified.ok).toBe(true);
    expect(verified.sha).toBe(git(p.core, ['rev-parse', workerBranchName(FEATURE_ID, CORE)]));
    // A leftover process commits to the node branch after verification.
    writeFileSync(join(t.worktree!, 'src', 'sneaky.js'), 'unverified');
    commitAll(t.worktree!, 'after verification');
    expect(() => o.integrate(CORE, verified.sha!)).toThrow(/NODE_BRANCH_MOVED/);
  });

  it('adapter session logs redact the claim capability the worker environment carries', async () => {
    const p = createPortfolio();
    writePrd(p);
    writeFileSync(join(p.featureDir, 'PORTFOLIO-GRAPH.yaml'), YAML.stringify(portfolioGraph(), { lineWidth: 0 }));
    expect((await cli(p, ['feature', 'init', FEATURE_ID])).code).toBe(0);
    commitControl(p, 'scaffold');
    writeFileSync(p.scenarioFile, JSON.stringify({ default: { outcome: 'SUBMITTED', turns: 1, print_env: ['MYCELINK_CLAIM_TOKEN'] } }));
    process.env['FAKE_CLAUDE_SCENARIO'] = p.scenarioFile;
    try {
      await cli(p, ['orchestrate', 'once', FEATURE_ID]);
    } finally {
      delete process.env['FAKE_CLAUDE_SCENARIO'];
    }
    const dir = join(p.featureDir, 'sessions', CORE);
    const log = readdirSync(dir).find((f) => f.endsWith('.log'))!;
    const text = readFileSync(join(dir, log), 'utf8');
    expect(text).toContain('[REDACTED:MYCELINK_CLAIM_TOKEN]');
    expect(text).not.toMatch(/MYCELINK_CLAIM_TOKEN=[0-9a-f]{64}/);
  });

  it('a worker cannot attest controller-only evidence kinds', async () => {
    const p = await hostPortfolio();
    const t = (await dispatch(p)).ticket!;
    for (const kind of ['review', 'e2e', 'candidate', 'regression']) {
      const r = await cli(p, ['evidence', 'record', FEATURE_ID, CORE, '--kind', kind, '--capability', t.capability, '--', 'node', '-e', '0']);
      expect(`${kind}: ${r.err}`).toMatch(/EVIDENCE_KIND_NOT_ALLOWED/);
    }
    expect(loadState(p.featureDir)!.data.nodes[CORE]!.evidence).toEqual({});
  });

  it('checkpoint restore needs a recorded decision and never revives a claim', async () => {
    const p = await hostPortfolio();
    await dispatch(p);
    const created = JSON.parse((await cli(p, ['checkpoint', 'create', FEATURE_ID, '--json'])).out) as { path: string };
    const name = created.path.split(/[\\/]/).pop()!;
    const refused = await cli(p, ['checkpoint', 'restore', FEATURE_ID, name]);
    expect(refused.err).toMatch(/DECISION_REQUIRED|DECISION_NOT_RECORDED/);
    expect((await cli(p, ['decision', 'record', FEATURE_ID, 'DEC-restore', '--answer', 'roll back'])).code).toBe(0);
    expect((await cli(p, ['checkpoint', 'restore', FEATURE_ID, name, '--decision', 'DEC-restore'])).code).toBe(0);
    const rt = loadState(p.featureDir)!.data.nodes[CORE]!;
    expect(rt.claim).toBeNull();
    expect(rt.state).toBe('READY');
  });

  it('a recorded decision unblocks once; replaying it is refused', async () => {
    const p = await hostPortfolio();
    const park = (): void =>
      mutateState(p.featureDir, (s) => {
        s.nodes[CORE]!.state = 'BLOCKED';
        s.nodes[CORE]!.blocked_reason = 'x';
        return s;
      });
    park();
    expect((await cli(p, ['decision', 'record', FEATURE_ID, 'DEC-1', '--answer', 'ok'])).code).toBe(0);
    expect((await cli(p, ['decision', 'apply', FEATURE_ID, 'DEC-1'])).code).toBe(0);
    park();
    const again = await cli(p, ['decision', 'apply', FEATURE_ID, 'DEC-1']);
    expect(again.err).toMatch(/DECISION_ALREADY_APPLIED/);
    const inv = await cli(p, ['node', 'invalidate', FEATURE_ID, CORE, '--decision', 'DEC-1']);
    expect(inv.err).toMatch(/DECISION_ALREADY_APPLIED/);
    expect(loadState(p.featureDir)!.data.nodes[CORE]!.state).toBe('BLOCKED');
  });

  it('candidate inputs ignore controller temp files but notice a re-pointed symlink', async (ctx) => {
    const p = createPortfolio();
    writePrd(p);
    const target1 = join(p.control, 'contracts', 'order-status.json');
    try {
      symlinkSync('order-status.json', join(p.control, 'contracts', 'alias.json'), 'file');
    } catch {
      ctx.skip();
    }
    commitControl(p, 'alias');
    const refs = [{ name: 'core', path: p.core, branch: 'main' }];
    const m = createCandidate({ controlRepo: p.control, featureDir: p.featureDir, featureId: FEATURE_ID, repositories: refs, contracts: [] });
    writeFileSync(join(p.featureDir, 'STATE.json.tmp-123-abcdef'), '{}');
    expect(verifyCandidate(m, { controlRepo: p.control, repositories: refs }).problems).toEqual([]);
    writeFileSync(join(p.control, 'contracts', 'other.json'), '{}');
    git(p.control, ['rm', '-q', 'contracts/alias.json']);
    symlinkSync('other.json', join(p.control, 'contracts', 'alias.json'), 'file');
    void target1;
    expect(verifyCandidate(m, { controlRepo: p.control, repositories: refs }).problems.map((x) => x.code)).toContain('CONTROL_INPUT_DRIFT');
  });

  it('node verify is a controller check that cannot overwrite settled evidence', async () => {
    const p = await hostPortfolio();
    expect((await hostLoop(p)).status).toBe('ALL_SETTLED');
    expect((await cli(p, ['node', 'verify', FEATURE_ID, CORE, '--capability', 'a'.repeat(64)])).err).toMatch(/ROLE_DENIED/);
    await cli(p, ['node', 'verify', FEATURE_ID, CORE]);
    expect((await cli(p, ['feature', 'verify', FEATURE_ID])).code).toBe(0);
  });

  it('evidence is never written through a link planted at its output path', async (ctx) => {
    const p = await hostPortfolio();
    const t = (await dispatch(p)).ticket!;
    const outside = join(p.root, 'victim.txt');
    writeFileSync(outside, 'untouched');
    const dir = join(p.featureDir, 'evidence', CORE);
    mkdirSync(dir, { recursive: true });
    try {
      symlinkSync(outside, join(dir, `${CORE}.red.log`), 'file');
    } catch {
      ctx.skip();
    }
    await cli(p, ['tdd', 'red', FEATURE_ID, CORE, '--capability', t.capability]);
    expect(readFileSync(outside, 'utf8')).toBe('untouched');
    expect(existsSync(join(dir, `${CORE}.red.log`))).toBe(true);
    void settle;
  });
});
