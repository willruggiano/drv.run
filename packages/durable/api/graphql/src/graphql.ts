import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { MIMEType } from "node:util";
import { awaitWithContext } from "@earendil-works/chord/context";
import { Problem } from "../../src/problem.ts";
import type { Float, ID, Int, GqlScalar } from "grats";
import {
  GraphQLError,
  execute,
  getOperationAST,
  parse,
  validate,
  valueFromASTUntyped,
  type ExecutionResult,
  type GraphQLSchema,
} from "graphql";
import Type from "typebox";
import Value from "typebox/value";
import { ConversationBusy, SessionFailed, StorageRequestError } from "@earendil-works/pi-durable";
import type { ResolverContext } from "./index.ts";
import { getSchema } from "./generated/graphql.ts";
import type * as Durable from "@earendil-works/pi-durable";
import type * as Chord from "@earendil-works/chord";
import type * as AI from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";

// TypeScript/Grats is the schema source of truth. The generated factory accepts
// scalar implementations. Deployment supplies authorized persisted Harness lookup
// and the session/model catalogs. Listener, lifetime, and recovery policy remain external.
// Upstream: pi-durable 1.4.0 dist/types.d.ts and dist/harness/types.d.ts.
// Global identities, connection wrappers, and transport inputs remain adapter types.

/*
 * All reads are point-in-time and do not enable scheduling. Transactions,
 * execution contexts, Harness factories, and telemetry remain server-side as in
 * SPEC.md. There is no watch, subscription, remote wait, or task-control API.
 *
 * Execution failures use GraphQL errors, not success payloads. extensions.code is
 * BAD_REQUEST for adapter validation and typed StorageRequestError,
 * NOT_FOUND for missing mutation targets, CONVERSATION_BUSY for typed
 * ConversationBusy, SESSION_FAILED for typed SessionFailed, and INTERNAL_SERVER_ERROR
 * otherwise. Mapping is independent of the operation. ReadAfterWrite, untyped
 * exceptions, and invisible historical entries retain the internal-error fallback. Never classify
 * by error-message text or expose stacks, causes, or internal error messages.
 * Missing lookup objects are null, not execution errors; storage failures still
 * produce errors. Persisted task failures and blocked inspection states are data.
 *
 * GraphQL execution errors are distinct from HTTP transport errors. The transport
 * retains no-store responses, body limits, media-type checks, and method checks;
 * mutations cannot run over GET. Disconnect cancels request-bound waits, not durable
 * execution, and does not establish whether a mutation committed. Neither SESSION_FAILED nor a transport failure
 * authorizes automatic replay or promises a recovery time.
 *
 * ID means an opaque global Node identifier. ConversationId, EntryId, TaskId, and
 * SubmissionId retain their upstream numeric representations, scoped to a session.
 * Record nodes expose durableId for the upstream id; Harness exposes its
 * externalId key. Other record fields retain their upstream names and values.
 * Missing optional output fields become null. Optional upstream input fields
 * permit omission, but reject explicit null unless their
 * description permits it. A null cursor means no continuation.
 */

type ErrorCode =
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "CONVERSATION_BUSY"
  | "SESSION_FAILED"
  | "INTERNAL_SERVER_ERROR";

class ResolverError extends GraphQLError {
  constructor(code: ErrorCode) {
    super(code, { extensions: { code } });
  }
}

// TODO(production): distinguish StorageRequestError from rejected storage reads
// (BAD_REQUEST) from fatal Storage.commit()/mintId() failures (INTERNAL_SERVER_ERROR).
// This type-only mapping is provisional; subsequent SessionFailed remains SESSION_FAILED.
// A read inside Harness.commit() is still a read, not a Storage.commit() failure.
// See SPEC.md "Validation and errors" and pi-durable/dist/session/session.js's storage guard.
function mapError(error?: unknown): ResolverError {
  if (error instanceof ResolverError) return error;
  if (error instanceof SessionFailed) return new ResolverError("SESSION_FAILED");
  if (error instanceof StorageRequestError) return new ResolverError("BAD_REQUEST");
  if (error instanceof ConversationBusy) return new ResolverError("CONVERSATION_BUSY");
  return new ResolverError("INTERNAL_SERVER_ERROR");
}

const SafeInteger = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
// Unsafe supplies only the nominal Durable ID brand; SafeInteger validates the value.
const ConversationId = Type.Unsafe<Durable.ConversationId>(SafeInteger);
/**
 * Upstream ConversationId: a nonnegative safe-integer JSON number in
 * 0..9007199254740991, not a 32-bit GraphQL Int or global Node ID.
 * @gqlScalar
 */
export type ConversationId = Type.Static<typeof ConversationId>;

const EntryId = Type.Unsafe<Durable.EntryId>(SafeInteger);
/**
 * Upstream EntryId; the same numeric range and representation as ConversationId.
 * @gqlScalar
 */
export type EntryId = Type.Static<typeof EntryId>;

const TaskId = Type.Unsafe<Durable.TaskId>(SafeInteger);
/**
 * Upstream TaskId; the same numeric range and representation as ConversationId.
 * @gqlScalar
 */
export type TaskId = Type.Static<typeof TaskId>;

const SubmissionId = Type.Unsafe<Durable.SubmissionId>(SafeInteger);
/**
 * Upstream SubmissionId; the same numeric range and representation as ConversationId.
 * @gqlScalar
 */
export type SubmissionId = Type.Static<typeof SubmissionId>;

const PageLimit = Type.Integer({ minimum: 1, maximum: 2147483647 });
// JSON object names are strings: https://www.rfc-editor.org/rfc/rfc8259#section-4
// TypeBox 1.3.27 build/type/types/record.mjs uses StringKey (^.*$), excluding newlines.
// \s and \S are complements, so [\s\S]* covers every string, including empty/newline keys:
// https://262.ecma-international.org/16.0/#sec-characterclassescape
const JsonKey = Type.String({ pattern: "^[\\s\\S]*$" });
const JsonValue = Type.Cyclic(
  {
    Json: Type.Union([
      Type.Null(),
      Type.Boolean(),
      Type.Number(),
      Type.String(),
      Type.Array(Type.Ref("Json")),
      Type.Record(JsonKey, Type.Ref("Json"), {
        additionalProperties: false,
      }),
    ]),
  },
  "Json",
);
/**
 * A finite JSON value, including null; object keys and payloads are preserved.
 * @gqlScalar
 */
export type JsonValue = Type.Static<typeof JsonValue>;

const JsonObject = Type.Record(JsonKey, JsonValue, {
  additionalProperties: false,
});
/**
 * Upstream JsonObject: a JSON object with string keys and JsonValue values.
 * @gqlScalar
 */
export type JsonObject = Type.Static<typeof JsonObject>;

const Cursor = JsonObject;
/**
 * Backend-owned JSON continuation state. Round-trip it unchanged to the same
 * upstream scan; storage validates it. Null means no continuation.
 * @gqlScalar
 */
export type Cursor = Type.Static<typeof Cursor>;

const TelemetryCarrier = Type.Record(JsonKey, Type.String(), { additionalProperties: false });
/**
 * Upstream TelemetryCarrier: a JSON object with string keys and string values.
 * @gqlScalar
 */
export type TelemetryCarrier = Type.Static<typeof TelemetryCarrier>;

// Adapter rule derived from https://www.rfc-editor.org/rfc/rfc4648#section-4:
// alphabet A-Z/a-z/0-9/+/, groups of four, then optionally two symbols + == or three + =.
// Empty input is valid (section 10). This checks alphabet/padding, not zero pad bits
// (section 3.5) or image bytes. Durable does not supply this validation pattern.
const ImageData = Type.String({
  pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
});

/**
 * Exactly one representation: plain text or ordered text/image blocks.
 * @gqlInput
 */
type UserInput = { text: string } | { blocks: ReadonlyArray<UserInputBlock> };

/** @gqlInput */
type UserInputBlock = { text: TextContentInput } | { image: ImageContentInput };

/** @gqlInput */
interface TextContentInput {
  readonly text: string;
  /** Omit when absent; explicit null is invalid. */
  readonly textSignature?: string | null;
}

/** @gqlInput */
interface ImageContentInput {
  /** Base64-encoded image bytes. */
  readonly data: string;
  readonly mimeType: string;
}

function inputBlock(block: UserInputBlock): AI.TextContent | AI.ImageContent {
  switch (true) {
    case "text" in block:
      return { type: "text", ...nonNull(block.text) };
    case "image" in block:
      checked(ImageData, block.image.data);
      return { type: "image", ...block.image };
    default:
      return unreachable(block);
  }
}

function inputContent(input: UserInput): Durable.UserInput {
  switch (true) {
    case "text" in input:
      return input.text;
    case "blocks" in input:
      return input.blocks.map(inputBlock);
    default:
      return unreachable(input);
  }
}

function unreachable(value: never): never {
  void value;
  throw new ResolverError("INTERNAL_SERVER_ERROR");
}

function checked<S extends Type.TSchema>(schema: S, value: unknown): Type.Static<S> {
  try {
    if (Value.Check(schema, value)) return value;
  } catch {
    /* Malformed values, including cycles, are invalid input. */
  }
  throw new ResolverError("BAD_REQUEST");
}

function scalar<S extends Type.TSchema>(schema: S): GqlScalar<Type.Static<S>> {
  return {
    parseValue: (value) => checked(schema, value),
    parseLiteral: (value, variables) => checked(schema, valueFromASTUntyped(value, variables)),
    serialize(value) {
      try {
        if (Value.Check(schema, value)) return value;
      } catch {
        /* Do not expose serializer failures. */
      }
      throw new ResolverError("INTERNAL_SERVER_ERROR");
    },
  };
}

export function createSchema(): GraphQLSchema {
  return getSchema({
    scalars: {
      ConversationId: scalar(ConversationId),
      EntryId: scalar(EntryId),
      EntryHead: scalar(EntryHead),
      TaskId: scalar(TaskId),
      SubmissionId: scalar(SubmissionId),
      JsonValue: scalar(JsonValue),
      JsonObject: scalar(JsonObject),
      Cursor: scalar(Cursor),
      TelemetryCarrier: scalar(TelemetryCarrier),
    },
  });
}

function mediaType(value: string): MIMEType | undefined {
  try {
    return new MIMEType(value);
  } catch {
    return undefined;
  }
}

function utf8(media: MIMEType): boolean {
  const charset = media.params.get("charset")?.toLowerCase();
  return charset === undefined || charset === "utf-8" || charset === "utf8";
}

function responseType(accept = "*/*"): string | undefined {
  const ranges = accept.split(",").map(mediaType);
  const candidates = ["application/json", "application/graphql-response+json"].map((type) => {
    let quality = 0;
    let specificity = -1;
    let order = Infinity;
    ranges.forEach((range, index) => {
      if (!range || !utf8(range)) return;
      for (const [parameter] of range.params) {
        if (parameter !== "q" && parameter !== "charset") return;
      }
      const q = range.params.get("q") ?? "1";
      if (!/^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(q)) return;
      const rank =
        range.essence === type
          ? 2
          : range.essence === "application/*"
            ? 1
            : range.essence === "*/*"
              ? 0
              : -1;
      if (rank > specificity) {
        quality = Number(q);
        specificity = rank;
        order = index;
      }
    });
    return { type, quality, order };
  });
  candidates.sort((a, b) => b.quality - a.quality || a.order - b.order);
  return candidates.find((candidate) => candidate.quality > 0)?.type;
}

const RequestParameters = Type.Object({
  query: Type.String(),
  operationName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  variables: Type.Optional(Type.Union([Type.Record(JsonKey, Type.Unknown()), Type.Null()])),
  extensions: Type.Optional(Type.Union([Type.Record(JsonKey, Type.Unknown()), Type.Null()])),
});

export function createGraphQLHandler(options: {
  getHarness: ResolverContext["session"];
  listHarnesses: (context: Chord.Context) => Promise<readonly string[]>;
  models: ResolverContext["models"];
  bodyLimit: number;
}) {
  const schema = createSchema();
  return async (
    request: IncomingMessage,
    response: ServerResponse,
    context: Chord.Context,
    closing: boolean,
  ): Promise<void> => {
    let media: string | undefined;
    response.setHeader("Cache-Control", "no-store");
    const send = (status: number, result?: ExecutionResult) => {
      if (response.destroyed) return;
      const body = result === undefined ? undefined : JSON.stringify(result);
      if (result !== undefined) response.setHeader("Content-Type", `${media}; charset=utf-8`);
      response.writeHead(status).end(body);
    };
    const requestErrors = (errors: readonly GraphQLError[]) =>
      send(media === "application/json" ? 200 : 400, { errors });
    try {
      if (closing) throw new Problem(503);
      media = responseType(request.headers.accept);
      if (!media) throw new Problem(406);
      if (request.method !== "GET" && request.method !== "POST")
        throw new Problem(405, "GET, POST");
      let input: unknown;
      if (request.method === "GET") {
        const params = new URL(request.url!, "http://durable.invalid").searchParams;
        for (const key of ["query", "operationName", "variables", "extensions"]) {
          if (params.getAll(key).length > 1) throw new Problem(400);
        }
        try {
          input = {
            query: params.get("query"),
            operationName: params.get("operationName"),
            variables: JSON.parse(params.get("variables") ?? "null"),
            extensions: JSON.parse(params.get("extensions") ?? "null"),
          };
        } catch {
          throw new Problem(400);
        }
      } else {
        const contentType = mediaType(request.headers["content-type"] ?? "");
        if (!contentType || contentType.essence !== "application/json" || !utf8(contentType))
          throw new Problem(415);
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request.iterator({ destroyOnReturn: false })) {
          assert(Buffer.isBuffer(chunk));
          size += chunk.length;
          if (size > options.bodyLimit) throw new Problem(413);
          chunks.push(chunk);
        }
        try {
          input = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
          );
        } catch {
          throw new Problem(400);
        }
      }
      if (!Value.Check(RequestParameters, input)) throw new Problem(400);
      let document;
      try {
        document = parse(input.query);
      } catch (error) {
        assert(error instanceof GraphQLError);
        return requestErrors([error]);
      }
      const operation = getOperationAST(document, input.operationName);
      if (!operation)
        return requestErrors([new GraphQLError("Operation name is missing or unknown")]);
      if (operation.operation === "mutation" && request.method === "GET")
        throw new Problem(405, "POST");
      if (operation.operation === "subscription")
        return requestErrors([new GraphQLError("Subscriptions are not supported")]);
      const errors = validate(schema, document);
      if (errors.length) return requestErrors(errors);
      async function lookup<T>(read: () => Promise<T>): Promise<T> {
        try {
          return await awaitWithContext(read(), context);
        } catch (error) {
          if (error instanceof StorageRequestError)
            throw new ResolverError("INTERNAL_SERVER_ERROR");
          throw error;
        }
      }
      const contextValue: ResolverContext = {
        context,
        session: (externalId) => lookup(() => options.getHarness(externalId)),
        sessions: () => lookup(() => options.listHarnesses(context)),
        models: options.models,
      };
      const result = await execute({
        schema,
        document,
        contextValue,
        operationName: input.operationName ?? null,
        variableValues: input.variables ?? null,
      });
      const safe = result.errors
        ? {
            ...result,
            errors: result.errors.map((error) => {
              if (!error.path || error.originalError instanceof ResolverError) return error;
              return new GraphQLError("INTERNAL_SERVER_ERROR", {
                nodes: error.nodes ?? null,
                path: error.path,
                extensions: { code: "INTERNAL_SERVER_ERROR" },
              });
            }),
          }
        : result;
      send("data" in result || media === "application/json" ? 200 : 400, safe);
    } catch (error) {
      if (error instanceof Problem) {
        if (error.allow) response.setHeader("Allow", error.allow);
        send(error.status);
      } else send(500);
    }
  };
}

function jsonValue(value: unknown): JsonValue {
  const serialized: unknown = JSON.parse(JSON.stringify(value));
  if (!Value.Check(JsonValue, serialized)) throw new ResolverError("INTERNAL_SERVER_ERROR");
  return serialized;
}

function encodeId(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeId(value: string): unknown {
  try {
    // Base64url alphabet: https://www.rfc-editor.org/rfc/rfc4648#section-5.
    // Global IDs are nonempty and omit padding; the round trip enforces canonical encoding.
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw new Error();
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ResolverError("BAD_REQUEST");
  }
}

const NodeKind = Type.Enum([
  "Harness",
  "ConversationRecord",
  "EntryRecord",
  "TaskRecord",
  "SubmissionRecord",
]);
type NodeKind = Type.Static<typeof NodeKind>;
const Identity = Type.Tuple([
  Type.Literal(1),
  NodeKind,
  Type.String(),
  Type.Union([SafeInteger, Type.Null()]),
]);
function identity(id: ID) {
  const [_, kind, externalId, durableId] = checked(Identity, decodeId(id));
  if (
    encodeId([1, kind, externalId, durableId]) !== id ||
    (kind === "Harness") !== (durableId === null)
  )
    throw new ResolverError("BAD_REQUEST");
  return { kind, externalId, durableId };
}
function globalId(kind: NodeKind, externalId: string, id: number | null = null): ID {
  return encodeId([1, kind, externalId, id]);
}
function harnessNode(externalId: string): Harness {
  return { __typename: "Harness", id: globalId("Harness", externalId), externalId };
}
async function requireHarness(ctx: ResolverContext, source: Harness) {
  const instance = await ctx.session(source.externalId);
  if (!instance) throw new ResolverError("NOT_FOUND");
  return instance;
}
async function requireConversation(ctx: ResolverContext, source: ConversationRecord) {
  const instance = await requireHarness(ctx, source.harness);
  const handle = await instance.conversation(source.durableId, ctx.context);
  if (!handle) throw new ResolverError("NOT_FOUND");
  return handle;
}

function projectConversation(
  owner: Harness,
  record: Durable.ConversationRecord,
): ConversationRecord {
  return {
    ...record,
    __typename: "ConversationRecord",
    id: globalId("ConversationRecord", owner.externalId, record.id),
    durableId: record.id,
    harness: owner,
  };
}
function projectTask(
  owner: Harness,
  record: Durable.TaskRecord<JsonValue, JsonValue, JsonValue>,
): TaskRecord {
  return {
    ...record,
    __typename: "TaskRecord",
    id: globalId("TaskRecord", owner.externalId, record.id),
    durableId: record.id,
    harness: owner,
  };
}
function projectSubmission(owner: Harness, record: Durable.SubmissionRecord): SubmissionRecord {
  return {
    ...record,
    __typename: "SubmissionRecord",
    id: globalId("SubmissionRecord", owner.externalId, record.id),
    durableId: record.id,
    harness: owner,
  };
}

function nonNull<T extends object>(value: T): { [K in keyof T]: Exclude<T[K], null> } {
  if (Object.values(value).some((field) => field === null)) throw new ResolverError("BAD_REQUEST");
  return value as { [K in keyof T]: Exclude<T[K], null> };
}

function connection<T, N extends Node>(
  page: Durable.Page<T, Durable.Cursor>,
  project: (record: T) => N,
): Connection<N> {
  return {
    nodes: page.items.map(project),
    pageInfo: { next: page.next ?? null },
  };
}

async function mutationConversation(ctx: ResolverContext, id: ID) {
  if (identity(id).kind !== "ConversationRecord") throw new ResolverError("BAD_REQUEST");
  const source = await node(id, ctx);
  if (!source) throw new ResolverError("NOT_FOUND");
  assert("__typename" in source && source.__typename === "ConversationRecord");
  return {
    source: source as ConversationRecord,
    handle: await requireConversation(ctx, source as ConversationRecord),
  };
}

/**
 * Upstream pi-ai message variants. String/array content stays distinct through
 * typed wrappers; JSON maps and application payloads remain JSON.
 * @gqlUnion
 */
type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

/** @gqlEnum */
type MessageRole = "system" | "user" | "assistant" | "toolResult";

/** @gqlType */
interface SystemMessage {
  readonly __typename: "SystemMessage";

  /** @gqlField */
  readonly role: MessageRole;
  /** @gqlField */
  readonly content: SystemMessageContent;
  /** Named prompt sections; null values remove a section. @gqlField */
  readonly sections?: JsonObject | null;
  /** @gqlField */
  readonly toolsAdded?: ReadonlyArray<Tool> | null;
  /** @gqlField */
  readonly toolsRemoved?: ReadonlyArray<ToolReference> | null;
  /** Upstream wall-clock milliseconds. @gqlField */
  readonly timestamp: Float;
}

/** @gqlType */
interface UserMessage {
  readonly __typename: "UserMessage";

  /** @gqlField */
  readonly role: MessageRole;
  /** @gqlField */
  readonly content: UserMessageContent;
  /** @gqlField */
  readonly timestamp: Float;
}

/** @gqlType */
interface AssistantMessage {
  readonly __typename: "AssistantMessage";

  /** @gqlField */
  readonly role: MessageRole;
  /** @gqlField */
  readonly content: ReadonlyArray<AssistantContent>;
  /** @gqlField */
  readonly api: string;
  /** @gqlField */
  readonly provider: string;
  /** @gqlField */
  readonly model: string;
  /** @gqlField */
  readonly responseModel?: string | null;
  /** @gqlField */
  readonly responseId?: string | null;
  /** @gqlField */
  readonly providerThinkingLevel?: string | null;
  /** @gqlField */
  readonly thinkingLevel?: ModelThinkingLevel | null;
  /** @gqlField */
  readonly diagnostics?: ReadonlyArray<MessageDiagnostic> | null;
  /** @gqlField */
  readonly usage: Usage;
  /** @gqlField */
  readonly stopReason: StopReason;
  /** @gqlField */
  readonly deferred?: DeferredHandle | null;
  /** @gqlField */
  readonly errorMessage?: string | null;
  /** @gqlField */
  readonly rawStopReason?: string | null;
  /** @gqlField */
  readonly endTurn?: boolean | null;
  /** @gqlField */
  readonly timestamp: Float;
  /** @gqlField */
  readonly durationMs?: Float | null;
}

/** @gqlType */
interface ToolResultMessage {
  readonly __typename: "ToolResultMessage";

  /** @gqlField */
  readonly role: MessageRole;
  /** @gqlField */
  readonly toolCallId: string;
  /** @gqlField */
  readonly toolName: string;
  /** @gqlField */
  readonly content: ReadonlyArray<UserContent>;
  /** Unmodified application payload. @gqlField */
  readonly details?: JsonValue | null;
  /** @gqlField */
  readonly usage?: Usage | null;
  /** @gqlField */
  readonly nestedCalls?: NestedToolCalls | null;
  /** @gqlField */
  readonly isError: boolean;
  /** @gqlField */
  readonly timestamp: Float;
  /** @gqlField */
  readonly durationMs?: Float | null;
}

/** @gqlUnion */
type SystemMessageContent = StringContent | TextContentList;

/** @gqlUnion */
type UserMessageContent = StringContent | UserContentList;

/** @gqlUnion */
type UserContent = TextContent | ImageContent;

/** @gqlUnion */
type AssistantContent = TextContent | ThinkingContent | ToolCall;

/** @gqlType */
interface StringContent {
  readonly __typename: "StringContent";

  /** @gqlField */
  readonly text: string;
}

/** @gqlType */
interface TextContentList {
  readonly __typename: "TextContentList";

  /** @gqlField */
  readonly blocks: ReadonlyArray<TextContent>;
}

/** @gqlType */
interface UserContentList {
  readonly __typename: "UserContentList";

  /** @gqlField */
  readonly blocks: ReadonlyArray<UserContent>;
}

/** @gqlEnum */
type ContentType = "text" | "image" | "thinking" | "toolCall";

/** @gqlType */
interface TextContent {
  readonly __typename: "TextContent";

  /** @gqlField */
  readonly type: ContentType;
  /** @gqlField */
  readonly text: string;
  /** @gqlField */
  readonly textSignature?: string | null;
}

/** @gqlType */
interface ImageContent {
  readonly __typename: "ImageContent";

  /** @gqlField */
  readonly type: ContentType;
  /** @gqlField */
  readonly data: string;
  /** @gqlField */
  readonly mimeType: string;
}

/** @gqlType */
interface ThinkingContent {
  readonly __typename: "ThinkingContent";

  /** @gqlField */
  readonly type: ContentType;
  /** @gqlField */
  readonly thinking: string;
  /** @gqlField */
  readonly thinkingSignature?: string | null;
  /** @gqlField */
  readonly redacted?: boolean | null;
}

/** @gqlType */
interface ToolCall {
  readonly __typename: "ToolCall";

  /** @gqlField */
  readonly type: ContentType;
  /** @gqlField */
  readonly id: string;
  /** @gqlField */
  readonly name: string;
  /** @gqlField */
  readonly arguments: JsonObject;
  /** @gqlField */
  readonly thoughtSignature?: string | null;
  /** @gqlField */
  readonly namespace?: string | null;
  /** @gqlField */
  readonly argumentsError?: string | null;
}

/** @gqlType */
interface Usage {
  /** @gqlField */
  readonly input: Float;
  /** @gqlField */
  readonly output: Float;
  /** @gqlField */
  readonly cacheRead: Float;
  /** @gqlField */
  readonly cacheWrite: Float;
  /** @gqlField */
  readonly cacheWrite1h?: Float | null;
  /** @gqlField */
  readonly reasoning?: Float | null;
  /** @gqlField */
  readonly totalTokens: Float;
  /** @gqlField */
  readonly cost: UsageCost;
}

/** @gqlType */
interface UsageCost {
  /** @gqlField */
  readonly input: Float;
  /** @gqlField */
  readonly output: Float;
  /** @gqlField */
  readonly cacheRead: Float;
  /** @gqlField */
  readonly cacheWrite: Float;
  /** @gqlField */
  readonly total: Float;
}

/** @gqlEnum */
type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";

/** @gqlType */
interface DeferredHandle {
  /** @gqlField */
  readonly provider: string;
  /** @gqlField */
  readonly modelId: string;
  /** @gqlField */
  readonly api: string;
  /** @gqlField */
  readonly id: string;
  /** @gqlField */
  readonly expiresAt?: Float | null;
  /** @gqlField */
  readonly pollAfterMs?: Float | null;
  /** @gqlField */
  readonly data?: JsonValue | null;
}

/** @gqlType */
interface Tool {
  /** @gqlField */
  readonly name: string;
  /** @gqlField */
  readonly description: string;
  /** JSON Schema for tool arguments. @gqlField */
  readonly parameters: JsonObject;
  /** Upstream false or provider-specific constrained-sampling configuration. @gqlField */
  readonly constrainedSampling?: JsonValue | null;
}

/** @gqlType */
interface ToolReference {
  /** @gqlField */
  readonly name: string;
}

/** @gqlType */
interface MessageDiagnostic {
  /** @gqlField */
  readonly type: string;
  /** @gqlField */
  readonly timestamp: Float;
  /** @gqlField */
  readonly error?: DiagnosticError | null;
  /** @gqlField */
  readonly details?: JsonObject | null;
}

/** @gqlType */
interface DiagnosticError {
  /** @gqlField */
  readonly name?: string | null;
  /** @gqlField */
  readonly message: string;
  /** @gqlField */
  readonly stack?: string | null;
  /** Upstream string or number code. @gqlField */
  readonly code?: JsonValue | null;
}

/** @gqlType */
interface NestedToolCalls {
  /** @gqlField */
  readonly calls: ReadonlyArray<NestedToolCallRecord>;
  /** @gqlField */
  readonly complete: boolean;
}

/** @gqlType */
interface NestedToolCallRecord {
  /** @gqlField */
  readonly id: string;
  /** @gqlField */
  readonly name: string;
  /** @gqlField */
  readonly arguments?: JsonObject | null;
  /** @gqlField */
  readonly argumentsBytes?: Float | null;
  /** @gqlField */
  readonly status: NestedToolCallStatus;
  /** @gqlField */
  readonly durationMs?: Float | null;
  /** @gqlField */
  readonly error?: string | null;
}

/** @gqlEnum */
type NestedToolCallStatus = "ok" | "error" | "unfinished";

function jsonObject(value: unknown): JsonObject {
  const json = jsonValue(value);
  if (!Value.Check(JsonObject, json)) throw new ResolverError("INTERNAL_SERVER_ERROR");
  return json;
}

function userContent(value: AI.TextContent | AI.ImageContent): UserContent {
  switch (value.type) {
    case "text":
      return { ...value, __typename: "TextContent" };
    case "image":
      return { ...value, __typename: "ImageContent" };
    default:
      return unreachable(value);
  }
}

function assistantContent(
  value: AI.TextContent | AI.ThinkingContent | AI.ToolCall,
): AssistantContent {
  switch (value.type) {
    case "text":
      return { ...value, __typename: "TextContent" };
    case "thinking":
      return { ...value, __typename: "ThinkingContent" };
    case "toolCall":
      return { ...value, __typename: "ToolCall", arguments: jsonObject(value.arguments) };
    default:
      return unreachable(value);
  }
}

function message(value: AI.Message): Message {
  switch (value.role) {
    case "system":
      return {
        ...value,
        __typename: "SystemMessage",
        content:
          typeof value.content === "string"
            ? { __typename: "StringContent", text: value.content }
            : {
                __typename: "TextContentList",
                blocks: value.content.map((block) => ({ ...block, __typename: "TextContent" })),
              },
        toolsAdded:
          value.toolsAdded?.map((tool) => ({
            ...tool,
            parameters: jsonObject(tool.parameters),
            constrainedSampling:
              tool.constrainedSampling === undefined ? null : jsonValue(tool.constrainedSampling),
          })) ?? null,
      };
    case "user":
      return {
        ...value,
        __typename: "UserMessage",
        content:
          typeof value.content === "string"
            ? { __typename: "StringContent", text: value.content }
            : { __typename: "UserContentList", blocks: value.content.map(userContent) },
      };
    case "assistant":
      return {
        ...value,
        __typename: "AssistantMessage",
        content: value.content.map(assistantContent),
        deferred: value.deferred
          ? {
              ...value.deferred,
              data: value.deferred.data === undefined ? null : jsonValue(value.deferred.data),
            }
          : null,
        diagnostics:
          value.diagnostics?.map((entry) => ({
            ...entry,
            details: entry.details === undefined ? null : jsonObject(entry.details),
          })) ?? null,
      };
    case "toolResult":
      return {
        ...value,
        __typename: "ToolResultMessage",
        content: value.content.map(userContent),
        details: value.details === undefined ? null : jsonValue(value.details),
        nestedCalls: value.nestedCalls
          ? {
              ...value.nestedCalls,
              calls: value.nestedCalls.calls.map((call) => ({
                ...call,
                arguments: call.arguments === undefined ? null : jsonObject(call.arguments),
              })),
            }
          : null,
      };
    default:
      return unreachable(value);
  }
}

function entryRecord(owner: Harness, record: Durable.EntryRecord): EntryRecord {
  return {
    ...record,
    __typename: "EntryRecord",
    id: globalId("EntryRecord", owner.externalId, record.id),
    durableId: record.id,
    harness: owner,
    model: record.model?.map(message) ?? null,
    edits:
      record.edits?.map((edit) =>
        edit.action === "replace" ? { ...edit, messages: edit.messages.map(message) } : edit,
      ) ?? null,
  };
}

/**
 * Globally refetchable identity. IDs encode object type, persisted session identity,
 * and the durable ID where applicable. They survive Harness reopen and are never
 * reused for replacement storage. An inherited entry has the same ID in every
 * conversation. Clients must not decode IDs.
 *
 * Each resolver reads independently. Repeated IDs do not imply a shared snapshot
 * across node(), connections, or inspection while the Harness is mutating.
 * @gqlInterface
 */
interface Node {
  /** @gqlField */
  readonly id: ID;
}

/**
 * Refetch any Node by global ID; null if it no longer exists or cannot be fetched.
 * @gqlQueryField
 */
export async function node(id: ID, ctx: ResolverContext): Promise<Node | null> {
  try {
    const target = identity(id);
    const instance = await ctx.session(target.externalId);
    if (!instance) return null;
    const owner = harnessNode(target.externalId);
    if (target.kind === "Harness") return owner;
    switch (target.kind) {
      case "ConversationRecord": {
        const record = await instance.commit(
          (tx) => tx.conversation(checked(ConversationId, target.durableId)),
          ctx.context,
        );
        return record ? projectConversation(owner, record) : null;
      }
      case "EntryRecord": {
        const record = await instance.commit(
          (tx) => tx.entry(checked(EntryId, target.durableId)),
          ctx.context,
        );
        return record ? entryRecord(owner, record) : null;
      }
      case "TaskRecord": {
        const record = await instance.commit(
          (tx) => tx.task(checked(TaskId, target.durableId)),
          ctx.context,
        );
        return record ? projectTask(owner, record) : null;
      }
      case "SubmissionRecord": {
        const handle = await instance.submission(
          checked(SubmissionId, target.durableId),
          ctx.context,
        );
        const record = await handle?.status(ctx.context);
        return record ? projectSubmission(owner, record) : null;
      }
    }
  } catch (error) {
    throw mapError(error);
  }
}

/** @gqlType */
interface Harness extends Node {
  readonly __typename: "Harness";

  /** @gqlField */
  readonly id: ID;
  /** @gqlField */
  readonly externalId: string;
}

/**
 * Resolve a persisted Harness by its external session key; does not create one.
 * @gqlQueryField
 */
export async function harness(externalId: string, ctx: ResolverContext): Promise<Harness | null> {
  try {
    return (await ctx.session(externalId)) ? harnessNode(externalId) : null;
  } catch (error) {
    throw mapError(error);
  }
}

/**
 * List accessible persisted sessions from the deployment's catalog, not the cache
 * of open Harness instances. Durable does not provide a cross-session catalog.
 * Order by ascending externalId; listing does not create sessions or enable scheduling.
 * @gqlQueryField
 */
export async function harnesses(ctx: ResolverContext): Promise<Harness[]> {
  try {
    const sessions = [...(await ctx.sessions())].sort();
    assert.equal(new Set(sessions).size, sessions.length);
    return sessions.map(harnessNode);
  } catch (error) {
    throw mapError(error);
  }
}

/**
 * Service-scoped available chat models in upstream order, without pagination.
 * Reads the deployment's current model source per call; never acquires a Harness,
 * refreshes the catalog, or starts generation. Availability does not guarantee
 * that a subsequent model request succeeds. An empty catalog is an empty list.
 * @gqlQueryField
 */
export async function models(ctx: ResolverContext): Promise<Model[]> {
  try {
    const signal = ctx.context.abortSignal;
    const available = await ctx
      .models()
      .getAvailable(undefined, signal === undefined ? undefined : { signal });
    return available.map((model) => ({
      id: model.id,
      provider: model.provider,
      name: model.name,
      input: model.input,
      reasoning: model.reasoning,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      cost: model.cost,
      thinkingLevels: getSupportedThinkingLevels(model),
    }));
  } catch (error) {
    throw mapError(error);
  }
}

/**
 * Public Pi AI chat-model metadata, not a persisted Node or selected default.
 * @gqlType
 */
interface Model {
  /** Native model ID; pair with provider. Becomes modelId in ModelRefInput. @gqlField */
  readonly id: string;
  /** @gqlField */
  readonly provider: string;
  /** @gqlField */
  readonly name: string;
  /** @gqlField */
  readonly input: ReadonlyArray<ModelInputModality>;
  /** @gqlField */
  readonly reasoning: boolean;
  /** @gqlField */
  readonly contextWindow: Float;
  /** @gqlField */
  readonly maxTokens: Float;
  /** Catalog prices, not accumulated message usage. @gqlField */
  readonly cost: ModelCost;
  /** Pi AI getSupportedThinkingLevels(), not a default selection. @gqlField */
  readonly thinkingLevels: ReadonlyArray<ModelThinkingLevel>;
}

/**
 * Upstream ModelInputModality.
 * @gqlEnum
 */
type ModelInputModality = "text" | "image";

/** @gqlType */
interface ModelCost {
  /** @gqlField */
  readonly input: Float;
  /** @gqlField */
  readonly output: Float;
  /** @gqlField */
  readonly cacheRead: Float;
  /** @gqlField */
  readonly cacheWrite: Float;
  /** @gqlField */
  readonly tiers?: ReadonlyArray<ModelCostTier> | null;
}

/** @gqlType */
interface ModelCostTier {
  /** @gqlField */
  readonly inputTokensAbove: Float;
  /** @gqlField */
  readonly input: Float;
  /** @gqlField */
  readonly output: Float;
  /** @gqlField */
  readonly cacheRead: Float;
  /** @gqlField */
  readonly cacheWrite: Float;
}

/**
 * Resolve Harness.conversation(id); expose its record instead of a live handle.
 * @gqlField
 */
export function conversation(
  source: Harness,
  id: ConversationId,
  ctx: ResolverContext,
): Promise<ConversationRecord | null> {
  return node(
    globalId("ConversationRecord", source.externalId, id),
    ctx,
  ) as Promise<ConversationRecord | null>;
}

/**
 * Harness.inspect(): live work and scheduling state, without enabling scheduling.
 * @gqlField
 */
export async function inspect(source: Harness, ctx: ResolverContext): Promise<HarnessInspection> {
  try {
    const instance = await requireHarness(ctx, source);
    const value = await instance.inspect(ctx.context);
    return {
      scheduling: value.scheduling,
      tasks: value.tasks.map(({ record, state }) => ({
        record: projectTask(source, record),
        state:
          state.kind === "blocked" && state.error !== undefined
            ? { ...state, error: jsonValue(state.error) }
            : state.kind === "blocked"
              ? { kind: state.kind, reason: state.reason }
              : state,
      })),
      submissions: value.submissions.map((record) => projectSubmission(source, record)),
    };
  } catch (error) {
    throw mapError(error);
  }
}

/**
 * Tx.scanConversations(); default order is ascending, or the cursor's order.
 * @gqlField
 */
export async function scanConversations(
  source: Harness,
  ctx: ResolverContext,
  limit: Int,
  query: ConversationQuery = {},
  cursor?: Cursor | null,
): Promise<Connection<ConversationRecord>> {
  try {
    checked(PageLimit, limit);
    const filters = nonNull(query);
    const instance = await requireHarness(ctx, source);
    const page = await instance.commit(
      (tx) => tx.scanConversations(filters, limit, cursor ?? undefined),
      ctx.context,
    );
    return connection(page, (record) => projectConversation(source, record));
  } catch (error) {
    throw mapError(error);
  }
}

/**
 * Tx.scanTasks(); default order is ascending, or the cursor's order.
 * @gqlField
 */
export async function scanTasks(
  source: Harness,
  ctx: ResolverContext,
  limit: Int,
  query: TaskQuery = {},
  cursor?: Cursor | null,
): Promise<Connection<TaskRecord>> {
  try {
    checked(PageLimit, limit);
    const filters = nonNull(query);
    const instance = await requireHarness(ctx, source);
    const page = await instance.commit(
      (tx) => tx.scanTasks(filters, limit, cursor ?? undefined),
      ctx.context,
    );
    return connection(page, (record) => projectTask(source, record));
  } catch (error) {
    throw mapError(error);
  }
}

/**
 * ConversationRecord, augmented with scoped Conversation operations, the read-only
 * Tx.submissionByRequest lookup, and Submission.status. Handles stay server-side.
 * @gqlType
 */
interface ConversationRecord extends Node {
  readonly __typename: "ConversationRecord";

  /** @gqlField */
  readonly id: ID;
  /** @gqlField */
  readonly durableId: ConversationId;
  /** @gqlField */
  readonly harness: Harness;
  /** @gqlField */
  readonly parent?: ConversationRecordParent | null;
  /** @gqlField */
  readonly owner?: ConversationRecordOwner | null;
}

/**
 * Conversation.agent(): settings resolved against the current registry and host
 * settings, not just stored overrides. Does not enable scheduling.
 * @gqlField
 */
export async function agent(source: ConversationRecord, ctx: ResolverContext): Promise<Agent> {
  try {
    const value = await (await requireConversation(ctx, source)).agent(ctx.context);
    return {
      model: value.model ?? null,
      thinkingLevel: value.thinkingLevel,
      cwd: value.cwd ?? null,
      instructions: value.instructions ?? null,
    };
  } catch (error) {
    throw mapError(error);
  }
}

/**
 * Readable settings from upstream Agent. Runtime extensions, tools, and prompt
 * section callbacks remain server-side.
 * @gqlType
 */
interface Agent {
  /** @gqlField */
  readonly model?: ModelRef | null;
  /** @gqlField */
  readonly thinkingLevel: ModelThinkingLevel;
  /**
   * Directory within the environment's file system; null when unset.
   * @gqlField
   */
  readonly cwd?: string | null;
  /**
   * Additional instructions, not the rendered extension prompt sections.
   * @gqlField
   */
  readonly instructions?: string | null;
}

/**
 * Output representation of upstream ModelRef; ModelRefInput is the mutation input type.
 * @gqlType
 */
interface ModelRef {
  /** @gqlField */
  readonly provider: string;
  /** @gqlField */
  readonly modelId: string;
}

/**
 * Fork-aware history, including inherited entries. Default order is descending.
 * @gqlField
 */
export async function entries(
  source: ConversationRecord,
  ctx: ResolverContext,
  limit: Int,
  query: EntryQuery = {},
  cursor?: Cursor | null,
): Promise<Connection<EntryRecord>> {
  try {
    checked(PageLimit, limit);
    const filters = nonNull(query);
    const instance = await requireConversation(ctx, source);
    const page = await instance.entries(filters, limit, cursor ?? undefined, ctx.context);
    return connection(page, (record) => entryRecord(source.harness, record));
  } catch (error) {
    throw mapError(error);
  }
}

/**
 * Current context when at is omitted; otherwise context through that visible entry.
 * @gqlField
 */
export async function context(
  source: ConversationRecord,
  ctx: ResolverContext,
  at?: EntryId | null,
): Promise<ContextView> {
  try {
    if (at === null) throw new ResolverError("BAD_REQUEST");
    const value = await (
      await requireConversation(ctx, source)
    ).context(ctx.context, at === undefined ? {} : { at });
    return {
      head: value.head ? entryRecord(source.harness, value.head) : null,
      entries: value.entries.map((entry) => entryRecord(source.harness, entry)),
      contributions: value.contributions.map((messages) => messages.map(message)),
      messages: value.messages.map(message),
    };
  } catch (error) {
    throw mapError(error);
  }
}

/**
 * Conversation-scoped Tx.submissionByRequest(). Null means absent at observation,
 * not that a concurrent or disconnected submission failed to commit.
 * @gqlField
 */
export async function submissionByRequest(
  source: ConversationRecord,
  requestId: string,
  ctx: ResolverContext,
): Promise<SubmissionRecord | null> {
  try {
    const instance = await requireHarness(ctx, source.harness);
    const record = await instance.commit(
      (tx) => tx.submissionByRequest(source.durableId, requestId),
      ctx.context,
    );
    return record ? projectSubmission(source.harness, record) : null;
  } catch (error) {
    throw mapError(error);
  }
}

/**
 * Reacquire Harness.submission(id), then read Submission.status(). Null for an
 * absent submission or one belonging to another conversation; never waits.
 * @gqlField
 */
export async function status(
  source: ConversationRecord,
  id: SubmissionId,
  ctx: ResolverContext,
): Promise<SubmissionRecord | null> {
  try {
    const record = (await node(
      globalId("SubmissionRecord", source.harness.externalId, id),
      ctx,
    )) as SubmissionRecord | null;
    return record?.conversationId === source.durableId ? record : null;
  } catch (error) {
    throw mapError(error);
  }
}

/**
 * GraphQL name for NonNullable<ConversationRecord["parent"]>.
 * @gqlType
 */
interface ConversationRecordParent {
  /** @gqlField */
  readonly conversationId: ConversationId;
  /** @gqlField */
  readonly at: EntryId;
}

/**
 * GraphQL name for NonNullable<ConversationRecord["owner"]>.
 * @gqlType
 */
interface ConversationRecordOwner {
  /** @gqlField */
  readonly conversationId: ConversationId;
  /** @gqlField */
  readonly taskId: TaskId;
}

/** @gqlType */
interface EntryRecord extends Node {
  readonly __typename: "EntryRecord";

  /** @gqlField */
  readonly id: ID;
  /** @gqlField */
  readonly durableId: EntryId;
  /** @gqlField */
  readonly harness: Harness;
  /** @gqlField */
  readonly conversationId: ConversationId;
  /** @gqlField */
  readonly kind: string;
  /** @gqlField */
  readonly model?: ReadonlyArray<Message> | null;
  /**
   * Unmodified application payload; explicit JSON null is retained.
   * @gqlField
   */
  readonly data?: JsonValue | null;
  /** @gqlField */
  readonly head?: EntryId | null;
  /** @gqlField */
  readonly edits?: ReadonlyArray<ContextEdit> | null;
  /** @gqlField */
  readonly byTaskId?: TaskId | null;
}

/** @gqlType */
interface ContextEdit {
  /** @gqlField */
  readonly target: EntryId;
  /** @gqlField */
  readonly action: ContextEditAction;
  /**
   * Present exactly when action is replace; omitted model content is not pre-rendered.
   * @gqlField
   */
  readonly messages?: ReadonlyArray<Message> | null;
}

/**
 * GraphQL name for ContextEdit["action"].
 * @gqlEnum
 */
type ContextEditAction = "omit" | "replace";

/** @gqlType */
interface ContextView {
  /** @gqlField */
  readonly head?: EntryRecord | null;
  /** @gqlField */
  readonly entries: ReadonlyArray<EntryRecord>;
  /**
   * One message array per entry, before tool-result ordering; preserve empty arrays.
   * @gqlField
   */
  readonly contributions: ReadonlyArray<ReadonlyArray<Message>>;
  /** @gqlField */
  readonly messages: ReadonlyArray<Message>;
}

/**
 * Complete SubmissionRecord. Status-dependent fields follow upstream invariants:
 * input done has entry and answer; write done has entry only; placed is input-only;
 * unanswered has reason and optional detail, with optional entry only for input.
 * Queued records have none of entry, answer, reason, or detail.
 * @gqlType
 */
interface SubmissionRecord extends Node {
  readonly __typename: "SubmissionRecord";

  /** @gqlField */
  readonly id: ID;
  /** @gqlField */
  readonly durableId: SubmissionId;
  /** @gqlField */
  readonly harness: Harness;
  /** @gqlField */
  readonly conversationId: ConversationId;
  /** @gqlField */
  readonly requestId?: string | null;
  /** @gqlField */
  readonly trace?: TelemetryCarrier | null;
  /** @gqlField */
  readonly type: SubmissionRecordType;
  /** @gqlField */
  readonly status: SubmissionRecordStatus;
  /** @gqlField */
  readonly entry?: EntryId | null;
  /** @gqlField */
  readonly answer?: EntryId | null;
  /** @gqlField */
  readonly reason?: string | null;
  /** @gqlField */
  readonly detail?: JsonValue | null;
}

/**
 * GraphQL name for SubmissionRecord["type"].
 * @gqlEnum
 */
type SubmissionRecordType = "input" | "write";

/**
 * GraphQL name for SubmissionRecord["status"].
 * @gqlEnum
 */
type SubmissionRecordStatus = "queued" | "placed" | "done" | "unanswered";

/**
 * Complete TaskRecord; task input, checkpoints, memos, traces, and outcomes remain JSON.
 * @gqlType
 */
interface TaskRecord extends Node {
  readonly __typename: "TaskRecord";

  /** @gqlField */
  readonly id: ID;
  /** @gqlField */
  readonly durableId: TaskId;
  /** @gqlField */
  readonly harness: Harness;
  /** @gqlField */
  readonly conversationId: ConversationId;
  /** @gqlField */
  readonly kind: string;
  /** @gqlField */
  readonly version: Float;
  /** @gqlField */
  readonly input?: JsonValue | null;
  /** @gqlField */
  readonly owner?: TaskId | null;
  /** @gqlField */
  readonly background: boolean;
  /** @gqlField */
  readonly abortRequested: boolean;
  /** @gqlField */
  readonly abortReason?: TaskRecordAbortReason | null;
  /** @gqlField */
  readonly abandonOnRestart?: boolean | null;
  /**
   * Upstream wall-clock milliseconds, not seconds or an ISO string.
   * @gqlField
   */
  readonly startedAt?: Float | null;
  /** @gqlField */
  readonly endedAt?: Float | null;
  /** @gqlField */
  readonly restarts?: Float | null;
  /** @gqlField */
  readonly trace?: TelemetryCarrier | null;
  /** @gqlField */
  readonly links?: ReadonlyArray<TelemetryCarrier> | null;
  /** @gqlField */
  readonly state: TaskState;
  /**
   * Absent for completing and terminal tasks.
   * @gqlField
   */
  readonly memos?: JsonObject | null;
}

/**
 * GraphQL name for NonNullable<TaskRecord["abortReason"]>.
 * @gqlEnum
 */
type TaskRecordAbortReason = "restart";

/**
 * Status-discriminated upstream state. pending/running/waiting/sleeping carry
 * checkpoint; waiting also carries on and policy; sleeping carries until.
 * completing/terminal carry outcome instead of checkpoint. JSON null checkpoints
 * are valid. Fields not belonging to the status return null.
 * @gqlType
 */
interface TaskState {
  /** @gqlField */
  readonly status: TaskStateStatus;
  /** @gqlField */
  readonly checkpoint?: JsonValue | null;
  /** @gqlField */
  readonly on?: ReadonlyArray<TaskId> | null;
  /** @gqlField */
  readonly policy?: JoinPolicy | null;
  /** @gqlField */
  readonly until?: Float | null;
  /** @gqlField */
  readonly outcome?: TaskOutcome | null;
}

/**
 * GraphQL name for TaskState["status"].
 * @gqlEnum
 */
type TaskStateStatus = "pending" | "running" | "waiting" | "sleeping" | "completing" | "terminal";

/** @gqlEnum */
type JoinPolicy = "failFast" | "allSettled";

/**
 * completed carries result; failed carries error and optional result; aborted
 * carries optional reason/result; orphaned carries reason; faulted carries error.
 * No other variant-specific fields are populated. A JSON null result is valid.
 * @gqlType
 */
interface TaskOutcome {
  /** @gqlField */
  readonly status: TaskOutcomeStatus;
  /** @gqlField */
  readonly result?: JsonValue | null;
  /** @gqlField */
  readonly error?: TaskOutcomeError | null;
  /** @gqlField */
  readonly reason?: string | null;
}

/**
 * GraphQL name for TaskOutcome["status"].
 * @gqlEnum
 */
type TaskOutcomeStatus = "completed" | "failed" | "aborted" | "orphaned" | "faulted";

/** @gqlType */
interface TaskOutcomeError {
  /** @gqlField */
  readonly message: string;
  /** @gqlField */
  readonly detail?: JsonValue | null;
}

/** @gqlType */
interface HarnessInspection {
  /** @gqlField */
  readonly scheduling: HarnessInspectionScheduling;
  /** @gqlField */
  readonly tasks: ReadonlyArray<TaskInspection>;
  /**
   * Queued and placed submissions, in upstream ID order.
   * @gqlField
   */
  readonly submissions: ReadonlyArray<SubmissionRecord>;
}

/**
 * GraphQL name for HarnessInspection["scheduling"].
 * @gqlEnum
 */
type HarnessInspectionScheduling = "paused" | "running" | "closing";

/** @gqlType */
interface TaskInspection {
  /** @gqlField */
  readonly record: TaskRecord;
  /** @gqlField */
  readonly state: TaskInspectionState;
}

/**
 * GraphQL name for TaskInspection["state"].
 * Every upstream inspection discriminant is retained. ready carries migrates;
 * waiting carries on; sleeping carries until; blocked carries reason and optional
 * error. running/completing carry only kind. Other fields return null.
 * @gqlType
 */
interface TaskInspectionState {
  /** @gqlField */
  readonly kind: TaskInspectionStateKind;
  /** @gqlField */
  readonly migrates?: boolean | null;
  /** @gqlField */
  readonly on?: ReadonlyArray<TaskId> | null;
  /** @gqlField */
  readonly until?: Float | null;
  /** @gqlField */
  readonly reason?: BlockedReason | null;
  /**
   * Upstream unknown/Error serialized with JSON.stringify, not a GraphQL error.
   * @gqlField
   */
  readonly error?: JsonValue | null;
}

/**
 * GraphQL name for TaskInspection["state"]["kind"].
 * @gqlEnum
 */
type TaskInspectionStateKind =
  | "running"
  | "ready"
  | "waiting"
  | "sleeping"
  | "completing"
  | "blocked";

/** @gqlEnum */
type BlockedReason = "missing_task" | "task_too_old" | "migration_failed" | "restart_limit";

/** @gqlEnum */
type ScanOrder = "ascending" | "descending";

/** @gqlInput */
interface ConversationQuery {
  readonly ownerConversationId?: ConversationId | null;
  readonly ownerTaskId?: TaskId | null;
  readonly order?: ScanOrder | null;
}

/**
 * Omit<EntryQuery, "conversationId">, as accepted by Conversation.entries().
 * The addressed conversation supplies conversationId.
 * @gqlInput
 */
interface EntryQuery {
  /** Inclusive lower ID bound; includes inherited history. */
  readonly minEntryId?: EntryId | null;
  /** Inclusive upper ID bound. */
  readonly maxEntryId?: EntryId | null;
  readonly order?: ScanOrder | null;
}

/** @gqlInput */
interface TaskQuery {
  readonly conversationId?: ConversationId | null;
  readonly kind?: string | null;
  readonly status?: TaskStateStatus | null;
  readonly abortRequested?: boolean | null;
  readonly background?: boolean | null;
  readonly order?: ScanOrder | null;
}

/**
 * Upstream page continuation. Null means the backend returned no next cursor.
 * @gqlType
 */
interface PageInfo {
  /** @gqlField */
  readonly next?: Cursor | null;
}

/**
 * One upstream page. limit must be positive; cursor belongs to the upstream scan.
 * @gqlType
 */
type Connection<T extends Node> = {
  /** @gqlField */
  nodes: T[];
  /** @gqlField */
  pageInfo: PageInfo;
};

/** @gqlInput */
interface SubmitInput {
  /** Global ConversationRecord ID, not its numeric durableId. */
  readonly conversationId: ID;
  readonly submission: SubmissionDraft;
}

/**
 * Exactly one upstream SubmissionDraft variant; the selection supplies type.
 * @gqlInput
 */
type SubmissionDraft = { input: InputSubmissionDraft } | { write: WriteSubmissionDraft };

/** @gqlInput */
interface InputSubmissionDraft {
  readonly content: UserInput;
  readonly requestId?: string | null;
  readonly whenBusy?: InputSubmissionDraftWhenBusy | null;
  readonly entry?: InputEntry | null;
}

/** @gqlInput */
interface WriteSubmissionDraft {
  readonly entry: EntryDraft;
  readonly requestId?: string | null;
}

/** @gqlInput */
interface InputEntry {
  /** Application kind; nonempty and outside the reserved pi. prefix. */
  readonly kind: string;
  /** Optional JSON payload; explicit null is allowed. */
  readonly data?: JsonValue | null;
}

/**
 * GraphQL name for NonNullable<InputSubmissionDraft["whenBusy"]>.
 * @gqlEnum
 */
type InputSubmissionDraftWhenBusy = "steer" | "followUp" | "reject";

/** @gqlInput */
interface EntryDraft {
  readonly kind: string;
  /** Optional JSON payload; explicit null is allowed. */
  readonly data?: JsonValue | null;
  /** Omit for display-only data; even an empty array is a context-affecting write. */
  readonly model?: ReadonlyArray<MessageInput> | null;
  readonly head?: EntryHead | null;
  readonly edits?: ReadonlyArray<ContextEditInput> | null;
}

const EntryHead = Type.Union([EntryId, Type.Literal("self")]);
/**
 * Upstream EntryDraft.head: a native EntryId or the literal string "self".
 * @gqlScalar
 */
export type EntryHead = Type.Static<typeof EntryHead>;

/** @gqlInput */
type ContextEditInput = { omit: EntryId } | { replace: ContextReplacementInput };

/** @gqlInput */
interface ContextReplacementInput {
  readonly target: EntryId;
  readonly messages: ReadonlyArray<MessageInput>;
}

/** @gqlInput */
type MessageInput =
  | { system: SystemMessageInput }
  | { user: UserMessageInput }
  | { assistant: AssistantMessageInput }
  | { toolResult: ToolResultMessageInput };

/** @gqlInput */
interface SystemMessageInput {
  readonly content: SystemMessageContentInput;
  /** Named prompt sections; each value must be a string or null. */
  readonly sections?: JsonObject | null;
  readonly toolsAdded?: ReadonlyArray<ToolInput> | null;
  readonly toolsRemoved?: ReadonlyArray<ToolReferenceInput> | null;
  readonly timestamp: Float;
}

/** @gqlInput */
type SystemMessageContentInput = { text: string } | { blocks: ReadonlyArray<TextContentInput> };

/** @gqlInput */
interface UserMessageInput {
  readonly content: UserInput;
  readonly timestamp: Float;
}

/** @gqlInput */
interface AssistantMessageInput {
  readonly content: ReadonlyArray<AssistantContentInput>;
  readonly api: string;
  readonly provider: string;
  readonly model: string;
  readonly responseModel?: string | null;
  readonly responseId?: string | null;
  readonly providerThinkingLevel?: string | null;
  readonly thinkingLevel?: ModelThinkingLevel | null;
  readonly diagnostics?: ReadonlyArray<MessageDiagnosticInput> | null;
  readonly usage: UsageInput;
  readonly stopReason: StopReason;
  readonly deferred?: DeferredHandleInput | null;
  readonly errorMessage?: string | null;
  readonly rawStopReason?: string | null;
  readonly endTurn?: boolean | null;
  readonly timestamp: Float;
  readonly durationMs?: Float | null;
}

/** @gqlInput */
type AssistantContentInput =
  | { text: TextContentInput }
  | { thinking: ThinkingContentInput }
  | { toolCall: ToolCallInput };

/** @gqlInput */
interface ThinkingContentInput {
  readonly thinking: string;
  readonly thinkingSignature?: string | null;
  readonly redacted?: boolean | null;
}

/** @gqlInput */
interface ToolCallInput {
  readonly id: string;
  readonly name: string;
  readonly arguments: JsonObject;
  readonly thoughtSignature?: string | null;
  readonly namespace?: string | null;
  readonly argumentsError?: string | null;
}

/** @gqlInput */
interface ToolResultMessageInput {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly content: ReadonlyArray<UserInputBlock>;
  /** Optional JSON payload; explicit null is allowed. */
  readonly details?: JsonValue | null;
  readonly usage?: UsageInput | null;
  readonly nestedCalls?: NestedToolCallsInput | null;
  readonly isError: boolean;
  readonly timestamp: Float;
  readonly durationMs?: Float | null;
}

/** @gqlInput */
interface UsageInput {
  readonly input: Float;
  readonly output: Float;
  readonly cacheRead: Float;
  readonly cacheWrite: Float;
  readonly cacheWrite1h?: Float | null;
  readonly reasoning?: Float | null;
  readonly totalTokens: Float;
  readonly cost: UsageCostInput;
}

/** @gqlInput */
interface UsageCostInput {
  readonly input: Float;
  readonly output: Float;
  readonly cacheRead: Float;
  readonly cacheWrite: Float;
  readonly total: Float;
}

/** @gqlInput */
interface DeferredHandleInput {
  readonly provider: string;
  readonly modelId: string;
  readonly api: string;
  readonly id: string;
  readonly expiresAt?: Float | null;
  readonly pollAfterMs?: Float | null;
  /** Optional JSON payload; explicit null is allowed. */
  readonly data?: JsonValue | null;
}

/** @gqlInput */
interface ToolInput {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonObject;
  /** Upstream false or ConstrainedSamplingConfig; omit when absent. */
  readonly constrainedSampling?: JsonValue | null;
}

/** @gqlInput */
interface ToolReferenceInput {
  readonly name: string;
}

/** @gqlInput */
interface MessageDiagnosticInput {
  readonly type: string;
  readonly timestamp: Float;
  readonly error?: DiagnosticErrorInput | null;
  readonly details?: JsonObject | null;
}

/** @gqlInput */
interface DiagnosticErrorInput {
  readonly name?: string | null;
  readonly message: string;
  readonly stack?: string | null;
  /** Upstream string or number code; omit when absent. */
  readonly code?: JsonValue | null;
}

/** @gqlInput */
interface NestedToolCallsInput {
  readonly calls: ReadonlyArray<NestedToolCallRecordInput>;
  readonly complete: boolean;
}

/** @gqlInput */
interface NestedToolCallRecordInput {
  readonly id: string;
  readonly name: string;
  readonly arguments?: JsonObject | null;
  readonly argumentsBytes?: Float | null;
  readonly status: NestedToolCallStatus;
  readonly durationMs?: Float | null;
  readonly error?: string | null;
}

// pi-ai 1.4.0 dist/types.d.ts: SystemMessage.sections and ConstrainedSamplingConfig.
const PromptSections = Type.Record(JsonKey, Type.Union([Type.String(), Type.Null()]), {
  additionalProperties: false,
});
const ConstrainedSampling = Type.Union([
  Type.Literal(false),
  Type.Object(
    { type: Type.Literal("json_schema"), strict: Type.Enum(["prefer", "require"]) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("grammar"),
      variants: Type.Object(
        {
          openai_lark: Type.Optional(Type.String()),
          openai_regex: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
]);
// pi-ai 1.4.0 dist/utils/diagnostics.d.ts: DiagnosticErrorInfo.code.
const DiagnosticCode = Type.Union([Type.String(), Type.Number()]);

function assistantInputContent(
  block: AssistantContentInput,
): AI.AssistantMessage["content"][number] {
  switch (true) {
    case "text" in block:
      return { type: "text", ...nonNull(block.text) };
    case "thinking" in block:
      return { type: "thinking", ...nonNull(block.thinking) };
    case "toolCall" in block:
      return { type: "toolCall", ...nonNull(block.toolCall) };
    default:
      return unreachable(block);
  }
}

function inputMessage(input: MessageInput): AI.Message {
  switch (true) {
    case "system" in input: {
      const { content, sections, toolsAdded, toolsRemoved, ...fields } = nonNull(input.system);
      const result: AI.SystemMessage = {
        ...fields,
        role: "system",
        content:
          "text" in content
            ? content.text
            : content.blocks.map((block): AI.TextContent => ({ type: "text", ...nonNull(block) })),
      };
      if (sections !== undefined) result.sections = checked(PromptSections, sections);
      if (toolsRemoved !== undefined)
        result.toolsRemoved = toolsRemoved.map((tool) => ({ ...tool }));
      if (toolsAdded !== undefined)
        result.toolsAdded = toolsAdded.map((tool) => {
          const { constrainedSampling, ...fields } = nonNull(tool);
          const result: AI.Tool = fields;
          if (constrainedSampling !== undefined)
            result.constrainedSampling = checked(ConstrainedSampling, constrainedSampling);
          return result;
        });
      return result;
    }
    case "user" in input:
      return {
        role: "user",
        timestamp: input.user.timestamp,
        content: inputContent(input.user.content),
      };
    case "assistant" in input: {
      const { content, usage, diagnostics, deferred, ...fields } = nonNull(input.assistant);
      const result: AI.AssistantMessage = {
        ...fields,
        role: "assistant",
        content: content.map(assistantInputContent),
        usage: nonNull(usage),
      };
      if (diagnostics !== undefined)
        result.diagnostics = diagnostics.map((entry) => {
          const { error, ...fields } = nonNull(entry);
          const result: AI.AssistantMessageDiagnostic = fields;
          if (error !== undefined) {
            const { code, ...fields } = nonNull(error);
            result.error = fields;
            if (code !== undefined) result.error.code = checked(DiagnosticCode, code);
          }
          return result;
        });
      if (deferred !== undefined) {
        const { data, ...fields } = deferred;
        result.deferred = nonNull(fields);
        if (data !== undefined) result.deferred.data = data;
      }
      return result;
    }
    case "toolResult" in input: {
      const { details, ...rest } = input.toolResult;
      const { content, usage, nestedCalls, ...fields } = nonNull(rest);
      const result: AI.ToolResultMessage = {
        ...fields,
        role: "toolResult",
        content: content.map(inputBlock),
      };
      if (details !== undefined) result.details = details;
      if (usage !== undefined) result.usage = nonNull(usage);
      if (nestedCalls !== undefined)
        result.nestedCalls = {
          ...nestedCalls,
          calls: nestedCalls.calls.map((call) => nonNull(call)),
        };
      return result;
    }
    default:
      return unreachable(input);
  }
}

function inputEdit(input: ContextEditInput): Durable.ContextEdit {
  switch (true) {
    case "omit" in input:
      return { target: input.omit, action: "omit" };
    case "replace" in input:
      return {
        target: input.replace.target,
        action: "replace",
        messages: input.replace.messages.map(inputMessage),
      };
    default:
      return unreachable(input);
  }
}

function submissionDraft(input: SubmissionDraft): Durable.SubmissionDraft {
  switch (true) {
    case "input" in input: {
      const fields = nonNull(input.input);
      if (
        fields.entry !== undefined &&
        (fields.entry.kind.length === 0 || fields.entry.kind.startsWith("pi."))
      )
        throw new ResolverError("BAD_REQUEST");
      return { ...fields, type: "input", content: inputContent(fields.content) };
    }
    case "write" in input: {
      const { entry, ...fields } = nonNull(input.write);
      const { data, ...rest } = entry;
      const { model, edits, ...shape } = nonNull(rest);
      return {
        ...fields,
        type: "write",
        entry: {
          ...shape,
          ...(data === undefined ? {} : { data }),
          ...(model === undefined ? {} : { model: model.map(inputMessage) }),
          ...(edits === undefined ? {} : { edits: edits.map(inputEdit) }),
        },
      };
    }
    default:
      return unreachable(input);
  }
}

/** @gqlType */
interface SubmitPayload {
  /**
   * Transport reference to Submission.id as a global SubmissionRecord ID.
   * node(id) reads its receipt; this payload is not itself the submission Node.
   * @gqlField
   */
  readonly submissionId: ID;
}

/**
 * Admit input or a passive entry write, not necessarily placement or completion.
 * Same requestId and type recover the prior submission without comparing content.
 * A key used for another type retains the untyped-error fallback. ConversationBusy means not admitted.
 * @gqlMutationField
 */
export async function submit(
  input: SubmitInput,
  ctx: ResolverContext,
): Promise<SubmitPayload | null> {
  try {
    const { source, handle } = await mutationConversation(ctx, input.conversationId);
    const result = await handle.submit(submissionDraft(input.submission), ctx.context);
    return {
      submissionId: globalId("SubmissionRecord", source.harness.externalId, result.id),
    };
  } catch (error) {
    throw mapError(error);
  }
}

/** @gqlInput */
interface AbortSubmissionInput {
  /** Global ConversationRecord ID; upstream abort is constrained to this conversation. */
  readonly conversationId: ID;
  readonly id: SubmissionId;
}

/** @gqlType */
interface AbortSubmissionPayload {
  /** @gqlField */
  readonly result: HarnessAbortSubmissionResult;
}

/**
 * Withdraw a queued submission; already_placed never becomes an execution abort.
 * @gqlMutationField
 */
export async function abortSubmission(
  input: AbortSubmissionInput,
  ctx: ResolverContext,
): Promise<AbortSubmissionPayload | null> {
  try {
    const { source } = await mutationConversation(ctx, input.conversationId);
    const instance = await requireHarness(ctx, source.harness);
    const result = await instance.abortSubmission(input.id, ctx.context, source.durableId);
    return { result };
  } catch (error) {
    throw mapError(error);
  }
}

/**
 * GraphQL name for Awaited<ReturnType<Harness["abortSubmission"]>>.
 * @gqlEnum
 */
type HarnessAbortSubmissionResult =
  | "aborted"
  | "already_placed"
  | "settled"
  /** Unknown submission or one belonging to another conversation; not an error. */
  | "not_found";

/** @gqlInput */
interface AbortInput {
  readonly conversationId: ID;
}

/**
 * Withdraw queued inputs and abort ordinary owned work; preserve background work
 * and queued writes. Resolves after upstream abort completes. No background flag.
 * @gqlMutationField
 */
export async function abort(input: AbortInput, ctx: ResolverContext): Promise<boolean | null> {
  try {
    const { handle } = await mutationConversation(ctx, input.conversationId);
    await handle.abort(ctx.context);
    return true;
  } catch (error) {
    throw mapError(error);
  }
}

/** @gqlInput */
interface ResumeInput {
  /** Global Harness ID, not its externalId key. */
  readonly harnessId: ID;
}

/**
 * Return true after enabling Harness scheduling, not after work completes.
 * @gqlMutationField
 */
export async function resume(input: ResumeInput, ctx: ResolverContext): Promise<boolean | null> {
  try {
    const target = identity(input.harnessId);
    if (target.kind !== "Harness") throw new ResolverError("BAD_REQUEST");
    const instance = await ctx.session(target.externalId);
    if (!instance) throw new ResolverError("NOT_FOUND");
    instance.resume();
    return true;
  } catch (error) {
    throw mapError(error);
  }
}

/** @gqlInput */
interface ResetInput {
  readonly conversationId: ID;
  /** Omit for no handoff; preserve a supplied string, including the empty string. */
  readonly handoff?: string | null;
}

/**
 * Return true after reset admission, not necessarily placement. No idempotency key.
 * @gqlMutationField
 */
export async function reset(input: ResetInput, ctx: ResolverContext): Promise<boolean | null> {
  try {
    if (input.handoff === null) throw new ResolverError("BAD_REQUEST");
    const { handle } = await mutationConversation(ctx, input.conversationId);
    await handle.reset(input.handoff, ctx.context);
    return true;
  } catch (error) {
    throw mapError(error);
  }
}

/** @gqlInput */
interface CompactInput {
  readonly conversationId: ID;
  readonly instructions?: string | null;
}

/** @gqlType */
interface CompactPayload {
  /**
   * Global TaskRecord ID corresponding to compact()'s admitted upstream TaskId.
   * @gqlField
   */
  readonly taskId: ID;
}

/**
 * Admit compaction; task completion and summary placement remain separate.
 * @gqlMutationField
 */
export async function compact(
  input: CompactInput,
  ctx: ResolverContext,
): Promise<CompactPayload | null> {
  try {
    if (input.instructions === null) throw new ResolverError("BAD_REQUEST");
    const { source, handle } = await mutationConversation(ctx, input.conversationId);
    const id = await handle.compact(input.instructions, ctx.context);
    return {
      taskId: globalId("TaskRecord", source.harness.externalId, id),
    };
  } catch (error) {
    throw mapError(error);
  }
}

/** @gqlInput */
interface ConfigureInput {
  readonly conversationId: ID;
  readonly change: AgentChange;
}

/**
 * Pick<AgentChange, "model" | "thinkingLevel" | "cwd">; no other overrides are exposed.
 * @gqlInput
 */
interface AgentChange {
  /** Omitted: unchanged. Explicit null: clear override. Value: replace override. */
  readonly model?: ModelRefInput | null;
  /** Omitted: unchanged. Explicit null: clear override. Value: replace override. */
  readonly thinkingLevel?: ModelThinkingLevel | null;
  /** Omitted: unchanged. Explicit null: clear override. Value: replace override. */
  readonly cwd?: string | null;
}

/** @gqlInput */
interface ModelRefInput {
  readonly provider: string;
  readonly modelId: string;
}

/** @gqlEnum */
type ModelThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Change model, thinking level, or cwd overrides; return true after the commit.
 * Read resolved settings through agent.
 * @gqlMutationField
 */
export async function configure(
  input: ConfigureInput,
  ctx: ResolverContext,
): Promise<boolean | null> {
  try {
    const { handle } = await mutationConversation(ctx, input.conversationId);
    await handle.configure(input.change, ctx.context);
    return true;
  } catch (error) {
    throw mapError(error);
  }
}
