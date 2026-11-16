import assert from "node:assert/strict";
import { test } from "node:test";
import { decode } from "../src/graphql.ts";
import { startServer } from "./fixtures.ts";

const result = { data: { ok: true } };

await test("POST decodes GraphQL arguments and uses JSON regardless of Accept", async (t) => {
  const running = await startServer(t);
  const execute = t.mock.method(running.app.api, "graphql", async () => result);
  const url = new URL("/api/graphql", running.server.url);
  const payload = {
    query: "query Q($id:ID!){node(id:$id){id}}",
    operationName: "Q",
    variables: { id: "x" },
    extensions: { persistedQuery: { version: 1 } },
  };
  for (const accept of [
    "text/plain",
    "application/json;q=0",
    "application/graphql-response+json",
  ]) {
    const response = await fetch(url, {
      method: "POST",
      headers: { Accept: accept, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
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

await test("non-POST requests are rejected before GraphQL execution", async (t) => {
  const running = await startServer(t);
  const execute = t.mock.method(running.app.api, "graphql", async () => result);
  for (const method of ["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const response = await fetch(new URL("/api/graphql?query=%7Bx%7D", running.server.url), {
      method,
    });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "POST");
    assert.equal(response.headers.get("cache-control"), "no-store");
    await response.arrayBuffer();
  }
  assert.equal(execute.mock.callCount(), 0);
});

await test("decode asserts that its caller supplies a POST request", async () => {
  await assert.rejects(
    decode(new Request("https://example.test/api/graphql")),
    assert.AssertionError,
  );
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
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    assert.equal(response.status, 200);
    const result = (await response.json()) as { errors: unknown[] };
    assert.equal(result.errors.length, 1);
  }
});
