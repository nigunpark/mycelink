# Recording storyboard (45–60 s)

A terminal recording of the **scripted walkthrough**. It shows the
controller doing its job on two real Git repositories; it is not a model run
and must never be presented as one.

## Rules

- The first frame says: *scripted worker and reviewer, no model*.
- Show the walkthrough's real output, unedited apart from cutting idle time.
  Do not splice in footage or numbers from a model run.
- No speed, cost or benchmark claims. The walkthrough's run time depends on
  the machine and is not a measure of Mycelink or of a model.
- The AC-4 gap is planted in the scripted worker's first version; say so.

## Record

From the root of a Mycelink clone, with
[asciinema](https://docs.asciinema.org/) installed:

```bash
asciinema rec quickstart.cast --cols 120 --rows 32 --idle-time-limit 1.5 --command "node examples/quickstart/walkthrough.mjs --pace 350"
```

`--pace <ms>` waits after each output line so a viewer can read it;
`--idle-time-limit` cuts the waits while the gates and settles run. Without
asciinema, any screen recorder and the same `node` command work.

## Storyboard

| Time | On screen (walkthrough output) | Caption |
|---|---|---|
| 0–5 s | header: `Mycelink … quickstart walkthrough … Scripted worker and reviewer, no model` | Two Git repositories, one feature. Scripted, no model. |
| 5–11 s | `[setup]` orders-api and orders-web, each its own repository on `main`; probe `0/4` | Independent repos; the feature does not exist yet. |
| 11–16 s | `[plan]` graph valid; `READY ORD-101.api.status.impl` | The web node waits for the API, the contract's producer. |
| 16–26 s | `[dispatch]` api node to its own worktree; `[red]` failed tests; `[commit] tests only`; `[green]`; `[commit] production only`; `[regress]`; `[settle] DONE` | Test first, proven by the controller, re-verified clean. |
| 26–33 s | the same for the web node | Only now does the client change. |
| 33–43 s | `[review] ORD-101-R001: GAP AC-4`; `[rework]` web reopened; new `[red]`: *a payload without a status* | Fault: the reviewer finds an untested clause. No candidate yet. |
| 43–50 s | `[review] ORD-101-R002: PASS`; `[candidate] ORD-101-C001 … api@… web@…` | One immutable candidate binds both SHAs. |
| 50–60 s | `[deliver] ACCEPTED`; both `main` SHAs; `[verify] … 4/4`; `Done: … 0 model calls.` | Delivered exactly what was verified. Nothing pushed. |

End card: `node examples/quickstart/setup.mjs --out ../mycelink-quickstart`,
then `/mycelink:run ORD-101` in Claude Code for a real run (uses model quota).

## The README animation

`docs/assets/quickstart-demo.gif` (and its still, `quickstart-demo-static.png`,
for readers who prefer reduced motion) follows this storyboard without a
screen recorder. `node scripts/quickstart-demo-gif.mjs` turns
[SAMPLE-OUTPUT.md](SAMPLE-OUTPUT.md) into one local HTML page per scene,
renders each with a headless Chrome, Chromium or Edge, and joins them with
ffmpeg (`--browser` and `--ffmpeg` name them; `--frames <dir>` keeps the
PNGs). Every frame carries the label `SCRIPTED WALKTHROUGH · NO MODEL`, shows
the sample's lines verbatim, and nothing else; the same browser, fonts and
ffmpeg give the same bytes. `tests/release/quickstart-demo-gif.test.ts` holds
the committed GIF to the generator's plan. Regenerate it whenever the sample
changes. A real model run is never shown in it; it is reported in
[its own report](../../docs/evals/2026-10-15-public-two-repo-demo.md).
