# Reusable environment images

Status: proposed. This specification does not describe implemented behavior.

## Decision

Package each prepared flake closure as a Nix-built, read-only EROFS image. Reuse
that artifact across instances. Keep the generic guest image and each instance's
writable store, workspace, credentials, and Nix database separate.

Nix owns artifact identity, local reuse, substitution, build scheduling, and GC.
drv.run owns the image derivation, instance integration, and retention policy.
There is no separate cache index, custom content hash, or branch-to-image cache.

The target workflow is repeated development on a small set of projects and fresh
CI instances using the same dependencies. An existing environment must not incur
another full host-to-guest NAR export and import for each instance.

The motivating session copied 499 paths, approximately 2.99 GiB, in
approximately 303 seconds. This is a baseline observation, not a performance
guarantee or a conclusive diagnosis of the underlying storage stalls.

## Scope

The first implementation provides:

- One complete environment image, independent of the generic guest closure.
- A generic runner that attaches an instance-selected image at a fixed filename.
- Private writable state for every instance, including fresh CI instances.
- Reuse and optional substitution through ordinary Nix derivations.
- Durable roots for images belonging to retained instances.

Out of scope:

- Toolchain layers, guest-closure subtraction, and cross-image deduplication.
- Updating the environment of an established instance in place.
- virtiofs, guest snapshots, lazy substitution, and custom cache services.
- Automatic prewarming, eviction policy, and GitHub Actions runner management.
- Skipping environment realization or building an image directly from a flake
  reference without first preparing its environment.

## Ownership and data flow

```text
flake reference
      |
      | Nix: print-dev-env, with an instance profile
      v
prepared environment E
      |
      | drv.run: instantiate pinned image derivation for E
      v
image derivation I(E)
      |
      | Nix: reuse locally / substitute / build
      v
rooted environment image
      |
      | drv.run: attach read-only, mount, register, root profile
      v
usable instance
```

### Resolve the environment

Retain the preparation operation in [the host worker](nixosModules/host/pre.sh).
It uses `nix print-dev-env --json --profile` with flake-provided configuration
acceptance disabled. The profile roots the prepared environment and its closure.

Resolve that profile to a concrete store path, E, after preparation succeeds.
Use E for image construction and guest profile creation. Do not evaluate the
original flake reference again during these operations.

Flake fetching, evaluation, substitution, and environment builds remain part of
preparation and must remain visible in timing reports. A mutable reference can
resolve to a different E on a later new-instance request. Restarting an existing
instance must use its recorded E without resolving the reference again.

### Realize the image

Add a pinned Nix function with the conceptual interface:

```nix
mkEnvironmentImage {
  environment = preparedEnvironment;
}
```

The worker invokes this function through a fixed host-side expression and asks
`nix build` to realize its result. Pass E as data, not interpolated Nix source.
Attach proper store dependency context to E, for example with
`builtins.storePath` in a narrowly scoped impure wrapper. This wrapper must not
reevaluate the user's flake impurely or select tools through an ambient
registry.

The derivation must depend only on E and the declared image-builder inputs:
pinned tools, builder code, image-format parameters, and target system. Do not
include instance IDs, workspace paths, credentials, timestamps, or the complete
drv.run source tree merely to locate the builder.

Nix performs the lookup as part of realization:

1. Reuse the valid output if it is already in the local store.
2. Otherwise substitute it from an authorized cache, if available.
3. Otherwise build it using the normal Nix build machinery.

Allow substitution. Do not inherit the existing microvm image builder's
`runCommandLocal` setting, which disables substitutes. Concurrent requests for
the same derivation on one host must use Nix's build coordination, not a new
application-level lock or cache service.

Changing E or an image-builder input changes the derivation identity. Equivalent
human descriptions do not imply equal store paths. In particular, a project
source change can change E even when most dependencies are unchanged. Measure
actual image reuse before introducing toolchain layers.

## Artifact contract

Use `pkgs.closureInfo { rootPaths = [ environment ]; }` to obtain the complete
closure and registration metadata. Do not implement dependency traversal or the
registration format in drv.run.

The derivation output contains `store.erofs`. Its filesystem contains:

```text
/
+-- store/          complete closure, using original store-path basenames
+-- registration    closureInfo registration data
+-- environment     exact prepared environment store path, newline terminated
```

Keeping metadata inside the same image binds it to the files being registered
and avoids increasing the credential seed image's payload.

Requirements:

- Preserve Nix file contents, symlinks, and executable bits. Do not rewrite
  absolute `/nix/store` references.
- Use deterministic filesystem metadata and a fixed label distinct from
  `nix-store` and `drv-run-seed`.
- Build directly from a read-only view of the closure. Do not first copy the
  entire closure into a staging directory.
- Include only the selected environment closure and required metadata. The image
  must not contain the host database, credentials, or unrelated paths.
- Validate the filesystem and its identity before publishing the derivation
  output. A successful build must produce a mountable image.
- Permit binary-cache publication under the host's existing trust policy.
  Publishing private source closures requires an appropriately private cache.

A complete image may duplicate paths already present in the generic guest image.
Accept that initially to keep its identity independent of the guest base. Do not
hide cold image construction or download time in a cache-hit measurement.

## Guest storage and registration

```text
host generic guest image ------> /nix/.ro-store -----------+
                                                         |
host environment image -------> /nix/.environment/store --+--> /nix/store
                                                         |
private state.img -------------> writable upper ----------+
```

Attach the environment image read-only at the hypervisor level, with host page
caching enabled. Keep the generic runner independent of E: the worker supplies a
runtime symlink to the rooted artifact's `store.erofs`.

Mount the environment image during the initrd, before mounting `/nix/store`. Use
stable device identity; adding a volume must not change which device backs
`/persist` or the credential seed. Update the host's exact-volume assertions.

Use the existing generic guest store as the higher-priority immutable lower
layer, followed by the environment's `store/` directory. Both sit below the
private writable upper layer. Overlapping valid store paths must denote the same
contents; do not silently repair conflicting paths during provisioning.

After the generic guest closure is registered, guest provisioning must:

1. Check that the image's environment equals the host's recorded E and that the
   required mounts are present.
2. Load the image's registration into the guest-private database with
   `nix-store --load-db`. Do not reimport NARs, rehash the entire closure, or
   recursively normalize metadata on the read-only files.
3. Establish the project profile for E using the existing prepared-environment
   mechanism, without reevaluating the original flake.
4. Acknowledge successful provisioning before the host publishes `client.conf`.

Registration and profile establishment must be safe to repeat on restart. Guest
GC must retain the project closure. Guest builds and additional packages remain
supported through the private writable store. No host Nix daemon socket or
writable host store is exposed.

Remove the full-closure copy from
[host provisioning](nixosModules/host/post.sh). Keep SSH for control operations;
do not replace the copy with a background copy or an automatic copy fallback.
Missing mounts or failed registration fail provisioning rather than publish a
partially usable instance.

## Lifecycle and retention

Before declaring durable instance resources prepared, the worker must have
successfully realized and rooted E, the runner, and the environment image.
Create the image root as part of realization, not after an unrooted interval.
Keep roots in the instance's existing state directory and recreate only runtime
symlinks on restart.

- Stopping an instance retains its environment, image, runner, and writable
  state.
- Restarting uses the pinned artifacts. It does not rebuild for a moving branch,
  swap lower layers, or reformat a missing established disk.
- Interrupted creation follows the existing explicit-cleanup policy. No
  incomplete instance becomes client-ready.
- Cleaning a stopped instance removes its roots through the existing state
  cleanup mechanism. It does not manually delete shared store objects.
- Nix GC can collect an image only after all roots retaining it are gone.
- Cancellation of one requester must not corrupt an image another instance uses.
  Failed builds must not publish an artifact or readiness.

No extra project-wide roots are introduced initially. Unreferenced images may
remain reusable until Nix GC collects them. A future prewarming policy would
retain additional roots; it would not implement another artifact cache.

Do not assume EROFS packing removes Nix-level references to the original
closure. The first version deliberately retains E as well as the image. Measure
storage amplification; reference suppression and compact retention are separate
work.

## Development and CI isolation

Interactive instances may retain their workspace and writable store. Fresh CI
instances share only immutable artifacts and start with independent writable
state. Never use another instance's workspace, credentials, runner registration,
agent state, or Nix database as a template.

This change enables efficient CI environments but does not create a runner
scheduler or define a security policy for untrusted pull-request jobs.

## Acceptance and measurement

### Correctness

Add focused derivation checks and a small NixOS integration test. Tests must
assert filesystem, database, profile, and lifecycle state, not log strings.
Cover:

- Identical inputs select the same image; changed environment or builder inputs
  select a different derivation. The runner remains independent of E.
- Symlinks, executable files, closure references, and registration survive image
  construction. The guest can execute a fixture dependency without copying it
  into the writable upper layer.
- A guest can build into its writable store while the environment disk remains
  immutable.
- Two instances share an image but cannot alter each other's writable state.
- Guest GC and host GC preserve the environment of running and stopped retained
  instances; cleaning one instance does not break another.
- Restart preserves the pinned environment and workspace.
- Missing or mismatched images, failed registration, and interrupted creation
  leave the instance unavailable to clients.
- Concurrent image requests and binary-cache substitution work without a
  drv.run-specific cache index.

Expose the focused integration test as a flake check. Do not use the prohibited
heavy `nixos-host-basic` run to validate this work. Follow [[CONTRIBUTING.md]]
for where Nix-dependent validation can run.

### Performance

The target is less than five seconds of incremental environment provisioning on
a local image hit: image lookup, additional mount work, registration, and
profile establishment. This is an acceptance target, not an existing result. The
hit path must not eagerly read, hash, or write the complete closure.

Benchmark fresh instances with the motivating environment or a recorded
comparable closure. Separate these cases:

- Image present locally, with warm and cold filesystem caches reported
  separately.
- Closure present locally but image absent.
- Image absent locally but available from a configured binary cache.
- Environment dependencies absent locally.

Record monotonic phase boundaries for request receipt, environment realization,
image realization, guest boot, image mounting, registration, profile readiness,
first successful shell command, and harness readiness when applicable. Report
end-to-end latency alongside phase timings; do not shift provisioning work into
boot or first access and count that as its removal.

Measure host and guest CPU, block writes, flush latency, and I/O pressure during
the same intervals. Also measure first use of Node, Python, and Chromium to
expose deferred I/O. Report repeated-run distributions, hardware, closure
identity, cache state, and competing workload. Benchmarks are not flake checks.

## Implementation sources

- Host preparation and lifecycle: [pre.sh](nixosModules/host/pre.sh),
  [post.sh](nixosModules/host/post.sh),
  [host module](nixosModules/host/default.nix), and
  [instance cleanup](nixosModules/host/cli.sh).
- Guest integration: [storage](nixosModules/guest/default.nix),
  [hypervisor configuration](nixosModules/guest/cloud-hypervisor.nix), and
  [prepared-environment entry](nixosModules/guest/guest.sh).
- Pinned microvm implementations:
  [image builder](https://github.com/willruggiano/microvm.nix/blob/3defb1d870b45d6545df1256e50330efbb504112/nixos-modules/microvm/store-disk.nix),
  [mounts](https://github.com/willruggiano/microvm.nix/blob/3defb1d870b45d6545df1256e50330efbb504112/nixos-modules/microvm/mounts.nix),
  and
  [runner](https://github.com/willruggiano/microvm.nix/blob/3defb1d870b45d6545df1256e50330efbb504112/lib/runners/cloud-hypervisor.nix).
- Pinned nixpkgs helpers:
  [closureInfo](https://github.com/NixOS/nixpkgs/blob/a32edd7654519351e48e80372a928df336394670/pkgs/build-support/closure-info.nix)
  and
  [trivial builders](https://github.com/NixOS/nixpkgs/blob/a32edd7654519351e48e80372a928df336394670/pkgs/build-support/trivial-builders/default.nix).
- Nix 2.35.2
  [database loading](https://github.com/NixOS/nix/blob/2.35.2/src/nix/nix-store/nix-store.cc):
  `opLoadDB` supplies hashes, skips canonicalization, and registers the supplied
  paths together.
