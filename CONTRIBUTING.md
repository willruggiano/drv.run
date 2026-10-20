# Contributing

This repository is a work in progress. There is _no_ backwards compatibility
requirement.

- **Think first:** Verify behavior against the upstream sources. State
  consequential assumptions and ask when interpretation changes the task. Work
  backwards from the user when designing the solution.
- **Keep it simple:** Implement only what is needed. Avoid speculative features,
  premature optimization, and clever control flow. Shared abstractions are only
  acceptable when multiple consumers/implementations exist.
- **Stay strict:** Write idiomatic, strictly typed code. Do not suppress check
  failures without precise justification and user approval. Assert aggressively.
- **Be surgical:** Touch only relevant code, match existing style, remove what
  your change makes obsolete, and report unrelated issues instead of widening
  scope.
- **Verify outcomes:** Run relevant tests and static checks. Measure before and
  after performance work.
- **Make Ken Thompson proud:** Follow the Unix Philosophy: [[unix.md]].

## Communication

- Tone: concise and precise, technical, blunt
- The user is highly technical; do not "dumb things down"
- Prefer short, direct sentences and active voice; loosely follow ASD-STE100
- State the conclusion/solution first; these can be code snippets if apropo
- Use exact technical terms. Do not replace technical terminology with vague
  slop language
- Use ASCII diagrams to explain flow and/or relationships
- Prefer diagrams to prose
- Always cite your sources; source code and documentation are the only
  acceptable form of primary evidence. Prefer _locally available_ source code
  and documentation (eg. /nix/store paths) to code/docs found on the web. Source
  code and documentation **must** match the version of the software declared by
  this project.
- Preserve important caveats and uncertainty. Distinguish facts, assumptions,
  and ambiguities. Do not turn a simple question into a tutorial.
- Avoid jargon, hype, rhetorical framing, motivational language, filler,
  repetition, dramatic wording, and unnecessary background explanation.
- Communication is the single most important skill. Get it _precisely_ right.

### Terminology

- **Client**: the computer from which the user `ssh drv.run <flake ref>`
- **Host**: the node to which the user `ssh drv.run <flake ref>`
- **Guest**: the VM on the _Host_ where the user lands after `ssh drv.run` or
  `ssh drv.run.XXX`
- **Guest closure**: the NixOS system closure that defines the _Guest_
- **Flake closure**: the build/development environment derived from the user's
  provided flake reference (`ssh drv.run <flake ref>`) that is activated when
  the user enters the _Guest_
- **Instance**: one systemd drv.run@%i.service

Note: terms are not proper nouns. They are case insensitive to avoid ambiguity.
For example, "Host" and "host" will be interpreted identically by me. Make sure
you clarify your meaning if are forced to used these terms in a manner
inconsistent with the definitions above.

### Examples

**Bad communication:**

```text
  choose attachment and provisioning mechanisms
      |
      v
  identify remaining host-to-guest operations
      |
      v
  determine their connection parameters
      |
      v
  choose configuration representation
```

**Good communication:**

```text
  operator's terminal
      |
      | outer SSH connection
      v
  host sshd -> host PTY
                  |
                  | inherited terminal file descriptors
                  v
             host-side SSH client
                  |
                  | inner SSH connection, requesting a guest PTY
                  v
             guest sshd -> guest PTY -> nix develop
```

## Making changes

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
