# Durable API

TypeScript backend extracted from `packages/app`. `packages/durable` is an
organizational directory, not a package.

## Direction

- Manage persisted Harness instances through an injected factory function for
  creating a Harness. Depend only on upstream Durable's `Harness` type, not on
  `packages/durable/harness`.
- Implementing the factory and connecting it to the API is a configuration and
  deployment concern.
- Treat upstream Durable as canonical for conversations. Keep operation names,
  arguments, results, and semantics as close to upstream as transport permits.
- Expose only the core operations required by the frontend, listed below.
  Application integrations are separate from this surface.
- Keep transactions and execution callbacks server-side. Do not introduce a
  remote transaction language or adopt Chord's distributed object runtime.
- Preserve submission identity, admission semantics, and the distinction between
  disconnecting an observer and aborting execution.
- Keep interfaces small and deep, with at most three exports per TypeScript
  module. Do not export production internals solely for tests.

## Core surface

Operations are scoped by session and conversation IDs as applicable. A session
ID addresses a persisted Harness instance. Names below identify logical
operations; their HTTP routes are listed separately. Execution contexts remain
server-side; object handles become IDs or records at the transport boundary.

The required behaviors come from the existing
[frontend commands](../../app/serve/elm/frontend.ts),
[conversation observation](../../app/serve/elm/stream.ts),
[transcript trees](../../app/serve/trees.ts), and
[compaction timing](../../app/serve/presentation.ts).

| Frontend behavior                                                       | Core API                                                     | Upstream Durable API                                                                                                                                          |
| ----------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transcript, streamed answer, tool progress, inbox, configuration, usage | `watch()` returns initial and replacement snapshots          | `Conversation.watch()` supplies `ConversationView`; do not expose Chord replication.                                                                          |
| History, search, export                                                 | `entries(query, limit, cursor)`                              | `Conversation.entries()`. Search and export reuse these records.                                                                                              |
| Submit, steer, follow-up, attachments                                   | `submit(draft)` returns a submission ID                      | `Conversation.submit()`. Preserve `requestId`, `whenBusy`, and admission semantics.                                                                           |
| Recover an uncertain submission acknowledgement                         | `submissionByRequest(requestId)` returns a record or absence | `Tx.submissionByRequest()` inside a server-side read-only `Harness.commit()`.                                                                                 |
| Cancel queued input                                                     | `abortSubmission(id)` returns the upstream result            | `Harness.abortSubmission(id, context, conversationId)`.                                                                                                       |
| Stop current work                                                       | `abort()`                                                    | `Conversation.abort()`. Observation disconnect does not invoke this.                                                                                          |
| Inspect interrupted work / resume                                       | `inspect()`, `resume()`                                      | `Harness.inspect()`, `Harness.resume()`. Inspection does not enable scheduling.                                                                               |
| Reset / compact context                                                 | `reset(handoff?)`, `compact(instructions?)`                  | Corresponding `Conversation` methods. Observe subsequent progress; no remote wait operation initially.                                                        |
| Context inspection                                                      | `context(at?)`                                               | `Conversation.context()`. Distinct from complete history.                                                                                                     |
| Branch navigation and transcript trees                                  | `scanConversations(query, limit, cursor)`; reuse `entries()` | `Tx.scanConversations()` inside a server-side read-only transaction. Elm constructs the tree from records. No fork mutation required by the current frontend. |
| Model and thinking settings                                             | `configure(change)`                                          | `Conversation.configure()`, initially restricted to frontend-used model/thinking fields. Current overrides arrive through `watch()` as `AgentDoc`.            |
| Compaction duration badges                                              | `scanTasks(query, limit, cursor)`, submission `status(id)`   | `Tx.scanTasks()` reads completed compactions; `Harness.submission(id).status()` resolves their summary entries. Read-only; no task-control API.               |

## Routes

```text
S = /api/s/{sessionId}
C = S/c/{conversationId}
```

All reads use GET. POST is reserved for mutations; there are no POST reads.

| Method | Route                   | Operation                                 |
| ------ | ----------------------- | ----------------------------------------- |
| GET    | `S/inspect`             | `inspect()`                               |
| GET    | `S/scanConversations`   | `scanConversations(query, limit, cursor)` |
| GET    | `S/scanTasks`           | `scanTasks(query, limit, cursor)`         |
| GET    | `C/watch`               | `watch()`                                 |
| GET    | `C/entries`             | `entries(query, limit, cursor)`           |
| GET    | `C/context`             | `context(at?)`                            |
| GET    | `C/submissionByRequest` | `submissionByRequest(requestId)`          |
| GET    | `C/submissions/status`  | Submission `status(id)`                   |
| POST   | `S/resume`              | `resume()`                                |
| POST   | `C/submit`              | `submit(draft)`                           |
| POST   | `C/abortSubmission`     | `abortSubmission(id)`                     |
| POST   | `C/abort`               | `abort()`                                 |
| POST   | `C/reset`               | `reset(handoff?)`                         |
| POST   | `C/compact`             | `compact(instructions?)`                  |
| POST   | `C/configure`           | `configure(change)`                       |

GET requests have no body. Encode the flat `QueryParameters` fields as query
parameters. Numbers use decimal notation, booleans use `true` or `false`, and
omitted fields have no parameter. There is no JSON `query` parameter.

Both request `cursor` and response `next` values are opaque strings encoded as
unpadded [base64url](https://www.rfc-editor.org/rfc/rfc4648.html#section-5) of
the UTF-8 JSON representation of the upstream cursor object. This uses `-` and
`_`, not `+` and `/`, and omits `=` padding. The server encodes upstream cursors
in responses and decodes incoming cursors back to upstream objects without
changing their contents. Clients pass `next` back as `cursor` unchanged; they do
not decode or re-encode it.

```text
GET C/entries?order=ascending&limit=100&cursor=<base64url>
GET S/scanConversations?ownerTaskId=42&limit=100
GET S/scanTasks?kind=pi.compaction&status=terminal&limit=100
GET C/context?at=42
GET C/submissionByRequest?requestId=<URL-encoded string>
GET C/submissions/status?id=42
```

POST requests with a `Request` type carry it as JSON with
`Content-Type: application/json`. Operations without a `Request` type have no
body. Responses are not cached initially (`Cache-Control: no-store`).

## HTTP errors

Each API declares its non-500 error responses below. Everything not declared
maps to **500 Internal Server Error**. Classify failures by typed upstream
exceptions or conditions explicitly established by the adapter, never by
matching error-message text. All non-2xx responses use the `ProblemDetails`
format defined below.

| Failure                                                                                  | HTTP status / title                                                                                          |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `ConversationBusy`                                                                       | **409 Conflict**: input was not admitted because of conversation state.                                      |
| `StorageRequestError` from a storage read                                                | **400 Bad Request**: invalid read arguments, including malformed/foreign cursors and conflicting scan order. |
| `SessionFailed`                                                                          | **503 Service Unavailable**: the Harness cannot serve operations until reopened.                             |
| Adapter-detected invalid JSON, query parameters, IDs, cursor encoding, or request fields | **400 Bad Request**.                                                                                         |
| Addressed session or conversation does not exist                                         | **404 Not Found**.                                                                                           |
| Unsupported method on a known route                                                      | **405 Method Not Allowed**, with `Allow` naming the supported method.                                        |
| Request body exceeds the configured limit                                                | **413 Content Too Large**.                                                                                   |
| Unsupported request media type                                                           | **415 Unsupported Media Type**.                                                                              |

`ReadAfterWrite` is a server-side transaction defect and takes the 500 fallback.
Do not classify arbitrary `TypeError` exceptions as client errors; validate
caller input explicitly. See the pinned
[upstream error definitions](../harness/node_modules/@earendil-works/pi-durable/dist/errors.d.ts).

Errors from `Storage.commit()` or `mintId()` are fatal, including
`StorageRequestError`; they must not become 400 merely because of their class.
The initial failure can propagate the original exception and produce 500;
subsequent calls throw `SessionFailed` and produce 503. A storage read inside a
read-only `Harness.commit()` is still a read, not a `Storage.commit()` call. See
the
[storage failure guard](../harness/node_modules/@earendil-works/pi-durable/dist/session/session.js).

A 503 does not establish that a mutation failed to commit, authorize automatic
replay, or promise a recovery time. Do not emit `Retry-After` without knowing
one.

Some upstream domain failures are untyped. Validate input-entry kinds before
submission to return 400 rather than classifying upstream's `TypeError`. Request
IDs already associated with a different submission type and historical context
entries not visible in the addressed conversation currently throw plain `Error`.
These take the 500 fallback until explicit checks or typed upstream errors
establish their classification; do not infer 409 or 404 from messages. Sources:
[submission admission](../harness/node_modules/@earendil-works/pi-durable/dist/harness/submissions.js)
and
[context lookup](../harness/node_modules/@earendil-works/pi-durable/dist/harness/context.js).

Missing submission lookups return HTTP 200 with `null`. All `abortSubmission()`
result variants, persisted task failures, and blocked inspection states remain
HTTP 200 response data. Client disconnect produces no synthetic HTTP response,
including no invented 499. Once watch headers have been sent, termination is an
SSE event or disconnect, not a new HTTP status.

## Wire types

Use the pinned upstream JSON record types rather than duplicate their schemas.
Each example is an independent scope. Import upstream types from their public
package entry points. `Page` and `ProblemDetails` are shared `@/types`
declarations below.

```typescript
// Speculative; not a literal implementation target
type Result<T, E> = T | E;
```

`Result` is shared notation for the declarations below, not a public envelope or
an imported runtime type.

Function declarations are semantic descriptions of inputs and decoded response
bodies, not literal implementation targets. They do not prescribe an HTTP/server
framework, async interface, or exception mechanism. HTTP status selects the body
type; there is no public result envelope:

- 2xx responses decode as `ResponseT`, or `Page<PageT>` for paginated responses.
  `PageT` describes one item. These operations currently use HTTP 200.
- Non-2xx responses use `Content-Type: application/problem+json`. Each `ErrorT`
  variant describes a specific problem shape through its `title` and `status`.
  These are semantic constraints on `ProblemDetails`, not complete standalone
  payload definitions: `type: "about:blank"` and the shared fields are implicit.
  Declared errors decode according to these variants; undeclared failures use
  the implicit 500 fallback, which is not repeated in each union.
- Serialize the success value or problem object directly. Do not wrap either in
  a result discriminant.
- Successful void operations return HTTP 200 with JSON `null`, not HTTP 204.
- `watch()` is the streaming exception: successful SSE messages decode as
  `Event`. EventSource does not expose non-2xx response bodies.
- Network failure, cancellation, or an invalid response is not a server problem
  response. Do not fabricate a problem status or infer that a mutation failed to
  commit when no valid response was received.

Shared conventions:

- Path variables are function arguments in path order: `sessionId`, then
  `conversationId` where applicable, before query parameters or a request body.
- `QueryParameters` describes GET query parameters; `Request` describes a POST
  JSON body. Operations without either take only path arguments.
- Durable IDs are nonnegative safe-integer JSON numbers.
- Optional properties are omitted. Explicit `null` retains its documented
  meaning. Missing lookup results return JSON `null`.
- Cursors are opaque base64url strings in requests and responses, round-tripped
  unchanged by clients.

`Page<T>` retains upstream pagination with encoded cursor strings. Non-2xx
response errors follow [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html):

```typescript
import type {
  ConversationId,
  Page as DurablePage,
} from "@earendil-works/pi-durable";

export type Page<T> = DurablePage<T, string>;

export type ProblemDetails = {
  type: "about:blank";
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  sessionId?: string;
  conversationId?: ConversationId;
};
```

Until further notice, every problem uses
[`type: "about:blank"`](https://www.rfc-editor.org/info/rfc9457/#name-aboutblank)
and the standard HTTP status phrase as `title`. Custom problem types are
deferred. `instance`, when present, is a URI reference identifying the
occurrence.

On non-2xx responses, always populate `status` with the actual HTTP status.
Include `sessionId` and `conversationId` whenever each is available. Clients
ignore unrecognized extensions and do not parse `title` or `detail` for control
flow. Do not expose stacks, arbitrary causes, or unsanitized internal error
messages.

Watch termination and inspection diagnostics retain upstream error types,
including `Error` and `unknown`. Serialize them using `JSON.stringify`. If this
is proven insufficient, stop and re-evaluate a suitable replacement; do not
introduce a replacement preemptively. They are part of a successful response,
not non-2xx HTTP failures, and are not redefined as `ProblemDetails`. Persisted
task outcome errors retain their upstream JSON representation.

### `watch()` — `GET /api/s/{sessionId}/c/{conversationId}/watch`

```typescript
import type {
  ConversationId,
  ConversationView,
  WatchEnd,
} from "@earendil-works/pi-durable";

type Event =
  | { type: "snapshot"; value: ConversationView }
  | { type: "end"; value: WatchEnd };

type ErrorT =
  | { title: "Bad Request"; status: 400 }
  | { title: "Not Found"; status: 404 }
  | { title: "Method Not Allowed"; status: 405 }
  | { title: "Service Unavailable"; status: 503 };

declare function watch(
  sessionId: string,
  conversationId: ConversationId,
): EventSource;
```

Errors before the HTTP 200 stream starts:

- 400: invalid path parameters or a rejected storage read.
- 404: addressed session or conversation does not exist.
- 405: method is not GET; `Allow: GET`.
- 503: `SessionFailed`.

The watch declaration denotes the EventSource-compatible stream; `Event`
describes its message data. `ErrorT` describes pre-stream HTTP errors;
EventSource does not expose their bodies.

Return HTTP 200 with `Content-Type: text/event-stream` and
`Cache-Control: no-store`, using the
[EventSource contract](https://html.spec.whatwg.org/multipage/server-sent-events.html).
Each `Event` is serialized as compact JSON in one SSE `data:` line, terminated
by a blank line. Use default `message` events; the JSON `type` distinguishes
snapshots from termination. Do not wrap frames in an envelope. Use SSE comments
for heartbeats.

Failure to open the stream returns a non-2xx problem response. EventSource
exposes a connection error, not the HTTP status or `ProblemDetails` body; accept
this limitation specifically for `watch()`. After HTTP 200 starts, termination
is an `end` frame or a disconnected stream, never a new HTTP failure response.

Initially, each snapshot replaces the previous `ConversationView`. Preserve its
upstream `conversation`, `entries`, and `docs` fields. The initial protocol has
no deltas, sequence numbers, replay cursors, or SSE event IDs.

Send the acquisition snapshot first. Reconnection acquires a fresh snapshot. A
terminal frame is best-effort; a broken connection may deliver none. On an `end`
frame, the client closes its EventSource to prevent automatic reconnection.
Disconnect releases observation, not execution.

### `entries(query, limit, cursor)` — `GET /api/s/{sessionId}/c/{conversationId}/entries`

```typescript
import type {
  ConversationId,
  EntryQuery,
  EntryRecord,
} from "@earendil-works/pi-durable";
import type { Page } from "@/types";

type QueryParameters = Omit<EntryQuery, "conversationId"> & {
  limit: number;
  cursor?: string;
};

type PageT = EntryRecord;

type ErrorT =
  | { title: "Bad Request"; status: 400 }
  | { title: "Not Found"; status: 404 }
  | { title: "Method Not Allowed"; status: 405 }
  | { title: "Service Unavailable"; status: 503 };

declare function entries(
  sessionId: string,
  conversationId: ConversationId,
  queryParameters: QueryParameters,
): Result<Page<PageT>, ErrorT>;
```

Errors:

- 400: invalid path/query parameters, cursor encoding, or a rejected storage
  read, including cursor/order conflicts.
- 404: addressed session or conversation does not exist.
- 405: method is not GET; `Allow: GET`.
- 503: `SessionFailed`.

Preserve `minEntryId`, `maxEntryId`, and `order`. The conversation comes from
addressing. `next` is omitted when pagination ends.

Do not rename entry fields or pre-render message content.

### `submit(draft)` — `POST /api/s/{sessionId}/c/{conversationId}/submit`

```typescript
import type {
  ConversationId,
  InputSubmissionDraft,
  SubmissionId,
} from "@earendil-works/pi-durable";

type Request = InputSubmissionDraft;

type ResponseT = {
  id: SubmissionId;
};

type ErrorT =
  | { title: "Bad Request"; status: 400 }
  | { title: "Not Found"; status: 404 }
  | { title: "Method Not Allowed"; status: 405 }
  | { title: "Conflict"; status: 409 }
  | { title: "Content Too Large"; status: 413 }
  | { title: "Unsupported Media Type"; status: 415 }
  | { title: "Service Unavailable"; status: 503 };

declare function submit(
  sessionId: string,
  conversationId: ConversationId,
  request: Request,
): Result<ResponseT, ErrorT>;
```

Errors:

- 400: invalid path parameters, JSON, or submission fields, including
  input-entry kind.
- 404: addressed session or conversation does not exist.
- 405: method is not POST; `Allow: POST`.
- 409: `ConversationBusy`; the input was not admitted.
- 413: request body exceeds the configured limit.
- 415: unsupported request media type.
- 503: `SessionFailed`.

Expose only input submissions initially; the frontend does not require passive
writes. The request retains upstream `type: "input"`, `content`, optional
`requestId`, `whenBusy`, and `entry`.

`content` retains the upstream string or text/image-block representation. Image
data is base64; no separate upload protocol.

The response identifies durable admission, not placement or completion.
`requestId` remains optional upstream; the frontend supplies it for receipt
recovery. Same-key, same-type retries return the existing submission without
comparing content.

### `submissionByRequest(requestId)` — `GET /api/s/{sessionId}/c/{conversationId}/submissionByRequest`

```typescript
import type {
  ConversationId,
  SubmissionRecord,
} from "@earendil-works/pi-durable";

type QueryParameters = {
  requestId: string;
};

type ResponseT = SubmissionRecord | null;

type ErrorT =
  | { title: "Bad Request"; status: 400 }
  | { title: "Not Found"; status: 404 }
  | { title: "Method Not Allowed"; status: 405 }
  | { title: "Service Unavailable"; status: 503 };

declare function submissionByRequest(
  sessionId: string,
  conversationId: ConversationId,
  queryParameters: QueryParameters,
): Result<ResponseT, ErrorT>;
```

Errors:

- 400: invalid path/query parameters or a rejected storage read.
- 404: addressed session or conversation does not exist; a missing receipt is
  not a 404.
- 405: method is not GET; `Allow: GET`.
- 503: `SessionFailed`.

Lookup is scoped to the addressed conversation. Preserve the complete upstream
record and its status discriminants.

`null` means no receipt was found at the lookup's observation point. It does not
prove a concurrent or disconnected request failed.

### `abortSubmission(id)` — `POST /api/s/{sessionId}/c/{conversationId}/abortSubmission`

```typescript
import type { ConversationId, SubmissionId } from "@earendil-works/pi-durable";

type Request = {
  id: SubmissionId;
};

type ResponseT = "aborted" | "already_placed" | "settled" | "not_found";

type ErrorT =
  | { title: "Bad Request"; status: 400 }
  | { title: "Not Found"; status: 404 }
  | { title: "Method Not Allowed"; status: 405 }
  | { title: "Content Too Large"; status: 413 }
  | { title: "Unsupported Media Type"; status: 415 }
  | { title: "Service Unavailable"; status: 503 };

declare function abortSubmission(
  sessionId: string,
  conversationId: ConversationId,
  request: Request,
): Result<ResponseT, ErrorT>;
```

Errors:

- 400: invalid path parameters, JSON, or submission ID.
- 404: addressed session or conversation does not exist; an unknown or
  differently scoped submission remains a result value.
- 405: method is not POST; `Allow: POST`.
- 413: request body exceeds the configured limit.
- 415: unsupported request media type.
- 503: `SessionFailed`.

Pass the addressed conversation ID to upstream. Unknown submissions and
submissions belonging to another conversation return `"not_found"` as an HTTP
200 result, not a problem response.

Do not translate `"already_placed"` into an execution abort.

### `abort()` — `POST /api/s/{sessionId}/c/{conversationId}/abort`

```typescript
import type { ConversationId } from "@earendil-works/pi-durable";

type ResponseT = null;

type ErrorT =
  | { title: "Bad Request"; status: 400 }
  | { title: "Not Found"; status: 404 }
  | { title: "Method Not Allowed"; status: 405 }
  | { title: "Service Unavailable"; status: 503 };

declare function abort(
  sessionId: string,
  conversationId: ConversationId,
): Result<ResponseT, ErrorT>;
```

Errors:

- 400: invalid path parameters.
- 404: addressed session or conversation does not exist.
- 405: method is not POST; `Allow: POST`.
- 503: `SessionFailed`.

Use upstream default behavior: withdraw queued inputs and abort ordinary owned
work; preserve background work and queued writes.

The response follows upstream completion of the abort operation. Initially, do
not expose the background-abort option.

### `inspect()` — `GET /api/s/{sessionId}/inspect`

```typescript
import type { HarnessInspection } from "@earendil-works/pi-durable";

type ResponseT = HarnessInspection;

type ErrorT =
  | { title: "Bad Request"; status: 400 }
  | { title: "Not Found"; status: 404 }
  | { title: "Method Not Allowed"; status: 405 }
  | { title: "Service Unavailable"; status: 503 };

declare function inspect(sessionId: string): Result<ResponseT, ErrorT>;
```

Errors:

- 400: invalid path parameters or a rejected storage read.
- 404: addressed session does not exist.
- 405: method is not GET; `Allow: GET`.
- 503: `SessionFailed`.

Scope: Harness. Preserve `scheduling`, `tasks`, `submissions`, and every
inspection-state discriminant, including upstream error types. Serialize those
errors using `JSON.stringify`, as specified above.

This is a point-in-time read, not a stream, and does not enable scheduling.

### `resume()` — `POST /api/s/{sessionId}/resume`

```typescript
type ResponseT = null;

type ErrorT =
  | { title: "Bad Request"; status: 400 }
  | { title: "Not Found"; status: 404 }
  | { title: "Method Not Allowed"; status: 405 }
  | { title: "Service Unavailable"; status: 503 };

declare function resume(sessionId: string): Result<ResponseT, ErrorT>;
```

Errors:

- 400: invalid path parameters.
- 404: addressed session does not exist.
- 405: method is not POST; `Allow: POST`.
- 503: `SessionFailed`.

Scope: Harness. Enables scheduling. The response does not mean pending work has
completed.

### `reset(handoff?)` — `POST /api/s/{sessionId}/c/{conversationId}/reset`

```typescript
import type { ConversationId } from "@earendil-works/pi-durable";

type Request = {
  handoff?: string;
};

type ResponseT = null;

type ErrorT =
  | { title: "Bad Request"; status: 400 }
  | { title: "Not Found"; status: 404 }
  | { title: "Method Not Allowed"; status: 405 }
  | { title: "Content Too Large"; status: 413 }
  | { title: "Unsupported Media Type"; status: 415 }
  | { title: "Service Unavailable"; status: 503 };

declare function reset(
  sessionId: string,
  conversationId: ConversationId,
  request: Request,
): Result<ResponseT, ErrorT>;
```

Errors:

- 400: invalid path parameters, JSON, or handoff field.
- 404: addressed session or conversation does not exist.
- 405: method is not POST; `Allow: POST`.
- 413: request body exceeds the configured limit.
- 415: unsupported request media type.
- 503: `SessionFailed`.

Omission means no handoff; preserve an explicitly supplied string unchanged. The
response acknowledges reset admission, not necessarily placement.

### `compact(instructions?)` — `POST /api/s/{sessionId}/c/{conversationId}/compact`

```typescript
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";

type Request = {
  instructions?: string;
};

type ResponseT = TaskId;

type ErrorT =
  | { title: "Bad Request"; status: 400 }
  | { title: "Not Found"; status: 404 }
  | { title: "Method Not Allowed"; status: 405 }
  | { title: "Content Too Large"; status: 413 }
  | { title: "Unsupported Media Type"; status: 415 }
  | { title: "Service Unavailable"; status: 503 };

declare function compact(
  sessionId: string,
  conversationId: ConversationId,
  request: Request,
): Result<ResponseT, ErrorT>;
```

Errors:

- 400: invalid path parameters, JSON, or instructions field.
- 404: addressed session or conversation does not exist.
- 405: method is not POST; `Allow: POST`.
- 413: request body exceeds the configured limit.
- 415: unsupported request media type.
- 503: `SessionFailed`.

Return the task ID as a JSON number, matching upstream's result rather than
inventing a compaction receipt.

Task admission, task completion, and summary placement remain distinct.

### `context(at?)` — `GET /api/s/{sessionId}/c/{conversationId}/context`

```typescript
import type {
  ContextView,
  ConversationId,
  EntryId,
  EntryRecord,
} from "@earendil-works/pi-durable";

type QueryParameters = {
  at?: EntryId;
};

type ResponseT = Omit<ContextView, "head"> & {
  head?: EntryRecord;
};

type ErrorT =
  | { title: "Bad Request"; status: 400 }
  | { title: "Not Found"; status: 404 }
  | { title: "Method Not Allowed"; status: 405 }
  | { title: "Service Unavailable"; status: 503 };

declare function context(
  sessionId: string,
  conversationId: ConversationId,
  queryParameters: QueryParameters,
): Result<ResponseT, ErrorT>;
```

Errors:

- 400: invalid path/query parameters or a rejected storage read.
- 404: addressed session or conversation does not exist; the untyped
  invisible-entry failure uses the fallback described above.
- 405: method is not GET; `Allow: GET`.
- 503: `SessionFailed`.

Omit `head` when upstream returns `undefined`. Preserve `entries`,
`contributions`, and `messages` unchanged.

Omitting `at` requests current context. Providing it requests the upstream
historical context through that visible entry.

### `scanConversations(query, limit, cursor)` — `GET /api/s/{sessionId}/scanConversations`

```typescript
import type {
  ConversationQuery,
  ConversationRecord,
} from "@earendil-works/pi-durable";
import type { Page } from "@/types";

type QueryParameters = ConversationQuery & {
  limit: number;
  cursor?: string;
};

type PageT = ConversationRecord;

type ErrorT =
  | { title: "Bad Request"; status: 400 }
  | { title: "Not Found"; status: 404 }
  | { title: "Method Not Allowed"; status: 405 }
  | { title: "Service Unavailable"; status: 503 };

declare function scanConversations(
  sessionId: string,
  queryParameters: QueryParameters,
): Result<Page<PageT>, ErrorT>;
```

Errors:

- 400: invalid path/query parameters, cursor encoding, or a rejected storage
  read, including cursor/order conflicts.
- 404: addressed session does not exist.
- 405: method is not GET; `Allow: GET`.
- 503: `SessionFailed`.

Scope: Harness. Preserve upstream ownership filters, ordering, parent
relationships, and ownership records. Do not introduce a separate branch/tree
model in the API.

The transaction remains server-side.

### `configure(change)` — `POST /api/s/{sessionId}/c/{conversationId}/configure`

```typescript
import type { AgentChange, ConversationId } from "@earendil-works/pi-durable";

type Request = Pick<AgentChange, "model" | "thinkingLevel">;
type ResponseT = null;

type ErrorT =
  | { title: "Bad Request"; status: 400 }
  | { title: "Not Found"; status: 404 }
  | { title: "Method Not Allowed"; status: 405 }
  | { title: "Content Too Large"; status: 413 }
  | { title: "Unsupported Media Type"; status: 415 }
  | { title: "Service Unavailable"; status: 503 };

declare function configure(
  sessionId: string,
  conversationId: ConversationId,
  request: Request,
): Result<ResponseT, ErrorT>;
```

Errors:

- 400: invalid path parameters, JSON, or configuration fields.
- 404: addressed session or conversation does not exist.
- 405: method is not POST; `Allow: POST`.
- 413: request body exceeds the configured limit.
- 415: unsupported request media type.
- 503: `SessionFailed`.

- Omitted field: unchanged.
- `null`: clear the stored override and follow host policy.
- Value: replace the stored override.

`model` retains `{ provider, modelId }`; `thinkingLevel` retains upstream's
thinking-level type.

Do not accept environment bindings, `cwd`, extension objects, or tool objects.
Observe committed overrides through `watch()`; do not return a second,
potentially divergent configuration representation.

### `scanTasks(query, limit, cursor)` — `GET /api/s/{sessionId}/scanTasks`

```typescript
import type { JsonValue } from "@earendil-works/chord";
import type { TaskQuery, TaskRecord } from "@earendil-works/pi-durable";
import type { Page } from "@/types";

type QueryParameters = TaskQuery & {
  limit: number;
  cursor?: string;
};

type PageT = TaskRecord<JsonValue, JsonValue, JsonValue>;

type ErrorT =
  | { title: "Bad Request"; status: 400 }
  | { title: "Not Found"; status: 404 }
  | { title: "Method Not Allowed"; status: 405 }
  | { title: "Service Unavailable"; status: 503 };

declare function scanTasks(
  sessionId: string,
  queryParameters: QueryParameters,
): Result<Page<PageT>, ErrorT>;
```

Errors:

- 400: invalid path/query parameters, cursor encoding, or a rejected storage
  read, including cursor/order conflicts.
- 404: addressed session does not exist.
- 405: method is not GET; `Allow: GET`.
- 503: `SessionFailed`.

Scope: Harness. Preserve upstream query fields and persisted task records. The
frontend uses `kind: "pi.compaction"` and `status: "terminal"` for compaction
timings.

Persisted task outcomes retain their upstream JSON error representation; they
are not HTTP failures and do not become problem objects.

The transaction remains server-side.

### Submission `status(id)` — `GET /api/s/{sessionId}/c/{conversationId}/submissions/status`

```typescript
import type {
  ConversationId,
  SubmissionId,
  SubmissionRecord,
} from "@earendil-works/pi-durable";

type QueryParameters = {
  id: SubmissionId;
};

type ResponseT = SubmissionRecord | null;

type ErrorT =
  | { title: "Bad Request"; status: 400 }
  | { title: "Not Found"; status: 404 }
  | { title: "Method Not Allowed"; status: 405 }
  | { title: "Service Unavailable"; status: 503 };

declare function status(
  sessionId: string,
  conversationId: ConversationId,
  queryParameters: QueryParameters,
): Result<ResponseT, ErrorT>;
```

Errors:

- 400: invalid path/query parameters or a rejected storage read.
- 404: addressed session or conversation does not exist; an absent or
  differently scoped submission returns `null`.
- 405: method is not GET; `Allow: GET`.
- 503: `SessionFailed`.

Reacquire the submission through `Harness.submission(id)`, then call
`Submission.status()`.

Return `null` if absent or outside the addressed conversation. Preserve the
record unchanged otherwise. This reads status without waiting or enabling
scheduling.

## Telemetry

Start with existing Durable and Pi AI instrumentation, one Pi-to-OpenTelemetry
adapter, and a host-side `otel-desktop-viewer` service. The current application
runs Durable on the host; only its execution environment reaches into guests. No
guest telemetry transport, `otel-cli`, or separate Collector is needed for this
integration. See the [application wiring](../../app/serve/application.ts) and
[host service](../../../nixosModules/pi.nix).

```text
host
  Harness instances: Durable + Pi AI instrumentation
    -> Pi-to-OTel adapter
    -> OTel SDK + OTLP exporters
    -> localhost:4318
    -> otel-desktop-viewer: DuckDB + web UI
```

### Adapter and lifecycle

Implement the pinned
[`pi-telemetry` contracts](../harness/node_modules/@earendil-works/pi-telemetry/dist/index.d.ts)
using the OTel SDK directly. Include traces, W3C trace-context propagation and
metrics; no log pipeline or auto-instrumentation initially. Map span attributes,
events, statuses and links to their OTel equivalents, and counters, up/down
counters and histograms to the corresponding metric instruments. Preserve
upstream names, attributes and error diagnostics; do not add content filtering
or redaction.

Preserve callback settlement semantics: invoke the callback synchronously and
exactly once, preserve its result or rejection, respect explicit status, and
ignore recording calls after settlement. Settled spans remain usable as link and
propagation targets. Verify the adapter with the upstream
[conformance suite](../harness/node_modules/@earendil-works/pi-telemetry/dist/testing/index.d.ts).
Use explicit contexts, not ambient current-span state. Do not introduce an
intermediate telemetry database or poll `InMemoryTelemetryContext` for export.

Deployment owns SDK initialization, service identity, export configuration and
shutdown. Create one telemetry runtime per application process, share its
adapter across Harness instances through `HarnessOptions.telemetry`, and shut
down the providers/exporters after closing the Harnesses. Use SDK batching and
shutdown flushing rather than custom retry or persistence machinery.

The extracted [`openHarness()`](../harness/src/index.ts) already forwards the
telemetry option. Configuring it enables existing Durable and nested model
instrumentation without requiring API request spans first. Preserve Durable's
propagation and span-link semantics rather than forcing all work into one HTTP
request tree. Sources:
[`DURABLE_TELEMETRY_SCHEMA`](../harness/node_modules/@earendil-works/pi-durable/dist/harness/telemetry.js),
[submission instrumentation](../harness/node_modules/@earendil-works/pi-durable/dist/harness/submissions.js),
and
[AI telemetry](../harness/node_modules/@earendil-works/pi-ai/dist/telemetry.js).

### Host collector

Run the nixpkgs-pinned `otel-desktop-viewer` as a NixOS system service:

```nix
systemd.services.otel-desktop-viewer = let
  StateDirectory = "otel-desktop-viewer";
in {
  wantedBy = ["multi-user.target"];
  serviceConfig = {
    inherit StateDirectory;
    ExecStart = lib.concatStringsSep " " [
      (lib.getExe pkgs.otel-desktop-viewer)
      "--host 127.0.0.1"
      "--open-browser=false"
      "--db %S/${StateDirectory}/telemetry.duckdb"
    ];
  };
};
```

The pinned
[v0.5.0 viewer](https://github.com/CtrlSpice/otel-desktop-viewer/blob/v0.5.0/README.md)
already provides OTLP receivers, batching, storage and the UI. Use its default 2
GB on-disk pruning threshold initially. The application sends OTLP/HTTP to port
4318; access the UI on port 8000 through SSH forwarding or Tailscale.

Configure the application through deployment:

```sh
OTEL_SERVICE_NAME=drv-run
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
```

The bootstrap must configure the SDK from these values; setting environment
variables alone does not activate Pi telemetry.

### Integration scope

First verify that a submission produces Durable and AI traces and metrics in the
viewer. Whether to wire this into the existing application immediately or
reserve the wiring for the new API executable remains undecided. For the
existing application, initialization/shutdown belongs in
[`server.ts`](../../app/serve/server.ts), with the telemetry option passed
through [`sessions.ts`](../../app/serve/sessions.ts). Instrumenting only the
extracted packages does not enable telemetry in the running service.

API measurements and shell instrumentation are independent follow-ups, not
prerequisites for this initial integration. API instrumentation should
subsequently distinguish upstream Durable work, serialization and response
writes. For watches, distinguish stream lifetime, time to the first snapshot,
and per-event processing/write durations; stream lifetime is not request
processing latency. Use telemetry to guide optimization without requiring a
separate snapshot-cost study before implementation.

## Follow-up work

Harness catalog, creation, naming and archival; execution-target selection and
working-directory validation; model/target choices; filesystem completion and
file serving; review workflows; global settings; provider authorization; and
push notifications are application or deployment integrations. Do not include
them in the core surface or introduce a dependency on the concrete Harness
package to implement them.

Incremental synchronization is required follow-up work, not part of the initial
snapshot-based API. Its protocol is deferred; implementing it is not contingent
on snapshot-cost measurements. Use telemetry to guide subsequent optimization
efforts.
