# Changelog

All notable changes to Mycelink are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the major
version is 0, minor releases may contain breaking changes; they are called out
under **Breaking**.

## [Unreleased]

## [0.3.0-beta.1]

Second public beta. Real worker sessions can now run their nodes (in
0.2.0-beta.1 they could not read their brief or write their result), the
plugin drives every node through host dispatch and settle, an independent
read-only reviewer judges every acceptance criterion before any candidate,
and evidence, rework and recovery were hardened against what a
public-project benchmark found.

**Highlights**

- Real worker sessions start their nodes: the brief arrives on stdin and
  the result is captured from the worker's worktree by atomic rename into a
  controller-owned quarantine (*Fixed*, *Security*).
- Host-native dispatch is the plugin's primary path: `/mycelink:run` loops
  `mycelink dispatch`, the `module-worker` subagent and `mycelink settle`,
  then `mycelink deliver` fast-forwards every base branch to the verified
  candidate. Mycelink never pushes.
- Controller-only commands need the controller key from `mycelink
  controller open`; worker commands need their claim's capability. A
  plugin hook fences what the controller and the workers may write.
- Settle verifies every node's history test-first from the repository, and
  the red gate judges what a RED proves.
- An independent, read-only acceptance review runs before any candidate,
  with per-criterion budgets, gap challenges and refinements, and a
  hash-chained lineage (*Breaking*).
- A defect QA reports after a delivery is repaired inside the feature:
  `feature rework`, `node rework` and `/mycelink:rework`.
- Worktree setup, verification nodes, module-scoped verification and
  per-criterion evidence.
- Recovery that charges no product attempt: interrupted settles, model
  provider failures, workers and reviewers still running, and answers from
  a superseded orchestration epoch.
- Gate evidence is content-addressed and immutable from creation.

**Upgrading from 0.2.0-beta.1**

- Update the plugin, then re-run `init` with a controller key for every
  control repository and check `doctor`, as *Update and uninstall* in the
  README describes, so the project hooks point at the new installation.
- Controller-only commands require `--authority <key>`; the plugin's
  commands open the key and pass it for you.
- Features initialised after the update require the acceptance review; a
  control repository opts out with `"acceptance_review": {"required":
  false}`. Features initialised before it keep no review.
- Run `mycelink evidence migrate <feature>` for evidence recorded with
  absolute output paths.
- Custom worker agents or skills that read `$MYCELINK_CONTEXT_PACK` or write
  `$MYCELINK_RESULT_PATH` must follow the bundled `module-worker` agent;
  those variables are no longer set.
- Graph validation is stricter; see *Breaking*.

**Evaluation and its limits**

The public-project benchmark (`evals-public-projects/`: six change requests
on frozen copies of spring-petclinic-microservices and changesets) is in the
repository, not in the release archive. With the plugin, all 12 cells of
its six-PRD × normal/fault matrix were delivered and verified by an
independent verifier. That shows each cell *can* be delivered; it is not a
success rate. One verified run is reported per cell, and 19 of the 54
with-plugin runs were verified; only the six Petclinic arms ran on the
final suite commit; the final matrix has no without-plugin baseline; and
one cell has no run record. The report, with all of its limitations and
how to re-check it, is
`docs/evals/2026-10-12-public-project-final-matrix.md` in the repository.
It makes no cost, latency or uplift claim.

### Breaking

- **Independent acceptance review before any candidate.** Once every
  product and verification node is DONE, `dispatch` hands out an
  acceptance-review ticket (`kind: acceptance-review`) for the bundled,
  read-only `mycelink:acceptance-reviewer` subagent, a session of its own:
  a packet with the approved criteria verbatim (kinds, hashes, material
  clauses), the graph's ownership, a checkout and diff of every reviewed
  head, and the workers' criterion evidence and gate outputs. It answers one
  strict JSON verdict per criterion (PASS/GAP, evidence ids, the public
  reproduction of a gap, its producer, confidence), bound to the review,
  its generation and the inputs' hash. Its form, coverage (every clause of
  a PASS traced to a test and an assertion location, the boundaries of a
  new behaviour covered, regression evidence for compatibility) and
  bindings are checked mechanically; the plugin's fence attests the
  reviewer's verdict Write and refuses every other write it makes (no
  Edit, shell or subagent). A GAP reworks the producer the graph names with
  the reproduction as its reason (the reworked node's other criteria keep
  their proof, `rework.carried_criteria`); the review runs again; at most
  `acceptance_review.max_rounds` (default 2, 1..5) review-reworks, then
  `REVIEW_GAPS` blocks the feature. Two refused verdicts block it with
  `REVIEW_INVALID`. `candidate create`, the candidate build, `feature
  verify`, `candidate verify` and `deliver` require a PASS receipt bound
  to the current repository heads, graph and criteria (`REVIEW_REQUIRED`,
  `REVIEW_STALE`, `REVIEW_RECEIPT_TAMPERED`, `REVIEW_NOT_FOR_CANDIDATE`);
  `orchestrate run` stops with `REVIEW_REQUIRED`. New: `review status`,
  `review settle --review <id> --capability <c>`, `dispatch --resume
  <review_id>`, reconcile's `pending_review`, `/mycelink:run` Phase 6. A
  control repository opts out with `"acceptance_review": {"required":
  false}`; features initialised before this keep no review. From CSET-203
  r2, where every node settled DONE on criterion evidence that pointed at a
  rollback test of one failure boundary, and hidden acceptance failed AC-1
  at another (a changelog that cannot be written).
- `node rework` archives the replaced work's evidence outputs under
  `evidence/<node>/replaced/g<n>/` and points its history there.

- **Every criterion has a product producer.** `graph validate` refuses a
  criterion that no product node serves (`CRITERION_NO_PRODUCER`), and any
  criterion a verification node carries without an upstream producer
  (`VERIFICATION_CRITERION_UNOWNED`). A review's gaps are mapped to the
  graph's producers of their criteria (the reviewer's node id decides
  nothing), and settle records the review and every planned rework in one
  STATE.json write under the delivery lock; an unowned or refused gap
  blocks in that write without dropping the others. A compatibility gap is
  answered by a compatibility-regression unit: trailing test-only commits
  with the trailer `Mycelink-Compatibility: <AC>`. From CSET-203 r3, where
  a gap owned only by the verification node reworked nothing and blocked
  the feature.

- **Verification nodes.** `node_type: verification` proves criteria by
  existing tests without a worker: `dispatch` runs it itself, after every
  producer of its repository, in a fresh set-up checkout of the integrated
  head, with allowlisted commands only (module verifiers checked for
  drift, repository commands checked again at run time), and records one
  receipt binding the head, modules and plans, the setup's config and
  receipt, every output and the canonical id of every test that passed; its
  compatibility criteria are evidenced by that receipt. No claim capability,
  worktree, branch, commit or history; a failing command is a retryable
  verification failure; a controller that died mid-run is handed back
  (`interrupted_controller_runs`) and the run repeated. `graph validate`
  refuses a worker node with a repository and no `allowed_paths`
  (`WORKER_NODE_CHANGES_NOTHING`) and holds verification nodes to their
  shape (`VERIFICATION_NODE_WRITES`, `VERIFICATION_NEEDS_REPOSITORY`,
  `VERIFICATION_EVIDENCE`, `VERIFICATION_DEPENDENCY_MISSING`,
  `VERIFICATION_NOT_BEFORE_CANDIDATE`, `VERIFICATION_CRITERION_UNOWNED`).
  From CSET-203 r1 with-faults, whose compatibility node was a worker that
  could only submit nothing and blocked on `NO_DECLARATION_COMMIT`.
- **Evidence correction cycles.** A held submission names the criterion,
  its kind and the gate its evidence needs; for a new behaviour no RED
  proved, the correction may add one RED cycle on top of the held commit
  (its gates open again; settle judges the whole history; rewriting the
  held commit is `CORRECTION_HISTORY_REWRITTEN`). A correction that changes
  nothing and gives up (`RETRYABLE`, e.g. `CRITERION_UNPROVEN:<AC>`) charges
  no attempt: the held submission is restored and one of the bounded
  corrections is spent. Reconcile lists a held claim with `settlement:
  "correction"`. Every worker brief opens with its criteria (exact text as
  data, kind, evidence rule), and `mycelink tdd check` judges a result's
  criterion evidence as settle will before it is submitted. From CSET-203
  r1 with-normal, where AC-4's correction was charged twice and blocked.

- **Acceptance criteria are exact, kinded and named by canonical test
  ids.** `feature acceptance` writes `features/<f>/ACCEPTANCE.json` from the
  approved requirement verbatim (or its structured sidecar): each
  criterion's exact text, kind (`new-behavior`, `compatibility`,
  `declaration`) and hashes. `graph validate` refuses a criterion that is
  summarised, of another kind, missing or invented; `feature init` binds
  the manifest, and claims, tickets and context packs carry each
  criterion's exact text, kind and hash. Every gate publishes the canonical
  ids of the tests it ran; criterion evidence names a test by `test_id` (a
  legacy path and name count only when they name exactly one bound test),
  and `tdd tests` finds a test a bound gate ran by its words. Evidence is
  checked per kind; an unknown or ambiguous test id holds the claim for
  correction (`EVIDENCE_CORRECTION_REQUIRED`) with nothing charged. `node
  discard` hands back a dispatch the controller reached into, unspent.

- **Module-scoped verification.** `repositories.yaml` may declare
  `modules` (and `module_defaults`): per module its path, whether it has
  runtime tests, and shell-free setup/build/test argv with the
  `${MODULE_PATH}`, `${MODULE_ID}` and `${REPORT}` placeholders and a
  structured report (`vitest-json`, `junit-xml`). `mycelink repo modules`
  prints the allowlist and each module's verifier. For such a repository,
  `graph validate` requires a node that owns a module to verify first with
  that module's verifier, `{ id, module, module_sha256, command }`
  (`UNSCOPED_VERIFICATION`, `MODULE_VERIFIER_REQUIRED`,
  `COMMAND_NOT_ALLOWLISTED`, `MODULE_COMMAND_MISMATCH`, `MODULE_DRIFT`,
  `MODULE_SPAN`, `MODULE_NOT_OWNED`, `UNKNOWN_MODULE`). The claim binds the
  module's command and hash: red and green run only that module's tests,
  regression, the candidate and delivery acceptance the full suite; the
  gates refuse `-- <command>` and `--cwd` (`GATE_COMMAND_BOUND`), dispatch
  stops on a changed descriptor (`MODULE_DRIFT`), and settle refuses gate
  evidence run with another module (`MODULE_BINDING_MISMATCH`). Evidence,
  setup receipts and settlements record `module`, `module_sha256` and the
  plan hash. From CSET-202 r1 with-faults, where the reworked errors node's
  whole-suite RED was poisoned by the cli tests already in its base.
- **Criterion evidence.** A worker's result names, per acceptance
  criterion of its node, the test that proves it, the gate that ran it and
  that gate's output hash (`criterion_evidence`). Settle checks it against
  the repository and the recorded evidence before integration (missing,
  repeated, other-node, outside-module, undeclared, unbound or not-run
  items are refused, `CRITERION_EVIDENCE_INVALID:<code>`); a criterion's
  `kind` is `behaviour` (proved by a RED) or `compatibility` (any gate).
  `candidate verify`, `feature verify` and `deliver` refuse a feature with a
  criterion no DONE node evidenced (`UNCOVERED_ACCEPTANCE_CRITERION`). From
  CSET-202 r1 with-normal, where four nodes settled on their own suites
  while hidden acceptance found three criteria unmet.
- **The red gate judges what a RED proves**, as the benchmark's replay does
  (`src/evidence/red-classify.ts`, in parity with
  `evals-public-projects/lib/results.mjs`). It reads the tests the RED
  declares (its test-side delta since the cycle began) and refuses one that
  fails for a syntax, compile, import or missing-symbol reason
  (`TypeError: X is not a constructor`, a missing export), a failed setup
  step, a declared test that did not run, no declared test at all
  (`no-test`), a timeout, or declared tests that all pass (a passing,
  unchanged test beside a failing one is accepted, as the replay does); a
  nonzero exit alone is never a RED.
  Without a structured report, conservative output patterns decide, and an
  expected domain exception from the code under test counts as a missing
  behaviour, never as setup. The refusal (`RED_INVALID:<category>`) says to
  change the test, not production code; evidence keeps `red_category`,
  `red_fingerprint` and `red_detail`. From CSET-202 r1, where core accepted
  the errors node's missing-symbol RED that the replay rejected.
- **A node with no red gate is declaration-only** (unless it is a
  `refactor`): settle accepts its history only as production-only
  commits, at least one, inside the declaration paths its claim binds
  (`DECLARATION_PATHS_UNBOUND`, `NOT_DECLARATION_ONLY`,
  `NO_DECLARATION_COMMIT`). Its GREEN no longer needs a RED first.
- **A graph is immutable after `feature init`.** `dispatch`, `node claim`
  and `dispatch --resume` refuse a graph that no longer hashes to the one
  STATE.json was initialised for (`PRECONDITION_FAILED`, `GRAPH_DRIFT`),
  before anything is claimed or set up.
- `repo register` of an existing name keeps what is not passed
  (`worktree_setup`, `tdd`, role, other commands) and refuses a second
  name for an already registered path.

### Added

- **A model provider's failure is infrastructure, never the product's
  (CSET-203 r10).** A session's failure is classified from Claude Code's
  own top-level records (a transient provider refusal, rate limit, server
  or network error; authentication; a context or turn limit; or the
  product), never from the model's text. A lease whose holder ended on a
  transient provider failure is closed `interrupted-provider`: without
  progress the node is READY again with its attempt refunded; with commits
  or gates the claim is kept and resumed under a rotated capability; a
  review, correction or refinement generation is re-issued with nothing
  spent. Settle and ingest answer `PROVIDER_INTERRUPTED`, and `session
  provider-interrupt` reconciles on request. Past two per ticket or four per
  phase the feature stops `PROVIDER_UNAVAILABLE` (`session provider-reset`
  clears it); no node is BLOCKED for it.

- **Review-gap challenges and refinements.** In an acceptance review's
  rework, a module-worker whose exact focused test of the review's
  reproduction passes on the unchanged integrated head (the red gate: "the
  RED does not fail") no longer answers BLOCKED: it submits a structured
  `REVIEW_GAP_CHALLENGE` (`tdd challenge` prints what it binds; `tdd check`
  judges it). Settle checks the current claim, the exact rework reason and
  the review's pinned receipt, each gap's reproduction hash, the red gate's
  output (its declared tests all passed on the claim's base, which holds the
  reviewed work), tests added only, no production change (a test-only
  challenge commit is kept under its own ref, never integrated) and every
  challenged clause traced to a concrete assertion inside a passing focused
  test. A valid challenge charges no attempt: its evidence is archived under
  `features/<f>/reviews/challenges/`, the node is DONE again on the
  generation the rework replaced, the review CHALLENGED, and `feature
  status` says `review-refine`: the next `dispatch` hands a fresh reviewer
  the refinement (`ticket.refinement`), which WITHDRAWs (the challenge's
  evidence traced as a PASS), REFINEs or UPHOLDs each gap with a materially
  different reproduction (a repeated one is refused,
  `REVIEW_REFINEMENT_REPEATED`); a refined gap is reworked anew from the
  original attempt base. Two challenge-refinement rounds per gap; a third
  blocks the review `REVIEW_DISPUTE` with its evidence, the node DONE.
  r6's own BLOCKED `REVIEW_GAP_NOT_REPRODUCED` is refused as an unstructured
  challenge (a failed attempt), never a parked node.
- **The plugin's controller/worker fence.** The plugin ships one PreToolUse
  hook (`hooks/hooks.json`) for Write, Edit, MultiEdit, NotebookEdit and
  Bash. The controller (the main thread, or any subagent that is not
  `mycelink:module-worker`) may read anything and run Mycelink's CLI, but
  never writes a registered repository, a worker worktree or result slot,
  Mycelink's scratch area or a feature's evidence, state or approved
  criteria, however a shell command spells it, and never runs a worker's
  gate. A module-worker writes only its worktree and result slot and never
  settles, dispatches or delivers. Inside a Mycelink workspace the hook
  fails closed on input it cannot read or parse. The controller no longer
  writes a missing worker result: a worker that wrote none settles as its
  own failed attempt. From CSET-202 r2, where the controller rewrote
  module-workers' result files and a node settled on forged evidence.

- **Worktree setup inputs.** `worktree_setup.inputs` names the tracked
  files a setup installs from (a lockfile, workspace and package
  manifests). The receipt binds their content; a gate that finds them
  changed in its worktree runs the same setup there first (refused with
  `WORKTREE_SETUP_FAILED` when it fails, nothing run or recorded), and the
  claim binds the new receipt. With inputs declared, a receipt survives a
  commit that changed none of them (`INPUTS_CHANGED` otherwise); gate
  evidence records `setup_inputs_sha256`. A worker declares a dependency on
  another of the repository's own packages instead of importing its sources
  by path; it never runs an install. The generated Changesets manifest
  declares `pnpm-lock.yaml`, `pnpm-workspace.yaml` and every
  `package.json`. From CSET-202 r1 with-normal, where the read node could
  not link `@changesets/errors` and broke the error class's identity.
- **Regression deferral to dependents.** A module-bound node's full-suite
  regression that fails only in test files its dependents own is recorded
  as deferred to them (`regression_deferred`), not as the producer's
  failure; the producer settles, its dependents reopen and re-verify on the
  new integration, and the candidate still requires the full suite
  (`REGRESSION_DEFERRED` until they have). Any other failure stays the
  node's (`REGRESSION_NOT_DEFERRED`).
- **Generated benchmark manifests declare modules**: Changesets' modules
  (types as declarations) verify with `pnpm build`, the tolerated rewrite
  restored, then `pnpm vitest run` on the module with a JSON report;
  Petclinic's with `./mvnw -pl <module> test` and its Surefire reports.

- **Worktree setup.** `repositories.yaml` may declare `worktree_setup`
  (argv commands, timeout, `env` with `${HOME}`/`${WORKTREE}`/`${TMPDIR}`
  placeholders, `required_paths`; `repo register --worktree-setup`). The
  controller runs it in every worktree it creates — a worker's before its
  ticket, a fresh verification's, delivery acceptance's — with a hardened
  environment, and refuses a setup that changes tracked files, leaves
  untracked output, moves HEAD, changes git configuration or hooks, or
  links out of the worktree. A receipt binds worktree, commit and
  configuration; a resume reuses it only while all three and the required
  paths hold. A failed setup is `PRECONDITION_FAILED`
  (`WORKTREE_SETUP_FAILED`) with its log: no worker, no attempt, no
  interruption, no usage; a settlement whose fresh checkout cannot be set
  up is held and finished by the next dispatch. Claims, tickets, context
  packs, gate and fresh evidence, settlement receipts and delivery
  acceptance records carry the setup's hashes. From the CSET-201 pilot,
  where every node worktree lacked the base checkout's node_modules.

- **Host-native execution is the plugin's primary path.** `/mycelink:run`
  now loops `mycelink dispatch` → the host's Agent tool with the
  `module-worker` subagent → `mycelink settle`, then `mycelink deliver`.
  It no longer runs `orchestrate run`, which spawns a nested `claude` that
  could not start in the 2026-10-06 eval sandbox. `orchestrate run` remains
  as the standalone CLI adapter.
- Claims carry a random capability (only its SHA-256 is stored). `tdd`,
  `evidence record`, `node begin`, `node finalize` and `settle` require
  it (`--capability` or `MYCELINK_CLAIM_TOKEN`); controller-only commands
  refuse anyone presenting one. `node claim` now goes through the scheduler
  and prints the capability once.
- **Controller-only commands need positive controller authority.** Every
  command in the controller-only table (including `dispatch`, `deliver`,
  `session reconcile`, `decision record/apply`, `feature init`, `repo
  register` and `init` of an existing control repository) now requires
  `--authority <key>` from `mycelink controller open`. Omitting or unsetting
  a worker capability no longer grants controller access. The key is
  printed once and only its hash is stored. Once a key exists, a new one is
  minted only by presenting it (rotation, with no claim live) or by
  `--takeover` from an interactive terminal, so a worker that ends its own
  claim still cannot mint one. The plugin commands open and pass it for you.
- **A resumed dispatch revokes the previous worker's result authority.**
  Every host dispatch generation has a dispatch id and its own result file
  (`.mycelink-worker/result-<dispatch-id>.json`); results must carry
  `dispatch_id`. `dispatch --resume` captures and validates a result the old
  generation already wrote before rotating, and ignores anything it writes
  afterwards. Previously a stale worker could write SUBMITTED, BLOCKED,
  NEEDS_DECISION or RETRYABLE into the slot the resumed dispatch used.
- Leaving BLOCKED, NEEDS_DECISION or BUDGET_EXHAUSTED by any route
  (including INVALIDATED, PAUSED, EXCLUDED and re-running `feature init`)
  needs a decision recorded with `decision record`; the failure history is
  kept.
- Evidence `output_path` is stored relative to the control root; run
  `mycelink evidence migrate <feature>` for older absolute records.
- Candidates pin canonical content hashes of the control repository's
  semantic inputs instead of control HEAD (`CONTROL_INPUT_DRIFT`,
  `CONTROL_INPUT_MISSING`, `CONTROL_INPUT_ADDED`). Older candidates keep the
  strict HEAD check.
- Slash-command arguments are numbered from `$0`, as current Claude Code
  numbers them.

- Worker sessions receive their brief on stdin and write their result to
  `.mycelink-worker/result.json` in the worktree. Custom worker agents or
  skills that read `$MYCELINK_CONTEXT_PACK` or write `$MYCELINK_RESULT_PATH`
  must follow the bundled `module-worker` agent and `node-worker` skill
  instead; those variables are no longer set.
- A release candidate binds every registered repository (one the feature
  never touched is bound at its base on a new `feature/<id>` branch), and
  `candidate verify` and `deliver` refuse one that leaves a registered
  repository out (`REPOSITORY_NOT_BOUND`). Candidate control inputs are the
  global configuration plus the target feature's own files only.
- **Settle verifies every node's history test-first, mechanically.** In the
  second PCM-101 pilot a worker kept the prompt-only commit contract and
  still added a test-only commit after its production commit; the node was
  integrated and the independent replay rejected the delivery. Now the red
  gate refuses to run while production files differ from HEAD
  (`RED_NOT_TEST_ONLY`, nothing run or recorded) and binds the exact test
  files (path and blob) of every RED it accepts, and settle reads the
  node's base..head from the repository before anything is verified or
  integrated: every production change must follow test-only commits
  holding exactly what a red gate ran; no declared test may be added,
  changed or removed after production except in a new complete RED ->
  GREEN cycle. A refused history (`TDD_HISTORY_INVALID:<code>`:
  `TEST_AFTER`, `MIXED_COMMIT`, `NO_TEST_FIRST`, `RED_NOT_BOUND`,
  `CHANGED_RED_BLOBS`, `NO_DECLARED_TESTS`, `MERGE_IN_HISTORY`,
  `TDD_CLAIM_MISMATCH`) is never integrated, is kept as evidence with the
  attempt's logs, counts as a failed attempt (the same refusal twice parks
  the node), and the node is dispatched again on a fresh branch from the
  integration state with the reason in its pack. A SUBMITTED result must
  name exactly the branch head in `commit_sha`, and its optional `tdd`
  claim (base, head, per-cycle RED and GREEN commits) must match. Which
  paths are tests is a per-repository policy (`repo register
  --test-paths/--production-roots/--declaration-paths`, conservative JVM,
  JS/TS, Python, Go and .NET defaults), bound to each claim. A graph whose
  node cannot write its own tests (`allowed_paths` without them) can no
  longer settle a red-requiring node.
- **An interrupted settle is finished by a fresh host session.** In the
  second PCM-101 pilot the host session was killed while settle verified
  the gateway node; the node stayed REGRESSION_VERIFIED, and the resumed
  `claude -p` session had neither the controller key nor the ticket
  capability, asked a user who was not there, and exited 0 with the feature
  undelivered. Now: a controller key records the Claude Code session that
  opened it (CLAUDE_PID verified as an ancestor, with its start), and
  `controller open --recover` mints a new key once that session provably
  ended and no adapter worker or settle of it still runs; settle markers
  name the settling process by identity, so a pid reused in another PID
  namespace is not mistaken for it; settle seals the judged head before
  any transition; `dispatch` (and `dispatch --resume`, which answers the
  new status `SETTLED`) finishes a settlement whose result the controller
  holds, at any boundary, without the lost capability or a second worker
  run, counting usage and the run ledger once; `session reconcile` marks
  such dispatches `settlement: "held"`; `feature verify --delivered`
  passes only when every node is DONE and the current candidate is
  delivered and accepted, and the plugin's run/resume instructions report
  success only then. `dispatch --resume` of a dispatch whose result is
  already in hand no longer returns a ticket.

- `/mycelink:rework <feature-id> [QA report]`: the controller-only entry for
  a defect QA reports after the delivery. Before any product file is read it
  states that the session must not edit or commit product code, recovers the
  key, runs `feature status` and `feature rework`, then the host loop
  (dispatch, module-worker, settle) to a new candidate, `deliver`, and
  finishes only on `feature verify --delivered`. `/mycelink:run`,
  `/mycelink:resume` and the `host-dispatch` skill start QA's report there.
  `feature owners` and `feature rework` take a module directory
  (`<repository>:<dir>/`: the producers whose allowed paths lie in it), and
  `--since-delivery` no longer swallows a path written after it.
- `mycelink feature rework <feature> --reason <QA's report>
  [<repository>:<path>...] [--acceptance <AC-id,...>] [--since-delivery]`
  (controller): QA's report after a delivery, attributed and reworked in one
  step. It reworks the producer nodes owning the given paths and what changed
  on a delivered base since the delivery, or else the single producer of the
  named acceptance criteria, dependents first so each keeps the report as its
  brief. An ambiguous or unowned report is refused (`REWORK_OWNER_AMBIGUOUS`,
  `REWORK_OWNER_UNKNOWN`) with nothing changed; repeating it changes nothing.
- `REWORK_LIMIT` counts a node's reworks since the feature's last accepted
  delivery (whose manifest must still be the one acceptance pinned). In the
  PCM-103 pilot the task's controller reworked its producer node twice on its
  own review before C001; QA's report after C001 was accepted was then refused
  as a third rework, and the run ended with C001 stale.
- `mycelink feature owners <feature> [<repository>:<path>...] [--acceptance
  <AC-id,...>] [--since-delivery]` (read-only): the producer nodes that own a
  failure, for `node rework` — the nodes whose repository and allowed paths
  hold the given paths, whose acceptance criteria include the given ones,
  and with `--since-delivery` the owners of everything changed on a
  delivered base branch since the delivery — each with what reworking it
  reopens. `/mycelink:run`, `/mycelink:resume` and the `host-dispatch`
  skill now say what to do with a defect QA reports after the delivery:
  never edit or commit product code as the controller; recover the key,
  find the producer node, rework it with QA's failing checks as the reason,
  dispatch, settle, deliver a new candidate, and finish only once `feature
  verify --delivered` passes. In the fourth PCM-101 pilot the host
  reverted the defect and committed a test on main itself, leaving C001
  stale.
- `mycelink node rework <feature> <node> --reason <why> [--decision <id>]`
  (controller-only): repair a check that failed after a node was DONE inside
  the same feature. The node keeps its attempts and failure fingerprints,
  its replaced work is kept as `rework_history`, its dependents and every
  candidate-build/E2E node are reopened, the current candidate stops being
  current, and its branch is archived so it is re-dispatched from the
  current integration state. Refused while work is in flight, when a parked
  node would be reopened without a decision, past its rework limit, or when
  a delivered base moved past the integration branch.
- A rework's reason now reaches the worker. `node rework` stores it (with
  optional `--acceptance` and `--evidence` references) as the node's
  `rework_brief`: at most 2000 bytes, no control characters, redacted of
  credential shapes, refused if it holds the controller key, bound to the
  rework record by its SHA-256 and re-checked before every dispatch
  (`REWORK_BRIEF_INVALID`). Tickets carry it as `rework` and the context
  pack inside its data delimiters, and the worker prompt and skills require
  a focused failing regression test from it before any production change.
  Found by a real-model run where QA's "201-char reason accepted" never
  reached the worker, which saw its own green suite and parked the node.
- Each approved rework is a generation with its own allowance of
  `max_attempts` attempts, counted from the lifetime attempts at the rework;
  lifetime attempts, fingerprints and history are kept. A worker's
  `INVALID_RED_EVIDENCE` (BLOCKED or RETRYABLE) inside a rework is a recorded,
  retryable failure under one fingerprint, so the same mistake twice parks
  the node. `REWORK_BUDGET_EXHAUSTED` is gone; `REWORK_LIMIT` bounds reworks.
- `mycelink feature supersede <old> --by <new> --reason <why>`: an explicit,
  audited `superseded_by` for a feature at rest; a superseded feature never
  verifies as complete. The replacement must be usable (not superseded, not
  cancelled, its graph valid and unchanged since init:
  `SUPERSEDING_FEATURE_NOT_VIABLE`), never in a cycle, and both features'
  delivery locks are held while it is recorded.
- `/mycelink:run` chains every phase (init, PRD, plan, dispatch, settle,
  candidate, deliver) without stopping between them, and documents rework.
- `mycelink dispatch <feature> [--resume <node>]`: runs due controller nodes
  inline and claims the next schedulable worker node for the host, printing
  a JSON ticket (capability, ids, attempt, worktree, allowed paths,
  verification and gate commands, result slot, settle command, bounded
  prompt). It never spawns a process.
- `mycelink settle <feature> <node> --capability <c>`: quarantines and
  validates the result slot, then parks, records a failure, or fresh-verifies,
  integrates and marks the node DONE. Idempotent per claim.
- `mycelink node finalize`: the same deterministic tail for manually driven
  nodes, so nothing is stranded at REGRESSION_VERIFIED.
- `mycelink deliver <feature>`: fast-forwards every base branch to exactly
  the candidate SHA after checking every repository first, journals a
  delivery manifest, rolls back on a mid-way failure, runs final acceptance,
  and never pushes. `/mycelink:deliver` and the `host-dispatch` skill.
- Adapter preflight (`doctor` and before `orchestrate run` claims anything):
  resolves the worker executable as the shell-less spawn would and probes
  `--version`.

### Changed

- **Workers keep a test-first commit history.** The module-worker agent,
  the node-worker skill, both ticket prompts (host and print mode) and the
  context pack's rules now fix the order: the failing tests and a red gate
  that accepts the RED, then exactly the test changes committed alone
  before any production edit, then production committed alone once green
  passes; never tests and production in one commit (`git diff --cached
  --name-only` before each), the same in rework. A RED refused as a setup or
  environment failure leads to no production edit or commit: the test
  changes are committed alone only when the gate's own output shows a
  missing behaviour, otherwise the worktree is restored and the worker
  returns BLOCKED with the gate's fingerprint. In the first real benchmark
  pilot, workers whose RED gate failed on the environment implemented
  anyway and committed tests and production together, a history no
  test-first replay can credit.

### Fixed

- **Node 22's test runner output is read as Node 24's.** Node's JUnit
  reporter names each test's file only from Node 24.11, so on Node 22 every
  declared RED test read "not run". A file-less result is now attributed to
  the one test file of the module that declares it (statically or by a
  template that carries its title), never when another file could have run
  it or its failure's stack names another file. On Node 22 `node --test`
  prints TAP into a pipe: the output-only RED check and regression deferral
  now read its diagnostics, so a RED failing on a missing constructor is
  refused there too, as on Node 24.
- **One place, one name (macOS `/var`, Windows 8.3 names).** A runner, git
  and a child's working directory name the real path of a directory the
  controller reached through a link or a short name. Reported test files,
  the provenance ledger (its file and git records alike), the benchmark's
  suite pin, workspace keys and registered-repository checks now compare
  canonical places; containment still requires the real path inside the
  real root.
- The provenance ledger records one change per call (`appendFileSync`
  writes through the exported `writeFileSync`; Node 22's `rmSync` through
  its own `unlinkSync`), the same on every Node.
- A failing verifier that prints nothing had a new fingerprint on every
  attempt on Linux and macOS (its fresh working directory was in it), so
  the same failure twice never blocked the node.
- `npm test`, CI and the release workflow run the suites through one
  bounded runner (`scripts/test-suites.mjs`): each suite in its own Vitest
  process with a worker limit, the large ones in duration-balanced shards,
  every collected file in exactly one; CI runs each shard as its own job on
  all six OS and Node legs.

- **A test is its path and its runner's key (PCM-101 final).** JUnit
  reports name `pkg.Class#method` while the Java reader declares bare
  methods, and the two were compared as strings, so every Java criterion
  was refused `CRITERION_TEST_UNKNOWN` after a valid RED, GREEN and
  regression. Tests now have a runner-aware canonical identity
  (`mycelink-test-identity/1`; for JUnit the normalised path and method,
  with the class and package checked against the file); nested classes,
  overloads, parameterised invocations and `@DisplayName` resolve from what
  the report names, and anything ambiguous fails closed. A hold, a BLOCKED
  answer or a parked node caused only by the old comparison is
  re-evaluated once, administratively, with nothing charged.

- **A criterion's review budget is not a cap, and a settled proof is never
  lost from the product (CSET-201 final).** CSET-201 final ran trusted, but
  R001's AC-2 and AC-3 reworks settled as re-proofs whose passing tests were
  archived and never committed; R002 passed AC-3 on them, the cli reopened
  later settled AC-3 on a RED of tests its head never held, and R003's
  materially new third AC-2 gap was exhausted solely because the count was
  2 while its AC-3 gap, its proof gone from the head, was judged a
  duplicate. Now `max_rounds` is a budget: past it a materially new gap
  (a new reproduction, or a duplicate naming an uncovered boundary no
  earlier gap named) is reworked when every producer reworked for the
  criterion's last gap settled it with verified progress in the reviewed
  heads, up to `acceptance_review.criterion_ceiling` (default 6, a person
  decides there); a review stops on a duplicate or no-progress loop, an
  oscillating restoration, `max_review_sessions` (default 8) or the
  optional `review_wall_clock_minutes`. Old lineages read with the default
  ceiling, their events unchanged. Settle commits an accepted re-proof as
  the red gate ran it, as a test-only unit (trailer `Mycelink-Reproof`)
  journaled before the branch moves and verified fresh; an integration that
  would lose a sibling's standing proof, rebuilt on an older head or
  conflicting with a sibling's integrated work is refused uncharged
  (`SIBLING_PROGRESS_LOST`) and reissued from the latest head, the reason in
  the pack; a RED of tests the head does not declare is no proof, and a
  cited test the head does not declare is `CRITERION_TEST_UNKNOWN`. Every
  review receipt pins a coverage manifest of the standing completions at
  its heads; a lost one is a `REGRESSION`, restored uncharged with its
  original RED before any reviewer runs. The benchmark's test-first replay
  credits a re-proof unit as tests alone of behaviour an earlier RED drove.

- **Gate evidence is immutable from creation.** Every gate output, results
  file and judged history is a content-addressed artifact
  (`<label>.<sha16>.<ext>`), created exclusively before any record names it
  and never written again; archives copy only bytes that hash as recorded.
  A stale pointer in older evidence is repaired only from an exact archive
  whose provenance the node's records attest, with a sealed receipt
  (`mycelink evidence repair [--dry-run]`, and `deliver` before it
  verifies), never by a product rework; anything less is
  `EVIDENCE_REPAIR_REQUIRED`. From the CSET-202 rerun, where two red runs
  in one claim wrote one log and delivery refused the candidate
  (`OUTPUT_HASH_MISMATCH`).

- **An uncommitted reproduction can be cited (CSET-203 r17).** `tdd capsule
  --criterion <AC>` runs a worker's uncommitted focused reproduction with
  the claim's own module command on a throwaway checkout of its unchanged
  base, and seals the files, output and results under the control
  repository. A passing capsule is challenge material only; a failing one
  is RED material only, its exact files committed test-first. A stale or
  unknown capsule is refused or held uncharged, and `capsule verify
  [--replay]` replays them. Before, such a reproduction could not be named
  at all and the node was parked.

- **A completed criterion is carried by its proof record (CSET-203 r16).**
  One immutable, hash-bound completion record per criterion and generation
  is written in the DONE write. A review order that names a completed
  criterion again carries its proof as re-provable; a generation that
  changes no production code stands on the attested RED of a carried
  completion instead of being asked for a new one; carried completions are
  revalidated on the claim's base before any worker runs, and only an
  affected criterion is reopened, uncharged.

- **Each criterion of a rework order settles on its own (CSET-203 r15).** A
  version 2 worker result (outcome `CRITERIA`) answers every ordered
  criterion once: DONE, `REVIEW_GAP_CHALLENGE`, or BLOCKED/NEEDS_DECISION
  with its own reason. Settle integrates the DONE work, records a challenge
  with the criterion's prior proof carried, and orders the unresolved
  criteria again alone: one execution, one attempt. Before, a result had
  one outcome for the whole order, so a mixed one asked a person.

- **A worker still running or a contended lock spends no attempt.** A host
  settle while the worker's Agent task has not completed answers
  `WORKER_RUNNING`, with nothing settled, written or charged; a verified
  submission whose integration lock another process holds is held and
  finished by the next dispatch. The project hook reads guarded commands
  as the shell runs them instead of matching their text, lets a worker
  rebase or cherry-pick its own history in its own worktree, and tells
  tests from production by the repository's TDD policy.

- **A refinement is a revision of its review (CSET-203 r14).** A review is
  a chain of immutable revisions; a refinement's settle writes the revision
  and rebases, amends, cancels or reorders every order it leaves standing
  in the same STATE.json write. An order still bound to an older revision
  is reconciled, never judged or charged (`REVIEW_ORDER_REBASED`,
  `REVIEW_GAP_STALE`), and conflicting decisions for one criterion are
  refused (`REVIEW_REFINEMENT_CONFLICT`). Before, an order the refinement
  did not touch kept its old binding, and its valid challenge was refused
  and charged twice.

- **A reviewer still running is awaited, never taken for one that left no
  verdict (CSET-203 r13).** r13's refinement reviewers finished within
  seconds, but Claude Code recorded each completion while the host sat in a
  `sleep` — a queue operation, then a queued command absorbed mid-turn,
  never a user message — and ingest knew only the user message: "has not
  completed". Settle took that for REVIEW_VERDICT_MISSING twice and blocked
  the feature REVIEW_INVALID with a valid challenge pending. A launched
  reviewer now has a lifecycle read from Claude Code's own records
  (`MISSING`, `RUNNING`, `COMPLETED`, `COMPLETED_NO_OUTPUT`,
  `FAILED_PROVIDER`, `LOST`, `TIMED_OUT`), every completion form counts, and
  its transcript is read only once its completion is durable. While it runs,
  settle and ingest answer `REVIEWER_RUNNING`, `dispatch` and `dispatch
  --resume` never issue a second generation, the fence refuses a second
  reviewer for the generation, and `feature status` says `await-reviewer`
  (its task and agent by hash, its elapsed and remaining wall-clock). The
  new `review await` (the ticket's `await_command`) waits for it. Only a
  reviewer that completed with no answer is REVIEW_VERDICT_MISSING. One
  past `acceptance_review.reviewer_timeout_seconds` (default 1200) from its
  launch, or whose host process or task ended first, is interrupted: its
  generation re-issued with nothing spent, its late answer stale, at most
  three times a review. The launch hook records the host's process and the
  Agent task it started. The benchmark harness waits on a running reviewer
  with no model session, has Mycelink interrupt a lost one model-free, and
  holds Mycelink's account of each reviewer against the sessions' own
  streams: a forged lifecycle makes the run untrusted.

- **A module-worker's own stash is the worker's, not the controller's
  (CSET-203 r12).** r12's module-worker ran `git stash` in its worktree, as
  the red gate's refusal told it to; worktrees share their repository's
  stash, and the benchmark's controller transaction, with no record of whose
  call moved `refs/stash`, rolled the whole session back to before the
  feature began. With `MYCELINK_PROVENANCE` set the plugin's hooks now record
  every Bash call's start and end and every subagent's stop with each
  repository's shared Git state, a worker bound to its claim through Claude
  Code's subagent meta and the fence's launch record, and the core records
  what it read before each change. The fence lets a worker take only stash
  entries its own worktree made; settle and `node discard` archive and drop
  what a worktree left, every other entry kept byte for byte; the red gate
  and the worker brief say the stash is shared and to leave nothing in it.

- **Each acceptance criterion has its own review-rework budget (CSET-203
  r11).** r11 ran continuously and trusted: R001's and R002's AC-1 gaps
  were each challenged and withdrawn while the cli was reworked for AC-5 and
  AC-3, and R003 then found materially new, concrete AC-1 and AC-3 gaps —
  but the one global `max_rounds: 2` count, spent by withdrawn hypotheses
  and other criteria, blocked it `REVIEW_GAPS` before any rework. Now
  `acceptance_review.max_rounds` (default 2, 1..5) is the number of accepted
  producer reworks per criterion. A gap spends its criterion's budget only
  when its reproduction is materially new and a producer is actually
  reworked for it; a challenged rework, a withdrawal, a format correction,
  a provider retry, a stale verdict or a verification rerun spends nothing,
  and one criterion never spends another's. A repeat of an earlier
  reproduction — compared by a normalized fingerprint (identifiers split,
  case, punctuation, order, padding and synonyms set aside), never the
  wording — is rejected without a rework (`REPEATED`); past its budget a
  materially new gap is exhausted, the other gaps are reworked all the same,
  and the feature blocks `REVIEW_GAPS` naming the exhausted criteria once
  they have settled. Four consecutive reviews without progress (no producer
  change, no new criterion proof, no accepted new gap, no valid challenge),
  or eight review sessions since the last accepted delivery, block it
  `REVIEW_NONCONVERGENT` with the lineage. Everything is one append-only,
  hash-chained lineage in STATE.json (`acceptance_review.lineage`), each
  receipt pinning the chain head its settle left: budgets are summarized
  from it, never stored, so a crash, a repeated settle or a stale
  generation counts nothing twice, and a lineage reset or rewritten outside
  Mycelink blocks the feature `REVIEW_LINEAGE_INVALID`. A review state from
  before it is migrated from its records and receipts. Every review packet
  carries `review_memory` — each earlier finding, its reproduction, hash
  and fingerprint, its challenge tests and assertions, WITHDRAW/REFINE/
  UPHOLD decisions, the reworked producers' commits and evidence — and the
  reviewer is told never to report one again and to look only for
  uncovered clauses. An acceptance review's rework is bounded by its
  criterion, no longer by the node's `REWORK_LIMIT`. A person's decided
  rework past a block grants each exhausted criterion one more and counts
  the ceilings afresh. `feature status` and `review status` give each
  criterion's budget left and next action.

- **A reviewer's final answer is its verdict (CSET-203 r8).** r8's
  corrective reviewers answered their whole corrected verdict JSON and never
  called Write; settle found no verdict twice and blocked the feature
  `REVIEW_INVALID`. Every review ticket now carries an `ingest_command`, run
  after the reviewer's Agent call returns and before `settle_command` (for a
  review, a format correction and a refinement alike): `mycelink review
  ingest` takes the reviewer's final answer — exactly one JSON object, raw or
  in one ```json fence, strictly parsed (bounded bytes and depth, no
  duplicate key) — from Claude Code's own records of the reviewer the host
  launched for that generation (a launch the plugin's hook records; the
  session's and the subagent's transcripts and meta), writes it to the
  generation's verdict file only and attests it like a Write, with the
  answer's and the transcript's hashes. Settle ingests by itself what the
  host did not, and `dispatch --resume` settles a finished reviewer's answer.
  A Write and a different answer are `REVIEW_OUTPUT_CONFLICT`; an answer that
  is not exactly one JSON object is `REVIEW_RESULT_INVALID`; both are
  corrected for their form. The fence refuses any write to Claude Code's
  transcripts and any session running `mycelink hook` itself. The bench
  records each reviewer's transport and its answer's and transcript's
  hashes, and scans reviewers' final answers for evaluator roots.

- **An epoch-fenced dispatch registry and review barrier (CSET-203 r7).**
  STATE.json carries a monotonic orchestration epoch, moved in the same
  write as each change of what a review or a candidate binds, and a durable
  lease for every claim and review generation. A result from a revoked,
  replaced or superseded generation is `STALE_ORCHESTRATION_EPOCH`: moved
  aside, with nothing charged. No review, refinement or PASS runs while a
  worker or verification lease is live, and a PASS binds a candidate only
  at its epoch with every judged node DONE (`REVIEW_STALE`,
  `REVIEW_BARRIER`). A valid challenge restores the dependents its rework
  reopened.

- **A reviewer verdict's prose is canonicalised, not refused for its
  length (CSET-203 r5).** Trace, boundary and gap prose is NFC- and
  whitespace-normalised and cut at its bound with a mark (ids, hashes,
  paths and evidence references are still refused over theirs), and the
  receipt keeps the original and canonical hashes. Control or
  bidirectional characters, credentials, controller authority and embedded
  instructions are `REVIEW_VERDICT_UNSAFE`. A verdict refused for its form
  is corrected within the review (up to three format corrections) instead
  of spending a review attempt.
  `schemas/acceptance-review-verdict.schema.json` is generated from the
  judge's own limits.

- **A rework starts a new generation (CSET-203 r4).** The replaced
  generation's criteria, judged history, RED bindings, receipt, claim and
  dispatch are archived, and the new generation starts with no active gate
  or binding, so the old capability settles nothing. Proofs of behaviours
  the rework does not name are carried and re-run at the settled head; a
  compatibility-only rework needs no RED; a RED-bound test file is fenced
  once production began (`tdd cycle` declares a new RED cycle); and
  `feature status` reports the `next_action`.

- `node rework` repairs a delivered feature on top of a base someone
  committed on after the delivery. It refused with `REWORK_BASE_MOVED`, so
  a defect a teammate's commit introduced on the delivered branch (the
  benchmark's late-hidden-defect fault) could not be repaired in the
  feature at all. A base that moved on top of the integration branch is now
  adopted: the integration branch fast-forwards to it in the rework's own
  state write (named in the report, the rework record and the event as
  `adopted_bases`), the node is dispatched from it, and the new candidate
  delivers by fast-forward. Repeating a rework a crash cut short finishes
  the adoption. A base that no longer holds the delivery still refuses
  (`REWORK_BASE_MOVED`), and an integration branch moved by anything else
  is still `INTEGRATION_BRANCH_MOVED`.
- Host-dispatched module-workers are no longer told to load the
  `node-worker` skill. They run as subagents, which have no Skill tool, so
  every worker's first call failed ("No such tool available: Skill", third
  PCM-101 pilot). The agent definition and the ticket already carry every
  rule; there is nothing to load.
- A dependent node in the same repository as its upstream failed
  `OWNERSHIP_VIOLATION` because its fence was measured from the base branch
  and so included the upstream's integrated files. A node branch now starts
  at the integration head; the exact base is pinned in the claim
  (`base_sha`) and fresh verification fences only the node's own delta.
- `/mycelink:prd` and `/mycelink:plan` no longer tell the host to stop after
  their phase when they are part of a run.
- `dispatch` no longer retries a failing controller node inline until it is
  BLOCKED. A candidate build that finds uncommitted files in the control
  repository returns `PRECONDITION_FAILED` with nothing charged, and any
  other controller failure stops dispatch with `CONTROLLER_FAILED` (seen in
  the existing-informed real-model eval run).
- `tdd` refuses a gate whose transition is illegal (`GATE_OUT_OF_ORDER`)
  before running the verifier, and a failure fingerprint counts once per
  claim, so a worker can iterate on a failing gate within one attempt (the
  greenfield real-model eval run BLOCKED a node in its first attempt).
  `/mycelink:init` and `/mycelink:plan` now commit the control-plane files.
- Result capture works when worktrees live on another volume than the
  control repository: the slot is renamed into a quarantine beside the
  worktree instead of failing with EXDEV. It is still one atomic rename
  with the same link, hard-link, size, schema and identity checks; nothing
  is copied, and capture still fails closed when no same-volume rename
  exists.
- Delivery rollback is a compare-and-swap: a base is restored only while it
  is still exactly at the candidate this delivery installed. A base someone
  committed on in the meantime is never reset; the manifest records
  `PARTIAL_DELIVERY` and names it. Before, a checked-out base was put back
  with `reset --keep`, discarding such a commit.
- A repeated `deliver` trusts an ACCEPTED manifest only if it is byte-for-byte
  the one whose passing acceptance was recorded in STATE.json, and its shape,
  binding to the candidate and every acceptance output's hash still check
  out; otherwise acceptance runs again.
- Settle counts a worker's usage exactly once per dispatch generation: the
  captured result's hash and the usage are recorded in one STATE.json
  write, a capture announces its controller copy before taking it so a
  settle that dies after writing it can finish, and a settle that dies after
  concluding the attempt is answered from a provisional receipt.

- Spawn failures and claim-setup failures are infrastructure: the claim is
  released with its attempt refunded, nothing is BLOCKED, and the run stops
  with the resumable `ADAPTER_UNAVAILABLE`.
- Reconcile tells abandoned host dispatches, dead settles and orphaned
  sessions (interruptions, no failure recorded) from task failures.
- `init` writes a safe `/.mycelink/` entry to the control repository's
  `.gitignore`.
- Worker worktrees are removed when a node reaches DONE.

- **Real worker sessions could never start their node (beta blocker).** The
  worker prompt told Claude Code to read `$MYCELINK_CONTEXT_PACK` and write
  `$MYCELINK_RESULT_PATH`. In print mode Claude Code's permission checks deny
  shell expansion of variables, and the pack lived outside the worktree, so
  the first real-Claude pilot's worker was denied on every attempt and exited
  0 with no result (`RESULT_MISSING`, no RED/GREEN evidence). The worker
  transport no longer depends on the worker discovering anything:
  - the validated, redacted, byte-bounded context pack is inlined in the
    prompt, which is sent on **stdin** (no command-line length limit, no
    batch-shim expansion). Pack text is JSON with `<`, `>`, `&` and backticks
    `\u`-escaped, so it cannot close its data block or forge protocol lines.
    A pack that is schema-invalid, over its byte budget, or for another
    feature, node or claim fails the attempt (`CONTEXT_PACK_INVALID`) without
    starting a worker;
  - the worker writes `.mycelink-worker/result.json` inside its own worktree.
    The controller creates that slot with a self-ignoring `.gitignore`,
    pre-approves exactly that file (`--allowed-tools
    Edit(./.mycelink-worker/result.json)`), and after the session collects it
    with link, size (256 KiB), schema and node/claim identity checks
    (`RESULT_PATH_ESCAPE`, `RESULT_TOO_LARGE`, `RESULT_SCHEMA_INVALID`,
    `RESULT_IDENTITY_MISMATCH`), stores a redacted copy under the feature's
    `sessions/` directory, and removes the worker's copy;
  - the controller offers the node's `mycelink tdd red|green|regression`
    calls as exact command lines (no `--` passthrough, so each runs the
    declared verifier) and pre-approves only those exact lines;
  - `MYCELINK_CONTEXT_PACK` and `MYCELINK_RESULT_PATH` are no longer set for
    workers; the PreToolUse hook exempts exactly the result file from the
    ownership fence and the RED gate.
- The real-Claude pilot no longer passes on a non-result. It now requires a
  structured worker result plus either a behaviour-missing RED and a passing
  GREEN on the same command, or a `NEEDS_DECISION` with a real question and at
  least two options; `RESULT_MISSING`, `READY`, `BLOCKED` and the rest fail it.
- Windows: every worker attempt failed with `WORKER_PROTOCOL_INVALID: gate
  argument "<8.3 short-name path containing ~1>" could be reinterpreted by a
  shell` when the control repository lived under an 8.3 short name (such as a
  user directory abbreviated to `RUNNER~1`), because `~` was not an accepted
  gate-argument character. A tilde is now accepted, but only inside
  double quotes, where every shell treats it as literal (an unquoted `~` is
  expanded by bash at the start of a word and after `=`). The gate-argument
  rules were also tightened: `%` is refused (cmd.exe expands `%VAR%` even
  inside double quotes), and a leading `@` (PowerShell splatting) is offered
  quoted. Found by the CI run for the worker-transport fix.
- Windows with Node.js 22: every worker result was refused with
  `RESULT_PATH_ESCAPE: the result is not a regular file`, so no real worker
  attempt could finish. The result's identity was checked by comparing
  `fstat` on the open file with `lstat` on its path. On Node 22 for Windows,
  path-based `lstat`/`stat` report `dev` as `0` while `fstat` reports the
  volume serial; Node 24 reports the same value from both. The check is
  gone: the result is now captured into a controller-owned quarantine by
  atomic rename before it is validated (see *Security*). Found by the CI run
  for the previous fix (Windows, Node 22.12.0 leg only).
- `mycelink --help` printed the usage and exited 1, and `mycelink -h` was an
  unknown command group (exit 2). `help`, `--help` and `-h`, alone or with a
  command group, now print the usage and exit 0; no command group still
  exits 1 and an unknown one 2.

### Security

- Every file the core and the hooks look at before reading (result and
  verdict slots, launch records, reports, ledgers, transcripts, setup
  receipts) is now read through one descriptor opened without following a
  link and without blocking, checked by its own `fstat` and against the
  path's file id, bounded (CodeQL `js/file-system-race` on the release pull
  request). Files Mycelink creates only where nothing is (the config, a
  review's diff) are created exclusively; copies are replaced atomically.
- The benchmark's transcript scan matches globs directly instead of
  compiling a session's pattern into a regular expression
  (`js/regex-injection`).

These issues were found by CodeQL on the worker-transport pull request.

- The worker result and the context pack were checked through one path
  lookup and read through another (CodeQL `js/file-system-race`). A file
  swapped in between was parsed without its size or link checks, and the
  first bytes of a non-JSON file outside the worktree could surface in the
  `RESULT_UNREADABLE` parse error. Both are now opened once, checked through
  that descriptor (`fstat`), and read with a byte bound. The worker result
  is first captured: the slot directory, then the result file, are moved by
  atomic rename into a fresh controller-owned quarantine beside the stored
  result, so the worker can no longer swap the path being checked. A rename
  moves a link itself, never its target, so a slot directory or result
  replaced by a link is refused without touching what it points at, and a
  result with more than one name (a hard link to a file outside the
  worktree) is refused too (`RESULT_PATH_ESCAPE`). If the rename cannot be
  done atomically, for example across volumes, capture fails closed
  (`RESULT_CAPTURE_FAILED`); nothing is copied out of the worktree. The
  quarantine is always removed, and links in it are unlinked, never
  followed.
- The result slot's `.gitignore` was written through whatever stood at that
  path, so a link left by an earlier attempt redirected the controller's
  write outside the worktree. It is now removed and recreated exclusively.
- Argv commands and opted-in shell scripts went through one planning
  function and one spawn, separated only by a runtime flag (CodeQL
  `js/shell-command-injection-from-environment`,
  `js/indirect-command-line-injection`). Shell scripts now have their own
  entry points (`planShellScript`, `runShellScriptSync`) and their own spawn.
  Verification takes either `command` (argv) or `shellScript`, never both,
  so an operator's `-- <argv>` cannot reach a shell. Batch-shim arguments
  are quoted only after passing an allowlist check.
- On Windows, batch shims and shell scripts run through the system
  `%SystemRoot%\System32\cmd.exe`. Before, they used `ComSpec`, which could
  come from a command's own environment.
- A crashed integration was resumed whenever the integration branch
  contained the verified node commit and its first parent was the recorded
  head. A same-user process could forge that shape (a merge of the recorded
  head and the verified commit carrying unverified content, moved onto
  `feature/<id>` between fresh verification and integration) and have it
  recorded as the trusted head; `branch integrate` likewise adopted such a
  merge as already integrated. An integration now journals the exact commit
  it produces (`pending_integrations` in STATE.json) before moving the
  branch, under a per-repository lock, and a resume accepts only that
  commit; anything else is `INTEGRATION_BRANCH_MOVED`. Merges are computed
  with `git merge-tree` and the branch is fast-forwarded to the journaled
  commit. `branch integrate` goes through the same path.
- A candidate was cut and made current outside the feature's delivery
  lock, so it could become current in the middle of a delivery or right
  after a rework reopened the work it binds. The candidate node and
  `candidate create` now check, bind and record it under that lock;
  a busy lock hands the candidate node back unspent (`FEATURE_BUSY`).

## [0.2.0-beta.1]

First public beta.

### Added

- Deterministic controller (`mycelink` CLI) and Claude Code plugin: one
  approved PRD becomes a four-layer portfolio graph, dependency-scheduled
  worker sessions in isolated git worktrees, per-repository
  `feature/<id>` integration branches, one immutable cross-repository
  candidate, and evidence-based completion.
- Strict TDD gates (RED must fail for a missing behaviour; GREEN re-runs the
  same command), bounded retries and budgets, failure fingerprints,
  capacity-bounded resource leases, E2E conflict scheduling, fresh
  verification and an optional LLM Wiki Brain memory adapter.
- Project-scoped enforcement hooks installed by `mycelink init`; `mycelink
  doctor` reports missing hooks or hooks that point at a moved installation
  (re-run `init` after a plugin update). Permission-bypass flags for worker
  sessions are refused unless explicitly allowed, and the hooks block model
  edits of `mycelink.config.json` and `.claude/settings.json`.
- Plan-source adapter registry (`mycelink graph adapters`,
  `mycelink graph import`); the ECC adapter is optional and validated against
  the documented artifact shape only.
- Security hardening: path containment with symlink/junction resolution;
  refusal of UNC, extended-length, device and reserved-name paths; validated
  feature/node/candidate ids and git ref names; argv-only command execution
  with an explicit, config-gated shell mode; Windows batch-shim argument
  checks; secret redaction in evidence, logs, ledgers, context packs and
  session logs; PID-reuse-safe session reconciliation; candidate manifests
  bound to their id and feature.
- Self-contained runtime bundle (`dist/mycelink.mjs`) so marketplace and
  release-ZIP installs need no `npm install` and no TypeScript build.
- Deterministic release packaging with SHA-256 checksum and SPDX 2.3 SBOM.

### Changed

- License: Apache-2.0.
- Repository metadata now points at the public GitHub repository
  `nigunpark/mycelink`: `homepage`, `repository` and `bugs` in `package.json`
  (also carried in the release archive's `package.json`), `homepage` and
  `repository` in the plugin manifest, the README's *From GitHub* install
  command, and the SECURITY/SUPPORT/issue-template links.
- `GOVERNANCE.md` lists `@nigunpark` as maintainer, and `.github/CODEOWNERS`
  assigns all paths to `@nigunpark`.
- `bin/mycelink.mjs` and `dist/mycelink.mjs` are tracked in git as executable
  (`100755`), matching the modes already used in the release archive, and
  `npm run build` sets the bundle's mode explicitly. Before this, rebuilding
  on Linux or macOS flipped the bundle's mode and failed the CI build check.

### Fixed

- Windows: node and integration worktrees were matched against `git worktree
  list` by path text. When the configured location used an 8.3 short name
  (for example the `RUNNER~1` user directory on GitHub-hosted runners), the
  existing worktree was not recognized: its directory was deleted and
  re-adding it failed with "missing but already registered worktree".
  Worktrees are now matched by real location (8.3 names expanded,
  case-insensitive on Windows). Found by the first public CI run.
- CI: both fixes above are confirmed by a run that passes on Windows, Ubuntu
  and macOS with Node.js 22.12.0 and 24.

[Unreleased]: #unreleased
[0.3.0-beta.1]: #030-beta1
[0.2.0-beta.1]: #020-beta1
