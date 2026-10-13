import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, withIdempotency, requestFingerprint, ERROR_CODES } from '../src/index.mjs';

async function tempStore(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ledger-core-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return openStore(dir);
}

test('withLock serialises concurrent critical sections', async (t) => {
  const store = await tempStore(t);
  let inside = 0;
  let maxInside = 0;
  await Promise.all(
    Array.from({ length: 10 }, () =>
      store.withLock('x', async () => {
        inside += 1;
        maxInside = Math.max(maxInside, inside);
        await new Promise((r) => setTimeout(r, 3));
        inside -= 1;
      }),
    ),
  );
  assert.equal(maxInside, 1);
});

test('a job can be claimed only once', async (t) => {
  const store = await tempStore(t);
  await store.enqueue({ type: 'noop' });
  const claims = await Promise.all([store.claimJob(), store.claimJob(), store.claimJob()]);
  assert.equal(claims.filter(Boolean).length, 1);
});

test('redeliverAll puts finished jobs back on the queue', async (t) => {
  const store = await tempStore(t);
  await store.enqueue({ type: 'noop' });
  const claim = await store.claimJob();
  await store.finishJob(claim);
  assert.equal(await store.redeliverAll(), 1);
  assert.ok(await store.claimJob());
});

test('withIdempotency executes once and refuses a reused key with a new body', async (t) => {
  const store = await tempStore(t);
  let runs = 0;
  const call = (body) =>
    withIdempotency(store, { scope: 's', key: 'k-1', fingerprint: requestFingerprint(body) }, async () => {
      runs += 1;
      return { status: 201, body: { n: runs } };
    });
  const results = await Promise.all([call({ a: 1 }), call({ a: 1 }), call({ a: 1 })]);
  assert.equal(runs, 1);
  assert.deepEqual(new Set(results.map((r) => r.body.n)), new Set([1]));
  await assert.rejects(call({ a: 2 }), (e) => e.code === ERROR_CODES.IDEMPOTENCY_KEY_REUSED);
});
