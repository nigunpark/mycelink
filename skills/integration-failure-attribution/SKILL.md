---
name: integration-failure-attribution
description: Use when a cross-repository integration or browser E2E fails and the cause must be traced back to a specific producer node, contract or repository instead of retrying the same scenario. Covers attribution strategies, building the nearest reproducer, and invalidating only the affected part of the graph.
---

# Integration failure attribution

A failing E2E is a symptom. Re-running it is not a diagnosis.

## Never

- Re-run the same scenario against the same candidate hoping for a different
  result.
- Patch the symptom in the UI when the contract is wrong.
- Invalidate the whole graph because one scenario failed.

## Attribution, narrowest signal first

1. **Declared.** The scenario's `attributed_nodes` names what it exercises.
   Trust it.
2. **Contract.** The failure output names a contract path that some node
   declares in `contract_outputs`. That producer is the suspect.
3. **Acceptance criteria.** The nodes covering the scenario's
   `acceptance_criteria`.
4. **Whole feature.** Every implementation node is a suspect. This is the
   admission that the scenario is not specific enough — fix that next time by
   filling in `attributed_nodes`.

E2E nodes are never blamed for their own failure.

## Then build the nearest reproducer

Move the failure down to the cheapest layer that can reproduce it:

```text
browser E2E  →  integration test  →  contract test  →  component  →  unit
```

Write that test first, watch it fail for the right reason, and fix it through
the normal TDD gates. A contract mismatch belongs in a contract test, not in
a browser.

## Invalidate precisely, and cascade

Invalidation cascades to dependents, because a downstream node's evidence was
produced against the old upstream. Leaving it DONE would let a stale
candidate look verified.

Invalidation keeps the node's RED (a test once proved the behaviour was
missing, and an upstream change does not undo that) and discards everything
proven against the changed inputs. It also resets the attempt budget: this is
a different problem now.

## Then a new candidate

A candidate is immutable. Fixing anything produces new SHAs, which means a
new candidate id. Re-run the targeted scenario against the new candidate
first; run the full set only when the targeted one passes.
