import { Type } from "@earendil-works/pi-ai";
import { ModelThinkingLevelSchema } from "@earendil-works/pi-ai/providers/model-schema";
import type { JsonValue } from "@earendil-works/chord";
import type { ConversationId, EntryId, TaskId } from "@earendil-works/pi-durable";

// Brands are erased on the wire; validation establishes the numeric representation, not existence.
export const EntryIdSchema = Type.Unsafe<EntryId>(Type.Integer());
export const ConversationIdSchema = Type.Unsafe<ConversationId>(Type.Integer());
export const TaskIdSchema = Type.Unsafe<TaskId>(Type.Integer());

// TypeBox truncates recursive static inference to any; retain the upstream recursive type.
export const JsonValueSchema = Type.Unsafe<JsonValue>(
  Type.Cyclic(
    {
      JsonValue: Type.Union([
        Type.Null(),
        Type.Boolean(),
        Type.Number(),
        Type.String(),
        Type.Array(Type.Ref("JsonValue")),
        Type.Record(Type.String(), Type.Ref("JsonValue")),
      ]),
    },
    "JsonValue",
  ),
);
export const JsonObjectSchema = Type.Record(Type.String(), JsonValueSchema);

export const TextContentSchema = Type.Object(
  {
    type: Type.Literal("text"),
    text: Type.String(),
    textSignature: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export const ImageContentSchema = Type.Object(
  {
    type: Type.Literal("image"),
    data: Type.String(),
    mimeType: Type.String(),
  },
  { additionalProperties: false },
);
export const ThinkingContentSchema = Type.Object({
  type: Type.Literal("thinking"),
  thinking: Type.String(),
  thinkingSignature: Type.Optional(Type.String()),
  redacted: Type.Optional(Type.Boolean()),
});
export const ToolCallSchema = Type.Object({
  type: Type.Literal("toolCall"),
  id: Type.String(),
  name: Type.String(),
  arguments: JsonObjectSchema,
  thoughtSignature: Type.Optional(Type.String()),
  namespace: Type.Optional(Type.String()),
  argumentsError: Type.Optional(Type.String()),
});
export const UserInputSchema = Type.Union([
  Type.String(),
  Type.Array(Type.Union([TextContentSchema, ImageContentSchema])),
]);

export const UsageSchema = Type.Object({
  input: Type.Number(),
  output: Type.Number(),
  cacheRead: Type.Number(),
  cacheWrite: Type.Number(),
  cacheWrite1h: Type.Optional(Type.Number()),
  reasoning: Type.Optional(Type.Number()),
  totalTokens: Type.Number(),
  cost: Type.Object({
    input: Type.Number(),
    output: Type.Number(),
    cacheRead: Type.Number(),
    cacheWrite: Type.Number(),
    total: Type.Number(),
  }),
});
export const StopReasonSchema = Type.Enum([
  "aborted",
  "deferred",
  "error",
  "length",
  "pending",
  "stop",
  "toolUse",
]);
export const DeferredHandleSchema = Type.Object({
  provider: Type.String(),
  modelId: Type.String(),
  api: Type.String(),
  id: Type.String(),
  expiresAt: Type.Optional(Type.Number()),
  pollAfterMs: Type.Optional(Type.Number()),
  data: Type.Optional(JsonValueSchema),
});
export const AssistantMessageDiagnosticSchema = Type.Object({
  type: Type.String(),
  timestamp: Type.Number(),
  error: Type.Optional(
    Type.Object({
      name: Type.Optional(Type.String()),
      message: Type.String(),
      stack: Type.Optional(Type.String()),
      code: Type.Optional(Type.Union([Type.String(), Type.Number()])),
    }),
  ),
  details: Type.Optional(JsonObjectSchema),
});
export const AssistantMessageSchema = Type.Object({
  role: Type.Literal("assistant"),
  content: Type.Array(Type.Union([TextContentSchema, ThinkingContentSchema, ToolCallSchema])),
  api: Type.String(),
  provider: Type.String(),
  model: Type.String(),
  responseModel: Type.Optional(Type.String()),
  responseId: Type.Optional(Type.String()),
  providerThinkingLevel: Type.Optional(Type.String()),
  thinkingLevel: Type.Optional(ModelThinkingLevelSchema),
  diagnostics: Type.Optional(Type.Array(AssistantMessageDiagnosticSchema)),
  usage: UsageSchema,
  stopReason: StopReasonSchema,
  deferred: Type.Optional(DeferredHandleSchema),
  errorMessage: Type.Optional(Type.String()),
  rawStopReason: Type.Optional(Type.String()),
  endTurn: Type.Optional(Type.Boolean()),
  timestamp: Type.Number(),
  durationMs: Type.Optional(Type.Number()),
});
export const SystemMessageSchema = Type.Object({
  role: Type.Literal("system"),
  content: Type.Union([Type.String(), Type.Array(TextContentSchema)]),
  sections: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]))),
  toolsAdded: Type.Optional(
    Type.Array(
      Type.Object({
        name: Type.String(),
        description: Type.String(),
        parameters: JsonObjectSchema,
        constrainedSampling: Type.Optional(
          Type.Union([
            Type.Literal(false),
            Type.Object({
              type: Type.Literal("json_schema"),
              strict: Type.Enum(["prefer", "require"]),
            }),
            Type.Object({
              type: Type.Literal("grammar"),
              variants: Type.Object({
                openai_lark: Type.Optional(Type.String()),
                openai_regex: Type.Optional(Type.String()),
              }),
            }),
          ]),
        ),
      }),
    ),
  ),
  toolsRemoved: Type.Optional(Type.Array(Type.Object({ name: Type.String() }))),
  timestamp: Type.Number(),
});
export const UserMessageSchema = Type.Object({
  role: Type.Literal("user"),
  content: UserInputSchema,
  timestamp: Type.Number(),
});
export const ToolResultMessageSchema = Type.Object({
  role: Type.Literal("toolResult"),
  toolCallId: Type.String(),
  toolName: Type.String(),
  content: Type.Array(Type.Union([TextContentSchema, ImageContentSchema])),
  details: Type.Optional(JsonValueSchema),
  usage: Type.Optional(UsageSchema),
  nestedCalls: Type.Optional(
    Type.Object({
      calls: Type.Array(
        Type.Object({
          id: Type.String(),
          name: Type.String(),
          arguments: Type.Optional(JsonObjectSchema),
          argumentsBytes: Type.Optional(Type.Number()),
          status: Type.Enum(["ok", "error", "unfinished"]),
          durationMs: Type.Optional(Type.Number()),
          error: Type.Optional(Type.String()),
        }),
      ),
      complete: Type.Boolean(),
    }),
  ),
  isError: Type.Boolean(),
  timestamp: Type.Number(),
  durationMs: Type.Optional(Type.Number()),
});
export const MessageSchema = Type.Union([
  SystemMessageSchema,
  UserMessageSchema,
  AssistantMessageSchema,
  ToolResultMessageSchema,
]);

export const ContextEditSchema = Type.Union([
  Type.Object(
    { target: EntryIdSchema, action: Type.Literal("omit") },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      target: EntryIdSchema,
      action: Type.Literal("replace"),
      messages: Type.ReadonlyObject(Type.Array(MessageSchema)),
    },
    { additionalProperties: false },
  ),
]);
export const EntryRecordSchema = Type.Object({
  id: EntryIdSchema,
  conversationId: ConversationIdSchema,
  kind: Type.String(),
  model: Type.Optional(Type.ReadonlyObject(Type.Array(MessageSchema))),
  data: Type.Optional(JsonValueSchema),
  head: Type.Optional(EntryIdSchema),
  edits: Type.Optional(Type.ReadonlyObject(Type.Array(ContextEditSchema))),
  byTaskId: Type.Optional(TaskIdSchema),
});
export const ScanOrderSchema = Type.Enum(["ascending", "descending"]);
export const EntryQuerySchema = Type.Object(
  {
    conversationId: ConversationIdSchema,
    minEntryId: Type.Optional(EntryIdSchema),
    maxEntryId: Type.Optional(EntryIdSchema),
    order: Type.Optional(ScanOrderSchema),
  },
  { additionalProperties: false },
);
// Cursors are backend-owned JSON, not a particular adapter's { after, order } representation.
export const CursorSchema = JsonObjectSchema;
export const EntryPageSchema = Type.Object({
  items: Type.ReadonlyObject(Type.Array(EntryRecordSchema)),
  next: Type.Optional(CursorSchema),
});
// Structured outputs omit undefined object properties, including ContextView.head.
export const ContextViewSchema = Type.Object({
  head: Type.Optional(EntryRecordSchema),
  entries: Type.ReadonlyObject(Type.Array(EntryRecordSchema)),
  contributions: Type.ReadonlyObject(Type.Array(Type.ReadonlyObject(Type.Array(MessageSchema)))),
  messages: Type.ReadonlyObject(Type.Array(MessageSchema)),
});
