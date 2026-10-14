# X and LinkedIn drafts

**Status: drafts, not posted.** Check [CHECKLIST.md](CHECKLIST.md) first.
Keep the caveat post in the thread. Do not post the first post on its own.

## X thread

1/
> Mycelink (open source, beta): one approved PRD → Claude Code workers, each in
> its own Git worktree → enforced TDD → per-criterion independent review →
> one immutable manifest pinning the exact SHA of every repo.
> https://github.com/nigunpark/mycelink

2/
> The point: the controller decides what runs, not the model. A GREEN without
> a real RED is refused. Writes outside a worker's worktree are blocked. "Done"
> in prose counts for nothing; recorded exit codes do.

3/
> A review gap reopens only the node that owns that criterion. At the end,
> `deliver` fast-forwards each repo to the candidate SHA and re-runs its tests.
> It never pushes.

4/
> Evidence, self-reported: 12 of 12 arms on Changesets and Spring Petclinic
> Microservices (normal and fault-injected) passed hidden tests and an
> independent verifier. Caveats: multi-module in one repo, one verified run
> per cell, no baseline, no cost data.
> https://github.com/nigunpark/mycelink/blob/main/docs/evals/2026-10-12-public-project-final-matrix.md

5/
> It's not a smarter model, and it costs more than one session. Five-minute
> quickstart with two tiny repos:
> https://github.com/nigunpark/mycelink/tree/main/examples/quickstart
> Apache-2.0, no telemetry, not affiliated with Anthropic. Feedback welcome.

## LinkedIn post

> I've released the public beta of **Mycelink**, an open-source (Apache-2.0)
> Claude Code plugin for features that span several Git repositories.
>
> The idea is simple: let the model do the judgement work and let a
> deterministic controller do the bookkeeping. You approve a PRD with
> acceptance criteria. Each piece of work then runs as its own Claude Code
> worker in an isolated Git worktree, with test-first gates the controller
> enforces. An independent reviewer checks every acceptance criterion and
> sends back only the piece that owns a gap. The result is one immutable
> manifest that pins the exact commit of every repository.
>
> What it is not: a smarter model, or a promise of better code. It's a way to
> make multi-repository AI-assisted work checkable. It costs more model usage
> than a single session.
>
> I've published a self-run evaluation on two public projects, Changesets
> and Spring Petclinic Microservices, with every caveat spelled out: the
> changes were multi-module within one repository, there is no baseline
> comparison, and cost was not measured.
>
> I'm looking for design partners who ship features across repositories and
> would pilot it on real work:
> https://github.com/nigunpark/mycelink/blob/main/docs/DESIGN_PARTNERS.md
>
> Repository and five-minute quickstart: https://github.com/nigunpark/mycelink
>
> (Independent project; not affiliated with or endorsed by Anthropic.)
