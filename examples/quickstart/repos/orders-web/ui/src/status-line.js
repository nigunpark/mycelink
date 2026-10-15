/**
 * The one line an order page shows for an order-status payload.
 *
 * Renders contract version 1 payloads ({ version, id, status }) as
 * published by the orders-api repository.
 */
const LABELS = Object.freeze({ placed: 'Placed', shipped: 'Shipped', delivered: 'Delivered' });

export function statusLine(payload) {
  return `Order ${payload.id}: ${LABELS[payload.status]}`;
}
