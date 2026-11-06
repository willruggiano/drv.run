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

## Schema-to-upstream mapping

This inventory covers every declared schema type and operation. It maps names,
not a second set of field contracts. Unless a conversion is listed, fields,
arguments, and enum values keep their upstream names. Nullability, selections,
and defaults remain authoritative in the [schema](schema.graphql).

Source prefixes below refer to the pinned 1.4.0 packages:

- `D`: Durable
  [records, transactions, queries, and pages](../node_modules/@earendil-works/pi-durable/dist/types.d.ts)
  and
  [Harness, Conversation, Submission, and agent contracts](../node_modules/@earendil-works/pi-durable/dist/harness/types.d.ts).
- `AI`: Pi AI
  [messages, content, tools, and usage](../node_modules/@earendil-works/pi-ai/dist/types.d.ts),
  [diagnostics](../node_modules/@earendil-works/pi-ai/dist/utils/diagnostics.d.ts),
  and
  [model settings](../node_modules/@earendil-works/pi-ai/dist/providers/model-schema.d.ts).
- `Chord`: [JSON values](../node_modules/@earendil-works/chord/dist/json.d.ts).
- `Telemetry`:
  [propagation carriers](../node_modules/@earendil-works/pi-telemetry/dist/index.d.ts).

“Adapter” means there is no corresponding upstream named type. Indexed type
expressions identify upstream members that GraphQL requires us to name.

### Behavior and procedure mapping

Calls to `D.Conversation` methods acquire the handle through
`D.Harness.conversation()`. Transaction reads below run inside
`D.Harness.commit()`. The resolver's Chord context stays server-side.

| Behavior                                        | GraphQL field                            | Upstream procedure or source                                                                                                                                    |
| ----------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Refetch a global identity                       | `Query.node`                             | Adapter dispatch: session lookup for Harness; `D.Tx.conversation`, `D.Tx.entry`, or `D.Tx.task` for records; `D.Harness.submission().status()` for submissions. |
| Resolve an accessible session                   | `Query.harness`                          | Deployment's `ResolverContext.session(sessionId)`; no Durable catalog operation.                                                                                |
| List accessible sessions                        | `Query.harnesses`                        | Deployment's `ResolverContext.sessions()`; sorted catalog, without opening Harnesses.                                                                           |
| Read a conversation record                      | `Harness.conversation`                   | `D.Tx.conversation(id)`; returns the persisted record, not a live `D.Conversation` handle.                                                                      |
| Inspect scheduling and live work                | `Harness.inspect`                        | `D.Harness.inspect()`.                                                                                                                                          |
| Browse conversation scopes                      | `Harness.scanConversations`              | `D.Tx.scanConversations(query, limit, cursor)`.                                                                                                                 |
| Inspect persisted tasks                         | `Harness.scanTasks`                      | `D.Tx.scanTasks(query, limit, cursor)`.                                                                                                                         |
| Read resolved agent settings                    | `ConversationRecord.agent`               | `D.Conversation.agent()`, with the readable projection below.                                                                                                   |
| Read fork-aware history                         | `ConversationRecord.entries`             | `D.Conversation.entries(query, limit, cursor)`.                                                                                                                 |
| Inspect current or historical model context     | `ConversationRecord.context`             | `D.Conversation.context(context, { at })`.                                                                                                                      |
| Recover an uncertain submission acknowledgement | `ConversationRecord.submissionByRequest` | `D.Tx.submissionByRequest(conversationId, requestId)`.                                                                                                          |
| Read a submission receipt                       | `ConversationRecord.status`              | `D.Harness.submission(id)`, then `D.Submission.status()`; returns null for a different conversation.                                                            |
| Submit input or a passive entry write           | `Mutation.submit`                        | `D.Conversation.submit(submission)`; both branches of `D.SubmissionDraft`.                                                                                      |
| Withdraw a queued submission                    | `Mutation.abortSubmission`               | `D.Harness.abortSubmission(id, context, conversationId)`.                                                                                                       |
| Stop ordinary owned work                        | `Mutation.abort`                         | `D.Conversation.abort(context)`; no background option exposed.                                                                                                  |
| Enable scheduling                               | `Mutation.resume`                        | `D.Harness.resume()`.                                                                                                                                           |
| Admit a context reset                           | `Mutation.reset`                         | `D.Conversation.reset(handoff, context)`.                                                                                                                       |
| Admit compaction                                | `Mutation.compact`                       | `D.Conversation.compact(instructions, context)`; returns a task ID, not completion.                                                                             |
| Change agent overrides                          | `Mutation.configure`                     | `D.Conversation.configure(change, context)`, with the writable projection below.                                                                                |

### Roots, identities, records, and pages

The `Record` suffix is upstream terminology, not a GraphQL requirement.
`D.ConversationRecord` is stored data; `D.Conversation` is a handle with
operations. The GraphQL `ConversationRecord` combines record fields with the
conversation-scoped resolvers above. Likewise, `D.SubmissionRecord` is a
receipt, not the awaitable `D.Submission`, and `D.TaskRecord` is persisted task
state, not an executable `D.Task` definition. `D.Entry` is a typed entry-kind
token, not an individual `D.EntryRecord`.

| Schema name                    | Upstream name or adapter role                                                                              |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `Query`                        | Adapter root for reads.                                                                                    |
| `Mutation`                     | Adapter root for admissions and configuration.                                                             |
| `Node`                         | Adapter global-identity interface.                                                                         |
| `Harness`                      | Adapter session reference to `D.Harness`; identity comes from deployment.                                  |
| `ConversationRecord`           | `D.ConversationRecord`, plus scoped operations and transport identity.                                     |
| `ConversationRecordParent`     | `NonNullable<D.ConversationRecord["parent"]>`.                                                             |
| `ConversationRecordOwner`      | `NonNullable<D.ConversationRecord["owner"]>`.                                                              |
| `EntryRecord`                  | `D.EntryRecord`, with transport identity and typed message projections.                                    |
| `SubmissionRecord`             | `D.SubmissionRecord`, flattened into one object with variant-dependent fields.                             |
| `TaskRecord`                   | `D.TaskRecord<Chord.JsonValue, Chord.JsonValue, Chord.JsonValue>`.                                         |
| `TaskState`                    | `D.TaskState<Chord.JsonValue, Chord.JsonValue>`, flattened discriminated union.                            |
| `TaskOutcome`                  | `D.TaskOutcome<Chord.JsonValue>`, flattened discriminated union.                                           |
| `TaskOutcomeError`             | `D.TaskOutcomeError`.                                                                                      |
| `ContextEdit`                  | `D.ContextEdit`, with typed replacement messages.                                                          |
| `ContextView`                  | `D.ContextView`, with record and message projections.                                                      |
| `HarnessInspection`            | `D.HarnessInspection`, with record projections.                                                            |
| `TaskInspection`               | `D.TaskInspection`.                                                                                        |
| `TaskInspectionState`          | `D.TaskInspection["state"]`, flattened discriminated union.                                                |
| `ConversationRecordConnection` | Adapter projection of `D.Page<D.ConversationRecord, D.Cursor>`.                                            |
| `EntryRecordConnection`        | Adapter projection of `D.Page<D.EntryRecord, D.Cursor>`.                                                   |
| `TaskRecordConnection`         | Adapter projection of `D.Page<D.TaskRecord<Chord.JsonValue, Chord.JsonValue, Chord.JsonValue>, D.Cursor>`. |
| `PageInfo`                     | Adapter container for `D.Page<unknown, D.Cursor>["next"]`; not Relay page information.                     |

### Inputs, agent settings, and mutation envelopes

| Schema name               | Upstream name or adapter role                                                                            |
| ------------------------- | -------------------------------------------------------------------------------------------------------- |
| `ConversationQuery`       | `D.ConversationQuery`.                                                                                   |
| `EntryQuery`              | `Omit<D.EntryQuery, "conversationId">`; the conversation is already addressed.                           |
| `TaskQuery`               | `D.TaskQuery`.                                                                                           |
| `Agent`                   | Readable `D.Agent` fields: `model`, `thinkingLevel`, `cwd`, `instructions`.                              |
| `AgentChange`             | Writable `D.AgentChange` fields: `model`, `thinkingLevel`, `cwd`.                                        |
| `ModelRefInput`           | `D.ModelRef` as an input object.                                                                         |
| `ModelRef`                | `D.ModelRef` as an output object; GraphQL input and output types cannot share a definition.              |
| `SubmissionDraft`         | One-of wrapper for `D.SubmissionDraft`; selection supplies `type`.                                       |
| `InputSubmissionDraft`    | `Omit<D.InputSubmissionDraft, "type">`; selection supplies the discriminator and content is unwrapped.   |
| `WriteSubmissionDraft`    | Adapter name for the write branch of `D.SubmissionDraft`, without its discriminator or forbidden fields. |
| `InputEntry`              | `D.InputEntry`; application kind and arbitrary JSON data.                                                |
| `EntryDraft`              | `D.EntryDraft`, with typed message and context-edit inputs.                                              |
| `ContextEditInput`        | One-of wrapper for `D.ContextEdit`; selection supplies `action`.                                         |
| `ContextReplacementInput` | Adapter object for the replace branch's target and messages.                                             |
| `UserInput`               | One-of wrapper for `D.UserInput`, which is `AI.UserMessage["content"]`.                                  |
| `UserInputBlock`          | One-of wrapper for an element of the array branch of `D.UserInput`.                                      |
| `TextContentInput`        | `Omit<AI.TextContent, "type">`; conversion supplies `type: "text"`.                                      |
| `ImageContentInput`       | `Omit<AI.ImageContent, "type">`; conversion supplies `type: "image"`.                                    |
| `SubmitInput`             | Adapter addressing/correlation envelope around `D.SubmissionDraft`.                                      |
| `SubmitPayload`           | Adapter reference to the admitted `D.Submission.id`.                                                     |
| `AbortSubmissionInput`    | Adapter addressing/correlation envelope for `D.Harness.abortSubmission()`.                               |
| `AbortSubmissionPayload`  | Adapter envelope around the return value of `D.Harness.abortSubmission()`.                               |
| `AbortInput`              | Adapter addressing/correlation envelope for `D.Conversation.abort()`.                                    |
| `AbortPayload`            | Adapter envelope for successful upstream void completion.                                                |
| `ResumeInput`             | Adapter addressing/correlation envelope for `D.Harness.resume()`.                                        |
| `ResumePayload`           | Adapter envelope for successful upstream void completion.                                                |
| `ResetInput`              | Adapter addressing/correlation envelope around `D.Conversation.reset()`'s handoff.                       |
| `ResetPayload`            | Adapter envelope for successful upstream void completion.                                                |
| `CompactInput`            | Adapter addressing/correlation envelope around `D.Conversation.compact()`'s instructions.                |
| `CompactPayload`          | Adapter reference to the task ID returned by `D.Conversation.compact()`.                                 |
| `ConfigureInput`          | Adapter addressing/correlation envelope around the exposed `D.AgentChange` fields.                       |
| `ConfigurePayload`        | Adapter envelope for successful upstream void completion.                                                |

### Messages, content, and diagnostics

These declarations originate in Pi AI, not Durable. Durable stores and returns
Pi AI messages. Output unions and one-of inputs preserve their variants;
wrappers preserve the string-versus-array distinction without making messages
opaque scalars.

| Schema name            | Upstream name or adapter role                                                        |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `Message`              | `AI.Message`.                                                                        |
| `SystemMessage`        | `AI.SystemMessage`.                                                                  |
| `UserMessage`          | `AI.UserMessage`.                                                                    |
| `AssistantMessage`     | `AI.AssistantMessage`.                                                               |
| `ToolResultMessage`    | `AI.ToolResultMessage`.                                                              |
| `SystemMessageContent` | Adapter union for `AI.SystemMessage["content"]`.                                     |
| `UserMessageContent`   | Adapter union for `AI.UserMessage["content"]`.                                       |
| `StringContent`        | Adapter object wrapping the string branch of system/user content.                    |
| `TextContentList`      | Adapter object wrapping the array branch of system content.                          |
| `UserContentList`      | Adapter object wrapping the array branch of user content.                            |
| `UserContent`          | `AI.ToolResultMessage["content"][number]`; also the elements of user content arrays. |
| `AssistantContent`     | `AI.AssistantMessage["content"][number]`.                                            |
| `TextContent`          | `AI.TextContent`.                                                                    |
| `ImageContent`         | `AI.ImageContent`.                                                                   |
| `ThinkingContent`      | `AI.ThinkingContent`.                                                                |
| `ToolCall`             | `AI.ToolCall`.                                                                       |
| `Tool`                 | `AI.Tool`; model-facing declaration, not Durable's executable `ToolRegistration`.    |
| `ToolReference`        | `AI.ToolReference`.                                                                  |
| `Usage`                | `AI.Usage`.                                                                          |
| `UsageCost`            | `AI.Usage["cost"]`.                                                                  |
| `DeferredHandle`       | `AI.DeferredHandle`; provider request recovery data, not a Durable task handle.      |
| `MessageDiagnostic`    | `AI.AssistantMessageDiagnostic`.                                                     |
| `DiagnosticError`      | `AI.DiagnosticErrorInfo`.                                                            |
| `NestedToolCalls`      | `AI.NestedToolCalls`.                                                                |
| `NestedToolCallRecord` | `AI.NestedToolCallRecord`.                                                           |

Input objects map to the same upstream contracts. Nested content and metadata
use the corresponding input types; conversion supplies omitted discriminators.

| Schema name                 | Upstream name or adapter role                                                 |
| --------------------------- | ----------------------------------------------------------------------------- |
| `MessageInput`              | One-of wrapper for `AI.Message`; selection supplies `role`.                   |
| `SystemMessageInput`        | `Omit<AI.SystemMessage, "role">`.                                             |
| `UserMessageInput`          | `Omit<AI.UserMessage, "role">`; content uses `UserInput`.                     |
| `AssistantMessageInput`     | `Omit<AI.AssistantMessage, "role">`.                                          |
| `ToolResultMessageInput`    | `Omit<AI.ToolResultMessage, "role">`; content uses `UserInputBlock` elements. |
| `SystemMessageContentInput` | One-of wrapper for `AI.SystemMessage["content"]`.                             |
| `AssistantContentInput`     | One-of wrapper for `AI.AssistantMessage["content"][number]`.                  |
| `ThinkingContentInput`      | `Omit<AI.ThinkingContent, "type">`.                                           |
| `ToolCallInput`             | `Omit<AI.ToolCall, "type">`.                                                  |
| `ToolInput`                 | `AI.Tool`; parameters and constrained sampling remain JSON.                   |
| `ToolReferenceInput`        | `AI.ToolReference`.                                                           |
| `UsageInput`                | `AI.Usage`.                                                                   |
| `UsageCostInput`            | `AI.Usage["cost"]`.                                                           |
| `DeferredHandleInput`       | `AI.DeferredHandle`.                                                          |
| `MessageDiagnosticInput`    | `AI.AssistantMessageDiagnostic`.                                              |
| `DiagnosticErrorInput`      | `AI.DiagnosticErrorInfo`.                                                     |
| `NestedToolCallsInput`      | `AI.NestedToolCalls`.                                                         |
| `NestedToolCallRecordInput` | `AI.NestedToolCallRecord`.                                                    |

### Enums

Enum values retain upstream discriminant spellings. Several enums name an
upstream inline literal union rather than a separately exported type.

| Schema name                    | Upstream name or member                                                                                   |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `BlockedReason`                | The blocked variant's `reason` in `D.TaskInspection["state"]`.                                            |
| `ContentType`                  | The `type` discriminants of `AI.TextContent`, `AI.ImageContent`, `AI.ThinkingContent`, and `AI.ToolCall`. |
| `ContextEditAction`            | `D.ContextEdit["action"]`.                                                                                |
| `HarnessAbortSubmissionResult` | `Awaited<ReturnType<D.Harness["abortSubmission"]>>`.                                                      |
| `HarnessInspectionScheduling`  | `D.HarnessInspection["scheduling"]`.                                                                      |
| `InputSubmissionDraftWhenBusy` | `NonNullable<D.InputSubmissionDraft["whenBusy"]>`.                                                        |
| `JoinPolicy`                   | `D.JoinPolicy`.                                                                                           |
| `MessageRole`                  | `AI.Message["role"]`.                                                                                     |
| `ModelThinkingLevel`           | `AI.ModelThinkingLevel`, used by Durable's agent settings.                                                |
| `NestedToolCallStatus`         | `AI.NestedToolCallRecord["status"]`.                                                                      |
| `ScanOrder`                    | `D.ScanOrder`.                                                                                            |
| `StopReason`                   | `AI.StopReason`.                                                                                          |
| `SubmissionRecordStatus`       | `D.SubmissionRecord["status"]`.                                                                           |
| `SubmissionRecordType`         | `D.SubmissionRecord["type"]`.                                                                             |
| `TaskInspectionStateKind`      | `D.TaskInspection["state"]["kind"]`.                                                                      |
| `TaskOutcomeStatus`            | `D.TaskOutcome<Chord.JsonValue>["status"]`.                                                               |
| `TaskRecordAbortReason`        | `NonNullable<D.TaskRecord<Chord.JsonValue, Chord.JsonValue, Chord.JsonValue>["abortReason"]>`.            |
| `TaskStateStatus`              | `D.TaskState<Chord.JsonValue, Chord.JsonValue>["status"]`.                                                |

### Scalars and GraphQL-provided names

| Schema name        | Upstream name or adapter role                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ConversationId`   | `D.ConversationId`.                                                                                                                                                                  |
| `EntryId`          | `D.EntryId`.                                                                                                                                                                         |
| `EntryHead`        | `NonNullable<D.EntryDraft["head"]>`: a native EntryId or the literal string "self".                                                                                                  |
| `TaskId`           | `D.TaskId`; result-type branding is erased at the transport boundary.                                                                                                                |
| `SubmissionId`     | `D.SubmissionId`.                                                                                                                                                                    |
| `Cursor`           | `D.Cursor`, represented directly as JSON, not the REST base64url string.                                                                                                             |
| `JsonObject`       | `D.JsonObject` and `AI.JsonObject`.                                                                                                                                                  |
| `JsonValue`        | `Chord.JsonValue` and `AI.JsonValue`.                                                                                                                                                |
| `TelemetryCarrier` | `Telemetry.TelemetryCarrier`.                                                                                                                                                        |
| `ID`               | GraphQL built-in used for adapter global identities, not native Durable IDs.                                                                                                         |
| `Int`              | GraphQL built-in used for page limits; upstream accepts a `number`.                                                                                                                  |
| `Float`            | GraphQL built-in used for upstream numeric fields, including timestamps and usage.                                                                                                   |
| `String`           | GraphQL built-in used for upstream strings and adapter session/correlation keys.                                                                                                     |
| `Boolean`          | GraphQL built-in used for upstream booleans.                                                                                                                                         |
| `@oneOf`           | GraphQL input-variant constraint generated by Grats for the submission, message, content, and context-edit input unions.                                                             |
| `__typename`       | GraphQL runtime type name, not upstream `role`, `type`, `kind`, or `status`. Output discriminants remain separate fields; input selections supply discriminators where mapped below. |

Other standard GraphQL introspection names and directives have no Durable
counterpart. Their definitions belong to
[GraphQL.js](../node_modules/graphql/type/introspection.js), not this adapter.

### Field and argument conversions

All fields and arguments not listed here or in the procedure table retain their
mapped upstream member names. Flattened output objects retain variant-dependent
fields; one-of inputs select a single upstream variant. Enum values are not
renamed.

| GraphQL name/path                                           | Upstream mapping                                                                                                                                     |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Node.id`, including record `id` fields                     | Adapter global identity containing session scope, kind, and native ID; Harness has no native record ID.                                              |
| Record `durableId`                                          | The corresponding upstream record's `id`. Applies to ConversationRecord, EntryRecord, TaskRecord, and SubmissionRecord.                              |
| Record `harness`                                            | Adapter relationship to the owning persisted session.                                                                                                |
| `Harness.sessionId`, `Query.harness(sessionId)`             | Deployment's external session key, not a Durable record field.                                                                                       |
| `Query.node(id)`                                            | Adapter global identity selecting a native read.                                                                                                     |
| `*Connection.nodes`                                         | `D.Page.items`, after record projection.                                                                                                             |
| `*Connection.pageInfo.next`                                 | `D.Page.next`; the `pageInfo` container is adapter-only.                                                                                             |
| Mutation `input`                                            | Adapter envelope; native procedures receive the selected arguments, not this envelope.                                                               |
| Mutation input `conversationId`                             | Global ConversationRecord identity used to resolve the native conversation. Other `ConversationId`-typed fields/arguments remain native numeric IDs. |
| `ResumeInput.sessionId`                                     | Global Harness identity, unlike the external key in `Harness.sessionId`.                                                                             |
| `SubmitInput.submission`                                    | The draft argument of `D.Conversation.submit()`.                                                                                                     |
| `SubmissionDraft.input`, `SubmissionDraft.write`            | Selected native draft; conversion supplies the corresponding `type` discriminator.                                                                   |
| `MessageInput.system`, `.user`, `.assistant`, `.toolResult` | Selected native message; conversion supplies the corresponding `role` discriminator.                                                                 |
| `AssistantContentInput.text`, `.thinking`, `.toolCall`      | Selected native content block; conversion supplies the corresponding `type` discriminator.                                                           |
| `SystemMessageContentInput.text`, `.blocks`                 | Native string or text-block array; block conversion supplies `type: "text"`.                                                                         |
| `ContextEditInput.omit`                                     | Native `target` with `action: "omit"`; no messages.                                                                                                  |
| `ContextEditInput.replace`                                  | Native target and replacement messages with `action: "replace"`.                                                                                     |
| `SubmitPayload.submissionId`                                | `D.Submission.id`, converted to a global SubmissionRecord identity.                                                                                  |
| `CompactPayload.taskId`                                     | Native result of `D.Conversation.compact()`, converted to a global TaskRecord identity.                                                              |
| `AbortSubmissionPayload.result`                             | Native result of `D.Harness.abortSubmission()`.                                                                                                      |
| `clientMutationId`                                          | Adapter-only echo; never forwarded as upstream `requestId`.                                                                                          |
| `UserInput.text`                                            | Native string content.                                                                                                                               |
| `UserInput.blocks`                                          | Native ordered content array, after block unwrapping.                                                                                                |
| `UserInputBlock.text`, `UserInputBlock.image`               | Native text/image block; conversion supplies the corresponding `type` discriminator.                                                                 |
| `StringContent.text`                                        | Native string content, unchanged.                                                                                                                    |
| `TextContentList.blocks`, `UserContentList.blocks`          | Native content arrays, with typed block projections.                                                                                                 |

For `ContextView`, `EntryRecord.model`, and replacement `ContextEdit.messages`,
the field names are unchanged but each native message receives the typed output
projection. JSON maps and application payloads stay JSON: for example
`EntryRecord.data`, `ToolCall.arguments`, `Tool.parameters`, and
`ToolResultMessage.details`. A shared `JsonValue` scalar does not make those
fields interchangeable.

## Application data and input content

Arbitrary application data belongs to entries, not to another `UserInput`
variant. An input submission can supply `entry: { kind, data }`; its `data` may
be any strict JSON value. The kind must be nonempty and outside `pi.`. Durable
places that input as the chosen entry kind instead of `pi.user`:

```text
InputSubmissionDraft.content     -> EntryRecord.model[0].content
InputSubmissionDraft.entry.kind  -> EntryRecord.kind
InputSubmissionDraft.entry.data  -> EntryRecord.data
```

The generated model message remains a user message. Metadata in `data` is not
automatically model input, decoded as an attachment, or resolved as a file.
Application-specific attachment descriptors can live there; their interpretation
belongs to the application. This path is already exposed through GraphQL
`SubmitInput.submission.input.entry` and read back through `EntryRecord.data`.
`SubmissionRecord.entry` is the native ID of that placed entry, not the data
payload itself. This does not add arbitrary properties to a ConversationRecord
or SubmissionRecord.

GraphQL exposes the passive write branch through
`SubmitInput.submission.write.entry`, mapped to upstream `EntryDraft`. It
appends an entry without itself requesting an agent response. A write with only
kind/data is display-only and normally lands immediately even while busy; it
queues behind a pending reset. Writes carrying model/head/edits follow upstream
boundary and stale-head rules, even when the arrays are empty. The input
branch's kind restrictions do not apply to writes.

Both branches forward `requestId`. The same key and native type recover the
prior submission without comparing payloads; reusing a key across types retains
the upstream untyped-error fallback. Admission does not imply placement or
completion.

These are transcript entries, not Durable Docs. Sources:
[`InputEntry` and `SubmissionDraft`](../node_modules/@earendil-works/pi-durable/dist/harness/types.d.ts),
[`EntryRecord`, `EntryDraft`, and `Tx.appendEntry`](../node_modules/@earendil-works/pi-durable/dist/types.d.ts),
[input placement and strict-JSON copying](../node_modules/@earendil-works/pi-durable/dist/harness/inbox.js),
[submission admission](../node_modules/@earendil-works/pi-durable/dist/harness/submissions.js),
and
[model-context construction](../node_modules/@earendil-works/pi-durable/dist/harness/context.js).

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
model settings, and telemetry. Resolvers borrow Harnesses through the injected
session callback; the owning service supplies shutdown and failed-instance
recovery. Listener ownership remains with deployment. The
[REST API](../src/index.ts) provides an instance-ownership reference, not a
route decoder or dispatcher for GraphQL.

### Dependency injection

The [ResolverContext](graphql.ts) supplies the Chord context, an authorized
session lookup, and the authorized session catalog. It contains no observation
cache. Grats supplies it through its native context mechanism; see
[[packages/durable/api/node_modules/grats/llm-docs/docblock-tags/context.md]].

Do not substitute ambient mutable state, patch generated resolver maps, or
construct a new schema per request. Both session callbacks enforce the same
access policy; lookup does not create missing sessions.

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

Each resolver reads independently. Repeated occurrences of an identity may
reflect different moments while the Harness changes; there is no operation-local
snapshot cache. Do not mutate Session-owned records while constructing transport
projections.

Sources: upstream
[transaction contracts](../node_modules/@earendil-works/pi-durable/dist/types.d.ts)
and GraphQL.js [execution](../node_modules/graphql/execution/execute.js).

## Identity and pagination

Implement the schema's global identification and upstream page contracts. Global
IDs follow the
[Node identification pattern](https://graphql.org/learn/global-object-identification/);
pagination is not Relay pagination.

Deployment must provide a persisted session identity that cannot be reused for
replacement storage. Reopening the same storage preserves identity. Non-reused
session keys are sufficient; deployments that reuse keys need a persisted
incarnation identifier. The encoding remains an adapter detail, not a client
contract. Validate decoded scope and object kind before accessing a mutation
target. An opaque ID is not an access credential.

Durable's `Cursor` is backend-owned continuation state. Pass the supplied limit
and cursor to exactly one upstream page read. Project `items` to `nodes` and
`next` to `pageInfo.next`; do not rescan, look ahead, or synthesize edge
cursors. Round-trip the cursor JSON unchanged. Harness catalog listing is not
paginated. Do not claim snapshot isolation between page requests.

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

| Condition                                                 | Code                    |
| --------------------------------------------------------- | ----------------------- |
| Adapter validation failure or typed `StorageRequestError` | `BAD_REQUEST`           |
| Missing mutation target                                   | `NOT_FOUND`             |
| Typed `ConversationBusy`                                  | `CONVERSATION_BUSY`     |
| Typed `SessionFailed`                                     | `SESSION_FAILED`        |
| Otherwise                                                 | `INTERNAL_SERVER_ERROR` |

Missing lookup objects return null; storage failures do not masquerade as
absence. Persisted task failures and blocked inspection states are data, not
GraphQL execution failures.

The resolver's `mapError` classifies by exception type, independently of the
operation. Existing `ResolverError` instances pass through; `ReadAfterWrite` and
untyped exceptions take the internal-error fallback. Never classify by message
text. Preserve GraphQL error paths, null propagation, and partial results.
Return safe messages, not internal exception messages, stacks, or causes. Keep
diagnostics server-side without rewriting persisted failure data.

GraphQL request errors, execution errors, and HTTP transport errors are
distinct. Use protocol-appropriate statuses; do not map every execution error to
HTTP 500 or send REST problem documents in place of GraphQL execution results.

Sources: [GraphQL error mapping](graphql.ts) and upstream
[error types](../node_modules/@earendil-works/pi-durable/dist/errors.d.ts).

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
coercion, identity and independent reads, upstream cursor round trips,
pagination boundaries, admission recovery, typed errors, and lifecycle behavior.
Verify that reads do not enable scheduling and disconnects do not abort admitted
work.

The current [coverage configuration](../package.json) targets `src/**/*.ts`; its
percentage does not establish GraphQL coverage. Do not weaken thresholds or
exclude new production code to accommodate implementation.
