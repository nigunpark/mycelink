import { randomUUID } from 'node:crypto';
import { assertAmountCents } from './money.mjs';
import { validationError } from './errors.mjs';

export const REFUND_STATUS = Object.freeze({
  PENDING: 'pending',
  PROCESSING: 'processing',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
});

export const MAX_REFUND_REASON_LENGTH = 200;

/** Validate a refund request body; returns the normalised fields. */
export function parseRefundRequest(body) {
  const amount_cents = assertAmountCents(body?.amount_cents);
  const reason = body?.reason ?? null;
  if (reason !== null && (typeof reason !== 'string' || reason.length > MAX_REFUND_REASON_LENGTH)) {
    throw validationError(`reason must be a string of at most ${MAX_REFUND_REASON_LENGTH} characters`, {
      field: 'reason',
    });
  }
  return { amount_cents, reason };
}

export function newRefund({ order_id, amount_cents, reason }, now = new Date()) {
  const at = now.toISOString();
  return {
    refund_id: `ref_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
    order_id,
    amount_cents,
    reason,
    status: REFUND_STATUS.PENDING,
    gateway_ref: null,
    failure_code: null,
    created_at: at,
    updated_at: at,
  };
}

/** Captured amount minus every refund that has not failed. */
export function refundableCents(order, refunds) {
  const reserved = refunds
    .filter((r) => r.status !== REFUND_STATUS.FAILED)
    .reduce((sum, r) => sum + r.amount_cents, 0);
  return order.captured_cents - reserved;
}
