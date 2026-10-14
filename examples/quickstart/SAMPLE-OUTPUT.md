# Sample output: scripted walkthrough

Source: `node examples/quickstart/walkthrough.mjs`, run by `node examples/quickstart/walkthrough.mjs --write-sample`.

This is **not** a model run. The Mycelink controller, Git and the gates are real; the module-worker and the
acceptance reviewer are scripted (`examples/quickstart/scripted/`, `walkthrough.mjs`). The GAP on AC-4 comes from
a fault planted in the scripted web worker's first implementation. Commit SHAs are reproducible: every commit has
a fixed identity and date, so the same Mycelink version prints the same SHAs on every machine.

```text
Mycelink 0.3.0-beta.1 quickstart walkthrough: feature ORD-101 across two Git repositories.
Scripted worker and reviewer, no model: see examples/quickstart/walkthrough.mjs.

[setup]      orders-api own Git repository, main 884eed990cb0, 4 tests pass
[setup]      orders-web own Git repository, main 8846c66e4225, 2 tests pass
[setup]      acceptance probe on the baselines: 0/4 criteria pass (feature not pre-solved)
[plan]       ORD-101 graph valid: ORD-101.api.status.impl -> ORD-101.web.status.impl -> ORD-101.release.candidate.build
[plan]       READY ORD-101.api.status.impl (the web node waits for the contract's producer)
[dispatch]   ORD-101.api.status.impl -> mycelink:module-worker, worktree .mycelink/worktrees/api__ORD-101.api.status.impl (wip/ORD-101/api.status.impl)
[red]        api: RED accepted, 4 declared tests failed for the missing behaviour
               failed  a shipped order is published with its id and status
               failed  a delayed order is published with its eta at contract version 2
               failed  every other payload carries version 2 and no eta
               failed  a delayed order without a valid eta is refused, naming the order
[commit]     api: f1250c8b2256 tests only
[green]      api: module tests pass, the same command the RED failed
[commit]     api: 6b82dd335709 production only
[regress]    api: full suite passes
[result]     ORD-101.api.status.impl: SUBMITTED, AC-1 AC-2 proved by this RED (tdd check ok)
[settle]     ORD-101.api.status.impl: DONE, re-verified on a clean checkout, feature/ORD-101 @ 6b82dd335709
[dispatch]   ORD-101.web.status.impl -> mycelink:module-worker, worktree .mycelink/worktrees/web__ORD-101.web.status.impl (wip/ORD-101/web.status.impl)
[red]        web: RED accepted, 2 declared tests failed for the missing behaviour
               failed  a delayed order shows its new expected date
               failed  an unknown status shows Status unavailable
[commit]     web: 82b08e534bed tests only
[green]      web: module tests pass, the same command the RED failed
[commit]     web: bb4e3dc0bd79 production only
[regress]    web: full suite passes
[result]     ORD-101.web.status.impl: SUBMITTED, AC-3 AC-4 proved by this RED (tdd check ok)
[settle]     ORD-101.web.status.impl: DONE, re-verified on a clean checkout, feature/ORD-101 @ bb4e3dc0bd79
[dispatch]   ORD-101-R001: acceptance review handed to mycelink:acceptance-reviewer
[review]     ORD-101-R001: independent read-only review of 4 criteria against api@6b82dd335709 web@bb4e3dc0bd79
[review]     ORD-101-R001: GAP AC-4: no test renders a payload without a status (scripted, see walkthrough.mjs)
[rework]     ORD-101.web.status.impl reopened; no candidate is cut while a gap is open
[dispatch]   ORD-101.web.status.impl -> mycelink:module-worker, worktree .mycelink/worktrees/web__ORD-101.web.status.impl (wip/ORD-101/web.status.impl)
[rework]     ORD-101.web.status.impl: brief from ORD-101-R001, criteria AC-4
[red]        web: RED accepted, 1 declared test failed for the missing behaviour
               failed  a payload without a status shows Status unavailable
[commit]     web: 9d17d3c01e57 tests only
[green]      web: module tests pass, the same command the RED failed
[commit]     web: 1e1ba232befe production only
[regress]    web: full suite passes
[result]     ORD-101.web.status.impl: SUBMITTED, AC-4 proved by this RED, AC-3 carried from the earlier RED (tdd check ok)
[settle]     ORD-101.web.status.impl: DONE, re-verified on a clean checkout, feature/ORD-101 @ 1e1ba232befe
[dispatch]   ORD-101-R002: acceptance review handed to mycelink:acceptance-reviewer
[review]     ORD-101-R002: independent read-only review of 4 criteria against api@6b82dd335709 web@1e1ba232befe
[review]     ORD-101-R002: PASS on every criterion
[controller] ORD-101.release.candidate.build: DONE
[candidate]  ORD-101-C001: immutable, binds api@6b82dd335709 web@1e1ba232befe (candidate verify ok)
[deliver]    ACCEPTED ORD-101-C001: main fast-forwarded in both repositories, nothing pushed
[deliver]    orders-api main 6b82dd335709fd68648b4ccf35786147df194804
[deliver]    orders-web main 1e1ba232befe9d3a865d770635bac8288b487be5
[verify]     feature verify --delivered ok; acceptance probe on the delivered commits: 4/4 criteria pass

Done: 2 repositories, ORD-101-R001 GAPS, ORD-101-R002 PASS, 1 rework, candidate ORD-101-C001, 0 model calls.
```
