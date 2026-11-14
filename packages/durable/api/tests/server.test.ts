import { once } from "node:events";
import assert from "node:assert/strict";
import { test } from "node:test";
import { startServer, runMain } from "./fixtures.ts";

await test("server converts resolver failures and propagates application shutdown failures", async (t) => {
  const running = await startServer(t);
  const failure = new Error("close failed");
  t.mock.method(running.app.api, "graphql", async () => {
    throw new Error("resolver failed");
  });
  const close = t.mock.method(running.app, "close", async () => {
    throw failure;
  });
  const response = await fetch(new URL("/api/graphql", running.server.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "{ test }" }),
  });
  assert.equal(response.status, 500);
  process.emit("SIGINT");
  await assert.rejects(running.done, (error: unknown) => error === failure);
  assert.equal(close.mock.callCount(), 1);
});

await test("Node entrypoint serves GraphQL and releases its listener on shutdown", async (t) => {
  const running = await startServer(t);
  const response = await fetch(new URL("/api/graphql", running.server.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "{ harnesses { externalId } }" }),
  });
  assert.equal(response.status, 200);
  const payload = (await response.json()) as { data: { harnesses: unknown[] } };
  assert.deepEqual(payload.data.harnesses, []);
  const observation = await fetch(
    new URL("/api/watch?externalId=absent&conversationId=1", running.server.url),
  );
  assert.equal(observation.status, 404);
  const missingRoute = await fetch(new URL("/not-found", running.server.url));
  assert.equal(missingRoute.status, 404);
  process.emit("SIGTERM");
  assert.equal(await running.shutdown(), undefined);
  await assert.rejects(fetch(running.server.url));

  const listeners = process.listenerCount("SIGTERM");
  process.env.HOST = "256.256.256.256";
  await assert.rejects(runMain());
  assert.equal(process.listenerCount("SIGTERM"), listeners);
});

await test("OAuth callbacks use the production router and do not expose failures", async (t) => {
  const running = await startServer(t);
  const { Problem } = await import("../src/problem.ts");
  let failure: Error | undefined;
  const callback = t.mock.method(running.app.api, "oauthCallback", async () => {
    if (failure) throw failure;
  });
  const url = new URL("/api/oauth/callback?code=private", running.server.url);
  assert.equal((await fetch(url, { method: "POST" })).status, 405);
  assert.equal(callback.mock.callCount(), 0);
  const accepted = await fetch(url);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers.get("referrer-policy"), "no-referrer");
  failure = new Problem(400);
  assert.equal((await fetch(url)).status, 400);
  failure = new Error("private");
  assert.equal((await fetch(url)).status, 500);
});

await test("CLI invocation rejects invalid deployment configuration", async () => {
  const { spawn } = await import("node:child_process");
  const child = spawn(
    process.execPath,
    ["--conditions=development", new URL("../src/index.ts", import.meta.url).pathname],
    {
      env: { ...process.env, PORT: "invalid" },
      stdio: "ignore",
    },
  );
  const [code, signal] = await once(child, "exit");
  assert.equal(code, 1);
  assert.equal(signal, null);
});
