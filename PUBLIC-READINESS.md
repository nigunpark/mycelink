# Public readiness — Mycelink 0.2.0-beta.1

**Status: VERIFIED_PUBLIC_READY** for the local verification scope below.
Publication still needs the GitHub-owner-dependent steps listed under
*Remaining before publishing*; nothing has been pushed or published.

This file records what was verified, how, and what remains. It is not
shipped in the release archive.

## Verified support

| Platform | Node.js | Evidence |
|---|---|---|
| Windows 11 Pro (x64) | 24.14.1 | full suite 583/583, strict plugin validation, packaging ×2, ZIP install/update/uninstall in an isolated Claude profile |
| Windows 11 Pro (x64) | 22.12.0 (official portable build, SHA-256 checked) | full suite 583/583; runtime bundle rebuilt under 22.12.0 is byte-identical to the committed one |
| Ubuntu (latest) | 22.12.0, 24 | **configured in `ci.yml`, not yet executed** (no remote repository exists yet; no local Linux environment) |
| macOS (latest) | 22.12.0, 24 | **configured in `ci.yml`, not yet executed** (same reason) |

Tooling used locally: Git 2.53.0.windows.2, npm 11.19.0, Claude Code 2.1.288
(the CI pins the same CLI version). The README's Linux/macOS support claim is
backed by the CI matrix definition; treat it as unproven until the first CI
run on GitHub is green on all six legs.

## Test totals

583 tests in 36 files, 583 passed, 0 failed, 0 skipped (Node 24.14.1 and
22.12.0). The reference implementation had 312; all were ported and adapted
(none deleted), and 271 were added.

| Suite | Tests | What it covers |
|---|---|---|
| `tests/unit` | 192 | state, locks, event log, graph validation, scheduler, leases, transitions, context packs, E2E scheduler, loops, Brain, ECC adapter, adapter registry |
| `tests/integration` | 100 | git worktrees, integration branches, candidates, evidence runner, session adapter (fake Claude), hooks as real processes, README walkthrough, doctor hook health |
| `tests/security` | 175 | path/UNC/device/extended-length/reserved-name refusal, symlink and junction escapes, malicious ids and ref names, argv/shell/batch-shim command policy, secret redaction in every durable artifact, PID reuse and lock-token mismatch, candidate tampering, untrusted PRD/graph content, permission-bypass refusal, protected configuration |
| `tests/fixtures` | 17 | three real repositories end to end: schedule, TDD gates, integration, candidate, E2E, invalidation, decisions |
| `tests/release` | 78 | bundle self-containment, third-party notices, reproducible packaging, archive allowlist and secret/personal-path scan, SPDX SBOM, run-from-ZIP, metadata/version/license consistency, workflow hardening policy |
| `tests/plugin-e2e` | 21 | real Claude Code CLI in GUID-scoped isolated profiles: validation, `--plugin-dir`, marketplace install, component inventory, installed controller, init, uninstall; release-ZIP install → update → re-init → uninstall with control-repo data preserved |

No test incurs model usage.

## Verification commands and results (final run at commit `3e55527`)

`3e55527` is the last commit that changes shipped files (it updated
`CHANGELOG.md`). Typecheck, build check, the full test suite, strict plugin
validation and the double package run were repeated there. `npm ci`,
`npm audit`, `actionlint` and the manual ZIP install were last run at
`57aff36`. Since then the only change is to `CHANGELOG.md`, so dependencies,
workflows and runtime files are unchanged.

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
| History scan of `main` (`git log -p HEAD`) | no personal paths or e-mail addresses in file contents |
| `git status --short` | clean |

The zip hash covers file contents only; it is unaffected by commits that do
not touch shipped files (this document is not shipped). The SBOM embeds the
creation time (`SOURCE_DATE_EPOCH`, else the HEAD commit time) and the zip
hash, so it changes with the commit time by design.

## Repository and history

- **`main` is the clean public history** and the only local branch. It is an
  orphan history (single root commit `9fb32f3`, no ancestry from the
  reference implementation or the internal bootstrap work) and is **the
  branch to push**.
- The internal bootstrap branch and the temporary worktree branches have
  been deleted; no other local branches, worktrees or stashes remain.
- Commits on `main` carry the local Git author identity configured
  on this machine (name and e-mail). Decide before publishing whether to keep
  it or rewrite the branch's authorship to a GitHub no-reply address; this
  was deliberately not changed without your decision.

## Remaining before publishing (GitHub-owner-dependent)

1. Create the GitHub repository and push `main`.
2. Add real URLs once the owner is known — intentionally absent now (no fake
   placeholders): `repository`, `homepage` and `bugs` in `package.json`;
   `repository`/`homepage` in `.claude-plugin/plugin.json` (re-run
   `claude plugin validate --strict .`); replace `<owner>` in the README's
   *From GitHub* install snippet.
3. Fill the maintainers table in `GOVERNANCE.md` and add `.github/CODEOWNERS`
   (then update `tests/release/metadata.test.ts`, which currently asserts
   CODEOWNERS is absent).
4. Repository settings: enable **private vulnerability reporting** (SECURITY.md
   depends on it), Dependabot alerts/updates, code scanning, and branch
   protection for `main` requiring the CI checks.
5. Let the first CI run finish green on all six matrix legs (Windows, Ubuntu,
   macOS × Node 22.12.0, 24), plus CodeQL and Scorecard. Fix any
   Linux/macOS-specific failures before tagging.
6. Optionally set the commit authorship (see above).

## Known limitations

- Beta: schemas and CLI flags may change before 1.0.
- Linux and macOS are CI-configured but not yet executed.
- Worker branches use `wip/<feature>/<node>` (Git refs cannot nest under
  `feature/<feature>`).
- The ECC adapter is validated against the documented artifact shape only, not
  a live ECC installation; ECC is optional.
- The real-Claude pilot (`MYCELINK_REAL_CLAUDE_PILOT=1 npm run test:pilot`)
  was not run for this release; it incurs model usage.
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
# one-time: publish `main` to the new remote
git remote add origin https://github.com/<owner>/mycelink.git
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
