# PDS hypermedia API

## 1. Scope and authority

PDS is an independent HTML application over `packages/durable/harness`. It does
not import `packages/app`, `packages/www`, or `packages/durable/api`. Those
applications are design references, not runtime dependencies.

Durable owns conversations, entries, submissions, configuration, execution, and
persistence. PDS owns forms, HTML projection, and HTTP connections. The browser
owns drafts, selected files, disclosure state, and scroll position. It does not
maintain a conversation replica or interpret Durable operations.

```text
HTML form -- POST --> PDS -- native operation --> Durable
browser   <-- HTML -- PDS <-- bounded watch ---- Durable
```

This specification adapts [[packages/durable/api/SPEC.md]] and
[[packages/durable/api/watch/SPEC.md]] to hypermedia. It does not promise their
entire operation surface. Upstream types and contracts take precedence over this
adapter's interpretation.

## 2. References and design choices

- [Durable integration](../durable/harness/src/index.ts) defines the extensions
  and execution environments used here. PDS must not replace that integration
  with its own conversation store.
- [Datastar's Tao](https://data-star.dev/guide/the_tao_of_datastar) supplies the
  backend-authoritative, HTML-first approach.
- [Form data](https://data-star.dev/examples/form_data) and
  [file upload](https://data-star.dev/examples/file_upload) are interaction
  references. Native named controls and multipart forms are preferred over JSON
  signals containing application state or base64 file contents.
- [Pinned Datastar fetch implementation][fetch] and [element patch
  implementation][elements] define the wire behavior, not examples from a newer
  release.
- [Hyperlith at the inspected revision][hyperlith] informs server ownership,
  separate command/observation paths, and backpressure. Its recommendation to
  morph an entire `main` is deliberately **not** adopted: PDS must stream
  incremental transcript regions.

[fetch]:
  https://github.com/starfederation/datastar/blob/v1.0.5/library/src/plugins/actions/fetch.ts
[elements]:
  https://github.com/starfederation/datastar/blob/v1.0.5/library/src/plugins/watchers/patchElements.ts
[hyperlith]:
  https://github.com/andersmurphy/hyperlith/blob/385d7ae7df3422af8806f72f37d0c18640091260/README.md

## 3. Resources and commands

Let `C` be `/sessions/{conversationId}`. IDs are native Durable IDs; URL parsing
must reject invalid integers rather than silently coercing them. Resource lookup
must distinguish a missing conversation from an internal failure.

| Method | Resource                         | Result                                                |
| ------ | -------------------------------- | ----------------------------------------------------- |
| GET    | `/`                              | Home, creation form, persisted PDS sessions           |
| GET    | `C`                              | Conversation page and bounded initial projection      |
| GET    | `C/events`                       | Fresh baseline, then incremental Datastar SSE patches |
| GET    | `C/entries?before=ID[&after=ID]` | One explicitly requested older page                   |
| POST   | `/sessions`                      | Validate, create, submit initial input, navigate      |
| POST   | `/thinking`                      | Render the thinking selector for a model on home      |
| POST   | `C/message`                      | Submit a message or execute a supported slash command |
| POST   | `C/configure`                    | Atomically update only submitted configuration fields |
| POST   | `C/stop`                         | Invoke native conversation abort                      |

GET is observation only. It must not create durable documents, admit work, or
resume execution. Opening or reconnecting a page never submits a message.
Commands are short requests; their connection does not own subsequent execution.

Forms carry ordinary named controls. Attachments use multipart `attachments`
fields. The server enforces a 32 MiB request-body limit before consuming the
complete body. The supported attachment policy is PNG, JPEG, GIF, WebP, and
UTF-8 text or source files. Unsupported binary documents are rejected before
submission.

The creation form validates configuration, initial input, and uploads before
creating a session. Failure must not leave an empty session behind. Durable
admission failures after creation are a separate boundary, not a promise of an
atomic create-and-submit transaction.

Successful native form navigation uses POST/redirect/GET. Enhanced requests may
instead receive an HTML result and a narrowly scoped navigation/reset effect.
Neither a transport success nor a reset effect means the model has answered.

### 3.1 Submission and commands

Normal messages use native `Conversation.submit`. Preserve the native returned
submission identity in the admission result; do not invent a PDS job ID. Unless
explicitly requested by an operation, the POST waits for admission, not
execution or settlement. Busy-conversation queueing follows native submission
semantics. An enhanced `C/message` admission carries the native ID in
`#admission[data-submission-id]`; commands clear that acknowledgement. Creation
navigation identifies the new conversation, not a settled submission.

PDS does not automatically retry writes. A lost response can leave admission
unknown; resubmitting is another user action and can duplicate input. PDS does
not claim idempotence without a native conversation-scoped request ID.

Supported composer commands:

- `/new`: create a separate conversation inheriting configuration and
  environment, not transcript history; navigate to it.
- `/cd PATH`: resolve against current working directory and update it without a
  model turn. Available on desktop and mobile.
- `/compact`: invoke native compaction; report its failure without manufacturing
  a successful summary.

Configuration changes read current values and apply submitted fields in one
transaction. An omitted field is not a request to restore a stale form value.
Changing the model chooses a supported thinking level when the previous level is
unsupported. Environment and directory are independent fields.

Reset, fork, rewind, submission cancellation, arbitrary task control, context
inspection, and usage APIs are not part of this surface. `/new` is not reset.

### 3.2 Errors and representation

Classify explicit adapter validation and native typed errors, never exception
message substrings. Unexpected exceptions are internal failures, not user input
errors; log them server-side and do not expose stack traces or storage details.

Datastar v1.0.5 only applies patches for HTTP 200 responses. Therefore a handled
form-validation failure is an HTTP 200 **invalid-form representation**, with an
accessible error region and no admission acknowledgement, navigation, or draft
reset. It is not a successful command. Native form requests may render the same
error in a full HTML page.

Malformed HTTP requests, missing resources, forbidden origins, unsupported
methods, oversized bodies, and internal failures retain their HTTP error status.
An enhanced request reports these as transport/protocol failures and preserves
the draft. Observation failures must not be displayed as an idle conversation.

## 4. Observation contract

### 4.1 Acquisition and lifetime

Each events request acquires a fresh native conversation observation. Its first
projection is a complete **bounded** baseline, not a replay from a prior browser
revision. PDS does not issue resumable SSE IDs or keep a replay store.

The native window defaults to 50 entries, grows to 100, then evicts back to 50.
Do not override it with a practically unlimited window. Baseline acquisition
must not enumerate all transcript entries or materialize model context.

Acquire the current head marker through a bounded native read and retain later
markers observed in native entry operations, including markers subsequently
evicted from the window. Establish the read/observation boundary without missing
commits during asynchronous acquisition. The environment document is observed
separately because it is not in the built-in conversation view.

A disconnected observer releases its observations and render state. It does not
abort a run, tool, or compaction. Stop is an explicit command. A new connection
replaces its live projection with a fresh baseline; loaded older pages are not a
persistent client-side replica.

Native watch callbacks are serialized. Respect socket backpressure and let Chord
fold pending operations while the writer waits. Do not allocate an unbounded
per-client queue, poll snapshots, or call asynchronous storage APIs from a
synchronous native observer.

### 4.2 Incremental HTML projection

The server consumes native values and Chord operations. Those operations stay on
the server. The browser receives only native Datastar element patches.

| Changed state                    | HTML work                                      |
| -------------------------------- | ---------------------------------------------- |
| Initial baseline or head change  | Replace the bounded transcript projection      |
| Newly committed entries          | Render and append only the new entries         |
| Native window eviction           | Discard server window state, not unchanged DOM |
| Partial assistant response       | Patch only the live response region            |
| Tool progress or result          | Patch the affected tool presentation           |
| Inbox                            | Patch the queue region                         |
| Run, retry, or compaction status | Patch status/failure regions                   |
| Usage                            | Patch inert statistics                         |
| Agent or environment             | Patch changed configuration controls only      |

Committed entry IDs determine stable DOM identity. Native message roles and
content blocks remain distinguishable; tool-call IDs correlate tool output.
Markdown and syntax highlighting for committed messages run when those messages
are first rendered, not on unrelated live progress. A changing partial Markdown
block may require reparsing that block; this is not a claim of token-level
incremental Markdown parsing.

Finalization must replace the partial representation with the committed one
without losing the final text or leaving duplicate content. A tool update must
not re-render unrelated committed prose or code. Preserve native `details` open
state and untouched directory/composer drafts.

Ordinary progress must not replace the transcript container or retransmit
unchanged history. Replacing the entire page or `main` on each update is not an
acceptable implementation of this contract.

If folded operations or a fresh window omit an interval, render an explicit
history affordance. Do not silently call the transcript complete, fabricate
entries, or synchronously drain history to bridge the gap.

### 4.3 History and context boundaries

Older history is user-requested, one page of at most 50 entries at a time. A
server-generated link carries exclusive native ID bounds. The server performs a
fork-aware descending scan, then renders the page in chronological order. The
continuation remains constrained to the same requested interval.

Following a link inserts its page at that history placeholder. Repeating a page
request must not duplicate entries. Observation never automatically drains older
pages, including after compaction or window eviction. A stale page response
whose target disappeared does not append arbitrary content to the page.

The newest head marker selects the active context boundary. A compaction
marker's `head` identifies the first retained entry, not the summary's
chronological position. Reset's self-head begins at the reset entry. Retain the
marker even when it is outside the live window. Older history is inspectable
behind a native disclosure; it must not be represented as still active model
context.

A head change may rebuild the bounded projection and discard explicitly loaded
pages from that projection. This is a boundary event, not permission to rerender
history on every subsequent progress update.

## 5. Browser contract and presentation

Use HTML links, forms, named inputs, native selects, buttons, and `details`.
Datastar supplies form requests, indicators, SSE, and element morphing. Signals
are limited to transient interaction state; no entries, model messages, queue,
configuration authority, or tool-result store belongs in them.

Approved presentation:

- No settings popup. Model-ID and thinking selectors remain in the conversation
  footer on desktop and mobile.
- Desktop conversation has an inline editable working directory and native
  environment selector. Mobile conversation has no environment selector.
- Mobile home retains environment selection.
- Statistics are inert. There is no context/usage inspector.
- No autofocus or selector/input focus outline; the composer form retains its
  focus border. Native controls must remain labelled and keyboard operable.

Prefer no custom browser module. Where native HTML and pinned Datastar cannot
preserve an interaction, keep the exception small and presentation-only:
attachment previews, individual removal from a `FileList`, clipboard/drop
intake, connection/request failure feedback, and following streamed content
without overriding deliberate upward scrolling. Do not relocate a large custom
program into HTML attributes to claim zero JavaScript.

An enhanced submission disables draft editing while admission is pending. Only
an acknowledged success resets the form. A rejected or uncertain enhanced
submission retains its draft; native error pages require browser-history
navigation back to the form. A native file input remains usable independently of
preview code.

## 6. Security and operational boundary

The default listener is loopback. There is no authentication or tenant
isolation. Origin validation protects unsafe browser requests; it is not
authorization. Explicit `ORIGIN` configuration is required when a proxy changes
the externally visible origin. Do not trust arbitrary forwarded-host headers.

Escape untrusted text and attributes, disable raw HTML in Markdown, and prevent
unsafe Markdown link/image schemes. Application IDs must not become executable
JavaScript or CSS selectors without encoding. Serve the pinned local Datastar
bundle; no runtime CDN dependency is required.

Durable SQLite storage is the only conversation persistence. PDS metadata may
identify and title PDS-created sessions; it must not duplicate transcript state.
Connections, HTML caches, and history placeholders are disposable projections.

## 7. Verification

Tests must cover observable interfaces and state rather than string-matching
serialized HTML or stdout:

- Bounded baseline and explicit older-page acquisition, including head markers
  outside the native window and gaps after folded updates.
- Entry append, partial-to-final transition, tool progress/results, queue
  changes, compaction, and reset boundaries.
- Unchanged committed DOM and rendering/highlighting work during live updates.
- Disconnect/reconnect, multiple observers, slow writers, and explicit abort.
- Validation without empty sessions, partial configuration, `/new`, and `/cd`.
- Attachment errors, draft preservation, native disclosures, scrolling, desktop
  controls, and mobile home/conversation differences.

Measure incremental rendering against the original full-transcript renderer with
the same committed-history and partial-update workload. Report rendering work
and generated bytes separately from provider/network performance. Benchmark runs
are not flake checks. Capture desktop and mobile screenshots after the
interaction changes; visual parity requires evidence, not a declaration.
