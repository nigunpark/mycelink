/** Bounded public `codex exec --json` evidence. This is process output, not actor authentication. */
import { createHash } from 'node:crypto';
import { parseStrictJson } from '../security/strict-json.js';

const MAX_LINE_BYTES = 64 * 1024;
const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const MAX_EVENTS = 4096;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const THREAD = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

export interface CodexTranscriptEvidence {
  provider: 'codex';
  source: 'exec-jsonl';
  /** A claim by the spawned process, not an authenticated host/session binding. */
  thread_id: string | null;
  terminal: 'completed' | 'failed' | 'incomplete' | 'invalid';
  turns: number;
  final: { item_id: string; sha256: string; bytes: number } | null;
  /** No error prose or tool output can be used as a retry classification. */
  failure: { class: 'unclassified'; transient: false } | null;
  role_attested: false;
}

/** One reader per process. Never stores raw prompts, tool output, or final response. */
export class CodexTranscriptReader {
  private readonly maxLineBytes: number;
  constructor(options: { maxLineBytes?: number } = {}) {
    const limit = options.maxLineBytes ?? MAX_LINE_BYTES;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 512 * 1024) throw new Error('CODEX_TRANSCRIPT_LINE_LIMIT_INVALID');
    this.maxLineBytes = limit;
  }
  private thread: string | null = null;
  private active = false;
  private terminal: CodexTranscriptEvidence['terminal'] = 'incomplete';
  private turns = 0;
  private final: CodexTranscriptEvidence['final'] = null;
  private bytes = 0;
  private events = 0;

  consume(line: string): void {
    if (this.terminal === 'invalid') return;
    const bytes = Buffer.byteLength(line, 'utf8');
    this.bytes += bytes;
    this.events++;
    if (bytes > this.maxLineBytes || this.bytes > MAX_STREAM_BYTES || this.events > MAX_EVENTS || this.terminal === 'failed') return this.invalidate();
    const parsed = parseStrictJson(line, { maxBytes: this.maxLineBytes, maxDepth: 24 });
    if (!parsed.ok || !object(parsed.value)) return this.invalidate();
    const event = parsed.value;
    // Top-level role labels supplied by the process are never authority.
    if ('agent_id' in event || 'agent_type' in event || 'role' in event) return this.invalidate();
    switch (event['type']) {
      case 'thread.started':
        if (this.thread !== null || this.active || this.turns > 0 || !THREAD.test(String(event['thread_id']))) return this.invalidate();
        this.thread = event['thread_id'] as string;
        return;
      case 'turn.started':
        if (this.thread === null || this.active) return this.invalidate();
        this.active = true;
        this.final = null;
        return;
      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        if (!this.active || !object(event['item']) || !ID.test(String(event['item']['id']))) return this.invalidate();
        const item = event['item'];
        if (event['type'] === 'item.completed' && item['type'] === 'agent_message') {
          if (typeof item['text'] !== 'string' || Buffer.byteLength(item['text'], 'utf8') > MAX_LINE_BYTES) return this.invalidate();
          this.final = { item_id: item['id'] as string, sha256: createHash('sha256').update(item['text']).digest('hex'), bytes: Buffer.byteLength(item['text'], 'utf8') };
        }
        return;
      }
      case 'error':
        if (!this.active) return this.invalidate();
        return; // An error may be followed by a successful turn; no prose classification.
      case 'turn.failed':
        if (!this.active || !object(event['error'])) return this.invalidate();
        this.active = false;
        this.final = null;
        this.terminal = 'failed';
        return;
      case 'turn.completed':
        if (!this.active || this.final === null || !object(event['usage'])) return this.invalidate();
        this.active = false;
        this.turns++;
        this.terminal = 'completed';
        return;
      default:
        return this.invalidate();
    }
  }

  private invalidate(): void {
    this.terminal = 'invalid';
    this.final = null;
  }

  finish(): CodexTranscriptEvidence {
    const terminal = this.terminal === 'invalid' || this.thread === null ? 'invalid' : this.active ? 'incomplete' : this.terminal;
    return {
      provider: 'codex', source: 'exec-jsonl', thread_id: this.thread, terminal,
      turns: this.turns, final: terminal === 'completed' ? this.final : null,
      failure: terminal === 'failed' ? { class: 'unclassified', transient: false } : null,
      role_attested: false,
    };
  }
}
