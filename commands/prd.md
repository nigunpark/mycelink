---
description: Turn a requirement into an approved PRD artifact for a new feature
argument-hint: <feature-id> <requirement...>
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, AskUserQuestion
---

# Write the PRD

Feature: `$0`
Requirement: `$ARGUMENTS`

The PRD is a file, not a conversation. Write `features/$0/PRD.md` in the
control repository containing:

- the user or operator behaviour being added
- Given / When / Then for each behaviour
- the success result
- error and boundary conditions
- API, database and event side effects
- affected repositories and modules
- explicit out-of-scope items
- backward-compatibility impact
- the user flows a real browser E2E must prove
- every policy question that needs a human decision

Give each acceptance criterion a stable `AC-n` id. The graph references these
ids, and every one of them must end up covered by a node.

Ask the user only about genuine product decisions: contradictory criteria,
public contract compatibility, data migration or deletion, security and
privacy, scope, budget, or a choice between two valid designs with different
product meaning. Decide ordinary implementation details yourself by following
the existing code.

This command writes the PRD only; planning and implementation are the
next phases. Commit `features/$0/PRD.md` in the control repository.

## When this is one phase of a run

If this was invoked by `/mycelink:run`, or the user asked for the feature
to be built or delivered end to end, do not stop here: hand control back
and continue immediately with `/mycelink:plan $0`, then the rest of the
`/mycelink:run` phases. Only a real unresolved product decision (one of the
kinds above, asked with AskUserQuestion) pauses the run, and it resumes once
the user answers.

Invoked on its own for just a PRD, report the PRD path and its open
questions and end there.
