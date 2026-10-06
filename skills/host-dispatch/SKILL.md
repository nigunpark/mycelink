---
name: host-dispatch
description: Use when driving a Mycelink multi-repository feature from inside Claude Code — looping mycelink dispatch, fulfilling each ticket with the Agent tool and the module-worker subagent, settling it, recovering interrupted tickets, and delivering the verified candidate.
---

# Host dispatch

Inside Claude Code the controller never starts a worker process. It hands
you one **ticket** at a time; you fulfil it with your own **Agent tool**;
the controller takes the result back and decides what it proves.

Never run `orchestrate run`, `orchestrate once` or `session spawn` here:
they are the standalone CLI adapter and need a `claude` executable the
sandbox may not have.

`M` below is `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs"`.

## Controller authority

Before the loop you need the controller key (`<key>`): the one you hold
from earlier in this conversation, or, only if this control repository has
never had one, `M controller open --json` (keep its `authority`). Every controller command (dispatch, reconcile, decisions,
deliver, ...) needs `--authority <key>`; settle and the gates need only the
ticket's capability. The key exists so that a subagent, which runs as the
same user with the same Bash tool, cannot act as the controller by simply
leaving out its own capability. So:

- never put the key in an Agent prompt, a file, a commit or an environment
  variable, and never write it into a result;
- it is shown once and only its hash is stored. Once a key exists, a new one
  is minted only by its holder (`controller open --authority <key>`, rotation,
  with no claim live) or by the operator at a terminal
  (`controller open --takeover`). A subagent can end its own claim, so "no
  claim is live" never proves that no worker is running;
- if you do not hold the key (`CONTROLLER_AUTHORITY_EXISTS`), ask the user
  to run `mycelink controller open --takeover` in their own terminal; never
  search for it.

The control repository must be committed (clean outside `features/<id>/`)
before you dispatch: a candidate is cut only from a clean control
repository.

## The loop

```text
repeat at most 3 × (number of graph nodes) times:
  d = M dispatch <feature> --json --authority <key>
  if d.status != DISPATCHED: stop and handle d.status
  Agent(subagent_type = d.ticket.agent, description = d.ticket.node_id, prompt = d.ticket.prompt)
  ensure a result exists at d.ticket.result_slot (write the subagent's JSON result there if it did not)
  run d.ticket.settle_command
```

- `dispatch` runs controller nodes (candidate build, E2E) itself before it
  returns the next ticket, so they never become tickets.
- The ticket carries a random `capability`. Settle and the gates accept
  only the current claim's capability; it is never stored, so keep the
  ticket until you have settled it. Do not paste it anywhere else.
- Pass `ticket.prompt` unchanged. It already holds the bounded context pack,
  the absolute worktree, the gate commands and the absolute result file.
- If the subagent returned no result and the slot is empty, write a
  `RETRYABLE` result with `failure_fingerprint: "WORKER_RESULT_MISSING"`.
  Never write a result claiming work the subagent did not report.
- `settle` quarantines the result, re-runs the node's verifiers on a clean
  checkout of its branch, checks the ownership fence, advances the gates,
  integrates into `feature/<feature>`, and only then marks the node DONE
  and makes its dependents READY. A submission that does not verify is a
  recorded failed attempt; the node is retried within its budget.

## Stop reasons

| status | what to do |
|---|---|
| `ALL_SETTLED` | `M feature verify`, `M candidate verify` (no current candidate: `M candidate create <feature> --authority <key>`), then `M deliver <feature> --json --authority <key>` |
| `WAITING` | an unsettled ticket exists: `M session reconcile <feature> --json --authority <key>`, then `M dispatch <feature> --resume <node> --json --authority <key>` |
| `NEEDS_DECISION` | ask the user; `M decision record ... --authority <key>`, then `M decision apply ... --authority <key>` |
| `BLOCKED` | report the fingerprint and evidence; do not unblock it yourself |
| `BUDGET_EXHAUSTED` / `NO_PROGRESS` | report usage or deferral reasons |
| `INFRASTRUCTURE_FAILURE` | a claim could not be set up; nothing was charged — report it |
| `PRECONDITION_FAILED` | the control repository has uncommitted files; commit your own scaffolding there and dispatch again, otherwise report them |
| `CONTROLLER_FAILED` | a controller node (candidate build, E2E) ran and failed; report its detail |

## Recovery

- **Lost a ticket** (interrupted turn, compaction, new session):
  `M session reconcile <feature> --json --authority <key>` lists `pending_dispatches`.
  `M dispatch <feature> --resume <node> --json --authority <key>` re-issues the ticket with a
  rotated capability and a new dispatch id with its own result file. The old
  capability stops working, and nothing the previous worker writes later is
  read. A result it had already written is checked and taken into the
  controller at the resume; then `result_present` is true and you just run
  the new ticket's `settle_command`.
- **Expired tickets** are handed back by reconcile as interruptions: the
  node returns to READY with its attempt refunded and no failure recorded.
  `--abandon-dispatches` does that at once (for `/mycelink:cancel`, or when
  you know the previous host is gone).
- **A settle that died** leaves a marker reconcile clears; settling again
  with the same capability completes it. A repeated settle of an already
  settled claim returns its receipt and changes nothing.
- A node interrupted more than three times is parked BLOCKED.

## Repair inside the same feature

A check that fails after a node was DONE (a dependent's fresh verification,
the E2E, `deliver` acceptance, the product's own acceptance suite on the
delivered commits) is repaired in the same feature, never under a new
feature id:

```text
M node rework <feature> <node-id> --reason "<failing check, exact input, expected vs actual, why this node owns it>" [--acceptance <AC-id,...>] [--evidence <relative-path,...>] --json --authority <key>
```

The reason becomes the node's **rework brief**: bounded (2000 bytes), free
of control characters, redacted of credential shapes, refused if it holds
the controller key, bound to the rework record by its SHA-256 and re-checked
before every dispatch (`REWORK_BRIEF_INVALID` otherwise). The node's next
tickets carry it as `rework` and inside the context pack, between the data
delimiters; the worker writes a focused failing regression test from it
before changing production code. Make the reason precise enough to
reproduce: the failing check, the exact input, expected and actual result.

It reopens the attributed producer node and everything downstream (the
candidate build and E2E included) in dependency order, keeps the node's
attempts and failure fingerprints and its replaced work as history,
archives its branch, and makes the current candidate stale. Each approved
rework is a generation with its own allowance of `max_attempts` attempts,
counted from the lifetime attempts at the rework (never reset); a worker's
`INVALID_RED_EVIDENCE` inside a rework is a recorded, retryable failure, and
the same failure twice parks the node. Then continue the loop in the same
feature: the node is dispatched from the current integration state, settle
fences only the repair, and a new candidate binds every repository. It is
refused, changing nothing, while work is in flight, when the node's rework
limit is spent, when the reason or references are unusable, when a parked
node would be reopened without `--decision <id>`, or when a delivered base
has moved past the integration branch. A parked (BLOCKED) node is never
reworked; it needs a recorded decision.

## Delivery

`M deliver <feature> --json --authority <key>` fast-forwards every base branch to exactly the
candidate SHA after checking every repository first (fast-forward possible,
checkout clean, candidate current and undrifted), writes the delivery
manifest and runs final acceptance. It never pushes. It is safe to re-run:
an accepted manifest is re-checked (every acceptance output must still hash
to what it records) before it answers, otherwise acceptance runs again.
If a later repository fails, what this delivery moved is put back only
where nobody has committed since; a base that moved is left alone and the
manifest says `PARTIAL_DELIVERY` — report it for manual recovery, do not
retry blindly.
