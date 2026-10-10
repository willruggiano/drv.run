# Time-to-shell optimization ideas

Research date: 2026-10-10. Checkout: `410df593b2ec9f65c108bdae25b4befbdfa062bd`.

**Start by revalidating the checkout, then attack guest initialization and
closure provisioning.** NixOS module evaluation is not on the current
per-instance path. This catalogue contains 130 experiment candidates, including
measurement work, conditional retries, and architectural alternatives; it is not
an implementation plan. No deployments or performance experiments were run for
this research.

## Reading the estimates

- **M**: measured in the archived experiments; not necessarily causal or
  current.
- **H**: hypothesis; any numerical range is an experiment budget, not a
  forecast.
- **Ceiling**: the measured time available in a phase, not achievable savings.
- **Unknown**: evidence supports the mechanism, not a defensible latency
  estimate.
- **Architecture**: changes lifecycle, storage, security assumptions, or
  supported environment semantics. Requires an explicit decision before
  implementation.
- **Cold**: distinguish cold flake metadata, absent host store paths, cold host
  page cache, fresh guest, and cold guest store. These are different conditions.

Gains overlap. Do not add them. A faster operation already hidden behind
parallel work need not improve launcher latency. Source links establish
mechanisms; archived measurements establish only their recorded workload and
configuration.

## Current path and evidence

See [[docs/architecture.md]] and [[docs/benchmarks.md]] for the lifecycle and
timing contract. Relevant implementations are
`nix/nixosModules/host/{worker,provision,launch}.sh`,
`nix/nixosModules/guest/{default.nix,cloud-hypervisor.nix,guest.sh}`, and the
checked-in `microvm.nix` submodule.

```text
Host deployment: evaluate guest NixOS -> build runner/kernel/initrd/store image
                                           |
Per fresh Instance:                        v
worker: [print-dev-env | root runner | keys + state filesystem]
        -> await jobs -> create seed filesystem
        -> TAP allocation -> runner -> Cloud Hypervisor
        -> kernel -> initrd -> activation -> systemd READY
        -> private SSH master -> nix copy -> validate/root environment
        -> close master -> publish client.conf
        -> final SSH -> nix develop -> bash -c exit
```

The packaged benchmark starts on the host. It excludes the client's outer SSH
handshake and deployment/build time. Its endpoint is command completion through
`nix develop`, not the first interactive prompt. Keep that series intact; add a
separate client-to-prompt series.

### Provenance and baseline warning

The original evidence is preserved in
`.auto/archive/autoresearch-evidence-20261010-164136Z.tar.gz`. Paths below
prefixed **archive:** are members of that archive, not files assumed to exist
beside this document. Read it without restoring old experiment state into the
working tree.

- **L1:** archive: `.auto/log.jsonl`, runs 2–32; original experiment ledger.
- **L2:** archive: `.auto/speed-log.jsonl`; intervening reliability/storage
  work.
- **L3:** archive: `.auto/script-phases/20261010-010250/summary.json`; three
  instrumented observations: environment preparation 0.236 s, runner rooting
  0.114 s, state filesystem 0.210 s, closure copy 0.884 s.
- **L4:** archive: `.auto/activation-profiles/20261010-001748/summary.json`;
  users 0.380 s, persistent-directory creation 0.210 s, `/etc` 0.110 s, special
  filesystems 0.060 s. These are older diagnostic measurements.
- **L5:** archive: `.auto/current-boot/20261010-091410/summary.json`; three late
  boot profiles: kernel 0.346–0.424 s, initrd 2.498–2.696 s, main userspace
  1.865–2.039 s, switch-root unit 0.773–1.001 s, main-stage udev trigger
  0.499–0.580 s, firewall 0.618–0.629 s. Unit durations overlap; switch-root and
  activation are not additive budgets.
- **L6:** archive: `.auto/prompt.md`, `.auto/ideas.md`,
  `.auto/phase-guest-analysis.log`, `.auto/store-image-sizes.txt`; context and
  earlier hypotheses. The prompt is stale relative to the later ledgers.
- **L7:** current git history, especially `77246f5`, `fff26ae`, `92727c9`,
  `54ab83e`, `64970f7`, `00cb47e`, `46be683`, `4f605cf`, `c7838c4`, `374497e`,
  `7ee9da8`, `11bfd90`, and `410df59`.

**Do not treat 8.08 s as a newly verified HEAD baseline.** L2 records an
uncompressed EROFS store, about 1.433 GB instead of 0.700 GB, retained before
the later ~8.08 s batches. Current `guest/default.nix` does not override
`storeDiskErofsFlags`; the checked-in microvm option defaults to LZ4HC, tail
packing, and fragments. The archive's uncompressed-image change is absent from
the current source. Reconcile deployed derivations and source archives before
comparing. The archive also has rewritten commit IDs that differ from current
history.

The last two archived batches contain seven successful measured launches each,
after warmup: 8.072/8.085 s launcher, 6.990 s activation, 0.419/0.444 s worker,
5.289/5.293 s boot wait, and 1.240/1.290 s provisioning. The roughly 1.08–1.09 s
outside activation includes launcher/final SSH/environment entry, not just SSH.
Independent phase medians need not sum exactly.

### What has already been tried

| Experiment                                                | Recorded outcome                                  | Current interpretation                                                   |
| --------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------ |
| Noninteractive journal console, `TERM=dumb`               | 12.632 -> 10.631 s; boot -2.00 s                  | Retained; do not rediscover. Interactive PTY behavior remains tested.    |
| Explicit console rows/columns                             | 10.753 s                                          | Rejected; no additional improvement.                                     |
| Private provisioning SSH master                           | Provision 1.834 -> 1.515 -> 1.321 s               | Retained. Explicit creation avoids a Nix auto-master handshake race.     |
| EROFS without fragments                                   | About -0.10 s total, essentially no boot change   | Weak evidence; removed by `64970f7`.                                     |
| Mount-event burst 5 -> 64                                 | About -0.94 s total, -1.06 s boot                 | Retained; finite rate limit remains.                                     |
| Mutable `/etc` overlay                                    | +1.06 s initially; no gain after burst fix        | Rejected twice. Retry only with materially different assumptions.        |
| Combined environment validation/profile rooting           | About -0.08 s provision, no total gain            | Rejected; changes validation/root-publication ordering.                  |
| Seed mount in initrd                                      | About -0.28 s total, -0.33 s boot                 | Retained.                                                                |
| Notification sender lifetime and orphan VSOCK reset fixes | Eliminated diagnosed readiness failure mechanisms | Correctness prerequisites, not speed knobs.                              |
| Buffered immutable store                                  | Reliable baseline 10.824/10.874 -> 8.894/8.881 s  | Retained; warm shared host page cache matters.                           |
| Uncompressed EROFS                                        | 8.590/8.492 s vs buffered compressed ~8.89 s      | Archived improvement ~0.30–0.40 s; missing from current configuration.   |
| Uncompressed initrd                                       | ARM `VmBoot InitramfsAddress`; x86 test passed    | Failed; no valid timing. Architecture-specific validation is essential.  |
| LZ4 instead of zstd initrd                                | 8.623 vs 8.316 s                                  | Rejected; no boot improvement.                                           |
| Environment preparation overlapped with initialization    | Worker ~0.76 -> 0.51–0.53 s                       | Retained.                                                                |
| Sparse-file `assume_storage_prezeroed=1`                  | Worker indistinguishable in alternating runs      | Retained but no causal latency win established. Fresh sparse files only. |
| Early root user manager                                   | Provision -0.21 s, boot +0.45 s; total worse      | Rejected; moved cost rather than removed it.                             |
| Concurrent runner rooting                                 | Worker ~0.535 -> 0.419–0.442 s                    | Retained; phase improvement reproduced.                                  |
| Main-stage udev workers capped at four                    | Final batches ~8.08 s                             | Retained; modest total gain, exact udev causality unproven.              |

The initial ledger's zero-valued crashes are not baselines. Run 5 duplicates run
4 for commit recovery. Some `discard` entries are unchanged replications, not
code reversions. Earlier batches with a readiness timeout cannot be scored from
their successful samples alone. These cautions come from L1/L2, not dashboard
summaries.

## The five requested references

### Seenix: closure analysis, not evaluation acceleration

[Seenix][seenix] walks narinfos, verifies signatures, and visualizes NAR
contents, files, ELF sections, and store references. It can consume
`nix path-info -r --json`. Use it to find closure bloat and unexpected
dependencies. Its lazy browser fetches are not a Nix evaluator optimization or a
production lazy store. No applicable TTS benchmark is documented. Follow its
reference to [nixpkgs-multiverse][multiverse], whose store-path index actually
implements a pre-resolved-package fast path.

### Fastpkgs: pre-resolved outputs

[Fastpkgs][fastpkgs] uses `nix-eval-jobs` offline to record cached output paths,
then reconstructs lightweight, context-carrying fake derivations from JSON.
`drvPath` deliberately throws; `.original` accesses the real package. It is WIP,
revision-specific, and dependent on cache availability. It cannot replace
arbitrary `mkShell`, overlays, derivation inspection, or source builds
transparently. The transferable idea is a verified environment-output index with
a real fallback, not replacing the host's nixpkgs wholesale. No numerical TTS
benchmark is supplied.

### PR 401751: explicit minimal module imports

[PR 401751][minimal-pr] is titled “nixosMinimal: init - nixos with minimal
modules.” The retrieved [API record][minimal-api] says open/unmerged, last
updated 2025-12-14; head `a1738af3b2b843842d6a81cca631553111c28eae`, three
files, 225 additions. Its [diff][minimal-diff] adds a curated 185-module list
and a minimal-system build test. It explicitly calls for dependency imports and
CI work. This is not the ordinary `profiles/minimal.nix` profile and has no
supplied latency benchmark.

The pinned nixpkgs already has experimental `lib.nixos.evalModules` via
`nixos/lib/eval-config-minimal.nix`, but does not contain the PR's
`nixos/modules/minimal.nix`. The [pinned implementation][minimal-eval] warns
that modules must be imported explicitly. Guest evaluation happens during
deployment; reducing it alone saves approximately zero current request-path
time.

### Modular services: composition first

The [manual][modular] describes service-class modules under
`system.services.<name>`, separating portable process/configuration definitions
from systemd-specific realization. The feature is new in 25.11 and still in
development. The manual itself calls evaluation benefits from extracting unused
service logic minor unless the approach becomes widespread. Read the
[contributor guide][modular-writing] before prototyping. It does not
automatically reduce the booted unit graph, replace NixOS, or cache
`print-dev-env`.

### Server-optimised NixOS: ideas, not a replacement distribution

The [README][server] explicitly calls this a playground and many features
vaporware. Inspecting [the flake][server-flake] and [base module][server-base]
matters: the current example imports ordinary `nixpkgs.lib.nixosSystem`, pins
the 24.05 branch, uses systemd initrd/repart/networkd, and disables wait-online.
The README's from-scratch ambition is not evidence that the current flake avoids
the whole NixOS module list. Several features already exist here through
microvm.

Useful directions: generated units, minimal pre-systemd work, image-based setup,
and explicit service dependencies. Do not copy its example password/emergency
access or virtiofs exposure. Its [activation notes][server-activation] concern
switching configurations; they are not a fresh-instance startup benchmark.

## A. Measurement and experiment design

### 001. Rebuild the performance baseline from exact source

Resolve the compressed/uncompressed-store discrepancy. Record the host system,
runner, image hash/flags, kernel, Nix, CH, and submodule revisions per batch.
**Gain:** no direct speedup; prevents optimizing against a different system.
**Evidence:** L1/L2/L7; [microvm image builder][microvm-image].

### 002. Add a separate client-to-interactive-prompt metric

Time outer SSH, both PTYs, shell hook, and a prompt-ready marker independently
of existing `launcher_s`. Preserve the old command-completion boundary.
**Gain:** measurement only; exposes latency currently excluded, especially WAN
RTT and interactive initialization. **Evidence:** [[docs/benchmarks.md]]; [Nix
develop implementation][develop], [OpenSSH client documentation][ssh-config].

### 003. Trace the whole critical path with one request identity

Add monotonic spans around source fetch, evaluation, realization, seed creation,
TAP, VMM entry, readiness, authentication, copy, validation, and shell
execution. Synchronize host/guest traces using explicit paired events, not raw
clock equality. **Gain:** measurement only; identifies whether work is serial or
hidden. **Evidence:** L3/L5; [systemd-analyze][analyze], [kernel boot
tracing][boot-trace].

### 004. Split closure-copy time into protocol and storage work

Measure validity queries, source NAR serialization, VSOCK transport, guest
unpack, hashing, SQLite registration, and fsync separately. A 0.884 s `nix copy`
span is not necessarily 0.884 s of byte transfer. **Gain:** measurement only;
provision ceiling ~1.29 s in late small-workload batches. **Evidence:** L3; [Nix
remote store][remote-store], [local store][local-store].

### 005. Profile Nix evaluation separately from realization

Use the version-supported sampling evaluator profiler and `NIX_SHOW_STATS`; pair
with process CPU/RSS and unprofiled timings. `print-dev-env` can fetch/build
too. **Gain:** measurement only; older warm preparation was only 0.236 s.
**Evidence:** L3; [Nix evaluation profiler][eval-profiler], [Nix
develop][develop].

### 006. Build an explicit cold/warm matrix

Separate absent source trees, absent Flake closures, cold host image cache,
fresh state disks, restarted Instances, and reconnects. Do not drop a production
host's page cache to simulate cold starts. **Gain:** measurement only;
distinguishes buffered-store wins from cold-I/O losses. **Evidence:** L2;
[microvm direct-I/O option][microvm-options], [Nix caches][nix-conf].

### 007. Use paired, interleaved A/B runs and retain failures

Randomize order, report every sample, and estimate uncertainty on paired deltas.
Seven samples support coarse medians, not a credible p99. Use more observations
before accepting tens-of-milliseconds changes. **Gain:** avoids false wins; no
direct latency reduction. **Evidence:** L1 runs 23–32; [hyperfine statistical
output][hyperfine].

### 008. Measure burst admission and resource saturation

Test simultaneous distinct and identical flakes; report queue time, memory, CPU,
I/O, and failure rate separately from service time. Existing serial warm results
cannot predict multi-instance behavior. **Gain:** measurement only;
prerequisites for tail-latency improvements. **Evidence:** [systemd resource
control][resource-control], [Nix settings][nix-conf].

### 009. Add representative workload classes

Include tiny shells, many small paths, large compiler/toolchain closures,
IFD-heavy evaluation, slow hooks, and uncached dependencies on both
architectures. Keep the original workload as the comparable primary series.
**Gain:** measurement only; prevents trading one workload's 0.1 s for another's
multi-second regression. **Evidence:** L6 larger-flake validation; [Nix
develop][develop], [cache benchmark scope][cache-shootout].

### 010. Trace kernel, scheduler, and filesystem faults only diagnostically

Use bootconfig/ftrace, initcall timing, perf, and block-I/O traces in separate
runs. Debug console output itself changes timing; `systemd-analyze blame` is not
a critical-path proof. **Gain:** measurement only; kernel ceiling ~0.35–0.42 s
in L5. **Evidence:** [boot tracing][boot-trace], [systemd-analyze
caveats][analyze].

## B. Flake evaluation and environment preparation

### 011. Cache the rooted prepared environment by immutable identity

Map a resolved flake/source identity, output, system, relevant configuration,
and Nix version to the real `*-env` output and GC-rooted closure. Never key only
on a mutable branch or `flake.lock`: root-flake content can change without the
lock. **Gain:** H, up to preparation cost on hits; warm L3 ceiling 0.236 s
before overlap. Cold evaluation may save seconds. **Evidence:**
[nix-direnv][nix-direnv], [develop].

### 012. Deduplicate simultaneous environment preparation

Single-flight identical cache misses per owner/security domain. Preserve shared
work when one client disconnects; publish only complete validated outputs.
**Gain:** H, little for a serial request; potentially large under duplicate
bursts. **Evidence:** [Nix store realization][local-store], [nix-direnv
caching][nix-direnv].

### 013. Precompute environments on repository updates

An opt-in builder resolves, evaluates, realizes, and roots selected locked Flake
closures before login. Keep arbitrary-flake fallback and bounded retention.
**Gain:** H, removes most cold evaluation/build/download wait on hits,
potentially seconds to minutes; shifts work rather than eliminates it.
**Architecture.** **Evidence:** [nix-eval-jobs][eval-jobs], [fastpkgs].

### 014. Preserve and inspect Nix's existing flake evaluation cache

Verify stable owner/HOME/XDG cache location, purity, enabled `eval-cache`, and
cache hits before adding another cache. Avoid accidental per-request cache dirs.
**Gain:** H, zero if already hitting; up to repeated output evaluation
otherwise. Intermediate expressions are not all cached. **Evidence:** [Nix
settings][nix-conf], [flake evaluation cache source][eval-cache].

### 015. Minimize mutable-reference resolution on repeat requests

Resolve branch/tag references to immutable identities once per explicit
freshness policy; retain fetch metadata. Do not use arbitrary long TTLs to
silently serve an old requested revision. **Gain:** H, network round trips on
metadata misses; approximately zero on warm immutable hits. **Evidence:** [Nix
Git fetcher][git-fetcher], [Nix settings][nix-conf].

### 016. Keep large input trees warm and rooted

Retain frequently used locked inputs, including nixpkgs, rather than only
outputs whose closure may omit evaluation sources. Bound cache size and verify
GC behavior. **Gain:** H, avoids source download/unpack on cold evaluation; none
when already present. **Evidence:** [nix-direnv GC roots][nix-direnv], [Git
fetcher][git-fetcher].

### 017. Reduce duplicated nixpkgs imports in service-owned flakes

Reuse package sets and align `inputs.*.follows` only when package configuration
is actually equivalent. Avoid forcing every system/output to select one
devShell. Do not rewrite arbitrary user flakes automatically. **Gain:** unknown;
proportional to duplicate evaluation in a profile. **Evidence:** [lazy
evaluation semantics][nix-evaluation], [eval-profiler].

### 018. Remove import-from-derivation from owned hot paths

Pre-generate static metadata or expose a prepared derivation rather than forcing
builds during evaluation. Treat IFD in user flakes as supported slow behavior,
not something to disable globally. **Gain:** H, seconds or build-duration scale
when IFD is responsible; zero otherwise. **Evidence:** [Nix IFD
documentation][ifd], [eval-jobs].

### 019. Apply fastpkgs only to package lookup subproblems

Offer pre-resolved outputs for opt-in package-list environments, with ordinary
nixpkgs fallback for overrides, uncached outputs, and real derivations.
**Gain:** H, avoids package evaluation; arbitrary devShell TTS gain unknown.
**Architecture** if this adds a different environment API. **Evidence:**
[fastpkgs], [store-path index][multiverse-paths].

### 020. Build an environment-specific output index, not a nixpkgs clone

Store the actual prepared environment path, references, provenance, and validity
status. This applies the fastpkgs mechanism at the service's real request unit.
Unlike item 011's local cache, this can be published by CI and consumed by
hosts. **Gain:** H, eliminates evaluation on verified index hits; realization
may remain. **Evidence:** [fastpkgs], [multiverse-paths], [develop].

### 021. Borrow dependency-aware invalidation from devenv

For impure/path-backed environments, track files and environment variables read
instead of trusting a directory mtime. Prefer a conservative miss over stale
output. **Gain:** unknown; improves hit rate without caching the wrong
environment. **Architecture:** evaluator integration rather than a shell
wrapper. **Evidence:** [devenv cache/FFI implementation description][devenv].

### 022. Replace repeated Nix CLI startup with a scoped C-API helper

Prototype a per-request helper that performs environment and store operations
without repeated process startup. Start scoped rather than a permanent
multi-tenant evaluator; preserve the existing Nix implementation and policy.
**Gain:** H, tens to low hundreds of milliseconds if process setup dominates;
profile first. **Evidence:** [devenv][devenv], [Nix C bindings][nix-bindings].

### 023. Test an isolated persistent evaluator pool

Retain parsed expression state for high-frequency environments; partition
owners, bound RSS, recycle workers, and validate invalidation. This is distinct
from simply caching an output path and is much harder to secure and maintain.
**Gain:** unknown; mainly cold-ish repeated evaluation throughput.
**Architecture.** **Evidence:** [eval-jobs worker management][eval-jobs],
[devenv].

### 024. Benchmark lazy-source-tree Nix as an alternate implementation

Compare source materialization on large flakes. The researched lazy-trees
feature is documented for Determinate Nix, not established as a flag in pinned
Nix 2.34.8. Require compatibility and trust review before changing the host
package. **Gain:** unknown here; vendor docs report ≥3x evaluation wall-time
reductions in some nixpkgs-tree workloads, not launcher TTS. **Evidence:** [lazy
trees][lazy-trees].

### 025. Compare evaluator versions without changing the workload

Benchmark pinned Nix against available newer Nix/Lix and, separately,
experimental Snix evaluation. Require `print-dev-env`, profile, daemon, flake,
and impurity compatibility; an expression benchmark is not sufficient. **Gain:**
unknown; cannot exceed the affected evaluation/process phases. **Evidence:**
[evaluator comparison harness][nixican], [Snix performance docs][snix-perf].

### 026. Parallelize offline environment evaluation, not one output blindly

Use bounded `nix-eval-jobs` workers for a registry of many environments. Do not
wrap one `print-dev-env` in a process farm or assume `max-jobs` parallelizes
evaluation. **Gain:** deployment/precompute throughput; approximately zero
direct warm TTS. **Evidence:** [nix-eval-jobs][eval-jobs], [Nix
settings][nix-conf].

### 027. Test parallel evaluators only when the selected operation supports them

Check current implementation support for a single devShell output. Historical
parallel `flake show`/`search` results do not imply parallel `print-dev-env`.
**Gain:** unknown here; historical 3–4x multi-output results are not
transferable. **Evidence:** [parallel-evaluator implementation and benchmark
scope][parallel-eval].

### 028. Evaluate the guest through a curated module set

Prototype pinned `lib.nixos.evalModules` plus explicitly imported dependencies,
using PR 401751 as a starting inventory rather than assuming it is merged.
**Gain:** unknown deployment evaluation/RSS improvement; ~0 current request TTS.
**Architecture:** maintenance cost from undeclared module dependencies.
**Evidence:** [minimal-pr], [minimal-diff], [minimal-eval].

### 029. Extract portable modular service definitions where useful

Use modular services to isolate the guest management components and make a
minimal module-set experiment tractable. Measure evaluation separately; do not
migrate service syntax solely for a speculative speedup. **Gain:** no
demonstrated direct TTS gain; enabling work for item 028. **Evidence:**
[modular], [modular-writing].

### 030. Remove avoidable source-tree materialization in owned flakes

Use appropriate filesets/clean source boundaries and avoid coercing entire large
repositories into derivation inputs when only a subdirectory is needed. Verify
all required source files remain included. **Gain:** H, cold copying/hashing
savings proportional to excluded data; near zero for tiny warm flakes.
**Evidence:** [nixpkgs filesets][filesets], [Git fetcher][git-fetcher].

## C. Closure realization and transfer

### 031. Put a measured binary cache near the host

Compare a local/regional cache with the current upstream path for cold Flake
closures. Evaluate authenticated private-cache needs separately from public
caches. **Gain:** H, WAN RTT and bandwidth savings; no warm-store benefit.
**Evidence:** [cache-shootout] compares implementations but excludes client
unpack/decompression; [Nix HTTP cache][http-cache].

### 032. Compare cache compression for the Rock 5B CPU/network balance

Publish zstd, xz, and uncompressed variants of the same closure; time download,
decompression, and registration end to end. Compression is a cache-production
choice, not a client override for already-published NARs. **Gain:** unknown;
likely cold-only, can regress on bandwidth-limited links. **Evidence:** [HTTP
cache settings][http-cache], [cache-shootout].

### 033. Tune substitution concurrency separately from builds

Sweep `max-substitution-jobs` and HTTP connection limits within RAM/CPU/I/O
budgets. Keep guest boot from competing with unlimited decompression workers.
**Gain:** H, reduced idle network time on cold multi-path closures; tails can
worsen. **Evidence:** [Nix settings][nix-conf].

### 034. Diagnose download-buffer stalls before raising limits

Record actual full-buffer events and CPU/disk backpressure; adjust
`download-buffer-size` only where it is limiting throughput. Do not consume
guest launch headroom merely to hide slow unpacking. **Gain:** unknown; zero
without buffer pressure. **Evidence:** [Nix settings][nix-conf], [file-transfer
implementation][file-transfer].

### 035. Trim and order substituters deliberately

Remove dead/untrusted/unneeded cache endpoints, retain required signatures, and
measure positive/negative narinfo lookup latency. Do not accept user flake cache
configuration on the host to chase speed. **Gain:** H, avoids network retries
and serial misses on cold requests; zero on local hits. **Evidence:** [Nix
settings][nix-conf], host `accept-flake-config=false`.

### 036. Keep a bounded hot-closure cache outside active Instances

Retain popular verified Flake closures after the last Instance stops, with a
capacity/age policy separate from per-instance roots. Avoid unbounded GC
retention. **Gain:** H, removes repeated downloads/builds after churn; zero
while already hot. **Evidence:** [Nix GC roots][gc-roots], [nix-direnv].

### 037. Preassemble immutable environment block images

Build an EROFS image plus verified registration metadata for each popular
prepared environment. Attach it read-only, keeping writable state private;
retain SSH copy for misses. This does not require sharing host directories.
**Gain:** H, targets the ~0.884 s small copy span and much larger cold guest
copies; image-build time must be off-path. **Architecture.** **Evidence:**
[microvm-image], [EROFS builder][erofs-mkfs], [local-store].

### 038. Layer generic and environment-specific store images

Reuse one base Guest closure image plus an environment delta instead of
rebuilding and duplicating the base. Validate OverlayFS lowerdir composition,
ordering, path conflicts, and Nix registration against the exact mounted layers.
**Gain:** unknown TTS; reduced image construction/storage and transfer on hits.
**Architecture.** **Evidence:** [OverlayFS][overlayfs], [microvm-image],
[erofs].

### 039. Use a prepopulated private state-image template

Construct a clean state filesystem containing a verified environment/store DB,
then reflink/copy it into each fresh Instance. Never clone another tenant's used
state or SSH identity; randomize filesystem identity where required. **Gain:**
H, can replace unpack/registration with clone cost on image hits.
**Architecture.** **Evidence:** [local-store], [reflink semantics][cp], [ext4].

### 040. Expand the generic image only for measured common dependencies

Consider generic Nix/shell/management dependencies frequently recopied into
guests. Inspect closure intersection first. Baking a benchmark-specific workload
is not a valid optimization under the previous experiment contract. **Gain:** H,
transferred-path savings; larger base can slow boot/cache warming.
**Architecture** if workload preloading is introduced. **Evidence:** [seenix],
[microvm-image], L6 constraints.

### 041. Verify that guest validity queries recognize the entire base closure

Check registration completeness and query batching before adding another
manifest cache. Files existing in the read-only store do not alone make them
valid to Nix. **Gain:** unknown; could eliminate needless copy of
already-present paths if a defect exists. **Evidence:** [microvm-image],
[remote-store], [local-store].

### 042. Batch related roots into one copy operation

If future provisioning adds multiple independent roots, send them together so
Nix can deduplicate traversal and missing paths. The current single-environment
copy already has little opportunity here. **Gain:** ~0 today; potential protocol
savings with multiple roots. **Evidence:** [Nix copy implementation][nix-copy],
[remote-store].

### 043. Compare SSH-ng connection counts on genuinely large transfers

The explicit master and `max-connections=1` are intentional. Test additional
daemon streams only after proving transfer parallelism is useful and preserving
the master-handshake fix and cleanup semantics. **Gain:** unknown; may help
large closures, likely hurts small ones. **Evidence:** L1 runs 7–9; [Nix SSH
implementation][nix-ssh], [remote-store].

### 044. Compare encrypted transports without weakening authentication

Benchmark supported modern SSH ciphers on ARM with identical closure bytes and
security policy. Local VSOCK eliminates WAN costs, not crypto or memory copies.
Do not propose a null cipher. **Gain:** H, bounded by crypto CPU within copy;
probably small for the smoke shell. **Evidence:** [OpenSSH
configuration][ssh-config], [Nix SSH][nix-ssh].

### 045. Test destination substitution only for the right topology

For large misses, compare guest-side substitution against host-to-guest copy.
Avoid downloading identical data twice; current local VSOCK copy may already be
better, and guest egress must retain the same policy. **Gain:** unknown;
potentially negative on this single-host topology. **Evidence:** [Nix copy
`substitute-on-destination`][nix-copy], [http-cache].

### 046. Prototype Styx lazy substitution

Fetch signed metadata and only accessed chunks through EROFS/fscache; prefetch
the shell's first-touch set. Nix integration, kernel support, failure semantics,
and private-cache authorization need evaluation. **Gain:** H, large cold
closures with sparse use may avoid most bytes; no reliable project benchmark.
**Architecture.** **Evidence:** [Styx source/docs][styx], [erofs].

### 047. Prototype a Snix-backed lazy store separately from production

Study content-addressed directory/blob services and lazy filesystem access. A
virtiofs-based boot prototype violates today's `microvm.shares == []` contract;
it is not an incremental configuration tweak. **Gain:** unknown; trades eager
copy for first-touch stalls. **Architecture.** **Evidence:** [Snix boot
source][snix-boot], [Snix performance][snix-perf].

### 048. Study Nix snapshotter's closure-aware preparation, not its container API

Reuse ideas for representing immutable closures and deduplicating preparation.
`nix-snapshotter` targets containerd, not CH block devices; container startup
numbers cannot establish VM TTS gains. **Gain:** no direct drop-in gain; unknown
for a redesigned image pipeline. **Architecture.** **Evidence:**
[nix-snapshotter][nix-snapshotter], [microvm-image].

## D. Guest activation and service graph

### 049. Replace Perl user activation with Userborn

Test `services.userborn.enable` alone before broader boot changes. Preserve root
login behavior, build users, UID/GID stability, and mutable account semantics;
account-state persistence may need adjustment. **Gain:** H, target part of L4's
0.380 s users phase, not all boot time. **Evidence:** [pinned Userborn
module][userborn-module], [Userborn design][userborn].

### 050. Compare systemd-sysusers as an alternative to Userborn

The guest primarily uses system accounts, so the experimental module may fit. It
does not support normal users or all password-update semantics. Test NSS, home
creation, build users, and persistence rather than assuming equivalence.
**Gain:** H, same ≤0.380 s historical phase ceiling as item 049; alternatives.
**Evidence:** [pinned sysusers module][sysusers].

### 051. Precompute static account files for a true appliance guest

Pinned Userborn supports `static=true`, with explicit UID management and no
switchable configurations. Confirm that this matches guest lifecycle and desired
account mutability before moving accounts into the closure. **Gain:** H, removes
most runtime account generation; ≤0.380 s historical budget. **Architecture.**
**Evidence:** [Userborn module warnings][userborn-module].

### 052. Consolidate impermanence directory creation

Profile and replace repeated `stat`/`mkdir`/ownership subprocesses with
equivalent batched tmpfiles rules or a small helper. Preserve permissions,
parent handling, first boot, restarts, and failure behavior. **Gain:** H, target
part of L4's 0.210 s directory-creation phase. **Evidence:** [pinned
impermanence implementation][impermanence], [tmpfiles].

### 053. Prepare static persistence directories in new state images

Populate only fixed empty directories/permissions during image creation, then
validate rather than recreate them at boot. Do not skip repair/validation for
existing Instances or move per-user secrets into a shared template. **Gain:** H,
≤0.210 s historical guest work, less any added host work. **Evidence:**
[impermanence], [mke2fs], host `worker.sh`.

### 054. Test bashless `system.nixos-init.enable` as a coherent migration

Pinned nixpkgs requires systemd initrd, `/etc` overlay, Userborn or sysusers,
and empty `boot.postBootCommands`. It ignores activation scripts: current
impermanence setup and microvm closure registration must first move to
equivalent units. **Gain:** H, targets ~1 s activation/switch-root region;
unknown net gain. **Architecture.** **Evidence:** [nixos-init
module][nixos-init-module], [nixos-init].

### 055. Revisit mutable `/etc` overlay only as part of item 054

Standalone overlay already failed twice. A bashless activation design changes
the assumptions, so an integrated comparison is valid; another isolated retry is
not. Keep ephemeral writable `/etc` unless explicitly changing that contract.
**Gain:** standalone expected ~0; integrated gain unknown, overlaps item 054.
**Evidence:** L1 runs 11/14; [pinned `/etc` activation][etc-activation].

### 056. Prebuild a generic Nix validity database

Construct a version-compatible DB for exactly the immutable Guest closure, copy
it into a new private state filesystem, then register only additions. Never
replace a live or established Instance DB with a template. **Gain:** unknown
until `nix-store --load-db` is timed; avoids repeated generic registration.
**Architecture.** **Evidence:** [microvm-image], [local-store].

### 057. Make unchanged base-closure registration conditional on restart

A persistent DB may already know the pinned runner's base closure. Validate a
versioned marker and DB/path state before skipping re-registration; do not
mistake fresh files for registered paths. **Gain:** H, restart-only registration
cost; no fresh-instance benefit by itself. **Evidence:** [microvm
registerClosure warning][microvm-options], [microvm-image].

### 058. Move registration into a precisely ordered service

Replace serial post-boot shell work with a unit required by provisioning/Nix,
while independent initialization proceeds. Gate all consumers on completion and
failure. This is also a prerequisite for bashless init, not permission to omit
registration. **Gain:** unknown; at most non-overlapped registration time.
**Evidence:** [microvm-image], [nixos-init-module], [systemd unit
ordering][unit].

### 059. Compare the nftables guest firewall backend

The current guest enables the firewall without selecting nftables explicitly.
Compare equivalent policy installed through nftables against the default
backend; retain deny behavior, logging requirements, and startup ordering.
**Gain:** H, targets part of L5's ~0.62 s firewall unit; not all necessarily
critical. **Evidence:** [pinned firewall module][firewall], [nftables
module][nftables].

### 060. Reduce firewall setup operations, not firewall coverage

Pre-generate a compact ruleset and apply it atomically; avoid repeated tool
invocations where the backend allows it. Verify connectivity and denied traffic
before accepting a speedup. **Gain:** H, same firewall budget as item 059;
non-additive. **Evidence:** [firewall], [nftables].

### 061. Define a real shell/provisioning-ready target

Derive the minimum dependency set for authenticated SSH, credentials,
persistence, Nix registration, and required security services. Notify on that
set rather than unrelated multi-user completion only if end-to-end shell
behavior is unchanged. **Gain:** unknown; overlap only genuinely nonessential
work, not fake readiness. **Architecture.** **Evidence:** [unit], [systemd SSH
generator][ssh-generator], L1 failures.

### 062. Start provisioning while safe noncritical boot work continues

After item 061, overlap closure transfer with services that do not touch its DB,
mounts, user/session prerequisites, or security policy. Trace contention as well
as overlap; early root-manager startup already regressed. **Gain:** H, bounded
by `min(remaining boot, provisioning)`, at most ~1.29 s in the late smoke
workload. **Evidence:** L1 run 26; [unit], [remote-store].

### 063. Remove unused services from the actual generated unit graph

Audit gettys, maintenance timers, udisks-style helpers, hardware services, and
generators before disabling anything. Keep logind's power-button shutdown and
network/security services needed by the workload. **Gain:** unknown; only
removed critical-path work or reduced contention counts. **Evidence:** [microvm
existing optimization][microvm-opt], [analyze], [unit].

### 064. Audit NixOS minimal profile against existing microvm defaults

Compare generated packages/units before and after `profiles/minimal.nix`; many
obvious switches, including docs and wait-online, are already addressed by
microvm. Do not count them again. **Gain:** unknown closure/I/O savings; may be
zero for this configuration. **Evidence:** [pinned minimal
profile][minimal-profile], [microvm-opt].

### 065. Use Seenix to remove accidental Guest closure dependencies

Inspect closure roots and ELF/store references; identify build-only tools
dragged into runtime scripts, duplicate versions, unnecessary
locale/docs/firmware paths. Removing bytes matters only if fetched, faulted, or
cache-evicting. **Gain:** unknown boot improvement; cold bytes saved are
directly measurable. **Evidence:** [seenix], [microvm-image].

### 066. Split rarely used tooling from the boot-critical image

Keep required SSH/Nix/shell components local, but make optional diagnostics and
large tools available through an explicit secondary closure or cache. Do not
silently remove the supported default environment. **Gain:** H, smaller
image/cache footprint; warm TTS may not change. **Architecture.** **Evidence:**
[seenix], [microvm-image], [erofs].

### 067. Audit duplicated initrd/main-stage generator work

Measure generator and unit-load costs; pre-generate fixed units or eliminate
unused generators only where their behavior is fully reproduced. Their
historical total is much smaller than the whole boot budget. **Gain:** H, tens
of milliseconds; L6 diagnostic main generator/load ~0.19 s ceiling.
**Evidence:** [systemd generators][generator], [ssh-generator].

### 068. Tune initrd udev concurrency independently

The retained cap applies to main-stage `/etc/udev`; verify initrd configuration
rather than assuming inheritance. Sweep small worker counts while preserving all
coldplug events and block-device readiness. **Gain:** unknown; main-stage result
does not prove initrd benefit. **Evidence:** [udev configuration][udev-conf],
[pinned initrd module][initrd], L5.

### 069. Optimize specific expensive udev rules

Use per-rule diagnostics to find redundant external helpers for the fixed
virtual hardware. Prefer upstream-equivalent rule simplification over skipping
coldplug or masking discovery services. **Gain:** H, bounded by affected part of
~0.5 s main trigger span; potentially zero. **Evidence:** [udevadm][udevadm],
[udev rules][udev], L5.

### 070. Replace broad device waits with exact device/mount dependencies

Look for `udevadm settle` or generic ordering in the evaluated guest. Wait only
for required store/state/seed devices, while keeping discovery correct. The seed
is already early-mounted; do not duplicate that change. **Gain:** unknown;
depends on an actual overbroad wait being present. **Evidence:** [udevadm],
[systemd mount units][mount-unit], [initrd].

### 071. Reduce persistence mount count without losing its semantics

Consider a coarser persistent subtree only where it preserves the precise
declared retained/ephemeral boundary. Additional persisted files are a behavior
change, not a free optimization. **Gain:** unknown; fewer mounts/events/units
may help after the burst fix. **Architecture.** **Evidence:** [impermanence],
[mount-unit], L1 run 13.

### 072. Prototype a single-stage/minimal guest separately

Study not-os/runit or a custom systemd-root image to avoid generic NixOS
activation and possibly switch-root. Reimplement SSH, Nix builds, persistence,
shutdown, and security tests before treating it as equivalent. **Gain:** H,
potentially seconds of the ~5.29 s boot phase; unknown net result.
**Architecture.** **Evidence:** [not-os], [server-base], [nixos-init].

## E. Filesystem, kernel, and VMM boot

### 073. Reintroduce the archived uncompressed EROFS candidate as a controlled test

Compare current compressed flags against no compression with buffered I/O.
Verify image bytes and exact deployed source; this is a recovery/revalidation
experiment, not an untried discovery. **Gain:** M, archived ~0.30–0.40 s; H for
current HEAD. Image roughly doubled. **Evidence:** L2; [EROFS format][erofs],
[microvm-image].

### 074. Sweep EROFS physical cluster size for first-touch latency

Keep compressor and contents fixed while varying `-C`; larger clusters may
reduce I/O but amplify random-read decompression. Measure executable faults, not
only size. **Gain:** unknown, either sign; avoid broad blind compression sweeps.
**Evidence:** [EROFS builder's random-access warning][erofs-mkfs].

### 075. Test selective compression for cold versus boot-critical files

Where supported by the pinned builder, leave frequently faulted binaries/data
uncompressed and compress colder content. Otherwise prototype separate immutable
images; verify deterministic construction. **Gain:** H, seeks uncompressed boot
behavior without doubling all image bytes; no established timing. **Evidence:**
[EROFS builder][erofs-mkfs], [erofs], L2.

### 076. Revisit fragments/tail packing only with first-touch evidence

Measure read amplification and decompression across boot-critical files. The
previous no-fragments run had no convincing boot gain, so require a new image,
compression mode, or measured bottleneck before retrying. **Gain:** expected ~0
absent new evidence; unknown under changed layout. **Evidence:** L1 runs 10/13;
[microvm-options], [erofs-mkfs].

### 077. Order boot-critical image data for locality

Record first accesses, then construct an image with the hot files grouped, using
supported tar ordering or a verified builder change. Keep metadata/content
identical and test both cold and warm host cache. **Gain:** unknown; primarily
cold random-I/O reduction. **Evidence:** [EROFS `--tar`/`--sort`
documentation][erofs-mkfs], [boot-trace].

### 078. Prefetch only the generic boot working set

Warm measured image ranges after host deployment or during idle time, rather
than reading the entire ~0.7–1.4 GB image per request. Account for interference
and RAM. **Gain:** H, reduces cold image-fault latency; near zero in the
existing warm series. **Evidence:** buffered-store results L2; [readahead
interface][readahead].

### 079. Protect hot immutable image pages under pressure

Use measured host memory reservations/pressure controls before considering
explicit page locking. Avoid unbounded pinning that starves guests or the Nix
daemon. **Gain:** unknown idle median; potentially fewer p95 cache-eviction
stalls. **Evidence:** [systemd resource control][resource-control], [CH
memory][ch-memory].

### 080. Compare buffered versus direct writable-state I/O

The read-only-store change does not justify changing writable disks blindly.
Validate flush propagation, crash recovery, and host-memory overhead while
measuring closure import and fsync latency. **Gain:** unknown; could affect the
~0.884 s copy phase. Durability is a hard gate. **Evidence:** [microvm volume
options][microvm-options], [ext4], [CH disk code][ch-block].

### 081. Reflink a pristine empty state filesystem

Compare host `mke2fs` against a private reflink of a preformatted empty template
on a supporting host filesystem. Keep unique filesystem identity where
necessary, no tenant data, and explicit failure if reflink assumptions do not
hold. **Gain:** H, targets ≤0.210 s historical formatting work, partly hidden by
evaluation. **Evidence:** [cp reflink semantics][cp], [mke2fs], L3.

### 082. Tune state-image inode density and geometry

Choose inode count, block-group layout, and filesystem size for actual
Nix/workspace usage, not arbitrary defaults. Benchmark both empty formatting and
many-small-file imports; maintain promised usable capacity. **Gain:** unknown;
creation and copy savings may trade off against capacity. **Evidence:**
[mke2fs], [ext4].

### 083. Examine lazy initialization and discard work

Trace whether journal/inode initialization or discard remains on the critical
path after `assume_storage_prezeroed=1`. Retain the new-sparse-file
precondition; never reuse that assumption for arbitrary existing images.
**Gain:** likely small/zero based on L1 alternating controls; quantify before
tuning. **Evidence:** [mke2fs], [ext4], L1 runs 23–25.

### 084. Optimize the seed image independently

Measure the 8 MiB `mke2fs -d` and `e2fsck -fn` path. Consider a smaller
validated filesystem or a metadata-only read-only format, preserving secret
handling, root-only permissions, and boot identification. **Gain:** unknown;
bounded by the worker's remaining ~0.44 s, not all boot time. **Architecture**
for changing the format. **Evidence:** [mke2fs], host `worker.sh`.

### 085. Replace the seed disk with a supported private credential channel

Prototype only a channel available on both ARM and x86. CH53 SMBIOS credentials
are not an ARM solution; never put host private keys on the kernel command line
or in a shared immutable image. **Gain:** H, avoids seed formatting/mount/device
work; unknown net gain. **Architecture.** **Evidence:** [systemd
credentials][credentials], [CH53][ch53].

### 086. Compile fixed boot drivers into a minimal guest kernel

Include required virtio block/network/console/VSOCK, EROFS, ext4, overlay, and
entropy support; remove unused hardware only after auditing generated devices
and workload kernel needs. Keep debug/recovery build variants. **Gain:** H, part
of ~0.35–0.42 s kernel plus module-loading work; not multi-second by kernel
timing alone. **Evidence:** [CH kernel guidance][ch-kernel], [boot-trace].

### 087. Use kernel initcall traces to remove specific probe delays

Investigate measured slow drivers, firmware requests, and synchronous probes. Do
not apply broad `initcall_blacklist` settings without proving required behavior
remains available. **Gain:** unknown; bounded by identified waits. **Evidence:**
[kernel boot tracing][boot-trace], [kernel parameters][kernel-params].

### 088. Reduce initrd contents before changing compression again

Remove unneeded firmware, drivers, utilities, and copied dependencies from the
actual systemd initrd. Retain persistence, credentials, filesystem tools, and
recovery needs. Raw/LZ4 compression-only attempts already failed or regressed.
**Gain:** unknown; smaller load/decompression and cleanup work. **Evidence:**
[pinned initrd builder][initrd], L2 raw-initrd failure, L1 run 27.

### 089. Diagnose switch-root teardown rather than assuming it is all activation

Trace initrd process shutdown, mount moves, old-root cleanup, systemd reexec,
and NixOS prepare-root separately. A ~0.8–1.0 s unit span can contain
overlapping or nested activation work. **Gain:** H, targets part of L5's
switch-root interval; unknown removable fraction. **Evidence:** [nixos-init],
[initrd], [systemd boot sequence][bootup].

### 090. Test initrd-less boot only with a redesigned root layout

Directly mount a suitable root with built-in drivers, then construct the private
writable state/overlay correctly. Current tmpfs root and impermanence ordering
do not support simply turning initrd off. **Gain:** H, potentially removes part
of ~2.5–2.7 s initrd phase, while work migrates elsewhere. **Architecture.**
**Evidence:** [CH kernel guidance][ch-kernel], [initrd].

### 091. Measure console/getty overhead without hiding failures

Keep `TERM=dumb`. Separately test kernel console verbosity and unused getty
removal, retaining journal diagnostics and interactive SSH PTYs. Do not use
debug output while scoring production timing. **Gain:** unknown, likely small
after the proven 2 s terminal-query fix. **Evidence:** [kernel
parameters][kernel-params], [systemd getty generator][getty], L1.

### 092. Compare immutable filesystem backends under identical conditions

Use EROFS versus supported squashfs first; an ext4 read-only prototype needs
custom image support. Match contents, buffered/direct mode, cache state, and
compression rather than comparing defaults with several variables changed.
**Gain:** unknown; current evidence favors testing EROFS details first.
**Evidence:** [microvm-image], [microvm-options], [erofs].

## F. Host orchestration, SSH, and shell entry

### 093. Overlap generic guest boot with environment preparation

Current worker waits for `print-dev-env` before boot, partly because the seed
carries the environment path. Decouple environment delivery from boot
credentials and start boot once the runner/state are ready; gate provisioning
and publication correctly. **Gain:** H, up to
`min(environment preparation, boot)`; small warm, large cold. **Architecture.**
**Evidence:** host `worker.sh`; [CH devices][ch53], [unit].

### 094. Overlap independent seed/key work within the worker

Profile ordering of client-key generation, known-hosts generation, staging, and
filesystem creation after existing background jobs. Preserve per-instance
identity and publish nothing until every job succeeds. **Gain:** H, milliseconds
to tens of milliseconds, bounded by the ~0.44 s worker. **Evidence:** host
`worker.sh`; [OpenSSH key generation][ssh-keygen], L3.

### 095. Replace the one-second SSH retry sleep with precise readiness

Record whether retries actually occur. Prefer an authenticated bounded retry
with short backoff or a readiness event tied to the listener and prerequisites.
Keep main-process death detection and cleanup. **Gain:** H, zero if first
attempt succeeds; up to ~1 s per current failed probe. **Evidence:** host
`provision.sh`; [ssh-generator], [systemd notification][sd-notify].

### 096. Reduce final SSH handshake cost without leaking the provision master

Measure KEX/auth/PAM separately. A deliberate private handoff/reuse design could
avoid reconnecting, but current policy closes the provisioning master before
publishing client configuration; do not silently weaken that separation.
**Gain:** H, a fraction of ~1.09 s post-activation overhead. **Architecture.**
**Evidence:** [OpenSSH multiplexing][ssh-config], L1 runs 7–9.

### 097. Measure outer-client SSH multiplexing as a distinct optimization

An opt-in client ControlMaster can remove repeated outer handshakes over high
RTT. Keep host-key checking, owner separation, and control-socket permissions
intact. It will not improve the existing host-side benchmark. **Gain:** H,
network handshake RTTs on repeat connections; ~0 `launcher_s` gain.
**Evidence:** [ssh-config], [[docs/benchmarks.md]].

### 098. Audit PAM/session setup while preserving its guarantees

Trace first-login user-manager creation, NSS, home setup, and session
registration. Optimize the concrete slow component, not `UsePAM=no`; early
user-manager startup already shifted cost into boot and lost overall. **Gain:**
unknown; narrower than total SSH/session latency. **Evidence:** L1 run 26; [sshd
settings][sshd-config], [pam_systemd][pam-systemd].

### 099. Cache generated environment-entry code with exact Nix semantics

Investigate retaining validated generated shell setup rather than parsing the
same `*-env` file on every entry. Preserve structured attributes, temporary
paths, variable filtering, shell selection, hooks, exit status, and interactive
behavior. **Gain:** H, part of final ~1.09 s overhead; no defensible exact
estimate. **Architecture.** **Evidence:** [develop], [nix-direnv].

### 100. Eliminate redundant Nix parsing only with equivalent validation

The guest validates with `print-dev-env` and then starts `nix develop` later.
Consider a shared parsed result or helper, not merely removing the validation
gate. Combined profile rooting was already tested and did not improve total
latency. **Gain:** H, ~0–0.08 s suggested by the earlier provision delta, not
proven. **Evidence:** L1 run 15; [develop].

### 101. Avoid fallback shell package resolution during `nix develop`

Verify which shell the pinned implementation chooses for the prepared
environment, and whether it consults the guest registry. The Guest closure
already includes `bashInteractive`; make that useful through supported semantics
rather than guessing. **Gain:** H, zero if already local/resolved; potentially
evaluation/fetch cost otherwise. **Evidence:** [develop], guest
`system.extraDependencies`.

### 102. Profile real shell hooks and interactive rc files

Expose hook/rc timings separately; optimize service-owned hooks and suggest
user-owned fixes. Do not omit hooks, defer required tools until after the
prompt, or score a blank shell as equivalent. **Gain:** unknown; potentially
dominates real interactive workloads, absent from a simple smoke shell.
**Evidence:** [develop], [Bash startup files][bash-startup].

### 103. Batch host helper work only where process startup is measured

Consolidate repeated path/metadata operations in a small typed helper if
profiles show Bash/coreutils overhead. The shell scripts are already small; a
rewrite needs phase-level evidence to justify its maintenance cost. **Gain:** H,
likely milliseconds; worker ceiling ~0.44 s. **Evidence:** host scripts; [devenv
process/FFI approach][devenv].

### 104. Overlap TAP allocation with independent preparation

Allocate the user namespace/TAP earlier and pass retained FDs into the runner
only after prerequisites succeed. Preserve cgroup ownership and last-FD cleanup;
do not leave a privileged global pool of network interfaces. **Gain:** H, up to
historical ~0.06–0.14 s TAP setup, less contention/coordination. **Evidence:**
`nix/nixosModules/host/tap.c`; [nsresourced API][nsresourced], L6 profiles.

### 105. Prototype a long-lived VSOCK SSH listener

Compare per-connection socket-activated `sshd -i` with a private persistent
listener that accepts the same VSOCK transport and credentials. A TCP sshd on
the guest NIC is not an equivalent substitute. **Gain:** unknown; reduces daemon
setup only if material, may increase boot work. **Architecture.** **Evidence:**
[ssh-generator], [sshd-config].

### 106. Consider a narrow authenticated guest control protocol

A dedicated management agent could combine closure metadata, environment
rooting, and readiness without repeated remote commands. Keep user shell access
on SSH initially; review authorization, PTY, signals, and protocol attack
surface separately. **Gain:** unknown; targets provisioning/session protocol
overhead, not byte I/O. **Architecture.** **Evidence:** [Nix remote-store
protocol][remote-store], [CH VSOCK][ch-vsock].

## G. Snapshot, pool, and alternative lifecycle designs

These were outside the previous autoresearch contract: no Instance reuse and no
workload preloading. They are research candidates only, not authorization to
change that contract. Never clone tenant secrets, SSH keys, active sessions, or
used state.

### 107. Restore a sanitized generic CH53 snapshot

Snapshot before tenant-specific state, then implement an explicit resume
protocol for identity, entropy, time, credentials, writable disks, Nix DB, and
readiness. CH53 supports snapshot restore; validate ARM and these devices before
investing. **Gain:** H, replaces much of ~5.29 s boot with restore/resume cost;
net unknown. **Architecture.** **Evidence:** [CH53 snapshot docs][ch-snapshot],
[snapshot uniqueness][uniqueness].

### 108. Compare CH53 eager and on-demand restore

CH53 documents `memory_restore_mode=ondemand` using userfaultfd, with
page-alignment and prefault restrictions; unsupported setup fails rather than
silently falling back. Measure first command, not merely API restore completion.
**Gain:** unknown; avoids eager RAM copy but can move stalls to shell execution.
**Evidence:** [version-matched snapshot docs][ch-snapshot].

### 109. Use bounded background prefaulting after restore

Inspect CH53's release/code support for background prefault workers and compare
first-touch stalls against CPU/I/O contention. Keep ordinary `prefault=on`
restrictions distinct from restore-specific background loading. **Gain:**
unknown; potentially improved restored-shell tails. **Evidence:** [CH53 release
notes][ch53], [CH53 memory implementation][ch-memory-code].

### 110. Evaluate copy-on-write snapshot RAM on a supported newer revision

Current upstream documentation describes a copy-on-write mode, but the inspected
v53 snapshot documentation does not establish it. Treat this as a version
upgrade experiment, with immutable snapshot-file lifetime and private-write
validation. **Gain:** unknown; may reduce eager-copy cost and shared-template
RAM consumption. **Architecture.** **Evidence:** [current snapshot
docs][ch-snapshot-main], [ch-snapshot].

### 111. Record and prefetch the snapshot working set

Use the REAP approach: record pages needed to reach the real shell, fetch them
compactly, and demand-page the remainder. Re-record for each guest generation;
do not assume FaaS working sets match development shells. **Gain:** unknown
here; REAP's external average 3.7x is against its own snapshot baseline, not
cold NixOS boot. **Evidence:** [vHive/REAP source][reap]; [original benchmark,
supplemental][reap-paper].

### 112. Investigate FaaSnap-style page-loading overlap

Study region recording, page-layout choices, and asynchronous loading beyond
simple whole-working-set prefetch. Only prototype if snapshot page faults are
the measured bottleneck; this is substantially more complex than item 108.
**Gain:** unknown on CH/Rock 5B. **Architecture.** **Evidence:** [FaaSnap
implementation and evaluation harness][faasnap].

### 113. Keep a bounded pool of pristine booted guests

Allocate one unused guest per request and destroy rather than recycle used
guests. Define how environment paths/keys/state arrive after pool assignment;
charge idle RAM and patch-age costs explicitly. **Gain:** H, can hide most boot
delay on pool hits; zero benefit on misses and extra background work.
**Architecture.** **Evidence:** [CH lifecycle APIs][ch53], [uniqueness].

### 114. Use paused pristine guests instead of continuously running idle guests

Compare pause/resume with running warm pools for CPU cost, clock handling,
entropy, and device state. RAM remains allocated; a pause is not a memory
snapshot on disk. **Gain:** H, similar boot hiding to item 113 with resume cost;
net unknown. **Architecture.** **Evidence:** [CH snapshot/pause/resume
docs][ch-snapshot].

### 115. Pool or snapshot by immutable environment identity

For popular environments, finish closure import before request arrival. Keep
per-owner authorization and secrets out of the reusable artifact, and cap the
number of environment variants. **Gain:** H, can hide boot plus ~1.29 s
small-workload provisioning; larger closures offer more. **Architecture.**
**Evidence:** [ch-snapshot], [fastpkgs], L6 constraints.

### 116. Make snapshot restore integrate with nsresourced FD ownership

CH53 accepts replacement network FDs on restore. Prove that the fresh TAP and
user namespace live exactly as long as the new Instance and that old Unix socket
paths, VSOCK connections, and writable backing files cannot be reused
accidentally. **Gain:** enabling work, no independent speedup. **Evidence:**
[CH53 net-FD restore][ch-snapshot], [nsresourced], `tap.c`.

### 117. Minimize snapshot memory and captured devices

Create templates with only needed initialized memory, no tenant data, and a
stable device set. Compare smaller boot RAM plus later expansion against fixed 3
GiB; do not reduce supported workload capacity silently. **Gain:** unknown; may
reduce restore I/O and improve pool density. **Architecture.** **Evidence:**
[CH53 memory controls][ch-memory], [ch-snapshot].

### 118. Compare Firecracker as an end-to-end alternative, not a boot headline

Reimplement runner notification, network FD handling, VSOCK, persistence,
shutdown, and ARM tests. Its snapshot/VMGenID behavior is useful research but
not evidence that CH53 has the same guarantees. **Gain:** unknown; could regress
compatibility or transfer time. **Architecture.** **Evidence:** [Firecracker
snapshots][firecracker-snapshot], [microvm-options].

### 119. Evaluate alternative isolation only as a separate product mode

Containers, nspawn, gVisor, or a jail could avoid VM boot, but they change the
kernel and isolation boundary. Do not replace this service's guest security
model under the label of TTS tuning. **Gain:** H, could remove the boot phase;
no equivalent-security estimate. **Architecture.** **Evidence:**
[nix-snapshotter], [systemd container interface][containers].

## H. Host scheduling, hardware, and sustained performance

### 120. Schedule latency-sensitive work on the Rock 5B's faster cores

Inspect actual CPU topology and cpuset placement; compare evaluator, VMM vCPU,
VMM I/O, and provisioning placement on big versus little cores. Do not hard-code
CPU numbers without checking the deployed kernel. **Gain:** unknown; CPU-bound
phases and variance may improve substantially. **Evidence:** [systemd CPU
affinity/resource controls][resource-control], [CH CPU docs][ch-cpu].

### 121. Test CPU frequency policy and thermal stability

Record governor, frequency, temperature, and throttling during paired runs. A
performance policy or better cooling can reduce startup ramp/thermal variance,
but report power costs and avoid unsafe overclocking. **Gain:** unknown; zero if
frequencies are already stable and maximal. **Evidence:** [Linux CPUFreq
documentation][cpufreq], [thermal sysfs][thermal].

### 122. Sweep guest vCPU count with bounded admission

Compare 1/2/4 vCPUs for this workload and adjust udev workers coherently. More
CPUs may improve parallel services but increase KVM/device initialization and
contention. Do not infer throughput from isolated median latency. **Gain:**
unknown, either sign; targets CPU-bound boot/provision phases. **Evidence:** [CH
CPU configuration][ch-cpu], [udev-conf], L1 run 31.

### 123. Tune guest memory initialization and page size

Compare memory sizes, ordinary pages/THP, and supported hugepage configurations.
Prefaulting all 3 GiB can hurt startup; verify the actual default and measure
faults rather than enabling every memory optimization. **Gain:** unknown; mostly
allocation/fault behavior and density. **Evidence:** [version-matched CH memory
docs][ch-memory], [THP docs][thp].

### 124. Reserve resources for interactive launches

Use CPU/I/O weights and memory protection to keep background builds, cache
fills, and GC from starving boot/provisioning. Reserve bounded capacity rather
than using unbounded realtime scheduling. **Gain:** H, little idle benefit,
potentially large loaded p95 improvement. **Evidence:** [systemd resource
control][resource-control], [Nix settings][nix-conf].

### 125. Admit only as many creations as resources can sustain

Bound concurrent evaluation, image initialization, boot, and copy separately.
Schedule by measured memory/I/O demand, with fair per-owner queues and explicit
queue-time telemetry. **Gain:** H, improved tails/failure rate under load;
serial latency may be unchanged. **Evidence:** [resource-control], [Nix worker
limits][nix-conf].

### 126. Move GC and store optimization out of launch bursts

Trace DB/filesystem contention from automatic GC and hardlink optimization.
Schedule maintenance with bounded background resources; retain enough free space
so avoiding maintenance does not cause ENOSPC failures. **Gain:** unknown idle
median; potentially large tail improvement during collisions. **Evidence:** [Nix
settings][nix-conf], [local-store], [resource-control].

### 127. Compare host storage placement for state and cache metadata

Measure NVMe/eMMC/SD placement, filesystem metadata latency, and fsync costs for
state images, Nix DB, sources, and immutable images separately. Do not label a
hardware upgrade as a software optimization. **Gain:** unknown; large if current
storage dominates cold copy/boot, small when hot. **Evidence:** [ext4], [CH disk
backend][ch-block], L2 buffered-store results.

### 128. Tune block queues and I/O backend only with traces

Inspect CH53's actual virtio-block path and host io_uring support. Compare queue
counts/depth and I/O scheduling without changing durability or overprovisioning
threads relative to two guest CPUs. **Gain:** unknown; likely
workload-dependent, more relevant to large closure import. **Evidence:** [CH53
block implementation][ch-block], [microvm-options].

### 129. Prebuild custom kernel/VMM/Nix binaries with measured code optimization

Only after CPU profiling, compare release/LTO/PGO or CPU-specific builds for hot
components. Preserve portability expectations, security features, and
reproducible inputs; build time is outside current launcher timing. **Gain:**
unknown, usually a fraction of CPU-bound time rather than whole TTS.
**Evidence:** [CH53 build configuration][ch-cargo], [Nix
benchmarking][nix-bench].

### 130. Route requests to hosts that already hold the needed artifacts

If the service becomes multi-host, use immutable environment/guest-generation
cache locality alongside admission capacity. Preserve owner state locality and
avoid moving an established Instance merely for a warm-cache hit. **Gain:** H,
avoids cold fetch/image costs and overload; ~0 on a single host.
**Architecture.** **Evidence:** [Nix store/cache identity][http-cache],
[multiverse-paths], [resource-control].

## Suggested first experiments

This ordering is advisory, not permission to deploy or alter architecture.

1. **001–010:** establish exact baseline/provenance and complete phase
   accounting.
2. **073:** reproduce the archived uncompressed-store result against current
   source.
3. **049/050, 052, 059/060:** target measured user activation, persistence
   setup, and firewall work without first changing the whole guest architecture.
4. **095, 101, 120–122:** check retry quantization, shell fallback, and CPU
   placement before implementing speculative caches or rewriting orchestration.
5. **011/012:** implement a prepared-environment cache only if real workload
   evaluation/miss costs justify it; the warm smoke preparation is already small
   and partly overlapped.
6. **054:** prototype bashless initialization as one coherent, tested migration.
   The previous standalone `/etc` overlay result does not answer this question.
7. **037/038 or 093:** for large Flake closures, compare image attachment
   against overlapping preparation and boot. Measure total first-request cost as
   well as hits.
8. **107–117:** only with an explicit lifecycle decision, prototype generic
   snapshot restore or pristine pools and then address page-fault behavior.

All candidates must retain authentication, host-key verification, owner
isolation, network policy, Nix sandboxing, persistence, correct GC roots,
failed-start cleanup, interactive PTYs/hooks, exit status, and graceful
shutdown. Keep the notification sender-lifetime and orphan-reset fixes. No
global unique CID allocator is needed for today's private CH Unix VSOCK
namespaces: the source intentionally uses CID 42.

Do not disable signature checking globally, mount a writable host store, remove
PAM/firewalls for benchmark scores, skip device events, remove fsync/barriers,
reuse SSH keys across Instances, or pre-publish `client.conf`. An apparently
earlier prompt with an incomplete environment is a different metric, not a TTS
win.

## Source index and version boundaries

Production mechanisms were checked primarily against local sources:

- nixpkgs `a32edd7654519351e48e80372a928df336394670`, available at
  `/nix/store/bqck1hypy8j3l922lf781qknmcxjv5a0-source`.
- Checked-in microvm commit `3defb1d870b45d6545df1256e50330efbb504112`.
- Impermanence `7b1d382faf603b6d264f58627330f9faa5cba149`, at
  `/nix/store/3ib4ns4q84wcjfqim5wc0jsjw7v18lpd-source`.
- systemd 261.2 and OpenSSH 10.5p1 supplied manuals; corresponding upstream docs
  below. OpenBSD-current SSH web manuals may be newer: local manuals govern
  flags.
- Nix 2.34.8 source captured in the archive and nixpkgs' stable package
  definition; release-specific 2.34.8 manuals are linked below.
- Cloud Hypervisor 53.0 plus this repository's VSOCK reset patch. `main`
  snapshot documentation is cited only for the explicitly newer-mode candidate.

The five inspiration projects and experimental alternatives are not dependencies
of this checkout. Their current code/docs describe candidate mechanisms, not
features asserted to exist in the pinned production stack. External benchmark
numbers are not local expected gains. The REAP paper and vendor/blog
descriptions are supplemental; implementation/docs are linked alongside them.

[seenix]: https://github.com/fzakaria/seenix
[fastpkgs]: https://github.com/tomberek/fastpkgs
[multiverse]: https://github.com/fzakaria/nixpkgs-multiverse
[multiverse-paths]:
  https://github.com/fzakaria/nixpkgs-multiverse/blob/main/docs/store-paths.md
[minimal-pr]: https://github.com/NixOS/nixpkgs/pull/401751
[minimal-api]: https://api.github.com/repos/NixOS/nixpkgs/pulls/401751
[minimal-diff]: https://api.github.com/repos/NixOS/nixpkgs/pulls/401751/files
[minimal-eval]:
  https://github.com/NixOS/nixpkgs/blob/a32edd7654519351e48e80372a928df336394670/nixos/lib/eval-config-minimal.nix
[modular]:
  https://github.com/NixOS/nixpkgs/blob/a32edd7654519351e48e80372a928df336394670/nixos/doc/manual/development/modular-services.md
[modular-writing]:
  https://github.com/NixOS/nixpkgs/blob/a32edd7654519351e48e80372a928df336394670/nixos/README-modular-services.md
[server]: https://github.com/arianvp/server-optimised-nixos/tree/master
[server-flake]:
  https://github.com/arianvp/server-optimised-nixos/blob/master/flake.nix
[server-base]:
  https://github.com/arianvp/server-optimised-nixos/blob/master/modules/base.nix
[server-activation]:
  https://github.com/arianvp/server-optimised-nixos/blob/master/activation.md
[microvm-image]:
  https://github.com/willruggiano/microvm.nix/blob/3defb1d870b45d6545df1256e50330efbb504112/nixos-modules/microvm/store-disk.nix
[microvm-options]:
  https://github.com/willruggiano/microvm.nix/blob/3defb1d870b45d6545df1256e50330efbb504112/nixos-modules/microvm/options.nix
[microvm-opt]:
  https://github.com/willruggiano/microvm.nix/blob/3defb1d870b45d6545df1256e50330efbb504112/nixos-modules/microvm/optimization.nix
[develop]: https://github.com/NixOS/nix/blob/2.34.8/src/nix/develop.cc
[remote-store]:
  https://github.com/NixOS/nix/blob/2.34.8/src/libstore/remote-store.cc
[local-store]:
  https://github.com/NixOS/nix/blob/2.34.8/src/libstore/local-store.cc
[nix-ssh]: https://github.com/NixOS/nix/blob/2.34.8/src/libstore/ssh.cc
[nix-copy]: https://github.com/NixOS/nix/blob/2.34.8/src/nix/copy.md
[nix-conf]:
  https://releases.nixos.org/nix/nix-2.34.8/manual/command-ref/conf-file.html
[eval-profiler]:
  https://releases.nixos.org/nix/nix-2.34.8/manual/advanced-topics/eval-profiler.html
[eval-cache]: https://github.com/NixOS/nix/blob/2.34.8/src/libexpr/eval-cache.cc
[git-fetcher]: https://github.com/NixOS/nix/blob/2.34.8/src/libfetchers/git.cc
[file-transfer]:
  https://github.com/NixOS/nix/blob/2.34.8/src/libstore/filetransfer.cc
[nix-evaluation]:
  https://releases.nixos.org/nix/nix-2.34.8/manual/language/evaluation.html
[ifd]:
  https://releases.nixos.org/nix/nix-2.34.8/manual/language/import-from-derivation.html
[gc-roots]:
  https://releases.nixos.org/nix/nix-2.34.8/manual/package-management/garbage-collector-roots.html
[http-cache]:
  https://releases.nixos.org/nix/nix-2.34.8/manual/store/types/http-binary-cache-store.html
[nix-bench]:
  https://releases.nixos.org/nix/nix-2.34.7/manual/development/benchmarking.html
[nix-direnv]: https://github.com/nix-community/nix-direnv
[eval-jobs]: https://github.com/nix-community/nix-eval-jobs
[devenv]: https://github.com/cachix/devenv/blob/main/devenv-eval-cache/DESIGN.md
[nix-bindings]: https://github.com/nixops4/nix-bindings-rust
[lazy-trees]: https://docs.determinate.systems/determinate-nix/lazy-trees
[parallel-eval]: https://github.com/NixOS/nix/pull/10938
[nixican]: https://github.com/Mic92/nixican-standoff
[filesets]:
  https://github.com/NixOS/nixpkgs/blob/a32edd7654519351e48e80372a928df336394670/lib/fileset/default.nix
[cache-shootout]: https://github.com/Mic92/cache-shootout
[styx]: https://github.com/dnr/styx
[snix-perf]: https://snix.dev/docs/guides/performance
[snix-boot]: https://cl.snix.dev/c/snix/+/31462/10/snix/boot/README.md
[nix-snapshotter]: https://github.com/pdtpartners/nix-snapshotter
[userborn]: https://github.com/nikstur/userborn
[userborn-module]:
  https://github.com/NixOS/nixpkgs/blob/a32edd7654519351e48e80372a928df336394670/nixos/modules/services/system/userborn.nix
[sysusers]:
  https://github.com/NixOS/nixpkgs/blob/a32edd7654519351e48e80372a928df336394670/nixos/modules/system/boot/systemd/sysusers.nix
[nixos-init]:
  https://github.com/NixOS/nixpkgs/blob/a32edd7654519351e48e80372a928df336394670/pkgs/by-name/ni/nixos-init/README.md
[nixos-init-module]:
  https://github.com/NixOS/nixpkgs/blob/a32edd7654519351e48e80372a928df336394670/nixos/modules/system/activation/nixos-init.nix
[etc-activation]:
  https://github.com/NixOS/nixpkgs/blob/a32edd7654519351e48e80372a928df336394670/nixos/modules/system/etc/etc-activation.nix
[impermanence]:
  https://github.com/nix-community/impermanence/blob/7b1d382faf603b6d264f58627330f9faa5cba149/nixos.nix
[firewall]:
  https://github.com/NixOS/nixpkgs/blob/a32edd7654519351e48e80372a928df336394670/nixos/modules/services/networking/firewall.nix
[nftables]:
  https://github.com/NixOS/nixpkgs/blob/a32edd7654519351e48e80372a928df336394670/nixos/modules/services/networking/nftables.nix
[minimal-profile]:
  https://github.com/NixOS/nixpkgs/blob/a32edd7654519351e48e80372a928df336394670/nixos/modules/profiles/minimal.nix
[initrd]:
  https://github.com/NixOS/nixpkgs/blob/a32edd7654519351e48e80372a928df336394670/nixos/modules/system/boot/systemd/initrd.nix
[not-os]: https://github.com/cleverca22/not-os
[analyze]:
  https://www.freedesktop.org/software/systemd/man/261/systemd-analyze.html
[resource-control]:
  https://www.freedesktop.org/software/systemd/man/261/systemd.resource-control.html
[unit]: https://www.freedesktop.org/software/systemd/man/261/systemd.unit.html
[mount-unit]:
  https://www.freedesktop.org/software/systemd/man/261/systemd.mount.html
[generator]:
  https://www.freedesktop.org/software/systemd/man/261/systemd.generator.html
[ssh-generator]:
  https://www.freedesktop.org/software/systemd/man/261/systemd-ssh-generator.html
[sd-notify]: https://www.freedesktop.org/software/systemd/man/261/sd_notify.html
[udev-conf]: https://www.freedesktop.org/software/systemd/man/261/udev.conf.html
[udevadm]: https://www.freedesktop.org/software/systemd/man/261/udevadm.html
[udev]: https://www.freedesktop.org/software/systemd/man/261/udev.html
[tmpfiles]: https://www.freedesktop.org/software/systemd/man/261/tmpfiles.d.html
[credentials]:
  https://www.freedesktop.org/software/systemd/man/261/systemd.exec.html
[pam-systemd]:
  https://www.freedesktop.org/software/systemd/man/261/pam_systemd.html
[nsresourced]:
  https://github.com/systemd/systemd/blob/v261.2/src/nsresourced/nsresourcework.c
[bootup]: https://www.freedesktop.org/software/systemd/man/261/bootup.html
[getty]:
  https://www.freedesktop.org/software/systemd/man/261/systemd-getty-generator.html
[containers]: https://systemd.io/CONTAINER_INTERFACE/
[ch53]: https://github.com/cloud-hypervisor/cloud-hypervisor/releases/tag/v53.0
[ch-snapshot]:
  https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/docs/snapshot_restore.md
[ch-snapshot-main]:
  https://github.com/cloud-hypervisor/cloud-hypervisor/blob/main/docs/snapshot_restore.md
[ch-memory]:
  https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/docs/memory.md
[ch-memory-code]:
  https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/vmm/src/memory_manager.rs
[ch-cpu]:
  https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/docs/cpu.md
[ch-kernel]:
  https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/README.md#building-your-kernel
[ch-block]:
  https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/virtio-devices/src/block.rs
[ch-vsock]:
  https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/docs/vsock.md
[ch-cargo]:
  https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/Cargo.toml
[firecracker-snapshot]:
  https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md
[uniqueness]:
  https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md
[reap]: https://github.com/vhive-serverless/vhive
[reap-paper]: https://arxiv.org/html/2101.09355v3
[faasnap]: https://github.com/ucsdsysnet/faasnap
[erofs]: https://docs.kernel.org/filesystems/erofs.html
[erofs-mkfs]: https://erofs.docs.kernel.org/en/latest/mkfs.html
[overlayfs]: https://docs.kernel.org/filesystems/overlayfs.html
[ext4]: https://docs.kernel.org/admin-guide/ext4.html
[mke2fs]: https://man7.org/linux/man-pages/man8/mke2fs.8.html
[readahead]: https://man7.org/linux/man-pages/man2/readahead.2.html
[cp]: https://www.gnu.org/software/coreutils/manual/html_node/cp-invocation.html
[boot-trace]: https://www.kernel.org/doc/html/latest/trace/boottime-trace.html
[kernel-params]: https://docs.kernel.org/admin-guide/kernel-parameters.html
[cpufreq]: https://docs.kernel.org/admin-guide/pm/cpufreq.html
[thermal]: https://docs.kernel.org/driver-api/thermal/sysfs-api.html
[thp]: https://docs.kernel.org/admin-guide/mm/transhuge.html
[ssh-config]: https://man.openbsd.org/ssh_config
[sshd-config]: https://man.openbsd.org/sshd_config
[ssh-keygen]: https://man.openbsd.org/ssh-keygen
[bash-startup]:
  https://www.gnu.org/software/bash/manual/html_node/Bash-Startup-Files.html
[hyperfine]: https://github.com/sharkdp/hyperfine
