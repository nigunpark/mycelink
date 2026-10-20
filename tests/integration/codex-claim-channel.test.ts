import { afterAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { makeTmpDir, cleanupTmpRoots } from '../helpers/tmp.js';
import { git, makeGitRepo } from '../helpers/git-fixture.js';
import { createWorkerWorktree } from '../../src/git/worktree.js';
import { ClaimChannel, type LiveClaim } from '../../src/sessions/codex-claim-channel.js';

afterAll(() => cleanupTmpRoots());

function fixture() {
  const root = makeTmpDir('codex-channel-');
  const repo = makeGitRepo(join(root, 'repo'), { files: { 'tests/a.test.js': 'old\n', 'src/a.js': 'old\n' } });
  const wt = createWorkerWorktree({ repoPath: repo, featureId: 'FEAT-101', nodeId: 'FEAT-101.api.impl', baseBranch: 'main', worktreeRoot: join(root, 'trees') }).worktree;
  let current = true;
  let nextGate: 'red' | 'green' | 'regression' = 'red';
  let gateExit = 0;
  const executed: string[][] = [];
  const live = (): LiveClaim | null => current ? {
    claimId: 'claim-1', featureId: 'FEAT-101', nodeId: 'FEAT-101.api.impl',
    repoPath: repo, worktree: wt, expectedHead: git(wt, ['rev-parse', 'HEAD']),
    allowedPaths: ['tests/**', 'src/**'], forbiddenPaths: ['src/forbidden.js'],
    nextGate, gateCommands: [
      { gate: 'red', argv: ['node', 'controller', 'tdd', 'red'] },
      { gate: 'green', argv: ['node', 'controller', 'tdd', 'green'] },
      { gate: 'regression', argv: ['node', 'controller', 'tdd', 'regression'] },
    ],
  } : null;
  const channel = new ClaimChannel(live, (argv) => { executed.push(argv); return { exitCode: gateExit, output: 'gate output' }; });
  const identity = { claimId: 'claim-1', featureId: 'FEAT-101', nodeId: 'FEAT-101.api.impl' };
  return { wt, channel, identity, executed, setCurrent: (v: boolean) => { current = v; }, setNext: (v: typeof nextGate) => { nextGate = v; }, setExit: (v: number) => { gateExit = v; } };
}

describe('claim-scoped controller channel core', () => {
  it('executes only live declared gate argv and commits only owned explicit paths', () => {
    const f = fixture();
    const gate = f.channel.handle({ ...f.identity, sequence: 1, operation: 'gate', gate: 'red' });
    expect(gate).toMatchObject({ ok: true, sequence: 1, exitCode: 0 });
    expect(f.executed).toEqual([['node', 'controller', 'tdd', 'red']]);
    writeFileSync(join(f.wt, 'tests/a.test.js'), 'new\n');
    writeFileSync(join(f.wt, 'src/a.js'), 'draft\n');
    const commit = f.channel.handle({ ...f.identity, sequence: 2, operation: 'commit', paths: ['tests/a.test.js'], message: 'test: a' });
    expect(commit).toMatchObject({ ok: true, sequence: 2, commitSha: expect.stringMatching(/^[0-9a-f]{40}$/) });
    expect(git(f.wt, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'])).toBe('tests/a.test.js');
    expect(git(f.wt, ['status', '--porcelain'])).toContain('src/a.js');
  });

  it('refuses stale, replayed, malformed, skipped and out-of-order requests without executing', () => {
    const f = fixture();
    expect(f.channel.handle({ ...f.identity, sequence: 2, operation: 'gate', gate: 'red' })).toMatchObject({ ok: false, code: 'CHANNEL_SEQUENCE_INVALID' });
    expect(f.channel.handle({ ...f.identity, sequence: 1, operation: 'gate', gate: 'green' })).toMatchObject({ ok: false, code: 'CHANNEL_GATE_OUT_OF_ORDER' });
    expect(f.channel.handle({ ...f.identity, sequence: 1, operation: 'gate', gate: 'red', argv: ['cmd', '/c', 'evil'] })).toMatchObject({ ok: false, code: 'CHANNEL_REQUEST_INVALID' });
    expect(f.channel.handle({ ...f.identity, sequence: 1, operation: 'gate', gate: 'red' })).toMatchObject({ ok: true });
    expect(f.channel.handle({ ...f.identity, sequence: 1, operation: 'gate', gate: 'red' })).toMatchObject({ ok: false, code: 'CHANNEL_SEQUENCE_INVALID' });
    f.setCurrent(false);
    expect(f.channel.handle({ ...f.identity, sequence: 2, operation: 'gate', gate: 'red' })).toMatchObject({ ok: false, code: 'CHANNEL_CLAIM_STALE' });
    expect(f.executed).toHaveLength(1);
  });

  it('returns gate failure and commit escape failure without pretending success', () => {
    const f = fixture();
    f.setExit(1);
    expect(f.channel.handle({ ...f.identity, sequence: 1, operation: 'gate', gate: 'red' })).toMatchObject({ ok: false, code: 'CHANNEL_GATE_FAILED', exitCode: 1 });
    writeFileSync(join(f.wt, 'src/a.js'), 'changed\n');
    expect(f.channel.handle({ ...f.identity, sequence: 2, operation: 'commit', paths: ['../repo/src/a.js'], message: 'bad' })).toMatchObject({ ok: false, code: 'CHANNEL_COMMIT_FAILED' });
    expect(git(f.wt, ['status', '--porcelain'])).toContain('src/a.js');
  });

  it('responds stale when the live state cannot be reloaded instead of silently stopping the mailbox', () => {
    const f = fixture();
    const channel = new ClaimChannel(() => { throw new Error('STATE_READ_FAILED'); }, () => { throw new Error('should not run'); });
    expect(channel.handle({ ...f.identity, sequence: 1, operation: 'gate', gate: 'red' })).toMatchObject({ ok: false, code: 'CHANNEL_CLAIM_STALE' });
  });
});
