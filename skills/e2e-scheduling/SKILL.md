---
name: e2e-scheduling
description: Use when deciding which browser E2E scenarios may run in parallel against a single shared runtime, writing an e2e-scenario YAML, or diagnosing why the scheduler serialised a scenario. Covers isolation requirements, the conflict graph and the capacity-1 runtime lease.
---

# E2E scheduling

One server exists. Many browsers may talk to it — but only when they
genuinely cannot interfere.

## The runtime is capacity 1

Build, deploy, healthcheck, fixture reset, every scenario and cleanup all
happen inside one `full-runtime` lease. There is never a second runtime. The
lease is released in `finally`, on success, failure, cancellation or crash.

## A scenario may run in parallel only if all of this holds

- its own browser context and profile directory
- its own user, tenant or account
- test data in a run- and scenario-scoped namespace
- it does not share a global fixture reset
- it has no ordering dependency
- it does not write a DB row, Queue key or global setting another scenario
  touches
- it does not mutate global state from a shared screen

Anything else is serialised. The cost of serialising is minutes; the cost of
a false green from cross-talk is a shipped bug.

## Scenario YAML

```yaml
schema_version: 1
id: E2E-create
acceptance_criteria: [AC-1, AC-2]
resources: [browser-worker]
isolation:
  browser_profile: unique      # unique | shared
  account: unique              # unique | shared | global-admin
  data_namespace: unique       # unique | shared
  global_fixture_reset: false
  mutates_global_state: false
  order_dependent: false
  writes: ['db:jobs_create']   # logical owners this scenario writes
conflicts_with: []
setup_command: []
test_command: ['npx', 'playwright', 'test', 'create.spec.ts']
cleanup_command: []
attributed_nodes: [FEAT-101.api.consume.impl]
evidence: { screenshots: true, trace: true, junit: true }
```

Fill in `attributed_nodes`. Without it, a failure is attributed to the whole
feature and you lose the diagnosis.

## Why the scheduler serialised something

| Reason | Meaning |
|---|---|
| `DECLARED_CONFLICT` | One of them lists the other in `conflicts_with`. |
| `GLOBAL_MUTATION` | One sets `mutates_global_state`, so it runs alone. |
| `ORDER_DEPENDENT` | One sets `order_dependent`. |
| `SHARED_GLOBAL_FIXTURE` | Both reset the global fixture. |
| `SHARED_ACCOUNT` | Both use the same non-unique account. |
| `SHARED_DATA_NAMESPACE` | Both use the shared namespace. |
| `SHARED_DATA_OWNER` | Their `writes` sets intersect. |
| `SHARED_BROWSER_PROFILE` | Both use a shared profile. |
| `EXCLUSIVE_RESOURCE` | One needs a capacity-1 resource, so it runs alone. |
| `RESOURCE_CAPACITY` | The shard already holds every unit available. |

## Isolation handed to the test

Each scenario receives `E2E_SCENARIO_ID`, `E2E_CANDIDATE_ID`,
`E2E_DATA_NAMESPACE`, `E2E_ACCOUNT`, `E2E_BROWSER_PROFILE_DIR`,
`E2E_TRACE_DIR` and `E2E_SCREENSHOT_DIR`. Use them. A test that hard-codes a
user or a fixture path cannot be parallelised and will cause a false green
for someone else.

## Scaling up

Start browser workers at 2. Raise it only after a measured run shows real
isolation — not because the scheduler allowed it.
