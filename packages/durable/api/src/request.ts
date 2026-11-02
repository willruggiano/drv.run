import type { IncomingMessage } from "node:http";
import Type, { type Static, type TProperties, type TSchema } from "typebox";
import { Check } from "typebox/value";
import type { ConversationId, EntryId, TaskId, SubmissionId } from "@earendil-works/pi-durable";
import { Problem } from "./problem.ts";

const id = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
// Unsafe supplies only the upstream brand; Check still enforces the integer schema.
const conversationId = Type.Unsafe<ConversationId>(id);
const entryId = Type.Unsafe<EntryId>(id);
const taskId = Type.Unsafe<TaskId>(id);
const submissionId = Type.Unsafe<SubmissionId>(id);
const order = Type.Optional(Type.Enum(["ascending", "descending"]));
const pagination = {
  limit: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  cursor: Type.Optional(Type.String()),
};

export const jsonValue = Type.Cyclic(
  {
    Json: Type.Union([
      Type.Null(),
      Type.Boolean(),
      Type.Number(),
      Type.String(),
      Type.Array(Type.Ref("Json")),
      Type.Record(Type.String({ pattern: "^[\\s\\S]*$" }), Type.Ref("Json"), {
        additionalProperties: false,
      }),
    ]),
  },
  "Json",
);

function object<P extends TProperties>(properties: P) {
  return Type.Object(properties, { additionalProperties: false });
}

const content = Type.Union([
  Type.String(),
  Type.Array(
    Type.Union([
      object({
        type: Type.Literal("text"),
        text: Type.String(),
        textSignature: Type.Optional(Type.String()),
      }),
      object({
        type: Type.Literal("image"),
        data: Type.String({
          pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
        }),
        mimeType: Type.String(),
      }),
    ]),
  ),
]);
const boolean = Type.Optional(Type.Boolean());

const queries = {
  inspect: object({}),
  scanConversations: object({
    ...pagination,
    order,
    ownerConversationId: Type.Optional(conversationId),
    ownerTaskId: Type.Optional(taskId),
  }),
  scanTasks: object({
    ...pagination,
    order,
    conversationId: Type.Optional(conversationId),
    kind: Type.Optional(Type.String()),
    status: Type.Optional(Type.Enum(["pending", "running", "waiting", "sleeping", "terminal"])),
    abortRequested: boolean,
    background: boolean,
  }),
  watch: object({}),
  entries: object({
    ...pagination,
    order,
    minEntryId: Type.Optional(entryId),
    maxEntryId: Type.Optional(entryId),
  }),
  context: object({ at: Type.Optional(entryId) }),
  submissionByRequest: object({ requestId: Type.String() }),
  "submissions/status": object({ id: submissionId }),
};
const bodies = {
  resume: Type.Undefined(),
  abort: Type.Undefined(),
  submit: object({
    type: Type.Literal("input"),
    content,
    requestId: Type.Optional(Type.String()),
    whenBusy: Type.Optional(Type.Enum(["steer", "followUp", "reject"])),
    entry: Type.Optional(
      object({ kind: Type.String({ pattern: "^(?!pi\\.)" }), data: Type.Optional(jsonValue) }),
    ),
  }),
  abortSubmission: object({ id: submissionId }),
  reset: object({ handoff: Type.Optional(Type.String()) }),
  compact: object({ instructions: Type.Optional(Type.String()) }),
  configure: object({
    model: Type.Optional(
      Type.Union([object({ provider: Type.String(), modelId: Type.String() }), Type.Null()]),
    ),
    thinkingLevel: Type.Optional(
      Type.Union([
        Type.Enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
        Type.Null(),
      ]),
    ),
  }),
};

type Query = {
  [K in keyof typeof queries]: { operation: K; value: Static<(typeof queries)[K]> };
}[keyof typeof queries];
type Body = {
  [K in keyof typeof bodies]: { operation: K; value: Static<(typeof bodies)[K]> };
}[keyof typeof bodies];

function parse<S extends TSchema>(schema: S, value: unknown): Static<S> {
  if (!Check(schema, value)) throw new Problem(400);
  return value;
}

function queryValue(schema: TSchema | undefined, value: string): unknown {
  if (Type.IsInteger(schema) && /^\d+$/.test(value)) return Number(value);
  if (Type.IsBoolean(schema) && (value === "true" || value === "false")) return value === "true";
  return value;
}

export function parseId(value: string): ConversationId {
  return parse(conversationId, queryValue(conversationId, value));
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
    const name = operation as keyof typeof queries;
    const properties: TProperties = queries[name].properties;
    const values: Record<string, unknown> = {};
    for (const [key, value] of url.searchParams) {
      if (Object.hasOwn(values, key)) throw new Problem(400);
      Object.defineProperty(values, key, {
        value: queryValue(properties[key], value),
        enumerable: true,
      });
    }
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
