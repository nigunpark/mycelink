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
- it is shown once and only its hash is stored, bound to the session that
  opened it. Once a key exists, a new one is minted only by its holder
  (`controller open --authority <key>`, rotation, with no claim live), by a
  fresh session after the holding session ended (`controller open
  --recover`), or by the operator at a terminal (`controller open
  --takeover`). A subagent can end its own claim, so "no claim is live"
  never proves that no worker is running; a subagent of a live session never
  recovers the key, because its own session holds it;
- if you do not hold the key (`CONTROLLER_AUTHORITY_EXISTS`: a new session
  after an interruption), run `M controller open --recover --json`. Only
  if it answers `CONTROLLER_BUSY`, ask the user, as the operator, to run
  `mycelink controller open --takeover` in their own terminal; never search
  for it.

The control repository must be committed (clean outside `features/<id>/`)
before you dispatch: a candidate is cut only from a clean control
repository.

## The loop

```text
repeat at most 3 × (number of graph nodes) times (counted again after each review that settles GAPS):
  d = M dispatch <feature> --json --authority <key>
  if d.status != DISPATCHED: stop and handle d.status
  Agent(subagent_type = d.ticket.agent, description = d.ticket.node_id, prompt = d.ticket.prompt)
  if d.ticket.kind == acceptance-review: run d.ticket.await_command until it answers anything but RUNNING (each run waits up to 90 s;
      never settle, correct or relaunch the reviewer while it runs), then d.ticket.ingest_command
  run d.ticket.settle_command        (never write the result yourself: a missing one settles as the worker's failed attempt)
  if it answers EVIDENCE_CORRECTION_REQUIRED: dispatch again (the held claim's correction goes to a fresh worker; nothing was charged)
  if it answers REVIEW_CHALLENGED: dispatch again (the next ticket is the review's refinement, a reviewer ticket; nothing was charged)
  if it answers CHALLENGE_REQUIRED: dispatch again (the held claim's challenge request goes to a fresh worker; nothing was charged)
  if it answers CRITERIA_SETTLED: dispatch again (each criterion settled on its own; a challenge of one is refined next, a parked one waits for a person)
  if it answers STALE_ORCHESTRATION_EPOCH: nothing was changed; continue the loop (never retry that settle)
  if it answers PROVIDER_INTERRUPTED: the model provider ended the worker or reviewer; nothing was charged; dispatch again
  if it answers WORKER_RUNNING: the worker's Agent task has not completed; nothing was charged; wait for its completion notification, then run the same settle line
  if it answers REVIEW_ORDER_REBASED or REVIEW_GAP_STALE: the review moved to a later revision; nothing was charged; dispatch again
  if dispatch answers PROVIDER_UNAVAILABLE: stop and report it; a person clears it (session provider-reset)
```

- `dispatch` runs controller nodes (candidate build, E2E, verification
  nodes) itself before it returns the next ticket, so they never become
  tickets. A verification node runs its commands in a fresh checkout of
  the repository's integrated head and records a receipt; it has no worker.
- Once every product and verification node is DONE, and before the
  candidate build, `dispatch` returns an acceptance-review ticket
  (`kind: acceptance-review`, `ticket.agent` `mycelink:acceptance-reviewer`,
  `node_id` null, a `review_id`). The same loop fulfils it: the Agent tool
  with that subagent type and the prompt unchanged (description
  "acceptance review <review_id>"), then its `await_command`, then its
  `ingest_command`, then its `settle_command` — for a review, a format
  correction and a refinement alike. The reviewer is a separate, read-only
  session, usually in the background: its completion is Claude Code's to
  record, whether its notification reaches you as a turn of its own or while
  you are busy. `await_command` waits while it runs (up to 90 s a run) and
  says what comes next: `RUNNING` — run it again; never settle, correct or
  relaunch the reviewer while it runs (the fence refuses a second reviewer
  for one generation), however long it takes within its wall-clock (20
  minutes from its launch by default); `COMPLETED` — ingest, then settle;
  `COMPLETED_NO_OUTPUT` — settle (it answered nothing: a fresh reviewer
  follows); `TIMED_OUT` or `LOST` — it ran past its wall-clock, or its task
  or session ended before it completed: the generation is interrupted with
  nothing spent (stop it with TaskStop if it still runs) and `dispatch`
  hands a fresh generation of the same review out; `MISSING` — launch it.
  Its verdict is its final answer (exactly one JSON object and nothing else)
  or its one write, which the fence attests. `ingest_command` takes the final
  answer as the verdict when it wrote none, proved from Claude Code's own
  record of your Agent call (`INGESTED`, `ALREADY_INGESTED`, `WRITTEN`:
  settle; `REVIEWER_RUNNING`: it has not completed — run the await line
  again, nothing was written or spent; `REVIEW_RESULT_INVALID` — not exactly
  one JSON object — and `REVIEW_OUTPUT_CONFLICT` — a written verdict and a
  different answer — settle as refusals for their form, corrected by the
  next generation; any other code wrote nothing). A settle while the
  reviewer runs answers `REVIEWER_RUNNING` (none was launched:
  `REVIEWER_NOT_LAUNCHED`) and changes nothing; `REVIEWER_INTERRUPTED`
  means it was interrupted as above: dispatch again. Never write, paste or
  copy the reviewer's answer or verdict anywhere yourself. `PASS` lets the
  next dispatch cut the candidate;
  `GAPS` has already reworked, in that one settle, every product node its
  gaps' criteria belong to (the graph decides; dispatch again at once: the
  next ticket is a worker's — a focused RED first for a new behaviour, a
  regression test alone for a compatibility gap); `REVIEW_INVALID` gets
  the next generation on dispatch: for a verdict refused for its form a
  correction of it (`ticket.correction`; at most 3 format corrections), for
  one that left nothing to correct a fresh reviewer (twice at most); `REPEATED` (only repeats of earlier
  reproductions: nothing reworked) gets the next review on dispatch; `REVIEW_GAPS` (a materially new gap the
  review could not rework on its own: a criterion at its emergency ceiling, or past its `max_rounds` budget per criterion
  with no verified producer progress) and `REVIEW_NONCONVERGENT` (four reviews without progress,
  or eight review sessions) stop the feature BLOCKED. Never write or change a verdict, and never review in
  the reviewer's place.
- `REVIEW_CHALLENGED` (a worker's settle): in an acceptance review's rework
  the worker wrote the gap's exact reproduction as a focused test and the
  red gate passed it on the unchanged head. No attempt was charged; the node
  is DONE on the work the review judged; the review is CHALLENGED and
  `feature status` answers `review-refine`. The next `dispatch` returns a
  reviewer ticket whose `ticket.refinement` names the challenged gaps: fulfil
  it exactly as a review (Agent tool, prompt unchanged, then its
  ingest_command, then its settle_command). The fresh reviewer WITHDRAWs, REFINEs or UPHOLDs each
  gap; a refined or upheld gap is reworked anew, a repeated reproduction is
  refused for its form. A third challenge of one gap blocks the feature
  `REVIEW_DISPUTE` for a person; the node stays DONE. Each refinement is a
  new revision of the review (`<review>.refined-<n>.json`, linked to the one
  before); in the same write every other producer's rework of the review is
  rebased to it when its gaps are untouched (same generation, attempts and
  reason), replaced when they changed, cancelled when withdrawn — `review
  status` lists each order's revision and rebases.
- `CRITERIA_SETTLED` (a worker's settle): the worker of an acceptance
  review's rework answered each criterion of its order on its own (outcome
  `CRITERIA`). The criteria it proved DONE are integrated as the node's new
  generation; one it challenged (its exact reproduction passed on the
  unchanged base) is recorded as a challenge, the review CHALLENGED and
  `feature status` answers `review-refine` — the refinement decides that
  criterion alone, and the node keeps what it proved; one it left BLOCKED or
  NEEDS_DECISION is ordered again on its own and parked with its reason
  (`follow_up`), for a person. One product attempt for the execution;
  nothing failed. Dispatch again.
- `REVIEW_ORDER_REBASED` / `REVIEW_GAP_STALE` (a worker's settle): the
  ticket's rework was bound to an older revision of its review. Its answer
  is not judged and nothing was charged; dispatch again — the same claim is
  reissued from where its worker stands (rebased), or the rework is
  replaced. Never re-settle the old ticket.
- `CHALLENGE_REQUIRED` (a worker's settle): nothing was charged and the
  claim is held — dispatch again (or `dispatch --resume <node>`), which
  re-issues it with a challenge request at the top of its prompt, and give
  that ticket, unchanged, to a module-worker. In an acceptance review's
  rework its worker answered BLOCKED (`REVIEW_GAP_NOT_REPRODUCED`, or
  `INVALID_RED_EVIDENCE` with the behaviour already present) although its red
  gate passed every test it declared; the request is made once, and the old
  answer again is a failed attempt.
- `STALE_ORCHESTRATION_EPOCH` (a settle): the capability presented belongs to
  a dispatch that no longer counts — revoked by a resume, abandoned, replaced,
  or settled before the review moved on (the orchestration epoch moved) — or
  the result names another `orchestration_epoch` than its ticket. Nothing was
  changed or charged and the late result is archived; never retry it or
  re-dispatch for it: continue the loop.
- `PROVIDER_INTERRUPTED` (a settle, an ingest): the worker or reviewer left no
  result because its model provider ended it (a transient refusal, a rate
  limit, a server or network failure), as Claude Code recorded it. Its lease
  is interrupted-provider and nothing was charged — no attempt, no format
  correction, no round: `dispatch` hands the work out again (a fresh worker,
  the same generation from where it stands, or a fresh reviewer generation).
  Mycelink finds such holders itself from their transcripts (`feature status`
  says `reconcile`, `session reconcile` and `dispatch` reconcile them); past
  two per ticket or four per phase, `dispatch` answers `PROVIDER_UNAVAILABLE`.
- `EVIDENCE_CORRECTION_REQUIRED`: only the result's criterion evidence was
  refused; the claim is held on the same commit and worktree, nothing was
  charged or integrated. `dispatch` (or
  `M dispatch <feature> --resume <node> --json --authority <key>`) re-issues
  it as a correction ticket: give its prompt, unchanged, to a module-worker.
  The correction names the criterion, its kind and the gate its evidence
  needs; a metadata error is corrected on the held commit; a new behaviour
  no RED proved may be proved by a new RED cycle on the same worktree,
  which settle then judges whole. A correction answering RETRYABLE
  `CRITERION_UNPROVEN:<AC>` without changing anything charges no attempt
  (corrections are bounded, apart from attempts). Never write the result
  yourself.
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
| `SETTLED` | `dispatch --resume` finished an interrupted settle itself (`settled` is its report): continue the loop |
| `ALL_SETTLED` | `M feature verify`, `M candidate verify` (no current candidate: `M candidate create <feature> --authority <key>`), then `M deliver <feature> --json --authority <key>` |
| `WAITING` | an unsettled ticket exists. Its Agent still running in this session (`feature status`: `await-worker`): wait for its completion notification, then settle it; nothing is reviewed or cut past a live lease. `await-reviewer`: the acceptance reviewer you launched still runs — run its ticket's `await_command` until it completes, then its ingest and settle lines. After an interruption: `M session reconcile <feature> --json --authority <key>`, then `M dispatch <feature> --resume <node> --json --authority <key>` (`SETTLED`: continue; `DISPATCHED`: fulfil the re-issued ticket); a review whose reviewer still runs is never re-issued (`REVIEWER_RUNNING`): `M review await <feature> --review <id> --json`, then dispatch |
| `NEEDS_DECISION` | ask the user; `M decision record ... --authority <key>`, then `M decision apply ... --authority <key>` |
| `BLOCKED` | report the fingerprint and evidence; do not unblock it yourself |
| `BUDGET_EXHAUSTED` / `NO_PROGRESS` | report usage or deferral reasons |
| `INFRASTRUCTURE_FAILURE` | a claim could not be set up; nothing was charged — report it |
| `PRECONDITION_FAILED` | nothing was charged. Uncommitted control-repository files: commit your own scaffolding and dispatch again, otherwise report them. `WORKTREE_SETUP_FAILED`: the repository's `worktree_setup` did not complete in a new worktree (its log and receipt are named); fix the environment, then dispatch again once — never install dependencies in a worker's worktree yourself. `GRAPH_DRIFT`: the graph changed after `feature init`; restore it |
| `CONTROLLER_FAILED` | a controller node (candidate build, E2E, verification node) ran and failed; report its detail. A verification node's failing check is retryable: rework the producer node that owns the failing behaviour (`feature owners`), or dispatch again for a flaky run |

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
- **An interrupted settle** (the settle process or the whole host session
  died at any point after it took the worker's result): `dispatch`
  finishes it as the controller from the result it holds, at the head it
  judged, without the lost capability and without running the worker again
  (reconcile lists it with `settlement: "held"`). `dispatch --resume
  <node>` does the same and answers `SETTLED`; it also finishes a
  dispatch whose worker wrote its result before the host died. A marker of
  a dead settle is seen through by the settling process's identity, never
  by a pid alone. A repeated settle of an already settled claim returns its
  receipt and changes nothing; a capability from before a resume is refused.
- **A held correction** (reconcile lists it with `settlement:
  "correction"`): `dispatch --resume <node>` re-issues the correction ticket
  with a rotated capability; fulfil it with a module-worker, never yourself.
- **An interrupted controller run** (a verification node or candidate build
  whose `dispatch` died): reconcile hands it back unspent
  (`interrupted_controller_runs`), as does the next `dispatch`, which runs it
  again; a run another live controller holds is left alone (`WAITING`).
- **A new session** recovers the key first (`controller open --recover`),
  reconciles, and continues the loop through the candidate and delivery.
- **An incomplete exit** (a session ended with nodes READY, a refused
  history's node waiting for its next attempt, the candidate not cut or not
  delivered) is resumable: `M feature status <feature> --json` answers
  `resumable: true` and a `next_action` (`dispatch`, `await-worker` — a
  worker holds a live dispatch lease: wait for its notification and settle
  it — `await-reviewer` — the acceptance reviewer launched for the open
  generation still runs (`next_action.reviewer`: its task and agent by hash,
  how long it ran of its wall-clock): wait for it, never relaunch it —
  `reconcile` — a lease's holder left a result to settle or a hold to
  re-issue, or is gone, a reviewer included — `review-refine` or `deliver`)
  naming the node, its rework generation, the attempts used of that
  generation's allowance and its last refusal. Never end the session while
  `next_action` is `await-worker`, `await-reviewer` or `reconcile`: a live
  lease you leave is one nobody settles. The next host invocation
  continues it with `/mycelink:run`; nothing done is lost. `resumable:
  false` (`decision`, `stopped`) needs a person.
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
no longer holds the delivery (its history was rewritten). A delivered base
someone committed on since the delivery is adopted instead: the node starts
again from it and the new candidate delivers on top of it. A parked
(BLOCKED) node is never reworked; it needs a recorded decision.

## A defect QA reports after the delivery

QA's report on a delivered commit, often to a new session, is repaired the
same way, as the controller: **do not edit or commit product code in this
session yourself** — no Write or Edit of a registered repository's files,
no `git commit`, `revert`, `cherry-pick`, `apply` or `checkout -- <path>`
there. Product code, a ticket's `result_slot` and the evidence are the
module-worker's and Mycelink's: the plugin's fence refuses a controller's
write there. `/mycelink:rework <feature>` is this procedure as a
controller-only command; start there.

```text
M controller open --recover --json          (a new session: recover the key first)
M feature status <feature> --json
M feature rework <feature> --since-delivery [<repository>:<path>...] [--acceptance <AC-id,...>] --reason "<QA's failing checks as reported>" --json --authority <key>
    (attributes and reworks in one step; on REWORK_OWNER_AMBIGUOUS or REWORK_OWNER_UNKNOWN:)
M feature owners <feature> [<repository>:<path>...] [--acceptance <AC-id,...>] --since-delivery --json
M node rework <feature> <producer-node> --reason "<QA's failing checks as reported>" --json --authority <key>
the loop: dispatch -> Agent(module-worker) -> settle, until ALL_SETTLED
M deliver <feature> --json --authority <key>
M feature verify <feature> --delivered --json   (done only when it exits 0)
```

`feature owners` names the producer nodes owning what changed on a
delivered base since the delivery (the commits QA's report may be about),
the paths the failing checks exercise and the acceptance criteria they name
(a check called `ac2_...` or `AC-2 ...` exercises AC-2), and what reworking
each reopens. Rework the node that owns the failing behaviour, never the
candidate build; its dependents reopen with it. The reason is at most 2000
bytes and holds nothing but what QA reported: each failing check and its
message.

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

The run is complete only when `M feature verify <feature> --delivered --json`
exits 0: every node DONE, the current candidate delivered and accepted.
Never report success, or end the session as if the feature were done,
before that.
