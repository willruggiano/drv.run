import assert from "node:assert/strict";
import { test } from "node:test";
import { startServer } from "./fixtures.ts";

const result = { data: { ok: true } };

await test("GET decodes GraphQL arguments and uses JSON regardless of Accept", async (t) => {
  const running = await startServer(t);
  const execute = t.mock.method(running.app.api, "graphql", async () => result);
  const url = new URL("/api/graphql", running.server.url);
  url.search = new URLSearchParams({
    query: "query Q($id:ID!){node(id:$id){id}}",
    operationName: "Q",
    variables: JSON.stringify({ id: "x" }),
    extensions: JSON.stringify({ persistedQuery: { version: 1 } }),
  }).toString();
  for (const accept of [
    "text/plain",
    "application/json;q=0",
    "application/graphql-response+json",
  ]) {
    const response = await fetch(url, { headers: { Accept: accept } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/json");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), result);
  }
  const [args, signal] = execute.mock.calls[0]!.arguments;
  assert.deepEqual(args, {
    source: "query Q($id:ID!){node(id:$id){id}}",
    operationName: "Q",
    variableValues: { id: "x" },
  });
  assert.ok(signal instanceof AbortSignal);
});

await test("POST decodes JSON GraphQL payloads into upstream arguments", async (t) => {
  const running = await startServer(t);
  const execute = t.mock.method(running.app.api, "graphql", async () => result);
  const response = await fetch(new URL("/api/graphql", running.server.url), {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ query: "{ ok }", variables: null }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), result);
  assert.deepEqual(execute.mock.calls[0]!.arguments[0], {
    source: "{ ok }",
    operationName: null,
    variableValues: null,
  });
});

await test("GET rejects mutations and invalid parameters before execution", async (t) => {
  const running = await startServer(t);
  const execute = t.mock.method(running.app.api, "graphql", async () => result);
  for (const [search, status, allow] of [
    ["?query=mutation%20%7Bx%7D", 405, "POST"],
    ["", 400, null],
    ["?query=%7B", 200, null],
    ["?query=%7Bx%7D&query=%7By%7D", 400, null],
    ["?query=%7Bx%7D&unknown=1", 400, null],
    ["?query=%7Bx%7D&toString=1", 400, null],
    ["?query=%7Bx%7D&variables=%5B%5D", 400, null],
    ["?query=%7Bx%7D&variables=%7B", 400, null],
  ] as const) {
    const response = await fetch(new URL(`/api/graphql${search}`, running.server.url));
    assert.equal(response.status, status);
    assert.equal(response.headers.get("allow"), allow);
    await response.arrayBuffer();
  }
  const wrongMethod = await fetch(new URL("/api/graphql", running.server.url), { method: "PUT" });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "GET, POST");
  await wrongMethod.arrayBuffer();
  assert.equal(execute.mock.callCount(), 1);
});

await test("malformed envelopes and unsupported request media types fail before execution", async (t) => {
  const running = await startServer(t);
  const execute = t.mock.method(running.app.api, "graphql", async () => result);
  for (const [contentType, body, status] of [
    ["text/plain", "{}", 415],
    ["application/graphql-response+json", "{}", 415],
    ["application/json", "{", 400],
    ["application/json", "[]", 400],
    ["application/json", "null", 400],
    ["application/json", JSON.stringify({ query: "{x}", variables: [] }), 400],
    ["application/json", JSON.stringify({ query: "{x}", operationName: 1 }), 400],
    ["application/json", JSON.stringify({ query: "{x}", extensions: [] }), 400],
    ["application/json", JSON.stringify({ query: "{x}", unknown: true }), 400],
    ["application/json", JSON.stringify({ query: "" }), 400],
  ] as const) {
    const response = await fetch(new URL("/api/graphql", running.server.url), {
      method: "POST",
      headers: { "Content-Type": contentType },
      body,
    });
    assert.equal(response.status, status);
    assert.equal(response.headers.get("cache-control"), "no-store");
    await response.arrayBuffer();
  }
  assert.equal(execute.mock.callCount(), 0);
});

await test("syntax and validation failures remain GraphQL execution results", async (t) => {
  const running = await startServer(t);
  for (const query of ["{", "{ unknownField }"]) {
    const url = new URL("/api/graphql", running.server.url);
    url.searchParams.set("query", query);
    const response = await fetch(url);
    assert.equal(response.status, 200);
    const result = (await response.json()) as { errors: unknown[] };
    assert.equal(result.errors.length, 1);
  }
});
