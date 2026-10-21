---
name: mycelink-prd
description: Author and register approved PRD acceptance criteria in a Codex planning-only control; no worker execution.
---

# Codex PRD (planning only)

Use **this skill's absolute SKILL.md path** to locate the plugin root (two parent directories above `skills/mycelink-prd`), and verify `<plugin-root>/bin/mycelink.mjs` and `<plugin-root>/dist/mycelink.mjs`. Invoke `node "<plugin-root>/bin/mycelink.mjs"`; never resolve from PATH, cwd, or Claude assets. Stop if unavailable. Use `--control-root "<absolute-control>"` for every command. Confirm `mycelink.config.json` has `provider.provider: codex`; do not convert an existing Claude control.

Discuss requirements with the operator and write `features/<id>/PRD.md` explicitly as a **draft**, not an implemented feature. Obtain approval for the exact acceptance criteria (e.g. `**AC-1 — ...**`); preserve them verbatim, label compatibility/declaration kinds explicitly. Keep hidden evaluator content and private reference solutions out of all prompts, PRD, PLAN, and graph. The CLI does not generate or approve requirements by itself.

After explicit PRD approval, keep the approved `features/<id>/PRD.md` unchanged and proceed to mycelink-plan. Draft and review the graph first, then use `codex prepare <id> --source features/<id>/PRD.md --from features/<id>/PORTFOLIO-GRAPH.draft.yaml --kind AC-n=compatibility --control-root "<control>" --json` (omit `--kind` if all criteria are new behavior). This one fresh-control planning command extracts the PRD's exact criteria into ACCEPTANCE.json and compiles/validates the reviewed graph **without minting controller authority**. Inspect the returned criteria and graph hash. Generic `feature acceptance` requires an existing controller key and is not the fresh Codex workflow. Never run `controller open` or `feature init` before a new `codex continue`, which must hold the only execution authority. No worker or review has started yet.
