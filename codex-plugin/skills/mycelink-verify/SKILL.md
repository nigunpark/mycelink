---
name: mycelink-verify
description: Refuse Codex worker verification and acceptance review until the runtime security gate passes.
---

# Codex verify: fail closed

Resolve `<plugin-root>/bin/mycelink.mjs` from **this skill's absolute SKILL.md path** (`skills/mycelink-verify/SKILL.md` under that root). Verify this launcher and `<plugin-root>/dist/mycelink.mjs`; stop if missing. Never use PATH, cwd, source checkout, or adjacent Claude plugin. Run `node "<plugin-root>/bin/mycelink.mjs" codex verify <feature-id> --control-root "<absolute-control>" --json`. Expect nonzero `CODEX_RUNTIME_DENIED`. Graph validation with `graph validate` is a planning check, **not** fresh verification of code or acceptance. Do not invoke generic `feature verify`, `review`, `e2e`, `candidate`, `settle`, or a direct Codex worker as a workaround. The Codex adapter preflight is denied and the original Codex host-hook/worker security review remains unresolved. Report missing verification honestly.
