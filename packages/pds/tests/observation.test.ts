import assert from "node:assert/strict";
import { get, type IncomingMessage } from "node:http";
import { test } from "node:test";
import hljs from "highlight.js";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { LiveDoc } from "@earendil-works/pi-durable";
import { context } from "../src/application.ts";
import { serve } from "../src/server.ts";
import { fixture, form } from "./fixtures.ts";

// Decode the SSE interface, not serialized HTML or diagnostics.
async function* events(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      pending += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = pending.indexOf("\n\n")) >= 0) {
        const lines = pending.slice(0, boundary).split("\n");
        pending = pending.slice(boundary + 2);
        const event = {
          type: "",
          fields: new Map<string, string[]>(),
          id: undefined as string | undefined,
        };
        for (const line of lines) {
          const colon = line.indexOf(":");
          const name = line.slice(0, colon);
          const data = line.slice(colon + 1).trimStart();
          if (name === "event") event.type = data;
          else if (name === "id") event.id = data;
          else if (name === "data") {
            const space = data.indexOf(" ");
            const key = data.slice(0, space);
            const values = event.fields.get(key) ?? [];
            values.push(data.slice(space + 1));
            event.fields.set(key, values);
          }
        }
        yield event;
      }
    }
  } finally {
    await reader.cancel();
  }
}

const cursor = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

await test("history queries validate native cursor membership, bounds, order and request shape", async (t) => {
  const { app, sessions, auth, selection } = await fixture(t);
  const conversation = await app.createConversation(form(selection));
  const other = await app.createConversation(form(selection));
  const [entry, foreign] = await conversation.commit(
    async (tx) => [
      await tx.appendEntry(conversation.id, { kind: "test.message" }),
      await tx.appendEntry(other.id, { kind: "test.message" }),
    ],
    context,
  );
  const server = await serve(sessions, { auth, port: 0 });
  t.after(() => server.close());
  const path = `${server.origin}/api/s/${app.id}/c/${conversation.id}/entries`;
  for (const query of [
    "before=1",
    "limit=51",
    "minEntryId=01",
    "maxEntryId=-1",
    "maxEntryId=1&maxEntryId=2",
    "minEntryId=2&maxEntryId=1",
    "order=newest",
    "cursor=e30=",
    "cursor=AA",
    `cursor=${cursor([])}`,
    `cursor=${cursor({ after: foreign.id, order: "descending" })}`,
    `cursor=${cursor({ after: entry.id, order: "ascending" })}&order=descending`,
    `cursor=${cursor({ after: entry.id, order: "descending" })}&minEntryId=${entry.id + 1}`,
    "projection=arbitrary-selector",
  ]) {
    const response = await fetch(`${path}?${query}`, { redirect: "manual" });
    await response.body?.cancel();
    assert.equal(response.status, 400, query);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  const valid = await fetch(`${path}?cursor=${cursor({ after: entry.id, order: "ascending" })}`, {
    redirect: "manual",
  });
  await valid.body?.cancel();
  assert.equal(valid.status, 303);
  const wrongMethod = await fetch(path, { method: "POST" });
  await wrongMethod.body?.cancel();
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "GET");
  assert.equal((await app.harness.inspect(context)).scheduling, "paused");
});

await test(
  "SSE observers are independent, reconnect without replay IDs, and close without aborting execution",
  { timeout: 15_000 },
  async (t) => {
    const { app, sessions, auth, selection, faux } = await fixture(t);
    const conversation = await app.createConversation(form(selection));
    const server = await serve(sessions, { auth, port: 0 });
    t.after(() => server.close());
    const path = `${server.origin}/api/s/${app.id}/c/${conversation.id}/watch`;
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    t.after(() => finish.resolve());
    faux.setResponses([
      async () => {
        started.resolve();
        await finish.promise;
        return fauxAssistantMessage("Finished");
      },
    ]);
    await app.submit(conversation, form({ message: "Continue independently" }));
    await started.promise;
    const open = async () => {
      const response = await fetch(path, {
        headers: { "Accept-Encoding": "gzip", "Last-Event-ID": "ignored" },
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-encoding"), "gzip");
      assert.equal(response.headers.get("cache-control"), "no-store");
      return events(response.body!);
    };
    const first = await open();
    const second = await open();
    for (const stream of [first, second]) {
      const baseline = await stream.next();
      assert(!baseline.done);
      assert.equal(baseline.value.type, "datastar-patch-elements");
      assert.equal(baseline.value.id, undefined);
    }
    await first.return();
    assert((await app.harness.snapshot(LiveDoc, conversation.id, context))?.run);
    finish.resolve();
    await conversation.waitForIdle(context);
    for await (const event of second) {
      assert.equal(event.type, "datastar-patch-elements");
      assert.equal(event.id, undefined);
      assert(event.fields.has("elements"));
      if (event.fields.get("mode")?.[0] === "append") break;
    }
    const third = await open();
    assert.equal((await third.next()).done, false);
    await third.return();
    assert.equal((await app.harness.inspect(context)).scheduling, "running");
    await sessions.close();
    const unavailable = await fetch(path);
    await unavailable.body?.cancel();
    assert.equal(unavailable.status, 503);
  },
);

await test(
  "a paused HTTP reader folds native progress instead of rendering an observer backlog",
  { timeout: 20_000 },
  async (t) => {
    const { app, sessions, auth, selection } = await fixture(t);
    const conversation = await app.createConversation(form(selection));
    await conversation.commit(async (tx) => {
      await tx.appendEntry(conversation.id, {
        kind: "test.message",
        model: [fauxAssistantMessage("x".repeat(8 * 1024 * 1024))],
      });
    }, context);
    const server = await serve(sessions, { auth, port: 0 });
    t.after(() => server.close());
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = get(`${server.origin}/api/s/${app.id}/c/${conversation.id}/watch`, resolve);
      request.on("error", reject);
      t.after(() => request.destroy());
    });
    // Node's IncomingMessage starts paused. The baseline exceeds the socket buffers.
    const highlight = t.mock.method(hljs, "highlight");
    for (let index = 0; index < 151; index++)
      await conversation.commit(async (tx) => {
        await tx.appendEntry(conversation.id, {
          kind: "test.message",
          model: [fauxAssistantMessage(`\`\`\`ts\nconst value = ${index};\n\`\`\``)],
        });
      }, context);
    assert.equal(highlight.mock.callCount(), 0);
    // The next callback renders only the newest 50, after the blocked baseline drains.
    for await (const chunk of response) {
      assert(Buffer.isBuffer(chunk));
      if (highlight.mock.callCount() >= 50) break;
    }
    assert.equal(highlight.mock.callCount(), 50);
  },
);
