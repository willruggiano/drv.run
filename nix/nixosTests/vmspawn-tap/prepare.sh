# shellcheck shell=bash
set -euo pipefail
umask 077
cd "$RUNTIME_DIRECTORY"
rm -f "$STATE_DIRECTORY/exit-status.json"

if [[ ! -e $STATE_DIRECTORY/initialized ]]; then
  test ! -e "$STATE_DIRECTORY/root.img"
  test ! -e "$STATE_DIRECTORY/host-key"
  cp --reflink=auto --sparse=always @image@ "$STATE_DIRECTORY/root.img"
  chmod 600 "$STATE_DIRECTORY/root.img"
  truncate -s +1G "$STATE_DIRECTORY/root.img"
  resize2fs "$STATE_DIRECTORY/root.img"
  ssh-keygen -q -t ed25519 -N '' -f "$STATE_DIRECTORY/host-key"
  touch "$STATE_DIRECTORY/initialized"
fi
test -s "$STATE_DIRECTORY/root.img"
ssh-keygen -y -f "$STATE_DIRECTORY/host-key" >/dev/null
ssh-keygen -q -t ed25519 -N '' -f client-key
cid=${RUNTIME_DIRECTORY##*.}
[[ $cid == 1234 || $cid == 1235 ]]
printf 'drv.run.vmspawn %s\n' "$(ssh-keygen -y -f "$STATE_DIRECTORY/host-key")" >known_hosts
cat >connection.conf <<EOF
Host drv.run.vmspawn
    ProxyCommand @proxy@ vsock/$cid %p
    ProxyUseFdpass yes
    HostKeyAlias drv.run.vmspawn
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
