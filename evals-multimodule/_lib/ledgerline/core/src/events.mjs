import { randomUUID } from 'node:crypto';

/**
 * Versioned domain event contracts.
 *
 * Every event a Ledgerline service emits must validate against this table.
 * Data objects are closed: a field that is not declared here is a contract
 * violation, so adding a field means adding it here (and bumping the version
 * when the change is not backward compatible).
 */
const SCHEMAS = {
  'order.created': {
    version: 1,
    fields: { order_id: 'string', amount_cents: 'integer', currency: 'string' },
  },
  'payment.capture_requested': {
    version: 1,
    fields: { order_id: 'string', amount_cents: 'integer' },
  },
  'payment.captured': {
    version: 1,
    fields: { order_id: 'string', amount_cents: 'integer', gateway_ref: 'string' },
  },
  'payment.failed': {
    version: 1,
    fields: { order_id: 'string', reason: 'string' },
  },
};

export const EVENT_TYPES = Object.freeze(Object.keys(SCHEMAS));

export function eventSchema(type) {
  const schema = SCHEMAS[type];
  return schema === undefined ? undefined : { type, version: schema.version, fields: { ...schema.fields } };
}

export function makeEvent(type, data, now = new Date()) {
  const schema = SCHEMAS[type];
  if (schema === undefined) throw new Error(`unknown event type ${type}`);
  return {
    event_id: `evt_${randomUUID()}`,
    type,
    version: schema.version,
    occurred_at: now.toISOString(),
    data,
  };
}

function typeOk(kind, value) {
  if (kind === 'string') return typeof value === 'string' && value.length > 0;
  if (kind === 'integer') return Number.isSafeInteger(value);
  return false;
}

/** Returns { ok, errors } — never throws for malformed input. */
export function validateEvent(event) {
  const errors = [];
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    return { ok: false, errors: ['event must be an object'] };
  }
  const allowed = new Set(['event_id', 'type', 'version', 'occurred_at', 'data']);
  for (const key of Object.keys(event)) if (!allowed.has(key)) errors.push(`unexpected envelope field ${key}`);
  if (typeof event.event_id !== 'string' || !event.event_id.startsWith('evt_')) errors.push('event_id must start with evt_');
  if (typeof event.occurred_at !== 'string' || Number.isNaN(Date.parse(event.occurred_at))) {
    errors.push('occurred_at must be an ISO-8601 timestamp');
  }
  const schema = SCHEMAS[event.type];
  if (schema === undefined) {
    errors.push(`unknown event type ${String(event.type)}`);
    return { ok: false, errors };
  }
  if (event.version !== schema.version) errors.push(`${event.type} must be version ${schema.version}`);
  const data = event.data;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    errors.push('data must be an object');
    return { ok: false, errors };
  }
  for (const [field, kind] of Object.entries(schema.fields)) {
    if (!typeOk(kind, data[field])) errors.push(`data.${field} must be a ${kind}`);
  }
  for (const field of Object.keys(data)) {
    if (!(field in schema.fields)) errors.push(`data.${field} is not part of ${event.type} v${schema.version}`);
  }
  return { ok: errors.length === 0, errors };
}
