# Data handling

Mycelink is local software. This page lists everything it reads and writes,
and what never leaves your machine.

## No telemetry

Mycelink collects no telemetry, analytics or crash reports and makes no
network requests of its own. Network traffic happens only through tools you
run: Claude Code worker sessions (which talk to Anthropic's API under your
account and Claude Code's own data policies), and your repositories' build
and test commands.

## What is written, and where

All paths are inside the control repository unless noted.

| Artifact | Location | Contents | Typically committed? |
|---|---|---|---|
| Manifest and config | `repositories.yaml`, `mycelink.config.json`, `.claude/settings.json` | operator configuration | yes |
| PRD, plan, decisions | `features/<id>/PRD.md`, `PLAN.md`, `DECISIONS.md`, `CHANGES.md` | requirements and answers | yes |
| Graph and state | `features/<id>/PORTFOLIO-GRAPH.yaml`, `STATE.json`, `leases.json` | ids, states, hashes, budgets | yes |
| Event log, run ledger | `features/<id>/events.jsonl`, `RUNS.jsonl` | compact metadata: ids, types, exit codes, fingerprints, paths — never file bodies, diffs or prompts | yes |
| Evidence | `features/<id>/evidence/**` | full stdout/stderr of verification commands (**redacted**) | your choice |
| Context packs | `features/<id>/context-packs/**` | the bounded brief given to a worker (**redacted**) | your choice |
| Session logs | `features/<id>/sessions/**` | worker stream-json output (**redacted**) and result files | usually not |
| Candidates | `features/<id>/candidates/*.yaml` | SHAs and hashes | yes |
| E2E artifacts | `features/<id>/evidence/e2e/**` | test output; your E2E tool may add screenshots and traces under the directories Mycelink names | your choice |
| Worktrees and checkouts | `.mycelink/worktrees`, `.mycelink/integration` | source checkouts of registered repositories | never (ignore `.mycelink/`) |
| Worker branches | `wip/<feature>/<node>` and `feature/<feature>` in each registered repository | your code | your choice; never pushed by Mycelink |

Review evidence and logs before committing or sharing them: they contain
whatever your commands printed.

## Redaction

Before any of the redacted artifacts above is written, Mycelink removes:

- the value of every environment variable whose name contains `TOKEN`,
  `SECRET`, `PASSWORD`, `PASSWD`, `PASSPHRASE`, `API_KEY`, `ACCESS_KEY`,
  `PRIVATE_KEY`, `CLIENT_SECRET`, `CREDENTIAL`, `AUTH` (not `AUTHOR`),
  `COOKIE`, `SESSION_KEY`, `WEBHOOK`, `SIGNING_KEY` or `DSN`, if the value is
  at least 8 characters (names ending in `_PATH`, `_FILE`, `_DIR`, `_HOME`,
  `_SOCK` are treated as locations, not secrets);
- credential shapes regardless of variable names: GitHub tokens
  (`ghp_…`, `github_pat_…`), `sk-…` API keys, AWS access key ids, Slack
  tokens, Google API keys, npm tokens, `Bearer`/`Basic` authorization values,
  `scheme://user:password@` URL credentials, and PEM private-key blocks.

Replaced values read `[REDACTED:<NAME>]`. Redaction is a safety net with known
limits (see [THREAT_MODEL.md](THREAT_MODEL.md)); keep secrets in the
environment rather than in command arguments or graph text.

Environment variables are **inherited** by your commands and worker sessions
so they can work normally; they are never written to Mycelink's artifacts in
clear text.

## Optional Brain memory

If `brain_dir` is configured, `mycelink memory …` writes Markdown pages under
that directory. Pages are retrieval aids, never authority, and are subject to
the same rule: do not capture secrets.

## Deleting data

Mycelink keeps no data outside the control repository and the registered
repositories' worktrees and branches. To remove a feature's data, delete
`features/<id>/`, run `git worktree prune` in each registered repository, and
delete the `wip/<id>/…` and `feature/<id>` branches you no longer need.
Uninstalling the plugin does not delete any of this.
