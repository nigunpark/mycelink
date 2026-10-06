import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ORDER_STATUS } from '../vendor/ledger-core/index.mjs';
import { startApp } from './helpers.mjs';

async function paidOrder(store, call, amount_cents) {
  const { body } = await call('POST', '/orders', { amount_cents, currency: 'USD' });
  const order = await store.readOrder(body.order.order_id);
  await store.writeOrder({ ...order, status: ORDER_STATUS.PAID, captured_cents: amount_cents });
  return body.order.order_id;
}

test('refunds are idempotent per key and capped at the captured amount', async (t) => {
  const { call, store } = await startApp(t);
  const id = await paidOrder(store, call, 1000);
  const first = await call('POST', `/orders/${id}/refunds`, { amount_cents: 600 }, { 'idempotency-key': 'a' });
  assert.equal(first.status, 202);
  const replay = await call('POST', `/orders/${id}/refunds`, { amount_cents: 600 }, { 'idempotency-key': 'a' });
  assert.deepEqual(replay.body, first.body);
  const over = await call('POST', `/orders/${id}/refunds`, { amount_cents: 500 }, { 'idempotency-key': 'b' });
  assert.equal(over.status, 422);
  assert.equal(over.body.error.code, 'REFUND_EXCEEDS_CAPTURED');
  const listed = await call('GET', `/orders/${id}/refunds`);
  assert.equal(listed.body.refunds.length, 1);
});

test('refund preconditions', async (t) => {
  const { call } = await startApp(t);
  const { body } = await call('POST', '/orders', { amount_cents: 100, currency: 'USD' });
  const noKey = await call('POST', `/orders/${body.order.order_id}/refunds`, { amount_cents: 1 });
  assert.equal(noKey.body.error.code, 'IDEMPOTENCY_KEY_REQUIRED');
  const unpaid = await call('POST', `/orders/${body.order.order_id}/refunds`, { amount_cents: 1 }, { 'idempotency-key': 'k' });
  assert.equal(unpaid.status, 409);
  assert.equal(unpaid.body.error.code, 'ORDER_NOT_CAPTURED');
});
