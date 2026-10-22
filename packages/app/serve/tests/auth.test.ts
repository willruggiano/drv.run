import assert from "node:assert/strict";
import { test } from "node:test";
import { request } from "node:http";
import { ProxyAuthorization } from "../auth.ts";
import { FormError } from "../hypermedia.ts";
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

await test("/auth is unauthenticated but mutations require same-origin POSTs and cannot choose an owner", async (t) => {
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
  const page = await fetch(base + "/auth");
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "no-store");
  await page.body?.cancel();
  for (const [path, options, code] of [
    ["/auth/login", { method: "GET" }, 404],
    ["/auth/login", { method: "POST" }, 403],
    ["/auth/login", { method: "POST", headers: { Origin: "http://attacker.invalid" } }, 403],
    ["/auth/logout", { method: "POST", headers: { Origin: "null" } }, 403],
    ["/auth", { method: "DELETE", headers: { Origin: base } }, 405],
  ] as const) {
    const response = await fetch(base + path, options);
    assert.equal(response.status, code);
    await response.body?.cancel();
    assert.equal((await control.authorization.status()).state, "not-enrolled");
  }
  const rebound = await new Promise<number | undefined>((resolve, reject) => {
    const call = request(
      base + "/auth/login",
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
  const enrolled = await post(base + "/auth/login?user=bob", { user: "bob" });
  assert.equal(enrolled.status, 303);
  assert.equal(enrolled.headers.get("location"), "/auth");
  assert.equal((await control.authorization.status()).userId, 1);
  assert.equal((await control.authorization.status()).state, "authorizing");
  control.approve();
  const removed = await post(base + "/auth/logout", {});
  assert.equal(removed.status, 303);
  assert.equal((await control.authorization.status()).state, "not-enrolled");
});
