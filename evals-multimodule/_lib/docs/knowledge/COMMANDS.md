# Commands

All commands use only Node.js (22.12+) and Git. There is nothing to install.

## Tests

| Repository | Command (run in the repository root) | Baseline |
|---|---|---|
| `repos/core` | `node --test` | 10 tests pass |
| `repos/api` | `node --test` | 7 tests pass (the helper file counts as one) |
| `repos/worker` | `node --test` | 5 tests pass |
| `repos/cli` | `node --test` | 4 tests pass |

`npm test` runs the same command. Add `--test-reporter=tap` for TAP output.
Tests create their own temporary data directories and ports; they can run in
parallel across repositories.

## Re-vendoring core into a service

After committing a change in `repos/core`, from each of `repos/api`,
`repos/worker` and `repos/cli`:

```bash
node scripts/sync-core.mjs ../core      # path to the core checkout you are shipping
node --test                             # vendor-lock test must pass
git add vendor && git commit -m "chore: vendor ledger-core <version>"
```

## Running the system locally

```bash
export LEDGER_DATA_DIR="$(mktemp -d)"
LEDGER_PORT=8080 node repos/api/bin/ledger-api.mjs &      # prints {"event":"listening","url":...}
node repos/cli/bin/ledger.mjs --api http://127.0.0.1:8080 orders create --amount 1000
node repos/cli/bin/ledger.mjs --api http://127.0.0.1:8080 orders capture <order_id>
node repos/worker/bin/ledger-worker.mjs --once            # drains the queue
node repos/cli/bin/ledger.mjs --api http://127.0.0.1:8080 orders show <order_id>
```

## QA acceptance

```bash
node acceptance/run.mjs      # from the workspace root
```

It exports each module repository **at its HEAD commit** (uncommitted work is
not tested and makes the verdict FAIL), runs every module's own suite, then
the black-box acceptance tests against real API, worker and CLI processes.
Results: `acceptance-results/SUMMARY.txt`, `report.json` and TAP files.
