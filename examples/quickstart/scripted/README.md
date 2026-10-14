# Scripted worker content (walkthrough only)

`walkthrough.mjs` plays the module-worker and the acceptance reviewer from
a script, so the controller can be shown end to end without a model. These
are the files its scripted workers write, step by step, into each node's
worktree:

| step | file | what the walkthrough does with it |
|---|---|---|
| `api/1-red` | `orders/test/order-status.test.mjs` | red gate, then a test-only commit |
| `api/2-green` | `orders/src/order-status.js` | green gate, production-only commit, regression gate |
| `web/1-red` | `ui/test/status-line.test.mjs` | red gate, test-only commit |
| `web/2-green` | `ui/src/status-line.js` | green, commit, regression. **Planted fault:** it throws on a payload with no `status` (AC-4), and no test covers that clause |
| `web/3-rework-red` | `ui/test/status-line.test.mjs` | after the scripted reviewer's GAP: the focused failing test |
| `web/4-rework-green` | `ui/src/status-line.js` | the fix |

None of this is copied into the baseline repositories that `setup.mjs`
creates: a real run starts from the baselines alone.
