# Releasing

Releases are tag-driven and reproducible. The same commit always produces the
same ZIP bytes, checksum and SBOM.

## Versioning

- Semantic Versioning; pre-releases use `-beta.N` / `-rc.N`.
- The version lives in four places that must agree: `package.json`,
  `package-lock.json` (root entry), `.claude-plugin/plugin.json`, and the
  plugin entry plus `metadata.version` in `.claude-plugin/marketplace.json`.
  `npm test` checks they agree (`tests/release/metadata.test.ts`).
- The Git tag is `v<version>`, e.g. `v0.2.0-beta.1`.

## Checklist

1. Update the version in the four places above and move **Unreleased**
   entries in `CHANGELOG.md` under the new version heading.
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
   ```

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

Exactly the allowlist in `scripts/package.mjs`: plugin manifests, commands,
skills, agents, templates, schemas, public docs, the launcher, the runtime
bundle, a runtime-only `package.json`, and the license/notice/changelog/
security/support/governance files. Sources, tests, scripts, CI configuration
and development metadata are never included; `tests/release/package.test.ts`
enforces this and scans the archive for personal paths, e-mail addresses and
secret-like values.
