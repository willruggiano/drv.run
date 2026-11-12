# Durable GraphQL API

## Authority and scope

The generated [schema](schema.graphql) describes the implemented Durable API.
This specification gives the target contracts for execution, transport,
ownership, deployment, identity, lifecycle, mutations, documents, and
application services. The generated schema does not yet implement all these
contracts.

Upstream Durable controls Harness behavior. The [manifest](../package.json) and
[lockfile](../package-lock.json) pin dependency versions. The upstream contracts
are
[Session and storage](../node_modules/@earendil-works/pi-durable/dist/types.d.ts)
and
[Harness and conversations](../node_modules/@earendil-works/pi-durable/dist/harness/types.d.ts).

The API has no subscriptions, remote transactions, execution callbacks, or
task-control operations. The SSE API changes only for bug fixes. New application
and document operations use GraphQL, not new REST routes or synchronization
protocols. The REST/SSE contract is in [[packages/durable/api/SPEC.md]].

The tables and SDL below give target names, mutation results, lifecycle
operations, and application settings. They take precedence over the generated
schema where the two differ. Generic option or settings maps do not replace
these contracts.

## Schema-to-upstream mapping

These tables map reusable Durable types and operations to upstream names. The
[application contracts](#application-services) are separate. Fields, arguments,
and enum values keep upstream names unless a table specifies a conversion.

Source prefixes below refer to the pinned 1.4.0 packages:

- `D`: Durable
  [records, transactions, queries, and pages](../node_modules/@earendil-works/pi-durable/dist/types.d.ts)
  and
  [Harness, Conversation, Submission, and agent contracts](../node_modules/@earendil-works/pi-durable/dist/harness/types.d.ts).
- `AI`: Pi AI
  [messages, content, tools, and usage](../node_modules/@earendil-works/pi-ai/dist/types.d.ts),
  [diagnostics](../node_modules/@earendil-works/pi-ai/dist/utils/diagnostics.d.ts),
  [model catalog and helpers](../node_modules/@earendil-works/pi-ai/dist/models.d.ts),
  and
  [model settings](../node_modules/@earendil-works/pi-ai/dist/providers/model-schema.d.ts).
- `Chord`: [JSON values](../node_modules/@earendil-works/chord/dist/json.d.ts).
- `Telemetry`:
  [propagation carriers](../node_modules/@earendil-works/pi-telemetry/dist/index.d.ts).

“Adapter” means there is no corresponding upstream named type. Indexed type
expressions give names to upstream members for GraphQL.

### Behavior and procedure mapping

Calls to `D.Conversation` methods acquire the handle through
`D.Harness.conversation()`. Transaction reads below run inside
`D.Harness.commit()`. The resolver's Chord context stays server-side.

| Behavior                                        | GraphQL field                            | Upstream procedure or source                                                                                                                                    |
| ----------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Refetch a global identity                       | `Query.node`                             | Adapter dispatch: session lookup for Harness. `D.Tx.conversation`, `D.Tx.entry`, or `D.Tx.task` for records. `D.Harness.submission().status()` for submissions. |
| Resolve an accessible session                   | `Query.harness`                          | Deployment's `ResolverContext.session(externalId)`. No Durable catalog operation.                                                                               |
| List accessible sessions                        | `Query.harnesses`                        | Deployment's `ResolverContext.sessions()`. Sorted catalog. No Harness acquisition.                                                                              |
| Acquire or provision a Harness                  | `Mutation.open`                          | Deployment storage provisioning and shared owner, then `D.Harness.open` when needed.                                                                            |
| Get or create the reserved root                 | `Mutation.root`                          | `D.Harness.root(context, options)`.                                                                                                                             |
| Read the reserved root                          | `Harness.root`                           | `D.Tx.conversation(D.ROOT_CONVERSATION_ID)`. No creation.                                                                                                       |
| Create another conversation                     | `Mutation.createConversation`            | `D.Harness.createConversation(options, context)`.                                                                                                               |
| List available chat models                      | `Query.models`                           | Deployment's `ResolverContext.models()`, then Pi AI `Models.getAvailable(undefined, { signal })`. No Harness lookup.                                            |
| Read a conversation record                      | `Harness.conversation`                   | `D.Tx.conversation(id)`. Returns the persisted record, not a live `D.Conversation` handle.                                                                      |
| Examine scheduling and live work                | `Harness.inspect`                        | `D.Harness.inspect()`.                                                                                                                                          |
| Browse conversation scopes                      | `Harness.scanConversations`              | `D.Tx.scanConversations(query, limit, cursor)`.                                                                                                                 |
| Examine persisted tasks                         | `Harness.scanTasks`                      | `D.Tx.scanTasks(query, limit, cursor)`.                                                                                                                         |
| Read resolved agent settings                    | `ConversationRecord.agent`               | `D.Conversation.agent()`, with the readable projection below.                                                                                                   |
| Read fork-aware history                         | `ConversationRecord.entries`             | `D.Conversation.entries(query, limit, cursor)`.                                                                                                                 |
| Examine current or historical model context     | `ConversationRecord.context`             | `D.Conversation.context(context, { at })`.                                                                                                                      |
| Recover an uncertain submission acknowledgement | `ConversationRecord.submissionByRequest` | `D.Tx.submissionByRequest(conversationId, requestId)`.                                                                                                          |
| Read a submission receipt                       | `ConversationRecord.status`              | `D.Harness.submission(id)`, then `D.Submission.status()`. Returns null for a different conversation.                                                            |
| Submit input or a passive entry write           | `Mutation.submit`                        | `D.Conversation.submit(submission)`. The two branches of `D.SubmissionDraft`.                                                                                   |
| Withdraw a queued submission                    | `Mutation.abortSubmission`               | `D.Harness.abortSubmission(id, context, conversationId)`.                                                                                                       |
| Stop ordinary owned work                        | `Mutation.abort`                         | `D.Conversation.abort(context)`. No background option exposed.                                                                                                  |
| Enable scheduling                               | `Mutation.resume`                        | `D.Harness.resume()`.                                                                                                                                           |
| Admit a context reset                           | `Mutation.reset`                         | `D.Conversation.reset(handoff, context)`.                                                                                                                       |
| Admit compaction                                | `Mutation.compact`                       | `D.Conversation.compact(instructions, context)`. Returns a task ID, not completion.                                                                             |
| Change agent overrides                          | `Mutation.configure`                     | `D.Conversation.configure(change, context)`, with the writable projection below.                                                                                |

### Roots, identities, records, and pages

The `Record` suffix comes from upstream. `D.ConversationRecord` is stored data.
`D.Conversation` is a handle with operations. GraphQL `ConversationRecord`
combines record fields with conversation-scoped resolvers.

`D.SubmissionRecord` is a receipt, not the awaitable `D.Submission`.
`D.TaskRecord` is persisted task state, not an executable `D.Task` definition.
`D.Entry` is a typed entry-kind token, not an individual `D.EntryRecord`.

| Schema name                    | Upstream name or adapter role                                                                              |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `Query`                        | Adapter root for reads.                                                                                    |
| `Mutation`                     | Adapter root for admissions and configuration.                                                             |
| `Node`                         | Adapter global-identity interface.                                                                         |
| `Harness`                      | Adapter session reference to `D.Harness`. Identity comes from deployment.                                  |
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
| `PageInfo`                     | Adapter container for `D.Page<unknown, D.Cursor>["next"]`. Not Relay page information.                     |

### Inputs, agent settings, and mutation envelopes

| Schema name               | Upstream name or adapter role                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------- |
| `ConversationQuery`       | `D.ConversationQuery`.                                                                                    |
| `EntryQuery`              | `Omit<D.EntryQuery, "conversationId">`. The parent supplies conversation scope.                           |
| `TaskQuery`               | `D.TaskQuery`.                                                                                            |
| `Agent`                   | Readable `D.Agent` fields: `model`, `thinkingLevel`, `cwd`, `instructions`.                               |
| `AgentChange`             | Writable `D.AgentChange` fields: `model`, `thinkingLevel`, `cwd`.                                         |
| `ModelRefInput`           | `D.ModelRef` as an input object.                                                                          |
| `ModelRef`                | `D.ModelRef` as an output object. GraphQL input and output types cannot share a definition.               |
| `SubmissionDraft`         | One-of wrapper for `D.SubmissionDraft`. Selection supplies `type`.                                        |
| `InputSubmissionDraft`    | `Omit<D.InputSubmissionDraft, "type">`. Selection supplies the discriminator. Conversion unwraps content. |
| `WriteSubmissionDraft`    | Adapter name for the write branch of `D.SubmissionDraft`, without its discriminator or forbidden fields.  |
| `InputEntry`              | `D.InputEntry`. Application kind and arbitrary JSON data.                                                 |
| `EntryDraft`              | `D.EntryDraft`, with typed message and context-edit inputs.                                               |
| `ContextEditInput`        | One-of wrapper for `D.ContextEdit`. Selection supplies `action`.                                          |
| `ContextReplacementInput` | Adapter object for the replace branch's target and messages.                                              |
| `UserInput`               | One-of wrapper for `D.UserInput`, which is `AI.UserMessage["content"]`.                                   |
| `UserInputBlock`          | One-of wrapper for an element of the array branch of `D.UserInput`.                                       |
| `TextContentInput`        | `Omit<AI.TextContent, "type">`. Conversion supplies `type: "text"`.                                       |
| `ImageContentInput`       | `Omit<AI.ImageContent, "type">`. Conversion supplies `type: "image"`.                                     |
| `SubmitInput`             | Adapter addressing envelope around `D.SubmissionDraft`.                                                   |
| `SubmitPayload`           | Adapter reference to the admitted `D.Submission.id`.                                                      |
| `AbortSubmissionInput`    | Adapter addressing envelope for `D.Harness.abortSubmission()`.                                            |
| `AbortSubmissionPayload`  | Adapter envelope around the return value of `D.Harness.abortSubmission()`.                                |
| `AbortInput`              | Adapter addressing envelope for `D.Conversation.abort()`.                                                 |
| `ResumeInput`             | Adapter addressing envelope for `D.Harness.resume()`.                                                     |
| `ResetInput`              | Adapter addressing envelope around `D.Conversation.reset()`'s handoff.                                    |
| `CompactInput`            | Adapter addressing envelope around `D.Conversation.compact()`'s instructions.                             |
| `CompactPayload`          | Adapter reference to the task ID returned by `D.Conversation.compact()`.                                  |
| `ConfigureInput`          | Adapter addressing envelope around the exposed `D.AgentChange` fields.                                    |

Lifecycle input and result mappings:

| Schema name                                            | Upstream name or adapter role                                               |
| ------------------------------------------------------ | --------------------------------------------------------------------------- |
| `OpenInput`, `OpenPayload`                             | Deployment storage key and returned Harness reference.                      |
| `RootInput`, `RootPayload`                             | Adapter Harness addressing and returned conversation reference.             |
| `RootOptionsInput`                                     | Data-only projection of `D.Harness.root` options. `init` stays server-side. |
| `CreateConversationInput`, `CreateConversationPayload` | Adapter Harness addressing and returned conversation reference.             |
| `ConversationCreateOptionsInput`                       | `D.ConversationCreateOptions` without the server-side `init` callback.      |
| `ConversationOwnershipInput`                           | `D.ConversationOwnership`, with discriminator/payload validation.           |
| `ConversationOwnershipKind`                            | `D.ConversationOwnership["kind"]`.                                          |

### Model catalog types

| Schema name     | Upstream name or adapter role                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------------------- |
| `Model`         | Public metadata projection of `AI.Model<AI.Api>`, plus supported thinking levels. Not a Node or selected default. |
| `ModelCost`     | `AI.ModelCost`, with optional pricing tiers. Not message `UsageCost`.                                             |
| `ModelCostTier` | `AI.ModelCostTier`.                                                                                               |

### Messages, content, and diagnostics

These types come from Pi AI. Durable stores and returns Pi AI messages. Output
unions and one-of inputs keep their variants. Wrappers keep the distinction
between strings and arrays without opaque message scalars.

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
| `UserContent`          | `AI.ToolResultMessage["content"][number]`. Also the elements of user content arrays. |
| `AssistantContent`     | `AI.AssistantMessage["content"][number]`.                                            |
| `TextContent`          | `AI.TextContent`.                                                                    |
| `ImageContent`         | `AI.ImageContent`.                                                                   |
| `ThinkingContent`      | `AI.ThinkingContent`.                                                                |
| `ToolCall`             | `AI.ToolCall`.                                                                       |
| `Tool`                 | `AI.Tool`. Model-facing declaration, not Durable's executable `ToolRegistration`.    |
| `ToolReference`        | `AI.ToolReference`.                                                                  |
| `Usage`                | `AI.Usage`.                                                                          |
| `UsageCost`            | `AI.Usage["cost"]`.                                                                  |
| `DeferredHandle`       | `AI.DeferredHandle`. Provider request recovery data, not a Durable task handle.      |
| `MessageDiagnostic`    | `AI.AssistantMessageDiagnostic`.                                                     |
| `DiagnosticError`      | `AI.DiagnosticErrorInfo`.                                                            |
| `NestedToolCalls`      | `AI.NestedToolCalls`.                                                                |
| `NestedToolCallRecord` | `AI.NestedToolCallRecord`.                                                           |

Input objects map to the same upstream contracts. Nested content and metadata
use the corresponding input types. Conversion supplies omitted discriminators.

| Schema name                 | Upstream name or adapter role                                                 |
| --------------------------- | ----------------------------------------------------------------------------- |
| `MessageInput`              | One-of wrapper for `AI.Message`. Selection supplies `role`.                   |
| `SystemMessageInput`        | `Omit<AI.SystemMessage, "role">`.                                             |
| `UserMessageInput`          | `Omit<AI.UserMessage, "role">`. Content uses `UserInput`.                     |
| `AssistantMessageInput`     | `Omit<AI.AssistantMessage, "role">`.                                          |
| `ToolResultMessageInput`    | `Omit<AI.ToolResultMessage, "role">`. Content uses `UserInputBlock` elements. |
| `SystemMessageContentInput` | One-of wrapper for `AI.SystemMessage["content"]`.                             |
| `AssistantContentInput`     | One-of wrapper for `AI.AssistantMessage["content"][number]`.                  |
| `ThinkingContentInput`      | `Omit<AI.ThinkingContent, "type">`.                                           |
| `ToolCallInput`             | `Omit<AI.ToolCall, "type">`.                                                  |
| `ToolInput`                 | `AI.Tool`. Parameters and constrained sampling remain JSON.                   |
| `ToolReferenceInput`        | `AI.ToolReference`.                                                           |
| `UsageInput`                | `AI.Usage`.                                                                   |
| `UsageCostInput`            | `AI.Usage["cost"]`.                                                           |
| `DeferredHandleInput`       | `AI.DeferredHandle`.                                                          |
| `MessageDiagnosticInput`    | `AI.AssistantMessageDiagnostic`.                                              |
| `DiagnosticErrorInput`      | `AI.DiagnosticErrorInfo`.                                                     |
| `NestedToolCallsInput`      | `AI.NestedToolCalls`.                                                         |
| `NestedToolCallRecordInput` | `AI.NestedToolCallRecord`.                                                    |

### Enums

Enum values keep upstream discriminant spellings. Several enums name an upstream
inline literal union rather than a separately exported type.

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
| `ModelInputModality`           | `AI.ModelInputModality`.                                                                                  |
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
| `TaskId`           | `D.TaskId`. Transport erases result-type branding.                                                                                                                                   |
| `SubmissionId`     | `D.SubmissionId`.                                                                                                                                                                    |
| `Cursor`           | `D.Cursor`, represented directly as JSON, not the REST base64url string.                                                                                                             |
| `JsonObject`       | `D.JsonObject` and `AI.JsonObject`.                                                                                                                                                  |
| `JsonValue`        | `Chord.JsonValue` and `AI.JsonValue`.                                                                                                                                                |
| `TelemetryCarrier` | `Telemetry.TelemetryCarrier`.                                                                                                                                                        |
| `ID`               | GraphQL built-in used for adapter global identities, not native Durable IDs.                                                                                                         |
| `Int`              | GraphQL built-in used for page limits. Upstream accepts a `number`.                                                                                                                  |
| `Float`            | GraphQL built-in used for upstream numeric fields, such as timestamps and usage.                                                                                                     |
| `String`           | GraphQL built-in used for upstream strings and adapter external storage keys.                                                                                                        |
| `Boolean`          | GraphQL built-in used for upstream booleans and successful void acknowledgments.                                                                                                     |
| `@oneOf`           | GraphQL input-variant constraint generated by Grats for the submission, message, content, and context-edit input unions.                                                             |
| `__typename`       | GraphQL runtime type name, not upstream `role`, `type`, `kind`, or `status`. Output discriminants remain separate fields. Input selections supply discriminators where mapped below. |

Other standard GraphQL introspection names and directives have no Durable
counterpart. Their definitions belong to
[GraphQL.js](../node_modules/graphql/type/introspection.js), not this adapter.

### Field and argument conversions

Fields and arguments keep upstream names unless this table or the procedure
table specifies a conversion. Flattened output objects keep variant-dependent
fields. One-of inputs select one upstream variant. Enum values keep their names.

| GraphQL name/path                                           | Upstream mapping                                                                                                                                     |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Node.id`, also for record `id` fields                      | Adapter global identity with session scope, kind, and native ID. Harness has no native record ID.                                                    |
| Record `durableId`                                          | The corresponding upstream record's `id`. Applies to ConversationRecord, EntryRecord, TaskRecord, and SubmissionRecord.                              |
| Record `harness`                                            | Adapter relationship to the owning persisted session.                                                                                                |
| `Harness.externalId`, `Query.harness(externalId)`           | Deployment's external session key, not a Durable record field.                                                                                       |
| `Query.node(id)`                                            | Adapter global identity for a native read.                                                                                                           |
| `*Connection.nodes`                                         | `D.Page.items`, after record projection.                                                                                                             |
| `*Connection.pageInfo.next`                                 | `D.Page.next`. The `pageInfo` container is adapter-only.                                                                                             |
| Mutation `input`                                            | Adapter envelope. Native procedures receive the selected arguments, not this envelope.                                                               |
| Mutation input `conversationId`                             | Global ConversationRecord identity used to resolve the native conversation. Other `ConversationId`-typed fields/arguments remain native numeric IDs. |
| Mutation input `harnessId`                                  | Global Harness identity, never the external key in `Harness.externalId`. Used by root, createConversation, and resume.                               |
| `Model.id`                                                  | Native Pi AI model ID, paired with `provider`. Becomes `modelId` in `ModelRefInput`, not a global Node ID.                                           |
| `Model.thinkingLevels`                                      | `getSupportedThinkingLevels(model)`, with the `ModelThinkingLevel` enum.                                                                             |
| `SubmitInput.submission`                                    | The draft argument of `D.Conversation.submit()`.                                                                                                     |
| `SubmissionDraft.input`, `SubmissionDraft.write`            | Selected native draft. Conversion supplies the corresponding `type` discriminator.                                                                   |
| `MessageInput.system`, `.user`, `.assistant`, `.toolResult` | Selected native message. Conversion supplies the corresponding `role` discriminator.                                                                 |
| `AssistantContentInput.text`, `.thinking`, `.toolCall`      | Selected native content block. Conversion supplies the corresponding `type` discriminator.                                                           |
| `SystemMessageContentInput.text`, `.blocks`                 | Native string or text-block array. Block conversion supplies `type: "text"`.                                                                         |
| `ContextEditInput.omit`                                     | Native `target` with `action: "omit"`. No messages.                                                                                                  |
| `ContextEditInput.replace`                                  | Native target and replacement messages with `action: "replace"`.                                                                                     |
| `SubmitPayload.submissionId`                                | `D.Submission.id`, converted to a global SubmissionRecord identity.                                                                                  |
| `CompactPayload.taskId`                                     | Native result of `D.Conversation.compact()`, converted to a global TaskRecord identity.                                                              |
| `AbortSubmissionPayload.result`                             | Native result of `D.Harness.abortSubmission()`.                                                                                                      |
| `UserInput.text`                                            | Native string content.                                                                                                                               |
| `UserInput.blocks`                                          | Native ordered content array, after block unwrapping.                                                                                                |
| `UserInputBlock.text`, `UserInputBlock.image`               | Native text/image block. Conversion supplies the corresponding `type` discriminator.                                                                 |
| `StringContent.text`                                        | Native string content, unchanged.                                                                                                                    |
| `TextContentList.blocks`, `UserContentList.blocks`          | Native content arrays, with typed block projections.                                                                                                 |

`ContextView`, `EntryRecord.model`, and replacement `ContextEdit.messages` keep
their field names. Each native message receives the typed output projection.
JSON maps and application payloads remain JSON. Examples include
`EntryRecord.data`, `ToolCall.arguments`, `Tool.parameters`, and
`ToolResultMessage.details`. The shared `JsonValue` scalar does not make these
fields interchangeable.

## Harness identity, discovery, and creation

`externalId` is the deployment-owned key of one persisted Harness store. It is
not a Durable record ID or filesystem path. Clients can select a new key for a
new store. Deployment validates and authorizes the key in its storage namespace.
It does not insert unchecked input into a path.

The key identifies that store until deployment deletes the store. Only then can
deployment reuse the key for another store. Reopen keeps the global identity.
Open does not replace storage or restore an archived store.

`Harness.id` is the opaque global GraphQL ID. `root`, `createConversation`, and
`resume` accept `harnessId: ID!`, not an external key. They validate the decoded
object kind and authorized scope. Native record IDs are numeric and scoped to
their Harness.

### Lifecycle schema

These declarations compose with the other Durable schema types. Existing fields
with the same names take the signatures below.

```graphql
extend type Query {
  harness(externalId: String!): Harness
  harnesses: [Harness!]!
}

extend type Harness {
  externalId: String!
  root: ConversationRecord
}

extend type Mutation {
  open(input: OpenInput!): OpenPayload
  root(input: RootInput!): RootPayload
  createConversation(input: CreateConversationInput!): CreateConversationPayload
}

input OpenInput {
  externalId: String!
}

type OpenPayload {
  harness: Harness!
}

input RootInput {
  harnessId: ID!
  options: RootOptionsInput
}

input RootOptionsInput {
  agent: AgentChange
}

type RootPayload {
  conversation: ConversationRecord!
}

input CreateConversationInput {
  harnessId: ID!
  options: ConversationCreateOptionsInput!
}

input ConversationCreateOptionsInput {
  ownership: ConversationOwnershipInput!
  agent: AgentChange
}

input ConversationOwnershipInput {
  kind: ConversationOwnershipKind!
  taskId: TaskId
}

enum ConversationOwnershipKind {
  ownerless
  task
}

type CreateConversationPayload {
  conversation: ConversationRecord!
}
```

### Discovery and passive root lookup

`Query.harnesses` lists the authorized persisted catalog in ascending
`externalId` order, not the cache of open Harnesses. An empty catalog returns an
empty list. An identity-only selection does not acquire a Harness:

```graphql
query KnownHarnesses {
  harnesses {
    externalId
    id
  }
}
```

`Query.harness(externalId)` returns an existing store or null. It never creates
missing storage. Other selected fields can acquire the shared owner, but reads
do not enable scheduling.

`Harness.root` reads `Tx.conversation(ROOT_CONVERSATION_ID)` and returns null if
the root is absent. It never calls the creating `Harness.root()` method. The
root uses Durable's reserved identity, not the first scan result or application
metadata. A session link opens this conversation when it exists.

### Open

`Mutation.open` asks deployment to find or create storage for the authorized
external ID and acquire its shared Harness owner. The factory calls
`Harness.open(storage, options, context)` only if no owner exists. Storage,
registry, model access, environment factory, runtime settings, hooks, and
execution context remain server-side. Clients cannot supply a `HarnessOptions`
map or override runtime policy for an open.

Concurrent opens for one authorized key share one owner across GraphQL and SSE.
Successful creation adds a stable identity to the persisted catalog that
`Query.harnesses` uses. The identity survives process restart. Open returns an
already-open Harness without changes to its configuration. Open does not call
`resume`, create a root, or submit input. An empty store is a valid persisted
session.

Repeated `open` calls with the same external ID acquire the same store without a
reset. Deployment supplies this guarantee, not Durable submission deduplication.
After an interrupted open, storage creation and catalog publication recover the
same identity without replacement storage. Factory failures release partially
acquired resources, but do not guarantee rollback.

Invalid external IDs return `BAD_REQUEST`. Inaccessible or archived identities
return `NOT_FOUND`, not absence. Other failures use the
[error mapping](#validation-and-errors).

### Root and additional conversations

`Mutation.root` finds the existing Harness by global ID and calls
`harness.root(context, options)`. Omitted options mean no agent changes. For an
absent root, creation and supplied agent changes commit atomically. For an
existing root, the method returns it without changes, even if the supplied
options differ. `configure` changes an existing root.

`Mutation.createConversation` calls
`harness.createConversation(options, context)` on the addressed Harness. For
`ownerless`, `taskId` must be absent. For `task`, `taskId` must be a non-null
native task ID in that Harness. The adapter validates this pairing before it
calls Durable. Other optional inputs can be absent but not null, except
null-clearing fields in `AgentChange`. Neither creation operation submits input,
enables scheduling, creates a fork, or starts a review workflow.

The native `init(tx, conversationId)` callback and creation hooks remain
server-side. The API exposes no executable callbacks, arbitrary transactions, or
document-initialization language. Application document changes use separate
mutations outside the conversation-creation commit.

Each successful `createConversation` creates another conversation. An uncertain
response is not permission for automatic retry. Catalog absence does not prove
that creation failed. Repeated `root` calls cannot create another root, but
initial options apply only at creation. Clients read the root again before
further edits.

### Composition and archival boundary

```text
open(externalId)
  -> Harness.id
  -> root(harnessId, options)
  -> ConversationRecord.id
  -> document writes, when needed
  -> submit(conversationId, submission)
```

These commands execute separately. Each output can supply inputs to later
requests, without nested mutation execution or a remote transaction. Failure can
leave an empty store or a conversation without a submission. Recovery uses the
original external ID, returned identities, and submission request ID.
Attachments belong to the submission draft, not `open` or `root`. Repeated
GraphQL operations are not a general recovery protocol.

The API has no archival operation. Close releases the Harness owner but does not
archive storage or establish terminal task outcomes. Any application archival
operation must coordinate with the shared owner, prevent reacquisition, and
update the persisted catalog. It must not move live SQLite files or use `open`
to archive a store.

Sources: [current catalog resolver](graphql.ts),
[storage and root initialization](../../../app/serve/sessions.ts),
[Harness factory](../../harness/src/index.ts), pinned
[Harness creation implementation](/nix/store/57n99acvmwvfw5qjn7ryqzh8gxg5gcj9-app-node-modules-0.1.0/node_modules/@earendil-works/pi-durable/dist/harness/harness.js),
[creation options](/nix/store/57n99acvmwvfw5qjn7ryqzh8gxg5gcj9-app-node-modules-0.1.0/node_modules/@earendil-works/pi-durable/dist/harness/types.d.ts),
and
[Session close contract](/nix/store/57n99acvmwvfw5qjn7ryqzh8gxg5gcj9-app-node-modules-0.1.0/node_modules/@earendil-works/pi-durable/dist/types.d.ts).

## Mutation results

Mutation inputs and results have no adapter-only correlation echo. Results keep
`SubmitPayload.submissionId`, `CompactPayload.taskId`, and
`AbortSubmissionPayload.result`. Application saves return typed settings and a
revision. Submission `requestId` remains the native admission/recovery key, not
an external ID.

Methods with upstream void results use nullable Boolean acknowledgments instead
of empty payload objects:

```graphql
extend type Mutation {
  abort(input: AbortInput!): Boolean
  resume(input: ResumeInput!): Boolean
  reset(input: ResetInput!): Boolean
}

input ResumeInput {
  harnessId: ID!
}
```

`configure` has the same Boolean result, as specified in
[conversation configuration](#durable-conversation-configuration). Void methods
return `true` only after successful upstream return. Failures produce a GraphQL
field error and null, never false. The acknowledgment confirms the method
return, not completion of later agent work. `resume` enables scheduling. `reset`
acknowledges admission, not completion or placement.

There are no void-result payload types. Other mutation inputs keep their
operation-specific fields without a correlation echo.

## Application data and input content

Application data uses entries, not another `UserInput` variant. An input
submission can supply `entry: { kind, data }` with any strict JSON value in
`data`. The kind must be nonempty and outside `pi.`. Durable places the input as
that entry kind instead of `pi.user`:

```text
InputSubmissionDraft.content     -> EntryRecord.model[0].content
InputSubmissionDraft.entry.kind  -> EntryRecord.kind
InputSubmissionDraft.entry.data  -> EntryRecord.data
```

The generated model message remains a user message. The adapter does not treat
`data` as model input, decode it as an attachment, or resolve it as a file. The
application interprets any attachment descriptors in `data`. GraphQL exposes
this input through `SubmitInput.submission.input.entry` and reads it through
`EntryRecord.data`. `SubmissionRecord.entry` is the placed entry's native ID,
not its data payload. This adds no arbitrary properties to ConversationRecord or
SubmissionRecord.

`SubmitInput.submission.write.entry` maps to upstream `EntryDraft`. It appends
an entry without a request for an agent response. A kind/data-only write is
display-only and normally lands immediately, even while busy. It queues behind a
pending reset. Writes with model/head/edits follow upstream boundary and
stale-head rules, even for empty arrays. The input branch's kind restrictions do
not apply to writes.

The two branches forward `requestId`. The same key and native type recover the
prior submission without a payload comparison. Key reuse across types uses the
upstream untyped-error fallback. Admission does not imply placement or
completion.

These are transcript entries, not Durable Docs. Sources:
[`InputEntry` and `SubmissionDraft`](../node_modules/@earendil-works/pi-durable/dist/harness/types.d.ts),
[`EntryRecord`, `EntryDraft`, and `Tx.appendEntry`](../node_modules/@earendil-works/pi-durable/dist/types.d.ts),
[input placement and strict-JSON copying](../node_modules/@earendil-works/pi-durable/dist/harness/inbox.js),
[submission admission](../node_modules/@earendil-works/pi-durable/dist/harness/submissions.js),
and
[model-context construction](../node_modules/@earendil-works/pi-durable/dist/harness/context.js).

## Durable documents

### Document schema

A document is Durable's persisted JSON-object state, accessed through a
registered token. It is not a transcript entry or filesystem document. Durable
exports `defineDoc()` for singletons and `defineDocFamily()` for keyed families.
A family key identifies one member under a shared definition and owner scope.
`DocumentAddressInput` matches `DocumentAddress`: `kind`, `scope`, and optional
`key`. Scope IDs remain native numeric IDs in the addressed Harness.

```graphql
enum DocumentScopeKind {
  session
  conversation
  task
}

enum DocumentHistory {
  latest
  rewindable
}

enum DocumentFork {
  asOf
  current
  initial
}

input DocumentScopeInput {
  kind: DocumentScopeKind!
  conversationId: ConversationId
  taskId: TaskId
}

input DocumentAddressInput {
  kind: String!
  scope: DocumentScopeInput!
  key: String
}

type DocumentDefinition {
  kind: String!
  version: Int!
  scope: DocumentScopeKind!
  family: Boolean
  history: DocumentHistory
  fork: DocumentFork
}

extend type Harness {
  documentDefinitions(scope: DocumentScopeInput!): [DocumentDefinition!]
  snapshot(address: DocumentAddressInput!): JsonObject
}

input ReplaceDocumentInput {
  harnessId: ID!
  address: DocumentAddressInput!
  content: JsonObject!
}

extend type Mutation {
  replaceDocument(input: ReplaceDocumentInput!): JsonObject
}
```

`DocumentDefinition` projects data from an exposed registered singleton or
family definition. Callbacks remain server-side. `family` is true for a family
and null for a singleton, as in upstream's optional `true` marker. Only
conversation scope supplies `history` and `fork`. The version is the
definition's positive schema version, not a content revision.

Definition discovery returns authorized definitions for the exact owner in
`kind` order, even for absent documents. It does not list stored documents or
family keys. An accessible owner with no exposed definitions returns an empty
list. Deployment enforces write and initialization permissions on each
operation. These permissions are not Durable definition fields.

Session scope accepts neither owner ID. Conversation scope must have only
`conversationId`. Task scope must have only `taskId`. A singleton must not have
`key`, and a family must have it. Optional inputs can be absent but not null.

The adapter validates the scope/discriminator pairing before it calls Durable.
Native owner IDs must belong to the addressed, authorized Harness.

`Harness.snapshot` calls `Session.snapshot()` and returns content or null,
without a document envelope. Lookup fields return null for missing or
inaccessible owners and unexposed definitions. An absent document returns null,
but an empty object remains `{}`. Invalid addresses return `BAD_REQUEST`.
Storage failures return errors, not absence.

`replaceDocument` is an adapter operation, not an upstream method. It replaces
the draft from `Tx.doc()` with validated content in one server-side commit.
Missing or inaccessible owners and unexposed definitions return `NOT_FOUND`.
Read-only definitions, invalid content, and forbidden initialization return
`BAD_REQUEST`. Deployment controls initialization of absent documents and
supplies any family seed. The result contains the committed replacement, not a
later writer's snapshot.

### Execution and permissions

Document queries and mutations are separate from transcript entries and
lifecycle operations. They do not start or end reviews, validate directories,
select environments, or create conversations. Commands such as `configure` keep
their Durable behavior and [mutation results](#mutation-results).

A document address uses its Harness, registered definition, native owner scope,
and family key when applicable. It does not select an application configuration
layer. Deployment supplies exposed definitions and read/write permissions.
Clients cannot register definitions or select storage paths. The adapter
validates ownership and permissions for each address, also for task-owned
documents. JSON fields must not expose credentials or internal execution state.

Reads use the owning Harness's non-creating `snapshot()` interface. Queries do
not use `Tx.doc()`, create initial content, or enable scheduling. Documents
without retained history do not support historical reads.

A content mutation replaces one document with a validated strict JSON object. It
uses the registered token and `Tx.doc()` in one `Harness.commit()`. Omitted
properties disappear. Explicit JSON null remains a value where the document
contract accepts it, not a deletion instruction. The adapter validates the full
replacement before it changes the draft.

Permitted initialization follows the registered definition without creation of
an absent parent conversation or task. Document registration and execution
callbacks remain server-side.

Write permission is explicit, not a consequence of registration or read
permission. Validation checks document-specific invariants. Runtime-owned inbox,
live, and provider state are not user configuration. Generic `pi.agent` access
is read-only. Its settings use `configure` for writes.

One mutation's commit is atomic, but multiple GraphQL mutation fields are not a
transaction. Document replacement supplies no compare-and-swap, automatic merge,
or deduplication guarantee.

Reads and mutations borrow the same Harness as SSE. Completion acknowledges the
document commit, not later execution that uses the state. Document mutations do
not create conversations, validate directories, transfer reports, or establish
remote connections. Registered hooks and document history/fork semantics still
apply. A disconnected response is not permission for automatic replay.

Only the existing mounted documents appear in SSE. Clients query other documents
after a mutation or on explicit refresh. Document access adds no watch route,
SSE mount, or synchronization protocol.

Sources: pinned Durable 1.4.0
[defineDoc and defineDocFamily](/nix/store/57n99acvmwvfw5qjn7ryqzh8gxg5gcj9-app-node-modules-0.1.0/node_modules/@earendil-works/pi-durable/dist/documents.d.ts),
[document tokens, Session.snapshot, and Tx.doc](/nix/store/57n99acvmwvfw5qjn7ryqzh8gxg5gcj9-app-node-modules-0.1.0/node_modules/@earendil-works/pi-durable/dist/types.d.ts),
[agent document semantics](/nix/store/57n99acvmwvfw5qjn7ryqzh8gxg5gcj9-app-node-modules-0.1.0/node_modules/@earendil-works/pi-durable/dist/harness/agent.js),
and the [existing SSE adapter](../src/stream.ts).

## Application services

The application API supplies instance inventory, configuration, linked OAuth2
accounts, and push-subscription management. These services remain outside the
Durable adapter and its `ResolverContext`. They can share a GraphQL endpoint
without changes to Durable's factory, storage, or operation contracts. The
frontend requirements are in [[packages/www/SPEC.md]].

### Application identities and connections

`Instance`, `AuthorizationServer`, `Authorization`, and `Account` implement
`Node`. Their opaque global IDs identify resources in the authorized
deployment/service namespace, not Durable records. Identity remains stable for
the resource's lifetime and across restart for retained resources. Application
composition extends `Query.node(id)` dispatch without changes to Durable's
`ResolverContext` or identity contract.

Lookups return null for missing or inaccessible resources. Commands validate
decoded kind and scope and return `NOT_FOUND` for unavailable targets. IDs are
not access credentials.

Application lists use `nodes`, `PageInfo.next`, positive `limit`, and opaque
JSON `Cursor` values. The owning services supply ordering and cursors without
Durable scans or Durable continuation state. Instances, servers, and accounts
use ascending service-owned identity order. Authorizations use creation time,
with service-owned identity as a tie-breaker.

The service validates cursor scope, filters, and ordering. It reads one page
without lookahead or silent truncation. Connections supply no snapshot isolation
across pages. Nullable connection fields can return errors without loss of
unrelated successful selections.

### Instance inventory

```graphql
extend type Query {
  instances(limit: Int!, cursor: Cursor): InstanceConnection
}

type InstanceConnection {
  nodes: [Instance!]!
  pageInfo: PageInfo!
}

type Instance implements Node {
  id: ID!
  unit: String!
  flakeReference: String
  state: InstanceState
  timings: InstanceTimings
}

type InstanceState {
  activeState: String!
  subState: String!
  result: String
}

type InstanceTimings {
  invocationId: String!
  activationUs: Float
  workerUs: Float
  bootWaitUs: Float
  provisionUs: Float
  managerGapsUs: Float
  hostPhases: [InstanceTimingPhase!]
  guestPhases: [InstanceTimingPhase!]
}

type InstanceTimingPhase {
  phase: String!
  clock: String!
  monotonicSeconds: Float!
  resolutionSeconds: Float!
}
```

Inventory is read-only. It combines retained inventory with known instance
units, so it includes stopped instances and units at startup. An instance
identifies a host service in its owner namespace, not a persisted Harness.
`harnesses` is not the instance catalog. An inventory read does not start or
connect to guests. There are no instance lifecycle mutations.

`state` returns observed `ActiveState`, `SubState`, and `Result` strings without
conversion to a closed enum. Unavailable metadata, state, or timings remain
null, without defaults. Failure to enumerate retained inventory or known units
produces a field error and null connection, not a partial membership list.
Clients keep prior rows marked stale.

`pageInfo.next` supplies pagination. Missing row observations do not invalidate
successful membership enumeration. Read failures for nullable row fields keep
GraphQL error paths and other usable fields.

Timings describe one service invocation, identified by `invocationId`. They do
not combine samples from different invocations. Duration fields map to
`activation_us`, `worker_us`, `boot_wait_us`, `provision_us`, and
`manager_gaps_us` in the benchmark's `timings()` calculation. These values are
Float microseconds, not signed 32-bit Int. Unavailable or unfinished durations
remain null. Invalid measurements and failed activations do not supply
successful startup durations.

Phase fields project host and guest JSONL fields: `phase`, `clock`,
`monotonic_s`, and `resolution_s`. They keep order, phase names, and seconds.
These records use `boottime` with 0.01-second resolution, not wall clock.
Calculations do not subtract host from guest timestamps or mix them with
systemd's monotonic clock.

A null phase list means unavailable. An empty list means that the source was
available but had no records. Aggregate durations do not supply phase data. A
historical timing store and timing persistence after runtime cleanup are not
necessary.

Sources: [host inventory](../../../../nixosModules/host/command.sh),
[host control](../../../../nixosModules/host/cli.sh),
[activation measurements](../../../bench/main.py),
[phase format and clock](../../../../nixosModules/timing.sh), and
[guest timing collection](../../../../nixosModules/host/post.sh).

### Application configuration

Configuration has independent owners:

| Configuration                                  | Authoritative storage                    |
| ---------------------------------------------- | ---------------------------------------- |
| Durable conversation settings, with `pi.agent` | Durable documents only                   |
| Harness runtime settings                       | `$XDG_CONFIG_HOME/harness/settings.json` |
| `www` presentation and delivery settings       | `$XDG_CONFIG_HOME/www/settings.json`     |

Configuration uses `$XDG_CONFIG_HOME` for the authorized application user. An
unset, empty, or relative value selects `$HOME/.config`. Each application has
one JSON file, without a `$XDG_CONFIG_DIRS` search or a merge of system, user,
and project files. Notification and OAuth2 configuration remain separate. No
specific settings library is necessary.

#### Settings schema

The application adds these target fields to the Durable schema. The generated
schema does not yet implement them. They are not Durable operations.

```graphql
extend type Query {
  settings(app: App!): Settings
}

enum App {
  web
  harness
}

union Settings = WebSettings | HarnessSettings

extend type Mutation {
  saveWwwSettings(input: SaveWwwSettingsInput!): SaveWwwSettingsPayload
  saveHarnessSettings(
    input: SaveHarnessSettingsInput!
  ): SaveHarnessSettingsPayload
}

enum WwwDeliveryMode {
  followUp
  steer
}

enum HarnessTransport {
  auto
  sse
  websocket
  websocketCached
}

enum HarnessQueueMode {
  oneAtATime
  all
}

type WebSettings {
  revision: String!
  wrapCode: Boolean!
  bottomAlign: Boolean!
  hideThinkingBlock: Boolean!
  showImages: Boolean!
  defaultDeliveryMode: WwwDeliveryMode!
}

input WwwSettingsInput {
  wrapCode: Boolean!
  bottomAlign: Boolean!
  hideThinkingBlock: Boolean!
  showImages: Boolean!
  defaultDeliveryMode: WwwDeliveryMode!
}

type HarnessSettings {
  revision: String!
  transport: HarnessTransport!
  steeringMode: HarnessQueueMode!
  followUpMode: HarnessQueueMode!
  retry: HarnessRetrySettings!
  compaction: HarnessCompactionSettings!
}

input HarnessSettingsInput {
  transport: HarnessTransport!
  steeringMode: HarnessQueueMode!
  followUpMode: HarnessQueueMode!
  retry: HarnessRetrySettingsInput!
  compaction: HarnessCompactionSettingsInput!
}

type HarnessRetrySettings {
  enabled: Boolean!
  maxRetries: Int!
  baseDelayMs: Int!
  maxAgentDelayMs: Int!
}

input HarnessRetrySettingsInput {
  enabled: Boolean!
  maxRetries: Int!
  baseDelayMs: Int!
  maxAgentDelayMs: Int!
}

type HarnessCompactionSettings {
  enabled: Boolean!
  reserveTokens: Int!
  keepRecentTokens: Int!
  backgroundTokens: Int!
}

input HarnessCompactionSettingsInput {
  enabled: Boolean!
  reserveTokens: Int!
  keepRecentTokens: Int!
  backgroundTokens: Int!
}

input SaveWwwSettingsInput {
  expectedRevision: String!
  settings: WwwSettingsInput!
}

type SaveWwwSettingsPayload {
  settings: WebSettings!
}

input SaveHarnessSettingsInput {
  expectedRevision: String!
  settings: HarnessSettingsInput!
}

type SaveHarnessSettingsPayload {
  settings: HarnessSettings!
}
```

`App.web` selects the `www` application and returns `WebSettings`. `App.harness`
returns `HarnessSettings`. The selector must be present and non-null. Fragments
select union fields, and `__typename` identifies the variant. Aliases let
clients read settings for the two applications in one operation:

```graphql
query ApplicationSettings {
  web: settings(app: web) {
    __typename
    ... on WebSettings {
      revision
      wrapCode
      defaultDeliveryMode
    }
  }
  harness: settings(app: harness) {
    __typename
    ... on HarnessSettings {
      revision
      transport
      retry {
        enabled
        maxRetries
      }
    }
  }
}
```

The authorized user determines file ownership. `app` selects only the
application. Clients cannot supply a path, user ID, arbitrary application name,
key/value list, or JSON settings scalar. Only the declared settings are
writable. Application files contain no model, thinking level, cwd, instructions,
or other conversation document values.

#### Fields and defaults

Each file contains its settings input fields, with GraphQL enum spellings as
JSON strings. It contains no `revision` or mutation metadata. An absent file or
omitted property uses the defaults below, also for nested properties. Unknown
fields, explicit nulls, wrong types, and out-of-range values make the file
invalid. A read never creates or rewrites a file.

| Field                                         | Default      | Meaning                                                                                       |
| --------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------- |
| `WebSettings.wrapCode`                        | `false`      | Wrap code blocks instead of horizontal scrolling.                                             |
| `WebSettings.bottomAlign`                     | `true`       | Bottom-align the transcript.                                                                  |
| `WebSettings.hideThinkingBlock`               | `false`      | Hide thinking content in the transcript.                                                      |
| `WebSettings.showImages`                      | `true`       | Display supported transcript images.                                                          |
| `WebSettings.defaultDeliveryMode`             | `followUp`   | Initial composer delivery choice. `steer` selects steering.                                   |
| `HarnessSettings.transport`                   | `auto`       | Model-provider transport, not browser SSE transport.                                          |
| `HarnessSettings.steeringMode`                | `oneAtATime` | Number of steering submissions placed at a boundary.                                          |
| `HarnessSettings.followUpMode`                | `oneAtATime` | Number of follow-up submissions placed at a boundary.                                         |
| `HarnessSettings.retry.enabled`               | `true`       | Enable Durable generation-attempt retries.                                                    |
| `HarnessSettings.retry.maxRetries`            | `3`          | Maximum retries after the initial attempt.                                                    |
| `HarnessSettings.retry.baseDelayMs`           | `2000`       | Base delay between attempts, in milliseconds.                                                 |
| `HarnessSettings.retry.maxAgentDelayMs`       | `60000`      | Upper bound on agent retry delay, in milliseconds.                                            |
| `HarnessSettings.compaction.enabled`          | `true`       | Enable automatic threshold/overflow compaction.                                               |
| `HarnessSettings.compaction.reserveTokens`    | `16384`      | Context capacity reserved for the answer.                                                     |
| `HarnessSettings.compaction.keepRecentTokens` | `20000`      | Approximate recent-context tokens retained by compaction.                                     |
| `HarnessSettings.compaction.backgroundTokens` | `32768`      | Background-compaction lead below the blocking threshold. Zero disables background compaction. |

Numeric settings are integers in `[0, 2147483647]`. A zero retry count disables
additional attempts. `HarnessQueueMode.oneAtATime` maps to `"one-at-a-time"`.
`HarnessTransport.websocketCached` maps to `"websocket-cached"`. Other queue and
transport values remain unchanged.

The transport field supplies `HarnessSettings.stream.transport`, not the
upstream provider-request retry settings. Retry and compaction objects map to
their upstream policy fields.

`settings(app: harness)` returns the configured runtime policy with resolved
defaults, not a per-Harness execution snapshot. A Harness uses current
configuration at open. Saves affect later opens, also for existing sessions, but
do not reconfigure open Harnesses. Factory constraints still apply without
changes to the configuration file, such as disabled background compaction for
codemode. Durable stores no per-session copy of runtime policy.

`settings(app: web)` returns presentation and delivery configuration. After a
successful save, the initiating page uses the returned settings. Other pages
read the changes on their next request. A saved delivery default does not alter
captured or admitted submissions.

The settings query acquires no Harness and uses no session for either
application. Neither save changes Durable documents or the SSE protocol.

#### Save protocol

The two mutations replace the full application configuration with typed
`settings` input. All input fields must be present and non-null, also in nested
objects. There is no implicit patch, null-as-delete, or key-based update. A
reset supplies the setting's default value without a search of another file.

`revision` is an opaque, nonempty content revision of the file, with a distinct
value for an absent file. It changes with file contents and remains stable
across reads and restarts for unchanged contents. It is not a Durable document
version or submission ID. Clients return it unchanged as `expectedRevision`.

API saves execute serially for each user's application file. Each save reads
current file contents and compares the revision before a write, not only a
cached revision. A mismatch returns a GraphQL error with
`extensions.code = "CONFIGURATION_CONFLICT"` and leaves the file unchanged. The
client reads the file again and explicitly reconciles its edits. This detects
stale API saves and external edits already visible to the read. It does not lock
concurrent writes from unrelated processes.

On a revision match, the service validates the full input and atomically
replaces the file. It returns the saved settings and new revision. No
transaction spans the two files. Nullable query fields and mutation payloads can
return errors with other successful selections. An absent file returns defaults,
not null.

Malformed or unreadable files and persistence failures return
`INTERNAL_SERVER_ERROR`, not defaults. GraphQL rejects unknown fields, missing
or null required inputs, invalid types, and values outside the signed 32-bit
`Int` range. Negative policy values return `BAD_REQUEST`. Error messages contain
no private paths or file contents.

A lost response leaves the save uncertain. The client reads the file again
before another explicit save. Equal values do not prove that a particular
request succeeded. Automatic replay is not necessary.

#### Durable conversation configuration

Conversation configuration keeps the typed Durable change contract:

```graphql
extend type Mutation {
  configure(input: ConfigureInput!): Boolean
}

input ConfigureInput {
  conversationId: ID!
  change: AgentChange!
}

input AgentChange {
  model: ModelRefInput
  thinkingLevel: ModelThinkingLevel
  cwd: String
}
```

`ModelRefInput` and `ModelThinkingLevel` are existing schema types.
`conversationId` is a global ConversationRecord ID. Omission leaves a stored
field unchanged, a value replaces it, and null removes it. For example,
`change: { cwd: "/work" }` keeps the stored model and thinking level.
`change: { cwd: null }` removes only cwd.

`configure` does not replace the whole document. `ConversationRecord.agent`
returns resolved values. The existing SSE mount reports stored `pi.agent`
changes.

The write affects only Durable, not application files or their defaults. Initial
values can populate conversation documents at creation. Those documents remain
authoritative on reopen, without a second copy in application configuration. The
settings UI uses `configure`, not generic document replacement.

Sources:
[XDG Base Directory Specification](https://specifications.freedesktop.org/basedir/0.8/),
[configuration resolver and existing types](graphql.ts),
[existing application settings](../../../app/serve/settings.ts),
[existing application defaults](../../../app/serve/server.ts),
[conversation initialization](../../../app/serve/sessions.ts),
[Harness factory](../../harness/src/index.ts), and pinned
[agent and policy defaults](/nix/store/57n99acvmwvfw5qjn7ryqzh8gxg5gcj9-app-node-modules-0.1.0/node_modules/@earendil-works/pi-durable/dist/harness/agent.js).

### Linked accounts

#### Authority and protocol mapping

Authorization-server metadata, requests, responses, and errors follow the OAuth
RFCs and the selected library's public API. Protocol error codes keep their
names. There is no provider enum. The current credential service uses Python and
Tornado. This specification selects no OAuth client library. The implementation
must use a pinned client library with validated public-type mappings to these
contracts.

Protocol fields keep RFC spellings. `AuthorizationRequest` projects an
authorization-code request, with an adapter-computed `url`.
`DeviceAuthorizationResponse` projects RFC 8628 section 3.2 without
`device_code`. `AuthorizationErrorResponse` keeps protocol error fields and
extension error codes as strings. `AuthorizationServer` projects public metadata
with deployment identity and application relationships.

`Authorization`, its status, and `Account` are application resources, not
OAuth-standardized objects. An account's `identifier` is provider metadata, not
a universal `subject` claim.

#### Authorization schema

```graphql
extend type Query {
  authorizationServers(
    limit: Int!
    cursor: Cursor
  ): AuthorizationServerConnection
  accounts(limit: Int!, cursor: Cursor): AccountConnection
}

type AuthorizationServerConnection {
  nodes: [AuthorizationServer!]!
  pageInfo: PageInfo!
}

type AccountConnection {
  nodes: [Account!]!
  pageInfo: PageInfo!
}

type AuthorizationConnection {
  nodes: [Authorization!]!
  pageInfo: PageInfo!
}

type AuthorizationServer implements Node {
  id: ID!
  label: String!
  authorization_endpoint: String
  token_endpoint: String
  device_authorization_endpoint: String
  revocation_endpoint: String
  grant_types_supported: [String!]
  accounts(limit: Int!, cursor: Cursor): AccountConnection
  authorizations(limit: Int!, cursor: Cursor): AuthorizationConnection
}

type Account implements Node {
  id: ID!
  server: AuthorizationServer!
  identifier: String
  displayName: String
  status: AccountStatus!
  scope: String
}

enum AccountStatus {
  usable
  temporarilyUnavailable
  reauthorizationRequired
}

type Authorization implements Node {
  id: ID!
  server: AuthorizationServer!
  status: AuthorizationStatus!
  createdAt: Float!
  account: Account
  request: AuthorizationRequest
  deviceAuthorizationResponse: DeviceAuthorizationResponse
  error: AuthorizationErrorResponse
}

enum AuthorizationStatus {
  pending
  completed
  cancelled
  failed
}

type AuthorizationRequest {
  url: String!
  response_type: String!
  client_id: String!
  redirect_uri: String!
  scope: String
  state: String!
  code_challenge: String!
  code_challenge_method: String!
}

type DeviceAuthorizationResponse {
  user_code: String!
  verification_uri: String!
  verification_uri_complete: String
  expires_in: Int!
  interval: Int
}

type AuthorizationErrorResponse {
  error: String!
  error_description: String
  error_uri: String
}

input AuthorizeInput {
  serverId: ID!
  accountId: ID
}

input DeviceAuthorizationInput {
  serverId: ID!
  accountId: ID
}

input CancelAuthorizationInput {
  authorizationId: ID!
}

input DisconnectInput {
  accountId: ID!
}

input RevokeInput {
  accountId: ID!
  token_type_hint: String
}

extend type Mutation {
  authorize(input: AuthorizeInput!): Authorization
  deviceAuthorization(input: DeviceAuthorizationInput!): Authorization
  cancelAuthorization(input: CancelAuthorizationInput!): Boolean
  disconnect(input: DisconnectInput!): Boolean
  revoke(input: RevokeInput!): Boolean
}
```

`grant_types_supported` keeps protocol strings, such as `authorization_code` and
`urn:ietf:params:oauth:grant-type:device_code`, without conversion to enums. A
null metadata field means unknown or unavailable metadata, not support. Commands
must have working client registration and grant support. Missing registration or
an unsupported operation returns `BAD_REQUEST`. Service failures return
`INTERNAL_SERVER_ERROR`, not empty catalogs or substitute account states. A
failed status read does not prove that credentials are absent or expired.

#### Enrollment and account ownership

`authorize` creates an authorization-code request from trusted server/client
configuration, server-generated correlation, and PKCE. The provider redirect and
callback complete the exchange. `deviceAuthorization` sends the device
authorization request and starts service-owned token polling. Each returns a
global Authorization identity. `node(id)` and the server's `authorizations`
connection support later reads and reconciliation.

An uncertain response is not permission for automatic retry. The service
controls retention. Connections list retained resources without a guarantee of
indefinite history or recovery of pending processing after restart.

```text
authorize(serverId) or deviceAuthorization(serverId)
  -> Authorization.id
  -> provider authorization + server-side token exchange
  -> validate credentials and provider account identity
  -> persist Account
  -> Authorization.account + accounts connection
```

Omission of `accountId` links an account. A supplied `accountId` reauthorizes an
existing account. Optional inputs can be absent but not null. Supplied IDs are
global IDs of the required kind, not server keys or provider account
identifiers. The account must belong to the selected server and initiating user.

The service validates the returned provider identity before it replaces
credentials. A different identity must not replace the addressed account. Failed
or canceled reauthorization keeps existing credentials. Known provider account
identities have one Account in the user's server scope, also after
reauthorization. Without provider identity metadata, the service supplies no
invented identifier or unsupported identity check. The schema accepts multiple
accounts per server.

There is no `createAccount` mutation. The service publishes an Account only
after successful authorization, credential validation, and persistence. It links
an existing provider account without creation of an account at the provider.
`Authorization.account` is null before initial enrollment succeeds and refers to
the existing target during reauthorization. Completion means that the service
persisted the account and validated credentials, not that the user visited the
provider URL. Account `scope` keeps the RFC space-delimited granted scope, or
null if unavailable.

The account service owns credential persistence, refresh, identity checks,
authorization tracking, cancellation, and disconnect. It is separate from login
to drv.run. Callbacks and authorization lookups use the initiating user's scope.
Authorization-code flows validate callback correlation and use PKCE.

Authorization-server destinations, client registrations, redirect URIs, and
requested permissions come from trusted service configuration. They are not
arbitrary browser-supplied URLs, secrets, or filesystem paths. Provider
configuration and adapters handle protocol differences without provider-specific
frontend pages.

#### Status, protocol errors, and credential removal

`Authorization.status` describes local processing, not RFC error codes.
`error.error` keeps `authorization_pending`, `slow_down`, `access_denied`,
`expired_token`, and other protocol codes. Backend token polling follows RFC
intervals, slow-down increments, timeout backoff, and expiry. GraphQL reads and
browser timers do not control token polling. Status reads do not start another
authorization.

Protocol failures are Authorization data. Invalid commands, access failures, and
service failures remain GraphQL field errors. `error_description` and
`error_uri` contain only safe public values, not internal causes or provider
messages with credentials.

`createdAt` is epoch milliseconds. `expires_in` is the original device-code
lifetime in seconds, measured from authorization creation. Later reads do not
reset that lifetime. `interval` is the original provider polling interval in
seconds. Backend polling uses the RFC default if this value is absent. It does
not prescribe a browser refresh interval.

OAuth request `state` is correlation, not Authorization status. After successful
initiation, only the relevant request or device-response field contains data.
Access tokens, refresh tokens, `device_code`, client secrets, and PKCE verifiers
remain server-side. The browser can read user codes and public challenges.

`cancelAuthorization` cancels local processing. It does not establish provider
revocation. `disconnect` removes local credential use and storage. `revoke`
performs RFC 7009 token revocation when supported, with credentials from
Account, not browser-supplied tokens. `token_type_hint` keeps `access_token` or
`refresh_token`. Omission lets the service select an applicable stored token.

A true result acknowledges successful revocation, also for an already-invalid
token as the RFC specifies. It does not prove revocation of all related tokens.
Revocation errors produce field errors with safe protocol codes, not success.
Local removal and provider revocation are separate operations. Neither operation
implies the other. Boolean acknowledgments return true after success, never
false for failures.

Sources: [existing authorization boundary](../../../app/serve/auth.ts),
[current provider protocol and enrollment](../../../mitm-proxy/auth.py),
[current credential-service dependencies](../../../mitm-proxy/default.nix),
[OAuth 2.0](https://www.rfc-editor.org/rfc/rfc6749),
[authorization-server metadata](https://www.rfc-editor.org/rfc/rfc8414),
[PKCE](https://www.rfc-editor.org/rfc/rfc7636),
[device authorization](https://www.rfc-editor.org/rfc/rfc8628), and
[token revocation](https://www.rfc-editor.org/rfc/rfc7009).

### Push subscriptions

```graphql
extend type Query {
  push: PushService
}

type PushService {
  applicationServerKey: String
  registered(endpoint: String!): Boolean
}

input PushSubscriptionKeysInput {
  p256dh: String!
  auth: String!
}

input RegisterPushSubscriptionInput {
  endpoint: String!
  keys: PushSubscriptionKeysInput!
}

input RemovePushSubscriptionInput {
  endpoint: String!
}

extend type Mutation {
  registerPushSubscription(input: RegisterPushSubscriptionInput!): Boolean
  removePushSubscription(input: RemovePushSubscriptionInput!): Boolean
}
```

`applicationServerKey` is the public VAPID key. Null means that configuration
disables delivery. A failed read returns a field error, not a successful null.
`registered` reads only the authorized user's registration for the browser
endpoint. It does not establish browser permission, current browser keys, or
delivery success.

Registration upserts the full endpoint subscription. Removal is idempotent and
remains available with delivery disabled. The two mutations return true only
after persistence succeeds. Failures return field errors, not false
acknowledgments. Subscription lists, returned encryption secrets, test-delivery
commands, and delivery history are not necessary.

Explicit registration reconciles the full browser subscription. A registration
lookup does not prove that stored keys match browser keys.

GraphQL exposes public push configuration and authorized subscription
registration and removal. The notification service owns subscription persistence
and server-side push credentials. Browser permission is not registration. The
API never returns private push keys. The service validates input and ownership
before it uses a subscription as a delivery destination.

Delivery is best effort and operates without an open browser or SSE connection.
Delivery failures do not fail agent execution. A durable queue, replay, and
restart recovery of pending notifications are not necessary. Missed or duplicate
notifications are possible. Notifications are not execution receipts.
Subscription persistence does not imply persistence of delivery work.

Sources: [existing notification service](../../../app/serve/notifications.ts)
and [push transport](../../../app/serve/push.ts).

## Model catalog

`Query.models` returns the service's available chat models without arguments. It
uses no session, acquires no Harness, and does not enable scheduling. The list
uses upstream order without pagination or adapter sorting. An empty catalog is a
successful empty list, not an availability error.

The public metadata projection follows
[[packages/durable/api/SPEC.md#`models()` — `GET /api/models`]].

`Model` is not a `Node`. It keeps native `provider`/`id` identity. The catalog's
`id` becomes `modelId` in `ModelRefInput`. The catalog supplies no selected or
default model or thinking level. Availability reflects upstream provider/auth
checks, not guaranteed generation success.

`ResolverContext.models` supplies `() => Models` through the public
`@earendil-works/pi-ai/models` interface. Deployment supplies this borrowed
source with the Harness factory's model configuration and enforces catalog
access policy. Tenant-specific catalogs use tenant-scoped contexts. Catalog
discovery never uses a Harness.

Each resolver invocation resolves the source and calls `getAvailable()` with
`ctx.context.abortSignal`. It does not cache acquisitions or results across
aliases or requests. It does not call `refresh()`, start provider login, or
generate model output. The upstream helper supplies supported thinking levels.
Failures follow the [error policy](#validation-and-errors). Cancellation and
failure never return a successful empty list.

The projection contains only fields on the public metadata allowlist. It
excludes model headers, credentials, base URLs, request transforms,
compatibility configuration, and provider/Models objects, also through JSON
scalars. Cost tiers and input modalities keep their types. The generated
[schema](schema.graphql) gives field contracts. The
[mapping tables](#schema-to-upstream-mapping) identify their upstream sources.

Sources: pinned Pi AI
[Models interface](../node_modules/@earendil-works/pi-ai/dist/models.d.ts),
[availability and thinking-level helpers](../node_modules/@earendil-works/pi-ai/dist/models.js),
[model types](../node_modules/@earendil-works/pi-ai/dist/types.d.ts), and
[cost and modality types](../node_modules/@earendil-works/pi-ai/dist/providers/model-schema.d.ts).

## Execution and observations

Reads do not enable scheduling. Each read-only transaction is short and uses
only its `tx` inside the callback. No `Harness.commit()` transaction spans
GraphQL execution. Nested Session calls can otherwise wait on the mutation line
that the transaction already holds.

A GraphQL operation is not a cross-Harness snapshot or transaction. GraphQL.js
can execute query fields concurrently and executes top-level mutation fields
serially. Serial execution does not make a mutation document atomic. A later
failure does not roll back earlier admissions. Resolvers keep upstream
admission, placement, completion, and recovery semantics without a wait for
agent work to finish.

Each resolver reads independently, without an operation-local snapshot cache.
Repeated identities can reflect different states while the Harness changes.
Transport projections do not modify Session-owned records.

Sources: upstream
[transaction contracts](../node_modules/@earendil-works/pi-durable/dist/types.d.ts)
and GraphQL.js [execution](../node_modules/graphql/execution/execute.js).

## Identity and pagination

Global IDs follow the
[Node identification pattern](https://graphql.org/learn/global-object-identification/).
Pagination does not use Relay.

The [Harness identity contract](#harness-identity-discovery-and-creation) gives
the lifetime of an external session key. Global ID encoding is an adapter
detail, not a client contract. Mutations validate decoded scope and object kind
before access to the target. An opaque ID is not an access credential.

Durable's `Cursor` is backend-owned continuation state. Each connection passes
the supplied limit and cursor to exactly one upstream page read. It projects
`items` to `nodes` and `next` to `pageInfo.next`, without rescans, lookahead, or
synthesized edge cursors. Cursor JSON remains unchanged through the round trip.
Harness and model catalog lists have no pagination. Pages have no snapshot
isolation guarantee.

Source: upstream
[page and scan contracts](../node_modules/@earendil-works/pi-durable/dist/types.d.ts).

## Validation and errors

Scalar and input contracts apply to variables and inline literals. The adapter
keeps payloads and the distinction between omission and explicit null. It does
not coerce invalid input or silently remove content.

Execution failures use GraphQL errors with these `extensions.code` values:

| Condition                                                                        | Code                    |
| -------------------------------------------------------------------------------- | ----------------------- |
| Adapter validation failure or `StorageRequestError` from a rejected storage read | `BAD_REQUEST`           |
| Missing mutation target                                                          | `NOT_FOUND`             |
| Typed `ConversationBusy`                                                         | `CONVERSATION_BUSY`     |
| Fatal `Storage.commit()` or `mintId()` failure, also for `StorageRequestError`   | `INTERNAL_SERVER_ERROR` |
| Typed `SessionFailed`                                                            | `SESSION_FAILED`        |
| Otherwise                                                                        | `INTERNAL_SERVER_ERROR` |

Missing lookup objects return null. Storage failures remain errors, not absence.
Persisted task failures and blocked inspection states are data, not GraphQL
execution failures.

Error classification uses the failure source, not only the exception type or
GraphQL operation type. A storage read inside a read-only `Harness.commit()`
remains a read, not a `Storage.commit()` call.

Upstream can propagate the original exception for the first fatal storage
failure. The adapter returns `INTERNAL_SERVER_ERROR`, also for
`StorageRequestError`. Subsequent calls throw `SessionFailed`, which maps to
`SESSION_FAILED`. Neither outcome proves that a mutation failed to commit.
Neither outcome is permission for automatic replay.

`ReadAfterWrite` and untyped exceptions use the internal-error fallback. Error
classification does not use message text. GraphQL error paths, null propagation,
and partial results remain unchanged. Messages contain no internal exception
messages, stacks, or causes. Diagnostics remain server-side without changes to
persisted failure data.

Request, execution, and HTTP transport errors remain distinct. HTTP statuses
follow the protocol. Execution errors do not all produce HTTP 500. GraphQL
execution results do not use REST problem documents.

Sources: [GraphQL error mapping](graphql.ts), upstream
[error types](../node_modules/@earendil-works/pi-durable/dist/errors.d.ts), the
[storage failure guard](../node_modules/@earendil-works/pi-durable/dist/session/session.js),
and [[packages/durable/api/SPEC.md#HTTP errors]].

## HTTP transport

The endpoint accepts standard JSON requests and negotiates GraphQL response
media types. Method and media-type checks precede execution. Mutations do not
execute over GET. The endpoint has no request-array batching, uploads,
WebSockets, or browser IDE.

Body limits apply to encoded streamed bytes, not only `Content-Length`, before
unbounded buffering. Oversized bodies return HTTP 413, not a malformed-body
error. The adapter rejects invalid UTF-8 and interrupted uploads. Responses
carry `Cache-Control: no-store`. Request parsing, operation selection,
validation, execution, and response negotiation follow GraphQL-over-HTTP
semantics. The [execution-error contract](#validation-and-errors) remains
unchanged.

## Ownership, recovery, and deployment

Concurrent GraphQL and SSE opens share one persisted Harness owner, also for
document operations. Open belongs to the service lifetime, not the first
request's lifetime. Lookups do not create absent persisted sessions. Factory
failures release partially acquired resources.

The service observes terminal instance state and controls when a failed instance
can reopen. Reopen uses persisted storage without mutation replay.
`SESSION_FAILED`, disconnected responses, and transport failures do not
establish whether admission committed. They are not permission for automatic
replay. The service sends `Retry-After` only with a known recovery time.

Observer disconnect does not call `Conversation.abort()` or cancel durable agent
execution. Cancellation of request-bound reads or waits does not cancel admitted
work.

An endpoint outside a trusted boundary has explicit policies for:

- Authentication and session access for all lookups, provisioning, global IDs,
  ownership targets, and cursor traversal.
- Request size, document/selection work, pagination, and concurrency limits.
  Body limits alone do not bound nested connection expansion. Excess work
  produces an error, not silent truncation or changed pagination.
- Stable session identity, failed-instance recovery, and shutdown bounds.

Shutdown stops request admission first. It settles or cancels request-bound work
under the selected policy. It then closes owned Harnesses before telemetry
shutdown. Telemetry ownership follows
[[packages/durable/api/SPEC.md#Telemetry]]. GraphQL-specific tracing is not
necessary.
