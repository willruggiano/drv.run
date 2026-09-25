# Cloud Hypervisor implementation plan

Replace the Guest VMM with Cloud Hypervisor. Keep per-user Instance services,
Unix ownership, captured Flake closures, persistent disks, and the current SSH
interface. Replace QEMU user networking with Host-preallocated routed TAP slots
and NAT. Replace `fw_cfg` with a per-boot read-only credential disk.

This is an implementation plan, not a tested implementation. Only this document
is changed by the planning task.

## 1. Scope and decisions

The user selected:

- Hypervisor migration only.
- Existing per-user `drv.run@ID.service` lifecycle.
- Privileged Host network setup; unprivileged VMM processes.
- Host-preallocated TAP slots rather than a dynamic privileged allocation API.
- A read-only seed disk for credentials and Guest network configuration.

Preserve:

- Client creation through `ssh -t drv.run <flake-reference>` using the existing
  authenticated-account behavior.
- Host-local reconnect through `ssh drv.run.ID` and the existing launcher.
- Automatic lingering and KVM membership for enabled normal Host accounts.
- Root SSH inside the Guest, strict Host-to-Guest host-key verification, and
  private per-boot client keys.
- Outbound Guest Internet access, including DNS and HTTPS.
- Guest-owned writable `/nix`, `/workspace`, and other declared persistence.
- A read-only Guest closure disk, no Host directory shares, and no virtiofs.
- Explicit start after Host reboot; SSH disconnect does not stop an Instance.

Do not implement:

- Public `ID.drv.run` DNS, direct Client-to-Guest SSH, public ingress, HTTPS
  publication, or additional Client authentication mechanisms.
- Upstream `microvm.nixosModules.host`, a shared `microvm` account, VSOCK SSH,
  Guest application modules, or Guest-driven boot-generation updates.
- Rootless networking, IPv6 Guest connectivity, live migration, or performance
  tuning.
- A QEMU compatibility backend or automatic conversion of old Instances.

The exact public hostname interface discussed in [[trajectory.md]] remains
future work. Preserving `drv.run.ID` here does not satisfy that interface.

## 2. Verified baseline

### Repository behavior

| Area             | Current implementation                                                           | Required change                                         |
| ---------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------- |
| VMM              | `microvm.hypervisor = "qemu"`                                                    | Cloud Hypervisor                                        |
| Network          | QEMU `type = "user"`, IPv4 DHCP                                                  | Routed TAP, static IPv4, NAT                            |
| SSH transport    | `nc -U .../ssh.sock` through QEMU host forwarding                                | TCP to the leased Guest address                         |
| Credentials      | `-fw_cfg`, `qemu_fw_cfg`, `ImportCredential`                                     | Read-only seed disk and `LoadCredential`                |
| Control          | `control.sock`, QMP shutdown                                                     | Keep socket pathname; use Cloud Hypervisor API shutdown |
| Persistent state | Owner's `StateDirectory`, `state.img`, host key, pinned closures                 | Preserve                                                |
| Runtime state    | Owner's `RuntimeDirectory`, client key and SSH configuration                     | Add seed image and slot assignment                      |
| Tests            | Actual Guest creation, provisioning, isolation, stop/start and filesystem checks | Adapt and extend                                        |

Sources: `nix/nixosModules/guest/default.nix`,
`nix/nixosModules/host/{default.nix,worker.sh,provision.sh,launch.sh}`, and
`nix/nixosTests/host-basic.nix`.

[[trajectory.md]] predates several changes: the current Guest has a control
socket, normal Host users own Instances, stopping preserves durable state, and
`host-basic` boots a Guest. Implement against the current files, not those older
observations.

### Pinned upstream constraints

Use the existing lock file. No dependency update is required by this plan.

- microvm.nix: `187b0a390ee054028106a674e7b01b1cb940cbba`.
- nixpkgs: `a32edd7654519351e48e80372a928df336394670`.
- Cloud Hypervisor package: `53.0` in pinned nixpkgs.

The pinned Cloud Hypervisor runner:

- Accepts TAP and macvtap, not `type = "user"`.
- Rejects nonempty `microvm.credentialFiles` and non-null `microvm.user`.
- Supports read-only raw disks and `microvm.socket` as an API socket.
- Uses `vm.power-button` followed by `waitpid "$MAINPID"` for shutdown.
- Enables seccomp and uses the uncompressed x86-64 kernel from `kernel.dev`.
- Generates network multiqueue settings from `microvm.vcpu`.
- Requires a VSOCK CID only for its optional systemd-notify transport, not for
  ordinary boot or API shutdown.

`lib/runner.nix` appends `extraArgsScript` output using shell word splitting. It
does not interpret shell quoting in that output. Runtime arguments must
therefore be strictly validated, whitespace-free tokens. Passing arguments to
`microvm-run` itself is not a substitute: that script does not forward `"$@"`.

The upstream TAP scripts use the `microvm` user and can delete existing TAPs. Do
not invoke them for this per-user pool.

Sources: upstream files listed in section 12.

## 3. Target architecture

```text
Host NixOS configuration
  |
  +-- root network-pool service
  |     +-- owner-bound TAPs, one /30 per slot
  |     +-- Host addresses and connected routes
  |     `-- stable lock files for unprivileged slot leasing
  |
  +-- nftables: source checks, isolation, outbound forwarding, NAT
  `-- immutable owner -> slot configuration

Client SSH -> Host sshd -> launcher [authenticated UID]
                            |
                            v
                   user's drv.run@ID.service
                     ExecStartPre: durable initialization
                     ExecStart:    lease slot; prepare seed;
                                   supervise Cloud Hypervisor
                     ExecStartPost: SSH readiness; copy Flake closure;
                                    publish client.conf
                            |
                            `-- Host SSH -> Guest address:22

Cloud Hypervisor [same UID, no capabilities]
  +-- read-only Guest closure disk
  +-- persistent state.img -> /persist
  +-- read-only seed.img   -> /run/drv-run-seed
  +-- leased TAP          -> Guest eth0/static IPv4
  `-- control.sock        -> Cloud Hypervisor HTTP API
```

Use one routed TAP per active Instance, not a shared bridge. Each slot has its
own /30, so Guests do not share an Ethernet broadcast domain. Addresses belong
to slots and may change across Instance restarts. They are private transport
addresses, not durable Instance identities.

Keep the existing Guest MAC address. Reusing it is safe across separate,
unbridged TAP links; no DHCP server or bridge learns a shared identity.

## 4. Host network configuration

### Explicit, stable slots

Add `nix/nixosModules/host/network.nix`, imported by the Host module. Introduce
`services.drv-run.network` with this configuration shape:

```nix
services.drv-run.network = {
  uplink = "eth0";
  dnsServers = ["9.9.9.9"];
  slots = {
    drv-op0 = {
      owner = "operator";
      subnet = "10.231.0.0/30";
    };
    drv-op1 = {
      owner = "operator";
      subnet = "10.231.0.4/30";
    };
    drv-other0 = {
      owner = "other";
      subnet = "10.231.0.8/30";
    };
  };
};
```

These are illustrative deployment values, not inferred Host settings. Require an
explicit uplink, DNS servers, and slots. Do not guess an unused private subnet,
add a resolver dependency, or derive addresses from sorted user names. The
repository exports modules, not an actual deployed Host configuration.

The slot key is the TAP name. Derive gateway address `network + 1` and Guest
address `network + 2`; use prefix length 30. Generate the pool service, firewall
rules, and per-owner manifests from this single Nix value.

Assertions:

- Slot names use a restricted `drv-` prefix and ASCII alphanumeric suffix, with
  at most 15 bytes total. Reject whitespace and shell/nftables metacharacters.
- Owners are enabled normal Host accounts. Every such account has at least one
  slot. Disabled and system accounts receive none.
- Subnets are canonical RFC1918 IPv4 /30 networks, disjoint from each other.
- DNS servers are valid IPv4 addresses; the list is nonempty. Host-local
  resolver addresses such as `127.0.0.53` are not Guest resolvers.
- Uplink syntax is validated and does not name a pool TAP.
- The Host uses the nftables firewall backend and IPv4 forwarding is enabled.
  Reject incompatible explicit configuration rather than silently overriding it.

Check deployment route overlap before activation. Nix evaluation cannot know all
DHCP, VPN, or externally installed routes. Refuse known collisions when
initializing the pool; document the remaining operator responsibility.

### Root provisioning, without a root request API

Create a fixed system service, `drv-run-network.service`, with `Type=oneshot`
and `RemainAfterExit=yes`:

1. Start after the nftables rules have loaded and normal accounts exist.
2. Resolve each configured owner to its numeric UID with `getent`.
3. Create its configured TAP with
   `ip tuntap add ... mode tap user UID vnet_hdr multi_queue`.
4. Assign the gateway /30 and bring the TAP up.
5. Disable IPv6 on these Host links and suppress ICMP redirects.
6. Prepare lease files and report the pool ready only after every slot is valid.

Use a fixed Host-generated script with escaped constants. It must not execute
owner-provided programs, read Instance files, or accept arbitrary device names
at runtime. Do not install sudo rules, a setuid helper, or capabilities on Cloud
Hypervisor. Load `tun`; verify owner access to `/dev/net/tun` as well as KVM.

Use multi-queue and virtual network headers even though TAP creation is not
performed by microvm.nix. The selected two-vCPU configuration requires the Cloud
Hypervisor network argument `num_queues=4`.

The fixed root service avoids networkd's documented deprecation of non-system
users in TAP `User=` configuration. It also avoids taking over the Host's
existing network manager. Ensure that manager does not reconfigure `drv-*`.

On partial setup failure, remove only the resources created by that invocation.
Never delete an unrelated preexisting interface. Verify an existing expected
interface's kind, owner, flags and address before accepting it.

Pool TAPs remain after an Instance stops. Pool teardown or reconfiguration is a
Host maintenance operation: stop affected Instances first. Do not hot-reassign
TAP ownership, addresses, or lease files under running VMMs. Configure service
restart behavior to avoid automatic pool teardown during ordinary rebuilds;
apply topology changes through the explicit stop/reconfigure/start sequence.

### Slot leasing

Generate public, non-secret manifests under `/etc/drv.run/network/<owner>.json`.
Each contains only that owner's slots, addresses, MAC, DNS servers and queue
count. Parse data with `jq`; do not source it as shell code.

Create locks under `/run/drv.run-network/leases/<owner>/<tap>.lock`:

- Parent directories remain root-owned and are not writable by owners.
- Each lock file is owned by its slot owner, mode `0600`.
- Never unlink or replace a lock file while the pool is in use. Replacing its
  inode would allow two independent locks for the same TAP.
- Use nonblocking `flock` to select a free slot. Exhaustion fails startup; it
  must not steal a slot or wait indefinitely.

A slot lease covers VMM startup, the entire VMM lifetime, and shutdown. An
`ExecStartPre` process cannot hold it for `ExecStart`: its descriptors disappear
when it exits. Hold the lock in the main startup/supervision process described
in section 7.

Locks prevent accidental concurrent allocation by one owner. They are not a
security boundary against that owner, who already owns its TAPs and disks.
Different owners cannot open each other's TAPs or acquire their lock files.

### Routing, filtering and NAT

Use Host-enforced filtering. Guest root can change its own address and firewall.
Do not trust either.

```text
Guest -> its TAP -> source check -> forwarding policy -> configured uplink
                                                           |
                                                           v
                                                      IPv4 masquerade

Host owner -> assigned Guest TCP/22 -> pinned SSH authentication
Guest -> Host new connection       -> DROP
Guest -> any other pool slot       -> DROP
external -> Guest new connection   -> DROP
IPv6 on a pool TAP                 -> DROP
```

Implement a dedicated nftables guard table plus the explicit allow rules needed
by the NixOS firewall:

1. Before connection tracking, reject IPv4 source addresses that do not match
   the Guest address assigned to the ingress TAP. Drop IPv6 from pool TAPs.
2. In an input guard chain before the normal filter priority, permit replies to
   Host-initiated connections and related errors; reject new Guest-to-Host
   traffic. This must precede globally opened Host ports such as SSH.
3. In a forwarding guard chain, reject traffic between pool TAPs, reject
   unsolicited inbound traffic to a Guest, and reject Guest egress through any
   interface except the configured uplink.
4. Block Guest destinations in loopback, link-local/metadata, private,
   carrier-grade NAT, multicast, reserved ranges, and every pool subnet. Permit
   configured upstream DNS addresses on TCP/UDP 53 as a narrow exception if a
   deployment uses private DNS. Never use this exception for a Host-local
   address or another slot. Permit related ICMP required for working PMTU.
5. Permit remaining outbound IPv4 and its established/related replies through
   `networking.firewall.extraForwardRules`, with
   `networking.firewall.filterForward = true`.
6. Masquerade only assigned Guest source addresses leaving the configured
   uplink. Do not enable DNAT or blanket forwarding from private networks.
7. Add an output guard for traffic to pool TAPs: permit root and the relevant
   owner to initiate TCP/22, plus necessary related traffic; reject initiation
   by other Host UIDs. Credential permissions and SSH authentication remain
   required even with this guard.

An `accept` in one nftables base chain does not bypass later base chains, and
NixOS accepts established traffic before its `extra*Rules`. Account for both
facts. Do not place the isolation rules only at the end of those extension
points. Test the effective combined ruleset, including existing Host open ports.

Use NixOS nftables table management for atomic updates and cleanup. Do not mix
ad-hoc `iptables` commands with nftables or flush unrelated tables.

This isolates direct Guest network access. It does not sandbox Host-side Flake
fetching or prevent a Guest from using a public Internet relay. Those are
separate security problems. Deployments must also account for sensitive routes
using globally routable addresses; private-range filtering alone is not a
complete classification of their internal network.

## 5. Credential and network seed disk

### Host construction

For every start, create a fresh `seed.img` inside the private Instance runtime
directory. Use a small raw ext4 image, for example 8 MiB, populated without a
Host mount using `mke2fs -d`. Package `e2fsprogs` explicitly.

```text
seed image root [root-owned, mode 0700]
  +-- authorized-keys    current runtime client public key
  +-- host-key           copy of durable Instance private host key
  +-- environment-path  resolved, captured Flake closure path
  `-- uplink.network    generated static Guest networkd configuration
```

Requirements:

- Use `umask 077`; the image, staging directory and private files remain
  private.
- Copy credential contents. Do not accidentally place the Host's `host-key`
  symlink into the filesystem image.
- Set the filesystem root owner to Guest root, e.g. with
  `mke2fs -E root_owner=0:0`; source files may retain Host numeric ownership,
  but remain behind the root-only image directory. `LoadCredential` creates the
  final service-private copies.
- Label the filesystem `drv-run-seed` explicitly. The volume has
  `autoCreate = false`, so microvm.nix will not label it.
- Create a temporary image, finish and validate it, then rename to `seed.img`.
  Remove staging files. Never modify the image while the Guest is running.
- Do not put secrets in Nix strings, derivations, kernel parameters, OEM
  strings, process arguments, environment variables, logs, or generated store
  paths.
- The seed remains attached until shutdown and disappears with the runtime
  directory. It is not persistent Instance state or an encrypted secret store.

### Guest disk layout and loading

Keep `state.img` first in `microvm.volumes`; append `seed.img` second:

```text
/dev/vda  read-only Guest closure disk
/dev/vdb  state.img -> /persist
/dev/vdc  seed.img  -> /run/drv-run-seed, by filesystem label
```

The drive letters describe the pinned runner's ordering, not a new general disk
naming API. Preserving `state.img` position avoids changing the current
unlabeled persistent volume's device.

Configure the seed volume with `readOnly = true`, `autoCreate = false`,
`imageType = "raw"`, `label = "drv-run-seed"`, and its mount point. Set Guest
mount options `ro,nodev,nosuid,noexec` and disable filesystem checking for this
fresh read-only image. The existing persistence disk remains writable ext4.

Add a Guest bootstrap oneshot that:

1. Requires the seed mount through `RequiresMountsFor`.
2. Validates required files, nonempty keys and the environment path.
3. Installs `uplink.network` into `/run/systemd/network/10-uplink.network`.
4. Completes before both `systemd-networkd.service` and `sshd.service`.

Add explicit `Requires` and `After` dependencies from those consumers. Use
explicit early-boot ordering for the bootstrap service rather than introducing a
`network-online.target` dependency cycle. It needs local mounts, not a working
network. Validate the resulting unit graph and a real boot.

Remove the static DHCP network unit. The generated unit matches the existing
Guest MAC, sets the assigned address and default gateway, disables DHCP and IPv6
link-local/RA, and supplies the configured DNS servers. Enable and wire
`systemd-resolved` explicitly so networkd's per-link DNS reaches applications.

Replace `ImportCredential` with absolute-path loading:

```nix
systemd.services.sshd.serviceConfig.LoadCredential = [
  "authorized-keys:/run/drv-run-seed/authorized-keys"
  "host-key:/run/drv-run-seed/host-key"
  "environment-path:/run/drv-run-seed/environment-path"
];
```

Keep existing sshd credential paths and `guest.sh`'s environment-path reader.
Keep host-key generation disabled. Missing credentials or an invalid seed must
fail closed, not generate a different host key or enable another login path.

Sources: microvm.nix `mounts.nix`, `lib/volumes.nix`, and systemd 261.2
`systemd.exec(5)`.

## 6. Cloud Hypervisor runner changes

In `nix/nixosModules/guest/default.nix`:

- Set `microvm.hypervisor = "cloud-hypervisor"`.
- Delete QEMU arguments, the `qemu_fw_cfg` initrd module, the user interface,
  and the Unix SSH forwarding script.
- Keep `microvm.socket = "control.sock"`, `mem = 3072`, `vcpu = 2`,
  `storeOnDisk = true`, and the writable store overlay.
- Keep `microvm.user = null`, `credentialFiles = {}`, and no directory shares.
- Leave VSOCK notification disabled; retain the existing service readiness model
  instead of changing the unit to `Type=notify`.
- Configure serial output explicitly for service operation, e.g.
  `--serial file=serial.log`, rather than depending on a terminal being present.
  Supply the matching `console=ttyS0`/early console kernel parameters: the
  pinned runner suppresses its default kernel console when serial is not `tty`.
- Keep the serial log in the private runtime directory. Expose its path in
  failure diagnostics and retain a bounded tail before runtime cleanup.
- Ensure `virtio_net` and ext4 support are available; the runtime network device
  will not be represented by a static `microvm.interfaces` entry.

Use `microvm.interfaces = []` and a new `extraArgsScript` to append exactly one
runtime-selected network device:

```text
--net tap=drv-op0,mac=02:00:00:00:00:01,num_queues=4
```

The script reads the selected slot data from the runtime directory, validates
its fixed fields and emits only those tokens. Do not interpolate an arbitrary
string as arguments. Assert that no second `--net`, port forward, or static
interface is configured. Derive queue count from the configured vCPU count.

This deliberate runtime hook keeps one reusable, pinned Guest runner rather than
building a Guest closure for every slot. Consequently, upstream TAP setup,
interface metadata and machined registration do not describe this network. Keep
those features unused and document the exception in the code.

Update Host volume assertions to recognize exactly the persistent disk and
read-only seed. Critically, change `createVolumes` to select only `state.img`
before setting `autoCreate = true`. The current mapping over every volume would
otherwise create the seed through the wrong code path.

## 7. Instance startup and SSH transport

### Durable initialization

Keep `worker.sh` as `ExecStartPre` for durable state:

- Validate the Instance ID, state directory and KVM access.
- Preserve first-creation `creating`/`ready` behavior, captured Flake closure,
  runner GC root, host key generation and one-time persistent disk creation.
- Preserve failure on a missing established disk or interrupted creation.
- Reject a pinned runner whose `share/microvm/hypervisor` is not
  `cloud-hypervisor`. Do not reinterpret a QEMU runner with new startup rules.
- Create the existing runtime credentials, known-hosts file and disk symlinks.
- Remove Unix-socket proxy configuration generation from this script.

There is no backwards compatibility requirement. The runner check is a clear
failure boundary, not a QEMU support branch.

### Startup and lease supervisor

Add `nix/nixosModules/host/start.sh` as the service's main process:

1. Resolve the authenticated owner from the effective UID, not caller-supplied
   environment variables.
2. Require a ready Host pool; verify the assigned TAP exists and has the
   expected link/address configuration. Use a bounded wait for boot-time pool
   startup.
3. Parse that owner's immutable manifest and nonblockingly acquire one slot
   lock.
4. Write the selected slot as private runtime data.
5. Generate static network configuration and the seed image.
6. Write and atomically publish `service-connection.conf`.
7. Start the pinned `runner/bin/microvm-run` as a direct child.
8. Hold the lock while waiting for the child; preserve its exit status.

The supervisor remains `MAINPID`. Retaining the lock in this parent does not
depend on Cloud Hypervisor preserving an unrelated inherited descriptor. Forward
termination signals, reap the child, and do not exit normally before the child
exits. Keep `KillMode=control-group` so systemd also kills descendants on
timeout.

Do not release a lease merely because provisioning failed. Release it after the
VMM has exited and the TAP queues have closed. Exercise this ordering under
normal shutdown, forced stop and startup failure.

### Service settings

Keep the current owner-only StateDirectory and RuntimeDirectory, `UMask=0077`,
`Type=exec`, and `Restart=no`.

Change `ExecStart` to the startup supervisor. Keep `ExecStop` pointing at the
pinned runner's `microvm-shutdown`; its Cloud Hypervisor implementation sends
the power-button request and waits for `MAINPID`, which exits after its child.
Keep a finite stop timeout and test that ordinary shutdown completes before it.

Do not use `Type=notify` unless a separate change implements the corresponding
VSOCK transport. Guest boot completion is not Flake provisioning completion.

Retain unlimited Flake build time if desired, but bound Guest readiness after
its VMM starts, e.g. 120 seconds with a test override. Readiness and build time
must not share an accidental infinite retry loop.

### TCP SSH configuration

Replace the runtime Unix-socket proxy with:

```sshconfig
HostName 10.231.0.2
Port 22
ProxyCommand none
HostKeyAlias drv.run.INSTANCE
IdentityFile /run/user/UID/drv.run.INSTANCE/client-key
UserKnownHostsFile /run/user/UID/drv.run.INSTANCE/known_hosts
```

Generate actual values from the selected slot and Instance identity. Preserve
the existing strict policy, including `User root`, `IdentitiesOnly`, disabled
agent use and forwarding, and `StrictHostKeyChecking yes`.

Keep the known-hosts identity tied to `drv.run.ID`, not to an address that may
later be leased to another Instance. The runtime `ProxyCommand none` must be
read before the existing `ProxyCommand false` fallback. Verify effective
configuration with `ssh -G` and connection behavior, not assumptions about
option ordering.

Update `provision.sh`:

- Wait for the complete service connection file before attempting SSH.
- Bound connection attempts and check the main process remains alive.
- Use the existing `ssh-ng` protocol, `nix copy`, and `root-environment`
  command.
- Publish `client.conf` only after the closure is copied and rooted in the
  Guest.
- On timeout or failure, return nonzero so systemd stops the VMM and removes
  runtime readiness. Do not leave a reconnect configuration for a failed start.

`launch.sh` and `guest.sh` keep their existing command grammar and PTY behavior.
Remove the `netcat-openbsd` substitution/dependency once no longer used.

## 8. State and failure semantics

```text
Durable per Instance                 Per boot                 Host pool
--------------------                 --------                 ---------
reference                            client key               TAP devices
Flake closure GC root                known_hosts              routes
runner GC root                       seed.img                 firewall/NAT
host key                             selected slot            owner manifests
state.img                            SSH configs              stable lock files
                                     control.sock
                                     serial.log
```

| Event                             | Required result                                                                  |
| --------------------------------- | -------------------------------------------------------------------------------- |
| SSH disconnect                    | VMM and lease remain active                                                      |
| Normal stop                       | Guest powers off; supervisor exits; runtime removed; lease released              |
| Restart                           | Same durable identity and state; fresh credentials and seed; any free owner slot |
| Host reboot                       | Durable state retained; pool recreated; explicit Instance start required         |
| Pool exhausted                    | Startup fails without taking another slot or damaging durable state              |
| Seed/network preparation fails    | No VMM left running; lease released; no client readiness                         |
| VMM exits during provisioning     | Provisioning fails promptly; runtime cleanup runs                                |
| Missing established state disk    | Fail; never format a replacement                                                 |
| Missing or wrong host key         | Fail; never silently accept a new identity                                       |
| Stop timeout                      | Kill service cgroup; release lease only as processes exit; report unclean stop   |
| State cleanup on stopped Instance | Existing `systemctl --user clean --what=state` behavior                          |

Stop and destroy remain separate. Do not use network cleanup to delete Instance
state. Do not persist runtime addresses or seed images in the state directory.

## 9. File-level implementation sequence

### Step 1: validate the transport primitives

Build a minimal Cloud Hypervisor Guest with one precreated TAP, the existing
state disk and a read-only seed. Verify unprivileged TAP attachment, queue
count, credential loading, static routing, DNS, serial capture and API poweroff.

This is the first implementation gate. Do not build the full pool machinery
around an untested boot path. In particular, test ext4 population ownership,
seed mount ordering and power-button delivery to the Guest's shutdown handler.
If the handler is absent, add the minimal Guest power-button handling and test
it; changing the shutdown command to a hard kill is not an acceptable fix.

### Step 2: implement the Host pool

- Add `host/network.nix` with typed options, assertions, manifests, fixed root
  provisioning service, locks, filtering and NAT.
- Import it from `host/default.nix`.
- Add deterministic pool tests before integrating Instance startup.
- Verify foreign-owner TAP attachment fails at the kernel permission boundary.

### Step 3: change the Guest and seed transport

- Update `guest/default.nix` and add a small Guest bootstrap script if needed.
- Replace firmware credentials and DHCP; append the seed volume.
- Add validated runtime network arguments and explicit serial handling.
- Fix persistent-volume selection and assertions in `host/default.nix`.

### Step 4: integrate the user-service lifecycle

- Split durable initialization and lease-owning startup as described above.
- Add `host/start.sh`; keep seed creation in this startup path rather than a
  generic abstraction with only one caller.
- Update `worker.sh`, `provision.sh`, package dependencies and service settings.
- Preserve launcher and Guest command behavior; delete obsolete QEMU glue.

### Step 5: extend integration tests

- Update `nix/nixosTests/host-basic.nix` for TAP, seed and TCP transport.
- Add focused `host-network.nix` and startup-failure tests where splitting makes
  failures easier to diagnose.
- Export any additional checks from `flake.nix`.

### Step 6: update maintained documentation

- Update the diagrams in [[docs/architecture.md]]; retain its diagram-only rule.
- Add a focused network setup document for the required Host configuration and
  capacity/reconfiguration procedure.
- Keep `nix/nixosModules/localhost.nix` aligned with the unchanged local
  aliases.
- Do not edit protected [[README.md]] or [[docs/security.md]]. Report their
  stale statements to the maintainer rather than overriding their edit
  restrictions.
- Remove obsolete implementation comments and dependencies; do not leave a
  disabled QEMU implementation as a fallback.

## 10. Test and acceptance matrix

All automated tests must be deterministic and offline. Assert exit status,
configuration values, process ownership, files, sockets, routes, connection
outcomes and filesystem state. Do not assert diagnostic output strings.

### Evaluation and generated configuration

- Valid network configuration evaluates with the locked inputs.
- Invalid owner, missing owner slots, overlapping subnet, malformed address,
  unsafe TAP name and incompatible firewall configuration fail evaluation.
- Guest options select Cloud Hypervisor, no static user networking, no shares,
  no firmware credentials, and exactly the intended two explicit volumes.
- Read-only seed and writable persistent disk properties hold.
- The persistent-disk creation helper cannot create or overwrite `seed.img`.
- nftables syntax checks pass through the pinned NixOS module's checker.

### Host pool and ownership

- Each configured TAP exists with the right UID, flags, address and route.
- The root pool service exposes no privileged runtime command interface.
- Each owner can attach its TAP; another owner cannot, even with the device
  name.
- Lock files cannot be unlinked/replaced by their owners.
- Two concurrent starts by one owner obtain distinct slots; exhaustion is clean.
- Another user's free slots do not increase this user's capacity.
- Pool failure leaves no partially active allocation available to Instances.

### Boot, provisioning and SSH

- Run Client creation through the real Host SSH launcher with PTY allocation.
- Verify the service and Cloud Hypervisor child both run as the authenticated
  owner, with no effective capabilities added for networking.
- Verify the Guest has its assigned address, route and functional DNS.
- Verify `seed.img` is read-only in the Guest and private on the Host.
- Verify `/run/credentials/sshd.service` contains the expected credentials.
- Copy and activate the Flake closure; assert `/run/environment` and enter the
  development environment through the existing reconnect command.
- Verify the control socket exists and the obsolete `ssh.sock` does not.
- Verify a wrong Guest host key and an unrelated client key fail authentication.
- Verify another Host owner cannot read keys/disks or connect to the Guest.
- Verify an unknown Instance alias fails closed.

### Network behavior

Use a separate test router and DNS/HTTP(S) endpoint; do not use the public
Internet. Give the endpoint a routed non-private test address so the ordinary
Internet egress path is exercised. Use a test CA for HTTPS if needed.

- Guest DNS resolution and HTTP(S) fetch succeed through the uplink.
- The external endpoint observes the Host's masqueraded address.
- Replies work without allowing unsolicited inbound connections.
- Guest access to Host wildcard-bound services, Host private addresses, Host
  loopback and metadata/link-local destinations fails.
- Guest access to another Guest fails, including a Guest owned by the same user.
- Source spoofing cannot bypass either input or forwarding filters.
- Configured private upstream DNS works only on TCP/UDP 53, not arbitrary ports.
- IPv6/RA/link-local attempts cannot bypass the IPv4-only design.
- Firewall reload preserves the isolation policy; unrelated Host SSH remains
  accessible from the Client.

### Persistence and shutdown

Retain the existing `/workspace`, `/root/discarded`, and offline `e2fsck -fn`
checks. Add:

- API power-button shutdown completes without hitting the systemd kill timeout.
- Persistent disk, host-key fingerprint, runner and Flake closure remain stable.
- Boot changes the Guest boot ID and rotates the runtime client key.
- Seed and runtime connection files disappear on stop.
- The lease is unavailable while the VMM runs and available after it exits.
- Restart can use a different slot without changing the SSH host identity.
- A second owner/Instance retains working network access when the first stops.
- Host reboot recreates the pool but does not autostart Instances; explicit
  restart recovers retained state.

### Failure paths

Inject pool exhaustion, absent TAP, missing seed, invalid seed contents, missing
persistent disk, corrupt/missing host key, VMM early exit, failed provisioning,
and forced stop. Assert no usable client readiness, no orphan VMM, eventual
lease availability, and no destruction of established state.

Test shutdown with the serial log and unit result available for diagnosis. A
service that becomes inactive only because systemd killed it is not a clean
shutdown success.

The outer NixOS test harness still uses QEMU. Keep `qemu.forceAccel = true` and
`-cpu host` for nested KVM. The migration removes QEMU as the drv.run Guest VMM,
not as the NixOS test driver. Nested KVM must be available on the test machine.

## 11. Validation and deployment

### Commands

For implementation changes, run the repository checks:

```sh
just check
just test
nix build .#checks.x86_64-linux.host-basic -L
nix flake check -L
```

Build additional named checks as they are introduced. `just test` includes a Nix
evaluation step; the final `nix flake check` is the authoritative suite.

The coding jail has no `nix`. Run `just check` and `node --test "**/*.test.ts"`
there, not the Nix-dependent recipes. The operator must run Nix evaluation,
builds and KVM integration tests outside it; leave that verification explicitly
pending. No boot, firewall, seed or shutdown behavior in this plan has been
experimentally validated by the planning task.

For this Markdown-only change, run formatting and `markdownlint-cli2`; Nix
checks are not required by the repository's Markdown exception.

### Cutover

1. Run the primitive boot gate and full offline suite.
2. Supply actual uplink, DNS and nonoverlapping slot configuration in the
   deployed Host's NixOS configuration.
3. Stop existing Instances. Back up any durable data that must be retained.
4. Activate the Host network and lifecycle changes in a maintenance window.
5. Verify pool ownership, routing, firewall policy and a new Instance end to
   end.
6. Create fresh Cloud Hypervisor Instances. Do not overwrite old runner roots,
   reformat old state disks, or claim transparent QEMU state migration.
7. Remove old Instance state only through an explicit owner/operator action.

For rollback, stop new Instances and restore the prior Host generation and
network configuration as a unit. Retain the old code/generation and state needed
for old QEMU Instances. Do not run a new Instance under an old pinned runner or
change its disk underneath a running VMM.

Pool capacity changes require a Host rebuild and a controlled pool restart. The
public Instance naming/publication work remains a separate implementation.

### Definition of done

- All selected scope constraints remain true.
- Cloud Hypervisor boots and provisions under the authenticated normal UID.
- Credentials do not cross the Nix store or VMM argument list.
- Guest Internet access works; Host and inter-Guest isolation tests pass.
- Stop/start preserves declared state and SSH identity, with fresh runtime data.
- Shutdown is graceful and failures release leases without deleting state.
- No QEMU-specific Guest transport remains; outer QEMU test infrastructure does.
- The complete locked-input NixOS test suite passes on a nested-KVM-capable
  Host.

## 12. Primary sources

Repository sources:

- `flake.lock`, `flake.nix`, and `justfile`.
- `nix/nixosModules/host/default.nix`, `worker.sh`, `provision.sh`, and
  `launch.sh`.
- `nix/nixosModules/guest/default.nix` and `guest.sh`.
- `nix/nixosModules/localhost.nix` and `nix/nixosTests/host-basic.nix`.
- [[trajectory.md]] for discussion context; current code takes precedence where
  its observations have become stale.

Pinned microvm.nix source root:
`/nix/store/qcpqkk0i9jlaz11jsb6n956b15xsixn4-source`.

- `lib/runners/cloud-hypervisor.nix`: arguments, disk/network support,
  credentials rejection, notification and shutdown.
- `lib/runner.nix`: runtime argument expansion, runner metadata and scripts.
- `lib/volumes.nix`: image creation and labeling.
- `nixos-modules/microvm/options.nix`: supported configuration interfaces.
- `nixos-modules/microvm/mounts.nix`: disk ordering and mounts.
- `nixos-modules/microvm/interfaces.nix`: TAP flags and upstream ownership.
- `nixos-modules/microvm/system.nix`: kernel modules and Guest boot integration.
- `nixos-modules/host/default.nix`: upstream lifecycle, deliberately not
  adopted.

Pinned nixpkgs source root:
`/nix/store/bqck1hypy8j3l922lf781qknmcxjv5a0-source`.

- `pkgs/by-name/cl/cloud-hypervisor/package.nix`: Cloud Hypervisor 53.0.
- `nixos/modules/services/networking/firewall-nftables.nix`: chain ordering and
  firewall extension points.
- `nixos/modules/services/networking/nftables.nix`: table lifecycle and checks.
- `nixos/modules/services/networking/nat-nftables.nix`: NAT integration
  behavior.

Systemd 261.2 manuals under
`/nix/store/848v7fr5jv4kb26a3jkfbiwds86rjf37-systemd-261.2-man/share/man`:

- `man5/systemd.exec.5.gz`: credential loading and runtime directory behavior.
- `man5/systemd.netdev.5.gz`: TAP multi-queue, virtual headers and user
  ownership.
