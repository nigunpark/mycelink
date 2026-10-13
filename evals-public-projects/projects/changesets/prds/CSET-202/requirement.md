# CSET-202 — Report every invalid changeset at once

Status: approved · Archetype: backward-compatible behavioural change

## Problem

When several changesets are invalid — a file that does not parse, a package
that is not in the workspace, a changeset that mixes ignored and not-ignored
packages — `changeset status` and `changeset version` stop at the first one
and print a stack trace. Maintainers fix them one run at a time.

## Scope

| Package | Change |
|---|---|
| `packages/errors` (`@changesets/errors`) | `ChangesetValidationError` |
| `packages/read` | collect every unparseable changeset |
| `packages/assemble-release-plan` | collect every unknown package and mixed changeset |
| `packages/cli` | report the collected problems once and exit 1 |

No other package changes.

## Acceptance criteria

**AC-1 — the error (errors).** `@changesets/errors` exports
`class ChangesetValidationError extends Error`, constructed as
`new ChangesetValidationError(issues)`, where each issue is

```ts
type ChangesetIssue = {
  changesetId: string;
  code: "INVALID_FILE" | "UNKNOWN_PACKAGE" | "MIXED_IGNORED";
  message: string;
};
```

- `error.issues` holds the issues sorted by `changesetId`, then `code`, then
  `message` (plain string comparison).
- `error.message` is the line `Invalid changesets:` followed by one line per
  issue, in that order, formatted `- <changesetId>: <message>`, joined with
  `\n`.

**AC-2 — reading (read).** `readChangesets(rootDir, sinceRef?)` attempts
every changeset file. If any cannot be parsed it rejects with one
`ChangesetValidationError` holding an `INVALID_FILE` issue per unparseable
file: `changesetId` is the file's id (its path below `.changeset/` without
`.md`, as for valid changesets) and `message` is the first line of the
parser's error message. When every file parses, the result is unchanged.

**AC-3 — planning (assemble-release-plan).** `assembleReleasePlan` checks
every changeset before planning and, if any is invalid, throws one
`ChangesetValidationError` with:

- an `UNKNOWN_PACKAGE` issue for every package a changeset names that is not
  in the workspace, with the message
  `Found changeset <id> for package <name> which is not in the workspace`;
- a `MIXED_IGNORED` issue for every changeset that names both skipped
  (ignored or unversioned private) and not-skipped packages, with a message
  that names both groups of packages.

When every changeset is valid, the plan is unchanged.

**AC-4 — CLI.** When `changeset status` or `changeset version` meets a
`ChangesetValidationError`, it prints that error's message once, without a
stack trace, and exits with code `1`. `changeset version` changes no file in
that case. Every other error is reported as today.

**AC-5 — compatibility.** For workspaces whose changesets are all valid,
everything both commands print, write and return is byte-identical to today.

## Engineering expectations

- Implement each criterion in the package that owns it, with tests in that
  package.
- Existing tests keep passing. Do not change the build tooling, the
  workspace layout or package names.
