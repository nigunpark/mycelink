# CSET-203 — Crash-safe `changeset version`

Status: approved · Archetype: deterministic failure, concurrency and recovery

## Problem

`changeset version` rewrites `package.json` and `CHANGELOG.md` files one at a
time and deletes the changesets it consumed at the end. If it fails part-way
(a file it cannot write, a formatter that crashes) or the process is killed,
the repository is left half-versioned with every changeset still present.
Running `changeset version` again then bumps the already-bumped packages a
second time.

## Scope

| Package | Change |
|---|---|
| `packages/apply-release-plan` | roll back a failed apply; keep a recovery journal while applying |
| `packages/cli` | recover an interrupted run before versioning; report failures cleanly |

No other package changes.

## Acceptance criteria

**AC-1 — rollback (apply-release-plan).** If `applyReleasePlan` fails after
it has started changing files, it restores every file it changed, created or
deleted to its exact previous bytes (or absence) and removes directories it
created, and only then rejects. The rejection's `cause` is the original
error.

**AC-2 — journal (apply-release-plan).** Before its first change,
`applyReleasePlan` durably records what it is about to change in a recovery
journal stored inside `.changeset/` under a name that starts with `.`, so it
is never read as a changeset. It removes the journal once the run has
completed, successfully or after a rollback. The journal's format is up to
you.

**AC-3 — recovery (CLI).** Before it reads anything else, `changeset
version` looks for a journal left by an interrupted run — for example after
the process was killed while applying. If it finds one, it restores the
state recorded in it, removes the journal, prints a warning that contains
the word `interrupted`, and then versions normally. The final result is the
same as one uninterrupted run: every package is bumped once and every
changeset is consumed once.

**AC-4 — failure (CLI).** When applying the release plan fails,
`changeset version` prints the failure without a stack trace and exits with
code `1`. It does not run `git add` or `git commit` for that run, even when
`commit` is enabled in the config.

**AC-5 — compatibility.** A run that succeeds produces exactly the same files
as today and leaves no journal behind. `changeset status` and
`changeset add` are unaffected by a journal.

## Engineering expectations

- Implement each criterion in the package that owns it, with tests in that
  package, including a test that interrupts a real `changeset version`
  process and proves the recovery.
- Existing tests keep passing. Do not change the build tooling, the
  workspace layout or package names.
