# Getting help

Mycelink is a volunteer-maintained open-source project. There is no paid
support and no service-level commitment.

## Where to ask

| You want to… | Go to |
|---|---|
| report a reproducible bug | a [GitHub issue](https://github.com/nigunpark/mycelink/issues/new/choose) using the **Bug report** template |
| report an incompatibility with an OS, Node.js or Claude Code version | a [GitHub issue](https://github.com/nigunpark/mycelink/issues/new/choose) using the **Compatibility** template |
| propose a feature or adapter | a [GitHub issue](https://github.com/nigunpark/mycelink/issues/new/choose) using the **Feature request** template |
| report a security vulnerability | **not an issue** — [report it privately](https://github.com/nigunpark/mycelink/security/advisories/new); see [SECURITY.md](SECURITY.md) |
| ask a usage question | [GitHub Discussions](https://github.com/nigunpark/mycelink/discussions), if enabled on the repository; otherwise an [issue](https://github.com/nigunpark/mycelink/issues) labelled `question` |

## Before you ask

1. Read the [README](README.md), especially **Troubleshooting** and
   **Limitations**.
2. Run `node <plugin>/bin/mycelink.mjs doctor --json` and include the output.
3. Include your OS, `node --version`, `git --version` and `claude --version`.
4. Remove secrets, private paths and private repository names from anything
   you paste. Never paste evidence logs without reading them first.

## Not covered

Mycelink drives Claude Code but is not part of it. Questions about Claude Code
itself, model behaviour, accounts or billing belong with Anthropic's own
support channels. Mycelink is not affiliated with or endorsed by Anthropic.
