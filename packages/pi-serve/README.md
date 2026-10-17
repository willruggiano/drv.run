# pi-serve

## Keyboard shortcuts

Ctrl/⌘+K opens Sessions. Outside text fields and native selects, `t` opens the
target selector, `m` opens the model selector, and `n` creates a session using
the selected target/model. `/` focuses the session filter. Escape dismisses the
dialog. Ctrl+J/K moves to the next/previous filtered session (wrapping at the
ends); Enter opens it. The same keys navigate menu items, select options, and
conversation search matches when those controls have focus.

Focused browser tests (with Chromium available):

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=$(command -v chromium) node --test packages/pi-serve/key-mappings.test.ts
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
nix run .#pi-serve.bench.render > benchmark.json
```

Add `-- --profile` for a separate diagnostic run with CPU profiles and browser
traces; artifact paths appear in the JSON report.

### Asset size

Served bytes before HTTP compression, including license notices.

| Revision |   Client JS (B) | Highlighter JS (B) |         CSS (B) | Service worker (B) |        Total (B) |
| -------- | --------------: | -----------------: | --------------: | -----------------: | ---------------: |
| Minified | 38,186 (-48.7%) |    60,653 (-61.7%) | 14,759 (-14.5%) |       669 (-34.0%) | 114,267 (-54.5%) |
| 9c18629  |          74,504 |            158,216 |          17,258 |              1,014 |          250,992 |
