---
description: Stop a feature safely, releasing claims and leases after a checkpoint
argument-hint: <feature-id> [reason]
allowed-tools: Bash, Read
---

# Cancel

Feature: `$1`

1. `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" checkpoint create $1`
2. `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" feature cancel $1 --reason "$2"`
3. `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" session reconcile $1`
4. `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" resource status $1`

Confirm to the user that no lease is still held and no worker is still
running. Report the checkpoint path so the feature can be resumed.
