# Ledgerline architecture

Ledgerline is four Git repositories plus this coordination repository
(`platform/`). All code is Node.js 22.12+ ES modules with **no npm
dependencies**; every repository tests with `node --test`.

```text
 operator ──► ledger-cli ──HTTP──► ledger-api ──┐
                                                │  LEDGER_DATA_DIR (shared files)
                         ledger-worker ◄────────┘  orders/ events/ queue/ idempotency/ locks/
                               │
                               └──► FakeGateway  →  $LEDGER_DATA_DIR/gateway/calls.jsonl
```

| Repository | Path | Role |
|---|---|---|
| ledger-core | `repos/core` | shared domain library: errors, money, order model, event contracts, file store, idempotency |
| ledger-api | `repos/api` | HTTP API over `node:http` |
| ledger-worker | `repos/worker` | background jobs; owns the payment gateway integration |
| ledger-cli | `repos/cli` | operator CLI; talks only to the API over HTTP |

## How the services share code: vendoring

`api`, `worker` and `cli` never import `../core`. Each contains a verbatim copy
of `core/src/` in `vendor/ledger-core/`, pinned by
`vendor/ledger-core.lock.json` (`package`, `version`, `tree_sha256`). Every
service imports core as `../vendor/ledger-core/index.mjs` (or
`../../vendor/…` from nested files).

Changing core therefore means: change and test `repos/core` (bump its
`package.json` version for a release), commit it, then in each consumer run
`node scripts/sync-core.mjs <path-to-core-checkout>` and commit the updated
`vendor/` and lock. Each consumer's `test/vendor-lock.test.mjs` checks the
vendored tree against its lock. QA's acceptance suite additionally checks that
every consumer's vendored copy equals the delivered core exactly.

## How the API and the worker share state: the file store

`core/src/store.mjs` (`openStore(dataDir)` → `Store`) is the only code that
touches the data directory. Several API processes and several workers may
share one data directory, so:

- **Documents** (`orders/<order_id>.json`) are replaced atomically
  (`writeOrder`: temp file + rename, retried on transient Windows errors).
- **Mutual exclusion across processes** is `store.withLock(name, fn)`, a
  `mkdir`-based lock under `locks/`. It is *not* re-entrant. Lock names in use:
  `order-<order_id>` (any read-modify-write of an order and its events) and
  `idem-<scope>-<hash>` (taken by `withIdempotency`). Always take the
  idempotency lock before the order lock, never the reverse.
- **Events** are appended per order to `events/<order_id>.jsonl` via
  `store.appendEvent(event)`; call it while holding the order lock.
- **Jobs**: `store.enqueue({ type, ...payload })` writes to `queue/pending/`.
  Workers claim with `store.claimJob()` (exclusive-create marker, then move to
  `queue/claimed/`) and finish with `store.finishJob(claim, 'done' | 'dead')`.
  Do not replace the claim with a plain `rename`: on Windows two processes can
  both "win" a rename of the same file.
- **Redelivery**: `store.redeliverAll()` (exposed as
  `POST /admin/jobs/redeliver`) moves every finished job back to pending.
  Delivery is therefore at-least-once and **handlers must be idempotent**.

## Idempotent HTTP requests

`core/src/idempotency.mjs` → `withIdempotency(store, { scope, key, fingerprint }, fn)`
runs `fn` once per `(scope, key)` under a cross-process lock and stores
`{ status, body }`. A replay with the same `requestFingerprint(body)` returns the
stored response with `replayed: true` (the API turns that into the header
`Idempotent-Replayed: true`); a different fingerprint throws
`IDEMPOTENCY_KEY_REUSED`. If `fn` throws, nothing is stored, so refused
requests do not consume the key. `POST /orders` uses scope `orders`; a scope
can embed an id (for example a per-order scope) to scope keys to it.

## Payment capture flow (the pattern to follow for new money movements)

1. API `POST /orders/:id/capture` (`api/src/orders.mjs#captureOrder`), under the
   order lock: check status, set `capture_pending`, append
   `payment.capture_requested`, enqueue `{ type: 'payment.capture', order_id }`.
2. Worker `handleCapture` (`worker/src/handlers/capture.mjs`): under the order
   lock, move `capture_pending → capturing` (any other status = already
   handled, return `'skipped'`); release the lock; call the gateway; re-take
   the lock and record `paid`/`payment_failed` plus the event. Owning the
   transition before the gateway call is what makes redelivery and concurrent
   workers safe.
3. Handlers are registered in `worker/src/worker.mjs` `HANDLERS`; a job type
   with no handler is dead-lettered to `queue/dead/`.
