## Summary

<!-- What does this change and why? Link the issue it resolves. -->

## RED → GREEN

<!-- Which test failed before this change, and why did it fail for the right reason? -->

## Checklist

- [ ] Tests added or updated; `npm test` passes locally
- [ ] `npm run typecheck` passes
- [ ] `npm run build` run; `dist/mycelink.mjs` and `THIRD_PARTY_NOTICES.md` committed if changed
- [ ] `claude plugin validate --strict .` passes (if plugin files changed)
- [ ] Docs updated (README, `docs/`, command/skill text) for any behaviour or flag change
- [ ] `CHANGELOG.md` entry under **Unreleased**
- [ ] No secrets, personal paths, e-mail addresses, private repository names or organisation-specific procedures
- [ ] Security impact considered (does this widen what a model, graph or command can do?)
