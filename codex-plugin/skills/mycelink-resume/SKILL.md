---
name: mycelink-resume
description: Resume experimental Codex continuation through safely recovered held authority in disposable repositories.
---

# Codex resume: official continuation

Resolve `<plugin-root>/bin/mycelink.mjs` from **this skill's absolute SKILL.md path** (`skills/mycelink-resume/SKILL.md` under that root). Verify this launcher and `<plugin-root>/dist/mycelink.mjs`; stop if missing. Never use PATH, project cwd, a source checkout, or adjacent Claude plugin.

Continue an existing valid controller with `node "<plugin-root>/bin/mycelink.mjs" codex continue <feature-id> --review --deliver --max-nodes 8 --max-reviews 6 --control-root "<absolute-control>" --json`. The same command supports a fresh control and holds authority across bounded workers, independent review and delivery. Require an approved PRD with CLI-created ACCEPTANCE.json, a reviewed valid graph, registered disposable Git repositories and explicit `experimental_codex.enabled: true` with every repository in `experimental_codex.disposable_repositories`. Never opt in a production checkout; complete mycelink-plan preflight before workers.

When authority already exists, the CLI verifies the recorded prior holder identity and proves its PID has exited before requesting recovery; the engine rechecks under its lock and enforces identity, host, adapter and settler rules. Active or unverifiable holders fail closed. Do not pass `--authority`, `--recover` or `--takeover`, copy authority, or bypass review. Existing feature state is retained; initialization occurs only when state is absent. If a built candidate exists after prior PASS, continuation resumes that pinned candidate without a second review, subject to the finalizer's review, settled-node, VERIFIED and drift checks. Inspect `codex status` and actual receipts; nonzero exit, GAPS or exhausted bounds is not completion.

Standalone `codex resume` remains denied with `CODEX_RUNTIME_DENIED`; standalone `codex deliver` is also denied. Do not bypass with generic `dispatch`, `session`, `orchestrate`, `candidate`, `deliver` or direct `codex exec`.
