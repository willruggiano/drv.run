# shellcheck shell=bash
set -euo pipefail

case ${SSH_ORIGINAL_COMMAND:-} in
'nix-daemon --stdio')
  exec nix-daemon --stdio
  ;;
root-environment)
  IFS= read -r environment </run/credentials/sshd.service/environment-path
  if [[ $environment != /nix/store/*-env || $environment == *[[:space:]]* ]]; then
    echo 'Error: invalid prepared environment path' >&2
    exit 1
  fi
  nix print-dev-env --json -- "$environment" >/dev/null
  nix-store --realise --add-root /run/environment --indirect "$environment" >/dev/null
  ;;
'')
  if [[ ! -L /run/environment ]]; then
    echo 'Error: a prepared environment is required' >&2
    exit 1
  fi
  cd /workspace
  exec nix develop -- /run/environment
  ;;
*)
  echo 'Error: unsupported guest protocol command' >&2
  exit 2
  ;;
esac
