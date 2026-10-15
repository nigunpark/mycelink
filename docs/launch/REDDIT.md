# Reddit draft

**Status: draft, not posted.** Check [CHECKLIST.md](CHECKLIST.md) first.

Candidate communities are ones about Claude and Claude Code. Before posting,
read each community's current rules on self-promotion and project posts,
use its flair for projects, and post to one community at a time, a few days
apart. Never cross-post the same text to several at once.

## Title

> I built a Claude Code plugin that runs one feature across several repos: a worker per worktree, TDD gates, per-criterion review, exact SHAs at the end (open source, beta)

## Body

> [Replace with your own reason in a sentence or two. Don't post a story that
> isn't yours.] I built **Mycelink**, an Apache-2.0 Claude Code plugin with a
> small deterministic controller, for features that span several
> repositories, where it is easy to lose track of which session did what and
> which commits belong together.
>
> **How it works**
>
> 1. You approve a PRD with acceptance criteria (`AC-1`, `AC-2`, ...).
> 2. Claude turns it into a graph. Each node owns paths in one repository.
> 3. The controller, not the model, hands out nodes. Each worker gets its own
>    Git worktree, and writes outside it are blocked.
> 4. A worker must record a failing test that fails because the behaviour is
>    missing, then pass with the identical command. Exit codes are recorded
>    as evidence.
> 5. A separate read-only reviewer checks every criterion. A gap reopens only
>    the node that owns it.
> 6. You get one immutable manifest with the exact SHA of every repository.
>    `deliver` fast-forwards your local branches. It never pushes.
>
> **What it isn't:** a smarter model or a general agent launcher. It uses more
> model usage than one session, and every repository needs a test command.
>
> **Evidence (self-reported):** a 12-arm matrix on two frozen public projects
> (Changesets and Spring Petclinic Microservices), with normal and
> fault-injected runs. 12 of 12 deliveries passed hidden acceptance tests and
> an independent verifier. Caveats: I ran it; the changes are multi-module
> in one repo, not cross-repo; one verified run per cell, picked after fixes;
> no baseline and no cost numbers. Full report:
> https://github.com/nigunpark/mycelink/blob/main/docs/evals/2026-10-12-public-project-final-matrix.md
>
> **Across separate repos:** one real run so far, of the quickstart's two
> tiny repos with Claude Opus 5.5: delivered and verified in about 17
> minutes, $5.55 at list prices as Claude Code reported it. One run, mine, no
> baseline:
> https://github.com/nigunpark/mycelink/blob/main/docs/evals/2026-10-15-public-two-repo-demo.md
>
> **Try it:** a five-minute quickstart with two tiny repos:
> https://github.com/nigunpark/mycelink/tree/main/examples/quickstart
>
> ```
> claude plugin marketplace add nigunpark/mycelink
> claude plugin install mycelink@mycelink-marketplace
> ```
>
> No telemetry, and it runs locally. It isn't affiliated with Anthropic. I'd
> love to hear where it breaks, especially on real multi-repo work. There's a
> first-run feedback form in the repo.
