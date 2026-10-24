# shellcheck shell=bash
set -euo pipefail

name=${RUNTIME_DIRECTORY##*/}
timing_directory="$RUNTIME_DIRECTORY"
@timing@
phase boot-ready
# Only control traffic crosses SSH. Registration and rooting completed before
# guest sysinit.target. On failure systemd kills the service cgroup.
until ssh -F @service-ssh@ -fMN "$name" </dev/null; do
  # ExecStartPost can outlive the main process; let failure trigger cleanup.
  kill -0 "${MAINPID:?systemd main process is unavailable}"
  sleep 1
done
phase acknowledgement-start
environment=$(readlink -e "$STATE_DIRECTORY/environment")
printf '%s\n' "$environment" | ssh -F @service-ssh@ "$name" root-environment
ssh -F @service-ssh@ "$name" environment-timings >"$RUNTIME_DIRECTORY/guest-timings.jsonl"
ssh -F @service-ssh@ -O exit "$name" </dev/null
printf 'Provisioned the environment.\n'
cp "$RUNTIME_DIRECTORY/service-connection.conf" "$RUNTIME_DIRECTORY/.client.conf"
mv "$RUNTIME_DIRECTORY/.client.conf" "$RUNTIME_DIRECTORY/client.conf"
phase client-ready
