import { randomUUID } from 'node:crypto';
import { assertAmountCents, assertCurrency } from './money.mjs';
import { validationError } from './errors.mjs';

export const ORDER_STATUS = Object.freeze({
  PENDING_PAYMENT: 'pending_payment',
  CAPTURE_PENDING: 'capture_pending',
  CAPTURING: 'capturing',
  PAID: 'paid',
  PAYMENT_FAILED: 'payment_failed',
  PARTIALLY_REFUNDED: 'partially_refunded',
  REFUNDED: 'refunded',
});

/** Order statuses that have captured money and may be refunded. */
export const REFUNDABLE_ORDER_STATUSES = Object.freeze([
  ORDER_STATUS.PAID,
  ORDER_STATUS.PARTIALLY_REFUNDED,
  ORDER_STATUS.REFUNDED,
]);

const ORDER_ID = /^ord_[A-Za-z0-9_-]{4,64}$/;

export function assertOrderId(value) {
  if (typeof value !== 'string' || !ORDER_ID.test(value)) {
    throw validationError('order_id must look like ord_<4-64 letters, digits, "_" or "-">', {
      field: 'order_id',
    });
  }
  return value;
}

export function newOrderId() {
  return `ord_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

/** A fresh order document. Persisted as-is by the store. */
export function newOrder({ order_id, amount_cents, currency }, now = new Date()) {
  const id = order_id === undefined ? newOrderId() : assertOrderId(order_id);
  const at = now.toISOString();
  return {
    order_id: id,
    amount_cents: assertAmountCents(amount_cents),
    currency: assertCurrency(currency),
    status: ORDER_STATUS.PENDING_PAYMENT,
    captured_cents: 0,
    refunded_cents: 0,
    gateway_ref: null,
    failure_code: null,
    created_at: at,
    updated_at: at,
  };
}

/** Orders written before refunds existed have no refunded_cents. */
export function withOrderDefaults(order) {
  return order === null ? null : { refunded_cents: 0, ...order };
}
