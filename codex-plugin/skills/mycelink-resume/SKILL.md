---
name: mycelink-resume
description: Refuse Codex resume while worker claims and security transaction remain unsupported.
---

# Codex resume: fail closed

Resolve `<plugin-root>/bin/mycelink.mjs` from **this skill's absolute SKILL.md path** (`skills/mycelink-resume/SKILL.md` under that root). Verify this launcher and `<plugin-root>/dist/mycelink.mjs`; stop if missing. Never use PATH, project cwd, a source checkout, or adjacent Claude plugin. Run `node "<plugin-root>/bin/mycelink.mjs" codex resume <feature-id> --control-root "<absolute-control>" --json`. Expect nonzero `CODEX_RUNTIME_DENIED`. Do not resume a worker through generic CLI `dispatch`, `session`, `orchestrate`, or direct `codex exec`. The existing adapter preflight denies Codex workers; the separate Windows Session 0 DPAPI/WSL transaction security gate is unresolved. Read `codex status` if state inspection is needed; no work has been resumed.
