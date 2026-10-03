# Public readiness — Mycelink 0.2.0-beta.1

**Status: PUBLIC_CI_GREEN.** The repository is public at
<https://github.com/nigunpark/mycelink>. The first public CI run
(`37105450954`) failed on all six matrix legs; the fix (`41b99d8`) is pushed
and CI run `37137320314` passed on all six legs (Windows, Ubuntu, macOS ×
Node 22.12.0 and 24), with CodeQL (`37137320292`) and OpenSSF Scorecard
(`37137320290`) also passing on the same commit. Branch protection and the
beta GitHub Release/tag remain; nothing has been tagged or released.

**New beta blocker found and fixed locally (not yet pushed or CI-verified).**
The first real-Claude pilot showed that real worker sessions could not start
any node: the worker was denied every attempt to read the context pack and
result path from environment variables and exited 0 with `RESULT_MISSING`.
The worker transport was redesigned on branch
`fix/real-worker-context-transport`, and the real pilot now reaches `DONE`
with a structured result and verified RED/GREEN evidence (see *Real-Claude
pilot*). The public CI status above is for `41b99d8`, which does **not**
contain this fix.

This file records what was verified, how, and what remains. It is not
shipped in the release archive.

## Verified support

| Platform | Node.js | Evidence |
|---|---|---|
| Windows 11 Pro (x64) | 24.14.1 | full suite 583/583, strict plugin validation, packaging ×2, ZIP install/update/uninstall in an isolated Claude profile |
| Windows 11 Pro (x64) | 22.12.0 (official portable build, SHA-256 checked) | full suite 583/583; runtime bundle rebuilt under 22.12.0 is byte-identical to the committed one |
| Ubuntu (GitHub-hosted, latest) | 22.12.0, 24 | **verified** by CI run `37137320314` at `41b99d8`: 593 tests, 589 passed, 4 skipped (Windows-only) per leg, including the POSIX-only bundle-mode test |
| macOS (GitHub-hosted, latest) | 22.12.0, 24 | **verified** by CI run `37137320314` at `41b99d8`: same totals as Ubuntu |
| Windows (GitHub-hosted, latest) | 22.12.0, 24 | **verified** by CI run `37137320314` at `41b99d8`: 593 tests, 592 passed, 1 skipped (POSIX-only) per leg, including the 8.3 short-path worktree regressions |

Tooling used locally: Git 2.53.0.windows.2, npm 11.19.0, Claude Code 2.1.288
(the CI pins the same CLI version). The README's Windows/Linux/macOS support
claim is backed by a CI run that is green on all six legs.

## First public CI run (`37105450954`): failure and fix (confirmed)

CodeQL and Scorecard passed; all six `test` legs failed, for two independent
reasons.

1. **Ubuntu and macOS: bundle mode flip in the build check.** `src/index.ts`
   starts with a hashbang, and esbuild writes hashbang outputs executable on
   POSIX, so the rebuilt `dist/mycelink.mjs` was mode 755 while git tracked
   it as `100644` (the repository was authored on Windows with
   `core.filemode=false`, which never recorded an executable bit). `git diff
   --exit-code -- dist` reported `old mode 100644 / new mode 100755`.
   *Fix:* `bin/mycelink.mjs` and `dist/mycelink.mjs` are now tracked as
   `100755`, matching the release ZIP (which `scripts/package.mjs` already
   stamps `0755`), and `scripts/build.mjs` sets `0755` explicitly instead of
   relying on esbuild and the umask. The ZIP's entry modes are unchanged.
   *Tests:* `tests/release/package.test.ts` checks, on every platform, that
   each shipped file's tracked mode agrees with its archive mode (RED before
   the index change: `bin/` and `dist/` were `100644`).
   `tests/release/bundle.test.ts` rebuilds to a temp file and compares its
   executable bit with the tracked mode; it runs on Linux/macOS only (Windows
   has no executable bit), so it is not observed locally; it passed on all
   four Ubuntu/macOS legs of CI run `37137320314`.
2. **Windows: worktree identity under an 8.3 temp path.** The runner's temp
   directory is under the 8.3 alias `RUNNER~1`; `git worktree list --porcelain`
   reports the long form of the same directory. `createWorkerWorktree` and
   `ensureIntegrationWorktree` matched registrations by path text, missed
   the existing worktree, **deleted its directory** (`rmSync`), then `git
   worktree add` failed with `missing but already registered worktree`. That
   caused the git-worktree test failures and the three-repo E2E failures on
   Node 22.12 and 24. *Fix:* `samePath()` in `src/security/paths.ts`
   compares the real paths of both sides (`realpathSync.native` on the
   deepest existing ancestor, which expands 8.3 names; case-insensitive on
   Windows), and both call sites use it. Containment checks
   (`isInsideReal`, `resolveInside`) are unchanged, so symlink/junction
   escape protection is unaffected. *Tests:* `samePath` unit tests for link
   aliases, distinct and linked-distinct directories, case, and a real 8.3
   alias; worker-worktree and integration-worktree regressions with a real
   8.3 alias root. All were RED with the CI error text before the fix. The
   pre-fix code run under `TMP`/`TEMP` set to an 8.3 alias reproduced the CI
   cascade (three-repo E2E steps 10, 12, 13 and the git-worktree tests). The
   fixed code passes the full suite under the same alias (591 passed at that
   point; the release mode tests were added afterwards).

Local verification of the fix (Windows 11, Node 24.14.1): `npm run typecheck`
exit 0; `npm run build:check` exit 0; `npm test` 36 files, 592 passed,
1 skipped (the POSIX-only mode test); `claude plugin validate --strict .` ✔;
`npm run package` twice with the same `SOURCE_DATE_EPOCH` gave byte-identical
zips and SBOMs, zip sha256
`ecd6c876c34b0d8aedadd2f44d843b84c1d3717b73a936c9a1083957759855de` (the
bundle changed, so this supersedes the hashes below). Node 22.12.0 was not
re-run locally for this fix; CI covers it.

**CI confirmation.** The fix was pushed as `41b99d8`. On that commit:

| Workflow | Run | Result |
|---|---|---|
| CI | `37137320314` | success on all six legs; Windows (Node 22.12.0, 24): 592 passed, 1 skipped; Ubuntu and macOS (Node 22.12.0, 24): 589 passed, 4 skipped (Windows-only 8.3/case tests); 593 tests in 36 files on every leg |
| CodeQL | `37137320292` | success |
| OpenSSF Scorecard | `37137320290` | success |

The commit that records these results also adds a line to `CHANGELOG.md`,
which is shipped, so it changes the zip hash. On that tree, `npx vitest run`
gave 36 files, 592 passed, 1 skipped; `claude plugin validate --strict .`
✔; and packaging twice with the same `SOURCE_DATE_EPOCH` gave byte-identical
zips, sha256
`e4a154df1e0e0e6a0194c9082f511f9c77e5d4033130d873931fad22ba5fe3e5`. The
`ecd6c876…` hash above remains the hash for `41b99d8` (re-checked). Runtime
files are unchanged.

## Test totals

With the worker-transport fix (local branch, not yet in CI): 617 tests in
38 files, 616 passed, 0 failed, 1 skipped on Windows (Node 24.14.1). The 24
new tests are in `tests/integration` (+17) and `tests/unit` (+7). The figures
below are for `41b99d8`.

593 tests in 36 files: locally on Windows (Node 24.14.1) 592 passed,
0 failed, 1 skipped (the POSIX-only bundle-mode test). CI run `37137320314`
ran the same 593 on all six legs with no failures (see *CI confirmation*). The 583-test pass recorded
below also passed on Node 22.12.0. The reference implementation had 312; all
were ported and adapted (none deleted), and 281 were added.

| Suite | Tests | What it covers |
|---|---|---|
| `tests/unit` | 192 | state, locks, event log, graph validation, scheduler, leases, transitions, context packs, E2E scheduler, loops, Brain, ECC adapter, adapter registry |
| `tests/integration` | 102 | git worktrees (including 8.3 short-path aliases), integration branches, candidates, evidence runner, session adapter (fake Claude), hooks as real processes, README walkthrough, doctor hook health |
| `tests/security` | 179 | path/UNC/device/extended-length/reserved-name refusal, symlink and junction escapes, path identity across aliases, malicious ids and ref names, argv/shell/batch-shim command policy, secret redaction in every durable artifact, PID reuse and lock-token mismatch, candidate tampering, untrusted PRD/graph content, permission-bypass refusal, protected configuration |
| `tests/fixtures` | 17 | three real repositories end to end: schedule, TDD gates, integration, candidate, E2E, invalidation, decisions |
| `tests/release` | 82 | bundle self-containment, third-party notices, reproducible packaging, tracked vs. archived executable modes, archive allowlist and secret/personal-path scan, SPDX SBOM, run-from-ZIP, metadata/version/license consistency, workflow hardening policy |
| `tests/plugin-e2e` | 21 | real Claude Code CLI in GUID-scoped isolated profiles: validation, `--plugin-dir`, marketplace install, component inventory, installed controller, init, uninstall; release-ZIP install → update → re-init → uninstall with control-repo data preserved |

No test incurs model usage.

## Verification commands and results (before the publication-metadata commit)

This table records the full verification pass on the tree immediately before
the publication-metadata commit. Typecheck, build check, the full test suite,
strict plugin validation and the double package run were last repeated after
the final `CHANGELOG.md` change; `npm ci`, `npm audit`, `actionlint` and the
manual ZIP install were run one commit earlier, and the only change between
the two was to `CHANGELOG.md`, so dependencies, workflows and runtime files
were unchanged. The current results are in the next section.

| Command | Result |
|---|---|
| `npm ci` | exit 0 |
| `npm audit` | found 0 vulnerabilities |
| `npm audit --omit=dev` | found 0 vulnerabilities |
| `npm run typecheck` | exit 0 |
| `npm run build` then `git diff --exit-code -- dist THIRD_PARTY_NOTICES.md` | exit 0 (committed bundle is current; build is deterministic) |
| `npx vitest run` | 36 files, 583 passed |
| `claude plugin validate --strict .` | ✔ Validation passed |
| `claude plugin validate --strict .claude-plugin/plugin.json` | ✔ Validation passed |
| `node scripts/package.mjs` twice | identical: zip `8eab660cce50392c42c62c114cc986c15932b37169494a32451ee09125650003` (1 018 941 bytes); SBOM identical for the same `SOURCE_DATE_EPOCH` |
| `actionlint` 1.7.12 on all workflows | no findings |
| Manual ZIP install in an isolated profile (`CLAUDE_CONFIG_DIR` in a temp dir) | strict validation ✔, marketplace add ✔, install ✔ (`0.2.0-beta.1`, enabled, under the isolated config), installed `mycelink --version` ✔, `init` ✔, `doctor` hooks ✔ pointing at the installed copy, uninstall ✔, control repo untouched; no `node_modules`, no `src`, no build step |
| Secret / personal-path scan of tracked files | no personal paths, no real e-mail addresses, no secret-like values (only synthetic `*@example.invalid` fixtures and a `c:/Users/someone` path-rejection test vector) |
| History scan of `main` (`git log -p --all`) | no personal paths or personal e-mail addresses in file contents (the only real address is a third-party copyright line in `THIRD_PARTY_NOTICES.md`) |
| `git status --short` | clean |

The zip hash covers file contents only; it is unaffected by commits that do
not touch shipped files (this document is not shipped). The SBOM embeds the
creation time (`SOURCE_DATE_EPOCH`, else the HEAD commit time) and the zip
hash, so it changes with the commit time by design.

### Re-verification after the publication-metadata commit (`9902b06`, the last commit changing shipped files before the report-only commits)

The commit that adds the `nigunpark/mycelink` URLs, CODEOWNERS and the
maintainers table changes shipped files (`package.json`, plugin manifest,
README, SECURITY, SUPPORT, GOVERNANCE, CHANGELOG), so the checks were re-run
on it: `npm run typecheck` exit 0; `npm run build:check` exit 0; `npx vitest
run` 36 files, 585 passed (two metadata tests added); `claude plugin validate
--strict .` and `.claude-plugin/plugin.json` ✔; `npm run package` twice with
the same `SOURCE_DATE_EPOCH` produced byte-identical zips, sha256
`d981e03581a7460adb471c49388d01494972f37b48afa42038e751de6d8840fc`
(supersedes the hash above). After the authorship rewrite (see below),
`npx vitest run` (36 files, 585 passed) and the double package run (same
sha256) were repeated at `9902b06`; the rewrite changed commit metadata only,
not file contents.

## Repository and history

- **`main` is the clean public history** and the only ref in the repository.
  It is an orphan history (single root commit `35ad200`, no ancestry from the
  reference implementation or the internal bootstrap work) and is **the
  branch to push**.
- Locally, `fix/real-worker-context-transport` (branched from `3575483`)
  carries the worker-transport fix; it has not been pushed. No other local
  branches, tags, worktrees or stashes. On GitHub, `main` is
  pushed at `41b99d8`; the only other remote branches are Dependabot update
  branches (open pull requests #1 and #2). No tags exist.
- Authorship was rewritten before publication: every reachable commit has
  author and committer `nigunpark` with the GitHub no-reply address, and no
  reachable commit carries a personal e-mail address. New commits use the
  same configured identity.

## Real-Claude pilot and the worker-transport fix

**First run (failed).** `MYCELINK_REAL_CLAUDE_PILOT=1 npm run test:pilot`
exited 0, but only because the pilot accepted a non-`DONE` ending.
`implementation/PILOT-MEASUREMENTS.json` recorded outcome `RETRY`, final state
`READY`, detail `RESULT_MISSING`, no RED or GREEN evidence. The durable
transcript showed the cause. The prompt told the worker to read
`$MYCELINK_CONTEXT_PACK` and write `$MYCELINK_RESULT_PATH`. Claude Code
2.1.288 in print mode denied every form of reading them: Bash `$VAR` ("a
variable in this command can't be checked before it runs"), PowerShell
`$env:`, `[Environment]::GetEnvironmentVariable`, and `Env:` provider paths.
The pack lived outside the worktree, where reads need an approval nobody can
give, so the worker never learned its node and wrote no result. The pilot's
pass was false, and real workers could not do any work.

**Fix.** The worker no longer discovers anything; see `CHANGELOG.md`
(*Unreleased → Fixed*) and `docs/PERMISSION_MODEL.md`. In summary:

- the validated, redacted, byte-bounded pack goes inline in a prompt sent on
  stdin;
- results come back through a git-ignored `.mycelink-worker/result.json` in
  the worktree, pre-approved as that one file and collected with link, size,
  schema and identity checks;
- the controller offers the `mycelink tdd` gates as exact, pre-approved
  command lines.

Before building on them, each Claude Code behavior this relies on was checked
against the real CLI (2.1.288, `haiku`, throwaway repositories):

- a stdin prompt with `-p` and `stream-json` works;
- `Edit(./<file>)` permits writing that one file and still denies a sibling
  path (`Write(./<file>)` does not match);
- an exact `Bash(<line>)` rule permits that line and denies the same line with
  one extra argument;
- repeated `--allowed-tools` flags merge.

**Regression tests (RED verified first).** 24 new tests:

- `tests/integration/worker-transport.test.ts` (15). It covers prompt-only
  delivery, no `MYCELINK_CONTEXT_PACK`/`MYCELINK_RESULT_PATH` in the worker
  environment, and stdin rather than argv. It covers exact grants, the
  git-ignored slot, and stale-result rejection. It covers rejection of an
  identity mismatch, an oversized result, a junction-redirected slot, an
  invalid/oversized/foreign pack, and an unsafe gate argument. It also covers
  result redaction, pack text that cannot close its block or forge protocol
  lines, and a prompt-only worker reaching `DONE` through the orchestrator
  with a behaviour-missing RED and a same-command GREEN.
- `tests/integration/hooks.test.ts` (+2): the result file is writable before
  RED and outside the fence; no other file in the slot is.
- `tests/unit/pilot-verdict.test.ts` (7): the pilot's pass rule.

The fake `claude` was tightened to the real worker's constraints. It reads its
brief only from the prompt, and it may write the result or run a gate only
when that exact grant is present. Against the old code, 25 tests failed on
assertions, including `expected 'RESULT_MISSING' to be null`, which reproduces
the pilot exactly.

**Pilot strengthened.** `tests/pilot/verdict.ts` now passes the pilot only on:

- a structured worker result with a behaviour-missing RED and a passing GREEN
  on the same command; or
- `NEEDS_DECISION` with a real question and at least two options.

`RESULT_MISSING`, `READY`, `BLOCKED` and `BUDGET_EXHAUSTED` fail it. The pilot
also sets two things that only it uses. One is an operator-style
least-privilege grant through `claude_extra_args`: `Read`, `Glob`, `Grep`,
`Edit(./src/**)`, `Edit(./tests/**)`, `Bash(node tests/run.mjs)` and scoped
`git` commands. The other is a realistic budget for the pilot node (80
counted turns, 15 minutes); the fixture default of 20 turns and 2 minutes is
sized for the fake.

**Second run (passed), Claude Code 2.1.288, worker model `sonnet`.**

- **Result:** `DONE` in 1 attempt, 1 session, 8 counted turns, about 26 s
  wall clock, 2,582 output tokens. The worker returned a structured
  `SUBMITTED` result with commit `5b705ea`.
- **Evidence:** RED exit 1, `behaviour-missing`. GREEN, regression and
  fresh-checkout verification all exit 0 on the same `node tests/run.mjs`.
  Verdict `ok`.
- **What the worker did** (from its durable transcript): it read only the
  worktree, ran the offered `tdd red`, wrote `src/publish.js`, ran `tdd green`
  and `tdd regression`, committed, and wrote the result file.
- **One denial:** it first appended `; echo EXIT $?` to the red line. That
  no longer matched the exact grant and was denied, and it retried with the
  line as written.
- **Limits:** this is one node and one run, not a distribution.
- **Not verified:** whether the control repository's project hooks were
  active inside the worker worktree. Fence enforcement in this run rests on
  Claude Code's scoped grants and the controller's fresh-checkout diff check.

**Other local verification at this change (Windows 11, Node 24.14.1):**

- `npm test`: 617 tests in 38 files, 616 passed, 0 failed, 1 skipped
  (POSIX-only).
- By suite: unit 199, integration 119, security 179, fixtures 17, release 82
  (1 skipped), plugin-e2e 21.
- `npm run typecheck` is clean.
- `npm run build:check` is clean: the rebuilt bundle is byte-identical to the
  committed one.
- `claude plugin validate --strict .` passed.
- Two packages built with the same `SOURCE_DATE_EPOCH` are byte-identical:
  58 files, SHA-256 `c27c97b6…f9c5f5`.

**Not yet done:** push the branch and get green CI on all six legs for this
commit.

## Remaining before publishing

1. ~~Create the GitHub repository and push `main`.~~ Done: public at
   <https://github.com/nigunpark/mycelink>.
2. ~~Add real URLs once the owner is known.~~ Done for `nigunpark/mycelink`:
   `package.json`, `.claude-plugin/plugin.json`, README install snippet,
   SECURITY/SUPPORT and issue-template links.
3. ~~Fill the maintainers table in `GOVERNANCE.md` and add
   `.github/CODEOWNERS`.~~ Done (`@nigunpark`); `tests/release/metadata.test.ts`
   now asserts both.
4. ~~Repository settings: private vulnerability reporting, Dependabot
   alerts/updates, code scanning.~~ Done: private vulnerability reporting,
   vulnerability alerts, automated security fixes, Issues and Discussions are
   enabled; CodeQL runs.
5. ~~Push the CI fix and get a run that is green on all six matrix legs,
   plus CodeQL and Scorecard.~~ Done: CI `37137320314`, CodeQL
   `37137320292`, Scorecard `37137320290`, all at `41b99d8`.
6. **Branch protection** for `main` requiring the CI checks. Not yet
   configured (`main` is currently unprotected).
7. **Beta GitHub Release and tag** `v0.2.0-beta.1` (see *Exact release
   commands*). Not yet created; `CHANGELOG.md` still carries the fixes under
   *Unreleased*.
8. **Land the worker-transport fix.** Commit it on
   `fix/real-worker-context-transport` (local; not pushed), merge it to
   `main`, and get CI green on all six legs. The tag must not be cut from a
   commit without it, because real workers cannot start a node without it.

## Known limitations

- Beta: schemas and CLI flags may change before 1.0.
- Worker branches use `wip/<feature>/<node>` (Git refs cannot nest under
  `feature/<feature>`).
- The ECC adapter is validated against the documented artifact shape only, not
  a live ECC installation; ECC is optional.
- The real-Claude pilot (`MYCELINK_REAL_CLAUDE_PILOT=1 npm run test:pilot`)
  covers one representative node. It passed once after the transport fix (see
  *Real-Claude pilot*), and it incurs model usage. Workers need
  operator-granted tools (`claude_extra_args`) to edit and commit; without
  them, a worker should return `BLOCKED` with `PERMISSION_DENIED:<tool>`. That
  path is covered by the prompt but not exercised by a real run.
- Turn counting is per stream event, so every tool call counts as a turn;
  set `max_turns` with that in mind.
- Claude Code has no `--max-turns`; the controller enforces turn ceilings by
  counting stream events.
- Shell mode is unsupported for E2E runtime steps; on Windows, batch-shim
  arguments containing `& | < > ^ " % !` or a trailing backslash are refused.
- After a plugin update the install path changes (it is versioned); users must
  re-run `mycelink init <control-repo>`, and `doctor` detects stale hooks.
- Redaction is pattern-based; the release checksum proves integrity, not
  authorship (no signing yet).

## Exact release commands

```bash
# one-time: publish `main` to the new remote (done)
git remote add origin https://github.com/nigunpark/mycelink.git
git push -u origin main

# every release (see docs/RELEASING.md)
npm ci
npm audit --omit=dev
npm run typecheck
npm run build && git diff --exit-code -- dist THIRD_PARTY_NOTICES.md
npm test
claude plugin validate --strict .
SOURCE_DATE_EPOCH=$(git log -1 --format=%ct) npm run package
SOURCE_DATE_EPOCH=$(git log -1 --format=%ct) npm run package -- --out artifacts/again
cmp artifacts/mycelink-0.2.0-beta.1.zip artifacts/again/mycelink-0.2.0-beta.1.zip
git tag -a v0.2.0-beta.1 -m "Mycelink v0.2.0-beta.1"
git push origin v0.2.0-beta.1      # release.yml verifies, packages and publishes
```
