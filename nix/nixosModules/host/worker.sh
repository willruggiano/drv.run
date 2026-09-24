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
  nix print-dev-env --option accept-flake-config false --print-build-logs --json \
    --profile "$STATE_DIRECTORY/environment" -- "$ref" </dev/null >/dev/null
  nix-store --realise @runner@ --add-root "$STATE_DIRECTORY/runner" --indirect >/dev/null
  ssh-keygen -q -t ed25519 -N '' -f "$STATE_DIRECTORY/host-key"
  chmod 0600 "$STATE_DIRECTORY/host-key"
  (
    cd "$STATE_DIRECTORY"
    test ! -e state.img
    @create-volumes@
  )
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
cat >"$RUNTIME_DIRECTORY/service-connection.conf" <<EOF
ProxyCommand @nc@ -U $RUNTIME_DIRECTORY/ssh.sock
IdentityFile $RUNTIME_DIRECTORY/client-key
UserKnownHostsFile $RUNTIME_DIRECTORY/known_hosts
EOF
