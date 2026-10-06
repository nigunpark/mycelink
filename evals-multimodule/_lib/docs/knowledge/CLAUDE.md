# Ledgerline workspace

- `platform/` — coordination repository: requirements in `platform/requirements/`,
  engineering documentation in `platform/docs/`.
- `repos/core`, `repos/api`, `repos/worker`, `repos/cli` — the four module
  repositories (separate Git repositories).
- `acceptance/` — QA's acceptance suite (`node acceptance/run.mjs`); do not edit.

Before changing code read, in order:

1. `platform/docs/ARCHITECTURE.md` — how the services fit together, the file
   store, locking and at-least-once job delivery.
2. `platform/docs/MODULES.md` — what lives where in each repository.
3. `platform/docs/COMMANDS.md` — test, run, re-vendor and acceptance commands.
4. `platform/docs/CONTRACTS.md` — HTTP, error, event, job, gateway and CLI contracts.

Key rules: services consume core only through `vendor/ledger-core/` (re-vendor
with `node scripts/sync-core.mjs ../core` after changing core); every
read-modify-write of an order happens under `store.withLock('order-<id>')`;
job handlers must be idempotent; every repository tests with `node --test`.
