# What infrastructure interfaces should components consume?

- Label: `wayfinder:grilling`
- Mode: HITL
- Status: closed
- Assignee: Pi (infrastructure-contract discussion)
- Blocked by: [[tasks/010-retained-workflows.md]]
- Map: [[TASKS.md]]

## Question

What minimal drv.run interfaces and package-owned service configuration let the
retained components compose without placing application policy back in core?

Settle:

- How PDS receives local or SSH execution targets without requiring drv.run's
  private runtime-directory layout or taking ownership of VM lifecycle.
- How notification collection and mitm provisioning obtain owner-bound guest
  identity, lifecycle information, and seed material without core importing
  their implementations. Push retains host-initiated SSH collection and
  host-selected owner binding; see [[tasks/040-notification-contract.md]]. Do
  not presume a general plugin or event system is needed.
- Which configuration belongs to core, package service exports, and rock5b
  wiring. Include package selection, state/runtime paths, service identity, and
  externally supplied endpoints; leave component protocol details to their own
  tickets. OAuth configuration remains Nix-owned; runtime UIs operate flows, not
  account configuration CRUD. Adding account declarations requires deployment;
  see [[tasks/030-credential-contract.md]]. Keep provisioned secret references
  separate from generated credentials. Account for PDS's shared owner-local
  `auth.json` path and service access without an accounts dependency for model
  authentication; see [[tasks/030-credential-contract.md]]. Application HTTP
  exposure remains Tailscale/LAN-only, with authn/authz deferred under
  [[tasks/000-foundation.md]]; do not add public exposure or an authentication
  gateway requirement.
- What external-origin and path-prefix configuration allows a deployment HTTP
  router to compose PDS, the independent accounts UI, and push's registration
  PWA without one application owning another's frontend. Account for links,
  assets, OAuth callbacks, and push's narrowly scoped service worker under the
  configured routing; see [[tasks/040-notification-contract.md]]. The user's
  `/`, `/accounts`, and nginx examples are illustrative, not selected routes or
  software; see [[tasks/030-credential-contract.md]]. A shared origin is
  permitted, not required.
- Which exports are service-class modules and which are ordinary NixOS modules
  configuring user services. Define explicit import scopes rather than hiding
  both behind an ambiguous adapter.
- How bare drv.run and standalone component configurations avoid pulling in
  legacy application closures, including generated agent context and development
  tooling.

The answer should name the interfaces and their owners. Implementing hooks,
rewriting modules, and moving files belong after the map.

## Resolution

Confirmed by the user across the SSH, environment-source, and remaining
infrastructure discussions. The final agreement uses `services.host` and
`services.guest` without scope prefixes in export names. These are contracts for
subsequent specification, not implemented behavior or permission to deploy.

### Compose through OpenSSH's normal configuration

- The user requires `host` to be the only required public SSH connection option.
  User selection can come from SSH configuration; an application-level user
  override is not required by this decision.
- Deployment places configuration where OpenSSH reads it normally, using native
  `Host`/`Include` rules for dynamic instance configuration. Key paths,
  known-hosts files, connection snippets, and the VSOCK route remain deployment
  details. PDS and push must neither reconstruct those paths nor require them in
  target configuration. Publishing the paths in a different discovery record is
  not the selected separation.
- Apply the same principle in the guest. `ssh_config` configures outgoing SSH;
  `sshd_config` configures the SSH server. Deployment provisions host keys and
  authorized keys in the locations selected by normal SSH configuration, with
  appropriate ownership and permissions, rather than requiring applications or
  bespoke daemon arguments to supply those locations.
- The user permits patching pi-env to support this boundary. The selected PDS
  integration must let OpenSSH resolve deployment-owned connection and trust
  settings, rather than forcing an application-owned known-hosts path or
  host-key alias. This is not permission to disable host-key verification, and
  it does not initiate implementation during the map.
- Discovery of available guest identities and their lifecycle is separate from
  establishing an SSH connection. It must not expose deployment-specific
  connection-file paths as application options.

### Discover drv.run instances through an optional PDS environment source

- An environment source supplies selectable environments and resolves their
  identities. An execution environment implements execution and filesystem
  operations for a selected environment. Keep these responsibilities distinct.
- Deployment registers an optional drv.run environment source with PDS. This is
  the narrowly scoped integration that populates the frontend environment
  selector; generic PDS execution must not depend on drv.run.
- Extend the existing drv.run CLI with machine-readable, unprivileged inventory
  scoped to the calling host Unix owner. The PDS source translates that
  inventory into environments. Do not parse human-formatted output or add an API
  daemon for this purpose. Exact command syntax and record schema belong in the
  specification.
- Use a small PDS extension interface around its existing environment callback,
  not a change to pi-durable's extension registry just to populate the selector.
  The drv.run source reuses the SSH execution environment and the
  deployment-owned OpenSSH configuration; it does not implement another
  transport.
- The source is read-only. It discovers available instances but does not create,
  start, stop, or delete them. A saved selection that becomes unavailable
  remains identifiable; it must never silently switch to local execution.
- Push can independently consume the same drv.run inventory. It must not depend
  on PDS or its environment-source interface.

### Readiness and discovery failures

- Inventory distinguishes retained instances from ready instances. Only ready
  instances are selectable. Ready means guest provisioning completed; it does
  not guarantee that the next SSH connection succeeds.
- An ordinary instance restart preserves its identity and saved PDS selection.
  An unavailable selection remains identifiable under the source contract above.
- Discovery errors must be visible and distinct from an empty inventory. Failure
  of the drv.run source must not make other environment sources unusable.

### Guest-file integration through systemd

User-confirmed revision during ticket 03 design: integrations produce canonical
filesystem trees through native systemd units, rather than file mappings.

- A file-producing integration is a per-instance oneshot unit in the host
  owner's user manager. Package/deployment modules compose these units through
  native NixOS options. Core exposes lifecycle phases, not an executable-hook
  dispatcher, integration registry, or file-mapping option tree.
- Each producer declares one `RuntimeDirectory` at
  `drv.run/%i/inputs/<integration>`. Its contents are exclusively guest-facing,
  with paths relative to guest `/`: `root/.config/gh/hosts.yml` becomes
  `/root/.config/gh/hosts.yml`. Host-only keys, sockets, and control files stay
  outside these output roots.
- Core's assembler enumerates immediate child directories of
  `%t/drv.run/%i/inputs`, merges their trees, and publishes a per-start
  snapshot. This directory convention identifies inputs; systemd does not
  automatically supply dependencies' runtime directories. Core does not
  interpret component formats or query arbitrary units to discover outputs.
- The assembly unit requires and orders itself after each configured producer
  with `Requires=` and `After=`. Directory presence and `Before=` alone are not
  readiness. Producers must fail on missing or unreadable mandatory inputs;
  required preparation or assembly failure prevents guest startup.
- Core-managed guest files participate in the same tree assembly. Shared
  directories may merge, but competing files, file/directory conflicts, and
  overwrites of core-managed material must fail. Assembly must not follow links
  outside its input trees or leak host-only material into the guest.
- The lifecycle must provide fresh inputs for every activation, retain outputs
  until their consumers finish, and clean up after stop, failure, and
  cancellation. Restart and failed-start retry must not reuse stale outputs.
  Normal guest persistence and instance identity remain unchanged.
- Integrations own generation and canonical paths; core owns guest ownership,
  publication, and transport. Integrations do not depend on an image format or
  application-specific guest search paths. Changing live producer state does not
  mutate a running guest's snapshot; applying changes requires a restart.
- Mitm owns capability generation and guest configuration. Its per-instance
  producer is distinct from the shared proxy service; stopping a guest must not
  stop that service. Upstream OAuth credentials and private CA keys remain
  host-only.

Ticket 03 implements this contract in [[nixosModules/host/default.nix]],
[[packages/guest-files/main.py]], and [[nixosModules/guest/files.nix]].
Readiness follows:

```text
drv.run-prepare@I -> core/integration producers -> drv.run-image@I -> drv.run@I
```

Each arrow requires both `Requires=` and `After=` on the consumer. Preparatory
units remain active while needed, stop with the instance through `PartOf=`, and
use `StopWhenUnneeded=` for failed or cancelled activation. Owner applicability
may use `ConditionUser=`; it must not replace mandatory-file checks for a
configured owner.

The concrete file policy is:

- Accept regular files and directories. Reject symlinks, hardlinks, special
  nodes, special permission bits, and extended attributes.
- Reject duplicate files even when their bytes match, file/directory conflicts,
  and inconsistent modes on shared directories.
- Preserve bytes and ordinary permission bits; normalize guest UID/GID to root.
  Producer-root metadata does not configure guest `/`, which remains `0755`.
- Reject destinations hidden by guest mounts, managed `environment.etc` targets,
  and the fixed system paths enumerated by the host units. These are internal
  transport exclusions, not an integration mapping interface.
- Publish an owner-private `0600` artifact without replacing an existing output.
  Keep environment metadata separate from the canonical payload. This slice uses
  EROFS beneath a fresh, writable root OverlayFS; persisted guest mounts remain
  separate.

[[nix/nixosTests/guest-files.nix]] uses real owner managers and assembly with a
dummy guest process. [[nix/nixosTests/guest-files-boot.nix]] uses the production
root/environment modules and native SSH across two boots. These do not establish
Cloud Hypervisor/VSOCK or deployment acceptance. [[tests/nixos/mitm-proxy.nix]]
remains blocked at test-driver bootstrap before its assertions. Deployment
remains unauthorized.

### Package-owned service modules and deployment wiring

Export modules through each package's `passthru.services`, with these roles:

| Component                  | Export           | Import scope                     | Service identity                        |
| -------------------------- | ---------------- | -------------------------------- | --------------------------------------- |
| PDS, accounts, host push   | `services.host`  | Host NixOS `imports`             | Host owner's user manager               |
| Guest notification adapter | `services.guest` | Guest NixOS `imports`            | Guest root's user manager               |
| Shared mitm proxy          | `services.host`  | `system.services.<name>.imports` | System manager, dedicated service user  |
| Mitm guest configuration   | `services.guest` | Guest NixOS `imports`            | Guest configuration, not another daemon |

- Put modules in their native import scopes. Use normal module-class and option
  checking rather than encoding scope in export names or adding an adapter or
  custom validator. Service-class modules use `_class = "service"`; NixOS
  modules belong to the `nixos` class.
- Package-owned modules configure their services. Retain the package-local
  module and lexical dependency rules in [[tasks/000-foundation.md]]. Rock5b
  selects and composes packages, users, provisioned secrets, endpoints, and
  cross-component wiring; it does not move application policy into core.
- Owner-bound service state and runtime access follow the host Unix ownership
  boundary. PDS accesses the owner's shared Pi credentials under
  [[tasks/030-credential-contract.md]], independently of accounts and mitm.
- Apply the infrastructure-only foundation to module imports, generated agent
  context, and development tooling as well as executable dependencies. Bare
  drv.run must not acquire legacy application closures through those paths.
  Concrete extraction and retirement proof obligations belong in
  [[tasks/060-retirement-gates.md]].

### Explicit public HTTP base URLs

- Each HTTP application receives a listening endpoint and a separate public base
  URL, including its path prefix.
- Deployment owns TLS and routing. The router preserves the configured prefix
  when forwarding and does not rewrite HTML.
- Applications own prefix-correct links, assets, SSE endpoints, and supported
  OAuth callbacks. Push confines its service worker to its assigned prefix.
- Router software, concrete routes, and a shared origin are not prescribed.
  Retain the Tailscale/LAN-only exposure boundary and deferred HTTP authn/authz
  from [[tasks/000-foundation.md]].

## Evidence

- [Host module and application coupling](../nixosModules/host/default.nix).
- The pinned systemd 262 manuals define dependency ordering and failure
  propagation (`systemd.unit(5)`), oneshot completion (`systemd.service(5)`),
  and per-unit runtime directories (`systemd.exec(5)`). Read them with
  `man -M /nix/store/mixa7a98zj24d03lc9br2h2zpwsxllmr-systemd-262-man/share/man`.
  The [upstream runtime-directory test][runtime-directory-test] checks retention
  with `RemainAfterExit=yes` and removal on stop, not the proposed drv.run
  graph.
- [Guest seed and SSH identity publication](../nixosModules/host/pre.sh) and
  [provisioning completion](../nixosModules/host/post.sh).
- [Owner-local inventory](../nixosModules/host/command.sh) and
  [administrative CLI](../nixosModules/host/cli.sh) already report retained
  instances and systemd state, currently as human-formatted text.
- [Guest core context](../nixosModules/guest/default.nix).
- [Mitm deployment](../nixosModules/host/mitm-proxy.nix) and
  [guest configuration](../nixosModules/guest/mitm-proxy.nix).
- [Notification deployment](../nixosModules/guest/notifications.nix) and
  [legacy frontend service](../nixosModules/pi.nix).
- [PDS environment discovery](../packages/pds/src/application.ts) currently
  reconstructs connection-file paths. The [SSH wrapper][pds-ssh] delegates to
  pi-env 1.5.2, whose [SSH implementation][pi-env-ssh] requires an explicit
  known-hosts file and host-key alias and passes them as SSH command-line
  options. Those are current integration constraints, not the selected public
  contract.
- [PDS's environment callback](../packages/pds/src/application.ts) already
  supplies [the selector](../packages/pds/src/render.ts). In pi-durable 1.5.2's
  [interfaces][pi-durable-types], `Extension` registers harness code, while
  `HarnessOptions.env` separately supplies the execution-environment factory.
- [PDS HTTP configuration](../packages/pds/src/index.ts) currently keeps only
  the URL origin; [routing](../packages/pds/src/server.ts) uses root-relative
  paths. Prefix support is a selected requirement, not existing behavior.
- The pinned [module evaluator][module-evaluator] rejects declared `_class`
  mismatches; unclassified modules still face option checking in their import
  scope. [Service submodules][service-submodules] use class `service`, whereas
  [NixOS evaluation][nixos-evaluation] uses class `nixos`. The export name does
  not determine either class.
- [Package composition](../packages/default.nix), [flake](../flake.nix), and
  [rock5b composition](../examples/rock5b/flake.nix).

Verify modular-service behavior against the pinned nixpkgs sources, not current
online documentation:

- `/nix/store/5kch26ml22zg5gx0gym9nff7j5rificm-source/nixos/doc/manual/development/modular-services.md`
- `/nix/store/5kch26ml22zg5gx0gym9nff7j5rificm-source/nixos/modules/system/service/README.md`

[runtime-directory-test]:
  /nix/store/hgvj3r5rf0hxx242vx92z8p6a0bzr3zf-source/test/units/TEST-23-UNIT-FILE.RuntimeDirectory.sh
[pds-ssh]: ../packages/durable/harness/src/env.ts
[pi-env-ssh]: https://unpkg.com/@earendil-works/pi-env@1.5.2/dist/ssh.js
[pi-durable-types]:
  /nix/store/66k268i56xwl405b3hnz6l84mgb4fl8c-pds-0.1.0/lib/pds/node_modules/@earendil-works/pi-durable/dist/harness/types.d.ts
[module-evaluator]:
  /nix/store/5kch26ml22zg5gx0gym9nff7j5rificm-source/lib/modules.nix
[service-submodules]:
  /nix/store/5kch26ml22zg5gx0gym9nff7j5rificm-source/lib/services/lib.nix
[nixos-evaluation]:
  /nix/store/5kch26ml22zg5gx0gym9nff7j5rificm-source/nixos/lib/eval-config-minimal.nix
