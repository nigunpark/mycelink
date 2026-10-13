# Mycelink control repository

This repository owns the authoritative execution state for multi-repository
features. Conversation history is never the source of truth.

## Authoritative artifacts

| Path | Owner | Meaning |
|---|---|---|
| `repositories.yaml` | human | the portfolio manifest and real build/test commands |
| `contracts/` | human + producer nodes | cross-repository contracts |
| `handoffs/` | controller | approved producer→consumer handoffs |
| `features/<id>/PRD.md`, `PLAN.md` | human-approved | the requirement |
| `features/<id>/PORTFOLIO-GRAPH.yaml` | planner, validated | the executable graph |
| `features/<id>/STATE.json` | **controller only** | current node states |
| `features/<id>/events.jsonl`, `RUNS.jsonl` | **controller only** | append-only audit |
| `features/<id>/evidence/` | controller | real command output |
| `features/<id>/candidates/` | **controller only** | immutable cross-repo manifests |
| `features/<id>/DECISIONS.md` | human | product decisions |
| `.mycelink/` | controller | worktrees, integration checkouts, deploys (not committed) |

## Rules

- Never hand-edit `STATE.json`, `events.jsonl`, `RUNS.jsonl`, `leases.json`,
  `repos.lock.yaml` or anything under `candidates/`. Use `mycelink`; the
  project hooks block direct edits anyway.
- A node advances only on a real exit code recorded as evidence. A sentence
  claiming success is not evidence.
- RED must fail because the behaviour is missing. A missing module, a syntax
  error or an unreachable service is not a RED.
- GREEN must re-run the identical command that produced the RED.
- Only one full runtime may exist. E2E holds a capacity-1 lease for the whole
  run, released in `finally` on every path.
- Workers implement one node, inside one worktree, within one ownership
  fence, and never spawn subagents.
- Run features with `/mycelink:run`: `mycelink dispatch` hands out one ticket
  at a time for the Agent tool's `module-worker`, and `mycelink settle`
  takes the result back. Never hand-progress nodes or do a worker's job in
  the host session; deliver with `mycelink deliver`.
- Ask the user only about product decisions, and record them in
  `DECISIONS.md`.

## Commands

```text
mycelink doctor
mycelink graph validate <feature>
mycelink feature init|status|verify <feature>
mycelink orchestrate ready|once|run <feature>
mycelink node claim|verify|release|invalidate <feature> <node>
mycelink tdd red|green|regression <feature> <node> -- <command>
mycelink candidate create|verify|list <feature>
mycelink e2e plan|run <feature>
mycelink resource status|recover <feature>
mycelink session status|reconcile <feature>
mycelink decision list|record|apply <feature> [id]
mycelink checkpoint create|validate|restore <feature>
```
