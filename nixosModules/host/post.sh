# shellcheck shell=bash
set -euo pipefail

name=drv.run.${RUNTIME_DIRECTORY##*/}
timing_directory="$RUNTIME_DIRECTORY"
@timing@
phase boot-ready
# Registration and rooting completed before guest sysinit.target. Keep the host
# unit activating until an authenticated SSH command verifies that environment.
environment=$(readlink -e "$STATE_DIRECTORY/environment")
phase acknowledgement-start
printf '%s\n' "$environment" | ssh -T -F @service-ssh@ "$name" \
  'read -r expected && test "$(cat /run/drv-run-environment/ready)" = "$expected" && test "$(readlink -e /nix/var/nix/profiles/project)" = "$expected" && cat /run/drv-run-environment/timings.jsonl' \
  >"$RUNTIME_DIRECTORY/guest-timings.jsonl"
phase client-ready
