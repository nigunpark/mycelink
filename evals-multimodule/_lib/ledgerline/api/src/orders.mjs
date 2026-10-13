import {
  DomainError,
  ERROR_CODES,
  ORDER_STATUS,
  assertOrderId,
  makeEvent,
  newOrder,
  requestFingerprint,
  withIdempotency,
} from '../vendor/ledger-core/index.mjs';

export async function loadOrder(store, orderId) {
  assertOrderId(orderId);
  const order = await store.readOrder(orderId);
  if (order === null) throw new DomainError(ERROR_CODES.ORDER_NOT_FOUND, `order ${orderId} does not exist`);
  return order;
}

async function createOrder(store, body) {
  const order = newOrder(body);
  return store.withLock(`order-${order.order_id}`, async () => {
    if ((await store.readOrder(order.order_id)) !== null) {
      throw new DomainError(ERROR_CODES.VALIDATION_FAILED, `order ${order.order_id} already exists`, {
        field: 'order_id',
      });
    }
    await store.writeOrder(order);
    await store.appendEvent(
      makeEvent('order.created', {
        order_id: order.order_id,
        amount_cents: order.amount_cents,
        currency: order.currency,
      }),
    );
    return { status: 201, body: { order } };
  });
}

/** POST /orders — an Idempotency-Key header is optional here. */
export async function postOrder(ctx) {
  const key = ctx.headers['idempotency-key'];
  if (key === undefined) return createOrder(ctx.store, ctx.body);
  return withIdempotency(
    ctx.store,
    { scope: 'orders', key, fingerprint: requestFingerprint(ctx.body) },
    () => createOrder(ctx.store, ctx.body),
  );
}

export async function getOrder(ctx) {
  return { status: 200, body: { order: await loadOrder(ctx.store, ctx.params.order_id) } };
}

/** POST /orders/:order_id/capture — hands the capture to the worker. */
export async function captureOrder(ctx) {
  const orderId = assertOrderId(ctx.params.order_id);
  return ctx.store.withLock(`order-${orderId}`, async () => {
    const order = await loadOrder(ctx.store, orderId);
    if (order.status !== ORDER_STATUS.PENDING_PAYMENT) {
      throw new DomainError(ERROR_CODES.ORDER_NOT_CAPTURABLE, `order is ${order.status}`);
    }
    const updated = { ...order, status: ORDER_STATUS.CAPTURE_PENDING, updated_at: new Date().toISOString() };
    await ctx.store.writeOrder(updated);
    await ctx.store.appendEvent(
      makeEvent('payment.capture_requested', { order_id: orderId, amount_cents: order.amount_cents }),
    );
    await ctx.store.enqueue({ type: 'payment.capture', order_id: orderId });
    return { status: 202, body: { order: updated } };
  });
}

export async function listOrderEvents(ctx) {
  const order = await loadOrder(ctx.store, ctx.params.order_id);
  return { status: 200, body: { events: await ctx.store.listEvents(order.order_id) } };
}
