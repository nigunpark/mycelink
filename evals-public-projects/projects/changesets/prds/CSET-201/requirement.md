# CSET-201 — Explain why each package is in the release plan

Status: approved · Archetype: additive vertical slice

## Problem

`changeset status` lists the packages that will be bumped, but not why. A
package can be in the plan because a changeset names it, because it depends
on a package that is being bumped out of its range, because it shares a
`fixed` or `linked` group with a releasing package, or because pre mode is
being exited. Maintainers currently reverse-engineer the planner to find out.

## Scope

| Package | Change |
|---|---|
| `packages/types` (`@changesets/types`) | the `ReleaseReason` type and an optional `reasons` on releases |
| `packages/assemble-release-plan` | record each reason where the planning decision is made |
| `packages/cli` | `changeset status --explain` |

No other package changes.

## Acceptance criteria

**AC-1 — types.** `@changesets/types` exports a `ReleaseReason` union with
exactly these members, and `ComprehensiveRelease` gains an optional
`reasons?: ReleaseReason[]`:

```ts
type ReleaseReason =
  | { type: "changeset"; changeset: string; bumpType: VersionType }
  | {
      type: "dependent";
      dependency: string;
      dependencyType: DependencyType;
      versionRange: string;
      bumpType: VersionType;
    }
  | { type: "fixed"; group: string[]; bumpType: VersionType }
  | { type: "linked"; group: string[]; bumpType: VersionType }
  | { type: "prerelease-exit"; bumpType: "patch" };
```

- `changeset`: the changeset with id `changeset` lists the package with
  `bumpType` (one reason per such changeset, including `none`).
- `dependent`: the package depends on `dependency` (a package in the plan)
  through `dependencyType` with the range `versionRange` exactly as written in
  its `package.json` (including any `workspace:` prefix), and that made the
  planner give it `bumpType`.
- `fixed` / `linked`: the planner aligned the package's bump to `bumpType`
  because of the configured group `group` (the group's package names, in
  configuration order after glob expansion).
- `prerelease-exit`: the package gets a patch release because pre mode is
  being exited.

**AC-2 — causal recording (assemble-release-plan).**
`assembleReleasePlan(changesets, packages, config, preState, snapshot, options)`
accepts an optional sixth argument `{ explain?: boolean }`.

- With `explain: true`, every release in the returned plan has a non-empty
  `reasons` array. A reason is appended at the moment the planner adds the
  package to the plan or changes its bump type, in the order those decisions
  happen; the same reason is never listed twice for a package.
- A `dependent` reason names the dependency whose release caused it — also
  when that dependency was itself added by a group or as a dependent.
- A group alignment that does not change a package's bump type adds no
  reason.
- Without the argument, or with `explain: false`, the plan is identical to
  today's: releases have no `reasons` property.

**AC-3 — CLI.** `changeset status --explain` prints the usual list. Under each
package line (and after its `--verbose` lines, when given) it prints one line
per reason, in order, indented by four spaces:

| Reason | Line |
|---|---|
| changeset | `    - reason: changeset .changeset/<id>.md (<bumpType>)` |
| dependent | `    - reason: dependent of <dependency> (<dependencyType> <versionRange>) -> <bumpType>` |
| fixed | `    - reason: fixed group [<name>, <name>, …] -> <bumpType>` |
| linked | `    - reason: linked group [<name>, <name>, …] -> <bumpType>` |
| prerelease-exit | `    - reason: exiting prerelease mode -> patch` |

`--explain` combines with `--verbose`, `--since` and `--output`. With
`--output <file>` it writes the plan JSON with each release's `reasons`.

**AC-4 — compatibility.** Without `--explain`, everything `changeset status`
prints and everything it writes with `--output` is byte-identical to today.

## Engineering expectations

- Implement each criterion in the package that owns it, with tests in that
  package.
- Existing tests keep passing. Do not change the build tooling, the
  workspace layout or package names.
