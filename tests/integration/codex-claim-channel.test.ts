import { afterAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { makeTmpDir, cleanupTmpRoots } from '../helpers/tmp.js';
import { git, makeGitRepo } from '../helpers/git-fixture.js';
import { createWorkerWorktree } from '../../src/git/worktree.js';
import { ClaimChannel, type LiveClaim } from '../../src/sessions/codex-claim-channel.js';
import { tddPolicyFor } from '../../src/engine/tdd-history.js';

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
    tddPolicy: tddPolicyFor(undefined),
    nextGate, gateCommands: [
      { gate: 'red', argv: ['node', 'controller', 'tdd', 'red'] },
      { gate: 'green', argv: ['node', 'controller', 'tdd', 'green'] },
      { gate: 'regression', argv: ['node', 'controller', 'tdd', 'regression'] },
    ],
  } : null;
  const channel = new ClaimChannel(live, (argv) => { executed.push(argv); return { exitCode: gateExit, output: 'gate output' }; });
  const identity = { claimId: 'claim-1', featureId: 'FEAT-101', nodeId: 'FEAT-101.api.impl' };
  return { wt, channel, channelScope: live, identity, executed, setCurrent: (v: boolean) => { current = v; }, setNext: (v: typeof nextGate) => { nextGate = v; }, setExit: (v: number) => { gateExit = v; } };
}

describe('claim-scoped controller channel core', () => {
  it('refuses GREEN on the accepted RED test commit without a production edit, then permits it after an edit', () => {
    const f = fixture();
    writeFileSync(join(f.wt, 'tests/a.test.js'), 'failing assertion\n');
    expect(f.channel.handle({ ...f.identity, sequence: 1, operation: 'gate', gate: 'red' })).toMatchObject({ ok: true });
    expect(f.channel.handle({ ...f.identity, sequence: 2, operation: 'commit', paths: ['tests/a.test.js'], message: 'test: red' })).toMatchObject({ ok: true });
    f.setNext('green');
    expect(f.channel.handle({ ...f.identity, sequence: 3, operation: 'gate', gate: 'green' })).toMatchObject({ ok: false, code: 'CHANNEL_GREEN_UNCHANGED_RED' });
    expect(f.executed).toHaveLength(1);
    writeFileSync(join(f.wt, 'src/a.js'), 'implementation\n');
    expect(f.channel.handle({ ...f.identity, sequence: 4, operation: 'gate', gate: 'green' })).toMatchObject({ ok: true, exitCode: 0 });
    expect(f.executed).toHaveLength(2);
  });

  it.each(['untracked', 'committed', 'changed', 'uncommitted-red'] as const)(
    'refuses %s test bytes before GREEN executes', (change) => {
      const f = fixture();
      writeFileSync(join(f.wt, 'tests/a.test.js'), 'accepted failing assertion\n');
      expect(f.channel.handle({ ...f.identity, sequence: 1, operation: 'gate', gate: 'red' })).toMatchObject({ ok: true });
      let sequence = 2;
      if (change !== 'uncommitted-red') {
        expect(f.channel.handle({ ...f.identity, sequence: sequence++, operation: 'commit', paths: ['tests/a.test.js'], message: 'test: red' })).toMatchObject({ ok: true });
      }
      writeFileSync(join(f.wt, 'src/a.js'), 'implementation\n');
      if (change === 'changed') writeFileSync(join(f.wt, 'tests/a.test.js'), 'weakened assertion\n');
      if (change === 'untracked' || change === 'committed') {
        writeFileSync(join(f.wt, 'tests/compatibility.test.js'), 'compatibility assertion\n');
        if (change === 'committed') {
          expect(f.channel.handle({ ...f.identity, sequence: sequence++, operation: 'commit', paths: ['tests/compatibility.test.js'], message: 'test: compatibility' })).toMatchObject({ ok: true });
        }
      }
      f.setNext('green');
      const request = { ...f.identity, sequence: sequence++, operation: 'gate', gate: 'green' };
      expect(f.channel.handle(request)).toEqual({ ok: false, sequence: request.sequence, code: 'CHANNEL_GREEN_TESTS_NOT_BOUND' });
      expect(f.executed).toEqual([['node', 'controller', 'tdd', 'red']]);
      expect(f.channel.handle(request)).toMatchObject({ ok: false, code: 'CHANNEL_SEQUENCE_INVALID' });
    },
  );

  it.each(['before', 'after'] as const)('allows unchanged compatibility tests present at RED and committed %s RED', (when) => {
    const f = fixture();
    let sequence = 1;
    writeFileSync(join(f.wt, 'tests/compatibility.test.js'), 'compatibility assertion\n');
    const commitCompatibility = () => expect(f.channel.handle({ ...f.identity, sequence: sequence++, operation: 'commit', paths: ['tests/compatibility.test.js'], message: 'test: compatibility' })).toMatchObject({ ok: true });
    if (when === 'before') commitCompatibility();
    writeFileSync(join(f.wt, 'tests/a.test.js'), 'accepted failing assertion\n');
    expect(f.channel.handle({ ...f.identity, sequence: sequence++, operation: 'gate', gate: 'red' })).toMatchObject({ ok: true });
    expect(f.channel.handle({ ...f.identity, sequence: sequence++, operation: 'commit', paths: ['tests/a.test.js'], message: 'test: red' })).toMatchObject({ ok: true });
    if (when === 'after') commitCompatibility();
    writeFileSync(join(f.wt, 'src/a.js'), 'implementation\n');
    f.setNext('green');
    expect(f.channel.handle({ ...f.identity, sequence, operation: 'gate', gate: 'green' })).toMatchObject({ ok: true });
    expect(f.executed).toEqual([['node', 'controller', 'tdd', 'red'], ['node', 'controller', 'tdd', 'green']]);
  });

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

  it('serves only a live review criterion challenge and read-only result check, without worker argv or capability', () => {
    const f = fixture();
    const seen: string[][] = [];
    const channel = new ClaimChannel(() => ({ ...f.channelScope(), challengeCriteria: ['AC-2'] }),
      () => { throw new Error('no gate'); },
      (operation, criterion) => { seen.push([operation, criterion ?? '']); return { exitCode: 0, output: '{"challenge":{}}' }; });
    const id = f.identity;
    expect(channel.handle({ ...id, sequence: 1, operation: 'challenge', criterion: 'AC-3' })).toMatchObject({ ok: false, code: 'CHANNEL_CRITERION_INVALID' });
    expect(channel.handle({ ...id, sequence: 1, operation: 'challenge', criterion: 'AC-2', argv: ['evil'] })).toMatchObject({ ok: false, code: 'CHANNEL_REQUEST_INVALID' });
    expect(channel.handle({ ...id, sequence: 1, operation: 'challenge', criterion: 'AC-2' })).toMatchObject({ ok: true, output: '{"challenge":{}}' });
    expect(channel.handle({ ...id, sequence: 2, operation: 'check' })).toMatchObject({ ok: true });
    expect(seen).toEqual([['challenge', 'AC-2'], ['check', '']]);
    f.setCurrent(false);
    expect(channel.handle({ ...id, sequence: 3, operation: 'check' })).toMatchObject({ ok: false, code: 'CHANNEL_CLAIM_STALE' });
  });
});
