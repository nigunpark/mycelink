/** LEDGER refunds: the HTTP contract, idempotency and concurrency. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertEventsValid,
  http,
  listRefunds,
  newDataDir,
  paidOrder,
  refundPost,
  runWorkerOk,
  startApi,
} from '../lib/system.mjs';

function assertError(res, status, code, label) {
  assert.equal(res.status, status, `${label}: expected HTTP ${status}, got ${res.status} ${res.text}`);
  assert.equal(res.body?.error?.code, code, `${label}: expected error.code ${code}, got ${res.text}`);
}

test('R1 a refund is accepted as pending, listed, and announced with a valid event', async (t) => {
  const data = await newDataDir(t);
  const api = await startApi(t, data);
  const order = await paidOrder(api.url, data, 1000);
  const res = await refundPost(api.url, order.order_id, { amount_cents: 400, reason: 'damaged item' }, 'r1-key');
  assert.equal(res.status, 202, res.text);
  const refund = res.body.refund;
  assert.equal(typeof refund.refund_id, 'string');
  assert.ok(refund.refund_id.length > 0);
  assert.equal(refund.order_id, order.order_id);
  assert.equal(refund.amount_cents, 400);
  assert.equal(refund.reason, 'damaged item');
  assert.equal(refund.status, 'pending');
  assert.equal(typeof refund.created_at, 'string');

  const refunds = await listRefunds(api.url, order.order_id);
  assert.deepEqual(refunds.map((r) => r.refund_id), [refund.refund_id]);

  const events = await assertEventsValid(api.url, order.order_id);
  const requested = events.filter((e) => e.type === 'refund.requested');
  assert.equal(requested.length, 1);
  assert.deepEqual(requested[0].data, { order_id: order.order_id, refund_id: refund.refund_id, amount_cents: 400 });

  const fetched = await http(api.url, 'GET', `/orders/${order.order_id}`);
  assert.equal(fetched.body.order.refunded_cents, 0, 'pending refunds are not yet refunded');
});

test('R2 replaying the same key and body returns the original refund without side effects', async (t) => {
  const data = await newDataDir(t);
  const api = await startApi(t, data);
  const order = await paidOrder(api.url, data, 1000);
  const first = await refundPost(api.url, order.order_id, { amount_cents: 250 }, 'r2-key');
  const again = await refundPost(api.url, order.order_id, { amount_cents: 250 }, 'r2-key');
  assert.equal(first.status, 202, first.text);
  assert.equal(again.status, 202, again.text);
  assert.deepEqual(again.body, first.body);
  assert.equal(again.headers.get('idempotent-replayed'), 'true');
  assert.equal((await listRefunds(api.url, order.order_id)).length, 1);
  const events = await assertEventsValid(api.url, order.order_id);
  assert.equal(events.filter((e) => e.type === 'refund.requested').length, 1);
});

test('R3 a reused key with a different body is refused; keys are scoped per order', async (t) => {
  const data = await newDataDir(t);
  const api = await startApi(t, data);
  const a = await paidOrder(api.url, data, 1000);
  const b = await paidOrder(api.url, data, 1000);
  assert.equal((await refundPost(api.url, a.order_id, { amount_cents: 100 }, 'shared-key')).status, 202);
  assertError(
    await refundPost(api.url, a.order_id, { amount_cents: 101 }, 'shared-key'),
    409,
    'IDEMPOTENCY_KEY_REUSED',
    'same key, different amount',
  );
  const other = await refundPost(api.url, b.order_id, { amount_cents: 100 }, 'shared-key');
  assert.equal(other.status, 202, `the same key on another order is a new refund: ${other.text}`);
  assert.equal(other.headers.get('idempotent-replayed'), null);
  assert.equal((await listRefunds(api.url, a.order_id)).length, 1);
  assert.equal((await listRefunds(api.url, b.order_id)).length, 1);
});

test('R4 invalid refunds are refused with the documented error codes', async (t) => {
  const data = await newDataDir(t);
  const api = await startApi(t, data);
  const paid = await paidOrder(api.url, data, 1000);
  const id = paid.order_id;

  assertError(await refundPost(api.url, id, { amount_cents: 100 }), 400, 'IDEMPOTENCY_KEY_REQUIRED', 'no key');
  for (const amount of [0, -5, 1.5, '100', null]) {
    assertError(await refundPost(api.url, id, { amount_cents: amount }, `bad-${String(amount)}`), 400, 'VALIDATION_FAILED', `amount ${amount}`);
  }
  assertError(await refundPost(api.url, id, {}, 'no-amount'), 400, 'VALIDATION_FAILED', 'missing amount');
  assertError(
    await refundPost(api.url, id, { amount_cents: 10, reason: 'x'.repeat(201) }, 'long-reason'),
    400,
    'VALIDATION_FAILED',
    'reason longer than 200 characters',
  );
  assertError(await refundPost(api.url, 'ord_doesnotexist', { amount_cents: 10 }, 'k404'), 404, 'ORDER_NOT_FOUND', 'unknown order');
  assertError(await refundPost(api.url, id, { amount_cents: 1001 }, 'too-much'), 422, 'REFUND_EXCEEDS_CAPTURED', 'over captured');

  const unpaid = await http(api.url, 'POST', '/orders', { amount_cents: 500, currency: 'USD' });
  assertError(
    await refundPost(api.url, unpaid.body.order.order_id, { amount_cents: 10 }, 'unpaid'),
    409,
    'ORDER_NOT_CAPTURED',
    'pending_payment order',
  );
  const declined = await http(api.url, 'POST', '/orders', { amount_cents: 3013, currency: 'USD' });
  await http(api.url, 'POST', `/orders/${declined.body.order.order_id}/capture`);
  await runWorkerOk(data);
  assertError(
    await refundPost(api.url, declined.body.order.order_id, { amount_cents: 10 }, 'declined'),
    409,
    'ORDER_NOT_CAPTURED',
    'payment_failed order',
  );
  assert.equal((await listRefunds(api.url, id)).length, 0, 'refused requests create no refunds');
});

test('R5 concurrent retries with one key create exactly one refund across two API processes', async (t) => {
  const data = await newDataDir(t);
  const [a, b] = [await startApi(t, data), await startApi(t, data)];
  const order = await paidOrder(a.url, data, 1000);
  const results = await Promise.all(
    Array.from({ length: 24 }, (_, i) =>
      refundPost((i % 2 ? a : b).url, order.order_id, { amount_cents: 300, reason: 'retry storm' }, 'storm-key'),
    ),
  );
  assert.deepEqual(new Set(results.map((r) => r.status)), new Set([202]), results.map((r) => r.text).join('\n'));
  assert.equal(new Set(results.map((r) => r.body.refund.refund_id)).size, 1);
  assert.equal((await listRefunds(a.url, order.order_id)).length, 1);
  const events = await assertEventsValid(a.url, order.order_id);
  assert.equal(events.filter((e) => e.type === 'refund.requested').length, 1);
});

test('R6 concurrent refunds with distinct keys never exceed the captured amount', async (t) => {
  const data = await newDataDir(t);
  const [a, b] = [await startApi(t, data), await startApi(t, data)];
  const order = await paidOrder(a.url, data, 1000);
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      refundPost((i % 2 ? a : b).url, order.order_id, { amount_cents: 300 }, `distinct-${i}`),
    ),
  );
  const accepted = results.filter((r) => r.status === 202);
  const refused = results.filter((r) => r.status !== 202);
  assert.equal(accepted.length, 3, results.map((r) => `${r.status} ${r.text}`).join('\n'));
  for (const r of refused) assertError(r, 422, 'REFUND_EXCEEDS_CAPTURED', 'over-refund');
  const refunds = await listRefunds(a.url, order.order_id);
  assert.equal(refunds.length, 3);
  assert.equal(refunds.reduce((sum, r) => sum + r.amount_cents, 0), 900);
});
