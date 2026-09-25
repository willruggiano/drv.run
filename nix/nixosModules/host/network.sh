# Invoked only by the fixed system service, never by an Instance owner.
set -euo pipefail
umask 077
[[ $EUID == 0 && $# == 1 && ($1 == start || $1 == stop) ]]
config=@config@
root=/run/drv.run-network
generation=$(jq -er '.generation' "$config")
alias="drv.run:$generation"
created_taps=()
created_locks=()
lease_fds=()

fail() {
  printf 'drv.run network: %s\n' "$*" >&2
  exit 1
}

# Only this invocation's newly created resources are rollback candidates.
rollback() {
  status=$?
  if ((status != 0)); then
    rm -f "$root/ready" "$root/ready.tmp"
    for tap in "${created_taps[@]}"; do
      ip link del dev "$tap" || printf 'drv.run network: rollback could not remove %s\n' "$tap" >&2
    done
    for lock in "${created_locks[@]}"; do
      rm -f -- "$lock"
    done
  fi
  for fd in "${lease_fds[@]}"; do
    exec {fd}<&-
  done
}

root_directory() {
  local directory=$1
  if [[ ! -e $directory ]]; then
    mkdir -m 0755 -- "$directory"
  fi
  [[ -d $directory && ! -L $directory && $(stat -c '%u:%a' "$directory") == 0:755 ]] ||
    fail "unsafe directory: $directory"
}
root_directory "$root"
root_directory "$root/leases"
# Serialize even manual root service invocations; owners cannot open this lock.
exec {pool_fd}>"$root/maintenance.lock"
flock -xn "$pool_fd" || fail 'pool maintenance is already in progress'
trap rollback EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
rm -f "$root/ready"

rows=$(jq -ce '.slots[]' "$config")
mapfile -t slots <<<"$rows"

load_slot() {
  local row=$1 account
  tap=$(jq -er '.tap' <<<"$row")
  owner=$(jq -er '.owner' <<<"$row")
  gateway=$(jq -er '.gateway' <<<"$row")
  account=$(getent passwd "$owner") || fail "owner does not exist: $owner"
  IFS=: read -r account_name _ uid _ _ _ _ <<<"$account"
  [[ $account_name == "$owner" && $uid =~ ^[0-9]+$ && $uid != 0 ]] || fail "invalid owner: $owner"
  lock="$root/leases/$owner/$tap.lock"
}

verify_tap() {
  local flags
  ip -j -d link show dev "$tap" | jq -e --arg alias "$alias" '
        length == 1 and .[0].linkinfo.info_kind == "tun"
        and .[0].linkinfo.info_data.persist == true
        and .[0].ifalias == $alias and (.[0].flags | index("UP") != null)
    ' >/dev/null || fail "unexpected link: $tap"
  [[ $(<"/sys/class/net/$tap/owner") == "$uid" && $(<"/sys/class/net/$tap/group") == -1 ]] ||
    fail "unexpected TAP permissions: $tap"
  flags=$(<"/sys/class/net/$tap/tun_flags")
  # TAP, NO_PI, VNET_HDR, MULTI_QUEUE; never TUN or ONE_QUEUE.
  (((flags & 0x7103) == 0x5102)) || fail "unexpected TAP flags: $tap"
  ip -j address show dev "$tap" | jq -e --arg gateway "$gateway" '
        [.[].addr_info[] | {family, local, prefixlen, scope}] ==
          [{family: "inet", local: $gateway, prefixlen: 30, scope: "global"}]
    ' >/dev/null || fail "unexpected TAP addresses: $tap"
  [[ $(<"/proc/sys/net/ipv4/conf/$tap/send_redirects") == 0 ]] || fail "redirects enabled: $tap"
  if [[ -e /proc/sys/net/ipv6/conf/$tap/disable_ipv6 ]]; then
    [[ $(<"/proc/sys/net/ipv6/conf/$tap/disable_ipv6") == 1 ]] || fail "IPv6 enabled: $tap"
  fi
}

verify_lock() {
  [[ -f $lock && ! -L $lock && $(stat -c '%u:%a:%h' "$lock") == "$uid:600:1" ]] ||
    fail "unexpected lease permissions or inode: $lock"
}

if [[ $1 == stop ]]; then
  # Acquire every lease and inspect every device before changing any link.
  # Never unlink leases, including when a stop fails or a unit is reloaded.
  for row in "${slots[@]}"; do
    load_slot "$row"
    root_directory "$root/leases/$owner"
    verify_lock
    exec {lease_fd}<"$lock"
    lease_fds+=("$lease_fd")
    flock -xn "$lease_fd" || fail "slot is leased; stop its Instance first: $tap"
    verify_tap
    [[ $(<"/sys/class/net/$tap/carrier") == 0 ]] || fail "TAP has attached queues: $tap"
  done
  for row in "${slots[@]}"; do
    load_slot "$row"
    ip link del dev "$tap"
  done
  exit 0
fi

uplink=$(jq -er '.uplink' "$config")
ip link show dev "$uplink" >/dev/null || fail "uplink does not exist: $uplink"
[[ -c /dev/net/tun && -c /dev/kvm ]] || fail 'TUN and KVM devices are required'

# Validate all preexisting devices before accepting their kernel routes below.
for row in "${slots[@]}"; do
  load_slot "$row"
  if ip link show dev "$tap" >/dev/null 2>&1; then
    verify_tap
  fi
  runuser -u "$owner" -- test -r /dev/net/tun
  runuser -u "$owner" -- test -w /dev/net/tun
  runuser -u "$owner" -- test -r /dev/kvm
  runuser -u "$owner" -- test -w /dev/kvm
done
ip -j -4 route show table all | jq -e --slurpfile config "$config" -f @route-check@ >/dev/null ||
  fail 'pool subnet overlaps an installed route'
ip -j -4 address show | jq -e --slurpfile config "$config" '
    [.[].addr_info[].local] as $local |
    all($config[0].dnsServers[]; . as $dns | $local | index($dns) == null)
' >/dev/null || fail 'upstream DNS must not be a Host-local address'

for row in "${slots[@]}"; do
  load_slot "$row"
  root_directory "$root/leases/$owner"
  if [[ ! -e $lock && ! -L $lock ]]; then
    (
      set -o noclobber
      : >"$lock"
    )
    created_locks+=("$lock")
    chown "$uid" "$lock"
    chmod 0600 "$lock"
  fi
  verify_lock
  if ! ip link show dev "$tap" >/dev/null 2>&1; then
    # Do not recreate a missing link while its owner's Instance holds a lease.
    exec {lease_fd}<"$lock"
    lease_fds+=("$lease_fd")
    flock -xn "$lease_fd" || fail "missing TAP has a live lease: $tap"
    ip tuntap add dev "$tap" mode tap user "$uid" vnet_hdr multi_queue
    created_taps+=("$tap")
    ip link set dev "$tap" alias "$alias"
    if [[ -e /proc/sys/net/ipv6/conf/$tap/disable_ipv6 ]]; then
      printf '1\n' >"/proc/sys/net/ipv6/conf/$tap/disable_ipv6"
    fi
    printf '0\n' >"/proc/sys/net/ipv4/conf/$tap/send_redirects"
    ip addr add "$gateway/30" dev "$tap"
    ip link set dev "$tap" up
  fi
  verify_tap
done
# Consumers must compare this generation with their immutable owner manifest.
# A rebuild can change manifests/rules, but must not reconfigure live TAPs.
printf '%s\n' "$generation" >"$root/ready.tmp"
chmod 0444 "$root/ready.tmp"
mv -T "$root/ready.tmp" "$root/ready"
