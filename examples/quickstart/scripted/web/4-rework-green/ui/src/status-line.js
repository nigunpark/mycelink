/**
 * The one line an order page shows for an order-status payload.
 *
 * Renders contract version 1 and 2 payloads ({ version, id, status, eta? })
 * as published by the orders-api repository. A status this client does not
 * know, or none at all, renders as "Status unavailable".
 */
const LABELS = Object.freeze({ placed: 'Placed', shipped: 'Shipped', delivered: 'Delivered' });

export function statusLine(payload) {
  const status = typeof payload.status === 'string' ? payload.status.toLowerCase() : null;
  if (status === 'delayed') return `Order ${payload.id}: Delayed, now expected ${payload.eta}`;
  const label = status !== null && Object.hasOwn(LABELS, status) ? LABELS[status] : 'Status unavailable';
  return `Order ${payload.id}: ${label}`;
}
