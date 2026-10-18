---
name: mycelink-deliver
description: Refuse Codex delivery until independent worker, reviewer, and transaction security gates pass.
---

# Codex deliver: fail closed

Resolve `<plugin-root>/bin/mycelink.mjs` from **this skill's absolute SKILL.md path** (`skills/mycelink-deliver/SKILL.md` under that root). Verify this launcher and `<plugin-root>/dist/mycelink.mjs`; stop if missing. Never use PATH, project cwd, source checkout, or adjacent Claude plugin. Run `node "<plugin-root>/bin/mycelink.mjs" codex deliver <feature-id> --control-root "<absolute-control>" --json`. Expect nonzero `CODEX_RUNTIME_DENIED`. Never bypass it with generic `deliver`, `candidate`, `settle`, `review`, `orchestrate`, or direct `codex exec`. The Codex adapter preflight remains denied; the original Codex host-hook/worker command, path, role, and result-provenance gate remains unresolved. A PRD, graph, and even valid state are not evidence of code implementation, accepted review, or delivery. Report `runtime_enabled: false` and no delivery.
