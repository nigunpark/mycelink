# Model-host provider contract

Mycelink's graph, scheduler, state machine, evidence store, TDD gates, candidate construction, and delivery rules are independent of the model host. A provider integration is allowed to translate process and hook protocols; it may not weaken these invariants.

## Session lifecycle

Every provider adapter implements the same four operations:

- `spawn`: start one bounded worker in its assigned worktree from the exact dispatch prompt;
- `poll`: report the latest durable observation without blocking;
- `wait`: resolve only after the worker reaches a terminal state;
- `stop`: terminate the provider session and make later reconciliation possible.

The adapter records a stable provider, adapter, session identity, PID when one exists, log path, result path, start time, and node/claim identity. A clean provider exit is not success unless Mycelink also collects a valid structured result owned by that worker.

## Structured usage

Adapters normalize host-specific events into Mycelink's usage totals: model turns, wall-clock milliseconds, input tokens, output tokens, and session count. Missing provider counters remain zero or explicitly unavailable; they are never estimated from prose. Mycelink independently enforces wall-clock, stall, attempt, and orchestration budgets.

## Result ownership

A worker receives the bounded context pack and exact gate commands, works only in its assigned worktree, and writes its structured result to the worktree result slot. The controller never writes or repairs a worker result. Mycelink removes the result from the worktree exactly once, validates size, links, schema, node, claim, dispatch, epoch, commit, evidence, and ownership, then stores a redacted controller-owned copy.

An acceptance reviewer is read-only except for its one verdict slot. Its final answer or written verdict must be attributable to the launched reviewer session. The controller cannot paste, translate, or recreate that verdict.

## Hook protocol

Provider hooks are translated into one canonical event model containing provider, session/thread/agent identity, current directory, transcript reference, event name, tool name, tool input/output, prompt, and final message. The shared policy engine decides whether to allow, deny, or add bounded context; a provider-specific emitter then produces the host's required response.

Hooks are defense in depth. Security-critical completion, graph-membership, ownership, evidence, and transition checks also run in the CLI/state machine. Claude-only events such as `PostCompact`, `TaskCreated`, and `TaskCompleted` may provide earlier feedback, but Codex support must preserve their core invariant through state transition and settle checks instead of silently omitting it.

## Host identities

Mycelink distinguishes three roles independently of provider vocabulary:

- **controller**: holds controller authority, dispatches tickets, settles results, and never implements product nodes;
- **worker**: holds one claim capability, edits only its assigned worktree/allowed paths, runs exact gates, and cannot invoke controller-only operations;
- **reviewer**: reads the review packet and reviewed checkouts, creates no product changes, and returns one attributable verdict.

Claude `Agent`/`Task` calls and Codex `spawn_agent` calls must both be bound to these canonical roles using provider records plus Mycelink's ticket identity. Model-supplied role labels alone are not authority.

## Provider interruptions

A provider refusal, rate limit, server/network failure, authentication failure, context limit, process loss, or cancellation is classified from bounded top-level provider records. Transient provider failure interrupts the lease without charging a product attempt; authentication or policy failures stop for operator action; context/turn limits follow the configured budget policy. Repeated provider interruptions are bounded and eventually produce `PROVIDER_UNAVAILABLE` rather than an infinite retry loop.

## Transcript and final-output evidence

Provider transcript readers are versioned, bounded, strict parsers. They read only the records required to attest session identity, tool/subagent launch, completion, top-level provider failure, and the final assistant output. Prompts, arbitrary tool output, and secrets are not copied into state.

Claude stream JSON and Codex JSONL are normalized into the same evidence concepts. Undocumented internal formats must fail closed when an expected identity or result cannot be proved. Hook-captured evidence and documented non-interactive JSONL are preferred over scraping terminal text.

## Capability matrix

| Capability | Claude Code baseline | Codex target |
|---|---|---|
| Standalone worker process | `claude -p --output-format stream-json` | `codex exec --json` |
| Interactive worker dispatch | `Agent`/`Task` | `spawn_agent`/`wait` |
| Project/plugin skills | Claude plugin commands, agents, skills | portable plugin skills |
| Pre/post tool fence | Claude hook JSON and exit/output contract | Codex hook JSON permission decisions |
| Compaction checkpoint | `PreCompact` + `PostCompact` | `PreCompact` + canonical-state rehydration at the next supported event |
| Task lifecycle hints | `TaskCreated` + `TaskCompleted` | enforced by dispatch/settle/state transitions; optional host hints only |
| Worker result transport | worktree result slot | same worktree result slot |
| Reviewer verdict transport | attributable final answer or verdict slot | attributable final answer or verdict slot |
| Provider failure evidence | Claude top-level stream/transcript records | Codex top-level JSONL/session records |

## Compatibility rule

A provider is supported only after deterministic fake-provider tests, isolated plugin installation tests, security parity tests, and at least one opt-in live contract test pass for a named provider version. Unsupported host behavior must be reported as a capability gap; it must never be approximated by relaxing the controller/worker fence.
