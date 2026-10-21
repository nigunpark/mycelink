---
name: mycelink-status
description: Inspect graph, state and experimental disposable worker eligibility.
---

# Mycelink Codex status

Locate the packaged launcher from **this SKILL.md's absolute path**: ascend from `skills/mycelink-status/SKILL.md` to the plugin root and verify `bin/mycelink.mjs` and `dist/mycelink.mjs` there. Use `node "<plugin-root>/bin/mycelink.mjs"`; never search PATH/cwd, nor invoke a launcher from the adjacent Claude plugin. If missing, stop.

Run `node "<launcher>" codex status <feature-id> --control-root "<absolute-control>" --json`. Inspect `graph_valid`, `state_present`, `feature_state`, node states, `runtime_enabled` and `runtime_reason`. A true runtime preflight denotes eligibility for experimental disposable workers, **not** that implementation, review or delivery occurred. A valid graph or `doctor` smoke does not authorize delivery. The fresh `codex continue --review --deliver` path requires explicit opt-in, registered disposable repositories and its own held controller authority; it delivers only after a new PASS and post-delivery tests. Standalone `codex deliver`, generic dispatch/review/candidate commands and direct worker calls are not substitutes. Inspect state and delivered SHA for actual completion.
