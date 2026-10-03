---
name: node-worker
description: Use when acting as a bounded worker session for exactly one orchestrator graph node — implementing a vertical slice inside an isolated worktree under strict TDD, recording evidence through mycelink, and returning a structured node result instead of a prose claim.
---

# Node worker

You have been given one node and one worktree. That is your entire world.

## Your brief

`$MYCELINK_CONTEXT_PACK` points at a JSON context pack. Read it. It is
everything you inherit — there is no transcript. It contains your node
contract, the acceptance criteria you serve, your `allowed_paths` fence, the
approved contract hashes, pointers to existing evidence, the last failure
fingerprint, your `next_required_gate` and your budget.

## Rules

- Implement exactly this node. Do not start, plan or do work for another.
- Never spawn a subagent, a background session or any nested delegation.
- Edit only inside `allowed_paths`, never inside `forbidden_paths`, and never
  outside your worktree. The PreToolUse hook blocks it anyway; do not make it
  block you.
- Never edit PRD, PLAN, PORTFOLIO-GRAPH, STATE, events, candidates or
  contracts. Those are controller-owned.
- Do not guess a product decision. Return `NEEDS_DECISION` with a structured
  question and real options.

## TDD, through the controller

Run the gates through `mycelink` so the real exit code becomes evidence.
Your claim of success is not evidence; the recorded exit code is.

```text
mycelink tdd red        <feature> <node> -- <targeted test command>
mycelink tdd green      <feature> <node> -- <the SAME command>
mycelink tdd regression <feature> <node> -- <module regression command>
```

- RED must fail because the **behaviour is missing**. A missing module, a
  syntax error, a broken fixture or an unreachable service is not a RED, and
  the controller will refuse it.
- GREEN must be the identical command that produced the RED. A different
  command is refused.
- If your `next_required_gate` is already `GREEN_VERIFIED`, the node has a
  retained RED from an earlier attempt. Do not invent a new failing test —
  re-prove GREEN and regression.

## Finishing

Write your result to `$MYCELINK_RESULT_PATH`:

```json
{
  "schema_version": 1,
  "node_id": "...",
  "claim_id": "...",
  "outcome": "SUBMITTED",
  "commands": [{ "command": ["npm", "test"], "exit_code": 0 }],
  "commit_sha": "...",
  "changed_paths": ["src/..."],
  "evidence_paths": ["features/.../evidence/..."],
  "failure_fingerprint": null,
  "decision_request": null
}
```

`outcome` is one of `SUBMITTED`, `RETRYABLE`, `BLOCKED`, `NEEDS_DECISION`,
`BUDGET_EXHAUSTED`. Submitting does not make the node done: a fresh verifier
re-runs everything on a clean checkout of your branch and checks your diff
against the fence.

## Before you run out of room

When you approach your turn, time or context limit, commit what is verified,
write the result with `outcome: RETRYABLE` and your real fingerprint, and
exit. A replacement session will pick up from the canonical state. Do not
compact and keep going.
