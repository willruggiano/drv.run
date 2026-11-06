import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import type { Harness } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { createApi } from "durable-api";
import { openHarness, serve } from "./fixtures.ts";

void test("concurrent requests share one open; cancelling a waiter does not cancel opening", async (t) => {
  const { harness } = await openHarness(t);
  const opened = Promise.withResolvers<void>();
  const release = Promise.withResolvers<Harness>();
  let opens = 0;
  const { api, url, server } = await serve(t, {
    async openHarness(id, context) {
      assert.equal(id, "test");
      assert.equal(context.abortSignal, undefined);
      opens++;
      opened.resolve();
      return release.promise;
    },
  });
  const disconnected = Promise.withResolvers<void>();
  server.once("request", (_request, response) => response.once("close", disconnected.resolve));
  const controller = new AbortController();
  const first = fetch(`${url}/inspect`, { signal: controller.signal });
  await opened.promise;
  controller.abort();
  await assert.rejects(first, { name: "AbortError" });
  await disconnected.promise;
  const second = fetch(`${url}/inspect`);
  release.resolve(harness);
  assert.equal((await second).status, 200);
  assert.equal((await fetch(`${url}/inspect`)).status, 200);
  assert.equal(opens, 1);
  let closes = 0;
  harness.subscribeClose(() => closes++);
  const closing = api.close();
  assert.equal(api.close(), closing);
  await closing;
  assert.equal(closes, 1);
  assert.equal((await fetch(`${url}/inspect`)).status, 503);
});

void test("missing sessions are not cached and escaped session IDs remain opaque", async (t) => {
  const { harness } = await openHarness(t);
  let available = false;
  const ids: string[] = [];
  const { url } = await serve(t, {
    async openHarness(id) {
      ids.push(id);
      return available ? harness : undefined;
    },
  });
  const path = `${url.replace("test", "some%20session")}/inspect`;
  assert.equal((await fetch(path)).status, 404);
  available = true;
  assert.equal((await fetch(path)).status, 200);
  assert.deepEqual(ids, ["some session", "some session"]);
});

void test("shutdown joins an in-flight open and closes its result without serving the waiter", async (t) => {
  const { harness } = await openHarness(t);
  const opened = Promise.withResolvers<void>();
  const release = Promise.withResolvers<Harness>();
  const { api, url } = await serve(t, {
    async openHarness() {
      opened.resolve();
      return release.promise;
    },
  });
  const request = fetch(`${url}/inspect`);
  await opened.promise;
  const closing = api.close();
  release.resolve(harness);
  assert.equal((await request).status, 503);
  await closing;
  assert.deepEqual(await harness.closed, { reason: "closed" });
});

void test("shutdown tolerates an unsuccessful open and open failures can be retried", async (t) => {
  const opened = Promise.withResolvers<void>();
  const release = Promise.withResolvers<Harness>();
  let opens = 0;
  const { api, url } = await serve(t, {
    async openHarness() {
      if (++opens === 1) throw new Error("open failed");
      opened.resolve();
      return release.promise;
    },
  });
  assert.equal((await fetch(`${url}/inspect`)).status, 500);
  const request = fetch(`${url}/inspect`);
  await opened.promise;
  const closing = api.close();
  release.reject(new Error("second open failed"));
  await closing;
  assert.equal((await request).status, 500);
  assert.equal(opens, 2);
});

void test("shutdown attempts every Harness and reports close failures", async (t) => {
  const first = await openHarness(t);
  const second = await openHarness(t);
  const error = new Error("close failed");
  const close = t.mock.method(first.harness, "close", async () => {
    throw error;
  });
  const api = createApi({
    models: createModels(),
    openHarness: async (id) => (id === "first" ? first.harness : second.harness),
  });
  const server = createServer(api.handle).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  t.after(() => {
    close.mock.restore();
    server.closeAllConnections();
    server.close();
  });
  for (const id of ["first", "second"])
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/s/${id}/inspect`)).status, 200);
  await assert.rejects(api.close(), (failure: unknown) => {
    assert(failure instanceof AggregateError);
    assert.deepEqual(failure.errors, [error]);
    return true;
  });
  close.mock.restore();
  assert.deepEqual(await second.harness.closed, { reason: "closed" });
});
