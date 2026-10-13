import { ORDER_STATUS, makeEvent } from '../../vendor/ledger-core/index.mjs';

/**
 * payment.capture — charge the order once.
 *
 * Jobs are delivered at least once (and may be redelivered by operators), so
 * the handler moves the order capture_pending -> capturing under the order
 * lock before calling the gateway. Any other status means another delivery
 * already owns or finished the capture, and this delivery is a no-op.
 */
export async function handleCapture(job, { store, gateway }) {
  const orderId = job.order_id;
  const order = await store.withLock(`order-${orderId}`, async () => {
    const current = await store.readOrder(orderId);
    if (current === null || current.status !== ORDER_STATUS.CAPTURE_PENDING) return null;
    const owned = { ...current, status: ORDER_STATUS.CAPTURING, updated_at: new Date().toISOString() };
    await store.writeOrder(owned);
    return owned;
  });
  if (order === null) return 'skipped';

  const result = await gateway.capture({ ref: orderId, amount_cents: order.amount_cents });

  await store.withLock(`order-${orderId}`, async () => {
    const current = await store.readOrder(orderId);
    const now = new Date().toISOString();
    if (result.ok) {
      await store.writeOrder({
        ...current,
        status: ORDER_STATUS.PAID,
        captured_cents: current.amount_cents,
        gateway_ref: result.gateway_ref,
        updated_at: now,
      });
      await store.appendEvent(
        makeEvent('payment.captured', {
          order_id: orderId,
          amount_cents: current.amount_cents,
          gateway_ref: result.gateway_ref,
        }),
      );
    } else {
      await store.writeOrder({
        ...current,
        status: ORDER_STATUS.PAYMENT_FAILED,
        failure_code: result.decline_code,
        updated_at: now,
      });
      await store.appendEvent(makeEvent('payment.failed', { order_id: orderId, reason: result.decline_code }));
    }
  });
  return 'done';
}
