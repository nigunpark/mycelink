---
description: Run the orchestration cycle for a feature until it settles or needs a decision
argument-hint: <feature-id>
allowed-tools: Bash, Read, Glob, Grep, AskUserQuestion
---

# Run the feature

Feature: `$0`

The controller is the only dispatcher. You do not implement nodes yourself and
you do not spawn agents outside the graph.

1. `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" loop validate $0`
2. `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" orchestrate ready $0`
   Show the user which nodes are schedulable and why the rest are deferred.
3. `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" orchestrate run $0 --json`

Then read the stop reason and act:

- `ALL_SETTLED` — run `feature verify $0` and report the evidence.
- `NEEDS_DECISION` — read `features/$0/DECISIONS.md`, ask the user with
  AskUserQuestion, record the answer with `decision record`, then
  `decision apply`, then run again. Never guess the answer.
- `BLOCKED` — report the node, its repeated failure fingerprint, the exact
  commands and exit codes, and the nearest reproducible test layer. Do not
  spawn a different agent to retry the same failure.
- `BUDGET_EXHAUSTED` — report what was spent, what remains, and the options.
- `NO_PROGRESS` — report what is deferred and why.

Report completed nodes, the current node, the blocking reason and real
evidence paths. Nothing else.
