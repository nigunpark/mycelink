# Show HN draft

**Status: draft, not posted.** Check [CHECKLIST.md](CHECKLIST.md) first.

## Title

> Show HN: Mycelink – TDD-gated Claude Code workers across multiple Git repos

Alternative titles, depending on emphasis:

- Show HN: Mycelink – one PRD to an immutable multi-repo commit set, via Claude Code
- Show HN: A deterministic controller for Claude Code features that span repos

## URL

https://github.com/nigunpark/mycelink

## First comment (posted by the maintainer right after submitting)

> Hi HN, I built Mycelink. [Replace with your own reason in one or two
> sentences, for example the multi-repo problem that made you write it.
> Don't post a story that isn't yours.]
>
> The problem it targets: with one feature spread over several repositories
> and several Claude Code sessions, it is easy to lose track of which session
> did what, whether the tests really came first, and which commits belong
> together.
>
> Mycelink is a Claude Code plugin plus a small deterministic controller. You
> approve a PRD with acceptance criteria (AC-1, AC-2, ...). Claude turns it
> into a graph where each node owns paths in one repository. Then the
> controller, not the model, decides what runs:
>
> - each node runs as its own worker in its own Git worktree, and writes
>   outside it are blocked by hooks;
> - a worker must record a RED that fails because the behaviour is missing
>   (not a syntax error or a missing module), then GREEN with the identical
>   command. Exit codes are evidence; "done" in prose is not;
> - a separate read-only reviewer judges every criterion. A gap reopens only
>   the node that owns it, within a budget;
> - the result is one immutable manifest binding the exact SHA of every
>   repository. `deliver` fast-forwards each base branch to it and re-runs
>   tests. It never pushes.
>
> What it is not: it doesn't make the model smarter, and it isn't a general
> agent launcher. It costs more model usage than one session (a session per
> node, plus reviews) and needs a test command in every repository.
>
> Evidence, with caveats: I ran a 12-arm matrix on six change requests to
> two frozen public projects (Changesets and Spring Petclinic
> Microservices). Each PRD ran once normally and once with injected faults
> (concurrent commits, duplicate and stale results, a late hidden defect,
> an interrupt). All 12 deliveries passed hidden acceptance tests and an
> independent verifier. But: I ran it myself; those changes are multi-module
> inside one repo each, not cross-repo; each cell is one verified run picked after fixes (19 of 54
> runs verified overall), so it's not a success rate; and there's no
> without-plugin baseline or cost measurement. The report, with every
> caveat:
> https://github.com/nigunpark/mycelink/blob/main/docs/evals/2026-10-12-public-project-final-matrix.md
>
> Across separate repos I have one real run so far: the quickstart's two
> tiny repos, with Claude Opus 5.5, delivered and verified in about 17
> minutes; Claude Code put it at $5.55 at list prices. One run, no baseline:
> https://github.com/nigunpark/mycelink/blob/main/docs/evals/2026-10-15-public-two-repo-demo.md
>
> There's a five-minute quickstart with two tiny repos:
> https://github.com/nigunpark/mycelink/tree/main/examples/quickstart
>
> It's a public beta, Apache-2.0, with no telemetry. It isn't affiliated with
> Anthropic. I'd especially like to hear from anyone who tries it on real
> repositories, and where it stops.

## Likely questions, with honest answers

- **"Why not just tell Claude to use subagents and TDD?"** You can. The
  difference is enforcement and records: the controller refuses a GREEN
  without a matching RED, refuses writes outside a worktree, and binds exact
  SHAs. Instructions alone don't guarantee any of that. Whether it produces
  better code is unmeasured.
- **"How much does it cost?"** More than a single session. The only
  published figure is one maintainer run of the quickstart: about 17 minutes,
  six subagent sessions, $5.55 at list prices as Claude Code reported it. Say
  that it is one run on two tiny repositories, not an estimate.
- **"Does it work with other models?"** It drives Claude Code. Other models
  are not planned.
- **"Is the benchmark independent?"** No. The verifier is independent of the
  agent (the agent never sees it), but the matrix was run and reported by the
  maintainer. The run records are not public; the report lists their hashes
  and the script that checks them.
- **"Why multi-module evidence for a multi-repo tool?"** Public multi-repo
  projects with a shared change and hidden tests are harder to set up.
  The quickstart's two-repo run is the only cross-repo model run so far;
  external cross-repo pilots are first on the roadmap, and design partners
  are welcome.
