# Third-party provenance of the public-project benchmark

The benchmark runs agents against two public open-source projects, frozen at
one commit each. **No upstream source is committed to this repository** and
none is shipped in the Mycelink package (`scripts/package.mjs` includes only
the plugin's runtime and public files). The sources live in a local cache as
Git bundles, verified offline before every use against the identity pinned in
`projects/<id>/source.lock.json`.

The identity is the content, not the bundle: the commit, its tree, a SHA-256
digest of every file's path, mode and content, the history (shape, commit
count, a SHA-256 digest of its commit ids) and the license blobs. A bundle's
SHA-256 is recorded as advisory transport only — Git does not write
byte-identical bundles across versions (re-made from GitHub with Git 2.53,
the Changesets bundle has other bytes and the same content; the Petclinic one
is byte-identical).

| Project | Remote | Commit | Tree | Content (SHA-256, files) | History | License |
|---|---|---|---|---|---|---|
| spring-petclinic-microservices | https://github.com/spring-petclinic/spring-petclinic-microservices.git | `dc9ca15a71189bc4be6c02518d7180232c0555b7` | `331b9c634e1e411e89a42cc740f6e641e5de2340` | `fd546a2917171e4d7fc747264c457449f2538841a55836a8b5cc59eb1b1a97ee`, 200 | shallow at the commit, 1 commit | Apache-2.0 (`LICENSE`, blob `261eeb9e9f8b2b4b0d119366dda99c6fd7d35c64`) |
| changesets | https://github.com/changesets/changesets.git | `c73949ba7b3160a4aa5729223335c190de1528f8` | `e459b17ff13c4196aa635bcf1f9b84db2af32101` | `4532c260b87dc0f5efcc59c49c4f4d51a36b71b4d9112ca502b1340eedc7c632`, 340 | complete, 985 commits | MIT (`LICENSE` and `packages/cli/LICENSE`, blob `b52920f187847fd82db01a391f7d77f2a26eaec5`) |

Re-make and check a bundle from the public remote (the only step that uses
the network), then verify the cache offline:

```bash
node evals-public-projects/tools/source.mjs prepare --project changesets --online   # --replace to overwrite
node evals-public-projects/tools/source.mjs verify
```

## Notices

- The source lock records every upstream license file by blob id, and source
  verification requires those exact blobs. Every agent workspace is the
  unmodified upstream tree, so the upstream `LICENSE` files (and, for
  Petclinic, its Apache-2.0 notices in source headers) are present wherever
  the code is.
- The requirement documents (`projects/*/prds/*/requirement.md`), adapters,
  manifests and tooling in this directory are original work of the Mycelink
  project. They describe changes to the upstream projects and quote upstream
  identifiers (module, class, command and option names) only to the extent
  needed to specify those changes.
- The evaluator artifacts — hidden acceptance tests, reference solutions and
  mutants — are modifications of the upstream sources. They are kept in the
  evaluator's local store, never committed or distributed, and carry the
  upstream license of the project they modify (Apache-2.0 or MIT). Only
  content hashes and counts of them are committed (`evaluator.lock.json`,
  `qualification.json`).
- The offline toolchain caches (the Maven repository, the pnpm store,
  corepack's pnpm) hold third-party packages under their own licenses. They
  are prepared locally by `tools/cache.mjs` and are never committed; only
  their content digests are recorded, in the local `cache.lock.json`.

Spring PetClinic Microservices is © its contributors, licensed under the
Apache License 2.0. Changesets is © its contributors, licensed under the MIT
License. Neither project is affiliated with or endorses this benchmark.
