# Elm conversation prototype

Status: proposed. This specification does not describe implemented behavior.

## Decision to evaluate

Build an opt-in Elm conversation frontend alongside the existing htmx frontend.
Determine whether explicit, typed state transitions simplify the app without
moving its application logic into JavaScript adapters or regressing interaction
behavior, delivery cost, or responsiveness.

This is an evaluation, not authorization to replace the production frontend.
Keep the TypeScript server, Durable, harness, and execution integration. Elm
owns presentation state; Durable remains authoritative for conversation state.

The prototype requires JavaScript. Existing htmx routes retain their native-form
behavior. Requiring JavaScript for a future replacement is a separate adoption
decision.

## Scope

Implement one complete conversation route under a separate `/elm` namespace,
with direct navigation to an existing session and conversation. Provide enough
navigation to switch between two existing conversations and exercise browser
back/forward. Use the existing frontend or test fixtures to create sessions.

Include:

- Completed history, live text and thinking, paired tool calls/results, images,
  queued inputs, usage, and connection state.
- Submission while idle, follow-up and steering while busy, queue cancellation,
  abort, and resume.
- Editable drafts, attachment selection/removal, paste/drop, and previews.
- Path and command completions, keyboard navigation, and IME handling.
- Reset confirmation and compaction, including access to archived history.
- Local transcript search, disclosure state, scrollback, and text selection.
- Draft persistence across reload and recovery from unavailable browser storage.

Reuse the existing CSS and visual conventions. Preserve accessibility semantics,
focus visibility, keyboard operation, and mobile layout. Do not combine the
prototype with a visual redesign.

Out of scope:

- Rewriting session creation, settings, review, context inspection, repository
  inspection, or export screens.
- Replacing the authentication flow, PWA installation/update UX, or service
  worker.
- Offline conversation replication, optimistic durable state, collaborative
  editing, a generic JSON-patch engine, or a new client persistence database.
- A component framework, routing framework, schema generator, or public API
  compatibility policy.

Expose only implemented commands. Unsupported slash commands must report an
error and retain the draft; they must never become model prompts. Missing
out-of-scope screens must remain explicit limitations in the evaluation report.

## Ownership

```text
TypeScript server                         Browser
-----------------                         -------
Durable / Sessions
    |
    +-> presentation projection -- SSE --> TypeScript transport adapter
    |                                                 |
    |                                                 v
    |                                           Elm Model/update
    |                                                 |
    |                                                 v
    +<-- validated commands ------ HTTP --------- Elm view
                                                      |
                                              browser capabilities
```

- Server: durable state, command validation, execution, policy, and submission
  deduplication. A disconnected browser does not stop an agent run.
- Elm: decoded presentation state, route, drafts, pending operations, completion
  state, search, disclosure choices, and connection status.
- TypeScript browser adapter: SSE lifecycle and browser capabilities not covered
  by Elm packages. It must not decide workflow transitions or maintain a second
  copy of the application model.

Keep durable observations distinct from local interaction state. A stream update
must not replace a draft, acknowledge a submission, or reset disclosure choices.
Represent lifecycle alternatives with custom types rather than unrelated flags.

Use the existing application services directly from both presentation adapters.
Extract shared command logic only where the prototype creates a second consumer.
Do not call HTML routes internally and parse their output.

## HTTP and stream contract

Serve an Elm shell and namespaced data/command endpoints through the existing
HTTP server. Keep the same origin checks, authorization, content security
policy, request limits, and error redaction requirements. GET requests must not
mutate Durable state. The default `/sessions` frontend remains unchanged.

Use explicit JSON encoders and Elm decoders for a small presentation contract.
Do not serialize the complete upstream harness or expose arbitrary document
kinds. Unknown or malformed protocol messages must produce a visible protocol
error, retain local work, and trigger a controlled resynchronization or explicit
retry. Never silently discard a failed decode and continue with partially
updated state.

### Observation

The SSE connection supplies the initial snapshot. Do not fetch a second full
snapshot before opening the stream.

1. Attach to committed state without a gap between snapshot and subscription.
2. Send one coherent snapshot containing the conversation identity, transcript
   and archive structure, current live state, queue, and displayed metadata.
3. Send incremental frames after that snapshot. Completed entries are delivered
   when introduced; document-only changes do not retransmit completed history.
4. Apply each frame atomically in Elm. Entry order and tool/result association
   must come from explicit identities, not DOM position or text matching.

Use domain-specific updates: new entries, transcript structure changes, and
replacement of changed live/queue/metadata regions. Do not port Durable's
generic replication internals into Elm. Preserve unchanged entry values in the
Elm model so lazy rendering can reuse them.

Each subscription has an identity and ordered frame sequence. Tag browser events
with the subscription identity; navigation invalidates the old subscription.
Detect missing, duplicate, and out-of-order frames before applying incremental
updates. Do not confuse a transcript head with a revision of all displayed
state.

For the first prototype, reconnect starts a fresh subscription and snapshot;
there is no cross-connection replay log. Reconcile it by stable entry identity,
replace obsolete server observations, and preserve local interaction state.
Measure the cost of retransmitting history on reconnect separately. A future
resume optimization is not a prerequisite for evaluating Elm.

Close subscriptions on navigation and release server observers on disconnect.
Bound pending transport work; a slow consumer must disconnect and resynchronize
rather than accumulate an unbounded queue. Reconnection failures must not create
a tight retry loop.

### Commands

Use HTTP requests with structured success/error responses. Multipart submission
is permitted for attachments; ordinary commands use JSON. Keep validation and
all durable effects on the server.

Every submission carries a stable request identity and the draft revision it
represents. Capture its text, attachments, destination, and busy mode once.
Retrying an uncertain submission reuses its identity and original payload.
Editing creates a new draft revision, not a mutation of the pending request.

An acknowledgement may clear only its matching draft revision. A late response
may acknowledge the old conversation's draft but must not navigate or mutate the
currently displayed conversation. An unrelated stream update is never an
acknowledgement. Failed requests retain the draft and files.

Do not infer command success from a disconnected transport, a matching
transcript string, or the absence of an error frame. Preserve Durable's existing
idempotency semantics; do not claim that every mutation is retry-safe.

## Browser integration and rendering

Use Elm's HTTP, file, event, navigation, and basic DOM APIs where they suffice.
Use ports or custom elements for missing capabilities, with typed request/result
messages and explicit ownership. Port callbacks from old routes or revisions
must be rejected just like stale HTTP responses.

Do not load htmx into the Elm page or let both renderers manage a subtree.
During evaluation, switching between the two frontends is a full page
navigation.

Likely integration boundaries are SSE, browser storage, caret/text-selection
operations, and syntax highlighting. A retained highlight.js integration must
own an isolated subtree; it must not rewrite Elm-owned children. Search matching
belongs in Elm even if range highlighting requires browser integration.

Persist draft text and retry identity in session storage, not conversation
history or attachment bytes. Keep in-memory drafts usable if storage is denied
or malformed. Do not expand the service worker's cache to include conversation
responses or protocol frames.

### Transcript identity gate

The existing tests require completed entry nodes to survive reset/compaction
when they move beneath an archive. Elm keys identify children within a parent;
they do not provide global DOM identity across reparenting.

Resolve this in the first rendering slice, before building the remaining UI:

- Prefer a stable-parent transcript layout with model-driven archive visibility.
- Preserve completed nodes across live updates and preserve user disclosure,
  selection, focus, and scrollback through reset/compaction.
- Verify the behavior in Chromium, including nested archives and search results
  inside collapsed history.
- Do not silently weaken existing assertions. If equivalent behavior requires
  different archive DOM structure, identify the affected assertions and obtain
  approval before changing the acceptance contract.

A large imperative transcript renderer underneath Elm is evidence against the
proposed architecture, not an acceptable way to claim a successful Elm rewrite.

Treat all model/tool output as untrusted content. Retain inert text rendering,
URL restrictions, image validation, and tests for hostile transcript content.

## Build and tests

Pin the compiler through the project's nixpkgs input and pin Elm application and
test dependencies explicitly. Verify the actual compiler version at that input;
do not assume a version from an unrelated Elm installation. Record selected
versions in build manifests, not only in this document.

Integrate compilation into the same asset build path used by the Nix package,
browser tests, and benchmark. Build release assets with Elm optimization
enabled. Keep compiler/tooling out of the server runtime closure. Nix builds
must use prefetched package sources and registry metadata and require no network
access.

Add Elm formatting, compilation, and pure tests to the app's checks and Nix
`checkPhase`. Keep existing TypeScript checks and tests. Use minimal Elm tests
for state transitions and decoders, Node tests for server/adapter interfaces,
and Chromium tests for browser behavior. No new NixOS test is needed.

Tests must be deterministic and offline, with faux model responses and real
Durable state where integration requires it. Assert model, durable, DOM, and
resource-lifecycle state; do not assert log output or serialized markup strings.
Follow [[CONTRIBUTING.md]] for execution boundaries and report checks passed
separately from deferred validation.

### Required behavioral cases

- Edit text and attachments during an outstanding submission; its
  acknowledgement clears only the submitted revision. Reload and retry a lost
  acknowledgement without duplicating the durable input.
- Switch conversations with pending commands and active SSE. Late callbacks do
  not change the new page; server and browser subscriptions are released.
- Disconnect during generation, append, reset, and compaction. Reconnect
  converges without duplicated entries, stale live output, or loss of a newer
  draft.
- Deliver malformed, stale, duplicate, and discontinuous stream frames. The
  model remains coherent and recovery is observable.
- Exercise busy/idle transitions, steering, follow-up, cancellation, abort, and
  resume against Durable state rather than button labels alone.
- Dismiss or change a completion query before its response arrives. Preserve IME
  composition, caret placement, keyboard selection, and ordinary newline input.
- Add/remove/paste/drop attachments; enforce existing type/count/size limits on
  both sides. A failed request retains the selected files.
- Preserve scrollback while output streams; follow new output only when pinned
  to the bottom and not actively selecting text. Back/forward restores the
  intended conversation and local state.
- Preserve disclosure defaults for new failed tools and user choices for
  existing tools. Reset/compaction and local search satisfy the transcript
  identity gate.
- Keep hostile output inert, mutations protected by existing origin/auth rules,
  and transcript content absent from persistent browser caches.

## Measurement and adoption gate

Capture a fresh htmx baseline before implementation. Extend the existing
benchmark to select either frontend with the same Durable workload, server
configuration, assets mode, browser, viewport, and machine conditions.

Use its 200-turn/600-entry workload, 40 streaming updates, and 10 busy/idle
transitions. Also measure reconnect and reset/compaction with long history.
Report raw samples and repeated-run summaries for:

- Navigation-to-transcript layout and commit-to-updated-layout latency.
- Initial, streaming, and reconnect HTTP bytes, including supplementary
  requests.
- Served asset bytes and separate forced-GC heap/DOM measurements.
- Browser and server work where diagnostic profiles identify a regression.

Keep profiles and forced-GC runs separate from timing samples. Preserve the
benchmark's timing boundaries and report exclusions; layout completion is not
completed paint. Do not compare renderer-only timings with end-to-end timings.
Do not introduce virtualization or change history visibility merely to improve
one frontend's result.

Recommend adoption only when:

1. The required behavioral cases pass and the htmx frontend remains unaffected.
2. Elm owns workflow state; TypeScript adapters remain capability boundaries.
3. Incremental updates avoid completed-history retransmission and rebuilding.
4. Repeated measurements show no unexplained material regression. Any accepted
   performance tradeoff is explicit and approved, not hidden by a faster median
   from another phase.
5. The report identifies remaining work for out-of-scope screens, no-JavaScript
   support, and PWA behavior before a full replacement.

The report must distinguish observed simplifications from expectations. Include
remaining imperative code, decoder/contract maintenance, build complexity, and
any interaction compromises. A functional TypeScript state machine is the
lower-migration-cost alternative if Elm's interop costs dominate.

## Implementation references

Current behavior and reusable interfaces:

- [Application boundary](serve/application.ts), [Sessions](serve/sessions.ts),
  and [HTTP/auth boundary](serve/server.ts).
- [HTML projection and transport](serve/hypermedia.ts), especially
  `ConversationFragments` and `events`.
- [Draft lifecycle](serve/hypermedia-drafts.ts),
  [completion lifecycle](serve/hypermedia-completions.ts), and
  [stream/selection integration](serve/hypermedia-stream.ts).
- [Transcript rendering](serve/hypermedia-render.ts),
  [attachments](serve/hypermedia-attachments.ts), and
  [search](serve/hypermedia-search.ts).
- [Streaming and identity tests](serve/tests/hypermedia.chromium.ts),
  [workflow tests](serve/tests/hypermedia-parity.chromium.ts), and
  [layout tests](serve/tests/hypermedia-visual.chromium.ts).
- [Asset build](serve/build.ts), [Nix package](default.nix), and
  [delivery benchmark](serve/benchmark.ts).

Elm API references used for the evaluation, not existing project dependencies:

- [Browser 1.0.2](https://package.elm-lang.org/packages/elm/browser/1.0.2/Browser)
  and
  [DOM operations](https://package.elm-lang.org/packages/elm/browser/1.0.2/Browser-Dom).
- [HTTP 2.0.0](https://github.com/elm/http/blob/2.0.0/src/Http.elm) and
  [File 1.0.5](https://github.com/elm/file/blob/1.0.5/src/File.elm).
- [Lazy rendering 1.0.0](https://github.com/elm/html/blob/1.0.0/src/Html/Lazy.elm),
  [keyed nodes 1.0.0](https://github.com/elm/html/blob/1.0.0/src/Html/Keyed.elm),
  and
  [keyed diff 1.0.3](https://github.com/elm/virtual-dom/blob/1.0.3/src/Elm/Kernel/VirtualDom.js).

Recheck these APIs against the versions selected for the implementation.
