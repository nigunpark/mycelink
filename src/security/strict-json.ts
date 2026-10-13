/**
 * JSON read strictly: what JSON.parse reads, bounded, and unambiguous.
 *
 * A reviewer's final answer becomes a verdict only through here
 * (engine/review-transport.ts). JSON.parse takes the last of two equal keys
 * silently — `{"overall":"PASS","overall":"GAPS"}` would mean whatever the
 * reader that saw it last believed — and recurses on its input. This parser
 * refuses a document over its byte bound before it reads a character, never
 * recurses (an explicit stack, refused past its depth bound), refuses a key an
 * object already has (compared decoded: `"ab"` is `"ab"`), and refuses
 * anything after the one top-level value. Everything else it reads exactly as
 * JSON.parse does, including an own `__proto__` key (never the prototype).
 * A refusal names its code, the offset and, for a duplicate, the key's JSON
 * pointer — never the content.
 */

export type StrictJsonCode = 'JSON_TOO_LARGE' | 'JSON_TOO_DEEP' | 'JSON_DUPLICATE_KEY' | 'JSON_INVALID' | 'JSON_TRAILING';

export type StrictJson = { ok: true; value: unknown } | { ok: false; code: StrictJsonCode; detail: string; offset: number; pointer: string };

export interface StrictJsonLimits {
  /** UTF-8 bytes of the whole text. */
  maxBytes: number;
  /** Open objects and arrays at once. */
  maxDepth: number;
}

type Frame = { kind: 'object'; value: Record<string, unknown>; keys: Set<string>; key: string | null } | { kind: 'array'; value: unknown[] };

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const ESCAPES: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

class Refusal {
  constructor(
    readonly code: StrictJsonCode,
    readonly detail: string,
    readonly offset: number,
    readonly pointer: string,
  ) {}
}

const segment = (s: string | number): string => `/${String(s).replace(/~/g, '~0').replace(/\//g, '~1')}`;

/** Parse `text` strictly (see above). */
export function parseStrictJson(text: string, limits: StrictJsonLimits): StrictJson {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > limits.maxBytes) return { ok: false, code: 'JSON_TOO_LARGE', detail: `the JSON is ${bytes} bytes, over its bound of ${limits.maxBytes}`, offset: 0, pointer: '' };
  try {
    return { ok: true, value: parse(text, limits.maxDepth) };
  } catch (err) {
    if (err instanceof Refusal) return { ok: false, code: err.code, detail: err.detail, offset: err.offset, pointer: err.pointer };
    throw err;
  }
}

function parse(text: string, maxDepth: number): unknown {
  const n = text.length;
  let i = 0;
  const stack: Frame[] = [];
  const invalid = (what: string): never => {
    throw new Refusal('JSON_INVALID', `not JSON at offset ${i}: ${what}`, i, '');
  };
  const pointerOf = (extra?: string): string =>
    stack.map((f) => (f.kind === 'object' ? segment(f.key ?? '') : segment(f.value.length))).join('') + (extra === undefined ? '' : segment(extra));
  const ws = (): void => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) break;
      i++;
    }
  };
  const string = (): string => {
    // text[i] is the opening quote.
    i++;
    let out = '';
    let start = i;
    while (true) {
      if (i >= n) return invalid('an unterminated string');
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        out += text.slice(start, i);
        i++;
        return out;
      }
      if (c < 0x20) return invalid('a control character in a string');
      if (c !== 0x5c) {
        i++;
        continue;
      }
      out += text.slice(start, i);
      const e = text[i + 1];
      if (e === undefined) return invalid('an unterminated escape');
      if (e === 'u') {
        const hex = text.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return invalid('a bad \\u escape');
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
      } else {
        const v = ESCAPES[e];
        if (v === undefined) return invalid('a bad escape');
        out += v;
        i += 2;
      }
      start = i;
    }
  };
  const open = (frame: Frame): void => {
    if (stack.length >= maxDepth) throw new Refusal('JSON_TOO_DEEP', `the JSON nests deeper than its bound of ${maxDepth}`, i, pointerOf());
    stack.push(frame);
    i++;
  };

  let root: unknown;
  let done = false;
  /** Attach a finished value to the open container, or make it the document. */
  const attach = (value: unknown): void => {
    const top = stack[stack.length - 1];
    if (top === undefined) {
      root = value;
      done = true;
    } else if (top.kind === 'array') top.value.push(value);
    else Object.defineProperty(top.value, top.key as string, { value, writable: true, enumerable: true, configurable: true });
  };

  // `want`: what the next token must be.
  let want: 'value' | 'key-or-close' | 'key' | 'value-or-close' | 'after' = 'value';
  while (!done) {
    ws();
    if (want === 'after') {
      const top = stack[stack.length - 1] as Frame;
      const c = text[i];
      if (c === ',') {
        i++;
        want = top.kind === 'object' ? 'key' : 'value';
        continue;
      }
      if ((c === '}' && top.kind === 'object') || (c === ']' && top.kind === 'array')) {
        i++;
        stack.pop();
        attach(top.value);
        want = 'after';
        if (done) break;
        continue;
      }
      return invalid(`expected , or ${top.kind === 'object' ? '}' : ']'}`);
    }
    if (want === 'key' || want === 'key-or-close') {
      const top = stack[stack.length - 1] as Extract<Frame, { kind: 'object' }>;
      if (want === 'key-or-close' && text[i] === '}') {
        i++;
        stack.pop();
        attach(top.value);
        want = 'after';
        if (done) break;
        continue;
      }
      if (text[i] !== '"') return invalid('expected a key');
      const at = i;
      const key = string();
      if (top.keys.has(key)) {
        top.key = null;
        const pointer = stack.slice(0, -1).map((f) => (f.kind === 'object' ? segment(f.key ?? '') : segment(f.value.length))).join('') + segment(key);
        throw new Refusal('JSON_DUPLICATE_KEY', `the key at ${pointer} appears twice in one object`, at, pointer);
      }
      top.keys.add(key);
      top.key = key;
      ws();
      if (text[i] !== ':') return invalid('expected :');
      i++;
      want = 'value';
      continue;
    }
    // A value (or, right after `[`, the close).
    if (i >= n) return invalid(stack.length === 0 && root === undefined ? 'no JSON value' : 'the document ends early');
    const c = text[i] as string;
    if (want === 'value-or-close' && c === ']') {
      const top = stack.pop() as Frame;
      i++;
      attach(top.value);
      want = 'after';
      if (done) break;
      continue;
    }
    if (c === '{') {
      open({ kind: 'object', value: {}, keys: new Set(), key: null });
      want = 'key-or-close';
      continue;
    }
    if (c === '[') {
      open({ kind: 'array', value: [] });
      want = 'value-or-close';
      continue;
    }
    let value: unknown;
    if (c === '"') value = string();
    else if (c === '-' || (c >= '0' && c <= '9')) {
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(text);
      if (m === null) return invalid('a bad number');
      value = Number(m[0]);
      i += m[0].length;
    } else if (text.startsWith('true', i)) {
      value = true;
      i += 4;
    } else if (text.startsWith('false', i)) {
      value = false;
      i += 5;
    } else if (text.startsWith('null', i)) {
      value = null;
      i += 4;
    } else return invalid('an unexpected character');
    attach(value);
    want = 'after';
  }
  ws();
  if (i < n) throw new Refusal('JSON_TRAILING', `more follows the JSON value at offset ${i}: one value, nothing after it`, i, '');
  return root;
}
