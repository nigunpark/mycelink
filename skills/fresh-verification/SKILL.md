---
name: fresh-verification
description: Use when independently verifying a submitted orchestrator node without inheriting the implementer's context — running the declared verifiers on a clean checkout, checking the ownership fence against a real diff, separating baseline failures from new regressions, and judging RED evidence validity.
---

# Fresh verification

The implementer does not get to mark their own work correct. Verification
happens in a clean worktree created from the node branch, with no inherited
context.

## What is checked, in order

1. **Ownership fence.** Diff the node branch against the repository base
   branch, including uncommitted and untracked files and renames. Any changed
   path outside `allowed_paths`, or inside `forbidden_paths`, fails the node
   with `OWNERSHIP_VIOLATION`. Not committing is not an escape hatch.
2. **Declared verifiers.** Every `verification_commands` entry runs in the
   clean checkout. The exit code is the verdict.
3. **Regression.** If the node requires regression evidence, the repository's
   regression (or test) command runs too.

## Baseline failures

Tests listed in the repository's `baseline_failures` were already broken
before this feature started. They are stripped before the verdict, and the
excluded ids are recorded on the evidence. A run whose only failures are
baseline passes; a run with one new failure does not.

## Judging RED evidence

Only a RED that failed because the behaviour is missing is valid:

| Output signal | Classification | Valid RED? |
|---|---|---|
| assertion, expected/actual, `not ok`, test failed | `behaviour-missing` | yes |
| cannot find module, missing script, no such file | `setup-error` | no |
| SyntaxError, parse error, TS1005 | `syntax-error` | no |
| ECONNREFUSED, EACCES, address in use | `environment-error` | no |
| anything unclassified | `setup-error` | no |

An unclassified failure is deliberately *not* treated as a missing behaviour.
A RED you cannot explain is not evidence.

## Failure fingerprints

A fingerprint is a stable hash of the normalised failure: paths, line
numbers, durations, hex ids and large numbers are collapsed first. The same
defect therefore produces the same fingerprint across retries, which is what
makes the repeat limit work. Changing model or agent name does not produce a
new fingerprint, and must not be used to disguise a repeat.

## What you return

A verdict, a fingerprint, exit codes and evidence paths. Not a narrative, not
a diff, not a log body. If you found a blocker, return it to the original
node; do not fix it yourself and do not delegate it onward.
