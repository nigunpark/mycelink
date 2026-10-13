import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { main } from '../src/main.mjs';

/** A stub API that records requests and answers from a table. */
async function stubApi(t, answer) {
  const seen = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const entry = { method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : undefined };
    seen.push(entry);
    const [status, body] = answer(entry);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

function capture() {
  const lines = { out: [], err: [] };
  return { lines, io: { out: (l) => lines.out.push(l), err: (l) => lines.err.push(l) } };
}

test('orders create sends cents, currency and the idempotency key', async (t) => {
  const api = await stubApi(t, () => [201, { order: { order_id: 'ord_abcd', status: 'pending_payment' } }]);
  const { lines, io } = capture();
  const code = await main(['--api', api.url, 'orders', 'create', '--amount', '1500', '--currency', 'EUR', '--key', 'k1'], io);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(lines.out[0]), { order_id: 'ord_abcd', status: 'pending_payment' });
  assert.deepEqual(api.seen[0].body, { amount_cents: 1500, currency: 'EUR' });
  assert.equal(api.seen[0].headers['idempotency-key'], 'k1');
});

test('API errors are printed as the error envelope with exit code 1', async (t) => {
  const api = await stubApi(t, () => [404, { error: { code: 'ORDER_NOT_FOUND', message: 'nope' } }]);
  const { lines, io } = capture();
  const code = await main(['orders', 'show', 'ord_nope1'], { ...io, env: { LEDGER_API_URL: api.url } });
  assert.equal(code, 1);
  assert.equal(JSON.parse(lines.err[0]).error.code, 'ORDER_NOT_FOUND');
});

test('invalid amounts are usage errors and never reach the API', async (t) => {
  const api = await stubApi(t, () => [500, {}]);
  const { io } = capture();
  assert.equal(await main(['--api', api.url, 'orders', 'create', '--amount', '0'], io), 2);
  assert.equal(await main(['--api', api.url, 'orders', 'create', '--amount', '1.5'], io), 2);
  assert.equal(await main(['--api', api.url, 'orders', 'explode'], io), 2);
  assert.equal(api.seen.length, 0);
});
