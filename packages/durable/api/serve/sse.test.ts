import assert from "node:assert/strict";
import { on } from "node:events";
import { describe, test, type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { serve } from "durable-api/serve";
import { sse } from "durable-api/sse";

function source(t: TestContext) {
  let controller!: ReadableStreamDefaultController<unknown>;
  const cancelled = Promise.withResolvers<unknown>();
  const reasons: unknown[] = [];
  const stream = new ReadableStream<unknown>({
    start(value) {
      controller = value;
    },
    cancel(reason: unknown) {
      reasons.push(reason);
      cancelled.resolve(reason);
    },
  });
  t.after(() => controller.error(new Error("test ended")));
  return { stream, controller, cancelled: cancelled.promise, reasons };
}

async function start(t: TestContext, events: ReadableStream<unknown>) {
  const errors: unknown[] = [];
  const server = await serve({
    host: "127.0.0.1",
    port: 0,
    routes: {},
    fetch: () => sse(events),
    error(error) {
      errors.push(error);
      return new Response(null, { status: 500 });
    },
  });
  t.after(async () => {
    server.forceClose();
    await server.close();
  });
  return { server, errors };
}

function eventSourceClient(): void {
  const {
    parentPort,
    workerData,
  }: typeof import("node:worker_threads") = require("node:worker_threads");
  if (parentPort === null || typeof workerData !== "string") throw new TypeError();
  const events = new EventSource(workerData);
  events.onopen = () => parentPort.postMessage({ type: "open" });
  events.onmessage = (event) => {
    parentPort.postMessage({
      type: event.type,
      data: JSON.parse(event.data),
      lastEventId: event.lastEventId,
    });
  };
  events.onerror = () => {
    events.close();
    parentPort.postMessage({ type: "error" });
    parentPort.close();
  };
}

void describe("sse", { timeout: 30_000 }, () => {
  void test("response metadata and an empty source", async () => {
    const response = sse(new ReadableStream<unknown>({ start: (c) => c.close() }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await response.arrayBuffer()).byteLength, 0);
  });

  void test("EventSource opens while idle and receives ordered JSON messages incrementally", async (t) => {
    const input = source(t);
    const { server, errors } = await start(t, input.stream);
    const client = new Worker(`(${eventSourceClient.toString()})()`, {
      eval: true,
      execArgv: ["--experimental-eventsource"],
      workerData: server.url.href,
    });
    const messages = on(client, "message", { signal: t.signal, close: ["exit"] });
    t.after(async () => {
      await client.terminate();
      await messages.return?.();
    });
    assert.deepEqual(await messages.next(), { done: false, value: [{ type: "open" }] });
    for (const value of [
      { type: "snapshot", value: { text: "雪 😀\r\ndata: injected\n\nevent: other\rid: forged" } },
      "",
      null,
      false,
      0,
      ["one", { nested: "two" }],
    ]) {
      input.controller.enqueue(value);
      assert.deepEqual(await messages.next(), {
        done: false,
        value: [{ type: "message", data: value, lastEventId: "" }],
      });
    }
    input.controller.close();
    assert.deepEqual(await messages.next(), { done: false, value: [{ type: "error" }] });
    assert.deepEqual(errors, []);
    assert.deepEqual(input.reasons, []);
  });

  void test("a paused consumer stalls production and reading resumes it", async (t) => {
    const input = new TransformStream<number, number>();
    const writer = input.writable.getWriter();
    const reader = sse(input.readable).body!.getReader();
    const firstWrite = Promise.withResolvers<void>();
    const values = Array.from({ length: 32 }, (_, index) => index);
    let produced = 0;
    const producing = (async () => {
      for (const value of values) {
        await writer.write(value);
        produced++;
        firstWrite.resolve();
      }
      await writer.close();
    })();
    t.after(async () => {
      const settled = producing.catch(() => {});
      await reader.cancel();
      await settled;
    });
    await firstWrite.promise;
    await setImmediate();
    assert(produced < values.length);
    while (true) {
      if ((await reader.read()).done) break;
    }
    await producing;
    assert.equal(produced, values.length);
  });

  void test("cancellation before reading and after delivery reaches the producer exactly once", async (t) => {
    for (const consume of [false, true]) {
      const input = source(t);
      const reader = sse(input.stream).body!.getReader();
      input.controller.enqueue({ value: 1 });
      if (consume) assert.equal((await reader.read()).done, false);
      else await setImmediate();
      const reason = new Error("consumer stopped");
      await reader.cancel(reason);
      assert.equal(await input.cancelled, reason);
      await reader.cancel(reason);
      assert.deepEqual(input.reasons, [reason]);
    }
  });

  void test("cancellation releases a pending read without waiting for a pending source pull", async () => {
    const pulling = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<unknown>();
    const input = new ReadableStream<unknown>({
      pull() {
        pulling.resolve();
        return release.promise;
      },
      cancel(reason: unknown) {
        cancelled.resolve(reason);
      },
    });
    const reader = sse(input).body!.getReader();
    try {
      const pending = reader.read();
      await pulling.promise;
      const reason = new Error("consumer stopped");
      await reader.cancel(reason);
      assert.equal(await cancelled.promise, reason);
      assert.deepEqual(await pending, { done: true, value: undefined });
    } finally {
      release.resolve();
    }
  });

  void test("serialization failures reject reads and cancel the source with the same error", async (t) => {
    for (const value of [undefined, 1n]) {
      const input = source(t);
      const reader = sse(input.stream).body!.getReader();
      input.controller.enqueue(value);
      let failure: unknown;
      await assert.rejects(reader.read(), (error: unknown) => {
        assert(error instanceof TypeError);
        failure = error;
        return true;
      });
      assert.equal(await input.cancelled, failure);
      assert.deepEqual(input.reasons, [failure]);
    }
  });

  void test("source failure after delivery errors the body without an additional event", async (t) => {
    const input = source(t);
    const reader = sse(input.stream).body!.getReader();
    input.controller.enqueue({ value: 1 });
    assert.equal((await reader.read()).done, false);
    const failure = new Error("private failure");
    input.controller.error(failure);
    await assert.rejects(reader.read(), (error: unknown) => error === failure);
  });

  void test("client disconnect cancels the SSE producer", async (t) => {
    const input = source(t);
    const { server, errors } = await start(t, input.stream);
    const controller = new AbortController();
    t.after(() => controller.abort());
    const response = await fetch(server.url, { signal: controller.signal });
    const reader = response.body!.getReader();
    input.controller.enqueue({ value: 1 });
    assert.equal((await reader.read()).done, false);
    controller.abort();
    await input.cancelled;
    assert.equal(input.reasons.length, 1);
    assert.deepEqual(errors, []);
  });

  void test("source failure after headers terminates HTTP without a replacement response", async (t) => {
    const input = source(t);
    const { server, errors } = await start(t, input.stream);
    const response = await fetch(server.url);
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    input.controller.enqueue({ value: 1 });
    assert.equal((await reader.read()).done, false);
    const rejected = assert.rejects(reader.read());
    input.controller.error(new Error("private failure"));
    await rejected;
    assert.deepEqual(errors, []);
  });
});
