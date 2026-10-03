---
name: graph-compilation
description: Use when writing or repairing a PORTFOLIO-GRAPH.yaml for the multi-repository orchestrator, or when `mycelink graph validate` reports problems. Covers the node schema, resource capacities, worker budgets, evidence requirements and every validation error code.
---

# Graph compilation

The graph is the contract between what was approved and what may run. If it
is wrong, every later guarantee is fiction.

## Node schema

```yaml
- id: FEAT-101.api.queue-consumer.impl
  level: executable-node
  repository: api          # null only for candidate-build / e2e-scenario
  capability: CAP-API-CONSUME     # null only for feature-level nodes
  node_type: implementation       # see the list below
  depends_on: [FEAT-101.core.publish.impl]
  allowed_paths: ['src/**', 'tests/**']
  forbidden_paths: ['src/generated/**']
  contract_inputs: ['contracts/order-status.json']
  contract_outputs: []
  required_resources: []
  required_evidence: [red, green, regression]
  verification_commands:
    - id: targeted
      command: ['npm', 'test', '--', '-t', 'queue consumer']
  worker:
    model: sonnet
    effort: high
    max_turns: 30
    max_wall_clock_minutes: 45
    max_attempts: 2
    nested_delegation: false
  invalidation_rules: []
  acceptance_criteria: [AC-2]
```

`node_type` is one of: `contract-lock`, `red-test`, `implementation`,
`refactor`, `regression`, `review`, `integration`, `candidate-build`,
`runtime-deploy`, `e2e-scenario`, `knowledge`.

`candidate-build` and `e2e-scenario` nodes are executed by the controller
itself, not by a worker session: there is nothing for a model to decide about
cutting a candidate or running a shard.

## Resources

```yaml
resources:
  full-runtime: { capacity: 1 }      # always 1; validator enforces it
  deploy-slot: { capacity: 1 }       # always 1
  browser-worker: { capacity: 2 }    # raise only with isolation evidence
  fixture-global-reset: { capacity: 1 }
```

A scenario or node that declares a capacity-1 resource runs alone.

## E2E node runtime steps

An `e2e-scenario` node declares its runtime sequence as named verifiers, so
the deploy path is part of the graph rather than a hidden flag:

```yaml
verification_commands:
  - { id: deploy,        command: ['node', 'scripts/deploy-candidate.mjs'] }
  - { id: healthcheck,   command: ['node', 'scripts/healthcheck.mjs'] }
  - { id: fixture-reset, command: ['node', 'scripts/reset-fixture.mjs'] }
```

## Validation errors and what they mean

| Code | Fix |
|---|---|
| `DEPENDENCY_CYCLE` | Break the cycle; the detail names it. |
| `DUPLICATE_NODE_ID` | Two nodes share an id. |
| `UNKNOWN_DEPENDENCY` | `depends_on` names a node that is not in the graph. |
| `UNKNOWN_REPOSITORY` | Not in `repositories.yaml`, or not in this feature's `repositories`. |
| `UNKNOWN_RESOURCE` | `required_resources` names a resource with no declared capacity. |
| `MISSING_VERIFIER` | A node that changes or proves anything needs a real command. |
| `INVALID_BUDGET` | Turns, attempts and wall-clock must all be positive. |
| `NESTED_DELEGATION_FORBIDDEN` | Set `nested_delegation: false`. |
| `MISSING_ALLOWED_PATHS` | A writing node must declare its ownership fence. |
| `PATH_ESCAPES_REPOSITORY` | Paths are relative and may not escape the repo root. |
| `IMPLEMENTATION_REQUIRES_RED` | An implementation node must require RED evidence. |
| `UNPRODUCED_CONTRACT_INPUT` | No node produces the contract being consumed. |
| `CONTRACT_HANDOFF_NOT_ORDERED` | The consumer must depend on its producer. |
| `UNCOVERED_ACCEPTANCE_CRITERION` | Add a node, or move the criterion out of scope. |
| `UNKNOWN_ACCEPTANCE_CRITERION` | The node cites an `AC-n` the PRD does not define. |
| `CAPABILITY_REPOSITORY_MISMATCH` | A capability and its node disagree on the repository. |
| `RUNTIME_CAPACITY_MUST_BE_ONE` | `full-runtime`, `deploy-slot` and `fixture-global-reset` are always 1. |

## Loop

Write, then run `mycelink graph validate <feature>`, then fix, then repeat.
Do not initialise the feature until it exits 0.
