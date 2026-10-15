# orders-api

The order-status API of the Mycelink quickstart. It turns an order record
from the store into the public status payload that clients render.

- `orders/src/order-status.js` publishes payloads at contract version 1:
  `{ version, id, status }` with `status` one of `placed`, `shipped`,
  `delivered`.
- No dependencies. Run the tests with `node --test` (Node.js 22.12+).
