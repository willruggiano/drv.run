import { FormError } from "../forms.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { request } from "node:http";
import { ProxyAuthorization } from "../auth.ts";

import { fixture } from "./sessions-testing.ts";
import { authorizationFixture, serve, post } from "./testing.ts";

await test("authorization client exposes only public state and validates device prompts", async (t) => {
  const f = await authorizationFixture(t);
  assert.deepEqual(await f.authorization.status(), {
    state: "not-enrolled",
    userId: 1,
    expiresAt: null,
    error: null,
    device: null,
  });
  await f.authorization.change("login");
  assert.deepEqual(await f.authorization.status(), {
    state: "authorizing",
    userId: 1,
    expiresAt: null,
    error: null,
    device: {
      userCode: "ABCD-EFGH",
      verificationUri: "https://github.com/login/device",
      expiresAt: 1900000900,
    },
  });
  f.reply({
    state: "usable",
    user_id: 1,
    device: null,
    error: null,
    expires_at: 1900028800,
    access_token: "secret",
    refresh_token: "secret",
  });
  assert.deepEqual(await f.authorization.status(), {
    state: "usable",
    userId: 1,
    expiresAt: 1900028800,
    error: null,
    device: null,
  });
  await f.authorization.change("logout");
  assert.equal((await f.authorization.status()).state, "not-enrolled");
  for (const value of [
    null,
    { state: "usable", user_id: 1, device: null, error: null, oversized: "x".repeat(16384) },
    { state: "unexpected", user_id: 1, device: null, error: null },
    {
      state: "authorizing",
      user_id: 1,
      error: null,
      device: {
        user_code: "ABCD-EFGH",
        verification_uri: "https://attacker.invalid",
        expires_at: 1900000900,
      },
    },
    { state: "usable", user_id: 1, device: null, error: null, expires_at: -1 },
  ]) {
    f.reply(value);
    await assert.rejects(
      f.authorization.status(),
      (error) => error instanceof FormError && error.status === 503,
    );
  }
  const missing = new ProxyAuthorization(f.authorization.socketPath + ".missing");
  assert.equal((await missing.status()).state, "unconfigured");
  await assert.rejects(
    missing.change("login"),
    (error) => error instanceof FormError && error.status === 503,
  );
});

await test("settings auth is unauthenticated but mutations require same-origin POSTs and cannot choose an owner", async (t) => {
  const f = await fixture(t);
  const control = await authorizationFixture(t);
  const base = await serve(
    t,
    f.sessions,
    undefined,
    "127.0.0.1",
    undefined,
    undefined,
    control.authorization,
  );
  const page = await fetch(base + "/settings");
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "no-store");
  await page.body?.cancel();
  for (const [path, options, code] of [
    ["/settings/auth/github/login", { method: "GET" }, 405],
    ["/settings/auth/github/login", { method: "POST" }, 403],
    [
      "/settings/auth/github/login",
      { method: "POST", headers: { Origin: "http://attacker.invalid" } },
      403,
    ],
    ["/settings/auth/github/logout", { method: "POST", headers: { Origin: "null" } }, 403],
    ["/settings", { method: "DELETE", headers: { Origin: base } }, 405],
  ] as const) {
    const response = await fetch(base + path, options);
    assert.equal(response.status, code);
    await response.body?.cancel();
    assert.equal((await control.authorization.status()).state, "not-enrolled");
  }
  const rebound = await new Promise<number | undefined>((resolve, reject) => {
    const call = request(
      base + "/settings/auth/github/login",
      { method: "POST", headers: { Origin: base, Host: "attacker.invalid" } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    call.once("error", reject);
    call.end();
  });
  assert.equal(rebound, 403);
  assert.equal((await control.authorization.status()).state, "not-enrolled");
  const enrolled = await post(base + "/settings/auth/github/login?user=bob", { user: "bob" });
  assert.equal(enrolled.status, 200);
  assert.deepEqual(await enrolled.json(), { saved: true });
  assert.equal((await control.authorization.status()).userId, 1);
  assert.equal((await control.authorization.status()).state, "authorizing");
  control.approve();
  const removed = await post(base + "/settings/auth/github/logout", {});
  assert.equal(removed.status, 200);
  assert.equal((await control.authorization.status()).state, "not-enrolled");
});

await test("host Codex auth resolves current JWTs from the credential service without changing the transport", async (t) => {
  const { hostModels } = await import("../auth.ts");
  const f = await authorizationFixture(t);
  const models = hostModels(f.authorization);
  assert.deepEqual(await models.getAvailable("openai-codex"), []);
  await f.authorization.change("login", undefined, "openai");
  assert.equal(
    (await f.authorization.status(undefined, "openai")).device?.verificationUri,
    "https://auth.openai.com/codex/device",
  );
  assert.equal((await f.authorization.status()).state, "not-enrolled");
  f.approve("openai");
  const available = await models.getAvailable("openai-codex");
  assert.ok(available.length > 0);
  assert.equal(
    f.calls.some((call) => call.path === "/openai/token"),
    false,
  );
  const model = available[0];
  let requests = 0;
  for (const generation of [1, 2]) {
    const payload = Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: "account-alice" },
        generation,
      }),
    ).toString("base64url");
    const token = `header.${payload}.signature`;
    f.token({ access_token: token, account_id: "account-alice", expires_at: 2100000000 });
    const result = await models.completeSimple(
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
          assert.equal(headers.get("chatgpt-account-id"), "account-alice");
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
  assert.equal(f.calls.filter((call) => call.path === "/openai/token").length, 2);
  await f.authorization.change("logout", undefined, "openai");
  assert.deepEqual(await models.getAvailable("openai-codex"), []);
  await assert.rejects(
    f.authorization.openaiToken(),
    (error) => error instanceof FormError && error.status === 503,
  );
});

await test("OpenAI token retrieval rejects invalid, expired, missing and cancelled responses", async (t) => {
  const f = await authorizationFixture(t);
  for (const value of [
    {},
    { access_token: "not-a-jwt", expires_at: 2100000000, account_id: "account-alice" },
    { access_token: "header.payload.signature", expires_at: 1, account_id: "account-alice" },
    { access_token: "header.payload.signature", expires_at: 2100000000, account_id: "" },
    { access_token: "x".repeat(16384), expires_at: 2100000000, account_id: "account-alice" },
  ]) {
    f.token(value);
    await assert.rejects(
      f.authorization.openaiToken(),
      (error) => error instanceof FormError && error.status === 503,
    );
  }
  await assert.rejects(f.authorization.openaiToken(AbortSignal.abort()));
  const missing = new ProxyAuthorization(f.authorization.socketPath + ".missing");
  assert.equal((await missing.status(undefined, "openai")).state, "unconfigured");
  await assert.rejects(missing.openaiToken());
  f.reply(
    {
      state: "authorizing",
      user_id: null,
      error: null,
      device: {
        user_code: "ABCD-EFGH",
        verification_uri: "https://attacker.invalid",
        expires_at: 2100000000,
      },
    },
    "openai",
  );
  await assert.rejects(f.authorization.status(undefined, "openai"));
});

await test(`elm: OpenAI enrollment is owner-bound and never exposes the token endpoint to HTTP`, async (t) => {
  const f = await fixture(t);
  const control = await authorizationFixture(t);
  const base = await serve(
    t,
    f.sessions,
    undefined,
    "127.0.0.1",
    undefined,
    undefined,
    control.authorization,
  );
  for (const [path, options, expected] of [
    [`/auth`, {}, 404],
    [`/auth/openai/login`, { method: "POST", headers: { Origin: base } }, 404],
    [`/settings/auth/openai/token`, {}, 404],
    [`/settings/auth/openai/token`, { method: "POST", headers: { Origin: base } }, 404],
    [`/settings/auth/openai/login`, { method: "POST" }, 403],
    [
      `/settings/auth/openai/login`,
      { method: "POST", headers: { Origin: "https://attacker.invalid" } },
      403,
    ],
  ] as const) {
    const response = await fetch(base + path, options);
    assert.equal(response.status, expected);
    await response.body?.cancel();
  }
  assert.equal(control.calls.length, 0);
  const enrolled = await post(`${base}/settings/auth/openai/login?user=bob`, {
    user: "bob",
  });
  assert.equal(enrolled.status, 200);
  await enrolled.body?.cancel();
  assert.equal((await control.authorization.status(undefined, "openai")).state, "authorizing");
  assert.equal((await control.authorization.status()).state, "not-enrolled");
  control.approve("openai");

  const response = await fetch(base + "/settings?data");
  const data = (await response.json()) as { kind: string; providers: unknown[] };
  assert.equal(data.kind, "settings");
  assert.deepEqual(data.providers[0], {
    id: "openai",
    label: "OpenAI",
    state: "usable",
    identity: "account-alice",
    failed: false,
    device: null,
  });

  const removed = await post(`${base}/settings/auth/openai/logout`, {});
  assert.equal(removed.status, 200);
  await removed.body?.cancel();
  assert.equal((await control.authorization.status(undefined, "openai")).state, "not-enrolled");
  assert.equal(
    control.calls.some((call) => call.path === "/openai/token"),
    false,
  );
});
