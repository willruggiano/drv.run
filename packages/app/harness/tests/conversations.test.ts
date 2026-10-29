import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT, awaitWithContext, type Context } from "@earendil-works/chord/context";
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
  defineTask,
  hook,
  type ConversationId,
  type ToolExecutionApi,
  type ToolHooks,
  type JsonObject,
} from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createConversationExtension } from "../conversations.ts";
import { openHarness } from "../index.ts";

const context = BACKGROUND_CONTEXT;
const call = (name: string, args: JsonObject) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const done = () => fauxAssistantMessage("Done.");
const fork = `
  const view = await tools.conversation_context({});
  const at = view.entries.findLast(e => e.kind === "pi.user").id;
  const child = await tools.conversation_fork({ at });
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
  let onCapture:
    | ((value: unknown, api: ToolExecutionApi, context: Context) => Promise<void>)
    | undefined;
  const requests: TranscriptContext[] = [];
  faux.setResponses(
    Array.from({ length: 100 }, () => (request: TranscriptContext) => {
      requests.push(request);
      if (request.messages.at(-1)?.role === "toolResult") return done();
      const input = request.messages.findLast((message) => message.role === "user")?.content;
      if (input === "hold") return call("hold", {});
      const script = typeof input === "string" ? scripts.get(input) : undefined;
      return script === undefined ? done() : call("codemode", { code: script });
    }),
  );
  const registry = createRegistry();
  const options = { sandbox, models: false };
  registry.install(createCodemodeExtension(options));
  registry.install(createConversationExtension(() => harness, options));
  registry.install(
    defineExtension({
      name: "test",
      hooks: [hook(ToolTask, hooks)],
      tools: [
        defineTool({
          name: "capture",
          parameters: Type.Object({ value: Type.Unknown() }),
          description: "Record test state.",
          async execute(args, api, context) {
            values.push({ conversationId: api.conversationId, value: args.value });
            await onCapture?.(args.value, api, context);
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
    harness = await Harness.open(
      await openNodeSqliteStorage(join(directory, "test.sqlite")),
      {
        models,
        registry,
        settings: { compaction: { enabled: false, keepRecentTokens: 0 } },
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
    sandbox,
    models,
    scripts,
    values,
    requests,
    held,
    registry,
    get harness() {
      return harness;
    },
    get holding() {
      return holding;
    },
    get cancelled() {
      return cancelled;
    },
    capture(fn: typeof onCapture) {
      onCapture = fn;
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

await test("opt-in harness installs Codemode and tools-only conversation methods", async (t) => {
  const f = await fixture(t);
  const directory = await mkdtemp(join(tmpdir(), "conversation-open-"));
  const harness = await openHarness(
    await openNodeSqliteStorage(join(directory, "test.sqlite")),
    {
      models: f.models,
      codemode: f.sandbox,
    },
    context,
  );
  t.after(async () => {
    await harness.close(context);
    await rm(directory, { recursive: true, force: true });
  });
  const agent = await (await harness.root(context)).agent(context);
  assert(agent.tools.some((tool) => tool.name === "codemode"));
  assert.equal(
    agent.tools.some((tool) => tool.name.startsWith("conversation_")),
    false,
  );
  assert.deepEqual(
    agent.callable
      .filter((tool) => tool.name.startsWith("conversation_"))
      .map((tool) => tool.name)
      .sort(),
    [
      "conversation_abort",
      "conversation_compact",
      "conversation_configure",
      "conversation_context",
      "conversation_entries",
      "conversation_fork",
      "conversation_reset",
      "conversation_submit",
      "conversation_waitForIdle",
    ],
  );
});

await test(
  "fork points, parallel results, configure, reset and history pagination",
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const first = await f.root.submit(
      { type: "write", entry: { kind: "test.first", data: { keep: true } } },
      context,
    );
    const firstEntry = (await first.status(context)).entry;
    assert(firstEntry !== undefined);
    const second = await f.root.submit(
      { type: "write", entry: { kind: "test.second", data: { exclude: true } } },
      context,
    );
    const secondEntry = (await second.status(context)).entry;
    await f.run(`
    const children = await Promise.all([1, 2].map(async i => {
      const child = await tools.conversation_fork({ at: ${firstEntry} });
      await tools.conversation_configure({ conversationId: child.id, change: { instructions: "child instructions" } });
      const inherited = await tools.conversation_entries({ conversationId: child.id, query: { order: "ascending" }, limit: 1 });
      await tools.conversation_reset({ conversationId: child.id, handoff: "focused task" });
      await tools.conversation_submit({ conversationId: child.id, submission: { type: "input", content: "answer", whenBusy: "reject" } });
      await tools.conversation_waitForIdle({ conversationId: child.id });
      const result = await tools.conversation_context({ conversationId: child.id });
      const history = [];
      let cursor;
      do {
        const page = await tools.conversation_entries({ conversationId: child.id, query: { order: "ascending" }, limit: 1, ...(cursor ? { cursor } : {}) });
        history.push(...page.items);
        cursor = page.next;
      } while (cursor);
      return { id: child.id, inherited, result, history };
    }));
    await tools.capture({ value: children });
  `);
    const conversations = await f.harness.commit((tx) => tx.scanConversations({}, 256), context);
    assert.equal(conversations.items.length, 3);
    for (const record of conversations.items.filter((record) => record.id !== f.root.id)) {
      assert.deepEqual(record.parent, { conversationId: f.root.id, at: firstEntry });
      const child = await f.harness.conversation(record.id, context);
      assert(child);
      const history = await child.entries({}, 256, undefined, context);
      assert(history.items.some((entry) => entry.id === firstEntry));
      assert.equal(
        history.items.some((entry) => entry.id === secondEntry),
        false,
      );
      const active = await child.context(context);
      assert.equal(
        active.entries.some((entry) => entry.id === firstEntry),
        false,
      );
      assert.equal(active.messages.at(-1)?.role, "assistant");
      assert.equal((await child.agent(context)).instructions, "child instructions");
      assert(record.owner);
      const guard = await f.harness.getTask(record.owner.taskId, context);
      assert.equal(guard?.kind, "app.conversations.guard");
      assert.equal(guard?.state.status, "terminal");
    }
    assert.equal(f.values.length, 1);
    assert.equal((await f.harness.inspect(context)).tasks.length, 0);
  },
);

await test(
  "recursive children can collect results but cannot access parent, siblings or unrelated history",
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const outsider = await f.harness.createConversation(
      { ownership: { kind: "ownerless" } },
      context,
    );
    const secret = await outsider.submit(
      { type: "write", entry: { kind: "test.secret", data: { secret: true } } },
      context,
    );
    const secretEntry = (await secret.status(context)).entry;
    assert(secretEntry !== undefined);
    const branch = (sibling: number) => `
    ${fork}
    const denied = [];
    for (const operation of [
      () => tools.conversation_context({ conversationId: ${f.root.id} }),
      () => tools.conversation_context({ conversationId: ${outsider.id} }),
      () => tools.conversation_context({ conversationId: ${sibling} }),
      () => tools.conversation_context({ at: ${secretEntry} }),
      () => tools.conversation_fork({ at: ${secretEntry} }),
      () => tools.conversation_waitForIdle({}),
      () => tools.conversation_abort({}),
      () => tools.conversation_compact({}),
      () => tools.conversation_submit({ submission: { type: "input", content: "escape" } }),
    ]) {
      try { await operation(); denied.push(false); } catch { denied.push(true); }
    }
    await tools.conversation_submit({ conversationId: child.id, submission: { type: "input", content: "leaf" } });
    await tools.conversation_waitForIdle({ conversationId: child.id });
    await tools.capture({ value: { denied, child } });
  `;
    f.capture(async (value) => {
      if (typeof value === "object" && value !== null && "sibling" in value) {
        assert.equal(typeof value.sibling, "number");
        assert(typeof value.sibling === "number");
        f.scripts.set("branch", branch(value.sibling));
      }
    });
    await f.run(`
    ${fork}
    const sibling = await tools.conversation_fork({ at });
    await tools.capture({ value: { sibling: sibling.id } });
    await tools.conversation_submit({ conversationId: child.id, submission: { type: "input", content: "branch" } });
    await tools.conversation_waitForIdle({ conversationId: child.id });
    const result = await tools.conversation_context({ conversationId: child.id });
    await tools.capture({ value: result.messages.at(-1).role });
  `);
    assert.equal(f.values.length, 3);
    const branchValue = f.values[1].value;
    assert(typeof branchValue === "object" && branchValue !== null && "denied" in branchValue);
    assert.deepEqual(branchValue.denied, Array(9).fill(true));
    assert.equal(f.values[2].value, "assistant");
    const conversations = await f.harness.commit((tx) => tx.scanConversations({}, 256), context);
    assert.equal(conversations.items.length, 5);
    assert.equal((await f.harness.inspect(context)).tasks.length, 0);
  },
);

for (const ending of ["return", "throw", "abort"] as const) {
  await test(
    `script ${ending} cancels and joins recursive descendants`,
    { timeout: 30_000 },
    async (t) => {
      const f = await fixture(t);
      f.scripts.set(
        "branch",
        `
      ${fork}
      await tools.conversation_submit({ conversationId: child.id, submission: { type: "input", content: "hold" } });
      await tools.conversation_waitForIdle({ conversationId: child.id });
    `,
      );
      f.scripts.set(
        "parent",
        `
      ${fork}
      await tools.conversation_submit({ conversationId: child.id, submission: { type: "input", content: "branch" } });
      await tools.barrier({});
      ${ending === "throw" ? 'throw new Error("stop");' : ending === "abort" ? "await tools.conversation_waitForIdle({ conversationId: child.id });" : "return;"}
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
  "interrupted fork is not repeated on restart and its child is cleaned up",
  { timeout: 30_000 },
  async (t) => {
    const admitted = Promise.withResolvers<void>();
    let first = true;
    const f = await fixture(t, {
      async afterTool(call, _result, _api, context) {
        if (call.name === "conversation_fork" && first) {
          first = false;
          admitted.resolve();
          await awaitWithContext(new Promise<never>(() => {}), context);
        }
      },
    });
    f.scripts.set(
      "parent",
      `
    const view = await tools.conversation_context({});
    const at = view.entries.findLast(e => e.kind === "pi.user").id;
    let interrupted = false;
    try { await tools.conversation_fork({ at }); } catch { interrupted = true; }
    await tools.capture({ value: interrupted });
  `,
    );
    await f.root.submit({ type: "input", content: "parent" }, context);
    await admitted.promise;
    const root = await f.reopen();
    await root.waitForIdle(context);
    assert.deepEqual(
      f.values.map((record) => record.value),
      [true],
    );
    const conversations = await f.harness.commit((tx) => tx.scanConversations({}, 256), context);
    assert.equal(conversations.items.length, 2);
    assert.equal((await f.harness.inspect(context)).tasks.length, 0);
  },
);

for (const recovered of [false, true]) {
  await test(
    `scope cleanup crosses background boundaries (recovered=${recovered})`,
    { timeout: 30_000 },
    async (t) => {
      const f = await fixture(t);
      let aborted = false;
      const Background = defineTask({
        name: "test.background",
        version: 1,
        initial: () => ({ phase: "hold" as const }),
        phases: {
          hold: async (_task, runtime, context) => {
            await awaitWithContext(new Promise<never>(() => {}), context);
            await runtime.commit(
              () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
              context,
            );
          },
        },
        abort: async (_task, runtime, context) => {
          aborted = true;
          await runtime.commit(
            () => ({ status: "terminal", outcome: { status: "aborted" } }),
            context,
          );
        },
      });
      f.registry.install(defineExtension({ name: "background-test", tasks: [Background] }));
      f.capture(async (value) => {
        assert(typeof value === "number");
        const records = await f.harness.commit((tx) => tx.scanConversations({}, 256), context);
        const child = records.items.find((record) => record.id === value);
        assert(child);
        await f.harness.commit(
          (tx) =>
            tx.createTask(Background, null, {
              ownership: { kind: "conversation" },
              conversationId: child.id,
              background: true,
            }),
          context,
        );
      });
      const script = `${fork}\nawait tools.capture({ value: child.id });`;
      if (recovered) {
        f.scripts.set("parent", `${script}\nawait tools.hold({});`);
        await f.root.submit({ type: "input", content: "parent" }, context);
        await f.held.promise;
        const root = await f.reopen();
        await root.abort(context);
      } else {
        await f.run(script);
      }
      assert.equal(aborted, true);
      assert.equal((await f.harness.inspect(context)).tasks.length, 0);
    },
  );
}

await test(
  "manual compaction retains raw history and explicit abort settles a child",
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    for (const content of ["earlier task", "more context", "last detail"]) {
      await f.root.submit({ type: "input", content }, context);
      await f.root.waitForIdle(context);
    }
    await f.run(`
    ${fork}
    const taskId = await tools.conversation_compact({ conversationId: child.id, instructions: "Preserve constraints." });
    await tools.conversation_waitForIdle({ conversationId: child.id });
    const compacted = await tools.conversation_context({ conversationId: child.id });
    const original = await tools.conversation_entries({ conversationId: child.id, limit: 256 });
    await tools.capture({ value: { taskId, head: compacted.head.kind, originalCount: original.items.length } });
    await tools.conversation_submit({ conversationId: child.id, submission: { type: "input", content: "hold" } });
    await tools.barrier({});
    await tools.conversation_abort({ conversationId: child.id });
    await tools.conversation_waitForIdle({ conversationId: child.id });
  `);
    const value = f.values[0].value;
    assert(typeof value === "object" && value !== null && "head" in value);
    assert.equal(value.head, "pi.compaction");
    assert.equal(f.cancelled, true);
    assert.equal((await f.harness.inspect(context)).tasks.length, 0);
  },
);

await test(
  "unawaited conversation RPCs cannot escape a finished script",
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    await f.run(`
    ${fork}
    void tools.conversation_submit({ conversationId: child.id, submission: { type: "input", content: "hold" } });
    void tools.conversation_fork({ at });
  `);
    assert.equal(f.holding, false);
    assert.equal((await f.harness.inspect(context)).tasks.length, 0);
  },
);
