---
description: Reconcile and resume a feature after a crash, compaction or new session
argument-hint: <feature-id>
allowed-tools: Bash, Read, Glob, Grep, Agent, Write
---

# Resume

Feature: `$0`

Do not rely on anything you remember. Rebuild from the canonical files. Let
`M` be `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs"`.

0. You need the controller key (`<key>`). Use the one you hold from earlier
   in this conversation. A new session does not hold it: run
   `M controller open --recover --json` and keep its `authority`. It mints a
   new key, revoking the old one, only once the session that held the old
   key has ended (its subagents ended with it). Only if it answers
   `CONTROLLER_BUSY` (that session is still running, or nothing can prove it
   ended), ask the user, as the operator, to run
   `mycelink controller open --takeover` in their own terminal and give you
   the key. Never search for it, and never put it in a file or a subagent
   prompt.
1. `M session reconcile $0 --json --authority <key>`
   Reclaims dead leases, clears settles whose process died, hands expired
   host dispatches back as interruptions (no failure is recorded), and lists
   the dispatches that are still pending. `settlement: "held"` marks an
   interrupted settle whose result the controller already holds;
   `settlement: "correction"` a claim held for its criterion evidence,
   which `dispatch --resume` re-issues as a correction ticket for a
   module-worker (never correct it yourself). `interrupted_controller_runs`
   names verification nodes or candidate builds whose `dispatch` died: they
   were handed back unspent and the next `dispatch` runs them again.
   `pending_review` names the acceptance review a reviewer subagent had:
   with `verdict_present` the next `dispatch` settles its verdict (no
   reviewer runs again). Its `reviewer.state` `RUNNING` (`feature status`:
   `await-reviewer`) means the reviewer launched before is still running —
   its host session lives on: never launch another; wait for it with
   `M review await $0 --review <review_id> --json` (run it again while it
   answers `RUNNING`), then `dispatch` settles its answer. Otherwise
   `M dispatch $0 --resume <review_id> --json --authority <key>` hands it
   to a fresh `mycelink:acceptance-reviewer` — a reviewer that ran past its
   wall-clock or whose session ended is interrupted first, nothing spent
   (fulfil the ticket as `/mycelink:run` Phase 6 describes: its await,
   ingest and settle lines).
2. `M checkpoint validate $0`
   If the checkpoint was taken against a different graph, say so and stop.
3. `M feature status $0 --json`
   Its `next_action` says what this session does next (`dispatch`,
   `reconcile`, `await-reviewer` — a reviewer launched before still runs:
   wait for it as step 1 says, never relaunch it — `review-refine` — a fresh
   reviewer refines a challenged review gap, dispatch hands out its
   ticket — or `deliver`), naming the exact node — its state, rework
   generation, attempts used of that generation's allowance and the last
   refusal (a settle's `TDD_HISTORY_INVALID:<code>` at a commit) — and
   `resumable` whether a controller can do it without a person. A session
   that exited with the feature incomplete left it resumable when
   `resumable` is true: this next host invocation continues it, through
   `/mycelink:run`'s loop (step 7). `resumable: false` (`decision`:
   a parked node, a rework generation whose attempts are spent; `stopped`)
   needs a person: report it.
4. Re-read `features/$0/PRD.md`, `PORTFOLIO-GRAPH.yaml` and `DECISIONS.md`.
5. If there are pending decisions, resolve them before resuming.
6. For each entry in `pending_dispatches`, run
   `M dispatch $0 --resume <node-id> --json --authority <key>`.
   `SETTLED`: the controller finished that interrupted settlement itself,
   from the result it holds (`settled` is the report); nothing is run again.
   `DISPATCHED`: it re-issued the ticket with a new capability (the old one
   stops working); fulfil it with the Agent tool exactly as `/mycelink:run`
   describes, then run its `settle_command`.
7. Continue with the `/mycelink:run` loop from
   `M dispatch $0 --json --authority <key>` through the candidate and
   delivery (its Phases 4 to 8: the acceptance review included). `dispatch` itself finishes any other
   interrupted settle whose result the controller holds.

The resume is complete only when `M feature verify $0 --delivered --json`
exits 0: every node DONE, the current candidate delivered and accepted.
Never report success, or end the session as if the feature were done,
before that; report the problems it lists as an unfinished run instead.

## A defect QA reports after the delivery

A session resumed for QA's report on a delivered commit repairs it in this
feature, as the controller: **do not edit or commit product code in this
session yourself** — no Write or Edit of a registered repository's files,
no `git commit`, `revert`, `cherry-pick`, `apply` or `checkout -- <path>`
there. Product code, a ticket's `result_slot` and the evidence are the
module-worker's and Mycelink's: the plugin's fence refuses a controller's
write there.

Start with `/mycelink:rework $0` and QA's report: it is this procedure as a
controller-only command. Its one-step attribution is
`M feature rework $0 --since-delivery [<repository>:<path>...] [--acceptance <AC-id,...>] --reason "<QA's failing checks as reported>" --json --authority <key>`;
when it answers `REWORK_OWNER_AMBIGUOUS` or `REWORK_OWNER_UNKNOWN`, use
steps 2 and 3.

1. Recover the key (`M controller open --recover --json`, step 0), then
   `M feature status $0 --json`.
2. Attribute QA's failing checks to the producer node that owns the failing
   behaviour: `M feature owners $0 [<repository>:<path>...] [--acceptance
   <AC-id,...>] --since-delivery --json` names the producer nodes owning
   what changed on a delivered base since the delivery, the paths the
   failing checks exercise and the acceptance criteria they name (a check
   called `ac2_...` or `AC-2 ...` exercises AC-2), and what reworking each
   reopens. Rework that node, never the candidate build; its dependents
   reopen with it.
3. `M node rework $0 <node-id> --reason "<QA's failing checks as reported: each check and its message>" --json --authority <key>`
   (at most 2000 bytes; nothing but what QA reported).
4. Continue with the `/mycelink:run` loop (its Phases 4 to 8): dispatch the
   reopened nodes to the module-worker subagent and settle each, then cut
   the new candidate and `M deliver $0 --json --authority <key>`.
5. You are done only when `M feature verify $0 --delivered --json` exits 0.
