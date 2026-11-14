import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main } from "../src/index.ts";
import { readDeploymentConfiguration } from "../src/configuration.ts";

await test("server converts resolver failures and aggregates application shutdown failures", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "durable-api-server-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const config = readDeploymentConfiguration(
    {
      XDG_CONFIG_HOME: join(directory, "config"),
    },
    1000,
    directory,
  );
  const failure = new Error("close failed");
  let closed = false;
  const running = await main({ ...config, server: { ...config.server, port: 0 } }, async () => ({
    api: {
      async graphql() {
        throw new Error("resolver failed");
      },
      watch() {
        return Promise.resolve(new ReadableStream());
      },
    },
    async close() {
      closed = true;
      throw failure;
    },
  }));
  t.after(async () => running.shutdown().catch(() => {}));
  const response = await fetch(new URL("/api/graphql", running.server.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "{ test }" }),
  });
  assert.equal(response.status, 500);
  process.emit("SIGINT");
  await assert.rejects(running.shutdown(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [failure]);
    return true;
  });
  assert.equal(closed, true);
});

await test("Node entrypoint serves GraphQL and closes application resources on startup failure", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "durable-api-server-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const config = readDeploymentConfiguration(
    {
      XDG_CONFIG_HOME: join(directory, "config"),
      XDG_RUNTIME_DIR: join(directory, "runtime"),
      XDG_STATE_HOME: join(directory, "instance-state"),
    },
    1000,
    directory,
  );
  const running = await main({ ...config, server: { ...config.server, port: 0 } });
  try {
    const response = await fetch(new URL("/api/graphql", running.server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ harnesses { externalId } }" }),
    });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      data: { harnesses: unknown[] };
    };
    assert.deepEqual(payload.data.harnesses, []);
    const observation = await fetch(
      new URL("/api/watch?externalId=absent&conversationId=1", running.server.url),
    );
    assert.equal(observation.status, 404);
    const missingRoute = await fetch(new URL("/not-found", running.server.url));
    assert.equal(missingRoute.status, 404);
  } finally {
    process.emit("SIGTERM");
    await running.shutdown();
  }

  let closed = false;
  await assert.rejects(
    main({ ...config, server: { host: "256.256.256.256", port: 8080 } }, async () => ({
      api: {
        async graphql() {
          return {};
        },
        watch() {
          return Promise.resolve(new ReadableStream());
        },
      },
      async close() {
        closed = true;
      },
    })),
  );
  assert.equal(closed, true);
});
