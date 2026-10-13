---
description: Prove a feature is complete from evidence, not from assertion
argument-hint: <feature-id>
allowed-tools: Bash, Read, Glob, Grep
---

# Verify

Feature: `$0`

Completion is only real when all of this passes. Run each and report the exit
code:

1. `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" graph validate $0`
2. `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" feature verify $0`
3. `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" branch verify $0`
4. `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" candidate verify $0`
5. `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" e2e plan $0`
6. `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" resource status $0`

Then report, per acceptance criterion, the nodes that cover it and the
evidence paths that prove it. If any command exited non-zero the feature is
not complete — say so plainly and name the gap.
