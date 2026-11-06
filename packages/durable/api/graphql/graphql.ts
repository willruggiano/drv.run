import type { Float, ID, Int } from "grats";
import type * as Durable from "@earendil-works/pi-durable";
import type * as Chord from "@earendil-works/chord";
import type * as Telemetry from "@earendil-works/pi-telemetry";
import type * as AI from "@earendil-works/pi-ai";

// TypeScript/Grats is the schema source of truth. The generated factory accepts
// scalar implementations. All field resolvers are explicit schema-only stubs;
// backend execution is not implemented.
// No Harness acquisition, transport, storage, or execution policy is implemented here.
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
export function node(id: ID): Promise<Node | null> {
  void id;
  throw new Error("not yet implemented");
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
export function harness(sessionId: string): Promise<Harness | null> {
  void sessionId;
  throw new Error("not yet implemented");
}

/**
 * List accessible persisted sessions from the deployment's catalog, not the cache
 * of open Harness instances. Durable does not provide a cross-session catalog.
 * Order by ascending sessionId; listing does not create sessions or enable scheduling.
 * Cursors bind the catalog, access scope, and ordering, not an individual session.
 * @gqlQueryField
 */
export function harnesses(first: Int, after?: string | null): Promise<HarnessConnection> {
  void first;
  void after;
  throw new Error("not yet implemented");
}

/**
 * Resolve Harness.conversation(id); expose its record instead of a live handle.
 * @gqlField
 */
export function conversation(
  source: Harness,
  id: ConversationId,
): Promise<ConversationRecord | null> {
  void source;
  void id;
  throw new Error("not yet implemented");
}

/**
 * Harness.inspect(): live work and scheduling state, without enabling scheduling.
 * @gqlField
 */
export function inspect(source: Harness): Promise<HarnessInspection> {
  void source;
  throw new Error("not yet implemented");
}

/**
 * Tx.scanConversations(); default order is ascending, or the cursor's order.
 * @gqlField
 */
export function scanConversations(
  source: Harness,
  first: Int,
  query: ConversationQuery = {},
  after?: string | null,
): Promise<ConversationRecordConnection> {
  void source;
  void first;
  void query;
  void after;
  throw new Error("not yet implemented");
}

/**
 * Tx.scanTasks(); default order is ascending, or the cursor's order.
 * @gqlField
 */
export function scanTasks(
  source: Harness,
  first: Int,
  query: TaskQuery = {},
  after?: string | null,
): Promise<TaskRecordConnection> {
  void source;
  void first;
  void query;
  void after;
  throw new Error("not yet implemented");
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
export function agent(source: ConversationRecord): Promise<Agent> {
  void source;
  throw new Error("not yet implemented");
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
  first: Int,
  query: EntryQuery = {},
  after?: string | null,
): Promise<EntryRecordConnection> {
  void source;
  void first;
  void query;
  void after;
  throw new Error("not yet implemented");
}

/**
 * Current context when at is omitted; otherwise context through that visible entry.
 * @gqlField
 */
export function context(source: ConversationRecord, at?: EntryId | null): Promise<ContextView> {
  void source;
  void at;
  throw new Error("not yet implemented");
}

/**
 * Conversation-scoped Tx.submissionByRequest(). Null means absent at observation,
 * not that a concurrent or disconnected submission failed to commit.
 * @gqlField
 */
export function submissionByRequest(
  source: ConversationRecord,
  requestId: string,
): Promise<SubmissionRecord | null> {
  void source;
  void requestId;
  throw new Error("not yet implemented");
}

/**
 * Reacquire Harness.submission(id), then read Submission.status(). Null for an
 * absent submission or one belonging to another conversation; never waits.
 * @gqlField
 */
export function status(
  source: ConversationRecord,
  id: SubmissionId,
): Promise<SubmissionRecord | null> {
  void source;
  void id;
  throw new Error("not yet implemented");
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
export function submit(input: SubmitInput): Promise<SubmitPayload | null> {
  void input;
  throw new Error("not yet implemented");
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
): Promise<AbortSubmissionPayload | null> {
  void input;
  throw new Error("not yet implemented");
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
export function abort(input: AbortInput): Promise<AbortPayload | null> {
  void input;
  throw new Error("not yet implemented");
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
export function resume(input: ResumeInput): Promise<ResumePayload | null> {
  void input;
  throw new Error("not yet implemented");
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
export function reset(input: ResetInput): Promise<ResetPayload | null> {
  void input;
  throw new Error("not yet implemented");
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
export function compact(input: CompactInput): Promise<CompactPayload | null> {
  void input;
  throw new Error("not yet implemented");
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
export function configure(input: ConfigureInput): Promise<ConfigurePayload | null> {
  void input;
  throw new Error("not yet implemented");
}
