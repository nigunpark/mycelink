---
name: mycelink-run
description: Run one experimental Codex worker cycle in explicitly disposable registered repositories.
---

# Codex run: bounded experimental worker cycle

Locate the packaged launcher from **this skill's absolute SKILL.md path**, ascending from `skills/mycelink-run/SKILL.md` to the plugin root. Verify `bin/mycelink.mjs` and `dist/mycelink.mjs` there. Do not search PATH, cwd, source checkout, or adjacent Claude assets; stop if missing. Require a separately initialized Codex control, approved PRD and validated graph; the operator must explicitly configure `experimental_codex.enabled: true` and list **every** registered disposable Git repository under `experimental_codex.disposable_repositories`. Do not set this opt-in yourself or use real production repositories. Open controller authority using the documented controller workflow, then run `node "<plugin-root>/bin/mycelink.mjs" codex run <feature-id> --control-root "<absolute-control>" --authority <controller-key> --json`. This runs **one** controller cycle, not the feature delivery. Keep the key private. On a preflight denial, stop; never bypass using direct `codex exec` or generic runtime commands. Check node state, actual RED/GREEN evidence and Git commits; a completed process is not proof of acceptance. Reviewer, verification and delivery remain disabled in this slice.
