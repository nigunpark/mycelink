---
description: Show the current orchestration state for a feature
argument-hint: <feature-id>
allowed-tools: Bash, Read
---

# Status

Feature: `$1`

Run, and report verbatim:

- `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" feature status $1`
- `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" orchestrate ready $1`
- `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" resource status $1`
- `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" loop budget $1`
- `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" session status $1`

Do not infer progress from anything other than this output.
