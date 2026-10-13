import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEvent } from '../vendor/ledger-core/index.mjs';
import { startApp } from './helpers.mjs';

test('create and fetch an order', async (t) => {
  const { call } = await startApp(t);
  const created = await call('POST', '/orders', { amount_cents: 1200, currency: 'USD' });
  assert.equal(created.status, 201);
  assert.equal(created.body.order.status, 'pending_payment');
  const fetched = await call('GET', `/orders/${created.body.order.order_id}`);
  assert.deepEqual(fetched.body.order, created.body.order);
});

test('validation errors use the shared error envelope', async (t) => {
  const { call } = await startApp(t);
  const res = await call('POST', '/orders', { amount_cents: 12.5, currency: 'USD' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'VALIDATION_FAILED');
  const missing = await call('GET', '/orders/ord_missing1');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'ORDER_NOT_FOUND');
});

test('POST /orders honours Idempotency-Key, including concurrent retries', async (t) => {
  const { call } = await startApp(t);
  const body = { amount_cents: 700, currency: 'EUR' };
  const results = await Promise.all(
    Array.from({ length: 8 }, () => call('POST', '/orders', body, { 'idempotency-key': 'order-key-1' })),
  );
  const ids = new Set(results.map((r) => r.body.order.order_id));
  assert.equal(ids.size, 1);
  assert.ok(results.some((r) => r.headers.get('idempotent-replayed') === 'true'));
  const conflict = await call(
    'POST',
    '/orders',
    { amount_cents: 701, currency: 'EUR' },
    { 'idempotency-key': 'order-key-1' },
  );
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'IDEMPOTENCY_KEY_REUSED');
});

test('capture moves the order to capture_pending and enqueues a job once', async (t) => {
  const { call, store } = await startApp(t);
  const { body } = await call('POST', '/orders', { amount_cents: 900, currency: 'USD' });
  const id = body.order.order_id;
  const captured = await call('POST', `/orders/${id}/capture`);
  assert.equal(captured.status, 202);
  assert.equal(captured.body.order.status, 'capture_pending');
  const again = await call('POST', `/orders/${id}/capture`);
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'ORDER_NOT_CAPTURABLE');
  const job = await store.claimJob();
  assert.equal(job.job.type, 'payment.capture');
  assert.equal(await store.claimJob(), null);
});

test('every emitted event satisfies the core contract', async (t) => {
  const { call } = await startApp(t);
  const { body } = await call('POST', '/orders', { amount_cents: 300, currency: 'KRW' });
  await call('POST', `/orders/${body.order.order_id}/capture`);
  const { body: events } = await call('GET', `/orders/${body.order.order_id}/events`);
  assert.deepEqual(
    events.events.map((e) => e.type),
    ['order.created', 'payment.capture_requested'],
  );
  for (const e of events.events) assert.deepEqual(validateEvent(e).errors, []);
});
