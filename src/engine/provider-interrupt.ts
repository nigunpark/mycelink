/**
 * A lease whose holder a model provider ended (CSET-203 r10), read from
 * Claude Code's own records of that holder — never from anything a model or
 * a caller says.
 *
 * A lease's holder is the host session its dispatch bound (the plugin's
 * fence saw it run `dispatch`: hooks/provider-binding.ts) and, once the host
 * launched one, the worker or reviewer subagent (its launch record). The
 * holder failed for the provider when its transcript's last request ended in
 * Claude Code's record of a transient provider failure
 * (sessions/provider-failure.ts) after the lease was issued, and it did
 * nothing after. A subagent's own failure counts first; a host that died
 * takes its background subagents with it, so the host's failure counts for
 * every lease it holds.
 *
 * The bounds: two interruptions per logical ticket (a node's generation and
 * attempt; a review generation's kind), four per phase. Past either, the
 * feature stops PROVIDER_UNAVAILABLE until a person clears it.
 */
import { closeSync, existsSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { classifyProviderFailure, parseJsonLines, type ProviderFailure } from '../sessions/provider-failure.js';
import type { DispatchLease, HostSessionBinding, ProviderLedger, ProviderMark } from '../model/types.js';

export const MAX_PROVIDER_INTERRUPTIONS_PER_TICKET = 2;
export const MAX_PROVIDER_INTERRUPTIONS_PER_PHASE = 4;
/** Interruptions a ledger keeps, newest last. */
const MAX_LEDGER = 32;
/** The tail of a transcript read for its last request: a failure is the last thing in it. */
const TAIL_BYTES = 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

export function emptyProviderLedger(): ProviderLedger {
  return { interruptions: [], tickets: {}, phases: {}, unavailable: null };
}

/** The last `max` bytes of a regular file (never through a link), from its first whole line. */
function tail(file: string, max = TAIL_BYTES): string | null {
  let fd: number;
  try {
    if (!lstatSync(file).isFile()) return null;
    fd = openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - max);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    return start === 0 ? text : text.slice(text.indexOf('\n') + 1);
  } finally {
    closeSync(fd);
  }
}

/** How a transcript ended, if on a failure recorded at or after `since` (an ISO time). */
export function transcriptFailure(file: string, since: string): ProviderFailure | null {
  const text = tail(file);
  if (text === null) return null;
  const failure = classifyProviderFailure({ entries: parseJsonLines(text), scope: 'transcript' });
  if (failure === null) return null;
  // A failure before the lease was issued ended an earlier holder, not this one.
  if (failure.at !== null && failure.at < since) return null;
  return failure;
}

/** A launch record's session, transcript and Agent call, when well formed. */
function launchOf(file: string): { session_id: string; transcript_path: string; tool_use_id: string } | null {
  try {
    const r = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const s = r['session_id'];
    const tx = r['transcript_path'];
    const u = r['tool_use_id'];
    if (typeof s !== 'string' || !ID.test(s) || typeof u !== 'string' || !ID.test(u) || typeof tx !== 'string' || !isAbsolute(tx) || basename(tx) !== `${s}.jsonl`) return null;
    return { session_id: s, transcript_path: tx, tool_use_id: u };
  } catch {
    return null;
  }
}

/** The subagent transcript of one launch: the subagent whose meta names its Agent call, beside the session's transcript. */
function subagentTranscript(l: { session_id: string; transcript_path: string; tool_use_id: string }): string | null {
  const dir = join(dirname(l.transcript_path), l.session_id, 'subagents');
  let names: string[] = [];
  try {
    if (!lstatSync(dir).isDirectory()) return null;
    names = readdirSync(dir).filter((n) => /^agent-[A-Za-z0-9_-]{1,64}\.meta\.json$/.test(n));
  } catch {
    return null;
  }
  for (const n of names.slice(0, 500)) {
    try {
      const meta = JSON.parse(readFileSync(join(dir, n), 'utf8')) as Record<string, unknown>;
      if (meta['toolUseId'] !== l.tool_use_id) continue;
      const tx = join(dir, n.replace(/\.meta\.json$/, '.jsonl'));
      return existsSync(tx) ? tx : null;
    } catch {
      continue;
    }
  }
  return null;
}

export interface HolderFailure {
  failure: ProviderFailure;
  source: ProviderMark['source'];
  session_id: string | null;
}

/**
 * How a lease's holder ended, if on a failure after it was issued: each
 * subagent launched for it (`launches`: its launch record files) first, then
 * the host session it was bound to. Null: no holder failed.
 */
export function holderFailure(args: { issuedAt: string; host: HostSessionBinding | null | undefined; launches: string[] }): HolderFailure | null {
  for (const file of args.launches) {
    const l = launchOf(file);
    if (l === null) continue;
    const tx = subagentTranscript(l);
    if (tx === null) continue;
    const failure = transcriptFailure(tx, args.issuedAt);
    if (failure !== null) return { failure, source: 'agent-transcript', session_id: l.session_id };
  }
  const host = args.host ?? null;
  if (host !== null && isAbsolute(host.transcript_path) && basename(host.transcript_path) === `${host.session_id}.jsonl`) {
    const failure = transcriptFailure(host.transcript_path, args.issuedAt);
    if (failure !== null) return { failure, source: 'host-transcript', session_id: host.session_id };
  }
  return null;
}

/** Launch records in `dir` (`launch-<tool use id>.json`), sorted. */
export function launchFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => /^launch-[A-Za-z0-9_-]{1,128}\.json$/.test(n))
      .sort()
      .map((n) => join(dir, n));
  } catch {
    return [];
  }
}

/** The mark a lease (and the ledger) keeps of a failure: its class and sanitized ids only. */
export function providerMark(h: HolderFailure, at: string = new Date().toISOString()): ProviderMark {
  return { class: h.failure.class, request_id: h.failure.request_id, category: h.failure.category, source: h.source, session_id: h.session_id, at: h.failure.at ?? at };
}

/** A lease's logical ticket: a node's generation and attempt, a review generation's kind. */
export function ticketOf(lease: Pick<DispatchLease, 'kind' | 'node_id' | 'review_id' | 'generation' | 'refinement'>, attempt: number | null, refinementRound: number | null = null): string {
  if (lease.kind === 'review') return `${lease.review_id ?? 'review'}:${lease.refinement === true ? `refinement-${refinementRound ?? 1}` : 'review'}`;
  return `${lease.node_id ?? 'node'}:g${lease.generation}:a${attempt ?? 0}`;
}

/** Count one interruption; whether it is past a bound, and why. */
export function countInterruption(ledger: ProviderLedger, ticket: string, phase: string): { ticket: number; phase: number; past: string | null } {
  const t = (ledger.tickets[ticket] ?? 0) + 1;
  const p = (ledger.phases[phase] ?? 0) + 1;
  ledger.tickets[ticket] = t;
  ledger.phases[phase] = p;
  const past =
    t > MAX_PROVIDER_INTERRUPTIONS_PER_TICKET
      ? `${ticket} was interrupted by its model provider ${t} times (at most ${MAX_PROVIDER_INTERRUPTIONS_PER_TICKET} are recovered)`
      : p > MAX_PROVIDER_INTERRUPTIONS_PER_PHASE
        ? `the ${phase} phase was interrupted by the model provider ${p} times (at most ${MAX_PROVIDER_INTERRUPTIONS_PER_PHASE} are recovered)`
        : null;
  return { ticket: t, phase: p, past };
}

/** Keep an interruption on the ledger, newest last. */
export function recordInterruption(ledger: ProviderLedger, entry: ProviderLedger['interruptions'][number]): void {
  ledger.interruptions = [...ledger.interruptions, entry].slice(-MAX_LEDGER);
}
