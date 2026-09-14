# shellcheck shell=bash
set -euo pipefail

if [[ ! -r /dev/kvm || ! -w /dev/kvm ]]; then
	echo 'Error: the user service manager needs read/write access to /dev/kvm' >&2
	exit 1
fi
if [[ $CACHE_DIRECTORY == *:* ]]; then
	echo 'Error: exactly one CacheDirectory per instance is required' >&2
	exit 1
fi
IFS= read -r ref <"$RUNTIME_DIRECTORY/reference"
if [[ -z $ref || $ref == -* || $ref == *[[:space:]]* ]]; then
	echo 'Error: invalid flake reference' >&2
	exit 2
fi
printf 'Preparing the environment on the SSH host...\n'
nix print-dev-env --option accept-flake-config false --print-build-logs --json \
	--profile "$RUNTIME_DIRECTORY/environment" -- "$ref" </dev/null >/dev/null
readlink -f "$RUNTIME_DIRECTORY/environment" >"$RUNTIME_DIRECTORY/environment-path"

ln -s "$CACHE_DIRECTORY/root.img" "$RUNTIME_DIRECTORY/root.img"
ssh-keygen -q -t ed25519 -N '' -f "$RUNTIME_DIRECTORY/client-key"
ssh-keygen -q -t ed25519 -N '' -f "$RUNTIME_DIRECTORY/host-key"
chmod 0600 "$RUNTIME_DIRECTORY/client-key" "$RUNTIME_DIRECTORY/host-key"
cp "$RUNTIME_DIRECTORY/client-key.pub" "$RUNTIME_DIRECTORY/authorized-keys"
printf '%s %s\n' "${RUNTIME_DIRECTORY##*/}" "$(ssh-keygen -y -f "$RUNTIME_DIRECTORY/host-key")" \
	>"$RUNTIME_DIRECTORY/known_hosts"
cat >"$RUNTIME_DIRECTORY/service-connection.conf" <<EOF
ProxyCommand @nc@ -U $RUNTIME_DIRECTORY/ssh.sock
IdentityFile $RUNTIME_DIRECTORY/client-key
UserKnownHostsFile $RUNTIME_DIRECTORY/known_hosts
EOF
printf 'Starting the project VM...\n'
