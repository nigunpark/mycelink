# ORD-101 Delayed orders with an expected delivery date

Status: approved (quickstart example)

## Behaviour being added

An operator can mark an order as delayed and give it a new expected
delivery date. The orders API publishes that state, and the web client
shows it on the order page. Today neither repository knows the state: the
API refuses it and the client has no label for it.

Both repositories move together to the order-status contract version 2
(`contracts/order-status.v2.json` in this control repository):

| field | type | when |
|---|---|---|
| `version` | the number `2` | always |
| `id` | non-empty string | always |
| `status` | `placed`, `shipped`, `delivered` or `delayed` | always |
| `eta` | `YYYY-MM-DD` date string | only when `status` is `delayed` |

## Affected repositories and modules

- `api` (orders-api), module `orders`: `orders/src/order-status.js`
  publishes contract version 2.
- `web` (orders-web), module `ui`: `ui/src/status-line.js` renders
  contract version 2 payloads.

The web client consumes the contract the API produces, so the web work
starts only after the API work is done.

## Acceptance criteria

- **AC-1** Given an order record `{ id: "A-7", state: "delayed", eta: "2026-11-03" }`, when the API builds its status payload, then the payload is exactly `{ version: 2, id: "A-7", status: "delayed", eta: "2026-11-03" }`; every other payload carries `version: 2` and no `eta` field.
- **AC-2** Given an order record with `state: "delayed"` whose `eta` is missing or is not a `YYYY-MM-DD` date, when the API builds its status payload, then it throws a `RangeError` whose message names the order id, and publishes nothing.
- **AC-3** Given the payload `{ version: 2, id: "A-7", status: "delayed", eta: "2026-11-03" }`, when the web client renders it, then the line is exactly `Order A-7: Delayed, now expected 2026-11-03`.
- **AC-4** Given a payload whose `status` the web client does not know, or that has no `status` at all, when the web client renders it, then the line is exactly `Order <id>: Status unavailable` and rendering never throws.

## Success result

Both repositories pass their full test suites at contract version 2, and
one candidate binds the exact commit of each.

## Error and boundary conditions

- A delayed order without a valid `eta` is a data error in the API (AC-2);
  it is never published with a guessed date.
- A client may meet a status it does not know (a newer API) or a payload
  without a status (a broken proxy); it degrades to a fixed line (AC-4).

## Side effects

None: no database, no events, no network. Both repositories are plain
functions with `node:test` suites.

## Out of scope

- Formatting dates for a locale; the `eta` is shown as published.
- Any other new status.
- Changing how `placed`, `shipped` and `delivered` render.

## Backward compatibility

Payloads change from version 1 to version 2 in one coordinated change.
Existing statuses keep their labels; the existing tests of both
repositories must keep passing.

## Browser E2E

Not required for this example: there is no browser runtime.

## Decisions

None open.
