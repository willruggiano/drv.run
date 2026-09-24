# shellcheck shell=bash
set -euo pipefail

name=${RUNTIME_DIRECTORY##*/}
export NIX_SSHOPTS='-F @service-ssh@'
until nix store info --store "ssh-ng://$name"; do
  # ExecStartPost can outlive the main process; let failure trigger cleanup.
  kill -0 "${MAINPID:?systemd main process is unavailable}"
  sleep 1
done
printf 'Copying the prepared closure into the guest...\n'
IFS= read -r environment <"$RUNTIME_DIRECTORY/environment-path"
nix copy --no-check-sigs --to "ssh-ng://$name" "$environment"
ssh -F @service-ssh@ "$name" root-environment </dev/null
printf 'Provisioned the environment.\n'
cp "$RUNTIME_DIRECTORY/service-connection.conf" "$RUNTIME_DIRECTORY/.client.conf"
mv "$RUNTIME_DIRECTORY/.client.conf" "$RUNTIME_DIRECTORY/client.conf"
