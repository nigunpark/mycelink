---
name: mycelink-verify
description: Explain standalone Codex verify denial; use held-authority continue for bounded opt-in review and delivery.
---

# Codex verify: fail closed

Resolve `<plugin-root>/bin/mycelink.mjs` from **this skill's absolute SKILL.md path** (`skills/mycelink-verify/SKILL.md` under that root). Verify this launcher and `<plugin-root>/dist/mycelink.mjs`; stop if missing. Never use PATH, cwd, source checkout, or adjacent Claude plugin. Run `node "<plugin-root>/bin/mycelink.mjs" codex verify <feature-id> --control-root "<absolute-control>" --json`. Expect nonzero `CODEX_RUNTIME_DENIED`: this standalone command cannot establish or recover held controller authority. Graph validation with `graph validate` is a planning check, **not** fresh verification of code or acceptance. Do not invoke generic `feature verify`, `review`, `e2e`, `candidate`, `settle`, or a direct Codex worker as a workaround. An approved disposable graph with explicit opt-in may instead run the **separate** `mycelink-run` skill's bounded foreground `codex continue --review --deliver`, which verifies against the candidate within one held authority; it is not this standalone command. Without opt-in, or after failed gates or stale authority, report missing verification honestly. The original hostile-worker OS boundary remains unverified.
