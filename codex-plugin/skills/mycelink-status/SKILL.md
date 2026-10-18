---
name: mycelink-status
description: Explain Mycelink's Codex plugin discovery status and the disabled worker/runtime gate.
---

# Mycelink Codex status

This plugin supplies an informational skill only. **Mycelink Codex worker/runtime execution is disabled pending security review.** Do not start a worker, call `mycelink init` for Codex, install Claude hooks into a Codex workspace, or imply parity with the Claude Code plugin. Installing this plugin does not enable Codex dispatch or attest a secure boundary.

The release ZIP also contains a separate Mycelink CLI (`bin/mycelink.mjs`) for existing workflows. Its `doctor --json` can check a configured control repository, but a bare workspace correctly reports missing configuration. Do not treat a successful installation or a doctor smoke test as authorization to run a Codex worker. Consult `docs/CODEX_COMPATIBILITY.md` in the source repository for the security gate and unresolved risks.
