#!/usr/bin/env bash
# Scaffold for the "existing-refunds-cold" eval case. Authored by the Mycelink
# maintainers.
#
# Builds the Ledgerline workspace for scenario "existing-cold" in the current
# (empty) run directory: a platform/ coordination repo, four module repos under
# repos/, and QA's acceptance suite. Uses only Node.js built-ins and git: no
# network, no package installs, and nothing written outside the run directory
# except a throwaway empty git config file in the OS temp directory.
set -euo pipefail
command -v node >/dev/null 2>&1 || { echo "scaffold: node is not on PATH" >&2; exit 127; }
command -v git >/dev/null 2>&1 || { echo "scaffold: git is not on PATH" >&2; exit 127; }
# The harness passes this script as a native path; normalise backslashes.
script="${0//\\//}"
case "$script" in
  */*) here="${script%/*}" ;;
  *) here=. ;;
esac
# Git Bash: hand Node a native path even when invoked as /c/...
if command -v cygpath >/dev/null 2>&1; then here="$(cygpath -m "$here")"; fi
exec node "$here/../_lib/scaffold.mjs" existing-cold .
