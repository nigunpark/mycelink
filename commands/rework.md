---
description: Repair a defect QA reports on a delivered feature, as the controller only — attribute it to its producer node, rework it, dispatch module-workers, deliver a new candidate
argument-hint: <feature-id> [QA report]
allowed-tools: Bash, Read, Glob, Grep, Agent, Skill, AskUserQuestion
---

# Rework a delivered feature from QA's report

Feature: `$0`. Without one, it is the feature under `features/` of the
control repository whose delivery QA reports on. QA's report is the rest of
the arguments or the report in this conversation: each failing check and
its message, and the module or repository QA names, if any.

Use the `host-dispatch` skill. Let `M` be the launcher:
`node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs"`, run from the control
repository (or pass `--control-root`).

## A defect QA reports after the delivery

This session is the Mycelink controller and nothing else. Before you read
or edit anything in a product repository, and for the whole session: **do
not edit or commit product code in this session yourself** — no Write or
Edit of a registered repository's files or of its worktrees, no `git
commit`, `revert`, `cherry-pick`, `apply`, `reset`, `restore` or `checkout
-- <path>` there, no shell redirection into them. Product code is the
module-worker's, and so is a ticket's `result_slot`. You do not need
to read product code to attribute the report: Mycelink attributes it.

1. The controller key (`<key>`): the one you hold from earlier in this
   conversation, or, in a new session, `M controller open --recover --json`
   (keep its `authority`). Only if that answers `CONTROLLER_BUSY`, ask the
   operator to run `mycelink controller open --takeover` in their own
   terminal. Never put the key in an Agent prompt, a file or a result.
2. `M feature status $0 --json`.
3. Attribute and rework in one step:
   `M feature rework $0 --since-delivery [<repository>:<path>...] [--acceptance <AC-id,...>] --reason "<QA's failing checks as reported: each check and its message>" --json --authority <key>`
   The reason is at most 2000 bytes and holds nothing but what QA
   reported. Name the acceptance criteria the failing checks exercise (a
   check called `ac2_...` or `AC-2 ...` exercises AC-2) and, when QA names
   a module, its directory as `<repository>:<module directory>/`, with the
   repository's registered name (`repositories.yaml`). It reworks the
   producer node that owns what changed on a delivered base since the
   delivery (the commits QA's report may be about) and that directory, or
   else the single producer node of those acceptance criteria — never the
   candidate build — and its dependents reopen with it; `targets` and
   `attribution` say which.
   - `REWORK_OWNER_AMBIGUOUS` or `REWORK_OWNER_UNKNOWN` (nothing changed):
     `M feature owners $0 [<repository>:<path>...] [--acceptance <AC-id,...>] --since-delivery --json`
     lists the producer nodes and what reworking each reopens; rework the
     one that owns the failing behaviour:
     `M node rework $0 <node-id> --reason "<QA's failing checks as reported>" --json --authority <key>`
   - `REWORK_LIMIT`, `REWORK_PARKED`, `REWORK_BASE_MOVED`,
     `REWORK_FEATURE_STOPPED` or `REWORK_IN_FLIGHT`: nothing changed. Settle
     or reconcile work in flight (`REWORK_IN_FLIGHT`, step 4) and retry;
     report the others. Never work around them, never edit product code
     instead, and never start a new feature.
4. The host loop, as `/mycelink:run` Phases 4 to 8 give it:
   `M dispatch $0 --json --authority <key>`; for a `DISPATCHED` ticket,
   the Agent tool with `subagent_type` from the ticket (the module-worker)
   and the ticket's `prompt` exactly, then
   `M settle $0 <node-id> --capability <the ticket's capability> --json`.
   On `WAITING`, `M session reconcile $0 --json --authority <key>` and
   `M dispatch $0 --resume <node-id> --json --authority <key>` for each
   pending dispatch. Once the reopened nodes are DONE, `dispatch` hands out
   the acceptance review again (a ticket with `kind: acceptance-review`):
   give its prompt to the Agent tool with `subagent_type`
   `mycelink:acceptance-reviewer`, then run its `settle_command`; a GAPS
   verdict reworks its producers and the loop goes on. Repeat until
   `ALL_SETTLED`: the candidate build cuts the new candidate.
5. `M deliver $0 --json --authority <key>`.
6. You are done only when `M feature verify $0 --delivered --json` exits 0.
   Then end with the summary QA asked for: the reworked node, the new
   candidate and the commit it delivered, and the tests its workers ran.
