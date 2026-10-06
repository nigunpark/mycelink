# Contracts

## HTTP API (ledger-api)

All bodies are JSON. Errors: `{ "error": { "code", "message", "details"? } }`
with the HTTP status from core's `httpStatusFor(code)`.

| Method & path | Success | Errors |
|---|---|---|
| `GET /healthz` | `200 {ok:true}` | |
| `POST /orders` `{amount_cents, currency, order_id?}`, optional `Idempotency-Key` | `201 {order}`; replay → stored response + `Idempotent-Replayed: true` | `400 VALIDATION_FAILED`, `409 IDEMPOTENCY_KEY_REUSED` |
| `GET /orders/:order_id` | `200 {order}` | `400`, `404 ORDER_NOT_FOUND` |
| `POST /orders/:order_id/capture` | `202 {order}` (`capture_pending`) | `404`, `409 ORDER_NOT_CAPTURABLE` |
| `GET /orders/:order_id/events` | `200 {events:[…]}` in emission order | `404` |
| `POST /admin/jobs/redeliver` | `200 {redelivered:n}` | |
| anything else | | `404 NOT_FOUND` |

Order document: `order_id`, `amount_cents`, `currency`, `status`,
`captured_cents`, `gateway_ref`, `failure_code`, `created_at`, `updated_at`.
Statuses: `pending_payment → capture_pending → capturing → paid | payment_failed`.

## Error codes (ledger-core `ERROR_CODES`)

`VALIDATION_FAILED` 400 · `NOT_FOUND` 404 · `ORDER_NOT_FOUND` 404 ·
`ORDER_NOT_CAPTURABLE` 409 · `IDEMPOTENCY_KEY_REUSED` 409 · `INTERNAL` 500.

## Domain events (ledger-core `events.mjs`)

Envelope `{ event_id: "evt_…", type, version, occurred_at, data }` — no other
envelope fields. `data` is **closed**: every declared field is required, and
any undeclared field fails `validateEvent`.

| Type | v | data |
|---|---|---|
| `order.created` | 1 | `order_id` string, `amount_cents` integer, `currency` string |
| `payment.capture_requested` | 1 | `order_id`, `amount_cents` |
| `payment.captured` | 1 | `order_id`, `amount_cents`, `gateway_ref` |
| `payment.failed` | 1 | `order_id`, `reason` |

`makeEvent(type, data)` builds a valid envelope; `appendEvent` stores it on the
order named by `data.order_id`. Adding a field to an existing event is a
breaking change (new version); adding a new event type is not.

## Jobs (data directory queue)

| Job | Producer | Consumer | Payload |
|---|---|---|---|
| `payment.capture` | api `captureOrder` | worker `handleCapture` | `{ order_id }` |

Delivery is at-least-once (`POST /admin/jobs/redeliver`, concurrent workers).

## Payment gateway audit (worker `FakeGateway`)

`$LEDGER_DATA_DIR/gateway/calls.jsonl`, one line per gateway call:
`{ op, ref, amount_cents, outcome: "approved"|"declined", at }`. Captures use
`op: "capture"`, `ref: <order_id>`. Amounts with `amount % 1000 === 13` are
declined with `card_declined`. Finance reconciles from this file: every money
movement must appear exactly once.

## CLI (ledger-cli)

`ledger [--api <url>] <group> <command> …` (or `LEDGER_API_URL`). Success: one
JSON document on stdout, exit 0. API refusal: `{"error":{…}}` on stderr, exit 1.
Usage error: exit 2, no request sent. API unreachable: exit 3.

## Vendored core lock

`vendor/ledger-core.lock.json`: `{ package: "@ledgerline/core", version, tree_sha256 }`;
`tree_sha256` = SHA-256 over `"<posix path>\0<sha256(LF-normalised text)>\n"`
for every file under `vendor/ledger-core/`, sorted by path
(`scripts/sync-core.mjs#treeSha256`).
