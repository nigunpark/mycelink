---
description: Reconcile and resume a feature after a crash, compaction or new session
argument-hint: <feature-id>
allowed-tools: Bash, Read, Glob, Grep
---

# Resume

Feature: `$1`

Do not rely on anything you remember. Rebuild from the canonical files.

1. `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" session reconcile $1`
   Reclaims dead leases, closes orphaned sessions and returns their nodes to
   a safe state.
2. `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" checkpoint validate $1`
   If the checkpoint was taken against a different graph, say so and stop.
3. `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" feature status $1`
4. Re-read `features/$1/PRD.md`, `PORTFOLIO-GRAPH.yaml` and `DECISIONS.md`.
5. If there are pending decisions, resolve them before resuming.
6. `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" orchestrate run $1 --json`
