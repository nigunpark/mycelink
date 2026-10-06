---
description: Create or adopt a control repository for multi-repository orchestration
argument-hint: <control-repo-path>
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# Initialise the control repository

Target: `$0`

Do this in order, and do not skip verification.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" init "$0"`.
   This creates `mycelink.config.json`, `repositories.yaml`, `contracts/`,
   `handoffs/`, `features/`, `.mycelink/`, a control-repo `CLAUDE.md`, and
   `.claude/settings.json` wired to the enforcement hooks.
2. If `$0` is not yet a git repository, tell the user and stop. Mycelink state
   must be versioned; do not silently `git init` on their behalf.
3. For each repository the user wants in the portfolio, run
   `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" repo register --control-root "$0" --name <name> --path <relative-path> --base-branch <branch> -- <test argv>`.
   Use the repository's real test command. Do not invent one: read its
   package.json, build file or CI config first.
4. Run `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" repo audit --control-root "$0"`
   and show the user the result. Every repository must be a real git
   repository at the path given.
5. Run `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" doctor --control-root "$0"`
   and report every failing check.

Report the exact commands you ran and their exit codes. Do not claim the
control repository is ready unless `doctor` exited 0.
