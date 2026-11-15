/*
 * Imports
 */

import assert from "node:assert/strict";
import { awaitWithContext } from "@earendil-works/chord/context";
import type { Float, ID, Int, GqlScalar } from "grats";
import { GraphQLError, valueFromASTUntyped, type GraphQLSchema } from "graphql";
import Type from "typebox";
import Value from "typebox/value";
import {
  configure as configureAgent,
  ConversationBusy,
  SessionFailed,
  StorageRequestError,
  ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import { Env } from "durable-harness";
import { sshArguments, type SshTarget as NativeSshTarget } from "@earendil-works/pi-env";
import { getSchema } from "./generated/graphql.ts";
import type * as Durable from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import type * as Chord from "@earendil-works/chord/json";
import type * as AI from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels, type Models } from "@earendil-works/pi-ai/models";

/*
 * Exports: Schema
 */

type DocumentToken =
  | Durable.DocToken<Durable.JsonObject, Durable.DocDefinition<Durable.JsonObject>>
  | Durable.DocFamilyToken<
      Durable.JsonObject,
      Chord.JsonValue,
      Durable.DocFamilyDefinition<Durable.JsonObject, Chord.JsonValue>
    >;

interface DocumentWrite {
  readonly validate: (content: Readonly<Durable.JsonObject>) => boolean;
  readonly initialize: boolean;

  readonly seed?: Chord.JsonValue;
}

interface DocumentAccess {
  readonly token: DocumentToken;

  readonly write?: DocumentWrite;
}

interface DocumentService {
  definitions(
    externalId: string,
    scope: Durable.DocumentAddress["scope"],
    context: Context,
  ): Promise<readonly DocumentToken[] | undefined>;

  resolve(
    externalId: string,
    address: Durable.DocumentAddress,
    context: Context,
  ): Promise<DocumentAccess | undefined>;
}

/** @gqlContext */
export interface ResolverContext {
  readonly context: Context;
  readonly isValidExternalId: (externalId: string) => boolean;

  readonly session: (externalId: string, create?: boolean) => Promise<Durable.Harness | undefined>;
  readonly sessions: () => Promise<readonly string[]>;
  readonly models: () => Models;
  readonly documents: DocumentService;
  readonly settings: SettingsService;
  readonly inventory: InventoryService;
  readonly accounts: AccountsService;
  readonly push: PushBinding;
}

/**
 * Upstream ConversationId: a nonnegative safe-integer JSON number in
 * 0..9007199254740991, not a 32-bit GraphQL Int or global Node ID.
 * @gqlScalar
 */
export type ConversationId = Type.Static<typeof ConversationId>;

/**
 * Upstream EntryId; the same numeric range and representation as ConversationId.
 * @gqlScalar
 */
export type EntryId = Type.Static<typeof EntryId>;

/**
 * Upstream TaskId; the same numeric range and representation as ConversationId.
 * @gqlScalar
 */
export type TaskId = Type.Static<typeof TaskId>;

/**
 * Upstream SubmissionId; the same numeric range and representation as ConversationId.
 * @gqlScalar
 */
export type SubmissionId = Type.Static<typeof SubmissionId>;

/**
 * A finite JSON value, including null; object keys and payloads are preserved.
 * @gqlScalar
 */
export type JsonValue = Type.Static<typeof JsonValue>;

/**
 * Upstream JsonObject: a JSON object with string keys and JsonValue values.
 * @gqlScalar
 */
export type JsonObject = Type.Static<typeof JsonObject>;

/**
 * Backend-owned JSON continuation state. Round-trip it unchanged to the same
 * list or scan; its owning service validates scope. Null means no continuation.
 * @gqlScalar
 */
export type Cursor = Type.Static<typeof Cursor>;

/**
 * Upstream TelemetryCarrier: a JSON object with string keys and string values.
 * @gqlScalar
 */
export type TelemetryCarrier = Type.Static<typeof TelemetryCarrier>;

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
      HarnessTransport: scalar(HarnessTransport),
      HarnessQueueMode: scalar(HarnessQueueMode),
    },
  });
}

/*
 * Exports: Messages
 */

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

/*
 * Exports: Nodes
 */

/**
 * Globally refetchable identity. IDs encode object type and an authorized service
 * namespace/resource key, or persisted session identity and a durable ID. Durable IDs
 * survive Harness reopen and are never reused for replacement storage. An inherited
 * entry has the same ID in every conversation. Clients must not decode IDs.
 *
 * Each resolver reads independently. Repeated IDs do not imply a shared snapshot
 * across node(), connections, or inspection while the Harness is mutating.
 * @gqlInterface
 */
interface Node {
  /** @gqlField */
  readonly id: ID;
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
 * Refetch any Node by global ID; null if it no longer exists or cannot be fetched.
 * @gqlQueryField
 */
export async function node(id: ID, ctx: ResolverContext): Promise<Node | null> {
  try {
    const target = identity(id);
    if (
      target.kind === "Instance" ||
      target.kind === "AuthorizationServer" ||
      target.kind === "Account" ||
      target.kind === "Authorization"
    ) {
      if (target.kind === "Instance")
        return await serviceCall(ctx, async () => {
          const namespace = checked(ServiceKey, ctx.inventory.namespace);
          if (target.namespace !== namespace) return null;
          const record = await ctx.inventory.lookup(target.serviceId, ctx.context);
          if (record === undefined) return null;
          const result = instanceNode(namespace, record);
          assert.equal(result.serviceId, target.serviceId);
          return result;
        });
      const namespace = await serviceCall(ctx, () => checked(ServiceKey, ctx.accounts.namespace));
      if (target.namespace !== namespace) return null;
      return accountNode(ctx, target.kind, target.serviceId);
    }
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
 * Read the reserved root without creating a conversation or enabling scheduling.
 * @gqlField root
 */
export async function harnessRoot(
  source: Harness,
  ctx: ResolverContext,
): Promise<ConversationRecord | null> {
  try {
    const instance = await ctx.session(source.externalId);
    if (!instance) return null;
    const record = await instance.commit(
      (tx) => tx.conversation(ROOT_CONVERSATION_ID),
      ctx.context,
    );
    return record ? projectConversation(source, record) : null;
  } catch (error) {
    throw mapError(error);
  }
}

/*
 * Exports: Documents
 */

/** @gqlEnum */
type DocumentScopeKind = "session" | "conversation" | "task";

/** @gqlEnum */
type DocumentHistory = "latest" | "rewindable";

/** @gqlEnum */
type DocumentFork = "asOf" | "current" | "initial";

/** @gqlInput */
interface DocumentScopeInput {
  readonly kind: DocumentScopeKind;
  readonly conversationId?: ConversationId | null;
  readonly taskId?: TaskId | null;
}

/** @gqlInput */
interface DocumentAddressInput {
  readonly kind: string;
  readonly scope: DocumentScopeInput;
  readonly key?: string | null;
}

/** @gqlType */
interface DocumentDefinition {
  /** @gqlField */
  readonly kind: string;
  /** @gqlField */
  readonly version: Int;
  /** @gqlField */
  readonly scope: DocumentScopeKind;
  /** @gqlField */
  readonly family: boolean | null;
  /** @gqlField */
  readonly history: DocumentHistory | null;
  /** @gqlField */
  readonly fork: DocumentFork | null;
}

/** @gqlInput */
interface ReplaceDocumentInput {
  readonly harnessId: ID;
  readonly address: DocumentAddressInput;
  readonly content: JsonObject;
}

/**
 * Authorized definition metadata for one owner, sorted by kind. Does not enumerate members or initialize documents.
 * @gqlField
 */
export async function documentDefinitions(
  source: Harness,
  scope: DocumentScopeInput,
  ctx: ResolverContext,
): Promise<DocumentDefinition[] | null> {
  try {
    const owner = checked(DocumentScope, scope);
    const instance = await ctx.session(source.externalId);
    if (!instance || !(await instance.commit((tx) => documentOwner(tx, owner), ctx.context)))
      return null;
    const tokens = await serviceCall(ctx, () =>
      ctx.documents.definitions(source.externalId, owner, ctx.context),
    );
    if (tokens === undefined) return null;
    const definitions = tokens.map(({ definition }) => {
      assert.equal(definition.scope, owner.kind);
      assert(
        Number.isInteger(definition.version) &&
          definition.version > 0 &&
          definition.version <= 2147483647,
      );
      return {
        kind: definition.kind,
        version: definition.version,
        scope: definition.scope,
        family: "family" in definition ? definition.family : null,
        history: definition.history ?? null,
        fork: definition.fork ?? null,
      };
    });
    const byKind = new Map(definitions.map((definition) => [definition.kind, definition]));
    assert.equal(byKind.size, definitions.length);
    return [...byKind.keys()].sort().map((kind) => byKind.get(kind)!);
  } catch (error) {
    throw mapError(error);
  }
}

/** @gqlField */
export async function snapshot(
  source: Harness,
  address: DocumentAddressInput,
  ctx: ResolverContext,
): Promise<JsonObject | null> {
  try {
    const resolved = await resolveDocument(source, address, ctx);
    if (!resolved) return null;
    const {
      instance,
      access: {
        token: { definition },
      },
      address: { scope, key },
    } = resolved;
    let value: Readonly<Durable.JsonObject> | undefined;
    switch (definition.scope) {
      case "session":
        value =
          "family" in definition
            ? await instance.snapshot({ definition }, key!, ctx.context)
            : await instance.snapshot({ definition }, ctx.context);
        break;
      case "conversation":
        assert(scope.kind === "conversation");
        value =
          "family" in definition
            ? await instance.snapshot({ definition }, scope.conversationId, key!, ctx.context)
            : await instance.snapshot({ definition }, scope.conversationId, ctx.context);
        break;
      case "task":
        assert(scope.kind === "task");
        value =
          "family" in definition
            ? await instance.snapshot({ definition }, scope.taskId, key!, ctx.context)
            : await instance.snapshot({ definition }, scope.taskId, ctx.context);
        break;
    }
    return value === undefined ? null : jsonObject(value);
  } catch (error) {
    throw mapError(error);
  }
}

/**
 * Replace one exposed application document in one commit. No merge, compare-and-swap, or automatic replay.
 * @gqlMutationField
 */
export async function replaceDocument(
  input: ReplaceDocumentInput,
  ctx: ResolverContext,
): Promise<JsonObject | null> {
  try {
    const target = identity(input.harnessId);
    if (target.kind !== "Harness") throw new ResolverError("BAD_REQUEST");
    const resolved = await resolveDocument(harnessNode(target.externalId), input.address, ctx);
    if (!resolved) throw new ResolverError("NOT_FOUND");
    const {
      instance,
      access,
      address: { scope, key },
    } = resolved;
    const write = access.write;
    if (!write || access.token.definition.kind.startsWith("pi."))
      throw new ResolverError("BAD_REQUEST");
    const content = jsonObject(input.content);
    if (!(await serviceCall(ctx, () => write.validate(content))))
      throw new ResolverError("BAD_REQUEST");
    const original = access.token.definition;
    if ("family" in original && write.initialize) assert(write.seed !== undefined);
    const definition = {
      ...original,
      initial(seed?: Chord.JsonValue) {
        if (!write.initialize) throw new ResolverError("BAD_REQUEST");
        if ("family" in original) {
          assert(seed !== undefined);
          return original.initial(seed);
        }
        return original.initial();
      },
      checkpointWhen: original.checkpointWhen.bind(original),
      ...(original.migrate === undefined ? {} : { migrate: original.migrate.bind(original) }),
    };
    return await harnessOperation(instance, ctx, () =>
      instance.commit(async (tx) => {
        if (!(await documentOwner(tx, scope))) throw new ResolverError("NOT_FOUND");
        let draft: Durable.JsonObject;
        switch (definition.scope) {
          case "session":
            draft =
              "family" in definition
                ? await tx.doc({ definition }, key!, write.seed ?? null)
                : await tx.doc({ definition });
            break;
          case "conversation":
            assert(scope.kind === "conversation");
            draft =
              "family" in definition
                ? await tx.doc({ definition }, scope.conversationId, key!, write.seed ?? null)
                : await tx.doc({ definition }, scope.conversationId);
            break;
          case "task":
            assert(scope.kind === "task");
            draft =
              "family" in definition
                ? await tx.doc({ definition }, scope.taskId, key!, write.seed ?? null)
                : await tx.doc({ definition }, scope.taskId);
            break;
        }
        for (const property of Object.keys(draft)) delete draft[property];
        Object.assign(draft, content);
        return jsonObject(draft);
      }, ctx.context),
    );
  } catch (error) {
    throw mapError(error);
  }
}

/*
 * Exports: Model catalog
 */

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
      cost: { ...model.cost, tiers: model.cost.tiers ?? null },
      thinkingLevels: getSupportedThinkingLevels(model),
    }));
  } catch (error) {
    throw mapError(error);
  }
}

/*
 * Exports: Inspection
 */

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
 * input done has entry and answer; write done has entry only; continue done has
 * answer only. Placed applies to input and continue. Unanswered has reason and
 * optional detail, with optional entry only for input.
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
type SubmissionRecordType = "input" | "write" | "continue";

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
 * Every upstream inspection discriminant is retained. pending carries migrates;
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
  | "pending"
  | "waiting"
  | "sleeping"
  | "completing"
  | "blocked";

/** @gqlEnum */
type BlockedReason = "missing_task" | "task_too_old" | "migration_failed";

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
 * Conversation.agent(): settings resolved against the current registry and host
 * settings, not just stored overrides. Does not enable scheduling.
 * @gqlField
 */
export async function agent(source: ConversationRecord, ctx: ResolverContext): Promise<Agent> {
  try {
    const { handle } = await requireConversation(ctx, source);
    const value = await handle.agent(ctx.context);
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
    const { handle } = await requireConversation(ctx, source);
    const page = await handle.entries(filters, limit, cursor ?? undefined, ctx.context);
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
    const { handle } = await requireConversation(ctx, source);
    const value = await handle.context(ctx.context, at === undefined ? {} : { at });
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

/*
 * Exports: Submissions
 */

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

/** @gqlType */
interface SubmitPayload {
  /**
   * Transport reference to Submission.id as a global SubmissionRecord ID.
   * node(id) reads its receipt; this payload is not itself the submission Node.
   * @gqlField
   */
  readonly submissionId: ID;
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
 * GraphQL name for Awaited<ReturnType<Harness["abortSubmission"]>>.
 * @gqlEnum
 */
type HarnessAbortSubmissionResult =
  | "aborted"
  | "already_placed"
  | "settled"
  /** Unknown submission or one belonging to another conversation; not an error. */
  | "not_found";

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
    const { source, handle, instance } = await mutationConversation(ctx, input.conversationId);
    const result = await harnessOperation(instance, ctx, () =>
      handle.submit(submissionDraft(input.submission), ctx.context),
    );
    return {
      submissionId: globalId("SubmissionRecord", source.harness.externalId, result.id),
    };
  } catch (error) {
    throw mapError(error);
  }
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
    const { source, instance } = await mutationConversation(ctx, input.conversationId);
    const result = await harnessOperation(instance, ctx, () =>
      instance.abortSubmission(input.id, ctx.context, source.durableId),
    );
    return { result };
  } catch (error) {
    throw mapError(error);
  }
}

/*
 * Exports: Conversation lifecycle
 */

/** @gqlInput */
interface AbortInput {
  readonly conversationId: ID;
}

/** @gqlInput */
interface OpenInput {
  readonly externalId: string;
}

/** @gqlType */
interface OpenPayload {
  /** @gqlField */
  readonly harness: Harness;
}

/** @gqlInput */
interface RootInput {
  readonly harnessId: ID;
  readonly options?: RootOptionsInput | null;
}

/** @gqlInput */
interface RootOptionsInput {
  readonly env?: SshTargetInput | null;
  readonly agent?: AgentChange | null;
}

/** @gqlType */
interface RootPayload {
  /** @gqlField */
  readonly conversation: ConversationRecord;
}

/** @gqlEnum */
type ConversationOwnershipKind = "ownerless" | "task";

/** @gqlInput */
interface ConversationOwnershipInput {
  readonly kind: ConversationOwnershipKind;
  readonly taskId?: TaskId | null;
}

/** @gqlInput */
interface ConversationCreateOptionsInput {
  readonly env?: SshTargetInput | null;
  readonly ownership: ConversationOwnershipInput;
  readonly agent?: AgentChange | null;
}

/** @gqlInput */
interface CreateConversationInput {
  readonly harnessId: ID;
  readonly options: ConversationCreateOptionsInput;
}

/** @gqlType */
interface CreateConversationPayload {
  /** @gqlField */
  readonly conversation: ConversationRecord;
}

/** @gqlInput */
interface ResumeInput {
  /** Global Harness ID, not its externalId key. */
  readonly harnessId: ID;
}

/** @gqlInput */
interface ResetInput {
  readonly conversationId: ID;
  /** Omit for no handoff; preserve a supplied string, including the empty string. */
  readonly handoff?: string | null;
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
 * Withdraw queued inputs and abort ordinary owned work; preserve background work
 * and queued writes. Resolves after upstream abort completes. No background flag.
 * @gqlMutationField
 */
export async function abort(input: AbortInput, ctx: ResolverContext): Promise<boolean | null> {
  try {
    const { handle, instance } = await mutationConversation(ctx, input.conversationId);
    await harnessOperation(instance, ctx, () => handle.abort(ctx.context));
    return true;
  } catch (error) {
    throw mapError(error);
  }
}

/**
 * Find or create authorized persisted storage through the shared Harness owner.
 * Does not create a root, change an existing Harness, or enable scheduling.
 * @gqlMutationField
 */
export async function open(input: OpenInput, ctx: ResolverContext): Promise<OpenPayload | null> {
  try {
    let valid: boolean;
    try {
      valid = ctx.isValidExternalId(input.externalId);
    } catch {
      throw new ResolverError("INTERNAL_SERVER_ERROR");
    }
    if (!valid) throw new ResolverError("BAD_REQUEST");
    if (!(await ctx.session(input.externalId, true))) throw new ResolverError("NOT_FOUND");
    return { harness: harnessNode(input.externalId) };
  } catch (error) {
    throw mapError(error);
  }
}

/**
 * Get or create the reserved root. Initial agent and env changes apply only at creation.
 * Does not submit input or enable scheduling.
 * @gqlMutationField
 */
export async function root(input: RootInput, ctx: ResolverContext): Promise<RootPayload | null> {
  try {
    if (input.options === null) throw new ResolverError("BAD_REQUEST");
    const { env, ...rest } = input.options ?? {};
    const options = nonNull(rest);
    const init = envInit(env);
    const { source, instance } = await mutationHarness(ctx, input.harnessId);
    const handle = await harnessOperation(instance, ctx, () =>
      instance.root(ctx.context, { ...options, ...(init === undefined ? {} : { init }) }),
    );
    return { conversation: await createdConversation(instance, source, handle.id, ctx) };
  } catch (error) {
    throw mapError(error);
  }
}

/**
 * Create another conversation with explicit ownership and initial agent settings.
 * Each call creates a new conversation; no submission, scheduling, or automatic replay.
 * @gqlMutationField
 */
export async function createConversation(
  input: CreateConversationInput,
  ctx: ResolverContext,
): Promise<CreateConversationPayload | null> {
  try {
    const { env, ...rest } = input.options;
    const options = nonNull(rest);
    const init = envInit(env);
    const ownership = checked(ConversationOwnership, options.ownership);
    const { source, instance } = await mutationHarness(ctx, input.harnessId);
    if (ownership.kind === "task" && !(await instance.getTask(ownership.taskId, ctx.context)))
      throw new ResolverError("NOT_FOUND");
    const handle = await harnessOperation(instance, ctx, () =>
      instance.createConversation(
        { ...options, ownership, ...(init === undefined ? {} : { init }) },
        ctx.context,
      ),
    );
    return { conversation: await createdConversation(instance, source, handle.id, ctx) };
  } catch (error) {
    throw mapError(error);
  }
}

/**
 * Return true after enabling Harness scheduling, not after work completes.
 * @gqlMutationField
 */
export async function resume(input: ResumeInput, ctx: ResolverContext): Promise<boolean | null> {
  try {
    const { instance } = await mutationHarness(ctx, input.harnessId);
    instance.resume();
    return true;
  } catch (error) {
    throw mapError(error);
  }
}

/**
 * Return true after reset admission, not necessarily placement. No idempotency key.
 * @gqlMutationField
 */
export async function reset(input: ResetInput, ctx: ResolverContext): Promise<boolean | null> {
  try {
    const { handoff } = input;
    if (handoff === null) throw new ResolverError("BAD_REQUEST");
    const { handle, instance } = await mutationConversation(ctx, input.conversationId);
    await harnessOperation(instance, ctx, () => handle.reset(handoff, ctx.context));
    return true;
  } catch (error) {
    throw mapError(error);
  }
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
    const { instructions } = input;
    if (instructions === null) throw new ResolverError("BAD_REQUEST");
    const { source, handle, instance } = await mutationConversation(ctx, input.conversationId);
    const id = await harnessOperation(instance, ctx, () =>
      handle.compact(instructions, ctx.context),
    );
    return {
      taskId: globalId("TaskRecord", source.harness.externalId, id),
    };
  } catch (error) {
    throw mapError(error);
  }
}

/*
 * Exports: Environments
 */

/** @gqlEnum */
type ExecutionEnvType = "ssh";

/** Connection data, not an executable environment or SSH binary configuration. @gqlType */
interface SshTarget {
  /** @gqlField */
  readonly type: ExecutionEnvType;
  /** @gqlField */
  readonly host: string;
  /** @gqlField */
  readonly user?: string | null;
  /** @gqlField */
  readonly port?: Int | null;
  /** @gqlField */
  readonly identityFile?: string | null;
  /** @gqlField */
  readonly knownHostsFile: string;
  /** @gqlField */
  readonly hostKeyAlias: string;
  /** @gqlField */
  readonly configFile?: string | null;
}

/** Optional target fields accept null as omission. @gqlInput */
interface SshTargetInput {
  readonly type: ExecutionEnvType;
  readonly host: string;
  readonly user?: string | null;
  readonly port?: Int | null;
  readonly identityFile?: string | null;
  readonly knownHostsFile: string;
  readonly hostKeyAlias: string;
  readonly configFile?: string | null;
}

/** @gqlInput */
interface ConfigureInput {
  readonly env?: SshTargetInput | null;
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

/** Persisted selection only. Reading it does not acquire an execution environment. @gqlField env */
export async function conversationEnv(
  source: ConversationRecord,
  ctx: ResolverContext,
): Promise<SshTarget | null> {
  try {
    const { instance } = await requireConversation(ctx, source);
    const value = (await instance.snapshot(Env, source.durableId, ctx.context))?.env;
    return value === undefined ? null : sshTarget(value);
  } catch (error) {
    throw mapError(error);
  }
}

/**
 * Change agent overrides and env selection atomically, including during active work.
 * Read resolved agent settings through agent and persisted selection through env.
 * @gqlMutationField
 */
export async function configure(
  input: ConfigureInput,
  ctx: ResolverContext,
): Promise<boolean | null> {
  try {
    const { handle, instance } = await mutationConversation(ctx, input.conversationId);
    const init = envInit(input.env);
    await harnessOperation(instance, ctx, () =>
      handle.commit(async (tx) => {
        await configureAgent(tx, handle.id, input.change);
        await init?.(tx, handle.id);
      }, ctx.context),
    );
    return true;
  } catch (error) {
    throw mapError(error);
  }
}

/*
 * Exports: Settings
 */

/** @gqlEnum */
type App = "web" | "harness";

/** @gqlEnum */
type WwwDeliveryMode = "followUp" | "steer";

/** Native provider transport string. @gqlScalar */
export type HarnessTransport = Type.Static<typeof HarnessTransport>;

/** Native Durable queue policy string. @gqlScalar */
export type HarnessQueueMode = Type.Static<typeof HarnessQueueMode>;

/** @gqlInput */
interface HarnessStreamSettingsInput {
  readonly transport: HarnessTransport;
}

/** @gqlType */
interface HarnessStreamSettings {
  /** @gqlField */
  readonly transport: HarnessTransport;
}

/** @gqlInput */
export interface WwwSettingsInput {
  readonly wrapCode: boolean;
  readonly bottomAlign: boolean;
  readonly hideThinkingBlock: boolean;
  readonly showImages: boolean;
  readonly defaultDeliveryMode: WwwDeliveryMode;
}

/** @gqlType */
interface WebSettings {
  readonly __typename: "WebSettings";
  /** @gqlField */
  readonly wrapCode: boolean;
  /** @gqlField */
  readonly bottomAlign: boolean;
  /** @gqlField */
  readonly hideThinkingBlock: boolean;
  /** @gqlField */
  readonly showImages: boolean;
  /** @gqlField */
  readonly defaultDeliveryMode: WwwDeliveryMode;
}

/** @gqlInput */
interface HarnessRetrySettingsInput {
  readonly enabled: boolean;
  readonly maxRetries: Int;
  readonly baseDelayMs: Int;
  readonly maxAgentDelayMs: Int;
}

/** @gqlType */
interface HarnessRetrySettings {
  /** @gqlField */
  readonly enabled: boolean;
  /** @gqlField */
  readonly maxRetries: Int;
  /** @gqlField */
  readonly baseDelayMs: Int;
  /** @gqlField */
  readonly maxAgentDelayMs: Int;
}

/** @gqlInput */
interface HarnessCompactionSettingsInput {
  readonly enabled: boolean;
  readonly reserveTokens: Int;
  readonly keepRecentTokens: Int;
  readonly backgroundTokens: Int;
}

/** @gqlType */
interface HarnessCompactionSettings {
  /** @gqlField */
  readonly enabled: boolean;
  /** @gqlField */
  readonly reserveTokens: Int;
  /** @gqlField */
  readonly keepRecentTokens: Int;
  /** @gqlField */
  readonly backgroundTokens: Int;
}

/** @gqlInput */
export interface HarnessSettingsInput {
  readonly stream: HarnessStreamSettingsInput;
  readonly steeringMode: HarnessQueueMode;
  readonly followUpMode: HarnessQueueMode;
  readonly retry: HarnessRetrySettingsInput;
  readonly compaction: HarnessCompactionSettingsInput;
}

/** @gqlType */
interface HarnessSettings {
  readonly __typename: "HarnessSettings";
  /** @gqlField */
  readonly stream: HarnessStreamSettings;
  /** @gqlField */
  readonly steeringMode: HarnessQueueMode;
  /** @gqlField */
  readonly followUpMode: HarnessQueueMode;
  /** @gqlField */
  readonly retry: HarnessRetrySettings;
  /** @gqlField */
  readonly compaction: HarnessCompactionSettings;
}

/** @gqlUnion */
type Settings = WebSettings | HarnessSettings;

/** @gqlInput */
type SaveSettingsInput = { web: SaveWwwSettingsInput } | { harness: SaveHarnessSettingsInput };

/** @gqlInput */
interface SaveWwwSettingsInput {
  readonly settings: WwwSettingsInput;
}

/** @gqlInput */
interface SaveHarnessSettingsInput {
  readonly settings: HarnessSettingsInput;
}

export interface Configuration<T> {
  read(context: Context): Promise<T>;
  replace(settings: T, context: Context): Promise<T>;
}

export interface SettingsService {
  readonly web: Configuration<WwwSettingsInput>;
  readonly harness: Configuration<HarnessSettingsInput>;
}

const PolicyInteger = Type.Integer({ minimum: 0, maximum: 2147483647 });

export const WwwSettingsInput = Type.Object(
  {
    wrapCode: Type.Boolean(),
    bottomAlign: Type.Boolean(),
    hideThinkingBlock: Type.Boolean(),
    showImages: Type.Boolean(),
    defaultDeliveryMode: Type.Union([Type.Literal("followUp"), Type.Literal("steer")]),
  },
  { additionalProperties: false },
);

const HarnessQueueMode = Type.Union([Type.Literal("one-at-a-time"), Type.Literal("all")]);

const HarnessTransport = Type.Union([
  Type.Literal("auto"),
  Type.Literal("sse"),
  Type.Literal("websocket"),
  Type.Literal("websocket-cached"),
]);

export const HarnessSettingsInput = Type.Object(
  {
    stream: Type.Object({ transport: HarnessTransport }, { additionalProperties: false }),
    steeringMode: HarnessQueueMode,
    followUpMode: HarnessQueueMode,
    retry: Type.Object(
      {
        enabled: Type.Boolean(),
        maxRetries: PolicyInteger,
        baseDelayMs: PolicyInteger,
        maxAgentDelayMs: PolicyInteger,
      },
      { additionalProperties: false },
    ),
    compaction: Type.Object(
      {
        enabled: Type.Boolean(),
        reserveTokens: PolicyInteger,
        keepRecentTokens: PolicyInteger,
        backgroundTokens: PolicyInteger,
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

/**
 * Read resolved application configuration without acquiring a Harness or creating files.
 * @gqlQueryField
 */
export async function settings(app: App, ctx: ResolverContext): Promise<Settings | null> {
  try {
    if (app === "web") {
      const value = configurationValue(
        WwwSettingsInput,
        await serviceCall(ctx, () => ctx.settings.web.read(ctx.context)),
      );
      return { ...value, __typename: "WebSettings" };
    }
    const value = configurationValue(
      HarnessSettingsInput,
      await serviceCall(ctx, () => ctx.settings.harness.read(ctx.context)),
    );
    return { ...value, __typename: "HarnessSettings" };
  } catch (error) {
    throw mapError(error);
  }
}

/**
 * Replace the application settings file.
 * Saves affect later Harness opens, not current execution. Never replay after a lost response.
 * @gqlMutationField
 */
export async function saveSettings(
  input: SaveSettingsInput,
  ctx: ResolverContext,
): Promise<Settings | null> {
  try {
    if ("web" in input) {
      const { settings } = input.web;
      checked(WwwSettingsInput, settings);
      const saved = await serviceCall(ctx, () => ctx.settings.web.replace(settings, ctx.context));
      const value = configurationValue(WwwSettingsInput, saved);
      return { ...value, __typename: "WebSettings" };
    }
    const { settings } = input.harness;
    checked(HarnessSettingsInput, settings);
    const saved = await serviceCall(ctx, () => ctx.settings.harness.replace(settings, ctx.context));
    const value = configurationValue(HarnessSettingsInput, saved);
    return { ...value, __typename: "HarnessSettings" };
  } catch (error) {
    throw mapError(error);
  }
}

/*
 * Exports: Inventory
 */

export interface InventoryRecord {
  readonly id: string;
  readonly unit: string;
}

export interface InventoryPhase {
  readonly phase: string;
  readonly clock: string;
  readonly monotonic_s: number;
  readonly resolution_s: number;
}

export interface InventoryService {
  readonly namespace: string;

  list(
    limit: number,
    cursor: Cursor | undefined,
    context: Context,
  ): Promise<InventoryPage | { readonly invalidCursor: true }>;
  lookup(id: string, context: Context): Promise<InventoryRecord | undefined>;

  flakeReference(id: string, context: Context): Promise<string | undefined>;
  connect(id: string, context: Context): Promise<Omit<NativeSshTarget, "ssh"> | undefined>;
  state(id: string, context: Context): Promise<InstanceState | undefined>;

  timings(id: string, context: Context): Promise<InventoryTimings | undefined>;
}

/** @gqlType */
interface Instance extends Node {
  readonly __typename: "Instance";
  readonly serviceId: string;
  /** @gqlField */
  readonly id: ID;
  /** @gqlField */
  readonly unit: string;
}

/** @gqlType */
interface InstanceState {
  /** @gqlField */
  readonly activeState: string;
  /** @gqlField */
  readonly subState: string;
  /** @gqlField */
  readonly result?: string | null;
}

/** @gqlType */
interface InstanceTimings {
  /** @gqlField */
  readonly invocationId: string;
  /** @gqlField */
  readonly activationUs?: Float | null;
  /** @gqlField */
  readonly workerUs?: Float | null;
  /** @gqlField */
  readonly bootWaitUs?: Float | null;
  /** @gqlField */
  readonly provisionUs?: Float | null;
  /** @gqlField */
  readonly managerGapsUs?: Float | null;
  /** @gqlField */
  readonly hostPhases?: readonly InstanceTimingPhase[] | null;
  /** @gqlField */
  readonly guestPhases?: readonly InstanceTimingPhase[] | null;
}

/** @gqlType */
interface InstanceTimingPhase {
  /** @gqlField */
  readonly phase: string;
  /** @gqlField */
  readonly clock: string;
  /** @gqlField */
  readonly monotonicSeconds: Float;
  /** @gqlField */
  readonly resolutionSeconds: Float;
}

/**
 * Read one inventory page without acquiring a Harness or connecting to guests.
 * Membership and ordering belong to the inventory service, not the Harness catalog.
 * @gqlQueryField
 */
export async function instances(
  limit: Int,
  ctx: ResolverContext,
  cursor?: Cursor | null,
): Promise<Connection<Instance> | null> {
  return applicationPage(
    ctx,
    ctx.inventory.namespace,
    limit,
    cursor,
    (limit, cursor, context) => ctx.inventory.list(limit, cursor, context),
    instanceNode,
  );
}

/** Unavailable metadata is null; observation errors do not erase membership. @gqlField flakeReference */
export async function instanceFlakeReference(
  source: Instance,
  ctx: ResolverContext,
): Promise<string | null> {
  return serviceCall(ctx, async () => {
    const value = await ctx.inventory.flakeReference(source.serviceId, ctx.context);
    if (value === undefined) return null;
    assert(typeof value === "string");
    return value;
  });
}

/** SSH connection data only; does not connect or start the instance. @gqlField connect */
export async function instanceConnect(
  source: Instance,
  ctx: ResolverContext,
): Promise<SshTarget | null> {
  return serviceCall(ctx, async () => {
    const target = await ctx.inventory.connect(source.serviceId, ctx.context);
    return target === undefined ? null : sshTarget({ ...target, type: "ssh" });
  });
}

/** Observed systemd strings, without conversion to a closed enum. @gqlField state */
export async function instanceState(
  source: Instance,
  ctx: ResolverContext,
): Promise<InstanceState | null> {
  return serviceCall(ctx, async () => {
    const value = await ctx.inventory.state(source.serviceId, ctx.context);
    if (value === undefined) return null;
    const result = {
      activeState: value.activeState,
      subState: value.subState,
      result: value.result ?? null,
    };
    assert(Value.Check(InstanceState, result));
    return result;
  });
}

/**
 * Durations are microseconds; phase samples retain their clock and seconds.
 * The service validates invocation coherence and activation success. No clocks are combined here.
 * @gqlField timings
 */
export async function instanceTimings(
  source: Instance,
  ctx: ResolverContext,
): Promise<InstanceTimings | null> {
  return serviceCall(ctx, async () => {
    const value = await ctx.inventory.timings(source.serviceId, ctx.context);
    if (value === undefined) return null;
    const result: InstanceTimings = {
      invocationId: value.invocation_id,
      activationUs: value.activation_us ?? null,
      workerUs: value.worker_us ?? null,
      bootWaitUs: value.boot_wait_us ?? null,
      provisionUs: value.provision_us ?? null,
      managerGapsUs: value.manager_gaps_us ?? null,
      hostPhases: value.host_phases?.map(instancePhase) ?? null,
      guestPhases: value.guest_phases?.map(instancePhase) ?? null,
    };
    assert(Value.Check(InstanceTimings, result));
    return result;
  });
}

/*
 * Exports: Accounts
 */

/** @gqlEnum */
type AccountStatus = "usable" | "temporarilyUnavailable" | "reauthorizationRequired";

/** @gqlEnum */
type AuthorizationStatus = "pending" | "completed" | "cancelled" | "failed";

/** @gqlType */
interface AuthorizationServer extends Node {
  readonly __typename: "AuthorizationServer";
  readonly serviceId: string;
  /** @gqlField */
  readonly id: ID;
  /** @gqlField */
  readonly label: string;
  /** @gqlField */
  readonly authorization_endpoint?: string | null;
  /** @gqlField */
  readonly token_endpoint?: string | null;
  /** @gqlField */
  readonly device_authorization_endpoint?: string | null;
  /** @gqlField */
  readonly revocation_endpoint?: string | null;
  /** @gqlField */
  readonly grant_types_supported?: readonly string[] | null;
}

/** @gqlType */
interface Account extends Node {
  readonly __typename: "Account";
  readonly serviceId: string;
  /** @gqlField */
  readonly id: ID;
  readonly serverId: string;
  /** @gqlField */
  readonly identifier?: string | null;
  /** @gqlField */
  readonly displayName?: string | null;
  /** @gqlField */
  readonly status: AccountStatus;
  /** @gqlField */
  readonly scope?: string | null;
}

/** @gqlType */
interface Authorization extends Node {
  readonly __typename: "Authorization";
  readonly serviceId: string;
  /** @gqlField */
  readonly id: ID;
  readonly serverId: string;
  readonly accountId?: string | null;
  /** @gqlField */
  readonly status: AuthorizationStatus;
  /** @gqlField */
  readonly createdAt: Float;
  /** @gqlField */
  readonly request?: AuthorizationRequest | null;
  /** @gqlField */
  readonly deviceAuthorizationResponse?: DeviceAuthorizationResponse | null;
  /** @gqlField */
  readonly error?: AuthorizationErrorResponse | null;
}

/** @gqlType */
interface AuthorizationRequest {
  /** @gqlField */
  readonly url: string;
  /** @gqlField */
  readonly response_type: string;
  /** @gqlField */
  readonly client_id: string;
  /** @gqlField */
  readonly redirect_uri: string;
  /** @gqlField */
  readonly scope?: string | null;
  /** @gqlField */
  readonly state: string;
  /** @gqlField */
  readonly code_challenge: string;
  /** @gqlField */
  readonly code_challenge_method: string;
}

/** @gqlType */
interface DeviceAuthorizationResponse {
  /** @gqlField */
  readonly user_code: string;
  /** @gqlField */
  readonly verification_uri: string;
  /** @gqlField */
  readonly verification_uri_complete?: string | null;
  /** @gqlField */
  readonly expires_in: Int;
  /** @gqlField */
  readonly interval?: Int | null;
}

/** @gqlType */
interface AuthorizationErrorResponse {
  /** @gqlField */
  readonly error: string;
  /** @gqlField */
  readonly error_description?: string | null;
  /** @gqlField */
  readonly error_uri?: string | null;
}

/** @gqlInput */
interface AuthorizeInput {
  readonly serverId: ID;
  readonly accountId?: ID | null;
}

/** @gqlInput */
interface DeviceAuthorizationInput {
  readonly serverId: ID;
  readonly accountId?: ID | null;
}

/** @gqlInput */
interface CancelAuthorizationInput {
  readonly authorizationId: ID;
}

/** @gqlInput */
interface DisconnectInput {
  readonly accountId: ID;
}

/** @gqlInput */
interface RevokeInput {
  readonly accountId: ID;
  readonly token_type_hint?: string | null;
}

export type AuthorizationServerRecord = Omit<AuthorizationServer, "__typename" | "serviceId">;

export type AccountRecord = Omit<Account, "__typename" | "serviceId">;

export type AuthorizationRecord = Omit<Authorization, "__typename" | "serviceId">;

export interface AccountsService {
  readonly namespace: string;
  servers(
    limit: number,
    cursor: Cursor | undefined,
    context: Context,
  ): Promise<ApplicationPageResult<AuthorizationServerRecord>>;
  accounts(
    serverId: string | undefined,
    limit: number,
    cursor: Cursor | undefined,
    context: Context,
  ): Promise<ApplicationPageResult<AccountRecord>>;
  authorizations(
    serverId: string,
    limit: number,
    cursor: Cursor | undefined,
    context: Context,
  ): Promise<ApplicationPageResult<AuthorizationRecord>>;
  server(id: string, context: Context): Promise<AuthorizationServerRecord | undefined>;
  account(id: string, context: Context): Promise<AccountRecord | undefined>;
  authorization(id: string, context: Context): Promise<AuthorizationRecord | undefined>;

  authorize(
    serverId: string,
    accountId: string | undefined,
    context: Context,
  ): Promise<ApplicationResult<AuthorizationRecord>>;
  deviceAuthorization(
    serverId: string,
    accountId: string | undefined,
    context: Context,
  ): Promise<ApplicationResult<AuthorizationRecord>>;
  cancelAuthorization(id: string, context: Context): Promise<ApplicationResult<void>>;
  disconnect(id: string, context: Context): Promise<ApplicationResult<void>>;

  revoke(
    id: string,
    hint: "access_token" | "refresh_token" | undefined,
    context: Context,
  ): Promise<ApplicationResult<void> | { readonly protocolError: string }>;
}

/** @gqlQueryField */
export async function authorizationServers(
  limit: Int,
  ctx: ResolverContext,
  cursor?: Cursor | null,
): Promise<Connection<AuthorizationServer> | null> {
  return applicationPage(
    ctx,
    ctx.accounts.namespace,
    limit,
    cursor,
    (limit, cursor, context) => ctx.accounts.servers(limit, cursor, context),
    serverRecord,
  );
}

/** @gqlQueryField */
export async function accounts(
  limit: Int,
  ctx: ResolverContext,
  cursor?: Cursor | null,
): Promise<Connection<Account> | null> {
  return applicationPage(
    ctx,
    ctx.accounts.namespace,
    limit,
    cursor,
    (limit, cursor, context) => ctx.accounts.accounts(undefined, limit, cursor, context),
    accountRecord,
  );
}

/** @gqlField accounts */
export async function serverAccounts(
  source: AuthorizationServer,
  limit: Int,
  ctx: ResolverContext,
  cursor?: Cursor | null,
): Promise<Connection<Account> | null> {
  return applicationPage(
    ctx,
    ctx.accounts.namespace,
    limit,
    cursor,
    (limit, cursor, context) => ctx.accounts.accounts(source.serviceId, limit, cursor, context),
    (namespace, value) => {
      const result = accountRecord(namespace, value);
      assert.equal(result.serverId, source.serviceId);
      return result;
    },
  );
}

/** @gqlField */
export async function authorizations(
  source: AuthorizationServer,
  limit: Int,
  ctx: ResolverContext,
  cursor?: Cursor | null,
): Promise<Connection<Authorization> | null> {
  return applicationPage(
    ctx,
    ctx.accounts.namespace,
    limit,
    cursor,
    (limit, cursor, context) =>
      ctx.accounts.authorizations(source.serviceId, limit, cursor, context),
    (namespace, value) => {
      const result = authorizationRecord(namespace, value);
      assert.equal(result.serverId, source.serviceId);
      return result;
    },
  );
}

/** @gqlField server */
export async function accountServer(
  source: Account,
  ctx: ResolverContext,
): Promise<AuthorizationServer> {
  return relatedServer(ctx, source.serverId);
}

/** @gqlField server */
export async function authorizationServer(
  source: Authorization,
  ctx: ResolverContext,
): Promise<AuthorizationServer> {
  return relatedServer(ctx, source.serverId);
}

/** @gqlField account */
export async function authorizationAccount(
  source: Authorization,
  ctx: ResolverContext,
): Promise<Account | null> {
  if (source.accountId == null) return null;
  const result = await accountNode(ctx, "Account", source.accountId);
  if (result !== null && result.serverId !== source.serverId)
    throw new ResolverError("INTERNAL_SERVER_ERROR");
  return result;
}

/** Create a service-owned authorization-code flow. Never replay initiation. @gqlMutationField */
export async function authorize(
  input: AuthorizeInput,
  ctx: ResolverContext,
): Promise<Authorization | null> {
  return startAuthorization(input, ctx, "authorize");
}

/** Create a device flow; the service, not browser reads, owns token polling. @gqlMutationField */
export async function deviceAuthorization(
  input: DeviceAuthorizationInput,
  ctx: ResolverContext,
): Promise<Authorization | null> {
  return startAuthorization(input, ctx, "deviceAuthorization");
}

/** Cancel local processing, not provider credentials. @gqlMutationField */
export async function cancelAuthorization(
  input: CancelAuthorizationInput,
  ctx: ResolverContext,
): Promise<boolean | null> {
  const id = await accountTarget(input.authorizationId, "Authorization", ctx);
  const value = await applicationResult(ctx, () =>
    ctx.accounts.cancelAuthorization(id, ctx.context),
  );
  if (value !== undefined) throw new ResolverError("INTERNAL_SERVER_ERROR");
  return true;
}

/** Remove local credential use/storage independently of provider revocation. @gqlMutationField */
export async function disconnect(
  input: DisconnectInput,
  ctx: ResolverContext,
): Promise<boolean | null> {
  const id = await accountTarget(input.accountId, "Account", ctx);
  const value = await applicationResult(ctx, () => ctx.accounts.disconnect(id, ctx.context));
  if (value !== undefined) throw new ResolverError("INTERNAL_SERVER_ERROR");
  return true;
}

/** Revoke stored credentials; an acknowledgment does not mean local removal. @gqlMutationField */
export async function revoke(input: RevokeInput, ctx: ResolverContext): Promise<boolean | null> {
  const hint = input.token_type_hint;
  if (hint !== undefined && hint !== "access_token" && hint !== "refresh_token")
    throw new ResolverError("BAD_REQUEST");
  const id = await accountTarget(input.accountId, "Account", ctx);
  const value = await applicationResult<{ protocol: string } | undefined>(ctx, async () => {
    const result = await ctx.accounts.revoke(id, hint, ctx.context);
    if ("protocolError" in result) {
      assert(Value.Check(ProtocolErrorCode, result.protocolError));
      return { value: { protocol: result.protocolError } };
    }
    if ("error" in result) return result;
    assert.equal(result.value, undefined);
    return { value: undefined };
  });
  if (value !== undefined) throw new ResolverError(value);
  return true;
}

/*
 * Exports: Push
 */

/** @gqlInput */
interface PushSubscriptionKeysInput {
  readonly p256dh: string;
  readonly auth: string;
}

/** @gqlInput */
interface RegisterPushSubscriptionInput {
  readonly endpoint: string;
  readonly keys: PushSubscriptionKeysInput;
}

/** @gqlInput */
interface RemovePushSubscriptionInput {
  readonly endpoint: string;
}

export interface PushBinding {
  applicationServerKey(context: Context): Promise<string | undefined>;
  registered(endpoint: string, context: Context): Promise<ApplicationResult<boolean>>;

  register(
    subscription: RegisterPushSubscriptionInput,
    context: Context,
  ): Promise<ApplicationResult<void>>;

  remove(endpoint: string, context: Context): Promise<ApplicationResult<void>>;
}

/** @gqlType */
interface PushService {
  readonly binding: PushBinding;
}

/** Public push configuration and the authorized user's registrations, not browser permission. @gqlQueryField */
export function push(ctx: ResolverContext): PushService | null {
  return { binding: ctx.push };
}

/** A null public key means delivery is disabled. @gqlField */
export async function applicationServerKey(
  source: PushService,
  ctx: ResolverContext,
): Promise<string | null> {
  return serviceCall(ctx, async () => {
    const value = await source.binding.applicationServerKey(ctx.context);
    return value === undefined ? null : checked(ServiceKey, value);
  });
}

/** Registration does not prove matching browser keys, permission, or successful delivery. @gqlField */
export async function registered(
  source: PushService,
  endpoint: string,
  ctx: ResolverContext,
): Promise<boolean | null> {
  checked(ServiceKey, endpoint);
  const value = await applicationResult(ctx, () =>
    source.binding.registered(endpoint, ctx.context),
  );
  if (typeof value !== "boolean") throw new ResolverError("INTERNAL_SERVER_ERROR");
  return value;
}

/** Persist the full browser subscription. No delivery is triggered by the adapter. @gqlMutationField */
export async function registerPushSubscription(
  input: RegisterPushSubscriptionInput,
  ctx: ResolverContext,
): Promise<boolean | null> {
  checked(ServiceKey, input.endpoint);
  checked(ServiceKey, input.keys.p256dh);
  checked(ServiceKey, input.keys.auth);
  const value = await applicationResult(ctx, () => ctx.push.register(input, ctx.context));
  if (value !== undefined) throw new ResolverError("INTERNAL_SERVER_ERROR");
  return true;
}

/** Remove the authorized user's endpoint registration, including with delivery disabled. @gqlMutationField */
export async function removePushSubscription(
  input: RemovePushSubscriptionInput,
  ctx: ResolverContext,
): Promise<boolean | null> {
  checked(ServiceKey, input.endpoint);
  const value = await applicationResult(ctx, () => ctx.push.remove(input.endpoint, ctx.context));
  if (value !== undefined) throw new ResolverError("INTERNAL_SERVER_ERROR");
  return true;
}

/*
 * Helpers: Schema
 */

type ErrorCode =
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "CONVERSATION_BUSY"
  | "SESSION_FAILED"
  | "INTERNAL_SERVER_ERROR";

type NodeKind = Type.Static<typeof NodeKind>;

type ApplicationNodeKind = "Instance" | "AuthorizationServer" | "Account" | "Authorization";

type NodeIdentity =
  | { [K in NodeKind]: { kind: K; externalId: string; durableId: number | null } }[NodeKind]
  | {
      [K in ApplicationNodeKind]: { kind: K; namespace: string; serviceId: string };
    }[ApplicationNodeKind];

const SafeInteger = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

const ConversationId = Type.Unsafe<Durable.ConversationId>(SafeInteger);

const EntryId = Type.Unsafe<Durable.EntryId>(SafeInteger);

const TaskId = Type.Unsafe<Durable.TaskId>(SafeInteger);

const SubmissionId = Type.Unsafe<Durable.SubmissionId>(SafeInteger);

const PageLimit = Type.Integer({ minimum: 1, maximum: 2147483647 });

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

const JsonObject = Type.Record(JsonKey, JsonValue, {
  additionalProperties: false,
});

const Cursor = JsonObject;

const TelemetryCarrier = Type.Record(JsonKey, Type.String(), { additionalProperties: false });

const ImageData = Type.String({
  pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
});

const NodeKind = Type.Enum([
  "Harness",
  "ConversationRecord",
  "EntryRecord",
  "TaskRecord",
  "SubmissionRecord",
]);

const ServiceKey = Type.String({ minLength: 1 });

const Identity = Type.Union([
  Type.Tuple([Type.Literal(1), NodeKind, Type.String(), Type.Union([SafeInteger, Type.Null()])]),
  Type.Tuple([
    Type.Literal(1),
    Type.Enum(["Instance", "AuthorizationServer", "Account", "Authorization"]),
    ServiceKey,
    ServiceKey,
  ]),
]);

function scalar<S extends Type.TSchema>(schema: S): GqlScalar<Type.Static<S>> {
  return {
    parseValue: (value) => checked(schema, value),
    parseLiteral: (value, variables) => checked(schema, valueFromASTUntyped(value, variables)),
    serialize(value) {
      try {
        if (Value.Check(schema, value)) return value;
      } catch {}
      throw new ResolverError("INTERNAL_SERVER_ERROR");
    },
  };
}

function identity(id: ID): NodeIdentity {
  const [_, kind, scope, key] = checked(Identity, decodeId(id));
  if (encodeId([1, kind, scope, key]) !== id) throw new ResolverError("BAD_REQUEST");
  if (
    kind === "Instance" ||
    kind === "AuthorizationServer" ||
    kind === "Account" ||
    kind === "Authorization"
  )
    return { kind, namespace: scope, serviceId: key };
  assert(typeof key !== "string");
  if ((kind === "Harness") !== (key === null)) throw new ResolverError("BAD_REQUEST");
  return { kind, externalId: scope, durableId: key };
}

function checked<S extends Type.TSchema>(schema: S, value: unknown): Type.Static<S> {
  try {
    if (Value.Check(schema, value)) return value;
  } catch {}
  throw new ResolverError("BAD_REQUEST");
}

function harnessNode(externalId: string): Harness {
  return { __typename: "Harness", id: globalId("Harness", externalId), externalId };
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

function mapError(error?: unknown): ResolverError {
  if (error instanceof ResolverError) return error;
  if (error instanceof SessionFailed) return new ResolverError("SESSION_FAILED", { cause: error });
  if (error instanceof StorageRequestError)
    return new ResolverError("BAD_REQUEST", { cause: error });
  if (error instanceof ConversationBusy)
    return new ResolverError("CONVERSATION_BUSY", { cause: error });
  return new ResolverError("INTERNAL_SERVER_ERROR", { cause: error });
}

class ResolverError extends GraphQLError {
  constructor(code: ErrorCode | { readonly protocol: string }, options?: ErrorOptions) {
    const value = typeof code === "string" ? code : code.protocol;
    super(value, { extensions: { code: value } });
    this.cause = options?.cause;
  }
}

async function harnessOperation<T>(
  instance: Durable.Harness,
  ctx: ResolverContext,
  operation: () => Promise<T>,
): Promise<T> {
  let closing = false;
  const stop = instance.subscribeClose(() => {
    closing = true;
  });
  let result: T;
  try {
    result = await operation();
  } catch (error) {
    stop();
    if (error instanceof StorageRequestError && closing) {
      const end = await awaitWithContext(instance.closed, ctx.context);
      if (end.kind === "failed" && end.error === error)
        throw new ResolverError("INTERNAL_SERVER_ERROR");
    }
    throw error;
  }
  stop();
  return result;
}

function globalId(kind: NodeKind, externalId: string, id: number | null = null): ID {
  return encodeId([1, kind, externalId, id]);
}

async function requireHarness(ctx: ResolverContext, source: Harness) {
  const instance = await ctx.session(source.externalId);
  if (!instance) throw new ResolverError("NOT_FOUND");
  return instance;
}

function jsonValue(value: unknown): JsonValue {
  const serialized: unknown = JSON.parse(JSON.stringify(value));
  if (!Value.Check(JsonValue, serialized)) throw new ResolverError("INTERNAL_SERVER_ERROR");
  return serialized;
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

async function requireConversation(ctx: ResolverContext, source: ConversationRecord) {
  const instance = await requireHarness(ctx, source.harness);
  const handle = await instance.conversation(source.durableId, ctx.context);
  if (!handle) throw new ResolverError("NOT_FOUND");
  return { instance, handle };
}

async function mutationConversation(ctx: ResolverContext, id: ID) {
  if (identity(id).kind !== "ConversationRecord") throw new ResolverError("BAD_REQUEST");
  const source = await node(id, ctx);
  if (!source) throw new ResolverError("NOT_FOUND");
  assert("__typename" in source && source.__typename === "ConversationRecord");
  return {
    source: source as ConversationRecord,
    ...(await requireConversation(ctx, source as ConversationRecord)),
  };
}

async function mutationHarness(ctx: ResolverContext, id: ID) {
  const target = identity(id);
  if (target.kind !== "Harness") throw new ResolverError("BAD_REQUEST");
  const source = harnessNode(target.externalId);
  return { source, instance: await requireHarness(ctx, source) };
}

async function createdConversation(
  instance: Durable.Harness,
  source: Harness,
  id: ConversationId,
  ctx: ResolverContext,
) {
  const record = await instance.commit((tx) => tx.conversation(id), ctx.context);
  assert(record);
  return projectConversation(source, record);
}

function unreachable(value: never): never {
  void value;
  throw new ResolverError("INTERNAL_SERVER_ERROR");
}

function decodeId(value: string): unknown {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw new Error();
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ResolverError("BAD_REQUEST");
  }
}

function encodeId(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
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

/*
 * Helpers: Messages
 */

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

/*
 * Helpers: Documents
 */

const DocumentScope = Type.Union([
  Type.Object({ kind: Type.Literal("session") }, { additionalProperties: false }),
  Type.Object(
    { kind: Type.Literal("conversation"), conversationId: ConversationId },
    { additionalProperties: false },
  ),
  Type.Object({ kind: Type.Literal("task"), taskId: TaskId }, { additionalProperties: false }),
]);

async function serviceCall<T>(ctx: ResolverContext, call: () => T | Promise<T>): Promise<T> {
  try {
    return await invokeWithContext(ctx.context, call);
  } catch (error) {
    throw new ResolverError("INTERNAL_SERVER_ERROR", { cause: error });
  }
}

async function documentOwner(
  tx: Durable.Tx,
  scope: Durable.DocumentAddress["scope"],
): Promise<boolean> {
  switch (scope.kind) {
    case "session":
      return true;
    case "conversation":
      return (await tx.conversation(scope.conversationId)) !== undefined;
    case "task":
      return (await tx.task(scope.taskId)) !== undefined;
  }
}

async function resolveDocument(source: Harness, input: DocumentAddressInput, ctx: ResolverContext) {
  const { scope, ...fields } = nonNull(input);
  const address: Durable.DocumentAddress = { ...fields, scope: checked(DocumentScope, scope) };
  const instance = await ctx.session(source.externalId);
  if (!instance || !(await instance.commit((tx) => documentOwner(tx, address.scope), ctx.context)))
    return undefined;
  const access = await serviceCall(ctx, () =>
    ctx.documents.resolve(source.externalId, address, ctx.context),
  );
  if (!access) return undefined;
  assert.equal(access.token.definition.kind, address.kind);
  assert.equal(access.token.definition.scope, address.scope.kind);
  if ("family" in access.token.definition !== (address.key !== undefined))
    throw new ResolverError("BAD_REQUEST");
  return { instance, access, address };
}

async function invokeWithContext<T>(context: Context, call: () => T | Promise<T>): Promise<T> {
  context.abortSignal?.throwIfAborted();
  const pending = Promise.resolve().then(() => {
    context.abortSignal?.throwIfAborted();
    return call();
  });
  return awaitWithContext(pending, context);
}

/*
 * Helpers: Submissions
 */

const EntryHead = Type.Union([EntryId, Type.Literal("self")]);

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

const DiagnosticCode = Type.Union([Type.String(), Type.Number()]);

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

/*
 * Helpers: Conversation lifecycle
 */

const ConversationOwnership = Type.Union([
  Type.Object({ kind: Type.Literal("ownerless") }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("task"), taskId: TaskId }, { additionalProperties: false }),
]);

/*
 * Helpers: Environments
 */

const SshTarget = Type.Object(
  {
    type: Type.Literal("ssh"),
    host: Type.String(),
    user: Type.Optional(Type.String()),
    port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
    identityFile: Type.Optional(Type.String()),
    knownHostsFile: Type.String(),
    hostKeyAlias: Type.String(),
    configFile: Type.Optional(Type.String({ minLength: 1, pattern: "^[^\\u0000]*$" })),
  },
  { additionalProperties: false },
);

function envInit(value: SshTargetInput | null | undefined): Durable.ConversationInit | undefined {
  if (value === undefined) return undefined;
  let target: Type.Static<typeof SshTarget> | null;
  try {
    target = value === null ? null : sshTarget(value);
  } catch {
    throw new ResolverError("BAD_REQUEST");
  }
  return async (tx, id) => {
    const draft = await tx.doc(Env, id);
    if (target === null) delete draft.env;
    else draft.env = target;
  };
}

function sshTarget(value: SshTargetInput): Type.Static<typeof SshTarget> {
  const target = {
    type: value.type,
    host: value.host,
    knownHostsFile: value.knownHostsFile,
    hostKeyAlias: value.hostKeyAlias,
    ...(value.user == null ? {} : { user: value.user }),
    ...(value.port == null ? {} : { port: value.port }),
    ...(value.identityFile == null ? {} : { identityFile: value.identityFile }),
    ...(value.configFile == null ? {} : { configFile: value.configFile }),
  };
  assert(Value.Check(SshTarget, target));
  sshArguments(target);
  return target;
}

/*
 * Helpers: Settings
 */

function configurationValue<S extends Type.TSchema>(
  schema: S,
  value: Type.Static<S>,
): Type.Static<S> {
  try {
    const settings = structuredClone(value);
    assert(Value.Check(schema, settings));
    return settings;
  } catch {
    throw new ResolverError("INTERNAL_SERVER_ERROR");
  }
}

/*
 * Helpers: Inventory
 */

type InventoryPage = ApplicationPage<InventoryRecord>;

interface InventoryTimings {
  readonly invocation_id: string;
  readonly activation_us?: number | null;
  readonly worker_us?: number | null;
  readonly boot_wait_us?: number | null;
  readonly provision_us?: number | null;
  readonly manager_gaps_us?: number | null;
  readonly host_phases?: readonly InventoryPhase[] | null;
  readonly guest_phases?: readonly InventoryPhase[] | null;
}

const InventoryRecord = Type.Object({ id: ServiceKey, unit: ServiceKey });

const InstanceState = Type.Object({
  activeState: Type.String(),
  subState: Type.String(),
  result: Type.Union([Type.String(), Type.Null()]),
});

const Duration = Type.Union([Type.Number({ minimum: 0 }), Type.Null()]);

const TimingPhases = Type.Union([
  Type.Array(
    Type.Object({
      phase: Type.String(),
      clock: Type.String(),
      monotonicSeconds: Type.Number({ minimum: 0 }),
      resolutionSeconds: Type.Number({ exclusiveMinimum: 0 }),
    }),
  ),
  Type.Null(),
]);

const InstanceTimings = Type.Object({
  invocationId: ServiceKey,
  activationUs: Duration,
  workerUs: Duration,
  bootWaitUs: Duration,
  provisionUs: Duration,
  managerGapsUs: Duration,
  hostPhases: TimingPhases,
  guestPhases: TimingPhases,
});

function instanceNode(namespace: string, record: InventoryRecord): Instance {
  const { id, unit } = record;
  assert(Value.Check(InventoryRecord, { id, unit }));
  return {
    __typename: "Instance",
    id: encodeId([1, "Instance", namespace, id]),
    serviceId: id,
    unit,
  };
}

function instancePhase(value: InventoryPhase): InstanceTimingPhase {
  return {
    phase: value.phase,
    clock: value.clock,
    monotonicSeconds: value.monotonic_s,
    resolutionSeconds: value.resolution_s,
  };
}

/*
 * Helpers: Accounts
 */

interface ApplicationPage<T> {
  readonly items: readonly T[];
  readonly next?: Cursor | null;
}

type ApplicationPageResult<T> = ApplicationPage<T> | { readonly invalidCursor: true };

type ApplicationResult<T> = { readonly value: T } | { readonly error: "BAD_REQUEST" | "NOT_FOUND" };

const NullableText = Type.Union([Type.String(), Type.Null()]);

const ServerRecordShape = Type.Object({
  id: ServiceKey,
  label: Type.String(),
  authorization_endpoint: NullableText,
  token_endpoint: NullableText,
  device_authorization_endpoint: NullableText,
  revocation_endpoint: NullableText,
  grant_types_supported: Type.Union([Type.Array(Type.String()), Type.Null()]),
});

const AccountRecordShape = Type.Object({
  id: ServiceKey,
  serverId: ServiceKey,
  identifier: NullableText,
  displayName: NullableText,
  status: Type.Enum(["usable", "temporarilyUnavailable", "reauthorizationRequired"]),
  scope: NullableText,
});

const AuthorizationRequestShape = Type.Object({
  url: ServiceKey,
  response_type: ServiceKey,
  client_id: ServiceKey,
  redirect_uri: ServiceKey,
  scope: NullableText,
  state: ServiceKey,
  code_challenge: ServiceKey,
  code_challenge_method: ServiceKey,
});

const DeviceResponseShape = Type.Object({
  user_code: ServiceKey,
  verification_uri: ServiceKey,
  verification_uri_complete: NullableText,
  expires_in: Type.Integer({ minimum: 1, maximum: 2147483647 }),
  interval: Type.Union([Type.Integer({ minimum: 1, maximum: 2147483647 }), Type.Null()]),
});

const ProtocolErrorCode = Type.String({
  minLength: 1,
  pattern: "^[\\x20-\\x21\\x23-\\x5B\\x5D-\\x7E]+$",
});

const AuthorizationErrorShape = Type.Object({
  error: ProtocolErrorCode,
  error_description: NullableText,
  error_uri: NullableText,
});

const AuthorizationRecordShape = Type.Object({
  id: ServiceKey,
  serverId: ServiceKey,
  accountId: Type.Union([ServiceKey, Type.Null()]),
  status: Type.Enum(["pending", "completed", "cancelled", "failed"]),
  createdAt: Type.Number({ minimum: 0 }),
});

async function accountNode(
  ctx: ResolverContext,
  kind: "AuthorizationServer",
  id: string,
): Promise<AuthorizationServer | null>;

async function accountNode(
  ctx: ResolverContext,
  kind: "Account",
  id: string,
): Promise<Account | null>;

async function accountNode(
  ctx: ResolverContext,
  kind: "Authorization",
  id: string,
): Promise<Authorization | null>;

async function accountNode(
  ctx: ResolverContext,
  kind: "AuthorizationServer" | "Account" | "Authorization",
  id: string,
): Promise<AuthorizationServer | Account | Authorization | null>;

async function accountNode(
  ctx: ResolverContext,
  kind: "AuthorizationServer" | "Account" | "Authorization",
  id: string,
): Promise<AuthorizationServer | Account | Authorization | null> {
  return serviceCall(ctx, async () => {
    const namespace = checked(ServiceKey, ctx.accounts.namespace);
    let result: AuthorizationServer | Account | Authorization;
    if (kind === "AuthorizationServer") {
      const value = await ctx.accounts.server(id, ctx.context);
      if (value === undefined) return null;
      result = serverRecord(namespace, value);
    } else if (kind === "Account") {
      const value = await ctx.accounts.account(id, ctx.context);
      if (value === undefined) return null;
      result = accountRecord(namespace, value);
    } else {
      const value = await ctx.accounts.authorization(id, ctx.context);
      if (value === undefined) return null;
      result = authorizationRecord(namespace, value);
    }
    assert.equal(result.serviceId, id);
    return result;
  });
}

async function applicationPage<T, N extends Node & { readonly serviceId: string }>(
  ctx: ResolverContext,
  namespace: string,
  limit: Int,
  cursor: Cursor | null | undefined,
  read: (
    limit: number,
    cursor: Cursor | undefined,
    context: Context,
  ) => Promise<ApplicationPageResult<T>>,
  project: (namespace: string, record: T) => N,
): Promise<Connection<N>> {
  checked(PageLimit, limit);
  const result = await serviceCall(ctx, async () => {
    checked(ServiceKey, namespace);
    const page = await read(limit, cursor ?? undefined, ctx.context);
    if ("invalidCursor" in page) {
      assert.equal(page.invalidCursor, true);
      return undefined;
    }
    assert(Array.isArray(page.items) && page.items.length <= limit);
    const nodes = page.items.map((record) => project(namespace, record));
    assert.equal(new Set(nodes.map((record) => record.serviceId)).size, nodes.length);
    const next = structuredClone(page.next ?? null);
    assert(next === null || Value.Check(Cursor, next));
    return { nodes, pageInfo: { next } };
  });
  if (result === undefined) throw new ResolverError("BAD_REQUEST");
  return result;
}

function serverRecord(namespace: string, value: AuthorizationServerRecord): AuthorizationServer {
  const record = publicProjection(ServerRecordShape, value);
  return {
    ...record,
    __typename: "AuthorizationServer",
    serviceId: record.id,
    id: encodeId([1, "AuthorizationServer", namespace, record.id]),
  };
}

function accountRecord(namespace: string, value: AccountRecord): Account {
  const record = publicProjection(AccountRecordShape, value);
  return {
    ...record,
    __typename: "Account",
    serviceId: record.id,
    id: encodeId([1, "Account", namespace, record.id]),
  };
}

function authorizationRecord(namespace: string, value: AuthorizationRecord): Authorization {
  const record = publicProjection(AuthorizationRecordShape, value);
  const request =
    value.request == null ? null : publicProjection(AuthorizationRequestShape, value.request);
  const device =
    value.deviceAuthorizationResponse == null
      ? null
      : publicProjection(DeviceResponseShape, value.deviceAuthorizationResponse);
  const error = value.error == null ? null : publicProjection(AuthorizationErrorShape, value.error);
  assert(request === null || device === null);
  assert(record.status !== "completed" || record.accountId !== null);
  return {
    ...record,
    __typename: "Authorization",
    serviceId: record.id,
    id: encodeId([1, "Authorization", namespace, record.id]),
    request,
    deviceAuthorizationResponse: device,
    error,
  };
}

async function relatedServer(ctx: ResolverContext, id: string): Promise<AuthorizationServer> {
  const result = await accountNode(ctx, "AuthorizationServer", id);
  if (result === null) throw new ResolverError("NOT_FOUND");
  return result;
}

async function startAuthorization(
  input: AuthorizeInput,
  ctx: ResolverContext,
  method: "authorize" | "deviceAuthorization",
): Promise<Authorization> {
  if (input.accountId === null) throw new ResolverError("BAD_REQUEST");
  const serverId = await accountTarget(input.serverId, "AuthorizationServer", ctx);
  const accountId =
    input.accountId === undefined
      ? undefined
      : await accountTarget(input.accountId, "Account", ctx);
  if (accountId !== undefined) {
    const account = await accountNode(ctx, "Account", accountId);
    if (account === null) throw new ResolverError("NOT_FOUND");
    if (account.serverId !== serverId) throw new ResolverError("BAD_REQUEST");
  }
  const result = await applicationResult(ctx, () =>
    ctx.accounts[method](serverId, accountId, ctx.context),
  );
  return serviceCall(ctx, () => {
    const value = authorizationRecord(checked(ServiceKey, ctx.accounts.namespace), result);
    assert.equal(value.serverId, serverId);
    if (accountId !== undefined) assert.equal(value.accountId, accountId);
    if (method === "authorize") assert.equal(value.deviceAuthorizationResponse, null);
    else assert.equal(value.request, null);
    return value;
  });
}

async function accountTarget(
  id: ID,
  kind: "AuthorizationServer" | "Account" | "Authorization",
  ctx: ResolverContext,
): Promise<string> {
  const target = identity(id);
  if (target.kind !== kind) throw new ResolverError("BAD_REQUEST");
  const namespace = await serviceCall(ctx, () => checked(ServiceKey, ctx.accounts.namespace));
  if (target.namespace !== namespace) throw new ResolverError("NOT_FOUND");
  if ((await accountNode(ctx, kind, target.serviceId)) === null)
    throw new ResolverError("NOT_FOUND");
  return target.serviceId;
}

async function applicationResult<T>(
  ctx: ResolverContext,
  call: () => Promise<ApplicationResult<T>>,
): Promise<T> {
  const result = await serviceCall(ctx, async () => {
    const value = await call();
    if ("error" in value) {
      const error = value.error;
      assert(error === "BAD_REQUEST" || error === "NOT_FOUND");
      return { error };
    }
    assert("value" in value);
    return { value: value.value };
  });
  if ("error" in result) throw new ResolverError(result.error);
  return result.value;
}

function publicProjection<S extends Type.TObject>(schema: S, value: unknown): Type.Static<S> {
  assert(value !== null && typeof value === "object");
  const projected = Object.fromEntries(
    Object.keys(schema.properties).map((key): [string, unknown] => [
      key,
      Reflect.get(value, key) ?? null,
    ]),
  );
  assert(Value.Check(schema, projected));
  return structuredClone(projected);
}
