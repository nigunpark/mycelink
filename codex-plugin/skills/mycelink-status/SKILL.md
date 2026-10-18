---
name: mycelink-status
description: Inspect validated graph and saved feature state in a planning-only Codex control; report runtime denial.
---

# Mycelink Codex status

This plugin supplies planning skills only. Locate the packaged launcher from **this SKILL.md's absolute path**: ascend from `skills/mycelink-status/SKILL.md` to the plugin root and verify `bin/mycelink.mjs` and `dist/mycelink.mjs` there. Use `node "<plugin-root>/bin/mycelink.mjs"`; never search PATH/cwd, nor invoke a launcher from the adjacent Claude plugin. If missing, stop.

Run `node "<launcher>" codex status <feature-id> --control-root "<absolute-control>" --json`. Inspect `graph_valid`, `state_present`, `feature_state`, node states, and `runtime_enabled`. **Mycelink Codex worker/runtime execution is disabled pending security review.** Even a valid graph and initialised state do not authorize dispatch, reviewers, verification or delivery. `doctor --json` can check configuration but a doctor smoke is not a runtime grant. No automatic PRD authoring or PRD implementation is provided. Do not run `orchestrate`, `dispatch`, `session spawn`, `review`, `settle`, `candidate`, `e2e`, or `deliver` via the generic CLI for this Codex control.
