---
description: Stop a feature safely, releasing claims and leases after a checkpoint
argument-hint: <feature-id> [reason]
allowed-tools: Bash, Read
---

# Cancel

Feature: `$0`

Controller commands need `--authority <key>`: the controller key you
already hold in this conversation. Only if this control repository has never
had one, run `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" controller open --json` and keep `authority`. If that
answers `CONTROLLER_AUTHORITY_EXISTS` and you do not hold the key, ask the
user to run `mycelink controller open --takeover` in their own terminal and
give it to you; never search for it.

1. `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" checkpoint create $0`
2. `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" feature cancel $0 --reason "$1" --authority <key>`
3. `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" session reconcile $0 --abandon-dispatches --authority <key>`
4. `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" resource status $0`

Confirm to the user that no lease is still held, no worker is still
running and no dispatch ticket is still outstanding. Report the checkpoint
path so the feature can be resumed.
