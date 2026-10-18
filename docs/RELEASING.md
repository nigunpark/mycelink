# Releasing

Releases are tag-driven and reproducible. The same commit always produces the
same ZIP bytes, checksum and SBOM.

## Versioning

- Semantic Versioning; pre-releases use `-beta.N` / `-rc.N`.
- The version lives in five places that must agree: `package.json`,
  `package-lock.json` (root entry), `.claude-plugin/plugin.json`, the
  plugin entry plus `metadata.version` in `.claude-plugin/marketplace.json`,
  and `codex-plugin/plugin.json` (discovery-only).
  `npm test` checks they agree (`tests/release/metadata.test.ts`).
- The Git tag is `v<version>`, e.g. `v0.3.0-beta.1`.

## Checklist

1. Update the version in the five places above and move **Unreleased**
   entries in `CHANGELOG.md` under the new version heading. Also update the
   places a user reads the version, which `npm test` checks too: the
   README's status line and release-ZIP example, the version placeholders in
   the bug and compatibility issue templates, and the supported line in
   `SECURITY.md`.
2. Run the full verification locally:

   ```bash
   npm ci
   npm audit --omit=dev
   npm run typecheck
   npm run build                     # must not change dist/ or notices afterwards
   npm test
   claude plugin validate --strict .
   npm run package
   npm run package                   # again: hashes must be identical
   ```

3. Commit (`chore(release): v<version>`), open a pull request, and wait for CI
   to pass on Windows, Linux and macOS.
4. After merge, tag the merge commit and push the tag:

   ```bash
   git tag -a v<version> -m "Mycelink v<version>"
   git push origin v<version>
   ```

5. The `release` workflow verifies the tag matches the package version,
   re-runs typecheck/build-drift/tests/strict validation, packages twice and
   compares hashes, then uploads `mycelink-<version>.zip`,
   `mycelink-<version>.zip.sha256` and `SBOM.spdx.json` to a GitHub Release
   (marked pre-release for `-beta`/`-rc` versions).
6. Smoke-test the published ZIP in a clean profile:

   ```bash
   sha256sum -c mycelink-<version>.zip.sha256
   unzip mycelink-<version>.zip -d mycelink
   claude plugin validate --strict ./mycelink
   claude plugin marketplace add ./mycelink
   claude plugin install mycelink@mycelink-marketplace
   # Codex: set ISOLATED_CODEX_HOME to a fresh native absolute directory first.
   CODEX_HOME="$ISOLATED_CODEX_HOME" codex plugin marketplace add ./mycelink
   CODEX_HOME="$ISOLATED_CODEX_HOME" codex plugin list --available
   CODEX_HOME="$ISOLATED_CODEX_HOME" codex plugin add mycelink@mycelink-codex-marketplace
   CODEX_HOME="$ISOLATED_CODEX_HOME" codex plugin list
   ```

Codex plugin discovery does **not** enable Codex worker/runtime execution.
That remains disabled pending security review; the Codex bundle contains only
a status skill and an explicit empty hooks overlay. The Claude hooks and
workers are not exposed by this Codex plugin. To repeat the isolated live
CLI install test on a machine with `codex-cli 0.163.0` installed, run
`MYCELINK_LIVE_CODEX_PLUGIN=1 npx vitest run tests/release/codex-plugin.test.ts`
from the source checkout. The regular release suite checks ZIP contents but
skips the CLI install test when this opt-in variable is unset.

## Reproducing a release

```bash
git checkout v<version>
npm ci
SOURCE_DATE_EPOCH=$(git log -1 --format=%ct) npm run package
sha256sum artifacts/mycelink-<version>.zip    # equals the published checksum
```

The archive uses STORE (no compression), a fixed 1980-01-01 timestamp, sorted
entries, normalised modes and LF line endings, so it does not depend on the
Node.js or zlib version. The SBOM creation time is `SOURCE_DATE_EPOCH`, or the
commit time when unset.

## What goes in the archive

Exactly the allowlist in `scripts/package.mjs`: Claude and Codex-discovery
marketplace manifests, the isolated informational Codex plugin, Claude
commands, skills, agents and hooks, templates, schemas, user documentation
(the threat model, permission model, data handling, adapters and this file),
the launcher, runtime bundle, runtime-only `package.json`, and the license,
notice, changelog, security, support, contributing, conduct and governance
files. Sources, tests, scripts, CI configuration, the benchmark suites
(`evals-*/`), the eval reports under `docs/evals/` and the benchmark's
constraint audit are never included; they stay in the repository.
`tests/release/package.test.ts` enforces this, checks that every relative
link in a shipped Markdown file resolves inside the archive, and scans the
archive for personal paths, e-mail addresses and secret-like values.
