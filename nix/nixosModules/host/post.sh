# shellcheck shell=bash
set -euo pipefail

name=${RUNTIME_DIRECTORY##*/}
export NIX_SSHOPTS='-F @service-ssh@'
# Establish the master before Nix starts: Nix's SSH handshake distinguishes
# preexisting masters from fresh connections. On failure systemd kills the
# service cgroup; on success we close the master before publishing client.conf.
until ssh -F @service-ssh@ -fMN "$name" </dev/null; do
  # ExecStartPost can outlive the main process; let failure trigger cleanup.
  kill -0 "${MAINPID:?systemd main process is unavailable}"
  sleep 1
done
printf 'Copying the prepared closure into the guest...\n'
IFS= read -r environment <"$RUNTIME_DIRECTORY/environment-path"
# Use our master rather than asking Nix to start another connection pool.
nix copy --no-check-sigs --to "ssh-ng://$name?max-connections=1" "$environment"
ssh -F @service-ssh@ "$name" root-environment </dev/null
ssh -F @service-ssh@ -O exit "$name" </dev/null
printf 'Provisioned the environment.\n'
cp "$RUNTIME_DIRECTORY/service-connection.conf" "$RUNTIME_DIRECTORY/.client.conf"
mv "$RUNTIME_DIRECTORY/.client.conf" "$RUNTIME_DIRECTORY/client.conf"
