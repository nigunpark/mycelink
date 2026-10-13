/**
 * Why a benchmark session failed, from what Claude Code itself records —
 * never from what a model wrote (CSET-203 r10: the controller's reply was
 * refused by a provider safeguard, `reasoning_extraction`, right after the
 * cli's rework ticket was dispatched; the session exited 1, and the run
 * ended there with the claim live and no candidate).
 *
 * The same rules as the plugin's own classifier (src/sessions/provider-
 * failure.ts; tests/benchmark/provider.test.ts holds them to each other):
 * only Claude Code's top-level fields count — a `model_refusal_no_fallback`
 * event, its synthetic assistant message flagged as an API error with the
 * refusal's stop details, a rejected `rate_limit_event`, and the result's
 * `api_error_status`, `stop_reason` and `subtype`. A transient provider
 * refusal, a rate limit, a server error or a network failure is transient;
 * authentication and billing are permanent; turn, budget and context limits
 * are limits; anything else is the controller's or the product's. Only the
 * class, a sanitized request id and category are kept.
 */

export const PROVIDER_CLASSES = ['provider-refusal', 'rate-limit', 'server-error', 'network', 'context-limit', 'turn-limit', 'auth', 'product'];
export const TRANSIENT_PROVIDER_CLASSES = ['provider-refusal', 'rate-limit', 'server-error', 'network'];

const REQUEST_ID = /^req_[A-Za-z0-9_-]{1,120}$/;
const CATEGORY = /^[A-Za-z0-9_.-]{1,64}$/;
const ERROR_CODE = /^[a-z_]{1,64}$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, re) => (typeof v === 'string' && re.test(v) ? v : null);

/** One JSON object per line; anything else is skipped. */
export function parseJsonLines(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    if (line.trim() === '') continue;
    try {
      const v = JSON.parse(line);
      if (isObject(v)) out.push(v);
    } catch {
      // not an event
    }
  }
  return out;
}

function classOfError(error) {
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

function classOfStatus(status) {
  if (status === null) return null;
  if (status === 429) return 'rate-limit';
  if (status === 401 || status === 402 || status === 403) return 'auth';
  if (status >= 500 && status <= 599) return 'server-error';
  return null;
}

function isApiErrorMessage(e) {
  if (e.type !== 'assistant') return false;
  const flagged = e.is_api_error_message === true || e.isApiErrorMessage === true;
  return flagged && isObject(e.message) && e.message.model === '<synthetic>';
}

function signalOf(e) {
  const at = typeof e.timestamp === 'string' ? e.timestamp : null;
  const requestId = str(e.request_id, REQUEST_ID) ?? str(e.requestId, REQUEST_ID);
  if (e.type === 'system' && e.subtype === 'model_refusal_no_fallback') {
    return { class: 'provider-refusal', request_id: requestId, category: str(e.api_refusal_category, CATEGORY) ?? str(e.apiRefusalCategory, CATEGORY), status: null, error: null, at };
  }
  if (isApiErrorMessage(e)) {
    const details = isObject(e.message.stop_details) ? e.message.stop_details : null;
    const error = str(e.error, ERROR_CODE);
    const refused = e.message.stop_reason === 'refusal' || details?.type === 'refusal';
    return { class: refused ? 'provider-refusal' : (classOfError(error) ?? 'product'), request_id: requestId, category: refused ? str(details?.category, CATEGORY) : null, status: null, error, at };
  }
  if (e.type === 'rate_limit_event' && isObject(e.rate_limit_info) && e.rate_limit_info.status === 'rejected') {
    return { class: 'rate-limit', request_id: null, category: str(e.rate_limit_info.rateLimitType, CATEGORY), status: null, error: null, at };
  }
  return null;
}

function merge(a, b) {
  if (a === null) return b;
  const pick = (x, y) => ({ class: x.class, request_id: x.request_id ?? y.request_id, category: x.category ?? (x.class === y.class ? y.category : null), status: x.status ?? y.status, error: x.error ?? y.error, at: x.at ?? y.at });
  if (a.class === 'provider-refusal' && b.class === 'product') return pick(a, b);
  if (b.class === 'provider-refusal' && a.class === 'product') return pick(b, a);
  return pick(b, a);
}

const hostEvent = (e) => e.parent_tool_use_id === undefined || e.parent_tool_use_id === null;
const activity = (e) => (e.type === 'user' || e.type === 'assistant') && !isApiErrorMessage(e) && e.isMeta !== true;

/**
 * Why the session `entries` record failed (`{ class, transient, request_id,
 * category, status, error, at }`), or null when it did not. `scope`:
 * 'stream' (a session's stream-json output: the host's own events; failed
 * when its exit code is not 0 or its last result says is_error) or
 * 'transcript' (an on-disk transcript: failed when the failure is the last
 * thing in it).
 */
export function classifyProviderFailure({ entries, exitCode = null, scope = 'stream' }) {
  const list = entries.filter(isObject).filter((e) => scope === 'transcript' || hostEvent(e));
  let signal = null;
  if (scope === 'stream') {
    let lastActivity = -1;
    list.forEach((e, i) => {
      if (activity(e)) lastActivity = i;
    });
    for (const [i, e] of list.entries()) {
      if (i < lastActivity) continue;
      const s = signalOf(e);
      if (s !== null) signal = merge(signal, s);
    }
    const results = list.filter((e) => e.type === 'result');
    const result = results[results.length - 1] ?? null;
    const resultError = result !== null && result.is_error === true;
    const failed = (typeof exitCode === 'number' && exitCode !== 0) || resultError;
    if (!failed) return null;
    if (resultError) {
      const status = Number.isInteger(result.api_error_status) ? result.api_error_status : null;
      const subtype = result.subtype;
      const fromResult = result.stop_reason === 'refusal' ? 'provider-refusal' : (classOfStatus(status) ?? (subtype === 'error_max_turns' || subtype === 'error_max_budget_usd' ? 'turn-limit' : null));
      if (fromResult !== null) {
        const r = { class: fromResult, request_id: null, category: subtype === 'error_max_budget_usd' ? 'max_budget_usd' : subtype === 'error_max_turns' ? 'max_turns' : null, status, error: null, at: null };
        signal = signal === null || signal.class === 'product' ? merge(signal, r) : { ...signal, status: signal.status ?? status };
      }
    }
  } else {
    let last = -1;
    list.forEach((e, i) => {
      if (activity(e) || signalOf(e) !== null) last = i;
    });
    if (last < 0) return null;
    for (let i = last; i >= 0; i--) {
      const e = list[i];
      if (activity(e)) break;
      const s = signalOf(e);
      if (s !== null) signal = signal === null ? s : merge(s, signal);
    }
    if (signal === null) return null;
  }
  if (signal === null) return { class: 'product', transient: false, request_id: null, category: null, status: null, error: null, at: null };
  return { class: signal.class, transient: TRANSIENT_PROVIDER_CLASSES.includes(signal.class), request_id: signal.request_id, category: signal.category, status: signal.status, error: signal.error, at: signal.at };
}

/** A session's failure from its stream text and exit code: null when it ended well. */
export function sessionFailure(text, exitCode) {
  return classifyProviderFailure({ entries: parseJsonLines(text), exitCode, scope: 'stream' });
}
