/**
 * Order-status payloads, as the orders API publishes them.
 *
 * Contract version 1: { version, id, status }, where status is one of
 * STATUSES. Clients render the payload; see the orders-web repository.
 */
export const CONTRACT_VERSION = 1;

export const STATUSES = Object.freeze(['placed', 'shipped', 'delivered']);

/** An order record from the store -> the public status payload. */
export function toStatusPayload(order) {
  if (order === null || typeof order !== 'object' || typeof order.id !== 'string' || order.id === '') {
    throw new TypeError('order.id must be a non-empty string');
  }
  if (!STATUSES.includes(order.state)) {
    throw new RangeError(`unknown order state: ${String(order.state)}`);
  }
  return { version: CONTRACT_VERSION, id: order.id, status: order.state };
}
