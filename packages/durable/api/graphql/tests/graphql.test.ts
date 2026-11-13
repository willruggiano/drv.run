import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  GraphQLError,
  graphql,
  isScalarType,
  isUnionType,
  isInputObjectType,
  isObjectType,
  getNamedType,
  parseValue,
  validateSchema,
} from "graphql";
import type { JsonValue } from "@earendil-works/chord";
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
  defineDoc,
  defineDocFamily,
  AgentDoc,
  type DocumentAddress,
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
import { createSchema, type ResolverContext } from "../src/index.ts";

import {
  unavailableSettings,
  settingsFixture,
  unavailableInventory,
  inventoryFixture,
} from "../../tests/fixtures.ts";

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

function catalogContext(models: ResolverContext["models"], context = execution): ResolverContext {
  return {
    context,
    models,
    documents: { definitions: async () => [], resolve: async () => undefined },
    settings: unavailableSettings,
    inventory: unavailableInventory,
    isValidExternalId() {
      assert.fail("catalog reads must not validate external IDs");
    },
    async session() {
      assert.fail("catalog reads must not acquire a Harness");
    },
    async sessions() {
      assert.fail("catalog reads must not enumerate sessions");
    },
  };
}

async function fixture(t: TestContext, externalId = "test") {
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
      documents: { definitions: async () => [], resolve: async () => undefined },
      settings: unavailableSettings,
      inventory: unavailableInventory,
      isValidExternalId: (id) => id.length > 0,
      session: async (id) => (id === externalId ? instance : undefined),
      sessions: async () => [externalId],
      models: () => models,
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
    `query($session: String!) { harness(externalId: $session) { id conversation(id: 1) { id durableId } } }`,
    { session: externalId },
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

void test("GraphQL entry point exposes only the schema factory", async () => {
  assert.deepEqual(Object.keys(await import("../src/index.ts")), ["createSchema"]);
  assert.throws(() => import.meta.resolve("durable-api/graphql/src/graphql.ts"), {
    code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
  });
});

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
    "SaveSettingsInput",
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

void test("schema distinguishes external keys from global IDs and has no correlation echoes", () => {
  const harness = schema.getType("Harness");
  assert(isObjectType(harness));
  const externalId = harness.getFields().externalId;
  assert(externalId);
  assert.equal(getNamedType(externalId.type), schema.getType("String"));
  assert.equal(harness.getFields().sessionId, undefined);
  const query = schema.getQueryType();
  assert(query);
  const lookup = query.getFields().harness;
  assert(lookup);
  assert.deepEqual(
    lookup.args.map((argument) => argument.name),
    ["externalId"],
  );
  const resume = schema.getType("ResumeInput");
  assert(isInputObjectType(resume));
  assert.deepEqual(Object.keys(resume.getFields()), ["harnessId"]);
  const harnessId = resume.getFields().harnessId;
  assert(harnessId);
  assert.equal(getNamedType(harnessId.type), schema.getType("ID"));
  for (const type of Object.values(schema.getTypeMap())) {
    if (isObjectType(type) || isInputObjectType(type)) {
      assert.equal(type.getFields().clientMutationId, undefined);
    }
  }
  const mutation = schema.getMutationType();
  assert(mutation);
  for (const [operation, payload] of [
    ["abort", "AbortPayload"],
    ["resume", "ResumePayload"],
    ["reset", "ResetPayload"],
    ["configure", "ConfigurePayload"],
  ] as const) {
    assert.equal(mutation.getFields()[operation]?.type, schema.getType("Boolean"));
    assert.equal(schema.getType(payload), undefined);
  }
  for (const [payload, field] of [
    ["SubmitPayload", "submissionId"],
    ["CompactPayload", "taskId"],
    ["AbortSubmissionPayload", "result"],
  ] as const) {
    const type = schema.getType(payload);
    assert(isObjectType(type));
    assert.deepEqual(Object.keys(type.getFields()), [field]);
  }
});

void test("catalog list, authorized sessions, missing nodes, and independent reads", async (t) => {
  const f = await fixture(t);
  const session = t.mock.fn(async (id: string) => (id === "test" ? f.instance : undefined));
  const ctx = () => f.request({ session, sessions: async () => ["z", "test", "a / 雪"] });
  const list = `{ harnesses { id externalId } }`;
  const all = await f.success<{ harnesses: Array<{ id: string; externalId: string }> }>(
    list,
    {},
    ctx(),
  );
  assert.deepEqual(
    all.harnesses.map((item) => item.externalId),
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
    `query($id: ID!) { a: harness(externalId: "test") { id } b: harness(externalId: "test") { id } node(id: $id) { id } absent: harness(externalId: "absent") { id } }`,
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
  const read = `{ harness(externalId: "test") { conversation(id: 1) { agent { cwd model { ... on ModelRef { provider modelId } } thinkingLevel instructions } } } }`;
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
  const change = `mutation($id: ID!, $change: AgentChange!) { configure(input: { conversationId: $id, change: $change }) }`;
  assert.deepEqual(
    await f.success(change, {
      id: f.conversationId,
      change: { cwd: "/work", thinkingLevel: "high" },
    }),
    { configure: true },
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
      configure(input: { conversationId: $id, change: { model: $model } })
    }`,
    { id: f.conversationId, model: { provider: "faux", modelId: "test" } },
  );
  value = (await f.success<Settings>(read)).harness.conversation.agent;
  assert.deepEqual(value.model, { provider: "faux", modelId: "test" });
  await f.root.configure({ instructions: "extra" }, execution);
  await f.success(
    `mutation($id: ID!) {
    a: configure(input: { conversationId: $id, change: { cwd: "first" } })
    b: configure(input: { conversationId: $id, change: { cwd: "second" } })
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
  const query = `query($limit: Int!, $cursor: Cursor, $filter: EntryQuery!) { harness(externalId: "test") { conversation(id: 1) { entries(limit: $limit, cursor: $cursor, query: $filter) { nodes { id durableId data } ${pageFields} } } } }`;
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
  const query = `query($cursor: Cursor) { harness(externalId: "test") { scanTasks(limit: 7, cursor: $cursor) { nodes { id } pageInfo { next } } } }`;
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
    harness(externalId: "test") {
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
  const read = `{ harness(externalId: "test") {
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
    `query($cursor: Cursor!) { harness(externalId: "test") { scanConversations(limit: 1, cursor: $cursor) { nodes { id durableId } ${pageFields} } } }`,
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
    harness(externalId: "test") { scanTasks(limit: 5) { nodes { id durableId state { status checkpoint } } } inspect { tasks { record { id durableId state { status checkpoint } } } } }
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
  const query = `{ harness(externalId: "test") { a: conversation(id: 1) { agent { cwd } } b: conversation(id: 1) { agent { cwd } } } }`;
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
  const mutation = `mutation($id: ID!, $draft: InputSubmissionDraft!) { submit(input: { conversationId: $id, submission: { input: $draft } }) { submissionId } }`;
  type Result = { submit: { submissionId: string } };
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
  }>(`{ harness(externalId: "test") { inspect { submissions { id status } } } }`);
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
    `query($id: SubmissionId!) { harness(externalId: "test") { conversation(id: 1) { submissionByRequest(requestId: "key") { id durableId conversationId status requestId } status(id: $id) { id durableId conversationId status requestId } } } }`,
    { id: receipt.node.durableId },
  );
  assert.deepEqual(recovery.harness.conversation.submissionByRequest, receipt.node);
  assert.deepEqual(recovery.harness.conversation.status, receipt.node);
  const other = await f.instance.createConversation(
    { ownership: { kind: "ownerless" } },
    execution,
  );
  const foreign = await f.success<{ harness: { conversation: { id: string; status: null } } }>(
    `query($conversation: ConversationId!, $id: SubmissionId!) { harness(externalId: "test") { conversation(id: $conversation) { id status(id: $id) { id } } } }`,
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
  assert.deepEqual(
    await f.success(`mutation($id: ID!) { abort(input: { conversationId: $id }) }`, {
      id: f.conversationId,
    }),
    { abort: true },
  );
  assert.equal(cancelled, true);
  const history = await f.root.entries({}, 50, undefined, execution);
  const user = history.items.find((entry) => entry.kind === "app.user");
  assert.deepEqual(user?.data, { "arbitrary.key": [null, 1] });
  assert.deepEqual(user?.model?.[0]?.content, content);
});

for (const operation of ["abort", "reset", "configure"] as const) {
  void test(`${operation} acknowledges upstream return and rejects upstream failure`, async (t) => {
    const f = await fixture(t);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    t.mock.method(f.instance, "conversation", async () => f.root);
    const upstream = t.mock.method(f.root, operation, async () => {
      entered.resolve();
      await release.promise;
    });
    const change = operation === "configure" ? ", change: {}" : "";
    const mutation = `mutation($id: ID!) { ${operation}(input: { conversationId: $id${change} }) }`;
    let acknowledged = false;
    const pending = f.run(mutation, { id: f.conversationId }).then((result) => {
      acknowledged = true;
      return result;
    });
    try {
      await entered.promise;
      assert.equal(acknowledged, false);
    } finally {
      release.resolve();
    }
    const success = await pending;
    assert.equal(success.errors, undefined);
    assert.equal(success.data?.[operation], true);
    upstream.mock.mockImplementation(async () => {
      throw new Error("private upstream failure");
    });
    const failure = await f.run(mutation, { id: f.conversationId });
    assert.equal(failure.errors?.length, 1);
    assert.equal(failure.errors?.[0]?.extensions.code, "INTERNAL_SERVER_ERROR");
    assert.deepEqual(failure.errors?.[0]?.path, [operation]);
    assert.equal(failure.data?.[operation], null);
    assert.equal(upstream.mock.callCount(), 2);
  });
}

void test("resume requires an authorized Harness global ID and reports synchronous failure", async (t) => {
  const f = await fixture(t, "tenant / 雪");
  const mutation = `mutation($id: ID!) { resume(input: { harnessId: $id }) }`;
  for (const id of ["tenant / 雪", f.conversationId]) {
    const result = await f.run(mutation, { id });
    assert.equal(result.errors?.[0]?.extensions.code, "BAD_REQUEST");
    assert.equal(result.data?.resume, null);
  }
  const missing = await f.run(
    mutation,
    { id: f.harnessId },
    f.request({ session: async () => undefined }),
  );
  assert.equal(missing.errors?.[0]?.extensions.code, "NOT_FOUND");
  assert.equal(missing.data?.resume, null);
  assert.equal((await f.instance.inspect(execution)).scheduling, "paused");
  const session = t.mock.fn(async (externalId: string) => {
    assert.equal(externalId, "tenant / 雪");
    return f.instance;
  });
  t.mock.method(f.instance, "resume", () => {
    throw new SessionFailed(new Error("private upstream failure"));
  });
  const failure = await f.run(mutation, { id: f.harnessId }, f.request({ session }));
  assert.equal(session.mock.callCount(), 1);
  assert.equal(failure.errors?.length, 1);
  assert.equal(failure.errors?.[0]?.extensions.code, "SESSION_FAILED");
  assert.deepEqual(failure.errors?.[0]?.path, ["resume"]);
  assert.equal(failure.data?.resume, null);
});

void test("resume, reset and compaction preserve upstream admission semantics", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(
    await f.success(`mutation($id: ID!) { resume(input: { harnessId: $id }) }`, {
      id: f.harnessId,
    }),
    { resume: true },
  );
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
  assert.deepEqual(
    await f.success(`mutation($id: ID!) { reset(input: { conversationId: $id, handoff: "" }) }`, {
      id: f.conversationId,
    }),
    { reset: true },
  );
  const current = await f.root.context(execution);
  assert.equal(current.head?.kind, "pi.reset");
  const value = await f.success<{
    harness: { conversation: { context: { head: { durableId: number }; messages: unknown[] } } };
  }>(
    `{ harness(externalId: "test") { conversation(id: 1) { context { head { durableId } messages { ${messageIdentity} } } } } }`,
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
    `reset(input: { conversationId: $id, handoff: null })`,
    `compact(input: { conversationId: $id, instructions: null }) { taskId }`,
  ]) {
    const result = await f.run(`mutation($id: ID!) { ${body} }`, { id: f.conversationId });
    assert.equal(result.errors?.[0]?.extensions.code, "BAD_REQUEST");
  }
  const nullAt = await f.run(
    `{ harness(externalId: "test") { conversation(id: 1) { context(at: null) { messages { __typename } } } } }`,
  );
  assert.equal(nullAt.errors?.[0]?.extensions.code, "BAD_REQUEST");
  for (const id of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"]) {
    const result = await f.run(
      `query($id: ConversationId!) { harness(externalId: "test") { conversation(id: $id) { id } } }`,
      { id },
    );
    assert.equal(result.errors?.[0]?.extensions.code, "BAD_REQUEST");
  }
  assert.deepEqual(
    await f.success(
      `{ harness(externalId: "test") { conversation(id: 9007199254740991) { id } } }`,
    ),
    { harness: { conversation: null } },
  );
  const invalidLiteral = await f.run(
    `{ harness(externalId: "test") { conversation(id: -1) { id } } }`,
  );
  assert.equal(invalidLiteral.errors?.[0]?.extensions.code, "BAD_REQUEST");
  const wrongKind = await f.run(
    `mutation($id: ID!) { configure(input: { conversationId: $id, change: {} }) }`,
    { id: f.harnessId },
  );
  assert.equal(wrongKind.errors?.[0]?.extensions.code, "BAD_REQUEST");
  for (const id of [
    "!",
    "AB",
    Buffer.from("not json").toString("base64url"),
    Buffer.from(JSON.stringify([1, "Harness", "test", 1])).toString("base64url"),
  ]) {
    const result = await f.run(`query($id: ID!) { node(id: $id) { id } }`, { id });
    assert.equal(result.errors?.[0]?.extensions.code, "BAD_REQUEST");
  }
  assert.equal((await f.instance.inspect(execution)).scheduling, "paused");
});

void test("healthy Harness failures retain the default typed error mapping", async (t) => {
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
    const result = await f.run(`{ harness(externalId: "test") { inspect { scheduling } } }`);
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
      `mutation($id: ID!) { configure(input: { conversationId: $id, change: {} }) }`,
      { id: f.conversationId },
    );
    assert.equal(result.errors?.[0]?.extensions.code, code);
    assert.equal(result.data?.configure, null);
    t.mock.restoreAll();
  }
  const missing = await f.run(
    `mutation($id: ID!) { abort(input: { conversationId: $id }) }`,
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
  const inspect = t.mock.method(f.instance, "inspect", async (): Promise<HarnessInspection> => ({
    scheduling: "paused",
    submissions: [],
    tasks: [{ record, state: { kind: "blocked", reason: "missing_task", error } }],
  }));
  const query = `{ harness(externalId: "test") { inspect { tasks { state { kind reason error } } } } }`;
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
  error = undefined;
  assert.deepEqual(await f.success(query), {
    harness: {
      inspect: { tasks: [{ state: { kind: "blocked", reason: "missing_task", error: null } }] },
    },
  });
  assert("rawJSON" in JSON && typeof JSON.rawJSON === "function");
  error = JSON.rawJSON("1e400");
  assert.equal((await f.run(query)).errors?.[0]?.extensions.code, "INTERNAL_SERVER_ERROR");
  error = {
    toJSON() {
      throw new Error("private");
    },
  };
  const result = await f.run(query);
  assert.equal(result.errors?.[0]?.extensions.code, "INTERNAL_SERVER_ERROR");
  inspect.mock.restore();
  assert.deepEqual(await f.success(query), {
    harness: { inspect: { tasks: [{ state: { kind: "ready", reason: null, error: null } }] } },
  });
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
    a: { id: string; harness: { externalId: string } };
    b: { id: string; harness: { externalId: string } };
  }>(
    `query($a: ID!, $b: ID!) { a: node(id: $a) { id ... on ConversationRecord { harness { externalId } } } b: node(id: $b) { id ... on ConversationRecord { harness { externalId } } } }`,
    { a: a.conversationId, b: b.conversationId },
    both,
  );
  assert.equal(result.a.harness.externalId, "a");
  assert.equal(result.b.harness.externalId, "b");
  assert.deepEqual(
    await a.success(`query($id: ID!) { node(id: $id) { id } }`, { id: b.conversationId }),
    { node: null },
  );
  const denied = await a.run(
    `mutation($id: ID!) { configure(input: { conversationId: $id, change: { cwd: "/forbidden" } }) }`,
    { id: b.conversationId },
  );
  assert.equal(denied.errors?.[0]?.extensions.code, "NOT_FOUND");
  assert.equal((await b.root.agent(execution)).cwd, undefined);
});

void test("a later mutation failure does not roll back an earlier mutation", async (t) => {
  const f = await fixture(t);
  const result = await f.run(
    `mutation($id: ID!) {
    first: configure(input: { conversationId: $id, change: { cwd: "/committed" } })
    second: reset(input: { conversationId: $id, handoff: null })
  }`,
    { id: f.conversationId },
  );
  assert.equal(result.errors?.length, 1);
  assert.equal(result.errors?.[0]?.extensions.code, "BAD_REQUEST");
  assert.deepEqual(result.errors?.[0]?.path, ["second"]);
  assert.deepEqual(JSON.parse(JSON.stringify(result.data)), {
    first: true,
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
  const query = `{ a: harness(externalId: "test") { id } b: harness(externalId: "test") { id } }`;
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
    `{ harness(externalId: "test") { conversation(id: 1) { entries(limit: 1) { nodes { id durableId model { ...MessageFields } } } } } } ${fragments}`,
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
    `query($at: EntryId!) { harness(externalId: "test") { conversation(id: 1) {
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
    harness(externalId: "test") { conversation(id: 1) { entries(limit: 1) { nodes { model {
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
  const mutation = `mutation($id: ID!, $draft: SubmissionDraft!) { submit(input: { conversationId: $id, submission: $draft }) { submissionId } }`;
  const data = { "file.path": "/workspace/image.png", "line\nbreak": [null, true, 3] };
  const admitted = await f.success<{ submit: { submissionId: string } }>(mutation, {
    id: f.conversationId,
    draft: { write: { requestId: "write-key", entry: { kind: "app.attachment", data } } },
  });
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

void test("model catalog exposes only typed public metadata without acquiring a Harness", async (t) => {
  const modelType = schema.getType("Model");
  assert(isObjectType(modelType));
  assert.deepEqual(modelType.getInterfaces(), []);
  const fields = modelType.getFields();
  assert.deepEqual(Object.keys(fields).sort(), [
    "contextWindow",
    "cost",
    "id",
    "input",
    "maxTokens",
    "name",
    "provider",
    "reasoning",
    "thinkingLevels",
  ]);
  assert.equal(getNamedType(fields.id!.type).name, "String");
  assert.equal(getNamedType(fields.input!.type).name, "ModelInputModality");
  assert.equal(getNamedType(fields.thinkingLevels!.type).name, "ModelThinkingLevel");
  assert.equal(getNamedType(fields.cost!.type).name, "ModelCost");
  for (const [name, expected] of [
    ["ModelCost", ["cacheRead", "cacheWrite", "input", "output", "tiers"]],
    ["ModelCostTier", ["cacheRead", "cacheWrite", "input", "inputTokensAbove", "output"]],
  ] as const) {
    const type = schema.getType(name);
    assert(isObjectType(type));
    assert.deepEqual(Object.keys(type.getFields()).sort(), expected);
  }
  const models = createModels();
  const faux = fauxProvider({
    provider: "catalog",
    models: [
      {
        id: "z",
        name: "Reasoner",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 4294967296,
        maxTokens: 100,
        cost: { input: 1.25, output: 2, cacheRead: 3, cacheWrite: 4 },
      },
      { id: "a", name: "Plain", reasoning: false, input: ["text"] },
      { id: "empty-tiers", name: "Empty tiers", reasoning: true, input: ["text"] },
    ],
  });
  const reasoner = faux.models[0];
  reasoner.headers = { Authorization: "Bearer private", "x-api-key": "private" };
  reasoner.baseUrl = "https://private.invalid/api";
  reasoner.samplingParams = { private: "secret" };
  reasoner.thinkingLevelMap = { minimal: null, xhigh: "extended", max: null };
  reasoner.cost.tiers = [
    { inputTokensAbove: 500, input: 5, output: 6.5, cacheRead: 7, cacheWrite: 8 },
  ];
  faux.models[2]!.cost.tiers = [];
  models.setProvider(faux.provider);
  const refresh = t.mock.method(models, "refresh");
  const available = t.mock.method(models, "getAvailable");
  const source = t.mock.fn(() => models);
  const ctx = catalogContext(source);
  const result = await graphql({
    schema,
    contextValue: ctx,
    source: `{ models {
    id provider name input reasoning contextWindow maxTokens thinkingLevels
    cost { input output cacheRead cacheWrite tiers { inputTokensAbove input output cacheRead cacheWrite } }
  } }`,
  });
  assert.equal(result.errors, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(result.data)), {
    models: [
      {
        id: "z",
        provider: "catalog",
        name: "Reasoner",
        input: ["text", "image"],
        reasoning: true,
        contextWindow: 4294967296,
        maxTokens: 100,
        thinkingLevels: ["off", "low", "medium", "high", "xhigh"],
        cost: {
          input: 1.25,
          output: 2,
          cacheRead: 3,
          cacheWrite: 4,
          tiers: [{ inputTokensAbove: 500, input: 5, output: 6.5, cacheRead: 7, cacheWrite: 8 }],
        },
      },
      {
        id: "a",
        provider: "catalog",
        name: "Plain",
        input: ["text"],
        reasoning: false,
        contextWindow: 128000,
        maxTokens: 16384,
        thinkingLevels: ["off"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tiers: null },
      },
      {
        id: "empty-tiers",
        provider: "catalog",
        name: "Empty tiers",
        input: ["text"],
        reasoning: true,
        contextWindow: 128000,
        maxTokens: 16384,
        thinkingLevels: ["off", "minimal", "low", "medium", "high"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tiers: [] },
      },
    ],
  });
  assert.equal(source.mock.callCount(), 1);
  assert.equal(available.mock.callCount(), 1);
  assert.deepEqual(available.mock.calls[0]?.arguments, [undefined, undefined]);
  assert.equal(refresh.mock.callCount(), 0);
  assert.equal(faux.state.callCount, 0);
  for (const field of [
    "headers",
    "baseUrl",
    "api",
    "compat",
    "samplingParams",
    "thinkingLevelMap",
    "inputLimits",
  ]) {
    const denied = await graphql({ schema, contextValue: ctx, source: `{ models { ${field} } }` });
    assert(denied.errors?.length);
    assert.equal(denied.data, undefined);
  }
  const invalid = await graphql({
    schema,
    contextValue: ctx,
    source: '{ models(provider: "catalog") { id } }',
  });
  assert(invalid.errors?.length);
  assert.equal(invalid.data, undefined);
  assert.equal(source.mock.callCount(), 1);
});

void test("model catalog observes auth and filtering, and excludes non-chat models", async (t) => {
  const models = createModels();
  const faux = fauxProvider({ models: [{ id: "allowed" }, { id: "filtered" }] });
  let authenticated = false;
  const allModels = t.mock.fn((): readonly (AI.Model<AI.Api> | AI.ImageModel<AI.ImageApi>)[] => [
    ...faux.models,
    {
      type: "image",
      id: "image-model",
      provider: "faux",
      api: "openrouter-images",
      name: "Image model",
      baseUrl: "https://unused.invalid",
      input: ["text"],
      output: ["image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  ]);
  models.setProvider({
    ...faux.provider,
    auth: {
      apiKey: {
        name: "Test auth",
        async check() {
          return authenticated ? { type: "api_key" } : undefined;
        },
        async resolve() {
          assert.fail("availability must not request generation credentials");
        },
      },
    },
    filterModels: (entries) => entries.filter((model) => model.id === "allowed"),
    getAllModels: allModels,
  });
  const contextValue = catalogContext(() => models);
  const source = "{ models { id provider } }";
  for (const allowed of [false, true, false]) {
    authenticated = allowed;
    const result = await graphql({ schema, contextValue, source });
    assert.equal(result.errors, undefined);
    assert.deepEqual(JSON.parse(JSON.stringify(result.data)), {
      models: allowed ? [{ id: "allowed", provider: "faux" }] : [],
    });
  }
  assert.equal(allModels.mock.callCount(), 0);
  assert.equal(faux.state.callCount, 0);
});

void test("model catalog resolves its source independently for aliases and later requests", async (t) => {
  const first = createModels();
  const second = createModels();
  first.setProvider(fauxProvider({ provider: "first", models: [{ id: "same-id" }] }).provider);
  second.setProvider(fauxProvider({ provider: "second", models: [{ id: "same-id" }] }).provider);
  const firstReads = t.mock.method(first, "getAvailable");
  const secondReads = t.mock.method(second, "getAvailable");
  let current = first;
  const source = t.mock.fn(() => {
    const value = current;
    current = second;
    return value;
  });
  const contextValue = catalogContext(source);
  const result = await graphql({
    schema,
    contextValue,
    source: "{ first: models { id provider } second: models { id provider } }",
  });
  assert.equal(result.errors, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(result.data)), {
    first: [{ id: "same-id", provider: "first" }],
    second: [{ id: "same-id", provider: "second" }],
  });
  assert.equal(source.mock.callCount(), 2);
  assert.equal(firstReads.mock.callCount(), 1);
  assert.equal(secondReads.mock.callCount(), 1);
  current = createModels();
  const empty = await graphql({ schema, contextValue, source: "{ models { id } }" });
  assert.equal(empty.errors, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(empty.data)), { models: [] });
  assert.equal(source.mock.callCount(), 3);
});

void test("model catalog failures use the existing error policy and never become empty lists", async () => {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider({
    ...faux.provider,
    getModels() {
      throw new Error("private provider data");
    },
  });
  let failSource = true;
  const contextValue = catalogContext(() => {
    if (failSource) throw new Error("private source data");
    return models;
  });
  for (const sourceFailure of [true, false]) {
    failSource = sourceFailure;
    const result = await graphql({ schema, contextValue, source: "{ models { id } }" });
    assert.equal(result.data, null);
    assert.equal(result.errors?.length, 1);
    assert.equal(result.errors[0]?.extensions.code, "INTERNAL_SERVER_ERROR");
    assert.deepEqual(result.errors[0]?.path, ["models"]);
  }
});

void test("model catalog forwards request cancellation to the upstream availability check", async (t) => {
  const models = createModels();
  const faux = fauxProvider();
  const started = Promise.withResolvers<AbortSignal>();
  const controller = new AbortController();
  t.after(() => controller.abort());
  const context = withAbortSignal(controller.signal, execution);
  models.setProvider({
    ...faux.provider,
    auth: {
      apiKey: {
        name: "Pending auth",
        async check({ signal }) {
          started.resolve(signal);
          await awaitWithContext(new Promise<never>(() => {}), withAbortSignal(signal, execution));
          assert.fail("availability check must be cancelled");
        },
        async resolve() {
          assert.fail("availability uses auth checks only");
        },
      },
    },
  });
  const available = t.mock.method(models, "getAvailable");
  const request = graphql({
    schema,
    contextValue: catalogContext(() => models, context),
    source: "{ models { id } }",
  });
  const signal = await started.promise;
  assert.equal(available.mock.callCount(), 1);
  assert.deepEqual(available.mock.calls[0]?.arguments, [
    undefined,
    { signal: context.abortSignal },
  ]);
  assert.equal(signal.aborted, false);
  controller.abort();
  const result = await request;
  assert.equal(signal.aborted, true);
  assert.equal(result.data, null);
  assert.equal(result.errors?.[0]?.extensions.code, "INTERNAL_SERVER_ERROR");
  assert.deepEqual(result.errors?.[0]?.path, ["models"]);
  assert.equal(faux.state.callCount, 0);
});

void test("missing records and vanished handles remain distinct from failed reads", async (t) => {
  const f = await fixture(t);
  for (const kind of ["EntryRecord", "TaskRecord", "SubmissionRecord"]) {
    const id = Buffer.from(JSON.stringify([1, kind, "test", 999])).toString("base64url");
    assert.deepEqual(await f.success("query($id: ID!) { node(id: $id) { id } }", { id }), {
      node: null,
    });
  }
  assert.deepEqual(
    await f.success(
      '{ harness(externalId:"test") { conversation(id:1) { submissionByRequest(requestId:"absent") { id } } } }',
    ),
    { harness: { conversation: { submissionByRequest: null } } },
  );
  let calls = 0;
  const vanished = await f.run(
    '{ harness(externalId:"test") { inspect { scheduling } } }',
    {},
    f.request({ session: async () => (calls++ === 0 ? f.instance : undefined) }),
  );
  assert.equal(vanished.errors?.[0]?.extensions.code, "NOT_FOUND");
  t.mock.method(f.instance, "conversation", async () => undefined);
  const missing = await f.run(
    '{ harness(externalId:"test") { conversation(id:1) { agent { thinkingLevel } } } }',
  );
  assert.equal(missing.errors?.[0]?.extensions.code, "NOT_FOUND");
});

void test("catalog, scan, receipt and abort-submission failures retain typed GraphQL errors", async (t) => {
  const f = await fixture(t);
  const catalog = await f.run(
    "{ harnesses { id } }",
    {},
    f.request({
      sessions: async () => {
        throw new Error("private");
      },
    }),
  );
  assert.equal(catalog.errors?.[0]?.extensions.code, "INTERNAL_SERVER_ERROR");
  for (const field of ["scanConversations", "scanTasks"]) {
    const response = await f.run(
      `{ harness(externalId:"test") { ${field}(limit:0) { nodes { id } } } }`,
    );
    assert.equal(response.errors?.[0]?.extensions.code, "BAD_REQUEST");
  }
  t.mock.method(f.storage, "submissionByRequest", async () => {
    throw new StorageRequestError("private");
  });
  t.mock.method(f.instance, "submission", async () => {
    throw new StorageRequestError("private");
  });
  for (const field of ['submissionByRequest(requestId:"request")', "status(id:999)"]) {
    const response = await f.run(
      `{ harness(externalId:"test") { conversation(id:1) { ${field} { id } } } }`,
    );
    assert.equal(response.errors?.[0]?.extensions.code, "BAD_REQUEST");
  }
  t.mock.method(f.instance, "abortSubmission", async () => {
    throw new Error("private");
  });
  const aborted = await f.run(
    "mutation($id:ID!) { abortSubmission(input:{conversationId:$id,id:999}) { result } }",
    { id: f.conversationId },
  );
  assert.equal(aborted.errors?.[0]?.extensions.code, "INTERNAL_SERVER_ERROR");
});

void test("projection rejects malformed upstream messages and non-object tool arguments", async (t) => {
  const f = await fixture(t);
  const entry = await f.instance.commit(
    (tx) => tx.appendEntry(f.root.id, { kind: "app.message" }),
    execution,
  );
  const malformed: readonly unknown[] = [
    [{ role: "unknown" }],
    [{ role: "user", content: [{ type: "unknown" }], timestamp: 0 }],
    [{ ...fauxAssistantMessage(""), content: [{ type: "unknown" }] }],
    [
      {
        ...fauxAssistantMessage(""),
        content: [{ type: "toolCall", id: "call", name: "tool", arguments: [] }],
      },
    ],
  ];
  for (const model of malformed) {
    // One cast at the malformed backend-record boundary; production types stay strict.
    const record = { ...entry, model } as EntryRecord;
    const scan = t.mock.method(f.storage, "scanEntries", async () => ({ items: [record] }));
    const response = await f.run(
      '{ harness(externalId:"test") { conversation(id:1) { entries(limit:1) { nodes { model { __typename } } } } } }',
    );
    assert.equal(response.errors?.[0]?.extensions.code, "INTERNAL_SERVER_ERROR");
    scan.mock.restore();
  }
});

void test("generated resolver bindings fail closed on invalid internal one-of variants", async (t) => {
  const f = await fixture(t);
  const field = schema.getMutationType()!.getFields().submit!;
  const resolve = field.resolve!;
  t.after(() => {
    field.resolve = resolve;
  });
  const mint = t.mock.method(f.storage, "mintId");
  for (const submission of [
    {},
    { input: { content: {} } },
    { input: { content: { blocks: [{}] } } },
    { write: { entry: { kind: "app.invalid", model: [{}] } } },
    { write: { entry: { kind: "app.invalid", edits: [{}] } } },
    {
      write: {
        entry: {
          kind: "app.invalid",
          model: [{ assistant: { ...fauxAssistantMessage(""), content: [{}] } }],
        },
      },
    },
  ]) {
    // A schema consumer can wrap a field resolver after GraphQL coercion. Reject
    // invalid variants at that binding boundary too, without admitting a write.
    field.resolve = (source, _args, context, info) =>
      resolve(source, { input: { conversationId: f.conversationId, submission } }, context, info);
    const response = await f.run(
      'mutation($id:ID!) { submit(input:{conversationId:$id,submission:{input:{content:{text:""}}}}) { submissionId } }',
      { id: f.conversationId },
    );
    assert.equal(response.errors?.[0]?.extensions.code, "INTERNAL_SERVER_ERROR");
  }
  assert.equal(mint.mock.callCount(), 0);
});

void test("projection preserves omitted metadata and omit edits", async (t) => {
  const f = await fixture(t);
  const first = await f.instance.commit(
    (tx) => tx.appendEntry(f.root.id, { kind: "app.first" }),
    execution,
  );
  await f.instance.commit(
    (tx) =>
      tx.appendEntry(f.root.id, {
        kind: "app.optional",
        edits: [{ action: "omit", target: first.id }],
        model: [
          {
            ...fauxAssistantMessage(""),
            deferred: {
              id: "pending",
              provider: "faux",
              modelId: "test",
              api: "openai-completions",
            },
            diagnostics: [{ type: "retry", timestamp: 0 }],
          },
          {
            role: "toolResult",
            toolCallId: "call",
            toolName: "tool",
            content: [],
            isError: false,
            timestamp: 0,
          },
        ],
      }),
    execution,
  );
  const value = await f.success(
    '{ harness(externalId:"test") { conversation(id:1) { entries(limit:1) { nodes { edits { action target messages { __typename } } model { ... on AssistantMessage { deferred { data } diagnostics { details } } ... on ToolResultMessage { details } } } } } } }',
  );
  assert.deepEqual(value, {
    harness: {
      conversation: {
        entries: {
          nodes: [
            {
              edits: [{ action: "omit", target: first.id, messages: null }],
              model: [
                { deferred: { data: null }, diagnostics: [{ details: null }] },
                { details: null },
              ],
            },
          ],
        },
      },
    },
  });
});

void test("passive root lookup uses the reserved ID and creation applies initial agent changes once", async (t) => {
  const f = await fixture(t);
  const storage = new MemoryStorage();
  const instance = await Harness.open(
    storage,
    { models: createModels(), registry: createRegistry() },
    execution,
  );
  t.after(() => instance.close(execution));
  const ctx = f.request({ session: async () => instance });
  const read =
    '{ harness(externalId:"test") { root { id durableId agent { cwd } } inspect { scheduling } } }';
  const empty = { harness: { root: null, inspect: { scheduling: "paused" } } };
  assert.deepEqual(await f.success(read, {}, ctx), empty);
  const writes = t.mock.method(storage, "commit");
  const extra = await f.success<{ createConversation: { conversation: Identity } }>(
    "mutation($id:ID!) { createConversation(input:{harnessId:$id,options:{ownership:{kind:ownerless}}}) { conversation { id durableId } } }",
    { id: f.harnessId },
    ctx,
  );
  assert.notEqual(extra.createConversation.conversation.durableId, 1);
  assert.equal(writes.mock.callCount(), 1);
  assert.deepEqual(await f.success(read, {}, ctx), empty);
  assert.equal(writes.mock.callCount(), 1);
  const mutate =
    "mutation($id:ID!,$options:RootOptionsInput) { root(input:{harnessId:$id,options:$options}) { conversation { id durableId agent { cwd } } } }";
  const created = await f.success<{
    root: { conversation: Identity & { agent: { cwd: string } } };
  }>(
    mutate,
    { id: f.harnessId, options: { agent: { cwd: "/initial", model: null, thinkingLevel: null } } },
    ctx,
  );
  assert.equal(created.root.conversation.durableId, 1);
  assert.equal(created.root.conversation.agent.cwd, "/initial");
  assert.equal(writes.mock.callCount(), 2);
  for (const options of [undefined, {}, { agent: { cwd: "/ignored" } }]) {
    assert.deepEqual(
      await f.success(
        mutate,
        { id: f.harnessId, ...(options === undefined ? {} : { options }) },
        ctx,
      ),
      created,
    );
  }
  assert.equal(writes.mock.callCount(), 2);
  assert.deepEqual(await f.success(read, {}, ctx), {
    harness: { root: created.root.conversation, inspect: { scheduling: "paused" } },
  });
  assert.deepEqual(await instance.inspect(execution), {
    scheduling: "paused",
    tasks: [],
    submissions: [],
  });
});

void test("root creation without options is atomic and failed initialization leaves it absent", async (t) => {
  const f = await fixture(t);
  for (const fail of [false, true]) {
    const storage = new MemoryStorage();
    const instance = await Harness.open(
      storage,
      {
        models: createModels(),
        registry: createRegistry(),
        conversationCreated: () => {
          if (fail) throw new Error("private initialization error");
        },
      },
      execution,
    );
    t.after(() => instance.close(execution));
    const ctx = f.request({ session: async () => instance });
    const writes = t.mock.method(storage, "commit");
    const response = await f.run(
      "mutation($id:ID!) { root(input:{harnessId:$id}) { conversation { durableId } } }",
      { id: f.harnessId },
      ctx,
    );
    if (fail) {
      assert.equal(response.errors?.[0]?.extensions.code, "INTERNAL_SERVER_ERROR");
      assert.equal(response.data?.root, null);
    } else {
      assert.equal(response.errors, undefined);
      assert.equal((response.data?.root as { conversation: Identity }).conversation.durableId, 1);
    }
    const record = await instance.commit((tx) => tx.conversation(f.root.id), execution);
    assert.equal(record !== undefined, !fail);
    assert.equal(writes.mock.callCount(), fail ? 0 : 1);
    assert.equal((await instance.inspect(execution)).scheduling, "paused");
  }
});

void test("conversation creation keeps owner scope, agent settings, and distinct identities", async (t) => {
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
  const create =
    "mutation($input:CreateConversationInput!) { createConversation(input:$input) { conversation { id durableId parent { at } owner { taskId conversationId } agent { cwd model { provider modelId } thinkingLevel } } } }";
  const ids = new Set<string>();
  for (const ownership of [{ kind: "ownerless" }, { kind: "task", taskId }]) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const before = t.mock.method(f.storage, "commit");
      const response = await f.success<{
        createConversation: {
          conversation: Identity & {
            parent: null;
            owner: { taskId: number; conversationId: number } | null;
            agent: {
              cwd: string;
              model: { provider: string; modelId: string };
              thinkingLevel: string;
            };
          };
        };
      }>(create, {
        input: {
          harnessId: f.harnessId,
          options: {
            ownership,
            agent: {
              cwd: "/new",
              model: { provider: "faux", modelId: "test" },
              thinkingLevel: "high",
            },
          },
        },
      });
      const conversation = response.createConversation.conversation;
      assert.equal(ids.has(conversation.id), false);
      ids.add(conversation.id);
      assert.equal(conversation.parent, null);
      assert.deepEqual(
        conversation.owner,
        ownership.kind === "task" ? { taskId, conversationId: f.root.id } : null,
      );
      assert.deepEqual(conversation.agent, {
        cwd: "/new",
        model: { provider: "faux", modelId: "test" },
        thinkingLevel: "high",
      });
      assert.equal(before.mock.callCount(), 1);
      before.mock.restore();
      const read = await f.success<{ node: Identity }>(
        "query($id:ID!) { node(id:$id) { id ... on ConversationRecord { durableId } } }",
        { id: conversation.id },
      );
      assert.equal(read.node.id, conversation.id);
      assert.equal(read.node.durableId, conversation.durableId);
    }
  }
  assert.equal((await f.instance.inspect(execution)).scheduling, "paused");
  assert.equal(f.faux.state.callCount, 0);
});

void test("lifecycle mutations validate optional inputs and ownership before acquiring a Harness", async (t) => {
  const f = await fixture(t);
  const session = t.mock.fn(f.request().session);
  const ctx = f.request({ session });
  for (const options of [null, { agent: null }]) {
    const response = await f.run(
      "mutation($id:ID!,$options:RootOptionsInput) { root(input:{harnessId:$id,options:$options}) { conversation { id } } }",
      { id: f.harnessId, options },
      ctx,
    );
    assert.equal(response.errors?.[0]?.extensions.code, "BAD_REQUEST");
  }
  for (const options of [
    { ownership: { kind: "ownerless", taskId: 1 } },
    { ownership: { kind: "ownerless", taskId: null } },
    { ownership: { kind: "task" } },
    { ownership: { kind: "task", taskId: null } },
    { ownership: { kind: "ownerless" }, agent: null },
  ]) {
    const response = await f.run(
      "mutation($input:CreateConversationInput!) { createConversation(input:$input) { conversation { id } } }",
      { input: { harnessId: f.harnessId, options } },
      ctx,
    );
    assert.equal(response.errors?.[0]?.extensions.code, "BAD_REQUEST");
  }
  assert.equal(session.mock.callCount(), 0);
});

void test("lifecycle commands reject wrong identities and missing Harnesses or task owners", async (t) => {
  const f = await fixture(t);
  const fields = [
    "root(input:{harnessId:$id})",
    "createConversation(input:{harnessId:$id,options:{ownership:{kind:ownerless}}})",
  ];
  for (const field of fields) {
    const query = `mutation($id:ID!) { ${field} { conversation { id } } }`;
    const wrong = await f.run(query, { id: f.conversationId });
    assert.equal(wrong.errors?.[0]?.extensions.code, "BAD_REQUEST");
    const missing = await f.run(
      query,
      { id: f.harnessId },
      f.request({ session: async () => undefined }),
    );
    assert.equal(missing.errors?.[0]?.extensions.code, "NOT_FOUND");
  }
  const creates = t.mock.method(f.instance, "createConversation");
  const response = await f.run(
    "mutation($id:ID!) { createConversation(input:{harnessId:$id,options:{ownership:{kind:task,taskId:999}}}) { conversation { id } } }",
    { id: f.harnessId },
  );
  assert.equal(response.errors?.[0]?.extensions.code, "NOT_FOUND");
  assert.equal(creates.mock.callCount(), 0);
  assert.deepEqual(
    await f.success(
      "{ harnesses { root { id } } }",
      {},
      f.request({ session: async () => undefined }),
    ),
    { harnesses: [{ root: null }] },
  );
});

void test("root reads and creation-result reads propagate failures without inventing records", async (t) => {
  const f = await fixture(t);
  const read = t.mock.method(f.storage, "conversation", async () => {
    throw new StorageRequestError("private read failure");
  });
  const response = await f.run('{ harness(externalId:"test") { root { id } } }');
  assert.equal(response.errors?.[0]?.extensions.code, "BAD_REQUEST");
  assert.deepEqual(response.errors?.[0]?.path, ["harness", "root"]);
  read.mock.restore();
  t.mock.method(f.instance, "commit", async () => undefined);
  for (const field of [
    "root(input:{harnessId:$id})",
    "createConversation(input:{harnessId:$id,options:{ownership:{kind:ownerless}}})",
  ]) {
    const failed = await f.run(`mutation($id:ID!) { ${field} { conversation { id } } }`, {
      id: f.harnessId,
    });
    assert.equal(failed.errors?.[0]?.extensions.code, "INTERNAL_SERVER_ERROR");
  }
});

void test("open requests provisioning and returns the same Harness identity without changing it", async (t) => {
  const f = await fixture(t);
  const session = t.mock.fn(f.request().session);
  const ctx = f.request({ session });
  const before = await f.instance.inspect(execution);
  const write = t.mock.method(f.storage, "commit");
  for (const source of [
    'mutation { open(input:{externalId:"test"}) { harness { id externalId } } }',
    "mutation($id:String!) { open(input:{externalId:$id}) { harness { id externalId } } }",
  ]) {
    assert.deepEqual(await f.success(source, { id: "test" }, ctx), {
      open: { harness: { id: f.harnessId, externalId: "test" } },
    });
  }
  assert.deepEqual(
    session.mock.calls.map((call) => call.arguments),
    [
      ["test", true],
      ["test", true],
    ],
  );
  assert.deepEqual(await f.instance.inspect(execution), before);
  assert.equal(write.mock.callCount(), 0);
});

void test("open distinguishes invalid keys, unavailable storage, and validation failures", async (t) => {
  const f = await fixture(t);
  const source = "mutation($id:String!) { open(input:{externalId:$id}) { harness { id } } }";
  const session = t.mock.fn(f.request().session);
  for (const [isValidExternalId, code] of [
    [() => false, "BAD_REQUEST"],
    [
      () => {
        throw new StorageRequestError("private validator failure");
      },
      "INTERNAL_SERVER_ERROR",
    ],
  ] as const) {
    const result = await f.run(source, { id: "test" }, f.request({ session, isValidExternalId }));
    assert.equal(result.data?.open, null);
    assert.equal(result.errors?.[0]?.extensions.code, code);
  }
  assert.equal(session.mock.callCount(), 0);
  const missing = await f.run(source, { id: "absent" });
  assert.equal(missing.errors?.[0]?.extensions.code, "NOT_FOUND");
  assert.deepEqual(missing.errors?.[0]?.path, ["open"]);
});

async function documentFixture(t: TestContext) {
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
  const common = { version: 1, initial: () => ({ initial: true }), checkpointWhen: () => false };
  const family = {
    version: 1,
    family: true as const,
    initial: (seed: JsonValue) => ({ seed }),
    checkpointWhen: () => false,
  };
  const session = defineDoc({ ...common, scope: "session", kind: "z.session" });
  const sessionFamily = defineDocFamily({ ...family, scope: "session", kind: "a.session" });
  const conversation = defineDoc({
    ...common,
    scope: "conversation",
    kind: "z.conversation",
    history: "rewindable",
    fork: "asOf",
  });
  const conversationFamily = defineDocFamily({
    ...family,
    scope: "conversation",
    kind: "a.conversation",
    history: "latest",
    fork: "initial",
  });
  const task = defineDoc({ ...common, scope: "task", kind: "z.task" });
  const taskFamily = defineDocFamily({ ...family, scope: "task", kind: "a.task" });
  const tokens = [session, sessionFamily, conversation, conversationFamily, task, taskFamily];
  const policy = {
    validate: (_content: Readonly<Record<string, JsonValue>>) => true,
    initialize: true,
    seed: { from: "server" },
  };
  const documents: ResolverContext["documents"] = {
    definitions: async (_id, scope) =>
      tokens.filter((token) => token.definition.scope === scope.kind),
    resolve: async (_id, address) => {
      const token = tokens.find(
        (token) =>
          token.definition.kind === address.kind && token.definition.scope === address.scope.kind,
      );
      return token && { token, write: policy };
    },
  };
  const ctx = f.request({ documents });
  const scopes: DocumentAddress["scope"][] = [
    { kind: "session" },
    { kind: "conversation", conversationId: f.root.id },
    { kind: "task", taskId },
  ];
  const addresses = scopes.flatMap((scope) =>
    tokens
      .filter((token) => token.definition.scope === scope.kind)
      .map((token): DocumentAddress => ({
        kind: token.definition.kind,
        scope,
        ...("family" in token.definition ? { key: "member" } : {}),
      })),
  );
  const replace = (
    address: unknown,
    content: unknown = {},
    context = ctx,
    harnessId = f.harnessId,
  ) =>
    f.run(
      "mutation($input:ReplaceDocumentInput!) { replaceDocument(input:$input) }",
      { input: { harnessId, address, content } },
      context,
    );
  const read = async (address: DocumentAddress, context = ctx) =>
    (
      await f.success<{ harness: { snapshot: unknown } }>(
        'query($address:DocumentAddressInput!) { harness(externalId:"test") { snapshot(address:$address) } }',
        { address },
        context,
      )
    ).harness.snapshot;
  return {
    ...f,
    tokens,
    scopes,
    addresses,
    session,
    sessionFamily,
    conversation,
    conversationFamily,
    task,
    taskFamily,
    taskId,
    documents,
    ctx,
    policy,
    replace,
    read,
  };
}

void test("documents expose only definition metadata and passive snapshots across all scopes", async (t) => {
  const f = await documentFixture(t);
  const writes = t.mock.method(f.storage, "commit");
  const initial = f.tokens.map((token) => t.mock.method(token.definition, "initial"));
  for (const scope of f.scopes) {
    const response = await f.success<{ harness: { documentDefinitions: unknown } }>(
      'query($scope:DocumentScopeInput!) { harness(externalId:"test") { documentDefinitions(scope:$scope) { kind version scope family history fork } } }',
      { scope },
      f.ctx,
    );
    const definitions = f.tokens
      .filter((token) => token.definition.scope === scope.kind)
      .reverse()
      .map(({ definition }) => ({
        kind: definition.kind,
        version: 1,
        scope: scope.kind,
        family: "family" in definition ? true : null,
        history: definition.scope === "conversation" ? definition.history : null,
        fork: definition.scope === "conversation" ? definition.fork : null,
      }));
    assert.deepEqual(response.harness.documentDefinitions, definitions);
  }
  for (const address of f.addresses) assert.equal(await f.read(address), null);
  assert.equal(writes.mock.callCount(), 0);
  assert(initial.every((call) => call.mock.callCount() === 0));
  assert.equal((await f.instance.inspect(execution)).scheduling, "paused");
  for (const address of f.addresses) {
    for (const content of [
      { keep: true, remove: "old" },
      { keep: null, nested: [1, false, {}] },
      {},
      JSON.parse('{"__proto__":{"test":true},"constructor":null}') as Record<string, JsonValue>,
    ]) {
      const before = writes.mock.callCount();
      const response = await f.replace(address, content);
      assert.equal(response.errors, undefined);
      assert.deepEqual(response.data?.replaceDocument, content);
      assert.deepEqual(await f.read(address), content);
      assert.equal(writes.mock.callCount(), before + 1);
    }
  }
  for (const [index, call] of initial.entries()) {
    assert.equal(call.mock.callCount(), 1);
    assert.deepEqual(call.mock.calls[0]?.arguments, index % 2 ? [f.policy.seed] : []);
  }
  assert.equal((await f.instance.inspect(execution)).scheduling, "paused");
  assert.equal(f.faux.state.callCount, 0);
});

void test("document access validates scope and family keys and denies unavailable owners", async (t) => {
  const f = await documentFixture(t);
  const invalid = [
    { kind: "session", conversationId: 1 },
    { kind: "session", taskId: null },
    { kind: "conversation" },
    { kind: "conversation", conversationId: null },
    { kind: "conversation", conversationId: 1, taskId: 1 },
    { kind: "task" },
    { kind: "task", taskId: 1, conversationId: 1 },
  ];
  for (const scope of invalid) {
    for (const field of [
      "documentDefinitions(scope:$scope) { kind }",
      'snapshot(address:{kind:"z.session",scope:$scope})',
    ]) {
      const session = t.mock.fn(f.ctx.session);
      const response = await f.run(
        `query($scope:DocumentScopeInput!) { harnesses { ${field} } }`,
        { scope },
        { ...f.ctx, session },
      );
      assert.equal(response.errors?.[0]?.extensions.code, "BAD_REQUEST");
      assert.equal(session.mock.callCount(), 0);
    }
    assert.equal(
      (await f.replace({ kind: "z.session", scope })).errors?.[0]?.extensions.code,
      "BAD_REQUEST",
    );
  }
  for (const address of [
    { kind: "z.session", scope: { kind: "session" }, key: "extra" },
    { kind: "z.session", scope: { kind: "session" }, key: null },
    { kind: "a.session", scope: { kind: "session" } },
  ]) {
    const read = await f.run(
      'query($address:DocumentAddressInput!) { harness(externalId:"test") { snapshot(address:$address) } }',
      { address },
      f.ctx,
    );
    assert.equal(read.errors?.[0]?.extensions.code, "BAD_REQUEST");
    assert.equal((await f.replace(address)).errors?.[0]?.extensions.code, "BAD_REQUEST");
  }
  for (const scope of [
    { kind: "conversation", conversationId: 999 },
    { kind: "task", taskId: 999 },
  ]) {
    const address = { kind: `z.${scope.kind}`, scope };
    const read = await f.success(
      'query($scope:DocumentScopeInput!,$address:DocumentAddressInput!) { harness(externalId:"test") { documentDefinitions(scope:$scope) { kind } snapshot(address:$address) } }',
      { scope, address },
      f.ctx,
    );
    assert.deepEqual(read, { harness: { documentDefinitions: null, snapshot: null } });
    assert.equal((await f.replace(address)).errors?.[0]?.extensions.code, "NOT_FOUND");
  }
  const address = f.addresses[0]!;
  for (const ctx of [
    { ...f.ctx, session: async () => undefined },
    { ...f.ctx, documents: { definitions: async () => undefined, resolve: async () => undefined } },
  ]) {
    assert.deepEqual(
      await f.success(
        "query($address:DocumentAddressInput!) { harnesses { documentDefinitions(scope:{kind:session}) { kind } snapshot(address:$address) } }",
        { address },
        ctx,
      ),
      { harnesses: [{ documentDefinitions: null, snapshot: null }] },
    );
    assert.equal((await f.replace(address, {}, ctx)).errors?.[0]?.extensions.code, "NOT_FOUND");
  }
  assert.deepEqual(
    await f.success(
      '{ harness(externalId:"test") { documentDefinitions(scope:{kind:session}) { kind } } }',
    ),
    { harness: { documentDefinitions: [] } },
  );
  assert.equal(await f.read({ kind: "hidden", scope: { kind: "session" } }), null);
  assert.equal(
    (await f.replace({ kind: "hidden", scope: { kind: "session" } })).errors?.[0]?.extensions.code,
    "NOT_FOUND",
  );
  assert.equal(
    (await f.replace(address, {}, f.ctx, f.conversationId)).errors?.[0]?.extensions.code,
    "BAD_REQUEST",
  );
});

void test("document writes require permission, valid content, and explicit initialization", async (t) => {
  const f = await documentFixture(t);
  const address = f.addresses[0]!;
  const writes = t.mock.method(f.storage, "commit");
  const ctx = {
    ...f.ctx,
    documents: { ...f.documents, resolve: async () => ({ token: f.session }) },
  };
  assert.equal((await f.replace(address, {}, ctx)).errors?.[0]?.extensions.code, "BAD_REQUEST");
  f.policy.validate = () => false;
  assert.equal((await f.replace(address)).errors?.[0]?.extensions.code, "BAD_REQUEST");
  f.policy.validate = () => {
    throw new StorageRequestError("private validator error");
  };
  assert.equal((await f.replace(address)).errors?.[0]?.extensions.code, "INTERNAL_SERVER_ERROR");
  assert.equal(writes.mock.callCount(), 0);
  f.policy.validate = () => true;
  f.policy.initialize = false;
  for (const target of f.addresses) {
    assert.equal((await f.replace(target)).errors?.[0]?.extensions.code, "BAD_REQUEST");
    assert.equal(await f.read(target), null);
  }
  assert.equal(writes.mock.callCount(), 0);
  f.policy.initialize = true;
  for (const target of f.addresses)
    assert.equal((await f.replace(target, { old: true })).errors, undefined);
  f.policy.initialize = false;
  const noSeed = {
    ...f.ctx,
    documents: {
      ...f.documents,
      resolve: async (_id: string, target: DocumentAddress) => {
        const token = f.tokens.find((token) => token.definition.kind === target.kind)!;
        return { token, write: { initialize: false, validate: () => true } };
      },
    },
  };
  for (const target of f.addresses) {
    assert.equal((await f.replace(target, { replacement: null }, noSeed)).errors, undefined);
    assert.deepEqual(await f.read(target), { replacement: null });
  }
  const family = f.addresses[1]!;
  const missingSeed = {
    ...f.ctx,
    documents: {
      ...f.documents,
      resolve: async () => ({
        token: f.sessionFamily,
        write: { initialize: true, validate: () => true },
      }),
    },
  };
  assert.equal(
    (await f.replace(family, {}, missingSeed)).errors?.[0]?.extensions.code,
    "INTERNAL_SERVER_ERROR",
  );
  const agent = { kind: AgentDoc.definition.kind, scope: f.scopes[1]! };
  const runtime = {
    ...f.ctx,
    documents: {
      ...f.documents,
      resolve: async () => ({ token: AgentDoc, write: { initialize: true, validate: () => true } }),
    },
  };
  assert.notEqual(await f.read(agent, runtime), null);
  assert.equal((await f.replace(agent, {}, runtime)).errors?.[0]?.extensions.code, "BAD_REQUEST");
});

void test("document replacement guards retirement races and returns its own committed value", async (t) => {
  const f = await documentFixture(t);
  const address = f.addresses[0]!;
  assert.equal((await f.replace(address, { old: true })).errors, undefined);
  f.policy.initialize = false;
  const initial = t.mock.method(f.session.definition, "initial");
  const retired = {
    ...f.ctx,
    documents: {
      ...f.documents,
      resolve: async () => {
        await f.instance.commit((tx) => tx.retireDoc(f.session), execution);
        return { token: f.session, write: f.policy };
      },
    },
  };
  assert.equal((await f.replace(address, {}, retired)).errors?.[0]?.extensions.code, "BAD_REQUEST");
  assert.equal(initial.mock.callCount(), 0);
  assert.equal(await f.read(address), null);
  f.policy.initialize = true;
  const commit = f.instance.commit.bind(f.instance);
  let commits = 0;
  t.mock.method(
    f.instance,
    "commit",
    async <T>(
      change: Parameters<typeof f.instance.commit<T>>[0],
      context: ResolverContext["context"],
    ) => {
      const result = await commit(change, context);
      if (++commits === 2)
        await commit(async (tx) => {
          const draft = await tx.doc(f.session);
          Object.assign(draft, { later: true });
        }, execution);
      return result;
    },
  );
  const result = await f.replace(address, { own: true });
  assert.equal(result.errors, undefined);
  assert.deepEqual(result.data?.replaceDocument, { own: true });
  assert.deepEqual(await f.read(address), { own: true, later: true });
});

void test("document service failures and inconsistent definitions are internal errors, not absence", async (t) => {
  const f = await documentFixture(t);
  for (const definitions of [
    async () => {
      throw new StorageRequestError("private discovery failure");
    },
    async () => [f.conversation],
    async () => [f.session, f.session],
    ...[0, 1.5, 2147483648].map((version) => async () => [
      { definition: { ...f.session.definition, version } },
    ]),
  ]) {
    const response = await f.run(
      '{ harness(externalId:"test") { documentDefinitions(scope:{kind:session}) { kind } } }',
      {},
      { ...f.ctx, documents: { ...f.documents, definitions } },
    );
    assert.equal(response.errors?.[0]?.extensions.code, "INTERNAL_SERVER_ERROR");
  }
  for (const resolve of [
    async () => {
      throw new StorageRequestError("private exposure failure");
    },
    async () => ({ token: f.task }),
    async () => ({
      token: { definition: { ...f.conversation.definition, kind: f.session.definition.kind } },
    }),
  ]) {
    const ctx = { ...f.ctx, documents: { ...f.documents, resolve } };
    const response = await f.run(
      'query($address:DocumentAddressInput!) { harness(externalId:"test") { snapshot(address:$address) } }',
      { address: f.addresses[0] },
      ctx,
    );
    assert.equal(response.errors?.[0]?.extensions.code, "INTERNAL_SERVER_ERROR");
    assert.equal(
      (await f.replace(f.addresses[0], {}, ctx)).errors?.[0]?.extensions.code,
      "INTERNAL_SERVER_ERROR",
    );
  }
  const read = t.mock.method(f.storage, "findDocument", async () => {
    throw new StorageRequestError("private rejected read");
  });
  const response = await f.run(
    'query($address:DocumentAddressInput!) { harness(externalId:"test") { snapshot(address:$address) } }',
    { address: f.addresses[0] },
    f.ctx,
  );
  assert.equal(response.errors?.[0]?.extensions.code, "BAD_REQUEST");
  read.mock.restore();
});

void test("document policy preserves registered migration/checkpoint receivers without permitting initialization", async (t) => {
  const f = await documentFixture(t);
  const address = f.addresses[0]!;
  assert.equal((await f.replace(address, { old: true })).errors, undefined);
  let migrations = 0;
  let checkpoints = 0;
  const definition = {
    ...f.session.definition,
    version: 2,
    migrate(value: Record<string, JsonValue>, from: number): Record<string, JsonValue> {
      assert.equal(this, definition);
      assert.equal(from, 1);
      migrations++;
      return { ...this.initial(), ...value };
    },
    checkpointWhen(): boolean {
      assert.equal(this, definition);
      checkpoints++;
      return false;
    },
  };
  const token = defineDoc(definition);
  const ctx = {
    ...f.ctx,
    documents: {
      ...f.documents,
      resolve: async () => ({ token, write: { initialize: false, validate: () => true } }),
    },
  };
  for (const content of [{ first: true }, { second: true }]) {
    assert.equal((await f.replace(address, content, ctx)).errors, undefined);
    assert.deepEqual(await f.read(address, ctx), content);
  }
  assert.equal(migrations, 1);
  assert(checkpoints > 0);
});

void test("document replacement rechecks its owner on the commit line", async (t) => {
  const f = await documentFixture(t);
  const read = f.storage.task.bind(f.storage);
  let calls = 0;
  t.mock.method(f.storage, "task", async (...args: Parameters<typeof read>) =>
    ++calls === 1 ? read(...args) : undefined,
  );
  const writes = t.mock.method(f.storage, "commit");
  const response = await f.replace({
    kind: f.task.definition.kind,
    scope: { kind: "task", taskId: f.taskId },
  });
  assert.equal(response.errors?.[0]?.extensions.code, "NOT_FOUND");
  assert.equal(writes.mock.callCount(), 0);
  assert.equal(calls, 2);
});

void test("document family access authorizes the exact key and accepts a server-supplied null seed", async (t) => {
  const f = await documentFixture(t);
  const address: DocumentAddress = {
    kind: f.sessionFamily.definition.kind,
    scope: { kind: "session" },
    key: "",
  };
  const initial = t.mock.method(f.sessionFamily.definition, "initial");
  const ctx = {
    ...f.ctx,
    documents: {
      ...f.documents,
      resolve: async (id: string, target: DocumentAddress, context: ResolverContext["context"]) => {
        assert.equal(id, "test");
        assert.equal(context, execution);
        return target.key === ""
          ? {
              token: f.sessionFamily,
              write: { initialize: true, seed: null, validate: () => true },
            }
          : undefined;
      },
    },
  };
  assert.equal((await f.replace(address, {}, ctx)).errors, undefined);
  assert.deepEqual(initial.mock.calls[0]?.arguments, [null]);
  assert.deepEqual(await f.read(address, ctx), {});
  const denied = { ...address, key: "private" };
  assert.equal(await f.read(denied, ctx), null);
  assert.equal((await f.replace(denied, {}, ctx)).errors?.[0]?.extensions.code, "NOT_FOUND");
});

for (const method of ["commit", "mintId"] as const) {
  void test(`fatal Storage.${method} request errors are internal and subsequent calls report SessionFailed`, async (t) => {
    const f = await fixture(t);
    const error = new StorageRequestError("private fatal write");
    const fault = t.mock.method(f.storage, method, async () => {
      throw error;
    });
    const request =
      "mutation($id:ID!) { createConversation(input:{harnessId:$id,options:{ownership:{kind:ownerless}}}) { conversation { id } } }";
    const response = await f.run(request, { id: f.harnessId });
    assert.equal(response.errors?.[0]?.extensions.code, "INTERNAL_SERVER_ERROR");
    assert.equal(response.errors?.[0]?.message, "INTERNAL_SERVER_ERROR");
    assert.deepEqual(response.errors?.[0]?.path, ["createConversation"]);
    assert.equal(response.data?.createConversation, null);
    assert.deepEqual(await f.instance.closed, { reason: "failed", error });
    const next = await f.run(request, { id: f.harnessId });
    assert.equal(next.errors?.[0]?.extensions.code, "SESSION_FAILED");
    assert.equal(fault.mock.callCount(), 1);
  });
}

void test("root creation and document replacement classify fatal storage request errors", async (t) => {
  const f = await fixture(t);
  const storage = new MemoryStorage();
  const instance = await Harness.open(
    storage,
    { models: createModels(), registry: createRegistry() },
    execution,
  );
  t.after(() => instance.close(execution));
  t.mock.method(storage, "commit", async () => {
    throw new StorageRequestError("private root write");
  });
  const root = await f.run(
    "mutation($id:ID!) { root(input:{harnessId:$id}) { conversation { id } } }",
    { id: f.harnessId },
    f.request({ session: async () => instance }),
  );
  assert.equal(root.errors?.[0]?.extensions.code, "INTERNAL_SERVER_ERROR");
  const docs = await documentFixture(t);
  t.mock.method(docs.storage, "commit", async () => {
    throw new StorageRequestError("private document write");
  });
  const document = await docs.replace(docs.addresses[0], { saved: true });
  assert.equal(document.errors?.[0]?.extensions.code, "INTERNAL_SERVER_ERROR");
  assert.equal(document.data?.replaceDocument, null);
});

void test("a rejected read inside a write-capable commit remains BAD_REQUEST without failing the Harness", async (t) => {
  const f = await documentFixture(t);
  const read = f.storage.task.bind(f.storage);
  let calls = 0;
  const fault = t.mock.method(f.storage, "task", async (...args: Parameters<typeof read>) => {
    if (++calls === 2) throw new StorageRequestError("private rejected owner read");
    return read(...args);
  });
  const writes = t.mock.method(f.storage, "commit");
  const response = await f.replace({
    kind: f.task.definition.kind,
    scope: { kind: "task", taskId: f.taskId },
  });
  assert.equal(response.errors?.[0]?.extensions.code, "BAD_REQUEST");
  assert.equal(writes.mock.callCount(), 0);
  fault.mock.restore();
  assert.equal((await f.instance.inspect(execution)).scheduling, "paused");
  await f.instance.close(execution);
  assert.deepEqual(await f.instance.closed, { reason: "closed" });
});

void test("normal closure and an unrelated terminal cause do not reclassify a rejected request", async (t) => {
  for (const failed of [false, true]) {
    const f = await fixture(t);
    const rejected = new StorageRequestError("private rejected read");
    const fatal = new StorageRequestError("different terminal cause");
    t.mock.method(f.instance, "root", async () => {
      if (failed) {
        t.mock.method(f.storage, "commit", async () => {
          throw fatal;
        });
        await assert.rejects(
          f.root.configure({ cwd: "/failure" }, execution),
          (error: unknown) => error === fatal,
        );
      } else {
        await f.instance.close(execution);
      }
      throw rejected;
    });
    const response = await f.run(
      "mutation($id:ID!) { root(input:{harnessId:$id}) { conversation { id } } }",
      { id: f.harnessId },
    );
    assert.equal(response.errors?.[0]?.extensions.code, "BAD_REQUEST");
    assert.deepEqual(
      await f.instance.closed,
      failed ? { reason: "failed", error: fatal } : { reason: "closed" },
    );
  }
});

void test("fatal-error classification waits for the terminal cause but remains request-cancellable", async (t) => {
  const release = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  const f = await fixture(t);
  const closing = Promise.withResolvers<void>();
  const waiting = Promise.withResolvers<void>();
  const terminal = f.instance.closed;
  t.mock.getter(f.instance, "closed", () => {
    waiting.resolve();
    return terminal;
  });
  const close = f.storage.close.bind(f.storage);
  t.mock.method(f.storage, "close", async (context: ResolverContext["context"]) => {
    closing.resolve();
    await release.promise;
    await close(context);
  });
  const error = new StorageRequestError("private fatal storage request");
  t.mock.method(f.storage, "commit", async () => {
    throw error;
  });
  const controller = new AbortController();
  const response = f.run(
    'mutation($id:ID!) { configure(input:{conversationId:$id,change:{cwd:"/changed"}}) }',
    { id: f.conversationId },
    f.request({ context: withAbortSignal(controller.signal, execution) }),
  );
  await closing.promise;
  await waiting.promise;
  controller.abort();
  const result = await response;
  assert.equal(result.errors?.[0]?.extensions.code, "INTERNAL_SERVER_ERROR");
  assert.equal(result.data?.configure, null);
  release.resolve();
  assert.deepEqual(await f.instance.closed, { reason: "failed", error });
});

void test("write operations release their close observer after success and rejection", async (t) => {
  const f = await fixture(t);
  const listeners = new Set<() => void>();
  const subscribe = f.instance.subscribeClose.bind(f.instance);
  t.mock.method(f.instance, "subscribeClose", (listener: () => void) => {
    listeners.add(listener);
    const stop = subscribe(listener);
    return () => {
      assert.equal(listeners.delete(listener), true);
      stop();
    };
  });
  const request =
    'mutation($id:ID!) { configure(input:{conversationId:$id,change:{cwd:"/value"}}) }';
  assert.equal((await f.run(request, { id: f.conversationId })).errors, undefined);
  assert.equal(listeners.size, 0);
  t.mock.method(f.instance, "conversation", async () => f.root);
  t.mock.method(f.root, "configure", async () => {
    throw new StorageRequestError("rejected");
  });
  assert.equal(
    (await f.run(request, { id: f.conversationId })).errors?.[0]?.extensions.code,
    "BAD_REQUEST",
  );
  assert.equal(listeners.size, 0);
});

const settingsFields = `__typename
  ... on WebSettings { revision wrapCode bottomAlign hideThinkingBlock showImages defaultDeliveryMode }
  ... on HarnessSettings { revision transport steeringMode followUpMode
    retry { enabled maxRetries baseDelayMs maxAgentDelayMs }
    compaction { enabled reserveTokens keepRecentTokens backgroundTokens }
  }`;
const saveSettingsMutation = `mutation($input:SaveSettingsInput!) { saveSettings(input:$input) { ${settingsFields} } }`;
function settingsContext(settings = settingsFixture()): ResolverContext {
  return { ...catalogContext(() => assert.fail("settings must not acquire models")), settings };
}

void test("settings reads select both typed services without acquiring a Harness", async (t) => {
  const ctx = settingsContext();
  const web = await ctx.settings.web.read(execution);
  const harness = await ctx.settings.harness.read(execution);
  const reads = [
    t.mock.method(ctx.settings.web, "read"),
    t.mock.method(ctx.settings.harness, "read"),
  ];
  const result = await graphql({
    schema,
    contextValue: ctx,
    source: `{ web:settings(app:web) { ${settingsFields} } harness:settings(app:harness) { ${settingsFields} } }`,
  });
  assert.equal(result.errors, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(result.data)), {
    web: { ...web.settings, revision: web.revision, __typename: "WebSettings" },
    harness: { ...harness.settings, revision: harness.revision, __typename: "HarnessSettings" },
  });
  for (const read of reads) {
    assert.equal(read.mock.callCount(), 1);
    assert.equal(read.mock.calls[0]!.arguments[0], execution);
  }
});

void test("settings saves replace each application and preserve opaque revisions and zero values", async () => {
  const ctx = settingsContext();
  const web = await ctx.settings.web.read(execution);
  const harness = await ctx.settings.harness.read(execution);
  const replacements = {
    web: {
      ...web.settings,
      wrapCode: true,
      bottomAlign: false,
      hideThinkingBlock: true,
      showImages: false,
      defaultDeliveryMode: "steer",
    },
    harness: {
      transport: "websocketCached",
      steeringMode: "all",
      followUpMode: "all",
      retry: { enabled: false, maxRetries: 0, baseDelayMs: 0, maxAgentDelayMs: 2147483647 },
      compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 0, backgroundTokens: 0 },
    },
  };
  for (const app of ["web", "harness"] as const) {
    const result = await graphql({
      schema,
      contextValue: ctx,
      source: saveSettingsMutation,
      variableValues: {
        input: { [app]: { expectedRevision: "absent", settings: replacements[app] } },
      },
    });
    assert.equal(result.errors, undefined);
    const value = await ctx.settings[app].read(execution);
    assert.deepEqual(value.settings, replacements[app]);
    assert.notEqual(value.revision, "absent");
    assert.deepEqual(JSON.parse(JSON.stringify(result.data?.saveSettings)), {
      ...value.settings,
      revision: value.revision,
      __typename: app === "web" ? "WebSettings" : "HarnessSettings",
    });
    const conflict = await graphql({
      schema,
      contextValue: ctx,
      source: saveSettingsMutation,
      variableValues: {
        input: { [app]: { expectedRevision: "absent", settings: replacements[app] } },
      },
    });
    assert.equal(conflict.errors?.[0]?.extensions.code, "CONFIGURATION_CONFLICT");
    assert.deepEqual(conflict.errors?.[0]?.path, ["saveSettings"]);
    assert.equal(conflict.data?.saveSettings, null);
    assert.deepEqual(await ctx.settings[app].read(execution), value);
  }
});

void test("settings input coercion rejects partial, null, unknown and out-of-range input before service calls", async (t) => {
  const ctx = settingsContext();
  const web = {
    expectedRevision: "absent",
    settings: (await ctx.settings.web.read(execution)).settings,
  };
  const harness = {
    expectedRevision: "absent",
    settings: (await ctx.settings.harness.read(execution)).settings,
  };
  const writes = [
    t.mock.method(ctx.settings.web, "replace"),
    t.mock.method(ctx.settings.harness, "replace"),
  ];
  for (const input of [
    {},
    { web: null },
    { web, harness },
    { web: { settings: web.settings } },
    { web: { ...web, settings: { wrapCode: true } } },
    { web: { ...web, settings: null } },
    { web: { ...web, settings: { ...web.settings, cwd: "/private" } } },
    { web: { ...web, settings: { ...web.settings, showImages: null } } },
    { web: { ...web, settings: { ...web.settings, defaultDeliveryMode: "follow-up" } } },
    { harness: { ...harness, settings: { ...harness.settings, transport: "websocket-cached" } } },
    { harness: { ...harness, settings: { ...harness.settings, retry: { enabled: true } } } },
    ...[null, 0.5, 2147483648, "1"].map((maxRetries) => ({
      harness: {
        ...harness,
        settings: { ...harness.settings, retry: { ...harness.settings.retry, maxRetries } },
      },
    })),
  ]) {
    const result = await graphql({
      schema,
      contextValue: ctx,
      source: saveSettingsMutation,
      variableValues: { input },
    });
    assert(result.errors?.length);
    assert.equal(result.data, undefined);
  }
  for (const source of [
    `mutation { saveSettings(input:{}) { __typename } }`,
    `mutation { saveSettings(input:{web:null}) { __typename } }`,
    `mutation { saveSettings(input:{web:null,harness:null}) { __typename } }`,
    `{ settings { __typename } }`,
    `{ settings(app:null) { __typename } }`,
    `{ settings(app:other) { __typename } }`,
  ])
    assert((await graphql({ schema, contextValue: ctx, source })).errors?.length);
  for (const write of writes) assert.equal(write.mock.callCount(), 0);
});

void test("settings reject empty revisions and every negative policy field without saving", async (t) => {
  const ctx = settingsContext();
  const harness = (await ctx.settings.harness.read(execution)).settings;
  const web = (await ctx.settings.web.read(execution)).settings;
  const writes = [
    t.mock.method(ctx.settings.web, "replace"),
    t.mock.method(ctx.settings.harness, "replace"),
  ];
  const inputs: object[] = [
    { web: { expectedRevision: "", settings: web } },
    { harness: { expectedRevision: "", settings: harness } },
  ];
  for (const [group, fields] of [
    ["retry", ["maxRetries", "baseDelayMs", "maxAgentDelayMs"]],
    ["compaction", ["reserveTokens", "keepRecentTokens", "backgroundTokens"]],
  ] as const) {
    for (const field of fields)
      inputs.push({
        harness: {
          expectedRevision: "absent",
          settings: { ...harness, [group]: { ...harness[group], [field]: -1 } },
        },
      });
  }
  for (const input of inputs) {
    const result = await graphql({
      schema,
      contextValue: ctx,
      source: saveSettingsMutation,
      variableValues: { input },
    });
    assert.equal(result.errors?.[0]?.extensions.code, "BAD_REQUEST");
    assert.equal(result.data?.saveSettings, null);
  }
  for (const write of writes) assert.equal(write.mock.callCount(), 0);
});

void test("settings service failures stay internal and preserve other selections", async (t) => {
  for (const error of [
    new Error("private file contents"),
    new StorageRequestError("private path"),
    new GraphQLError("private", { extensions: { code: "BAD_REQUEST" } }),
  ]) {
    const ctx = settingsContext();
    const web = await ctx.settings.web.read(execution);
    t.mock.method(ctx.settings.web, "read", async () => {
      throw error;
    });
    t.mock.method(ctx.settings.harness, "replace", async () => {
      throw error;
    });
    const source = `{ bad:settings(app:web) { __typename } good:settings(app:harness) { __typename } }`;
    const read = await graphql({ schema, contextValue: ctx, source });
    assert.deepEqual(JSON.parse(JSON.stringify(read.data)), {
      bad: null,
      good: { __typename: "HarnessSettings" },
    });
    assert.equal(read.errors?.[0]?.message, "INTERNAL_SERVER_ERROR");
    assert.deepEqual(read.errors?.[0]?.path, ["bad"]);
    const write = await graphql({
      schema,
      contextValue: ctx,
      source: saveSettingsMutation,
      variableValues: {
        input: {
          harness: {
            expectedRevision: "absent",
            settings: (await ctx.settings.harness.read(execution)).settings,
          },
        },
      },
    });
    assert.equal(write.errors?.[0]?.extensions.code, "INTERNAL_SERVER_ERROR");
    assert.equal(write.data?.saveSettings, null);
    assert.equal(web.revision, "absent");
  }
});

void test("invalid service snapshots are internal errors, never partial settings or defaults", async (t) => {
  const ctx = settingsContext();
  const web = await ctx.settings.web.read(execution);
  for (const invalid of [
    { ...web, revision: "" },
    { ...web, settings: { ...web.settings, showImages: null } },
    { ...web, settings: { ...web.settings, secret: "private" } },
  ]) {
    // Deliberately malformed service result at the typed boundary.
    t.mock.method(ctx.settings.web, "read", async () => invalid as typeof web);
    const result = await graphql({
      schema,
      contextValue: ctx,
      source: `{ settings(app:web) { ${settingsFields} } }`,
    });
    assert.equal(result.errors?.[0]?.extensions.code, "INTERNAL_SERVER_ERROR");
    assert.equal(result.data?.settings, null);
  }
  const harness = await ctx.settings.harness.read(execution);
  t.mock.method(ctx.settings.harness, "read", async () => ({
    ...harness,
    settings: { ...harness.settings, retry: { ...harness.settings.retry, maxRetries: -1 } },
  }));
  const read = await graphql({
    schema,
    contextValue: ctx,
    source: `{ settings(app:harness) { __typename } }`,
  });
  assert.equal(read.errors?.[0]?.extensions.code, "INTERNAL_SERVER_ERROR");
});

void test("settings cancellation prevents new admission and does not replay an admitted save", async (t) => {
  const ctx = settingsContext();
  const web = await ctx.settings.web.read(execution);
  const controller = new AbortController();
  const contextValue = { ...ctx, context: withAbortSignal(controller.signal, execution) };
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<typeof web>();
  const replace = t.mock.method(
    ctx.settings.web,
    "replace",
    async (
      _revision: string,
      _settings: typeof web.settings,
      context: ResolverContext["context"],
    ) => {
      assert.equal(context, contextValue.context);
      entered.resolve();
      return release.promise;
    },
  );
  const request = {
    schema,
    contextValue,
    source: saveSettingsMutation,
    variableValues: { input: { web: { expectedRevision: web.revision, settings: web.settings } } },
  };
  const response = graphql(request);
  await entered.promise;
  controller.abort();
  assert.equal((await response).errors?.[0]?.extensions.code, "INTERNAL_SERVER_ERROR");
  release.resolve(web);
  assert.equal((await graphql(request)).errors?.[0]?.extensions.code, "INTERNAL_SERVER_ERROR");
  assert.equal(replace.mock.callCount(), 1);
});

void test("settings projections detach nested values from service state before field execution", async (t) => {
  const ctx = settingsContext();
  const initial = await ctx.settings.harness.read(execution);
  const snapshot = {
    ...initial,
    settings: { ...initial.settings, retry: { ...initial.settings.retry } },
  };
  t.mock.method(ctx.settings.harness, "read", async () => snapshot);
  const localSchema = createSchema();
  const retry = localSchema.getType("HarnessRetrySettings");
  assert(isObjectType(retry));
  retry.getFields().enabled!.resolve = (source: unknown) => {
    assert.notEqual(source, snapshot.settings.retry);
    snapshot.settings.retry.maxRetries = 99;
    return true;
  };
  const result = await graphql({
    schema: localSchema,
    contextValue: ctx,
    source: `{ settings(app:harness) { ... on HarnessSettings { retry { enabled maxRetries } } } }`,
  });
  assert.equal(result.errors, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(result.data)), {
    settings: { retry: { enabled: true, maxRetries: initial.settings.retry.maxRetries } },
  });
  assert.equal(snapshot.settings.retry.maxRetries, 99);
});

void test("settings service serialization errors and invalid saved snapshots remain internal", async (t) => {
  const ctx = settingsContext();
  const web = await ctx.settings.web.read(execution);
  t.mock.method(ctx.settings.web, "read", async () => ({
    get revision(): string {
      throw new StorageRequestError("private snapshot");
    },
    settings: web.settings,
  }));
  assert.equal(
    (await graphql({ schema, contextValue: ctx, source: `{ settings(app:web) { __typename } }` }))
      .errors?.[0]?.extensions.code,
    "INTERNAL_SERVER_ERROR",
  );
  for (const app of ["web", "harness"] as const) {
    const binding = settingsFixture()[app];
    const snapshot = await binding.read(execution);
    t.mock.method(ctx.settings[app], "replace", async () => ({ ...snapshot, revision: "" }));
    const response = await graphql({
      schema,
      contextValue: ctx,
      source: saveSettingsMutation,
      variableValues: {
        input: { [app]: { expectedRevision: "absent", settings: snapshot.settings } },
      },
    });
    assert.equal(response.errors?.[0]?.extensions.code, "INTERNAL_SERVER_ERROR");
  }
});

void test("settings and Durable fields coexist without changing an open Harness policy or documents", async (t) => {
  const f = await fixture(t);
  const service = settingsFixture();
  const ctx = f.request({ settings: service });
  const before = await f.instance.inspect(execution);
  const agentBefore = await f.root.agent(execution);
  const harness = await service.harness.read(execution);
  const saved = await f.run(
    saveSettingsMutation,
    {
      input: {
        harness: {
          expectedRevision: harness.revision,
          settings: { ...harness.settings, retry: { ...harness.settings.retry, maxRetries: 17 } },
        },
      },
    },
    ctx,
  );
  assert.equal(saved.errors, undefined);
  const data = await f.success(
    `{ settings(app:harness) { ... on HarnessSettings { retry { maxRetries } } } harness(externalId:"test") { root { id } inspect { scheduling } } }`,
    {},
    ctx,
  );
  assert.deepEqual(data, {
    settings: { retry: { maxRetries: 17 } },
    harness: { root: { id: f.conversationId }, inspect: { scheduling: "paused" } },
  });
  assert.deepEqual(await f.instance.inspect(execution), before);
  assert.deepEqual(await f.root.agent(execution), agentBefore);
});

const instanceFields = `id unit flakeReference state { activeState subState result }
  timings { invocationId activationUs workerUs bootWaitUs provisionUs managerGapsUs
    hostPhases { phase clock monotonicSeconds resolutionSeconds }
    guestPhases { phase clock monotonicSeconds resolutionSeconds }
  }`;
function inventoryContext(inventory = inventoryFixture()): ResolverContext {
  return { ...catalogContext(() => assert.fail("inventory must not acquire models")), inventory };
}
async function inventoryPage(ctx: ResolverContext, limit = 3, cursor?: Cursor | null) {
  const result = await graphql({
    schema,
    contextValue: ctx,
    source: `query($limit:Int!,$cursor:Cursor) { instances(limit:$limit,cursor:$cursor) { nodes { id unit } pageInfo { next } } }`,
    variableValues: { limit, cursor },
  });
  assert.equal(result.errors, undefined);
  assert(result.data?.instances);
  // Response boundary: service identity and page state, not serialized text.
  return result.data.instances as {
    nodes: { id: string; unit: string }[];
    pageInfo: { next: Cursor | null };
  };
}

void test("instance inventory pages preserve service order and cursors without lookahead or Harness acquisition", async (t) => {
  const ctx = inventoryContext();
  const list = t.mock.method(ctx.inventory, "list");
  const metadata = [
    t.mock.method(ctx.inventory, "flakeReference"),
    t.mock.method(ctx.inventory, "state"),
    t.mock.method(ctx.inventory, "timings"),
  ];
  const first = await inventoryPage(ctx, 2, null);
  assert.deepEqual(
    first.nodes.map((row) => row.unit),
    ["drv.run@retained.service", "drv.run@running.service"],
  );
  assert.deepEqual(first.pageInfo.next, { namespace: ctx.inventory.namespace, after: "running" });
  assert.equal(list.mock.callCount(), 1);
  assert.deepEqual(list.mock.calls[0]!.arguments, [2, undefined, execution]);
  const second = await inventoryPage(ctx, 2, first.pageInfo.next);
  assert.deepEqual(
    second.nodes.map((row) => row.unit),
    ["drv.run@starting.service"],
  );
  assert.equal(second.pageInfo.next, null);
  assert.equal(list.mock.callCount(), 2);
  assert.deepEqual(list.mock.calls[1]!.arguments, [2, first.pageInfo.next, execution]);
  const empty = await inventoryPage(ctx, 2, {
    namespace: ctx.inventory.namespace,
    after: "starting",
  });
  assert.deepEqual(empty.nodes, []);
  assert.equal(empty.pageInfo.next, null);
  for (const read of metadata) assert.equal(read.mock.callCount(), 0);
});

void test("inventory identities survive service recreation, isolate namespaces, and refetch without enumeration", async (t) => {
  const ctx = inventoryContext();
  const page = await inventoryPage(ctx);
  const restored = inventoryContext(inventoryFixture());
  assert.deepEqual(await inventoryPage(restored), page);
  const other = inventoryContext(inventoryFixture("other-owner"));
  const otherPage = await inventoryPage(other);
  assert.notEqual(otherPage.nodes[0]!.id, page.nodes[0]!.id);
  const list = t.mock.method(restored.inventory, "list", async () =>
    assert.fail("node must not enumerate inventory"),
  );
  const lookup = t.mock.method(restored.inventory, "lookup");
  const id = page.nodes[0]!.id;
  const response = await graphql({
    schema,
    contextValue: restored,
    source: `query($id:ID!) { node(id:$id) { __typename id ... on Instance { unit } } }`,
    variableValues: { id },
  });
  assert.equal(response.errors, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(response.data)), {
    node: { __typename: "Instance", ...page.nodes[0] },
  });
  assert.deepEqual(lookup.mock.calls[0]!.arguments, ["retained", execution]);
  assert.equal(list.mock.callCount(), 0);
  const foreign = t.mock.method(other.inventory, "lookup", async () =>
    assert.fail("foreign namespace must not reach lookup"),
  );
  assert.equal(
    (
      await graphql({
        schema,
        contextValue: other,
        source: `query($id:ID!) { node(id:$id) { id } }`,
        variableValues: { id },
      })
    ).data?.node,
    null,
  );
  assert.equal(foreign.mock.callCount(), 0);
  t.mock.method(restored.inventory, "lookup", async () => undefined);
  assert.equal(
    (
      await graphql({
        schema,
        contextValue: restored,
        source: `query($id:ID!) { node(id:$id) { id } }`,
        variableValues: { id },
      })
    ).data?.node,
    null,
  );
});

void test("inventory identity validation rejects malformed scopes and Durable mutation targets", async () => {
  const ctx = inventoryContext();
  for (const parts of [
    [1, "Instance", "", "id"],
    [1, "Instance", "ns", ""],
    [1, "Instance", "ns", null],
    [1, "Instance", "ns", 1],
    [1, "Instance", "ns"],
    [2, "Instance", "ns", "id"],
    [1, "Harness", "ns", "id"],
  ]) {
    const id = Buffer.from(JSON.stringify(parts)).toString("base64url");
    const response = await graphql({
      schema,
      contextValue: ctx,
      source: `query($id:ID!) { node(id:$id) { id } }`,
      variableValues: { id },
    });
    assert.equal(response.errors?.[0]?.extensions.code, "BAD_REQUEST");
  }
  const noncanonical = Buffer.from(
    JSON.stringify([1, "Instance", "host/user", "running"], null, 2),
  ).toString("base64url");
  const rejected = await graphql({
    schema,
    contextValue: ctx,
    source: `query($id:ID!) { node(id:$id) { id } }`,
    variableValues: { id: noncanonical },
  });
  assert.equal(rejected.errors?.[0]?.extensions.code, "BAD_REQUEST");
  const id = (await inventoryPage(ctx)).nodes[0]!.id;
  for (const source of [
    `mutation($id:ID!) { resume(input:{harnessId:$id}) }`,
    `mutation($id:ID!) { configure(input:{conversationId:$id,change:{}}) }`,
  ]) {
    const response = await graphql({ schema, contextValue: ctx, source, variableValues: { id } });
    assert.equal(response.errors?.[0]?.extensions.code, "BAD_REQUEST");
  }
});

void test("instance observations preserve unavailable metadata, systemd strings, invocation IDs, units and phase clocks", async () => {
  const ctx = inventoryContext();
  const page = await inventoryPage(ctx);
  const result = await graphql({
    schema,
    contextValue: ctx,
    source: `{ instances(limit:3) { nodes { ${instanceFields} } pageInfo { next } } }`,
  });
  assert.equal(result.errors, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(result.data)), {
    instances: {
      nodes: [
        { ...page.nodes[0], flakeReference: "github:owner/retained", state: null, timings: null },
        {
          ...page.nodes[1],
          flakeReference: "github:owner/running",
          state: { activeState: "active", subState: "running", result: "success" },
          timings: {
            invocationId: "running-invocation",
            activationUs: 4294967296,
            workerUs: 1000000,
            bootWaitUs: 2000000,
            provisionUs: 3000000,
            managerGapsUs: 4288967296,
            hostPhases: [
              {
                phase: "preparation-start",
                clock: "boottime",
                monotonicSeconds: 10.12,
                resolutionSeconds: 0.01,
              },
              {
                phase: "preparation-ready",
                clock: "boottime",
                monotonicSeconds: 11.12,
                resolutionSeconds: 0.01,
              },
            ],
            guestPhases: [
              {
                phase: "mounts-ready",
                clock: "boottime",
                monotonicSeconds: 0.25,
                resolutionSeconds: 0.01,
              },
            ],
          },
        },
        {
          ...page.nodes[2],
          flakeReference: null,
          state: { activeState: "activating", subState: "start-pre", result: null },
          timings: {
            invocationId: "starting-invocation",
            activationUs: null,
            workerUs: null,
            bootWaitUs: null,
            provisionUs: null,
            managerGapsUs: null,
            hostPhases: [],
            guestPhases: null,
          },
        },
      ],
      pageInfo: { next: null },
    },
  });
});

void test("inventory pagination validates client limits and reports service cursor rejection explicitly", async (t) => {
  const ctx = inventoryContext();
  const list = t.mock.method(ctx.inventory, "list");
  for (const limit of [0, -1]) {
    const result = await graphql({
      schema,
      contextValue: ctx,
      source: `query($limit:Int!) { instances(limit:$limit) { nodes { id } } }`,
      variableValues: { limit },
    });
    assert.equal(result.errors?.[0]?.extensions.code, "BAD_REQUEST");
  }
  for (const limit of [null, 0.5, 2147483648])
    assert(
      (
        await graphql({
          schema,
          contextValue: ctx,
          source: `query($limit:Int!) { instances(limit:$limit) { nodes { id } } }`,
          variableValues: { limit },
        })
      ).errors?.length,
    );
  assert.equal(list.mock.callCount(), 0);
  for (const cursor of [
    { namespace: "foreign", after: "retained" },
    { namespace: ctx.inventory.namespace, after: "absent" },
  ]) {
    const result = await graphql({
      schema,
      contextValue: ctx,
      source: `query($cursor:Cursor) { instances(limit:1,cursor:$cursor) { nodes { id } } }`,
      variableValues: { cursor },
    });
    assert.equal(result.errors?.[0]?.extensions.code, "BAD_REQUEST");
    assert.equal(result.data?.instances, null);
  }
});

void test("inventory enumeration and lookup failures stay internal rather than returning partial membership or absence", async (t) => {
  for (const error of [
    new Error("private inventory path"),
    new StorageRequestError("private systemd request"),
  ]) {
    const ctx = inventoryContext();
    const id = (await inventoryPage(ctx)).nodes[0]!.id;
    t.mock.method(ctx.inventory, "list", async () => {
      throw error;
    });
    t.mock.method(ctx.inventory, "lookup", async () => {
      throw error;
    });
    const response = await graphql({
      schema,
      contextValue: { ...ctx, settings: settingsFixture() },
      source: `query($id:ID!) { instances(limit:1) { nodes { id } } node(id:$id) { id } settings(app:web) { __typename } }`,
      variableValues: { id },
    });
    assert.deepEqual(JSON.parse(JSON.stringify(response.data)), {
      instances: null,
      node: null,
      settings: { __typename: "WebSettings" },
    });
    assert.deepEqual(
      response.errors?.map((error) => error.path),
      [["instances"], ["node"]],
    );
    for (const error of response.errors!) {
      assert.equal(error.extensions.code, "INTERNAL_SERVER_ERROR");
      assert.equal(error.message, "INTERNAL_SERVER_ERROR");
    }
  }
});

void test("inventory observation failures preserve membership, sibling fields, and row error paths", async (t) => {
  const ctx = inventoryContext();
  const page = await inventoryPage(ctx);
  for (const field of ["flakeReference", "state", "timings"] as const) {
    const method = ctx.inventory[field].bind(ctx.inventory);
    t.mock.method(ctx.inventory, field, async (...args: Parameters<typeof method>) => {
      if (args[0] === "running") throw new StorageRequestError("private observation");
      return method(args[0], args[1]);
    });
  }
  const response = await graphql({
    schema,
    contextValue: ctx,
    source: `{ instances(limit:3) { nodes { ${instanceFields} } } }`,
  });
  assert.deepEqual(
    response.errors?.map((error) => error.path),
    [
      ["instances", "nodes", 1, "flakeReference"],
      ["instances", "nodes", 1, "state"],
      ["instances", "nodes", 1, "timings"],
    ],
  );
  const data = response.data?.instances as { nodes: object[] };
  assert.equal(data.nodes.length, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(data.nodes[1])), {
    ...page.nodes[1],
    flakeReference: null,
    state: null,
    timings: null,
  });
  for (const error of response.errors!)
    assert.equal(error.extensions.code, "INTERNAL_SERVER_ERROR");
});

void test("inventory rejects invalid service membership, overflow, cursors and mismatched lookup identities", async (t) => {
  const ctx = inventoryContext();
  const id = (await inventoryPage(ctx)).nodes[0]!.id;
  const row = { id: "x", unit: "drv.run@x.service" };
  for (const value of [
    { items: [row, row] },
    { items: [row, { id: "y", unit: "u" }] },
    { items: [{ id: "", unit: "u" }] },
    { items: [{ id: "x", unit: "" }] },
    { items: [], next: [] },
    { items: null },
    { invalidCursor: false },
  ]) {
    // Malformed service responses at the typed boundary.
    t.mock.method(
      ctx.inventory,
      "list",
      async () => value as Awaited<ReturnType<typeof ctx.inventory.list>>,
    );
    const response = await graphql({
      schema,
      contextValue: ctx,
      source: `{ instances(limit:1) { nodes { id } } }`,
    });
    assert.equal(response.errors?.[0]?.extensions.code, "INTERNAL_SERVER_ERROR");
  }
  t.mock.method(ctx.inventory, "list", async () => ({ items: [row, row] }));
  assert.equal(
    (
      await graphql({
        schema,
        contextValue: ctx,
        source: `{ instances(limit:2) { nodes { id } } }`,
      })
    ).errors?.[0]?.extensions.code,
    "INTERNAL_SERVER_ERROR",
  );
  t.mock.method(ctx.inventory, "lookup", async () => row);
  assert.equal(
    (
      await graphql({
        schema,
        contextValue: ctx,
        source: `query($id:ID!) { node(id:$id) { id } }`,
        variableValues: { id },
      })
    ).errors?.[0]?.extensions.code,
    "INTERNAL_SERVER_ERROR",
  );
  const invalidNamespace = inventoryContext({ ...inventoryFixture(), namespace: "" });
  assert.equal(
    (
      await graphql({
        schema,
        contextValue: invalidNamespace,
        source: `{ instances(limit:1) { nodes { id } } }`,
      })
    ).errors?.[0]?.extensions.code,
    "INTERNAL_SERVER_ERROR",
  );
});

void test("invalid instance observations never leak through scalar completion", async (t) => {
  const ctx = inventoryContext();
  t.mock.method(
    ctx.inventory,
    "flakeReference",
    async () => ({ private: true }) as unknown as string,
  );
  t.mock.method(
    ctx.inventory,
    "state",
    async () =>
      ({ activeState: 7, subState: "running" }) as unknown as Awaited<
        ReturnType<typeof ctx.inventory.state>
      >,
  );
  const invalid = await graphql({
    schema,
    contextValue: ctx,
    source: `{ instances(limit:1) { nodes { id flakeReference state { activeState } } } }`,
  });
  assert.equal(invalid.errors?.length, 2);
  for (const error of invalid.errors!) assert.equal(error.extensions.code, "INTERNAL_SERVER_ERROR");
  const valid = await ctx.inventory.timings("running", execution);
  assert(valid);
  for (const timing of [
    { ...valid, invocation_id: "" },
    { ...valid, activation_us: -1 },
    { ...valid, worker_us: Infinity },
    {
      ...valid,
      host_phases: [{ phase: "x", clock: "boottime", monotonic_s: NaN, resolution_s: 0.01 }],
    },
    {
      ...valid,
      guest_phases: [{ phase: "x", clock: "boottime", monotonic_s: 1, resolution_s: 0 }],
    },
  ]) {
    t.mock.method(ctx.inventory, "timings", async () => timing);
    const result = await graphql({
      schema,
      contextValue: ctx,
      source: `{ instances(limit:1) { nodes { timings { invocationId } } } }`,
    });
    assert.equal(result.errors?.[0]?.extensions.code, "INTERNAL_SERVER_ERROR");
    assert.deepEqual(result.errors?.[0]?.path, ["instances", "nodes", 0, "timings"]);
  }
  t.mock.method(ctx.inventory, "state", async () => ({
    activeState: "vendor-active",
    subState: "vendor-substate",
    result: "",
  }));
  t.mock.method(ctx.inventory, "timings", async () => ({
    invocation_id: "failed-invocation",
    host_phases: null,
    guest_phases: [],
  }));
  const result = await graphql({
    schema,
    contextValue: ctx,
    source: `{ instances(limit:1) { nodes { state { activeState subState result } timings { invocationId activationUs hostPhases { phase } guestPhases { phase } } } } }`,
  });
  assert.equal(result.errors, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(result.data)), {
    instances: {
      nodes: [
        {
          state: { activeState: "vendor-active", subState: "vendor-substate", result: "" },
          timings: {
            invocationId: "failed-invocation",
            activationUs: null,
            hostPhases: null,
            guestPhases: [],
          },
        },
      ],
    },
  });
});

void test("inventory waits are cancellable without retry and an aborted context admits no new read", async (t) => {
  const ctx = inventoryContext();
  const controller = new AbortController();
  const contextValue = { ...ctx, context: withAbortSignal(controller.signal, execution) };
  const entered = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<{ items: [] }>();
  const list = t.mock.method(
    ctx.inventory,
    "list",
    async (_limit: number, _cursor: Cursor | undefined, context: ResolverContext["context"]) => {
      assert.equal(context, contextValue.context);
      entered.resolve();
      return pending.promise;
    },
  );
  const request = { schema, contextValue, source: `{ instances(limit:1) { nodes { id } } }` };
  const response = graphql(request);
  await entered.promise;
  controller.abort();
  assert.equal((await response).errors?.[0]?.extensions.code, "INTERNAL_SERVER_ERROR");
  pending.resolve({ items: [] });
  assert.equal((await graphql(request)).errors?.[0]?.extensions.code, "INTERNAL_SERVER_ERROR");
  assert.equal(list.mock.callCount(), 1);
});

void test("inventory exposes only read-only public fields and uses Float microseconds", () => {
  const instance = schema.getType("Instance");
  assert(isObjectType(instance));
  assert.deepEqual(Object.keys(instance.getFields()).sort(), [
    "flakeReference",
    "id",
    "state",
    "timings",
    "unit",
  ]);
  assert.equal(instance.getInterfaces()[0], schema.getType("Node"));
  const timings = schema.getType("InstanceTimings");
  assert(isObjectType(timings));
  for (const field of ["activationUs", "workerUs", "bootWaitUs", "provisionUs", "managerGapsUs"]) {
    assert.equal(timings.getFields()[field]!.type, schema.getType("Float"));
  }
  const phase = schema.getType("InstanceTimingPhase");
  assert(isObjectType(phase));
  assert.deepEqual(Object.keys(phase.getFields()).sort(), [
    "clock",
    "monotonicSeconds",
    "phase",
    "resolutionSeconds",
  ]);
  for (const command of ["startInstance", "stopInstance", "restartInstance", "connectInstance"])
    assert.equal(schema.getMutationType()!.getFields()[command], undefined);
});

void test("inventory service failure stays observed when the service synchronously cancels its caller", async (t) => {
  const ctx = inventoryContext();
  const controller = new AbortController();
  const contextValue = { ...ctx, context: withAbortSignal(controller.signal, execution) };
  const list = t.mock.method(ctx.inventory, "list", async () => {
    controller.abort();
    throw new StorageRequestError("private failure after cancellation");
  });
  const result = await graphql({
    schema,
    contextValue,
    source: `{ instances(limit:1) { nodes { id } } }`,
  });
  assert.equal(result.errors?.[0]?.extensions.code, "INTERNAL_SERVER_ERROR");
  assert.equal(result.data?.instances, null);
  assert.equal(list.mock.callCount(), 1);
});

void test("cancellation before queued inventory admission prevents the service call", async (t) => {
  const ctx = inventoryContext();
  const controller = new AbortController();
  const contextValue = { ...ctx, context: withAbortSignal(controller.signal, execution) };
  const list = t.mock.method(ctx.inventory, "list");
  queueMicrotask(() => controller.abort());
  const result = await graphql({
    schema,
    contextValue,
    source: `{ instances(limit:1) { nodes { id } } }`,
  });
  assert.equal(result.errors?.[0]?.extensions.code, "INTERNAL_SERVER_ERROR");
  assert.equal(list.mock.callCount(), 0);
});
