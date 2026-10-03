# Permission model

Who may do what, and where the switch for it lives.

## Principles

1. **Configuration is the operator's.** Anything that widens trust lives in
   the control repository's `mycelink.config.json` or `.claude/settings.json`,
   which a model session cannot edit (the PreToolUse hook blocks it).
2. **Plans are data.** A PRD, plan or graph can *request* behaviour through
   structured fields, but cannot *grant* it.
3. **Least privilege by default.** Every escape hatch defaults to off.

## Defaults

| Capability | Default | How to change | Who can change it |
|---|---|---|---|
| Worker edits | only inside the node's worktree and `allowed_paths`, never `forbidden_paths` | the node's graph fields (validated) | graph author, after review |
| Production edits before RED | blocked | — | nobody |
| Subagents / nested delegation from a worker | blocked | — | nobody |
| Shell execution of verifiers | off | `allow_shell_commands: true` **and** `shell: true` on the verifier | operator (config) + graph author |
| Shell execution of E2E runtime steps | never | — | nobody |
| Worker permission bypass (`--dangerously-skip-permissions`, `bypassPermissions`) | refused | `allow_dangerous_permission_bypass: true` | operator (config) |
| Worker tool permissions | Claude Code defaults for print mode, plus the controller's protocol grants below | `claude_extra_args`, e.g. `--allowed-tools` | operator (config) |
| Controller protocol grants | `Edit(./.mycelink-worker/result.json)` and the exact `mycelink tdd red/green/regression` lines for the node | — | nobody (controller-built, not graph-authored) |
| Raw `git push` / `merge` / `rebase` / `cherry-pick` / `worktree add|remove` in a session | blocked by hook | — | nobody (use the `mycelink` equivalents) |
| Automatic push, force-push, fetch | never performed | — | nobody |
| Repository discovery | none; only `repositories.yaml` entries | `mycelink repo register` | operator |
| Writer concurrency | 2 | `feature init --writer-concurrency N` | operator |
| `full-runtime`, `deploy-slot`, `fixture-global-reset` capacity | 1 | — (validator enforces 1) | nobody |
| `browser-worker` capacity | 2 | graph `resources` | graph author, after proving isolation |
| Always-on hooks | none at plugin level; project-scoped hooks only in control repositories | `mycelink init` / `--no-hooks` | operator |

## Shell mode, explicitly

Shell mode exists because some verification steps genuinely need pipes or
`&&`. When enabled, the verifier's single script string is passed to
`/bin/sh -c` (POSIX) or `cmd.exe /d /s /c` (Windows), and **everything in it is
interpreted by the shell**. That means anyone who can author or alter a graph
can run arbitrary commands as you. Enable it only when every graph author is
trusted to that degree, prefer a script file in the repository invoked via
argv (`[node, scripts/verify.mjs]`) instead, and keep it off in shared or
automated environments.

## Worker sessions

Worker sessions run `claude -p` in print mode with the node's worktree as
working directory. Print mode cannot ask for interactive approval, so a worker
can only use tools allowed by Claude Code's settings and by
`claude_extra_args`. Grant the minimum a node type needs, for example:

```json
{
  "claude_extra_args": ["--allowed-tools", "Read", "Edit", "Write", "Glob", "Grep", "Bash(npm test:*)"]
}
```

Prefer path- and command-scoped rules when you can, as the real-Claude
pilot does: `Edit(./src/**)`, `Edit(./tests/**)`, `Bash(node tests/run.mjs)`,
`Bash(git add:*)`, `Bash(git commit:*)`. Repeated `--allowed-tools` flags
merge, so these combine with the controller's own grants.

The controller adds exactly two kinds of grant itself, because the worker
protocol cannot work without them and print mode cannot ask:

- `Edit(./.mycelink-worker/result.json)` — the one result file, relative to
  the worktree. Verified on Claude Code 2.1.288 to permit that file and
  nothing else. The PreToolUse hook also exempts exactly that path from the
  ownership fence and the RED gate.
- `Bash(<exact line>)` for each `mycelink tdd red|green|regression` call the
  node requires, built from controller-known argv with no `-- <command>`
  passthrough, so each runs only the node's declared verifier. An exact rule
  does not match any other command line. Arguments that a shell could
  reinterpret (quotes, `$`, backticks, backslashes, newlines) are refused
  rather than escaped.

Workers never receive the context-pack path or a controller path in their
environment, and are never asked to expand a variable or read outside their
worktree.

Bypassing permissions turns every worker into an unrestricted process with
your privileges; Mycelink refuses it unless you opt in, and you should opt in
only inside a disposable sandbox (container or VM) that holds no credentials
you care about.

## Hooks

`mycelink init` writes project hooks with absolute paths to the installed
launcher. They enforce state ownership, controller bypass rules, fences and
the RED gate. A successful hook writes nothing; a block writes at most 1 KiB to
stderr and exits 2; no hook invokes a model. Re-run `init` after updating the
plugin (see README, *Update and uninstall*); `doctor` reports stale hooks.
