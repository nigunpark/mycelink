# Security policy

## Supported versions

| Version | Supported |
|---|---|
| 0.2.x (beta) | Yes — security fixes are released as new patch or beta versions |
| < 0.2 | No |

## Reporting a vulnerability

**Please do not report security vulnerabilities in public issues, pull
requests or discussions.**

Report them privately through GitHub's private vulnerability reporting:

1. Open
   [github.com/nigunpark/mycelink/security/advisories/new](https://github.com/nigunpark/mycelink/security/advisories/new)
   (the repository's **Security** tab → **Report a vulnerability**, GitHub
   Security Advisories).
3. Describe the issue, affected versions, and a minimal reproduction. Please
   do not include real credentials or private repository content; redact
   them, or describe their shape instead.

There is deliberately no security e-mail address. If private vulnerability
reporting is not yet enabled on the repository you are looking at, open a
[public issue](https://github.com/nigunpark/mycelink/issues/new/choose) that says only "please enable private vulnerability reporting"
— without any details — and a maintainer will enable it and follow up.

## What to expect

- Acknowledgement of a report within 7 days.
- An initial assessment (accepted, needs more information, or declined with a
  reason) within 14 days.
- Coordinated disclosure: we agree a disclosure date with the reporter, ship a
  fix, then publish a GitHub Security Advisory crediting the reporter unless
  they prefer otherwise.

These are goals of a volunteer-run project, not contractual guarantees.

## Scope

In scope:

- the `mycelink` controller and runtime bundle (`dist/mycelink.mjs`),
- the project hooks it installs,
- the Claude Code plugin components (commands, skills, agents) in this
  repository,
- release packaging (archive contents, checksum, SBOM).

Out of scope:

- vulnerabilities in Claude Code itself (report those to Anthropic),
- vulnerabilities in your own repositories' build or test commands that
  Mycelink runs on your behalf,
- deployments that set `allow_shell_commands: true` and then run untrusted
  graphs — that configuration explicitly trusts every graph author with
  arbitrary command execution (see `docs/PERMISSION_MODEL.md`).

## Security model

See `docs/THREAT_MODEL.md`, `docs/PERMISSION_MODEL.md` and
`docs/DATA_HANDLING.md`.
