---
description: Run a feature host-natively — dispatch each READY node to the module-worker subagent, settle it, then deliver
argument-hint: <feature-id>
allowed-tools: Bash, Read, Glob, Grep, Agent, Write, AskUserQuestion
---

# Run the feature

Feature: `$0`

Use the `host-dispatch` skill. The controller decides what runs; you carry
tickets between it and the Agent tool. You do not implement nodes yourself,
you do not edit controller files, and you never start a nested `claude`
process.

Let `M` be the launcher: `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs"`.

0. You need the controller key; below it is `<key>`. Use the one you hold
   from earlier in this conversation (`/mycelink:init` opens it). Only if
   this control repository has never had one, run `M controller open --json`
   and keep its `authority`. If that answers `CONTROLLER_AUTHORITY_EXISTS`
   and you do not hold the key, stop and ask the user to run
   `mycelink controller open --takeover` in their own terminal and give you
   the key; never search for it. Every controller command needs
   `--authority <key>`; `settle` and the gates do not (they use the
   ticket's capability). The key is yours alone: never put the key in the
   Agent prompt, a file or an environment variable, and never pass it to the
   subagent.
1. `M loop validate $0`
2. `M orchestrate ready $0` — show the user which nodes are schedulable and
   why the rest are deferred.
3. Loop, **at most 3 × (number of graph nodes) iterations**:
   1. Run `M dispatch $0 --json --authority <key>` and read `status`.
   2. If `status` is `DISPATCHED`, take the `ticket` and call the **Agent
      tool** with `subagent_type` set to `ticket.agent`
      (`mycelink:module-worker`), a short `description` naming
      `ticket.node_id`, and `prompt` set to `ticket.prompt` exactly. Do not
      add instructions to it and do not do the node's work yourself.
   3. When the Agent returns, check that the file at `ticket.result_slot`
      exists. If it does not, write the JSON node result the subagent
      returned in its final message to `ticket.result_slot` with the Write
      tool. If it returned none, write
      `{"schema_version": 1, "node_id": <ticket.node_id>, "claim_id": <ticket.claim_id>, "dispatch_id": <ticket.dispatch_id>, "outcome": "RETRYABLE", "commands": [], "evidence_paths": [], "failure_fingerprint": "WORKER_RESULT_MISSING"}`.
      Never write a result that claims more than the subagent reported.
   4. Run `ticket.settle_command` exactly (it is
      `M settle $0 <node-id> --capability <capability> --json`). Settle
      re-verifies on a clean checkout, integrates, and marks the node DONE
      only if everything holds. Report its `outcome`, then continue the loop.
   5. Any other `status` ends the loop; handle it below.

Stop reasons:

- `ALL_SETTLED` — every node is DONE (controller nodes such as the
  candidate build ran inside `dispatch`). Run `M feature verify $0` and
  `M candidate verify $0`; if both exit 0, run
  `M deliver $0 --json --authority <key>` and
  report the delivered SHAs and acceptance evidence.
- `WAITING` — a dispatched node was not settled (an interrupted turn). Run
  `M session reconcile $0 --json --authority <key>`; for each
  `pending_dispatches` entry run
  `M dispatch $0 --resume <node-id> --json --authority <key>` and continue the loop with that
  ticket (settle it directly if `result_present` is true). Resume a node at
  most twice; after that, report it.
- `NEEDS_DECISION` — read `features/$0/DECISIONS.md`, ask the user with
  AskUserQuestion, `M decision record $0 <id> --answer "..." --authority <key>`,
  then `M decision apply $0 <id> --authority <key>`, then continue. Never
  answer it yourself.
- `BLOCKED` — report the node, its repeated failure fingerprint, the
  commands and exit codes, and the nearest reproducible test layer. Do not
  retry it with another agent and do not try to unblock it yourself.
- `BUDGET_EXHAUSTED` — report what was spent and what remains.
- `NO_PROGRESS` — report what is deferred and why.
- `INFRASTRUCTURE_FAILURE` — the controller could not set up a claim
  (worktree, git). Nothing was charged; report the detail.
- `PRECONDITION_FAILED` — a controller node (the candidate build) needs a
  clean control repository and found uncommitted files; nothing was
  charged. If the files listed are Mycelink scaffolding or feature files
  you created (`features/`, `repositories.yaml`, `.gitignore`, `CLAUDE.md`,
  `.claude/settings.json`, `mycelink.config.json`), commit them in the
  control repository (`git -C <control> add -A` then `git commit`) and
  dispatch again; otherwise report them to the user.
- `CONTROLLER_FAILED` — a controller node ran and failed. Report its
  detail; do not edit controller files to make it pass.

If the loop limit is reached, stop and report the last dispatch output.

Report completed nodes, the current node, any stop reason and real evidence
paths — nothing else. `orchestrate run` is the optional standalone CLI
adapter for use outside Claude Code; it is not part of this command.
