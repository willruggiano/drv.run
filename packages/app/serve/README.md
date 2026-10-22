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

### Frontend delivery baseline

Production frontend sources: `7d9a1b02`. Medians from three fresh browsers per
frontend, run sequentially without competing tests: Chromium 153.0.8010.47, Node
24.20.0, Linux ARM64/Cortex-A76, 4 available CPUs, no throttling, 390×844 mobile
viewport. Same 200 turns (600 entries), 40 streaming updates and 10 busy/idle
transitions as the renderer workload above.

| Frontend | Initial (ms) | Start streaming (ms) | Stream update (ms) | Busy/idle (ms) | HTTP bytes/update |
| -------- | -----------: | -------------------: | -----------------: | -------------: | ----------------: |
| Original |       758.90 |                51.20 |              54.35 |          48.00 |         635,177.0 |
| htmx POC |       740.20 |                93.00 |              59.50 |          65.40 |             821.5 |

Initial time runs from navigation start to transcript layout. Updates include
Durable commits, browser-control transport, real HTTP/SSE delivery, rendering
and synchronous layout; they exclude completed paint. These are not comparable
to the renderer-only timings above. CDP network observation waits for the first
SSE frame, then stops before streaming measurements. CPU profiles and traces
remain confined to separate diagnostic runs.

Bytes count actual server socket writes: HTTP response headers, bodies and chunk
framing, including supplementary reads; not TCP/IP overhead. No compression is
configured. Per-update ranges were 634,280–636,074 bytes (original) and
373–1,270 bytes (POC). Median initial delivery, including assets and the first
SSE frame, was 1,433,490 and 7,253,776 bytes respectively. The POC currently
retransmits history on first connect.

```sh
NODE_OPTIONS=--conditions=development node packages/app/serve/benchmark.ts --frontend original > original.json
NODE_OPTIONS=--conditions=development node packages/app/serve/benchmark.ts --frontend hypermedia > hypermedia.json
```

Reports contain every timing and byte sample. Omitting `--frontend` retains the
renderer-only benchmark; `--profile` also works with either frontend.

### Asset size

Served bytes before HTTP compression, including license notices.

| Revision |   Client JS (B) | Highlighter JS (B) |         CSS (B) | Service worker (B) |        Total (B) |
| -------- | --------------: | -----------------: | --------------: | -----------------: | ---------------: |
| Minified | 38,186 (-48.7%) |    60,653 (-61.7%) | 14,759 (-14.5%) |       669 (-34.0%) | 114,267 (-54.5%) |
| 9c18629  |          74,504 |            158,216 |          17,258 |              1,014 |          250,992 |
