# shellcheck shell=bash
set -euo pipefail
umask 077

state=$STATE_DIRECTORY
runtime=$RUNTIME_DIRECTORY
# A missing stop record must not be mistaken for the previous boot's result.
rm -f "$state/exit-status.json"
cd "$runtime"
test -r /dev/kvm && test -w /dev/kvm
test -r /dev/net/tun && test -w /dev/net/tun

# This fixture has no recovery path: an established disk must never be recreated.
if [[ ! -e $state/initialized ]]; then
  [[ ! -e $state/state.img && ! -e $state/host-key ]]
  truncate -s 16G "$state/state.img"
  mke2fs -q -t ext4 "$state/state.img"
  ssh-keygen -q -t ed25519 -N '' -f "$state/host-key"
  touch "$state/initialized"
fi
test -s "$state/state.img"
ssh-keygen -y -f "$state/host-key" >/dev/null
ln -s "$state/state.img" state.img
ln -s "$state/host-key" host-key
ssh-keygen -q -t ed25519 -N '' -f client-key
printf 'drv.run.primitive %s\n' "$(ssh-keygen -y -f "$state/host-key")" >known_hosts

staging=$(mktemp -d "$runtime/seed.XXXXXXXX")
image=$(mktemp "$runtime/seed.img.XXXXXXXX")
trap 'rm -rf "$staging"; rm -f "$image"' EXIT
cp client-key.pub "$staging/authorized-keys"
# Deliberately exercise copying the runtime symlink's contents, not its inode.
cp -L host-key "$staging/host-key"
printf '%s\n' '@environment@' >"$staging/environment-path"
cp @network@ "$staging/uplink.network"
chmod 600 "$staging/"*
truncate -s 8M "$image"
# -d copies contents; set the filesystem root's ownership and mode explicitly.
mke2fs -q -t ext4 -L drv-run-seed -E root_owner=0:0,root_perms=0700 -d "$staging" "$image"
e2fsck -fn "$image"
[[ $(blkid -p -s LABEL -o value "$image") == drv-run-seed ]]
mv "$image" seed.img

printf '%s\n' '{"tap":"drv-primitive","mac":"02:00:00:00:00:01","queues":4}' >slot.json
cat >connection.conf <<EOF
Host drv.run.primitive
    HostName 10.231.0.2
    HostKeyAlias drv.run.primitive
    Port 22
    ProxyCommand none
    User root
    IdentityFile $runtime/client-key
    UserKnownHostsFile $runtime/known_hosts
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
