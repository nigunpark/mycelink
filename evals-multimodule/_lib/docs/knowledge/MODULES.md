# Module map

Paths are relative to each repository root.

## ledger-core (`repos/core`) — `@ledgerline/core` 1.4.0

| File | Contents |
|---|---|
| `src/index.mjs` | re-exports everything below, plus `CORE_VERSION` |
| `src/errors.mjs` | `ERROR_CODES`, `DomainError` (`.code`, `.status`, `.toJSON()`), `httpStatusFor(code)` (status table), `validationError()` |
| `src/money.mjs` | `assertAmountCents(value, field)`, `assertCurrency()`, `CURRENCIES`, `MAX_AMOUNT_CENTS` |
| `src/orders.mjs` | `ORDER_STATUS`, `assertOrderId()`, `newOrderId()`, `newOrder()` |
| `src/events.mjs` | event contract table, `EVENT_TYPES`, `eventSchema()`, `makeEvent(type, data)`, `validateEvent(event)` |
| `src/store.mjs` | `openStore()`, `Store` (locks, orders, events, queue, idempotency records), `keyHash()` |
| `src/idempotency.mjs` | `withIdempotency()`, `requestFingerprint()`, `canonicalJson()`, `assertIdempotencyKey()` |
| `test/*.test.mjs` | events, money/orders, store and idempotency tests |

A new error code needs an entry in both `ERROR_CODES` and the HTTP status table
in `errors.mjs`. A new event type needs an entry in the `SCHEMAS` table in
`events.mjs`; `EVENT_TYPES` is derived from it.

## ledger-api (`repos/api`) — `@ledgerline/api` 2.3.1

| File | Contents |
|---|---|
| `bin/ledger-api.mjs` | process entry: env `LEDGER_DATA_DIR`, `LEDGER_PORT`, `LEDGER_HOST`; prints `{"event":"listening","url":…}` |
| `src/app.mjs` | `routes` table and `createApp({ store })`; maps handler results `{ status, body, replayed? }` to HTTP |
| `src/http.mjs` | JSON body parsing (64 KiB cap), `sendJson`, error envelope, tiny router with `:param` segments |
| `src/orders.mjs` | `loadOrder`, `postOrder` (optional idempotency), `getOrder`, `captureOrder`, `listOrderEvents` |
| `src/admin.mjs` | `POST /admin/jobs/redeliver` |
| `scripts/sync-core.mjs` | re-vendor core |
| `test/helpers.mjs` | `startApp(t)` → `{ store, call(method, path, body, headers) }` on a temp data dir |
| `test/orders.test.mjs`, `test/vendor-lock.test.mjs` | tests |

Handlers receive `ctx = { store, params, body, headers, query }`; headers are
lower-case (`ctx.headers['idempotency-key']`).

## ledger-worker (`repos/worker`) — `@ledgerline/worker` 1.9.0

| File | Contents |
|---|---|
| `bin/ledger-worker.mjs` | `--once` drains the queue and exits; otherwise polls; env `LEDGER_DATA_DIR`, `LEDGER_GATEWAY_DELAY_MS` |
| `src/worker.mjs` | `HANDLERS` (job type → handler), `processNext()`, `drain()` |
| `src/handlers/capture.mjs` | `payment.capture` handler |
| `src/gateway.mjs` | `FakeGateway` (`capture()`, audit file `gateway/calls.jsonl`), `isDeclined()` (amount % 1000 === 13) |
| `scripts/sync-core.mjs` | re-vendor core |
| `test/capture.test.mjs`, `test/vendor-lock.test.mjs` | tests |

Handlers are `async (job, { store, gateway }) => 'done' | 'skipped'`.

## ledger-cli (`repos/cli`) — `@ledgerline/cli` 0.8.2

| File | Contents |
|---|---|
| `bin/ledger.mjs` | process entry |
| `src/main.mjs` | `GROUPS` (command groups), `USAGE`, `main(argv, io)` → exit code |
| `src/args.mjs` | `parseArgs()` (every `--flag` takes a value), `intFlag()`, `UsageError` |
| `src/client.mjs` | `createClient(baseUrl)` → `request(method, path, { body, headers })`, `ApiError` |
| `src/commands/orders.mjs` | the `orders` group (`create`, `show`, `capture`, `events`) |
| `scripts/sync-core.mjs` | re-vendor core |
| `test/cli.test.mjs` | tests against a stub HTTP server; `test/vendor-lock.test.mjs` |

A command group is an object of `async ({ positionals, flags }, request) => result`
functions registered in `GROUPS`; throwing `UsageError` exits 2 before any
request is made.

## Dependencies

`core` ← `api`, `worker`, `cli` (vendored). `cli` → `api` over HTTP only.
`api` and `worker` communicate only through the data directory (orders,
events, queue).
