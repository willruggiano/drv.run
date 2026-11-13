import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
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
  defineDoc,
  StorageRequestError,
  Harness,
  createRegistry,
  CompactionTask,
} from "@earendil-works/pi-durable";
import { openHarness, serve, events, settingsFixture } from "../../tests/fixtures.ts";

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

for (const create of [false, true]) {
  void test(`GraphQL and SSE share acquisition (create=${create}), disconnect does not cancel opening, and shutdown ends both`, async (t) => {
    const { harness } = await openHarness(t);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<Harness>();
    const open = t.mock.fn(
      async (_id: string, context: typeof BACKGROUND_CONTEXT, requested: boolean) => {
        assert.equal(requested, create);
        assert.equal(context.abortSignal, undefined);
        entered.resolve();
        return release.promise;
      },
    );
    const { url, api, server } = await serve(t, { openHarness: open });
    const endpoint = new URL("/api/graphql", url);
    const controller = new AbortController();
    const disconnected = Promise.withResolvers<void>();
    server.once("request", (_request, response) => response.once("close", disconnected.resolve));
    const first = fetch(endpoint, {
      ...json(
        create
          ? 'mutation { open(input:{externalId:"test"}) { harness { id } } }'
          : '{ harness(externalId:"test") { id } }',
      ),
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
}

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
    throw new StorageRequestError("private failure after persistence");
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

void test("open publishes persisted storage without a root and keeps its identity across API restart", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "graphql-provision-"));
  const owners: Array<{ close(): Promise<void> }> = [];
  t.after(async () => {
    for (const owner of owners) await owner.close();
    await rm(directory, { recursive: true, force: true });
  });
  const models = createModels();
  const acquisitions: boolean[] = [];
  const options = {
    models,
    isValidExternalId: (id: string) => /^[a-z]+$/.test(id),
    listHarnesses: () => readdir(directory),
    async openHarness(id: string, context: typeof BACKGROUND_CONTEXT, create: boolean) {
      assert.equal(context.abortSignal, undefined);
      assert.equal(options.isValidExternalId(id), true);
      acquisitions.push(create);
      if (!create && !(await readdir(directory)).includes(id)) return undefined;
      return Harness.open(
        await openNodeJsonlStorage(join(directory, id), context),
        { models, registry: createRegistry() },
        context,
      );
    },
  };
  const first = await serve(t, options);
  owners.push(first.api);
  const endpoint = new URL("/api/graphql", first.url);
  const catalog = "{ harnesses { id externalId } }";
  assert.deepEqual(await result(await fetch(endpoint, json(catalog))), { data: { harnesses: [] } });
  assert.deepEqual(acquisitions, []);
  assert.deepEqual(
    await result(await fetch(endpoint, json('{ harness(externalId:"test") { id } }'))),
    { data: { harness: null } },
  );
  assert.equal((await fetch(`${first.url}/inspect`)).status, 404);
  assert.deepEqual(await readdir(directory), []);
  const query =
    'mutation { open(input:{externalId:"test"}) { harness { id externalId root { id } inspect { scheduling } } } }';
  const [one, two] = await Promise.all([
    fetch(endpoint, json(query)),
    fetch(endpoint, json(query)),
  ]);
  const opened = await result(one);
  assert.deepEqual(await result(two), opened);
  assert.deepEqual(await result(await fetch(endpoint, json(query))), opened);
  const value = opened.data?.open as { harness: { id: string } };
  assert.equal(typeof value.harness.id, "string");
  const identity = { id: value.harness.id, externalId: "test" };
  assert.deepEqual(opened, {
    data: { open: { harness: { ...identity, root: null, inspect: { scheduling: "paused" } } } },
  });
  assert.deepEqual(acquisitions, [false, false, true]);
  assert.deepEqual(await result(await fetch(endpoint, json(catalog))), {
    data: { harnesses: [identity] },
  });
  const root = await result(
    await fetch(
      endpoint,
      json("mutation($id:ID!) { root(input:{harnessId:$id}) { conversation { durableId } } }", {
        id: identity.id,
      }),
    ),
  );
  assert.deepEqual(root.data, { root: { conversation: { durableId: 1 } } });
  const iterator = events(await fetch(`${first.url}/c/1/watch`));
  assert.equal((await iterator.next()).value?.type, "snapshot");
  const closing = first.api.close();
  assert.deepEqual((await iterator.next()).value, { type: "end", value: { reason: "cancelled" } });
  await iterator.next();
  await closing;
  const second = await serve(t, options);
  owners.push(second.api);
  const reopened = new URL("/api/graphql", second.url);
  assert.deepEqual(await result(await fetch(reopened, json(catalog))), {
    data: { harnesses: [identity] },
  });
  assert.deepEqual(acquisitions, [false, false, true]);
  const lookup = await result(
    await fetch(
      reopened,
      json(
        '{ harness(externalId:"test") { id externalId root { durableId } inspect { scheduling } } }',
      ),
    ),
  );
  assert.deepEqual(lookup.data, {
    harness: { ...identity, root: { durableId: 1 }, inspect: { scheduling: "paused" } },
  });
  assert.deepEqual(acquisitions, [false, false, true, false]);
  await second.api.close();
});

void test("HTTP open validates keys before provisioning and distinguishes refusal from factory failure", async (t) => {
  let fail = false;
  const factory = t.mock.fn(
    async (_id: string, _context: typeof BACKGROUND_CONTEXT, create: boolean) => {
      assert.equal(create, true);
      if (fail) throw new StorageRequestError("private provisioning failure");
      return undefined;
    },
  );
  const { url } = await serve(t, {
    isValidExternalId: (id) => /^[a-z]+$/.test(id),
    openHarness: factory,
  });
  const endpoint = new URL("/api/graphql", url);
  const query = "mutation($id:String!) { open(input:{externalId:$id}) { harness { id } } }";
  for (const id of ["", "../escape", "/absolute"]) {
    const response = await result(await fetch(endpoint, json(query, { id })));
    assert.equal(response.errors?.[0]?.extensions.code, "BAD_REQUEST");
    assert.deepEqual(response.data, { open: null });
  }
  assert.equal(factory.mock.callCount(), 0);
  const denied = await result(await fetch(endpoint, json(query, { id: "archived" })));
  assert.equal(denied.errors?.[0]?.extensions.code, "NOT_FOUND");
  assert.equal(factory.mock.callCount(), 1);
  fail = true;
  const failed = await result(await fetch(endpoint, json(query, { id: "test" })));
  assert.equal(failed.errors?.[0]?.extensions.code, "INTERNAL_SERVER_ERROR");
  assert.equal(failed.errors?.[0]?.message, "INTERNAL_SERVER_ERROR");
  assert.equal(factory.mock.callCount(), 2);
});

void test("HTTP document operations borrow the shared Harness and pass request context to deployment", async (t) => {
  const { harness } = await openHarness(t);
  const token = defineDoc({
    scope: "session",
    kind: "app.preferences",
    version: 1,
    initial: () => ({}),
    checkpointWhen: () => false,
  });
  const factory = t.mock.fn(async () => harness);
  const { url } = await serve(t, {
    openHarness: factory,
    documents: {
      async definitions(id, scope, context) {
        assert.equal(id, "test");
        assert.deepEqual({ ...scope }, { kind: "session" });
        assert.equal(context.abortSignal?.aborted, false);
        return [token];
      },
      async resolve(id, address, context) {
        assert.equal(id, "test");
        assert.deepEqual(
          { ...address, scope: { ...address.scope } },
          {
            kind: token.definition.kind,
            scope: { kind: "session" },
          },
        );
        assert.equal(context.abortSignal?.aborted, false);
        return { token, write: { initialize: true, validate: () => true } };
      },
    },
  });
  const endpoint = new URL("/api/graphql", url);
  const read =
    '{ harness(externalId:"test") { id documentDefinitions(scope:{kind:session}) { kind } snapshot(address:{kind:"app.preferences",scope:{kind:session}}) } }';
  const initial = await result(await fetch(endpoint, json(read)));
  const value = initial.data?.harness as { id: string; snapshot: unknown };
  assert.equal(value.snapshot, null);
  const content = { setting: true };
  const written = await result(
    await fetch(
      endpoint,
      json(
        'mutation($id:ID!,$content:JsonObject!) { replaceDocument(input:{harnessId:$id,address:{kind:"app.preferences",scope:{kind:session}},content:$content}) }',
        { id: value.id, content },
      ),
    ),
  );
  assert.deepEqual(written, { data: { replaceDocument: content } });
  assert.deepEqual(await harness.snapshot(token, BACKGROUND_CONTEXT), content);
  assert.deepEqual(await result(await fetch(endpoint, json(read))), {
    data: {
      harness: {
        id: value.id,
        documentDefinitions: [{ kind: token.definition.kind }],
        snapshot: content,
      },
    },
  });
  assert.equal((await fetch(`${url}/inspect`)).status, 200);
  assert.equal(factory.mock.callCount(), 1);
  assert.equal((await harness.inspect(BACKGROUND_CONTEXT)).scheduling, "paused");
});

void test("disconnect cancels document authorization waits before mutation admission", async (t) => {
  const { harness, storage } = await openHarness(t);
  const token = defineDoc({
    scope: "session",
    kind: "app.pending",
    version: 1,
    initial: () => ({}),
    checkpointWhen: () => false,
  });
  const entered = Promise.withResolvers<AbortSignal>();
  const release = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  const { api, url, server } = await serve(t, {
    openHarness: async () => harness,
    documents: {
      definitions: async () => [],
      async resolve(_id, _address, context) {
        assert(context.abortSignal);
        entered.resolve(context.abortSignal);
        await release.promise;
        return { token, write: { initialize: true, validate: () => true } };
      },
    },
  });
  const endpoint = new URL("/api/graphql", url);
  const lookup = await result(await fetch(endpoint, json('{ harness(externalId:"test") { id } }')));
  const value = lookup.data?.harness as { id: string };
  const writes = t.mock.method(storage, "commit");
  const disconnected = Promise.withResolvers<void>();
  server.once("request", (_request, response) => response.once("close", disconnected.resolve));
  const controller = new AbortController();
  const request = fetch(endpoint, {
    ...json(
      'mutation($id:ID!) { replaceDocument(input:{harnessId:$id,address:{kind:"app.pending",scope:{kind:session}},content:{}}) }',
      { id: value.id },
    ),
    signal: controller.signal,
  });
  const signal = await entered.promise;
  controller.abort();
  await assert.rejects(request, { name: "AbortError" });
  await disconnected.promise;
  assert.equal(signal.aborted, true);
  await api.close();
  assert.deepEqual(await harness.closed, { reason: "closed" });
  release.resolve();
  await release.promise;
  assert.equal(writes.mock.callCount(), 0);
});

void test("HTTP settings save returns typed results and conflicts without acquiring a Harness", async (t) => {
  const settings = settingsFixture();
  const initial = await settings.web.read(BACKGROUND_CONTEXT);
  const { url } = await serve(t, {
    settings,
    openHarness: async () => assert.fail("settings must not acquire a Harness"),
  });
  const endpoint = new URL("/api/graphql", url);
  const mutation = `mutation($input:SaveSettingsInput!) { saveSettings(input:$input) { __typename ... on WebSettings { revision wrapCode } } }`;
  const variables = {
    input: {
      web: {
        expectedRevision: initial.revision,
        settings: { ...initial.settings, wrapCode: true },
      },
    },
  };
  const response = await result(await fetch(endpoint, json(mutation, variables)));
  assert.equal(response.errors, undefined);
  const saved = await settings.web.read(BACKGROUND_CONTEXT);
  assert.deepEqual(response.data, {
    saveSettings: { __typename: "WebSettings", revision: saved.revision, wrapCode: true },
  });
  const conflict = await result(await fetch(endpoint, json(mutation, variables)));
  assert.equal(conflict.errors?.[0]?.extensions?.code, "CONFIGURATION_CONFLICT");
  assert.equal(conflict.errors?.[0]?.message, "CONFIGURATION_CONFLICT");
  assert.equal(conflict.data?.saveSettings, null);
  assert.deepEqual(await settings.web.read(BACKGROUND_CONTEXT), saved);
  assert.deepEqual(
    await settings.harness.read(BACKGROUND_CONTEXT),
    await settingsFixture().harness.read(BACKGROUND_CONTEXT),
  );
  endpoint.search = new URLSearchParams({
    query: mutation,
    variables: JSON.stringify(variables),
  }).toString();
  assert.equal((await fetch(endpoint)).status, 405);
});

void test("HTTP disconnect leaves an admitted settings save with its service and never replays it", async (t) => {
  const settings = settingsFixture();
  const initial = await settings.web.read(BACKGROUND_CONTEXT);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  const committed = Promise.withResolvers<void>();
  const replace = settings.web.replace.bind(settings.web);
  const save = t.mock.method(
    settings.web,
    "replace",
    async (...args: Parameters<typeof replace>) => {
      entered.resolve();
      await release.promise;
      const value = await replace(...args);
      committed.resolve();
      return value;
    },
  );
  const { url } = await serve(t, {
    settings,
    openHarness: async () => assert.fail("settings must not acquire a Harness"),
  });
  const endpoint = new URL("/api/graphql", url);
  const controller = new AbortController();
  const request = fetch(endpoint, {
    ...json(`mutation($input:SaveSettingsInput!) { saveSettings(input:$input) { __typename } }`, {
      input: {
        web: {
          expectedRevision: initial.revision,
          settings: { ...initial.settings, wrapCode: true },
        },
      },
    }),
    signal: controller.signal,
  });
  await entered.promise;
  controller.abort();
  await assert.rejects(request, { name: "AbortError" });
  release.resolve();
  await committed.promise;
  const read = await result(
    await fetch(
      endpoint,
      json(`{ settings(app:web) { ... on WebSettings { wrapCode revision } } }`),
    ),
  );
  const saved = await settings.web.read(BACKGROUND_CONTEXT);
  assert.deepEqual(read.data, { settings: { wrapCode: true, revision: saved.revision } });
  assert.equal(save.mock.callCount(), 1);
});

void test("API shutdown drains a pending settings replacement and rejects new work", async (t) => {
  const settings = settingsFixture();
  const initial = await settings.harness.read(BACKGROUND_CONTEXT);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  const replace = settings.harness.replace.bind(settings.harness);
  t.mock.method(settings.harness, "replace", async (...args: Parameters<typeof replace>) => {
    entered.resolve();
    await release.promise;
    return replace(...args);
  });
  const { api, url } = await serve(t, {
    settings,
    openHarness: async () => assert.fail("settings must not acquire a Harness"),
  });
  const endpoint = new URL("/api/graphql", url);
  const request = fetch(
    endpoint,
    json(
      `mutation($input:SaveSettingsInput!) { saveSettings(input:$input) { ... on HarnessSettings { revision } } }`,
      { input: { harness: { expectedRevision: initial.revision, settings: initial.settings } } },
    ),
  );
  await entered.promise;
  const closing = api.close();
  assert.equal(
    (await fetch(endpoint, json(`{ settings(app:harness) { __typename } }`))).status,
    503,
  );
  release.resolve();
  const response = await result(await request);
  assert.equal(response.errors, undefined);
  assert.deepEqual(response.data, {
    saveSettings: { revision: (await settings.harness.read(BACKGROUND_CONTEXT)).revision },
  });
  await closing;
});
