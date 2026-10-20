# Contributing

This repository is a work in progress. There is _no_ backwards compatibility
requirement. If you haven't already, read [[README.md]].

- Read `justfile` for essential development commands
- Use Conventional Commit messages: `<type>(<scope>): <subject>`
  - `<scope>` is optional, apply it when necessary
- Use `codemode` to batch tool calls
- Be frugal about adding _new_ files. Prefer inlining code unless it is
  genuinely shared across modules.
- No `./example/*` dependencies in core drv.run modules and tests. The examples
  are intentionally standalone example flakes -- they depend on drv.run, not the
  other way around. The only (temporary) exception is the `rockctl` j2hc.

## Documentation

- Do not edit Markdown files unless explicitly instructed to do so.
- Do not add "intent to edit" Markdown files to any plan or working/session
  document unless explicitly instructed to do so.
- Do not create new Markdown files unless explicitly instructed to do so.
- You may delete Markdown files iff they are obsolete.

### Writing documentation

Writing/editing Markdown requires explicit instruction!

- Use repository-relative wiki links, including `.md`: `[[docs/extensions.md]]`.
- Use standard Markdown links for external URLs.
- One H1, do not skip heading levels, and label every fenced code block.
- One topic per file. Link to the source of truth instead of duplicating it.
- Keep only concise, verifiable information. Remove stale content and update its
  callers; do not leave migration notes or tombstones.
- `markdownlint-cli2` is the source of truth for markdown strictness.
- Several doc files have a header explicitly forbidding you from editing them;
  do not break this file-specific rule!

## Testing

- `nix flake check` is the authoritative test suite and required for all changes
  (except markdown-only ones). It is quite slow so save it for the end.
- `just check` runs the Nix-free formatters, linters and type checks.
- `just test` runs Node tests and Nix evaluation; `just pre-commit` also runs
  full Nix validation. See `justfile` for the commands.
- In the coding jail, run `just check` and `node --test "**/*.test.ts"`
  directly. Leave Nix-dependent recipes and validation to the operator outside
  the jail.
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

### Pi extension tests

- Put them in `<extension>/tests/*.test.ts`
- Use `node:test` and `node:assert/strict`
- Test observable extension behavior, especially event ordering and lifecycle
  boundaries. Add a focused regression test for bug fixes.
- Keep tests deterministic and offline. Use temporary directories and register
  cleanup with the test context.
- Keep harnesses minimal. Test doubles may use narrow local interfaces and one
  cast at the extension boundary; do not weaken production types.
