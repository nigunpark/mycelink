import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EVENT_TYPES, makeEvent, validateEvent } from '../src/index.mjs';

test('every declared event type round-trips through validateEvent', () => {
  const samples = {
    'order.created': { order_id: 'ord_1234', amount_cents: 100, currency: 'USD' },
    'payment.capture_requested': { order_id: 'ord_1234', amount_cents: 100 },
    'payment.captured': { order_id: 'ord_1234', amount_cents: 100, gateway_ref: 'gw_1' },
    'payment.failed': { order_id: 'ord_1234', reason: 'card_declined' },
    'refund.requested': { order_id: 'ord_1234', refund_id: 'ref_1', amount_cents: 50 },
    'refund.succeeded': { order_id: 'ord_1234', refund_id: 'ref_1', amount_cents: 50, gateway_ref: 'gw_2' },
    'refund.failed': { order_id: 'ord_1234', refund_id: 'ref_1', reason: 'card_declined' },
  };
  for (const type of EVENT_TYPES) {
    assert.ok(samples[type], `missing sample for ${type}`);
    const result = validateEvent(makeEvent(type, samples[type]));
    assert.deepEqual(result, { ok: true, errors: [] }, type);
  }
});

test('event data is closed: unknown fields are a contract violation', () => {
  const evt = makeEvent('payment.failed', { order_id: 'ord_1234', reason: 'x', extra: 1 });
  const result = validateEvent(evt);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /extra/);
});

test('wrong version and unknown types are rejected', () => {
  const evt = makeEvent('order.created', { order_id: 'ord_1234', amount_cents: 1, currency: 'USD' });
  assert.equal(validateEvent({ ...evt, version: 2 }).ok, false);
  assert.equal(validateEvent({ ...evt, type: 'order.exploded' }).ok, false);
  assert.equal(validateEvent(null).ok, false);
});
