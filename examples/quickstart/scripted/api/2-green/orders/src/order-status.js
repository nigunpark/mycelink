/**
 * Order-status payloads, as the orders API publishes them.
 *
 * Contract version 2 (contracts/order-status.v2.json in the control
 * repository): { version, id, status, eta? }, where status is one of
 * STATUSES and eta, a YYYY-MM-DD date, is present exactly when the order is
 * delayed. Clients render the payload; see the orders-web repository.
 */
export const CONTRACT_VERSION = 2;

export const STATUSES = Object.freeze(['placed', 'shipped', 'delivered', 'delayed']);

/** A real calendar date written as YYYY-MM-DD. */
function isDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** An order record from the store -> the public status payload. */
export function toStatusPayload(order) {
  if (order === null || typeof order !== 'object' || typeof order.id !== 'string' || order.id === '') {
    throw new TypeError('order.id must be a non-empty string');
  }
  if (!STATUSES.includes(order.state)) {
    throw new RangeError(`unknown order state: ${String(order.state)}`);
  }
  if (order.state !== 'delayed') return { version: CONTRACT_VERSION, id: order.id, status: order.state };
  if (!isDate(order.eta)) {
    throw new RangeError(`delayed order ${order.id} needs an eta as YYYY-MM-DD, got ${JSON.stringify(order.eta)}`);
  }
  return { version: CONTRACT_VERSION, id: order.id, status: 'delayed', eta: order.eta };
}
