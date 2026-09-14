# shellcheck shell=bash
set -euo pipefail

export XDG_RUNTIME_DIR="/run/user/$EUID"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
if [[ ! -S $XDG_RUNTIME_DIR/bus ]]; then
	echo 'Error: a running systemd user manager is required for this account' >&2
	exit 1
fi
ref=${SSH_ORIGINAL_COMMAND:-}
if [[ -z $ref ]]; then
	inventory=$(systemctl --user list-units --type=service --state=active \
		--plain --no-legend --no-pager 'drv.run@*.service')
	while read -r unit _; do
		if [[ $unit =~ ^drv\.run@([[:alnum:]]+)\.service$ ]]; then
			printf 'drv.run.%s\n' "${BASH_REMATCH[1]}"
		fi
	done <<<"$inventory"
	exit 0
fi
if [[ $ref == -* || $ref == *[[:space:]]* ]]; then
	echo 'Usage: ssh -t drv.run <flake-reference> (one reference, not a shell command)' >&2
	exit 2
fi
if [[ ! -r /dev/kvm || ! -w /dev/kvm ]]; then
	echo 'Error: read/write access to /dev/kvm is required' >&2
	exit 1
fi

umask 077
runtime=$(mktemp -d "$XDG_RUNTIME_DIR/drv.run.XXXXXXXXXX")
unit="drv.run@${runtime##*.}.service"
submitted=false
cleanup() {
	if [[ $submitted == false ]]; then
		rm -rf "$runtime"
	fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
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
printf '%s\n' "${runtime##*/}" >&2
exec ssh "${runtime##*/}"
