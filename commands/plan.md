---
description: Compile an approved PRD into a validated four-layer portfolio graph
argument-hint: <feature-id>
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# Compile the portfolio graph

Feature: `$1`

Use the `portfolio-decomposition` and `graph-compilation` skills.

1. Read `features/$1/PRD.md` and `repositories.yaml`.
2. Decompose into exactly four layers: feature, repository slice, capability,
   executable node. A node is one verifiable behaviour or vertical slice —
   never one file edit, and never so fine-grained that managing the graph
   costs more than the work.
3. For every node, fill in: repository, capability, `node_type`,
   `depends_on`, `allowed_paths`, `forbidden_paths`, `contract_inputs`,
   `contract_outputs`, `required_resources`, `required_evidence`, real
   `verification_commands`, and a worker budget with
   `nested_delegation: false`.
4. Write `features/$1/PORTFOLIO-GRAPH.yaml`.
5. Validate: `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" graph validate $1`
   Fix every reported problem. The validator rejects cycles, duplicate ids,
   unknown repositories and resources, missing verifiers, non-positive
   budgets, nested delegation, escaping paths, contract inputs with no
   producer, consumers that do not depend on their producer, and acceptance
   criteria no node covers.
6. Initialise: `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" feature init $1`
7. Validate the loop contracts:
   `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" loop validate $1`

Show the user the node list and the READY set. Do not start implementing.
