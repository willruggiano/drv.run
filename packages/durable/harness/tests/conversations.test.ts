import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  BACKGROUND_CONTEXT,
  awaitWithContext,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { Type, type TranscriptContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import {
  Harness,
  ToolTask,
  createRegistry,
  defineExtension,
  defineTool,
  hook,
  type ConversationId,
  type ConversationHandle,
  type ToolHooks,
  type JsonObject,
  type Storage,
} from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createConversationExtension } from "../src/conversations.ts";
import { openHarness } from "../src/index.ts";

const context = BACKGROUND_CONTEXT;
const call = (name: string, args: JsonObject) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const done = () => fauxAssistantMessage("Done.");
const fork = `
  const view = await tools.contextView({});
  const at = view.entries.findLast(e => e.kind === "pi.user").id;
`;

async function fixture(t: TestContext, hooks: Partial<ToolHooks> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "conversation-tools-"));
  const sandbox = new CodemodeSandbox({ timeoutMs: 20_000 });
  const faux = fauxProvider({ models: [{ id: "test" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const scripts = new Map<string, string>();
  const values: { conversationId: ConversationId; value: unknown }[] = [];
  const held = Promise.withResolvers<void>();
  let holding = false;
  let cancelled = false;
  let harness: Harness;
  let storage: Storage;
  faux.setResponses(
    Array.from({ length: 100 }, () => (request: TranscriptContext) => {
      if (request.messages.at(-1)?.role === "toolResult") return done();
      const input = request.messages.findLast((message) => message.role === "user")?.content;
      if (input === "hold") return call("hold", {});
      if (input === "fail")
        return fauxAssistantMessage("", { stopReason: "error", errorMessage: "failure" });
      const script = typeof input === "string" ? scripts.get(input) : undefined;
      return script === undefined ? done() : call("codemode", { code: script });
    }),
  );
  const registry = createRegistry();
  const options = { sandbox, models: false };
  registry.install(createCodemodeExtension(options));
  registry.install(createConversationExtension());
  registry.install(
    defineExtension({
      name: "test",
      hooks: [hook(ToolTask, hooks)],
      tools: [
        defineTool({
          name: "capture",
          parameters: Type.Object({ value: Type.Unknown() }),
          description: "Record test state.",
          async execute(args, api) {
            values.push({ conversationId: api.conversationId, value: args.value });
            return {};
          },
        }),
        defineTool({
          name: "hold",
          parameters: Type.Object({}),
          description: "Wait for cancellation.",
          async execute(_args, _api, context) {
            holding = true;
            held.resolve();
            try {
              await awaitWithContext(new Promise<never>(() => {}), context);
            } finally {
              holding = false;
              cancelled = true;
            }
            return {};
          },
        }),
        defineTool({
          name: "barrier",
          parameters: Type.Object({}),
          description: "Wait until the leaf is running.",
          async execute(_args, _api, context) {
            await awaitWithContext(held.promise, context);
            return {};
          },
        }),
      ],
    }),
  );
  async function open() {
    storage = await openNodeSqliteStorage(join(directory, "test.sqlite"));
    harness = await Harness.open(
      storage,
      {
        models,
        registry,
        settings: { compaction: { backgroundTokens: 0 }, retry: { maxRetries: 0 } },
      },
      context,
    );
    return harness.root(context, { agent: { model: { provider: "faux", modelId: "test" } } });
  }
  const root = await open();
  t.after(async () => {
    await harness.close(context);
    await sandbox.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    root,
    registry,
    sandbox,
    models,
    scripts,
    values,
    held,
    get harness() {
      return harness;
    },
    get storage() {
      return storage;
    },
    get holding() {
      return holding;
    },
    get cancelled() {
      return cancelled;
    },
    async reopen() {
      await harness.close(context);
      return open();
    },
    async run(script: string) {
      scripts.set("parent", script);
      await root.submit({ type: "input", content: "parent" }, context);
      await root.waitForIdle(context);
      const history = await root.entries({}, 256, undefined, context);
      const results = history.items.filter((entry) => entry.kind === "pi.tool-result");
      assert(results.length > 0);
      for (const entry of results) {
        for (const message of entry.model ?? []) {
          if (message.role === "toolResult") assert.equal(message.isError, false);
        }
      }
    },
  };
}

await test("opt-in installs only the three conversation tools and disables background compaction", async (t) => {
  const f = await fixture(t);
  const directory = await mkdtemp(join(tmpdir(), "conversation-open-"));
  const storage = await openNodeSqliteStorage(join(directory, "test.sqlite"));
  const modelOverrides: Record<string, { backgroundTokens: number }> = {
    "faux/test": { backgroundTokens: 300_000 },
  };
  const settings = { compaction: { backgroundTokens: 200_000, modelOverrides } };
  const harness = await openHarness(
    storage,
    { models: f.models, codemode: f.sandbox, settings },
    context,
  );
  t.after(async () => {
    await harness.close(context);
    await rm(directory, { recursive: true, force: true });
  });
  const root = await harness.root(context);
  const agent = await root.agent(context);
  assert.deepEqual(agent.tools.map((tool) => tool.name).sort(), [
    "bash",
    "codemode",
    "edit",
    "read",
    "web_fetch",
    "web_search",
    "write",
  ]);
  assert.deepEqual(agent.callable.map((tool) => tool.name).sort(), [
    "bash",
    "contextEntries",
    "contextView",
    "edit",
    "forkJoin",
    "read",
    "web_fetch",
    "web_search",
    "write",
  ]);
  assert.equal(settings.compaction.backgroundTokens, 200_000);
  assert.equal(modelOverrides["faux/test"]?.backgroundTokens, 300_000);
  // Both configured thresholds would start background compaction for a nonempty
  // request. Check durable records, including tasks that already finished.
  await root.configure({ model: { provider: "faux", modelId: "test" } }, context);
  await (await root.submit({ type: "input", content: "answer" }, context)).wait(context);
  delete modelOverrides["faux/test"];
  await (await root.submit({ type: "input", content: "again" }, context)).wait(context);
  const background = await harness.commit((tx) => tx.scanTasks({ background: true }, 256), context);
  assert.deepEqual(background.items, []);
  assert.equal((await harness.inspect(context)).tasks.length, 0);
});

await test(
  "contextView projects active context; contextEntries retains and paginates raw history",
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const first = await f.root.submit(
      { type: "write", entry: { kind: "test.old", data: { retained: true } } },
      context,
    );
    const at = (await first.status(context)).entry;
    assert(at !== undefined);
    const historical = await f.root.context(context, { at });
    await f.root.reset("focused task", context);
    await f.run(`
    const current = await tools.contextView({});
    const historical = await tools.contextView({ at: ${at} });
    const entries = [];
    let cursor;
    do {
      const page = await tools.contextEntries({ query: { order: "ascending" }, limit: 1, ...(cursor ? { cursor } : {}) });
      entries.push(...page.items);
      cursor = page.next;
    } while (cursor);
    const bounded = await tools.contextEntries({ query: { minEntryId: ${at}, maxEntryId: ${at} }, limit: 1 });
    await tools.capture({ value: { historical, oldActive: current.entries.some(e => e.id === ${at}), ids: entries.map(e => e.id), bounded } });
  `);
    const value = f.values[0]?.value;
    assert(
      typeof value === "object" &&
        value !== null &&
        "historical" in value &&
        "oldActive" in value &&
        "ids" in value &&
        "bounded" in value,
    );
    assert.deepEqual(value.historical, JSON.parse(JSON.stringify(historical)));
    assert.equal(value.oldActive, false);
    assert(Array.isArray(value.ids));
    assert.equal(value.ids[0], at);
    assert.deepEqual(
      value.ids,
      [...new Set(value.ids)].sort((a, b) => a - b),
    );
    assert.deepEqual(
      value.bounded,
      JSON.parse(
        JSON.stringify(
          await f.root.entries({ minEntryId: at, maxEntryId: at }, 1, undefined, context),
        ),
      ),
    );
  },
);

await test(
  "parallel forkJoin calls inherit the selected history and return their specific answers",
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    await f.root.configure({ instructions: "inherited instructions" }, context);
    const first = await f.root.submit({ type: "write", entry: { kind: "test.first" } }, context);
    const at = (await first.status(context)).entry;
    assert(at !== undefined);
    const later = await f.root.submit({ type: "write", entry: { kind: "test.later" } }, context);
    const excluded = (await later.status(context)).entry;
    await f.run(`
    const results = await Promise.all(["left", "right"].map(content => tools.forkJoin({ at: ${at}, content })));
    await tools.capture({ value: results });
  `);
    const results = f.values[0]?.value;
    assert(Array.isArray(results));
    assert.equal(results.length, 2);
    const records = (await f.harness.commit((tx) => tx.scanConversations({}, 256), context)).items;
    assert.equal(records.length, 3);
    for (const record of records.filter((record) => record.id !== f.root.id)) {
      assert.deepEqual(record.parent, { conversationId: f.root.id, at });
      assert(record.owner);
      const owner = await f.harness.getTask(record.owner.taskId, context);
      assert.equal(owner?.kind, "pi.tool");
      assert.equal(owner?.state.status, "terminal");
      const child = await f.harness.conversation(record.id, context);
      assert(child);
      assert.equal((await child.agent(context)).instructions, "inherited instructions");
      const history = (await child.entries({}, 256, undefined, context)).items;
      assert(history.some((entry) => entry.id === at));
      assert.equal(
        history.some((entry) => entry.id === excluded),
        false,
      );
      const answer = history.find((entry) => entry.kind === "pi.assistant")?.model?.[0];
      assert.deepEqual(
        results.find((result) => result.conversationId === record.id),
        { conversationId: record.id, answer },
      );
    }
    assert.equal((await f.harness.inspect(context)).tasks.length, 0);
  },
);

await test(
  "recursive children have self-only readers and cannot fork unrelated entries",
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const outsider = await f.harness.createConversation(
      { ownership: { kind: "ownerless" } },
      context,
    );
    const secret = await outsider.submit(
      { type: "write", entry: { kind: "test.secret" } },
      context,
    );
    const secretEntry = (await secret.status(context)).entry;
    assert(secretEntry !== undefined);
    f.scripts.set(
      "branch",
      `
    ${fork}
    const denied = [];
    for (const operation of [
      () => tools.contextView({ conversationId: ${f.root.id} }),
      () => tools.contextEntries({ conversationId: ${outsider.id}, limit: 1 }),
      () => tools.contextEntries({ query: { conversationId: ${outsider.id} }, limit: 1 }),
      () => tools.contextView({ at: ${secretEntry} }),
      () => tools.forkJoin({ at: ${secretEntry}, content: "escape" }),
    ]) {
      try { await operation(); denied.push(false); } catch { denied.push(true); }
    }
    const hidden = await tools.contextEntries({ query: { minEntryId: ${secretEntry}, maxEntryId: ${secretEntry} }, limit: 1 });
    const result = await tools.forkJoin({ at, content: "leaf" });
    await tools.capture({ value: { denied, hidden, result } });
  `,
    );
    await f.run(`${fork}
    const result = await tools.forkJoin({ at, content: "branch" });
    await tools.capture({ value: result });
  `);
    assert.equal(f.values.length, 2);
    const branch = f.values[0]?.value;
    assert(
      typeof branch === "object" && branch !== null && "denied" in branch && "hidden" in branch,
    );
    assert.deepEqual(branch.denied, [true, true, true, true, true]);
    assert.deepEqual(branch.hidden, { items: [] });
    const records = (await f.harness.commit((tx) => tx.scanConversations({}, 256), context)).items;
    assert.equal(records.length, 4);
    assert.equal((await f.harness.inspect(context)).tasks.length, 0);
  },
);

await test(
  "forkJoin rejects a failed submission rather than returning an inherited answer",
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    await (
      await f.root.submit({ type: "input", content: "earlier answer" }, context)
    ).wait(context);
    await f.run(`${fork}
    let rejected = false;
    try { await tools.forkJoin({ at, content: "fail" }); } catch { rejected = true; }
    await tools.capture({ value: rejected });
  `);
    assert.deepEqual(
      f.values.map((record) => record.value),
      [true],
    );
    assert.equal((await f.harness.inspect(context)).tasks.length, 0);
  },
);

for (const ending of ["return", "throw", "abort"] as const) {
  await test(
    `script ${ending} cancels and joins unfinished recursive forkJoin calls`,
    { timeout: 30_000 },
    async (t) => {
      const f = await fixture(t);
      f.scripts.set("branch", `${fork} await tools.forkJoin({ at, content: "hold" });`);
      f.scripts.set(
        "parent",
        `${fork}
      void tools.forkJoin({ at, content: "branch" });
      await tools.barrier({});
      ${ending === "throw" ? 'throw new Error("stop");' : ending === "abort" ? "await tools.hold({});" : "return;"}
    `,
      );
      await f.root.submit({ type: "input", content: "parent" }, context);
      await f.held.promise;
      if (ending === "abort") await f.root.abort(context);
      await f.root.waitForIdle(context);
      assert.equal(f.holding, false);
      assert.equal(f.cancelled, true);
      assert.equal((await f.harness.inspect(context)).tasks.length, 0);
    },
  );
}

await test(
  "restart reuses the fork and submission when interrupted before returning the result",
  { timeout: 30_000 },
  async (t) => {
    const answered = Promise.withResolvers<void>();
    let first = true;
    const f = await fixture(t, {
      async afterTool(call, _result, _api, context) {
        if (call.name === "forkJoin" && first) {
          first = false;
          answered.resolve();
          await awaitWithContext(new Promise<never>(() => {}), context);
        }
      },
    });
    f.scripts.set(
      "parent",
      `${fork}
    const result = await tools.forkJoin({ at, content: "child" });
    await tools.capture({ value: result });
  `,
    );
    await f.root.submit({ type: "input", content: "parent" }, context);
    await answered.promise;
    const root = await f.reopen();
    await root.waitForIdle(context);
    const records = (await f.harness.commit((tx) => tx.scanConversations({}, 256), context)).items;
    assert.equal(records.length, 2);
    const child = records.find((record) => record.id !== root.id);
    assert(child);
    const conversation = await f.harness.conversation(child.id, context);
    assert(conversation);
    const history = (await conversation.entries({}, 256, undefined, context)).items.filter(
      (entry) => entry.conversationId === child.id,
    );
    assert.equal(history.filter((entry) => entry.kind === "pi.user").length, 1);
    assert.equal(history.filter((entry) => entry.kind === "pi.assistant").length, 1);
    assert.equal(f.values.length, 1);
    assert.deepEqual(f.values[0]?.value, {
      conversationId: child.id,
      answer: history.find((entry) => entry.kind === "pi.assistant")?.model?.[0],
    });
    assert.equal((await f.harness.inspect(context)).tasks.length, 0);
  },
);

await test("tool context reads match the public view and obey caller and invocation cancellation", async (t) => {
  const f = await fixture(t);
  let handle: ConversationHandle | undefined;
  f.registry.install(
    defineExtension({
      name: "context-lifetime",
      tools: [
        defineTool({
          name: "readContext",
          description: "Read through the invocation-bound conversation.",
          parameters: Type.Object({}),
          async execute(_args, api, callContext) {
            handle = await api.conversation(api.conversationId, callContext);
            assert(handle);
            assert.deepEqual(await handle.context(context), await f.root.context(context));
            const controller = new AbortController();
            controller.abort();
            await assert.rejects(handle.context(withAbortSignal(controller.signal, context)));
            return {};
          },
        }),
      ],
    }),
  );
  await f.run("await tools.readContext({});");
  assert(handle);
  await assert.rejects(handle.context(context));
});

await test(
  "a context read finishing after its tool invocation ends rejects",
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const acquired = Promise.withResolvers<ConversationHandle>();
    const finishTool = Promise.withResolvers<void>();
    const scanning = Promise.withResolvers<void>();
    const releaseScan = Promise.withResolvers<void>();
    f.registry.install(
      defineExtension({
        name: "context-lifetime",
        tools: [
          defineTool({
            name: "acquireContext",
            description: "Acquire an invocation-bound reader.",
            parameters: Type.Object({}),
            async execute(_args, api, callContext) {
              const handle = await api.conversation(api.conversationId, callContext);
              assert(handle);
              acquired.resolve(handle);
              await awaitWithContext(finishTool.promise, callContext);
              return {};
            },
          }),
        ],
      }),
    );
    f.scripts.set("parent", "await tools.acquireContext({});");
    await f.root.submit({ type: "input", content: "parent" }, context);
    const handle = await acquired.promise;
    const scanEntries = f.storage.scanEntries.bind(f.storage);
    let held = false;
    t.mock.method(f.storage, "scanEntries", async (...args: Parameters<Storage["scanEntries"]>) => {
      const page = await scanEntries(...args);
      // Hold the scan off the Session line, after the context bounds were captured.
      if (!held && args[0].maxEntryId !== undefined) {
        held = true;
        scanning.resolve();
        await releaseScan.promise;
      }
      return page;
    });
    const reading = handle.context(context);
    const rejected = assert.rejects(reading);
    try {
      await scanning.promise;
      finishTool.resolve();
      await f.root.waitForIdle(context);
    } finally {
      finishTool.resolve();
      releaseScan.resolve();
    }
    await rejected;
  },
);
