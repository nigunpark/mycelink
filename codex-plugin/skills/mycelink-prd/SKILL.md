---
name: mycelink-prd
description: Author and register approved PRD acceptance criteria in a Codex planning-only control; no worker execution.
---

# Codex PRD (planning only)

Use **this skill's absolute SKILL.md path** to locate the plugin root (two parent directories above `skills/mycelink-prd`), and verify `<plugin-root>/bin/mycelink.mjs` and `<plugin-root>/dist/mycelink.mjs`. Invoke `node "<plugin-root>/bin/mycelink.mjs"`; never resolve from PATH, cwd, or Claude assets. Stop if unavailable. Use `--control-root "<absolute-control>"` for every command. Confirm `mycelink.config.json` has `provider.provider: codex`; do not convert an existing Claude control.

Discuss requirements with the operator and write `features/<id>/PRD.md` explicitly as a **draft**, not an implemented feature. Obtain approval for the exact acceptance criteria (e.g. `**AC-1 — ...**`); preserve them verbatim, label compatibility/declaration kinds explicitly. Keep hidden evaluator content and private reference solutions out of all prompts, PRD, PLAN, and graph. The CLI does not generate or approve requirements by itself.

Controller state changes require the operator-held `--authority <key>` from `node "<launcher>" controller open --control-root "<control>" --json`; never write the key to a file, prompt, chat transcript, or worker input. After explicit PRD approval: `node "<launcher>" feature acceptance <id> --source features/<id>/PRD.md --kind AC-n=compatibility --control-root "<control>" --authority <key> --json` (omit `--kind` only when every criterion is new behavior). Check the manifest in `features/<id>/ACCEPTANCE.json`: exact source hash, text, and kinds. Existing sidecars are validated, not overridden. No worker/reviewer/delivery is enabled. See mycelink-plan next.
