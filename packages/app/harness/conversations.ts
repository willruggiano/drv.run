import assert from "node:assert/strict";
import { copyJson } from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import { Type, type Static, type TSchema } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  defineExtension,
  defineTool,
  section,
  type EntryId,
  type Harness,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";

const id = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const object = <P extends Record<string, TSchema>>(properties: P) =>
  Type.Object(properties, { additionalProperties: false });
const content = Type.Union([
  Type.String(),
  Type.Array(
    Type.Union([
      object({
        type: Type.Literal("text"),
        text: Type.String(),
        textSignature: Type.Optional(Type.String()),
      }),
      object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String() }),
    ]),
  ),
]);
// Describe the navigable fields without projecting away upstream message or entry metadata.
const message = Type.Object({
  role: Type.String(),
  content: Type.Union([
    Type.String(),
    Type.Array(
      Type.Object({
        type: Type.String(),
        text: Type.Optional(Type.String()),
      }),
    ),
  ]),
});
const entry = Type.Object({
  id,
  conversationId: id,
  kind: Type.String(),
  model: Type.Optional(Type.Array(message)),
});
const cursor = Type.Record(Type.String(), Type.Unknown());

export function createConversationExtension(harness: () => Harness) {
  async function self(api: ToolExecutionApi, context: Context) {
    const conversation = await harness().conversation(api.conversationId, context);
    assert(conversation);
    return conversation;
  }

  function tool<S extends TSchema>(
    name: string,
    description: string,
    parameters: S,
    structuredOutputSchema: TSchema,
    execute: (args: Static<S>, api: ToolExecutionApi, context: Context) => Promise<unknown>,
  ) {
    return defineTool({
      name,
      description,
      parameters,
      structuredOutputSchema,
      callers: ["tools"],
      replay: "safe",
      async execute(args, api, context) {
        return {
          structuredOutput: copyJson(await execute(args, api, context), {
            omitUndefinedProperties: true,
          }),
        };
      },
    });
  }

  return defineExtension({
    name: "conversations",
    sections: [
      section(
        "conversations",
        () =>
          "contextView reads your active model context; contextEntries pages your raw history, including entries excluded by resets or compaction. " +
          "forkJoin({ at, content }) forks your conversation through the selected visible entry, submits content, and returns that submission's answer. " +
          "The child inherits your agent configuration and can recursively forkJoin. Prefer a user entry before the current tool round. " +
          "Await forkJoin calls inside Codemode; unfinished calls and their descendants are cancelled when the script ends. " +
          "The returned conversationId identifies the transcript, not a handle. Forks share your execution environment.",
      ),
    ],
    tools: [
      tool(
        "contextView",
        "Read your active context, optionally as of a visible entry. Returns head, raw active entries, per-entry contributions, and assembled messages.",
        object({ at: Type.Optional(id) }),
        Type.Object({
          head: Type.Optional(entry),
          entries: Type.Array(entry),
          contributions: Type.Array(Type.Array(message)),
          messages: Type.Array(message),
        }),
        async (args, api, context) =>
          (await self(api, context)).context(context, { at: args.at as EntryId | undefined }),
      ),
      tool(
        "contextEntries",
        "Read your raw fork-aware history, including inactive entries. Returns items and optional next; round-trip next as cursor.",
        object({
          query: Type.Optional(
            object({
              minEntryId: Type.Optional(id),
              maxEntryId: Type.Optional(id),
              order: Type.Optional(Type.Enum(["ascending", "descending"])),
            }),
          ),
          limit: Type.Integer({ minimum: 1, maximum: 256 }),
          cursor: Type.Optional(cursor),
        }),
        Type.Object({ items: Type.Array(entry), next: Type.Optional(cursor) }),
        async (args, api, context) => {
          const next = args.cursor === undefined ? undefined : copyJson(args.cursor);
          assert(
            next === undefined ||
              (typeof next === "object" && next !== null && !Array.isArray(next)),
          );
          return (await self(api, context)).entries(
            {
              minEntryId: args.query?.minEntryId as EntryId | undefined,
              maxEntryId: args.query?.maxEntryId as EntryId | undefined,
              order: args.query?.order,
            },
            args.limit,
            next,
            context,
          );
        },
      ),
      tool(
        "forkJoin",
        "Fork your conversation at a visible entry, submit content, and await its answer. Rejects if the submission is unanswered. Returns conversationId and the complete AssistantMessage.",
        object({ at: id, content }),
        Type.Object({
          conversationId: id,
          answer: Type.Object({
            ...message.properties,
            role: Type.Literal("assistant"),
            stopReason: Type.String(),
          }),
        }),
        async (args, api, context) => {
          const child = await api.commit(async (tx) => {
            const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
            if (existing) return existing.id;
            return (
              await tx.forkConversation(api.conversationId, args.at as EntryId, {
                ownership: { kind: "task", taskId: api.taskId },
              })
            ).id;
          }, context);
          await api.details({ conversationId: child }, context);
          const conversation = await api.conversation(child, context);
          assert(conversation);
          const submission = await conversation.submit(
            {
              type: "input",
              content: args.content,
              requestId: `forkJoin:${api.taskId}`,
            },
            context,
          );
          const settled = await submission.wait(context);
          if (settled.status !== "done" || settled.type !== "input") {
            throw new Error(
              `forkJoin submission ${settled.id} was not answered: ${settled.reason}`,
            );
          }
          const answer = (
            await api.commit((tx) => tx.entry(AssistantEntry, settled.answer), context)
          )?.model?.[0];
          assert(answer?.role === "assistant", "Answered submission has no assistant message");
          return { conversationId: child, answer };
        },
      ),
    ],
  });
}
