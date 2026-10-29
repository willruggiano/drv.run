import assert from "node:assert/strict";
import { copyJson } from "@earendil-works/chord";
import { withoutAbortSignal, type Context } from "@earendil-works/chord/context";
import { Type, type Static, type TSchema } from "@earendil-works/pi-ai";
import {
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  section,
  wrapTool,
  type Conversation,
  type ConversationId,
  type Cursor,
  type EntryId,
  type Harness,
  type TaskId,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { createCodemodeTool, type CodemodeToolOptions } from "@earendil-works/pi-durable/codemode";

// Neither the scope nor its task ID is a model capability. Only a direct nested
// call of the wrapped Codemode task can acquire it, including after recovery.
const Scope = defineDoc<{ guard?: TaskId; closed: boolean }>({
  kind: "app.conversations.scope",
  version: 1,
  scope: "task",
  initial: () => ({ closed: false }),
  checkpointWhen: () => false,
});

const id = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const target = { conversationId: Type.Optional(id) };
const object = <P extends Record<string, TSchema>>(properties: P) =>
  Type.Object(properties, { additionalProperties: false });
const change = object({
  model: Type.Optional(
    Type.Union([object({ provider: Type.String(), modelId: Type.String() }), Type.Null()]),
  ),
  thinkingLevel: Type.Optional(
    Type.Union([
      Type.Enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
      Type.Null(),
    ]),
  ),
  instructions: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  cwd: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});
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

export function createConversationExtension(harness: () => Harness, options: CodemodeToolOptions) {
  async function children(owner: TaskId, context: Context) {
    const ids: ConversationId[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = await harness().commit(
        (tx) => tx.scanConversations({ ownerTaskId: owner }, 256, cursor),
        context,
      );
      ids.push(...page.items.map((record) => record.id));
      cursor = page.next;
    } while (cursor !== undefined);
    return ids;
  }

  // The guard stays live until explicitly aborted. Its durable abort handler is
  // also reached when the caller crashes or is cancelled before finally runs.
  // Ordinary ownership cancellation skips background tasks; this sweep does not.
  const Guard = defineTask({
    name: "app.conversations.guard",
    version: 1,
    initial: () => ({ phase: "hold" as const }),
    phases: {
      hold: async (_task, runtime, context) => {
        await runtime.commit(
          () => ({
            status: "sleeping",
            until: runtime.now() + 86_400_000,
            checkpoint: { phase: "hold" },
          }),
          context,
        );
      },
    },
    abort: async (_task, runtime, context) => {
      await Promise.all(
        (await children(runtime.taskId, context)).map(async (id) => {
          const conversation = await harness().conversation(id, context);
          assert(conversation);
          await conversation.abort(context, { background: true });
        }),
      );
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
    },
  });

  async function resolve(api: ToolExecutionApi, requested: number | undefined, context: Context) {
    const call = await api.getTask(api.taskId, context);
    assert(call?.owner !== undefined, "Conversation tools require Codemode");
    const scope = await api.snapshot(Scope, call.owner, context);
    assert(scope?.guard !== undefined && !scope.closed, "Codemode scope is closed or absent");
    const guard = await api.getTask(scope.guard, context);
    assert(
      guard && !guard.abortRequested && guard.state.status !== "terminal",
      "Codemode scope has ended",
    );
    const conversationId = requested ?? api.conversationId;
    if (conversationId !== api.conversationId) {
      const permitted = await children(scope.guard, context);
      assert(
        permitted.some((id) => id === conversationId),
        "Conversation is outside this Codemode scope",
      );
    }
    // IDs are validated integers at the JSON boundary; authority was checked above.
    const conversation = await harness().conversation(conversationId as ConversationId, context);
    assert(conversation, "Conversation does not exist");
    return { conversation, guard: scope.guard };
  }

  function childOnly(conversation: Conversation, api: ToolExecutionApi) {
    assert(conversation.id !== api.conversationId, "This operation requires a child conversation");
  }

  function tool<S extends TSchema>(
    name: string,
    description: string,
    parameters: S,
    execute: (args: Static<S>, api: ToolExecutionApi, context: Context) => Promise<unknown>,
    replay: "safe" | "unsafe" = "unsafe",
  ) {
    return defineTool({
      name: `conversation_${name}`,
      description,
      parameters,
      callers: ["tools"],
      replay,
      structuredOutputSchema: Type.Unknown(),
      async execute(args, api, context) {
        const value = await execute(args, api, context);
        return {
          structuredOutput:
            value === undefined ? null : copyJson(value, { omitUndefinedProperties: true }),
        };
      },
    });
  }

  return defineExtension({
    name: "conversations",
    tasks: [Guard],
    sections: [
      section(
        "conversations",
        () =>
          "Use conversation_* tools inside Codemode. Omit conversationId for self; otherwise use a child ID returned in this invocation. " +
          "fork(at) inherits history through that visible entry. Prefer a user entry before the current tool round. " +
          "submit accepts input only in this prototype. submit, compact, abort and waitForIdle require a child, never self. " +
          "All child execution, including descendants, is cancelled and joined when the script ends. " +
          "Await children inside the script; waitForIdle does not imply success. Read context or entries for results. " +
          "Interrupted mutations report failure rather than rerunning; they may already have taken effect. " +
          "Forks share the execution environment: they do not isolate filesystem writes.",
      ),
    ],
    wraps: [
      wrapTool(createCodemodeTool(options), (codemode) => ({
        ...codemode,
        async execute(args, api, context) {
          const guard = await api.commit(async (tx) => {
            const scope = await tx.doc(Scope, api.taskId);
            scope.guard ??= await tx.createTask(Guard, null, {
              ownership: { kind: "task", taskId: api.taskId },
            });
            return scope.guard;
          }, context);
          try {
            return await codemode.execute(args, api, context);
          } finally {
            const cleanup = withoutAbortSignal(context);
            // Close admission before joining RPCs. A late admitted RPC then fails
            // resolve(); an already executing RPC is aborted and joined below.
            await harness().commit(async (tx) => {
              (await tx.doc(Scope, api.taskId)).closed = true;
            }, cleanup);
            const nested = (await harness().inspect(cleanup)).tasks.filter(
              ({ record }) => record.owner === api.taskId && record.id !== guard,
            );
            await Promise.all(
              nested.map(async ({ record }) => {
                await harness().abortTask(record.id, cleanup);
                await harness().waitForTask(record.id, cleanup);
              }),
            );
            await harness().abortTask(guard, cleanup);
            await harness().waitForTask(guard, cleanup);
          }
        },
      })),
    ],
    tools: [
      tool(
        "context",
        "Read active context, optionally at a visible entry.",
        object({
          ...target,
          at: Type.Optional(id),
        }),
        async (args, api, context) => {
          const { conversation } = await resolve(api, args.conversationId, context);
          return conversation.context(context, { at: args.at as EntryId | undefined });
        },
        "safe",
      ),
      tool(
        "entries",
        "Read fork-aware history. Round-trip next as cursor to paginate.",
        object({
          ...target,
          query: Type.Optional(
            object({
              minEntryId: Type.Optional(id),
              maxEntryId: Type.Optional(id),
              order: Type.Optional(Type.Enum(["ascending", "descending"])),
            }),
          ),
          limit: Type.Integer({ minimum: 1, maximum: 256 }),
          cursor: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        }),
        async (args, api, context) => {
          const { conversation } = await resolve(api, args.conversationId, context);
          const cursor = args.cursor === undefined ? undefined : copyJson(args.cursor);
          assert(
            cursor === undefined ||
              (typeof cursor === "object" && cursor !== null && !Array.isArray(cursor)),
          );
          return conversation.entries(
            {
              minEntryId: args.query?.minEntryId as EntryId | undefined,
              maxEntryId: args.query?.maxEntryId as EntryId | undefined,
              order: args.query?.order,
            },
            args.limit,
            cursor,
            context,
          );
        },
        "safe",
      ),
      tool(
        "fork",
        "Fork at a visible entry. Returns { id }; ownership is supplied by Codemode.",
        object({
          ...target,
          at: id,
          agent: Type.Optional(change),
        }),
        async (args, api, context) => {
          const { conversation, guard } = await resolve(api, args.conversationId, context);
          const child = await conversation.fork(
            args.at as EntryId,
            {
              ownership: { kind: "task", taskId: guard },
              agent: args.agent,
            },
            context,
          );
          return { id: child.id };
        },
      ),
      tool(
        "configure",
        "Change JSON-compatible agent fields; null clears a field.",
        object({
          ...target,
          change,
        }),
        async (args, api, context) => {
          const { conversation } = await resolve(api, args.conversationId, context);
          await conversation.configure(args.change, context);
        },
      ),
      tool(
        "submit",
        "Submit user input to a child. Returns { id }, not a Submission handle.",
        object({
          ...target,
          submission: object({
            type: Type.Literal("input"),
            content,
            requestId: Type.Optional(Type.String()),
            whenBusy: Type.Optional(Type.Enum(["steer", "followUp", "reject"])),
          }),
        }),
        async (args, api, context) => {
          const { conversation } = await resolve(api, args.conversationId, context);
          childOnly(conversation, api);
          const submission = await conversation.submit(args.submission, context);
          return { id: submission.id };
        },
      ),
      tool(
        "reset",
        "Admit a context reset, optionally carrying a handoff user message.",
        object({
          ...target,
          handoff: Type.Optional(Type.String()),
        }),
        async (args, api, context) => {
          const { conversation } = await resolve(api, args.conversationId, context);
          await conversation.reset(args.handoff, context);
        },
      ),
      tool(
        "compact",
        "Admit manual compaction of a child. Returns its task ID; waitForIdle before reading.",
        object({
          ...target,
          instructions: Type.Optional(Type.String()),
        }),
        async (args, api, context) => {
          const { conversation } = await resolve(api, args.conversationId, context);
          childOnly(conversation, api);
          return conversation.compact(args.instructions, context);
        },
      ),
      tool(
        "abort",
        "Cancel and join a child's work, including background work.",
        object(target),
        async (args, api, context) => {
          const { conversation } = await resolve(api, args.conversationId, context);
          childOnly(conversation, api);
          await conversation.abort(context, { background: true });
        },
      ),
      tool(
        "waitForIdle",
        "Wait for a child's ordinary ownership scope to become idle. Not a success assertion.",
        object(target),
        async (args, api, context) => {
          const { conversation } = await resolve(api, args.conversationId, context);
          childOnly(conversation, api);
          await conversation.waitForIdle(context);
        },
        "safe",
      ),
    ],
  });
}
