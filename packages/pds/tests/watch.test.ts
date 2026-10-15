import assert from "node:assert/strict";
import { test } from "node:test";
import hljs from "highlight.js";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { LiveDoc } from "@earendil-works/pi-durable";
import { context } from "../src/application.ts";
import { configuration, metadata } from "../src/render.ts";
import { observe, Projection, type Patch } from "../src/watch.ts";
import { fixture, form } from "./fixtures.ts";

await test("bounded projection never highlights committed history on partial updates", async (t) => {
  const { app, selection } = await fixture(t);
  const conversation = await app.create(form(selection));
  await conversation.commit(async (tx) => {
    for (let index = 0; index < 250; index++)
      await tx.appendEntry(conversation.id, {
        kind: "test.message",
        model: [
          fauxAssistantMessage(`Answer ${index}.\n\n\`\`\`ts\nconst value = ${index};\n\`\`\``),
        ],
      });
  }, context);
  const abort = new AbortController();
  t.after(() => abort.abort());
  const watch = await observe(app, conversation, abort.signal);
  assert.equal(watch.value.view.entries.length, 50);
  assert(watch.value.view.before !== undefined);
  const highlight = t.mock.method(hljs, "highlight");
  const projection = new Projection({
    configuration: () => configuration(app, conversation),
    metadata: (view) => metadata(app, conversation, view),
  });
  await projection.update(watch.value);
  assert.equal(highlight.mock.callCount(), 50);
  let delivered = Promise.withResolvers<void>();
  let patches: Patch[] = [];
  watch.start(async (call) => {
    assert.equal(call.kind, "value");
    if (call.kind !== "value") return;
    patches = await projection.update(call.value, call.ops);
    delivered.resolve();
  });
  for (let index = 0; index < 10; index++) {
    delivered = Promise.withResolvers<void>();
    await conversation.commit(async (tx) => {
      const live = await tx.doc(LiveDoc, conversation.id);
      const { role, api, provider, model, usage, stopReason, timestamp } = fauxAssistantMessage("");
      live.generation = {
        attempt: 1,
        message: {
          role,
          api,
          provider,
          model,
          usage,
          stopReason,
          timestamp,
          content: [{ type: "text", text: `Partial ${index}` }],
        },
      };
    }, context);
    await delivered.promise;
    assert.equal(patches.length, 1);
    assert.equal(patches[0]?.mode, undefined);
    assert.equal(highlight.mock.callCount(), 50);
  }
  delivered = Promise.withResolvers<void>();
  await conversation.commit(async (tx) => {
    const live = await tx.doc(LiveDoc, conversation.id);
    await tx.appendEntry(conversation.id, {
      kind: "test.message",
      model: [fauxAssistantMessage("```ts\nconst final = true;\n```")],
    });
    delete live.generation;
  }, context);
  await delivered.promise;
  assert.equal(highlight.mock.callCount(), 51);
  assert.equal(patches.filter((patch) => patch.mode === "append").length, 1);
  assert.equal(patches.find((patch) => patch.mode === "append")?.selector, "#entries");
  abort.abort();
  assert.equal((await watch.closed).kind, "aborted");
});

await test("head survives eviction, environment changes are observed, and slow listeners fold updates", async (t) => {
  const { app, selection } = await fixture(t);
  const conversation = await app.create(form(selection));
  const watch = await observe(app, conversation, new AbortController().signal);
  t.after(() => watch.stop());
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const folded = Promise.withResolvers<void>();
  let frames = 0;
  watch.start(async (call) => {
    assert.equal(call.kind, "value");
    frames++;
    if (frames === 1) {
      entered.resolve();
      await release.promise;
    } else folded.resolve();
  });
  await app.configure(conversation, form({ environment: "test-guest" }));
  await entered.promise;
  const head = await conversation.commit(
    (tx) => tx.appendEntry(conversation.id, { kind: "test.reset", head: "self" }),
    context,
  );
  for (let index = 0; index < 120; index++)
    await conversation.commit(
      (tx) => tx.appendEntry(conversation.id, { kind: "test.message" }),
      context,
    );
  assert.equal(frames, 1);
  release.resolve();
  await folded.promise;
  assert.equal(frames, 2);
  assert.equal(watch.value.environment, "test-guest");
  assert.equal(watch.value.head?.id, head.id);
  assert.equal(
    watch.value.view.entries.some((entry) => entry.id === head.id),
    false,
  );
  assert(watch.value.view.entries.length >= 50 && watch.value.view.entries.length <= 100);
  const reconnect = await observe(app, conversation, new AbortController().signal);
  try {
    assert.equal(reconnect.value.view.entries.length, 50);
    assert.equal(reconnect.value.head?.id, head.id);
    assert.equal(reconnect.value.environment, "test-guest");
  } finally {
    await reconnect.stop();
  }
});

await test("tool progress updates only its presentation after the call leaves the window", async (t) => {
  const { app, selection } = await fixture(t);
  const conversation = await app.create(form(selection));
  await conversation.commit(async (tx) => {
    const live = await tx.doc(LiveDoc, conversation.id);
    live.tools = [{ callId: "read-one", name: "read", status: "running" }];
    await tx.appendEntry(conversation.id, {
      kind: "test.message",
      model: [
        fauxAssistantMessage([
          { type: "text", text: "```ts\nconst first = true;\n```" },
          { type: "toolCall", id: "read-one", name: "read", arguments: { path: "note.txt" } },
        ]),
      ],
    });
  }, context);
  const watch = await observe(app, conversation, new AbortController().signal);
  t.after(() => watch.stop());
  const projection = new Projection({
    configuration: () => configuration(app, conversation),
    metadata: (view) => metadata(app, conversation, view),
  });
  await projection.update(watch.value);
  let delivered = Promise.withResolvers<void>();
  let patches: Patch[] = [];
  watch.start(async (call) => {
    assert(call.kind === "value");
    patches = await projection.update(call.value, call.ops);
    delivered.resolve();
  });
  await conversation.commit(async (tx) => {
    for (let index = 0; index < 120; index++)
      await tx.appendEntry(conversation.id, {
        kind: "test.message",
        model: [fauxAssistantMessage("```ts\nconst later = true;\n```")],
      });
  }, context);
  await delivered.promise;
  assert.equal(watch.value.view.entries.length, 50);
  const highlight = t.mock.method(hljs, "highlight");
  delivered = Promise.withResolvers<void>();
  await conversation.commit(async (tx) => {
    const live = await tx.doc(LiveDoc, conversation.id);
    live.tools![0]!.output = "Reading note.txt";
  }, context);
  await delivered.promise;
  assert.equal(patches.length, 1);
  assert.equal(highlight.mock.callCount(), 0);
  delivered = Promise.withResolvers<void>();
  await conversation.commit(async (tx) => {
    const live = await tx.doc(LiveDoc, conversation.id);
    await tx.appendEntry(conversation.id, {
      kind: "test.tool",
      model: [
        {
          role: "toolResult",
          toolCallId: "read-one",
          toolName: "read",
          content: [{ type: "text", text: "Finished" }],
          isError: false,
          timestamp: 1,
        },
      ],
    });
    delete live.tools;
  }, context);
  await delivered.promise;
  assert.equal(patches.length, 2);
  assert.equal(patches.filter((patch) => patch.mode === "append").length, 1);
  assert.equal(highlight.mock.callCount(), 0);
});
