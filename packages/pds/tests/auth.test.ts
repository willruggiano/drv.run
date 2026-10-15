import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { hostModels } from "../src/auth.ts";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "pds-auth-"));
  const socket = join(directory, "owner.sock");
  const calls: { method: string | undefined; path: string | undefined }[] = [];
  const reply: { status: unknown; token: unknown; code: number; raw?: string; hold: boolean } = {
    status: { state: "not-enrolled", account_id: null },
    token: {},
    code: 200,
    hold: false,
  };
  const server = createServer((request, response) => {
    calls.push({ method: request.method, path: request.url });
    if (reply.hold) return;
    response.writeHead(reply.code, { "Content-Type": "application/json" });
    response.end(
      reply.raw ?? JSON.stringify(request.url === "/openai/status" ? reply.status : reply.token),
    );
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  });
  server.listen(socket);
  await once(server, "listening");
  return { socket, server, reply, calls, models: hostModels(socket) };
}

function token(generation: number) {
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "account-me" },
      generation,
    }),
  ).toString("base64url");
  return {
    access_token: `header.${payload}.signature`,
    account_id: "account-me",
    expires_at: Date.now() / 1000 + 3600,
  };
}

await test("PDS reuses host Codex auth and resolves refreshed tokens for each request without changing transport", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.models.getAvailable("openai-codex"), []);
  f.reply.status = { state: "usable", account_id: "account-me" };
  const available = await f.models.getAvailable("openai-codex");
  const model = available[0];
  assert(model);
  assert.deepEqual(f.calls, [
    { method: "GET", path: "/openai/status" },
    { method: "GET", path: "/openai/status" },
  ]);
  assert.equal(f.models.getProvider("openai-codex")?.auth.oauth, undefined);
  let requests = 0;
  for (const generation of [1, 2]) {
    const credential = token(generation);
    f.reply.token = credential;
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
          assert.equal(headers.get("authorization"), `Bearer ${credential.access_token}`);
          assert.equal(headers.get("chatgpt-account-id"), credential.account_id);
          return new Response(
            `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } } })}\n\n`,
            { headers: { "Content-Type": "text/event-stream" } },
          );
        },
      },
    );
    assert.equal(result.stopReason, "stop");
  }
  assert.equal(requests, 2);
  assert.deepEqual(f.calls.slice(2), [
    { method: "POST", path: "/openai/token" },
    { method: "POST", path: "/openai/token" },
  ]);
  // Revocation takes effect without restarting PDS; no previously resolved token is cached.
  f.reply.status = { state: "not-enrolled", account_id: null };
  assert.deepEqual(await f.models.getAvailable("openai-codex"), []);
  f.reply.code = 503;
  await assert.rejects(f.models.getAuth("openai-codex"), { code: "auth" });
});

await test("host availability uses status only and missing sockets do not hide other providers", async (t) => {
  const f = await fixture(t);
  for (const state of ["not-enrolled", "reauthorization-required", "authorizing"]) {
    f.reply.status = { state, account_id: "account-me" };
    assert.equal(await f.models.checkAuth("openai-codex"), undefined);
  }
  f.reply.status = { state: "temporarily-unavailable", account_id: null };
  assert.equal(await f.models.checkAuth("openai-codex"), undefined);
  f.reply.status = { state: "temporarily-unavailable", account_id: "account-me" };
  assert.deepEqual(await f.models.checkAuth("openai-codex"), {
    type: "oauth",
    source: "Host OpenAI OAuth",
  });
  assert(f.calls.every((call) => call.method === "GET" && call.path === "/openai/status"));
  const missing = hostModels(f.socket + ".missing");
  assert.deepEqual(await missing.getAvailable("openai-codex"), []);
  await assert.rejects(missing.getAuth("openai-codex"), { code: "auth" });
  const openai = missing.getProvider("openai");
  assert(openai?.auth.apiKey);
  assert(openai.auth.oauth);
  const auth = await openai.auth.apiKey.resolve({
    ctx: {
      env: async (name) => (name === "OPENAI_API_KEY" ? "test-api-key" : undefined),
      fileExists: async () => false,
    },
    signal: new AbortController().signal,
  });
  assert.deepEqual(auth, { auth: { apiKey: "test-api-key" }, source: "OPENAI_API_KEY" });
});

await test("host auth rejects malformed, expired, oversized, and unsuccessful responses", async (t) => {
  const f = await fixture(t);
  for (const value of [
    null,
    [],
    {},
    { ...token(1), access_token: "not-a-jwt" },
    { ...token(1), account_id: "" },
    { ...token(1), expires_at: 0 },
    { ...token(1), expires_at: "future" },
    { ...token(1), expires_at: 1e20 },
    { ...token(1), padding: "x".repeat(65_536) },
  ]) {
    f.reply.token = value;
    await assert.rejects(f.models.getAuth("openai-codex"), { code: "auth" });
  }
  for (const status of [
    null,
    [],
    {},
    { state: "unknown" },
    { state: "usable", account_id: null },
    { state: "usable", account_id: "account-me", padding: "x".repeat(16_384) },
  ]) {
    f.reply.status = status;
    await assert.rejects(f.models.checkAuth("openai-codex"), { code: "auth" });
  }
  f.reply.raw = "{invalid JSON";
  await assert.rejects(f.models.getAuth("openai-codex"), { code: "auth" });
  await assert.rejects(f.models.checkAuth("openai-codex"), { code: "auth" });
  delete f.reply.raw;
  f.reply.token = token(1);
  for (const code of [403, 503]) {
    f.reply.code = code;
    await assert.rejects(f.models.getAuth("openai-codex"), { code: "auth" });
    await assert.rejects(f.models.checkAuth("openai-codex"), { code: "auth" });
  }
});

await test("cancelling host auth closes the socket", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.models.getAuth("openai-codex", { signal: AbortSignal.abort() }), {
    name: "AbortError",
  });
  assert.equal(f.calls.length, 0);
  f.reply.hold = true;
  const received = Promise.withResolvers<void>();
  const disconnected = Promise.withResolvers<void>();
  f.server.once("request", (request) => {
    request.socket.once("close", () => disconnected.resolve());
    received.resolve();
  });
  const controller = new AbortController();
  const pending = f.models.getAuth("openai-codex", { signal: controller.signal });
  await received.promise;
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  await disconnected.promise;
  assert.deepEqual(f.calls, [{ method: "POST", path: "/openai/token" }]);
});
