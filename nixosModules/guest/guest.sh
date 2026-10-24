# shellcheck shell=bash
set -euo pipefail

profile=/nix/var/nix/profiles/project
ready=/run/drv-run-environment/ready
test -f "$ready"

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
  test "$(<"$ready")" = "$environment"
  test "$(readlink -e "$profile")" = "$environment"
  exit 0
  ;;
environment-timings)
  exec cat /run/drv-run-environment/timings.jsonl
  ;;
esac

if [[ ! -L $profile ]]; then
  echo 'Error: a prepared environment is required' >&2
  exit 1
fi
cd /workspace
if [[ -z ${SSH_ORIGINAL_COMMAND:-} ]]; then
  exec nix develop -- "$profile"
fi
exec nix develop "$profile" --command @command@ "$SSH_ORIGINAL_COMMAND"
