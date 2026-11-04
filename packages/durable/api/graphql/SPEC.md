# Durable GraphQL API

## Authority and scope

The [schema](schema.graphql), including its descriptions, is authoritative for
GraphQL shape and field-specific contracts. Author it in
[graphql.ts](graphql.ts) and generate it with Grats; do not maintain a second
schema or resolver map. This specification defines execution, transport,
ownership, and deployment requirements. It does not redefine types, fields,
arguments, or defaults.

Upstream Durable is authoritative for Harness behavior. Use the versions pinned
in the [package manifest](../package.json) and lockfile. The relevant contracts
are
[Session and storage](../node_modules/@earendil-works/pi-durable/dist/types.d.ts)
and
[Harness and conversations](../node_modules/@earendil-works/pi-durable/dist/harness/types.d.ts).

This directory belongs to the enclosing API package, not a separate npm package.
The schema covers non-streaming operations. Do not add subscriptions, remote
transactions, execution callbacks, or task-control operations as server
plumbing. The REST specification remains separate:
[[packages/durable/api/SPEC.md]].

## Composition

```text
deployment: listener + access policy + persisted Harness factory
    |
bounded HTTP adapter
    |
GraphQL-over-HTTP handler -> GraphQL.js -> Grats-generated schema
                                             |
                                      functional resolvers
                                             |
                                      upstream Harness
```

Keep all handwritten GraphQL code in [graphql.ts](graphql.ts). Use exported
functional resolvers colocated with their associated interfaces; do not put
methods on GraphQL interfaces. Generated code is a build artifact.

Depend on upstream Harness interfaces, not the application Harness
implementation. Deployment supplies the factory, storage, execution environment,
model settings, and telemetry. The API owns instances it acquires and exposes
explicit shutdown; it does not own the listener. Reuse the ownership boundary of
the [REST API](../src/index.ts), not its route decoder or HTTP-shaped
dispatcher.

### Dependency injection

Resolvers need explicit access to instance lookup, upstream execution contexts,
and operation-local observations. Grats supports this through its native context
mechanism; see
[[packages/durable/api/node_modules/grats/llm-docs/docblock-tags/context.md]].

A minimal context carrying those dependencies is the proposed integration. Its
concrete definition requires approval before implementation. Do not reinstate a
context interface that mirrors every resolver. Do not substitute ambient mutable
state, patch generated resolver maps, or construct a new schema per request.

## Execution and observations

Call the corresponding upstream operations directly. The
[REST dispatcher](../src/operations.ts) is a reference for those calls, not an
additional transport layer for GraphQL.

Reads do not enable scheduling. Keep each read-only transaction short and use
only its `tx` inside the callback. Never hold a `Harness.commit()` transaction
across GraphQL execution: nested Session calls can wait on the mutation line
already held by that transaction.

A GraphQL operation is not a cross-Harness snapshot or a transaction. GraphQL.js
may execute query fields concurrently and executes top-level mutation fields
serially; serial execution does not make a mutation document atomic. A later
failure does not roll back earlier admissions. Preserve upstream admission,
placement, completion, and recovery distinctions rather than waiting for agent
work to finish.

Use operation-local observations to satisfy the schema's node-equality contract
across lookups, connections, and inspection. Start with ordinary maps, including
in-flight reads where necessary. Do not introduce a global record cache or a
batching framework without a demonstrated need. Do not mutate Session-owned
records while constructing transport projections.

Sources: upstream
[transaction contracts](../node_modules/@earendil-works/pi-durable/dist/types.d.ts)
and GraphQL.js [execution](../node_modules/graphql/execution/execute.js).

## Identity and pagination

Implement the schema's global identification and connection contracts, including
their descriptions. Relay references:
[global identification](https://graphql.org/learn/global-object-identification/)
and [connections](https://relay.dev/graphql/connections.htm).

Deployment must provide a persisted session identity that cannot be reused for
replacement storage. Reopening the same storage preserves identity. Non-reused
session keys are sufficient; deployments that reuse keys need a persisted
incarnation identifier. The encoding remains an adapter detail, not a client
contract. Validate decoded scope and object kind before accessing a mutation
target. An opaque ID is not an access credential.

Durable's `Cursor` is backend-owned continuation state. Round-trip it unchanged;
do not synthesize it from a particular backend's implementation or treat a
`Page.next` as an edge cursor. The REST cursor codec is not a Relay
implementation.

A simple initial algorithm may rescan ordered upstream pages and discard records
through the adapter cursor's last emitted ID, then collect the requested slice
and lookahead. Preserve scope, filter, and ordering validation. This avoids
backend-specific cursor assumptions; continuation reuse is an optimization to
justify by measurement. Do not claim snapshot isolation between page requests.

Source: upstream
[page and scan contracts](../node_modules/@earendil-works/pi-durable/dist/types.d.ts).

## Validation and errors

Configure custom scalars when constructing the generated schema. TypeScript
aliases do not validate runtime values. Enforce the scalar and input contracts
from the schema for both variables and inline literals. Preserve payloads and
the distinction between omission and explicit null; do not coerce invalid input
or silently drop content. Reuse existing TypeBox validators only where their
contracts match.

GraphQL.js defaults unspecified scalar coercion functions to identity functions;
empty configurations are not sufficient validation. See its
[scalar implementation](../node_modules/graphql/type/definition.js) and
[[packages/durable/api/node_modules/grats/llm-docs/docblock-tags/scalars.md]].

Execution failures use GraphQL errors with these `extensions.code` values:

| Condition                                                       | Code                    |
| --------------------------------------------------------------- | ----------------------- |
| Adapter validation failure or `StorageRequestError` from a read | `BAD_REQUEST`           |
| Missing mutation target                                         | `NOT_FOUND`             |
| Typed `ConversationBusy` from input submission                  | `CONVERSATION_BUSY`     |
| Typed `SessionFailed`                                           | `SESSION_FAILED`        |
| Otherwise                                                       | `INTERNAL_SERVER_ERROR` |

Missing lookup objects return null; storage failures do not masquerade as
absence. Persisted task failures and blocked inspection states are data, not
GraphQL execution failures.

Classify errors at the operation boundary. A `StorageRequestError` from storage
commit or ID minting is fatal and takes the internal-error fallback. So do
`ReadAfterWrite` and untyped upstream exceptions. Never classify by message
text. Preserve GraphQL error paths, null propagation, and partial results.
Return safe messages, not internal exception messages, stacks, or causes. Keep
diagnostics server-side without rewriting persisted failure data.

GraphQL request errors, execution errors, and HTTP transport errors are
distinct. Use protocol-appropriate statuses; do not map every execution error to
HTTP 500 or send REST problem documents in place of GraphQL execution results.

Sources: [GraphQL policy](graphql.ts), upstream
[storage failure contract](../node_modules/@earendil-works/pi-durable/dist/types.d.ts),
and the existing [read-error boundary](../src/problem.ts).

## HTTP transport

The proposed transport is the core `graphql-http` handler behind a small
`node:http` adapter. The reviewed candidate is
[`graphql-http` 1.23.1](https://github.com/graphql/graphql-http/blob/v1.23.1/package.json);
it is not yet a package dependency. Pin the selected release when integrating
it. No additional HTTP framework is needed.

Use the library for GraphQL request parsing, operation selection, validation,
execution, and response negotiation. Support standard JSON requests and
negotiate GraphQL response media types. Mutations must not execute over GET. Do
not add request-array batching, uploads, WebSockets, or a browser IDE to this
boundary.

The adapter must enforce encoded body limits before unbounded buffering, reject
invalid UTF-8, handle interrupted uploads, and set `Cache-Control: no-store` on
responses. Preserve method and media-type checks. Apply body limits to streamed
bytes, not just `Content-Length`.

The reviewed
[Node adapter](https://github.com/graphql/graphql-http/blob/v1.23.1/src/use/http.ts)
buffers bodies without a limit. Its
[core handler](https://github.com/graphql/graphql-http/blob/v1.23.1/src/handler.ts)
turns body-reader exceptions into malformed-body errors and defaults to
returning errors unchanged. Supply bounded reading and explicit error
formatting; handle oversized bodies as HTTP 413 outside that generic parser
failure path.

Use one executable schema per API instance. Do not reload SDL or run Grats on
requests. The endpoint mount and listener address belong to deployment.

## Ownership, recovery, and deployment

Share concurrent opens of one persisted Harness. Opening belongs to the service,
not the first request's lifetime. An absent persisted session must not be
created as a side effect of lookup. Factory failures must release partially
acquired resources.

Observe terminal instance state and define how failed instances become eligible
for reopening. Reopen from persisted storage; never transparently replay a
mutation. Neither `SESSION_FAILED`, a disconnected response, nor a transport
failure establishes whether admission committed or authorizes automatic replay.
Do not invent a recovery time or emit `Retry-After` without one.

The existing [instance manager](../src/sessions.ts) shares opens and closes
owned instances, but does not evict an opened Harness when it subsequently
fails. Its reuse requires an explicit recovery policy, not an assumption that
factory injection already provides recovery.

Disconnecting an observer must not call `Conversation.abort()` or cancel durable
agent execution. Cancellation of request-bound reads or waits is separate from
work already admitted upstream.

Before exposing the endpoint outside a trusted boundary, deployment must select:

- Authentication and session-access policy, applied to every lookup path,
  including global IDs and cursor-based traversal.
- Request, document/selection-work, pagination, and concurrency budgets. A body
  limit alone does not bound nested connection expansion. Reject over-budget
  work rather than silently truncating results or changing pagination semantics.
- Stable session identity, failed-instance reopening policy, and shutdown
  bounds.

Stop request admission before shutdown. Settle or cancel request-bound work
under the selected policy, close owned Harnesses, then shut down telemetry.
Reuse the existing [telemetry adapter](../src/telemetry.ts) and the deployment
ownership in [[packages/durable/api/SPEC.md#Telemetry]]. GraphQL-specific
tracing is not a prerequisite for serving requests.

## Build and verification

Grats remains a build-time tool; GraphQL.js and the selected transport are
runtime dependencies. Keep the Nix-provided TypeScript compiler. Compile and
install the handwritten module and generated executable schema with the API
entry point; shipping SDL alone does not provide a server. Package exports and
Nix installation must agree about artifact locations.

Before calling the server working, verify the executable schema and the
installed package after development dependencies have been pruned. Cover scalar
coercion, identity and repeated observations, per-edge cursor resumption,
pagination boundaries, admission recovery, typed errors, and lifecycle behavior.
Verify that reads do not enable scheduling and disconnects do not abort admitted
work.

The current [coverage configuration](../package.json) targets `src/**/*.ts`; its
percentage does not establish GraphQL coverage. Do not weaken thresholds or
exclude new production code to accommodate implementation.
