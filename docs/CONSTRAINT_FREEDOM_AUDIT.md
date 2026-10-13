# Constraint/freedom audit (before r15, updated before r16, r17, r18 and both CSET-202 reruns)

Base: `25a7a0d` on `eval/public-project-benchmark`; updated on `fb21139`
after r15 (T-19, T-20, the r15 row), on `90d6279` after r16 (T-21–T-23, the r16 row), on `b72a9ba` after r17 (T-24–T-26, the r17 row) on `a67b6cb` after CSET-202 final (B-05 generalised, B-11, B-12, the CSET-202 final row) on `3a10e65` after the CSET-202 rerun (T-27–T-29, the CSET-202 rerun row) and on `80c6e17` after CSET-201 final (T-30–T-34, R-04 relaxed to a budget, the CSET-201 final row) and on `f4b020c` after PCM-101 final (T-35–T-37, T-33 restated, the PCM-101 final row). Model-free only: no model pilot was run. The checkable record is
[`docs/evals/constraint-audit.json`](evals/constraint-audit.json);
`node scripts/constraint-audit.mjs --check` verifies it (anchors, tests,
generated sections, no absolute paths or ids), and
`tests/security/worker-freedom-envelope.test.ts` verifies its cross-case
section.

Outcome of the reruns this audit cleared: all 12 arms (6 PRDs, normal and
fault) were verified and independently verified. See
[`docs/evals/2026-10-12-public-project-final-matrix.md`](evals/2026-10-12-public-project-final-matrix.md).

The question: has hardening Mycelink against CSET-203's failures
overconstrained Claude, or fitted the plugin to one case? The short answer is
no for the plugin core's code, which has no case-specific branch. But the
audit found and fixed seven rules that either blocked legitimate work or
charged product attempts for orchestration problems. Three more are kept
deliberately, with the reason recorded.

## Classes

| class | meaning |
|---|---|
| `HARD_SAFETY` | ownership, secrets/hidden evaluator, controller/product separation, stale result isolation, resource locks, exact candidate/evidence |
| `EVIDENCE_GATE` | an outcome checked at a semantic transition; it does not dictate implementation commands |
| `RECOVERABLE_ADVISORY` | unusual but legitimate; logged and reconciled; never a product attempt charged for an orchestration/administrative issue |
| `OVERCONSTRAINT` | a command/path/workflow restriction the invariant does not need, or case-specific coupling |

Scope: `runtime` means every plugin installation, and `benchmark` means the
public-project harness. The project hooks that `mycelink init` writes into a
control repository's `.claude/settings.json` (the P-* entries) are never
loaded by the benchmark, because its sessions run with
`--setting-sources user`. They apply only when Claude runs with the control
repository as its project.

## Inventory (78 enforcement points)

Counts: 30 HARD_SAFETY, 22 EVIDENCE_GATE, 13 RECOVERABLE_ADVISORY,
10 OVERCONSTRAINT. By status: 61 retained, 11 fixed, 3 retained-candidate.
Each entry's invariant, actor, blocked action, false-positive risk, recovery,
whether it charges a product attempt, its tests and an anchor in the code are
in the JSON record.

### Plugin fence (runtime and benchmark; `hooks/hooks.json` → `src/hooks/fence.ts`)

| id | rule | class | status |
|---|---|---|---|
| F-01 | acceptance reviewer read-only; one attested verdict Write | HARD_SAFETY | retained |
| F-02 | a module-worker spawns no subagent | HARD_SAFETY | retained |
| F-03 | no session runs `mycelink hook` | HARD_SAFETY | retained |
| F-04 | host-only commands never a worker's | HARD_SAFETY | retained |
| F-05 | nobody writes Claude Code transcripts | HARD_SAFETY | retained |
| F-06 | nobody writes the provenance ledger (benchmark) | HARD_SAFETY | retained |
| F-07 | the controller never runs a worker's gate | HARD_SAFETY | retained |
| F-08 | worker stash: own entries only; never clear/store/branch | HARD_SAFETY | retained |
| F-09 | a worker writes only worktrees and its result slot inside a workspace | HARD_SAFETY | retained |
| F-10 | RED-bound test file byte-identical after production began (unless `tdd cycle`) | EVIDENCE_GATE | retained |
| F-11 | the controller never writes worktrees, slots, checkouts, evidence, scratch | HARD_SAFETY | retained |
| F-12 | controller writes only its documents inside a workspace | OVERCONSTRAINT (scratch part) | retained |
| F-13 | controller code with unplaceable writes refused inside a workspace | HARD_SAFETY | retained |
| F-14 | fail closed inside a workspace | HARD_SAFETY | retained |
| F-15 | an unrecordable call does not run (benchmark ledger) | RECOVERABLE_ADVISORY | retained |
| F-16 | one reviewer per review generation | HARD_SAFETY | retained |

### Project hooks (normal runtime only; `src/hooks/entrypoint.ts`)

| id | rule | class | status |
|---|---|---|---|
| P-01 | managed state never edited with file tools | HARD_SAFETY | retained |
| P-02 | feature graph refused before `feature init` | OVERCONSTRAINT | **fixed** |
| P-03 | `repositories.yaml` changed through `repo register` | HARD_SAFETY | retained |
| P-04 | controller-bypass guard matched command *text* | OVERCONSTRAINT | **fixed** |
| P-05 | a node session spawns no subagent | HARD_SAFETY | retained |
| P-06 | a worker edits inside its worktree and allowed paths | HARD_SAFETY | retained |
| P-07 | one claimed node: every session's edit taken for that worker's | OVERCONSTRAINT | **fixed** |
| P-08 | edit-time RED gate used its own test regex and ignored compat-only reworks | EVIDENCE_GATE | **fixed** |
| P-09 | task-list items must name a schedulable node | OVERCONSTRAINT | retained-candidate |
| P-10 | a task naming a node completes only with its evidence | EVIDENCE_GATE | retained |
| P-11 | Stop refused once while work is in flight | RECOVERABLE_ADVISORY | retained |

### Core state, locks, epochs (runtime and benchmark)

| id | rule | class | status |
|---|---|---|---|
| S-01 | legal node edges with evidence gates | EVIDENCE_GATE | retained |
| S-02 | settle/gates need the current claim's capability | HARD_SAFETY | retained |
| S-03 | stale dispatches settle STALE_ORCHESTRATION_EPOCH, uncharged | HARD_SAFETY | retained |
| S-04 | resource leases, controller and feature locks (busy → RETRY, uncharged) | HARD_SAFETY | retained |
| S-05 | review barrier | HARD_SAFETY | retained |

### Settle: TDD, evidence, attempts (runtime and benchmark)

| id | rule | class | status |
|---|---|---|---|
| T-01 | test-first history (test-only commits first, RED blobs bound, no mixed commit, no merge) | EVIDENCE_GATE | retained |
| T-02 | a RED counts only for missing behaviour | EVIDENCE_GATE | retained |
| T-03 | gates ran the claim's module command | EVIDENCE_GATE | retained |
| T-04 | criterion evidence; correction hold uncharged | EVIDENCE_GATE | retained |
| T-05 | ownership fence on the node's delta | HARD_SAFETY | retained |
| T-06 | fresh verification of the sealed head | EVIDENCE_GATE | retained |
| T-07 | carried proofs revalidated | EVIDENCE_GATE | retained |
| T-08 | settle while the worker still runs | RECOVERABLE_ADVISORY | **fixed** (was RESULT_MISSING, charged) |
| T-09 | completed worker with no result is RESULT_MISSING | EVIDENCE_GATE | retained |
| T-10 | provider-ended holder interrupted, uncharged | RECOVERABLE_ADVISORY | retained |
| T-11 | answers to stale review orders reconciled, uncharged | RECOVERABLE_ADVISORY | retained |
| T-12 | legacy BLOCKED with passing RED → challenge request once | RECOVERABLE_ADVISORY | retained |
| T-13 | unproven correction spends a correction, not an attempt | RECOVERABLE_ADVISORY | retained |
| T-14 | integration-lock contention | RECOVERABLE_ADVISORY | **fixed** (was charged) |
| T-15 | INTEGRATION_BRANCH_MOVED charges the attempt | EVIDENCE_GATE | retained-candidate |
| T-16 | unclassified adapter-path exception charges the attempt | RECOVERABLE_ADVISORY | retained-candidate |
| T-17 | same-failure and rework limits | EVIDENCE_GATE | retained |
| T-18 | worker that could not start handed back unspent | RECOVERABLE_ADVISORY | retained |
| T-19 | one rework order needed one outcome for all of its criteria | OVERCONSTRAINT | **fixed** (r15: one attempt and a person) |
| T-20 | a per-criterion answer is judged criterion by criterion | EVIDENCE_GATE | retained (new) |
| T-21 | a generation that changed no production code had to run a RED of its own for the whole node | OVERCONSTRAINT | **fixed** (r16: two attempts charged, BLOCKED) |
| T-22 | a completed criterion is carried only after its record is revalidated on the new head | EVIDENCE_GATE | retained (new) |
| T-23 | production code is never carried in behind a completed or carried proof | EVIDENCE_GATE | retained (new) |
| T-24 | a focused review reproduction counted only once committed (or statically named) | OVERCONSTRAINT | **fixed** (r17: BLOCKED after six attempts) |
| T-25 | a reproduction capsule is used only as sealed (claim, revision, base, module, criterion, hash) | HARD_SAFETY | retained (new) |
| T-26 | a node reopened by an upstream's rework could not cite its carried proofs | OVERCONSTRAINT | **fixed** (r17: an attempt and a person) |
| T-27 | a delivery refused for an overwritten evidence pointer was answered by a product rework demanding a historical RED on fixed code | OVERCONSTRAINT | **fixed** (CSET-202 rerun: an attempt and a person) |
| T-28 | gate evidence immutable from creation (content-addressed, exclusive, never rewritten), verified on its own and across records | HARD_SAFETY | retained (new) |
| T-29 | a stale pointer repaired only from an archive whose exact bytes and provenance the node's records attest | EVIDENCE_GATE | retained |
| T-31 | a re-proof's passing tests kept out of the product: later heads never held the proof a review passed on | OVERCONSTRAINT | fixed: committed by settle as a test-only re-proof unit |
| T-32 | an integration never loses a sibling's standing proof; a stale base is reissued | HARD_SAFETY | retained (new, uncharged to its bound) |
| T-33 | a proof is a test the submitted head declares (by its canonical identity, T-36); a RED of tests never committed is no generation's own | EVIDENCE_GATE | retained |
| T-35 | "declared at the head" compared a reported full name with declared names as strings: a JUnit `pkg.Class#method` never equals the bare method the Java reader declares | OVERCONSTRAINT | **fixed** (PCM-101 final: every Java criterion refused; an attempt and a person) |
| T-36 | a test is its normalised path and its runner's key (JUnit: the method, class and package kept as raw evidence; JS: full suite/title; others exact), resolved at the submitted head; wrong or ambiguous is CRITERION_TEST_UNKNOWN; old evidence only through alias receipts | EVIDENCE_GATE | retained (new) |
| T-37 | an identity-shape refusal the old comparison made (a pre-identity hold, an identity-only BLOCKED answer) is re-evaluated once, administratively, from the exact captured answer | RECOVERABLE_ADVISORY | retained (new, never charged) |

### Acceptance review (runtime and benchmark)

| id | rule | class | status |
|---|---|---|---|
| R-01 | verdict schema; format corrections apart from reviewer attempts | EVIDENCE_GATE | retained |
| R-02 | verdict is the launched reviewer's own answer or attested file | HARD_SAFETY | retained |
| R-03 | running/missing/lost/timed-out reviewer spends nothing | RECOVERABLE_ADVISORY | retained |
| R-04 | per-criterion budgets (never a cap), repeats, nonconvergence | EVIDENCE_GATE | retained, relaxed to a budget |
| T-30 | a materially new gap exhausted solely by the per-criterion count of 2 despite verified progress | OVERCONSTRAINT | fixed: progress-gated past the budget, emergency ceiling 6 |
| T-34 | review closure needs monotonic coverage at the exact heads; a lost proof is restored, a regression | EVIDENCE_GATE | retained (new) |
| R-05 | gap challenges need the exact reproduction | EVIDENCE_GATE | retained |

### Benchmark harness only (`evals-public-projects/lib`)

| id | rule | class | status |
|---|---|---|---|
| B-01 | isolation boundary, fail-closed preflight | HARD_SAFETY | retained |
| B-02 | evaluator leakage fails a delivery | HARD_SAFETY | retained |
| B-03 | transcript monitor of controller writes (parity with the fence) | HARD_SAFETY | retained |
| B-04 | controller session transaction and rollback | HARD_SAFETY | retained |
| B-05 | a worker's stash beside an overlapping host wait blamed on the controller | OVERCONSTRAINT | **fixed** (CSET-202 final: two sessions lost) |
| B-06 | independent TDD replay | EVIDENCE_GATE | retained |
| B-07 | delivered scope | EVIDENCE_GATE | retained |
| B-08 | delivery hygiene | HARD_SAFETY | retained |
| B-09 | with-arm orchestration evidence | EVIDENCE_GATE | retained |
| B-10 | bounded continuations | RECOVERABLE_ADVISORY | retained |
| B-11 | a shared-Git transition is a worker's only as the causal tree places its call and its own stash command in its own worktree made it | HARD_SAFETY | retained (new) |
| B-12 | a live check stops a session only for the controller's own hand; a rollback archives every stash entry it takes out | RECOVERABLE_ADVISORY | retained (new) |

## Worker freedom envelope

Inside its own repository, worktree and node ownership, a module-worker may:

- inspect any file or history, including the base checkout;
- create helpers and choose its own structure;
- edit what it owns;
- split tests and add test data or snapshots;
- write through file tools, heredocs, moves or generators, including targets
  computed inside its worktree;
- commit, reset, rebase, cherry-pick and branch its own history;
- stash push, list and show, and pop, apply or drop its own entries;
- run builds, tests and any local command;
- keep scratch files outside the workspace;
- run its gates and preview settle with `tdd check`;
- answer each criterion of a rework order on its own (outcome `CRITERIA`),
  narrowing its challenge to the criteria whose reproduction passed
  (`tdd challenge --criteria`).

Its work is judged by outcomes at settle: ownership of the node's delta, a
test-first history, criterion evidence and fresh verification. The
benchmark adds an independent replay, scope and hygiene check. The fence
whitelists no implementation strategy.

The cross-case audit asks the shipped fence about 630 calls, read-only, in
workspaces shaped like each public PRD's own modules and language. Nothing it
answers is acted on. With `MYCELINK_AUDIT_DUMP=1` it prints every decision.
Among them, CSET-202 final's own shapes: a worker setting its production
aside beside its red gate in one call (`cd <wt> && git stash push -q --
<file> && ... tdd red ...`), a host waiting on a background worker (`sleep
100; echo waiting`, `sleep 240; ...; ls ... 2>/dev/null`) and looking at the
shared stash, all allowed; a host stashing the project checkout, refused.

| PRD | modules | worker freedom allowed | worker hard refused | controller freedom allowed | controller hard refused | retained refusals | old RED regex false blocks |
|---|---|---|---|---|---|---|---|
| CSET-201 | types, assemble-release-plan, cli | 69/69 | 33/33 | 11/11 | 7/7 | 2/2 | 3 |
| CSET-202 | errors, read, assemble-release-plan, cli | 92/92 | 44/44 | 11/11 | 7/7 | 2/2 | 4 |
| CSET-203 | apply-release-plan, cli | 46/46 | 22/22 | 11/11 | 7/7 | 2/2 | 2 |
| PCM-101 | visits-service, api-gateway | 46/46 | 22/22 | 11/11 | 7/7 | 2/2 | 0 |
| PCM-102 | customers-service, api-gateway | 46/46 | 22/22 | 11/11 | 7/7 | 2/2 | 0 |
| PCM-103 | visits-service, api-gateway | 46/46 | 22/22 | 11/11 | 7/7 | 2/2 | 0 |

No freedom call is refused in any case, and no hard-invariant call is
allowed. Each refusal names its own invariant, never the generic fail-closed
reason. The last column counts test-side files each adapter's own TDD policy
names (Changesets snapshots) that the project hook's old edit-time regex
refused before RED. P-08 now uses the policy.

One code path still violated the envelope's spirit: a worker that *was*
still running was charged when the host settled early (T-08). A sealed,
verified submission was also charged when the integration lock was
contended (T-14). Both now charge nothing. Workers can also now reorder their
own commits under the project hook (P-04).

## Case coupling

Pattern `cset-?[0-9]+|changesets?|petclinic|pcm-?[0-9]+`, case-insensitive.
Generated in `case_coupling`.

- Plugin core source: 231 mentions in 45 files, all of them in comments.
  There are **0** in code tokens (identifiers, strings, templates, regular
  expressions), so no core logic branches on a case or node name. The exact
  per-file counts are in the record.
- Model-facing plugin text (agents, skills, commands, templates, hooks,
  schemas, bin): **0**. Before this audit there were 10, all run narratives:
  "CSET-203 r1 planned `compat.regression`…", "CSET-203 r3 gave AC-5
  (`changeset status`…)", "CSET-203 r4's AC-3 and AC-5", "CSET-202 r2's
  controller…", plus four `(CSET-203 rN)` notes in schema descriptions.
  They were rewritten to case-neutral wording with the same rules. They
  coached the with arm about one benchmark case.
- Built bundle: 31 mentions, all comments; 0 in code tokens.
- Test files naming each case: CSET-201 12, CSET-202 40, CSET-203 104,
  PCM-101 17, PCM-102 2, PCM-103 5. This is the real overfitting signal: the
  regression suite is concentrated on one case.

## r1–r17, CSET-202 final, the CSET-202 rerun, CSET-201 final and PCM-101 final: product reliability or harness friction

From committed fixtures and tests only. No hidden evaluator content is used
beyond what the committed fixture READMEs already state.

| run | cause | kind | product attempts charged for orchestration | reviewer generations spent on transport/format | evidence |
|---|---|---|---|---|---|
| r1 | a correction answered RETRYABLE twice when its behaviour was already in the base; a planned no-op worker submitted nothing twice | harness friction | 4 | 0 | `tests/integration/criterion-correction-cycle.test.ts`, `tests/integration/verification-node.test.ts` |
| r2 | an AC-1 error path the workers' tests missed | genuine product | 0 | 0 | `tests/benchmark/fixtures/cset203-r2/README.md` |
| r3 | a verification-only criterion's gap had no product owner | harness friction | 0 | 0 | `tests/benchmark/fixtures/cset203-r3/README.md` |
| r4 | compatibility test appended to a RED-bound file (CHANGED_RED_BLOBS; 1 attempt, a workflow-discipline charge) | harness friction | 0 | 0 | `tests/fixtures/cset203-r4-replay-e2e.test.ts` |
| r5 | two verdicts refused for form | harness friction | 0 | 2 | `tests/fixtures/cset203-r5-e2e.test.ts` |
| r6 | an honest BLOCKED against a contradicted gap parked the node; a controller wrote the approved criteria | genuine safety (+ friction) | 1 | 0 | `tests/fixtures/cset203-r6-challenge-e2e.test.ts` |
| r7 | a node claimed past a review PASS | harness friction | 1 | 0 | `tests/fixtures/cset203-r7-epoch-e2e.test.ts` |
| r8 | verdicts answered as final text, not written | harness friction | 0 | 2 | `tests/fixtures/cset203-r8-transport-e2e.test.ts` |
| r9 | the controller wrote the approved criteria through an unplaceable script | genuine safety | 0 | 0 | `tests/benchmark/controller-edits.test.ts` |
| r10 | provider refusal ended the controller session (1 session lost) | harness friction | 0 | 0 | `tests/integration/provider-interrupt.test.ts` |
| r11 | a global review-round budget blocked new gaps | harness friction | 0 | 0 | `tests/fixtures/cset203-r11-convergence-e2e.test.ts` |
| r12 | a worker's own stash blamed on the controller; session rolled back (1 session lost) | harness friction | 0 | 0 | `tests/benchmark/controller-shared-git.test.ts` |
| r13 | queued reviewer completions not recognised | harness friction | 0 | 2 | `tests/fixtures/cset203-r13-reviewer-e2e.test.ts` |
| r14 | an order bound to a superseded receipt: REVIEW_CHALLENGE_STALE twice, charged, BLOCKED | harness friction | 2 | 0 | `tests/fixtures/cset203-r14-rebase-e2e.test.ts` |
| r15 | one order (AC-3 RED and fix, AC-4's reproduction passing in the same red gate, AC-5 compatibility unit) had to share one outcome: NEEDS_DECISION, automation stopped | harness friction | 1 | 0 | `tests/fixtures/cset203-r15-partial-e2e.test.ts` |
| r17 | fault arm: after the late defect, R005's exact AC-1 reproduction (a template-literal title in a loop, kept out of the branch) passed but could be neither checked nor challenged (CRITERION_TEST_UNKNOWN, NO_DECLARED_TESTS, GATE_UNKNOWN): BLOCKED; the reopened cli could not cite its carried AC-4 and asked a person | harness friction | 2 | 0 | `tests/fixtures/cset203-r17-capsule-e2e.test.ts` |
| r16 | fault arm: a compatibility-only continuation whose passing red gate re-proved AC-3 (completed by RED and fix a generation earlier, its order rebased untouched by a refinement) was asked for a RED of its own: INVALID_RED_EVIDENCE charged twice, BLOCKED | harness friction | 2 | 0 | `tests/fixtures/cset203-r16-carry-e2e.test.ts` |
| CSET-202 final | with arm: the host waited on each background worker in `sleep 100; echo waiting` while the worker pushed, ran its gate, committed and popped in its own worktree; the open host call was taken for a hand in the stash, and the live check stopped the task and the corrective session for the identical "refs/stash (moved from nothing to nothing)" (2 sessions lost, delivery-failed) | harness friction | 0 | 0 | `tests/benchmark/controller-rollback.test.ts` |
| CSET-202 rerun | with arm, trusted, no controller violation: R002 PASS and C001, then delivery refused C001 (OUTPUT_HASH_MISMATCH): the cli's review rework ran its red gate twice in one claim and both runs wrote one canonical log, under the record kept as its RED; the host ordered a product rework to "rerun the red gate" and the worker, whose code already held the behaviour, could not honestly make a passing test fail and asked a person (NEEDS_DECISION) | harness friction | 1 | 0 | `tests/fixtures/cset202-evidence-e2e.test.ts` |
| CSET-201 final | R001's re-proofs kept out of the product; R002 passed AC-3 on archived tests; the reopened cli settled AC-3 on a RED of tests its head never held; R003's materially new third AC-2 gap exhausted by the count of 2 alone and its AC-3 gap (proof gone) dropped as a duplicate; a person asked | harness friction (overconstraint) | 0 | 0 | `tests/fixtures/cset201-convergence-e2e.test.ts` |
| PCM-101 final | with arm, trusted: both Java producers ran a valid RED, GREEN and full regression; settle compared each JUnit result's `pkg.Class#method` with the bare declared methods and refused every criterion CRITERION_TEST_UNKNOWN: visits answered BLOCKED (its attempt spent, parked), the gateway was held for a correction no worker could make; a person asked | harness friction (overconstraint) | 1 | 0 | `tests/fixtures/pcm101-identity-e2e.test.ts` |

Totals: 18 of 21 runs failed on harness or orchestration friction. Three
failed on a genuine product gap or a real controller/product separation
breach (r2, r6, r9). Before their fixes, 15 product attempts were charged for
orchestration problems and 6 reviewer generations were spent on
transport/format. 4 sessions were lost to the harness. Every one of these
paths is now uncharged and tested (T-10–T-14, T-19, T-21, T-24, T-26, T-27, T-35, T-37, R-01, R-03, B-04, B-05).
This audit closed two more paths that had not yet been hit in a run: T-08 and
T-14.

r16 (fault arm) ran trusted. Controller authority was recovered, the
teammate's concurrent commit was synchronized, the duplicate and stale
replays were idempotent and the interrupted session resumed. What stopped it
was administrative (T-21). The cli's first generation had completed AC-3 by
RED and fix. R001's refinement rebased the cli's AC-3/AC-5 order, untouched,
to revision 1. The continuation found R001's AC-3 reproduction already
passing on that head, kept it out of the branch and committed AC-5's
compatibility unit: 0 RED cycles, 1 unit. Settle (and the worker's own
regression gate) asked the whole node for a RED of that generation. It
charged INVALID_RED_EVIDENCE twice and BLOCKED the node.

r15 ran trusted, with no controller violation, and passed every gate of this
audit. What stopped it was an orchestration overconstraint (T-19), not a
worker failure: R001's AC-3, AC-4 and AC-5 were one order on the cli, and
a result had one outcome for all of them. The worker proved AC-3 by RED and
fix and AC-5 by a compatibility unit, and wrote AC-4's exact reproduction.
That reproduction passed on the base in the same red gate where AC-3's
test failed. The challenge line refused because that gate had a failing
test. SUBMITTED needed a RED for AC-4 that no honest test has. So the
worker asked a person. One product attempt was spent and automation
stopped.

## Retained vs relaxed

Fixed or relaxed, each proven by a RED test:

- **T-27** administrative evidence repair (`src/engine/evidence-integrity.ts`).
  The CSET-202 rerun's cli kept the first of two red gates its review rework
  ran in one claim as its RED; both runs wrote one canonical log, so the
  record named bytes the second run had put there. R002 passed and C001 was
  cut; delivery refused it (OUTPUT_HASH_MISMATCH), the host ordered a
  product rework to "rerun the red gate", and the worker (its code already
  held the behaviour) could not honestly make a passing test fail and asked
  a person. Demanding a historical RED again on fixed code was an
  overconstraint: evidence storage is the controller's, never a worker's.
  `deliver` now repairs such a pointer before it verifies, from an exact,
  provenance-attested archive (T-29), under the same candidate: the bytes
  copied to a new immutable path, only the broken pointer moved, a sealed
  receipt bound in STATE.json, one event. Nothing is rerun, reopened or
  charged, and the orchestration epoch does not move, so the review PASS
  still binds. Where no exact archive exists the feature is
  EVIDENCE_REPAIR_REQUIRED: administrative, delivery fails closed, the next
  action is `evidence-repair` (not resumable by dispatch), and `node rework`
  of the named node is refused (REWORK_EVIDENCE_REPAIR) unless a person's
  decision is passed. `mycelink evidence repair <feature> [--dry-run]` is the
  controller's command. Tests: `tests/integration/evidence-repair.test.ts`,
  `tests/integration/evidence-repair-crash.test.ts`, the model-free replay
  `tests/fixtures/cset202-evidence-e2e.test.ts` (two red gates in one claim,
  R002 PASS, C001: delivered with nothing to repair, and, from the state an
  earlier release left, repaired from the red gate's own snapshot and
  delivered) and `tests/benchmark/cset202-rerun-evidence.test.ts` (the
  rerun's own state, repaired on a copy, the original read-only).

  Retained, both hard evidence gates:

  - **T-28** immutable gate evidence (`src/evidence/store.ts`). Every gate
    output, results file and judged history is a content-addressed artifact
    (`<label>.<sha16>.<ext>` in the node's evidence) created exclusively
    before any record names it and never written again; a file or link at
    its name is never written over or through. Replaced-generation,
    rejected-attempt, challenge-snapshot and completion archives copy only
    bytes hashing as recorded and never overwrite. Legacy canonical names
    are still read, never written. Feature verify checks every artifact a
    record names on its own and across records: results, the judged
    histories completion records name, carried proofs, every repair, one
    path named with two hashes, swapped files. Only a killed writer's stale
    temporary files are ever collected.
  - **T-29** provenance-attested repair. A stale pointer is restored only
    from an archive whose exact bytes and provenance (node, gate, generation
    and claim, and the commit, module, plan and exit where known) the node's
    own records attest: a replaced generation's copies (the rework that
    archived them), a completion record still sealed as written, a red
    gate's snapshot (that gate's binding in the same generation). Bytes
    attested for another node, generation, claim, base or module, two
    archives that disagree, a link, a second hard link, a traversal, a swap
    or a link at the record's own path are refused and fail closed. Every
    step is idempotent across a crash, a restart and a compacted event log.

  Tests: `tests/integration/evidence-immutable.test.ts`,
  `tests/unit/evidence-store.test.ts`, `tests/unit/evidence-provenance.test.ts`.

- **T-24** reproduction capsules (`src/engine/reproduction-capsule.ts`). r17's
  focused reproduction had to be committed, or statically named, to count;
  kept out of the branch, as a challenge's reproduction is, it had no
  identity the check or challenge lines could cite. That commit requirement
  was an overconstraint. `tdd capsule --criterion <AC>` now seals the exact
  uncommitted files: the controller runs them with the claim's own module
  command on a throwaway checkout of the claim's unchanged base, set up as
  its worktree was, records each test the run reported from them (by id,
  name, status and declaration block, a template-literal title located by
  its template), archives everything under the control repository and
  removes the checkout. Nothing of the product's refs, index or worktree
  changes. A passing capsule is challenge material only (`tdd challenge
  --capsule`, each gap's `capsule`, `gate_output_sha256` null). A failing
  one is RED material only: its exact files committed test-first, the red
  gate, the fix, cited with `capsule_id`. A passing capsule never proves a
  criterion DONE. Refusals caused only by a valid capsule's path
  (CRITERION_TEST_UNKNOWN, NO_DECLARED_TESTS, REVIEW_CHALLENGE_GATE_UNKNOWN)
  are held uncharged as `CRITERION_CAPSULE_PATH`; a BLOCKED answer beside a
  passing capsule becomes the challenge request (once). Tests:
  `tests/unit/reproduction-capsule.test.ts`,
  `tests/integration/reproduction-capsule.test.ts` and the model-free replay
  `tests/fixtures/cset203-r17-capsule-e2e.test.ts`. The replay runs both
  ways to C002: the reviewer withdraws or refines, or upholds and only AC-1
  is reworked, its failing capsule promoted to the RED.

  Retained (T-25): capsule integrity is a hard safety and evidence gate. A
  capsule's files are test paths inside the node's module and fence, never
  read through a link, bounded, and free of credentials, the controller key,
  literal capabilities and prompt delimiters. Its archive is immutable and
  bound by hash in a registry only the claim's capability holder writes.
  Stale (a rebased order, another claim, a late reuse) is administrative and
  uncharged; forged or tampered fails closed. Feature verify checks every
  cited capsule, and `capsule verify --replay` runs each again, on a fresh
  checkout of its base (and a promoted RED's on its integrated head).

- **T-26** carried proofs of a node reopened by an upstream's rework. r17's
  cli, reopened by QA's rework of apply-release-plan, could not cite AC-4's
  carried proof and asked a person. What its last generation settled as
  carried is now offered again (`carried_criteria`) and revalidated at
  settle by the fresh verification.

- **T-21** the generation's RED, per criterion. Each criterion a settlement
  accepts gets an immutable completion record (`criterion_ledger`,
  `src/engine/criterion-ledger.ts`). It is hash-bound to the order revision,
  repository base and head, production delta, the RED (archived), the proof,
  the settlement and its lineage. A review order that names a completed
  criterion again carries its completed proof as re-provable
  (`rework.completed_criteria`). The review's reproduction passing on the
  unchanged base is its re-proof: never a RED, never committed. With the
  completed proof cited exactly as given, it proves the criterion DONE. A
  generation with no RED cycle and no production change stands on the
  attested RED of a completion it carries. Compatibility work alone needs
  none. A refused, all-passing red run never displaces the generation's RED.
  A gate that the controller's own judged record cannot enter is held
  uncharged (`SETTLE_GATE_STATE`), and administrative fingerprints are never
  counted, so they can never park a node. A challenge beside a compatibility
  unit binds with its focused test kept out of the branch. Tests:
  `tests/unit/criterion-ledger.test.ts`,
  `tests/integration/criterion-carry.test.ts` (r16's own answer, the
  re-proof as v2 and v1, every crash boundary) and the model-free replay
  `tests/fixtures/cset203-r16-carry-e2e.test.ts`. The replay covers the
  concurrent commit, the lost reviewer, the sibling's withdrawn challenge, a
  restarted continuation, duplicate and stale replays, the late defect and
  C002, trusted and verified, with the teammate's commit kept.

  Retained (T-22, T-23): a completion is carried only after it is
  revalidated on the claim's base before any worker runs. The record must be
  intact, its work in the base, its test unchanged and its fix present. A
  fix someone else changed holds only while its test passes on the base (one
  module run). What fails is reopened alone, ordered by its own RED and
  uncharged. At settle, a carried proof that the base no longer holds, and
  that the worker never touched, reopens the criterion and hands the claim
  back unspent. One the worker broke is charged as before. A re-proof
  without its completed proof (or the reverse) is held for correction,
  uncharged. Production code behind a carried proof is refused
  (`CRITERIA_PRODUCTION_UNDRIVEN`). Feature verify reports a tampered ledger.

- **T-19** per-criterion outcomes. A result at `schema_version` 2 with
  outcome `CRITERIA` answers each criterion of the order exactly once:
  DONE, REVIEW_GAP_CHALLENGE, or BLOCKED/NEEDS_DECISION with its own reason.
  Settle judges each one against the same claim, order, revision and base.
  The DONE work is integrated as the node's new generation. The challenged
  criterion keeps its prior proof, revalidated, and is recorded as one
  challenge. Unresolved criteria are ordered again on their own and parked
  with their reasons, at no attempt or criterion budget. The refinement
  orders only the challenged criterion again; WITHDRAW keeps what the node
  completed. One execution is one product attempt. A crash at any boundary
  is finished once by dispatch. An answer bound to a stale revision is
  reconciled, and a late one changes nothing. Tests:
  `tests/integration/criterion-outcomes.test.ts` and the model-free
  replay `tests/fixtures/cset203-r15-partial-e2e.test.ts`, both to
  delivery.

  Nothing about ownership, secrets or evidence was relaxed (T-20). A DONE
  criterion still needs its own RED binding (or compatibility unit) and
  fresh verification. A passing test is never a RED, and a failing test is
  never a challenge. One test serves two criteria only when each traces its
  own clauses to its assertion lines. A production change only the
  challenged criterion could need is refused with the challenge. Scalar
  results (version 1) are judged exactly as before, including the legacy
  challenge of a subset of the order.

  Residual: one test traced to clauses of two criteria proves both whenever
  the test failed in RED. Mycelink does not attribute a failing test's
  failure to individual assertions. The acceptance review judges what each
  clause asserts.

- **T-08** WORKER_RUNNING. A settle while the worker's Agent task has not
  completed, with an empty slot, settles, writes and charges nothing. It
  applies only on positive evidence: the fence's launch record, the host
  transcript showing that call without a completion, a live host (when the
  hook could name it) and the session wall-clock not yet past. Anything else
  is judged as before, so a completed worker that wrote nothing is still
  RESULT_MISSING. Test: `tests/integration/worker-running.test.ts`.
- **T-14** Integration-lock contention is held as PRECONDITION_FAILED and
  the next dispatch finishes the sealed settlement. Same test file.
- **B-05** Overlap is no cause (CSET-202 final). The r15 relaxation covered
  a bare `sleep N` proved by the host's transcript, and only at the
  settlement. CSET-202's host waited in `sleep 100; echo waiting`, and the
  live check, which never applied even that, stopped the task session and
  its corrective session for the identical "moved from nothing to nothing":
  an overconstraint, and a transport false positive of the transaction, not
  a controller act. Now each call of a stash transition's window is placed in
  the session's causal tree, read from its own stream (`lib/causal.mjs`
  streamTree: `parent_tool_use_id`, the Agent call's task, SendMessage
  resumes) and agreeing with its hook record, binding and Claude Code's own
  transcript (`agentId`, `attributionAgent`). A host call counts as a cause
  only when what it runs may change anything (shellEffects, read as its
  shell runs it): waiting, printing, testing, reading files and read-only git
  change nothing, whatever they overlap or whatever words they print. A
  summary names a transient entry ("moved from nothing through <entry> to
  nothing"). Tests: `tests/benchmark/controller-shared-git.test.ts` (the
  exact two-worker shape with live checks, a wait outlasting its worker, a
  compaction, a restart, a SendMessage resume),
  `tests/benchmark/causal-provenance.test.ts`,
  `tests/benchmark/controller-rollback.test.ts` (the same shape end to end to
  C001, and across a restart and a compaction).
- **P-02 / P-04 / P-07 / P-08** project-hook fixes, in
  `tests/integration/project-hook-freedom.test.ts`. The parsed P-04 guard is
  also *stricter*: it catches `git -C . push` and `bash -c 'git push'`.
- Case-specific narratives removed from model-facing text.

Retained deliberately:

- **F-12** controller scratch files inside a workspace. The refusal is
  cheap. Relaxing it in the fence alone would turn it into a benchmark
  controller-violation rollback.
- **P-09** task-list items must name a node. This is an explicitly tested
  design rule. I did not re-verify that Claude Code event's semantics here,
  so I recommend making it advisory rather than removing it.
- **T-15** INTEGRATION_BRANCH_MOVED is still charged. It may signal
  tampering, and holding it would loop.
- **T-16** unclassified exceptions on the adapter (`claude -p`) path are
  still charged. The benchmark does not use this path.
- **F-10 / T-01** test-first commit discipline. The public case prompts
  require it and the independent replay judges the same. Reordering through
  rebase or reset is free.
- **B-11** causal provenance stays a hard safety: a stash transition is a
  worker's only when the stream, the hooks and Claude Code's records agree
  on its call, the entry was made on the worker's branch by a `git stash
  push` that call ran in its own worktree (each command counted once), and a
  dropped entry was its own, taken by its own pop or drop. A host command
  that runs git stash however it is wrapped (a shell, `eval`, an alias, a
  build tool), a call no stream shows or shows otherwise, a forged nested
  transcript, parent id or start record, a late child (after its subagent
  stopped, with no resume), an unbound worker, or a rival worker's command
  that may have made it fails the transition closed. If both a host call and
  a worker may have made it, it is the controller's.
- **B-12** a check while the session runs stops it only for the controller's
  own hand. A call the stream does not show yet, or a worker's stash its
  commands do not establish, waits for the settlement, which fails closed on
  anything not attributed. Every rollback archives each stash entry it takes
  out under `refs/mycelink/archive/`, so approved progress is never lost; the
  user's entries go back byte for byte.

Residual risks, all under-constraints and none an overconstraint:
worktrees share refs, so a worker could move another branch from its own
worktree; a worker could write a sibling worktree. Settle and delivery judge
each node's own delta and the base heads. Neither has been observed. The
causal tree trusts the session's stream: a controller with code execution
that wrote into Claude Code's own stdout could forge lines, which must still
agree with the hooks' records, the binding and the subagent's transcript. A
read-only git command can run a program its configuration names (fsmonitor,
a diff driver, a pager): a configuration changed in the workspace is itself a
violation, one in the session HOME is outside the transaction. A worker
program that stashes with no visible command fails closed (B-11); another
worker's opaque program stashing beside a worker's own push is caught only by
the per-command count.

## Go / no-go for the PCM-101 rerun

**GO.** PCM-101 final ran trusted with no controller violation. Its stop
was an overconstraint of the evidence gate's own making (T-35): both Java
producers proved their criteria with a valid RED, GREEN and full regression,
but `declares` compared a JUnit report's `pkg.Class#method` with the bare
methods the Java reader declares, as strings, so no Java test could ever be
declared. A test is now its normalised source path and its runner's key,
resolved against the submitted head (T-36): for JUnit the method, its class
and package kept as raw evidence and checked to be the file's own; nested
classes, overloads and parameterized invocations told apart by what the
report names; a wrong or ambiguous reference still CRITERION_TEST_UNKNOWN;
JS unchanged. Evidence published before identities is accepted only by the
same path and an unambiguous declaration, with an immutable alias receipt.
A refusal the old comparison made is re-evaluated administratively, once,
from the exact captured answer (T-37). The run's own evidence is accepted
when replayed; its exact copied end state recovers model-free to C001,
nothing charged or dispatched, and the benchmark's verifier accepts that
delivery in every section.

Stop the rerun and investigate if a Java criterion whose test the head
declares is refused CRITERION_TEST_UNKNOWN or a worker answers BLOCKED on
such a refusal; if a criterion is accepted by a test of another class,
file, module, overload or nested class; if an identity re-evaluation charges
an attempt, dispatches a worker, asks for a correction or settles an answer
twice; or if a JS criterion is judged differently than before.

## Go / no-go for the CSET-201 rerun

**GO.** CSET-201 final ran trusted with no controller violation. Its stop
was an overconstraint: R003's materially new AC-2 gap was exhausted solely
because the per-criterion count was 2, after both earlier AC-2 reworks had
settled with a RED and a production change (T-30); and a settled producer's
proof was lost because a re-proof was never in the product (T-31). The
count is now a budget: past it a gap is reworked on verified producer
progress, up to an emergency ceiling (default 6) where a person decides;
what stops a review is a duplicate or no-progress loop, an oscillating
restoration, the session or wall-clock budget or a trust failure. Every
settled proof is in the authoritative head: re-proofs are committed as
test-only units, an integration never loses a sibling's standing proof
(T-32), a stale RED is no proof (T-33), and a lost proof is restored before
any reviewer runs (T-34). The exact shape is replayed model-free to C001,
test-first, nothing charged.

Stop the rerun and investigate if a materially new gap with verified
producer progress is exhausted below the ceiling, or a person is asked
before it; if an integrated head loses a completed producer's test or
production change, or a re-proof a review passed on is not in the next
reviewed head; if a duplicate gap whose fix lost its proof is dropped as a
duplicate; or if SIBLING_PROGRESS_LOST or a restoration charges an attempt
or spends a criterion's budget before its bound.

## Go / no-go for the next CSET-202 rerun (kept as recorded)

**GO.** The CSET-202 rerun ran trusted with no controller violation. Its stop
was an evidence-storage overwrite answered by a product rework (T-27), not a
product failure. The exact generation (two red gates in one claim, a
re-proof, R002 PASS, C001) is replayed model-free to delivery, both with
immutable evidence (nothing to repair) and from the state an earlier release
left (repaired from the red gate's own snapshot, the same candidate, R002
still binding, nothing reopened, rerun, charged or asked). The rerun's own
state is repaired on a copy with the original read-only, and the state at
the refusal, rebuilt from the run's provenance store, verifies C001 after
the repair. Tampering stays refused (T-28, T-29).

Stop the rerun and investigate if a delivery refusal for an evidence pointer
is answered by a product rework, or a worker is asked to reproduce a RED on
code that already holds the behaviour; if a record's output, results or
history is overwritten after it was recorded, or two records name one path
with two hashes; if a repair takes bytes from an archive of another node,
generation, claim, base or module, or follows a link; or if an evidence
repair reopens a node, charges an attempt, moves the orchestration epoch or
invalidates a review PASS.

## Go / no-go for the CSET-202 rerun (kept as recorded)

**GO.** CSET-202 final ran trusted. Its stop was a transport false positive
of the controller transaction (B-05), not a product or controller failure,
and nothing was charged. The exact shape — a host waiting in `sleep 100; echo
waiting` beside two workers' push, gate, test commit and pop — is replayed
model-free with live checks: nothing stops the session, every node settles
DONE, the session settles clean, and the run delivers C001; a restart and a
compaction the same. The controller's own stash, forged transcripts and
parent ids, sibling and late-child stashes still roll back, the user's stash
byte for byte, every entry taken out archived.

Stop the rerun and investigate if a with-arm session is stopped or rolled
back for a stash change whose overlapping host calls only waited, printed or
read; if a stash change is attributed to a worker while a host call that may
change anything ran in the same window; or if a rollback leaves an entry it
took out unarchived, or changes a pre-existing entry's reflog bytes.

## Go / no-go for r18

**GO.** r17 ran trusted, and every fault was handled. Its stop (T-24) was an
uncheckable uncommitted reproduction, not a product failure. It is fixed and
replayed model-free through the late defect to C002 both ways, with nothing
charged for any challenge and both teammate commits kept. Capsule integrity
(T-25) is a new hard gate; ownership, TDD history and evidence are unchanged.

Stop r18 and investigate if a worker answers BLOCKED for a passing
reproduction it could have sealed and is charged for it; if a passing capsule
settles a criterion DONE, or a failing one is accepted without its committed
red gate; or if a capsule of another claim, revision or base is accepted, or
a capsule's files reach the product branch through a challenge.

## Go / no-go for r17

**GO.** r16 ran trusted, and every fault was handled. Its stop (T-21) was
administrative. It is fixed and replayed model-free through the late defect
to C002. AC-3 is completed by one RED and only carried after it, with
nothing charged for the carry. A conflicting teammate edit reopens only the
criterion it breaks. Ownership, TDD history and evidence integrity are
unchanged or stricter (T-22, T-23).

Stop r17 and investigate if a passing red gate or a carried completion is
charged, or an administrative fingerprint parks a node; if a completion is
carried whose test fails, or whose fix is gone, on the new head; or if a
production change settles behind a carried proof without its own RED.

## Go / no-go for r16

**GO.** The r15 history shows the gates held. T-19 is fixed and replayed
model-free to an accepted delivery: AC-3 DONE, AC-4 challenged and
withdrawn (or refined and reworked alone), AC-5 DONE, then R002 PASS and
C001. No person was asked, and only product attempts were counted.

## Go / no-go for r15 (kept as recorded)

**GO**, with one caveat.

- No case-specific branch in plugin core code, and no case narrative in
  model-facing text.
- In all six public PRDs, the freedom envelope is allowed and every hard
  invariant is refused.
- Worker running, provider, stale-order, challenge-conversion, unproven
  correction, infrastructure, integration-lock and reviewer-transport states
  charge no product attempt.
- The targeted suites, six-case drift, typecheck, build and strict
  validation pass (below).

Caveat: the benchmark attribution change (B-05) and T-08 have not been run
under the Linux bubblewrap real-shape tests. Run
`tests/benchmark/controller-shared-git.test.ts` and one real shape there
before, or alongside, r15.

Stop r15 and investigate if:

- a with-arm session is rolled back for a stash change whose overlapping
  host call was not a bare sleep;
- a settle reports RESULT_MISSING while its worker's completion notification
  is absent;
- a controller-violation names a document the controller legitimately
  authored.

## Verification

Before the PCM-101 rerun (T-35–T-37), model-free only:

- Windows: unit and security (with the six-PRD envelope) 87 files; all 76
  integration files in three chunks; all 24 fixture files (the PCM-101
  identity e2e among them: the repaired flow, an identity-only BLOCKED
  answer, the exact end state reconciled to C001, and a kill at each of four
  re-evaluation boundaries); release and plugin-e2e; all 52 benchmark files
  in four chunks.
- WSL (a clean checkout of the base with the change applied): typecheck,
  unit and security, the identity, criterion, sibling, capsule, challenge
  and resume integration suites, the PCM-101, CSET-201, CSET-202 and r17
  fixtures, and all 52 benchmark files in two chunks.
- The exact copied PCM-101 final end state, inside bubblewrap at the run's
  own path with the original hidden: dispatch reopened visits from its
  captured answer and re-evaluated the gateway's hold (attempts 1 each, no
  worker ticket or correction, every old Java id aliased), both
  compatibility verifications, the review and C001 passed and C001 was
  delivered; the benchmark's verifier (suite pinned at the base, the
  repaired package) accepted it in every section, hidden acceptance and the
  test-first replay included. The original run is byte-for-byte unchanged.

Windows, foreground, bounded:

- `node scripts/constraint-audit.mjs --check`
- typecheck
- `npm run build:check`
- `npm run bench:cases:check` (six cases, no drift)
- `claude plugin validate --strict .`
- The targeted policy/fence/security/integration suites
- The model-free fixtures (`tests/fixtures`)
- The six-PRD manifest, case and replay suites

The Linux bubblewrap and real-source tests were not run for the r15 audit.

Before r16 (T-19, T-20), model-free only:

- Windows: unit and security (with the six-PRD envelope), 1152 passed and 1
  skipped. All 68 integration files passed in three chunks, 594 tests, the
  17 per-criterion scenarios among them. Fixtures and release: 156 passed,
  1 skipped. Plugin-e2e: 21. Benchmark without arms: 616 passed, 22
  skipped. Arms: 35, in chunks.
- Typecheck, a reproducible `build:check`, six-case drift `[]`,
  `claude plugin validate --strict` and `constraint-audit --check` all
  pass.
- WSL with bubblewrap: the targeted per-criterion, envelope and revision
  suites, 48. The review, challenge, convergence, resume, compatibility and
  correction integration suites, 58. Benchmark without arms: 626 passed, 12
  skipped.
- Real Changesets source under bubblewrap: the r6 shape (a challenge, its
  refinement and the rework to C001, accepted by the verifier) and the
  r3 review shape both pass.

Before r17 (T-21–T-23, `c71631f`), model-free only:

- Windows: unit 787 passed, 1 skipped. Security and release (with the
  six-PRD envelope) 457 passed, 1 skipped. All 69 integration files passed
  in nine chunks, the 9 carry scenarios among them. Fixtures: 21 files, 79
  tests, the r16 fault replay and the conflicting-edit case among them.
  Plugin-e2e: 21. Benchmark without arms: 613 passed, 22 skipped, and
  `reviewer-await` (a known load flake) passed alone. Arms: 35, in five
  chunks.
- Typecheck, a reproducible `build:check`, six-case drift `[]`,
  `claude plugin validate --strict` and `constraint-audit --check` all
  pass.
- WSL with bubblewrap: the ledger, carry, r16 replay and envelope suites,
  29. The outcome, generation, challenge, revision, compatibility, resume,
  provider and epoch integration suites, 83. Benchmark without arms: 626
  passed, 12 skipped.
- Real Changesets source under bubblewrap: the r6 shape passes (559 s;
  C001 accepted by the verifier). The CSET-202 real shape with a fault plan
  (late defect) was not completed. It runs past the 10-minute foreground
  bound, and background runs were out of scope.

Before r18 (T-24–T-26, on `b72a9ba`), model-free only:

- Windows: unit and security (with the six-PRD envelope) 1182 passed, 1
  skipped. All 70 integration files passed in four chunks, the 11 capsule
  scenarios among them. Fixtures: 21 files, 79 tests, both r17 fault replays
  (withdraw/refine and uphold with a failing capsule promoted) to C002
  among them. Release and plugin-e2e: 102 passed, 1 skipped. Benchmark: 641
  passed, 22 skipped, and `reviewer-await` (the known load flake) passed
  alone.
- Typecheck, `build:check`, six-case drift `[]`, `claude plugin validate
  --strict` and `constraint-audit --check` all pass.
- WSL with bubblewrap: the capsule, r17 and r16 replay, challenge, carry,
  outcome and revision suites, 82. Benchmark: 660 passed, 13 skipped.
- Real Changesets source under bubblewrap: the r6 challenge shape passes
  (559 s; C001 accepted by the verifier). No real late-defect shape fits the
  10-minute foreground bound (the CSET-202 fault shape runs past it); the
  late defect is covered by the model-free r17 replays.

Before the CSET-202 rerun (B-05 generalised, B-11, B-12, on `a67b6cb`),
model-free only:

- Windows: the causal and shared-Git suites, 39 (the exact two-worker
  CSET-202 shape with live checks, a wait outlasting its worker, a
  compaction, a restart, a SendMessage resume, every security case). The
  rollback suite, 18, the CSET-202 shape end to end to C001 and across a
  restart and a compaction among them. Arms: 35, in chunks. The rest of the
  benchmark passed; `reviewer-await` (the known load flake) passed alone.
  Unit, security (with the six-PRD envelope, 630 calls) and the worker
  lifecycle and stash integration suites: 1193 passed, 1 skipped.
- Typecheck, `build:check`, six-case drift `[]`, `claude plugin validate
  --strict` and `constraint-audit --check` all pass.
- WSL with bubblewrap: the causal, shared-Git, transaction, envelope and
  audit suites, 72. The rollback suite, 18. Benchmark without arms: 567
  passed, 1 skipped, in two chunks. Arms: 35, in three chunks.
- CSET-202 final's own evidence, re-judged read-only under bubblewrap (the
  run directory mounted read-only and checked unchanged): both settlements
  attribute every push and pop to its worker with nothing unauthorised, and
  the two live checks that stopped the task and the corrective session
  stop nothing.

Before the next CSET-202 rerun (T-27–T-29, on `3a10e65`), model-free only:

- Windows, foreground, in chunks: unit and security (with the six-PRD
  envelope) 1195 passed, 1 skipped; all 73 integration files; fixtures 22
  files, 81 tests (the CSET-202 replay both ways among them); release and
  plugin-e2e 102 passed, 1 skipped; benchmark (the rollback suite in four
  runs) and arms 35.
- Typecheck, `build:check`, six-case drift `[]`, `claude plugin validate
  --strict` and `constraint-audit --check` all pass.
- WSL: unit and security 1192 passed, 4 skipped; fixtures 81; integration
  630 passed, 3 skipped, and one failure that fails identically on the
  unchanged base (`verification-node.test.ts`, the repeated-failure case: a
  Linux checkout path in an extensionless verifier's output is not
  normalised out of its fingerprint); benchmark 649 passed; arms 34, 1
  skipped.
- The CSET-202 rerun's own state, under bubblewrap with the run directory
  mounted read-only and checked unchanged
  (`tests/benchmark/cset202-rerun-evidence.test.ts`,
  `MYCELINK_CSET202_RERUN`): the state as the run left it repaired on a
  copy, once; and the state at the refusal, rebuilt from the run's
  provenance store, reproduces the refusal, then `deliver` repairs the
  pointers itself and delivers C001, accepted by the repository's full suite
  on a clean checkout set up offline from the run's store.
