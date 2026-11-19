# shellcheck shell=bash
set -euo pipefail

timing_directory="$RUNTIME_DIRECTORY"
@timing@
phase preparation-start

if [[ ! -r /dev/kvm || ! -w /dev/kvm ]]; then
  echo 'Error: the user service manager needs read/write access to /dev/kvm' >&2
  exit 1
fi
if [[ $STATE_DIRECTORY == *:* ]]; then
  echo 'Error: exactly one StateDirectory per Instance is required' >&2
  exit 1
fi
id=${RUNTIME_DIRECTORY##*/}
name=drv.run.$id
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
  # The preparation unit owns all children, including on failure or interruption.
  (
    phase environment-start
    nix print-dev-env --option accept-flake-config false --print-build-logs --json \
      --profile "$STATE_DIRECTORY/environment" -- "$ref" </dev/null >/dev/null
    phase environment-ready
  ) &
  environment_pid=$!
  nix-store --realise @runner@ --add-root "$STATE_DIRECTORY/runner" --indirect >/dev/null &
  runner_pid=$!
  ssh-keygen -q -t ed25519 -N '' -f "$STATE_DIRECTORY/host-key"
  chmod 0600 "$STATE_DIRECTORY/host-key"
  (
    cd "$STATE_DIRECTORY"
    test ! -e state.img
    @create-volumes@
  )
  wait "$environment_pid"
  environment=$(readlink -e "$STATE_DIRECTORY/environment")
  test ! -e "$STATE_DIRECTORY/environment-image"
  test ! -L "$STATE_DIRECTORY/environment-image"
  phase image-start
  nix build --impure --file @image-expression@ --argstr environment "$environment" \
    --out-link "$STATE_DIRECTORY/environment-image" </dev/null
  phase image-ready
  wait "$runner_pid"
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
test -e "$STATE_DIRECTORY/environment"
test -L "$STATE_DIRECTORY/environment-image"
test -f "$STATE_DIRECTORY/environment-image/store.erofs"
ln -s "$STATE_DIRECTORY/environment-image/store.erofs" "$RUNTIME_DIRECTORY/environment.erofs"
ln -s "$STATE_DIRECTORY/state.img" "$RUNTIME_DIRECTORY/state.img"
ln -s image/seed.img "$RUNTIME_DIRECTORY/seed.img"
ssh-keygen -q -t ed25519 -N '' -f "$RUNTIME_DIRECTORY/client-key"
chmod 0600 "$RUNTIME_DIRECTORY/client-key"
printf '%s %s\n' "$name" "$(ssh-keygen -y -f "$STATE_DIRECTORY/host-key")" \
  >"$RUNTIME_DIRECTORY/known_hosts"
cat >"$RUNTIME_DIRECTORY/.client.conf" <<EOF
Host $name
    ProxyCommand @proxy@ vsock-mux$RUNTIME_DIRECTORY/notify.vsock %p
    IdentityFile $RUNTIME_DIRECTORY/client-key
    UserKnownHostsFile $RUNTIME_DIRECTORY/known_hosts
EOF
mv "$RUNTIME_DIRECTORY/.client.conf" "$RUNTIME_DIRECTORY/client.conf"
