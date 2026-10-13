# Mycelink multi-repository plugin evaluation — 2026-10-06 pilot

Machine-readable companion: [`2026-10-06-multimodule-plugin-eval-summary.json`](2026-10-06-multimodule-plugin-eval-summary.json).
Suite: [`evals-multimodule/`](../../evals-multimodule/README.md) at commit `531a8bf`.

## Verdict

**Mycelink 0.2.0-beta.1 is not reliable for perfect end-to-end completion in
these scenarios, and in this pilot it did worse than Claude Code without
the plugin.**

With Mycelink use required, the independent verifier found:

| | WITH Mycelink | WITHOUT (direct Claude) |
|---|---|---|
| Completion (feature delivered, committed, trusted acceptance re-run passes) | **1/3** | **3/3** |
| Valid Mycelink orchestration | **0/3** | not applicable |
| Full Mycelink success (completion **and** valid orchestration) | **0/3** | not applicable |

This is a pilot with **n = 1 run per case per arm**. It is not statistically
significant. It does show specific, reproducible defects (see
[Defect priorities](#defect-priorities)), and a 0/3 full-success result is
enough to rule out calling the current release reliable.

> **Correction (2026-10-06, after a read-only trace and source review).** An
> earlier version of this report said that `mycelink orchestrate run` was
> never invoked. That was wrong. The session traces show `orchestrate run`
> was **attempted in all three WITH sessions**: twice in existing-cold, once
> in existing-informed and once in greenfield. Every attempt stopped with
> `stop: BLOCKED`. The raw grader value `mycelink-orchestrate-run = false`
> is kept unchanged below. It means the grader found **no recognized
> successful invocation**. It does not mean nobody tried. The workers never
> ran because the worker process could not be spawned (see
> [Root-cause review](#root-cause-review-trace-and-source)).

## What was evaluated

Three `claude plugin eval` cases. Each uses a scaffolded Ledgerline workspace:
a `platform/` coordination repository plus four Git module repositories
(`core`, `api`, `worker`, `cli`). The QA acceptance suite has 23 black-box
tests.

| Case | Scenario | Task |
|---|---|---|
| `existing-refunds-cold` | existing-cold | Add partial refunds (LEDGER-142) to an existing codebase, with no project knowledge docs |
| `existing-refunds-informed` | existing-informed | Same as cold, plus accurate knowledge docs (`CLAUDE.md`, `platform/docs/*`). The module repositories are identical to cold. |
| `greenfield-refunds` | greenfield | Build the Ledgerline MVP (LEDGER-100) from empty module repositories |

Environment (from evidence): WSL, `linux-x64`, Node `v22.12.0`, Claude Code
`2.1.290`, model `sonnet`, plugin `mycelink` `0.2.0-beta.1`, ablation
`with-without`, pass threshold `1`, concurrency `1`.

### Two independent measurements

1. **Claude plugin eval score.** The weighted grader score from `claude plugin
   eval` (16 scored weight points: acceptance verdict and suite integrity,
   23/23 TAP, clean commits in all four modules, report file, summary
   graders, and an LLM-judged honesty check). A run "passes" only at score
   1.0. Mycelink activation indicators are recorded as `withOnly` graders
   but are **not scored**, so a WITH run can score 1.0 without any valid
   Mycelink orchestration.
2. **Independent verifier** (`evals-multimodule/tools/verify-workspace.mjs`,
   schema `ledgerline-eval-aggregate-verification/1`, v1.0.0). It inspects
   each kept workspace after the run. It re-runs the pristine acceptance
   suite against the committed HEADs and checks history preservation,
   uncommitted code, per-module test growth, and reporting. For WITH runs
   (`--require-mycelink`) it also checks Mycelink state: node states, evidence
   files on disk, `feature verify`, `candidate verify`, candidate == delivery,
   leases, sessions, and worker usage.

The verifier is the authority on whether the work was actually completed and
whether Mycelink actually orchestrated it.

## Stage 1 — initial neutral pilot (invalid as plugin evidence)

The first WSL pilot used prompts **without** any instruction to use
Mycelink. It started `2026-10-06T03:10:59Z`, ran for 1376 s, and cost
$5.1239848 at top level.

| Case | WITH score | WITHOUT score | WITH turns / cost / s | WITHOUT turns / cost / s |
|---|---|---|---|---|
| existing-refunds-cold | 1.0 | 1.0 | 18 / $0.6427 / 132 | 16 / $0.5734 / 134 |
| existing-refunds-informed | 1.0 | 1.0 | 19 / $0.6723 / 151 | 20 / $0.7323 / 141 |
| greenfield-refunds | 1.0 | 1.0 | 16 / $1.0630 / 317 | 22 / $1.4404 / 501 |

- Functional passes: **6/6** (plugin-eval `overallScore` 1, `meanDelta` 0).
- Mycelink activation in the WITH arm: **0/3**. All six indicators were false
  in every WITH run: Skill called 0×, the Mycelink launcher called 0×, and no
  `mycelink.config.json`, `STATE.json` or candidate was created.

**Conclusion:** both arms measured Claude alone. The Δ of 0 says nothing
about Mycelink, so this stage is **invalid as plugin evidence**. It was not
independently verified. It led to the availability-conditional prompt
instruction added in `531a8bf`.

## Stage 2 — forced conditional-use pilot (Mycelink genuinely activated)

Every prompt now contains the same sentence: *"If the Mycelink plugin is
available, you must use it to coordinate and deliver the work; if it is not
available, proceed directly without it."*

- Started `2026-10-06T05:20:27Z`. Duration **1509 s**. Top-level cost
  **$5.5405246**.
- Model-free self-test (`tools/selftest.mjs`): **81/81 passed**, 0 failed.
- Activation: in **3/3** WITH runs the Mycelink skill was invoked and the
  controller was used. A control plane and feature `STATE.json` were created
  each time.

### Activation indicators (WITH arm, unscored)

| Indicator | cold | informed | greenfield |
|---|---|---|---|
| `mycelink-skill-invoked` | ✅ Skill 6× | ✅ Skill 6× | ✅ Skill 4× |
| `mycelink-controller-used` | ✅ 29 launcher calls | ✅ 8 | ✅ 15 |
| `mycelink-orchestrate-run` (raw grader) | ❌ 0× | ❌ 0× | ❌ 0× |
| `orchestrate run` attempts in trace (not graded) | 2, each `BLOCKED` | 1, `BLOCKED` | 1, `BLOCKED` |
| `mycelink-control-plane-created` | ✅ | ✅ | ✅ |
| `mycelink-feature-state-recorded` | ✅ | ✅ | ✅ |
| `mycelink-candidate-created` | ✅ | ❌ | ❌ |

The raw `mycelink-orchestrate-run` grader reads 0× in every WITH run. The
trace row shows that this does not mean "not attempted". Every attempt
returned `BLOCKED`, so none counted as a recognized successful invocation.

### Per-case results

| Case | Arm | Plugin-eval score | Plugin-eval pass | Turns | Cost (USD) | Duration (s) | Verifier completion | Verifier orchestration |
|---|---|---|---|---|---|---|---|---|
| existing-refunds-cold | WITH | **1.0** | yes | 76 | 2.1394258 | 417 | ✅ | ❌ |
| existing-refunds-cold | WITHOUT | **1.0** | yes | 15 | 0.5910814 | 138 | ✅ | n/a |
| existing-refunds-informed | WITH | **0.125** | no | 29 | 0.4548928 | 104 | ❌ | ❌ |
| existing-refunds-informed | WITHOUT | **0.9375** | no | 18 | 0.5962208 | 133 | ✅ | n/a |
| greenfield-refunds | WITH | **0.125** | no | 11 | 0.5972864 | 154 | ❌ | ❌ |
| greenfield-refunds | WITHOUT | **1.0** | yes | 26 | 1.1616174 | 563 | ✅ | n/a |

Plugin-eval aggregates: `overallScore` 0.4167, `overallPassRate` 0.3333
(1/3 cases passed), `meanDelta` −0.5625. Per-case Δ: cold 0, informed
−0.8125, greenfield −0.875.

Arm totals: WITH 116 turns, $3.191605, 675 s. WITHOUT 59 turns, $2.3489196,
834 s.

Notes on the plugin-eval score:

- *informed WITHOUT (0.9375)*: every objective grader passed, and the
  verifier confirmed completion. The run lost only the LLM-judged
  `honest-completion-claim` (judge votes FAIL FAIL FAIL), which put its
  plugin-eval pass rate at 0. The verifier does not judge the final message.
- *informed WITH and greenfield WITH (0.125)*: each kept only
  `did-not-read-reference-solution` and `summary-lists-delivered-commits`
  (2/16). The second grader passed even though no commits were delivered,
  because it only matches four hex strings in the final message. This is a
  weak grader (see eval-side items below).

### Independent verifier findings (WITH arm)

**existing-refunds-cold WITH: functionality delivered, orchestration invalid.**

- Completion ✅. Trusted acceptance re-run PASS **23/23**. All module suites
  pass (core 21, api 20, worker 11, cli 10). One clean commit on top of the
  preserved baseline in each of the four modules. The in-run report matches
  the delivered HEADs.
- Orchestration ❌:
  - `mycelink orchestrate run` was attempted twice. Both attempts stopped
    `BLOCKED` because the worker process could not be spawned. The raw grader
    still reads 0×, meaning no recognized successful invocation. The session
    then progressed the nodes by hand with CLI primitives and wrote the code
    itself.
  - Implementation nodes were left at `REGRESSION_VERIFIED`, not `DONE`
    (`LEDGER-142.{core.refund-defs,api.refunds,worker.settle,cli.refunds}.impl`).
    The candidate node `LEDGER-142.release.candidate.build` was `INVALIDATED`.
    No CLI primitive can move a node from `REGRESSION_VERIFIED` to `DONE`;
    only the orchestrator's `runNode` path does that (root cause A4).
  - `evidence-files`: 12 evidence records exist, but their red / green /
    regression outputs are missing on disk for all four implementation
    nodes. The records store absolute output paths, which no longer resolve
    once the run's workspace is sealed and kept (root cause A5).
  - `feature verify` failed with `NODE_NOT_DONE` for all five nodes, even
    though the feature state reads `CANDIDATE_READY`.
  - `candidate verify` failed with `CONTROL_SHA_DRIFT`: "Control repository
    is at f7b415fed680…, candidate bound 52774685cee6…". Candidate
    `LEDGER-142-C001` does bind all four modules at exactly the delivered
    SHAs. The candidate pins the control-repository HEAD and then keeps its
    state in that same repository, so committing that state moves HEAD away
    from the pin (root cause A6).
  - Leases empty; 4 sessions, 0 live; control repository clean.

**existing-refunds-informed WITH: not completed, no valid candidate.**

- `orchestrate run` was attempted once and stopped `BLOCKED`. Node states:
  `LEDGER-142.core.refund-definitions.impl=BLOCKED` (worker spawn failed
  twice with the same fingerprint). The other four nodes stayed `PLANNED`. Feature state `RUNNING`, current candidate
  *(none)*, 0 evidence records.
- `module-changed`: 0 commits on top of the baseline in all four modules.
- Trusted acceptance re-run: **FAIL — acceptance: 16 failing of 23**. That is
  the untouched baseline: 7/23, the same as the self-test's baseline. No
  module tests were added, and `ledger-core` is still 1.4.0 (AC-11 requires a
  new minor release).
- The in-run acceptance report was never written. The control repository
  has 31 uncommitted paths. `mycelink init` writes no `.gitignore` for the
  `.mycelink/` runtime directory, although the test fixtures add one
  (root cause A7).

**greenfield-refunds WITH: not completed, no valid candidate.**

- `orchestrate run` was attempted once and stopped `BLOCKED`. Node states:
  `LEDGER-100.core.storage.impl=BLOCKED` (worker spawn failed twice with the
  same fingerprint). The other seven nodes stayed `PLANNED`. Feature state `RUNNING`, current candidate *(none)*,
  0 evidence records.
- `module-changed`: 0 commits in all four modules.
- Trusted acceptance re-run: **FAIL — every module "has no passing tests of
  its own"; acceptance: 23 failing of 23**.
- The in-run acceptance report was never written.

All three WITHOUT runs: verifier `ok`, completion ✅, 23/23 acceptance, one
clean commit per module, and more module tests than at baseline.

## Cost accounting and worker dispatch

- The top-level eval cost ($5.5405246) is the sum of the six agent runs'
  `costUsd`. LLM-judge cost is listed separately per run (about $0.017 in
  total). The harness **does not include nested `claude -p` worker sessions**
  that Mycelink spawns, so in a working orchestration the true WITH cost
  would be higher than reported.
- In these runs, the verifier read Mycelink's own usage ledger and found
  **0 model turns, 0 input tokens and 0 output tokens** in every WITH
  workspace (sessions recorded: 4 / 2 / 2; wall clock 42 / 21 / 19 ms). The
  self-test shows that this accounting path does report non-zero usage when
  a (fake) Claude worker actually runs (`model_turns 12`,
  `input_tokens 1200`, `output_tokens 600`).
- **The zero tokens are explained by worker spawn failure**, not by a
  missing `orchestrate run` call. Each orchestrated attempt claimed a node
  and tried to spawn the worker executable. The spawn failed at once, the
  adapter recorded a failed session (`SPAWN_FAILED`), and no model turn ran.
  The recorded session counts match this: 4 sessions in existing-cold (two
  `orchestrate run` attempts × two node attempts each), and 2 each in
  existing-informed and greenfield. Total wall clock was 19–42 ms.
- So **no model worker was ever dispatched successfully**. Whatever code
  was delivered (existing-cold WITH) was written by the top-level session.
  In this pilot, the WITH cost figures are therefore complete, not
  under-counted.

## Root-cause review (trace and source)

A read-only review compared the session traces with the Mycelink source at
`531a8bf`. No product code or eval behaviour was changed. Source locations
are repository-relative.

**Failure chain in all three WITH runs.** The session ran `orchestrate run`.
The orchestrator claimed the first ready node (`CLAIMED` increments
`attempts`, `src/state/transition.ts`) and tried to spawn the worker. The
spawn failed (`src/sessions/claude-cli-adapter.ts`: the child-process
`error` handler records `SPAWN_FAILED: <spawn error>` and settles the
session as `failed`). `failAttempt` recorded the failure fingerprint
(`src/engine/orchestrator.ts`). The second identical fingerprint reached
`max_same_failure` (default 2, `src/state/feature-state.ts`) and moved the
node to `BLOCKED` with reason *"Same failure fingerprint … reached the limit
of 2"* (`src/state/transition.ts`). With nothing else schedulable,
`runToCompletion` stopped with `stop_reason` `BLOCKED`. The human-readable
output of `orchestrate run` omits the per-node detail, so the
`SPAWN_FAILED` cause shows only with `--json`.

In existing-cold the session then drove the nodes by hand (`node claim`,
`tdd red/green/regression`, `node invalidate`, `candidate create`) and wrote
the code itself. In existing-informed and greenfield it stopped.

Confirmed root causes:

| ID | Class | Root cause | Source evidence |
|---|---|---|---|
| A1 | A | The worker executable is not visible to the controller, and `doctor` does not preflight it | Default `claude_executable: 'claude'` (`src/workspace/workspace.ts`) is resolved from the controller's `PATH` and spawned with `shell: false`; `doctor` (`src/cli/cli.ts`) only reports the adapter name |
| A2 | A | Infrastructure spawn errors consume node retries and `BLOCK` the node after two | `SPAWN_FAILED` goes through the same `failAttempt` → `recordFailure` path as a real worker failure; limit `max_same_failure: 2` |
| A3 | A | `node claim` bypasses readiness and dependency checks, and `BLOCKED` can be laundered through `INVALIDATED` | `node claim` calls `orchestrator.claim()` directly, not `src/scheduler/ready.ts`; `BLOCKED → INVALIDATED → READY` needs no justification, and entering `INVALIDATED` resets `attempts` and failure counts (`src/state/transition.ts`) |
| A4 | A/B | CLI primitives cannot move `REGRESSION_VERIFIED` to `DONE`; only `runNode` does | `REVIEW_VERIFIED`, `INTEGRATED` and `DONE` are set only inside the orchestrator (`advanceVerifiedGates`, `runNode`); the `tdd` commands stop at `REGRESSION_VERIFIED` |
| A5 | A | Absolute evidence paths break after the workspace is sealed | `src/evidence/runner.ts` stores resolved absolute `cwd` and `output_path`; `feature verify` checks `existsSync(record.output_path)` and reports `MISSING_OUTPUT` |
| A6 | A/B | The candidate pins control-repository HEAD, then Mycelink state is written into that same repository, so committing it causes self-drift | `src/git/candidate.ts` records `control_commit` as HEAD and writes the manifest into the tracked feature folder; `candidate verify` fails `CONTROL_SHA_DRIFT` once HEAD moves. Mycelink does not commit by itself, but the design tracks feature state, and committing that state moves HEAD |
| A7 | A | `init` omits the `.mycelink/` `.gitignore` entry that the tests add | `cmdInit` / `initControlRepo` write no `.gitignore`; `tests/helpers/portfolio-fixture.ts` and `tests/integration/readme-walkthrough.test.ts` add `.mycelink/` by hand; `candidate create` counts untracked files as dirty |
| A8 | A | Slash-command argument templates are off by one | `commands/*.md` use `$1` for the first argument and `$2` for the second (for example `commands/run.md`, `commands/cancel.md`, `commands/decision.md`), while Claude Code numbers positional arguments from `$0` |
| A9 | A/B | No base-branch delivery step | `src/git/integrate.ts` merges node branches only into `feature/<id>`; nothing in `src/` fast-forwards or merges into a module base branch, and `commands/run.md` ends at `feature verify` |

## Architecture assessment

**Category B: moderate workflow and interface redesign, plus category A
local defects. Not category C (fundamentally unsound).** The state machine,
evidence gates, candidate binding and verifier-side checks behaved as
designed: they refused to call invalid work done. The failures come from how
workers are dispatched in a sandboxed host, from CLI primitives that are
both too permissive and incomplete, and from where run state lives.

**Minimal A fixes** (local, each small):

- Preflight the worker executable in `doctor` and before the first claim
  (A1).
- Classify spawn and other infrastructure errors separately, so they do not
  consume node attempts or same-failure counts. Report them as environment
  errors (A2).
- Route `node claim` through the readiness check. Require a justification
  and keep the attempt history when a node leaves `BLOCKED` through
  `INVALIDATED` (A3).
- Store evidence paths relative to the control repository (A5).
- Write `.mycelink/` to `.gitignore` in `init` (A7).
- Fix the argument indices in `commands/*.md` (A8).
- Print the per-node `BLOCKED` detail in the human `orchestrate run` output.

**Key B redesign:**

- **R1: host-native worker dispatch.** Replace nested `claude -p` spawning
  with a dispatch *ticket* that the host session fulfils through its own
  Agent tool, followed by a *settle* command that ingests the result. An
  external worker daemon is the alternative. Either removes the dependency
  on a worker executable being visible inside the sandbox.
- **Role-scoped claim capabilities.** Separate controller, worker and
  verifier permissions, so a host session cannot hand-progress nodes past
  the gates. Give the legitimate path a complete set of transitions to
  `DONE` (A4).
- **State outside the pinned tree.** Keep run state outside the
  control-repository tree that the candidate pins, or bind the candidate to
  a content hash of its inputs instead of HEAD (A6).
- **Detached, durable runs.** Let a run outlive the host turn, and have the
  skill wait on or resume it instead of abandoning a `RUNNING` feature.
- **Delivery step.** Add an explicit, verified fast-forward or merge of the
  candidate into each module's base branch (A9).

**Outlook.** The following are judgements, not measurements:

- A-only fixes **cannot make nested workers work in the current sandbox**.
  They turn the failure into an early, clear and honest error, but the
  worker executable still cannot run there.
- A + R1 + delivery makes **3/3 plausible but unproven**. The estimate is
  about **50–65%** full Mycelink success after one or two iteration rounds.
  This percentage is an engineering judgement, not a measured rate. It
  needs a re-run with ≥ 10 runs per case per arm to confirm.

## Defect priorities

Ordered by impact on the end-to-end goal. Each item cites the evidence above.

| # | Priority | Defect | Root cause | Evidence | Suggested action |
|---|---|---|---|---|---|
| 1 | P0 | Workers are never dispatched in the sandbox: every `orchestrate run` attempt (4 in total) stopped `BLOCKED` on a worker spawn failure | A1, A2; needs R1 | Traces: cold 2, informed 1, greenfield 1 attempts, all `BLOCKED`; 0 worker tokens and turns; 4 / 2 / 2 failed sessions in 19–42 ms | Short term: preflight the worker in `doctor`, treat spawn errors as environment errors that do not consume attempts, and show the cause in human output. Real fix: host-native dispatch ticket/settle (R1) or an external daemon. |
| 2 | P0 | After `BLOCKED`, the session either stops with no code (informed, greenfield) or hand-progresses nodes outside orchestration (cold) | A3, A4; needs role-scoped capabilities and durable runs | informed and greenfield WITH: first node `BLOCKED`, rest `PLANNED`, 0 commits. cold WITH: nodes stuck at `REGRESSION_VERIFIED`, candidate node `INVALIDATED` | Route `claim` through readiness and stop `BLOCKED` laundering through `INVALIDATED`. Scope claim capabilities by role. Give the skill a documented recovery or an honest fallback, and never end the turn silently on a `RUNNING` / `BLOCKED` feature. |
| 3 | P1 | Candidate invalidated by control-repository self-drift | A6 | cold WITH: `CONTROL_SHA_DRIFT`, candidate node `INVALIDATED` | Keep run state outside the pinned tree, or bind the candidate to a content hash. Add a regression test for "commit control state after candidate build". |
| 4 | P1 | Evidence outputs missing at verification | A5 | cold WITH: 12 records, outputs missing for all four implementation nodes | Store repository-relative evidence paths. Gate `CANDIDATE_READY` on `feature verify`. |
| 5 | P1 | Control repository left dirty | A7 | informed WITH: 31 uncommitted control-repo paths | Have `init` write `.mycelink/` to `.gitignore`, as the test fixtures do. |
| 6 | P1 | No delivery to module base branches | A9 | Source: integration stops at `feature/<id>`; `commands/run.md` ends at `feature verify` | Add a verified delivery step: fast-forward or merge the candidate into each base branch. |
| 7 | P2 | Slash-command arguments off by one | A8 | `commands/*.md` use `$1` / `$2` for the first / second argument | Renumber from `$0` and add a template test. |
| 8 | P2 | No activation on neutral prompts | — | Stage 1: 0/3 activation on a multi-repository task | Improve the skill description and triggers for multi-repository feature work. The current suite works around this with an explicit instruction. |
| 9 | P2 | Overhead when it does work | — | cold WITH: 76 turns, $2.14, 417 s vs WITHOUT 15 turns, $0.59, 138 s, with equal functional outcome | Re-measure after #1–#6. Overhead is only justified if orchestration delivers verified, evidence-backed candidates. |

Eval-side follow-ups (not Mycelink defects):

- `summary-lists-delivered-commits` passes on any four hex strings. Tighten
  it to match the delivered HEADs, or move the check to the verifier.
- `mycelink-orchestrate-run` reads 0× although the traces show four
  `orchestrate run` attempts, all `BLOCKED`. Its 0× means "no recognized
  successful invocation", not "no attempt". Split it into separate
  *attempted* and *succeeded* indicators, accept other launcher spellings,
  and record the `stop_reason`.
- Activation indicators are unscored. The plugin-eval score alone rated
  cold WITH a full pass despite invalid orchestration, so always report the
  verifier alongside it.
- Case configs declare `runs: 3`, but these pilots ran one run per arm. Use
  ≥ 10 runs per case per arm, with Wilson intervals, before claiming
  differences (README §3).

## Reproducibility

From the repository root at commit `531a8bf`, in a shell with the four
`GIT_AUTHOR_*` / `GIT_COMMITTER_*` variables exported as described in
`evals-multimodule/README.md`:

```bash
git checkout 531a8bf
claude plugin validate --strict .
node evals-multimodule/tools/selftest.mjs        # expect "81 passed, 0 failed"

claude plugin eval . --eval-dir evals-multimodule \
  --scaffold --allow-tools Bash Write Edit \
  --runs 1 --model sonnet --keep-temp --no-publish \
  --max-cost-usd 40 \
  --json evals-multimodule/results/wsl-activation-pilot.json

node evals-multimodule/tools/verify-workspace.mjs \
  --aggregate evals-multimodule/results/wsl-activation-pilot.json \
  --require-mycelink --out evals-multimodule/results/wsl-activation-verification.json
```

The aggregate file name matches the one the verifier recorded. The other
flags follow the README runbook (§1–§2). The exact operator command line was
not captured in the evidence, and `--max-cost-usd` in particular is the
runbook default, not a recorded value. Stage 1 ran before `531a8bf`, with
prompts that lacked the conditional instruction. Reproducing it requires
removing that sentence from each `case.yaml` prompt.

## Evidence handling

The summary JSON was derived by script from four local evidence files: the
two plugin-eval aggregates, the verifier aggregate and the self-test output.
A separate script cross-checked it against those files. The correction
and the root-cause review also used the session traces and the Mycelink
source at `531a8bf`. Raw HTML reports, traces and workspaces are not
included. Usernames, absolute paths, temporary
sandbox identifiers, session identifiers, e-mail addresses and credentials
have been removed. Git SHAs that appear here are commits inside the synthetic
fixture repositories.
