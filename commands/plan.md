---
description: Compile an approved PRD into a validated four-layer portfolio graph
argument-hint: <feature-id>
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# Compile the portfolio graph

Feature: `$0`

Use the `portfolio-decomposition` and `graph-compilation` skills.

1. Read `features/$0/PRD.md` and `repositories.yaml`.
2. Decompose into exactly four layers: feature, repository slice, capability,
   executable node. A node is one verifiable behaviour or vertical slice —
   never one file edit, and never so fine-grained that managing the graph
   costs more than the work.
3. For every node, fill in: repository, capability, `node_type`,
   `depends_on`, `allowed_paths`, `forbidden_paths`, `contract_inputs`,
   `contract_outputs`, `required_resources`, `required_evidence`, real
   `verification_commands`, and a worker budget with
   `nested_delegation: false`. Where the repository declares modules
   (`node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" repo modules --json`),
   a node's first verifier is its module's printed `verifier` (with
   `module_sha256`), copied verbatim; the full suite is regression's.
   A criterion proved only by existing tests (a compatibility criterion)
   goes on a verification node (`node_type: verification`), which changes
   nothing and is run by the controller after every producer of its
   repository and before the candidate build; never a worker node with no
   allowed paths, which could only make a no-op submission.
4. Write `features/$0/PORTFOLIO-GRAPH.yaml`. Its `acceptance_criteria` are
   exactly the approved ones in `features/$0/ACCEPTANCE.json` (`id`,
   `text`, `kind`), copied programmatically from that file, never retyped
   or summarised: validation refuses a criterion whose text or kind differs
   (`ACCEPTANCE_TEXT_MISMATCH`, `ACCEPTANCE_KIND_MISMATCH`), is missing or
   invented.
5. Validate: `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" graph validate $0`
   Fix every reported problem. The validator rejects cycles, duplicate ids,
   unknown repositories and resources, missing verifiers, non-positive
   budgets, nested delegation, escaping paths, contract inputs with no
   producer, consumers that do not depend on their producer, and acceptance
   criteria no node covers.
6. Use the controller key you already hold (`<key>`, from `/mycelink:init`).
   Only if this control repository has never had one, run
   `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" controller open --json` and keep its `authority`. If it answers
   `CONTROLLER_AUTHORITY_EXISTS` and you do not hold the key (a new session),
   run `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" controller open --recover --json`; only if that answers `CONTROLLER_BUSY`, ask the user to
   run `mycelink controller open --takeover` in their own terminal. Never put
   the key in a file or a subagent prompt.
   Initialise: `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" feature init $0 --authority <key>`
   Then commit `features/$0/` so the control repository is clean before a run.
7. Validate the loop contracts:
   `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" loop validate $0`

Show the user the node list and the READY set. This command plans only; it
does not implement nodes itself.

## When this is one phase of a run

If this was invoked by `/mycelink:run`, or the user asked for the feature
to be built or delivered end to end, do not stop here: hand control back
and continue immediately with the dispatch loop of `/mycelink:run $0`
(Phase 4) through to delivery. Only a real unresolved product decision
pauses the run.

Invoked on its own for just a plan, report the graph and the READY set and
end there.
