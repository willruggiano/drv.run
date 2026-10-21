import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import type { Extension, ToolExecutionApi } from "@earendil-works/pi-durable";
import * as web from "../web.ts";

const context = BACKGROUND_CONTEXT;
// Neither tool may read the guest environment (or any other execution API state).
const api = new Proxy({} as ToolExecutionApi, {
  get() {
    assert.fail("Web tools must not access the guest execution API.");
  },
});
const extension: Extension = web.createWebExtension();
assert(extension.tools);
const [search, extract] = extension.tools;

async function credential(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "web-test-"));
  const path = join(directory, "key");
  const previous = process.env.PARALLEL_API_KEY_FILE;
  t.after(async () => {
    if (previous === undefined) delete process.env.PARALLEL_API_KEY_FILE;
    else process.env.PARALLEL_API_KEY_FILE = previous;
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(path, "test-key\n", { mode: 0o600 });
  process.env.PARALLEL_API_KEY_FILE = path;
  return path;
}

await test("web exposes only search and fetch, sends host-authenticated requests, and returns results", async (t) => {
  assert.deepEqual(Object.keys(web), ["createWebExtension"]);
  assert.equal(extension.name, "web");
  assert.deepEqual(
    extension.tools?.map((tool) => tool.name),
    ["web_search", "web_fetch"],
  );
  const path = await credential(t);
  const result = {
    results: [{ url: "https://example.com", excerpts: ["Source text"] }],
    errors: [
      {
        url: "https://example.org",
        error_type: "fetch_error",
        http_status_code: 500,
        content: "Fetch failed",
      },
    ],
  };
  const requests: { url: unknown; init: RequestInit }[] = [];
  t.mock.method(globalThis, "fetch", async (url: unknown, init: RequestInit) => {
    requests.push({ url, init });
    return Response.json(result);
  });
  const query = { objective: "Find documentation", search_queries: ["Nix manual"] };
  const urls = ["https://example.com", "https://example.org"];
  for (const [tool, args] of [
    [search, query],
    [extract, { urls }],
    [extract, { urls, ...query }],
  ] as const) {
    const response = await tool.execute(args, api, context);
    assert(!response.isError); // Extract's per-URL errors do not discard successful results.
    const output = response.output;
    assert(output?.[0]?.type === "text");
    assert.deepEqual(JSON.parse(output[0].text), result);
    await writeFile(path, "rotated-key\n");
  }
  assert.deepEqual(
    requests.map(({ url, init }) => {
      assert.equal(init.method, "POST");
      assert.equal(init.redirect, "error");
      assert(typeof init.body === "string");
      return { url, headers: init.headers, body: JSON.parse(init.body) };
    }),
    [
      {
        url: "https://api.parallel.ai/v1/search",
        headers: { "content-type": "application/json", "x-api-key": "test-key" },
        body: { ...query, mode: "fast" },
      },
      {
        url: "https://api.parallel.ai/v1/extract",
        headers: { "content-type": "application/json", "x-api-key": "rotated-key" },
        body: { urls },
      },
      {
        url: "https://api.parallel.ai/v1/extract",
        headers: { "content-type": "application/json", "x-api-key": "rotated-key" },
        body: { urls, ...query },
      },
    ],
  );
});

await test("missing, empty, and unreadable host credentials fail before HTTP", async (t) => {
  const path = await credential(t);
  const fetch = t.mock.method(globalThis, "fetch", async () =>
    assert.fail("No HTTP without credentials."),
  );
  const args = { urls: ["https://example.com"] };
  delete process.env.PARALLEL_API_KEY_FILE;
  await assert.rejects(extract.execute(args, api, context));
  process.env.PARALLEL_API_KEY_FILE = path;
  await writeFile(path, "\n");
  await assert.rejects(extract.execute(args, api, context));
  await rm(path);
  await assert.rejects(extract.execute(args, api, context));
  assert.equal(fetch.mock.callCount(), 0);
});

await test("HTTP failures expose actionable API fields, redact credentials, and handle undocumented bodies", async (t) => {
  const path = await credential(t);
  const key = 'test-"key';
  await writeFile(path, key);
  const cases = [
    {
      status: 422,
      body: {
        type: "error",
        error: {
          ref_id: "search_123",
          message: "Invalid request",
          detail: { field: "search_queries", reason: "Too many queries" },
        },
      },
      expected: {
        ref_id: "search_123",
        message: "Invalid request",
        detail: { field: "search_queries", reason: "Too many queries" },
      },
    },
    {
      status: 429,
      body: {
        type: "error",
        error: { ref_id: "search_456", message: "Rate limited", detail: null },
      },
      expected: { ref_id: "search_456", message: "Rate limited", detail: null, retry_after: "30" },
    },
    ...[401, 403].map((status) => ({
      status,
      body: {
        type: "error",
        error: {
          ref_id: key,
          message: `Rejected ${key}`,
          detail: { [key]: [key] },
          headers: { secret: key },
        },
      },
      expected: {
        ref_id: "[REDACTED]",
        message: "Rejected [REDACTED]",
        detail: { "[REDACTED]": ["[REDACTED]"] },
        hint: "Ask the host operator to check the Parallel API key in SOPS and account permissions. Do not put credentials in the guest.",
      },
    })),
    ...["<html>Bad gateway</html>", "", { message: key }, { type: "error", error: null }].map(
      (body) => ({
        status: 502,
        body,
        expected: { message: "No valid Parallel API error message returned." },
      }),
    ),
  ];
  for (const { status, body, expected } of cases) {
    const fetch = t.mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(typeof body === "string" ? body : JSON.stringify(body), {
          status,
          headers: status === 429 ? { "retry-after": "30" } : {},
        }),
    );
    for (const [tool, args, endpoint] of [
      [search, { objective: "Docs", search_queries: ["Nix"] }, "search"],
      [extract, { urls: ["https://example.com"] }, "extract"],
    ] as const) {
      const result = await tool.execute(args, api, context);
      assert.equal(result.isError, true);
      assert(result.output?.[0]?.type === "text");
      assert.deepEqual(JSON.parse(result.output[0].text), { endpoint, status, ...expected });
    }
    assert.equal(fetch.mock.callCount(), 2);
    fetch.mock.restore();
  }
});

await test("durable cancellation propagates during HTTP requests and error-body reads", async (t) => {
  await credential(t);
  for (const phase of ["request", "body"]) {
    const { context: cancelled, cancel } = withCancel(context);
    const fetch = t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
      assert(init.signal);
      assert.equal(init.signal.aborted, false);
      cancel();
      assert.equal(init.signal.aborted, true);
      if (phase === "request") init.signal.throwIfAborted();
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(cancelled.abortSignal?.reason);
          },
        }),
        { status: 500 },
      );
    });
    await assert.rejects(
      search.execute({ objective: "Docs", search_queries: ["Nix"] }, api, cancelled),
      (error: unknown) => error === cancelled.abortSignal?.reason,
    );
    assert.equal(fetch.mock.callCount(), 1);
    fetch.mock.restore();
  }
});
