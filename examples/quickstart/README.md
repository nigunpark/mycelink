# Quickstart: one requirement across two repositories

A five-minute start. You create two tiny Git repositories and a control
repository, then give Claude Code one approved requirement. Mycelink plans
it, runs one isolated worker per node test-first, has an independent
reviewer check every acceptance criterion, and cuts one candidate that binds
the exact commit of both repositories.

| | |
|---|---|
| **Repositories** | `pricing` (computes prices) and `storefront` (renders product labels). Plain Node.js with no dependencies; tests run with `node --test` |
| **Requirement** | [`requirements/FEAT-101.md`](requirements/FEAT-101.md): show sale prices. Pricing computes `sale_cents`, storefront displays it. Four acceptance criteria, one of them a compatibility criterion |
| **You need** | Node.js 22.12+ or 24.x, Git 2.30+, Claude Code signed in, and Mycelink installed (see below) |
| **Cost** | Setup uses no model. Step 3 runs real Claude sessions (a planner, one worker per node, a reviewer) and uses your Claude plan or API credit. It costs more than asking a single session for the same change |

## 1. Install Mycelink

```bash
claude plugin marketplace add nigunpark/mycelink
claude plugin install mycelink@mycelink-marketplace
```

## 2. Create the demo workspace

```bash
git clone https://github.com/nigunpark/mycelink.git
node mycelink/examples/quickstart/setup.mjs mycelink-demo
```

`setup.mjs` runs only `git`: no Mycelink command, no model, no network. It
creates three repositories, each with one commit on `main`:

```text
mycelink-demo/
  pricing/       src/price.js   test/price.test.js
  storefront/    src/label.js   test/label.test.js
  control/       requirements/FEAT-101.md   (the approved requirement)
```

## 3. Hand Claude Code the requirement

```bash
cd mycelink-demo
claude
```

Paste this prompt:

```text
The requirement FEAT-101 has been approved: control/requirements/FEAT-101.md.
control/ is our coordination repository; the code lives in the Git
repositories pricing/ and storefront/. Each has no dependencies and tests
with `node --test`.

Use the Mycelink plugin to deliver it end to end with /mycelink:run FEAT-101:
set up control/ as the Mycelink control repository with pricing and
storefront registered (base branch main), then plan, run, review and deliver.
```

If you prefer to drive each phase yourself, the same work is
`/mycelink:init control`, then `/mycelink:prd FEAT-101`, `/mycelink:plan FEAT-101`,
`/mycelink:run FEAT-101` and `/mycelink:verify FEAT-101`.

## What you should see

1. **Control plane.** `control/` gets `mycelink.config.json`,
   `repositories.yaml` and project-scoped hooks in `.claude/settings.json`.
   `mycelink doctor` passes.
2. **A validated graph.** `control/features/FEAT-101/` gets a PRD, an
   acceptance manifest (`ACCEPTANCE.json`, AC-1 to AC-4 cut verbatim from the
   requirement) and a `PORTFOLIO-GRAPH.yaml` whose nodes each own paths in
   one repository.
3. **Isolated workers.** Each node runs in its own Git worktree on a
   `wip/FEAT-101/<node>` branch. A worker must record a failing test (RED)
   before production code, then GREEN with the identical command. Writes
   outside its own worktree are blocked, and settle checks the node's Git
   history test-first.
4. **Independent review.** A read-only reviewer judges every criterion. A
   gap sends only the node that owns that criterion back for rework.
5. **One candidate.** `control/features/FEAT-101/candidates/FEAT-101-C001.yaml`
   binds the exact SHA of `pricing` and `storefront`. Check it yourself:

   ```bash
   node <plugin>/bin/mycelink.mjs candidate verify FEAT-101 --control-root control
   ```

   (`claude plugin list` shows where the plugin is installed.)
6. **Delivery.** `deliver` fast-forwards each repository's `main` to exactly
   the candidate SHA and re-runs its tests there. It never pushes.

Starting takes about five minutes. The run itself takes as long as its
sessions need, usually much longer. The run, not the setup, is where
model usage happens.

## If something stops

- `mycelink doctor --control-root control` names what is missing.
- `node <plugin>/bin/mycelink.mjs feature status FEAT-101 --control-root control`
  shows every node's state and the evidence log for any node that is blocked.
- An interrupted session resumes: start Claude Code again in `mycelink-demo`
  and ask it to continue `/mycelink:run FEAT-101`.
- Then please tell us how it went:
  [first-run feedback](https://github.com/nigunpark/mycelink/issues/new?template=first-run.yml).

## Clean up

Delete the `mycelink-demo` directory. Mycelink keeps its worktrees, state and
evidence inside it, and nothing was pushed anywhere.

---

Back to the [main README](../../README.md).
