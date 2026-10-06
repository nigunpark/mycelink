import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertAmountCents, newOrder, ORDER_STATUS, DomainError, ERROR_CODES } from '../src/index.mjs';

test('amounts are positive integer cents', () => {
  assert.equal(assertAmountCents(1), 1);
  for (const bad of [0, -1, 1.5, '100', null, 100_000_001]) {
    assert.throws(() => assertAmountCents(bad), (e) => e instanceof DomainError && e.code === ERROR_CODES.VALIDATION_FAILED);
  }
});

test('a new order starts pending payment with nothing captured', () => {
  const order = newOrder({ order_id: 'ord_test_1', amount_cents: 2500, currency: 'EUR' }, new Date(0));
  assert.equal(order.status, ORDER_STATUS.PENDING_PAYMENT);
  assert.equal(order.captured_cents, 0);
  assert.equal(order.created_at, '1970-01-01T00:00:00.000Z');
});

test('order ids are validated', () => {
  assert.throws(() => newOrder({ order_id: '../etc', amount_cents: 1, currency: 'USD' }));
});
