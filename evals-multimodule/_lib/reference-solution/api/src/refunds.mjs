import {
  DomainError,
  ERROR_CODES,
  REFUNDABLE_ORDER_STATUSES,
  assertOrderId,
  makeEvent,
  newRefund,
  parseRefundRequest,
  refundableCents,
  requestFingerprint,
  withIdempotency,
} from '../vendor/ledger-core/index.mjs';
import { loadOrder } from './orders.mjs';

/**
 * POST /orders/:order_id/refunds
 *
 * Idempotency lock (per order and key) -> order lock: the reservation check
 * and the write of the new refund happen atomically across API processes.
 */
export async function postRefund(ctx) {
  const key = ctx.headers['idempotency-key'];
  if (key === undefined || key === '') {
    throw new DomainError(ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED, 'an Idempotency-Key header is required');
  }
  const request = parseRefundRequest(ctx.body);
  const orderId = assertOrderId(ctx.params.order_id);
  await loadOrder(ctx.store, orderId);

  return withIdempotency(
    ctx.store,
    { scope: `refunds-${orderId}`, key, fingerprint: requestFingerprint(ctx.body) },
    () =>
      ctx.store.withLock(`order-${orderId}`, async () => {
        const order = await loadOrder(ctx.store, orderId);
        if (!REFUNDABLE_ORDER_STATUSES.includes(order.status)) {
          throw new DomainError(ERROR_CODES.ORDER_NOT_CAPTURED, `order is ${order.status}`);
        }
        const refunds = await ctx.store.readRefunds(orderId);
        const available = refundableCents(order, refunds);
        if (request.amount_cents > available) {
          throw new DomainError(
            ERROR_CODES.REFUND_EXCEEDS_CAPTURED,
            `only ${available} cents can still be refunded`,
            { refundable_cents: available },
          );
        }
        const refund = newRefund({ order_id: orderId, ...request });
        await ctx.store.writeRefunds(orderId, [...refunds, refund]);
        await ctx.store.appendEvent(
          makeEvent('refund.requested', {
            order_id: orderId,
            refund_id: refund.refund_id,
            amount_cents: refund.amount_cents,
          }),
        );
        await ctx.store.enqueue({ type: 'refund.process', order_id: orderId, refund_id: refund.refund_id });
        return { status: 202, body: { refund } };
      }),
  );
}

/** GET /orders/:order_id/refunds */
export async function listRefunds(ctx) {
  const order = await loadOrder(ctx.store, ctx.params.order_id);
  return { status: 200, body: { refunds: await ctx.store.readRefunds(order.order_id) } };
}
