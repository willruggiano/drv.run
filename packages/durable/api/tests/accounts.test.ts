import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
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
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "accounts-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const models = createModels();
  models.setProvider(fauxProvider({ provider: "faux" }).provider);
  const options = { directory, servers: [registration], origin: "https://app.example", models };
  const app = await openAccounts(options);
  t.after(() => app.close());
  let subject = "user-1";
  let tokenStatus = 200;
  let expiresIn = 3600;
  const requests: { url: string; parameters: URLSearchParams }[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const parameters = new URLSearchParams(String(init?.body ?? ""));
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
  assert.deepEqual(records.map((r) => r?.status).sort(), ["completed", "failed"]);
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
