import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ERROR_CODES,
  REFUND_STATUS,
  httpStatusFor,
  makeEvent,
  newRefund,
  parseRefundRequest,
  refundableCents,
  validateEvent,
} from '../src/index.mjs';

test('refund events are closed v1 contracts', () => {
  const ok = makeEvent('refund.succeeded', { order_id: 'ord_abcd', refund_id: 'ref_1', amount_cents: 5, gateway_ref: 'gw' });
  assert.deepEqual(validateEvent(ok).errors, []);
  assert.equal(validateEvent({ ...ok, data: { ...ok.data, extra: true } }).ok, false);
});

test('refund error codes map to their HTTP statuses', () => {
  assert.equal(httpStatusFor(ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED), 400);
  assert.equal(httpStatusFor(ERROR_CODES.ORDER_NOT_CAPTURED), 409);
  assert.equal(httpStatusFor(ERROR_CODES.REFUND_EXCEEDS_CAPTURED), 422);
});

test('refund requests are validated', () => {
  assert.deepEqual(parseRefundRequest({ amount_cents: 5 }), { amount_cents: 5, reason: null });
  assert.throws(() => parseRefundRequest({ amount_cents: 0 }));
  assert.throws(() => parseRefundRequest({ amount_cents: 5, reason: 'x'.repeat(201) }));
});

test('failed refunds do not reserve the captured amount', () => {
  const order = { captured_cents: 1000 };
  const refunds = [
    { ...newRefund({ order_id: 'ord_abcd', amount_cents: 300, reason: null }), status: REFUND_STATUS.SUCCEEDED },
    { ...newRefund({ order_id: 'ord_abcd', amount_cents: 200, reason: null }), status: REFUND_STATUS.FAILED },
    newRefund({ order_id: 'ord_abcd', amount_cents: 100, reason: null }),
  ];
  assert.equal(refundableCents(order, refunds), 600);
});
