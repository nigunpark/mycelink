import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmpDir, cleanupTmpRoots } from '../helpers/tmp.js';
import { ClaimFileTransport } from '../../src/sessions/codex-claim-files.js';
import { ClaimChannel } from '../../src/sessions/codex-claim-channel.js';
import type { ChannelResponse } from '../../src/sessions/codex-claim-channel.js';

afterAll(() => cleanupTmpRoots());

function fixture(handler: (value: unknown) => ChannelResponse = (r) => ({ ok: true, sequence: (r as { sequence: number }).sequence, exitCode: 0, output: 'ok' })) {
  const root = makeTmpDir('claim-files-');
  const wt = join(root, 'tree');
  mkdirSync(wt);
  mkdirSync(join(wt, '.mycelink-worker'));
  const transport = new ClaimFileTransport(wt, 'claim-1', handler, { TOKEN_SECRET: 'sensitive-value-123' });
  transport.start();
  const dir = join(wt, '.mycelink-worker', 'channel-claim-1');
  const put = (n: number, value: unknown) => writeFileSync(join(dir, `request-${n}.json`), JSON.stringify(value));
  const response = (n: number) => JSON.parse(readFileSync(join(dir, `response-${n}.json`), 'utf8')) as ChannelResponse;
  return { root, dir, transport, put, response };
}

describe('bounded claim file transport', () => {
  it('delivers a numbered request once, redacts and bounds its response, then closes', () => {
    const f = fixture((r) => ({ ok: true, sequence: (r as { sequence: number }).sequence, exitCode: 0, output: 'sensitive-value-123' + 'x'.repeat(100_000) }));
    f.put(1, { claimId: 'claim-1', featureId: 'F', nodeId: 'F.n', sequence: 1, operation: 'gate', gate: 'red' });
    f.transport.tick();
    expect(f.response(1)).toMatchObject({ ok: true, sequence: 1, exitCode: 0 });
    expect(JSON.stringify(f.response(1))).not.toContain('sensitive-value-123');
    expect(readFileSync(join(f.dir, 'response-1.json')).length).toBeLessThan(65_000);
    f.transport.tick();
    f.transport.stop();
    expect(existsSync(f.dir)).toBe(false);
  });

  it('rejects oversized and link requests without calling the handler or reading an escaped target', () => {
    let calls = 0;
    const f = fixture(() => { calls++; throw new Error('should not execute'); });
    writeFileSync(join(f.dir, 'request-1.json'), 'x'.repeat(8193));
    f.transport.tick();
    expect(f.response(1)).toMatchObject({ ok: false, code: 'CHANNEL_REQUEST_INVALID' });
    writeFileSync(join(f.root, 'outside'), '{}');
    symlinkSync(join(f.root, 'outside'), join(f.dir, 'request-2.json'), 'file');
    f.transport.tick();
    expect(f.response(2)).toMatchObject({ ok: false, code: 'CHANNEL_REQUEST_INVALID' });
    expect(calls).toBe(0);
    f.transport.stop();
    expect(existsSync(join(f.root, 'outside'))).toBe(true);
  });

  it('rejects a future sequence without consuming it and ignores renamed stale requests after stop', () => {
    const seen: unknown[] = [];
    const f = fixture((r) => { seen.push(r); return { ok: true, sequence: (r as { sequence: number }).sequence, exitCode: 0, output: 'ok' }; });
    f.put(2, { sequence: 2 });
    f.transport.tick();
    expect(f.response(2)).toMatchObject({ ok: false, code: 'CHANNEL_SEQUENCE_INVALID' });
    f.put(1, { sequence: 1 });
    f.transport.tick();
    expect(f.response(1).ok).toBe(true);
    expect(seen).toHaveLength(1);
    f.transport.stop();
    expect(() => f.transport.tick()).toThrow();
  });

  it('binds the JSON sequence to its filename and refuses a poisoned response without consuming another gate', () => {
    const seen: unknown[] = [];
    const f = fixture((r) => { seen.push(r); return { ok: true, sequence: 1, exitCode: 0, output: 'ok' }; });
    f.put(1, { sequence: 2, operation: 'gate' });
    f.transport.tick();
    expect(f.response(1)).toMatchObject({ ok: false, code: 'CHANNEL_REQUEST_INVALID' });
    expect(seen).toHaveLength(0);
    f.put(2, { sequence: 2, operation: 'gate' });
    f.transport.tick();
    expect(f.response(2)).toMatchObject({ ok: false, code: 'CHANNEL_REQUEST_INVALID' });
    expect(seen).toHaveLength(1);
    f.transport.stop();
  });

  it('routes a mailbox request through the claim protocol, not worker-supplied argv', () => {
    const executed: string[][] = [];
    const claim = { claimId: 'claim-1', featureId: 'F', nodeId: 'F.n', repoPath: 'unused', worktree: 'unused', expectedHead: '0'.repeat(40), allowedPaths: [], forbiddenPaths: [], nextGate: 'red' as const, gateCommands: [{ gate: 'red' as const, argv: ['node', 'declared-verifier'] }] };
    const channel = new ClaimChannel(() => claim, (argv) => { executed.push([...argv]); return { exitCode: 0, output: 'passed' }; });
    const f = fixture((input) => channel.handle(input));
    f.put(1, { claimId: 'claim-1', featureId: 'F', nodeId: 'F.n', sequence: 1, operation: 'gate', gate: 'red', argv: ['node', 'other'] });
    f.transport.tick();
    expect(f.response(1)).toMatchObject({ ok: false, code: 'CHANNEL_REQUEST_INVALID' });
    f.put(2, { claimId: 'claim-1', featureId: 'F', nodeId: 'F.n', sequence: 2, operation: 'gate', gate: 'red' });
    f.transport.tick();
    expect(f.response(2)).toMatchObject({ ok: false, code: 'CHANNEL_SEQUENCE_INVALID' });
    expect(executed).toEqual([]);
    f.transport.stop();
    const channel2 = new ClaimChannel(() => claim, (argv) => { executed.push([...argv]); return { exitCode: 0, output: 'passed' }; });
    const fresh = fixture((input) => channel2.handle(input));
    fresh.put(1, { claimId: 'claim-1', featureId: 'F', nodeId: 'F.n', sequence: 1, operation: 'gate', gate: 'red' });
    fresh.transport.tick();
    expect(fresh.response(1)).toMatchObject({ ok: true, exitCode: 0, output: 'passed' });
    expect(executed).toEqual([['node', 'declared-verifier']]);
    fresh.transport.stop();
  });

  it('does not consume a request while its JSON write is incomplete', () => {
    const seen: number[] = [];
    const f = fixture((r) => {
      const sequence = (r as { sequence: number }).sequence;
      seen.push(sequence);
      return { ok: true, sequence, exitCode: 0, output: 'ok' };
    });
    const request = { claimId: 'claim-1', featureId: 'F', nodeId: 'F.n', sequence: 1, operation: 'gate', gate: 'green' };
    const path = join(f.dir, 'request-1.json');
    writeFileSync(path, JSON.stringify(request).slice(0, 40));
    f.transport.tick();
    expect(existsSync(join(f.dir, 'response-1.json'))).toBe(false);
    writeFileSync(path, JSON.stringify(request));
    f.transport.tick();
    expect(f.response(1)).toMatchObject({ ok: true, sequence: 1 });
    expect(seen).toEqual([1]);
    f.transport.stop();
  });

  it('distinguishes a handler exception from malformed request bytes', () => {
    const f = fixture(() => { throw new Error('sensitive-value-123'); });
    f.put(1, { claimId: 'claim-1', featureId: 'F', nodeId: 'F.n', sequence: 1, operation: 'gate', gate: 'green' });
    f.transport.tick();
    expect(f.response(1)).toMatchObject({ ok: false, code: 'CHANNEL_HANDLER_FAILED' });
    expect(JSON.stringify(f.response(1))).not.toContain('sensitive-value-123');
    f.transport.stop();
  });

  it('refuses a pre-existing claim directory and a linked mailbox parent', () => {
    const root = makeTmpDir('claim-files-parent-');
    const worktree = join(root, 'tree');
    const outside = join(root, 'outside');
    mkdirSync(worktree);
    mkdirSync(outside);
    symlinkSync(outside, join(worktree, '.mycelink-worker'), 'junction');
    expect(() => new ClaimFileTransport(worktree, 'claim-1', () => ({ ok: false, sequence: null, code: 'NO' })).start()).toThrow('CHANNEL_PATH_INVALID');
    expect(existsSync(join(outside, 'channel-claim-1'))).toBe(false);
  });
});
