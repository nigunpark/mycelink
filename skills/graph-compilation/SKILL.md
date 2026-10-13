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
`runtime-deploy`, `e2e-scenario`, `knowledge`, `verification`.

`candidate-build`, `e2e-scenario` and `verification` nodes are executed by
the controller itself, not by a worker session: there is nothing for a
model to decide about cutting a candidate, running a shard or running
existing tests. A worker node always has something to change: one with a
repository and no `allowed_paths` is refused (`WORKER_NODE_CHANGES_NOTHING`).

## Verification nodes

A compatibility criterion ("a run that succeeds produces exactly the same
files as today"), or a final full-suite regression, is proved again on the
integrated state by a `verification` node: the controller runs it itself,
inside `dispatch`, like the candidate build — no ticket, worker, worktree,
branch, commit or TDD history. It is never a worker node with nothing to
change: a `regression` worker with no allowed paths can only submit
nothing, settle refuses `NO_DECLARATION_COMMIT` and the node blocks.

**Every criterion has a product producer.** Give each criterion, whatever
its kind, to the implementation (or declaration) node whose code it is
about; a verification node may carry it as well, never alone. A criterion
a verification node carries alone has no product node to rework when the
acceptance review finds it untested, and the feature blocks.
The producer evidences a compatibility criterion with a test its green or
regression gate passed (an existing one, or the regression test of a
compatibility-regression unit); the verification node proves it again.
`graph validate` refuses a criterion no product node serves
(`CRITERION_NO_PRODUCER`) and a verification node's criterion no upstream
producer serves (`VERIFICATION_CRITERION_UNOWNED`).

```yaml
- id: FEAT-101.api.compat.verify
  level: executable-node
  repository: api                  # the repository whose integrated state it checks
  capability: CAP-API-COMPAT
  node_type: verification
  depends_on: [FEAT-101.api.queue-consumer.impl]   # every producer node of its repository
  allowed_paths: []                # it writes nothing
  required_evidence: [regression]  # or [green, regression]; never red
  verification_commands:           # from the allowlist: any module's verifier, or a repository command
    - { id: module-api, module: api, module_sha256: <from repo modules>, command: [<the module's test argv>] }
    - { id: full-suite, command: [npm, test] }
  worker: { model: sonnet, max_turns: 1, max_wall_clock_minutes: 30, max_attempts: 2, nested_delegation: false }
  invalidation_rules: []
  acceptance_criteria: [AC-5]      # proved again here; AC-5 is also on the producer whose code it is about
```

- It runs in a fresh, set-up checkout of the repository's integrated head
  (the commit the candidate binds): it depends on every producer node of
  its repository, and the candidate build depends on it.
- Its receipt binds the head, each command's module and plan hashes and
  output, the setup's config and receipt, and the canonical id of every
  test that passed; a criterion it carries is evidenced again by that
  receipt. Every criterion on it is one a producer it depends on serves:
  the proof stays that producer's (its RED, its GREEN, or for a
  compatibility criterion a test its gates passed), and the verification
  node only re-verifies it. A review gap in it is reworked on that producer.
- A failing command is the node's recorded, retryable verification failure
  (`dispatch` stops with `CONTROLLER_FAILED`, the receipt names the output):
  rework the producer node that owns the failing behaviour, or dispatch
  again for a flaky run; the same failure twice blocks it. A drifted module
  or a checkout that cannot be set up charges nothing.

## Resources

```yaml
resources:
  full-runtime: { capacity: 1 }      # always 1; validator enforces it
  deploy-slot: { capacity: 1 }       # always 1
  browser-worker: { capacity: 2 }    # raise only with isolation evidence
  fixture-global-reset: { capacity: 1 }
```

A scenario or node that declares a capacity-1 resource runs alone.

## Test-first history

Settle verifies every node that requires `red` evidence test-first from its
commit history: test-only commits holding exactly what a red gate ran, then
production-only commits, cycle after cycle; anything else is refused before
integration. So a node's `allowed_paths` must include the tests it writes
(`src/**` alone leaves the worker nowhere to put its RED). Which paths are
tests is the repository's policy: conservative defaults (`**/src/test/**`,
`**/*.test.*`, `test/` and `tests/` directories, `test_*.py`, `*_test.go`,
...; `**/src/main/**` never), replaced with
`mycelink repo register ... --test-paths <globs> --production-roots <globs>`;
`--declaration-paths <globs>` names production (type declarations,
documentation) that carries no runtime test and needs no RED cycle.

A node whose `required_evidence` has no `red` (other than a `refactor`) is
a declaration-only node: it proves GREEN (build, typecheck) and regression
without a RED, and settle accepts its history only as production-only
commits, at least one, inside the declaration paths its claim binds — no
test, no runtime code. Give it `allowed_paths` within the repository's
declaration paths; anything with behaviour belongs in a node with a RED.

## Acceptance criteria and their evidence

Each criterion may say its `kind`: `behaviour` (the default: a new
behaviour, evidenced by a test a RED failed) or `compatibility` (behaviour
that must not change, which may be evidenced by an existing test through
green or regression). Every worker node's result maps each of its criteria
to a named test, its gate and that gate's output hash; settle refuses the
node otherwise, and `candidate verify` and `deliver` refuse a feature with a
criterion no DONE node evidenced (`UNCOVERED_ACCEPTANCE_CRITERION`). Give
every criterion to the worker node that owns its behaviour.

## Module-scoped verification

When `repositories.yaml` declares `modules` for a repository (each module's
shell-free setup/build/test argv, `module_defaults` for what they share),
every node verifier in that repository comes from its allowlist. Print it
with `mycelink repo modules --json`: per module its resolved commands, its
`sha256` and the exact `verifier` to paste, and the repository's full suite.

- A node that owns a module (its `allowed_paths` reach it) verifies first
  with that module's verifier — `{ id, module, module_sha256, command }`,
  copied as printed. Its red and green gates run only that module's tests;
  its regression, the candidate and delivery acceptance run the full suite.
- One node owns at most one runtime module; a declaration-only module
  (`runtime_tests: false`) may sit beside it, and a node that owns only one
  uses that module's verifier too.
- A node in no module (shared paths) may name a repository command.
- A node whose module will depend on another of the repository's own
  packages declares it in its manifest and the lockfile: give it the
  lockfile (a shared path, in no module) in `allowed_paths`. When the
  repository's `worktree_setup` names them as `inputs`, the node's next
  gate installs the change.
- The module hash binds the graph: a module changed after `feature init`
  stops dispatch with `MODULE_DRIFT` (nothing claimed or charged).

| Code | Fix |
|---|---|
| `UNSCOPED_VERIFICATION` | The node owns a module but runs the whole suite; use the module verifier the detail prints. |
| `MODULE_VERIFIER_REQUIRED` | The node owns a module; its first verifier must be that module's. |
| `COMMAND_NOT_ALLOWLISTED` | The command is neither a module command nor a repository command. |
| `MODULE_COMMAND_MISMATCH` | The verifier names a module but not exactly its command. |
| `MODULE_DRIFT` | `module_sha256` is not the module's current hash; copy it again from `repo modules`. |
| `MODULE_SPAN` | The fence reaches two runtime modules; split the node. |
| `MODULE_NOT_OWNED` | The verifier runs a module the node's fence does not reach. |
| `UNKNOWN_MODULE` | The repository declares no such module. |

## Graph immutability

Once `feature init` has recorded the graph's hash, the graph is fixed:
`dispatch`, `node claim` and `dispatch --resume` refuse a graph that no
longer hashes to it (`PRECONDITION_FAILED`, `GRAPH_DRIFT`) before
anything is claimed or set up. Restore it, or plan the change as a new
feature (`feature supersede`).

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
| `WORKER_NODE_CHANGES_NOTHING` | A worker node with a repository and no `allowed_paths` could only submit nothing; prove existing behaviour with a `verification` node. |
| `VERIFICATION_NODE_WRITES` | A verification node changes nothing: empty its `allowed_paths`. |
| `VERIFICATION_NEEDS_REPOSITORY` | A verification node names the repository it checks out. |
| `VERIFICATION_EVIDENCE` | A verification node's `required_evidence` is green and/or regression, never red. |
| `VERIFICATION_DEPENDENCY_MISSING` | Make it depend (directly or not) on every producer node of its repository. |
| `VERIFICATION_NOT_BEFORE_CANDIDATE` | Make the candidate build depend on every verification node. |
| `VERIFICATION_CRITERION_UNOWNED` | Every criterion on a verification node, compatibility included, needs a producer it depends on that serves it too. |
| `CRITERION_NO_PRODUCER` | A criterion only a verification node, candidate build or E2E scenario names: give it to the implementation (or declaration) node whose code it is about as well. |

## Loop

Write, then run `mycelink graph validate <feature>`, then fix, then repeat.
Do not initialise the feature until it exits 0.
