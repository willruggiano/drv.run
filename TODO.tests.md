# TODOs specifically related to testing

**Both tests contain worthwhile coverage, but `host-basic` is heavily
over-specified.** Much of it checks implementation details, repeats
successful-launch evidence, or tests upstream behavior.

I reviewed both project-owned NixOS tests—`host-basic.nix` (761 lines) and
`pi-serve.nix` (190 lines)—against the modules and launcher/provisioning
scripts. These are the only NixOS tests wired into this checkout. The
`microvm.nix` submodule directory is empty; upstream tests were unavailable.

Below, **good** means retain the coverage; **garbage** means delete that code or
replace it with substantially smaller coverage. Fixture/setup code inherits the
classification of the tests it supports.

## `tests/nixos/host-basic.nix`

### 1. Good tests (host-basic)

| Lines            | Coverage worth keeping                                                                                                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 285–296          | Empty SSH requests do not create instances; malformed requests are rejected without executing injected commands. Run the parser cases as **one owner**, not both.                         |
| 298–300          | Root retains ordinary SSH behavior. This checks the project’s generated `Match User`/`ForceCommand` boundary, not merely SSH.                                                             |
| 302–313          | Root CLI request validation and no accidental creation. The table is reasonably compact and tests `cli.sh`, although parser cases need not require a full nested-VM test.                 |
| 315–332          | Launch through the public SSH interface; discover the resulting instance. This is the core smoke test.                                                                                    |
| 335–338, 343–346 | Private generated state/credentials and an unprivileged VMM. Keep one ownership/security check per distinct invariant, not every incidental file.                                         |
| 369–373          | Listing a running instance does not restart it. Keep the unchanged-PID assertion; the additional active-unit and workspace checks are redundant.                                          |
| 375–378, 390–391 | Reconnect through generated SSH configuration; terminal/environment propagation, guest identity, command failure. Consolidate with command-forwarding coverage.                           |
| 414–428          | Captured environment registration, rejected registration requests, and survival through guest GC. This exercises custom provisioning and `guest.sh`.                                      |
| 456–497          | Command forwarding: exit status, stdin, quoting, working directory, PTY/non-PTY behavior, option injection, and local invocation. These are real launcher contracts.                      |
| 517–539          | Failed evaluation does not publish ready state or leave allocated resources; listing does not retry it. Rechecking state **after listing** is meaningful, not redundant.                  |
| 542–558          | Failed disk/runner preparation preserves existing objects and does not publish ready state. Different failure points in custom `pre.sh`; legitimate coverage.                             |
| 561–570          | Cross-owner isolation through generated SSH configuration and the private VSOCK socket. Retain representative secret-access and connection checks, not a file-by-file permissions survey. |
| 572–581          | Guest DNS/egress and observable source NAT. One successful request plus its observed source address covers the integration.                                                               |
| 586–602          | Project firewall policy: blocked destinations, host access, unsolicited ingress, and behavior after nftables reload. Positive listener controls are necessary, not garbage.               |
| 604–615          | Source-spoofing and IPv6 policy. Counter changes help establish that the project’s filter rejected traffic rather than an unrelated connection failure.                                   |
| 617–637          | Independent instances for different owners; bidirectional guest isolation. Keep successful peer connectivity before negative checks.                                                      |
| 643–659          | Root management selects the correct owner, refuses destructive cleaning of live state, and cannot be invoked as another owner.                                                            |
| 668–671, 677–707 | Stop/restart preserves declared state and captured environment, discards ephemeral state, preserves host identity, rotates client credentials, and leaves the other instance working.     |
| 710–714          | Failed `exec` releases resources allocated by custom `tap.c`.                                                                                                                             |
| 716–727          | Provisioning failure releases runtime resources. Distinct from evaluation failure: this exercises `ExecStartPost` failure after guest startup.                                            |
| 729–744, 746–747 | VMM crash cleanup, restart, and stopping all owners without deleting retained state.                                                                                                      |
| 749–759          | Cleaning unloaded instances, owner selection, and idempotent cleanup. Actual `cli.sh` behavior.                                                                                           |

There is useful coverage here beyond `ssh … exit`: chiefly **isolation,
lifecycle failure paths, environment capture, and management selection**. Those
are project behavior, even when implemented using systemd or nftables.

### 2. Garbage (host-basic)

| Lines                                | Why                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 267                                  | Checking that `dhcpcd` is inactive tests the chosen NixOS network configuration, not guest functionality. Egress supplies better evidence.                                                                                                                                                                                         |
| 274–284                              | Unit-file existence, absence of a historical `drvrun` account/group, disabled-user creation, linger files, user buses, and KVM permissions. Successful owner launches subsume the prerequisites. Linger/KVM membership are also enforced by module assertions. Keep only synchronization actually needed by subsequent operations. |
| 286–287                              | Checking a particular systemctl “no matching unit” exit status is unnecessary when durable-state absence already checks non-creation.                                                                                                                                                                                              |
| 288–295 repeated for both users      | Identical parser coverage twice. Owner selection is exercised elsewhere.                                                                                                                                                                                                                                                           |
| 333–334, 339–342                     | Repeated active/ownership evidence and absence of old socket/path names. These pin internal layout without adding a useful behavioral guarantee.                                                                                                                                                                                   |
| 347–356                              | Namespace-FD introspection and exact CH network count, queue count, and CID. Egress/resource cleanup cover the custom FD plumbing. Exact constants are not useful runtime coverage.                                                                                                                                                |
| 358–367                              | Nix version and settings inventory. This mostly checks `nix.package`/`nix.settings` plumbing. Host sandbox configuration is already asserted. Nothing here actually tests build sandbox behavior.                                                                                                                                  |
| 377, 379                             | Whole-system health and immediately rereading files just written. The later reboot/persistence test supplies meaningful coverage.                                                                                                                                                                                                  |
| 380–388                              | Enumerating SSH units, interfaces, seed mounts, and credential copies. Successful authenticated connection already exercises credential delivery. Keep, at most, the separate **no TCP SSH listener** security invariant; discard the rest.                                                                                        |
| 389                                  | Another active-unit assertion after successful guest commands.                                                                                                                                                                                                                                                                     |
| 393–412                              | The elaborate extra-module fixture mostly tests NixOS package installation, `/etc`, tmpfiles copying/modes/idempotence, and impermanence. Replace with one guest-specific marker demonstrating that `extraModules` reaches the guest, not the host.                                                                                |
| 415–416                              | Absence of old environment paths and exact profile symlink layout. Successful captured-environment use and GC survival are stronger.                                                                                                                                                                                               |
| 418 versus 428                       | The full environment assertion before GC repeats setup evidence. Assert usability after GC. Keep the unrooted-object control: it proves GC actually removed something.                                                                                                                                                             |
| 430–454                              | A 256-connection VSOCK transport regression test. It directly tests upstream VSOCK/CH behavior, not drv.run’s notification handling. Repeated successful launches already exercise the integration.                                                                                                                                |
| 461–466                              | Repeated UID/environment/package assertions within the forwarding probe. Retain only those not covered by the consolidated launch/environment test.                                                                                                                                                                                |
| 473–474, 507                         | Testing shell pipelines/`tee`, then checking the same resulting file again through another connection. The stdin/argv probe already demonstrates command preservation.                                                                                                                                                             |
| 498–505, 508–513 on every matrix row | Every command case repeats instance inventory, liveness, reference contents, host/client marker checks, and cleanup assertions. Discover and clean instances as necessary; assert lifecycle/reference behavior once. Check injection markers only for relevant cases.                                                              |
| 514–515, 540, 559                    | Repeated “original instance still works” checks after cases that have not exercised a distinct cross-instance resource boundary.                                                                                                                                                                                                   |
| 529, 554                             | `MainPID == 0` adds little after failed startup plus no runtime resources/no ready state.                                                                                                                                                                                                                                          |
| 573, 575, 579, 582–584               | Exact TAP count/owner/subnet size, guest address matching host neighbor state, and BPF directory existence. Mostly upstream implementation/configuration inspection.                                                                                                                                                               |
| 629, 633                             | Additional TAP count and ownership assertions; actual two-owner operation and isolation are stronger.                                                                                                                                                                                                                              |
| 638–641                              | `TUNSETIFF` permission enforcement is a kernel/nsresourced test. drv.run does not implement that authorization.                                                                                                                                                                                                                    |
| 661–666                              | The helper explicitly supplies strict host-key checking and explicit identities, then tests OpenSSH rejects wrong keys. It bypasses the generated client policy whose correctness would matter.                                                                                                                                    |
| 672–676                              | Filesystem checking and mounting the stopped disk to inspect exact profile links. Successful restart **alone** cannot prove pre-provisioning rooting, but this code still only checks links, not a live GC root. If that invariant matters, use a focused state/rooting test rather than this disk inspection.                     |
| 695                                  | Whole-system health again. Assert the required state, not every guest unit’s health.                                                                                                                                                                                                                                               |
| 708, 745                             | Repeated `e2fsck`: testing filesystem integrity is not meaningful additional project coverage here.                                                                                                                                                                                                                                |

**Important distinction:** checking the old client key fails after restart, at
703, is worth keeping. Unlike the generic wrong-key test, it checks the
project’s credential lifecycle.

## `tests/nixos/pi-serve.nix`

### 1. Good tests (pi-serve)

| Lines                 | Coverage worth keeping                                                                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 68–69, 135–145        | Public module works without the project overlay; configured owner serves the application; another user cannot activate it. Keep one external HTTP readiness check and one explicit observer-start rejection. |
| 149–157               | Creating a real guest is necessary fixture setup for the pi integration.                                                                                                                                     |
| 161–164               | The service discovers the owner’s actual running instance. This checks integration between service environment and durable instance inventory.                                                               |
| 24–53, 59–62, 183–186 | A real host-side session sends a tool through `pi-env` into the guest’s captured flake environment; the resulting file exists in the guest, not the host. This is the valuable end-to-end test.              |
| 188                   | Necessary cleanup.                                                                                                                                                                                           |

### 2. Garbage (pi-serve)

| Lines                | Why                                                                                                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 129–133              | Excess prerequisite polling. Retain only waits required to avoid setup races; service/HTTP readiness already establishes most of this.                                                                 |
| 138                  | Checking the user unit file exists after successfully starting the service.                                                                                                                            |
| 139 and 141 together | The explicit observer start followed by inactivity is sufficient; the preliminary inactivity check repeats the condition.                                                                              |
| 142 plus 145         | Local and LAN requests both check basic availability. The LAN request is stronger for this module’s binding contract.                                                                                  |
| 146–147              | Package contents and `environment.systemPackages` installation. Not VM tests.                                                                                                                          |
| 158–159              | Active guest unit and environment marker checks before the actual tool test, which requires both to work.                                                                                              |
| 165                  | Empty session catalog in a fresh fixture. Not additional NixOS integration coverage.                                                                                                                   |
| 166–175              | User-service process UID, injected `PI_OFFLINE` in `/proc`, PID replacement after restart, and UID again. Primarily systemd semantics and explicit fixture configuration.                              |
| 176–180              | Stop/start and HTTP availability exercise ordinary systemd service lifecycle, not custom application recovery.                                                                                         |
| 54–58                | Idle task count, exact history result count, error flag, and faux-provider call count. The resulting guest file proves the integration. Session bookkeeping belongs in the existing application tests. |

Stopping `pi.service` at 181 is defensible fixture setup. It also reveals a
coverage boundary: **the final end-to-end probe instantiates `Sessions`
directly; it does not exercise the running HTTP service.** Do not describe that
block as HTTP-to-guest coverage.

## What the reduced suite should look like

1. **Launch:** `ssh host <flake> exit`.
2. **Environment:** one command checks a captured variable, shell hook, and
   flake-only executable; verify survival after GC and restart without the
   original flake.
3. **Forwarding:** compact cases for stdin/quoting, nonzero exit, PTY, and
   injection rejection.
4. **Lifecycle:** creation failure, provisioning failure, crash, stop/restart,
   clean, and owner selection.
5. **Isolation:** second owner, protected connection material, egress, and
   project firewall boundaries.
6. **Pi:** external HTTP readiness/catalog plus one real guest tool execution.

The largest missing coverage is also the area you highlighted: **both fixtures
expose only a default `devShell`**. The large assertion count does not establish
other flake-selection behavior or an actual build-environment invariant.

No files changed; this was a static review, not a test run.
