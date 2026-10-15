import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type RequestListener } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { ModelsError } from "@earendil-works/pi-ai/models";
import { hostOpenAIAuth } from "../src/host-auth.ts";
import { readDeploymentConfiguration } from "../src/configuration.ts";
import { openApplication } from "../src/application.ts";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "host-openai-"));
  const socketPath = join(directory, "auth.sock");
  const calls: { method: string | undefined; path: string | undefined }[] = [];
  let status: unknown = { state: "not-enrolled", account_id: null };
  let token: unknown;
  let handler: RequestListener = (request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(request.url === "/openai/status" ? status : token));
  };
  const server = createServer((request, response) => {
    calls.push({ method: request.method, path: request.url });
    handler(request, response);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  });
  server.listen(socketPath);
  await once(server, "listening");
  const models = builtinModels();
  const provider = models.getProvider("openai-codex");
  assert(provider);
  models.setProvider({ ...provider, auth: hostOpenAIAuth(socketPath) });
  return {
    directory,
    socketPath,
    models,
    provider,
    calls,
    status(value: unknown) {
      status = value;
    },
    token(value: unknown) {
      token = value;
    },
    respond(value: RequestListener) {
      handler = value;
    },
  };
}

await test("host OpenAI availability uses status without retrieving tokens", async (t) => {
  const f = await fixture(t);
  const available = () => f.models.getAvailable("openai-codex");
  for (const state of [
    "not-enrolled",
    "authorizing",
    "reauthorization-required",
    "temporarily-unavailable",
  ]) {
    f.status({ state });
    assert.deepEqual(await available(), []);
    f.status({ state, account_id: null });
    assert.deepEqual(await available(), []);
  }
  for (const state of ["usable", "temporarily-unavailable"]) {
    f.status({ state, account_id: "account-alice" });
    assert.deepEqual(await available(), f.provider.getModels());
    assert.deepEqual(await f.models.checkAuth("openai-codex"), {
      source: "Host OpenAI OAuth",
      type: "oauth",
    });
  }
  f.status({ state: "reauthorization-required", account_id: "account-alice" });
  assert.deepEqual(await available(), []);
  assert(f.calls.every((call) => call.method === "GET" && call.path === "/openai/status"));
  for (const status of [
    null,
    {},
    { state: "unknown" },
    { state: "usable" },
    { state: "usable", account_id: "" },
  ]) {
    f.status(status);
    await assert.rejects(available(), ModelsError);
  }
});

await test("Codex requests use current host JWTs without changing transport or catalog", async (t) => {
  const f = await fixture(t);
  const model = f.provider.getModels()[0];
  assert(model);
  let requests = 0;
  for (const generation of [1, 2]) {
    const accountId = `account-${generation}`;
    const payload = Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: accountId },
        generation,
      }),
    ).toString("base64url");
    const token = `header.${payload}.signature`;
    f.token({ access_token: token, account_id: accountId, expires_at: Date.now() / 1000 + 3600 });
    const result = await f.models.completeSimple(
      model,
      { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
      {
        transport: "sse",
        fetch: async (input, init) => {
          requests++;
          assert.equal(
            input instanceof Request ? input.url : input.toString(),
            "https://chatgpt.com/backend-api/codex/responses",
          );
          const headers = new Headers(init?.headers);
          assert.equal(headers.get("authorization"), `Bearer ${token}`);
          assert.equal(headers.get("chatgpt-account-id"), accountId);
          return new Response(
            `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } } })}\n\n`,
            {
              headers: { "Content-Type": "text/event-stream" },
            },
          );
        },
      },
    );
    assert.equal(result.stopReason, "stop");
  }
  assert.equal(requests, 2);
  assert.deepEqual(f.calls, [
    { method: "POST", path: "/openai/token" },
    { method: "POST", path: "/openai/token" },
  ]);
});

await test("token responses must contain an unexpired JWT and account identity", async (t) => {
  const f = await fixture(t);
  const valid = {
    access_token: "header.payload.signature",
    account_id: "account-alice",
    expires_at: Date.now() / 1000 + 3600,
  };
  for (const token of [
    null,
    {},
    { ...valid, access_token: "not-a-jwt" },
    { ...valid, account_id: "" },
    { ...valid, expires_at: "later" },
    { ...valid, expires_at: 9e12 },
    { ...valid, expires_at: 1 },
  ]) {
    f.token(token);
    await assert.rejects(f.models.getAuth("openai-codex"), ModelsError);
  }
});

await test("missing sockets disable discovery but cannot supply credentials", async (t) => {
  const f = await fixture(t);
  f.models.setProvider({ ...f.provider, auth: hostOpenAIAuth(join(f.directory, "missing.sock")) });
  assert.deepEqual(await f.models.getAvailable("openai-codex"), []);
  await assert.rejects(f.models.getAuth("openai-codex"), ModelsError);
});

await test("host failures, malformed JSON and oversized responses fail closed", async (t) => {
  const f = await fixture(t);
  for (const operation of [
    () => f.models.getAvailable("openai-codex"),
    () => f.models.getAuth("openai-codex"),
  ]) {
    for (const reply of [
      { status: 503, body: "private upstream error" },
      { status: 200, body: "invalid JSON" },
      { status: 200, body: "x".repeat(65_537) },
    ]) {
      f.respond((_request, response) => {
        response.writeHead(reply.status);
        response.end(reply.body);
      });
      await assert.rejects(operation(), (error: unknown) => {
        assert(error instanceof ModelsError);
        assert(error.cause instanceof Error);
        assert.equal(error.cause.cause, undefined);
        return true;
      });
    }
  }
  f.respond((request) => request.socket.destroy());
  await assert.rejects(f.models.getAvailable("openai-codex"), ModelsError);
  await assert.rejects(f.models.getAuth("openai-codex"), ModelsError);
});

await test("host requests honor caller cancellation and enforce a timeout", async (t) => {
  const f = await fixture(t);
  for (const timeout of [false, true]) {
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    f.respond((_request, response) => {
      response.once("close", () => closed.resolve());
      response.writeHead(200);
      response.write("{");
      entered.resolve();
    });
    if (timeout)
      t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
        assert.equal(milliseconds, 35_000);
        return controller.signal;
      });
    const operation = f.models.getAuth(
      "openai-codex",
      timeout ? {} : { signal: controller.signal },
    );
    const rejected = assert.rejects(operation);
    await entered.promise;
    controller.abort();
    await rejected;
    await closed.promise;
  }
});

await test("application exposes host-authorized Codex models without local OAuth enrollment", async (t) => {
  const f = await fixture(t);
  const config = readDeploymentConfiguration({
    OPENAI_AUTH_SOCKET: f.socketPath,
    XDG_STATE_HOME: join(f.directory, "state"),
    XDG_CONFIG_HOME: join(f.directory, "config"),
    XDG_RUNTIME_DIR: join(f.directory, "runtime"),
  });
  const app = await openApplication(config);
  t.after(() => app.close());
  const query = async () => {
    const result = await app.api.graphql(
      { source: "{ models { provider id } accounts(limit: 10) { nodes { id } } }" },
      new AbortController().signal,
    );
    assert.equal(result.errors, undefined);
    const data = result.data as {
      models: { provider: string; id: string }[];
      accounts: { nodes: unknown[] };
    };
    assert.deepEqual(data.accounts.nodes, []);
    return data.models;
  };
  const initial = await query();
  assert(!initial.some((model) => model.provider === "openai-codex"));
  f.status({ state: "usable", account_id: "account-alice" });
  const authorized = await query();
  assert.deepEqual(
    authorized.filter((model) => model.provider === "openai-codex").map((model) => model.id),
    f.provider.getModels().map((model) => model.id),
  );
  assert.deepEqual(
    authorized.filter((model) => model.provider !== "openai-codex"),
    initial,
  );
  f.status({ state: "not-enrolled", account_id: null });
  assert.deepEqual(await query(), initial);
  assert(f.calls.every((call) => call.path === "/openai/status"));
});
