import { ORDER_STATUS, REFUND_STATUS, makeEvent } from '../../vendor/ledger-core/index.mjs';

/**
 * refund.process — return money once per refund.
 *
 * Like capture: own the refund (pending -> processing) under the order lock
 * before calling the gateway, so redelivered or concurrent jobs skip it.
 */
export async function handleRefund(job, { store, gateway }) {
  const { order_id: orderId, refund_id: refundId } = job;
  const replace = (list, updated) => list.map((r) => (r.refund_id === refundId ? updated : r));

  const refund = await store.withLock(`order-${orderId}`, async () => {
    const refunds = await store.readRefunds(orderId);
    const current = refunds.find((r) => r.refund_id === refundId);
    if (current === undefined || current.status !== REFUND_STATUS.PENDING) return null;
    const owned = { ...current, status: REFUND_STATUS.PROCESSING, updated_at: new Date().toISOString() };
    await store.writeRefunds(orderId, replace(refunds, owned));
    return owned;
  });
  if (refund === null) return 'skipped';

  const result = await gateway.refund({ ref: refundId, amount_cents: refund.amount_cents });

  await store.withLock(`order-${orderId}`, async () => {
    const refunds = await store.readRefunds(orderId);
    const order = await store.readOrder(orderId);
    const now = new Date().toISOString();
    const current = refunds.find((r) => r.refund_id === refundId);
    if (result.ok) {
      await store.writeRefunds(
        orderId,
        replace(refunds, { ...current, status: REFUND_STATUS.SUCCEEDED, gateway_ref: result.gateway_ref, updated_at: now }),
      );
      const refunded = (order.refunded_cents ?? 0) + current.amount_cents;
      await store.writeOrder({
        ...order,
        refunded_cents: refunded,
        status: refunded >= order.captured_cents ? ORDER_STATUS.REFUNDED : ORDER_STATUS.PARTIALLY_REFUNDED,
        updated_at: now,
      });
      await store.appendEvent(
        makeEvent('refund.succeeded', {
          order_id: orderId,
          refund_id: refundId,
          amount_cents: current.amount_cents,
          gateway_ref: result.gateway_ref,
        }),
      );
    } else {
      await store.writeRefunds(
        orderId,
        replace(refunds, { ...current, status: REFUND_STATUS.FAILED, failure_code: result.decline_code, updated_at: now }),
      );
      await store.appendEvent(
        makeEvent('refund.failed', { order_id: orderId, refund_id: refundId, reason: result.decline_code }),
      );
    }
  });
  return 'done';
}
