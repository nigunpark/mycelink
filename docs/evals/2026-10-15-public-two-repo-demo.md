# Mycelink quickstart with a real model: ORD-101 across two Git repositories

Date: 2026-10-15
Run by: the Mycelink maintainer, on their own machine. **One run. Self-reported, not an independent
benchmark.**
Demo: [`examples/quickstart/`](../../examples/quickstart/README.md), feature ORD-101, exactly as committed.

This is a real Claude Code run of the public two-repository quickstart. It is not the scripted
walkthrough. [`SAMPLE-OUTPUT.md`](../../examples/quickstart/SAMPLE-OUTPUT.md) and the README's
animation come from `walkthrough.mjs`, which drives the real controller with a **scripted** worker
and reviewer, plants a gap on purpose and calls no model. The two must not be confused: they have
different delivered SHAs, different review findings and different session counts
([compared below](#this-run-and-the-scripted-walkthrough)).

No raw run record, transcript, prompt, controller key or local path is published with this report.
The numbers below are copied from the run's records and from checks re-run after the run.

## Verdict

The run completed on its own and delivered candidate **ORD-101-C001**, which binds one exact commit in
each of two independent Git repositories. Every check run afterwards passed: Mycelink's own
delivery and candidate verification, an acceptance probe that sits outside both repositories, and
both repositories' full test suites. Nothing was pushed.

That is all this report shows: one feature, one run, one machine. It is no success rate, no
comparison with plain Claude Code, and no measure of code quality.

## Scope

| | |
|---|---|
| Repositories | `orders-api` and `orders-web`: two independent local Git repositories, each with its own `.git` and `main`, no shared remote, no submodule. A third, `control/`, holds Mycelink's PRD, graph, state and evidence. |
| Feature | ORD-101 *Delayed orders with an expected delivery date*: contract v1 → v2, four acceptance criteria ([PRD](../../examples/quickstart/control/features/ORD-101/PRD.md)) |
| Graph | `ORD-101.api.status.impl` → `ORD-101.web.status.impl` → `ORD-101.release.candidate.build` |
| Software | Claude Code 2.1.290, model Claude Opus 5.5, Mycelink `0.3.0-beta.1` from adoption commit `f3afb6ae92b18bf3af67252d74fcc784d1420dd6`; Windows host |
| Network | none of Mycelink's own; the only traffic was Claude Code's model requests. The demo repositories have no remotes. |

## Method

1. `node examples/quickstart/setup.mjs --out <workspace>` created the three repositories at the
   published baselines.
2. Before the run, the external acceptance probe (`examples/quickstart/acceptance/probe.mjs`)
   passed **0 of 4** criteria on the baselines: the feature was not already there.
3. In a Claude Code session started in `control/` with the Mycelink plugin, the maintainer ran
   `/mycelink:run ORD-101` and let it finish. The host session opened its own controller key,
   initialised the feature from the committed graph, dispatched each node, ran the acceptance
   review and its rework, cut the candidate and delivered it.
4. Afterwards, the checks in [Results](#results) were run again by hand on the delivered state.

## Results

| Check (run after the run) | Result |
|---|---|
| `mycelink feature verify ORD-101 --delivered --json` | `{"ok": true, "problems": []}` |
| `mycelink candidate verify ORD-101 --json` | `{"ok": true, "problems": []}` |
| External acceptance probe on the delivered commits | **4 / 4** criteria pass (0 / 4 on the baselines) |
| `orders-api`: `node --test` | 8 / 8 pass |
| `orders-web`: `node --test` | 11 / 11 pass |
| Product repositories | clean working trees; no remotes; nothing pushed |

### Exact commits

| Repository | Baseline `main` (published, reproducible) | Delivered `main` = candidate ORD-101-C001 |
|---|---|---|
| `orders-api` | `884eed990cb0819a4494f0347299eeef87ab0072` | `27bde55218f7f37733da16f7e87ed5231e50b887` |
| `orders-web` | `8846c66e4225c51a96b25051ca104216aa3ff916` | `9197a9f4af6904ef01acded3a5f3c429c49d1343` |

The baseline SHAs are the same on every machine (fixed identity and dates in `setup.mjs`). The
delivered SHAs belong to this run only: a new run gets a model's new commits, with new SHAs.

## Sessions and recovery

Besides the host session, the run started **six subagent sessions**: three
`mycelink:module-worker` and three `mycelink:acceptance-reviewer`.

| # | Session | What happened |
|---|---|---|
| 1 | module-worker, `ORD-101.api.status.impl` | settled DONE on the first attempt |
| 2 | module-worker, `ORD-101.web.status.impl` | settled DONE on the first attempt |
| 3 | acceptance-reviewer, review R001 | returned no usable verdict; Mycelink started a fresh reviewer automatically |
| 4 | acceptance-reviewer, review R001 (fresh) | challenged **AC-4** ("a payload whose `status` the web client does not know") for payloads whose `status` is not a string |
| 5 | module-worker, `ORD-101.web.status.impl` rework | added a focused re-proof test for non-string statuses; the production code already handled them, so the rework changed no production code |
| 6 | acceptance-reviewer, review R002 | **PASS** on AC-1, AC-2, AC-3 and AC-4 |

Then the controller cut ORD-101-C001 and delivered it: each repository's `main` was fast-forwarded to
the candidate's SHA and re-tested.

Two things in this run were not planned: the first reviewer's empty-handed exit, which the
controller recovered from without a person, and a real review finding on a case the PRD's words
cover but the first web tests did not single out. Both are ordinary
events in a model run, and both stayed inside one feature id and one candidate.

## Time and cost

| Measure | Value | Source |
|---|---|---|
| Wall-clock, whole run | 1 007 201 ms (about 16 min 47 s) | Claude Code's result record for the host process |
| Model API time | 970 476 ms (about 16 min 10 s) | same record |
| Feature wall-clock | 850 940 ms (about 14 min 11 s) | Mycelink's feature state, `wall_clock_ms` |
| Cost | **$5.550356** | Claude Code's `total_cost_usd` for the run, at API list prices |
| Tokens | 178 input, 104 232 output, 5 727 475 cache read, 366 580 cache creation | Claude Code's usage for the run |

Read these with care:

- **Claude Code reported the cost and tokens, not Mycelink.** Mycelink's own records show 0 tokens
  for this run, because it does not import the usage of subagents started through Claude Code's
  Agent tool. The token fields in Mycelink's state are not a measurement here.
- **The cost is a list-price figure, not an invoice.** On a Claude plan it is drawn from the plan's
  quota instead; with other prices or caching it would differ.
- **One run.** Time and cost vary with the model's choices: a review with no finding would have
  needed fewer sessions, and a harder gap more. No average, spread or success rate can be drawn
  from one run, and none is claimed.

## This run and the scripted walkthrough

| | This report: real model run | `walkthrough.mjs` / `SAMPLE-OUTPUT.md` / README GIF |
|---|---|---|
| Worker and reviewer | Claude Opus 5.5 in Claude Code subagents | scripted, no model |
| Review finding | real: AC-4 for non-string statuses | planted: AC-4 for a payload with no status |
| Reviewer sessions | 3 (one retried automatically) | 2 |
| Rework | test-only re-proof | new test and a production fix |
| Delivered `orders-api` | `27bde55218f7` | `6b82dd335709` |
| Delivered `orders-web` | `9197a9f4af69` | `1e1ba232befe` |
| Reproducible byte for byte | no | yes |

## Limitations

- **One maintainer-run demo.** Not repeated, not run by anyone else, not an independent benchmark,
  and no success rate.
- **No baseline.** Nobody ran the same feature with plain Claude Code for comparison. No claim of
  better code, speed or cost.
- **A small, prepared feature.** Two tiny repositories of plain functions with `node:test` suites,
  four acceptance criteria and a PRD written in advance. Real repositories have slower tests,
  more files and vaguer requirements.
- **Windows only.** Linux and macOS ran the model-free suite in CI, not this model run.
- **The probe is the maintainer's.** `probe.mjs` lives outside both demo repositories, but it was
  written alongside the demo, not by an outside party.
- **Unpublished records.** The run record and transcripts stay private. The commits and checks above
  can be inspected only by re-running the demo, which gives new SHAs.

Mycelink's design-partner pilots on separate, real repositories
([roadmap](../ROADMAP.md#2-real-cross-repository-pilots)) are still to come.

## Reproducing

From a clone of this repository (Node 22.12+, Git, Claude Code logged in; step 3 uses model quota):

```bash
# 1. The workspace, at the published baselines (no model, no network)
node examples/quickstart/setup.mjs --out ../mycelink-quickstart
node examples/quickstart/acceptance/probe.mjs ../mycelink-quickstart/orders-api ../mycelink-quickstart/orders-web   # 0/4 expected, exit 1

# 2. Optional, no model: the scripted walkthrough (not this run)
node examples/quickstart/walkthrough.mjs

# 3. The real run
cd ../mycelink-quickstart/control
claude --plugin-dir ../../mycelink
#   then, inside Claude Code:  /mycelink:run ORD-101
cd ../../mycelink

# 4. The checks in Results
node bin/mycelink.mjs feature verify ORD-101 --delivered --json --control-root ../mycelink-quickstart/control
node bin/mycelink.mjs candidate verify ORD-101 --json --control-root ../mycelink-quickstart/control
node examples/quickstart/acceptance/probe.mjs ../mycelink-quickstart/orders-api ../mycelink-quickstart/orders-web   # 4/4 expected
node --test   # in ../mycelink-quickstart/orders-api and in ../mycelink-quickstart/orders-web
git -C ../mycelink-quickstart/orders-api status --porcelain   # empty
git -C ../mycelink-quickstart/orders-api remote -v            # empty: nothing to push to
git -C ../mycelink-quickstart/orders-web status --porcelain
git -C ../mycelink-quickstart/orders-web remote -v
```

A new run's delivered SHAs, test counts, sessions, time and cost will differ from this one's.
