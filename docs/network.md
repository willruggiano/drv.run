# Host TAP pool

The Host module requires explicit network configuration. Options and validation
live in [[nix/nixosModules/host/network.nix]]; provisioning and teardown live in
[[nix/nixosModules/host/network.sh]].

## Configuration

Supply deployment-specific values. These addresses and interface names are
examples, not detected Host settings:

```nix
services.drv-run.network = {
  uplink = "eth0";
  dnsServers = ["9.9.9.9"];
  slots = {
    drv-op0 = { owner = "operator"; subnet = "10.231.0.0/30"; };
    drv-op1 = { owner = "operator"; subnet = "10.231.0.4/30"; };
    drv-other0 = { owner = "other"; subnet = "10.231.0.8/30"; };
  };
};
```

Each enabled normal Host account needs at least one slot. Slots determine each
owner's concurrent allocation limit; another owner's unused slots do not add
capacity. Explicit numeric UIDs are optional.

The entire `drv-*` interface namespace is reserved. Each slot uses an unbridged
TAP, with the Host at subnet offset 1 and the Guest at offset 2. Interface
names, slot subnets and ownership are stable configuration, not derived from
user order.

The module requires the nftables firewall, IPv4 forwarding and table-scoped
updates. If other configuration enables global nftables flushing, explicitly set
`networking.nftables.flushRuleset = false`. Incompatible explicit settings fail
validation. Build-time UID substitutions affect only the nftables syntax-check
copy; the Host resolves account names when loading the actual rules.

## Allocation boundary

```text
root: drv-run-network.service
  +-- create and verify owner-bound TAPs
  +-- create root-owned lease directories
  +-- create owner-readable/writable 0600 lock files
  `-- publish /run/drv.run-network/ready

owner: /etc/drv.run/network/OWNER.json
  +-- compare manifest generation with ready
  +-- flock a free /run/drv.run-network/leases/OWNER/TAP.lock
  `-- hold that descriptor until the VMM has exited
```

Manifests and the readiness marker are public configuration, not credentials.
Lease files survive service stops. Do not unlink or replace them while the pool
is in use: a replacement inode permits a second independent lock.

Locks coordinate one owner's processes. Kernel TAP ownership separates different
owners. The service grants no capabilities, sudo rules or privileged request
API.

## Routing and filtering

```text
TAP -> source-address check -> destination/uplink filter -> IPv4 masquerade
TAP -> Host new connection                               -> DROP
TAP -> another TAP                                      -> DROP
uplink -> TAP unsolicited connection                    -> DROP
Host root or slot owner -> assigned Guest TCP/22        -> ALLOW
other Host UID -> TAP                                   -> DROP
IPv6 from/to TAP                                        -> DROP
```

Replies and related ICMP errors are permitted. Private, loopback, link-local,
carrier-grade NAT, multicast and reserved destinations are blocked. Configured
upstream DNS addresses have a TCP/UDP port 53 exception, but cannot be
Host-local or inside a pool subnet.

Startup checks all current IPv4 routing tables for subnet overlap, excluding
default routes and verified pool links' kernel routes. It cannot predict future
VPN/DHCP routes. Operators must also classify sensitive networks that use public
addresses; address-range filtering does not identify those networks. Public
Internet relays and Host-side Flake fetching are outside this filter's scope.

## Maintenance

Topology, DNS and owner changes require a full pool maintenance window:

1. Stop every owner's Instances and any other processes attached to pool TAPs.
2. Stop `drv-run-network.service`. Verify its `Result` is `success`, not merely
   that `systemctl stop` returned. A refused stop preserves links and leases but
   removes readiness.
3. Rebuild and activate the new Host configuration.
4. Start `drv-run-network.service` and verify it is `active (exited)` with a
   readiness generation matching the owner manifests.
5. Explicitly start Instances.

The service does not restart or tear down TAPs automatically on ordinary
rebuilds. Rebuild **after** stopping the old pool: its teardown script verifies
the old generation's interface identity. A topology-changing rebuild alone does
not reconfigure live links. Unrecognized `drv-*` traffic remains filtered.

After a refused stop, stop the remaining holders, then start and stop the pool
service again before rebuilding. If an incompatible generation was already
activated, restore the previous generation before teardown, or reboot with all
Instances stopped. Do not repair the pool by deleting live lease files.

If an owner's numeric UID changes, reboot with Instances stopped to recreate
lease ownership. The service rejects existing lease files with the wrong UID; it
does not reassign them.

The offline checks are [[nix/nixosTests/host-network-eval.nix]] and
[[nix/nixosTests/host-network.nix]].
