# shellcheck shell=bash
set -euo pipefail
read -r request_uptime _ </proc/uptime

export XDG_RUNTIME_DIR="/run/user/$EUID"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
if [[ ! -S $XDG_RUNTIME_DIR/bus ]]; then
  echo 'Error: a running systemd user manager is required for this account' >&2
  exit 1
fi
endpoint() {
  @endpoint@
}

ref=${SSH_ORIGINAL_COMMAND:-}
command=
# Only split the reference boundary; the Guest shell interprets the command.
if [[ $ref =~ ^([^[:space:]]+)[[:space:]]+(.*)$ ]]; then
  ref=${BASH_REMATCH[1]}
  command=${BASH_REMATCH[2]}
fi
if (($# != 0)) || [[ $ref == -* || $ref == *[[:space:]]* ]]; then
  echo 'Usage: ssh [-t] drv.run <flake-reference> [<command>]' >&2
  exit 2
fi
if [[ -z $ref ]]; then
  # Durable state identifies retained instances; systemd supplies their live state.
  state=$(systemd-path user-state-private)
  for instance in "$state"/drv.run/*; do
    id=${instance##*/}
    if [[ $id =~ ^[[:alnum:]]+$ && -f $instance/reference ]]; then
      IFS= read -r reference <"$instance/reference"
      # Query exact names: stopped instances may have been unloaded by systemd.
      unit_state=$(systemctl --user show "drv.run@$id.service" -p ActiveState,SubState,Result)
      declare -A properties=()
      while IFS='=' read -r property value; do
        properties[$property]=$value
      done <<<"$unit_state"
      printf 'drv.run.%s %s: %s' "$id" "$reference" "${properties[SubState]}"
      if [[ ${properties[ActiveState]} == failed ]]; then
        printf ' (%s)' "${properties[Result]}"
      fi
      endpoint "$id"
      printf '\n'
    fi
  done
  exit 0
fi
if [[ ! -r /dev/kvm || ! -w /dev/kvm ]]; then
  echo 'Error: read/write access to /dev/kvm is required' >&2
  exit 1
fi

umask 077
state=$(systemd-path user-state-private)
mkdir -p "$state/drv.run"
while :; do
  id=$(shuf --random-source=/dev/urandom -i 1-4294967295 -n 1)
  instance="$state/drv.run/$id"
  # Reserve durable state too: stopped instances retain their identity and keys.
  if mkdir "$instance"; then
    runtime="$XDG_RUNTIME_DIR/drv.run.$id"
    if mkdir "$runtime"; then
      break
    fi
    rmdir "$instance"
    [[ -e $runtime ]] || exit 1
  elif [[ ! -e $instance ]]; then
    exit 1
  fi
done
unit="drv.run@$id.service"
submitted=false
cleanup() {
  if [[ $submitted == false ]]; then
    rm -rf "$runtime"
    rmdir "$instance"
  fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
timing_directory=$runtime
@timing@
phase request-received "$request_uptime"
printf '%s\n' "$ref" >"$runtime/reference"
printf 'Starting %s...\n' "$unit" >&2
submitted=true
status=0
systemctl --user start "$unit" </dev/null || status=$?
if ((status != 0)); then
  journalctl --user -u "$unit" -n 80 --no-pager >&2 || true
  printf 'Full log: journalctl --user -u %s --no-pager\n' "$unit" >&2
  exit "$status"
fi
printf '%s' "${runtime##*/}" >&2
endpoint "$id" >&2
printf '\n' >&2
exec ssh -- "${runtime##*/}" "$command"
