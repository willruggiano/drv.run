import assert from "node:assert/strict";
import { copyJson } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { AssistantEntry, defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import {
  AssistantMessageSchema,
  ContextViewSchema,
  ConversationIdSchema,
  CursorSchema,
  EntryIdSchema,
  EntryPageSchema,
  EntryQuerySchema,
  UserInputSchema,
} from "./durable.ext.ts";

export function createConversationExtension() {
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
      defineTool({
        name: "contextView",
        description:
          "Read your active context, optionally as of a visible entry. Returns head, raw active entries, per-entry contributions, and assembled messages.",
        parameters: Type.Object(
          { at: Type.Optional(EntryIdSchema) },
          { additionalProperties: false },
        ),
        structuredOutputSchema: ContextViewSchema,
        callers: ["tools"],
        replay: "safe",
        async execute(args, api, context) {
          const conversation = await api.conversation(api.conversationId, context);
          assert(conversation);
          return {
            structuredOutput: copyJson(await conversation.context(context, args), {
              omitUndefinedProperties: true,
            }),
          };
        },
      }),
      defineTool({
        name: "contextEntries",
        description:
          "Read your raw fork-aware history, including inactive entries. Returns items and optional next; round-trip next as cursor.",
        parameters: Type.Object(
          {
            query: Type.Optional(
              Type.Omit(EntryQuerySchema, ["conversationId"], { additionalProperties: false }),
            ),
            limit: Type.Integer({ minimum: 1, maximum: 256 }),
            cursor: Type.Optional(CursorSchema),
          },
          { additionalProperties: false },
        ),
        structuredOutputSchema: EntryPageSchema,
        callers: ["tools"],
        replay: "safe",
        async execute(args, api, context) {
          const page = await api.commit(
            (tx) =>
              tx.scanEntries(
                { ...args.query, conversationId: api.conversationId },
                args.limit,
                args.cursor,
              ),
            context,
          );
          return { structuredOutput: copyJson(page, { omitUndefinedProperties: true }) };
        },
      }),
      defineTool({
        name: "forkJoin",
        description:
          "Fork your conversation at a visible entry, submit content, and await its answer. Rejects if the submission is unanswered. Returns conversationId and the complete AssistantMessage.",
        parameters: Type.Object(
          { at: EntryIdSchema, content: UserInputSchema },
          { additionalProperties: false },
        ),
        structuredOutputSchema: Type.Object({
          conversationId: ConversationIdSchema,
          answer: AssistantMessageSchema,
        }),
        callers: ["tools"],
        replay: "safe",
        async execute(args, api, context) {
          const child = await api.commit(async (tx) => {
            const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
            if (existing) return existing.id;
            return (
              await tx.forkConversation(api.conversationId, args.at, {
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
          return {
            structuredOutput: copyJson(
              { conversationId: child, answer },
              {
                omitUndefinedProperties: true,
              },
            ),
          };
        },
      }),
    ],
  });
}
