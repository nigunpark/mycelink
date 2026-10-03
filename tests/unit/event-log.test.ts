import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { makeTmpDir, cleanupTmpRoots } from '../helpers/tmp.js';
import {
  EventTooLargeError,
  appendEvent,
  listRotatedSegments,
  readEvents,
} from '../../src/state/event-log.js';

afterAll(() => cleanupTmpRoots());

// Child processes load the per-module tsc output, not the single runtime bundle.
const DIST = resolve(process.cwd(), 'build');

describe('event-log', () => {
  it('appends a single parseable JSONL record', () => {
    const dir = makeTmpDir('events-');
    const log = join(dir, 'events.jsonl');

    const result = appendEvent(log, {
      idempotency_key: 'k1',
      type: 'node.claimed',
      actor: 'mycelink',
      feature_id: 'FEAT-1',
      node_id: 'FEAT-1.a.b.impl',
      data: { claim_id: 'c1' },
    });

    expect(result.appended).toBe(true);
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] as string);
    expect(parsed.type).toBe('node.claimed');
    expect(parsed.idempotency_key).toBe('k1');
    expect(typeof parsed.event_id).toBe('string');
    expect(typeof parsed.ts).toBe('string');
    expect(parsed.seq).toBe(1);
  });

  it('is idempotent: a duplicate key does not append twice', () => {
    const dir = makeTmpDir('events-');
    const log = join(dir, 'events.jsonl');
    const first = appendEvent(log, { idempotency_key: 'dup', type: 't', actor: 'a', data: {} });
    const second = appendEvent(log, { idempotency_key: 'dup', type: 't', actor: 'a', data: {} });

    expect(first.appended).toBe(true);
    expect(second.appended).toBe(false);
    expect(second.event.event_id).toBe(first.event.event_id);
    expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('assigns strictly increasing sequence numbers', () => {
    const dir = makeTmpDir('events-');
    const log = join(dir, 'events.jsonl');
    for (let i = 0; i < 5; i++) {
      appendEvent(log, { idempotency_key: `k${i}`, type: 't', actor: 'a', data: {} });
    }
    const seqs = readEvents(log).map((e) => e.seq);
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
  });

  it('readEvents honours a limit and returns the most recent records in order', () => {
    const dir = makeTmpDir('events-');
    const log = join(dir, 'events.jsonl');
    for (let i = 0; i < 10; i++) {
      appendEvent(log, { idempotency_key: `k${i}`, type: `t${i}`, actor: 'a', data: {} });
    }
    const recent = readEvents(log, { limit: 3 });
    expect(recent.map((e) => e.type)).toEqual(['t7', 't8', 't9']);
  });

  it('rejects an oversized event instead of bloating the audit log', () => {
    const dir = makeTmpDir('events-');
    const log = join(dir, 'events.jsonl');
    expect(() =>
      appendEvent(log, {
        idempotency_key: 'big',
        type: 'tool.result',
        actor: 'hook',
        data: { blob: 'x'.repeat(10_000) },
      }),
    ).toThrow(EventTooLargeError);
    expect(existsSync(log)).toBe(false);
  });

  it('rotates the log once it exceeds the configured size, preserving history', () => {
    const dir = makeTmpDir('events-');
    const log = join(dir, 'events.jsonl');
    for (let i = 0; i < 40; i++) {
      appendEvent(
        log,
        { idempotency_key: `k${i}`, type: 'pad', actor: 'a', data: { pad: 'y'.repeat(200) } },
        { maxBytes: 2048 },
      );
    }
    const segments = listRotatedSegments(log);
    expect(segments.length).toBeGreaterThan(0);

    // Every key must survive exactly once across the live log plus segments.
    const all = readEvents(log, { includeRotated: true });
    expect(all).toHaveLength(40);
    expect(new Set(all.map((e) => e.idempotency_key)).size).toBe(40);
    expect(all.map((e) => e.seq)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
  });

  it('tolerates a torn trailing line written by a crashed appender', () => {
    const dir = makeTmpDir('events-');
    const log = join(dir, 'events.jsonl');
    appendEvent(log, { idempotency_key: 'good', type: 't', actor: 'a', data: {} });
    writeFileSync(log, readFileSync(log, 'utf8') + '{"partial":', { flag: 'w' });

    const events = readEvents(log);
    expect(events).toHaveLength(1);
    expect(events[0]?.idempotency_key).toBe('good');

    // A subsequent append must still work and must not duplicate sequences.
    appendEvent(log, { idempotency_key: 'next', type: 't', actor: 'a', data: {} });
    const after = readEvents(log);
    expect(after.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('never loses or interleaves records under concurrent OS processes', async () => {
    const dir = makeTmpDir('events-mp-');
    const log = join(dir, 'events.jsonl');
    const modUrl = pathToFileURL(join(DIST, 'state', 'event-log.js')).href;
    const script = join(dir, 'append.mjs');
    writeFileSync(
      script,
      `
import { appendEvent } from ${JSON.stringify(modUrl)};
const [log, tag, count] = process.argv.slice(2);
for (let i = 0; i < Number(count); i++) {
  appendEvent(log, { idempotency_key: tag + ':' + i, type: 'concurrent', actor: tag, data: { i } });
}
`,
    );

    const procs = 4;
    const perProc = 25;
    await Promise.all(
      Array.from(
        { length: procs },
        (_, p) =>
          new Promise<void>((ok, fail) => {
            const child = spawn(process.execPath, [script, log, `p${p}`, String(perProc)], {
              stdio: ['ignore', 'ignore', 'pipe'],
            });
            let stderr = '';
            child.stderr.on('data', (c: Buffer) => {
              stderr += c.toString();
            });
            child.on('error', fail);
            child.on('exit', (code) =>
              code === 0 ? ok() : fail(new Error(`child exit ${code}: ${stderr}`)),
            );
          }),
      ),
    );

    const events = readEvents(log);
    expect(events).toHaveLength(procs * perProc);
    expect(new Set(events.map((e) => e.idempotency_key)).size).toBe(procs * perProc);
    expect(new Set(events.map((e) => e.seq)).size).toBe(procs * perProc);
  });
});
