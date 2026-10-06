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

## Host-dispatched workers (primary path)

Inside Claude Code, `/mycelink:run` does not start worker processes.
`mycelink dispatch` claims one node and prints a ticket; the host session's
own Agent tool runs the `module-worker` subagent on it, under the host
session's permissions, and `mycelink settle` takes the result back.

- Each claim has a random 256-bit capability. Only its SHA-256 is stored;
  the raw value is printed once in the ticket and appears in the gate
  commands the subagent runs. Gates, evidence, finalize and settle require
  the current claim's capability; a stale (rotated or abandoned) one fails
  closed.
- Controller-only commands (every entry of the CLI's controller-only table:
  init of an existing control repository, repo register/lock, graph
  compile/import, feature init/cancel, node claim/block/invalidate/release/
  verify, session spawn/reconcile/stop, evidence migrate, branch
  create/integrate, candidate create, resource acquire/release/recover, e2e
  run/cleanup, decision record/apply, checkpoint restore, orchestrate
  once/run, dispatch, deliver) need **positive controller authority**:
  `--authority <key>`. Not presenting a capability is not enough, because a
  subagent can always leave out its own. Anyone presenting a capability is
  refused as well, with or without a key.
- The key is a random 256-bit value minted by `mycelink controller open`
  and printed once to the caller; only its SHA-256 is stored, in
  `.mycelink/controller-authority.json` (hook-protected). It never enters a
  ticket, prompt, context pack, worktree, result or environment variable;
  the plugin's commands tell the host to keep it in its own context and pass
  it on the command line.
- The first key of a control repository can be minted by anyone, but only
  before one exists, which is before anything can be dispatched (dispatch
  needs it), so before any worker exists. After that a key is minted only
  by presenting the current one (rotation, refused while any claim is live)
  or by `mycelink controller open --takeover`, which requires an interactive
  terminal on stdin and stdout. An agent's Bash tool has none; a worker that
  deliberately wraps the command in a pseudo-terminal (`script`, `winpty`)
  defeats that check, which is circumvention, not protocol use, and it
  revokes the host's key, so the host notices on its next command. "No claim is
  live" alone is never treated as proof that no worker runs: a worker holds
  its own claim capability and can end its claim (settle it, or fail a gate
  into BLOCKED) while it keeps running. A new host session that lost the
  key asks the operator for a takeover.
- Each dispatch generation has a random dispatch id and its own result file,
  `<worktree>/.mycelink-worker/result-<dispatch-id>.json`. A resume issues a
  new generation; settle reads only the current generation's file and
  accepts only a result naming its dispatch id, so a worker from before the
  resume cannot affect the resumed attempt. A result the old generation had
  already written is validated and captured into the controller (with its
  capability redacted by hash) before the rotation, or discarded.
- The result slot directory is `<worktree>/.mycelink-worker/`. Settle moves
  it into a controller-owned quarantine before reading it and applies the
  same link, hard-link, size, schema and identity checks as print mode; the
  capability is redacted from every kept copy. The move is always one
  atomic rename, never a copy. If the worktree is on another volume than the
  control repository's `features/` (for example `.mycelink/worktrees`
  linked to another drive), the quarantine is made beside the worktree,
  outside it, on its volume; if no same-volume rename is possible the
  capture fails closed with `RESULT_CAPTURE_FAILED`. Keep worktrees on a
  volume where that holds.
- What this does and does not stop. Within one OS user, capabilities and
  the controller key stop confused or shortcut-taking agents, including a
  worker that omits or unsets its token to run a controller command, and
  they make deliberate misuse require going outside the protocol. They are
  not an OS boundary against hostile code running as that user: such code
  can read the host's transcript or process list (where the key appears on
  command lines), rewrite the stored hash, or edit controller files
  directly when project hooks are not loaded. A dispatch id is stored in
  STATE.json, so a deliberately misbehaving earlier-generation worker could
  read it and write the current generation's result file, or replace the
  slot directory to make a resumed attempt fail (never succeed). Nothing
  stops any process from creating its own control repository with
  `mycelink init` and opening a key for that; it gives no authority over the
  real one, but its repositories are only as protected as git itself makes
  them. Use OS-level isolation (a separate user, container or
  VM for workers) where that matters.

## Worker sessions (standalone CLI adapter)

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
