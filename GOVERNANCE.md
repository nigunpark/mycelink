# Governance

Mycelink is an independent open-source project maintained by the Mycelink
Contributors. It is not affiliated with or endorsed by Anthropic.

## Roles

- **Users** use Mycelink and report problems.
- **Contributors** propose changes through issues and pull requests. Anyone
  can be a contributor.
- **Maintainers** review and merge pull requests, triage issues, handle
  security reports, and cut releases.

## Maintainers

| GitHub handle | Areas |
|---|---|
| [@nigunpark](https://github.com/nigunpark) | all |

`.github/CODEOWNERS` mirrors this table; update both together.

## Decisions

- Day-to-day changes are decided in pull requests: one maintainer approval and
  green CI are required to merge. Maintainers do not merge their own
  non-trivial changes without a second review when a second maintainer exists.
- Larger changes — new adapters, schema changes, changes to the security or
  permission model, new runtime dependencies, license questions — start as an
  issue labelled `proposal`, stay open for at least 7 days for comment, and
  are decided by maintainer consensus. If consensus cannot be reached, the
  majority of maintainers decides.
- Security fixes may be developed privately and merged without the public
  comment period; see [SECURITY.md](SECURITY.md).

## Becoming a maintainer

Contributors with a sustained record of high-quality contributions and
reviews may be invited by the existing maintainers. Maintainers who are
inactive for 12 months may be moved to emeritus status.

## Changes to this document

Changes to governance follow the "larger changes" process above.
