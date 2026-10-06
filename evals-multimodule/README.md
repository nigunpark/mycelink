# Mycelink multi-module eval suite

Three realistic scenarios that ask one question: **can Claude Code, with and
without Mycelink, finish a cross-repository feature completely — and what does
prior knowledge change?**

| Case | Scenario | Starting point | What the agent must do |
|---|---|---|---|
| `greenfield-refunds` | 1. greenfield | approved MVP PRD (LEDGER-100) in `platform/`; `repos/{core,api,worker,cli}` hold only a README | establish how the portfolio is coordinated and build the whole vertical: orders, capture, idempotent concurrency-safe partial refunds |
| `existing-refunds-cold` | 2. existing, zero knowledge | working Ledgerline system in four repos, approved refunds PRD (LEDGER-142), **no architecture docs** | discover modules, commands and contracts; ship refunds across all four repos without regressions |
| `existing-refunds-informed` | 3. existing, prior knowledge | **identical** to 2, plus accurate `platform/docs/{ARCHITECTURE,MODULES,COMMANDS,CONTRACTS}.md` and a workspace `CLAUDE.md` | same feature; the difference from 2 quantifies what knowledge buys (completion, cost, turns) |

Prompts ask for the business outcome. Every prompt also carries one
identical, availability-conditional sentence:

> If the Mycelink plugin is available, you must use it to coordinate and
> deliver the work; if it is not available, proceed directly without it.

It names no Mycelink commands or concepts. In the `without` arm the plugin is
absent, so the sentence is a no-op and both arms still get the same prompt.
It exists because the first pilot (prompts without it) never activated the
plugin; see [Validity](#validity-a-run-is-a-plugin-evaluation-only-if-mycelink-ran).
The self-test enforces the exact wording in all three cases.

## The system and the feature

Each workspace (the run's working directory) looks like this:

```text
platform/        coordination ("control") Git repo: requirements/<PRD>.md [, docs/]
repos/core       @ledgerline/core: errors, money, order model, event contracts,
                 file store with cross-process locks, idempotency
repos/api        HTTP API (node:http)              ─┐ share LEDGER_DATA_DIR
repos/worker     job processor + fake payment gateway ─┘ (orders/, events/, queue/)
repos/cli        operator CLI (talks HTTP to the API)
acceptance/      QA's black-box acceptance suite (not a Git repo)
```

Everything is Node.js built-ins and Git; there are no npm dependencies and no
network access. Services consume `core` by **vendoring** it (`vendor/ledger-core/`
pinned by a lock hash), so a change to shared contracts must be released in
`core` and re-vendored into every consumer: a genuine cross-repository contract
change.

**Feature: idempotent, concurrency-safe partial refunds** (`POST /orders/:id/refunds`,
`GET …/refunds`, worker settlement, `ledger refunds create|list`). The parts
that make it non-trivial:

- **Idempotency.** `Idempotency-Key` replay returns the identical response, a
  reused key with a different body gets 409, and keys are scoped per order.
- **Concurrency.** Two API processes share one data directory. 24 concurrent
  retries must yield exactly one refund, and 12 concurrent distinct refunds
  must never exceed the captured amount.
- **Exactly-once side effects.** Three concurrent workers plus an operator
  redelivery of every job must still call the payment gateway exactly once
  per refund. Declines release the reserved amount.
- **Contracts.** New closed, versioned events (`refund.requested|succeeded|failed`)
  must validate with core's validator. New error codes and statuses are added,
  and every consumer must ship the delivered core release byte-for-byte.

### Acceptance criteria → acceptance tests (23, identical in every scenario)

| Tests | Proves |
|---|---|
| C1–C3 | core publishes the new error codes, refund/order statuses and closed v1 refund events |
| C4 | api, worker and cli vendor exactly the delivered core (`vendor/ledger-core/` == `core/src/`, lock hash and version correct) |
| O1–O6 | orders, idempotent creation across two API processes, capture via worker, declines, exactly-once capture under redelivery, CLI orders — the **regression guard** in scenarios 2/3 and part of the MVP in scenario 1 |
| R1–R6 | refund request, replay, key reuse/scoping, every validation/error code, same-key concurrency across two API processes, no over-refund under concurrency |
| W1–W3 | settlement and order totals, gateway exactly-once with 3 concurrent workers + redelivery, decline → `refund.failed` and released reservation |
| L1–L4 | `ledger refunds create` (idempotent) / `list`, API errors exit 1, missing `--key` / bad amount exit 2 without calling the API |

`node acceptance/run.mjs` tests what is **committed**. It exports each module
repo's HEAD commit (via `ls-tree` + `cat-file`: no filters, and the repo's
index is never touched). It then runs each module's own `node --test` suite,
then the 23 black-box tests against real API/worker/CLI processes. It writes
`acceptance-results/{SUMMARY.txt,report.json,acceptance.tap,modules/*.tap}`
and exits 0 only if every module is committed and clean, every module suite
passes, and all 23 tests pass.

Baselines (proven by `tools/selftest.mjs`): existing scenarios pass exactly
C4 + O1–O6 (7/23) with all module suites green; greenfield passes 0/23. The
maintainers' reference solution passes 23/23. Removing the cross-process lock
(a mutant) fails O2, R5, R6 and W2.

## Files

```text
evals-multimodule/
  README.md                       this runbook
  greenfield-refunds/             case.yaml + scaffold.sh (scenario 1)
  existing-refunds-cold/          case.yaml + scaffold.sh (scenario 2)
  existing-refunds-informed/      case.yaml + scaffold.sh (scenario 3)
  _lib/scaffold.mjs               deterministic workspace builder (Node + git only)
  _lib/baseline-shas.json         expected baseline commit SHAs per scenario
  _lib/ledgerline/                the existing codebase fixture
  _lib/docs/                      PRDs and the scenario-3 knowledge artifacts
  _lib/acceptance/                QA acceptance suite (copied into each workspace)
  _lib/reference-solution/, _lib/reference.mjs
                                  maintainers' reference implementation — self-test
                                  only, never copied into a workspace
  tools/verify-workspace.mjs      independent post-run verifier (JSON, fails closed)
  tools/selftest.mjs              model-free self-test of everything above
  tools/mycelink-fixture.mjs      genuine Mycelink orchestration with the fake Claude
```

## Requirements

- Claude Code with `claude plugin eval` (case schema `1.0`). Authored against
  the 2.1.288 format and validated on **2.1.290**.
- Node.js 22.12+ or 24.x, and Git 2.30+ (2.40+ also honours `GIT_ATTR_SOURCE`
  hardening) on `PATH`.
- `bash` on `PATH`, because the harness runs `bash <scaffold.sh>`. On Windows this
  must be Git Bash (`C:\Program Files\Git\usr\bin\bash.exe`) ahead of the WSL
  launcher (`…\WindowsApps\bash.exe`); `Get-Command bash -All` shows the order.
  Under WSL's bash the scaffold fails closed (no Windows `node` on its PATH).
- Mycelink's nested worker sessions run the `claude` executable on `PATH` and
  inherit the eval child's environment.

## Safety

- **Scaffolds** are authored here and short. Each `scaffold.sh` checks for
  `node` and `git`, then `exec`s `_lib/scaffold.mjs`. That script refuses a
  non-empty target, writes only inside the run directory (plus one empty git
  config file in the OS temp dir), uses no network and installs nothing. It
  disables system/global git config, so baseline SHAs are identical on every
  machine; it checks them against `_lib/baseline-shas.json` and fails on any
  drift. The harness still requires `--scaffold` to run them.
- **Git hardening.** A repository's own `.git/config` can make git execute
  programs (`core.fsmonitor`, filter drivers, includes). The acceptance runner
  and the verifier therefore refuse any repository whose local config has
  keys outside an inert allowlist. They run git with system/global config off
  and fsmonitor, hooks, attributes and pager overridden. The self-test proves
  a planted filter/fsmonitor is refused and never runs.
- **The verifier executes delivered code.** Re-running acceptance means
  running the API, worker, CLI and module tests the agent wrote. Treat it like
  the eval run itself: run it as the same user, on the same disposable machine
  or VM. On Windows the harness cannot seal kept run directories (it says so
  when `--keep-temp` is used). Delete them when you're done.

## Runbook

All commands run from the repository root. `claude plugin eval .` resolves
the plugin from the path, so ablation defaults to `with-without`: each case
runs once with Mycelink and once without, and the report shows the Δ.

### 0. Model-free checks (free; do these first)

```bash
claude plugin validate --strict .                 # plugin + marketplace manifests
node evals-multimodule/tools/selftest.mjs         # ~4 min; must end "N passed, 0 failed"
```

### Required operator grants

The cases list `Read, Glob, Grep, Write, Edit, Bash, Skill, Agent, TodoWrite`.
Bash, Write and Edit are gated: **without `--allow-tools Bash Write Edit` the
harness withholds them, no file can be created, and every completion grader
fails.** It prints `cannot pass with the granted tools` for each one. Do not
narrow Bash to patterns like `Bash(node:*)`: the agent needs git, node and
the Mycelink launcher, and a pattern in `allowed_tools` is only honoured when
granted verbatim.

### Required operator environment

The agent commits in five repositories, and the sandbox HOME has no git
identity. `claude plugin eval` only accepts `EVAL_*` keys in a case's
`execution.env` (any other key fails the run before the model launches), so
the git identity must come from the shell that runs the eval. The eval child,
and Mycelink's nested worker sessions, inherit it. Set it once per shell
before steps 1 and 3 (Git Bash, also bash/zsh on Linux and macOS):

```bash
export GIT_AUTHOR_NAME="Ledgerline Engineer" GIT_AUTHOR_EMAIL="engineering@ledgerline.invalid"
export GIT_COMMITTER_NAME="Ledgerline Engineer" GIT_COMMITTER_EMAIL="engineering@ledgerline.invalid"
```

Equivalents: PowerShell `$env:GIT_AUTHOR_NAME = 'Ledgerline Engineer'` (and
likewise for the other three); cmd.exe `set GIT_AUTHOR_NAME=Ledgerline Engineer`.
`env | grep '^GIT_'` (PowerShell: `Get-ChildItem env:GIT_*`) should list all four.
The self-test asserts that every `execution.env` key in each case begins `EVAL_`.

### 1. Cheap pilot (1 run per case per arm = 6 agent runs)

```bash
# in a shell with the four GIT_* variables above exported
claude plugin eval . --eval-dir evals-multimodule \
  --scaffold --allow-tools Bash Write Edit \
  --runs 1 --model sonnet --keep-temp --no-publish \
  --max-cost-usd 40 \
  --json evals-multimodule/results/pilot.json
```

For an even cheaper first look, run one case (2 agent runs):
`--case existing-refunds-cold --max-cost-usd 15`.

Costs are not known until the pilot has run: each run may use up to 150 turns
(200 for greenfield) and 60 minutes. `--max-cost-usd` is checked before each
run launches, so a run already in flight can overshoot it. Lower the ceiling
for tighter control, or run single cases.

### 2. Verify the pilot independently (mandatory)

The pilot is **not a plugin evaluation** until this step passes for the
`with` arm. Treat it as invalid unless every `with` run shows the activation
indicators (`mycelink-skill-invoked`, `mycelink-controller-used`,
`mycelink-orchestrate-run`, `mycelink-control-plane-created`,
`mycelink-feature-state-recorded`, `mycelink-candidate-created`) **and** the
verifier's `orchestration.ok` under `--require-mycelink`. If they fail, the
`with` arm measured Claude alone; do not report Δ, and do not proceed to the
full run.

```bash
node evals-multimodule/tools/verify-workspace.mjs \
  --aggregate evals-multimodule/results/pilot.json \
  --require-mycelink --out evals-multimodule/results/pilot-verification.json
```

`--aggregate` finds every run's kept workspace (`<tmp>/claude-eval-*/home/cwd`,
located from the trace path) and verifies it. `--require-mycelink` applies
only to the `with` arm. A single workspace:

```bash
node evals-multimodule/tools/verify-workspace.mjs --workspace <dir> [--scenario existing-cold] [--require-mycelink]
```

Exit 0 = verified, 1 = not verified, 2 = usage/internal error. The JSON is
always printed. Without `--keep-temp` there is nothing to verify, and the
verifier reports that as a failure.

### 3. Full, statistically meaningful run

```bash
# in a shell with the four GIT_* variables above exported
claude plugin eval . --eval-dir evals-multimodule \
  --scaffold --allow-tools Bash Write Edit \
  --runs 10 --model sonnet --keep-temp --no-publish \
  -j 2 --max-cost-usd 600 \
  --json evals-multimodule/results/full.json
node evals-multimodule/tools/verify-workspace.mjs --aggregate evals-multimodule/results/full.json \
  --require-mycelink --out evals-multimodule/results/full-verification.json
```

Completion is binary per run, so small samples say little. With 3 runs per
arm a 3/3 vs 0/3 split is suggestive at best. **Use ≥ 10 runs per case per
arm** before reporting differences, and report each rate with a 95% Wilson
interval: with n = 10, 8/10 is [0.49, 0.94]. `-j` runs agents concurrently on
one credential and rate limit. Mycelink also spawns worker sessions, so keep
`-j` at 1–2. Every run uses its own temporary data directories and ephemeral
ports, so concurrent runs do not interfere.

### Variants

- **No baseline arm.** `--ablation none` runs only with the plugin. Note that
  with `none`, the with-only graders count towards the score.
- **One scenario.** `--case greenfield-refunds`, or `--tag existing` /
  `--tag greenfield`.
- **Knowledge effect.** Compare `existing-refunds-cold` with
  `existing-refunds-informed` within the same arm.
- **Another model.** `--model opus`. The grader judge stays on haiku unless
  you pass `--judge-model`.

### Result paths

| What | Where |
|---|---|
| aggregate result + HTML report | `evals-multimodule/results/<timestamp>/aggregate-result.json`, `report.html` (or `--output-dir`) |
| full JSON (prompts, graders, per-run scores) | the `--json` path |
| per-run trace | `tracePath` in the JSON (`<tmp>/claude-eval-*/out/trace.jsonl`) |
| per-run workspace (needs `--keep-temp`) | `<tmp>/claude-eval-*/home/cwd` |
| in-run acceptance output | `<workspace>/acceptance-results/` |
| Mycelink state (with arm) | `<control repo>/features/<id>/` (STATE.json, evidence/, candidates/, sessions/, leases.json) |
| independent verification | the verifier's `--out` file |

## Validity: a run is a plugin evaluation only if Mycelink ran

The first WSL pilot (6 runs, prompts without the availability-conditional
sentence) passed every functional grader in both arms, but in every `with`
run all six activation indicators failed: no skill, no controller Bash call,
no `orchestrate run`, no control plane, state or candidate. It measured
Claude alone twice and says nothing about Mycelink. That pilot is invalid as
a plugin evaluation.

Before interpreting any result:

- A `with` run counts as a plugin run only if all six activation indicators
  pass **and** the verifier's `orchestration.ok` is true (`--require-mycelink`).
- A `with` run that fails either is a non-activation, not a plugin result.
  Report the non-activation rate; exclude such runs from any "Mycelink
  helped / hurt" claim.
- If most `with` runs do not activate, the comparison is invalid: report Δ
  as not measured, not as zero.

## Interpreting results — four signals, not one

1. **Plugin activation (with-only indicators, not scored under ablation):**
   - `mycelink-skill-invoked`: a `mycelink:*` skill or command ran.
   - `mycelink-controller-used`: the launcher ran.
   - `mycelink-orchestrate-run`: the controller dispatched work.
   - `mycelink-control-plane-created`, `mycelink-feature-state-recorded`,
     `mycelink-candidate-created`: Mycelink artifacts the run created.

   Activation says Mycelink was *used*, not that it *helped*. Without it
   (and without `orchestration.ok`), signals 2–4 describe Claude alone.
2. **Objective feature completion. The authoritative signal is the
   verifier's `completion` section.** It checks, in order:
   - every module repo's local git config is inert;
   - baseline history is preserved, and every module changed;
   - no uncommitted code;
   - the workspace acceptance suite is untampered (hash);
   - a trusted re-run of acceptance passes against the delivered HEADs;
   - new tests exist in every module (existing: more than the baseline
     10/7/5/4; greenfield: at least 1);
   - core shipped a new minor release (existing scenarios).

   In-eval graders are a fast proxy: verdict, suite hash, 23/23 TAP, 4 clean
   green modules, `report.json`, acceptance actually run, plus the honesty of
   the final summary. The proxy can be wrong if the agent writes the result
   files itself; the verifier cannot be fooled that way.
3. **Orchestration evidence: the verifier's `orchestration` section,
   required with `--require-mycelink`.** It checks:
   - the control root is present and the git config is safe;
   - every graph node is DONE;
   - evidence files exist;
   - `mycelink feature verify` and `mycelink candidate verify` pass;
   - the candidate binds all four modules, and **the delivered trees equal
     the candidate's bound SHAs**;
   - no unreleased lease (stricter than Mycelink, which ignores leases whose
     holder exited);
   - no live session;
   - worker worktrees hold no uncommitted work.

   A dirty control repo is a warning only. `in-run report` checks
   (`reporting`) confirm that the agent's own final acceptance run tested
   exactly the delivered commits.
4. **Baseline comparison.** The report's Δ is the `with` score minus the
   `without` score, on scored graders only. Compare verifier completion
   rates, turns and cost per arm too. **Cost caveat:** the harness's
   `costUsd` covers only the top-level session; Mycelink's nested worker
   sessions are separate `claude` processes and are *not* included. The
   verifier reports Mycelink's own ledger in `evidence.mycelink.usage`
   (tokens, sessions), and `--aggregate` sums it per case/arm as
   `mycelink_worker_tokens`. Add it before comparing cost.

A run "finished the functionality completely" only when `completion.ok` is
true. For the with arm, the claim that Mycelink did it needs all six
activation indicators and `orchestration.ok` as well; otherwise the run is a
non-activation and the with/without comparison is not a plugin evaluation.

## Known caveats

- **Nested workers inside the harness are still unproven.** The first pilot
  never activated the plugin, so it did not exercise them.
  `mycelink orchestrate run` spawns `claude -p` worker sessions. Whether they
  authenticate and reach the API from inside the eval child (sandbox HOME,
  `--setting-sources user`, and on Linux/macOS the OS sandbox's network and
  local-bind rules) has not been exercised with a real model yet. The
  orchestration path itself is proven only with Mycelink's fake Claude
  (`tools/mycelink-fixture.mjs`).
- **Project hooks are inert in eval runs.** The child runs with
  `--setting-sources user`, so the PreToolUse enforcement hooks that
  `mycelink init` installs in a control repo's `.claude/settings.json` don't
  load. What is measured is Mycelink's controller and skills, not its hook
  enforcement.
- **A workspace `CLAUDE.md` appears not to reach the eval child.** A haiku
  probe answered that it saw no ARCHITECTURE.md mention. Scenario 3's
  knowledge is still discoverable through `platform/README.md`, which points
  at `platform/docs/`.
- **Mycelink usability finding.** `mycelink init` does not add `.mycelink/`
  to the control repo's `.gitignore`. The candidate-build step then refuses
  the control repo as dirty, because its worktrees live under `.mycelink/`.
  An agent has to notice and fix this; the fixture does it explicitly.
- **File graders only see files the run creates**, not scaffolded ones (probe
  evidence). Every file grader here targets run-created output.
- **Contamination.** The reference solution lives in this repository, and an
  agent with Bash could read it. `did-not-read-reference-solution` fails any
  run whose trace mentions it.
- **Linux/macOS not exercised here.** The suite was built and self-tested on
  native Windows (Node 24, Git 2.53). Scaffold, runner and verifier use only
  portable Node APIs and POSIX-safe bash, but run the self-test once on each
  OS you report results for.

## Maintaining the suite

- After changing anything under `_lib/ledgerline/`, `_lib/docs/` or
  `_lib/scaffold.mjs`, run `node evals-multimodule/tools/selftest.mjs --write-baseline`
  and commit the new `_lib/baseline-shas.json`.
- After changing anything under `_lib/acceptance/`, update the
  `suite_sha256` pattern in all three `case.yaml` files. The self-test fails
  until they match.
- Keep `existing-refunds-cold/case.yaml` and `existing-refunds-informed/case.yaml`
  identical apart from name, description, tags and comments. The self-test
  enforces this.
