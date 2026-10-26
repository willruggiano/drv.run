# Contributing

This repository is a work in progress. There is _no_ backwards compatibility
requirement. If you haven't already, read [[README.md]].

- Read `justfile` for essential development commands
- Use Conventional Commit messages: `<type>(<scope>): <subject>`
  - `<scope>` is optional, apply it when necessary
- Be frugal about adding _new_ files. Prefer inlining code unless it is
  genuinely shared across modules.
- No `./example/*` dependencies in core drv.run modules and tests. The examples
  are intentionally standalone example flakes -- they depend on drv.run, not the
  other way around. The only (temporary) exception is the `rockctl` j2hc.

## Documentation

<!-- If you are NOT a human, you may not write/update documentation without the
user's explicit approval. -->

- Source code is the source of truth. Do not restate in Markdown what can be
  learned by reading source code. Prefer citing the source code directly.
- Use repository-relative wiki links, including `.md`: `[[docs/extensions.md]]`.
- One topic per file. Link to the source of truth instead of duplicating it.
- Keep only concise, verifiable information. Remove stale content and update its
  callers; do not leave migration notes or tombstones.
- All Markdown changes must pass `markdownlint-cli2`, no exceptions.
- Aggressively delete documentation that is obselete.

## Testing

- `nix flake check` is the authoritative test suite.
  - All Nix-defined packages should have at minimum a `checkPhase` in which unit
    tests run. `installCheckPhase`s probably aren't necessary.
  - Nix-defined packages with benchmarks and/or nixos/vm tests should expose
    these through `passthru.bench` and `passthru.tests`. Package nixos tests
    should be added as flake checks with a `nixos-` prefix.
  - Never add benchmarks as flake checks.
  - Be frugal about adding or extending nixos/vm tests. Prefer in order:
    1. Nodejs tests
    2. Chromium tests
    3. Nix flake checks that don't require a nixos vm
    4. Nixos tests
  - (temporary) Do NOT run the `nixos-host-basic` check. It is too slow and
    memory intensive on aarch64 where it has to run under TCG EL2 :/
- `just check` runs the Nix-free formatters, linters and type checks.
- `just test` runs Node tests and Nix evaluation; `just pre-commit` also runs
  full Nix validation. See `justfile` for the commands.
- Fix failures caused by the change. If execution is blocked, report the exact
  deferred command and reason; distinguish checks passed from verification
  pending. Do not attempt a known-unavailable tool just to obtain an error.
- All checks run in CI.
- Do NOT write tests that assert stdout/stderr or attempt to string match in any
  other way. Write tests against interfaces, assert on state.

### Timings

Measurements from a ROCK 5B instance with 2 CPU, 3gb memory.

Sequential runs, without competing Nix builds:

| Command/suite           |   Time | Result                               |
| ----------------------- | -----: | ------------------------------------ |
| Non-Chromium Node tests |  56.6s | 108 passed                           |
| `just test`             |  69.5s | Passed                               |
| `just chromium`         | 187.1s | 19 passed                            |
| `just ci`               | 384.0s | Passed, including aarch64 Nix checks |

### Nix checks

- Assert aggresively in nixos modules
- Add or update a nixos test in `nix/nixosTests/`
- Test with `nix flake check` or by building a specific check, eg.
  `nix build .#checks.x86_64-linux.host-basic`

### TypeScript tests

- Put them in `<package>/tests/*.test.ts`
- Use `node:test` and `node:assert/strict`
- Test observable behavior, especially event ordering and lifecycle boundaries.
  Add a focused regression test for bug fixes.
- Keep tests deterministic and offline. Use temporary directories and register
  cleanup with the test context.
- Keep harnesses minimal. Test doubles may use narrow local interfaces and one
  cast at the interface boundary; do not weaken production types.
