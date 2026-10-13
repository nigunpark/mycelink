/** Refund settlement in the worker: gateway exactly-once, declines, order totals. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertEventsValid,
  gatewayCalls,
  http,
  listRefunds,
  newDataDir,
  paidOrder,
  refundPost,
  runWorkerOk,
  startApi,
} from '../lib/system.mjs';

async function getOrder(apiUrl, id) {
  return (await http(apiUrl, 'GET', `/orders/${id}`)).body.order;
}

test('W1 the worker settles refunds and the order tracks refunded totals', async (t) => {
  const data = await newDataDir(t);
  const api = await startApi(t, data);
  const order = await paidOrder(api.url, data, 1000);
  const first = await refundPost(api.url, order.order_id, { amount_cents: 400 }, 'w1-a');
  assert.equal(first.status, 202, first.text);
  await runWorkerOk(data);

  let refunds = await listRefunds(api.url, order.order_id);
  assert.equal(refunds[0].status, 'succeeded');
  assert.equal(typeof refunds[0].gateway_ref, 'string');
  assert.ok(refunds[0].gateway_ref.length > 0);
  let current = await getOrder(api.url, order.order_id);
  assert.equal(current.refunded_cents, 400);
  assert.equal(current.status, 'partially_refunded');

  const rest = await refundPost(api.url, order.order_id, { amount_cents: 600 }, 'w1-b');
  assert.equal(rest.status, 202, rest.text);
  await runWorkerOk(data);
  refunds = await listRefunds(api.url, order.order_id);
  assert.deepEqual(refunds.map((r) => r.status), ['succeeded', 'succeeded'], 'refunds list in creation order');
  current = await getOrder(api.url, order.order_id);
  assert.equal(current.refunded_cents, 1000);
  assert.equal(current.status, 'refunded');

  const events = await assertEventsValid(api.url, order.order_id);
  const succeeded = events.filter((e) => e.type === 'refund.succeeded');
  assert.equal(succeeded.length, 2);
  assert.deepEqual(
    succeeded.map((e) => e.data.refund_id).sort(),
    refunds.map((r) => r.refund_id).sort(),
  );

  const more = await refundPost(api.url, order.order_id, { amount_cents: 1 }, 'w1-c');
  assert.equal(more.status, 422, more.text);
  assert.equal(more.body.error.code, 'REFUND_EXCEEDS_CAPTURED');
});

test('W2 each refund reaches the gateway exactly once under concurrent workers and redelivery', async (t) => {
  const data = await newDataDir(t);
  const api = await startApi(t, data);
  const order = await paidOrder(api.url, data, 1000);
  const ids = [];
  for (let i = 0; i < 4; i++) {
    const res = await refundPost(api.url, order.order_id, { amount_cents: 100 + i }, `w2-${i}`);
    assert.equal(res.status, 202, res.text);
    ids.push(res.body.refund.refund_id);
  }
  await Promise.all([1, 2, 3].map(() => runWorkerOk(data, { delayMs: 25 })));
  const redeliver = await http(api.url, 'POST', '/admin/jobs/redeliver');
  assert.equal(redeliver.status, 200);
  assert.ok(redeliver.body.redelivered >= 4, `redelivered ${redeliver.text}`);
  await Promise.all([1, 2].map(() => runWorkerOk(data, { delayMs: 25 })));

  const calls = await gatewayCalls(data);
  for (const id of ids) {
    assert.equal(calls.filter((c) => c.op === 'refund' && c.ref === id).length, 1, `gateway refund calls for ${id}`);
  }
  assert.equal(calls.filter((c) => c.op === 'capture' && c.ref === order.order_id).length, 1);
  const refunds = await listRefunds(api.url, order.order_id);
  assert.deepEqual(new Set(refunds.map((r) => r.status)), new Set(['succeeded']));
  assert.equal((await getOrder(api.url, order.order_id)).refunded_cents, 100 + 101 + 102 + 103);
  const events = await assertEventsValid(api.url, order.order_id);
  assert.equal(events.filter((e) => e.type === 'refund.succeeded').length, 4, 'one refund.succeeded per refund');
});

test('W3 a declined refund fails, emits refund.failed and releases its amount', async (t) => {
  const data = await newDataDir(t);
  const api = await startApi(t, data);
  const order = await paidOrder(api.url, data, 5000);
  const declined = await refundPost(api.url, order.order_id, { amount_cents: 1013 }, 'w3-declined');
  assert.equal(declined.status, 202, declined.text);
  await runWorkerOk(data);

  const [refund] = await listRefunds(api.url, order.order_id);
  assert.equal(refund.status, 'failed');
  assert.equal(refund.failure_code, 'card_declined');
  let current = await getOrder(api.url, order.order_id);
  assert.equal(current.refunded_cents, 0);
  assert.equal(current.status, 'paid');
  let events = await assertEventsValid(api.url, order.order_id);
  const failed = events.filter((e) => e.type === 'refund.failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].data.refund_id, refund.refund_id);

  const full = await refundPost(api.url, order.order_id, { amount_cents: 5000 }, 'w3-full');
  assert.equal(full.status, 202, `a failed refund no longer reserves its amount: ${full.text}`);
  await runWorkerOk(data);
  current = await getOrder(api.url, order.order_id);
  assert.equal(current.refunded_cents, 5000);
  assert.equal(current.status, 'refunded');
  events = await assertEventsValid(api.url, order.order_id);
  assert.equal(events.filter((e) => e.type === 'refund.succeeded').length, 1);
});
