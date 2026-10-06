---
description: Run a feature end to end host-natively — init, PRD, plan, then dispatch each READY node to the module-worker subagent, settle it, cut the candidate and deliver
argument-hint: <feature-id>
allowed-tools: Bash, Read, Glob, Grep, Agent, Write, Edit, Skill, AskUserQuestion
---

# Run the feature

Feature: `$0`

Use the `host-dispatch` skill. The controller decides what runs; you carry
tickets between it and the Agent tool. You do not implement nodes yourself,
you do not edit controller files, and you never start a nested `claude`
process.

Let `M` be the launcher: `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs"`.

This command is the whole run. Its phases follow one another: **do not stop
between phases**. When a phase command (`/mycelink:init`, `/mycelink:prd`,
`/mycelink:plan`) finishes, it hands control back here and you continue with
the next phase at once. Stop early only for a real unresolved product
decision (ask the user with AskUserQuestion, record it, then continue) or
for a stop reason listed below. Skip a phase whose output already exists and
is committed.

The controller key (`<key>`): use the one you hold from earlier in this
conversation (`/mycelink:init` opens it). Only if this control repository has
never had one, run `M controller open --json` and keep its `authority`. If
that answers `CONTROLLER_AUTHORITY_EXISTS` and you do not hold the key, stop
and ask the user to run `mycelink controller open --takeover` in their own
terminal and give you the key; never search for it. Every controller command
needs `--authority <key>`; `settle` and the gates do not (they use the
ticket's capability). The key is yours alone: never put the key in the Agent
prompt, a file or an environment variable, and never pass it to the
subagent.

### Phase 1 — init

No `mycelink.config.json` yet: follow `/mycelink:init` for the control
repository, then continue with Phase 2.

### Phase 2 — prd

No committed `features/$0/PRD.md` yet: follow `/mycelink:prd` (write it,
commit it), then continue with Phase 3.

### Phase 3 — plan

No `features/$0/STATE.json` yet: follow `/mycelink:plan` (graph, validate,
`feature init`, commit), then continue with Phase 4.

1. `M loop validate $0`
2. `M orchestrate ready $0` — show the user which nodes are schedulable and
   why the rest are deferred, then go straight on.

### Phase 4 — dispatch

Loop, **at most 3 × (number of graph nodes) iterations**:

1. Run `M dispatch $0 --json --authority <key>` and read `status`.
2. If `status` is `DISPATCHED`, take the `ticket` and call the **Agent
   tool** with `subagent_type` set to `ticket.agent`
   (`mycelink:module-worker`), a short `description` naming
   `ticket.node_id`, and `prompt` set to `ticket.prompt` exactly. Do not
   add instructions to it and do not do the node's work yourself.
3. When the Agent returns, check that the file at `ticket.result_slot`
   exists. If it does not, write the JSON node result the subagent
   returned in its final message to `ticket.result_slot` with the Write
   tool. If it returned none, write
   `{"schema_version": 1, "node_id": <ticket.node_id>, "claim_id": <ticket.claim_id>, "dispatch_id": <ticket.dispatch_id>, "outcome": "RETRYABLE", "commands": [], "evidence_paths": [], "failure_fingerprint": "WORKER_RESULT_MISSING"}`.
   Never write a result that claims more than the subagent reported.

### Phase 5 — settle

4. Run `ticket.settle_command` exactly (it is
   `M settle $0 <node-id> --capability <capability> --json`). Settle
   re-verifies on a clean checkout, integrates, and marks the node DONE
   only if everything holds. Report its `outcome`, then continue the loop
   at step 1.
5. Any other `status` ends the loop; handle it below.

### Phase 6 — candidate

The candidate build in the graph runs inside `dispatch`; `ALL_SETTLED`
means every node is DONE. If `M feature status $0` shows no current
candidate (a graph without a candidate-build node), cut one with
`M candidate create $0 --authority <key>`. A candidate binds every registered
repository at its exact integration SHA.

### Phase 7 — deliver

Run `M feature verify $0` and `M candidate verify $0`; if both exit 0, run
`M deliver $0 --json --authority <key>` and report the delivered SHAs and
acceptance evidence. If the task names an acceptance suite of its own, run
it now on the delivered commits.

## Repair inside the same feature

When a check after a node was DONE fails — fresh verification of a
dependent, the E2E, `deliver` acceptance (`ACCEPTANCE_FAILED`) or the
product's own acceptance suite on the delivered commits — repair it in
**this** feature. Never create a new or follow-up feature id, and do not
cancel this one to start over.

1. Attribute the failure to the producer node that owns the failing
   behaviour (use the `integration-failure-attribution` skill; name the
   failing test, file or contract).
2. `M node rework $0 <node-id> --reason "<failing check, test and why this node owns it>" --json --authority <key>`
   It reopens that node and everything downstream of it (candidate build
   and E2E included), keeps the node's attempts, failures and evidence as
   history, archives its old branch and makes the current candidate stale.
   If it names a parked node (`REWORK_PARKED`), ask the user, record the
   decision, and pass `--decision <id>`. Repeating the same rework changes
   nothing.
3. Go back to Phase 4. The node is dispatched from the current integration
   state, its worker writes a failing test for the reported defect first,
   and settle fences only the repair. Then a new candidate binds every
   repository and Phase 7 delivers it.

A rework is refused, with nothing changed, when work is still in flight
(`REWORK_IN_FLIGHT`: settle or reconcile first), when the node's attempt or
rework budget is spent (`REWORK_BUDGET_EXHAUSTED`, `REWORK_LIMIT`), or when a
delivered base branch moved past the integration branch
(`REWORK_BASE_MOVED`). Report those to the user; do not work around them.

## Stop reasons

- `ALL_SETTLED` — continue with Phase 6 and Phase 7.
- `WAITING` — a dispatched node was not settled (an interrupted turn). Run
  `M session reconcile $0 --json --authority <key>`; for each
  `pending_dispatches` entry run
  `M dispatch $0 --resume <node-id> --json --authority <key>` and continue the loop with that
  ticket (settle it directly if `result_present` is true). Resume a node at
  most twice; after that, report it.
- `NEEDS_DECISION` — read `features/$0/DECISIONS.md`, ask the user with
  AskUserQuestion, `M decision record $0 <id> --answer "..." --authority <key>`,
  then `M decision apply $0 <id> --authority <key>`, then continue. Never
  answer it yourself.
- `BLOCKED` — report the node, its repeated failure fingerprint, the
  commands and exit codes, and the nearest reproducible test layer. Do not
  retry it with another agent and do not try to unblock it yourself.
- `BUDGET_EXHAUSTED` — report what was spent and what remains.
- `NO_PROGRESS` — report what is deferred and why.
- `INFRASTRUCTURE_FAILURE` — the controller could not set up a claim
  (worktree, git). Nothing was charged; report the detail.
- `PRECONDITION_FAILED` — a controller node (the candidate build) needs a
  clean control repository and found uncommitted files; nothing was
  charged. If the files listed are Mycelink scaffolding or feature files
  you created (`features/`, `repositories.yaml`, `.gitignore`, `CLAUDE.md`,
  `.claude/settings.json`, `mycelink.config.json`), commit them in the
  control repository (`git -C <control> add -A` then `git commit`) and
  dispatch again; otherwise report them to the user.
- `CONTROLLER_FAILED` — a controller node ran and failed. Report its
  detail; do not edit controller files to make it pass. If the E2E failed
  and attributed a producer node, that node is already reopened: dispatch
  again.

If the loop limit is reached, stop and report the last dispatch output.

Report completed nodes, the current node, any stop reason and real evidence
paths — nothing else. `orchestrate run` is the optional standalone CLI
adapter for use outside Claude Code; it is not part of this command.
