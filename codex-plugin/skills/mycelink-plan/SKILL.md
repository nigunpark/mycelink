---
name: mycelink-plan
description: Compile and validate an operator-reviewed PRD graph in a Codex control, without running agents.
---

# Codex graph planning (no dispatch)

Find the packaged launcher from **this skill's absolute SKILL.md path**: plugin root is above `skills/mycelink-plan`; verify `<plugin-root>/bin/mycelink.mjs` and `<plugin-root>/dist/mycelink.mjs`. Invoke `node "<plugin-root>/bin/mycelink.mjs"` with quoted absolute paths, never a PATH/cwd/Claude launcher. Stop if either file is missing. Ensure `mycelink.config.json` says `provider.provider: codex` and the PRD's approved `ACCEPTANCE.json` exists.

Write `features/<id>/PLAN.md` and a **draft** graph, with all acceptance criteria copied exactly (id, text, kind; omit the manifest-only sha256 field) from the manifest; do not paraphrase. The CLI can list adapters with `graph adapters --json` or produce an unapproved draft with `graph import <id> --adapter <name> ...`; import never approves a graph. Require operator review of repositories, dependencies, allowed/forbidden paths, verification commands and criteria before compile. Drafting, compilation and validation do not require controller authority; leave the fresh control without a key until `codex continue` starts.

After approval: `node "<launcher>" graph compile <id> --from "<reviewed-draft.yaml>" --control-root "<control>" --json`, then `node "<launcher>" graph validate <id> --control-root "<control>" --json`. Planning/compile/validate need no controller key. Do not run `controller open` or `feature init` here: a subsequent fresh `codex continue` opens and holds authority, initialises state once and invokes bounded workers/review. Read `codex status <id> --control-root "<control>" --json` and report any preflight denial truthfully. Graph validation does not prove implementation, review or delivery. See mycelink-run for explicit opt-in and the held-authority workflow.
