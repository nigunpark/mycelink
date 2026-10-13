import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { main } from '../src/main.mjs';

test('refunds create sends the key and prints the refund; --key is mandatory', async (t) => {
  const seen = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    seen.push({ url: req.url, key: req.headers['idempotency-key'], body: raw ? JSON.parse(raw) : undefined });
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ refund: { refund_id: 'ref_1', amount_cents: 5 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const api = `http://127.0.0.1:${server.address().port}`;
  const out = [];
  const io = { out: (l) => out.push(l), err: () => {} };

  assert.equal(await main(['--api', api, 'refunds', 'create', 'ord_abcd', '--amount', '5', '--key', 'k', '--reason', 'r'], io), 0);
  assert.deepEqual(JSON.parse(out[0]), { refund_id: 'ref_1', amount_cents: 5 });
  assert.deepEqual(seen[0], { url: '/orders/ord_abcd/refunds', key: 'k', body: { amount_cents: 5, reason: 'r' } });

  assert.equal(await main(['--api', api, 'refunds', 'create', 'ord_abcd', '--amount', '5'], io), 2);
  assert.equal(seen.length, 1);
});
