/**
 * Secret redaction.
 *
 * Every durable artifact Mycelink writes — evidence logs, event logs, the run
 * ledger, context packs, worker session logs and E2E metadata — passes
 * through here first. Two things are removed:
 *
 *  1. the value of any environment variable whose *name* looks secret
 *     (TOKEN, SECRET, PASSWORD, API_KEY, CREDENTIAL, ...), and
 *  2. well-known credential *shapes* (GitHub, cloud and model-provider keys,
 *     bearer headers, URL credentials, PEM private keys), even when no
 *     environment variable announced them.
 *
 * Redaction is a safety net, not a licence to print secrets: commands should
 * still read credentials from the environment rather than argv.
 */

const SECRET_NAME =
  /(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CLIENT_?SECRET|CREDENTIAL|AUTH(?!OR)|COOKIE|SESSION_?KEY|WEBHOOK|SIGNING_?KEY|DSN)/i;
/** Names that match the pattern but conventionally hold a location, not a secret. */
const LOCATION_NAME = /(_SOCK|_PATH|_FILE|_DIR|_HOME)$/i;

/** Values shorter than this are not redacted by name (avoids mangling "true"). */
const MIN_SECRET_LENGTH = 8;

const SHAPES: { name: string; rx: RegExp }[] = [
  { name: 'PRIVATE_KEY', rx: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: 'GITHUB_TOKEN', rx: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { name: 'GITHUB_TOKEN', rx: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: 'API_KEY', rx: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { name: 'AWS_ACCESS_KEY_ID', rx: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'SLACK_TOKEN', rx: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { name: 'GOOGLE_API_KEY', rx: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'NPM_TOKEN', rx: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { name: 'BEARER', rx: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/g },
  { name: 'URL_CREDENTIALS', rx: /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi },
];

export type Env = Record<string, string | undefined>;

/** [name, value] pairs of secret-looking environment variables, longest value first. */
export function secretEnvValues(env: Env = process.env): [string, string][] {
  const out: [string, string][] = [];
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string' || value.length < MIN_SECRET_LENGTH) continue;
    if (!SECRET_NAME.test(name) || LOCATION_NAME.test(name)) continue;
    out.push([name, value]);
  }
  return out.sort((a, b) => b[1].length - a[1].length);
}

/** Replace secret values and credential shapes in `text`. */
export function redactText(text: string, env: Env = process.env): string {
  if (text === '') return text;
  let out = text;
  for (const [name, value] of secretEnvValues(env)) {
    if (out.includes(value)) out = out.split(value).join(`[REDACTED:${name}]`);
  }
  for (const { name, rx } of SHAPES) {
    out = out.replace(rx, (match, scheme: unknown) =>
      name === 'URL_CREDENTIALS' && typeof scheme === 'string'
        ? `${scheme}[REDACTED:${name}]@`
        : name === 'BEARER'
          ? `${match.split(/\s+/)[0]} [REDACTED:${name}]`
          : `[REDACTED:${name}]`,
    );
  }
  return out;
}

/** Deep-redact every string inside a JSON-like value; keys are left intact. */
export function redactValue<T>(value: T, env: Env = process.env): T {
  const secrets = secretEnvValues(env);
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return redactText(v, secrets.length > 0 ? Object.fromEntries(secrets) : {});
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, inner] of Object.entries(v as Record<string, unknown>)) out[k] = walk(inner);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

/**
 * Line-oriented redactor for streams (worker session logs). Buffers partial
 * lines so a secret split across two chunks is still caught.
 */
export class LineRedactor {
  private pending = '';
  private readonly env: Env;
  constructor(env: Env = process.env) {
    this.env = env;
  }
  push(chunk: string): string {
    this.pending += chunk;
    const cut = this.pending.lastIndexOf('\n');
    if (cut === -1) return '';
    const ready = this.pending.slice(0, cut + 1);
    this.pending = this.pending.slice(cut + 1);
    return redactText(ready, this.env);
  }
  flush(): string {
    const rest = this.pending;
    this.pending = '';
    return redactText(rest, this.env);
  }
}
