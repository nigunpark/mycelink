---
description: Record and apply a product decision that is blocking a feature
argument-hint: <feature-id> <decision-id> <answer...>
allowed-tools: Bash, Read, Edit, AskUserQuestion
---

# Record a decision

Feature: `$1`
Decision: `$2`

1. `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" decision list $1`
2. Read `features/$1/DECISIONS.md` for the exact question and options.
3. If the answer was not supplied in `$ARGUMENTS`, ask the user with
   AskUserQuestion. Present the real options and their consequences.
4. `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" decision record $1 $2 --answer "<answer>"`
5. If the decision changes the PRD or a public contract, update
   `features/$1/PRD.md` and `contracts/` first, then invalidate only the
   affected nodes with `node invalidate` — it cascades to dependents.
6. `node "${CLAUDE_PLUGIN_ROOT}/bin/mycelink.mjs" decision apply $1 $2`

Never answer a product decision yourself.
