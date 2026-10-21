---
name: mycelink-deliver
description: Refuse Codex delivery until independent worker, reviewer, and transaction security gates pass.
---

# Codex deliver: fail closed

Resolve `<plugin-root>/bin/mycelink.mjs` from **this skill's absolute SKILL.md path** (`skills/mycelink-deliver/SKILL.md` under that root), verifying the launcher and bundled runtime. Never use PATH, cwd/source or Claude assets. **Standalone `codex deliver` remains denied**; do not bypass with generic `deliver`, `candidate`, `settle`, `orchestrate` or direct `codex exec`. The supported experimental delivery path is a *fresh* `codex continue <feature-id> --review --deliver --max-nodes <1-8> --max-reviews <1-6> --control-root "<absolute-control>" --json` with no existing controller key, an approved PRD/graph and explicit disposable-repository opt-in. It retains one controller authority through workers, independent review, candidate and post-delivery verification. It delivers only after a fresh PASS; GAPS, exhausted bounds, failed tests or a stale candidate are not delivery. Read back the delivered base's exact Git HEAD, candidate binding and independent post-delivery test receipts before reporting success. A closed authority cannot be reused or recovered by this command.
