---
name: brain-memory
description: Use when capturing a durable procedure, policy, decision, pitfall or codebase fact into the optional LLM Wiki Brain, or when recalling memory before planning a task. Covers page schema, provenance, status, supersession, stale handling and the authority order that keeps memory below real evidence.
---

# LLM Wiki Brain

A verified map of past knowledge. Never the territory.

## Authority order

```text
the user's current instruction and organisation policy
> approved PRD / PLAN / DECISIONS
> source code plus real build, test and runtime evidence
> harness canonical files (GRAPH, STATE, evidence)
> verified Brain pages
> partial, stale or contested pages
> conversation history and auto memory
```

A memory never advances a production node to DONE.

## Capture, don't hoard

Capture when the user states something durable: a repeated procedure, a
policy, a design decision with a reason, a costly failure's root cause, or
what a confusingly named piece of code actually does.

Do not capture greetings, one-off task state, TODO text, whole tool logs,
unresolved guesses, secret values, or anything a selector can already find at
its authoritative source.

```bash
mycelink memory capture --type procedure --id deploy-preflight \
  --title "Deploy preflight" --status instructed_not_verified \
  --triggers "deploy,release" --source "user_instruction:session-123" \
  --body-file ./procedure.md
```

A procedure the user described but that was never executed here is
`instructed_not_verified`, not `verified`. Those are different facts.

## Recall before planning

```bash
mycelink memory context-pack --query "<task>" --max-bytes 2048
```

Order: policy, procedure, decisions, similar episodes and pitfalls, then
code module/contract/flow. Check for stale and contested pages before relying
on anything. Record which memories you actually *used*, not merely read.

## Status means something

| Status | Meaning |
|---|---|
| `verified` | At least one verification step actually passed. |
| `instructed_not_verified` | The user said so; nobody has run it here. |
| `partial` | Only one side was verified (e.g. producer, not consumer). |
| `stale` | A watched source changed; re-verify before relying on it. |
| `contested` | The user's description and the code disagree. |
| `superseded` | Replaced; excluded from default retrieval, kept for audit. |

`not_run` is never rewritten to `passed`.

## Correcting a memory

Never silently overwrite. Write a new page and link it:

```bash
mycelink memory supersede --old <old-id> --new <new-id>
```

When code changes, mark only what it affects:

```bash
mycelink memory stale --changed src/queue/client.ts,src/api/jobs.ts
```

## Code claims need anchors

A `code-module`, `code-contract` or `code-flow` page is rejected unless at
least one source ref carries a symbol or a content hash. A description is not
evidence.

## Consolidation is a review queue

`mycelink memory consolidate` reports duplicate triggers, orphan
references, promotion candidates and pages marked verified with nothing
verified. It never merges automatically.

## Success measure

Not page count. Whether the next task retrieved and *used* the right memory,
and whether it reduced searching and repeated mistakes.
