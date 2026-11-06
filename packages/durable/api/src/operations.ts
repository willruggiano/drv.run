import assert from "node:assert/strict";
import type { Context } from "@earendil-works/chord";
import type {
  Cursor,
  Harness,
  Page,
  ConversationWatch,
  ConversationId,
} from "@earendil-works/pi-durable";
import Type from "typebox";
import { Check } from "typebox/value";
import { jsonValue, type decode } from "./request.ts";
import { Problem, read } from "./problem.ts";

type Request = Awaited<ReturnType<typeof decode>>;
const cursorSchema = Type.Record(Type.String({ pattern: "^[\\s\\S]*$" }), jsonValue, {
  additionalProperties: false,
});

function cursor(value: string | undefined): Cursor | undefined {
  if (value === undefined) return undefined;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Problem(400);
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw new Problem(400);
    const decoded: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!Check(cursorSchema, decoded)) throw new Problem(400);
    return decoded;
  } catch {
    throw new Problem(400);
  }
}

async function page<T>(result: Promise<Page<T, Cursor>>) {
  const { items, next } = await read(() => result);
  return {
    items,
    ...(next === undefined
      ? {}
      : { next: Buffer.from(JSON.stringify(next)).toString("base64url") }),
  };
}

export async function execute(
  harness: Harness,
  conversationId: ConversationId | undefined,
  request: Exclude<Request, { operation: "models" }>,
  context: Context,
): Promise<{ value: unknown } | { watch: ConversationWatch }> {
  switch (request.operation) {
    case "inspect":
      return { value: await read(() => harness.inspect(context)) };
    case "resume":
      harness.resume();
      return { value: null };
    case "scanConversations": {
      const { limit, cursor: next, ...query } = request.value;
      return {
        value: await page(
          harness.commit((tx) => tx.scanConversations(query, limit, cursor(next)), context),
        ),
      };
    }
    case "scanTasks": {
      const { limit, cursor: next, ...query } = request.value;
      return {
        value: await page(
          harness.commit((tx) => tx.scanTasks(query, limit, cursor(next)), context),
        ),
      };
    }
  }
  // Conversation routes have already validated the path ID.
  assert(conversationId !== undefined);
  const conversation = await read(() => harness.conversation(conversationId, context));
  if (!conversation) throw new Problem(404);
  switch (request.operation) {
    case "watch":
      return { watch: await read(() => conversation.watch(context)) };
    case "entries": {
      const { limit, cursor: next, ...query } = request.value;
      return {
        value: await page(conversation.entries(query, limit, cursor(next), context)),
      };
    }
    case "context":
      return { value: await read(() => conversation.context(context, request.value)) };
    case "submissionByRequest":
      return {
        value:
          (await read(() =>
            harness.commit(
              (tx) => tx.submissionByRequest(conversationId, request.value.requestId),
              context,
            ),
          )) ?? null,
      };
    case "submissions/status": {
      const submission = await read(() => harness.submission(request.value.id, context));
      const record = submission && (await read(() => submission.status(context)));
      return { value: record?.conversationId === conversationId ? record : null };
    }
    case "submit": {
      const submission = await conversation.submit(request.value, context);
      return { value: { id: submission.id } };
    }
    case "abortSubmission":
      return { value: await harness.abortSubmission(request.value.id, context, conversationId) };
    case "abort":
      await conversation.abort(context);
      return { value: null };
    case "reset":
      await conversation.reset(request.value.handoff, context);
      return { value: null };
    case "compact":
      return { value: await conversation.compact(request.value.instructions, context) };
    case "configure":
      await conversation.configure(request.value, context);
      return { value: null };
  }
}
