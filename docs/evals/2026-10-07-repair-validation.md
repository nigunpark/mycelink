# Mycelink multi-module repair validation

Date: 2026-10-07
Branch: `fix/durable-worker-dispatch`
Final implementation commit under evaluation: `ffb35f6`

## Executive result

The original `v0.2.0-beta.1` pilot was not a valid working orchestration: nested Claude workers could not start, nodes were blocked by infrastructure failures, candidates invalidated themselves, and delivery was missing.

The repaired implementation now completes the requested three scenario classes with the host-native path:

1. existing multi-module project, no prior knowledge;
2. existing multi-module project, architecture knowledge supplied;
3. greenfield multi-module project.

The final evidence is split across two runs because the last defect was found only in the informed case:

- On exact commit `72c54b4`, the full three-case run independently verified cold and greenfield end to end.
- That run's informed case correctly stopped after QA found one product defect, but its rework ticket omitted the controller's defect reason.
- Commit `ffb35f6` fixed bounded, audited rework-brief transport and per-rework bounded attempts.
- A fresh informed-case run on exact commit `ffb35f6` scored `1.0` and independently verified completion, reporting, and orchestration.

No result is counted from grader prose alone. The authoritative completion check is `verify-workspace.mjs --require-mycelink` over each sealed workspace.

## Final functional evidence

| Scenario | Code state | Plugin grader | Independent verifier | Result |
|---|---|---:|---:|---:|
| Existing, no prior knowledge | `72c54b4` | 1.0000 | completion/reporting/orchestration all true | PASS |
| Existing, knowledge supplied | `ffb35f6` | 1.0000 | completion/reporting/orchestration all true | PASS |
| Greenfield | `72c54b4` | 1.0000 | completion/reporting/orchestration all true | PASS |

The informed rerun used 4 top-level turns, cost `$2.1732642`, and took 421 seconds.

## Final implementation verification

At `ffb35f6`:

- `npm test`: 74 files, 915 passed, 1 skipped, 0 failed;
- TypeScript typecheck: passed;
- committed-bundle build check: passed;
- `npm audit`: 0 vulnerabilities;
- strict Claude plugin validation: passed;
- package creation: 62 files;
- model-free multi-module selftest: 101 passed, 0 failed.

## Architecture changes

The primary plugin path is now:

```text
controller dispatch ticket
  -> Claude Code Agent(module-worker)
  -> claim-scoped result
  -> controller settle
  -> fresh verification
  -> exact journaled integration
  -> whole-portfolio candidate
  -> acceptance
  -> compare-and-swap delivery
```

The standalone nested-CLI adapter remains optional and is no longer the plugin's primary execution path.

Implemented controls include:

- positive controller authority separate from worker claims;
- dispatch generations that revoke stale workers and stale result slots;
- fail-closed result quarantine, including cross-volume handling;
- infrastructure failures separated from node retry budgets;
- scheduler/readiness and allowed-path enforcement;
- node deltas pinned to their exact starting integration SHA;
- exact controller-journaled integration recovery rather than ancestry inference;
- fresh verifier and evidence-path containment;
- canonical target-feature candidate inputs and whole-portfolio SHA binding;
- candidate, rework, delivery, and supersede locking;
- compare-and-swap rollback that never erases a concurrent commit;
- accepted-delivery manifest integrity and acceptance-output verification;
- exactly-once usage accounting across settle crashes;
- same-feature rework with bounded attempts and preserved lifetime failure history;
- bounded, redacted, hash-bound rework briefs carried to the worker;
- explicit, cycle-checked supersession chains;
- deterministic final delivery without force push.

## Real failures that drove the fixes

### Nested worker launch

The original worker adapter tried to spawn `claude` inside the plugin-eval sandbox and failed with `ENOENT`. The primary path was redesigned around Claude Code's host Agent tool.

### Same-repository ownership

A downstream node in the same repository was compared against `main`, so upstream integrated files appeared as its own out-of-fence changes. Nodes now verify only their delta from the exact integration SHA captured at claim creation.

### Phase stop after PRD

The informed scenario stopped after the PRD because a phase skill told the host to stop. Phase skills now hand control back to an end-to-end `/mycelink:run` unless a genuine unresolved decision exists.

### Repair by creating extra features

Earlier agents worked around failed acceptance by creating new feature IDs, leaving stale candidates and incomplete historical features. Mycelink now reopens an explicitly attributed producer node inside the same feature, invalidates downstream state, and cuts a replacement full-portfolio candidate.

### Missing rework reason

The exact-head informed run at `72c54b4` found a real 201-character reason validation defect, but the rework worker did not receive that QA reason and returned `INVALID_RED_EVIDENCE`. Commit `ffb35f6` transports a bounded, audited, redacted, hash-bound rework brief. The fresh informed run then passed fully.

### Forged crash-resume integration

An independent reviewer found that ancestry/first-parent shape could make a forged merge look like interrupted integration. Recovery now trusts only the exact integration commit journaled by the controller. Deterministic malicious-merge and crash-boundary tests pass.

## Remaining limits

These are documented production-hardening limits rather than blockers for the bounded evaluation:

- same-user processes are not an OS security boundary;
- multi-repository delivery cannot be globally atomic, although CAS prevents data loss and reports partial delivery;
- one POSIX-only release test remains intentionally skipped on Windows;
- the three final scenario proofs are two sealed evaluation batches rather than one final aggregate, because the informed-only defect was repaired and rerun separately.

## Honest verdict

The original beta was not complete. The repaired branch demonstrates that the architecture is viable and that all three requested scenario classes can finish with verified code, repository commits, acceptance, candidate binding, and delivery. It should not be released as the old `v0.2.0-beta.1`; it needs review/CI on the repair branch and a new prerelease version.
