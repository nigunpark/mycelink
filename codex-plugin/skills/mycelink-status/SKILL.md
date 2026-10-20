---
name: mycelink-status
description: Inspect graph, state and experimental disposable worker eligibility.
---

# Mycelink Codex status

Locate the packaged launcher from **this SKILL.md's absolute path**: ascend from `skills/mycelink-status/SKILL.md` to the plugin root and verify `bin/mycelink.mjs` and `dist/mycelink.mjs` there. Use `node "<plugin-root>/bin/mycelink.mjs"`; never search PATH/cwd, nor invoke a launcher from the adjacent Claude plugin. If missing, stop.

Run `node "<launcher>" codex status <feature-id> --control-root "<absolute-control>" --json`. Inspect `graph_valid`, `state_present`, `feature_state`, node states, `runtime_enabled` and `runtime_reason`. The latter denotes only an experimental disposable worker preflight, not reviewed/delivered functionality. A valid graph or `doctor` smoke does not authorize delivery. `codex run` requires explicit opt-in, registered disposable repositories and controller authority; do not invoke generic dispatch, reviewer, candidate or deliver commands as a workaround.
