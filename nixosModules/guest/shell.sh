# shellcheck shell=bash
set -euo pipefail

# A login shell, not an SSH command dispatcher: preserve -c and its argument
# exactly. Internal SSH subsystems bypass the shell, as on an ordinary server.
profile=/nix/var/nix/profiles/project
test -f /run/drv-run-environment/ready
test -L "$profile"
if (($# == 0)); then
  cd /workspace
  exec nix develop -- "$profile"
fi
# Keep shellHook chatter and reads off the command's protocol stream. Nix
# preserves inherited FDs across develop's exec (src/nix/run.cc).
exec nix develop "$profile" --command @bash@ -c \
  'exec @bash@ "$@" <&3 >&4 3<&- 4>&-' -- "$@" \
  3<&0 4>&1 </dev/null >&2
