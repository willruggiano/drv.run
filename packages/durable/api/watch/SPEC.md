# Conversation watch

## Status and scope

Draft for review. This contract targets Pi 1.5.2. The
[manifest](../package.json) still pins 1.4.0, and [watch.ts](watch.ts) is a
stub. Upgrade the dependencies in a separate change before implementation.

Use Durable's records, bounded conversation view, and Chord operations. Do not
add a conversation store, event replay log, custom delta language, or Chord
network runtime. This is state synchronization, not an execution event stream.

## Loading policy

Start with a recent, bounded window of fork-visible history. Do not read the
whole transcript or derive the whole model context before sending the first
frame. Window size is policy; it is not the active-context boundary.

Use Durable's default window: start with 50 entries, grow to 100, then remove
the oldest entries to return to 50. Configure `min` and `max` at application
startup; `min` defaults to 50 and `max` defaults to twice `min`. Apply Durable's
integer and ordering constraints, with no additional application-imposed
ceiling. Read these values from application startup settings; environment
variables can supply those settings. Dynamic configuration is not required.

```text
recent bounded window
  -> optional bounded backfill within active context
  -> stop at the active-context boundary
  -> older history only on explicit user request
```

- A window may contain entries before a reset or compaction boundary. Keep those
  entries; an active-only wire representation is not required.
- Do not automatically drain all pages, even within active context.
- The newest head marker defines the boundary. For compaction, its `head` target
  is the first retained entry, not the summary's chronological position.
  Retained entries can precede the summary. A reset with `head: "self"` starts
  at itself.
- With no head marker, the boundary is the start of fork-visible history.
- Check the current boundary before each automatic page request. Do not request
  entries below it without an explicit user request. A reconnect is not that
  request.
- If a reset or compaction changes the boundary while a page request runs, let
  that request finish. Accept its result without changing the current head or
  live state. Apply the new boundary to subsequent automatic requests; do not
  add special cancellation logic.

Durable's [window][view] contains chronological history. [Context
derivation][context] defines the active boundary.
`ConversationTranscript.loadEarlier()` and `fillGap()` are [paging
helpers][transcript], not enforcement of this loading policy. Do not call them
automatically without checking the requested range. Specify the history-loading
API separately through GraphQL; do not add another REST route here. That API is
not a prerequisite for implementing the watch stream.

## Stream contract

`watch/watch.ts` has one export, `watch`. Acquisition is asynchronous and
returns a native `ReadableStream` of Chord operation batches. Keep supporting
types internal. The application supplies its shared
[Sessions](../src/sessions.ts) instance and startup window settings.

Each connection synchronizes this JSON state:

```typescript
type State = {
  readonly view: ConversationView;
  readonly head: EntryRecord | null;
};
```

`view` is Durable's bounded conversation view, including its built-in documents.
`head` is the newest visible head marker, or `null` if none exists. Keep the
head record even when it is outside the entry window. Do not filter or reorder
the view's entries, apply context edits, or derive provider messages.

Each stream item is a Chord `Op[]`:

- The first batch is `[["r", state]]`, a complete baseline for this connection.
- Later batches transform the previously delivered state into the next state.
- A later root replacement is valid, including after pending-operation overflow.
- Move Durable's view operations under `view`; update `head` in the same batch.
  Do not calculate differences across the full documents on every update.

Use the existing [Chord operation format][delta]. No separate snapshot/delta
operation language, frame sequence, or replay cursor is used. The baseline
contains a bounded view.

## Acquisition and consistency

Borrow the Harness through `Sessions.get(externalId)`, a non-creating lookup. A
missing Harness or conversation fails acquisition; watching must not provision
either or start execution. Do not create documents to read their values.

The tested composition uses public APIs only:

1. Attach `Harness.observeConversation()` with a bounded window. Keep its latest
   value, including changes received before the attachment promise resolves.
2. In a read-only `Conversation.commit()` callback, read
   `tx.latestHeadMarker(conversationId)`. Pair it with the latest observed view
   and establish the baseline inside that callback, not after awaiting
   `commit()`.
3. Follow subsequent synchronous observations. Track head markers from the entry
   insertion operations, not only from the resulting window. One commit can
   append a marker and enough later entries to remove it from that window.
4. Feed the combined value and operations to Chord's `Watch` for asynchronous
   delivery, operation folding, and overflow replacement.

Synchronous observers must do no I/O, await no work, and call no Session APIs.
Do not use stored-commit observation as a substitute: a view can include
deferred live-document changes before storage receives them.

The [observer and transaction contracts][types], [publication gates][session],
and [view advancement][view] constrain this composition. Do not import private
Session helpers. No storage write is needed for the head read.

## Reconnect and history

First connection, reconnect, and live delivery converge on authoritative state.
Each connection starts with a fresh bounded baseline, with no replay requirement
or client cursor parameter.

The client replaces its live replica with that baseline. A gap is missing
history, not a requirement to load it immediately. Apply the same boundary and
explicit-request rules to gap filling as to earlier-page loading.

## HTTP boundary

The [entrypoint](../src/index.ts) owns `GET /api/watch`, with query parameters
`externalId` and `conversationId`. It decodes these parameters before calling
the API. Other methods return `405` with `Allow: GET`. No request body or URL
credentials are used.

Authentication belongs at the HTTP boundary and uses cookies. Authorization
belongs in the API before state is exposed. Neither is implemented by this spec.
Both transports borrow the same application-owned resources.

The route disables connection inactivity timeout for the stream and passes its
items to [sse](../serve/sse.ts). Each batch becomes one JSON SSE `message`. Do
not add named events, SSE IDs, replay, retry directives, or heartbeats to that
adapter. HTTP listener behavior belongs to
[[packages/durable/api/serve/SPEC.md]].

## Flow control and lifetime

- Let downstream demand control asynchronous watch delivery. Do not add a
  detached pump or an unbounded queue of encoded frames.
- Use Chord's [watch lifecycle][watch] and operation folding. A slow consumer
  may skip intermediate values but must receive operations valid for its last
  value.
- Entry limits and pending-operation limits are not byte limits. Large entries,
  head records, documents, and individual commit batches can still be large. Do
  not claim a fixed memory or response-size bound from the window count alone.
  Add no byte limit or byte-limit configuration to the initial implementation.
  Do not truncate entries, documents, or operation batches. Deferred loading of
  large tool outputs or attachment bodies is outside the initial contract.
- Request abort, stream cancellation, acquisition failure, and consumer failure
  release the observer and request-owned delivery resources. Cleanup is
  idempotent. Disconnect does not abort conversation execution or close the
  shared Harness. Shared Harness opening must not inherit one request's
  cancellation.
- Cancellation must detach observation without waiting for a storage operation.
  A pending read or already-running listener may still need to settle. Observe
  late failures and prevent late acquisition from leaving a subscription alive.
- Do not send terminal application frames. A completed answer appears in state;
  it does not end the connection. After a lost connection, the client reconnects
  for a new baseline. When the user leaves the conversation, the client closes
  the connection.
- Source termination ends delivery. For 1.5.2, synchronous observers report
  Session close as `failed`; the ordinary conversation watch reports `ended`. Do
  not interpret the observer tag alone as a storage failure.
- Acquisition errors remain HTTP errors before the response starts. After the
  response starts, no second HTTP response is possible. Do not serialize raw
  exceptions or diagnostic text to the client.

The application owns shared resources. Deployment owns process signals and
shutdown deadlines. The watch module installs neither.

## Verification

Keep implementation tests in `watch/watch.test.ts`. Use real Durable state and
Chord operations; control races through storage gates. Assert reconstructed
state and resource release, not logs or serialized text.

Cover bounded cold SQLite reads without writes; changes before attachment
resolves; head changes during acquisition; atomic entry/document updates;
compaction targets before the summary; same-commit marker eviction; fork
inheritance; raw backwards head writes; deferred documents; overflow and
slow-listener recovery; reconnect; independent windows; cancellation during
acquisition and delivery; Session close; and listener failure. Replay every
delivered batch against the previous state.

History integration must also test that automatic requests stop at the boundary,
explicit requests can cross it, and reconnect does not cause historical
backfill. A page request started before a reset or compaction must be allowed to
finish; subsequent automatic requests must use the new boundary. Measure read
volume and delivery cost before making performance claims. Test transport
integration with the existing Node server and SSE adapter.

## Dependency references

These references select upstream commit
`b4afdddf44e059c67ccf5097e5317d913521b470` (Pi 1.5.2), the investigated target,
not the current project pin. Use these source contracts when reviewing the
draft.

[view]:
  https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/durable/src/harness/view.ts
[context]:
  https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/durable/src/harness/context.ts
[transcript]:
  https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/durable/src/harness/transcript.ts
[types]:
  https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/durable/src/types.ts
[session]:
  https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/durable/src/session/session.ts
[watch]:
  https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/chord/src/watch.ts
[delta]:
  https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/chord/src/delta/index.ts
