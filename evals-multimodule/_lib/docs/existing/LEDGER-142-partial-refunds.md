# LEDGER-142 — Partial refunds

| | |
|---|---|
| Status | **Approved** — Product 2026-09-28, Engineering review 2026-09-30 |
| Owner | Payments team |
| Affects | public HTTP API, background worker, operator CLI, shared domain library |

## Problem

Support agents refund customers by hand in the payment gateway's dashboard.
When a click times out they click again, and we have paid out the same refund
twice three times this quarter. Ledgerline itself has no idea a refund
happened, so order totals and the event stream are wrong afterwards.

We want refunds to go through Ledgerline: requested through the API or the
operator CLI, settled by the background worker against the payment gateway,
safe to retry, and impossible to over-refund.

## Glossary

- **Captured amount** — `captured_cents` on a paid order.
- **Refundable amount** — captured amount minus every refund of the order that
  is not `failed` (pending, in progress or succeeded refunds all count).
- **Idempotency key** — a client-chosen string identifying one logical refund
  request, sent as the `Idempotency-Key` HTTP header.

## Behaviour

### Refund object

```json
{
  "refund_id": "ref_…",             // unique, assigned by Ledgerline
  "order_id": "ord_…",
  "amount_cents": 400,              // positive integer, minor units
  "reason": "damaged item",         // string or null
  "status": "pending",              // pending | succeeded | failed (other internal states allowed in between)
  "gateway_ref": null,              // set when the gateway approves
  "failure_code": null,             // gateway decline code when failed
  "created_at": "2026-10-01T12:00:00.000Z",
  "updated_at": "2026-10-01T12:00:00.000Z"
}
```

### AC-1 Request a refund

`POST /orders/{order_id}/refunds` with header `Idempotency-Key` and body
`{ "amount_cents": <positive integer>, "reason": <optional string, at most 200 characters> }`.

Given a paid order, when a valid refund is requested, then the API answers
`202 Accepted` with `{ "refund": <Refund> }` in status `pending`, the refund
appears in the order's refund list, a `refund.requested` event is appended to
the order's event stream, and the refund is handed to the background worker
for settlement.

### AC-2 Safe retries

Given a refund was accepted with key K, when the same request (same body) is
sent again with key K, then the response is identical to the original (same
status and body) and carries the header `Idempotent-Replayed: true`; no new
refund, event or settlement work is created.

### AC-3 Key reuse

Given key K was used for an accepted refund on an order, when K is sent again
for that order with a different body, then `409 IDEMPOTENCY_KEY_REUSED`.
Keys are scoped to the order: the same key on a different order is an
independent request. A refused request (any 4xx) does not consume its key.

### AC-4 Validation and errors

Checks apply in this order; the first failing one answers:

| # | Condition | Response |
|---|---|---|
| 1 | no `Idempotency-Key` header | `400 IDEMPOTENCY_KEY_REQUIRED` |
| 2 | `amount_cents` missing or not a positive integer; `reason` not a string of at most 200 characters | `400 VALIDATION_FAILED` |
| 3 | order does not exist | `404 ORDER_NOT_FOUND` |
| 4 | key already used on this order (AC-2 / AC-3) | replay or `409 IDEMPOTENCY_KEY_REUSED` |
| 5 | order status is not `paid`, `partially_refunded` or `refunded` | `409 ORDER_NOT_CAPTURED` |
| 6 | `amount_cents` greater than the refundable amount | `422 REFUND_EXCEEDS_CAPTURED` |

Errors use the existing envelope `{ "error": { "code", "message" } }`.

### AC-5 Concurrent retries

Clients retry aggressively. Many identical requests with the same key that
arrive at the same time — including on different API instances that share the
same data directory — must produce exactly one refund, and every one of them
must receive the same `202` refund.

### AC-6 Never over-refund

Concurrent refund requests with different keys — including on different API
instances — must never jointly exceed the captured amount. Requests that would
exceed the refundable amount are refused with `422 REFUND_EXCEEDS_CAPTURED`.

### AC-7 List refunds

`GET /orders/{order_id}/refunds` answers `200 { "refunds": [<Refund>, …] }` in
creation order (`404 ORDER_NOT_FOUND` for an unknown order).

### AC-8 Settlement by the worker

The worker sends each refund to the payment gateway **exactly once**, even when
jobs are redelivered (`POST /admin/jobs/redeliver`) and several workers run at
the same time.

- The non-production gateway (`FakeGateway`) gains a `refund` operation next to
  `capture`, recorded in the same `gateway/calls.jsonl` audit file with
  `op: "refund"` and `ref: <refund_id>`, and with the same deterministic
  decline rule as captures.
- Approved: the refund becomes `succeeded` with `gateway_ref`, and a
  `refund.succeeded` event is appended.
- Declined: the refund becomes `failed` with `failure_code` set to the
  gateway's decline code, and a `refund.failed` event is appended (`reason` is
  the decline code). A failed refund no longer counts against the refundable
  amount.

### AC-9 Order totals

Orders gain `refunded_cents`: the sum of `succeeded` refunds (`0` for orders
with none, including orders created before this change). The order status
becomes `partially_refunded` while `0 < refunded_cents < captured_cents` and
`refunded` once they are equal.

### AC-10 Event contracts

New domain events, version 1, with closed data objects:

| Type | Data |
|---|---|
| `refund.requested` | `order_id`, `refund_id`, `amount_cents` |
| `refund.succeeded` | `order_id`, `refund_id`, `amount_cents`, `gateway_ref` |
| `refund.failed` | `order_id`, `refund_id`, `reason` |

Every event any service emits must validate with the shared contract
validator. Existing events and their versions are unchanged.

### AC-11 Shared definitions

The shared domain library publishes everything other services need: the new
error codes (`IDEMPOTENCY_KEY_REQUIRED`, `ORDER_NOT_CAPTURED`,
`REFUND_EXCEEDS_CAPTURED`), a `REFUND_STATUS` set (at least `pending`,
`succeeded`, `failed`), the new order statuses (`partially_refunded`,
`refunded`) and the event contracts above. Release it as a new minor version;
every service must ship built against exactly that release.

### AC-12 Operator CLI

```text
ledger refunds create <order_id> --amount <cents> --key <idempotency-key> [--reason <text>]
ledger refunds list <order_id>
```

- `create` prints the refund as one JSON document on stdout and exits 0;
  re-running it with the same key replays the same refund.
- `list` prints the order's refunds as a JSON array.
- `--key` is mandatory and `--amount` must be a positive integer: otherwise a
  usage error (exit 2) without calling the API.
- API refusals behave like existing commands: `{"error":{…}}` on stderr,
  exit 1.

### AC-13 No regressions

Existing order and capture behaviour, endpoints, CLI commands and event
contracts are unchanged. Every repository's own test suite passes, and new
behaviour is covered by tests in the repository that owns it.

## Out of scope

Refunding uncaptured orders (voids), partial captures, currency conversion,
recovering a refund whose worker died mid-call to the gateway, authentication,
any UI.

## Definition of done

- Every acceptance criterion above is implemented, tested in the owning
  repository, and committed in every affected repository.
- QA's acceptance suite passes: `node acceptance/run.mjs`.
