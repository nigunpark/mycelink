#!/usr/bin/env bash
# Disposable WSL-only security spike; never run a Codex worker on the Windows shim.
set -euo pipefail
scratch=$(mktemp -d /tmp/mycelink-codex-wsl-XXXXXX)
trap 'rm -rf "$scratch"' EXIT
printf 'scratch_filesystem='; stat -f -c %T "$scratch"
printf 'linux_codex_install='; npm install --prefix "$scratch" --no-save --ignore-scripts @openai/codex@0.163.0 --silent >/dev/null && "$scratch/node_modules/.bin/codex" --version
printf 'linux_auth='; if test -f "$HOME/.codex/auth.json"; then echo PRESENT; else echo ABSENT; fi
printf 'sandboxed_linux_codex='; bwrap --die-with-parent --unshare-all --new-session \
  --ro-bind /usr /usr --ro-bind /bin /bin --ro-bind /lib /lib \
  --ro-bind /lib64 /lib64 --ro-bind /etc /etc --proc /proc --dev /dev \
  --tmpfs /tmp --dir /home --dir /opt --ro-bind "$scratch/node_modules" /opt/node_modules \
  --clearenv --setenv PATH /usr/local/bin:/usr/bin:/bin --setenv HOME /home \
  --chdir / -- /usr/local/bin/node /opt/node_modules/@openai/codex/bin/codex.js --version
mkdir -p "$scratch/worktree/allowed" "$scratch/protected"
printf 'sandboxed_codex_exec='; set +e
timeout 12s bwrap --die-with-parent --unshare-all --new-session \
  --ro-bind /usr /usr --ro-bind /bin /bin --ro-bind /lib /lib \
  --ro-bind /lib64 /lib64 --ro-bind /etc /etc --proc /proc --dev /dev \
  --tmpfs /tmp --tmpfs /home --dir /home/.codex --dir /opt --dir /worktree \
  --ro-bind "$scratch/node_modules" /opt/node_modules \
  --ro-bind "$scratch/worktree" /worktree \
  --clearenv --setenv PATH /usr/local/bin:/usr/bin:/bin --setenv HOME /home \
  --setenv CODEX_HOME /home/.codex --chdir /worktree \
  -- /usr/local/bin/node /opt/node_modules/@openai/codex/bin/codex.js \
     exec --ignore-user-config --ephemeral --skip-git-repo-check --json \
     --cd /worktree --sandbox read-only -c approval_policy=never - \
     >"$scratch/codex.stdout" 2>"$scratch/codex.stderr" <<<'Print the word OK.'
exec_status=$?
set -e
printf '%s\n' "$exec_status"
printf 'sandboxed_codex_events='; node -e 'const fs=require("fs"); const s=fs.readFileSync(process.argv[1],"utf8"); console.log(s.split("\n").filter(Boolean).map(l=>{try{return JSON.parse(l).type}catch{return "non-json"}}).join(","))' "$scratch/codex.stdout"
printf 'sandboxed_codex_failure='; node -e 'const fs=require("fs"); const s=fs.readFileSync(process.argv[1],"utf8"); console.log(s.includes("failed to lookup address information") ? "API_DNS_UNREACHABLE" : s.includes("CODEX_HOME") ? "CODEX_HOME_ERROR" : "OTHER")' "$scratch/codex.stderr"
printf 'ORIGINAL\n' > "$scratch/protected/result.txt"
printf 'ORIGINAL\n' > "$scratch/worktree/allowed/normal.txt"
ln "$scratch/protected/result.txt" "$scratch/worktree/allowed/alias.txt"
cat > "$scratch/attack.sh" <<'ATTACK'
#!/bin/sh
set +e
printf 'ATTACK\n' > /worktree/allowed/alias.txt
printf 'ALLOWED\n' > /worktree/allowed/normal.txt
printf 'DIRECT\n' > /protected/result.txt
printf 'HOST\n' > /mnt/c/Users/psh09/mycelink-wsl-escape.txt
printf 'NETWORK\n' > /tmp/marker
curl -sS -I --max-time 3 https://api.openai.com >/tmp/network.out 2>/tmp/network.err
printf 'network_status=%s\n' "$?"
if test -e /init; then echo 'interop=VISIBLE'; else echo 'interop=HIDDEN'; fi
if test -e /mnt/c/Windows; then echo 'windows_drive=VISIBLE'; else echo 'windows_drive=HIDDEN'; fi
ATTACK
bwrap --die-with-parent --unshare-all --new-session \
  --ro-bind /usr /usr --ro-bind /bin /bin --ro-bind /lib /lib \
  --ro-bind /lib64 /lib64 --ro-bind /etc /etc --proc /proc --dev /dev \
  --tmpfs /tmp --dir /home --dir /mnt --dir /worktree \
  --ro-bind "$scratch/worktree" /worktree \
  --bind "$scratch/worktree/allowed" /worktree/allowed \
  --ro-bind "$scratch/attack.sh" /attack.sh \
  --clearenv --setenv PATH /usr/bin:/bin --setenv HOME /home \
  --chdir /worktree -- /bin/sh /attack.sh 2>&1
printf 'protected_result='; cat "$scratch/protected/result.txt"
printf 'allowed_result='; cat "$scratch/worktree/allowed/normal.txt"
printf 'host_escape='; if test -e /mnt/c/Users/psh09/mycelink-wsl-escape.txt; then echo EXISTS; else echo ABSENT; fi
printf 'ORIGINAL\n' > "$scratch/protected/result.txt"
printf 'ORIGINAL\n' > "$scratch/worktree/allowed/normal.txt"
printf 'safe_overlay_probe='; bwrap --die-with-parent --unshare-all --new-session \
  --ro-bind /usr /usr --ro-bind /bin /bin --ro-bind /lib /lib \
  --ro-bind /lib64 /lib64 --ro-bind /etc /etc --proc /proc --dev /dev \
  --tmpfs /tmp --dir /home --dir /mnt --dir /worktree \
  --ro-bind "$scratch/worktree" /worktree \
  --tmpfs /worktree/allowed --ro-bind "$scratch/attack.sh" /attack.sh \
  --clearenv --setenv PATH /usr/bin:/bin --setenv HOME /home \
  --chdir /worktree -- /bin/sh /attack.sh 2>&1 | tr '\n' ';'
printf '\n'
printf 'safe_overlay_protected='; cat "$scratch/protected/result.txt"
printf 'safe_overlay_persisted='; cat "$scratch/worktree/allowed/normal.txt"
printf 'shared_network_unrelated_egress='; set +e
bwrap --die-with-parent --unshare-all --share-net --new-session \
  --ro-bind /usr /usr --ro-bind /bin /bin --ro-bind /lib /lib \
  --ro-bind /lib64 /lib64 --ro-bind /etc /etc --dir /mnt --dir /mnt/wsl --ro-bind /etc/resolv.conf /mnt/wsl/resolv.conf \
  --proc /proc --dev /dev --tmpfs /tmp --dir /home \
  --clearenv --setenv PATH /usr/bin:/bin --chdir / \
  -- /usr/bin/curl -sSI --max-time 5 https://example.com >"$scratch/shared-network.stdout" 2>"$scratch/shared-network.stderr"
network_status=$?
set -e
printf '%s\n' "$network_status"
printf 'shared_network_http_status='; node -e 'const s=require("fs").readFileSync(process.argv[1],"utf8"); console.log(s.match(/HTTP\/[^\r\n]+/g)?.slice(-1)[0] || "NO_HTTP_RESPONSE")' "$scratch/shared-network.stdout"
printf 'shared_network_error='; node -e 'const s=require("fs").readFileSync(process.argv[1],"utf8"); console.log(s.split("\n").filter(Boolean).slice(-1)[0]?.slice(0,160) || "<none>")' "$scratch/shared-network.stderr"
