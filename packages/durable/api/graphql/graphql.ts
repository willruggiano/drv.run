import assert from "node:assert/strict";
import type { Float, ID, Int, GqlScalar } from "grats";
import { GraphQLError, valueFromASTUntyped } from "graphql";
import Type, { type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { ConversationBusy, SessionFailed, StorageRequestError } from "@earendil-works/pi-durable";
import { getSchema } from "./generated/graphql.ts";
import type * as Durable from "@earendil-works/pi-durable";
import type * as Chord from "@earendil-works/chord";
import type * as Telemetry from "@earendil-works/pi-telemetry";
import type * as AI from "@earendil-works/pi-ai";

// TypeScript/Grats is the schema source of truth. The generated factory accepts
// scalar implementations. Deployment supplies authorized persisted Harness lookup
// and the session catalog. Listener, lifetime, and recovery policy remain external.
// Upstream: pi-durable 1.4.0 dist/types.d.ts and dist/harness/types.d.ts.
// Relay identities, connection wrappers, and transport inputs remain adapter types.

/*
 * All reads are point-in-time and do not enable scheduling. Transactions,
 * execution contexts, Harness factories, and telemetry remain server-side as in
 * SPEC.md. There is no watch, subscription, remote wait, or task-control API.
 *
 * Execution failures use GraphQL errors, not success payloads. extensions.code is
 * BAD_REQUEST for adapter validation and StorageRequestError from reads,
 * NOT_FOUND for missing mutation targets, CONVERSATION_BUSY for submit's typed
 * ConversationBusy, SESSION_FAILED for typed SessionFailed, and INTERNAL_SERVER_ERROR
 * otherwise. Storage commit/mint failures, ReadAfterWrite, untyped exceptions, and
 * invisible historical entries retain the internal-error fallback. Never classify
 * by error-message text or expose stacks, causes, or internal error messages.
 * Missing lookup objects are null, not execution errors; storage failures still
 * produce errors. Persisted task failures and blocked inspection states are data.
 *
 * GraphQL execution errors are distinct from HTTP transport errors. Deployment
 * retains no-store responses, body limits, media-type checks, and method checks;
 * mutations cannot run over GET. Disconnect does not abort execution or establish
 * whether a mutation committed. Neither SESSION_FAILED nor a transport failure
 * authorizes automatic replay or promises a recovery time.
 *
 * ID means an opaque global Node identifier. ConversationId, EntryId, TaskId, and
 * SubmissionId retain their upstream numeric representations, scoped to a session.
 * Record nodes expose durableId for the upstream id; Harness exposes its external
 * sessionId key. Other record fields retain their upstream names and values.
 * Missing optional output fields become null. Optional upstream input fields
 * permit omission, but reject explicit null unless their
 * description permits it. Relay after permits null, meaning no cursor.
 * clientMutationId permits null and is only echoed, never used as an idempotency key.
 */

// Construct a fresh context for each GraphQL operation. Session keys must never be
// reused for replacement storage. Both callbacks enforce the same access policy;
// scope identifies that policy/catalog for cursor binding. The caller owns Harnesses.
/** @gqlContext */
export interface ResolverContext {
  readonly execution: Chord.Context;
  readonly scope: string;
  readonly lookup: (sessionId: string) => Promise<Durable.Harness | undefined>;
  readonly sessions: () => Promise<readonly string[]>;
  readonly observations: Map<string, Promise<unknown>>;
}

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

async function boundary<T>(
  read: boolean,
  operation: () => T | Promise<T>,
  admission = false,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ResolverError) throw error;
    if (error instanceof SessionFailed) throw new ResolverError("SESSION_FAILED");
    if (read && error instanceof StorageRequestError) throw new ResolverError("BAD_REQUEST");
    if (admission && error instanceof ConversationBusy)
      throw new ResolverError("CONVERSATION_BUSY");
    throw new ResolverError("INTERNAL_SERVER_ERROR");
  }
}

// Keys are private to this module and identify one result type. Cache in-flight
// reads as well as values, so concurrent aliases cannot observe different versions.
function observe<T>(ctx: ResolverContext, key: string, read: () => T | Promise<T>): Promise<T> {
  const existing = ctx.observations.get(key);
  if (existing) return existing as Promise<T>;
  const pending = boundary(true, read);
  ctx.observations.set(key, pending);
  return pending;
}

const safeInteger = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const jsonSchema = Type.Cyclic(
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
const jsonObjectSchema = Type.Record(Type.String({ pattern: "^[\\s\\S]*$" }), jsonSchema, {
  additionalProperties: false,
});
const textSchema = Type.Object({
  type: Type.Literal("text"),
  text: Type.String(),
  textSignature: Type.Optional(Type.String()),
});
const imageSchema = Type.Object({
  type: Type.Literal("image"),
  data: Type.String({
    pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
  }),
  mimeType: Type.String(),
});
const userInputSchema = Type.Unsafe<UserInput>(
  Type.Intersect([
    jsonSchema,
    Type.Union([Type.String(), Type.Array(Type.Union([textSchema, imageSchema]))]),
  ]),
);

function checked<S extends TSchema>(schema: S, value: unknown): Static<S> {
  try {
    if (Check(schema, value)) return value;
  } catch {
    /* Malformed values, including cycles, are invalid input. */
  }
  throw new ResolverError("BAD_REQUEST");
}

function scalar<S extends TSchema>(schema: S): GqlScalar<Static<S>> {
  return {
    parseValue: (value) => checked(schema, value),
    parseLiteral: (value, variables) => checked(schema, valueFromASTUntyped(value, variables)),
    serialize(value) {
      try {
        if (Check(schema, value)) return value;
      } catch {
        /* Do not expose serializer failures. */
      }
      throw new ResolverError("INTERNAL_SERVER_ERROR");
    },
  };
}

export function createSchema() {
  return getSchema({
    scalars: {
      ConversationId: scalar(Type.Unsafe<ConversationId>(safeInteger)),
      EntryId: scalar(Type.Unsafe<EntryId>(safeInteger)),
      TaskId: scalar(Type.Unsafe<TaskId>(safeInteger)),
      SubmissionId: scalar(Type.Unsafe<SubmissionId>(safeInteger)),
      JsonValue: scalar(Type.Unsafe<JsonValue>(jsonSchema)),
      JsonObject: scalar(Type.Unsafe<JsonObject>(jsonObjectSchema)),
      TelemetryCarrier: scalar(
        Type.Unsafe<TelemetryCarrier>(
          Type.Record(Type.String({ pattern: "^[\\s\\S]*$" }), Type.String(), {
            additionalProperties: false,
          }),
        ),
      ),
      UserInput: scalar(userInputSchema),
      // Message is output-only. Its structure comes from pi-ai, not a second model
      // schema here. Apply native JSON serialization, including omission of undefined.
      Message: {
        parseValue() {
          throw new ResolverError("BAD_REQUEST");
        },
        parseLiteral() {
          throw new ResolverError("BAD_REQUEST");
        },
        serialize(value) {
          try {
            const json: unknown = JSON.parse(JSON.stringify(value));
            if (!Check(jsonObjectSchema, json)) throw new Error();
            return json;
          } catch {
            throw new ResolverError("INTERNAL_SERVER_ERROR");
          }
        },
      },
    },
  });
}

function diagnostic(value: unknown): JsonValue {
  const serialized: unknown = JSON.parse(JSON.stringify(value));
  if (!Check(jsonSchema, serialized)) throw new ResolverError("INTERNAL_SERVER_ERROR");
  return serialized;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decode(value: string): unknown {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw new Error();
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ResolverError("BAD_REQUEST");
  }
}

const nodeKindSchema = Type.Enum([
  "Harness",
  "ConversationRecord",
  "EntryRecord",
  "TaskRecord",
  "SubmissionRecord",
]);
type NodeKind = Static<typeof nodeKindSchema>;
const identitySchema = Type.Tuple([
  Type.Literal(1),
  nodeKindSchema,
  Type.String(),
  Type.Union([safeInteger, Type.Null()]),
]);
function identity(id: ID) {
  const [_, kind, sessionId, durableId] = checked(identitySchema, decode(id));
  if (
    encode([1, kind, sessionId, durableId]) !== id ||
    (kind === "Harness") !== (durableId === null)
  )
    throw new ResolverError("BAD_REQUEST");
  return { kind, sessionId, durableId };
}
function globalId(kind: NodeKind, sessionId: string, id: number | null = null): ID {
  return encode([1, kind, sessionId, id]);
}
function harnessNode(ctx: ResolverContext, sessionId: string): Promise<Harness> {
  return observe(ctx, `harness-node:${sessionId}`, () => ({
    __typename: "Harness",
    id: globalId("Harness", sessionId),
    sessionId,
  }));
}
function acquire(ctx: ResolverContext, sessionId: string) {
  return observe(ctx, `instance:${sessionId}`, () => boundary(false, () => ctx.lookup(sessionId)));
}
async function requireHarness(ctx: ResolverContext, source: Harness) {
  const instance = await acquire(ctx, source.sessionId);
  if (!instance) throw new ResolverError("NOT_FOUND");
  return instance;
}
async function requireConversation(ctx: ResolverContext, source: ConversationRecord) {
  const instance = await requireHarness(ctx, source.harness);
  const handle = await observe(ctx, `handle:${source.id}`, () =>
    instance.conversation(source.durableId, ctx.execution),
  );
  if (!handle) throw new ResolverError("NOT_FOUND");
  return handle;
}

type RecordNode = ConversationRecord | EntryRecord | TaskRecord | SubmissionRecord;
// All projections and direct lookups share these keys. The first observation wins.
function recordNode<T extends RecordNode>(
  ctx: ResolverContext,
  id: ID,
  read: () => Promise<T | null>,
): Promise<T | null> {
  return observe(ctx, `record:${id}`, read);
}
async function projectConversation(
  ctx: ResolverContext,
  owner: Harness,
  record: Durable.ConversationRecord,
): Promise<ConversationRecord> {
  const id = globalId("ConversationRecord", owner.sessionId, record.id);
  const result = await recordNode(ctx, id, async () => ({
    ...record,
    __typename: "ConversationRecord",
    id,
    durableId: record.id,
    harness: owner,
  }));
  assert(result);
  return result;
}
async function projectEntry(
  ctx: ResolverContext,
  owner: Harness,
  record: Durable.EntryRecord,
): Promise<EntryRecord> {
  const id = globalId("EntryRecord", owner.sessionId, record.id);
  const result = await recordNode(ctx, id, async () => ({
    ...record,
    __typename: "EntryRecord",
    id,
    durableId: record.id,
    harness: owner,
  }));
  assert(result);
  return result;
}
async function projectTask(
  ctx: ResolverContext,
  owner: Harness,
  record: Durable.TaskRecord<JsonValue, JsonValue, JsonValue>,
): Promise<TaskRecord> {
  const id = globalId("TaskRecord", owner.sessionId, record.id);
  const result = await recordNode(ctx, id, async () => ({
    ...record,
    __typename: "TaskRecord",
    id,
    durableId: record.id,
    harness: owner,
  }));
  assert(result);
  return result;
}
async function projectSubmission(
  ctx: ResolverContext,
  owner: Harness,
  record: Durable.SubmissionRecord,
): Promise<SubmissionRecord> {
  const id = globalId("SubmissionRecord", owner.sessionId, record.id);
  const result = await recordNode(ctx, id, async () => ({
    ...record,
    __typename: "SubmissionRecord",
    id,
    durableId: record.id,
    harness: owner,
  }));
  assert(result);
  return result;
}

function nonNull<T extends object>(value: T): { [K in keyof T]: Exclude<T[K], null> } {
  if (Object.values(value).some((field) => field === null)) throw new ResolverError("BAD_REQUEST");
  return value as { [K in keyof T]: Exclude<T[K], null> };
}

const cursorSchema = Type.Object(
  {
    version: Type.Literal(1),
    scope: Type.String(),
    connection: Type.String(),
    filters: Type.String(),
    order: Type.Enum(["ascending", "descending"]),
    last: Type.Union([safeInteger, Type.String()]),
  },
  { additionalProperties: false },
);

function pagination(
  ctx: ResolverContext,
  connection: string,
  first: number,
  query: { order?: ScanOrder | null },
  after: string | null | undefined,
  defaultOrder: ScanOrder,
) {
  if (!Number.isInteger(first) || first < 0 || first > 2147483647)
    throw new ResolverError("BAD_REQUEST");
  const { order, ...filters } = nonNull(query);
  const filterKey = JSON.stringify(
    Object.entries(filters)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  const cursor = after == null ? undefined : checked(cursorSchema, decode(after));
  if (
    cursor &&
    (cursor.scope !== ctx.scope ||
      cursor.connection !== connection ||
      cursor.filters !== filterKey ||
      (order !== undefined && order !== cursor.order))
  )
    throw new ResolverError("BAD_REQUEST");
  const effectiveOrder = order ?? cursor?.order ?? defaultOrder;
  return {
    order: effectiveOrder,
    last: cursor?.last,
    cursor: (last: number | string) =>
      encode({
        version: 1,
        scope: ctx.scope,
        connection,
        filters: filterKey,
        order: effectiveOrder,
        last,
      }),
  };
}

function connectionResult<T>(edges: Array<{ cursor: string; node: T }>, hasNextPage: boolean) {
  return {
    edges,
    pageInfo: {
      hasNextPage,
      hasPreviousPage: false,
      startCursor: edges[0]?.cursor ?? null,
      endCursor: edges.at(-1)?.cursor ?? null,
    },
  };
}

async function recordPage<T extends { readonly id: number }, N>(
  ctx: ResolverContext,
  key: string,
  first: number,
  query: { order?: ScanOrder | null },
  after: string | null | undefined,
  defaultOrder: ScanOrder,
  fetch: (order: ScanOrder, cursor?: Durable.Cursor) => Promise<Durable.Page<T, Durable.Cursor>>,
  project: (record: T) => Promise<N>,
) {
  const page = pagination(ctx, key, first, query, after, defaultOrder);
  if (page.last !== undefined && typeof page.last !== "number")
    throw new ResolverError("BAD_REQUEST");
  const last = page.last;
  const edges: Array<{ cursor: string; node: N }> = [];
  let cursor: Durable.Cursor | undefined;
  // Rescan ordered pages, preserving opaque Durable continuations. Never fabricate
  // a backend cursor or copy one page continuation onto every edge.
  do {
    const batch = await fetch(page.order, cursor);
    for (const record of batch.items) {
      if (
        last !== undefined &&
        (page.order === "ascending" ? record.id <= last : record.id >= last)
      )
        continue;
      if (edges.length === first) return connectionResult(edges, true);
      edges.push({ cursor: page.cursor(record.id), node: await project(record) });
    }
    cursor = batch.next;
  } while (cursor !== undefined);
  return connectionResult(edges, false);
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

function mutation<T>(ctx: ResolverContext, run: () => Promise<T>, admission = false): Promise<T> {
  // Root mutation fields run serially. Each must see preceding committed changes,
  // not an observation retained from a previous field in the same operation.
  ctx.observations.clear();
  return boundary(false, run, admission);
}

/**
 * Upstream ConversationId: a nonnegative safe-integer JSON number in
 * 0..9007199254740991, not a 32-bit GraphQL Int or global Node ID.
 * @gqlScalar
 */
export type ConversationId = Durable.ConversationId;

/**
 * Upstream EntryId; the same numeric range and representation as ConversationId.
 * @gqlScalar
 */
export type EntryId = Durable.EntryId;

/**
 * Upstream TaskId; the same numeric range and representation as ConversationId.
 * @gqlScalar
 */
export type TaskId = Durable.TaskId;

/**
 * A finite JSON value, including null; object keys and payloads are preserved.
 * @gqlScalar
 */
export type JsonValue = Chord.JsonValue;

/**
 * Upstream JsonObject: a JSON object with string keys and JsonValue values.
 * @gqlScalar
 */
export type JsonObject = Durable.JsonObject;

/**
 * Upstream TelemetryCarrier: a JSON object with string keys and string values.
 * @gqlScalar
 */
export type TelemetryCarrier = Telemetry.TelemetryCarrier;

/**
 * An unmodified pi-ai Message JSON object, including all provider-specific fields.
 * @gqlScalar
 */
export type Message = AI.Message;

/**
 * InputSubmissionDraft.content: a string or an ordered array of text/image blocks.
 * TextContent: {type: "text", text: string, textSignature?: string}.
 * ImageContent: {type: "image", data: base64 string, mimeType: string}.
 * Validate the complete upstream shape without coercion or dropping extra fields.
 * @gqlScalar
 */
export type UserInput = Durable.UserInput;

/**
 * Upstream SubmissionId; the same numeric range and representation as ConversationId.
 * @gqlScalar
 */
export type SubmissionId = Durable.SubmissionId;

/**
 * Globally refetchable identity. IDs encode object type, persisted session identity,
 * and the durable ID where applicable. They survive Harness reopen and are never
 * reused for replacement storage. An inherited entry has the same ID in every
 * conversation. Clients must not decode IDs.
 *
 * Repeated occurrences of the same ID within a query have equal field values.
 * Resolvers must reuse request-scoped observations; a mutating Harness must not
 * produce conflicting versions through node(), connections, and inspection.
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
export function node(id: ID, ctx: ResolverContext): Promise<Node | null> {
  return boundary(true, async () => {
    const target = identity(id);
    const instance = await acquire(ctx, target.sessionId);
    if (!instance) return null;
    const owner = await harnessNode(ctx, target.sessionId);
    if (target.kind === "Harness") return owner;
    return recordNode(ctx, id, async () => {
      switch (target.kind) {
        case "ConversationRecord": {
          const record = await instance.commit(
            (tx) =>
              tx.conversation(checked(Type.Unsafe<ConversationId>(safeInteger), target.durableId)),
            ctx.execution,
          );
          return record
            ? {
                ...record,
                __typename: "ConversationRecord",
                id,
                durableId: record.id,
                harness: owner,
              }
            : null;
        }
        case "EntryRecord": {
          const record = await instance.commit(
            (tx) => tx.entry(checked(Type.Unsafe<EntryId>(safeInteger), target.durableId)),
            ctx.execution,
          );
          return record
            ? { ...record, __typename: "EntryRecord", id, durableId: record.id, harness: owner }
            : null;
        }
        case "TaskRecord": {
          const record = await instance.getTask(
            checked(Type.Unsafe<Durable.TaskId<JsonValue>>(safeInteger), target.durableId),
            ctx.execution,
          );
          return record
            ? { ...record, __typename: "TaskRecord", id, durableId: record.id, harness: owner }
            : null;
        }
        case "SubmissionRecord": {
          const handle = await instance.submission(
            checked(Type.Unsafe<SubmissionId>(safeInteger), target.durableId),
            ctx.execution,
          );
          const record = await handle?.status(ctx.execution);
          return record
            ? {
                ...record,
                __typename: "SubmissionRecord",
                id,
                durableId: record.id,
                harness: owner,
              }
            : null;
        }
        default:
          throw new Error("Invalid record kind");
      }
    });
  });
}

/** @gqlType */
interface Harness extends Node {
  readonly __typename: "Harness";

  /** @gqlField */
  readonly id: ID;
  /** @gqlField */
  readonly sessionId: string;
}

/**
 * Resolve a persisted Harness by its external session key; does not create one.
 * @gqlQueryField
 */
export async function harness(sessionId: string, ctx: ResolverContext): Promise<Harness | null> {
  return (await acquire(ctx, sessionId)) ? harnessNode(ctx, sessionId) : null;
}

/**
 * List accessible persisted sessions from the deployment's catalog, not the cache
 * of open Harness instances. Durable does not provide a cross-session catalog.
 * Order by ascending sessionId; listing does not create sessions or enable scheduling.
 * Cursors bind the catalog, access scope, and ordering, not an individual session.
 * @gqlQueryField
 */
export function harnesses(
  ctx: ResolverContext,
  first: Int,
  after?: string | null,
): Promise<HarnessConnection> {
  return boundary(true, async () => {
    const page = pagination(ctx, "harnesses", first, {}, after, "ascending");
    if (page.order !== "ascending" || (page.last !== undefined && typeof page.last !== "string"))
      throw new ResolverError("BAD_REQUEST");
    const sessions = await observe(ctx, "catalog", async () => {
      const values = [...(await ctx.sessions())].sort();
      assert.equal(new Set(values).size, values.length);
      return values;
    });
    const remaining = sessions.filter((id) => page.last === undefined || id > page.last);
    const edges = await Promise.all(
      remaining
        .slice(0, first)
        .map(async (id) => ({ cursor: page.cursor(id), node: await harnessNode(ctx, id) })),
    );
    return connectionResult(edges, remaining.length > first);
  });
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
    globalId("ConversationRecord", source.sessionId, id),
    ctx,
  ) as Promise<ConversationRecord | null>;
}

/**
 * Harness.inspect(): live work and scheduling state, without enabling scheduling.
 * @gqlField
 */
export function inspect(source: Harness, ctx: ResolverContext): Promise<HarnessInspection> {
  return observe(ctx, `inspect:${source.id}`, async () => {
    const instance = await requireHarness(ctx, source);
    const value = await instance.inspect(ctx.execution);
    return {
      scheduling: value.scheduling,
      tasks: await Promise.all(
        value.tasks.map(async ({ record, state }) => ({
          record: await projectTask(ctx, source, record),
          state:
            state.kind === "blocked" && state.error !== undefined
              ? { ...state, error: diagnostic(state.error) }
              : state.kind === "blocked"
                ? { kind: state.kind, reason: state.reason }
                : state,
        })),
      ),
      submissions: await Promise.all(
        value.submissions.map((record) => projectSubmission(ctx, source, record)),
      ),
    };
  });
}

/**
 * Tx.scanConversations(); default order is ascending, or the cursor's order.
 * @gqlField
 */
export function scanConversations(
  source: Harness,
  ctx: ResolverContext,
  first: Int,
  query: ConversationQuery = {},
  after?: string | null,
): Promise<ConversationRecordConnection> {
  return boundary(true, async () => {
    const filters = nonNull(query);
    const instance = await requireHarness(ctx, source);
    return recordPage(
      ctx,
      `scanConversations:${source.id}`,
      first,
      query,
      after,
      "ascending",
      (order, cursor) =>
        instance.commit(
          (tx) => tx.scanConversations({ ...filters, order }, 128, cursor),
          ctx.execution,
        ),
      (record) => projectConversation(ctx, source, record),
    );
  });
}

/**
 * Tx.scanTasks(); default order is ascending, or the cursor's order.
 * @gqlField
 */
export function scanTasks(
  source: Harness,
  ctx: ResolverContext,
  first: Int,
  query: TaskQuery = {},
  after?: string | null,
): Promise<TaskRecordConnection> {
  return boundary(true, async () => {
    const filters = nonNull(query);
    const instance = await requireHarness(ctx, source);
    return recordPage(
      ctx,
      `scanTasks:${source.id}`,
      first,
      query,
      after,
      "ascending",
      (order, cursor) =>
        instance.commit((tx) => tx.scanTasks({ ...filters, order }, 128, cursor), ctx.execution),
      (record) => projectTask(ctx, source, record),
    );
  });
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
export function agent(source: ConversationRecord, ctx: ResolverContext): Promise<Agent> {
  return observe(ctx, `agent:${source.id}`, async () => {
    const value = await (await requireConversation(ctx, source)).agent(ctx.execution);
    return {
      model: value.model ?? null,
      thinkingLevel: value.thinkingLevel,
      cwd: value.cwd ?? null,
      instructions: value.instructions ?? null,
    };
  });
}

/**
 * Readable settings from upstream Agent. Runtime extensions, tools, and prompt
 * section callbacks remain server-side.
 * @gqlType
 */
interface Agent {
  /** @gqlField */
  readonly model?: AgentModel | null;
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
 * Output representation of upstream ModelRef; ModelRef is the mutation input type.
 * @gqlType
 */
interface AgentModel {
  /** @gqlField */
  readonly provider: string;
  /** @gqlField */
  readonly modelId: string;
}

/**
 * Fork-aware history, including inherited entries. Default order is descending.
 * @gqlField
 */
export function entries(
  source: ConversationRecord,
  ctx: ResolverContext,
  first: Int,
  query: EntryQuery = {},
  after?: string | null,
): Promise<EntryRecordConnection> {
  return boundary(true, async () => {
    const filters = nonNull(query);
    const instance = await requireConversation(ctx, source);
    return recordPage(
      ctx,
      `entries:${source.id}`,
      first,
      query,
      after,
      "descending",
      (order, cursor) => instance.entries({ ...filters, order }, 128, cursor, ctx.execution),
      (record) => projectEntry(ctx, source.harness, record),
    );
  });
}

/**
 * Current context when at is omitted; otherwise context through that visible entry.
 * @gqlField
 */
export function context(
  source: ConversationRecord,
  ctx: ResolverContext,
  at?: EntryId | null,
): Promise<ContextView> {
  return observe(ctx, `context:${source.id}:${at}`, async () => {
    if (at === null) throw new ResolverError("BAD_REQUEST");
    const value = await (
      await requireConversation(ctx, source)
    ).context(ctx.execution, at === undefined ? {} : { at });
    return {
      head: value.head ? await projectEntry(ctx, source.harness, value.head) : null,
      entries: await Promise.all(
        value.entries.map((entry) => projectEntry(ctx, source.harness, entry)),
      ),
      contributions: value.contributions,
      messages: value.messages,
    };
  });
}

/**
 * Conversation-scoped Tx.submissionByRequest(). Null means absent at observation,
 * not that a concurrent or disconnected submission failed to commit.
 * @gqlField
 */
export function submissionByRequest(
  source: ConversationRecord,
  requestId: string,
  ctx: ResolverContext,
): Promise<SubmissionRecord | null> {
  return observe(ctx, `request:${source.id}:${requestId}`, async () => {
    const instance = await requireHarness(ctx, source.harness);
    const record = await instance.commit(
      (tx) => tx.submissionByRequest(source.durableId, requestId),
      ctx.execution,
    );
    return record ? projectSubmission(ctx, source.harness, record) : null;
  });
}

/**
 * Reacquire Harness.submission(id), then read Submission.status(). Null for an
 * absent submission or one belonging to another conversation; never waits.
 * @gqlField
 */
export function status(
  source: ConversationRecord,
  id: SubmissionId,
  ctx: ResolverContext,
): Promise<SubmissionRecord | null> {
  return boundary(true, async () => {
    const record = (await node(
      globalId("SubmissionRecord", source.harness.sessionId, id),
      ctx,
    )) as SubmissionRecord | null;
    return record?.conversationId === source.durableId ? record : null;
  });
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
 * Forward-only Relay connections: first is a nonnegative Int, including zero;
 * after is an opaque edge cursor. Slice strictly after its edge, then take first.
 * Ordering is stable across pages. Omitted order inherits the cursor's order or
 * the operation's initial default. Conflicting order or foreign/malformed cursors
 * are BAD_REQUEST. Cursors bind connection, session and conversation where applicable,
 * filters, and effective order, but not page size.
 *
 * Every edge must have its own resumable cursor, including the final edge. A
 * Durable Page.next is a page continuation, not a cursor to copy onto every edge;
 * the adapter must retain enough continuation/position information for any edge.
 * The HTTP API's cursor encoding is not assumed to be a Relay edge cursor.
 *
 * hasNextPage reflects whether more matching edges remain, including for first: 0;
 * use lookahead rather than assuming a full page means more results. For forward
 * pagination, hasPreviousPage may be false if prior edges cannot be determined
 * efficiently. startCursor/endCursor equal the first/last returned edge cursor,
 * or null when edges is empty. Backward pagination is intentionally not exposed.
 * @gqlType
 */
interface PageInfo {
  /** @gqlField */
  readonly hasNextPage: boolean;
  /** @gqlField */
  readonly hasPreviousPage: boolean;
  /** @gqlField */
  readonly startCursor?: string | null;
  /** @gqlField */
  readonly endCursor?: string | null;
}

/** @gqlType */
interface HarnessConnection {
  /** @gqlField */
  readonly edges: ReadonlyArray<HarnessEdge>;
  /** @gqlField */
  readonly pageInfo: PageInfo;
}

/** @gqlType */
interface HarnessEdge {
  /** @gqlField */
  readonly cursor: string;
  /** @gqlField */
  readonly node: Harness;
}

/** @gqlType */
interface ConversationRecordConnection {
  /** @gqlField */
  readonly edges: ReadonlyArray<ConversationRecordEdge>;
  /** @gqlField */
  readonly pageInfo: PageInfo;
}

/** @gqlType */
interface ConversationRecordEdge {
  /** @gqlField */
  readonly cursor: string;
  /** @gqlField */
  readonly node: ConversationRecord;
}

/** @gqlType */
interface EntryRecordConnection {
  /** @gqlField */
  readonly edges: ReadonlyArray<EntryRecordEdge>;
  /** @gqlField */
  readonly pageInfo: PageInfo;
}

/** @gqlType */
interface EntryRecordEdge {
  /** @gqlField */
  readonly cursor: string;
  /** @gqlField */
  readonly node: EntryRecord;
}

/** @gqlType */
interface TaskRecordConnection {
  /** @gqlField */
  readonly edges: ReadonlyArray<TaskRecordEdge>;
  /** @gqlField */
  readonly pageInfo: PageInfo;
}

/** @gqlType */
interface TaskRecordEdge {
  /** @gqlField */
  readonly cursor: string;
  /** @gqlField */
  readonly node: TaskRecord;
}

/** @gqlInput */
interface SubmitInput {
  /** Global ConversationRecord ID, not its numeric durableId. */
  readonly conversationId: ID;
  readonly submission: InputSubmissionDraft;
  readonly clientMutationId?: string | null;
}

/** @gqlInput */
interface InputSubmissionDraft {
  readonly type: InputSubmissionDraftType;
  readonly content: UserInput;
  readonly requestId?: string | null;
  readonly whenBusy?: InputSubmissionDraftWhenBusy | null;
  readonly entry?: InputEntry | null;
}

/**
 * GraphQL name for InputSubmissionDraft["type"].
 * @gqlEnum
 */
type InputSubmissionDraftType = "input";

/**
 * GraphQL name for NonNullable<InputSubmissionDraft["whenBusy"]>.
 * @gqlEnum
 */
type InputSubmissionDraftWhenBusy = "steer" | "followUp" | "reject";

/** @gqlInput */
interface InputEntry {
  /** Application kind; must not start with the reserved prefix "pi.". */
  readonly kind: string;
  /** Optional JSON payload; explicit null is allowed. */
  readonly data?: JsonValue | null;
}

/** @gqlType */
interface SubmitPayload {
  /**
   * Transport reference to Submission.id as a global SubmissionRecord ID.
   * node(id) reads its receipt; this payload is not itself the submission Node.
   * @gqlField
   */
  readonly submissionId: ID;
  /** @gqlField */
  readonly clientMutationId?: string | null;
}

/**
 * Admit input, not placement or completion. Same requestId and type recover the
 * prior submission without comparing content. A key used for another type
 * retains the untyped-error fallback. ConversationBusy means not admitted.
 * @gqlMutationField
 */
export function submit(input: SubmitInput, ctx: ResolverContext): Promise<SubmitPayload | null> {
  return mutation(
    ctx,
    async () => {
      const { source, handle } = await mutationConversation(ctx, input.conversationId);
      const draft = nonNull(input.submission);
      checked(userInputSchema, draft.content);
      if (draft.entry?.kind.startsWith("pi.")) throw new ResolverError("BAD_REQUEST");
      if (draft.entry?.data !== undefined) checked(jsonSchema, draft.entry.data);
      const result = await handle.submit(draft, ctx.execution);
      return {
        submissionId: globalId("SubmissionRecord", source.harness.sessionId, result.id),
        clientMutationId: input.clientMutationId ?? null,
      };
    },
    true,
  );
}

/** @gqlInput */
interface AbortSubmissionInput {
  /** Global ConversationRecord ID; upstream abort is constrained to this conversation. */
  readonly conversationId: ID;
  readonly id: SubmissionId;
  readonly clientMutationId?: string | null;
}

/** @gqlType */
interface AbortSubmissionPayload {
  /** @gqlField */
  readonly result: HarnessAbortSubmissionResult;
  /** @gqlField */
  readonly clientMutationId?: string | null;
}

/**
 * Withdraw a queued submission; already_placed never becomes an execution abort.
 * @gqlMutationField
 */
export function abortSubmission(
  input: AbortSubmissionInput,
  ctx: ResolverContext,
): Promise<AbortSubmissionPayload | null> {
  return mutation(ctx, async () => {
    const { source } = await mutationConversation(ctx, input.conversationId);
    const instance = await requireHarness(ctx, source.harness);
    const result = await instance.abortSubmission(input.id, ctx.execution, source.durableId);
    return { result, clientMutationId: input.clientMutationId ?? null };
  });
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
  readonly clientMutationId?: string | null;
}

/**
 * Successful void result; only the optional correlation value is returned.
 * @gqlType
 */
interface AbortPayload {
  /** @gqlField */
  readonly clientMutationId?: string | null;
}

/**
 * Withdraw queued inputs and abort ordinary owned work; preserve background work
 * and queued writes. Resolves after upstream abort completes. No background flag.
 * @gqlMutationField
 */
export function abort(input: AbortInput, ctx: ResolverContext): Promise<AbortPayload | null> {
  return mutation(ctx, async () => {
    const { handle } = await mutationConversation(ctx, input.conversationId);
    await handle.abort(ctx.execution);
    return { clientMutationId: input.clientMutationId ?? null };
  });
}

/** @gqlInput */
interface ResumeInput {
  /** Global Harness ID, not its external sessionId key. */
  readonly sessionId: ID;
  readonly clientMutationId?: string | null;
}

/** @gqlType */
interface ResumePayload {
  /** @gqlField */
  readonly clientMutationId?: string | null;
}

/**
 * Enable Harness scheduling; successful return does not mean work has completed.
 * @gqlMutationField
 */
export function resume(input: ResumeInput, ctx: ResolverContext): Promise<ResumePayload | null> {
  return mutation(ctx, async () => {
    const target = identity(input.sessionId);
    if (target.kind !== "Harness") throw new ResolverError("BAD_REQUEST");
    const instance = await acquire(ctx, target.sessionId);
    if (!instance) throw new ResolverError("NOT_FOUND");
    instance.resume();
    return { clientMutationId: input.clientMutationId ?? null };
  });
}

/** @gqlInput */
interface ResetInput {
  readonly conversationId: ID;
  /** Omit for no handoff; preserve a supplied string, including the empty string. */
  readonly handoff?: string | null;
  readonly clientMutationId?: string | null;
}

/** @gqlType */
interface ResetPayload {
  /** @gqlField */
  readonly clientMutationId?: string | null;
}

/**
 * Admit a reset, not necessarily its placement. No idempotency key.
 * @gqlMutationField
 */
export function reset(input: ResetInput, ctx: ResolverContext): Promise<ResetPayload | null> {
  return mutation(ctx, async () => {
    if (input.handoff === null) throw new ResolverError("BAD_REQUEST");
    const { handle } = await mutationConversation(ctx, input.conversationId);
    await handle.reset(input.handoff, ctx.execution);
    return { clientMutationId: input.clientMutationId ?? null };
  });
}

/** @gqlInput */
interface CompactInput {
  readonly conversationId: ID;
  readonly instructions?: string | null;
  readonly clientMutationId?: string | null;
}

/** @gqlType */
interface CompactPayload {
  /**
   * Global TaskRecord ID corresponding to compact()'s admitted upstream TaskId.
   * @gqlField
   */
  readonly taskId: ID;
  /** @gqlField */
  readonly clientMutationId?: string | null;
}

/**
 * Admit compaction; task completion and summary placement remain separate.
 * @gqlMutationField
 */
export function compact(input: CompactInput, ctx: ResolverContext): Promise<CompactPayload | null> {
  return mutation(ctx, async () => {
    if (input.instructions === null) throw new ResolverError("BAD_REQUEST");
    const { source, handle } = await mutationConversation(ctx, input.conversationId);
    const id = await handle.compact(input.instructions, ctx.execution);
    return {
      taskId: globalId("TaskRecord", source.harness.sessionId, id),
      clientMutationId: input.clientMutationId ?? null,
    };
  });
}

/** @gqlInput */
interface ConfigureInput {
  readonly conversationId: ID;
  readonly change: AgentChange;
  readonly clientMutationId?: string | null;
}

/**
 * Pick<AgentChange, "model" | "thinkingLevel" | "cwd">; no other overrides are exposed.
 * @gqlInput
 */
interface AgentChange {
  /** Omitted: unchanged. Explicit null: clear override. Value: replace override. */
  readonly model?: ModelRef | null;
  /** Omitted: unchanged. Explicit null: clear override. Value: replace override. */
  readonly thinkingLevel?: ModelThinkingLevel | null;
  /** Omitted: unchanged. Explicit null: clear override. Value: replace override. */
  readonly cwd?: string | null;
}

/** @gqlInput */
interface ModelRef {
  readonly provider: string;
  readonly modelId: string;
}

/** @gqlEnum */
type ModelThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** @gqlType */
interface ConfigurePayload {
  /** @gqlField */
  readonly clientMutationId?: string | null;
}

/**
 * Change model, thinking level, or cwd overrides; read resolved settings through agent.
 * @gqlMutationField
 */
export function configure(
  input: ConfigureInput,
  ctx: ResolverContext,
): Promise<ConfigurePayload | null> {
  return mutation(ctx, async () => {
    const { handle } = await mutationConversation(ctx, input.conversationId);
    await handle.configure(input.change, ctx.execution);
    return { clientMutationId: input.clientMutationId ?? null };
  });
}
