---
description: Record and apply a product decision that is blocking a feature
argument-hint: <feature-id> <decision-id> <answer...>
allowed-tools: Bash, Read, Edit, AskUserQuestion
---

# Record a decision

Feature: `$0`
Decision: `$1`

Recording and applying need `--authority <key>`: the controller key you
already hold in this conversation. Only if this control repository has never
had one, run `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" controller open --json`. If you do not hold an existing
key, ask the user to run `mycelink controller open --takeover` in their own
terminal and give it to you.

1. `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" decision list $0`
2. Read `features/$0/DECISIONS.md` for the exact question and options.
3. If the answer was not supplied in `$ARGUMENTS`, ask the user with
   AskUserQuestion. Present the real options and their consequences.
4. `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" decision record $0 $1 --answer "<answer>" --authority <key>`
5. If the decision changes the PRD or a public contract, update
   `features/$0/PRD.md` and `contracts/` first, then invalidate only the
   affected nodes with `node invalidate ... --authority <key>` — it cascades to dependents.
6. `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" decision apply $0 $1 --authority <key>`

Never answer a product decision yourself.
