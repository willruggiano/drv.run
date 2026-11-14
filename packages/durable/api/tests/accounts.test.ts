import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openAccounts } from "../src/accounts.ts";

const context = BACKGROUND_CONTEXT;
const registration = {
  id: "example",
  provider: "faux",
  label: "Example",
  client_id: "client",
  scope: "profile offline_access",
  metadata: {
    issuer: "https://issuer.example",
    authorization_endpoint: "https://issuer.example/authorize",
    token_endpoint: "https://issuer.example/token",
    device_authorization_endpoint: "https://issuer.example/device",
    userinfo_endpoint: "https://issuer.example/userinfo",
    revocation_endpoint: "https://issuer.example/revoke",
    grant_types_supported: ["authorization_code", "urn:ietf:params:oauth:grant-type:device_code"],
  },
};
async function fixture(
  t: TestContext,
  overrides: Partial<Parameters<typeof openAccounts>[0]> = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "accounts-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const models = createModels();
  models.setProvider(fauxProvider({ provider: "faux" }).provider);
  const options = {
    directory,
    servers: [registration],
    origin: "https://app.example",
    models,
    ...overrides,
  };
  const app = await openAccounts(options);
  t.after(() => app.close());
  let subject = "user-1";
  let tokenStatus = 200;
  let expiresIn = 3600;
  const requests: { url: string; parameters: URLSearchParams }[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    assert(init?.body == null || init.body instanceof URLSearchParams);
    const parameters = new URLSearchParams(init?.body ?? undefined);
    requests.push({ url, parameters });
    if (url.endsWith("/userinfo")) return Response.json({ sub: subject, name: "Example User" });
    if (url.endsWith("/device"))
      return Response.json({
        device_code: "private-device-code",
        user_code: "ABCD-EFGH",
        verification_uri: "https://issuer.example/verify",
        expires_in: 600,
        interval: 1,
      });
    if (url.endsWith("/revoke")) return new Response(null, { status: 200 });
    assert.equal(url, registration.metadata.token_endpoint);
    return tokenStatus === 200
      ? Response.json({
          access_token: "secret-access",
          refresh_token: "secret-refresh",
          token_type: "Bearer",
          expires_in: expiresIn,
          scope: "profile",
        })
      : Response.json(
          { error: "invalid_grant", error_description: "secret" },
          { status: tokenStatus },
        );
  });
  async function begin(accountId?: string) {
    const result = await app.service.authorize("example", accountId, context);
    assert("value" in result);
    assert(result.value.request);
    const callback = new URL(result.value.request.redirect_uri);
    callback.searchParams.set("state", result.value.request.state);
    callback.searchParams.set("code", "code");
    return { record: result.value, callback };
  }
  async function enroll(accountId?: string) {
    const flow = await begin(accountId);
    await app.callback(flow.callback);
    const record = await app.service.authorization(flow.record.id, context);
    assert(record);
    return record;
  }
  return {
    ...app,
    directory,
    models,
    options,
    requests,
    begin,
    enroll,
    subject(value: string) {
      subject = value;
    },
    tokenStatus(value: number) {
      tokenStatus = value;
    },
    expiresIn(value: number) {
      expiresIn = value;
    },
  };
}

await test("OAuth code enrollment persists one account and supplies the model catalog and execution", async (t) => {
  const f = await fixture(t);
  const initial = await f.begin();
  const request = initial.record.request!;
  assert.equal(request.code_challenge_method, "S256");
  assert.ok(request.code_challenge);
  assert.equal(new URL(request.url).searchParams.get("state"), request.state);
  await assert.rejects(
    f.callback(new URL("https://app.example/api/oauth/callback?state=wrong&code=code")),
  );
  await f.callback(initial.callback);
  const flow = await f.service.authorization(initial.record.id, context);
  assert.equal(flow?.status, "completed");
  assert(flow.accountId);
  const account = await f.service.account(flow.accountId, context);
  assert.deepEqual(account, {
    id: flow.accountId,
    serverId: "example",
    identifier: "user-1",
    displayName: "Example User",
    scope: "profile",
    status: "usable",
  });
  const exchange = f.requests.find(
    ({ parameters }) => parameters.get("grant_type") === "authorization_code",
  );
  assert(exchange);
  assert(exchange.parameters.get("code_verifier"));
  assert.equal(exchange.parameters.get("redirect_uri"), request.redirect_uri);
  assert.equal((await stat(join(f.directory, "accounts.sqlite"))).mode & 0o777, 0o600);
  assert.deepEqual(await f.models.getAuth("faux"), {
    auth: { apiKey: "secret-access" },
    source: "Linked account",
  });
  assert.ok((await f.models.getAvailable("faux")).length);
  assert.deepEqual(await f.service.authorize("example", undefined, context), {
    error: "BAD_REQUEST",
  });
  await assert.rejects(f.callback(initial.callback));
  await f.close();
  const reopened = await openAccounts({ ...f.options, models: createModelsWithFaux() });
  t.after(() => reopened.close());
  assert.deepEqual(await reopened.service.account(flow.accountId, context), account);
  assert.equal(await reopened.service.authorization(flow.id, context), undefined);
});
function createModelsWithFaux() {
  const models = createModels();
  models.setProvider(fauxProvider({ provider: "faux" }).provider);
  return models;
}

await test("reauthorization preserves identity and failures never replace credentials", async (t) => {
  const f = await fixture(t);
  const first = await f.enroll();
  assert(first.accountId);
  f.subject("other-user");
  const mismatch = await f.enroll(first.accountId);
  assert.equal(mismatch.status, "failed");
  assert.equal((await f.service.account(first.accountId, context))?.identifier, "user-1");
  f.subject("user-1");
  assert.equal((await f.enroll(first.accountId)).accountId, first.accountId);
  f.tokenStatus(400);
  const failure = await f.enroll(first.accountId);
  assert.deepEqual(failure.error, { error: "invalid_grant" });
  assert.equal(failure.status, "failed");
  assert.equal((await f.models.getAuth("faux"))?.auth.apiKey, "secret-access");
});

await test("concurrent enrollment, cancellation, and disconnect cannot replace another account", async (t) => {
  const f = await fixture(t);
  const [a, b] = await Promise.all([f.begin(), f.begin()]);
  await Promise.all([f.callback(a.callback), f.callback(b.callback)]);
  const records = await Promise.all(
    [a, b].map(({ record }) => f.service.authorization(record.id, context)),
  );
  assert.deepEqual(
    records
      .map((r) => {
        assert(r);
        return r.status;
      })
      .sort((a, b) => a.localeCompare(b)),
    ["completed", "failed"],
  );
  const accountId = records.find((r) => r?.status === "completed")?.accountId;
  assert(accountId);
  const pending = await f.begin(accountId);
  assert.deepEqual(await f.service.disconnect(accountId, context), { value: undefined });
  assert.equal((await f.service.authorization(pending.record.id, context))?.status, "cancelled");
  await assert.rejects(f.callback(pending.callback));
  assert.equal(await f.service.account(accountId, context), undefined);
  assert.deepEqual(await f.service.disconnect(accountId, context), { error: "NOT_FOUND" });
});

await test("refresh is serialized and protocol failures retain credentials with an unavailable status", async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  f.expiresIn(1);
  const account = await f.enroll();
  assert(account.accountId);
  t.mock.timers.tick(2000);
  await Promise.all([f.models.getAuth("faux"), f.models.getAuth("faux")]);
  assert.equal(
    f.requests.filter(({ parameters }) => parameters.get("grant_type") === "refresh_token").length,
    1,
  );
  t.mock.timers.tick(2000);
  f.tokenStatus(400);
  await assert.rejects(f.models.getAuth("faux"));
  assert.equal(
    (await f.service.account(account.accountId, context))?.status,
    "reauthorizationRequired",
  );
  assert.equal((await f.models.getAvailable("faux")).length, 0);
});

await test("revocation and local removal are independent and pagination is scoped", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = await fixture(t);
  const account = await f.enroll();
  assert(account.accountId);
  assert.deepEqual(await f.service.revoke(account.accountId, "refresh_token", context), {
    value: undefined,
  });
  const request = f.requests.at(-1)!;
  assert.equal(request.parameters.get("token"), "secret-refresh");
  assert.equal(request.parameters.get("token_type_hint"), "refresh_token");
  assert(await f.service.account(account.accountId, context));
  await f.begin(account.accountId);
  const page = await f.service.authorizations("example", 1, undefined, context);
  assert("items" in page && page.next);
  const next = await f.service.authorizations("example", 1, page.next, context);
  assert("items" in next);
  assert.equal(next.items.length, 1);
  assert.notEqual(next.items[0]?.id, page.items[0]?.id);
  assert.deepEqual(await f.service.accounts(undefined, 1, page.next, context), {
    invalidCursor: true,
  });
  assert.deepEqual(await f.service.authorize("absent", undefined, context), { error: "NOT_FOUND" });
  assert.deepEqual(await f.service.authorize("example", "absent", context), { error: "NOT_FOUND" });
});

await test("device enrollment polls without browser reads and cancellation stops polling", async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const result = await f.service.deviceAuthorization("example", undefined, context);
  assert("value" in result);
  assert.deepEqual(result.value.deviceAuthorizationResponse, {
    user_code: "ABCD-EFGH",
    verification_uri: "https://issuer.example/verify",
    verification_uri_complete: null,
    expires_in: 600,
    interval: 1,
  });
  assert.equal(f.requests.length, 1);
  t.mock.timers.tick(1000);
  await setImmediate();
  const record = await f.service.authorization(result.value.id, context);
  assert.equal(record?.status, "completed");
  assert(record.accountId);
  const pending = await f.service.deviceAuthorization("example", record.accountId, context);
  assert("value" in pending);
  await f.service.cancelAuthorization(pending.value.id, context);
  const count = f.requests.length;
  t.mock.timers.tick(10000);
  await setImmediate();
  assert.equal(f.requests.length, count);
  assert.equal((await f.service.authorization(pending.value.id, context))?.status, "cancelled");
});

await test("device initiation transport failures remain service errors", async (t) => {
  const f = await fixture(t);
  const failure = new Error("offline");
  t.mock.method(globalThis, "fetch", async () => {
    throw failure;
  });
  await assert.rejects(
    f.service.deviceAuthorization("example", undefined, context),
    (error: unknown) => error === failure,
  );
  const page = await f.service.authorizations("example", 10, undefined, context);
  assert("items" in page);
  assert.equal(page.items[0]?.status, "failed");
  assert.deepEqual(page.items[0]?.error, { error: "server_error" });
});

await test("account catalogs expose metadata, enforce registration, and reject foreign cursors", async (t) => {
  const { scope: _scope, ...withoutScope } = registration;
  const limited = {
    ...withoutScope,
    id: "limited",
    metadata: {
      issuer: "https://issuer.example",
      token_endpoint: registration.metadata.token_endpoint,
      grant_types_supported: [],
    },
  };
  const f = await fixture(t, { servers: [registration, limited] });
  const servers = await f.service.servers(1, undefined, context);
  assert("items" in servers && servers.next);
  assert.equal(servers.items[0]?.id, "example");
  const next = await f.service.servers(1, servers.next, context);
  assert("items" in next);
  assert.equal(next.items[0]?.id, "limited");
  assert.equal(next.items[0]?.authorization_endpoint, null);
  assert.equal(next.items[0]?.device_authorization_endpoint, null);
  assert.equal(next.items[0]?.revocation_endpoint, null);
  assert.equal((await f.service.server("example", context))?.label, "Example");
  assert.equal(await f.service.server("absent", context), undefined);
  for (const cursor of [
    {},
    { namespace: f.directory, scope: "servers", after: "absent" },
    { namespace: f.directory, scope: "servers", after: 7 },
  ])
    assert.deepEqual(await f.service.servers(1, cursor, context), { invalidCursor: true });
  assert.deepEqual(await f.service.authorize("limited", undefined, context), {
    error: "BAD_REQUEST",
  });
  assert.deepEqual(await f.service.deviceAuthorization("limited", undefined, context), {
    error: "BAD_REQUEST",
  });
  assert.deepEqual(await f.service.deviceAuthorization("absent", undefined, context), {
    error: "NOT_FOUND",
  });
  assert.deepEqual(await f.service.cancelAuthorization("absent", context), { error: "NOT_FOUND" });
  assert.deepEqual(await f.service.revoke("absent", undefined, context), { error: "NOT_FOUND" });
  const flow = await f.enroll();
  assert(flow.accountId);
  assert.deepEqual(await f.service.cancelAuthorization(flow.id, context), { value: undefined });
  for (const id of [undefined, "example", "other"]) {
    const page = await f.service.accounts(id, 10, undefined, context);
    assert("items" in page);
    assert.equal(page.items.length, id === "other" ? 0 : 1);
  }
  const { withAbortSignal } = await import("@earendil-works/chord/context");
  await assert.rejects(
    f.service.authorize("example", flow.accountId, withAbortSignal(AbortSignal.abort(), context)),
  );
});

await test("client secrets, optional metadata, and token fields preserve OAuth semantics", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "client-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const secretFile = join(directory, "secret");
  await writeFile(secretFile, "private-client-secret\n");
  const { userinfo_endpoint: _userinfo, ...metadata } = registration.metadata;
  const { scope: _scope, ...server } = registration;
  const f = await fixture(t, { servers: [{ ...server, metadata, clientSecretFile: secretFile }] });
  let expires: number | undefined;
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    assert(init?.body instanceof URLSearchParams);
    assert.equal(init.body.get("client_secret"), "private-client-secret");
    if (init.body.has("token")) return new Response(null, { status: 200 });
    return Response.json({
      token_type: "bearer",
      access_token: "access",
      ...(expires === undefined ? {} : { expires_in: expires }),
    });
  });
  const flow = await f.enroll();
  assert(flow.accountId);
  const account = await f.service.account(flow.accountId, context);
  assert.equal(account?.identifier, null);
  assert.equal(account?.scope, null);
  assert.equal((await f.models.getAuth("faux"))?.auth.apiKey, "access");
  assert.deepEqual(await f.service.revoke(flow.accountId, "refresh_token", context), {
    error: "BAD_REQUEST",
  });
  for (const hint of [undefined, "access_token"] as const)
    assert.deepEqual(await f.service.revoke(flow.accountId, hint, context), { value: undefined });
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  expires = 1;
  assert.equal((await f.enroll(flow.accountId)).status, "completed");
  t.mock.timers.tick(2000);
  await assert.rejects(f.models.getAuth("faux"));
  assert.equal(
    (await f.service.account(flow.accountId, context))?.status,
    "reauthorizationRequired",
  );
  await f.close();
  const noRevocation = await openAccounts({
    ...f.options,
    models: createModelsWithFaux(),
    servers: [
      {
        ...registration,
        metadata: {
          issuer: metadata.issuer,
          token_endpoint: metadata.token_endpoint,
          grant_types_supported: [],
        },
      },
    ],
  });
  t.after(() => noRevocation.close());
  assert.deepEqual(await noRevocation.service.revoke(flow.accountId, undefined, context), {
    error: "BAD_REQUEST",
  });
});

await test("refresh retains omitted fields and distinguishes transport failures from invalid grants", async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  f.expiresIn(1);
  const flow = await f.enroll();
  assert(flow.accountId);
  t.mock.timers.tick(2000);
  const original = globalThis.fetch;
  let offline = true;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.body instanceof URLSearchParams && init.body.get("grant_type") === "refresh_token") {
      if (offline) throw new Error("offline");
      return Response.json({ token_type: "bearer", access_token: "refreshed" });
    }
    return original(input, init);
  });
  await assert.rejects(f.models.getAuth("faux"));
  assert.equal(
    (await f.service.account(flow.accountId, context))?.status,
    "temporarilyUnavailable",
  );
  offline = false;
  assert.equal((await f.models.getAuth("faux"))?.auth.apiKey, "refreshed");
  assert.equal((await f.service.account(flow.accountId, context))?.scope, "profile");
  assert.deepEqual(await f.service.revoke(flow.accountId, undefined, context), {
    value: undefined,
  });
  assert.equal(f.requests.at(-1)?.parameters.get("token"), "secret-refresh");
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: "unsupported_token_type" }, { status: 400 }),
  );
  assert.deepEqual(await f.service.revoke(flow.accountId, undefined, context), {
    protocolError: "unsupported_token_type",
  });
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("offline");
  });
  await assert.rejects(f.service.revoke(flow.accountId, undefined, context));
});

await test("unlinked providers retain ambient auth, without selecting it for a linked account", async (t) => {
  for (const kind of ["check", "resolve", "absent", "oauth"] as const) {
    const models = createModelsWithFaux();
    const provider = models.getProvider("faux")!;
    models.setProvider({
      ...provider,
      auth:
        kind === "oauth"
          ? {}
          : {
              apiKey: {
                name: "ambient",
                ...(kind === "check"
                  ? {
                      async check() {
                        return { type: "api_key" as const };
                      },
                    }
                  : {}),
                async resolve() {
                  return kind === "absent" ? undefined : { auth: { apiKey: "ambient" } };
                },
              },
            },
    });
    const f = await fixture(t, { models });
    assert.equal(
      (await models.getAvailable("faux")).length > 0,
      kind === "check" || kind === "resolve",
    );
    assert.equal(
      (await models.getAuth("faux"))?.auth.apiKey,
      kind === "check" || kind === "resolve" ? "ambient" : undefined,
    );
    await f.enroll();
    assert.equal((await models.getAuth("faux"))?.auth.apiKey, "secret-access");
    await f.close();
  }
});

await test("device polling honors pending, slow-down, timeout backoff, failure, and expiry", async (t) => {
  for (const scenario of [
    "retry",
    "denied",
    "expired",
    "late",
    "protocol",
    "timeout-expiry",
  ] as const) {
    await t.test(scenario, async (t) => {
      const f = await fixture(t);
      t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
      let polls = 0;
      const original = globalThis.fetch;
      t.mock.method(
        globalThis,
        "fetch",
        async (input: string | URL | Request, init?: RequestInit) => {
          if (new URL(input instanceof Request ? input.url : input).pathname === "/device") {
            if (scenario === "protocol")
              return Response.json({ error: "access_denied" }, { status: 400 });
            return Response.json({
              device_code: "secret",
              user_code: "CODE",
              verification_uri: "https://issuer.example/device",
              expires_in:
                scenario === "expired" || scenario === "late" || scenario === "timeout-expiry"
                  ? 6
                  : 600,
            });
          }
          if (
            init?.body instanceof URLSearchParams &&
            init.body.get("grant_type") === "urn:ietf:params:oauth:grant-type:device_code"
          ) {
            polls++;
            if (scenario === "denied")
              return Response.json({ error: "access_denied" }, { status: 400 });
            if (scenario === "late") t.mock.timers.tick(2000);
            if (scenario === "timeout-expiry") throw new DOMException("timeout", "TimeoutError");
            if (scenario === "retry" && polls < 3)
              return Response.json(
                { error: polls === 1 ? "authorization_pending" : "slow_down" },
                { status: 400 },
              );
            if (scenario === "retry" && polls === 3)
              throw new DOMException("timeout", "TimeoutError");
          }
          return original(input, init);
        },
      );
      const result = await f.service.deviceAuthorization("example", undefined, context);
      assert("value" in result);
      if (scenario === "retry") {
        for (const [duration, count] of [
          [4999, 0],
          [1, 1],
          [5000, 2],
          [9999, 2],
          [1, 3],
          [19999, 3],
          [1, 4],
        ]) {
          t.mock.timers.tick(duration!);
          await setImmediate();
          assert.equal(polls, count);
        }
      } else if (scenario !== "protocol") {
        t.mock.timers.tick(scenario === "expired" ? 6000 : 5000);
        await setImmediate();
      }
      if (scenario === "timeout-expiry") {
        t.mock.timers.tick(1000);
        await setImmediate();
      }
      const record = await f.service.authorization(result.value.id, context);
      assert.equal(record?.status, scenario === "retry" ? "completed" : "failed");
      if (scenario !== "retry")
        assert.equal(
          record?.error?.error,
          scenario === "denied" || scenario === "protocol" ? "access_denied" : "expired_token",
        );
    });
  }
});

await test("grant admission, callback origin, and optional identity metadata are enforced", async (t) => {
  const f = await fixture(t, {
    servers: [
      registration,
      {
        ...registration,
        id: "disabled",
        metadata: { ...registration.metadata, grant_types_supported: [] },
      },
    ],
  });
  assert.deepEqual(await f.service.authorize("disabled", undefined, context), {
    error: "BAD_REQUEST",
  });
  assert.deepEqual(await f.service.deviceAuthorization("disabled", undefined, context), {
    error: "BAD_REQUEST",
  });
  const flow = await f.begin();
  const url = new URL(flow.callback);
  url.host = "other.example";
  await assert.rejects(f.callback(url));
  assert.equal((await f.service.authorization(flow.record.id, context))?.status, "pending");
  const original = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    if (new URL(input instanceof Request ? input.url : input).pathname === "/userinfo")
      return Response.json({ sub: "user-1" });
    return original(input, init);
  });
  await f.callback(flow.callback);
  const finished = await f.service.authorization(flow.record.id, context);
  assert(finished?.accountId);
  assert.equal((await f.service.account(finished.accountId, context))?.displayName, null);
  await f.close();
  const { scope: _scope, ...withoutScope } = registration;
  const noScope = await fixture(t, { servers: [withoutScope] });
  const device = await noScope.service.deviceAuthorization("example", undefined, context);
  assert("value" in device);
  assert.equal(noScope.requests[0]?.parameters.has("scope"), false);
});
