import assert from "node:assert/strict";
import { request as httpRequest, ServerResponse } from "node:http";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  MemoryStorage,
  ROOT_CONVERSATION_ID,
  StorageRequestError,
  ReadAfterWrite,
  SessionFailed,
  ConversationBusy,
} from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createApi } from "durable-api";
import { openHarness, serve } from "./fixtures.ts";

async function problem(response: Response, status: number, ids: object = { sessionId: "test" }) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("content-type"), "application/problem+json");
  assert.equal(response.headers.get("cache-control"), "no-store");
  const value: unknown = await response.json();
  const titles: Record<number, string> = {
    400: "Bad Request",
    404: "Not Found",
    405: "Method Not Allowed",
    409: "Conflict",
    413: "Content Too Large",
    415: "Unsupported Media Type",
    500: "Internal Server Error",
    503: "Service Unavailable",
  };
  assert.deepEqual(value, { type: "about:blank", title: titles[status], status, ...ids });
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json; charset=utf-8" },
  body: JSON.stringify(body),
});

void test("strict route, method, query and JSON decoding precedes opening", async (t) => {
  let opens = 0;
  const { url } = await serve(t, {
    bodyLimit: 128,
    async openHarness() {
      opens++;
      return undefined;
    },
  });
  const ids = { sessionId: "test", conversationId: 1 };
  await problem(await fetch(url.replace("/api/s/test", "/unknown")), 404, {});
  await problem(await fetch(`${url.replace("test", "%XX")}/inspect`), 400, {});
  for (const id of ["-1", "NaN", "1.2", "9007199254740992", "%30"])
    await problem(await fetch(`${url}/c/${id}/context`), 400);
  for (const path of ["missing", "c/1/missing", "c/1/inspect", "context"])
    await problem(
      await fetch(`${url}/${path}`),
      404,
      path.startsWith("c/") ? ids : { sessionId: "test" },
    );
  for (const [path, method, allow] of [
    ["inspect", "POST", "GET"],
    ["c/1/submit", "GET", "POST"],
  ] as const) {
    const response = await fetch(`${url}/${path}`, { method });
    assert.equal(response.headers.get("allow"), allow);
    await problem(response, 405, path!.startsWith("c/") ? ids : { sessionId: "test" });
  }
  for (const path of [
    "inspect?extra=1",
    "c/1/entries?limit=1&limit=2",
    "c/1/entries",
    "c/1/entries?limit=0",
    "c/1/entries?limit=1e2",
    "c/1/entries?limit=1&order=wrong",
    "scanTasks?limit=1&background=1",
    "c/1/context?at=-1",
    "c/1/submissionByRequest",
    "c/1/submissions/status?id=bad",
    "inspect?__proto__=bad",
  ]) {
    await problem(
      await fetch(`${url}/${path}`),
      400,
      path.startsWith("c/") ? ids : { sessionId: "test" },
    );
  }
  for (const [operation, body] of [
    ["submit", { type: "write", content: "x" }],
    ["submit", { type: "input", content: "x", entry: { kind: "pi.user" } }],
    [
      "submit",
      { type: "input", content: [{ type: "image", data: "not base64", mimeType: "image/png" }] },
    ],
    ["submit", { type: "input", content: null }],
    ["submit", { type: "input", content: "x", whenBusy: "later" }],
    ["abortSubmission", { id: -1 }],
    ["abortSubmission", { id: "1" }],
    ["submit", { type: "input", content: [{ type: "text", text: 42 }] }],
    ["submit", { type: "input", content: [{ type: "text", text: "x", extra: true }] }],
    ["reset", { handoff: null }],
    ["compact", { instructions: 4 }],
    ["configure", { cwd: 42 }],
    ["configure", { cwd: {} }],
    ["configure", { extensions: [] }],
    ["configure", { tools: [] }],
    ["configure", { modelTools: [] }],
    ["configure", { instructions: "no" }],
    ["configure", { env: "local" }],
    ["configure", { model: { provider: "x" } }],
    ["configure", { model: { provider: "x", modelId: "y", extra: true } }],
    ["configure", { thinkingLevel: "unknown" }],
  ] as const)
    await problem(await fetch(`${url}/c/1/${operation}`, json(body)), 400, ids);
  await problem(await fetch(`${url}/c/1/reset?extra=1`, json({})), 400, ids);
  await problem(await fetch(`${url}/c/1/reset`, { method: "POST", body: "{}" }), 415, ids);
  await problem(await fetch(`${url}/c/1/reset`, { method: "POST" }), 415, ids);
  for (const body of ["{", "", new Uint8Array([0xff])])
    await problem(
      await fetch(`${url}/c/1/reset`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
      400,
      ids,
    );
  await problem(
    await fetch(`${url}/c/1/submit`, json({ type: "input", content: "x".repeat(128) })),
    413,
    ids,
  );
  await problem(await fetch(`${url}/resume`, json({})), 400);
  await problem(await fetch(`${url}/c/1/abort`, json({})), 400, ids);
  // fetch forbids GET bodies; use the HTTP interface directly.
  const response = await new Promise<Response>((resolve, reject) => {
    const request = httpRequest(
      `${url}/inspect`,
      { method: "GET", headers: { "content-length": 1 } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve(
            new Response(Buffer.concat(chunks), {
              status: response.statusCode!,
              headers: {
                "content-type": String(response.headers["content-type"]),
                "cache-control": String(response.headers["cache-control"]),
              },
            }),
          ),
        );
      },
    );
    request.on("error", reject);
    request.end("x");
  });
  await problem(response, 400);
  assert.equal(opens, 0);
});

void test("missing addressing and lookup absence are distinct", async (t) => {
  const { harness } = await openHarness(t);
  const { url } = await serve(t, {
    openHarness: async (id) => (id === "test" ? harness : undefined),
  });
  await problem(await fetch(`${url.replace("test", "absent")}/inspect`), 404, {
    sessionId: "absent",
  });
  await problem(await fetch(`${url}/c/999/context`), 404, {
    sessionId: "test",
    conversationId: 999,
  });
  for (const path of ["submissionByRequest?requestId=missing", "submissions/status?id=999"]) {
    const response = await fetch(`${url}/c/1/${path}`);
    assert.equal(response.status, 200);
    assert.equal(await response.json(), null);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  const missingAbort = await fetch(`${url}/c/1/abortSubmission`, json({ id: 999 }));
  assert.equal(missingAbort.status, 200);
  assert.equal(await missingAbort.json(), "not_found");
});

void test("opaque cursors reject malformed encoding and invalid upstream continuation", async (t) => {
  const { harness } = await openHarness(t);
  const { url } = await serve(t, { openHarness: async () => harness });
  for (const cursor of [
    "",
    "==",
    "AB",
    "_w",
    Buffer.from("{").toString("base64url"),
    Buffer.from("[]").toString("base64url"),
    Buffer.from("null").toString("base64url"),
    Buffer.from('{"nested":{"number":1e400}}').toString("base64url"),
    Buffer.from("{}").toString("base64url"),
  ]) {
    await problem(
      await fetch(`${url}/c/1/entries?limit=1&cursor=${encodeURIComponent(cursor)}`),
      400,
      { sessionId: "test", conversationId: 1 },
    );
  }
});

void test("storage read rejection is 400; unexpected read failure fails the session", async (t) => {
  const storage = new MemoryStorage();
  const { harness } = await openHarness(t, {}, storage);
  const { url } = await serve(t, { openHarness: async () => harness });
  const fault = t.mock.method(storage, "scanConversations", async () => {
    throw new StorageRequestError("private");
  });
  await problem(await fetch(`${url}/scanConversations?limit=1`), 400);
  fault.mock.mockImplementation(async () => {
    throw new TypeError("private");
  });
  await problem(await fetch(`${url}/scanConversations?limit=1`), 500);
  await problem(await fetch(`${url}/inspect`), 503);
});

void test("StorageRequestError in a mutation is fatal, never a 400", async (t) => {
  const storage = new MemoryStorage();
  const { harness } = await openHarness(t, {}, storage);
  const { url } = await serve(t, { openHarness: async () => harness });
  t.mock.method(storage, "commit", async () => {
    throw new StorageRequestError("private");
  });
  await problem(await fetch(`${url}/c/1/configure`, json({ thinkingLevel: "high" })), 500, {
    sessionId: "test",
    conversationId: 1,
  });
  await problem(await fetch(`${url}/c/1/context`), 503, { sessionId: "test", conversationId: 1 });
});

void test("typed and untyped factory failures retain their classification without leaking diagnostics", async (t) => {
  const failures = [
    new ReadAfterWrite("private"),
    new SessionFailed(new Error("private")),
    new ConversationBusy(ROOT_CONVERSATION_ID),
    new Error("private"),
  ];
  const { url } = await serve(t, {
    async openHarness() {
      throw failures.shift();
    },
  });
  for (const status of [500, 503, 500, 500]) await problem(await fetch(`${url}/inspect`), status);
});

void test("serialized inspection diagnostics remain native JSON; serializer failure is a problem", async (t) => {
  const { harness } = await openHarness(t);
  const { url } = await serve(t, { openHarness: async () => harness });
  const original = await harness.inspect(BACKGROUND_CONTEXT);
  const circular = { ...original };
  // Exercise transport failure using an upstream method double, not a session driver.
  Object.defineProperty(circular, "cycle", { value: circular, enumerable: true });
  t.mock.method(harness, "inspect", async () => circular);
  await problem(await fetch(`${url}/inspect`), 500);
});

void test("body limits reject invalid deployment configuration", () => {
  for (const bodyLimit of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(
      () =>
        createApi({
          models: createModels(),
          listHarnesses: async () => [],
          openHarness: async () => undefined,
          bodyLimit,
        }),
      RangeError,
    );
});

void test("transport failure after SSE headers disconnects instead of sending a problem", async (t) => {
  const { harness } = await openHarness(t);
  const { url } = await serve(t, { openHarness: async () => harness });
  const write = t.mock.method(ServerResponse.prototype, "write", function () {
    throw new Error("write failure");
  });
  await assert.rejects(fetch(`${url}/c/1/watch`));
  write.mock.restore();
});

void test("asynchronous SSE write failure releases observation and closes transport", async (t) => {
  const { harness } = await openHarness(t);
  const { url } = await serve(t, { openHarness: async () => harness });
  const write = t.mock.method(ServerResponse.prototype, "write", function (...args: unknown[]) {
    const callback = args.at(-1);
    assert.equal(typeof callback, "function");
    (callback as (error: Error) => void)(new Error("asynchronous write failure"));
    return false;
  });
  await assert.rejects(fetch(`${url}/c/1/watch`));
  write.mock.restore();
});

void test("model catalog projects public metadata without opening a Harness", async (t) => {
  const models = createModels();
  const faux = fauxProvider({
    provider: "catalog",
    models: [
      {
        id: "reasoner",
        name: "Reasoner",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 1000,
        maxTokens: 100,
        cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
      },
      { id: "plain", name: "Plain", reasoning: false, input: ["text"] },
    ],
  });
  const reasoner = faux.models[0];
  reasoner.headers = { Authorization: "Bearer private", "x-api-key": "private" };
  reasoner.baseUrl = "https://private.invalid/api";
  reasoner.thinkingLevelMap = { minimal: null, xhigh: "extended", max: null };
  reasoner.cost.tiers = [
    { inputTokensAbove: 500, input: 5, output: 6, cacheRead: 7, cacheWrite: 8 },
  ];
  models.setProvider(faux.provider);
  const refresh = t.mock.method(models, "refresh");
  const { url } = await serve(t, {
    models,
    async openHarness() {
      assert.fail("catalog reads must not open a Harness");
    },
  });
  const response = await fetch(new URL("/api/models", url));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), [
    {
      id: "reasoner",
      provider: "catalog",
      name: "Reasoner",
      input: ["text", "image"],
      reasoning: true,
      contextWindow: 1000,
      maxTokens: 100,
      cost: {
        input: 1,
        output: 2,
        cacheRead: 3,
        cacheWrite: 4,
        tiers: [{ inputTokensAbove: 500, input: 5, output: 6, cacheRead: 7, cacheWrite: 8 }],
      },
      thinkingLevels: ["off", "low", "medium", "high", "xhigh"],
    },
    {
      id: "plain",
      provider: "catalog",
      name: "Plain",
      input: ["text"],
      reasoning: false,
      contextWindow: 128000,
      maxTokens: 16384,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      thinkingLevels: ["off"],
    },
  ]);
  assert.equal(refresh.mock.callCount(), 0);
  assert.equal(faux.state.callCount, 0);
});

void test("catalog observes current authentication, provider filtering, and replacement model sources", async (t) => {
  let models = createModels();
  const faux = fauxProvider({ models: [{ id: "allowed" }, { id: "filtered" }] });
  let authenticated = false;
  models.setProvider({
    ...faux.provider,
    auth: {
      apiKey: {
        name: "Test auth",
        async check() {
          return authenticated ? { type: "api_key" } : undefined;
        },
        async resolve() {
          assert.fail("availability uses check, not request authentication");
        },
      },
    },
    filterModels: (entries) => entries.filter((model) => model.id === "allowed"),
  });
  let reads = 0;
  const { url } = await serve(t, {
    models: () => {
      reads++;
      return models;
    },
    async openHarness() {
      assert.fail("catalog reads must not open a Harness");
    },
  });
  const catalog = new URL("/api/models", url);
  const empty = await fetch(catalog);
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), []);
  authenticated = true;
  const available = await fetch(catalog);
  assert.equal(available.status, 200);
  const entries = await available.json();
  assert(Array.isArray(entries));
  assert.deepEqual(
    entries.map((model) => model.id),
    ["allowed"],
  );
  authenticated = false;
  assert.deepEqual(await (await fetch(catalog)).json(), []);
  models = createModels();
  models.setProvider(fauxProvider({ provider: "replacement", models: [{ id: "new" }] }).provider);
  const replacement = await fetch(catalog);
  assert.equal(replacement.status, 200);
  const replaced = await replacement.json();
  assert(Array.isArray(replaced));
  assert.deepEqual(
    replaced.map(({ id, provider }) => ({ id, provider })),
    [{ id: "new", provider: "replacement" }],
  );
  assert.equal(reads, 4);
});

void test("model route rejects methods, queries, bodies, and session scopes before reading the catalog", async (t) => {
  const { url } = await serve(t, {
    models: () => {
      assert.fail("invalid requests must not read the catalog");
    },
    async openHarness() {
      assert.fail("invalid requests must not open a Harness");
    },
  });
  const catalog = new URL("/api/models", url);
  for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
    const response = await fetch(catalog, { method });
    assert.equal(response.headers.get("allow"), "GET");
    await problem(response, 405, {});
  }
  const head = await fetch(catalog, { method: "HEAD" });
  assert.equal(head.status, 405);
  assert.equal(head.headers.get("allow"), "GET");
  for (const query of ["provider=test", "unknown=1", "limit=1", "x=1&x=2"])
    await problem(await fetch(`${catalog.href}?${query}`), 400, {});
  for (const path of ["/api/models/", "/api/models/missing"])
    await problem(await fetch(new URL(path, url)), 404, {});
  await problem(await fetch(`${url}/models`), 404);
  await problem(await fetch(`${url}/c/1/models`), 404, { sessionId: "test", conversationId: 1 });
  const response = await new Promise<{ status: number | undefined; body: unknown }>(
    (resolve, reject) => {
      const request = httpRequest(
        catalog,
        { method: "GET", headers: { "content-length": 1 } },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () =>
            resolve({
              status: response.statusCode,
              body: JSON.parse(Buffer.concat(chunks).toString()),
            }),
          );
        },
      );
      request.on("error", reject);
      request.end("x");
    },
  );
  assert.deepEqual(response, {
    status: 400,
    body: { type: "about:blank", title: "Bad Request", status: 400 },
  });
});

void test("model source and provider failures return generic problems without session identity", async (t) => {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider({
    ...faux.provider,
    getModels() {
      throw new Error("private provider data");
    },
  });
  let failSource = true;
  const { url } = await serve(t, {
    models: () => {
      if (failSource) throw new SessionFailed(new Error("private source data"));
      return models;
    },
    async openHarness() {
      assert.fail("catalog reads must not open a Harness");
    },
  });
  await problem(await fetch(new URL("/api/models", url)), 500, {});
  failSource = false;
  await problem(await fetch(new URL("/api/models", url)), 500, {});
});

void test("disconnect cancels an outstanding model availability check", async (t) => {
  const models = createModels();
  const faux = fauxProvider();
  const started = Promise.withResolvers<AbortSignal>();
  const aborted = Promise.withResolvers<void>();
  models.setProvider({
    ...faux.provider,
    auth: {
      apiKey: {
        name: "Pending auth",
        async check({ signal }) {
          started.resolve(signal);
          await new Promise<void>((resolve) =>
            signal.addEventListener(
              "abort",
              () => {
                aborted.resolve();
                resolve();
              },
              { once: true },
            ),
          );
          signal.throwIfAborted();
          assert.fail("request must be aborted");
        },
        async resolve() {
          assert.fail("availability uses check");
        },
      },
    },
  });
  const { url } = await serve(t, {
    models,
    async openHarness() {
      assert.fail("catalog reads must not open a Harness");
    },
  });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const request = fetch(new URL("/api/models", url), { signal: controller.signal });
  const signal = await started.promise;
  assert.equal(signal.aborted, false);
  controller.abort();
  await assert.rejects(request, { name: "AbortError" });
  await aborted.promise;
  assert.equal(signal.aborted, true);
});
