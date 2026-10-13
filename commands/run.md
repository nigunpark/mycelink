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
process. In the workspace you write only your own documents (the feature's
PRD, plan and graph, its E2E scenarios, contracts) and commit the control
repository; a helper script or scratch file goes under `$TMPDIR`, outside the
workspace, and a script names the files it writes literally — the fence
refuses code whose writes it cannot place.

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
that answers `CONTROLLER_AUTHORITY_EXISTS` and you do not hold the key (a new
session: the one that opened it was interrupted or ended), run
`M controller open --recover --json` and keep its `authority`: it mints a new
key, revoking the old one, only once the session that held the old key has
ended. Only if that answers `CONTROLLER_BUSY` (the session is still running,
or nothing can prove it ended), stop and ask the user, as the operator, to
run `mycelink controller open --takeover` in their own terminal and give you
the key; never search for it. Every controller command needs
`--authority <key>`; `settle` and the gates do not (they use the ticket's
capability). The key is yours alone: never put the key in the Agent prompt, a
file or an environment variable, and never pass it to the subagent.

A run that was interrupted (this is a new session and `features/$0/STATE.json`
shows work in flight) picks up where it stopped: run
`M session reconcile $0 --json --authority <key>`, then go straight to
Phase 4. `dispatch` itself finishes an interrupted settle whose result the
controller already holds (`settlement: "held"`; its report is in
`controller_reports`), without running the worker again and without the
lost capability. For any other `pending_dispatches` entry run
`M dispatch $0 --resume <node-id> --json --authority <key>`: `SETTLED` means
it finished that settlement itself; `DISPATCHED` is a re-issued ticket to
fulfil as below.

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

Loop, **at most 3 × (number of graph nodes) iterations**, counted again from
zero after each acceptance review that settles `GAPS` (its reworked producers,
the verification nodes and the next review run in this same loop):

1. Run `M dispatch $0 --json --authority <key>` and read `status`.
2. If `status` is `DISPATCHED`, take the `ticket` and call the **Agent
   tool** with `subagent_type` set to `ticket.agent`
   (`mycelink:module-worker`), a short `description` naming
   `ticket.node_id`, and `prompt` set to `ticket.prompt` exactly. Do not
   add instructions to it and do not do the node's work yourself. A ticket
   with `kind: acceptance-review` is the review of Phase 6, not a node.
3. When the Agent returns, do not write, edit or remove anything at
   `ticket.result_slot`, in the worktree or in the evidence yourself: the
   result is the worker's own claim, and the plugin's fence refuses a
   controller's write there (a controller that rewrites a result forges the
   worker's criterion evidence). A worker that wrote none settles as its
   own failed attempt.

### Phase 5 — settle

4. Run `ticket.settle_command` exactly (it is
   `M settle $0 <node-id> --capability <capability> --json`). Settle
   re-verifies on a clean checkout, integrates, and marks the node DONE
   only if everything holds. Report its `outcome`, then continue the loop
   at step 1. `EVIDENCE_CORRECTION_REQUIRED` means only the result's
   criterion evidence was refused: the claim is held on the same commit and
   worktree, nothing was charged or integrated. Dispatch again (or
   `M dispatch $0 --resume <node-id> --json --authority <key>`): the
   correction ticket goes to a fresh module-worker. It names the criterion,
   its kind and the gate its evidence needs; a new behaviour no RED proved
   may be proved by a new RED cycle on the same worktree, and an answer
   RETRYABLE `CRITERION_UNPROVEN:<AC>` that changes nothing charges no
   attempt (corrections are bounded on their own). Never correct it
   yourself. `REVIEW_CHALLENGED` means the worker of an acceptance review's
   rework wrote the review gap's exact reproduction as a focused test and
   the red gate passed it on the unchanged head: the review's hypothesis
   is contradicted, which is review feedback, not a product failure. No
   attempt was charged, the node is DONE again on the work the review
   judged, the review is CHALLENGED, and `feature status` says
   `review-refine`: dispatch again at once — the next ticket is the
   review's refinement (Phase 6), handed out once nothing else is in
   flight and every node it does not decide has settled (a verification
   node the rework reopened runs again first, inside `dispatch`).
   `CRITERIA_SETTLED` means that worker answered each criterion of its
   order on its own: the criteria it proved DONE are integrated, one it
   challenged is refined next (`review-refine`; the node keeps what it
   proved), one it left BLOCKED or NEEDS_DECISION is ordered again alone
   and parked with its reason. One attempt for the execution, nothing
   failed: dispatch again.
   `CHALLENGE_REQUIRED` means that worker answered BLOCKED
   (`REVIEW_GAP_NOT_REPRODUCED`, or `INVALID_RED_EVIDENCE` with the
   behaviour already present) although its red gate passed every test it
   declared: nothing was charged and the claim is held; dispatch again, and
   give the re-issued ticket (its prompt opens with the challenge request)
   to a module-worker unchanged. `STALE_ORCHESTRATION_EPOCH` means the
   settle presented a dispatch that no longer counts — revoked by a resume,
   abandoned, replaced, or settled before the review moved on — or a result
   naming another `orchestration_epoch`: nothing was changed or charged and
   its result was archived; never retry it or re-dispatch for it, continue
   the loop at step 1. `PROVIDER_INTERRUPTED` means the model provider ended
   the worker or reviewer before it answered: nothing was charged; continue
   the loop at step 1 (dispatch hands it out again). `WORKER_RUNNING` means
   the worker's Agent task has not completed and its result slot is empty:
   nothing was settled or charged; wait for its completion notification, then
   run the same settle line (never dispatch it again meanwhile). `PROVIDER_UNAVAILABLE`
   from dispatch: stop and report it; a person clears it.
5. Any other `status` ends the loop; handle it below.

### Phase 6 — review

Once every product and verification node is DONE, and before any
candidate, `dispatch` hands out the independent acceptance review
(automatically, as part of this loop): a ticket with `kind:
acceptance-review`, `ticket.agent` `mycelink:acceptance-reviewer`, its
`review_id`, its own `ingest_command` and `settle_command`. Call the **Agent
tool** with `subagent_type` `mycelink:acceptance-reviewer`, `description`
"acceptance review <ticket.review_id>", and `prompt` set to `ticket.prompt`
exactly; add nothing to it. The reviewer is a separate, read-only session:
it reads the packet and the checkouts and returns one JSON verdict — its
final answer, or written to `ticket.result_slot`. For every reviewer ticket
the order is: the Agent tool, then `ticket.await_command` (until it no longer
answers `RUNNING`), then `ticket.ingest_command`, then `ticket.settle_command`.
It usually runs in the background, for minutes. Once the Agent call is made, run
`ticket.await_command` exactly: it waits while the reviewer runs (up to 90 s
a run) and says what comes next. `RUNNING`: run it again, as often as it
takes — never settle, correct or relaunch the reviewer while it runs (the
fence refuses a second reviewer for one generation; Claude Code records its
completion whether its notification reaches you as a turn of its own or
while you are busy). `COMPLETED`: run `ticket.ingest_command` exactly, then
`ticket.settle_command` exactly, then continue the loop at Phase 4 step 1.
`COMPLETED_NO_OUTPUT` (it answered nothing): settle; a fresh reviewer
follows. `TIMED_OUT` (it ran past its wall-clock, 20 minutes from its launch
unless `acceptance_review.reviewer_timeout_seconds` says otherwise) or
`LOST` (its task or session ended before it completed): the generation is
interrupted with nothing spent — stop it with TaskStop if it still runs —
and the next `dispatch` hands a fresh generation of the same review out.
`MISSING`: launch it. Do this for every reviewer ticket alike: a review, a
format correction (`ticket.correction`) and a refinement
(`ticket.refinement`). Ingest takes the reviewer's final answer as its
verdict when it wrote none — proved from Claude Code's own record of the
Agent call you made, never from anything you say — so a reviewer that
answered its JSON without a Write costs no correction. It answers
`INGESTED`, `ALREADY_INGESTED` or `WRITTEN` (the reviewer wrote its file):
settle. `REVIEWER_RUNNING`: the reviewer has not completed; nothing was
written or spent — run the await line again; never settle before. A settle
run too early answers `REVIEWER_RUNNING` too (no reviewer launched:
`REVIEWER_NOT_LAUNCHED`) and changes nothing; `REVIEWER_INTERRUPTED` means
the generation was interrupted as above: dispatch again.
`REVIEW_RESULT_INVALID` (its answer was not exactly one JSON object, kept as
its output) and `REVIEW_OUTPUT_CONFLICT` (it wrote one verdict and answered
another): settle anyway; they are refused for their form and the next
generation corrects them. Any other code: nothing was written; settle, which
refuses a generation that left no verdict. Never write, paste or copy the
reviewer's answer or verdict anywhere yourself, never edit or change the
verdict, the packet or anything under the review's directory, and never
answer a review in the reviewer's place: the plugin's fence refuses it, and
settle refuses a verdict the reviewer did not write or answer.

- `PASS`: the receipt binds the repository heads, the graph and the
  approved criteria; the next `dispatch` builds the candidate.
- `GAPS`: in the same settle, the controller has already reworked every
  product node a gap's criterion belongs to (the graph decides which; the
  reviewer's naming is advisory), each with the reviewer's public
  reproduction of its own gaps as its rework reason, and reopened what
  depends on them once. Dispatch again at once — the next `dispatch` is a
  worker ticket: fresh module-workers write the focused failing test for a
  new behaviour's gap first, then the fix, and close a compatibility gap
  with its regression test alone (a compatibility-regression unit); the
  verification nodes and the review run again on the repaired heads. Each
  criterion has its own budget: `max_rounds` accepted reworks per criterion
  (`acceptance_review` in `mycelink.config.json`, default 2) on newness
  alone, then more on the producers' verified progress up to its
  `criterion_ceiling` (default 6), where a person decides. A
  gap spends its criterion's budget only when its reproduction is materially
  new and a producer is reworked for it; a completed proof lost from the
  reviewed head is restored and spends nothing; a challenged and withdrawn gap, a
  format correction, a provider retry or a stale verdict spends nothing.
  `M review status $0` and `M feature status $0` give each criterion's
  budget left and its next action.
- `REPEATED`: the review found only repeats of earlier reproductions
  (compared by their normalized fingerprint, not their wording): nothing was
  reworked and no budget spent. Dispatch again: the next review is handed
  every earlier finding and what came of it, and asked only for what none
  of them covers.
- `REVIEW_INVALID` (with a `code` and, for a verdict refused for its form,
  its `problems`, each at a JSON pointer): dispatch again. A verdict that
  was malformed, incomplete, untraced or bound to another review is mended
  by the next generation of the same review: its `ticket.correction` names
  the refused verdict and every problem, and its prompt asks the reviewer to
  fix exactly those fields and keep its judgements (at most
  3 format corrections, none of them a review-rework round). A
  generation that left no verdict to correct (none written, one not
  attested) gets a fresh reviewer, twice at most. Past either, the feature stops `BLOCKED` with
  `REVIEW_INVALID`. Over-long prose in a verdict is never refused: settle
  cuts it at its bound and the receipt records the original.
- `REVIEW_GAPS`: a criterion exhausted its own budget with a materially new
  gap, or (in a graph from before every criterion had a product producer) a
  gap has no product node to rework — the other gaps are reworked all the
  same, and an exhausted criterion blocks once they have settled: the
  feature stops `BLOCKED`. Report each gap and the exhausted criteria;
  never cut a candidate around them.
- `REVIEW_NONCONVERGENT`: four reviews in a row made no progress (no
  producer change, no new criterion proof, no accepted new gap, no valid
  challenge), or eight review sessions were spent since the last accepted
  delivery: the feature stops `BLOCKED` with its lineage. Report it.

A refinement ticket is a reviewer ticket like any other (`kind:
acceptance-review`, `mycelink:acceptance-reviewer`, its `ingest_command` and
`settle_command`)
whose `ticket.refinement` names the challenged gaps it decides: after a
worker's valid challenge, a fresh reviewer reads the review it refines and
the challenge's tests, results and traces, and decides each gap — WITHDRAW,
REFINE (a materially different reproduction) or UPHOLD (why the challenge's
assertions miss the clause, and a corrected reproduction). Run it exactly as
a review: the Agent tool with `ticket.prompt`, then its ingest line, then its
settle line, then dispatch again. Its settle answers `PASS` (every gap withdrawn, nothing
else left), `GAPS` (the refined or upheld gaps reworked anew, from the
attempt base the challenge restored; the review's other gaps stand), or
`WITHDRAWN` (every gap withdrawn but the heads moved: a new review
follows). A refinement repeating the challenged reproduction is refused for
its form and corrected like any verdict. After two challenge-refinement
rounds of one gap, a third challenge stops the feature `BLOCKED` with
`REVIEW_DISPUTE` and every round's evidence: the node stays DONE; report it
for a person's decision.

`M review status $0` shows the review, its rounds and its receipts.

### Phase 7 — candidate

The candidate build and any verification node in the graph run inside
`dispatch` (a verification node runs existing tests on the integrated head
and has no worker; its failure stops the loop with `CONTROLLER_FAILED`);
`ALL_SETTLED` means every node is DONE and a review PASS binds them. If
`M feature status $0` shows no current candidate (a graph without a
candidate-build node), cut one with `M candidate create $0 --authority <key>`;
it is refused (`REVIEW_REQUIRED`, `REVIEW_STALE`) without a current review
PASS. A candidate binds every registered repository at its exact
integration SHA.

### Phase 8 — deliver

Run `M feature verify $0` and `M candidate verify $0`; if both exit 0, run
`M deliver $0 --json --authority <key>` and report the delivered SHAs and
acceptance evidence. If the task names an acceptance suite of its own, run
it now on the delivered commits.

The run is complete only when `M feature verify $0 --delivered --json` exits
0: every node DONE, the current candidate delivered and accepted. Never
report success, or end the session as if the feature were done, before that.
If it does not pass, continue the loop; if a stop reason below ends it,
report the remaining problems it lists as an unfinished run.

An unfinished run is not over. `M feature status $0 --json` says what comes
next: `next_action` (`dispatch`, `await-worker` — a worker you dispatched
holds a live lease: wait for its Agent's completion notification and
settle its ticket; nothing is reviewed or cut past a live lease —
`await-reviewer` — the acceptance reviewer launched for the open review
generation still runs (`next_action.reviewer` gives its task and agent by
hash and how long it ran of its wall-clock): run the ticket's await line
(without the ticket: `M review await $0 --review <id> --json`, then
`dispatch`), never relaunch it — `reconcile` — a lease's holder left you a
result to settle or a hold to re-issue, or is gone (a reviewer that ran
past its wall-clock or whose session ended included): reconcile, then
`dispatch` or `dispatch --resume <node-id>` — `review-refine` — a fresh
reviewer refines a challenged gap, which `dispatch` hands out — or `deliver`, with the exact
node — its state, rework generation, attempts used of that generation's
allowance and the last refusal — and the command) and `resumable`. Never
end the session while `next_action` is `await-worker`, `await-reviewer` or
`reconcile`: a lease you leave live is one nobody settles. While
`resumable` is true and you can still act, act: a settle that answered
`TDD_HISTORY_INVALID` charged one attempt and left the node READY on a fresh
branch, and the next `dispatch` hands it to a fresh module-worker told why.
A session that ends anyway leaves the feature incomplete but resumable, and
the next host invocation continues it with `/mycelink:run $0` (recover the
key, reconcile, dispatch); nothing done is lost. Only `resumable: false`
(`next_action.kind` `decision` — a parked node, a rework generation whose
attempts are spent — or `stopped`) needs a person: report it.

## Repair inside the same feature

When a check after a node was DONE fails — fresh verification of a
dependent, the E2E, `deliver` acceptance (`ACCEPTANCE_FAILED`) or the
product's own acceptance suite on the delivered commits — repair it in
**this** feature. Never create a new or follow-up feature id, and do not
cancel this one to start over.

1. Attribute the failure to the producer node that owns the failing
   behaviour (use the `integration-failure-attribution` skill; name the
   failing test, file or contract).
2. `M node rework $0 <node-id> --reason "<failing check, the exact input and expected vs actual result, and why this node owns it>" [--acceptance <AC-id,...>] [--evidence <relative-path,...>] --json --authority <key>`
   The reason is the worker's only description of the defect (its own
   suite was green when the work was found wrong), so state the failing
   check precisely: for example "POST refund with a 201-char reason returned
   202 instead of 400 VALIDATION_FAILED (AC-4); validation lives in
   src/orders.mjs". It must be at most 2000 bytes, without control
   characters, and never contain your controller key (`REWORK_REASON_*`).
   The controller stores it as the node's rework brief and hands it to the
   node's next workers inside their context pack, as data.
   It reopens that node and everything downstream of it (candidate build
   and E2E included), keeps the node's attempts, failures and evidence as
   history, archives its old branch and makes the current candidate stale.
   When the feature was already delivered and someone has since committed
   on a delivered base branch (on top of the delivery, as a teammate's
   change QA reports on would be), the rework adopts that base: the report
   names it in `adopted_bases`, the node starts again from the base as it
   is now, and the new candidate delivers on top of it.
   If it names a parked node (`REWORK_PARKED`), ask the user, record the
   decision, and pass `--decision <id>`. Repeating the same rework changes
   nothing.
3. Go back to Phase 4 **in this same feature**. The node is dispatched from
   the current integration state with the rework brief in its ticket
   (`rework`) and prompt; its worker writes a focused failing regression
   test from the brief first, and settle fences only the repair. Then a new
   review runs on the repair, a new candidate binds every repository and Phase 8 delivers it.

Each approved rework is a generation with its own attempt allowance (the
node's `max_attempts`); lifetime attempts and failure fingerprints carry on.
A worker that reports `INVALID_RED_EVIDENCE` inside a rework is a recorded,
retryable failure: keep dispatching. The same failure twice parks the node
BLOCKED, and the number of reworks per node between accepted deliveries is
bounded (`REWORK_LIMIT`; an accepted delivery starts the count again).

A rework is refused, with nothing changed, when work is still in flight
(`REWORK_IN_FLIGHT`: settle or reconcile first), when the node's rework
limit is spent (`REWORK_LIMIT`), when its reason or references are unusable
(`REWORK_REASON_TOO_LONG`, `REWORK_REASON_INVALID`, `REWORK_REASON_UNSAFE`,
`REWORK_REFERENCE_INVALID`: fix the reason and retry), or when a delivered
base branch no longer holds the delivery (`REWORK_BASE_MOVED`: its history
was rewritten). Report the others to the user; do not work around them,
never bypass the controller, and never start a new feature instead.

## A defect QA reports after the delivery

QA may report failing checks on a delivered commit after the run ended, to
a new session. Repair it in this feature, as above, and as the controller:
**do not edit or commit product code in this session yourself** — no Write
or Edit of a registered repository's files, no `git commit`, `revert`,
`cherry-pick`, `apply` or `checkout -- <path>` there. Product code is the
module-worker's, and so is a ticket's `result_slot`.

Start with `/mycelink:rework $0` and QA's report: it is this procedure as a
controller-only command. Its one-step attribution is
`M feature rework $0 --since-delivery [<repository>:<path>...] [--acceptance <AC-id,...>] --reason "<QA's failing checks as reported>" --json --authority <key>`,
which reworks the producer node of what changed since the delivery (or the
single producer of the named acceptance criteria); when it answers
`REWORK_OWNER_AMBIGUOUS` or `REWORK_OWNER_UNKNOWN`, use steps 2 and 3.

1. A new session recovers the key first (`M controller open --recover
   --json`), then runs `M feature status $0 --json`.
2. Attribute QA's failing checks to the producer node that owns the failing
   behaviour: `M feature owners $0 [<repository>:<path>...] [--acceptance
   <AC-id,...>] --since-delivery --json` names the producer nodes owning
   what changed on a delivered base since the delivery (the commits QA's
   report may be about), the paths the failing checks exercise and the
   acceptance criteria they name (a check called `ac2_...` or `AC-2 ...`
   exercises AC-2), and what reworking each reopens. Rework the node that
   owns the failing behaviour, never the candidate build; its dependents
   reopen with it.
3. `M node rework $0 <node-id> --reason "<QA's failing checks as reported: each check and its message>" --json --authority <key>`
   (at most 2000 bytes; nothing but what QA reported).
4. Phases 4 to 8: dispatch the reopened nodes to the module-worker subagent
   and settle each, then cut the new candidate and deliver it with
   `M deliver $0 --json --authority <key>`.
5. You are done only when `M feature verify $0 --delivered --json` exits 0.

## Stop reasons

- `ALL_SETTLED` — continue with Phase 7 and Phase 8.
- `SETTLED` — `dispatch --resume` finished an interrupted settle itself
  (`settled` is its report); continue the loop at step 1.
- `WAITING` — a dispatched node was not settled. If its Agent is still
  running in this session (`feature status` says `await-worker`), wait for
  its completion notification and settle its ticket; no review or
  refinement is handed out past a live lease. After an interrupted turn, run
  `M session reconcile $0 --json --authority <key>`; for each
  `pending_dispatches` entry run
  `M dispatch $0 --resume <node-id> --json --authority <key>`: on `SETTLED`
  continue the loop; on `DISPATCHED` fulfil the re-issued ticket and settle
  it. Resume a node at most twice; after that, report it. A `pending_review`
  is the acceptance review with its reviewer: a verdict already in its slot
  is settled by the next `dispatch` (no reviewer runs again); a reviewer
  still running (`await-reviewer`, `REVIEWER_RUNNING`) is waited for with
  its await line, never re-issued; otherwise
  `M dispatch $0 --resume <review_id> --json --authority <key>` hands it to a
  fresh reviewer (Phase 6).
- `NEEDS_DECISION` — read `features/$0/DECISIONS.md`, ask the user with
  AskUserQuestion, `M decision record $0 <id> --answer "..." --authority <key>`,
  then `M decision apply $0 <id> --authority <key>`, then continue. Never
  answer it yourself.
- `BLOCKED` — report the node, its repeated failure fingerprint, the
  commands and exit codes, and the nearest reproducible test layer. Do not
  retry it with another agent and do not try to unblock it yourself.
  `REVIEW_GAPS`, `REVIEW_INVALID`, `REVIEW_NONCONVERGENT` or
  `REVIEW_LINEAGE_INVALID` in the detail: the acceptance review stopped the
  feature before any candidate (a criterion past its own rework budget, no
  verdict it could take, a review that cannot converge, or a lineage changed
  outside Mycelink). Report the review
  (`M review status $0`): each gap and its reproduction. Only the user's
  recorded decision (`node rework ... --decision <id>`) continues past it.
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
  dispatch again; otherwise report them to the user. `WORKTREE_SETUP_FAILED`:
  the repository's `worktree_setup` (repositories.yaml) did not complete in
  a new worktree, or a fresh verification checkout; the detail names its
  log and receipt, and no worker ran. Fix the cause and dispatch again (a
  held settlement is finished then); do not install dependencies in a
  worktree yourself or edit `repositories.yaml` to skip the setup.
  `GRAPH_DRIFT`: the graph was edited after `feature init`; restore it.
- `CONTROLLER_FAILED` — a controller node ran and failed. Report its
  detail; do not edit controller files to make it pass. If the E2E failed
  and attributed a producer node, that node is already reopened: dispatch
  again.

If the loop limit is reached, stop and report the last dispatch output.

Report completed nodes, the current node, any stop reason and real evidence
paths — nothing else. `orchestrate run` is the optional standalone CLI
adapter for use outside Claude Code; it is not part of this command.
