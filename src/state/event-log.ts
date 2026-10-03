/**
 * Append-only, rotated, idempotent audit log (`events.jsonl`).
 *
 * Design constraints of the execution model:
 *  - events are compact metadata only; raw tool payloads are never copied here
 *    (oversized records are rejected, see {@link EventTooLargeError});
 *  - duplicate hook deliveries must be harmless, so every record carries an
 *    idempotency key and a re-append is a no-op;
 *  - the log is size-bounded and rotated; the whole file is never injected into
 *    a model context.
 */
import { appendFileSync, closeSync, existsSync, fsyncSync, ftruncateSync, openSync, readFileSync, readdirSync, renameSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { withLock } from './process-lock.js';
import { bestEffortSync, retrySync } from '../util/retry.js';
import { redactValue } from '../security/redact.js';

export interface MycelinkEvent {
  seq: number;
  event_id: string;
  idempotency_key: string;
  ts: string;
  type: string;
  actor: string;
  feature_id?: string;
  node_id?: string;
  data: Record<string, unknown>;
}

export interface EventInput {
  idempotency_key: string;
  type: string;
  actor: string;
  feature_id?: string;
  node_id?: string;
  data?: Record<string, unknown>;
  ts?: string;
}

export interface AppendOptions {
  /** Rotate the live log once it would exceed this size. Default 1 MiB. */
  maxBytes?: number;
  /** Reject any single record larger than this. Default 4 KiB. */
  maxEventBytes?: number;
  /** Lock acquisition timeout. Default 10s. */
  lockTimeoutMs?: number;
}

export interface ReadOptions {
  limit?: number;
  includeRotated?: boolean;
  sinceSeq?: number;
  type?: string;
  nodeId?: string;
}

export class EventTooLargeError extends Error {
  readonly bytes: number;
  readonly limit: number;
  constructor(bytes: number, limit: number) {
    super(
      `Event payload is ${bytes} bytes, over the ${limit}-byte audit limit. ` +
        `Record a path + SHA-256 pointer instead of the raw payload.`,
    );
    this.name = 'EventTooLargeError';
    this.bytes = bytes;
    this.limit = limit;
  }
}

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_EVENT_BYTES = 4096;

function lockFileFor(log: string): string {
  return log + '.lock';
}

/** Parse a JSONL file, skipping a torn trailing line from a crashed writer. */
function parseJsonl(file: string): MycelinkEvent[] {
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, 'utf8');
  const out: MycelinkEvent[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const parsed = JSON.parse(trimmed) as MycelinkEvent;
      if (typeof parsed.seq === 'number' && typeof parsed.idempotency_key === 'string') {
        out.push(parsed);
      }
    } catch {
      // Torn trailing record: an appender died mid-write. Audit semantics are
      // append-only, so the incomplete record simply never happened.
    }
  }
  return out;
}

/** Rotated segments for a log, oldest first. */
export function listRotatedSegments(log: string): string[] {
  const dir = dirname(log);
  const base = basename(log).replace(/\.jsonl$/, '');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.\\d{5}\\.jsonl$`).test(f))
    .sort()
    .map((f) => join(dir, f));
}

function nextSegmentPath(log: string): string {
  const existing = listRotatedSegments(log);
  const n = existing.length + 1;
  return log.replace(/\.jsonl$/, '') + '.' + String(n).padStart(5, '0') + '.jsonl';
}

/**
 * Truncate an incomplete trailing record left by a crashed appender.
 *
 * Without this, the next append would be concatenated onto the torn line and
 * destroy a second, otherwise-valid record.
 */
export function repairTornTail(log: string): boolean {
  if (!existsSync(log)) return false;
  const raw = readFileSync(log, 'utf8');
  if (raw === '' || raw.endsWith('\n')) return false;
  const lastNewline = raw.lastIndexOf('\n');
  const keep = lastNewline === -1 ? '' : raw.slice(0, lastNewline + 1);
  retrySync(() => {
    const fd = openSync(log, 'r+');
    try {
      ftruncateSync(fd, Buffer.byteLength(keep, 'utf8'));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  });
  return true;
}

function eventId(key: string, type: string): string {
  return createHash('sha256').update(JSON.stringify([type, key])).digest('hex').slice(0, 24);
}

function findByKey(log: string, key: string): MycelinkEvent | null {
  for (const ev of parseJsonl(log)) {
    if (ev.idempotency_key === key) return ev;
  }
  for (const seg of listRotatedSegments(log).reverse()) {
    for (const ev of parseJsonl(seg)) {
      if (ev.idempotency_key === key) return ev;
    }
  }
  return null;
}

function highestSeq(log: string): number {
  let max = 0;
  for (const ev of parseJsonl(log)) max = Math.max(max, ev.seq);
  for (const seg of listRotatedSegments(log)) {
    for (const ev of parseJsonl(seg)) max = Math.max(max, ev.seq);
  }
  return max;
}

export interface AppendResult {
  appended: boolean;
  event: MycelinkEvent;
}

/**
 * Append one compact event. Safe under concurrent processes and duplicate
 * hook deliveries.
 */
export function appendEvent(
  log: string,
  input: EventInput,
  options: AppendOptions = {},
): AppendResult {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;

  const draft: MycelinkEvent = {
    seq: 0,
    event_id: eventId(input.idempotency_key, input.type),
    idempotency_key: input.idempotency_key,
    ts: input.ts ?? new Date().toISOString(),
    type: input.type,
    actor: input.actor,
    ...(input.feature_id ? { feature_id: input.feature_id } : {}),
    ...(input.node_id ? { node_id: input.node_id } : {}),
    // Event logs and the run ledger are durable and often committed.
    data: redactValue(input.data ?? {}),
  };

  const probe = Buffer.byteLength(JSON.stringify(draft), 'utf8');
  if (probe > maxEventBytes) {
    throw new EventTooLargeError(probe, maxEventBytes);
  }

  return withLock(
    lockFileFor(log),
    (): AppendResult => {
      repairTornTail(log);
      const existing = findByKey(log, input.idempotency_key);
      if (existing) return { appended: false, event: existing };

      // Rotate before writing so the live log never exceeds maxBytes.
      if (existsSync(log)) {
        const size = Buffer.byteLength(readFileSync(log, 'utf8'), 'utf8');
        if (size + probe > maxBytes) {
          renameSync(log, nextSegmentPath(log));
        }
      }

      const event: MycelinkEvent = { ...draft, seq: highestSeq(log) + 1 };
      const line = JSON.stringify(event) + '\n';
      retrySync(() => appendFileSync(log, line, 'utf8'));
      // The bytes are already in the file; the fsync is durability only, so a
      // transient Windows lock must not fail the append.
      bestEffortSync(() => {
        const fd = openSync(log, 'r+');
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      });
      return { appended: true, event };
    },
    { timeoutMs: options.lockTimeoutMs ?? 10_000, pollMs: 5, purpose: 'event-log append' },
  );
}

/** Read events from the live log (and optionally rotated segments). */
export function readEvents(log: string, options: ReadOptions = {}): MycelinkEvent[] {
  let events: MycelinkEvent[] = [];
  if (options.includeRotated) {
    for (const seg of listRotatedSegments(log)) events = events.concat(parseJsonl(seg));
  }
  events = events.concat(parseJsonl(log));
  events.sort((a, b) => a.seq - b.seq);

  if (options.sinceSeq !== undefined) {
    events = events.filter((e) => e.seq > (options.sinceSeq as number));
  }
  if (options.type) events = events.filter((e) => e.type === options.type);
  if (options.nodeId) events = events.filter((e) => e.node_id === options.nodeId);
  if (options.limit !== undefined && events.length > options.limit) {
    events = events.slice(events.length - options.limit);
  }
  return events;
}

/** Write an arbitrary file atomically alongside the log (helper for callers). */
export function writeLineSync(file: string, line: string): void {
  const fd = openSync(file, 'a');
  try {
    writeSync(fd, line.endsWith('\n') ? line : line + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
