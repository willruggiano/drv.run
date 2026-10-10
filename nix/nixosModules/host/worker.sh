# shellcheck shell=bash
set -euo pipefail

if [[ ! -r /dev/kvm || ! -w /dev/kvm ]]; then
  echo 'Error: the user service manager needs read/write access to /dev/kvm' >&2
  exit 1
fi
if [[ $STATE_DIRECTORY == *:* ]]; then
  echo 'Error: exactly one StateDirectory per Instance is required' >&2
  exit 1
fi
name=${RUNTIME_DIRECTORY##*/}
id=${name#drv.run.}
if [[ ! $id =~ ^[[:alnum:]]+$ || ${STATE_DIRECTORY##*/} != "$id" ]]; then
  echo 'Error: invalid Instance identity' >&2
  exit 2
fi

if [[ ! -d $STATE_DIRECTORY/ready ]]; then
  if [[ ! -f $RUNTIME_DIRECTORY/reference ]]; then
    echo 'Error: Instance state is missing; create new Instances through drv.run' >&2
    exit 1
  fi
  IFS= read -r ref <"$RUNTIME_DIRECTORY/reference"
  if [[ -z $ref || $ref == -* || $ref == *[[:space:]]* ]]; then
    echo 'Error: invalid flake reference' >&2
    exit 2
  fi
  # An interrupted creation must be explicitly cleaned, never resumed or reformatted.
  mkdir "$STATE_DIRECTORY/creating"
  printf '%s\n' "$ref" >"$STATE_DIRECTORY/reference"
  # Evaluate the Flake closure while creating independent Instance resources.
  # systemd owns all ExecStartPre children, including on failure or interruption.
  nix print-dev-env --option accept-flake-config false --print-build-logs --json \
    --profile "$STATE_DIRECTORY/environment" -- "$ref" </dev/null >/dev/null &
  environment_pid=$!
  nix-store --realise @runner@ --add-root "$STATE_DIRECTORY/runner" --indirect >/dev/null
  ssh-keygen -q -t ed25519 -N '' -f "$STATE_DIRECTORY/host-key"
  chmod 0600 "$STATE_DIRECTORY/host-key"
  (
    cd "$STATE_DIRECTORY"
    test ! -e state.img
    @create-volumes@
  )
  wait "$environment_pid"
  mv "$STATE_DIRECTORY/creating" "$STATE_DIRECTORY/ready"
elif [[ -e $RUNTIME_DIRECTORY/reference ]]; then
  echo 'Error: Instance identity already exists' >&2
  exit 1
fi

# Neither the worker nor the pinned runner may recreate a lost established disk.
test -f "$STATE_DIRECTORY/state.img"
test ! -L "$STATE_DIRECTORY/state.img"
test -f "$STATE_DIRECTORY/reference"
test -x "$STATE_DIRECTORY/runner/bin/microvm-run"
readlink -e "$STATE_DIRECTORY/environment" >"$RUNTIME_DIRECTORY/environment-path"
ln -s "$STATE_DIRECTORY/state.img" "$RUNTIME_DIRECTORY/state.img"
ln -s "$STATE_DIRECTORY/host-key" "$RUNTIME_DIRECTORY/host-key"
ssh-keygen -q -t ed25519 -N '' -f "$RUNTIME_DIRECTORY/client-key"
chmod 0600 "$RUNTIME_DIRECTORY/client-key"
cp "$RUNTIME_DIRECTORY/client-key.pub" "$RUNTIME_DIRECTORY/authorized-keys"
printf '%s %s\n' "$name" "$(ssh-keygen -y -f "$STATE_DIRECTORY/host-key")" \
  >"$RUNTIME_DIRECTORY/known_hosts"
staging=$(mktemp -d "$RUNTIME_DIRECTORY/seed.XXXXXXXX")
trap 'rm -rf "$staging"' EXIT
cp "$RUNTIME_DIRECTORY/authorized-keys" "$staging/authorized-keys"
cp "$STATE_DIRECTORY/host-key" "$staging/host-key"
cp "$RUNTIME_DIRECTORY/environment-path" "$staging/environment-path"
chmod 0600 "$staging/"*
truncate -s 8M "$RUNTIME_DIRECTORY/seed.img"
mke2fs -q -t ext4 -L drv-run-seed -E root_owner=0:0,root_perms=0700 \
  -d "$staging" "$RUNTIME_DIRECTORY/seed.img"
e2fsck -fn "$RUNTIME_DIRECTORY/seed.img"
cat >"$RUNTIME_DIRECTORY/service-connection.conf" <<EOF
ProxyCommand @proxy@ vsock-mux$RUNTIME_DIRECTORY/notify.vsock %p
ProxyUseFdpass yes
IdentityFile $RUNTIME_DIRECTORY/client-key
UserKnownHostsFile $RUNTIME_DIRECTORY/known_hosts
EOF
