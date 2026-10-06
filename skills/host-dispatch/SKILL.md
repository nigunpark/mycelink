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

Before the loop, run `M controller open --json` and keep its `authority`
as `<key>`. Every controller command (dispatch, reconcile, decisions,
deliver, ...) needs `--authority <key>`; settle and the gates need only the
ticket's capability. The key exists so that a subagent, which runs as the
same user with the same Bash tool, cannot act as the controller by simply
leaving out its own capability. So:

- never put the key in an Agent prompt, a file, a commit or an environment
  variable, and never write it into a result;
- it is shown once and only its hash is stored; opening again rotates it;
- it cannot be opened while any claim is live (`CONTROLLER_BUSY`). If you
  lost it while a ticket is outstanding, ask the user to run
  `mycelink controller open --takeover` in their own terminal.

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
| `ALL_SETTLED` | `M feature verify`, `M candidate verify`, then `M deliver <feature> --json --authority <key>` |
| `WAITING` | an unsettled ticket exists: `M session reconcile <feature> --json --authority <key>`, then `M dispatch <feature> --resume <node> --json --authority <key>` |
| `NEEDS_DECISION` | ask the user; `M decision record ... --authority <key>`, then `M decision apply ... --authority <key>` |
| `BLOCKED` | report the fingerprint and evidence; do not unblock it yourself |
| `BUDGET_EXHAUSTED` / `NO_PROGRESS` | report usage or deferral reasons |
| `INFRASTRUCTURE_FAILURE` | a claim could not be set up; nothing was charged — report it |

## Recovery

- **Lost a ticket** (interrupted turn, compaction, new session):
  `M session reconcile <feature> --json --authority <key>` lists `pending_dispatches`.
  `M dispatch <feature> --resume <node> --json --authority <key>` re-issues the ticket with a
  rotated capability (the old one stops working). If `result_present` is
  true, just run its `settle_command`.
- **Expired tickets** are handed back by reconcile as interruptions: the
  node returns to READY with its attempt refunded and no failure recorded.
  `--abandon-dispatches` does that at once (for `/mycelink:cancel`, or when
  you know the previous host is gone).
- **A settle that died** leaves a marker reconcile clears; settling again
  with the same capability completes it. A repeated settle of an already
  settled claim returns its receipt and changes nothing.
- A node interrupted more than three times is parked BLOCKED.

## Delivery

`M deliver <feature> --json --authority <key>` fast-forwards every base branch to exactly the
candidate SHA after checking every repository first (fast-forward possible,
checkout clean, candidate current and undrifted), writes the delivery
manifest and runs final acceptance. It never pushes. It is safe to re-run.
