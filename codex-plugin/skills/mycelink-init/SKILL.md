---
name: mycelink-init
description: Initialise a planning-only Mycelink Codex control repository without Claude hooks or worker dispatch.
---

# Codex planning-only init

Resolve the packaged launcher from **this skill's absolute SKILL.md path**: go up from `skills/mycelink-init/SKILL.md` to the plugin root and use `<plugin-root>/bin/mycelink.mjs`. Verify that file and its sibling `dist/mycelink.mjs` exist before invoking `node "<plugin-root>/bin/mycelink.mjs"`; never use a launcher from PATH, the project cwd, a checkout, or the adjacent Claude plugin. Quote absolute paths. If the plugin root is unavailable, stop rather than guessing.

With the operator's explicit choice of a control directory, run `node "<plugin-root>/bin/mycelink.mjs" codex init "<control-directory>" --json`. It can initialise an existing project (including one with `.codex/config.toml`) and safely re-run for an existing Codex control; it never edits `.codex/config.toml`. It refuses conversion of a Claude control and leaves `.claude/` and `CLAUDE.md` untouched. This creates a Codex-provider control skeleton and repositories.yaml, but **does not install Claude hooks or Codex runtime hooks, register repositories, create a PRD, or start a worker**. `mycelink doctor --control-root "<control-directory>" --json` reports Codex executable/login status without credentials, packaged plugin/skills/launcher health, project sandbox/approval warnings, and the disabled runtime gate. Plugin update/uninstall belongs to `codex plugin` and must never remove unrelated project configuration; reinstall the Mycelink plugin if the launcher is stale. Keep credentials and controller authority out of PRD and worker inputs. See mycelink-prd and mycelink-plan for the manual planning sequence. Codex runtime is denied pending independent security review.
