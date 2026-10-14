# Launch checklist

Work through it in order. A box is ticked only by checking, never from
memory. **Do not post until every item under "Before posting" is ticked.**

## Before posting

### The repository

- [ ] The adoption branch is merged to `main`. The README's absolute links
      (`blob/main/...`, `tree/main/examples/quickstart`, issue forms) only
      resolve once it is.
- [ ] CI on `main` is green on Windows, Linux and macOS for the merge commit.
      Record the run id here: `________`.
- [ ] The README renders on GitHub: the Mermaid diagram draws, the badges
      load, and the tables are readable on a phone-width window.
- [ ] Every link in the README works when clicked on github.com, including
      both issue forms (`first-run.yml`, `design-partner.yml`).
- [ ] The release named in the README (`0.3.0-beta.1`) exists, and its ZIP and
      `.sha256` download and verify. If the release is not published, remove
      the release-ZIP install path from the posts.
- [ ] The repository description and topics on GitHub match the README hero.
      Suggested topics: `claude-code`, `claude-code-plugin`, `tdd`,
      `git-worktree`, `multi-repo`, `orchestration`.

### The quickstart, run by a person

The model-free part of the quickstart (setup, `verify-demo.mjs` and the
scripted `walkthrough.mjs`) is checked by `tests/release/quickstart.test.ts`
and `tests/fixtures/quickstart-walkthrough.test.ts`. The model-driven part
has not been run for this launch yet.

- [ ] On a clean machine (or a fresh user account) with a current Claude Code,
      follow [the quickstart](../../examples/quickstart/README.md) exactly as
      written, from install to a delivered candidate.
- [ ] Note what it took: wall-clock time, sessions, and the model usage that
      Claude Code reports. Use these numbers in posts **only** if you say they
      come from one run.
- [ ] Fix any step that needed knowledge the walkthrough does not give.
- [ ] Repeat on a second OS, if possible.
- [ ] Any recording or screenshot of the scripted walkthrough follows
      [RECORDING.md](../../examples/quickstart/RECORDING.md) and says it is
      scripted, not a model run.

### The claims

- [ ] Each post's numbers match
      [the public-project report](../evals/2026-10-12-public-project-final-matrix.md):
      6 PRDs, 12 arms, 12 verified, 19 of 54 with-plugin runs verified, 5
      suite commits, no baseline, cost out of scope.
- [ ] Each post says the public model arms are multi-module inside one
      repository, and that the matrix was run by the maintainer.
- [ ] No post claims better code, speed, cost or success rate, or names
      another tool as worse.
- [ ] The non-affiliation sentence ("not affiliated with or endorsed by
      Anthropic") appears in each long-form post.

### Being ready to answer

- [ ] Discussions **Q&A** and the issue forms work for an account that is
      not the maintainer's.
- [ ] Optional: create `first-run` and `design-partner` labels and add them
      to the two issue forms. The forms use only existing labels today.
- [ ] Block out the first 6 hours after posting to answer comments and
      issues.
- [ ] Prepare honest answers to the obvious questions (see
      [SHOW_HN.md](SHOW_HN.md), "Likely questions").

## On the day

- [ ] Post to one place first (Show HN is the usual choice). Wait at least a
      day before the next.
- [ ] Post from the maintainer's own account, and say plainly that you built
      it.
- [ ] Answer every technical question, including critical ones, with links
      into the repository instead of adjectives.
- [ ] Log every bug reported in comments as an issue, with credit to the
      reporter.

## Afterwards

- [ ] Write down what people asked that the README did not answer, and fix
      the README.
- [ ] Triage first-run feedback weekly, and feed it into
      [the roadmap](../ROADMAP.md).
- [ ] Follow up with every design-partner offer within a week.
