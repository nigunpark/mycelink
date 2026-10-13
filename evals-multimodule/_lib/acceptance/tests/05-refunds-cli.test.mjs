/** Operator CLI for refunds. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listRefunds, newDataDir, paidOrder, runCli, runWorkerOk, startApi } from '../lib/system.mjs';

test('L1 `ledger refunds create` is idempotent through the CLI', async (t) => {
  const data = await newDataDir(t);
  const api = await startApi(t, data);
  const order = await paidOrder(api.url, data, 900);
  const args = ['refunds', 'create', order.order_id, '--amount', '250', '--key', 'cli-key-1', '--reason', 'late delivery'];
  const first = await runCli(args, { apiUrl: api.url });
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.json?.order_id, order.order_id, `stdout must be the refund JSON: ${first.stdout}`);
  assert.equal(first.json.amount_cents, 250);
  assert.equal(first.json.reason, 'late delivery');
  assert.equal(first.json.status, 'pending');
  const again = await runCli(args, { apiUrl: api.url });
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.json.refund_id, first.json.refund_id);
  assert.equal((await listRefunds(api.url, order.order_id)).length, 1);
});

test('L2 `ledger refunds list` prints the refunds as a JSON array', async (t) => {
  const data = await newDataDir(t);
  const api = await startApi(t, data);
  const order = await paidOrder(api.url, data, 900);
  await runCli(['refunds', 'create', order.order_id, '--amount', '100', '--key', 'l2-a'], { apiUrl: api.url });
  await runCli(['refunds', 'create', order.order_id, '--amount', '200', '--key', 'l2-b'], { apiUrl: api.url });
  await runWorkerOk(data);
  const listed = await runCli(['refunds', 'list', order.order_id], { apiUrl: api.url });
  assert.equal(listed.code, 0, listed.stderr);
  assert.ok(Array.isArray(listed.json), `stdout must be a JSON array: ${listed.stdout}`);
  assert.deepEqual(listed.json.map((r) => r.amount_cents), [100, 200]);
  assert.deepEqual(listed.json.map((r) => r.status), ['succeeded', 'succeeded']);
});

test('L3 API refusals surface as the error envelope with exit code 1', async (t) => {
  const data = await newDataDir(t);
  const api = await startApi(t, data);
  const order = await paidOrder(api.url, data, 900);
  const res = await runCli(['refunds', 'create', order.order_id, '--amount', '901', '--key', 'l3'], { apiUrl: api.url });
  assert.equal(res.code, 1, res.stdout + res.stderr);
  assert.equal(res.errorJson?.error?.code, 'REFUND_EXCEEDS_CAPTURED', `stderr: ${res.stderr}`);
});

test('L4 a refund without --key is a usage error and never reaches the API', async (t) => {
  const data = await newDataDir(t);
  const api = await startApi(t, data);
  const order = await paidOrder(api.url, data, 900);
  const res = await runCli(['refunds', 'create', order.order_id, '--amount', '100'], { apiUrl: api.url });
  assert.equal(res.code, 2, res.stdout + res.stderr);
  const bad = await runCli(['refunds', 'create', order.order_id, '--amount', '1.5', '--key', 'l4'], { apiUrl: api.url });
  assert.equal(bad.code, 2, bad.stdout + bad.stderr);
  assert.equal((await listRefunds(api.url, order.order_id)).length, 0);
});
