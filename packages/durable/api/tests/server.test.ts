import { once } from "node:events";
import { mkdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
  assert.equal((await fetch(new URL("/api/oauth/callback", running.server.url))).status, 400);
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
  const running = await startServer(t, { ORIGIN: "https://app.example" });
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

await test("authorization callbacks cross the HTTP listener with the configured HTTPS redirect", async (t) => {
  const origin = "https://app.example";
  const running = await startServer(t, {
    ORIGIN: origin,
    OAUTH_SERVERS: JSON.stringify([
      {
        id: "example",
        label: "Example",
        provider: "openai",
        client_id: "client",
        metadata: {
          issuer: "https://issuer.example",
          authorization_endpoint: "https://issuer.example/authorize",
          token_endpoint: "https://issuer.example/token",
          grant_types_supported: ["authorization_code"],
        },
      },
    ]),
  });
  const signal = new AbortController().signal;
  const catalog = await running.app.api.graphql(
    { source: "{ authorizationServers(limit:1) { nodes { id } } }" },
    signal,
  );
  assert.equal(catalog.errors, undefined);
  const { authorizationServers } = catalog.data as {
    authorizationServers: { nodes: { id: string }[] };
  };
  const started = await running.app.api.graphql(
    {
      source:
        "mutation($server:ID!) { authorize(input:{serverId:$server}) { id request { redirect_uri state } } }",
      variableValues: { server: authorizationServers.nodes[0]!.id },
    },
    signal,
  );
  assert.equal(started.errors, undefined);
  const { authorize } = started.data as {
    authorize: { id: string; request: { redirect_uri: string; state: string } };
  };
  const transport = globalThis.fetch;
  let exchanges = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== "https://issuer.example") return transport(input, init);
    assert(init?.body instanceof URLSearchParams);
    assert.equal(init.body.get("redirect_uri"), authorize.request.redirect_uri);
    exchanges++;
    return Response.json({ token_type: "bearer", access_token: "private" });
  });
  const callback = new URL("/api/oauth/callback", running.server.url);
  callback.search = new URLSearchParams({
    state: authorize.request.state,
    code: "private-code",
  }).toString();
  const response = await fetch(callback, {
    headers: { "X-Forwarded-Host": "untrusted.example", "X-Forwarded-Proto": "http" },
  });
  assert.equal(response.status, 200);
  assert.equal(exchanges, 1);
  const completed = await running.app.api.graphql(
    {
      source: "query($id:ID!) { node(id:$id) { ... on Authorization { status } } }",
      variableValues: { id: authorize.id },
    },
    signal,
  );
  assert.equal(completed.errors, undefined);
  assert(completed.data);
  assert.equal((completed.data.node as { status: string }).status, "completed");
});

await test("service diagnostics remain server-side through the HTTP GraphQL boundary", async (t) => {
  const running = await startServer(t);
  const { readDeploymentConfiguration } = await import("../src/configuration.ts");
  const directory = join(readDeploymentConfiguration().configDirectory, "web");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "settings.json"), "invalid JSON");
  const response = await fetch(new URL("/api/graphql", running.server.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "{ settings(app:web) { __typename } }" }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result, {
    data: { settings: null },
    errors: [
      {
        message: "INTERNAL_SERVER_ERROR",
        locations: [{ line: 1, column: 3 }],
        path: ["settings"],
        extensions: { code: "INTERNAL_SERVER_ERROR" },
      },
    ],
  });
});

await test("the production listener serves www assets and navigation documents alongside GraphQL", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "www-assets-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const assets = [
    ["/", "index.html", "text/html; charset=utf-8"],
    ["/main.js", "main.js", "text/javascript; charset=utf-8"],
    ["/bootstrap.js", "bootstrap.js", "text/javascript; charset=utf-8"],
    ["/styles.css", "styles.css", "text/css; charset=utf-8"],
  ] as const;
  const bytes = Uint8Array.from([1, 2, 3]);
  for (const [, file] of assets) await writeFile(join(directory, file), bytes);
  const running = await startServer(t, { WWW_ROOT: directory });
  for (const [path, , type] of assets) {
    const url = new URL(path, running.server.url);
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), type);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert(response.headers.has("content-security-policy"));
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
    const head = await fetch(url, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    const rejected = await fetch(url, { method: "POST" });
    assert.equal(rejected.status, 405);
    assert.equal(rejected.headers.get("allow"), "GET, HEAD");
  }
  for (const path of [
    "/package.json",
    "/src/index.ts",
    "/%2e%2e%2findex.html",
    "/sessions/alpha",
    "/settings",
  ])
    assert.equal((await fetch(new URL(path, running.server.url))).status, 404);
  for (const path of ["/settings", "/sessions/alpha", "/unknown"]) {
    const response = await fetch(new URL(path, running.server.url), {
      headers: { accept: "text/html,application/xhtml+xml" },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  }
  assert.equal(
    (await fetch(new URL("/api/unknown", running.server.url), { headers: { accept: "text/html" } }))
      .status,
    404,
  );
  const result = await fetch(new URL("/api/graphql", running.server.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "{ harnesses { externalId } }" }),
  });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { data: { harnesses: [] } });
});
