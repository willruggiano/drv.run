# serve

## Running

Run as the drv.run instance owner:

```sh
nix run .#app
```

There are no command-line options. `HOST` defaults to `127.0.0.1`; `PORT`
defaults to `8080`. The server is unauthenticated. Execution uses drv.run guests
only; there is no local execution target.

## Keyboard shortcuts

Ctrl/⌘+K opens Sessions. Outside text fields and native selects, `t` opens the
target selector, `m` opens the model selector, and `n` creates a session using
the selected target/model. `/` focuses the session filter. Escape dismisses the
dialog. Ctrl+J/K moves to the next/previous filtered session (wrapping at the
ends); Enter opens it. The same keys navigate menu items, select options, and
conversation search matches when those controls have focus.

Focused browser tests (with Chromium on PATH):

```sh
NODE_OPTIONS=--conditions=development node --test packages/app/serve/tests/key-mappings.chromium.ts
```

## Base directory

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

Use ↑/↓ or Ctrl+J/K to navigate suggestions, Enter/Tab or a tap to select, and
Escape to dismiss. Selecting a command only inserts it; use Send or Ctrl/⌘+Enter
to execute. Ordinary Enter still inserts a newline when the suggestion list is
closed.

Run the focused tests with Chromium and esbuild on PATH:

```sh
NODE_OPTIONS=--conditions=development node --test packages/app/serve/tests/completions.*.ts
```

## Benchmarks

“Minified” uses esbuild 0.27.2. Deltas are relative to the unminified build at
`9c18629`.

### Rendering

Medians from three fresh browsers: Chromium 153, Linux ARM64/Cortex-A76, 2
available CPUs, no throttling, 390×844 mobile viewport. Each run uses 200 turns
(600 entries), 40 streaming updates and 10 busy/idle transitions.

| Revision |   Initial (ms) | Start streaming (ms) | Stream update (ms) | Busy/idle (ms) |
| -------- | -------------: | -------------------: | -----------------: | -------------: |
| Minified | 318.80 (+1.3%) |        12.10 (+0.8%) |       8.55 (-4.5%) | 10.00 (+11.1%) |
| 9c18629  |         314.70 |                12.00 |               8.95 |           9.00 |

Includes JSON parsing, rendering and synchronous layout; excludes asset loading,
network and completed paint. Timing samples are unprofiled; small differences
between these runs are not evidence of a rendering speedup.

```sh
nix run .#app.bench.render > benchmark.json
```

Add `-- --profile` for a separate diagnostic run with CPU profiles and browser
traces; artifact paths appear in the JSON report.

### Asset size

Served bytes before HTTP compression, including license notices.

| Revision |   Client JS (B) | Highlighter JS (B) |         CSS (B) | Service worker (B) |        Total (B) |
| -------- | --------------: | -----------------: | --------------: | -----------------: | ---------------: |
| Minified | 38,186 (-48.7%) |    60,653 (-61.7%) | 14,759 (-14.5%) |       669 (-34.0%) | 114,267 (-54.5%) |
| 9c18629  |          74,504 |            158,216 |          17,258 |              1,014 |          250,992 |
