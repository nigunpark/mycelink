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
   Re-running it on an existing control repository (after a plugin update)
   is a controller operation: open the key first (step 3) and add
   `--authority <key>`.
2. If `$0` is not yet a git repository, tell the user and stop. Mycelink state
   must be versioned; do not silently `git init` on their behalf.
3. `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" controller open --control-root "$0" --json`
   and keep its `authority` value as `<key>`. Controller commands need
   `--authority <key>`. It is shown once and never stored; never put it in a
   file, an environment variable or a subagent prompt.
4. For each repository the user wants in the portfolio, run
   `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" repo register --control-root "$0" --authority <key> --name <name> --path <relative-path> --base-branch <branch> -- <test argv>`.
   Use the repository's real test command. Do not invent one: read its
   package.json, build file or CI config first.
5. Run `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" repo audit --control-root "$0"`
   and show the user the result. Every repository must be a real git
   repository at the path given.
6. Commit everything `init` and `repo register` created in `$0`
   (`git -C "$0" add -A` then `git -C "$0" commit -m "mycelink control plane"`).
   A candidate is cut only from a control repository that is clean outside
   the feature's own directory, so uncommitted scaffolding stops every run.
7. Run `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" doctor --control-root "$0"`
   and report every failing check.

Report the exact commands you ran and their exit codes. Do not claim the
control repository is ready unless `doctor` exited 0.
