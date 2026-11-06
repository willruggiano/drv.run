import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  GraphQLError,
  graphql,
  isScalarType,
  isUnionType,
  isInputObjectType,
  parseValue,
  validateSchema,
} from "graphql";
import type * as AI from "@earendil-works/pi-ai";
import {
  BACKGROUND_CONTEXT,
  awaitWithContext,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import {
  Harness,
  MemoryStorage,
  createRegistry,
  CompactionTask,
  ConversationBusy,
  SessionFailed,
  StorageRequestError,
  ReadAfterWrite,
  type HarnessInspection,
  type EntryRecord,
  type TaskId,
  type Cursor,
  type TaskQuery,
  type SubmissionId,
} from "@earendil-works/pi-durable";
import { createSchema, type ResolverContext } from "./graphql.ts";

const execution = BACKGROUND_CONTEXT;
const schema = createSchema();
type Connection<T> = {
  nodes: T[];
  pageInfo: { next: Cursor | null };
};
type Identity = { id: string; durableId: number };
const pageFields = "pageInfo { next }";

const userMessageFields = `__typename ... on UserMessage {
  role timestamp content { __typename ... on StringContent { text }
    ... on UserContentList { blocks { __typename ... on TextContent { type text textSignature } ... on ImageContent { type data mimeType } } }
  }
}`;
const messageIdentity = `__typename
  ... on SystemMessage { role timestamp }
  ... on UserMessage { role timestamp }
  ... on AssistantMessage { role timestamp }
  ... on ToolResultMessage { role timestamp }
`;

async function fixture(t: TestContext, sessionId = "test") {
  const models = createModels();
  const faux = fauxProvider({ models: [{ id: "test", reasoning: true }] });
  models.setProvider(faux.provider);
  const storage = new MemoryStorage();
  const instance = await Harness.open(
    storage,
    {
      models,
      registry: createRegistry(),
      settings: { compaction: { backgroundTokens: 0 }, retry: { maxRetries: 0 } },
    },
    execution,
  );
  t.after(() => instance.close(execution));
  const root = await instance.root(execution, {
    agent: { model: { provider: "faux", modelId: "test" } },
  });
  function request(overrides: Partial<ResolverContext> = {}): ResolverContext {
    return {
      context: execution,
      session: async (id) => (id === sessionId ? instance : undefined),
      sessions: async () => [sessionId],
      ...overrides,
    };
  }
  function run(
    source: string,
    variableValues: Record<string, unknown> = {},
    contextValue = request(),
  ) {
    return graphql({ schema, source, variableValues, contextValue });
  }
  async function success<T>(
    source: string,
    variables: Record<string, unknown> = {},
    ctx = request(),
  ): Promise<T> {
    const result = await run(source, variables, ctx);
    assert.equal(result.errors, undefined);
    assert(result.data);
    // The test's response boundary: assert on serialized GraphQL data, not text.
    return JSON.parse(JSON.stringify(result.data)) as T;
  }
  const ids = await success<{ harness: { id: string; conversation: Identity } }>(
    `query($session: String!) { harness(sessionId: $session) { id conversation(id: 1) { id durableId } } }`,
    { session: sessionId },
  );
  return {
    storage,
    instance,
    root,
    faux,
    request,
    run,
    success,
    harnessId: ids.harness.id,
    conversationId: ids.harness.conversation.id,
  };
}

void test("generated schema remains valid", () => {
  assert.deepEqual(validateSchema(schema), []);
  const message = schema.getType("Message");
  assert(isUnionType(message));
  assert.deepEqual(
    message
      .getTypes()
      .map((type) => type.name)
      .sort(),
    ["AssistantMessage", "SystemMessage", "ToolResultMessage", "UserMessage"],
  );
  for (const name of [
    "SubmissionDraft",
    "UserInput",
    "UserInputBlock",
    "MessageInput",
    "AssistantContentInput",
    "SystemMessageContentInput",
    "ContextEditInput",
  ]) {
    const input = schema.getType(name);
    assert(isInputObjectType(input));
    assert.equal(input.isOneOf, true);
  }
});

void test("catalog list, authorized sessions, missing nodes, and independent reads", async (t) => {
  const f = await fixture(t);
  const session = t.mock.fn(async (id: string) => (id === "test" ? f.instance : undefined));
  const ctx = () => f.request({ session, sessions: async () => ["z", "test", "a / 雪"] });
  const list = `{ harnesses { id sessionId } }`;
  const all = await f.success<{ harnesses: Array<{ id: string; sessionId: string }> }>(
    list,
    {},
    ctx(),
  );
  assert.deepEqual(
    all.harnesses.map((item) => item.sessionId),
    ["a / 雪", "test", "z"],
  );
  assert.equal(session.mock.callCount(), 0);
  assert.deepEqual(await f.success(list, {}, f.request({ sessions: async () => [] })), {
    harnesses: [],
  });
  const values = await f.success<{
    a: { id: string };
    b: { id: string };
    node: { id: string };
    absent: null;
  }>(
    `query($id: ID!) { a: harness(sessionId: "test") { id } b: harness(sessionId: "test") { id } node(id: $id) { id } absent: harness(sessionId: "absent") { id } }`,
    { id: f.harnessId },
    ctx(),
  );
  assert.deepEqual(values.a, values.b);
  assert.deepEqual(values.a, values.node);
  assert.equal(values.absent, null);
  assert.equal(session.mock.callCount(), 4);
  assert.deepEqual(
    await f.success(
      `query($id: ID!) { node(id: $id) { id } }`,
      { id: f.harnessId },
      f.request({ session: async () => undefined }),
    ),
    { node: null },
  );
  assert.equal((await f.instance.inspect(execution)).scheduling, "paused");
});

void test("resolved configuration, omission, clearing, and serial mutation fields", async (t) => {
  const f = await fixture(t);
  const read = `{ harness(sessionId: "test") { conversation(id: 1) { agent { cwd model { ... on ModelRef { provider modelId } } thinkingLevel instructions } } } }`;
  type Settings = {
    harness: {
      conversation: {
        agent: {
          cwd: string | null;
          model: { provider: string; modelId: string } | null;
          thinkingLevel: string;
          instructions: string | null;
        };
      };
    };
  };
  const change = `mutation($id: ID!, $change: AgentChange!, $tag: String) { configure(input: { conversationId: $id, change: $change, clientMutationId: $tag }) { clientMutationId } }`;
  assert.deepEqual(
    await f.success(change, {
      id: f.conversationId,
      change: { cwd: "/work", thinkingLevel: "high" },
      tag: "correlation",
    }),
    { configure: { clientMutationId: "correlation" } },
  );
  await f.success(change, { id: f.conversationId, change: {} });
  let value = (await f.success<Settings>(read)).harness.conversation.agent;
  assert.deepEqual(value, {
    cwd: "/work",
    model: { provider: "faux", modelId: "test" },
    thinkingLevel: "high",
    instructions: null,
  });
  await f.success(change, {
    id: f.conversationId,
    change: { cwd: null, model: null, thinkingLevel: null },
  });
  value = (await f.success<Settings>(read)).harness.conversation.agent;
  assert.deepEqual(value, { cwd: null, model: null, thinkingLevel: "off", instructions: null });
  await f.success(
    `mutation($id: ID!, $model: ModelRefInput!) {
      configure(input: { conversationId: $id, change: { model: $model } }) { clientMutationId }
    }`,
    { id: f.conversationId, model: { provider: "faux", modelId: "test" } },
  );
  value = (await f.success<Settings>(read)).harness.conversation.agent;
  assert.deepEqual(value.model, { provider: "faux", modelId: "test" });
  await f.root.configure({ instructions: "extra" }, execution);
  await f.success(
    `mutation($id: ID!) {
    a: configure(input: { conversationId: $id, change: { cwd: "first" } }) { clientMutationId }
    b: configure(input: { conversationId: $id, change: { cwd: "second" } }) { clientMutationId }
  }`,
    { id: f.conversationId },
  );
  value = (await f.success<Settings>(read)).harness.conversation.agent;
  assert.equal(value.cwd, "second");
  assert.equal(value.instructions, "extra");
  assert.equal((await f.instance.inspect(execution)).scheduling, "paused");
});

void test("entry connections return exactly one upstream page and its continuation", async (t) => {
  const f = await fixture(t);
  const records: EntryRecord[] = [];
  for (let i = 0; i < 132; i++) {
    records.push(
      await f.instance.commit(
        (tx) => tx.appendEntry(f.root.id, { kind: "app.data", data: i }),
        execution,
      ),
    );
  }
  const expected = await f.root.entries({ order: "ascending" }, 130, undefined, execution);
  const scan = t.mock.method(f.storage, "scanEntries");
  const query = `query($limit: Int!, $cursor: Cursor, $filter: EntryQuery!) { harness(sessionId: "test") { conversation(id: 1) { entries(limit: $limit, cursor: $cursor, query: $filter) { nodes { id durableId data } ${pageFields} } } } }`;
  type Result = { harness: { conversation: { entries: Connection<Identity & { data: number }> } } };
  async function page(limit: number, filter: Record<string, unknown> = {}, cursor?: Cursor | null) {
    return (await f.success<Result>(query, { limit, filter, cursor })).harness.conversation.entries;
  }
  const ascending = await page(130, { order: "ascending" });
  assert.equal(scan.mock.callCount(), 1);
  assert.equal(scan.mock.calls[0]?.arguments[1], 130);
  assert.equal(scan.mock.calls[0]?.arguments[2], undefined);
  assert.deepEqual(
    ascending.nodes.map((node) => node.durableId),
    records.slice(0, 130).map((record) => record.id),
  );
  assert.deepEqual(ascending.pageInfo.next, expected.next);
  const rest = await page(10, {}, ascending.pageInfo.next);
  assert.equal(scan.mock.callCount(), 2);
  assert.equal(scan.mock.calls[1]?.arguments[1], 10);
  assert.deepEqual(scan.mock.calls[1]?.arguments[2], expected.next);
  assert.deepEqual(
    rest.nodes.map((node) => node.data),
    [130, 131],
  );
  assert.equal(rest.pageInfo.next, null);
  const descending = await page(2, {}, null);
  assert.deepEqual(
    descending.nodes.map((node) => node.data),
    [131, 130],
  );
  const continuation = await page(1, {}, descending.pageInfo.next);
  assert.equal(continuation.nodes[0]?.data, 129);
  const bounded = await page(5, { minEntryId: records[3]!.id, maxEntryId: records[3]!.id });
  assert.equal(bounded.nodes.length, 1);
  assert.equal(bounded.nodes[0]?.data, 3);
  const empty = await page(1, { minEntryId: Number.MAX_SAFE_INTEGER });
  assert.deepEqual(empty, { nodes: [], pageInfo: { next: null } });
  for (const variables of [
    { limit: 0, filter: {} },
    { limit: -1, filter: {} },
    { limit: 1, filter: {}, cursor: "!" },
    { limit: 1, filter: {}, cursor: { after: "invalid" } },
    { limit: 1, filter: { order: "descending" }, cursor: ascending.pageInfo.next },
    { limit: 1, filter: { order: null } },
  ]) {
    const result = await f.run(query, variables);
    assert.equal(result.errors?.[0]?.extensions.code, "BAD_REQUEST");
  }
  assert.equal((await f.instance.inspect(execution)).scheduling, "paused");
});

void test("opaque backend continuations pass through without lookahead, decoding, or rewriting", async (t) => {
  const f = await fixture(t);
  const opaque = { "backend.key": { position: [null, true, 42], "line\nbreak": "opaque" } };
  const scan = t.mock.method(
    f.storage,
    "scanTasks",
    async (_query: TaskQuery, _limit: number, cursor: Cursor | undefined) =>
      cursor === undefined ? { items: [], next: opaque } : { items: [] },
  );
  const query = `query($cursor: Cursor) { harness(sessionId: "test") { scanTasks(limit: 7, cursor: $cursor) { nodes { id } pageInfo { next } } } }`;
  const first = await f.success<{ harness: { scanTasks: Connection<Identity> } }>(query);
  assert.equal(scan.mock.callCount(), 1);
  assert.deepEqual(first.harness.scanTasks, { nodes: [], pageInfo: { next: opaque } });
  assert.deepEqual(scan.mock.calls[0]?.arguments.slice(0, 3), [{}, 7, undefined]);
  const last = await f.success(query, { cursor: first.harness.scanTasks.pageInfo.next });
  assert.equal(scan.mock.callCount(), 2);
  assert.deepEqual(scan.mock.calls[1]?.arguments.slice(0, 3), [{}, 7, opaque]);
  assert.deepEqual(last, { harness: { scanTasks: { nodes: [], pageInfo: { next: null } } } });
});

void test("fork-aware entries keep identity and context preserves message content and empty contributions", async (t) => {
  const f = await fixture(t);
  const message = { role: "user", content: "original", timestamp: 42 } as const;
  const first = await f.instance.commit(
    (tx) =>
      tx.appendEntry(f.root.id, {
        kind: "app.user",
        model: [message],
        data: { "file.name": "a", nested: [null, true] },
      }),
    execution,
  );
  const second = await f.instance.commit(
    (tx) => tx.appendEntry(f.root.id, { kind: "app.empty", data: null }),
    execution,
  );
  const fork = await f.root.fork(second.id, { ownership: { kind: "ownerless" } }, execution);
  const query = `query($fork: ConversationId!, $at: EntryId!) {
    harness(sessionId: "test") {
      root: conversation(id: 1) { entries(limit: 5) { nodes { id durableId model { ${userMessageFields} } data edits { target action messages { ${userMessageFields} } } head } } }
      fork: conversation(id: $fork) { parent { conversationId at } entries(limit: 5) { nodes { id durableId model { ${userMessageFields} } data edits { target action messages { ${userMessageFields} } } head } } context { entries { id durableId } contributions { ${userMessageFields} } messages { ${userMessageFields} } head { id } } historical: context(at: $at) { messages { ${userMessageFields} } entries { durableId } } }
    }
  }`;
  type Result = {
    harness: {
      root: { entries: { nodes: Identity[] } };
      fork: {
        entries: { nodes: Identity[] };
        parent: { conversationId: number; at: number };
        context: {
          entries: Identity[];
          contributions: unknown[][];
          messages: unknown[];
          head: null;
        };
        historical: { messages: unknown[]; entries: Array<{ durableId: number }> };
      };
    };
  };
  const value = (await f.success<Result>(query, { fork: fork.id, at: first.id })).harness;
  assert.deepEqual(value.fork.entries, value.root.entries);
  assert.deepEqual(value.fork.parent, { conversationId: f.root.id, at: second.id });
  const projected = {
    __typename: "UserMessage",
    role: "user",
    timestamp: 42,
    content: { __typename: "StringContent", text: "original" },
  };
  assert.deepEqual(value.fork.context.contributions, [[projected], []]);
  assert.deepEqual(value.fork.context.messages, [projected]);
  assert.equal(value.fork.context.head, null);
  assert.deepEqual(value.fork.historical.entries, [{ durableId: first.id }]);
  const id = value.root.entries.nodes[0]!.id;
  const refetch = await f.success<{ node: Identity }>(
    `query($id: ID!) { node(id: $id) { id ... on EntryRecord { durableId model { ${userMessageFields} } data edits { target action messages { ${userMessageFields} } } head } } }`,
    { id },
  );
  assert.deepEqual(refetch.node, value.root.entries.nodes[0]!);
});

void test("conversation/task scans, inspection, and node refetch read records independently", async (t) => {
  const f = await fixture(t);
  const other = await f.instance.createConversation(
    { ownership: { kind: "ownerless" } },
    execution,
  );
  const taskId = await f.instance.commit(
    (tx) =>
      tx.createTask(
        CompactionTask,
        { reason: "manual" },
        { conversationId: f.root.id, ownership: { kind: "conversation" } },
      ),
    execution,
  );
  const read = `{ harness(sessionId: "test") {
    scanConversations(limit: 1) { nodes { id durableId parent { at } owner { taskId } } ${pageFields} }
    scanTasks(limit: 2, query: { kind: "pi.compaction", status: pending, background: false, abortRequested: false, conversationId: 1 }) { nodes { id durableId state { status checkpoint outcome { status result } } input memos } ${pageFields} }
    inspect { scheduling tasks { record { id durableId state { status checkpoint outcome { status result } } input memos } state { kind migrates error } } submissions { id } }
  } }`;
  type Task = Identity & {
    state: { status: string; checkpoint: unknown; outcome: unknown };
    input: unknown;
    memos: unknown;
  };
  type Result = {
    harness: {
      scanConversations: Connection<Identity>;
      scanTasks: Connection<Task>;
      inspect: { scheduling: string; tasks: Array<{ record: Task }>; submissions: unknown[] };
    };
  };
  const value = (await f.success<Result>(read)).harness;
  assert(value.scanConversations.pageInfo.next);
  assert.equal(value.scanConversations.nodes[0]?.durableId, f.root.id);
  const tail = await f.success<{ harness: { scanConversations: Connection<Identity> } }>(
    `query($cursor: Cursor!) { harness(sessionId: "test") { scanConversations(limit: 1, cursor: $cursor) { nodes { id durableId } ${pageFields} } } }`,
    { cursor: value.scanConversations.pageInfo.next },
  );
  assert.equal(tail.harness.scanConversations.nodes[0]?.durableId, other.id);
  assert.equal(value.inspect.scheduling, "paused");
  const task = value.scanTasks.nodes[0]!;
  assert.equal(task.durableId, taskId);
  assert.deepEqual(value.inspect.tasks[0]?.record, task);
  assert.deepEqual(value.inspect.submissions, []);
  const initial = await f.instance.getTask(taskId, execution);
  assert(initial);
  t.mock.method(f.instance, "inspect", async (): Promise<HarnessInspection> => ({
    scheduling: "paused",
    submissions: [],
    tasks: [
      {
        record: {
          ...initial,
          state: { status: "sleeping", checkpoint: { phase: "select" }, until: 42 },
        },
        state: { kind: "sleeping", until: 42 },
      },
    ],
  }));
  const concurrent = await f.success<{
    a: Task;
    harness: { scanTasks: Connection<Task>; inspect: { tasks: Array<{ record: Task }> } };
  }>(
    `query($id: ID!) {
    a: node(id: $id) { id ... on TaskRecord { durableId state { status checkpoint } } }
    harness(sessionId: "test") { scanTasks(limit: 5) { nodes { id durableId state { status checkpoint } } } inspect { tasks { record { id durableId state { status checkpoint } } } } }
  }`,
    { id: task.id },
  );
  assert.deepEqual(concurrent.a, concurrent.harness.scanTasks.nodes[0]);
  assert.deepEqual(concurrent.harness.inspect.tasks[0]?.record, {
    ...concurrent.a,
    state: { status: "sleeping", checkpoint: { phase: "select" } },
  });
});

void test("agent aliases read independently within and between operations", async (t) => {
  const f = await fixture(t);
  t.mock.method(f.instance, "conversation", async () => f.root);
  const value = await f.root.agent(execution);
  let calls = 0;
  const context = withAbortSignal(new AbortController().signal, execution);
  t.mock.method(f.root, "agent", async (received: ResolverContext["context"]) => {
    assert.equal(received, context);
    return { ...value, cwd: String(++calls) };
  });
  const query = `{ harness(sessionId: "test") { a: conversation(id: 1) { agent { cwd } } b: conversation(id: 1) { agent { cwd } } } }`;
  const result = await f.success<{ harness: { a: unknown; b: unknown } }>(
    query,
    {},
    f.request({ context }),
  );
  assert.notDeepEqual(result.harness.a, result.harness.b);
  assert.equal(calls, 2);
  await f.success(query, {}, f.request({ context }));
  assert.equal(calls, 4);
});

void test("submission admission, idempotent recovery, busy rejection, scoped withdrawal and abort", async (t) => {
  const f = await fixture(t);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let cancelled = false;
  f.faux.setResponses([
    async (_request, options) => {
      assert(options?.signal);
      started.resolve();
      try {
        await awaitWithContext(release.promise, withAbortSignal(options.signal, execution));
      } finally {
        cancelled = options.signal.aborted;
      }
      return fauxAssistantMessage("answer");
    },
  ]);
  t.after(() => release.resolve());
  const mutation = `mutation($id: ID!, $draft: InputSubmissionDraft!) { submit(input: { conversationId: $id, submission: { input: $draft }, clientMutationId: "echo" }) { submissionId clientMutationId } }`;
  type Result = { submit: { submissionId: string; clientMutationId: string } };
  const content = [
    { type: "text", text: "hello", textSignature: "sig" },
    { type: "image", data: "aGk=", mimeType: "image/png" },
  ];
  const admitted = await f.success<Result>(mutation, {
    id: f.conversationId,
    draft: {
      content: {
        blocks: [
          { text: { text: "hello", textSignature: "sig" } },
          { image: { data: "aGk=", mimeType: "image/png" } },
        ],
      },
      requestId: "key",
      entry: { kind: "app.user", data: { "arbitrary.key": [null, 1] } },
    },
  });
  await started.promise;
  const live = await f.success<{
    harness: { inspect: { submissions: Array<{ id: string; status: string }> } };
  }>(`{ harness(sessionId: "test") { inspect { submissions { id status } } } }`);
  assert.deepEqual(live.harness.inspect.submissions, [
    { id: admitted.submit.submissionId, status: "placed" },
  ]);
  const duplicate = await f.success<Result>(mutation, {
    id: f.conversationId,
    draft: { content: { text: "different" }, requestId: "key" },
  });
  assert.deepEqual(duplicate, admitted);
  const busy = await f.run(mutation, {
    id: f.conversationId,
    draft: { content: { text: "reject" }, whenBusy: "reject" },
  });
  assert.equal(busy.errors?.[0]?.extensions.code, "CONVERSATION_BUSY");
  const receipt = await f.success<{
    node: Identity & { conversationId: number; status: string; requestId: string };
  }>(
    `query($id: ID!) { node(id: $id) { id ... on SubmissionRecord { durableId conversationId status requestId } } }`,
    { id: admitted.submit.submissionId },
  );
  assert.equal(receipt.node.status, "placed");
  const recovery = await f.success<{
    harness: { conversation: { submissionByRequest: unknown; status: unknown } };
  }>(
    `query($id: SubmissionId!) { harness(sessionId: "test") { conversation(id: 1) { submissionByRequest(requestId: "key") { id durableId conversationId status requestId } status(id: $id) { id durableId conversationId status requestId } } } }`,
    { id: receipt.node.durableId },
  );
  assert.deepEqual(recovery.harness.conversation.submissionByRequest, receipt.node);
  assert.deepEqual(recovery.harness.conversation.status, receipt.node);
  const other = await f.instance.createConversation(
    { ownership: { kind: "ownerless" } },
    execution,
  );
  const foreign = await f.success<{ harness: { conversation: { id: string; status: null } } }>(
    `query($conversation: ConversationId!, $id: SubmissionId!) { harness(sessionId: "test") { conversation(id: $conversation) { id status(id: $id) { id } } } }`,
    { conversation: other.id, id: receipt.node.durableId },
  );
  assert.equal(foreign.harness.conversation.status, null);
  const withdraw = `mutation($conversation: ID!, $id: SubmissionId!) { abortSubmission(input: { conversationId: $conversation, id: $id }) { result } }`;
  assert.deepEqual(
    await f.success(withdraw, {
      conversation: foreign.harness.conversation.id,
      id: receipt.node.durableId,
    }),
    { abortSubmission: { result: "not_found" } },
  );
  assert.deepEqual(
    await f.success(withdraw, { conversation: f.conversationId, id: receipt.node.durableId }),
    { abortSubmission: { result: "already_placed" } },
  );
  assert.equal(cancelled, false);
  const queued = await f.success<Result>(mutation, {
    id: f.conversationId,
    draft: { content: { text: "queued" }, whenBusy: "followUp" },
  });
  const queuedReceipt = await f.success<{ node: Identity }>(
    `query($id: ID!) { node(id: $id) { id ... on SubmissionRecord { durableId } } }`,
    { id: queued.submit.submissionId },
  );
  assert.deepEqual(
    await f.success(withdraw, { conversation: f.conversationId, id: queuedReceipt.node.durableId }),
    { abortSubmission: { result: "aborted" } },
  );
  assert.deepEqual(
    await f.success(withdraw, { conversation: f.conversationId, id: queuedReceipt.node.durableId }),
    { abortSubmission: { result: "settled" } },
  );
  await f.success(
    `mutation($id: ID!) { abort(input: { conversationId: $id }) { clientMutationId } }`,
    { id: f.conversationId },
  );
  assert.equal(cancelled, true);
  const history = await f.root.entries({}, 50, undefined, execution);
  const user = history.items.find((entry) => entry.kind === "app.user");
  assert.deepEqual(user?.data, { "arbitrary.key": [null, 1] });
  assert.deepEqual(user?.model?.[0]?.content, content);
});

void test("resume, reset and compaction preserve upstream admission semantics", async (t) => {
  const f = await fixture(t);
  await f.success(`mutation($id: ID!) { resume(input: { sessionId: $id }) { clientMutationId } }`, {
    id: f.harnessId,
  });
  assert.equal((await f.instance.inspect(execution)).scheduling, "running");
  f.faux.setResponses([fauxAssistantMessage("answer"), fauxAssistantMessage("summary")]);
  await (await f.root.submit({ type: "input", content: "question" }, execution)).wait(execution);
  const result = await f.success<{ compact: { taskId: string } }>(
    `mutation($id: ID!) { compact(input: { conversationId: $id, instructions: "keep names" }) { taskId } }`,
    { id: f.conversationId },
  );
  const task = await f.success<{ node: { durableId: TaskId } }>(
    `query($id: ID!) { node(id: $id) { ... on TaskRecord { durableId } } }`,
    { id: result.compact.taskId },
  );
  await f.instance.waitForTask(task.node.durableId, execution);
  const terminal = await f.success<{
    node: { state: { status: string; outcome: { status: string } }; memos: null };
  }>(
    `query($id: ID!) { node(id: $id) { ... on TaskRecord { state { status outcome { status result } } memos } } }`,
    { id: result.compact.taskId },
  );
  assert.equal(terminal.node.state.status, "terminal");
  assert.equal(terminal.node.state.outcome.status, "completed");
  assert.equal(terminal.node.memos, null);
  await f.success(
    `mutation($id: ID!) { reset(input: { conversationId: $id, handoff: "" }) { clientMutationId } }`,
    { id: f.conversationId },
  );
  const current = await f.root.context(execution);
  assert.equal(current.head?.kind, "pi.reset");
  const value = await f.success<{
    harness: { conversation: { context: { head: { durableId: number }; messages: unknown[] } } };
  }>(
    `{ harness(sessionId: "test") { conversation(id: 1) { context { head { durableId } messages { ${messageIdentity} } } } } }`,
  );
  assert.equal(value.harness.conversation.context.head.durableId, current.head?.id);
  const typenames = {
    system: "SystemMessage",
    user: "UserMessage",
    assistant: "AssistantMessage",
    toolResult: "ToolResultMessage",
  };
  assert.deepEqual(
    value.harness.conversation.context.messages,
    current.messages.map((message) => ({
      __typename: typenames[message.role],
      role: message.role,
      timestamp: message.timestamp,
    })),
  );
});

void test("input validation rejects null overrides outside configure, invalid scalars and reserved kinds", async (t) => {
  const f = await fixture(t);
  for (const draft of [
    { content: { text: "x" }, requestId: null },
    { content: { text: "x" }, whenBusy: null },
    { content: { text: "x" }, entry: null },
    { content: { text: "x" }, entry: { kind: "pi.user" } },
    ...[
      "!",
      "A",
      "AAA",
      "Zg=",
      "Zg===",
      "Zg==\n",
      " Zg==",
      "Zg== ",
      "-_==",
      "data:image/png;base64,aGk=",
    ].map((data) => ({
      content: { blocks: [{ image: { data, mimeType: "image/png" } }] },
    })),
    { content: { blocks: [{ text: { text: "x", textSignature: null } }] } },
    { content: { text: "x" }, entry: { kind: "app", data: Infinity } },
  ]) {
    const result = await f.run(
      `mutation($id: ID!, $draft: InputSubmissionDraft!) { submit(input: { conversationId: $id, submission: { input: $draft } }) { submissionId } }`,
      { id: f.conversationId, draft },
    );
    assert.equal(result.errors?.[0]?.extensions.code, "BAD_REQUEST");
  }
  for (const body of [
    `reset(input: { conversationId: $id, handoff: null }) { clientMutationId }`,
    `compact(input: { conversationId: $id, instructions: null }) { taskId }`,
  ]) {
    const result = await f.run(`mutation($id: ID!) { ${body} }`, { id: f.conversationId });
    assert.equal(result.errors?.[0]?.extensions.code, "BAD_REQUEST");
  }
  const nullAt = await f.run(
    `{ harness(sessionId: "test") { conversation(id: 1) { context(at: null) { messages { __typename } } } } }`,
  );
  assert.equal(nullAt.errors?.[0]?.extensions.code, "BAD_REQUEST");
  for (const id of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"]) {
    const result = await f.run(
      `query($id: ConversationId!) { harness(sessionId: "test") { conversation(id: $id) { id } } }`,
      { id },
    );
    assert.equal(result.errors?.[0]?.extensions.code, "BAD_REQUEST");
  }
  assert.deepEqual(
    await f.success(`{ harness(sessionId: "test") { conversation(id: 9007199254740991) { id } } }`),
    { harness: { conversation: null } },
  );
  const invalidLiteral = await f.run(
    `{ harness(sessionId: "test") { conversation(id: -1) { id } } }`,
  );
  assert.equal(invalidLiteral.errors?.[0]?.extensions.code, "BAD_REQUEST");
  const wrongKind = await f.run(
    `mutation($id: ID!) { configure(input: { conversationId: $id, change: {} }) { clientMutationId } }`,
    { id: f.harnessId },
  );
  assert.equal(wrongKind.errors?.[0]?.extensions.code, "BAD_REQUEST");
  for (const id of [
    "!",
    Buffer.from("not json").toString("base64url"),
    Buffer.from(JSON.stringify([1, "Harness", "test", 1])).toString("base64url"),
  ]) {
    const result = await f.run(`query($id: ID!) { node(id: $id) { id } }`, { id });
    assert.equal(result.errors?.[0]?.extensions.code, "BAD_REQUEST");
  }
  assert.equal((await f.instance.inspect(execution)).scheduling, "paused");
});

void test("error classification depends only on typed failures, not the operation", async (t) => {
  const f = await fixture(t);
  for (const [error, code] of [
    [new StorageRequestError("private"), "BAD_REQUEST"],
    [new SessionFailed(new Error("private")), "SESSION_FAILED"],
    [new ReadAfterWrite("private"), "INTERNAL_SERVER_ERROR"],
    [new Error("SessionFailed"), "INTERNAL_SERVER_ERROR"],
    [new ConversationBusy(f.root.id), "CONVERSATION_BUSY"],
    [undefined, "INTERNAL_SERVER_ERROR"],
    ["SessionFailed", "INTERNAL_SERVER_ERROR"],
  ] as const) {
    t.mock.method(f.instance, "inspect", async () => {
      throw error;
    });
    const result = await f.run(`{ harness(sessionId: "test") { inspect { scheduling } } }`);
    assert.equal(result.errors?.[0]?.extensions.code, code);
    assert.deepEqual(result.errors?.[0]?.path, ["harness", "inspect"]);
    assert.equal(result.data?.harness, null);
    t.mock.restoreAll();
  }
  for (const [error, code] of [
    [new StorageRequestError("private"), "BAD_REQUEST"],
    [new SessionFailed(new Error("private")), "SESSION_FAILED"],
    [new ConversationBusy(f.root.id), "CONVERSATION_BUSY"],
    [new Error("private"), "INTERNAL_SERVER_ERROR"],
  ] as const) {
    t.mock.method(f.instance, "conversation", async () => f.root);
    t.mock.method(f.root, "configure", async () => {
      throw error;
    });
    const result = await f.run(
      `mutation($id: ID!) { configure(input: { conversationId: $id, change: {} }) { clientMutationId } }`,
      { id: f.conversationId },
    );
    assert.equal(result.errors?.[0]?.extensions.code, code);
    assert.equal(result.data?.configure, null);
    t.mock.restoreAll();
  }
  const missing = await f.run(
    `mutation($id: ID!) { abort(input: { conversationId: $id }) { clientMutationId } }`,
    { id: f.conversationId },
    f.request({ session: async () => undefined }),
  );
  assert.equal(missing.errors?.[0]?.extensions.code, "NOT_FOUND");
});

void test("inspection diagnostics use native JSON serialization and serialization failures stay internal", async (t) => {
  const f = await fixture(t);
  const taskId = await f.instance.commit(
    (tx) =>
      tx.createTask(
        CompactionTask,
        { reason: "manual" },
        { conversationId: f.root.id, ownership: { kind: "conversation" } },
      ),
    execution,
  );
  const record = await f.instance.getTask(taskId, execution);
  assert(record);
  let error: unknown = new Error("private");
  t.mock.method(f.instance, "inspect", async (): Promise<HarnessInspection> => ({
    scheduling: "paused",
    submissions: [],
    tasks: [{ record, state: { kind: "blocked", reason: "missing_task", error } }],
  }));
  const query = `{ harness(sessionId: "test") { inspect { tasks { state { kind reason error } } } } }`;
  const data = await f.success(query);
  assert.deepEqual(data, {
    harness: {
      inspect: { tasks: [{ state: { kind: "blocked", reason: "missing_task", error: {} } }] },
    },
  });
  error = { arbitrary: [null, 42] };
  assert.deepEqual(await f.success(query), {
    harness: {
      inspect: { tasks: [{ state: { kind: "blocked", reason: "missing_task", error } }] },
    },
  });
  error = {
    toJSON() {
      throw new Error("private");
    },
  };
  const result = await f.run(query);
  assert.equal(result.errors?.[0]?.extensions.code, "INTERNAL_SERVER_ERROR");
});

void test("scalar codecs preserve structured values and reject invalid input/output", () => {
  function codec(name: string) {
    const value = schema.getType(name);
    assert(isScalarType(value));
    return value;
  }
  function code(expected: string) {
    return (error: unknown) => error instanceof GraphQLError && error.extensions.code === expected;
  }
  for (const name of ["ConversationId", "EntryId", "TaskId", "SubmissionId"]) {
    const id = codec(name);
    assert.equal(id.parseValue(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
    assert.equal(id.serialize(0), 0);
    assert.equal(id.parseLiteral(parseValue("42")), 42);
    assert.throws(() => id.serialize(-1), code("INTERNAL_SERVER_ERROR"));
    assert.throws(() => id.parseValue("42"), code("BAD_REQUEST"));
  }
  const json = codec("JsonValue");
  const value = { "file.name": [null, true, { x: 42 }], "line\nbreak": "preserved" };
  assert.deepEqual(json.parseValue(value), value);
  assert.deepEqual(json.serialize(value), value);
  assert.deepEqual(structuredClone(json.parseLiteral(parseValue("{nested: $value}"), { value })), {
    nested: value,
  });
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  assert.throws(() => json.parseValue(cycle), code("BAD_REQUEST"));
  assert.throws(() => json.serialize(cycle), code("INTERNAL_SERVER_ERROR"));
  assert.throws(() => codec("JsonObject").parseValue([]), code("BAD_REQUEST"));
  assert.deepEqual(codec("JsonObject").parseValue(value), value);
  const keys = Object.fromEntries(
    ["", "\n", "\r", "\u2028", "\u2029", "\u0000", "雪", "💾"].map((key, index) => [key, index]),
  );
  assert.deepEqual(codec("JsonObject").parseValue(keys), keys);
  assert.deepEqual(codec("Cursor").parseValue(value), value);
  assert.throws(() => codec("Cursor").parseValue([]), code("BAD_REQUEST"));
  const trace = { traceparent: "opaque", "vendor.key": "value" };
  assert.deepEqual(codec("TelemetryCarrier").parseValue(trace), trace);
  assert.throws(() => codec("TelemetryCarrier").parseValue({ key: 42 }), code("BAD_REQUEST"));
});

void test("IDs retain their session scope for reads and mutation authorization", async (t) => {
  const a = await fixture(t, "a");
  const b = await fixture(t, "b");
  assert.equal(a.root.id, b.root.id);
  assert.notEqual(a.conversationId, b.conversationId);
  assert.notEqual(a.harnessId, b.harnessId);
  const both = a.request({
    session: async (id) => (id === "a" ? a.instance : id === "b" ? b.instance : undefined),
  });
  const result = await a.success<{
    a: { id: string; harness: { sessionId: string } };
    b: { id: string; harness: { sessionId: string } };
  }>(
    `query($a: ID!, $b: ID!) { a: node(id: $a) { id ... on ConversationRecord { harness { sessionId } } } b: node(id: $b) { id ... on ConversationRecord { harness { sessionId } } } }`,
    { a: a.conversationId, b: b.conversationId },
    both,
  );
  assert.equal(result.a.harness.sessionId, "a");
  assert.equal(result.b.harness.sessionId, "b");
  assert.deepEqual(
    await a.success(`query($id: ID!) { node(id: $id) { id } }`, { id: b.conversationId }),
    { node: null },
  );
  const denied = await a.run(
    `mutation($id: ID!) { configure(input: { conversationId: $id, change: { cwd: "/forbidden" } }) { clientMutationId } }`,
    { id: b.conversationId },
  );
  assert.equal(denied.errors?.[0]?.extensions.code, "NOT_FOUND");
  assert.equal((await b.root.agent(execution)).cwd, undefined);
});

void test("a later mutation failure does not roll back an earlier mutation", async (t) => {
  const f = await fixture(t);
  const result = await f.run(
    `mutation($id: ID!) {
    first: configure(input: { conversationId: $id, change: { cwd: "/committed" }, clientMutationId: "first" }) { clientMutationId }
    second: reset(input: { conversationId: $id, handoff: null }) { clientMutationId }
  }`,
    { id: f.conversationId },
  );
  assert.equal(result.errors?.length, 1);
  assert.equal(result.errors?.[0]?.extensions.code, "BAD_REQUEST");
  assert.deepEqual(result.errors?.[0]?.path, ["second"]);
  assert.deepEqual(JSON.parse(JSON.stringify(result.data)), {
    first: { clientMutationId: "first" },
    second: null,
  });
  assert.equal((await f.root.agent(execution)).cwd, "/committed");
});

void test("session failures are not cached and never masquerade as absence", async (t) => {
  const f = await fixture(t);
  let fail = true;
  const session = t.mock.fn(async () => {
    if (fail) throw new StorageRequestError("failure while opening storage");
    return f.instance;
  });
  const query = `{ a: harness(sessionId: "test") { id } b: harness(sessionId: "test") { id } }`;
  const failed = await f.run(query, {}, f.request({ session }));
  assert.equal(failed.errors?.length, 2);
  assert(failed.errors?.every((error) => error.extensions.code === "BAD_REQUEST"));
  assert.equal(session.mock.callCount(), 2);
  fail = false;
  const recovered = await f.success<{ a: { id: string }; b: { id: string } }>(
    query,
    {},
    f.request({ session }),
  );
  assert.deepEqual(recovered.a, recovered.b);
  assert.equal(session.mock.callCount(), 4);
});

void test("message unions expose every upstream variant, content block, and metadata field", async (t) => {
  const f = await fixture(t);
  const text: AI.TextContent = { type: "text", text: "text", textSignature: "sig" };
  const image: AI.ImageContent = { type: "image", data: "aGk=", mimeType: "image/png" };
  const tool: AI.Tool = {
    name: "read",
    description: "Read a file",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    constrainedSampling: { type: "grammar", variants: { openai_regex: ".*" } },
  };
  const assistant: AI.AssistantMessage = {
    ...fauxAssistantMessage("answer"),
    content: [
      text,
      { type: "thinking", thinking: "", thinkingSignature: "encrypted", redacted: true },
      {
        type: "toolCall",
        id: "call",
        name: "read",
        arguments: { "file.name": "notes", nested: [null, true] },
        thoughtSignature: "thought",
        namespace: "files",
        argumentsError: "recorded parse failure",
      },
    ],
    timestamp: 1700000000000,
    durationMs: 0,
    responseModel: "resolved",
    responseId: "response",
    providerThinkingLevel: "provider-effort",
    thinkingLevel: "high",
    stopReason: "deferred",
    rawStopReason: "provider-pending",
    errorMessage: "recorded error",
    endTurn: false,
    deferred: {
      provider: "faux",
      modelId: "test",
      api: "faux",
      id: "job",
      expiresAt: 1700000000010,
      pollAfterMs: 0,
      data: { opaque: [null, "token"] },
    },
    diagnostics: [
      {
        type: "provider",
        timestamp: 1700000000001,
        error: { name: "RecordedError", message: "recorded", stack: "stored diagnostic", code: 0 },
        details: { arbitrary: [null, false] },
      },
    ],
    usage: {
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      cacheWrite1h: 0,
      reasoning: 0,
      totalTokens: 10,
      cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0.3, total: 0.6 },
    },
  };
  const messages: AI.Message[] = [
    {
      role: "system",
      content: "",
      timestamp: 1,
      sections: { instructions: "keep", removed: null },
      toolsAdded: [tool],
      toolsRemoved: [{ name: "old" }],
    },
    { role: "system", content: [text], timestamp: 2 },
    { role: "user", content: "", timestamp: 3 },
    { role: "user", content: [text, image], timestamp: 4 },
    assistant,
    {
      role: "toolResult",
      toolCallId: "call",
      toolName: "read",
      content: [text, image],
      details: null,
      isError: false,
      timestamp: 1700000000002,
      durationMs: 0,
      usage: assistant.usage,
      nestedCalls: {
        complete: false,
        calls: [
          { id: "child", name: "nested", arguments: { x: [null, 1] }, status: "ok", durationMs: 0 },
          {
            id: "unfinished",
            name: "nested",
            argumentsBytes: 123,
            status: "unfinished",
            error: "stored",
          },
        ],
      },
    },
  ];
  const blockInput = (
    block: AI.TextContent | AI.ImageContent | AI.ThinkingContent | AI.ToolCall,
  ) => {
    const { type, ...fields } = block;
    return { [type]: fields };
  };
  const model = messages.map(({ role, content, ...fields }) => {
    switch (role) {
      case "system":
        return {
          system: {
            ...fields,
            content:
              typeof content === "string"
                ? { text: content }
                : {
                    blocks: content.map(({ text, textSignature }) =>
                      textSignature === undefined ? { text } : { text, textSignature },
                    ),
                  },
          },
        };
      case "user":
        return {
          user: {
            ...fields,
            content:
              typeof content === "string" ? { text: content } : { blocks: content.map(blockInput) },
          },
        };
      default:
        return { [role]: { ...fields, content: content.map(blockInput) } };
    }
  });
  const admitted = await f.success<{ submit: { submissionId: string } }>(
    `mutation($id: ID!, $entry: EntryDraft!) { submit(input: { conversationId: $id, submission: { write: { entry: $entry } } }) { submissionId } }`,
    { id: f.conversationId, entry: { kind: "app.messages", model } },
  );
  const receipt = await f.success<{ node: { type: string; status: string; entry: number } }>(
    `query($id: ID!) { node(id: $id) { ... on SubmissionRecord { type status entry } } }`,
    { id: admitted.submit.submissionId },
  );
  assert.equal(receipt.node.type, "write");
  assert.equal(receipt.node.status, "done");
  const record = (await f.root.entries({}, 1, undefined, execution)).items[0]!;
  assert.equal(record.id, receipt.node.entry);
  assert.deepEqual(record.model, messages);
  assert.equal(f.faux.state.callCount, 0);
  const fragments = `
    fragment TextFields on TextContent { __typename type text textSignature }
    fragment ImageFields on ImageContent { __typename type data mimeType }
    fragment UsageFields on Usage { input output cacheRead cacheWrite cacheWrite1h reasoning totalTokens cost { input output cacheRead cacheWrite total } }
    fragment MessageFields on Message {
      __typename
      ... on SystemMessage {
        role timestamp sections toolsAdded { name description parameters constrainedSampling } toolsRemoved { name }
        systemContent: content { __typename ... on StringContent { text } ... on TextContentList { blocks { ...TextFields } } }
      }
      ... on UserMessage {
        role timestamp
        userContent: content { __typename ... on StringContent { text } ... on UserContentList { blocks { ...TextFields ...ImageFields } } }
      }
      ... on AssistantMessage {
        role timestamp api provider model responseModel responseId providerThinkingLevel thinkingLevel stopReason rawStopReason errorMessage endTurn durationMs
        assistantContent: content { ...TextFields ... on ThinkingContent { __typename type thinking thinkingSignature redacted } ... on ToolCall { __typename type id name arguments thoughtSignature namespace argumentsError } }
        usage { ...UsageFields }
        deferred { provider modelId api id expiresAt pollAfterMs data }
        diagnostics { type timestamp error { name message stack code } details }
      }
      ... on ToolResultMessage {
        role timestamp toolCallId toolName isError durationMs details resultUsage: usage { ...UsageFields }
        resultContent: content { ...TextFields ...ImageFields }
        nestedCalls { complete calls { id name arguments argumentsBytes status durationMs error } }
      }
    }
  `;
  type Result = { id: string; durableId: number; model: Array<Record<string, unknown>> };
  const result = await f.success<{ harness: { conversation: { entries: { nodes: Result[] } } } }>(
    `{ harness(sessionId: "test") { conversation(id: 1) { entries(limit: 1) { nodes { id durableId model { ...MessageFields } } } } } } ${fragments}`,
  );
  const entry = result.harness.conversation.entries.nodes[0]!;
  assert.equal(entry.durableId, record.id);
  assert.deepEqual(
    entry.model.map((value) => value.__typename),
    [
      "SystemMessage",
      "SystemMessage",
      "UserMessage",
      "UserMessage",
      "AssistantMessage",
      "ToolResultMessage",
    ],
  );
  const projectedText = { ...text, __typename: "TextContent" };
  const projectedImage = { ...image, __typename: "ImageContent" };
  assert.deepEqual(entry.model[0], {
    __typename: "SystemMessage",
    role: "system",
    timestamp: 1,
    systemContent: { __typename: "StringContent", text: "" },
    sections: { instructions: "keep", removed: null },
    toolsAdded: [tool],
    toolsRemoved: [{ name: "old" }],
  });
  assert.deepEqual(entry.model[1], {
    __typename: "SystemMessage",
    role: "system",
    timestamp: 2,
    systemContent: { __typename: "TextContentList", blocks: [projectedText] },
    sections: null,
    toolsAdded: null,
    toolsRemoved: null,
  });
  assert.deepEqual(entry.model[2], {
    __typename: "UserMessage",
    role: "user",
    timestamp: 3,
    userContent: { __typename: "StringContent", text: "" },
  });
  assert.deepEqual(entry.model[3], {
    __typename: "UserMessage",
    role: "user",
    timestamp: 4,
    userContent: { __typename: "UserContentList", blocks: [projectedText, projectedImage] },
  });
  const { content: assistantBlocks, ...assistantFields } = assistant;
  assert.deepEqual(entry.model[4], {
    ...assistantFields,
    __typename: "AssistantMessage",
    assistantContent: [
      projectedText,
      { ...assistantBlocks[1], __typename: "ThinkingContent" },
      { ...assistantBlocks[2], __typename: "ToolCall" },
    ],
  });
  assert.deepEqual(entry.model[5], {
    __typename: "ToolResultMessage",
    role: "toolResult",
    toolCallId: "call",
    toolName: "read",
    isError: false,
    timestamp: 1700000000002,
    durationMs: 0,
    details: null,
    resultUsage: assistant.usage,
    resultContent: [projectedText, projectedImage],
    nestedCalls: {
      complete: false,
      calls: [
        {
          id: "child",
          name: "nested",
          arguments: { x: [null, 1] },
          argumentsBytes: null,
          status: "ok",
          durationMs: 0,
          error: null,
        },
        {
          id: "unfinished",
          name: "nested",
          arguments: null,
          argumentsBytes: 123,
          status: "unfinished",
          durationMs: null,
          error: "stored",
        },
      ],
    },
  });
  const refetch = await f.success<{ node: Result }>(
    `query($id: ID!) { node(id: $id) { id ... on EntryRecord { durableId model { ...MessageFields } } } } ${fragments}`,
    { id: entry.id },
  );
  assert.deepEqual(refetch.node, entry);
  assert.deepEqual(
    (await f.instance.commit((tx) => tx.entry(record.id), execution))?.model,
    record.model,
  );
});

void test("typed messages are projected in edit replacements, current/historical context and contributions", async (t) => {
  const f = await fixture(t);
  const original: AI.UserMessage = { role: "user", content: "original", timestamp: 1 };
  const first = await f.instance.commit(
    (tx) => tx.appendEntry(f.root.id, { kind: "app.first", model: [original] }),
    execution,
  );
  await f.success(
    `mutation($id: ID!, $target: EntryId!) { submit(input: { conversationId: $id, submission: { write: { entry: { kind: "app.edit", edits: [{ replace: { target: $target, messages: [{ user: { content: { blocks: [] }, timestamp: 2 } }] } }] } } } }) { submissionId } }`,
    { id: f.conversationId, target: first.id },
  );
  const replaced = {
    __typename: "UserMessage",
    role: "user",
    timestamp: 2,
    content: { __typename: "UserContentList", blocks: [] },
  };
  const result = await f.success<{
    harness: {
      conversation: {
        entries: {
          nodes: Array<{
            edits: Array<{ target: number; action: string; messages: unknown[] }> | null;
          }>;
        };
        context: { messages: unknown[]; contributions: unknown[][] };
        historical: { messages: unknown[] };
      };
    };
  }>(
    `query($at: EntryId!) { harness(sessionId: "test") { conversation(id: 1) {
    entries(limit: 2) { nodes { edits { target action messages { ${userMessageFields} } } } }
    context { messages { ${userMessageFields} } contributions { ${userMessageFields} } }
    historical: context(at: $at) { messages { ${userMessageFields} } }
  } } }`,
    { at: first.id },
  );
  assert.deepEqual(result.harness.conversation.entries.nodes[0]?.edits, [
    { target: first.id, action: "replace", messages: [replaced] },
  ]);
  assert.deepEqual(result.harness.conversation.context.messages, [replaced]);
  assert.deepEqual(result.harness.conversation.context.contributions, [[replaced], []]);
  assert.deepEqual(result.harness.conversation.historical.messages, [
    {
      __typename: "UserMessage",
      role: "user",
      timestamp: 1,
      content: { __typename: "StringContent", text: "original" },
    },
  ]);
  assert.deepEqual((await f.instance.commit((tx) => tx.entry(first.id), execution))?.model, [
    original,
  ]);
  await f.success(
    `mutation($id: ID!, $target: EntryId!) { submit(input: { conversationId: $id, submission: { write: { entry: { kind: "app.omit", edits: [{ omit: $target }] } } } }) { submissionId } }`,
    { id: f.conversationId, target: first.id },
  );
  assert.deepEqual((await f.root.context(execution)).messages, []);
  assert.equal(f.faux.state.callCount, 0);
});

void test("one-of inputs reject invalid alternatives before submission", async (t) => {
  const f = await fixture(t);
  t.mock.method(f.instance, "conversation", async () => f.root);
  const submit = t.mock.method(f.root, "submit");
  const mutation = `mutation($id: ID!, $content: UserInput!) { submit(input: { conversationId: $id, submission: { input: { content: $content } } }) { submissionId } }`;
  for (const content of [
    "raw text",
    [],
    null,
    {},
    { text: null },
    { blocks: null },
    { text: "x", blocks: [] },
    { blocks: [{}] },
    { blocks: [{ text: null }] },
    { blocks: [{ text: { text: "x" }, image: { data: "", mimeType: "image/png" } }] },
    { blocks: [{ text: { text: 3 } }] },
    { blocks: [{ text: { text: "x", unknown: true } }] },
  ]) {
    const result = await f.run(mutation, { id: f.conversationId, content });
    assert(result.errors?.length);
    assert.equal(result.data, undefined);
    assert.equal(result.errors[0]?.path, undefined);
  }
  for (const content of ["{}", "{ text: null }", '{ text: "x", blocks: [] }', "{ blocks: [{}] }"]) {
    const result = await f.run(
      `mutation($id: ID!) { submit(input: { conversationId: $id, submission: { input: { content: ${content} } } }) { submissionId } }`,
      { id: f.conversationId },
    );
    assert(result.errors?.length);
    assert.equal(result.data, undefined);
  }
  assert.equal(submit.mock.callCount(), 0);
  assert.equal((await f.instance.inspect(execution)).scheduling, "paused");
});

void test("one-of input literals preserve empty text, empty blocks and ordered image/text content", async (t) => {
  const f = await fixture(t);
  const cases: Array<{ literal: string; content: AI.UserMessage["content"] }> = [
    { literal: `{ text: "" }`, content: "" },
    { literal: `{ blocks: [] }`, content: [] },
    {
      literal: `{ blocks: [{ image: { data: "aGk=", mimeType: "image/png" } }, { text: { text: "caption", textSignature: "signature" } }, { text: { text: "plain" } }] }`,
      content: [
        { type: "image", data: "aGk=", mimeType: "image/png" },
        { type: "text", text: "caption", textSignature: "signature" },
        { type: "text", text: "plain" },
      ],
    },
  ];
  // RFC 4648 section 10 base64 vectors; validation checks encoding, not image bytes.
  // https://www.rfc-editor.org/rfc/rfc4648#section-10
  for (const data of ["", "Zg==", "Zm8=", "Zm9v", "Zm9vYg==", "Zm9vYmE=", "Zm9vYmFy"]) {
    cases.push({
      literal: `{ blocks: [{ image: { data: "${data}", mimeType: "image/png" } }] }`,
      content: [{ type: "image", data, mimeType: "image/png" }],
    });
  }
  f.faux.setResponses(cases.map(() => fauxAssistantMessage("answer")));
  for (const { literal, content } of cases) {
    const result = await f.success<{ submit: { submissionId: string } }>(
      `mutation($id: ID!) { submit(input: { conversationId: $id, submission: { input: { content: ${literal} } } }) { submissionId } }`,
      { id: f.conversationId },
    );
    const node = await f.success<{ node: { durableId: SubmissionId } }>(
      `query($id: ID!) { node(id: $id) { ... on SubmissionRecord { durableId } } }`,
      { id: result.submit.submissionId },
    );
    const submission = await f.instance.submission(node.node.durableId, execution);
    assert(submission);
    const receipt = await submission.wait(execution);
    assert.equal(receipt.status, "done");
    assert(receipt.entry !== undefined);
    const entry = await f.instance.commit((tx) => tx.entry(receipt.entry!), execution);
    assert.deepEqual(entry?.model?.[0]?.content, content);
  }
});

void test("message projection preserves absent metadata, empty arrays and JSON payloads", async (t) => {
  const f = await fixture(t);
  const details = { "file.name": [null, true], "line\nbreak": { value: 0 } };
  const messages: AI.Message[] = [
    {
      role: "system",
      content: [],
      timestamp: 0,
      toolsAdded: [
        { name: "disabled", description: "", parameters: {}, constrainedSampling: false },
        { name: "default", description: "", parameters: {} },
      ],
    },
    { ...fauxAssistantMessage(""), content: [] },
    {
      role: "toolResult",
      toolCallId: "call",
      toolName: "tool",
      content: [],
      isError: true,
      timestamp: 0,
      details,
    },
  ];
  await f.instance.commit(
    (tx) => tx.appendEntry(f.root.id, { kind: "app.optional", model: messages }),
    execution,
  );
  const result = await f.success<{
    harness: { conversation: { entries: { nodes: Array<{ model: unknown[] }> } } };
  }>(`{
    harness(sessionId: "test") { conversation(id: 1) { entries(limit: 1) { nodes { model {
      __typename
      ... on SystemMessage { content { ... on TextContentList { blocks { text } } } toolsAdded { constrainedSampling } }
      ... on AssistantMessage { assistantContent: content { __typename } diagnostics { type } deferred { id } usage { cacheWrite1h reasoning } }
      ... on ToolResultMessage { resultContent: content { __typename } details nestedCalls { complete } toolUsage: usage { totalTokens } }
    } } } } }
  }`);
  assert.deepEqual(result.harness.conversation.entries.nodes[0]?.model, [
    {
      __typename: "SystemMessage",
      content: { blocks: [] },
      toolsAdded: [{ constrainedSampling: false }, { constrainedSampling: null }],
    },
    {
      __typename: "AssistantMessage",
      assistantContent: [],
      diagnostics: null,
      deferred: null,
      usage: { cacheWrite1h: null, reasoning: null },
    },
    {
      __typename: "ToolResultMessage",
      resultContent: [],
      details,
      nestedCalls: null,
      toolUsage: null,
    },
  ]);
});

void test("write submissions place metadata without generation and recover by request ID", async (t) => {
  const f = await fixture(t);
  const mutation = `mutation($id: ID!, $draft: SubmissionDraft!) { submit(input: { conversationId: $id, submission: $draft, clientMutationId: "echo" }) { submissionId clientMutationId } }`;
  const data = { "file.path": "/workspace/image.png", "line\nbreak": [null, true, 3] };
  const admitted = await f.success<{ submit: { submissionId: string; clientMutationId: string } }>(
    mutation,
    {
      id: f.conversationId,
      draft: { write: { requestId: "write-key", entry: { kind: "app.attachment", data } } },
    },
  );
  assert.equal(admitted.submit.clientMutationId, "echo");
  assert.deepEqual(
    await f.success(mutation, {
      id: f.conversationId,
      draft: { write: { requestId: "write-key", entry: { kind: "different", data: null } } },
    }),
    admitted,
  );
  const receipt = await f.success<{ node: { type: string; status: string; entry: number } }>(
    `query($id: ID!) { node(id: $id) { ... on SubmissionRecord { type status entry } } }`,
    { id: admitted.submit.submissionId },
  );
  assert.equal(receipt.node.type, "write");
  assert.equal(receipt.node.status, "done");
  const history = await f.root.entries({}, 10, undefined, execution);
  assert.deepEqual(history.items, [
    { id: receipt.node.entry, conversationId: f.root.id, kind: "app.attachment", data },
  ]);
  const mismatch = await f.run(mutation, {
    id: f.conversationId,
    draft: { input: { requestId: "write-key", content: { text: "not admitted" } } },
  });
  assert.equal(mismatch.errors?.[0]?.extensions.code, "INTERNAL_SERVER_ERROR");
  // Writes retain upstream EntryDraft semantics, including pi.* kinds and JSON null.
  await f.success(mutation, {
    id: f.conversationId,
    draft: { write: { entry: { kind: "pi.note", data: null } } },
  });
  await f.success(mutation, {
    id: f.conversationId,
    draft: { write: { entry: { kind: "app.no-data" } } },
  });
  const placed = (await f.root.entries({}, 10, undefined, execution)).items;
  assert.equal(placed.length, 3);
  assert.equal(Object.hasOwn(placed[0]!, "data"), false);
  assert.equal(placed[1]?.data, null);
  assert.deepEqual((await f.root.context(execution)).messages, []);
  assert.equal(f.faux.state.callCount, 0);
  assert.deepEqual((await f.instance.inspect(execution)).tasks, []);
});

void test("busy writes preserve boundary queuing, empty model arrays, and reset ordering", async (t) => {
  const f = await fixture(t);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.faux.setResponses([
    async (_request, options) => {
      assert(options?.signal);
      started.resolve();
      await awaitWithContext(release.promise, withAbortSignal(options.signal, execution));
      return fauxAssistantMessage("answer");
    },
  ]);
  t.after(() => release.resolve());
  const active = await f.root.submit({ type: "input", content: "question" }, execution);
  await started.promise;
  const mutation = `mutation($id: ID!, $draft: WriteSubmissionDraft!) { submit(input: { conversationId: $id, submission: { write: $draft } }) { submissionId } }`;
  async function receipt(requestId: string) {
    const value = await f.instance.commit(
      (tx) => tx.submissionByRequest(f.root.id, requestId),
      execution,
    );
    assert(value);
    return value;
  }
  for (const [requestId, entry, status] of [
    ["empty-model", { kind: "app.context", model: [] }, "queued"],
    ["display", { kind: "app.display", data: 1 }, "done"],
    ["reset", { kind: "pi.reset", head: "self", model: [] }, "queued"],
    ["after-reset", { kind: "app.after-reset", data: 2 }, "queued"],
    ["withdrawn", { kind: "app.withdrawn", model: [] }, "queued"],
  ] as const) {
    await f.success(mutation, { id: f.conversationId, draft: { requestId, entry } });
    assert.equal((await receipt(requestId)).status, status);
  }
  const withdrawn = await receipt("withdrawn");
  assert.deepEqual(
    await f.success(
      `mutation($conversation: ID!, $id: SubmissionId!) { abortSubmission(input: { conversationId: $conversation, id: $id }) { result } }`,
      { conversation: f.conversationId, id: withdrawn.id },
    ),
    { abortSubmission: { result: "aborted" } },
  );
  assert.equal(
    (await f.root.entries({}, 50, undefined, execution)).items.some(
      (entry) => entry.kind === "app.context",
    ),
    false,
  );
  release.resolve();
  await active.wait(execution);
  await f.root.waitForIdle(execution);
  for (const requestId of ["empty-model", "display", "reset", "after-reset"]) {
    assert.equal((await receipt(requestId)).status, "done");
  }
  assert.equal((await receipt("withdrawn")).status, "unanswered");
  const history = (await f.root.entries({}, 50, undefined, execution)).items;
  const reset = history.find((entry) => entry.kind === "pi.reset");
  const after = history.find((entry) => entry.kind === "app.after-reset");
  assert(reset && after);
  assert.equal(reset.head, reset.id);
  assert(after.id > reset.id);
  assert.equal(
    history.some((entry) => entry.kind === "app.withdrawn"),
    false,
  );
  assert.deepEqual(history.find((entry) => entry.kind === "app.context")?.model, []);
  assert.deepEqual((await f.root.context(execution)).messages, []);
  assert.equal(f.faux.state.callCount, 1);
});

void test("write heads preserve native self and entry IDs and reject stale placement", async (t) => {
  const f = await fixture(t);
  const first = await f.instance.commit(
    (tx) => tx.appendEntry(f.root.id, { kind: "app.first" }),
    execution,
  );
  await f.success(
    `mutation($id: ID!) { submit(input: { conversationId: $id, submission: { write: { entry: { kind: "app.reset", head: "self" } } } }) { submissionId } }`,
    { id: f.conversationId },
  );
  const reset = (await f.root.entries({}, 1, undefined, execution)).items[0]!;
  assert.equal(reset.head, reset.id);
  const mutation = `mutation($id: ID!, $head: EntryHead!, $key: String!) { submit(input: { conversationId: $id, submission: { write: { requestId: $key, entry: { kind: "app.head", head: $head } } } }) { submissionId } }`;
  await f.success(mutation, { id: f.conversationId, head: reset.id, key: "same-head" });
  await f.success(mutation, { id: f.conversationId, head: first.id, key: "stale-head" });
  const [same, stale] = await f.instance.commit(
    async (tx) => [
      await tx.submissionByRequest(f.root.id, "same-head"),
      await tx.submissionByRequest(f.root.id, "stale-head"),
    ],
    execution,
  );
  assert.equal(same?.status, "done");
  assert.equal(stale?.status, "unanswered");
  assert.equal(stale?.reason, "stale");
  assert.equal((await f.root.entries({}, 10, undefined, execution)).items.length, 3);
  assert.equal((await f.root.context(execution)).head?.head, reset.id);
  assert.equal(f.faux.state.callCount, 0);
});

void test("submission and write message one-of inputs reject invalid variants before admission", async (t) => {
  const f = await fixture(t);
  t.mock.method(f.instance, "conversation", async () => f.root);
  const submit = t.mock.method(f.root, "submit");
  const mutation = `mutation($id: ID!, $draft: SubmissionDraft!) { submit(input: { conversationId: $id, submission: $draft }) { submissionId } }`;
  for (const draft of [
    {},
    { input: null },
    { write: null },
    { input: { content: { text: "x" } }, write: { entry: { kind: "app" } } },
    { type: "write", entry: { kind: "app" } },
    { write: {} },
    { write: { entry: { kind: "app" }, content: { text: "x" } } },
    { write: { entry: { kind: "app" }, whenBusy: "followUp" } },
    { input: { content: { text: "x" }, entry: { kind: "app", model: [] } } },
    ...[
      {},
      { user: null },
      {
        user: { content: { text: "x" }, timestamp: 1 },
        system: { content: { text: "x" }, timestamp: 1 },
      },
    ].map((message) => ({ write: { entry: { kind: "app", model: [message] } } })),
    ...[
      {},
      { omit: null },
      { omit: 1, replace: { target: 1, messages: [] } },
      { replace: { target: 1 } },
    ].map((edit) => ({ write: { entry: { kind: "app", edits: [edit] } } })),
  ]) {
    const result = await f.run(mutation, { id: f.conversationId, draft });
    assert(result.errors?.length);
    assert.equal(result.data, undefined);
  }
  for (const draft of [
    "{}",
    "{ input: null }",
    '{ write: { entry: { kind: "app" } }, input: { content: { text: "x" } } }',
  ]) {
    const result = await f.run(
      `mutation($id: ID!) { submit(input: { conversationId: $id, submission: ${draft} }) { submissionId } }`,
      { id: f.conversationId },
    );
    assert(result.errors?.length);
    assert.equal(result.data, undefined);
  }
  assert.equal(submit.mock.callCount(), 0);
  assert.deepEqual((await f.root.entries({}, 10, undefined, execution)).items, []);
});

void test("write input validation rejects invalid heads, null optionals and malformed message metadata", async (t) => {
  const f = await fixture(t);
  t.mock.method(f.instance, "conversation", async () => f.root);
  const submit = t.mock.method(f.root, "submit");
  const mutation = `mutation($id: ID!, $draft: WriteSubmissionDraft!) { submit(input: { conversationId: $id, submission: { write: $draft } }) { submissionId } }`;
  const assistant = {
    content: [],
    api: "faux",
    provider: "faux",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  };
  for (const draft of [
    { entry: { kind: "app" }, requestId: null },
    ...[null, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "other", "1"].map((head) => ({
      entry: { kind: "app", head },
    })),
    { entry: { kind: "app", model: null } },
    { entry: { kind: "app", edits: null } },
    ...[
      { system: { content: { text: "x" }, timestamp: 1, sections: { invalid: 1 } } },
      {
        system: {
          content: { text: "x" },
          timestamp: 1,
          toolsAdded: [
            { name: "tool", description: "", parameters: {}, constrainedSampling: true },
          ],
        },
      },
      {
        user: {
          content: { blocks: [{ image: { data: "bad", mimeType: "image/png" } }] },
          timestamp: 1,
        },
      },
      {
        assistant: {
          ...assistant,
          diagnostics: [{ type: "test", timestamp: 1, error: { message: "x", code: [] } }],
        },
      },
      {
        assistant: {
          ...assistant,
          deferred: { provider: "faux", modelId: "test", api: "faux", id: "id", expiresAt: null },
        },
      },
      { assistant: { ...assistant, usage: { ...assistant.usage, reasoning: null } } },
      { assistant: { ...assistant, content: [{ thinking: { thinking: "x", redacted: null } }] } },
      {
        toolResult: {
          toolCallId: "call",
          toolName: "tool",
          content: [],
          timestamp: 1,
          isError: false,
          nestedCalls: {
            complete: true,
            calls: [{ id: "nested", name: "tool", status: "ok", arguments: null }],
          },
        },
      },
    ].map((message) => ({ entry: { kind: "app", model: [message] } })),
  ]) {
    const result = await f.run(mutation, { id: f.conversationId, draft });
    assert.equal(result.errors?.[0]?.extensions.code, "BAD_REQUEST", JSON.stringify(draft));
  }
  assert.equal(submit.mock.callCount(), 0);
});

void test("write messages preserve omitted optionals, JSON null and constrained sampling variants", async (t) => {
  const f = await fixture(t);
  const system = {
    timestamp: 1,
    toolsAdded: [
      { name: "plain", description: "", parameters: {} },
      { name: "disabled", description: "", parameters: {}, constrainedSampling: false },
      {
        name: "schema",
        description: "",
        parameters: {},
        constrainedSampling: { type: "json_schema", strict: "require" },
      },
      {
        name: "grammar",
        description: "",
        parameters: {},
        constrainedSampling: {
          type: "grammar",
          variants: { openai_regex: "[a-z]+", openai_lark: "start: WORD" },
        },
      },
    ],
  };
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const assistant = {
    content: [],
    api: "faux",
    provider: "faux",
    model: "test",
    usage,
    stopReason: "deferred",
    timestamp: 3,
    diagnostics: [
      { type: "notice", timestamp: 3 },
      { type: "error", timestamp: 3, error: { message: "x" } },
    ],
    deferred: { provider: "faux", modelId: "test", api: "faux", id: "request", data: null },
  };
  const toolResult = {
    toolCallId: "call",
    toolName: "tool",
    content: [],
    isError: false,
    timestamp: 4,
  };
  await f.success(
    `mutation($id: ID!, $model: [MessageInput!]!) { submit(input: { conversationId: $id, submission: { write: { entry: { kind: "app.messages", model: $model } } } }) { submissionId } }`,
    {
      id: f.conversationId,
      model: [
        { system: { ...system, content: { text: "" } } },
        { user: { content: { text: "" }, timestamp: 2 } },
        { assistant },
        { toolResult },
        { toolResult: { ...toolResult, details: null } },
      ],
    },
  );
  assert.deepEqual((await f.root.entries({}, 1, undefined, execution)).items[0]?.model, [
    { role: "system", ...system, content: "" },
    { role: "user", content: "", timestamp: 2 },
    { role: "assistant", ...assistant },
    { role: "toolResult", ...toolResult },
    { role: "toolResult", ...toolResult, details: null },
  ]);
  assert.equal(f.faux.state.callCount, 0);
});
