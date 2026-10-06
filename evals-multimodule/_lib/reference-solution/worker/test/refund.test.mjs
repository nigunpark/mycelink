import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, newOrder, newRefund, ORDER_STATUS } from '../vendor/ledger-core/index.mjs';
import { FakeGateway } from '../src/gateway.mjs';
import { drain } from '../src/worker.mjs';

async function setup(t, amounts) {
  const dir = await mkdtemp(join(tmpdir(), 'ledger-worker-refund-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await openStore(dir);
  const order = { ...newOrder({ amount_cents: 1000, currency: 'USD' }), status: ORDER_STATUS.PAID, captured_cents: 1000 };
  await store.writeOrder(order);
  const refunds = amounts.map((amount_cents) => newRefund({ order_id: order.order_id, amount_cents, reason: null }));
  await store.writeRefunds(order.order_id, refunds);
  for (const r of refunds) await store.enqueue({ type: 'refund.process', order_id: order.order_id, refund_id: r.refund_id });
  return { dir, store, order, refunds, deps: { store, gateway: new FakeGateway({ dataDir: dir, delayMs: 5 }) } };
}

test('refunds settle once despite redelivery and concurrent workers', async (t) => {
  const { dir, store, order, deps } = await setup(t, [100, 200]);
  await Promise.all([drain(deps), drain(deps), drain(deps)]);
  await store.redeliverAll();
  await Promise.all([drain(deps), drain(deps)]);
  const calls = (await readFile(join(dir, 'gateway', 'calls.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(calls.length, 2);
  const updated = await store.readOrder(order.order_id);
  assert.equal(updated.refunded_cents, 300);
  assert.equal(updated.status, 'partially_refunded');
});

test('a declined refund fails and leaves the order total alone', async (t) => {
  const { store, order, deps } = await setup(t, [13]);
  await drain(deps);
  const [refund] = await store.readRefunds(order.order_id);
  assert.equal(refund.status, 'failed');
  assert.equal(refund.failure_code, 'card_declined');
  assert.equal((await store.readOrder(order.order_id)).refunded_cents, 0);
});
