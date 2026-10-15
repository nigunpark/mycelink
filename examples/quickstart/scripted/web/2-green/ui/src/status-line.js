/**
 * The one line an order page shows for an order-status payload.
 *
 * Renders contract version 1 and 2 payloads ({ version, id, status, eta? })
 * as published by the orders-api repository.
 */
const LABELS = Object.freeze({ placed: 'Placed', shipped: 'Shipped', delivered: 'Delivered' });

export function statusLine(payload) {
  const status = payload.status.toLowerCase();
  if (status === 'delayed') return `Order ${payload.id}: Delayed, now expected ${payload.eta}`;
  return `Order ${payload.id}: ${LABELS[status] ?? 'Status unavailable'}`;
}
