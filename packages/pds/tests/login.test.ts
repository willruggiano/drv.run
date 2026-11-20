import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import lockfile from "proper-lockfile";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type * as A from "@earendil-works/pi-ai";
import { hostAuth } from "../src/auth.ts";
import { LoginError, ModelAuth } from "../src/login.ts";
import { serve } from "../src/server.ts";
import { authFixture } from "./fixtures.ts";

const noAmbient = { env: async () => undefined, fileExists: async () => false };
const key: A.Credential = { type: "api_key", key: "replacement-secret" };
async function selected(auth: ModelAuth, provider = "openai") {
  const view = (await auth.view(provider)).selected;
  assert(view);
  return view;
}
async function until(
  auth: ModelAuth,
  predicate: (view: Awaited<ReturnType<typeof selected>>) => boolean,
  provider = "openai",
) {
  const signal = AbortSignal.timeout(5000);
  while (true) {
    const view = await selected(auth, provider);
    if (predicate(view)) return view;
    await sleep(5, undefined, { signal });
  }
}
function flow(
  auth: ModelAuth,
  login: (interaction: A.ProviderAuthInteraction) => Promise<A.ApiKeyCredential>,
) {
  const provider = auth.models.getProvider("openai");
  assert(provider?.auth.apiKey);
  auth.models.setProvider({ ...provider, auth: { apiKey: { ...provider.auth.apiKey, login } } });
}
async function answer(auth: ModelAuth, value: string, provider = "openai") {
  const attempt = (await until(auth, (view) => !!view.attempt?.prompt, provider)).attempt;
  assert(attempt?.prompt);
  auth.respond(provider, attempt.id, attempt.prompt.id, value);
  return attempt;
}

await test("generic prompts share one attempt; replacements persist before success and reject stale answers", async (t) => {
  const { auth, path, sessions } = await authFixture(t);
  const original = { openai: { type: "api_key", key: "old" }, unrelated: key };
  await writeFile(path, JSON.stringify(original));
  const inputs: string[] = [];
  flow(auth, async (interaction) => {
    inputs.push(
      await interaction.prompt({ type: "text", message: "Account", placeholder: "Name" }),
    );
    inputs.push(await interaction.prompt({ type: "secret", message: "Secret" }));
    inputs.push(
      await interaction.prompt({
        type: "select",
        message: "Select",
        options: [{ id: "yes", label: "Yes" }],
      }),
    );
    inputs.push(await interaction.prompt({ type: "manual_code", message: "Code" }));
    return key;
  });
  auth.start("openai", "api_key");
  const before = await selected(auth);
  assert(before.attempt?.prompt);
  assert.deepEqual((await selected(auth)).attempt, before.attempt);
  assert.throws(() => auth.start("openai", "api_key"), LoginError);
  assert.equal((await auth.models.getAuth("openai"))?.auth.apiKey, "old");
  const first = await answer(auth, "name");
  await answer(auth, "secret");
  const choice = (await selected(auth)).attempt;
  assert(choice?.prompt);
  assert.throws(
    () => auth.respond("openai", choice.id, choice.prompt!.id, "not-an-option"),
    LoginError,
  );
  assert.throws(
    () => auth.respond("openai", first.id, first.prompt!.id, "late-answer"),
    LoginError,
  );
  await answer(auth, "yes");
  await answer(auth, "manual-code");
  const saved = await until(auth, (view) => view.attempt?.state === "succeeded");
  assert.deepEqual(inputs, ["name", "secret", "yes", "manual-code"]);
  assert.deepEqual(saved.attempt, { id: first.id, state: "succeeded", events: [] });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { openai: key, unrelated: key });
  assert.deepEqual(await sessions.list(), []);
});

await test("per-prompt cancellation withdraws a manual-code prompt without cancelling callback completion", async (t) => {
  const { auth } = await authFixture(t);
  const promptAbort = new AbortController();
  const continueFlow = Promise.withResolvers<void>();
  flow(auth, async (interaction) => {
    await assert.rejects(
      interaction.prompt({ type: "manual_code", message: "Code", signal: promptAbort.signal }),
      { name: "AbortError" },
    );
    assert.equal(interaction.signal.aborted, false);
    await continueFlow.promise;
    return key;
  });
  auth.start("openai", "api_key");
  const attempt = (await selected(auth)).attempt;
  assert(attempt?.prompt);
  promptAbort.abort();
  await until(auth, (view) => !view.attempt?.prompt);
  assert.throws(() => auth.respond("openai", attempt.id, attempt.prompt!.id, "stale"), LoginError);
  continueFlow.resolve();
  await until(auth, (view) => view.attempt?.state === "succeeded");
});

await test("cancel and expiry end login without replacing stored credentials; shutdown and restart never resume it", async (t) => {
  const { auth, path } = await authFixture(t);
  await writeFile(path, JSON.stringify({ openai: key }));
  auth.start("openai", "api_key");
  const attempt = (await selected(auth)).attempt;
  assert(attempt);
  await auth.cancel("openai", attempt.id);
  assert.equal((await selected(auth)).attempt?.state, "cancelled");
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { openai: key });
  flow(auth, async (interaction) => {
    interaction.notify({
      type: "device_code",
      userCode: "EXPIRED",
      verificationUri: "https://example.test/verify",
      expiresInSeconds: 0,
    });
    await interaction.prompt({ type: "manual_code", message: "Code" });
    return key;
  });
  auth.start("openai", "api_key");
  const expired = await until(auth, (view) => view.attempt?.state === "expired");
  assert.deepEqual(expired.attempt?.events, []);
  auth.start("openai", "api_key");
  await auth.close();
  assert.throws(() => auth.start("openai", "api_key"), LoginError);
  const restarted = hostAuth(path, noAmbient);
  t.after(() => restarted.close());
  assert.equal((await selected(restarted)).attempt, undefined);
  assert.equal((await selected(restarted)).stored, "api_key");
});

await test("cancelled lock wait cannot save after the CLI-protocol lock is released", async (t) => {
  const { auth, path } = await authFixture(t);
  await writeFile(path, JSON.stringify({ openai: key }));
  auth.start("openai", "api_key");
  const attempt = (await selected(auth)).attempt;
  assert(attempt?.prompt);
  const release = await lockfile.lock(path, { retries: 0, stale: 30_000 });
  const contended = Promise.withResolvers<void>();
  const lock = lockfile.lock;
  t.mock.method(lockfile, "lock", async (...args: Parameters<typeof lock>) => {
    try {
      return await lock(...args);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ELOCKED")
        contended.resolve();
      throw error;
    }
  });
  auth.respond("openai", attempt.id, attempt.prompt.id, "must-not-save");
  try {
    await contended.promise;
    await auth.cancel("openai", attempt.id);
  } finally {
    await release();
  }
  assert.equal((await selected(auth)).attempt?.state, "cancelled");
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { openai: key });
});

for (const failed of [false, true]) {
  await test(`cancellation during a started commit waits for its actual ${failed ? "failure" : "success"}`, async (t) => {
    const store = new InMemoryCredentialStore();
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const auth = new ModelAuth(
      {
        read: (id, options) => store.read(id, options),
        list: (options) => store.list(options),
        delete: (id, options) => store.delete(id, options),
        modify: (id, fn, options) =>
          store.modify(
            id,
            async (current) => {
              const next = await fn(current);
              entered.resolve();
              await finish.promise;
              assert.equal(options?.signal?.aborted, false);
              if (failed) throw new Error("secret-bearing write failure");
              return next;
            },
            options,
          ),
      },
      noAmbient,
    );
    t.after(async () => {
      finish.resolve();
      await auth.close();
    });
    auth.start("openai", "api_key");
    const attempt = await answer(auth, "replacement-secret");
    await entered.promise;
    let cancelled = false;
    const cancellation = auth.cancel("openai", attempt.id).then(() => {
      cancelled = true;
    });
    assert.equal((await selected(auth)).attempt?.state, "saving");
    assert.equal(cancelled, false);
    finish.resolve();
    await cancellation;
    assert.equal((await selected(auth)).attempt?.state, failed ? "failed" : "succeeded");
    assert.deepEqual(await store.read("openai"), failed ? undefined : key);
  });
}

await test("logout cancels ignored interaction results and serializes against rotating refresh", async (t) => {
  const { auth, path } = await authFixture(t);
  const late = Promise.withResolvers<A.ApiKeyCredential>();
  flow(auth, async () => late.promise);
  auth.start("openai", "api_key");
  await auth.logout("openai");
  late.resolve(key);
  assert.equal((await selected(auth)).logout, "succeeded");
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {});
  const expired: A.OAuthCredential = {
    type: "oauth",
    access: "old",
    refresh: "old-refresh",
    expires: 0,
  };
  await writeFile(path, JSON.stringify({ openai: expired, unrelated: key }));
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<A.OAuthCredential>();
  const provider = auth.models.getProvider("openai");
  assert(provider);
  auth.models.setProvider({
    ...provider,
    auth: {
      oauth: {
        name: "Fixture",
        login: async () => expired,
        refresh: async () => {
          entered.resolve();
          return finish.promise;
        },
        toAuth: async (value) => ({ apiKey: value.access }),
      },
    },
  });
  const refresh = auth.models.getAuth("openai");
  await entered.promise;
  const logout = auth.logout("openai");
  assert.throws(() => auth.start("openai", "oauth"), LoginError);
  finish.resolve({
    ...expired,
    access: "rotated",
    refresh: "rotated",
    expires: Date.now() + 3_600_000,
  });
  await Promise.all([refresh, logout]);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { unrelated: key });
  assert.equal((await selected(auth)).stored, undefined);
});

await test("metadata distinguishes ambient authorization, stored login, and storage failure without exposing credentials", async (t) => {
  const { path } = await authFixture(t);
  const auth = hostAuth(path, { ...noAmbient, env: async () => "ambient-secret" });
  t.after(() => auth.close());
  let view = await selected(auth);
  assert.equal(view.authorized, true);
  assert.equal(view.stored, undefined);
  await writeFile(path, JSON.stringify({ openai: key }));
  view = await selected(auth);
  assert.equal(view.authorized, true);
  assert.equal(view.stored, "api_key");
  await auth.logout("openai");
  view = await selected(auth);
  assert.equal(view.authorized, true);
  assert.equal(view.stored, undefined);
  await writeFile(path, "secret-invalid-json");
  view = await selected(auth);
  assert.equal(view.unavailable, true);
  assert.equal(view.authorized, undefined);
  assert.equal(view.stored, undefined);
  assert.deepEqual(Object.keys(view).sort(), ["id", "logout", "methods", "name", "unavailable"]);
});

await test("prefixed login commands enforce methods, origins and canonical fields without provisioning sessions", async (t) => {
  const { auth, sessions } = await authFixture(t);
  const server = await serve(sessions, { auth, port: 0, origin: "https://pds.test/prefix/" });
  t.after(async () => {
    await server.close();
    assert.equal((await selected(auth)).attempt?.state, "cancelled");
  });
  const post = (action: string, values: Record<string, string>, headers = {}) =>
    fetch(`${server.origin}/prefix/login/${action}`, {
      method: "POST",
      body: new URLSearchParams(values),
      redirect: "manual",
      headers,
    });
  assert.equal((await fetch(`${server.origin}/login`)).status, 404);
  assert.equal((await fetch(`${server.origin}/prefix/login/start`)).status, 405);
  assert.equal(
    (
      await post(
        "start",
        { provider: "openai", method: "api_key" },
        { origin: "https://foreign.test" },
      )
    ).status,
    403,
  );
  assert.equal((await selected(auth)).attempt, undefined);
  assert.equal((await post("start", { provider: "unknown", method: "api_key" })).status, 400);
  assert.equal(
    (await post("start", { provider: "openai", method: "api_key", secret: "unexpected" })).status,
    400,
  );
  const response = await post(
    "start",
    { provider: "openai", method: "api_key" },
    { origin: "https://pds.test" },
  );
  assert.equal(response.status, 303);
  assert.equal(new URL(response.headers.get("location")!, server.origin).pathname, "/prefix/login");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "same-origin");
  assert((await selected(auth)).attempt);
  assert.deepEqual(await sessions.list(), []);
});

await test("a started login commit completes before logout deletes its credential", async (t) => {
  const store = new InMemoryCredentialStore();
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const auth = new ModelAuth(
    {
      read: (id, options) => store.read(id, options),
      list: (options) => store.list(options),
      delete: (id, options) => store.delete(id, options),
      modify: (id, fn, options) =>
        store.modify(
          id,
          async (previous) => {
            const next = await fn(previous);
            entered.resolve();
            await finish.promise;
            return next;
          },
          options,
        ),
    },
    noAmbient,
  );
  t.after(async () => {
    finish.resolve();
    await auth.close();
  });
  auth.start("openai", "api_key");
  await answer(auth, "must-be-removed");
  await entered.promise;
  const logout = auth.logout("openai");
  assert.equal((await selected(auth)).logout, "pending");
  assert.equal((await selected(auth)).attempt?.state, "saving");
  assert.throws(() => auth.start("openai", "api_key"), LoginError);
  finish.resolve();
  await logout;
  assert.equal(await store.read("openai"), undefined);
  assert.equal((await selected(auth)).logout, "succeeded");
  assert.equal((await selected(auth)).attempt, undefined);
});

await test("unsuccessful replacement preserves the old credential and malformed storage is never removed", async (t) => {
  const { auth, path } = await authFixture(t);
  await writeFile(path, JSON.stringify({ openai: key }));
  flow(auth, async () => {
    throw new Error("raw-provider-secret", { cause: key });
  });
  auth.start("openai", "api_key");
  const view = await until(auth, (view) => view.attempt?.state === "failed");
  assert.deepEqual(view.attempt, { id: view.attempt?.id, state: "failed", events: [] });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { openai: key });
  await writeFile(path, "invalid-secret-bearing-record");
  const before = await readFile(path);
  await auth.logout("openai");
  assert.equal((await selected(auth)).logout, "failed");
  assert.deepEqual(await readFile(path), before);
});

await test("interactive login expires at the owner deadline even without provider events", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const auth = new ModelAuth(new InMemoryCredentialStore(), noAmbient);
  t.after(() => auth.close());
  auth.start("openai", "api_key");
  t.mock.timers.tick(15 * 60_000 - 1);
  assert.equal((await selected(auth)).attempt?.state, "pending");
  t.mock.timers.tick(1);
  assert.equal((await selected(auth)).attempt?.state, "expired");
  assert.equal((await selected(auth)).stored, undefined);
});

await test("native Codex device enrollment stays upstream and stores its native credential offline", async (t) => {
  const { auth, path } = await authFixture(t);
  const completed = Promise.withResolvers<void>();
  t.after(() => completed.resolve());
  const access = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64")}.signature`;
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    assert.equal(url.origin, "https://auth.openai.com");
    assert.equal(request.method, "POST");
    requests.push(url.pathname);
    switch (url.pathname) {
      case "/api/accounts/deviceauth/usercode":
        return Response.json({
          device_auth_id: "fixture-device",
          user_code: "ABCD-EFGH",
          interval: 0,
        });
      case "/api/accounts/deviceauth/token":
        assert.deepEqual(await request.json(), {
          device_auth_id: "fixture-device",
          user_code: "ABCD-EFGH",
        });
        await completed.promise;
        return Response.json({
          authorization_code: "fixture-code",
          code_verifier: "fixture-verifier",
        });
      case "/oauth/token": {
        const fields = new URLSearchParams(await request.text());
        assert.equal(fields.get("redirect_uri"), "https://auth.openai.com/deviceauth/callback");
        assert.equal(fields.get("code"), "fixture-code");
        assert.equal(fields.get("code_verifier"), "fixture-verifier");
        return Response.json({
          access_token: access,
          refresh_token: "fixture-refresh",
          expires_in: 3600,
        });
      }
      default:
        assert.fail("Unexpected provider request");
    }
  });
  auth.start("openai-codex", "oauth");
  await answer(auth, "device_code", "openai-codex");
  const pending = await until(auth, (view) => !!view.attempt?.events.length, "openai-codex");
  assert.deepEqual(
    pending.attempt?.events.map((event) => event.type),
    ["device_code"],
  );
  completed.resolve();
  await until(auth, (view) => view.attempt?.state === "succeeded", "openai-codex");
  const stored = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(stored, {
    "openai-codex": {
      type: "oauth",
      access,
      refresh: "fixture-refresh",
      expires: stored["openai-codex"].expires,
      accountId: "fixture-account",
    },
  });
  assert.equal(typeof stored["openai-codex"].expires, "number");
  assert.deepEqual(requests, [
    "/api/accounts/deviceauth/usercode",
    "/api/accounts/deviceauth/token",
    "/oauth/token",
  ]);
});

await test("cancelling a status read releases its lock wait without cancelling the pending login", async (t) => {
  const { auth, path } = await authFixture(t);
  auth.start("openai", "api_key");
  const before = (await selected(auth)).attempt;
  const release = await lockfile.lock(path, { retries: 0, stale: 30_000 });
  const controller = new AbortController();
  try {
    const view = auth.view("openai", { signal: controller.signal });
    controller.abort();
    await assert.rejects(view, { name: "AbortError" });
  } finally {
    await release();
  }
  assert.deepEqual((await selected(auth)).attempt, before);
});
