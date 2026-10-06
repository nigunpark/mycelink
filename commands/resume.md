---
description: Reconcile and resume a feature after a crash, compaction or new session
argument-hint: <feature-id>
allowed-tools: Bash, Read, Glob, Grep, Agent, Write
---

# Resume

Feature: `$0`

Do not rely on anything you remember. Rebuild from the canonical files. Let
`M` be `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs"`.

0. `M controller open --json` and keep `authority` as `<key>` (never in a file
   or a subagent prompt). If it reports `CONTROLLER_BUSY`, a claim is still
   live: use the key you opened earlier in this conversation if you have it;
   otherwise ask the user to run `mycelink controller open --takeover` in
   their own terminal and give you the key.
1. `M session reconcile $0 --json --authority <key>`
   Reclaims dead leases, clears settles whose process died, hands expired
   host dispatches back as interruptions (no failure is recorded), and lists
   the dispatches that are still pending.
2. `M checkpoint validate $0`
   If the checkpoint was taken against a different graph, say so and stop.
3. `M feature status $0`
4. Re-read `features/$0/PRD.md`, `PORTFOLIO-GRAPH.yaml` and `DECISIONS.md`.
5. If there are pending decisions, resolve them before resuming.
6. For each entry in `pending_dispatches`, run
   `M dispatch $0 --resume <node-id> --json --authority <key>`. It re-issues the ticket with a
   new capability (the old one stops working). If `result_present` is true,
   run its `settle_command` directly; otherwise fulfil it with the Agent
   tool exactly as `/mycelink:run` describes.
7. Continue with the `/mycelink:run` loop from `M dispatch $0 --json --authority <key>`.
