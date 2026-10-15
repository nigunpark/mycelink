# Design partners

Mycelink's public evidence so far is multi-module work inside one repository.
The next step is real features that span **separate repositories**, on real
code. Design partners are the people who run those pilots.

## What a pilot is

- **One real feature** that changes two or more of your Git repositories, each
  with an automated test command (any language or build tool).
- **Your machine, your account.** Mycelink runs locally, makes no network
  requests of its own, has no telemetry, and never pushes. You decide what,
  if anything, is shared.
- **A PRD with acceptance criteria** that you approve before any work starts.
- **Maintainer help** with setup, the graph and anything that stops the run.
- **A short write-up afterwards**: what worked, where it stopped, roughly how
  long it took and what it cost. It is published only with your permission,
  and anonymised if you prefer.

## What you get

- Direct influence on the [roadmap](ROADMAP.md). Pilot findings decide what
  is fixed before 1.0.
- Fixes for the problems your pilot hits, prioritised.

## What it costs you

- Model usage on your own Claude plan or API account. A Mycelink run uses
  more sessions than a single Claude session would.
- A few hours to set up the control repository, write the PRD and review the
  result.

## Who fits

- You already use Claude Code.
- You ship features across repositories (for example a library and its
  consumers, or a service and its client).
- You can share, at least in general terms, what happened.

## How to start

Open a [design-partner issue](https://github.com/nigunpark/mycelink/issues/new?template=design-partner.yml).
It asks for the shape of the work, not your code. Leave out private
repository names and anything confidential. If you would rather not post
publicly, say so in the issue and we will agree another channel.
