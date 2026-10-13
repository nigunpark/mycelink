/** Order and capture behaviour that must keep working (regression guard). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertEventsValid,
  gatewayCalls,
  http,
  newDataDir,
  paidOrder,
  runCli,
  runWorkerOk,
  startApi,
} from '../lib/system.mjs';

test('O1 orders can be created, fetched and validated', async (t) => {
  const data = await newDataDir(t);
  const api = await startApi(t, data);
  const created = await http(api.url, 'POST', '/orders', { amount_cents: 1200, currency: 'USD' });
  assert.equal(created.status, 201);
  assert.equal(created.body.order.status, 'pending_payment');
  const fetched = await http(api.url, 'GET', `/orders/${created.body.order.order_id}`);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.order.amount_cents, 1200);
  const invalid = await http(api.url, 'POST', '/orders', { amount_cents: 0, currency: 'USD' });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, 'VALIDATION_FAILED');
  const missing = await http(api.url, 'GET', '/orders/ord_doesnotexist');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'ORDER_NOT_FOUND');
});

test('O2 order creation is idempotent across two API processes', async (t) => {
  const data = await newDataDir(t);
  const [a, b] = [await startApi(t, data), await startApi(t, data)];
  const body = { amount_cents: 777, currency: 'EUR' };
  const results = await Promise.all(
    Array.from({ length: 16 }, (_, i) =>
      http((i % 2 ? a : b).url, 'POST', '/orders', body, { 'idempotency-key': 'accept-order-1' }),
    ),
  );
  assert.deepEqual(new Set(results.map((r) => r.status)), new Set([201]));
  assert.equal(new Set(results.map((r) => r.body.order.order_id)).size, 1);
});

test('O3 capture goes through the worker and emits valid events', async (t) => {
  const data = await newDataDir(t);
  const api = await startApi(t, data);
  const order = await paidOrder(api.url, data, 2500);
  assert.equal(order.captured_cents, 2500);
  const events = await assertEventsValid(api.url, order.order_id);
  assert.deepEqual(
    events.map((e) => e.type),
    ['order.created', 'payment.capture_requested', 'payment.captured'],
  );
});

test('O4 a declined capture marks the order payment_failed', async (t) => {
  const data = await newDataDir(t);
  const api = await startApi(t, data);
  const created = await http(api.url, 'POST', '/orders', { amount_cents: 2013, currency: 'USD' });
  await http(api.url, 'POST', `/orders/${created.body.order.order_id}/capture`);
  await runWorkerOk(data);
  const order = await http(api.url, 'GET', `/orders/${created.body.order.order_id}`);
  assert.equal(order.body.order.status, 'payment_failed');
  await assertEventsValid(api.url, created.body.order.order_id);
});

test('O5 captures charge exactly once under concurrent workers and redelivery', async (t) => {
  const data = await newDataDir(t);
  const api = await startApi(t, data);
  const ids = [];
  for (const amount of [300, 400, 500]) {
    const created = await http(api.url, 'POST', '/orders', { amount_cents: amount, currency: 'USD' });
    ids.push(created.body.order.order_id);
    await http(api.url, 'POST', `/orders/${created.body.order.order_id}/capture`);
  }
  await Promise.all([runWorkerOk(data, { delayMs: 20 }), runWorkerOk(data, { delayMs: 20 })]);
  const redeliver = await http(api.url, 'POST', '/admin/jobs/redeliver');
  assert.equal(redeliver.status, 200);
  await Promise.all([runWorkerOk(data, { delayMs: 20 }), runWorkerOk(data, { delayMs: 20 })]);
  const calls = await gatewayCalls(data);
  for (const id of ids) {
    assert.equal(calls.filter((c) => c.op === 'capture' && c.ref === id).length, 1, `capture calls for ${id}`);
  }
});

test('O6 the CLI still creates, captures and shows orders', async (t) => {
  const data = await newDataDir(t);
  const api = await startApi(t, data);
  const created = await runCli(['orders', 'create', '--amount', '1500', '--currency', 'KRW'], { apiUrl: api.url });
  assert.equal(created.code, 0, created.stderr);
  const id = created.json.order_id;
  const captured = await runCli(['orders', 'capture', id], { apiUrl: api.url });
  assert.equal(captured.code, 0, captured.stderr);
  await runWorkerOk(data);
  const shown = await runCli(['orders', 'show', id], { apiUrl: api.url });
  assert.equal(shown.code, 0, shown.stderr);
  assert.equal(shown.json.status, 'paid');
  const usage = await runCli(['orders', 'create', '--amount', 'ten'], { apiUrl: api.url });
  assert.equal(usage.code, 2);
});
