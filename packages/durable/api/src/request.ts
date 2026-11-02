import type { IncomingMessage } from "node:http";
import { z } from "zod";
import type { ConversationId, EntryId, TaskId, SubmissionId } from "@earendil-works/pi-durable";
import { Problem } from "./problem.ts";

const id = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const queryId = z.string().regex(/^\d+$/).transform(Number).pipe(id);
const conversationId = queryId.transform((value) => value as ConversationId);
const entryId = queryId.transform((value) => value as EntryId);
const taskId = queryId.transform((value) => value as TaskId);
const submissionId = id.transform((value) => value as SubmissionId);
const order = z.enum(["ascending", "descending"]).optional();
const pagination = {
  limit: queryId.pipe(z.number().positive()),
  cursor: z.string().optional(),
};
const content = z.union([
  z.string(),
  z.array(
    z.union([
      z.strictObject({
        type: z.literal("text"),
        text: z.string(),
        textSignature: z.string().optional(),
      }),
      z.strictObject({ type: z.literal("image"), data: z.base64(), mimeType: z.string() }),
    ]),
  ),
]);
const boolean = z
  .enum(["true", "false"])
  .transform((value) => value === "true")
  .optional();

const queries = {
  inspect: z.strictObject({}),
  scanConversations: z.strictObject({
    ...pagination,
    order,
    ownerConversationId: conversationId.optional(),
    ownerTaskId: taskId.optional(),
  }),
  scanTasks: z.strictObject({
    ...pagination,
    order,
    conversationId: conversationId.optional(),
    kind: z.string().optional(),
    status: z.enum(["pending", "running", "waiting", "sleeping", "terminal"]).optional(),
    abortRequested: boolean,
    background: boolean,
  }),
  watch: z.strictObject({}),
  entries: z.strictObject({
    ...pagination,
    order,
    minEntryId: entryId.optional(),
    maxEntryId: entryId.optional(),
  }),
  context: z.strictObject({ at: entryId.optional() }),
  submissionByRequest: z.strictObject({ requestId: z.string() }),
  "submissions/status": z.strictObject({ id: queryId.pipe(submissionId) }),
};
const bodies = {
  resume: z.undefined(),
  abort: z.undefined(),
  submit: z.strictObject({
    type: z.literal("input"),
    content,
    requestId: z.string().optional(),
    whenBusy: z.enum(["steer", "followUp", "reject"]).optional(),
    entry: z
      .strictObject({
        kind: z.string().refine((value) => !value.startsWith("pi.")),
        data: z.json().optional(),
      })
      .optional(),
  }),
  abortSubmission: z.strictObject({ id: submissionId }),
  reset: z.strictObject({ handoff: z.string().optional() }),
  compact: z.strictObject({ instructions: z.string().optional() }),
  configure: z.strictObject({
    model: z.strictObject({ provider: z.string(), modelId: z.string() }).nullable().optional(),
    thinkingLevel: z
      .enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
      .nullable()
      .optional(),
  }),
};

type Query = {
  [K in keyof typeof queries]: { operation: K; value: z.output<(typeof queries)[K]> };
}[keyof typeof queries];
type Body = {
  [K in keyof typeof bodies]: { operation: K; value: z.output<(typeof bodies)[K]> };
}[keyof typeof bodies];

function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new Problem(400);
  return result.data;
}

export function parseId(value: string): ConversationId {
  return parse(conversationId, value);
}

export async function decode(
  request: IncomingMessage,
  url: URL,
  operation: string,
  conversation: boolean,
  bodyLimit: number,
): Promise<Query | Body> {
  if (conversation === ["inspect", "resume", "scanConversations", "scanTasks"].includes(operation))
    throw new Problem(404);
  if (Object.hasOwn(queries, operation)) {
    if (request.method !== "GET") throw new Problem(405, "GET");
    await noBody(request);
    const values: Record<string, string> = {};
    for (const [key, value] of url.searchParams) {
      if (Object.hasOwn(values, key)) throw new Problem(400);
      Object.defineProperty(values, key, { value, enumerable: true });
    }
    const name = operation as keyof typeof queries;
    // Each table key selects the schema for the same discriminant.
    return { operation: name, value: parse(queries[name], values) } as Query;
  }
  if (!Object.hasOwn(bodies, operation)) throw new Problem(404);
  if (request.method !== "POST") throw new Problem(405, "POST");
  if (url.search) throw new Problem(400);
  const name = operation as keyof typeof bodies;
  const value =
    name === "resume" || name === "abort"
      ? await noBody(request)
      : await jsonBody(request, bodyLimit);
  return { operation: name, value: parse(bodies[name], value) } as Body;
}

async function noBody(request: IncomingMessage): Promise<undefined> {
  for await (const _chunk of request.iterator({ destroyOnReturn: false })) throw new Problem(400);
  return undefined;
}

async function jsonBody(request: IncomingMessage, limit: number): Promise<unknown> {
  if (
    request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
  )
    throw new Problem(415);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) throw new Problem(413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new Problem(400);
  }
}
