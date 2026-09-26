# Session trajectory: management and Guest egress

**SSH over Cloud Hypervisor's private VSOCK socket is the selected management
path. Guest egress remains undecided.** The production target is Cloud
Hypervisor (CH), with Firecracker still under consideration, not QEMU.

This continues [[trajectory.md]]. The session reviewed ways to remove custom
Host/Guest networking, credential, storage and lifecycle machinery. It then
implemented two independent test-only gates. The operator ran both outside the
coding jail and reported both passing after corrections. The final fixtures, not
the initial drafts, define what was validated.

```text
Management:
  Host SSH client -> private CH Unix socket -> VSOCK -> Guest sshd
                                                         |
                                                         +-> provisioning
                                                         +-> environment entry

Guest egress, still undecided:
  Guest NIC -> CH -> named TAP -> Host firewall / routing / NAT
                 -> nsresourced TAP FD -> same Host packet-processing path
                 -> vhost-user -> passt -> Host sockets + egress policy
```

No production migration was performed or authorized. The experiment changes are
flake checks and fixtures. This document records the resulting decisions,
evidence and remaining boundaries; it does not select an egress implementation.

## Starting point and review criteria

The review covered both conservative simplifications and replacements of whole
subsystems. The criterion was less machinery and fewer operational rules, not
just fewer lines in drv.run. Security boundaries had to survive the comparison.

At review time, `nix/nixosModules/guest/default.nix` still selected QEMU/SLiRP,
while `nix/nixosModules/host/default.nix` imported the new persistent TAP pool.
Configuring that pool did not make the SLiRP Guest use its isolation policy.

The pool design used owner-bound persistent multiqueue TAPs, static `/30`s,
root-managed nftables policy/NAT, immutable lease files, `flock`, and
generation/readiness checks. It rejected unsafe reconfiguration of attached
TAPs. The review questioned extending that allocator and startup supervisor
before testing upstream alternatives.

Sources: `nix/nixosModules/host/network.nix`,
`nix/nixosModules/host/network.sh`, `nix/nixosModules/host/network-routes.jq`,
and [[docs/network.md]].

## Alternatives reviewed initially

| Area                | Alternative                                                   | Assessment                                                                                                                                                                 |
| ------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Management          | SSH over VSOCK                                                | Separate authenticated management from Guest IP networking. Subsequently tested and selected for CH.                                                                       |
| Resource lifecycle  | vmspawn + nsresourced + networkd                              | Could replace the persistent pool. Subsequently tested, but vmspawn itself launches QEMU, not CH or Firecracker.                                                           |
| Egress              | passt                                                         | Can remove the Host TAP/subnet/forwarding/NAT path. Requires separate isolation policy and untested CH integration.                                                        |
| Existing pool setup | networkd `.netdev` and `.network` units                       | Replace device/address setup, not slot leasing, lock-inode invariants or protection against changing attached TAPs. Non-system TAP owners are deprecated in systemd 261.2. |
| Network policy      | UID/cgroup restrictions, network namespaces, `IPAddressDeny=` | Different enforcement mechanisms, not automatic replacements for the current isolation contract. Socket filtering does not filter forwarded TAP traffic.                   |
| Credentials         | Standard systemd credentials and network-generator inputs     | Standardize consumption, but do not themselves transport credentials into a VM. QEMU's file-backed `fw_cfg` is not a solution for the target VMMs.                         |
| Closure delivery    | virtiofs/shared Host store instead of `nix copy`              | Avoid copying, but add exports, helper lifecycle and Nix registration/GC concerns. Retain closure transfer and disk images for now.                                        |
| Persistence         | Existing Guest-owned disk and impermanence                    | Already a direct composition. No evidence justified replacing it with Host directory sharing.                                                                              |
| Reconfiguration     | Reboot-only topology changes                                  | Could simplify live pool reconciliation at the cost of operational flexibility. Discussed, not selected.                                                                   |

The pinned CH runner rejects `credentialFiles`. A read-only credential seed disk
therefore remained reasonable. Private keys in OEM-string process arguments were
rejected. A late seed mount also cannot be treated as if it automatically
precedes early network-generator execution.

The existing `nix/nixosModules/host/provision.sh` is small: wait for the Guest
store, copy the Flake closure, then activate the environment. The pinned
microvm.nix virtiofs helper instead adds supervisord and notification handling.
A read-only Guest mount is not a substitute for a Host-enforced read-only
export.

Sources: [pinned CH runner][microvm-ch], [virtiofs helper][microvm-virtiofs],
[systemd netdev options][systemd-netdev], and [systemd resource
controls][systemd-resources].

## Two passing gates

The checks are registered in `flake.nix`:

- `cloud-hypervisor-vsock`: `nix/nixosTests/cloud-hypervisor-vsock.nix` and its
  `cloud-hypervisor-vsock/` fixtures.
- `vmspawn-tap`: `nix/nixosTests/vmspawn-tap.nix` and its `vmspawn-tap/`
  fixtures.

Their runtime scenarios use offline fixtures. The assistant could run static
checks and Node tests, but Nix was unavailable in the jail. The operator built,
ran and debugged the VM checks externally, then confirmed both passed. This was
not a performance comparison or a complete security-equivalence proof.

### Cloud Hypervisor VSOCK gate

The CH gate validates:

- An unprivileged user service, notification readiness and a Guest without a
  NIC, IP routes, TCP listeners or Host directory shares.
- SSH through CH's Unix-socket VSOCK transport, using systemd's SSH proxy and
  OpenSSH FD passing.
- Strict host-key verification, rejection of unrelated client keys and denial of
  another Host UID's access to the private transport socket and secrets.
- A read-only credential seed and per-connection `sshd@` credentials.
- Offline Flake closure transfer and environment entry through the production
  Guest protocol, with a test-only credential-path substitution and inspection
  wrapper.
- Declared persistence across restart, disappearance of undeclared root state,
  stable Guest host keys, rotated client authorization, and clean shutdown with
  a non-repairing filesystem check.

VSOCK supplies transport, not authentication. SSH still authenticates both ends.
This gate validates the CH implementation; it does not validate an identical
Firecracker integration.

Relevant corrections were retained rather than weakening the assertions:

- Socket activation uses `sshd@`, not the old fixed `sshd.service` credential
  path. Credential dependencies and command-line paths changed together.
- SSH configuration uses valid omitted/deny-all settings rather than empty
  directives: CH omits the inherited `HostKey` with `null`, and both fixtures
  use `authorizedKeysFiles = ["none"]` before per-connection overrides.
- `systemd-resolved` accounted for four TCP listeners. It was disabled only in
  the NIC-less fixture; the zero-listener assertion remained.

Sources: `nix/nixosTests/cloud-hypervisor-vsock.nix`,
`nix/nixosTests/cloud-hypervisor-vsock/guest.nix`, [microvm VSOCK SSH
module][microvm-vsock], [systemd SSH proxy][ssh-proxy], and [OpenSSH FD
passing][openssh-fdpass].

### vmspawn/nsresourced TAP gate

Two unprivileged user services launch Guests without the production TAP pool.
The gate validates transient, owner-bound TAP allocation; disjoint networkd
`/28` subnets; DHCP and NAT; and offline DNS/HTTP egress.

Explicit Host nftables policy, not nsresourced or networkd alone, supplies the
isolation checks. The tests cover Host/peer and sensitive-destination rejection,
unsolicited ingress, DNS-only exceptions, source spoofing, IPv6 rejection,
firewall reload, foreign TAP attachment, persistence, clean stop and SIGKILL
cleanup without disrupting the other Instance.

Three integration findings were consequential:

1. **Systemd packaging:** generic BPF support was insufficient. The Host-local
   systemd build enables `withLibBPF` and supplies `vmlinux.h` generated by
   `bpftool` from the actual Host kernel's `${kernel.dev}/vmlinux`. It does not
   read the builder's `/sys` or apply a global systemd overlay. The same package
   supplies nsresourced, vmspawn and SSH proxies. The test verifies active BPF
   LSM and pinned BPF resources at runtime; incomplete `kernel.config` metadata
   was not a reliable assertion source.
2. **Caller identity:** this vmspawn registration path maps the caller UID and
   primary GID to namespace root. Upstream validation requires matching outside
   UID/GID ranges. Private primary groups with GIDs matching UIDs 1000/1001 made
   the path valid without bypassing nsresourced protections.
3. **Clean shutdown:** in systemd 261.2, the chosen `--pass-ssh-key=no` path
   falls back to killing QEMU rather than clean Guest poweroff. The earlier
   claim of a graceful QMP fallback was incorrect. `e2fsck -fn` exposed the
   unclean shutdown. The final `ExecStop` uses pinned VSOCK SSH to request
   `systemctl --no-block poweroff`, then waits for `$MAINPID`. Both stages are
   bounded. Missing `MAINPID` skips the request; `KillMode=mixed` retains
   crash/failed-stop cleanup. No pre-stop `sync` or filesystem repair was used
   to conceal this failure.

The Guest import also needed `modulesPath` instead of `pkgs.path` to avoid
module-evaluation recursion. Caller identity and untruncated failure journals
remain available for diagnosis.

The gate deliberately exposes non-equivalence:

- Source filtering permits the assigned `/28`, not exactly one leased `/32`.
- Native QEMU VSOCK is reachable by another Host UID. That UID cannot read the
  private key or authenticate with its own Guest's client key. This is not CH's
  owner-private Unix-socket transport boundary.
- The Guest has a writable full-root disk, not CH's declared-persistence model.
- Clean stops receive filesystem checks; crash cleanup is not proof of a
  crash-clean filesystem.
- Fixed-pool capacity semantics are not automatically reproduced by transient
  allocation.

Sources: `nix/nixosTests/vmspawn-tap.nix`,
`nix/nixosTests/vmspawn-tap/network.nix`, and [systemd 261.2
vmspawn][vmspawn-source] and [nsresourced][nsresourced-source].

## QEMU infrastructure versus the production VMM

The experiments use QEMU in two distinct roles:

```text
NixOS test harness                 Inside the test Host
------------------                --------------------
outer QEMU -> Host -> user unit -> Cloud Hypervisor -> Guest
                                  ^ production target

outer QEMU -> Host -> user unit -> vmspawn -> inner QEMU -> Guest
                                             ^ not the production target
```

The outer QEMU is test infrastructure. The inner QEMU is integral to vmspawn
261.2, which constructs QEMU configuration and uses QMP. vmspawn is not a
hypervisor-neutral launcher and has no CH or Firecracker backend.

The vmspawn experiment proves an upstream resource-allocation mechanism and its
tested Host policy/lifecycle composition. It does not prove a replacement
production launcher for our target VMMs. Its user-mode network option selects
QEMU `user` networking (SLiRP), not passt.

Source: [pinned vmspawn implementation][vmspawn-source].

## Separate the networking components

| Component   | Responsibility                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------- |
| TAP         | A Linux virtual Ethernet interface. The VMM exchanges frames through an open FD.                                |
| nsresourced | A privileged resource broker. It authorizes and allocates a TAP, then returns its FD to an unprivileged caller. |
| networkd    | Addresses, DHCP, routes and optionally masquerading for the interface.                                          |
| nftables    | Host-controlled packet filtering, including Guest/Host/LAN/tenant isolation.                                    |
| passt       | Translates Guest traffic into ordinary Host TCP/UDP/ping sockets instead of using a Host TAP.                   |
| vmspawn     | A QEMU launcher which already connects several of these components.                                             |

nsresourced is not in the packet path. Its TAP mode does not put the Guest's
networking into a separate network namespace. The implementation explicitly uses
the registered user namespace for identity/ownership, not a network namespace
operation. Registration is not an egress sandbox.

Sources: [nsresourced TAP implementation][nsresourced-source], [Varlink client
and FD handoff][nsresource-client], and [pinned passt manual][passt-manual].

### CH with transient nsresourced TAP

```text
Instance launcher -> register and retain user namespace
                  -> request TAP from nsresourced
                  <- receive TAP FD
                  -> inherit TAP FD into CH

Guest NIC -> CH -> TAP -> Host firewall / routing / NAT -> network
                   ^
                   +-- networkd addresses and DHCP
```

CH 53 accepts pre-opened network FDs through `--net fd=[...]`. One nsresourced
single-queue TAP FD corresponds to one RX/TX queue pair: CH requires
`num_queues=2` for that FD. This is not the current multiqueue pool
configuration.

The CH launcher still needs registration, FD reception/inheritance, correct
queue configuration, namespace lifetime management and failure cleanup. The TAP
is nonpersistent and disappears when its last attached FD closes. The registered
user namespace must also remain alive for the intended allocation lifetime.
**This CH composition has not been tested.**

Sources: [CH network validation][ch-config], [nsresource
client][nsresource-client], and [Linux TAP lifecycle][linux-tap].

### CH with passt

```text
Instance service arrangement -> CH
                             -> passt

Guest NIC -> CH -> vhost-user socket -> passt -> Host sockets -> network
                                       ^
                                       +-- Host-enforced egress policy
```

passt can eliminate the Host TAP, TAP leases, routed Guest subnet allocation,
Host-side networkd DHCP server, IP forwarding and kernel masquerading for this
path. Translation still occurs in passt; Host kernel networking still handles
its sockets. The Guest still has a NIC and IP configuration.

CH 53 supports vhost-user networking, and pinned passt supports `--vhost-user`.
The pinned microvm.nix CH runner exposes TAP/macvtap rather than this backend
and normally disables shared memory without virtiofs or graphics. Integration
needs runner changes, shared Guest memory, backend socket setup and supervised
passt startup/teardown. **Exact CH/passt interoperability remains untested.**

QEMU 11.1.0 has an integrated passt backend with launch/cleanup support, but
that is not a production advantage when QEMU is not the target VMM.

`--no-map-gw` disables a particular gateway-to-Host mapping. It is not a
Host/LAN/tenant firewall. passt's ordinary Host sockets require a separate,
Host-enforced policy.

Sources: [pinned passt manual][passt-manual], [CH vhost-user
example][ch-vhost-user], [pinned runner][microvm-ch], and [QEMU passt
backend][qemu-passt].

### Firecracker-compatible named TAP

Firecracker 1.16.1 opens a TAP by `host_dev_name`. Its supported API does not
expose CH-style pre-opened TAP FDs or a vhost-user network backend. Named TAP is
therefore the common supported model for CH and Firecracker; neither the
nsresourced FD handoff nor CH/passt is portable unchanged to Firecracker.

Named TAP does not mean a permanent, preallocated pool. A privileged lifecycle
component could create and remove a device per Instance. However, bridging
pre-creation to unprivileged Firecracker attachment needs an explicit lifetime
arrangement:

- Closing the last FD of a nonpersistent TAP destroys it.
- Holding its single queue open in a broker does not permit Firecracker to
  attach another queue by name.
- A persistent single-queue TAP can survive that handoff interval, but needs
  explicit cleanup afterward, including after VMM failure.

Firecracker 1.16.1 does not support multiqueue. Its `open_named` requests
`IFF_TAP | IFF_NO_PI | IFF_VNET_HDR`, not `IFF_MULTI_QUEUE`. **Our existing
multiqueue TAP pool is not Firecracker-compatible unchanged.** This session did
not boot a Firecracker gate.

Sources: [Firecracker networking][firecracker-network], [Firecracker TAP
implementation][firecracker-tap], [Linux TAP lifecycle][linux-tap], and
`nix/nixosModules/host/network.sh`.

## What Guest egress and allowlisting mean

Guest egress includes `curl https://ietf.org`, DNS queries, `git clone`, package
downloads and outbound SSH from inside the Guest. It is separate from
Host-to-Guest management, public ingress/publication, and Host-side Flake
fetching. The publication questions in [[trajectory.md]] remain unresolved by
these egress experiments.

Guest root can replace Guest firewall rules and ignore proxy environment
variables. An enforceable boundary therefore lives outside the Guest. See
[[docs/security.md]].

### Address and port policy

```text
TAP:
  Guest -> CH/Firecracker -> TAP -> Host nftables FORWARD policy -> network

passt:
  Guest -> CH -> passt -> Host OUTPUT/cgroup policy -> network
```

TAP rules can identify the Instance by ingress interface, reject source
spoofing, match destination IP/protocol/port, and deny everything else.
nsresourced's allocation does not supply those rules.

passt traffic must be identified by its Host socket ownership, for example a
dedicated UID or protected cgroup. Filtering a shared owner UID also affects
that owner's other processes and conflates their Instances. A unit-owned rule
that an untrusted policy subject can remove is not a sufficient boundary.

Systemd `IPAddressAllow=`/`IPAddressDeny=` filters addresses on a unit's
IPv4/IPv6 sockets, not destination ports or forwarded TAP traffic. Required BPF
support must be verified: unsupported configurations may have no effect.

The existing TAP policy blocks sensitive address ranges while permitting public
Internet egress. It is not a positive destination allowlist. Operators must also
account for sensitive destinations using public addresses.

Sources: `nix/nixosModules/host/network.nix`, [[docs/network.md]], and [systemd
resource controls][systemd-resources].

### Hostname policy

Allowing `ietf.org` is not equivalent to allowing its currently resolved IPs.
Addresses change, and unrelated domains can share CDN addresses. Resolving
approved names into firewall sets does not preserve hostname identity.

An explicit Host-controlled HTTP(S) proxy is one possible implementation:

```text
Guest curl -> CONNECT ietf.org:443 -> egress proxy
                                       |
                                       +-> hostname/port authorization
                                       +-> DNS resolution and IP validation
                                       +-> connection to approved destination

Guest direct Internet connection -------------------------------> DENY
```

The underlying TAP or passt policy would permit only proxy access and explicitly
required infrastructure. `HTTPS_PROXY` configures cooperative applications; the
outside firewall prevents bypass. The proxy must validate resolved addresses,
not merely a supplied name, to protect Host/private destinations and handle DNS
rebinding. Redirects that require another destination must pass policy again.
Direct DNS, IPv6, alternate transports and client compatibility need explicit
treatment.

A CONNECT proxy restricts tunnel destinations. Without decrypting TLS it does
not authorize URL paths or all activity inside the tunnel. An allowed service
can still accept uploads or act as a relay. DNS-only filtering is not a complete
egress boundary either.

Squid 7.6 supplies hostname, destination-IP and port ACLs; it was an example,
not a selected component. No allowlist implementation was added.

Sources: [pinned Squid ACL documentation][squid-acls] and [HTTP CONNECT
semantics][http-connect].

## Named TAP versus passt

| Concern             | Firecracker-compatible named TAP                                                                              | passt with CH                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Compatibility       | Supported by both target VMMs, with single-queue configuration for Firecracker.                               | CH interface exists; exact integration untested. No corresponding Firecracker 1.16.1 backend.                        |
| Resources           | TAP ownership, addressing, routing, usually NAT, and cleanup. A fixed pool is optional.                       | Backend process and socket instead of that Host network topology.                                                    |
| Privileges          | Host-network-namespace provisioning requires privilege; owner attachment can be unprivileged.                 | Backend can be unprivileged; enforceable Host policy still requires privileged configuration.                        |
| Lifecycle           | Persistent devices need cleanup after VMM failure. Per-Instance creation does not remove that responsibility. | Must supervise backend/socket lifetime alongside CH; no persistent TAP cleanup.                                      |
| Isolation           | Interface-scoped packet filtering maps directly to each Guest.                                                | Socket UID/cgroup policy needs secure per-Instance attribution.                                                      |
| Protocols           | Ethernet-frame path into Host networking, subject to configured routing/filtering.                            | TCP/UDP/ping translation, not arbitrary Ethernet/IP transport.                                                       |
| Attack surface      | Guest frames reach VMM/TAP and the Host packet-processing path.                                               | Additional userspace parser/backend; vhost-user gives it shared Guest-memory access. Host socket networking remains. |
| Observability       | Interface captures/counters, routes and nftables state.                                                       | Process, socket and backend attribution.                                                                             |
| Hostname allowlists | Need separate application-aware policy.                                                                       | Same requirement; passt does not supply it.                                                                          |
| Performance         | No comparative measurements in this session.                                                                  | No comparative measurements in this session.                                                                         |

Shared Guest memory is not a Host directory share, but it expands which process
can access Guest memory. Neither model has an established blanket security or
performance advantage here.

If Firecracker support is required, named TAP is the common supported path. If
CH is sufficient, passt could remove more Host network machinery, provided its
lifecycle and enforceable egress policy do not reintroduce equivalent
complexity. Transient nsresourced TAP remains a third CH candidate: retain
interface-based policy while removing the persistent pool, subject to the
untested CH FD integration.

Sources: [Firecracker networking][firecracker-network], [CH network
configuration][ch-config], [CH vhost-user example][ch-vhost-user], and [pinned
passt manual][passt-manual].

## Remaining decisions and validation boundaries

- Integrate the selected CH VSOCK management design without treating the
  fixture's inspection command as a production protocol feature.
- Decide whether Firecracker compatibility is required or merely an option worth
  retaining. It constrains network attachment, not just VMM selection.
- Specify allowlist semantics: IP/port, hostname, or stronger application
  restrictions; global versus per-Instance policy; and required protocols.
- Compare egress candidates against that policy: Firecracker-compatible named
  TAP, CH/nsresourced FD handoff, or CH/passt. No candidate was selected.
- For CH/nsresourced, validate the actual CH launcher/FD/lifetime composition
  and preserve the required systemd packaging and authorization boundaries.
- For CH/passt, validate matched-version interoperability, shared memory,
  ownership, supervision, fail-closed egress policy and crash cleanup.
- For Firecracker, add an actual boot/network/lifecycle gate using compatible
  TAP flags. Neither existing experiment proves this path.
- Preserve tested authentication, ownership, isolation, persistence and cleanup
  outcomes when replacing mechanisms. Do not infer production equivalence from
  two passing prototypes.

Diagnostic logs used during the experiments are
`.scratch/cloud-hypervisor-vsock.log` and `.scratch/vmspawn-tap.log`. External
builds captured with `tee` need `set -o pipefail` to preserve build failures.

## Pinned evidence

`flake.lock` pins microvm.nix at `187b0a390ee054028106a674e7b01b1cb940cbba` and
nixpkgs at `a32edd7654519351e48e80372a928df336394670`.

| Component                        | Version reviewed     |
| -------------------------------- | -------------------- |
| systemd                          | 261.2                |
| OpenSSH                          | 10.5p1               |
| Cloud Hypervisor                 | 53.0                 |
| Firecracker                      | 1.16.1               |
| QEMU                             | 11.1.0               |
| passt                            | `2026_07_16.090d739` |
| Squid, for the allowlist example | 7.6                  |

Local source and manual roots used:

- microvm.nix: `/nix/store/qcpqkk0i9jlaz11jsb6n956b15xsixn4-source`.
- nixpkgs: `/nix/store/bqck1hypy8j3l922lf781qknmcxjv5a0-source`.
- systemd manuals:
  `/nix/store/848v7fr5jv4kb26a3jkfbiwds86rjf37-systemd-261.2-man`.
- OpenSSH manuals:
  `/nix/store/lz43srhib9zixm2w65kc7mwb9pfg1lrm-openssh-10.5p1-man`.

External implementation links below are version-pinned. The Linux TAP reference
explains the interface/lifetime model; the runtime gates, not that older kernel
manual alone, establish behavior on the tested Host kernel.

[microvm-ch]:
  https://github.com/microvm-nix/microvm.nix/blob/187b0a390ee054028106a674e7b01b1cb940cbba/lib/runners/cloud-hypervisor.nix
[microvm-vsock]:
  https://github.com/microvm-nix/microvm.nix/blob/187b0a390ee054028106a674e7b01b1cb940cbba/nixos-modules/microvm/vsock-ssh.nix
[microvm-virtiofs]:
  https://github.com/microvm-nix/microvm.nix/blob/187b0a390ee054028106a674e7b01b1cb940cbba/nixos-modules/microvm/virtiofsd/default.nix
[systemd-netdev]:
  https://github.com/systemd/systemd/blob/v261.2/man/systemd.netdev.xml
[systemd-resources]:
  https://github.com/systemd/systemd/blob/v261.2/man/systemd.resource-control.xml
[ssh-proxy]:
  https://raw.githubusercontent.com/systemd/systemd/v261.2/src/ssh-generator/ssh-proxy.c
[openssh-fdpass]:
  https://raw.githubusercontent.com/openssh/openssh-portable/V_10_5_P1/sshconnect.c
[vmspawn-source]:
  https://raw.githubusercontent.com/systemd/systemd/v261.2/src/vmspawn/vmspawn.c
[nsresourced-source]:
  https://raw.githubusercontent.com/systemd/systemd/v261.2/src/nsresourced/nsresourcework.c
[nsresource-client]:
  https://raw.githubusercontent.com/systemd/systemd/v261.2/src/shared/nsresource.c
[ch-config]:
  https://raw.githubusercontent.com/cloud-hypervisor/cloud-hypervisor/v53.0/vmm/src/config.rs
[ch-vhost-user]:
  https://raw.githubusercontent.com/cloud-hypervisor/cloud-hypervisor/v53.0/docs/vhost-user-net-testing.md
[qemu-passt]: https://raw.githubusercontent.com/qemu/qemu/v11.1.0/net/passt.c
[passt-manual]: https://passt.top/passt/plain/passt.1?id=090d739
[firecracker-network]:
  https://raw.githubusercontent.com/firecracker-microvm/firecracker/v1.16.1/docs/network-setup.md
[firecracker-tap]:
  https://raw.githubusercontent.com/firecracker-microvm/firecracker/v1.16.1/src/vmm/src/devices/virtio/net/tap.rs
[linux-tap]: https://www.kernel.org/doc/html/v6.4/networking/tuntap.html
[squid-acls]:
  https://raw.githubusercontent.com/squid-cache/squid/SQUID_7_6/src/cf.data.pre
[http-connect]: https://www.rfc-editor.org/rfc/rfc9110.html#section-9.3.6
