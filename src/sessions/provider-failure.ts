/**
 * Why a model session (a controller, a module-worker, a reviewer) failed,
 * from what Claude Code itself records — never from what a model wrote.
 *
 * CSET-203 r10: right after the cli's rework ticket was dispatched, the
 * controller's reply was refused by a provider safeguard
 * (`reasoning_extraction`, a false positive). The session exited 1 with the
 * claim live, and nothing told that infrastructure failure from a product
 * one: the lease waited for its expiry and the run ended with no candidate.
 *
 * Claude Code names such a failure in top-level fields only a model never
 * writes: a `model_refusal_no_fallback` system event, a synthetic assistant
 * message flagged as an API error (`is_api_error_message` in the stream,
 * `isApiErrorMessage` on disk) with its `error` code and the refusal's
 * `stop_details`, a `rate_limit_event` rejected, and the result's
 * `api_error_status`, `stop_reason` and `subtype`. Message text, tool
 * results and anything nested is a model's or a tool's, and never counts.
 *
 * Classes: a transient provider refusal, a rate limit, a server error or a
 * network failure are transient (the same work, in a fresh session, may
 * well go through); authentication and billing are permanent; a turn,
 * budget or context limit is a limit; any other failure is the
 * controller's or the product's. Only a sanitized request id and category
 * are kept: nothing of a prompt, a reply or a model's reasoning.
 */

export type ProviderFailureClass = 'provider-refusal' | 'rate-limit' | 'server-error' | 'network' | 'context-limit' | 'turn-limit' | 'auth' | 'product';

/** Failures a fresh session may get past: the provider's, not the work's. */
export const TRANSIENT_PROVIDER_CLASSES: readonly ProviderFailureClass[] = ['provider-refusal', 'rate-limit', 'server-error', 'network'];

export interface ProviderFailure {
  class: ProviderFailureClass;
  transient: boolean;
  /** The provider's request id (`req_...`), when Claude Code recorded a well-formed one. */
  request_id: string | null;
  /** The refusal's category, or a limit's kind, when well-formed. */
  category: string | null;
  /** The API's HTTP status, when recorded. */
  status: number | null;
  /** Claude Code's error code of the failed request (`rate_limit`, `invalid_request`, ...). */
  error: string | null;
  /** When the failure was recorded (the failing entry's timestamp). */
  at: string | null;
}

/**
 * - `stream`: a session's `stream-json` output; the host's own events only
 *   (a subagent's carry its Agent call's `parent_tool_use_id`). It failed
 *   when its exit code is not 0, or its last result says `is_error`.
 * - `transcript`: a session's (or a subagent's) on-disk transcript; it
 *   failed when the failure is the last thing it did (no message after it).
 */
export type ProviderFailureScope = 'stream' | 'transcript';

type Entry = Record<string, unknown>;

const REQUEST_ID = /^req_[A-Za-z0-9_-]{1,120}$/;
const CATEGORY = /^[A-Za-z0-9_.-]{1,64}$/;
const ERROR_CODE = /^[a-z_]{1,64}$/;

const isObject = (v: unknown): v is Entry => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, re: RegExp): string | null => (typeof v === 'string' && re.test(v) ? v : null);

/** One JSON object per line; anything else (not JSON, not an object) is skipped. */
export function parseJsonLines(text: string): Entry[] {
  const out: Entry[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const v = JSON.parse(line) as unknown;
      if (isObject(v)) out.push(v);
    } catch {
      // not an event
    }
  }
  return out;
}

const transient = (c: ProviderFailureClass): boolean => TRANSIENT_PROVIDER_CLASSES.includes(c);

/** The class a Claude Code error code names. */
function classOfError(error: string | null): ProviderFailureClass | null {
  switch (error) {
    case 'rate_limit':
      return 'rate-limit';
    case 'server_error':
    case 'overloaded':
    case 'overloaded_error':
    case 'api_error':
      return 'server-error';
    case 'connection_error':
    case 'network_error':
    case 'timeout':
    case 'api_timeout':
      return 'network';
    case 'authentication_failed':
    case 'authentication_error':
    case 'billing_error':
    case 'permission_error':
      return 'auth';
    case 'max_output_tokens':
    case 'prompt_too_long':
      return 'context-limit';
    default:
      return null;
  }
}

/** The class an HTTP status names. */
function classOfStatus(status: number | null): ProviderFailureClass | null {
  if (status === null) return null;
  if (status === 429) return 'rate-limit';
  if (status === 401 || status === 402 || status === 403) return 'auth';
  if (status >= 500 && status <= 599) return 'server-error';
  return null;
}

/** A synthetic assistant message Claude Code wrote for a failed request (never a model's own). */
function isApiErrorMessage(e: Entry): boolean {
  if (e['type'] !== 'assistant') return false;
  const flagged = e['is_api_error_message'] === true || e['isApiErrorMessage'] === true;
  const message = isObject(e['message']) ? e['message'] : {};
  return flagged && message['model'] === '<synthetic>';
}

interface Signal {
  class: ProviderFailureClass;
  request_id: string | null;
  category: string | null;
  status: number | null;
  error: string | null;
  at: string | null;
}

/** What one top-level entry says of a failed request, if anything. */
function signalOf(e: Entry): Signal | null {
  const at = typeof e['timestamp'] === 'string' ? (e['timestamp'] as string) : null;
  const requestId = str(e['request_id'], REQUEST_ID) ?? str(e['requestId'], REQUEST_ID);
  if (e['type'] === 'system' && e['subtype'] === 'model_refusal_no_fallback') {
    return { class: 'provider-refusal', request_id: requestId, category: str(e['api_refusal_category'], CATEGORY) ?? str(e['apiRefusalCategory'], CATEGORY), status: null, error: null, at };
  }
  if (isApiErrorMessage(e)) {
    const message = e['message'] as Entry;
    const details = isObject(message['stop_details']) ? message['stop_details'] : null;
    const error = str(e['error'], ERROR_CODE);
    const refused = message['stop_reason'] === 'refusal' || details?.['type'] === 'refusal';
    const cls = refused ? 'provider-refusal' : (classOfError(error) ?? 'product');
    return { class: cls, request_id: requestId, category: refused ? str(details?.['category'], CATEGORY) : null, status: null, error, at };
  }
  if (e['type'] === 'rate_limit_event' && isObject(e['rate_limit_info']) && e['rate_limit_info']['status'] === 'rejected') {
    return { class: 'rate-limit', request_id: null, category: str(e['rate_limit_info']['rateLimitType'], CATEGORY), status: null, error: null, at };
  }
  return null;
}

/** Of two signals of one failure, the more specific; a permanent one outranks what came before it. */
function merge(a: Signal | null, b: Signal): Signal {
  if (a === null) return b;
  const pick = (x: Signal, y: Signal): Signal => ({
    class: x.class,
    request_id: x.request_id ?? y.request_id,
    category: x.category ?? (x.class === y.class ? y.category : null),
    status: x.status ?? y.status,
    error: x.error ?? y.error,
    at: x.at ?? y.at,
  });
  // A refusal is named by its stop details; the error code it travels with (`invalid_request`) says less.
  if (a.class === 'provider-refusal' && b.class === 'product') return pick(a, b);
  if (b.class === 'provider-refusal' && a.class === 'product') return pick(b, a);
  return pick(b, a);
}

const hostEvent = (e: Entry): boolean => e['parent_tool_use_id'] === undefined || e['parent_tool_use_id'] === null;
const activity = (e: Entry): boolean => (e['type'] === 'user' || e['type'] === 'assistant') && !isApiErrorMessage(e) && e['isMeta'] !== true;

/**
 * Why the session `entries` record failed, or null when it did not. A
 * failure with no provider signal is `product` (the controller's or the
 * product's): only Claude Code's own records ever make it a provider's.
 */
export function classifyProviderFailure(input: { entries: readonly unknown[]; exitCode?: number | null; scope?: ProviderFailureScope }): ProviderFailure | null {
  const scope = input.scope ?? 'stream';
  const entries = input.entries.filter(isObject).filter((e) => scope === 'transcript' || hostEvent(e));
  let signal: Signal | null = null;
  let failed = false;
  if (scope === 'stream') {
    // The signals since the host's last message of its own: what ended it, not a failure it went on past.
    let lastActivity = -1;
    entries.forEach((e, i) => {
      if (activity(e)) lastActivity = i;
    });
    for (const [i, e] of entries.entries()) {
      if (i < lastActivity) continue;
      const s = signalOf(e);
      if (s !== null) signal = merge(signal, s);
    }
    const results = entries.filter((e) => e['type'] === 'result');
    const result = results[results.length - 1] ?? null;
    const resultError = result !== null && result['is_error'] === true;
    failed = (typeof input.exitCode === 'number' && input.exitCode !== 0) || resultError;
    if (!failed) return null;
    if (resultError && result !== null) {
      const status = typeof result['api_error_status'] === 'number' && Number.isInteger(result['api_error_status']) ? (result['api_error_status'] as number) : null;
      const subtype = result['subtype'];
      const fromResult: ProviderFailureClass | null =
        result['stop_reason'] === 'refusal'
          ? 'provider-refusal'
          : (classOfStatus(status) ?? (subtype === 'error_max_turns' || subtype === 'error_max_budget_usd' ? 'turn-limit' : null));
      if (fromResult !== null) {
        const r: Signal = { class: fromResult, request_id: null, category: subtype === 'error_max_budget_usd' ? 'max_budget_usd' : subtype === 'error_max_turns' ? 'max_turns' : null, status, error: null, at: null };
        // The result corroborates what the failing request's own record named; it decides only where that is silent.
        signal = signal === null || signal.class === 'product' ? merge(signal, r) : { ...signal, status: signal.status ?? status };
      }
    }
  } else {
    // On disk: the session failed when its last message is the failure (nothing it did after).
    let last = -1;
    entries.forEach((e, i) => {
      if (activity(e) || signalOf(e) !== null) last = i;
    });
    if (last < 0) return null;
    for (let i = last; i >= 0; i--) {
      const e = entries[i] as Entry;
      if (activity(e)) break;
      const s = signalOf(e);
      if (s !== null) signal = signal === null ? s : merge(s, signal);
    }
    if (signal === null) return null;
    failed = true;
  }
  if (signal === null) return { class: 'product', transient: false, request_id: null, category: null, status: null, error: null, at: null };
  return { class: signal.class, transient: transient(signal.class), request_id: signal.request_id, category: signal.category, status: signal.status, error: signal.error, at: signal.at };
}
