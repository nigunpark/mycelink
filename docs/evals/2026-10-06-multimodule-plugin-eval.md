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
| `mycelink-orchestrate-run` | ❌ 0× | ❌ 0× | ❌ 0× |
| `mycelink-control-plane-created` | ✅ | ✅ | ✅ |
| `mycelink-feature-state-recorded` | ✅ | ✅ | ✅ |
| `mycelink-candidate-created` | ✅ | ❌ | ❌ |

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
  - `mycelink orchestrate run` was never invoked (`mycelink-orchestrate-run` 0×).
  - Implementation nodes were left at `REGRESSION_VERIFIED`, not `DONE`
    (`LEDGER-142.{core.refund-defs,api.refunds,worker.settle,cli.refunds}.impl`).
    The candidate node `LEDGER-142.release.candidate.build` was `INVALIDATED`.
  - `evidence-files`: 12 evidence records exist, but their red / green /
    regression outputs are missing on disk for all four implementation
    nodes.
  - `feature verify` failed with `NODE_NOT_DONE` for all five nodes, even
    though the feature state reads `CANDIDATE_READY`.
  - `candidate verify` failed with `CONTROL_SHA_DRIFT`: "Control repository
    is at f7b415fed680…, candidate bound 52774685cee6…". Candidate
    `LEDGER-142-C001` does bind all four modules at exactly the delivered
    SHAs.
  - Leases empty; 4 sessions, 0 live; control repository clean.

**existing-refunds-informed WITH: not completed, no valid candidate.**

- Node states: `LEDGER-142.core.refund-definitions.impl=BLOCKED`. The other
  four nodes stayed `PLANNED`. Feature state `RUNNING`, current candidate
  *(none)*, 0 evidence records.
- `module-changed`: 0 commits on top of the baseline in all four modules.
- Trusted acceptance re-run: **FAIL — acceptance: 16 failing of 23**. That is
  the untouched baseline: 7/23, the same as the self-test's baseline. No
  module tests were added, and `ledger-core` is still 1.4.0 (AC-11 requires a
  new minor release).
- The in-run acceptance report was never written. The control repository
  has 31 uncommitted paths.

**greenfield-refunds WITH: not completed, no valid candidate.**

- Node states: `LEDGER-100.core.storage.impl=BLOCKED`. The other seven nodes
  stayed `PLANNED`. Feature state `RUNNING`, current candidate *(none)*,
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
- Together with `orchestrate run` never being called, this indicates that
  **orchestration did not dispatch any model workers**. Whatever code was
  delivered (existing-cold WITH) was written by the top-level session. In
  this pilot, the WITH cost figures are therefore complete, not
  under-counted.

## Defect priorities

Ordered by impact on the end-to-end goal. Each item cites the evidence above.

| # | Priority | Defect | Evidence | Suggested action |
|---|---|---|---|---|
| 1 | P0 | The agent drives Mycelink through the controller but never runs `orchestrate run`, so no model worker is dispatched | 0/3 `orchestrate run`; 0 worker tokens / turns in all WITH runs | Make the skill's primary path a single `orchestrate run` after planning. Have the controller refuse, or loudly warn about, manual state progression that bypasses orchestration. |
| 2 | P0 | The first implementation node goes `BLOCKED` and the session ends with no code written | informed and greenfield WITH: first node BLOCKED, rest PLANNED, 0 commits, 11–29 turns | Surface the blocking reason in controller output and in `STATE.json`. Give a documented recovery command. The skill must not end the turn while the feature is `RUNNING` / `BLOCKED` without either resolving it or falling back to direct delivery. |
| 3 | P1 | Candidate invalidated by control-repository drift | cold WITH: `CONTROL_SHA_DRIFT`, candidate node `INVALIDATED` | Bind the candidate after the final control-plane commit, or exclude Mycelink's own bookkeeping commits from the drift check. Add a regression test for "commit control state after candidate build". |
| 4 | P1 | Inconsistent state: feature `CANDIDATE_READY` while every node fails `feature verify` and evidence outputs are missing on disk | cold WITH: nodes `REGRESSION_VERIFIED`, 12 records without on-disk outputs | Gate the `CANDIDATE_READY` transition on `feature verify`. Write evidence output files atomically with their records. |
| 5 | P1 | Control repository left dirty | informed WITH: 31 uncommitted control-repo paths | Ensure `mycelink init` / state writes either commit or `.gitignore` runtime state, so candidate-build preconditions can hold. |
| 6 | P2 | No activation on neutral prompts | Stage 1: 0/3 activation on a multi-repository task | Improve the skill description and triggers for multi-repository feature work. The current suite works around this with an explicit instruction. |
| 7 | P2 | Overhead when it does work | cold WITH: 76 turns, $2.14, 417 s vs WITHOUT 15 turns, $0.59, 138 s, with equal functional outcome | Re-measure after #1–#4. Overhead is only justified if orchestration delivers verified, evidence-backed candidates. |

Eval-side follow-ups (not Mycelink defects):

- `summary-lists-delivered-commits` passes on any four hex strings. Tighten
  it to match the delivered HEADs, or move the check to the verifier.
- `mycelink-orchestrate-run` matches only `mycelink.mjs … orchestrate run`.
  The zero worker usage corroborates it here, but the grader should also
  accept other launcher spellings.
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
A separate script cross-checked it against those files. Raw HTML reports,
traces and workspaces are not included. Usernames, absolute paths, temporary
sandbox identifiers, session identifiers, e-mail addresses and credentials
have been removed. Git SHAs that appear here are commits inside the synthetic
fixture repositories.
