# Permission model

Who may do what, and where the switch for it lives.

This table describes the **Claude execution path**, not a Codex parity claim.
The [Codex planning guide](CODEX.md) describes its empty hook map, read-only
diagnostics and unconditional `CODEX_RUNTIME_DENIED`; no Codex worker,
reviewer, gate or delivery permission can be granted through these settings.
`codex init` never installs Claude hooks or changes `.codex/config.toml`.
Custom Codex role TOML cannot override parent `sandbox_mode`, approvals or
`mcp_servers`; a worktree is not an OS isolation boundary.

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
| Worktree setup (dependencies a new worktree lacks) | none; never derived from a README | `mycelink repo register --worktree-setup <argv JSON>`: argv only, no shell; runs with the session's PATH, HOME and cache locations plus its own `env` (placeholders `${HOME}`, `${WORKTREE}`, `${TMPDIR}` only), no proxy, credential, loader or Mycelink variable; refused if it changes a tracked file, leaves untracked output, moves HEAD, changes git configuration or hooks, or links out of the worktree | operator (config) |
| Graph after `feature init` | immutable: dispatch, claim and resume refuse a drifted graph (`GRAPH_DRIFT`) | a new feature (`feature supersede`) | nobody |
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

## The acceptance reviewer

Before any candidate, `dispatch` hands an acceptance-review ticket to the
host's Agent tool for the `mycelink:acceptance-reviewer` subagent, a session
of its own. It is read-only: its tools are Read, Glob, Grep and Write, and the
plugin's PreToolUse fence (`hooks/hooks.json`, matcher
`Write|Edit|MultiEdit|NotebookEdit|Bash|Agent|Task`) refuses it every Edit,
shell command and subagent, and every Write except its verdict file of an open
review generation (`<control>/.mycelink/reviews/<feature>/<review>/<dispatch>/verdict.json`).
The hook attests that one Write beside it (subagent id and type, session, the
verdict's canonical hash); `review settle` refuses a verdict without a
matching attestation. The controller and module-workers are refused at the
verdict file like anywhere in the scratch area, and a module-worker never runs
`review` or spawns a subagent. `review settle` needs the ticket's capability,
rotated with each generation; it is never in the reviewer's prompt.

## Host-dispatched workers (primary path)

Inside Claude Code, `/mycelink:run` does not start worker processes.
`mycelink dispatch` claims one node and prints a ticket; the host session's
own Agent tool runs the `module-worker` subagent on it, under the host
session's permissions, and `mycelink settle` takes the result back.

- Worktrees share their repository's stash. A module-worker may set edits
  aside with `git stash push` in its own worktree; the fence lets it pop,
  apply or drop only an entry its own worktree made (made on its claim's
  branch, from a commit of it — read from the entry's commit, never a
  message), and never `stash clear`, `store` or `branch`. Settle and
  `node discard` archive every entry the claim's worktree left under
  `refs/mycelink/archive/<feature>/<node>/stash/` and drop it, leaving every
  other entry's reflog line byte for byte. A worker is bound to its claim
  through Claude Code's subagent meta and the launch record the fence wrote
  at the host's Agent call.
- With `MYCELINK_PROVENANCE` set (an operator's audit, such as the
  benchmark's), the plugin's hooks also record every Bash call's start and
  end (PreToolUse, PostToolUse, PostToolUseFailure) and every subagent's
  stop (SubagentStop) in `<dir>/calls.jsonl`: session, subagent, tool use id,
  the command's hash, the hook's process, and each registered repository's
  refs, stash reflog and worktree HEADs as they stood. The core records what
  it read before each change it makes. Without the variable nothing is
  recorded.
- Each claim has a random 256-bit capability. Only its SHA-256 is stored;
  the raw value is printed once in the ticket and appears in the gate
  commands the subagent runs. Gates, evidence, finalize and settle require
  the current claim's capability; a stale (rotated or abandoned) one fails
  closed.
- Controller-only commands (every entry of the CLI's controller-only table:
  init of an existing control repository, repo register/lock, graph
  compile/import, feature init/cancel/supersede, node claim/block/invalidate/
  rework/release/verify, session spawn/reconcile/stop, evidence migrate, branch
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
  into BLOCKED) while it keeps running.
- A key records the Claude Code session that opened it: the CLAUDE_PID
  process, believed only when it is an ancestor of the call, by pid and
  start (on Linux also boot). A new host session after that session ended
  (a crash, an interrupted `claude -p`) runs
  `mycelink controller open --recover`: it mints a new key, revoking the
  old one, only when the recorded session provably no longer runs (its
  in-process subagents ended with it), the caller runs in a verifiable
  session of its own, and no adapter worker session or settle is still
  alive. A subagent of a live session finds its own session recorded as the
  holder and is refused. A key opened outside a verifiable session (no
  holder) is recovered only by the operator's `--takeover`.
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
- Ownership is fenced against the node's own delta: the commit its branch
  was created from is pinned in the claim (`base_sha`), and fresh
  verification diffs from there, advanced only to integration commits the
  controller itself recorded in STATE.json. Work an upstream node
  integrated is not the dependent's, and a branch that no longer contains
  its base fails closed (`BASE_NOT_ANCESTOR`). The integration branch itself
  is trusted only at the head the controller recorded (the newest
  integrated commit in that repository, or the base branch when nothing was
  integrated there): a new worker branch, an integration and a candidate
  all refuse a `feature/<id>` branch moved any other way, including a
  pre-existing one in a repository no node touches
  (`INTEGRATION_BRANCH_MOVED`). An integration journals the exact commit it
  will move the branch to (`pending_integrations`) before moving it, under
  a per-repository lock; an integration that died after the move resumes
  only when the branch is at exactly that journaled commit. Which commits
  the branch contains, or what its first parent is, is never evidence: a
  merge that contains the verified commit plus anything else is refused.
  `branch integrate` takes the same road. Same-user code that rewrites
  STATE.json is outside this, as above.
- A candidate pins the global configuration and its own feature's files. A
  verifier, scenario or contract stored under another feature's directory is
  not pinned; keep shared files outside `features/`.
- `node rework` is controller-only and never a way to launder history: the
  reopened node keeps its lifetime attempts and failure fingerprints (each
  approved rework gets its own bounded allowance of `max_attempts`, counted
  from the attempts at the rework, and the same failure twice still parks
  it), its reason reaches the next worker only as a bounded, redacted,
  hash-bound brief inside the context pack's data delimiters (refused if it
  holds the controller key or control characters), a parked node is
  never its target (that needs a recorded decision), a parked dependent is
  reopened only with a recorded decision that is consumed once, the number of
  reworks per node is bounded, and it is refused while anything is in
  flight or when a delivered base branch no longer holds the delivery (one
  someone committed on after the delivery is adopted by fast-forward, in the
  rework's own state write, and only from where the controller left the
  integration branch).
  `feature supersede` likewise requires the old feature to be at rest, and
  its replacement to be usable: initialised, not itself superseded, not
  cancelled, with a graph that validates and still matches its STATE.json
  (`SUPERSEDING_FEATURE_NOT_VIABLE`), never in a cycle. It holds both
  features' delivery locks, in a fixed order.
  Delivery, rework, supersede and every candidate cut (the candidate node
  and `candidate create`) hold the feature's delivery lock, so the current
  candidate never changes under a running delivery or across a rework
  (`FEATURE_BUSY` when another holds it).
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
