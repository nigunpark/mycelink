---
description: Stop a feature safely, releasing claims and leases after a checkpoint
argument-hint: <feature-id> [reason]
allowed-tools: Bash, Read
---

# Cancel

Feature: `$0`

1. `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" checkpoint create $0`
2. `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" feature cancel $0 --reason "$1"`
3. `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" session reconcile $0`
4. `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" resource status $0`

Confirm to the user that no lease is still held and no worker is still
running. Report the checkpoint path so the feature can be resumed.
