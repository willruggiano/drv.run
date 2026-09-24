# Session trajectory

The discussion started with replacing QEMU and ended with a broader Instance
model: hostname-based access across protocols, Guest-managed application
services, and Host-managed publication expressed in NixOS configuration.
Implementation remains pending. The session performed research and scoping only.

Repository paths below are relative to the repository root.

## Starting point: hypervisor migration

The initial request was to read microvm.nix and scope switching drv.run to Cloud
Hypervisor or Firecracker.

The existing implementation couples the Guest to QEMU through user networking,
Unix-socket SSH forwarding, and `fw_cfg` credentials. Neither alternative is a
drop-in replacement. Both require another networking and credential-delivery
mechanism. Firecracker also requires an API socket; the current Guest sets
`microvm.socket = null`.

Outbound Guest Internet access must remain available. Privileged TAP setup
versus rootless networking was left open. VSOCK SSH and a credential seed disk
were explored, not selected. Neither hypervisor was selected.

Sources: `nix/nixosModules/guest/default.nix`,
`nix/nixosModules/host/worker.sh`, and the pinned microvm.nix runners listed
below.

## Correction: consider the upstream Host lifecycle

[Stapelberg's article](https://michael.stapelberg.ch/posts/2026-02-01-coding-agent-microvm-nix/)
uses both Cloud Hypervisor and `microvm.nixosModules.host`. It declares Guests,
uses TAP interfaces with a bridge and NAT, shares directories through virtiofs,
and starts Guests through system services.

The initial analysis overemphasized preserving drv.run's existing user-service
lifecycle. Adopting upstream's Host lifecycle is a valid alternative to building
custom lifecycle machinery. Upstream also supports imperative installation, not
only statically declared Guests.

Upstream's `microvm` account owns VMM processes. It does not automatically
replace `drvrun` as the SSH entry point. Those roles can remain separate. Their
eventual account model remains undecided.

Sources: pinned microvm.nix `nixos-modules/host/default.nix` and
`doc/src/microvm-command.md`; `nix/nixosModules/host/default.nix`.

## Client interface became the governing constraint

The Client and Host will be separate computers. Requiring the Client to execute
`sudo -u drvrun -H ssh ...` is not acceptable.

The agreed command forms are:

```sh
ssh -t drv.run <flake-reference>
ssh ID.drv.run
```

These are exact interface constraints, not abbreviations for commands with
hidden requirements:

- No Client SSH configuration, wrappers, `ProxyJump`, or `RemoteCommand` setup.
- No additional reconnect flags or arguments.
- Creation may use `-t`; this was explicitly allowed after establishing that
  stock OpenSSH does not request a PTY by default for an exec request.
- Instance names use `ID.drv.run`, rather than the original `drv.run.ID` form.

Sources for current behavior: `nix/nixosModules/peerLocal.nix`,
`nix/nixosModules/host/launch.sh`, and OpenSSH 10.5p1 `ssh_config(5)`.

## Direct access and the alternatives explored

SSH does not send the destination DNS hostname as a routing selector. Multiple
names resolving to one IP address and port 22 do not identify different Guests
to an ingress router.

Hostname-selected direct SSH therefore requires distinguishable destination
addresses under the agreed Client interface. One router and one Host tunnel can
carry many such addresses; separate physical machines or interfaces are not
required. The tunnel moves the upstream routing requirement to an ingress node
but does not eliminate per-Instance addressing.

The discussion explored:

- Public DNS with routed per-Guest addresses.
- A Host-only tunnel to public ingress, without Client VPN configuration.
- Client VPNs with private DNS and routing.
- LAN DNS and mDNS. mDNS normally uses `.local` names and link-local multicast;
  it does not provide general Internet reachability.
- SSH bastions, destination ports, explicit reconnect commands, interactive
  selection, credential-based selection, and Client connection mappings.
- `ssh ID@drv.run`: a valid account/service selector, with the verified key
  identifying the authorized principal. Stock OpenSSH needs valid accounts;
  virtual selectors need an SSH gateway or additional account-resolution
  machinery. Username-based gateways terminate Client SSH rather than
  transparently carrying end-to-end Guest SSH.

After this broader comparison, hostname-based selection remained the preference.
IPv4-only Client support, routed-prefix availability, and ingress placement
remain open deployment questions.

Protocol sources: [SSH transport](https://www.rfc-editor.org/rfc/rfc4253),
[SSH authentication](https://www.rfc-editor.org/rfc/rfc4252),
[SSH connection protocol](https://www.rfc-editor.org/rfc/rfc4254), and
[mDNS](https://www.rfc-editor.org/rfc/rfc6762).

## DNS allocation, latency, and scale

A routed IPv6 prefix would permit local allocation of one address per Instance,
with a corresponding AAAA record. Address allocation, routing, and DNS
publication are separate operations. Having one IPv6 address on the Host does
not imply having a prefix routed to it.

DNS has no mandatory propagation wait once authoritative servers serve a record.
Actual readiness depends on authoritative deployment and resolver caches.
Negative caching, including DNSSEC-synthesized denial, can delay access to newly
created names. Positive TTL is not a startup delay.

100,000 distinct names with one AAAA each is not prohibited by DNS. Provider
quotas, query rate, update rate, replication, and caching policy govern
practical capacity. A lookup returns the requested name's records, not the
entire zone. Prepublished mappings and synthesized authoritative answers were
considered as alternatives to per-creation DNS updates. No backend or allocation
scheme was selected or benchmarked.

Sources: [AAAA records](https://www.rfc-editor.org/rfc/rfc3596),
[negative caching](https://www.rfc-editor.org/rfc/rfc2308),
[aggressive DNSSEC caching](https://www.rfc-editor.org/rfc/rfc8198), and
[authoritative DNS operations](https://www.rfc-editor.org/rfc/rfc9199).

## Publication clarified the naming model

One hostname identifies an Instance across protocols:

```text
abc.drv.run -> Instance address
                  |
                  +-- :22  -> Guest SSH
                  +-- :443 -> published HTTPS service
                  `-- other explicitly published ports
```

The intended workflow is creation, application startup, publication, disconnect,
and subsequent public access at `https://abc.drv.run`. The example
`localhost:443` was illustrative, not a loopback-binding requirement.

HTTP(S) can select backends using TLS SNI and HTTP authority on a shared
address; SSH cannot do the equivalent. Ordinary A/AAAA records do not select by
port, so using the same hostname requires coordinated address and port handling.
HTTPS could terminate in the Guest or at a Host proxy serving the Instance's
address. That choice remains open, as does HTTP-only versus arbitrary TCP/UDP
publication.

Separate website aliases are not a core requirement. CNAME aliases can be added
later, but TLS certificate coverage and HTTP virtual-host handling must also
accept the alias.

Sources: [TLS SNI](https://www.rfc-editor.org/rfc/rfc6066#section-3),
[HTTP authority](https://www.rfc-editor.org/rfc/rfc9110#section-7.2), and
[TLS service identity](https://www.rfc-editor.org/rfc/rfc9525#section-6.1).

## Configuration ownership: NixOS, not a publication database

The discussion distinguished durable intent from applied runtime resources. A
separate publication record/schema was proposed, then rejected in favor of using
NixOS configuration as the publication source of truth.

The final division is:

```text
Guest NixOS configuration          Host NixOS configuration
-------------------------         ------------------------
application systemd unit          public exposure policy
listener and dependencies         proxy and certificates, if used
service restart policy            public firewall / forwarding
```

Public exposure is not necessarily a property of the originating Flake. An
application can run privately until the owner requests Host-side publication.

Command-based authoring remains compatible with this model. An illustrative
`ssh drv.run publish abc` would authorize the request, update Host-controlled
Nix configuration, build and validate it, and activate the resulting generation.
This is an example, not a finalized publication command grammar.

Publication should survive Guest restart. Application supervision is a separate
Guest responsibility. Allocated identities, addresses, keys, and disks still
need state; rejecting a publication database does not eliminate state generally.

The implementation still needs an explicit writable Host configuration source,
build/activation entry point, and concurrency/failure handling. The repository
exports modules, not a deployed Host configuration. Current Flake handling
captures a development environment; Guest service declarations require
additional integration.

Sources: `flake.nix`, `nix/nixosModules/host/worker.sh`, and pinned nixpkgs
`nixos/modules/services/web-servers/nginx/default.nix`.

## Aside: rebuilding from inside the Guest

Guest-side `nixos-rebuild switch` is possible with configuration source,
tooling, a writable Nix store/database, activation privileges, and system
switching enabled. microvm.nix can disable switching as an optimization;
`system.switch.enable = true` overrides that default.

Live activation and next-boot selection are different:

```text
Guest rebuild -> running Guest userspace and services
Host runner   -> boot kernel, initrd, and initial NixOS generation
```

A Guest rebuild does not automatically update the Host runner. Preserving the
Guest's selected generation across restart requires boot/deployment
coordination; persistent `/nix` alone is insufficient. Host publication and VM
hardware remain Host-controlled.

Sources: pinned microvm.nix `nixos-modules/microvm/optimization.nix`,
`nixos-modules/microvm/system.nix`, and `lib/runners/cloud-hypervisor.nix`.

## Remaining implementation boundaries

- Choose the hypervisor and whether to adopt upstream's Host lifecycle.
- Establish address availability and IPv4/IPv6 Client requirements.
- Choose DNS allocation/publication and public ingress mechanisms.
- Define Host Nix configuration editing, validation, activation, and rollback.
- Define how the input Flake supplies Guest application service configuration.
- Separate stop/restart from destroy and preserve Instance identity accordingly.
- Coordinate Guest-side activation with Host-controlled boot generations.
- Add actual Guest boot, provisioning, reconnect, publication, and restart
  tests.

The current cleanup deletes the disk cache and runtime credentials on stop. The
current `host-basic` test does not start a Guest. These are implementation gaps,
not properties of the proposed model.

Sources: `nix/nixosModules/host/default.nix`, `nix/nixosTests/host-basic.nix`,
and [[docs/architecture.md]].

## Pinned evidence used

- microvm.nix revision `187b0a390ee054028106a674e7b01b1cb940cbba`, from
  `flake.lock`; local source:
  `/nix/store/qcpqkk0i9jlaz11jsb6n956b15xsixn4-source`.
- nixpkgs revision `a32edd7654519351e48e80372a928df336394670`, from
  `flake.lock`; local source:
  `/nix/store/bqck1hypy8j3l922lf781qknmcxjv5a0-source`.
- OpenSSH 10.5p1 manuals:
  `/nix/store/lz43srhib9zixm2w65kc7mwb9pfg1lrm-openssh-10.5p1-man`.
- systemd 261.2 manuals, including `systemd.exec(5)` directory lifetimes:
  `/nix/store/848v7fr5jv4kb26a3jkfbiwds86rjf37-systemd-261.2-man`.
