# shellcheck shell=bash
set -euo pipefail

# Preserve local, unprivileged launcher use; SSH calls the launcher directly.
if ((EUID != 0)); then
  exec @launcher@ "$@"
fi

usage() {
  printf '%s\n' \
    'Usage: drv.run list [-u <user>]' \
    '       drv.run stop [-u <user>] --all|<instance>' \
    '       drv.run clean [-u <user>] --all|<instance>' \
    'Without -u, target all configured instance owners.' \
    'stop stops instances via systemd and retains their state.' \
    'clean removes instance state via systemd; instances must be stopped.'
}
fail() {
  printf 'drv.run: %s\n' "$*" >&2
  exit 1
}
invalid() {
  usage >&2
  exit 2
}

if [[ ${1:-} == --help || ${1:-} == -h ]]; then
  usage
  exit 0
fi
(($# > 0)) || invalid
action=$1
shift
[[ $action == list || $action == stop || $action == clean ]] || invalid
owners=(@owners@)
if [[ ${1:-} == -u ]]; then
  (($# >= 2)) && [[ -n $2 ]] || invalid
  selected=$2
  found=false
  for owner in "${owners[@]}"; do
    if [[ $owner == "$selected" ]]; then
      found=true
      break
    fi
  done
  [[ $found == true ]] || fail "not a configured instance owner: $selected"
  owners=("$selected")
  shift 2
fi
if [[ $action == list ]]; then
  (($# == 0)) || invalid
else
  (($# == 1)) || invalid
  target=$1
  if [[ $target != --all ]]; then
    target=${target#drv.run.}
    [[ $target =~ ^[a-zA-Z0-9]+$ ]] || invalid
  fi
fi

found=false
for owner in "${owners[@]}"; do
  if [[ $action == stop && $target == --all ]]; then
    # Include units still starting, even before they have written durable state.
    systemctl --user --machine="$owner@.host" stop 'drv.run@*.service'
    continue
  fi
  # Read user-owned inventory without root privileges. Do not interpret an
  # inherited SSH command or root's XDG paths as a request to launch a Guest.
  inventory=$(runuser --user "$owner" -- env \
    -u SSH_ORIGINAL_COMMAND -u XDG_STATE_HOME -u XDG_CONFIG_HOME \
    @launcher@)
  while read -r instance details; do
    [[ -n $instance ]] || continue
    if [[ $action == list ]]; then
      printf '%s %s %s\n' "$owner" "$instance" "$details"
    elif [[ $target == --all || $instance == "drv.run.$target" ]]; then
      unit="drv.run@${instance#drv.run.}.service"
      if [[ $action == clean ]]; then
        # Use exact names: stopped instances may be unloaded by systemd.
        systemctl --user --machine="$owner@.host" clean --what=state "$unit"
      else
        systemctl --user --machine="$owner@.host" stop "$unit"
      fi
      found=true
    fi
  done <<<"$inventory"
done
if [[ $action != list && $target != --all && $found == false ]]; then
  fail "instance not found: $target"
fi
