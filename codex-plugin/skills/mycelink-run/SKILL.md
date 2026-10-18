---
name: mycelink-run
description: Refuse Codex run until the independent Mycelink runtime security gate is authorised.
---

# Codex run: fail closed

Locate the packaged launcher from **this skill's absolute SKILL.md path**, ascending from `skills/mycelink-run/SKILL.md` to the plugin root. Verify `bin/mycelink.mjs` and `dist/mycelink.mjs` there. Do not search PATH, cwd, source checkout, or adjacent Claude assets; stop if missing. Run `node "<plugin-root>/bin/mycelink.mjs" codex run <feature-id> --control-root "<absolute-control>" --json`. Nonzero `CODEX_RUNTIME_DENIED` is expected. Never bypass it via generic `dispatch`, `orchestrate`, `session`, `review`, `settle`, `candidate`, `e2e`, `deliver`, or direct `codex exec`. The CLI Codex adapter preflight denies worker execution; Windows Session 0 DPAPI and independent WSL transaction security remain unresolved. A plan is not PRD implementation. Report the blocker and current status instead.
