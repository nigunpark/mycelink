---
description: Show the current orchestration state for a feature
argument-hint: <feature-id>
allowed-tools: Bash, Read
---

# Status

Feature: `$0`

Run, and report verbatim:

- `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" feature status $0`
- `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" orchestrate ready $0`
- `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" resource status $0`
- `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" loop budget $0`
- `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" session status $0`

Do not infer progress from anything other than this output. Its `next:` line
(`next_action` and `resumable` with `--json`) says what the next controller
step is and whether a controller can take it without a person: an
incomplete feature with `resumable` true is continued by the next host
invocation of `/mycelink:run`. `review-refine`: a worker's valid challenge of an
acceptance review gap waits for a fresh reviewer's refinement, which the
next `dispatch` hands out. `await-reviewer`: the reviewer launched for the
open review generation is still running; `next_action.reviewer` gives its
state, its Agent task and agent by hash, and how long it has run of its
wall-clock and has left. Wait for it (`review await $0 --review <id>`); it is
never settled, corrected or re-issued while it runs.
