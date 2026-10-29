import assert from "node:assert/strict";
import { test } from "node:test";
import { copyJson } from "@earendil-works/chord";
import {
  Type,
  type AssistantMessage,
  type Message,
  type Static,
  type UserMessage,
} from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type {
  ContextEdit,
  ContextView,
  Cursor,
  EntryId,
  EntryQuery,
  EntryRecord,
  Page,
  UserInput,
} from "@earendil-works/pi-durable";
import { Compile } from "typebox/compile";
import {
  AssistantMessageSchema,
  ContextEditSchema,
  ContextViewSchema,
  ConversationIdSchema,
  CursorSchema,
  EntryIdSchema,
  EntryPageSchema,
  EntryQuerySchema,
  EntryRecordSchema,
  JsonValueSchema,
  MessageSchema,
  TaskIdSchema,
  UserInputSchema,
} from "../durable.ext.ts";

await test("schema-inferred types are assignable to the upstream API types", () => {
  const compatible: [
    Static<typeof EntryIdSchema> extends EntryId ? true : false,
    Static<typeof UserInputSchema> extends UserInput ? true : false,
    Static<typeof AssistantMessageSchema> extends AssistantMessage ? true : false,
    Static<typeof MessageSchema> extends Message ? true : false,
    Static<typeof ContextEditSchema> extends ContextEdit ? true : false,
    Static<typeof EntryRecordSchema> extends EntryRecord ? true : false,
    Static<typeof EntryQuerySchema> extends EntryQuery ? true : false,
    Static<typeof CursorSchema> extends Cursor ? true : false,
    Static<typeof EntryPageSchema> extends Page<EntryRecord, Cursor> ? true : false,
    Static<typeof ContextViewSchema> extends Omit<ContextView, "head"> & {
      head?: EntryRecord;
    }
      ? true
      : false,
  ] = [true, true, true, true, true, true, true, true, true, true];
  assert(compatible.every(Boolean));
});

await test("IDs validate positive safe integers without conflating their brands", () => {
  for (const schema of [EntryIdSchema, ConversationIdSchema, TaskIdSchema]) {
    const validator = Compile(schema);
    assert(validator.Check(1));
    assert(validator.Check(Number.MAX_SAFE_INTEGER));
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, "1", null]) {
      assert.equal(validator.Check(value), false);
    }
  }
  const distinct: Static<typeof EntryIdSchema> extends Static<typeof ConversationIdSchema>
    ? false
    : true = true;
  assert(distinct);
});

await test("user input accepts signed text and images, but not assistant blocks", () => {
  const validator = Compile(UserInputSchema);
  const content: UserInput = [
    { type: "text", text: "question", textSignature: "signature" },
    { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
  ];
  assert(validator.Check(content));
  assert(validator.Check("question"));
  assert(validator.Check([]));
  for (const value of [
    null,
    [{ type: "thinking", thinking: "reasoning" }],
    [{ type: "image", data: "aW1hZ2U=" }],
    [{ type: "text", text: 1 }],
    [{ type: "text", text: "question", conversationId: 1 }],
  ]) {
    assert.equal(validator.Check(value), false);
  }
});

await test("recursive JSON and opaque cursors validate nested values", () => {
  const json = Compile(JsonValueSchema);
  const cursor = Compile(CursorSchema);
  const opaque: Cursor = {
    backend: { token: [null, true, 3, "position", { nested: [1, 2] }] },
  };
  assert(json.Check(opaque));
  assert(cursor.Check(opaque));
  assert(cursor.Check({}));
  for (const value of [null, 1, "cursor", []]) assert.equal(cursor.Check(value), false);
  for (const value of [
    { backend: { token: [undefined] } },
    { backend: { token: { unsupported: undefined } } },
    { backend: { token: [Infinity] } },
    { backend: { token: [() => {}] } },
  ]) {
    assert.equal(json.Check(value), false);
    assert.equal(cursor.Check(value), false);
  }
});

await test("entry queries can exclude conversation selection without weakening validation", () => {
  const validator = Compile(
    Type.Omit(EntryQuerySchema, ["conversationId"], { additionalProperties: false }),
  );
  assert(validator.Check({}));
  assert(validator.Check({ minEntryId: 1, maxEntryId: 2, order: "ascending" }));
  assert(validator.Check({ order: "descending" }));
  for (const value of [
    { conversationId: 1 },
    { minEntryId: 0 },
    { maxEntryId: 1.5 },
    { order: "newest" },
  ]) {
    assert.equal(validator.Check(value), false);
  }
});

await test("complete messages and context metadata survive structured-output validation", () => {
  const answer: AssistantMessage = {
    ...fauxAssistantMessage("answer"),
    content: [
      { type: "text", text: "answer", textSignature: "signed" },
      { type: "thinking", thinking: "", thinkingSignature: "opaque", redacted: true },
      {
        type: "toolCall",
        id: "call",
        name: "tool",
        arguments: { nested: [{ value: true }] },
        namespace: "test",
        thoughtSignature: "opaque",
        argumentsError: "incomplete arguments",
      },
    ],
    responseModel: "resolved-model",
    responseId: "response",
    providerThinkingLevel: "high",
    thinkingLevel: "high",
    diagnostics: [
      {
        type: "retry",
        timestamp: 1,
        error: { name: "Error", message: "retry", stack: "stack", code: 429 },
        details: { nested: [null, { retry: true }] },
      },
    ],
    usage: { ...fauxAssistantMessage("answer").usage, reasoning: 2, cacheWrite1h: 3 },
    stopReason: "deferred",
    deferred: {
      api: "custom-api",
      provider: "custom-provider",
      modelId: "model",
      id: "deferred",
      expiresAt: 10,
      pollAfterMs: 1,
      data: { request: ["opaque"] },
    },
    errorMessage: "pending",
    rawStopReason: "provider-reason",
    endTurn: false,
    durationMs: 5,
  };
  const messages: Message[] = [
    {
      role: "system",
      content: [{ type: "text", text: "instructions" }],
      sections: { added: "instructions", removed: null },
      toolsAdded: [
        {
          name: "tool",
          description: "test",
          parameters: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
          },
          constrainedSampling: false,
        },
        {
          name: "strict",
          description: "test",
          parameters: { type: "object", properties: {} },
          constrainedSampling: { type: "json_schema", strict: "require" },
        },
        {
          name: "grammar",
          description: "test",
          parameters: { type: "object", properties: {} },
          constrainedSampling: {
            type: "grammar",
            variants: { openai_lark: "grammar", openai_regex: ".*" },
          },
        },
      ],
      toolsRemoved: [{ name: "old" }],
      timestamp: 1,
    },
    { role: "user", content: "question", timestamp: 2 },
    answer,
    {
      role: "toolResult",
      toolCallId: "call",
      toolName: "tool",
      content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
      details: { nested: [{ detail: true }] },
      usage: answer.usage,
      nestedCalls: {
        calls: [
          {
            id: "nested",
            name: "tool",
            arguments: { nested: [1] },
            argumentsBytes: 10,
            status: "unfinished",
            durationMs: 2,
            error: "cancelled",
          },
        ],
        complete: false,
      },
      isError: false,
      timestamp: 3,
      durationMs: 2,
    },
  ];
  const entry = {
    id: 1,
    conversationId: 1,
    kind: "test",
    model: messages,
    data: { extra: [true] },
    head: 1,
    byTaskId: 1,
    edits: [
      { target: 1, action: "replace", messages },
      { target: 1, action: "omit" },
    ],
  };
  const view = { head: entry, entries: [entry], contributions: [messages], messages };
  for (const [schema, value] of [
    [AssistantMessageSchema, answer],
    [EntryRecordSchema, entry],
    [EntryPageSchema, { items: [entry], next: { backend: { token: [1] } } }],
    [ContextViewSchema, view],
  ] as const) {
    const wire = copyJson(value, { omitUndefinedProperties: true });
    const before = structuredClone(wire);
    assert(Compile(schema).Check(wire));
    assert.deepEqual(wire, before);
  }
  const validator = Compile(MessageSchema);
  for (const message of messages)
    assert(validator.Check(copyJson(message, { omitUndefinedProperties: true })));
  assert.equal(validator.Check({ ...answer, usage: {} }), false);
  assert.equal(validator.Check({ ...answer, stopReason: "unknown" }), false);
  assert.equal(
    validator.Check({ ...answer, diagnostics: [{ type: "retry", timestamp: 1, error: {} }] }),
    false,
  );
  const user: UserMessage = { role: "user", content: "question", timestamp: 1 };
  assert.equal(
    validator.Check({ ...user, content: [{ type: "thinking", thinking: "wrong role" }] }),
    false,
  );
});

await test("context heads are optional on the wire; malformed edits and page entries reject", () => {
  const view: ContextView = { head: undefined, entries: [], contributions: [], messages: [] };
  assert(Compile(ContextViewSchema).Check(copyJson(view, { omitUndefinedProperties: true })));
  assert.equal(Compile(ContextViewSchema).Check({ entries: [], messages: [] }), false);
  assert.equal(Compile(EntryPageSchema).Check({ items: [{ id: 1 }] }), false);
  assert.equal(
    Compile(ContextEditSchema).Check({ target: 1, action: "omit", messages: [] }),
    false,
  );
  assert.equal(Compile(ContextEditSchema).Check({ target: 1, action: "replace" }), false);
});
