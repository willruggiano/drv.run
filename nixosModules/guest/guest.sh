# shellcheck shell=bash
set -euo pipefail

profile=/nix/var/nix/profiles/project

case ${SSH_ORIGINAL_COMMAND:-} in
'nix-daemon --stdio')
  exec nix-daemon --stdio
  ;;
root-environment)
  IFS= read -r environment
  if [[ $environment != /nix/store/*-env || $environment == *[[:space:]]* ]]; then
    echo 'Error: invalid prepared environment path' >&2
    exit 1
  fi
  exec nix print-dev-env --json --profile "$profile" -- "$environment" >/dev/null
  ;;
esac

if [[ ! -L $profile ]]; then
  echo 'Error: a prepared environment is required' >&2
  exit 1
fi
cd /workspace
if [[ -f /run/drv-run-seed/mitm-proxy/placeholder ]]; then
  GH_TOKEN=$(</run/drv-run-seed/mitm-proxy/placeholder)
  export GH_TOKEN
fi
if [[ -z ${SSH_ORIGINAL_COMMAND:-} ]]; then
  exec nix develop -- "$profile"
fi
exec nix develop "$profile" --command @bash@ -c "$SSH_ORIGINAL_COMMAND"
