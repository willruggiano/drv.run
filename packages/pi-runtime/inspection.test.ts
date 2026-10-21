import * as runtime from "./index.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { estimateMessageTokens, estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  DEFAULT_COMPACTION_POLICY,
  type Conversation,
  type EntryDraft,
} from "@earendil-works/pi-durable";
import { describeContext } from "./inspection.ts";
import { readHistory, fixture, model } from "./testing.ts";
import type { Session } from "./index.ts";

const context = BACKGROUND_CONTEXT;
const user = (content: string): Message => ({ role: "user", content, timestamp: 1 });
const append = (conversation: Conversation, entry: EntryDraft) =>
  conversation.commit((tx) => tx.appendEntry(conversation.id, entry), context);
async function view(conversation: Conversation) {
  const watch = await conversation.watch(context);
  try {
    return watch.value;
  } finally {
    await watch.stop();
  }
}
async function inspect(session: Session, conversation = session.root) {
  const data = await runtime.inspectContext(session, await view(conversation));
  assert.equal(data.state, "available");
  assert(data.state === "available");
  const projection = await conversation.context(context);
  assert.deepEqual(
    data.messages.map((message) => [message.role, message.tokens]),
    projection.messages.map((message) => [message.role, estimateMessageTokens(message)]),
  );
  assert.equal(
    data.tokens,
    data.roles.reduce((sum, role) => sum + role.tokens, 0),
  );
  assert.equal(
    data.tokens,
    data.messages.reduce((sum, message) => sum + message.tokens, 0),
  );
  return data;
}

await test("inspection preserves durable baseline, compaction, tool ordering and synthetic provenance", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const root = session.root;
  await append(root, { kind: "pi.user", model: [user("archived ".repeat(1000))] });
  const calls = ["one", "two", "missing"].map((id) => ({
    ...fauxToolCall("read", { path: id }),
    id,
  }));
  const retained = await append(root, {
    kind: "pi.assistant",
    model: [fauxAssistantMessage(calls, { stopReason: "toolUse" })],
  });
  const results = [];
  for (const id of ["two", "one", "orphan"])
    results.push(
      await append(root, {
        kind: "pi.tool-result",
        model: [
          {
            role: "toolResult",
            toolName: "read",
            toolCallId: id,
            content: [{ type: "text", text: id }],
            timestamp: 1,
            isError: false,
            details: { calls: [{ name: "bash", arguments: "not model content".repeat(1000) }] },
          },
        ],
      }),
    );
  const summary = await append(root, {
    kind: "pi.compaction",
    head: retained.id,
    model: [user("summary")],
  });
  const baseline = await append(root, {
    kind: "pi.system",
    model: [{ role: "system", content: "baseline", timestamp: 1 }],
  });
  const update = await append(root, {
    kind: "pi.system",
    model: [{ role: "system", content: "", sections: { instructions: "update" }, timestamp: 1 }],
  });
  for (const stopReason of ["error", "aborted", "deferred"] as const)
    await append(root, {
      kind: "pi.assistant",
      model: [fauxAssistantMessage("excluded".repeat(1000), { stopReason })],
    });
  const data = await inspect(session);
  assert.deepEqual(
    data.messages.map((message) => message.source?.entry),
    [baseline.id, summary.id, retained.id, results[1]!.id, results[0]!.id, undefined, update.id],
  );
  assert.deepEqual(
    data.roles.map(({ role }) => role),
    ["system", "user", "assistant", "toolResult"],
  );
  assert.equal(data.head, summary.id);
  assert.equal(data.messages[1]!.source?.kind, "pi.compaction");
  await append(root, { kind: "edit", edits: [{ target: results[1]!.id, action: "omit" }] });
  const missing = await inspect(session);
  assert.equal(missing.messages.length, data.messages.length);
  assert.equal(missing.messages[3]!.source, undefined);
  await append(root, { kind: "edit", edits: [{ target: retained.id, action: "omit" }] });
  assert.deepEqual(
    (await inspect(session)).messages.map((message) => message.role),
    ["system", "user", "system"],
  );
  await append(root, {
    kind: "edit",
    edits: [
      { target: retained.id, action: "replace", messages: retained.model! },
      { target: results[1]!.id, action: "replace", messages: results[1]!.model! },
    ],
  });
  assert.equal((await inspect(session)).tokens, data.tokens);
  assert.equal(f.faux.state.callCount, 0);
});

await test("inspection derives protocol fields without exposing content, schemas or nested-call details", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const file = {
    level: "repo",
    path: "/workspace/<img src=x onerror=alert(1)>/README.md",
    content: "private document",
  };
  const tools = [
    {
      name: "ask_user",
      description: "private schema",
      parameters: { type: "object" as const, properties: {} },
    },
  ];
  await append(session.root, {
    kind: "pi.system",
    model: [
      {
        role: "system",
        content: [{ type: "text", text: "private prompt" }],
        sections: {
          context: JSON.stringify({ files: [file] }),
          cwd: "<cwd>\n/workspace\n</cwd>",
          removed: null,
          custom: "private section",
        },
        toolsAdded: tools,
        toolsRemoved: [{ name: "bash" }],
        timestamp: 1,
      },
    ],
  });
  await append(session.root, {
    kind: "pi.user",
    model: [
      {
        role: "user",
        content: [
          { type: "text", text: "private user" },
          { type: "image", data: "private base64", mimeType: "image/png" },
        ],
        timestamp: 1,
      },
    ],
  });
  await append(session.root, {
    kind: "pi.assistant",
    model: [
      fauxAssistantMessage(
        [
          {
            type: "thinking",
            thinking: "private thinking",
            thinkingSignature: "private signature",
          },
          { type: "text", text: "private answer" },
          fauxToolCall("read", { path: "SPEC.md", hidden: "private arguments" }),
        ],
        { stopReason: "toolUse" },
      ),
    ],
  });
  const data = await inspect(session);
  const system = data.messages[0]!;
  assert.deepEqual(
    system.parts.map(({ name, value }) => [name, value]),
    [
      ["text", undefined],
      ["sections.context", undefined],
      ["sections.cwd", "/workspace"],
      ["sections.removed", "null"],
      ["sections.custom", undefined],
      ["toolsAdded", "ask_user"],
      ["toolsRemoved", "bash"],
    ],
  );
  assert.deepEqual(system.parts[1]!.children, [
    { name: file.path, tokens: estimateTextTokens(JSON.stringify(file)) },
  ]);
  assert.equal(system.parts[3]!.tokens, 0);
  assert.deepEqual(
    data.messages[1]!.parts.map(({ name, value }) => [name, value]),
    [
      ["text", undefined],
      ["image", "image/png"],
    ],
  );
  assert.deepEqual(
    data.messages[2]!.parts.map(({ name, value }) => [name, value]),
    [
      ["thinking", undefined],
      ["text", undefined],
      ["toolCall", "read  SPEC.md"],
    ],
  );
  assert.deepEqual(Object.keys(system).sort(), ["parts", "role", "source", "tokens"]);
  for (const malformed of [
    "not json",
    JSON.stringify({ files: [{ path: "invented" }] }),
    JSON.stringify({ files: null }),
  ]) {
    await append(session.root, {
      kind: "pi.system",
      model: [{ role: "system", content: "", sections: { context: malformed }, timestamp: 1 }],
    });
    const current = await inspect(session);
    assert.equal(current.messages.at(-1)!.parts[0]!.children, undefined);
    assert.equal(current.messages.at(-1)!.tokens, estimateTextTokens(malformed));
  }
});

await test("inspection follows edits, fork-as-of, reset and persisted unavailable-target state", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const first = await append(session.root, { kind: "pi.user", model: [user("original context")] });
  const answer = await append(session.root, {
    kind: "pi.assistant",
    model: [
      {
        ...fauxAssistantMessage("answer"),
        usage: {
          input: 90000,
          output: 9000,
          cacheRead: 80000,
          cacheWrite: 7000,
          totalTokens: 186000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
    ],
  });
  const branch = await session.root.fork(answer.id, { ownership: { kind: "ownerless" } }, context);
  const original = await inspect(session, branch);
  await append(session.root, { kind: "edit", edits: [{ target: first.id, action: "omit" }] });
  assert.equal((await inspect(session)).messages.length, 1);
  await append(session.root, {
    kind: "edit",
    edits: [{ target: first.id, action: "replace", messages: [user("replacement")] }],
  });
  const replaced = await inspect(session);
  assert.equal(replaced.messages[0]!.tokens, estimateMessageTokens(user("replacement")));
  assert.equal(replaced.messages[0]!.source?.entry, first.id);
  assert.deepEqual(await inspect(session, branch), original);
  await append(session.root, {
    kind: "edit",
    edits: [{ target: first.id, action: "replace", messages: first.model! }],
  });
  assert.equal((await inspect(session)).tokens, original.tokens);
  const history = await readHistory(session.root);
  await f.reopen({ env: undefined, targets: async () => [] });
  const restored = await f.sessions.get(session.id);
  assert.equal((await inspect(restored)).tokens, original.tokens);
  assert.deepEqual(await readHistory(restored.root), history);
  assert.equal(f.faux.state.callCount, 0);
  await restored.root.reset(undefined, context);
  const empty = await inspect(restored);
  assert.equal(empty.tokens, 0);
  assert.deepEqual(empty.messages, []);
  assert.notEqual(empty.head, null);
  assert.deepEqual(
    await inspect(restored, await runtime.getConversation(restored, branch.id)),
    original,
  );
});

await test("inspection uses captured boundaries, caches live-only revisions and recovers from failure", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const first = await append(session.root, { kind: "pi.user", model: [user("one")] });
  const before = await view(session.root);
  await append(session.root, { kind: "pi.user", model: [user("two")] });
  const old = await runtime.inspectContext(session, before);
  assert(old.state === "available");
  assert.equal(old.tail, first.id);
  assert.equal(old.messages.length, 1);
  const get = t.mock.method(
    session.harness,
    "conversation",
    session.harness.conversation.bind(session.harness),
  );
  const live = {
    ...before,
    docs: {
      ...before.docs,
      "pi.live": { generation: { partial: { content: "streaming" } } },
      "pi.inbox": { items: [{ text: "queued" }] },
    },
  };
  assert.equal(await runtime.inspectContext(session, live), old);
  assert.equal(get.mock.callCount(), 0);
  get.mock.restore();
  const current = await view(session.root);
  const failing = t.mock.method(session.harness, "conversation", async () => {
    throw new Error("storage unavailable");
  });
  assert.deepEqual(await runtime.inspectContext(session, current), {
    state: "unavailable",
    conversation: session.root.id,
  });
  failing.mock.restore();
  assert.equal((await inspect(session)).messages.length, 2);
  const unknown = {
    ...current,
    docs: { ...current.docs, "pi.agent": { model: { provider: "missing", modelId: "missing" } } },
  };
  const changed = await runtime.inspectContext(session, unknown);
  assert(changed.state === "available");
  assert.equal(changed.window, null);
  assert.equal(changed.fraction, null);
  assert.deepEqual(changed.model, { provider: "missing", modelId: "missing" });
});

await test(
  "canceling an inspection waiter preserves the shared projection and its cache",
  { timeout: 5000 },
  async (t) => {
    const release = Promise.withResolvers<void>();
    t.after(() => release.resolve());
    const f = await fixture(t);
    const session = await f.create();
    await append(session.root, { kind: "pi.user", model: [user("shared")] });
    const snapshot = await view(session.root);
    const entered = Promise.withResolvers<void>();
    const original = session.harness.conversation.bind(session.harness);
    const opening = t.mock.method(
      session.harness,
      "conversation",
      async (...args: Parameters<typeof original>) => {
        assert.equal(args[1].abortSignal, undefined);
        entered.resolve();
        await release.promise;
        return original(...args);
      },
    );
    const controller = new AbortController();
    const reason = new Error("Caller left");
    const abandoned = runtime.inspectContext(
      session,
      snapshot,
      withAbortSignal(controller.signal, context),
    );
    const active = runtime.inspectContext(session, snapshot);
    await entered.promise;
    controller.abort(reason);
    await assert.rejects(abandoned, reason);
    release.resolve();
    const result = await active;
    assert.equal(result.state, "available");
    assert.equal(await runtime.inspectContext(session, snapshot), result);
    assert.equal(opening.mock.callCount(), 1);
    assert.equal(f.faux.state.callCount, 0);
  },
);

await test("inspection reads no execution environment, starts no work and writes no durable state", async (t) => {
  const f = await fixture(t);
  let opens = 0;
  await f.reopen({
    env: async () => {
      opens++;
      throw new Error("disconnected");
    },
  });
  const session = await f.create();
  const entry = await append(session.root, { kind: "pi.user", model: [user("committed")] });
  const branch = await session.root.fork(entry.id, { ownership: { kind: "ownerless" } }, context);
  const before = await session.harness.inspect(context);
  const history = await readHistory(session.root);
  for (const conversation of [session.root, branch, session.root])
    await inspect(session, conversation);
  assert.deepEqual(await readHistory(session.root), history);
  assert.deepEqual(await session.harness.inspect(context), before);
  assert.equal(opens, 0);
  assert.equal(f.faux.state.callCount, 0);
});

await test("inspection capacity, headroom and overflow are estimates independent of usage", () => {
  const projection = {
    head: undefined,
    entries: [],
    contributions: [],
    messages: [user("x".repeat(700))],
  };
  const policy = { ...DEFAULT_COMPACTION_POLICY, reserveTokens: 10, backgroundTokens: 20 };
  for (const capacity of [null, 0, -1, NaN, Infinity]) {
    const data = describeContext(projection, 1, model, capacity, policy);
    assert.equal(data.tokens, 200);
    assert.equal(data.window, null);
    assert.equal(data.remaining, null);
    assert.equal(data.fraction, null);
    assert.equal(data.backgroundAt, null);
    assert.equal(data.blockingAt, null);
  }
  const data = describeContext(projection, 1, model, 100, policy);
  assert.equal(data.tokens, 200);
  assert.equal(data.fraction, 2);
  assert.equal(data.remaining, 0);
  assert.equal(data.blockingAt, 90);
  assert.equal(data.backgroundAt, 70);
  const blocking = describeContext(projection, 1, model, 100, {
    ...policy,
    backgroundTokens: 0,
    enabled: false,
  });
  assert.equal(blocking.policy.enabled, false);
  assert.equal(blocking.backgroundAt, blocking.blockingAt);
});
