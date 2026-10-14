# Launch drafts

Drafts for announcing the public beta. **Nothing here has been posted.** Each
draft is meant to be edited by the person posting it, in their own voice.

| File | For |
|---|---|
| [CHECKLIST.md](CHECKLIST.md) | what must be true before anything is posted, and on the day |
| [SHOW_HN.md](SHOW_HN.md) | a Show HN post and the first comment |
| [REDDIT.md](REDDIT.md) | a Reddit post for Claude Code communities |
| [SOCIAL.md](SOCIAL.md) | an X thread and a LinkedIn post |

## Rules for every post

Every claim must trace to the repository. When in doubt, cut it.

- **Say:** deterministic orchestration for Claude Code across several Git
  repositories: isolated worktrees, enforced TDD gates, independent review of
  each criterion, and one immutable candidate pinning exact SHAs.
- **Say:** public beta, Apache-2.0, no telemetry, runs locally, never pushes,
  not affiliated with Anthropic.
- **Say, always with its caveats:** 12 of 12 public-project arms verified,
  in a matrix run and reported by the maintainer. The caveats: multi-module
  inside one repository per PRD, one verified run selected per cell (19 of 54
  runs verified), no without-plugin baseline, and cost not measured. Link
  [the report](../evals/2026-10-12-public-project-final-matrix.md).
- **Never say:** that it writes better code, is faster or cheaper, raises
  success rates, beats any named tool, or is "production-ready". Never imply
  that the public model runs were cross-repository.
- **Never** post the same text to many communities at once, ask for upvotes,
  or ask friends to vote.
