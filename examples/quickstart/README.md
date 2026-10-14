# Quickstart: one feature across two repositories

A five-minute, self-contained Mycelink demo. One approved PRD needs a
coordinated change in two **independent Git repositories**: an API that
publishes order-status payloads and a web client that renders them. They
share a contract that moves from version 1 to version 2.

```text
  orders-api/   own Git repo   publishes { version, id, status, eta? }
  orders-web/   own Git repo   renders the line an order page shows
  control/      own Git repo   Mycelink: PRD, acceptance criteria, contract, graph, state, evidence

  ORD-101.api.status.impl ──contract v2──► ORD-101.web.status.impl ──► ORD-101.release.candidate.build
  (worktree in orders-api)                 (worktree in orders-web)     (controller: one immutable candidate)
```

The feature, ORD-101 *Delayed orders with an expected delivery date*, has four
acceptance criteria ([PRD](control/features/ORD-101/PRD.md)): the API publishes
`delayed` with an `eta` (AC-1) and refuses a delayed order without a valid one
(AC-2); the client renders it (AC-3) and degrades safely on a status it does
not know, or none at all (AC-4).

## Prerequisites

| | |
|---|---|
| Node.js | 22.12 or later (24.x works) |
| Git | 2.30 or later |
| OS | Windows, macOS or Linux; no Docker, WSL, VM, network access or `npm install` |
| Claude Code | **only for step 4**, logged in, with model quota |

**Cost.** Steps 1–3 start no model, use no network and cost nothing. Step 4
is a real run: a host session plus at least three subagent sessions (two
module-workers and one acceptance reviewer, and more if the review finds a
gap). It uses your Claude plan's quota or API credits. Mycelink's maintainers
have not published a measured cost or duration for this demo; budget roughly
15–45 minutes of wall-clock time.

## 1. Create the workspace (seconds)

The quickstart lives in this repository, not in the plugin ZIP, so start
from a clone:

```bash
git clone https://github.com/nigunpark/mycelink.git
cd mycelink
node examples/quickstart/setup.mjs --out ../mycelink-quickstart
```

`setup.mjs` creates `orders-api/`, `orders-web/` and `control/` side by side
in the output directory, each its own Git repository on `main`, and commits
their baselines. It:

- refuses an output directory that is not empty, unless an earlier run of
  `setup.mjs` made it and you pass `--force`;
- refuses an output directory inside any Git work tree, so the three
  repositories stay independent;
- sets only a local Git identity (`Mycelink Quickstart
  <quickstart@example.invalid>`) in each new repository, and dates the
  baseline commits at a fixed time, so the baselines get the same SHAs on
  every machine: `orders-api` `884eed990cb0`, `orders-web` `8846c66e4225`;
- runs `mycelink init` for the control repository, then adds the approved
  PRD, `ACCEPTANCE.json`, the contract and the portfolio graph, and checks
  them with `mycelink graph validate ORD-101` and `mycelink repo audit`;
- runs both baselines' tests (`node --test`) and prints the next commands.

It opens no controller key: the Claude Code session that runs the feature
opens its own. Every process it starts gets an argv array, never a shell
string. To use an installed plugin's hooks instead of this checkout's, pass
`--mycelink <plugin-install-path>/bin/mycelink.mjs`.

## 2. Check the demo (seconds, no model)

```bash
node examples/quickstart/verify-demo.mjs
```

It builds a throwaway workspace and checks that the repositories are
separate, the baselines are the published SHAs and pass their tests, the
feature is not already solved, the graph validates and initialises, the
acceptance manifest matches the PRD byte for byte, and the commands in this
README exist. The repository's release tests run it too.

## 3. Watch the scripted walkthrough (about a minute, no model)

```bash
node examples/quickstart/walkthrough.mjs
```

It runs the whole feature in a temporary directory with a **scripted**
module-worker and acceptance reviewer, through the real controller: the
READY set, dispatch tickets, isolated worktrees, the red/green/regression
gates, settle's clean re-verification, an acceptance review that finds a
gap, the rework, the candidate and the delivery. The gap is planted on
purpose (the scripted web worker's first version throws on a payload with
no status). [SAMPLE-OUTPUT.md](SAMPLE-OUTPUT.md) is its output, labelled as
such; it is not a model run.

`--keep` keeps the workspace so you can inspect the repositories,
`features/ORD-101/STATE.json`, the evidence and the candidate manifest.

## 4. Run it with Claude Code (uses model quota)

From the clone, after step 1:

```bash
cd ../mycelink-quickstart/control
claude --plugin-dir ../../mycelink
```

`--plugin-dir` loads the plugin from your clone for this session only. Use
the clone's own directory name if it is not `mycelink`. With an installed
plugin, run `setup.mjs` with `--mycelink` (above) and start plain `claude`.

Then, inside Claude Code:

```text
/mycelink:run ORD-101
```

The session opens the controller key, initialises ORD-101 from the
committed graph, dispatches `ORD-101.api.status.impl` to a module-worker in
its own worktree, then `ORD-101.web.status.impl` once the API node is DONE,
runs the independent acceptance review, cuts the candidate and delivers it.
Claude Code asks before each command it runs, unless you allowed it
already. Delivery fast-forwards `main` in both repositories and never
pushes.

Check the result yourself, from the clone:

```bash
node bin/mycelink.mjs feature verify ORD-101 --delivered --control-root ../mycelink-quickstart/control
node examples/quickstart/acceptance/probe.mjs ../mycelink-quickstart/orders-api ../mycelink-quickstart/orders-web
git -C ../mycelink-quickstart/orders-api log --oneline main
git -C ../mycelink-quickstart/orders-web log --oneline main
```

`probe.mjs` checks AC-1 to AC-4 from outside both repositories. It fails all
four on the baselines and passes all four on a correct delivery. A model's
own implementation may differ from the scripted one; the probe judges
behaviour, not code.

### If something stops

- `node bin/mycelink.mjs feature status ORD-101 --control-root ../mycelink-quickstart/control`
  shows every node's state and the evidence log of any node that is blocked;
  `doctor` with the same `--control-root` names what is missing.
- An interrupted run resumes: start Claude Code again in `control/` as above
  and run `/mycelink:run ORD-101`. The state file, not the conversation, says
  where it stood.
- Then please tell us how it went, good or bad:
  [first-run feedback](https://github.com/nigunpark/mycelink/issues/new?template=first-run.yml).

## What it demonstrates

| Mycelink property | Where you see it |
|---|---|
| Independent repositories | three `.git` directories, no shared remote, no submodules |
| Graph dependencies | the web node is deferred until the API node, the contract's producer, is DONE |
| Isolated worktrees | each node runs in `control/.mycelink/worktrees/<repo>__<node>` on `wip/ORD-101/<node>` |
| Strict RED, GREEN, regression | the red gate accepts only a test that fails for the missing behaviour; tests and production code are committed separately; the full suite runs before settle |
| Independent acceptance review | a read-only reviewer judges each criterion's words against the tests before any candidate; a GAP reworks the producer |
| One immutable candidate | `features/ORD-101/candidates/ORD-101-C001.yaml` binds the exact SHA of both repositories and the contract's hash |
| Two exact delivered SHAs | after `deliver`, `main` in each repository is exactly the SHA the candidate bound |

## Files

| Path | What |
|---|---|
| `setup.mjs` | creates the workspace |
| `verify-demo.mjs` | the model-free checks of step 2 |
| `walkthrough.mjs` | the scripted, model-free run of step 3 |
| `lib/quickstart.mjs` | shared workspace code (argv-only processes, fixed identity and dates) |
| `repos/orders-api/`, `repos/orders-web/` | the baselines (contract version 1) |
| `control/` | what setup adds to the control repository: `repositories.yaml`, the contract, ORD-101's PRD, `ACCEPTANCE.json` and graph |
| `scripted/` | the files the walkthrough's scripted workers write (never part of a baseline) |
| `acceptance/probe.mjs` | AC-1 to AC-4 checked from outside both repositories |
| `SAMPLE-OUTPUT.md` | the walkthrough's output |
| `RECORDING.md` | a storyboard for a 45–60 s terminal recording |

## Start again or clean up

```bash
node examples/quickstart/setup.mjs --out ../mycelink-quickstart --force
```

`--force` deletes only a directory an earlier `setup.mjs` created (it holds
`.mycelink-quickstart.json`). To clean up, delete the output directory.

## Limitations

- The walkthrough's worker and reviewer are scripted; it shows what the
  controller enforces, not what a model would write.
- No browser E2E: both repositories are plain functions with `node:test`
  suites, so there is no runtime to deploy.
- The real run's prompts and approvals depend on your Claude Code version
  and permission settings.

---

Back to the [main README](../../README.md).
