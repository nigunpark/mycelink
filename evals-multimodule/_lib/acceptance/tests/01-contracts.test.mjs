import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { importCore, systemDir } from '../lib/system.mjs';

function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p).split(sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

const lf = (path) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

function treeSha256(dir) {
  const h = createHash('sha256');
  for (const rel of listFiles(dir)) {
    h.update(`${rel}\0${createHash('sha256').update(lf(join(dir, rel))).digest('hex')}\n`);
  }
  return h.digest('hex');
}

test('C1 core publishes the refund error codes', async () => {
  const core = await importCore();
  for (const code of [
    'VALIDATION_FAILED',
    'ORDER_NOT_FOUND',
    'ORDER_NOT_CAPTURABLE',
    'IDEMPOTENCY_KEY_REUSED',
    'IDEMPOTENCY_KEY_REQUIRED',
    'ORDER_NOT_CAPTURED',
    'REFUND_EXCEEDS_CAPTURED',
  ]) {
    assert.equal(core.ERROR_CODES?.[code], code, `ERROR_CODES.${code}`);
  }
});

test('C2 core publishes refund and order status values', async () => {
  const core = await importCore();
  const refundStatuses = Object.values(core.REFUND_STATUS ?? {});
  for (const status of ['pending', 'succeeded', 'failed']) assert.ok(refundStatuses.includes(status), `REFUND_STATUS has ${status}`);
  const orderStatuses = Object.values(core.ORDER_STATUS ?? {});
  for (const status of ['pending_payment', 'paid', 'payment_failed', 'partially_refunded', 'refunded']) {
    assert.ok(orderStatuses.includes(status), `ORDER_STATUS has ${status}`);
  }
});

test('C3 refund events are versioned, closed contracts', async () => {
  const core = await importCore();
  const envelope = (type, data) => ({
    event_id: 'evt_acceptance',
    type,
    version: 1,
    occurred_at: '2026-01-01T00:00:00.000Z',
    data,
  });
  const samples = {
    'order.created': { order_id: 'ord_abcd', amount_cents: 100, currency: 'USD' },
    'payment.capture_requested': { order_id: 'ord_abcd', amount_cents: 100 },
    'payment.captured': { order_id: 'ord_abcd', amount_cents: 100, gateway_ref: 'gw_1' },
    'payment.failed': { order_id: 'ord_abcd', reason: 'card_declined' },
    'refund.requested': { order_id: 'ord_abcd', refund_id: 'ref_1234', amount_cents: 50 },
    'refund.succeeded': { order_id: 'ord_abcd', refund_id: 'ref_1234', amount_cents: 50, gateway_ref: 'gw_2' },
    'refund.failed': { order_id: 'ord_abcd', refund_id: 'ref_1234', reason: 'card_declined' },
  };
  for (const [type, data] of Object.entries(samples)) {
    assert.ok(core.EVENT_TYPES.includes(type), `EVENT_TYPES has ${type}`);
    assert.deepEqual(core.validateEvent(envelope(type, data)).errors, [], `${type} sample is valid`);
    assert.equal(core.validateEvent(envelope(type, { ...data, unexpected: 1 })).ok, false, `${type} is closed`);
    assert.equal(core.validateEvent({ ...envelope(type, data), version: 2 }).ok, false, `${type} is v1`);
  }
  const missing = { ...samples['refund.succeeded'] };
  delete missing.gateway_ref;
  assert.equal(core.validateEvent(envelope('refund.succeeded', missing)).ok, false, 'required fields are enforced');
});

test('C4 every consumer vendors exactly the delivered core, pinned by its lock', () => {
  const coreSrc = join(systemDir(), 'core', 'src');
  const corePkg = JSON.parse(readFileSync(join(systemDir(), 'core', 'package.json'), 'utf8'));
  const expected = treeSha256(coreSrc);
  for (const consumer of ['api', 'worker', 'cli']) {
    const vendored = join(systemDir(), consumer, 'vendor', 'ledger-core');
    const lockPath = join(systemDir(), consumer, 'vendor', 'ledger-core.lock.json');
    assert.ok(existsSync(vendored), `${consumer}: vendor/ledger-core/ is missing`);
    assert.ok(existsSync(lockPath), `${consumer}: vendor/ledger-core.lock.json is missing`);
    assert.deepEqual(listFiles(vendored), listFiles(coreSrc), `${consumer}: vendored file list differs from core/src`);
    for (const rel of listFiles(coreSrc)) {
      assert.equal(lf(join(vendored, rel)), lf(join(coreSrc, rel)), `${consumer}: vendor/ledger-core/${rel} is stale`);
    }
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    assert.equal(lock.package, '@ledgerline/core', `${consumer}: lock package`);
    assert.equal(lock.version, corePkg.version, `${consumer}: lock version matches core package.json`);
    assert.equal(lock.tree_sha256, expected, `${consumer}: lock tree_sha256`);
  }
});
