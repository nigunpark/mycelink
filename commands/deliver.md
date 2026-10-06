---
description: Deliver a verified feature — fast-forward every base branch to the candidate, then run final acceptance
argument-hint: <feature-id>
allowed-tools: Bash, Read
---

# Deliver

Feature: `$0`

Let `M` be `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs"`.

1. `M feature verify $0` — must exit 0.
2. `M candidate verify $0` — must exit 0.
3. `M deliver $0 --json`

`deliver` checks everything before it moves anything: the feature verifies,
the candidate is current and still matches every repository, and each base
branch is a fast-forward to the candidate commit with a clean checkout. It
then fast-forwards each base branch to exactly the candidate SHA, writes
`features/$0/deliveries/<candidate>.json`, and runs each repository's test
command on the delivered commit. It never pushes and never forces; pushing
is yours to do afterwards.

If it reports `DELIVERY_REFUSED`, nothing moved: report each problem. If it
reports `DELIVERY_FAILED`, it put back what it moved: report the manifest's
`error`. Re-running `deliver` is safe: an accepted delivery is answered from
its manifest and an interrupted one resumes.

Report each repository's before and after SHA and the acceptance evidence.
