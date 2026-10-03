---
name: portfolio-decomposition
description: Use when turning an approved multi-repository PRD into the four-layer decomposition (feature, repository slice, capability, executable node) before a portfolio graph is written. Triggers on splitting a requirement across several git repositories, deciding node granularity, or assigning ownership and contracts between a producer and consumer repository.
---

# Portfolio decomposition

Four layers, no more and no fewer:

```text
Portfolio feature (the whole PRD)
└─ Repository / module slice
   └─ Capability / behaviour slice
      └─ Executable node
```

## Node granularity

A node is **one verifiable behaviour or vertical slice**. Not one file edit,
not one tool call. If the graph is so fine-grained that maintaining it costs
more than the implementation, the decomposition is wrong.

A good node can answer all of these:

- Which single repository does it change?
- What one behaviour becomes true when it is done?
- What exact command proves it, and what does that command print when it
  fails for the right reason?
- Which acceptance criterion does it serve?

## Ownership

Two nodes in the same repository must not own overlapping paths. If they do,
either merge them or split the paths. The scheduler refuses to run
path-overlapping nodes in parallel, so a sloppy fence silently serialises
everything.

## Contracts between repositories

When repository A produces something repository B consumes — a REST schema, a
DB migration, a Queue key or event shape, a native ABI, a file format, a shared
DTO — write it down:

- the producing node lists it in `contract_outputs`
- the consuming node lists it in `contract_inputs`
- the consumer **must** depend, directly or transitively, on the producer

The graph validator enforces the last point. A consumer that does not depend
on its producer is a race, not a plan.

## What goes to the user

Only product decisions: contradictory acceptance criteria, whether breaking a
public contract is acceptable, data migration or deletion, security and
privacy, scope, budget, and choices between two valid designs that mean
different things to the product. Everything else you decide by following the
existing code.

## Node id convention

```text
<feature>.<repository>.<capability>.<step>
FEAT-101.api.queue-consumer.impl
```

## Output

A node list where every acceptance criterion in the PRD is covered by at
least one node, and every node names a real repository, a real command and a
real ownership fence.
