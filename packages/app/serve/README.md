# serve

<!-- FIXME: Refactor this doc to be more useful -->

## Running

There are no command-line options. `HOST` defaults to `127.0.0.1`; `PORT`
defaults to `8080`. The server is unauthenticated. Execution uses drv.run guests
only; there is no local execution target.

## Base directory

<!-- FIXME: Move to a new public/configuration.md file -->

For drv.run targets, **Base directory** in Sessions sets the new session's
working path. Session settings can change it for the current conversation. Empty
means `/workspace`; both `foo` and `/foo` mean `/workspace/foo` (even
`/workspace/foo` means `/workspace/workspace/foo`). `..` components are
rejected. This sets the working directory, not a filesystem sandbox; symlinks
and tools' explicit absolute paths retain their normal behavior.

Suggestions list directories in the selected guest, including nested paths; type
`.` to include hidden directories. The setting uses Durable's native `cwd`, so
it persists across restarts and is inherited by forks. File tools, commands, `@`
completion, and repository status all use the current conversation's directory.

## Mentions and commands

<!-- FIXME: Move to a new public/usage.md file -->

Type `@` at a word boundary to browse paths in the session's guest workspace.
Completion matches name prefixes; select a directory to browse inside it. Type
`.` to include hidden entries. Paths containing spaces are quoted automatically.
Mentions insert path references, not file contents. Listing is bounded to 5,000
entries per directory and 50 suggestions.

Type `/` at the start of a message for commands: `/sessions`, `/new`,
`/settings`, `/model`, `/compact [instructions]`, `/reset [handoff]`, `/stop`,
`/resume`, `/export`, and `/search`. `/new` uses the target and model selected
in Sessions. Reset asks for confirmation and preserves history. Unknown commands
and failed operations leave the draft intact; commands are never submitted as
model prompts.

Use ↑/↓ or `ctrl+j/k` to navigate suggestions, `enter`/`tab` or a tap to select,
and `escape` to dismiss. Selecting a command only inserts it; use Send or
`ctrl+enter` to execute. Ordinary `enter` still inserts a newline when the
suggestion list is closed.

<!-- FIXME: Move most of the rest of this doc to CONTRIBUTING.md or docs/benchmarks.md -->

Run the focused tests with Chromium and esbuild on PATH:

```sh
NODE_OPTIONS=--conditions=development node --test packages/app/serve/tests/completions.*.ts
```

## Benchmarks

```sh
nix run .#app.bench.render > benchmark.json
```

Add `-- --profile` for a separate diagnostic run with CPU profiles and browser
traces; artifact paths appear in the JSON report.
