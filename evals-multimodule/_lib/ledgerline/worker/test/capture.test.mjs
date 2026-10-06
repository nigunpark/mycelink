import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, newOrder, ORDER_STATUS, validateEvent } from '../vendor/ledger-core/index.mjs';
import { FakeGateway } from '../src/gateway.mjs';
import { drain } from '../src/worker.mjs';

async function setup(t, amount_cents) {
  const dir = await mkdtemp(join(tmpdir(), 'ledger-worker-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await openStore(dir);
  const order = { ...newOrder({ amount_cents, currency: 'USD' }), status: ORDER_STATUS.CAPTURE_PENDING };
  await store.writeOrder(order);
  await store.enqueue({ type: 'payment.capture', order_id: order.order_id });
  return { dir, store, order, deps: { store, gateway: new FakeGateway({ dataDir: dir, delayMs: 5 }) } };
}

async function gatewayCalls(dir) {
  const text = await readFile(join(dir, 'gateway', 'calls.jsonl'), 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('a capture job charges the order and marks it paid', async (t) => {
  const { dir, store, order, deps } = await setup(t, 4200);
  await drain(deps);
  const paid = await store.readOrder(order.order_id);
  assert.equal(paid.status, 'paid');
  assert.equal(paid.captured_cents, 4200);
  assert.equal((await gatewayCalls(dir)).length, 1);
  const events = await store.listEvents(order.order_id);
  assert.deepEqual(events.map((e) => e.type), ['payment.captured']);
  assert.equal(validateEvent(events[0]).ok, true);
});

test('a declined capture marks the order payment_failed', async (t) => {
  const { store, order, deps } = await setup(t, 1013);
  await drain(deps);
  const failed = await store.readOrder(order.order_id);
  assert.equal(failed.status, 'payment_failed');
  assert.equal(failed.failure_code, 'card_declined');
});

test('redelivered and concurrent deliveries charge exactly once', async (t) => {
  const { dir, store, order, deps } = await setup(t, 999);
  await store.enqueue({ type: 'payment.capture', order_id: order.order_id });
  await Promise.all([drain(deps), drain(deps), drain(deps)]);
  await store.redeliverAll();
  await Promise.all([drain(deps), drain(deps)]);
  const calls = (await gatewayCalls(dir)).filter((c) => c.ref === order.order_id);
  assert.equal(calls.length, 1);
});

test('unknown job types are dead-lettered, not retried forever', async (t) => {
  const { store, deps } = await setup(t, 100);
  await store.enqueue({ type: 'mystery.job' });
  const outcomes = await drain(deps);
  assert.ok(outcomes.includes('dead'));
});
