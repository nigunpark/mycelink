---
name: mycelink-plan
description: Compile and validate an operator-reviewed PRD graph in a Codex control, without running agents.
---

# Codex graph planning (no dispatch)

Find the packaged launcher from **this skill's absolute SKILL.md path**: plugin root is above `skills/mycelink-plan`; verify `<plugin-root>/bin/mycelink.mjs` and `<plugin-root>/dist/mycelink.mjs`. Invoke `node "<plugin-root>/bin/mycelink.mjs"` with quoted absolute paths, never a PATH/cwd/Claude launcher. Stop if either file is missing. Ensure `mycelink.config.json` says `provider.provider: codex` and the PRD's approved `ACCEPTANCE.json` exists.

Write `features/<id>/PLAN.md` and a **draft** graph, with all acceptance criteria copied exactly (id, text, kind; omit the manifest-only sha256 field) from the manifest; do not paraphrase. The CLI can list adapters with `graph adapters --json` or produce an unapproved draft with `graph import <id> --adapter <name> ...`; import never approves a graph. Require human review of repositories, dependencies, allowed/forbidden paths, verification commands, and criteria before compile. Controller commands require operator-held `--authority <key>` from `controller open --control-root "<control>" --json`; do not log, store or share it with workers.

After approval: `node "<launcher>" graph compile <id> --from "<reviewed-draft.yaml>" --control-root "<control>" --authority <key> --json`, then `node "<launcher>" graph validate <id> --control-root "<control>" --json`. You may initialise the *graph state* with `feature init <id> --control-root "<control>" --authority <key> --json` only after the graph and repository manifest validate, but this is not a run authorization; do not reinitialise progressed state. Read `codex status <id> --control-root "<control>" --json` and report `runtime_enabled: false` truthfully. Do not dispatch, claim, settle, start a reviewer, or deliver: the security gate is denied.
