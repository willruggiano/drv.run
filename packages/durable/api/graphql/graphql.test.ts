import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { GraphQLError, graphql, isScalarType, parseValue, validateSchema } from "graphql";
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
} from "@earendil-works/pi-durable";
import { createSchema, type ResolverContext } from "./graphql.ts";

const execution = BACKGROUND_CONTEXT;
const schema = createSchema();
type Connection<T> = {
  edges: Array<{ cursor: string; node: T }>;
  pageInfo: {
    hasNextPage: boolean;
    hasPreviousPage: boolean;
    startCursor: string | null;
    endCursor: string | null;
  };
};
type Identity = { id: string; durableId: number };
const pageFields = "pageInfo { hasNextPage hasPreviousPage startCursor endCursor }";

async function fixture(t: TestContext, sessionId = "test") {
  const models = createModels();
  const faux = fauxProvider({ models: [{ id: "test", reasoning: true }] });
  models.setProvider(faux.provider);
  const instance = await Harness.open(
    new MemoryStorage(),
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
      execution,
      scope: "catalog:user",
      observations: new Map(),
      lookup: async (id) => (id === sessionId ? instance : undefined),
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
});

void test("catalog pagination, authorized lookup, missing nodes, and in-flight reuse", async (t) => {
  const f = await fixture(t);
  const lookup = t.mock.fn(async (id: string) => (id === "test" ? f.instance : undefined));
  const ctx = () => f.request({ lookup, sessions: async () => ["z", "test", "a / 雪"] });
  const list = `query($first: Int!, $after: String) { harnesses(first: $first, after: $after) { edges { cursor node { id sessionId } } ${pageFields} } }`;
  const empty = await f.success<{ harnesses: Connection<never> }>(list, { first: 0 }, ctx());
  assert.deepEqual(empty.harnesses.edges, []);
  assert.equal(empty.harnesses.pageInfo.hasNextPage, true);
  const first = await f.success<{ harnesses: Connection<{ id: string; sessionId: string }> }>(
    list,
    { first: 2 },
    ctx(),
  );
  assert.deepEqual(
    first.harnesses.edges.map((edge) => edge.node.sessionId),
    ["a / 雪", "test"],
  );
  assert.equal(lookup.mock.callCount(), 0);
  const tail = await f.success<typeof first>(
    list,
    { first: 5, after: first.harnesses.edges[0]!.cursor },
    ctx(),
  );
  assert.deepEqual(
    tail.harnesses.edges.map((edge) => edge.node.sessionId),
    ["test", "z"],
  );
  assert.equal(tail.harnesses.pageInfo.hasNextPage, false);
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
  assert.equal(lookup.mock.callCount(), 2);
  assert.deepEqual(
    await f.success(
      `query($id: ID!) { node(id: $id) { id } }`,
      { id: f.harnessId },
      f.request({ lookup: async () => undefined }),
    ),
    { node: null },
  );
  const denied = await f.run(
    list,
    { first: 1, after: first.harnesses.edges[0]!.cursor },
    f.request({ scope: "other-user" }),
  );
  assert.equal(denied.errors?.[0]?.extensions.code, "BAD_REQUEST");
  assert.equal((await f.instance.inspect(execution)).scheduling, "paused");
});

void test("resolved configuration, omission, clearing, and serial mutation fields", async (t) => {
  const f = await fixture(t);
  const read = `{ harness(sessionId: "test") { conversation(id: 1) { agent { cwd model { provider modelId } thinkingLevel instructions } } } }`;
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

void test("entry edge cursors resume at any edge across backend pages, in either order", async (t) => {
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
  const query = `query($first: Int!, $after: String, $filter: EntryQuery!) { harness(sessionId: "test") { conversation(id: 1) { entries(first: $first, after: $after, query: $filter) { edges { cursor node { id durableId data } } ${pageFields} } } } }`;
  type Result = { harness: { conversation: { entries: Connection<Identity & { data: number }> } } };
  async function page(first: number, filter: Record<string, unknown> = {}, after?: string) {
    return (await f.success<Result>(query, { first, filter, after })).harness.conversation.entries;
  }
  const zero = await page(0);
  assert.deepEqual(zero.edges, []);
  assert.equal(zero.pageInfo.hasNextPage, true);
  const ascending = await page(130, { order: "ascending" });
  assert.deepEqual(
    ascending.edges.map((edge) => edge.node.durableId),
    records.slice(0, 130).map((record) => record.id),
  );
  assert.equal(ascending.pageInfo.hasNextPage, true);
  assert.equal(ascending.pageInfo.startCursor, ascending.edges[0]?.cursor);
  assert.equal(ascending.pageInfo.endCursor, ascending.edges.at(-1)?.cursor);
  assert.equal(new Set(ascending.edges.map((edge) => edge.cursor)).size, 130);
  const rest = await page(10, {}, ascending.edges[128]!.cursor);
  assert.deepEqual(
    rest.edges.map((edge) => edge.node.data),
    [129, 130, 131],
  );
  assert.equal(rest.pageInfo.hasNextPage, false);
  const done = await page(0, {}, rest.edges.at(-1)!.cursor);
  assert.equal(done.pageInfo.hasNextPage, false);
  assert.equal(done.pageInfo.startCursor, null);
  assert.equal(done.pageInfo.endCursor, null);
  const descending = await page(2);
  const continuation = await page(1, {}, descending.edges[0]!.cursor);
  assert.deepEqual(continuation.edges[0]?.node, descending.edges[1]?.node);
  const bounded = await page(5, { minEntryId: records[3]!.id, maxEntryId: records[3]!.id });
  assert.equal(bounded.edges.length, 1);
  assert.equal(bounded.edges[0]?.node.data, 3);
  for (const variables of [
    { first: -1, filter: {} },
    { first: 1, filter: {}, after: "!" },
    { first: 1, filter: { order: "descending" }, after: ascending.edges[0]!.cursor },
    { first: 1, filter: { minEntryId: records[1]!.id }, after: ascending.edges[0]!.cursor },
    { first: 1, filter: { order: null } },
  ]) {
    const result = await f.run(query, variables);
    assert.equal(result.errors?.[0]?.extensions.code, "BAD_REQUEST");
  }
  const foreign = await f.run(
    `query($after: String!) { harness(sessionId: "test") { scanConversations(first: 1, after: $after) { edges { cursor } } } }`,
    { after: ascending.edges[0]!.cursor },
  );
  assert.equal(foreign.errors?.[0]?.extensions.code, "BAD_REQUEST");
  assert.equal((await f.instance.inspect(execution)).scheduling, "paused");
});

void test("fork-aware entries keep identity and context preserves raw messages and empty contributions", async (t) => {
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
      root: conversation(id: 1) { entries(first: 5) { edges { node { id durableId model data edits { target action messages } head } } } }
      fork: conversation(id: $fork) { parent { conversationId at } entries(first: 5) { edges { node { id durableId model data edits { target action messages } head } } } context { entries { id durableId } contributions messages head { id } } historical: context(at: $at) { messages entries { durableId } } }
    }
  }`;
  type Result = {
    harness: {
      root: { entries: { edges: Array<{ node: Identity }> } };
      fork: {
        entries: { edges: Array<{ node: Identity }> };
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
  assert.deepEqual(value.fork.context.contributions, [[message], []]);
  assert.deepEqual(value.fork.context.messages, [message]);
  assert.equal(value.fork.context.head, null);
  assert.deepEqual(value.fork.historical.entries, [{ durableId: first.id }]);
  const id = value.root.entries.edges[0]!.node.id;
  const refetch = await f.success<{ node: Identity }>(
    `query($id: ID!) { node(id: $id) { id ... on EntryRecord { durableId model data edits { target action messages } head } } }`,
    { id },
  );
  assert.deepEqual(refetch.node, value.root.entries.edges[0]!.node);
});

void test("conversation/task scans, inspection, node refetch, and per-operation record equality", async (t) => {
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
    scanConversations(first: 1) { edges { cursor node { id durableId parent { at } owner { taskId } } } ${pageFields} }
    scanTasks(first: 2, query: { kind: "pi.compaction", status: pending, background: false, abortRequested: false, conversationId: 1 }) { edges { cursor node { id durableId state { status checkpoint outcome { status result } } input memos } } ${pageFields} }
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
  assert.equal(value.scanConversations.pageInfo.hasNextPage, true);
  assert.equal(value.scanConversations.edges[0]?.node.durableId, f.root.id);
  const tail = await f.success<{ harness: { scanConversations: Connection<Identity> } }>(
    `query($after: String!) { harness(sessionId: "test") { scanConversations(first: 1, after: $after) { edges { cursor node { id durableId } } ${pageFields} } } }`,
    { after: value.scanConversations.edges[0]!.cursor },
  );
  assert.equal(tail.harness.scanConversations.edges[0]?.node.durableId, other.id);
  assert.equal(value.inspect.scheduling, "paused");
  const task = value.scanTasks.edges[0]!.node;
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
    harness(sessionId: "test") { scanTasks(first: 5) { edges { node { id durableId state { status checkpoint } } } } inspect { tasks { record { id durableId state { status checkpoint } } } } }
  }`,
    { id: task.id },
  );
  assert.deepEqual(concurrent.a, concurrent.harness.scanTasks.edges[0]?.node);
  assert.deepEqual(concurrent.a, concurrent.harness.inspect.tasks[0]?.record);
});

void test("agent observations are shared between concurrent aliases but not between operations", async (t) => {
  const f = await fixture(t);
  t.mock.method(f.instance, "conversation", async () => f.root);
  const value = await f.root.agent(execution);
  let calls = 0;
  t.mock.method(f.root, "agent", async () => ({ ...value, cwd: String(++calls) }));
  const query = `{ harness(sessionId: "test") { a: conversation(id: 1) { agent { cwd } } b: conversation(id: 1) { agent { cwd } } } }`;
  const result = await f.success<{ harness: { a: unknown; b: unknown } }>(query);
  assert.deepEqual(result.harness.a, result.harness.b);
  assert.equal(calls, 1);
  await f.success(query);
  assert.equal(calls, 2);
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
  const mutation = `mutation($id: ID!, $draft: InputSubmissionDraft!) { submit(input: { conversationId: $id, submission: $draft, clientMutationId: "echo" }) { submissionId clientMutationId } }`;
  type Result = { submit: { submissionId: string; clientMutationId: string } };
  const content = [
    { type: "text", text: "hello", textSignature: "sig", extra: { keep: true } },
    { type: "image", data: "aGk=", mimeType: "image/png" },
  ];
  const admitted = await f.success<Result>(mutation, {
    id: f.conversationId,
    draft: {
      type: "input",
      content,
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
    draft: { type: "input", content: "different", requestId: "key" },
  });
  assert.deepEqual(duplicate, admitted);
  const busy = await f.run(mutation, {
    id: f.conversationId,
    draft: { type: "input", content: "reject", whenBusy: "reject" },
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
    draft: { type: "input", content: "queued", whenBusy: "followUp" },
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
    `{ harness(sessionId: "test") { conversation(id: 1) { context { head { durableId } messages } } } }`,
  );
  assert.equal(value.harness.conversation.context.head.durableId, current.head?.id);
  assert.deepEqual(value.harness.conversation.context.messages, current.messages);
});

void test("input validation rejects null overrides outside configure, invalid scalars and reserved kinds", async (t) => {
  const f = await fixture(t);
  for (const draft of [
    { type: "input", content: "x", requestId: null },
    { type: "input", content: "x", whenBusy: null },
    { type: "input", content: "x", entry: null },
    { type: "input", content: "x", entry: { kind: "pi.user" } },
    { type: "input", content: [{ type: "image", data: "!", mimeType: "image/png" }] },
    { type: "input", content: [{ type: "text", text: 3 }] },
    { type: "input", content: "x", entry: { kind: "app", data: Infinity } },
  ]) {
    const result = await f.run(
      `mutation($id: ID!, $draft: InputSubmissionDraft!) { submit(input: { conversationId: $id, submission: $draft }) { submissionId } }`,
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
    `{ harness(sessionId: "test") { conversation(id: 1) { context(at: null) { messages } } } }`,
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

void test("error classification depends on typed failures and read/write boundaries", async (t) => {
  const f = await fixture(t);
  for (const [error, code] of [
    [new StorageRequestError("private"), "BAD_REQUEST"],
    [new SessionFailed(new Error("private")), "SESSION_FAILED"],
    [new ReadAfterWrite("private"), "INTERNAL_SERVER_ERROR"],
    [new Error("SessionFailed"), "INTERNAL_SERVER_ERROR"],
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
    [new StorageRequestError("private"), "INTERNAL_SERVER_ERROR"],
    [new SessionFailed(new Error("private")), "SESSION_FAILED"],
    [new ConversationBusy(f.root.id), "INTERNAL_SERVER_ERROR"],
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
    f.request({ lookup: async () => undefined }),
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
  const value = { "file.name": [null, true, { x: 42 }] };
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
  const trace = { traceparent: "opaque", "vendor.key": "value" };
  assert.deepEqual(codec("TelemetryCarrier").parseValue(trace), trace);
  assert.throws(() => codec("TelemetryCarrier").parseValue({ key: 42 }), code("BAD_REQUEST"));
  const message = codec("Message");
  assert.deepEqual(
    message.serialize({
      role: "user",
      content: "text",
      timestamp: 0,
      extra: value,
      omitted: undefined,
    }),
    { role: "user", content: "text", timestamp: 0, extra: value },
  );
  assert.throws(() => message.serialize(null), code("INTERNAL_SERVER_ERROR"));
  assert.throws(() => message.serialize(cycle), code("INTERNAL_SERVER_ERROR"));
  assert.throws(() => message.parseValue({}), code("BAD_REQUEST"));
  assert.throws(() => message.parseLiteral(parseValue("{}")), code("BAD_REQUEST"));
});

void test("IDs retain their session scope for reads and mutation authorization", async (t) => {
  const a = await fixture(t, "a");
  const b = await fixture(t, "b");
  assert.equal(a.root.id, b.root.id);
  assert.notEqual(a.conversationId, b.conversationId);
  assert.notEqual(a.harnessId, b.harnessId);
  const both = a.request({
    lookup: async (id) => (id === "a" ? a.instance : id === "b" ? b.instance : undefined),
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

void test("acquisition failures are not cached across operations and never masquerade as absence", async (t) => {
  const f = await fixture(t);
  let fail = true;
  const lookup = t.mock.fn(async () => {
    if (fail) throw new StorageRequestError("failure while opening storage");
    return f.instance;
  });
  const query = `{ a: harness(sessionId: "test") { id } b: harness(sessionId: "test") { id } }`;
  const failed = await f.run(query, {}, f.request({ lookup }));
  assert.equal(failed.errors?.length, 2);
  assert(failed.errors?.every((error) => error.extensions.code === "INTERNAL_SERVER_ERROR"));
  assert.equal(lookup.mock.callCount(), 1);
  fail = false;
  const recovered = await f.success<{ a: { id: string }; b: { id: string } }>(
    query,
    {},
    f.request({ lookup }),
  );
  assert.deepEqual(recovered.a, recovered.b);
  assert.equal(lookup.mock.callCount(), 2);
});
