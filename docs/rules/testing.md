# Testing conventions

- `nix flake check` is the authoritative test suite and required for all changes
  (except markdown-only ones). It is quite slow so save it for the end.
- `make check` and `make test` are the "fast" checks: linters, formatters, unit
  tests, etc.
- Fix failures caused by the change. If execution is blocked, report the exact
  command and failure and leave verification explicitly blocked.
- All checks run in CI.
- Do NOT write tests that assert stdout/stderr or attempt to string match in any
  other way. Write tests against interfaces, assert on state.

## Nix checks

- Assert aggresively in nixos modules
- Add or update a nixos test in `nix/nixosTests/`
- Test with `nix flake check` or by building a specific check, eg.
  `nix build .#checks.x86_64-linux.host-basic`

## Pi extension tests

- Put them in `extensions/<extension>/tests/*.test.ts`
- Use `node:test` and `node:assert/strict`
- Test observable extension behavior, especially event ordering and lifecycle
  boundaries. Add a focused regression test for bug fixes.
- Keep tests deterministic and offline. Use temporary directories and register
  cleanup with the test context.
- Keep harnesses minimal. Test doubles may use narrow local interfaces and one
  cast at the extension boundary; do not weaken production types.
