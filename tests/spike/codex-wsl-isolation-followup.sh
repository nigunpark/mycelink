#!/usr/bin/env bash
# Standalone negative/positive boundary probe; NOT a production Codex launcher.
set -euo pipefail
scratch=$(mktemp -d /tmp/mycelink-isolation-followup-XXXXXX)
trap 'rm -rf "$scratch"' EXIT
mkdir -p "$scratch/source/allowed" "$scratch/protected"
printf 'ORIGINAL\n' > "$scratch/protected/result"
ln "$scratch/protected/result" "$scratch/source/allowed/alias"
printf 'SOURCE\n' > "$scratch/source/allowed/normal"
printf 'source_fs='; stat -f -c %T "$scratch/source"
printf 'alias_inode='; stat -c %i "$scratch/source/allowed/alias"
printf 'protected_inode='; stat -c %i "$scratch/protected/result"
# The only host input is a read-only source tree; worker scratch is anonymous tmpfs.
# Open FD9 to a protected file in the launcher to test descriptor inheritance.
# Invoke with `closed` to explicitly close inherited FDs before execing bwrap.
# Do not bind /mnt/c, /run, WSL /init, host /proc, or auth into this namespace.
mode=${1:-inherited}
if [[ $mode == closed ]]; then
  launcher=(python3 -c 'import os,sys; os.closerange(3, 1024); os.execvp(sys.argv[1], sys.argv[1:])' bwrap)
elif [[ $mode == inherited ]]; then
  launcher=(bwrap)
else
  echo 'mode must be closed or inherited' >&2; exit 2
fi
set +e
"${launcher[@]}" --die-with-parent --unshare-all --new-session \
  --ro-bind /usr /usr --ro-bind /bin /bin --ro-bind /lib /lib \
  --ro-bind /lib64 /lib64 --ro-bind /etc /etc \
  --proc /proc --dev /dev --tmpfs /tmp --dir /worktree \
  --ro-bind "$scratch/source" /worktree --tmpfs /proposal \
  --clearenv --setenv PATH /usr/bin:/bin --setenv HOME /tmp \
  --chdir /worktree -- /bin/sh -c '
    printf "namespace_pid1="; cat /proc/1/comm
    printf "windows_drive_visibility="; test -e /mnt/c/Windows && echo VISIBLE || echo HIDDEN
    printf "wsl_interop_visibility="; test -e /init && echo VISIBLE || echo HIDDEN
    printf "fd9_visibility="; test -e /proc/self/fd/9 && echo VISIBLE || echo HIDDEN
    printf "fd9_write="; (printf ATTACK >&9) 2>/dev/null; echo $?
    printf "alias_write="; (printf ATTACK > /worktree/allowed/alias) 2>/dev/null; echo $?
    printf "normal_write="; (printf ATTACK > /worktree/allowed/normal) 2>/dev/null; echo $?
    printf "direct_write="; (printf ATTACK > /protected/result) 2>/dev/null; echo $?
    printf "proposal_write="; (printf PROPOSAL > /proposal/change) 2>/dev/null; echo $?
    printf "network_status="; curl -sSI --max-time 2 https://example.com >/dev/null 2>&1; echo $?
    printf "spoofed_review=approved\n"
  ' 9>"$scratch/protected/fd-target" >"$scratch/worker.stdout" 2>"$scratch/worker.stderr"
worker_status=$?
set -e
printf 'worker_exit=%s\n' "$worker_status"
printf 'worker_observations_BEGIN\n'; cat "$scratch/worker.stdout"; printf 'worker_observations_END\n'
printf 'worker_stderr='; tr '\n' ' ' < "$scratch/worker.stderr"; printf '\n'
printf 'protected_after='; cat "$scratch/protected/result"
printf 'source_after='; cat "$scratch/source/allowed/normal"
printf 'fd_target_size='; stat -c %s "$scratch/protected/fd-target"
printf 'proposal_persisted='; test -e "$scratch/proposal/change" && echo YES || echo NO
# This is a launcher gate illustration, not a claim that production uses it.
# Both cases deny *before* payload execution; no fabricated Codex success.
for case in unavailable_broker failed_broker; do
  marker="$scratch/$case-executed"
  if [[ $case == unavailable_broker ]]; then broker="$scratch/no-such-broker"; else broker=/bin/false; fi
  if [[ ! -x $broker ]] || ! "$broker"; then
    printf '%s=DENY_BEFORE_PAYLOAD\n' "$case"
  else
    touch "$marker"
  fi
  if [[ -e $marker ]]; then printf '%s=FAIL_OPEN\n' "$case"; exit 1; fi
done
if [[ $worker_status != 0 ]] || [[ $(cat "$scratch/protected/result") != ORIGINAL ]] || \
   [[ $(cat "$scratch/source/allowed/normal") != SOURCE ]] || \
   [[ $(stat -c %s "$scratch/protected/fd-target") != 0 ]]; then
  echo "probe_assertion=FAILED_${mode}"; exit 1
fi
printf 'probe_assertion=PASS_LIMITED_SHELL_BOUNDARY_WITH_FD_CLOSURE\n'
