# Contributing

- Read `justfile` for essential development commands
- Use Conventional Commit messages: `<type>(<scope>): <subject>`
  - `<scope>` is optional, apply it when necessary
- Use `codemode` to orchestrate tool calls and `pi` subprocesses
- Be frugal about adding _new_ files. Prefer inlining code unless it is
  genuinely shared across modules.
- No example dependencies in core drv.run modules and tests. The examples are
  intentionally standalone example flakes -- they depend on drv.run, not the
  other way around. The only (temporary) exception is the `rockctl` j2hc.
