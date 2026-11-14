import assert from "node:assert/strict";
import { test } from "node:test";
import { graphQLRequest } from "../src/index.ts";

const result = { data: { ok: true } };
const execute = async (payload: unknown, signal: AbortSignal) => {
  assert.equal(signal.aborted, false);
  assert.equal(typeof payload, "object");
  return result;
};

await test("GET decodes GraphQL parameters, JSON variables and extensions, and negotiates response types", async () => {
  const request = new Request(
    "http://local/api/graphql?query=query%20Q%28%24id%3AID%21%29%7Bnode%28id%3A%24id%29%7Bid%7D%7D&operationName=Q&variables=%7B%22id%22%3A%22x%22%7D&extensions=%7B%22persistedQuery%22%3A%7B%22version%22%3A1%7D%7D",
    {
      headers: { Accept: "application/json;q=0.5, application/graphql-response+json;q=0.9" },
    },
  );
  let received: unknown;
  const response = await graphQLRequest(request, async (payload, signal) => {
    received = payload;
    return execute(payload, signal);
  });
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("content-type"),
    "application/graphql-response+json; charset=utf-8",
  );
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(received, {
    query: "query Q($id:ID!){node(id:$id){id}}",
    operationName: "Q",
    variables: { id: "x" },
    extensions: { persistedQuery: { version: 1 } },
  });
  assert.deepEqual(await response.json(), result);
});

await test("POST accepts JSON GraphQL payloads and defaults to application/json", async () => {
  const response = await graphQLRequest(
    new Request("http://local/api/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ query: "{ ok }", variables: null }),
    }),
    execute,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.deepEqual(await response.json(), result);
});

await test("GET rejects mutations before execution and preserves the method contract", async () => {
  let calls = 0;
  const executeNever = async () => {
    calls++;
    return result;
  };
  for (const [url, status, allow] of [
    ["http://local/api/graphql?query=mutation%20%7Bx%7D", 405, "POST"],
    ["http://local/api/graphql", 400, null],
    ["http://local/api/graphql?query=%7B", 200, null],
    ["http://local/api/graphql?query=%7Bx%7D&query=%7By%7D", 400, null],
    ["http://local/api/graphql?query=%7Bx%7D&unknown=1", 400, null],
    ["http://local/api/graphql?query=%7Bx%7D&toString=1", 400, null],
  ] as const) {
    const response = await graphQLRequest(new Request(url), executeNever);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("allow"), allow);
  }
  const wrongMethod = await graphQLRequest(
    new Request("http://local/api/graphql", { method: "PUT" }),
    executeNever,
  );
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "GET, POST");
  // Only the syntactically invalid GraphQL document reaches execution.
  assert.equal(calls, 1);
});

await test("malformed request bodies, parameter objects, media types, and negotiation fail before execution", async () => {
  let calls = 0;
  const executeNever = async () => {
    calls++;
    return result;
  };
  const cases = [
    new Request("http://local/api/graphql", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "{}",
    }),
    new Request("http://local/api/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    }),
    new Request("http://local/api/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "[]",
    }),
    new Request("http://local/api/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "{x}", variables: [] }),
    }),
    new Request("http://local/api/graphql?query=%7Bx%7D&variables=%5B%5D"),
    new Request("http://local/api/graphql?query=%7Bx%7D", { headers: { Accept: "text/plain" } }),
    new Request("http://local/api/graphql?query=%7Bx%7D", {
      headers: { Accept: "application/json;q=0" },
    }),
    new Request("http://local/api/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/graphql-response+json" },
      body: "{}",
    }),
  ];
  for (const request of cases) {
    const response = await graphQLRequest(request, executeNever);
    assert([400, 406, 415].includes(response.status));
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.body, null);
  }
  assert.equal(calls, 0);
});

await test("syntax and validation failures are GraphQL execution results, and unexpected execution failures propagate", async () => {
  const response = await graphQLRequest(
    new Request("http://local/api/graphql?query=%7B"),
    async () => ({ errors: [{ message: "Syntax Error" }] }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { errors: [{ message: "Syntax Error" }] });
  const error = new Error("resolver failure");
  await assert.rejects(
    graphQLRequest(new Request("http://local/api/graphql?query=%7Bx%7D"), async () => {
      throw error;
    }),
    (cause: unknown) => cause === error,
  );
});
