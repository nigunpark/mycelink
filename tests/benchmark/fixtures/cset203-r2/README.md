# CSET-203 r2: the workers' own commits

The six commits the with-normal arm's module-workers made in the CSET-203 r2
pilot (suite 3a54a17, frozen Changesets c73949ba7b31), exported with
`git show --format= --binary`, in order:

| # | commit | node | what |
|---|---|---|---|
| 1 | 9d29583 | apply-release-plan | test: rollback and journal (rollback when a `package.json` write fails) |
| 2 | 71f62c6 | apply-release-plan | feat: journal and roll back `applyReleasePlan` |
| 3 | d98563d | cli | test: `version` recovers from a journal and fails cleanly |
| 4 | b57676d | cli | feat: recover interrupted version runs and fail cleanly |
| 5 | 77e69f4 | cli | test: real-process kill recovery |
| 6 | 2d42e5f | cli | fix: recover from a journal cut short by a kill |

Every node of that run settled DONE under strict TDD and the delivery failed
exactly one hidden check: AC-1, "when a changelog cannot be written, every
file is restored". Commit 1 tests rollback only at the `package.json`
boundary; commit 2's journal records a path it cannot read as a file
(`EISDIR`) as absent, so its rollback removes a directory standing where a
changelog was to be written.

`tests/benchmark/cset203-review-real.test.ts` replays them as the workers'
first submissions, and the acceptance reviewer's GAP drives the rework.
