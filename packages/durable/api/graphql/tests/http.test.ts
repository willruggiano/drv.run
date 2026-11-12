import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { test } from "node:test";
import { GraphQLError, type ExecutionResult } from "graphql";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  StorageRequestError,
  Harness,
  createRegistry,
  CompactionTask,
} from "@earendil-works/pi-durable";
import { openHarness, serve, events } from "../../tests/fixtures.ts";

const modern = "application/graphql-response+json";
const json = (query: string, variables?: object, operationName?: string): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", accept: modern },
  body: JSON.stringify({ query, variables, operationName }),
});
async function result(response: Response, status = 200): Promise<ExecutionResult> {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return (await response.json()) as ExecutionResult;
}

void test("HTTP GET/POST select operations, coerce variables and preserve partial execution errors", async (t) => {
  const { harness } = await openHarness(t);
  const { url } = await serve(t, {
    openHarness: async (id) => (id === "test" ? harness : undefined),
  });
  const endpoint = new URL("/api/graphql", url);
  const query =
    "query One($id: String!) { harness(externalId: $id) { externalId } } query Two { harnesses { externalId } }";
  for (const method of ["GET", "POST"]) {
    endpoint.search = new URLSearchParams({
      query,
      operationName: "One",
      variables: JSON.stringify({ id: "test" }),
      extensions: "null",
    }).toString();
    const response = await fetch(
      endpoint,
      method === "GET" ? { headers: { accept: modern } } : json(query, { id: "test" }, "One"),
    );
    assert.equal(response.headers.get("content-type"), `${modern}; charset=utf-8`);
    assert.deepEqual(await result(response), { data: { harness: { externalId: "test" } } });
  }
  endpoint.search = new URLSearchParams({
    query: 'query Read { __typename } mutation Write { resume(input:{harnessId:"invalid"}) }',
    operationName: "Read",
  }).toString();
  assert.deepEqual(await result(await fetch(endpoint)), { data: { __typename: "Query" } });
  endpoint.search = "";
  const lookup = await result(
    await fetch(
      endpoint,
      json('{ absent: harness(externalId: "missing") { id } bad: node(id: "invalid") { id } }'),
    ),
  );
  assert.deepEqual(lookup.data, { absent: null, bad: null });
  assert.equal(lookup.errors?.[0]?.extensions.code, "BAD_REQUEST");
  assert.deepEqual(lookup.errors?.[0]?.path, ["bad"]);
  for (const accept of [modern, "application/json"]) {
    for (const [query, variables, operationName] of [
      ["{", undefined, undefined],
      ["{ unknownField }", undefined, undefined],
      ["query One { __typename } query Two { __typename }", undefined, undefined],
      ["query One { __typename }", undefined, "Missing"],
      ["query($id: ID!) { node(id: $id) { id } }", { id: [] }, undefined],
      ["subscription { __typename }", undefined, undefined],
    ] as const) {
      const response = await fetch(endpoint, {
        ...json(query, variables, operationName),
        headers: { "content-type": "application/json", accept },
      });
      const value = await result(response, accept === modern ? 400 : 200);
      assert.equal(value.data, undefined);
      assert(value.errors?.length);
    }
  }
  const mutation = 'mutation { resume(input: { harnessId: "invalid" }) }';
  endpoint.search = new URLSearchParams({ query: mutation }).toString();
  const denied = await fetch(endpoint);
  assert.equal(denied.status, 405);
  assert.equal(denied.headers.get("allow"), "POST");
  assert.equal((await harness.inspect(BACKGROUND_CONTEXT)).scheduling, "paused");
});

void test("HTTP negotiation respects quality, specificity, charset and unacceptable media", async (t) => {
  const { url } = await serve(t, { openHarness: async () => undefined });
  const endpoint = new URL("/api/graphql?query=%7B__typename%7D", url);
  for (const [accept, expected] of [
    [undefined, "application/json"],
    [modern, modern],
    ["application/*", "application/json"],
    [`${modern},application/json`, modern],
    [`application/json;q=0.1,${modern};q=0.8`, modern],
    [`${modern};q=0.1,application/json;q=0.8`, "application/json"],
    ["application/json;q=0,*/*;q=1", modern],
    ["application/json;q=0,application/*;q=1", modern],
    ['application/json; charset="UTF8"', "application/json"],
    ["application/json; charset=utf-8", "application/json"],
    ["application/json; charset=latin1", undefined],
    ["text/html", undefined],
    ["application/json; profile=unsupported", undefined],
    ["bad media", undefined],
    ["application/json;q=0", undefined],
    ["application/json;q=no", undefined],
    ["application/json;q=2", undefined],
    ["application/json;q=0.1234", undefined],
  ] as const) {
    const response = await fetch(endpoint, accept === undefined ? {} : { headers: { accept } });
    assert.equal(response.headers.get("cache-control"), "no-store");
    if (expected) {
      assert.equal(response.headers.get("content-type"), `${expected}; charset=utf-8`);
      assert.deepEqual(await result(response), { data: { __typename: "Query" } });
    } else assert.equal(response.status, 406);
  }
});

void test("HTTP transport rejects malformed requests before service access", async (t) => {
  const unused = async () => {
    assert.fail("invalid requests must not reach services");
  };
  const { url } = await serve(t, {
    openHarness: unused,
    listHarnesses: unused,
    models: () => {
      assert.fail("invalid request");
    },
  });
  const endpoint = new URL("/api/graphql", url);
  for (const method of ["PUT", "DELETE", "OPTIONS"]) {
    const response = await fetch(endpoint, { method });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET, POST");
  }
  for (const contentType of [
    undefined,
    "text/plain",
    "application/json; charset=latin1",
    "bad media",
  ]) {
    const response = await fetch(endpoint, {
      method: "POST",
      ...(contentType ? { headers: { "content-type": contentType } } : {}),
    });
    assert.equal(response.status, 415);
  }
  for (const body of [
    "",
    "{",
    "[]",
    "null",
    "{}",
    '{"query":1}',
    '{"query":"{__typename}","variables":[]}',
    '{"query":"{__typename}","operationName":1}',
    '{"query":"{__typename}","extensions":1}',
    new Uint8Array([0xff]),
  ]) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  for (const search of [
    "",
    "?query=x&query=y",
    "?query=x&variables={",
    "?query=x&extensions={",
    "?query=x&variables=[]",
  ]) {
    endpoint.search = search;
    assert.equal((await fetch(endpoint)).status, 400);
  }
  endpoint.search = "";
  assert.deepEqual(
    await result(
      await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": 'Application/JSON; charset="UTF-8"' },
        body: '{"query":"{__typename}","variables":null,"extensions":{},"unknown":true}',
      }),
    ),
    { data: { __typename: "Query" } },
  );
});

void test("HTTP body limits count streamed bytes; interrupted uploads never execute", async (t) => {
  let calls = 0;
  const { url, server } = await serve(t, {
    bodyLimit: 32,
    openHarness: async () => {
      calls++;
      return undefined;
    },
  });
  const endpoint = new URL("/api/graphql", url);
  const oversized = await new Promise<number>((resolve, reject) => {
    const request = httpRequest(
      endpoint,
      { method: "POST", headers: { "content-type": "application/json" } },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode!));
      },
    );
    request.on("error", reject);
    request.write('{"query":"');
    request.end("雪".repeat(10));
  });
  assert.equal(oversized, 413);
  const body = JSON.stringify({ query: "{__typename}" }).padEnd(32);
  const requestOptions = { method: "POST", headers: { "content-type": "application/json" } };
  assert.deepEqual(await result(await fetch(endpoint, { ...requestOptions, body })), {
    data: { __typename: "Query" },
  });
  assert.equal((await fetch(endpoint, { ...requestOptions, body: body + " " })).status, 413);
  const connected = Promise.withResolvers<void>();
  const disconnected = Promise.withResolvers<void>();
  server.once("request", (_request, response) => {
    connected.resolve();
    response.once("close", disconnected.resolve);
  });
  const request = httpRequest(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  request.on("error", () => {});
  request.write('{"query":');
  await connected.promise;
  request.destroy();
  await disconnected.promise;
  assert.equal(calls, 0);
});

void test("GraphQL and SSE share acquisition, disconnect does not cancel opening, and shutdown ends both", async (t) => {
  const { harness } = await openHarness(t);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<Harness>();
  const open = t.mock.fn(async (_id: string, context: typeof BACKGROUND_CONTEXT) => {
    assert.equal(context.abortSignal, undefined);
    entered.resolve();
    return release.promise;
  });
  const { url, api, server } = await serve(t, { openHarness: open });
  const endpoint = new URL("/api/graphql", url);
  const controller = new AbortController();
  const disconnected = Promise.withResolvers<void>();
  server.once("request", (_request, response) => response.once("close", disconnected.resolve));
  const first = fetch(endpoint, {
    ...json('{ harness(externalId:"test") { id } }'),
    signal: controller.signal,
  });
  await entered.promise;
  controller.abort();
  await assert.rejects(first, { name: "AbortError" });
  await disconnected.promise;
  const stream = fetch(`${url}/c/1/watch`);
  const second = fetch(endpoint, json('{ harness(externalId:"test") { externalId } }'));
  release.resolve(harness);
  assert.deepEqual(await result(await second), { data: { harness: { externalId: "test" } } });
  const iterator = events(await stream);
  assert.equal((await iterator.next()).value?.type, "snapshot");
  assert.equal(open.mock.callCount(), 1);
  const closing = api.close();
  assert.equal(api.close(), closing);
  const end = await iterator.next();
  assert.deepEqual(end.value, { type: "end", value: { reason: "cancelled" } });
  await iterator.next();
  await closing;
  assert.deepEqual(await harness.closed, { reason: "closed" });
  assert.equal((await fetch(endpoint, json("{ __typename }"))).status, 503);
  assert.equal((await fetch(new URL("/api/models", url))).status, 503);
});

void test("catalog comes from deployment and acquisition failures remain execution errors", async (t) => {
  let failing = true;
  const { api, url } = await serve(t, {
    listHarnesses: async () => ["z", "cold"],
    openHarness: async () => {
      if (failing) throw new StorageRequestError("private acquisition failure");
      return undefined;
    },
  });
  const endpoint = new URL("/api/graphql", url);
  const catalog = await result(await fetch(endpoint, json("{ harnesses { externalId } }")));
  assert.deepEqual(catalog.data, { harnesses: [{ externalId: "cold" }, { externalId: "z" }] });
  const failed = await result(await fetch(endpoint, json('{ harness(externalId:"test") { id } }')));
  assert.equal(failed.errors?.[0]?.extensions.code, "INTERNAL_SERVER_ERROR");
  assert.equal(failed.errors?.[0]?.message, "INTERNAL_SERVER_ERROR");
  failing = false;
  assert.deepEqual(
    await result(await fetch(endpoint, json('{ harness(externalId:"test") { id } }'))),
    { data: { harness: null } },
  );
  await api.close();
});

void test("unexpected field serialization failures expose no internal messages", async (t) => {
  const { harness } = await openHarness(t);
  const state = await harness.inspect(BACKGROUND_CONTEXT);
  t.mock.method(harness, "inspect", async () => ({
    ...state,
    scheduling: "private" as typeof state.scheduling,
  }));
  const { url } = await serve(t, { openHarness: async () => harness });
  const value = await result(
    await fetch(
      new URL("/api/graphql", url),
      json('{ harness(externalId:"test") { inspect { scheduling } } }'),
    ),
  );
  assert.equal(value.errors?.[0]?.extensions.code, "INTERNAL_SERVER_ERROR");
  assert.equal(value.errors?.[0]?.message, "INTERNAL_SERVER_ERROR");
  assert.deepEqual(value.errors?.[0]?.path, ["harness", "inspect", "scheduling"]);
});

void test("failed Harnesses reopen from persisted storage for both protocols without replay", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "graphql-recovery-"));
  const options = { models: createModels(), registry: createRegistry() };
  const storage = await openNodeJsonlStorage(directory, BACKGROUND_CONTEXT);
  const first = await Harness.open(storage, options, BACKGROUND_CONTEXT);
  await first.root(BACKGROUND_CONTEXT);
  t.after(() => first.close(BACKGROUND_CONTEXT));
  const reopening = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let acquisitions = 0;
  const open = t.mock.fn(async () => {
    if (acquisitions++ === 0) return first;
    reopening.resolve();
    await release.promise;
    return Harness.open(
      await openNodeJsonlStorage(directory, BACKGROUND_CONTEXT),
      options,
      BACKGROUND_CONTEXT,
    );
  });
  const { api, url } = await serve(t, { openHarness: open });
  t.after(() => rm(directory, { recursive: true, force: true }));
  const endpoint = new URL("/api/graphql", url);
  const identity = await result(
    await fetch(endpoint, json('{ harness(externalId:"test") { conversation(id:1) { id } } }')),
  );
  const value = identity.data?.harness;
  assert(value && typeof value === "object" && "conversation" in value);
  const conversation = value.conversation;
  assert(conversation && typeof conversation === "object" && "id" in conversation);
  const commit = storage.commit.bind(storage);
  const fault = t.mock.method(storage, "commit", async (...args: Parameters<typeof commit>) => {
    await commit(...args);
    throw new Error("private failure after persistence");
  });
  const failed = await result(
    await fetch(
      endpoint,
      json(
        "mutation($id:ID!) { configure(input:{conversationId:$id,change:{thinkingLevel:high}}) }",
        { id: conversation.id },
      ),
    ),
  );
  assert.equal(failed.errors?.[0]?.extensions.code, "INTERNAL_SERVER_ERROR");
  assert.equal((await first.closed).reason, "failed");
  assert.equal(open.mock.callCount(), 1);
  const rest = fetch(`${url}/c/1/context`);
  const graphql = fetch(
    endpoint,
    json('{ harness(externalId:"test") { conversation(id:1) { id agent { thinkingLevel } } } }'),
  );
  await reopening.promise;
  release.resolve();
  assert.equal((await rest).status, 200);
  assert.deepEqual(await result(await graphql), {
    data: { harness: { conversation: { id: conversation.id, agent: { thinkingLevel: "high" } } } },
  });
  assert.equal(open.mock.callCount(), 2);
  assert.equal(fault.mock.callCount(), 1);
  await api.close();
});

void test("shutdown joins admitted catalog work and rejects acquisitions after body decoding", async (t) => {
  const { harness } = await openHarness(t);
  let ownerClosing = false;
  harness.subscribeClose(() => {
    ownerClosing = true;
  });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<readonly string[]>();
  const { api, url } = await serve(t, {
    openHarness: async () => harness,
    listHarnesses: async () => {
      entered.resolve();
      return release.promise;
    },
  });
  const endpoint = new URL("/api/graphql", url);
  assert.equal((await fetch(`${url}/inspect`)).status, 200);
  const pending = fetch(endpoint, json("{ harnesses { id } }"));
  await entered.promise;
  let closed = false;
  const closing = api.close().then(() => {
    closed = true;
  });
  assert.equal((await fetch(endpoint, json("{ __typename }"))).status, 503);
  assert.equal(closed, false);
  assert.equal(ownerClosing, false);
  release.resolve([]);
  assert.deepEqual(await result(await pending), { data: { harnesses: [] } });
  await closing;
  assert.equal(ownerClosing, true);
  const upload = await serve(t, {
    openHarness: async () => {
      assert.fail("shutdown must seal acquisitions");
    },
  });
  const started = Promise.withResolvers<void>();
  upload.server.once("request", () => started.resolve());
  const response = Promise.withResolvers<number>();
  const request = httpRequest(
    `${upload.url}/c/1/configure`,
    { method: "POST", headers: { "content-type": "application/json" } },
    (incoming) => {
      incoming.resume();
      incoming.once("end", () => response.resolve(incoming.statusCode!));
    },
  );
  request.on("error", response.reject);
  request.write('{"thinkingLevel":');
  await started.promise;
  const draining = upload.api.close();
  request.end('"high"}');
  assert.equal(await response.promise, 503);
  await draining;
});

void test("disconnect after submission admission does not abort durable generation", async (t) => {
  const acknowledge = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  t.after(() => {
    acknowledge.resolve();
    finish.resolve();
  });
  const { harness, root, faux } = await openHarness(t);
  const entered = Promise.withResolvers<void>();
  const generating = Promise.withResolvers<AbortSignal>();
  faux.setResponses([
    async (_context, options) => {
      assert(options?.signal);
      generating.resolve(options.signal);
      await finish.promise;
      return fauxAssistantMessage("completed");
    },
  ]);
  t.mock.method(harness, "conversation", async () => root);
  const submit = root.submit.bind(root);
  t.mock.method(root, "submit", async (...args: Parameters<typeof submit>) => {
    const receipt = await submit(...args);
    entered.resolve();
    await acknowledge.promise;
    return receipt;
  });
  const { url, server } = await serve(t, { openHarness: async () => harness });
  const endpoint = new URL("/api/graphql", url);
  const identity = await result(
    await fetch(endpoint, json('{ harness(externalId:"test") { conversation(id:1) { id } } }')),
  );
  const value = identity.data?.harness;
  assert(value && typeof value === "object" && "conversation" in value);
  const conversation = value.conversation;
  assert(conversation && typeof conversation === "object" && "id" in conversation);
  const disconnected = Promise.withResolvers<void>();
  server.once("request", (_request, response) => response.once("close", disconnected.resolve));
  const controller = new AbortController();
  const pending = fetch(endpoint, {
    ...json(
      'mutation($id:ID!) { submit(input:{conversationId:$id,submission:{input:{content:{text:"hello"},requestId:"disconnected"}}}) { submissionId } }',
      { id: conversation.id },
    ),
    signal: controller.signal,
  });
  await entered.promise;
  const signal = await generating.promise;
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  await disconnected.promise;
  assert.equal(signal.aborted, false);
  acknowledge.resolve();
  const record = await harness.commit(
    (tx) => tx.submissionByRequest(root.id, "disconnected"),
    BACKGROUND_CONTEXT,
  );
  assert(record);
  const receipt = await harness.submission(record.id, BACKGROUND_CONTEXT);
  assert(receipt);
  finish.resolve();
  assert.equal((await receipt.wait(BACKGROUND_CONTEXT)).status, "done");
  assert.equal(faux.state.callCount, 1);
});

void test("execution errors without source locations still receive safe error codes", async (t) => {
  const { harness, root } = await openHarness(t);
  const id = await harness.commit(
    (tx) =>
      tx.createTask(
        CompactionTask,
        { reason: "manual" },
        { conversationId: root.id, ownership: { kind: "conversation" } },
      ),
    BACKGROUND_CONTEXT,
  );
  const record = await harness.getTask(id, BACKGROUND_CONTEXT);
  assert(record);
  const path = ["harness", "inspect", "tasks", 0, "state", "migrates"];
  t.mock.method(harness, "inspect", async () => ({
    scheduling: "paused",
    submissions: [],
    tasks: [
      {
        record,
        state: {
          kind: "ready",
          get migrates(): boolean {
            throw new GraphQLError("private", { path });
          },
        },
      },
    ],
  }));
  const { url } = await serve(t, { openHarness: async () => harness });
  const value = await result(
    await fetch(
      new URL("/api/graphql", url),
      json('{ harness(externalId:"test") { inspect { tasks { state { migrates } } } } }'),
    ),
  );
  assert.deepEqual(value.errors, [
    { message: "INTERNAL_SERVER_ERROR", path, extensions: { code: "INTERNAL_SERVER_ERROR" } },
  ]);
});

void test("shutdown releases a watch acquired by an already admitted request", async (t) => {
  const release = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  const { harness, root } = await openHarness(t);
  const acquired = Promise.withResolvers<void>();
  const watch = root.watch.bind(root);
  t.mock.method(harness, "conversation", async () => root);
  t.mock.method(root, "watch", async (context: Parameters<typeof watch>[0]) => {
    const result = await watch(context);
    acquired.resolve();
    await release.promise;
    return result;
  });
  const { api, url } = await serve(t, { openHarness: async () => harness });
  const pending = fetch(`${url}/c/1/watch`);
  await acquired.promise;
  const closing = api.close();
  release.resolve();
  assert.equal((await pending).status, 503);
  await closing;
  assert.deepEqual(await harness.closed, { reason: "closed" });
});
