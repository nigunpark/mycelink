# Roadmap

Mycelink is in public beta (`0.3.0-beta.1`). This roadmap says what has to be
true before 1.0. It sets priorities, not dates. It changes with what beta
users report. To influence it, open a
[first-run feedback](https://github.com/nigunpark/mycelink/issues/new?template=first-run.yml)
issue, a [feature request](https://github.com/nigunpark/mycelink/issues/new?template=feature.yml),
or [become a design partner](DESIGN_PARTNERS.md).

## Where things stand

- **Works today:** one approved PRD becomes a validated graph. Each node runs
  in its own worktree with enforced RED/GREEN gates. An independent reviewer
  checks every criterion and drives rework. One immutable candidate binds
  every repository, and `deliver` fast-forwards each base branch without
  pushing. The model-free suite runs on Windows, Linux and macOS with
  Node 22.12 and 24.
- **Shown with a real model, by the maintainer:** 12 of 12 public-project
  arms verified by an independent verifier with hidden acceptance tests
  ([report](evals/2026-10-12-public-project-final-matrix.md)). Those changes
  are multi-module inside one repository, one verified run per cell, with no
  baseline and no cost measurement.
- **Not shown yet:** a public model run across separate repositories, a
  success rate over repeated runs, uplift over plain Claude Code, cost, and
  upgrading a feature in flight from one release to the next.

## 1. Beta feedback

- Collect first runs on the [quickstart](../examples/quickstart/) and on real
  repositories: where setup stopped, which error was unclear, how long it took.
- Turn every refusal that users report as confusing into a clearer message
  or a `doctor` check. Every refusal code should name the next step.
- Track compatibility across Claude Code releases. Mycelink depends on plugin
  marketplaces, subagents and hooks behaving as documented.

## 2. Real cross-repository pilots

- Run features that span **separate** repositories (not modules of one
  repository) with design partners, on their own code and test suites.
- Publish what happened, including the runs that failed, with the same
  candidate, delivery and verifier records the public-project matrix uses.
- Add a public, reproducible cross-repository model benchmark next to the
  existing multi-module one.

## 3. Resume and upgrade compatibility

- A feature started on one beta release resumes after a plugin update, or
  refuses with a clear message and a documented way forward.
- Updating today means re-running `init` to refresh hook paths (README,
  *Update and uninstall*). Make `doctor` detect every step that is missing.
- Test the upgrade path in CI against control repositories recorded by the
  previous release.

## 4. Performance, cost and failure metrics

- Report per feature: sessions started, model usage and cost (as Claude Code
  reports them), wall-clock time, rework rounds, refusals by kind, and
  where a run stopped.
- Run repeated trials per case, with and without the plugin, and publish
  success rates and spread instead of one selected run per cell.
- Cut overhead where the metrics show it, for example fewer review sessions
  when nothing changed.

## 5. Schema migration

- Every canonical artifact carries a schema version (`schema_version`, or a
  `mycelink-<kind>/<n>` tag). Today migration is piecemeal: `evidence migrate`,
  and review lineage migrated on its next write.
- Goal: one documented migration path for control repositories (graph, state,
  ledgers, evidence), a dry run that reports what would change, and a refusal
  for versions it does not know rather than a guess.

## 6. Criteria for 1.0

1.0 ships when all of these hold:

- [ ] CLI flags, graph schema and state schemas are frozen, and any later
      change comes with a migration.
- [ ] Features resume across at least one minor upgrade, tested in CI.
- [ ] Several external cross-repository pilots have run, with their results
      published, failures included.
- [ ] Success rate, cost and time are published from repeated runs, with a
      without-plugin baseline.
- [ ] The threat model and permission model have been reviewed against the
      1.0 surface, and no high-severity security report is open.
- [ ] The quickstart works first time on Windows, Linux and macOS for people
      outside the project, as their first-run reports show.

## Not planned

- A hosted service, accounts or telemetry.
- Support for models other than Claude through Claude Code.
- Automatic pushing, merging or force-pushing.
