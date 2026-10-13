# LEDGER-100 — Ledgerline MVP: orders, payment capture and partial refunds

| | |
|---|---|
| Status | **Approved** — Product 2026-09-28, Engineering review 2026-09-30 |
| Owner | Payments team |
| Repositories | `repos/core`, `repos/api`, `repos/worker`, `repos/cli` (empty today) |

## Problem

We are replacing a spreadsheet-and-dashboard payments process with Ledgerline.
The first release must let integrations and support agents create orders,
capture payment, and issue partial refunds that are safe to retry and
impossible to over-refund. Support currently double-refunds customers when a
dashboard click times out and they click again; that must not be possible in
Ledgerline.

## Architecture constraints (from engineering review)

- Four independently versioned Git repositories, each with a single
  responsibility:
  - `core` — package `@ledgerline/core`: shared domain definitions (money,
    statuses, error codes, event contracts and their validator) and the
    storage primitives the services share. Entry point `src/index.mjs`.
  - `api` — the public HTTP API (`bin/ledger-api.mjs`).
  - `worker` — background job processing and the payment-gateway integration
    (`bin/ledger-worker.mjs`).
  - `cli` — the operator command line (`bin/ledger.mjs`).
- Node.js 22.12+ and its built-in modules only — no npm dependencies, no
  database, no external services. ES modules (`.mjs` or `"type": "module"`).
- Each repository builds and tests **on its own**: `node --test` in the
  repository root runs its suite, and nothing imports from outside the
  repository. Services consume `core` by **vendoring** it: `core/src/` is
  copied verbatim to `vendor/ledger-core/` in `api`, `worker` and `cli`,
  pinned by `vendor/ledger-core.lock.json`:

  ```json
  { "package": "@ledgerline/core", "version": "<core package.json version>", "tree_sha256": "<hex>" }
  ```

  `tree_sha256` is the SHA-256 of the concatenation, over every file under
  `vendor/ledger-core/` sorted by POSIX relative path, of
  `"<relative/path>\0<sha256 hex of the file's text with CRLF normalised to LF>\n"`.
  Every service must ship built against exactly the delivered `core`.
- The API and the worker share state through a data directory given by the
  `LEDGER_DATA_DIR` environment variable. Several API processes and several
  worker processes may use the same data directory at the same time, on
  Windows, Linux and macOS; correctness must not depend on running a single
  process.
- Background work is delivered **at least once**: jobs can be redelivered, so
  every job handler must be idempotent.

## Runtime interfaces

### API process

`node bin/ledger-api.mjs` with `LEDGER_DATA_DIR` (required), `LEDGER_PORT`
(default `8080`, `0` = any free port) and `LEDGER_HOST` (default
`127.0.0.1`). Once listening it prints exactly one JSON line to stdout:
`{"event":"listening","url":"http://127.0.0.1:<port>"}`.

All responses are JSON. Errors use `{ "error": { "code": "<CODE>", "message": "…" } }`.

### Worker process

`node bin/ledger-worker.mjs --once` processes jobs until none are left, then
exits 0. Without `--once` it keeps polling. Several workers may run at once.

### Payment gateway (non-production)

The worker talks to the payment gateway through a fake gateway that records
every call by appending one JSON object per line to
`$LEDGER_DATA_DIR/gateway/calls.jsonl`:
`{ "op": "capture" | "refund", "ref": "<order_id for captures, refund_id for refunds>", "amount_cents": <int>, "outcome": "approved" | "declined", "at": "<ISO time>" }`.
Any amount whose value modulo 1000 is 13 (13, 1013, 2013, …) is declined with
decline code `card_declined`; everything else is approved with a non-empty
gateway reference. `LEDGER_GATEWAY_DELAY_MS` adds artificial latency per call.
This file is the finance audit trail: every money movement appears in it
exactly once.

### Operator CLI

`node bin/ledger.mjs [--api <url>] <group> <command> …`; the API URL comes from
`--api` or `LEDGER_API_URL`. Successful commands print one JSON document on
stdout and exit 0. API refusals print `{"error":{…}}` (the API's envelope) on
stderr and exit 1. Usage errors (unknown command, missing or invalid
arguments) exit 2 without calling the API.

## Orders and capture

### Order object

`{ order_id, amount_cents, currency, status, captured_cents, refunded_cents, gateway_ref, failure_code, created_at, updated_at }`

- `order_id`: `ord_` followed by 4–64 letters, digits, `_` or `-`; generated
  when the client does not supply one.
- `amount_cents`: positive integer minor units, at most 100 000 000.
- `currency`: `USD`, `EUR` or `KRW`.
- `status`: `pending_payment` → `capture_pending` → (`capturing` →) `paid` or
  `payment_failed`; later `partially_refunded` / `refunded` (see refunds).

### AC-1 Create and read orders

- `POST /orders` `{ amount_cents, currency, order_id? }` → `201 { "order": … }`
  in `pending_payment` with `captured_cents` and `refunded_cents` 0, and an
  `order.created` event. Invalid input → `400 VALIDATION_FAILED`.
- `POST /orders` accepts an optional `Idempotency-Key` header: identical
  retries (also concurrent, also across API processes) return the original
  `201` response and create one order; the same key with a different body →
  `409 IDEMPOTENCY_KEY_REUSED`.
- `GET /orders/{order_id}` → `200 { "order": … }`, unknown → `404 ORDER_NOT_FOUND`.
- `GET /orders/{order_id}/events` → `200 { "events": [ … ] }` in emission order.

### AC-2 Capture payment

- `POST /orders/{order_id}/capture` on a `pending_payment` order →
  `202 { "order": … }` in `capture_pending`, a `payment.capture_requested`
  event, and a capture job for the worker. Any other status →
  `409 ORDER_NOT_CAPTURABLE`.
- The worker captures through the gateway exactly once per order (even with
  redelivery and concurrent workers): approved → `paid`, `captured_cents` =
  `amount_cents`, `gateway_ref` set, `payment.captured` event; declined →
  `payment_failed`, `failure_code` = decline code, `payment.failed` event.
- `POST /admin/jobs/redeliver` → `200 { "redelivered": <n> }` puts every job the
  workers already finished back on the queue (operational replay after an
  incident).

### AC-3 CLI for orders

```text
ledger orders create --amount <cents> [--currency USD|EUR|KRW] [--key <idempotency-key>] [--id <order_id>]
ledger orders show <order_id>
ledger orders capture <order_id>
ledger orders events <order_id>
```

`create`, `show` and `capture` print the order object; `events` prints the
events array. `--currency` defaults to `USD`.

## Partial refunds

### Refund object

`{ refund_id, order_id, amount_cents, reason, status, gateway_ref, failure_code, created_at, updated_at }`
— `refund_id` unique and assigned by Ledgerline; `reason` a string or null;
`status` `pending`, `succeeded` or `failed` (other internal states allowed in
between); `gateway_ref` / `failure_code` null until settled.

The **refundable amount** of an order is `captured_cents` minus every refund
of the order that is not `failed`.

### AC-4 Request a refund

`POST /orders/{order_id}/refunds` with header `Idempotency-Key` (1–128 visible
ASCII characters) and body
`{ "amount_cents": <positive integer>, "reason": <optional string, at most 200 characters> }`
→ `202 { "refund": <Refund> }` in `pending`; the refund appears in the
order's refund list, a `refund.requested` event is appended, and the refund is
handed to the worker.

### AC-5 Safe retries and key reuse

The same key and body again → the identical response (status and body) with
header `Idempotent-Replayed: true`, and no new refund, event or work. The same
key with a different body on the same order → `409 IDEMPOTENCY_KEY_REUSED`.
Keys are scoped to the order. A refused request (any 4xx) does not consume
its key.

### AC-6 Validation and errors

The first failing check answers:

| # | Condition | Response |
|---|---|---|
| 1 | no `Idempotency-Key` header | `400 IDEMPOTENCY_KEY_REQUIRED` |
| 2 | `amount_cents` missing or not a positive integer; bad `reason` | `400 VALIDATION_FAILED` |
| 3 | order does not exist | `404 ORDER_NOT_FOUND` |
| 4 | key already used on this order | replay, or `409 IDEMPOTENCY_KEY_REUSED` |
| 5 | order status not `paid`, `partially_refunded` or `refunded` | `409 ORDER_NOT_CAPTURED` |
| 6 | amount greater than the refundable amount | `422 REFUND_EXCEEDS_CAPTURED` |

### AC-7 Concurrency

Many identical requests with the same key arriving at once — including on
different API processes sharing the data directory — create exactly one
refund and all receive the same `202`. Concurrent requests with different
keys never jointly exceed the captured amount; the excess is refused with
`422 REFUND_EXCEEDS_CAPTURED`.

### AC-8 List refunds

`GET /orders/{order_id}/refunds` → `200 { "refunds": [ … ] }` in creation
order; unknown order → `404 ORDER_NOT_FOUND`.

### AC-9 Settlement

The worker refunds through the gateway **exactly once per refund**, even with
redelivery and concurrent workers. Approved → `succeeded` with `gateway_ref`
and a `refund.succeeded` event. Declined → `failed` with `failure_code` and a
`refund.failed` event (`reason` = decline code); a failed refund no longer
counts against the refundable amount.

### AC-10 Order totals

`refunded_cents` is the sum of succeeded refunds. Status becomes
`partially_refunded` while `0 < refunded_cents < captured_cents`, and
`refunded` once equal.

### AC-11 CLI for refunds

```text
ledger refunds create <order_id> --amount <cents> --key <idempotency-key> [--reason <text>]
ledger refunds list <order_id>
```

`create` prints the refund object (re-running with the same key replays the
same refund); `list` prints the refunds array. `--key` is mandatory and
`--amount` must be a positive integer, otherwise exit 2 without calling the API.

## Shared contracts (`core`)

### AC-12 Exports

`core/src/index.mjs` exports at least:

- `ERROR_CODES` — an object mapping each code to itself:
  `VALIDATION_FAILED`, `NOT_FOUND`, `ORDER_NOT_FOUND`, `ORDER_NOT_CAPTURABLE`,
  `IDEMPOTENCY_KEY_REUSED`, `IDEMPOTENCY_KEY_REQUIRED`, `ORDER_NOT_CAPTURED`,
  `REFUND_EXCEEDS_CAPTURED`, `INTERNAL`.
- `ORDER_STATUS` — object whose values include `pending_payment`,
  `capture_pending`, `paid`, `payment_failed`, `partially_refunded`, `refunded`.
- `REFUND_STATUS` — object whose values include `pending`, `succeeded`, `failed`.
- `EVENT_TYPES` — array of every event type below.
- `validateEvent(event)` → `{ ok: boolean, errors: string[] }`, never throws.

### AC-13 Event contracts

Envelope: `{ event_id: "evt_…", type, version, occurred_at: <ISO time>, data }`
and nothing else. Every type is version 1 and its `data` is **closed**: all
listed fields are required with the given types, and any other field makes
the event invalid.

| Type | `data` fields |
|---|---|
| `order.created` | `order_id` string, `amount_cents` integer, `currency` string |
| `payment.capture_requested` | `order_id` string, `amount_cents` integer |
| `payment.captured` | `order_id` string, `amount_cents` integer, `gateway_ref` string |
| `payment.failed` | `order_id` string, `reason` string |
| `refund.requested` | `order_id` string, `refund_id` string, `amount_cents` integer |
| `refund.succeeded` | `order_id` string, `refund_id` string, `amount_cents` integer, `gateway_ref` string |
| `refund.failed` | `order_id` string, `refund_id` string, `reason` string |

Every event the services emit must validate with `validateEvent`.

## Quality

### AC-14 Tests and delivery

Each repository has its own `node --test` suite covering the behaviour it
owns, and it passes from a clean checkout of the delivered commit.

## Out of scope

Authentication, any UI, real payment providers, currency conversion, voids and
partial captures, recovering a job whose worker died mid-call to the gateway.

## Definition of done

- Every acceptance criterion is implemented, tested in the owning repository,
  and committed in every repository.
- QA's acceptance suite passes: `node acceptance/run.mjs`.
