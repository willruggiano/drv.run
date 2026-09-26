# shellcheck shell=bash
set -euo pipefail
umask 077
cd "$RUNTIME_DIRECTORY"
rm -f "$STATE_DIRECTORY/exit-status.json"

if [[ ! -e $STATE_DIRECTORY/initialized ]]; then
  test ! -e "$STATE_DIRECTORY/state.img"
  test ! -e "$STATE_DIRECTORY/host-key"
  nix print-dev-env --offline --json --profile "$STATE_DIRECTORY/environment" -- @shell@ >/dev/null
  truncate -s 16G "$STATE_DIRECTORY/state.img"
  mke2fs -q -t ext4 "$STATE_DIRECTORY/state.img"
  ssh-keygen -q -t ed25519 -N '' -f "$STATE_DIRECTORY/host-key"
  touch "$STATE_DIRECTORY/initialized"
fi
test -s "$STATE_DIRECTORY/state.img"
ssh-keygen -y -f "$STATE_DIRECTORY/host-key" >/dev/null
ln -s "$STATE_DIRECTORY/state.img" state.img
ssh-keygen -q -t ed25519 -N '' -f client-key
readlink -e "$STATE_DIRECTORY/environment" >environment-path
printf 'drv.run.vsock %s\n' "$(ssh-keygen -y -f "$STATE_DIRECTORY/host-key")" >known_hosts

staging=$(mktemp -d "$RUNTIME_DIRECTORY/seed.XXXXXXXX")
trap 'rm -rf "$staging"' EXIT
cp client-key.pub "$staging/authorized-keys"
cp "$STATE_DIRECTORY/host-key" "$staging/host-key"
cp environment-path "$staging/environment-path"
chmod 600 "$staging/"*
truncate -s 8M seed.img
mke2fs -q -t ext4 -L drv-run-seed -E root_owner=0:0,root_perms=0700 -d "$staging" seed.img
e2fsck -fn seed.img

cat >connection.conf <<EOF
Host drv.run.vsock
    ProxyCommand @proxy@ vsock-mux$RUNTIME_DIRECTORY/notify.vsock %p
    ProxyUseFdpass yes
    HostKeyAlias drv.run.vsock
    User root
    IdentityFile $RUNTIME_DIRECTORY/client-key
    UserKnownHostsFile $RUNTIME_DIRECTORY/known_hosts
    GlobalKnownHostsFile /dev/null
    StrictHostKeyChecking yes
    IdentitiesOnly yes
    IdentityAgent none
    BatchMode yes
    ConnectTimeout 2
    ConnectionAttempts 1
    ForwardAgent no
    ClearAllForwardings yes
EOF
