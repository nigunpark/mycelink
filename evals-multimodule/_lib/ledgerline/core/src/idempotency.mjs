import { createHash } from 'node:crypto';
import { DomainError, ERROR_CODES, validationError } from './errors.mjs';
import { keyHash } from './store.mjs';

/** Canonical JSON: object keys sorted, so equal bodies fingerprint equally. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function requestFingerprint(body) {
  return createHash('sha256').update(canonicalJson(body ?? null)).digest('hex');
}

const KEY = /^[\x21-\x7e]{1,128}$/;

export function assertIdempotencyKey(key) {
  if (typeof key !== 'string' || !KEY.test(key)) {
    throw validationError('Idempotency-Key must be 1-128 visible ASCII characters', { field: 'Idempotency-Key' });
  }
  return key;
}

/**
 * Execute `fn` at most once per (scope, key).
 *
 * The whole check-execute-record sequence runs under a cross-process lock,
 * so concurrent requests with the same key — even on different API
 * processes — observe exactly one execution. A replay with the same request
 * fingerprint returns the stored response; a different fingerprint is
 * refused with IDEMPOTENCY_KEY_REUSED.
 *
 * `fn` returns `{ status, body }`; only that is stored and replayed.
 */
export async function withIdempotency(store, { scope, key, fingerprint }, fn) {
  assertIdempotencyKey(key);
  return store.withLock(`idem-${scope}-${keyHash(key).slice(0, 32)}`, async () => {
    const existing = await store.readIdempotency(scope, key);
    if (existing !== null) {
      if (existing.fingerprint !== fingerprint) {
        throw new DomainError(
          ERROR_CODES.IDEMPOTENCY_KEY_REUSED,
          'this Idempotency-Key was already used with a different request',
        );
      }
      return { ...existing.response, replayed: true };
    }
    const response = await fn();
    await store.writeIdempotency(scope, key, {
      fingerprint,
      response: { status: response.status, body: response.body },
      created_at: new Date().toISOString(),
    });
    return { ...response, replayed: false };
  });
}
