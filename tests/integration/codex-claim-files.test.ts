import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { makeTmpDir, cleanupTmpRoots } from '../helpers/tmp.js';
import { ClaimFileTransport } from '../../src/sessions/codex-claim-files.js';
import { canonicalTestId } from '../../src/evidence/test-ids.js';
import { redactValue } from '../../src/security/redact.js';
import { boundChannelResponse, validProbeDiagnostic, ClaimChannel } from '../../src/sessions/codex-claim-channel.js';
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
  it.each(['diagnostic', 'escaped output'] as const)('bounds serialized bytes for bypassed %s', (kind) => {
    const f = fixture(() => ({ ok: true, sequence: 1, exitCode: 1,
      output: '\u0000😀'.repeat(32768),
      diagnostic: { role: 'diagnostic-only', tests: kind === 'diagnostic' ? [{
        id: 'a'.repeat(16), path: 'tests/a.mjs', full_name: 'n'.repeat(32769), status: 'failed',
      }] : [] } }));
    try {
      f.put(1, { sequence: 1 });
      f.transport.tick();
      expect(readFileSync(join(f.dir, 'response-1.json')).length).toBeLessThanOrEqual(32 * 1024);
      if (kind === 'diagnostic') {
        expect(f.response(1)).toEqual({ ok: true, sequence: 1, exitCode: 2, output: 'CHANNEL_PROBE_REPORT_INVALID:SIZE' });
      } else expect(f.response(1)).toMatchObject({ ok: true, exitCode: 1, diagnostic: { tests: [] } });
    } finally { f.transport.stop(); }
  });

  it('refuses an envelope that exceeds the wire bound even with empty output', () => {
    // A bypassed handler can supply a receipt too large to fit without output.
    const response: ChannelResponse = { ok: true, sequence: 1, exitCode: 1, output: '',
      test_ids: ['receipt-' + 'x'.repeat(32768)],
      diagnostic: { role: 'diagnostic-only', tests: [] } };
    expect(validProbeDiagnostic(response.diagnostic)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(response))).toBeGreaterThan(32 * 1024);
    expect(boundChannelResponse(response)).toEqual({ ok: true, sequence: 1, exitCode: 2,
      output: 'CHANNEL_PROBE_REPORT_INVALID:WIRE' });
  });

  it.each(['callback', 'wire', 'redaction', 'redaction-identity'] as const)('fails closed at file transport stage %s without identity or receipt leakage', kind => {
    const full_name = kind === 'redaction' ? 'sensitive-value-123'.repeat(210)
      : kind === 'redaction-identity' ? 'assertion sensitive-value-123' : 'ordinary assertion';
    const diagnostic = { role: 'diagnostic-only' as const, tests: [{
      id: canonicalTestId('junit-xml', 'tests/a.mjs', full_name), path: 'tests/a.mjs',
      full_name, status: 'failed' as const,
    }] };
    expect(validProbeDiagnostic(diagnostic)).toBe(true);
    if (kind === 'redaction-identity') {
      const redacted = redactValue(diagnostic, { TOKEN_SECRET: 'sensitive-value-123' });
      const test = redacted.tests[0]!;
      // Shape validation still passes, but the original canonical ID is now stale.
      // Assert booleans so a failed precondition cannot print the fixture secret.
      expect(test.full_name !== full_name).toBe(true);
      expect(Buffer.byteLength(test.full_name)).toBeLessThan(4096);
      expect(validProbeDiagnostic(redacted)).toBe(true);
      expect(test.id === diagnostic.tests[0]!.id).toBe(true);
      expect(test.id !== canonicalTestId('junit-xml', test.path, test.full_name)).toBe(true);
    }
    // Redaction expands a valid name beyond the 4096-byte identity bound.
    if (kind === 'callback') diagnostic.tests[0]!.full_name = 'n'.repeat(32769);
    const claim = { claimId: 'claim-1', featureId: 'F', nodeId: 'F.n', repoPath: 'unused', worktree: 'unused',
      expectedHead: '0'.repeat(40), allowedPaths: [], forbiddenPaths: [], nextGate: 'red' as const,
      gateCommands: [{ gate: 'red' as const, argv: ['node', 'declared-verifier'] }] };
    const channel = new ClaimChannel(() => claim, () => { throw new Error('gate must not run'); }, undefined,
      () => ({ exitCode: 1, output: 'sensitive-value-123', diagnostic }));
    const f = fixture(input => kind === 'wire'
      ? { ok: true, sequence: 1, exitCode: 1, output: '', diagnostic, test_ids: ['receipt-' + 'x'.repeat(32768)] }
      : channel.handle(input));
    try {
      f.put(1, { claimId: 'claim-1', featureId: 'F', nodeId: 'F.n', sequence: 1, operation: 'probe' });
      f.transport.tick();
      const bytes = readFileSync(join(f.dir, 'response-1.json'));
      if (kind === 'redaction-identity') {
        expect(bytes.toString('utf8').includes(diagnostic.tests[0]!.id)).toBe(false);
      }
      expect(bytes.length).toBeLessThan(128);
      expect(f.response(1)).toEqual({ ok: true, sequence: 1, exitCode: 2,
        output: `CHANNEL_PROBE_REPORT_INVALID:${kind === 'callback' ? 'SIZE' : kind === 'wire' ? 'WIRE' : 'REDACTION'}` });
      for (const text of ['sensitive-value-123', 'tests/a.mjs', 'receipt-', 'criterion_evidence', 'diagnostic']) {
        expect(bytes.toString('utf8')).not.toContain(text);
      }
    } finally { f.transport.stop(); }
  });

  it('accepts the exact argument-free probe client command and redacts its diagnostic', async () => {
    const seen: unknown[] = [];
    const f = fixture((r) => {
      seen.push(r);
      return { ok: true, sequence: (r as { sequence: number }).sequence, exitCode: 1,
        output: 'sensitive-value-123' + 'x'.repeat(100_000), diagnostic: { role: 'diagnostic-only', tests: [] } };
    });
    try {
      const client = join(f.dir, 'client.mjs');
      for (const args of [['probe', '--filter', 'x'], ['probe', 'tests/a.mjs']]) {
        expect(spawnSync(process.execPath, [client, ...args], { encoding: 'utf8', timeout: 5_000 }).status).not.toBe(0);
      }
      expect(seen).toEqual([]);
      const child = spawn(process.execPath, [client, 'probe'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 });
      let output = '';
      child.stdout.on('data', (chunk) => { output += String(chunk); });
      const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      expect(code).toBe(0); // a diagnostic failure is a successful probe request
      expect(seen).toEqual([{ claimId: 'claim-1', featureId: '', nodeId: '', sequence: 1, operation: 'probe' }]);
      const answer = JSON.parse(output);
      expect(answer).toMatchObject({ ok: true, exitCode: 1, diagnostic: { role: 'diagnostic-only' } });
      expect(answer.output).not.toContain('sensitive-value-123');
      expect(answer.output.length).toBeLessThanOrEqual(32 * 1024);
      expect(answer).not.toHaveProperty('output_sha256');
      expect(answer).not.toHaveProperty('test_ids');
    } finally { f.transport.stop(); }
  });

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
