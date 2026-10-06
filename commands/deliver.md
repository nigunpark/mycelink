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
3. Use the controller key you already hold in this conversation (`<key>`).
   Only if this control repository has never had one, run
   `M controller open --json`. If you do not hold an existing key, ask the
   user to run `mycelink controller open --takeover` in their own terminal.
   Never write the key to a file or a subagent prompt.
4. `M deliver $0 --json --authority <key>`

`deliver` checks everything before it moves anything: the feature verifies,
the candidate is current and still matches every repository, and each base
branch is a fast-forward to the candidate commit with a clean checkout. It
then fast-forwards each base branch to exactly the candidate SHA, writes
`features/$0/deliveries/<candidate>.json`, and runs each repository's test
command on the delivered commit. It never pushes and never forces; pushing
is yours to do afterwards.

If it reports `DELIVERY_REFUSED`, nothing moved: report each problem. If it
reports `DELIVERY_FAILED`, it put back what it moved: report the manifest's
`error`. If the manifest status is `PARTIAL_DELIVERY`, a base branch moved
underneath the delivery and was deliberately not reset: report the named
repositories to the user for manual recovery and do not retry blindly. Re-running `deliver` is safe: an accepted delivery is answered from
its manifest and an interrupted one resumes.

Report each repository's before and after SHA and the acceptance evidence.
