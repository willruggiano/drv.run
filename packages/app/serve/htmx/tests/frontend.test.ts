import assert from "node:assert/strict";
import { request } from "node:http";
import { copyJson } from "@earendil-works/chord";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, InboxDoc, LiveDoc } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Review } from "harness";
import { modelKey, targetKey } from "../forms.ts";
import { Environment, Metadata } from "../../sessions.ts";
import { conversationURL } from "../../presentation.ts";
import { ConversationFragments } from "../frontend.ts";
import { benchmarkFixture } from "../../benchmark.ts";
import { fixture, readHistory, waitFor, model } from "../../tests/sessions-testing.ts";
import { serve } from "../../tests/testing.ts";

const context = BACKGROUND_CONTEXT;

await test("archive endpoints require same-origin POSTs and hide sessions from the catalog", async (t) => {
  const f = await fixture(t);
  const base = await serve(t, f.sessions);
  for (const frontend of ["htmx", "elm"]) {
    const session = await f.create();
    const path =
      frontend === "elm"
        ? `${conversationURL(session, undefined, "elm")}/archive`
        : `/htmx/sessions/${session.id}/archive`;
    assert.equal((await fetch(base + path)).status, 405);
    const rejectedHeaders: Record<string, string>[] = [{}, { Origin: "http://evil.test" }];
    for (const headers of rejectedHeaders) {
      const response = await fetch(base + path, {
        method: "POST",
        headers,
        body: new URLSearchParams(),
        redirect: "manual",
      });
      assert.equal(response.status, 403);
    }
    assert.deepEqual(
      (await f.sessions.catalog()).sessions.map((item) => item.id),
      [session.id],
    );
    const response = await fetch(base + path, {
      method: "POST",
      headers: { Origin: base },
      body: new URLSearchParams(),
      redirect: "manual",
    });
    assert.equal(response.status, frontend === "elm" ? 200 : 303);
    if (frontend === "elm") assert.deepEqual(await response.json(), { archived: true });
    else assert.equal(response.headers.get("location"), "/htmx/");
    assert.deepEqual((await f.sessions.catalog()).sessions, []);
    assert.deepEqual((await (await fetch(base + "/elm?data=1")).json()).sessions, []);
    const missing = path.replace(session.id, randomUUID());
    assert.equal(
      (
        await fetch(base + missing, {
          method: "POST",
          headers: { Origin: base },
          body: new URLSearchParams(),
        })
      ).status,
      404,
    );
  }
});

await test("HTML submission retries reuse Durable request IDs and review transitions are idempotent", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const base = await serve(t, f.sessions);
  const path = conversationURL(session);
  const post = (path: string, data: Record<string, string> = {}) =>
    fetch(base + path, {
      method: "POST",
      headers: { Origin: base },
      body: new URLSearchParams(data),
      redirect: "manual",
    });
  f.faux.setResponses([fauxAssistantMessage("Done.")]);
  const data = { content: "Exactly once", requestId: randomUUID(), whenBusy: "reject" };
  const first = await post(`${path}/submit`, data);
  assert.equal(first.status, 303);
  assert.equal(first.headers.get("location"), path);
  await session.root.waitForIdle(context);
  const history = await readHistory(session.root);
  assert.equal((await post(`${path}/submit`, data)).status, 303);
  assert.deepEqual(await readHistory(session.root), history);
  assert.equal(f.faux.state.callCount, 1);

  f.faux.setResponses([fauxAssistantMessage("No findings.")]);
  const reviewResponse = await post(`${path}/review`);
  assert.equal(reviewResponse.status, 303);
  const reviewPath = reviewResponse.headers.get("location")!;
  assert.equal((await post(`${path}/review`)).headers.get("location"), reviewPath);
  const id = (await session.harness.snapshot(Review, session.root.id, context))?.active;
  assert(id !== undefined);
  const review = await session.harness.conversation(id, context);
  assert(review);
  await review.waitForIdle(context);
  f.faux.setResponses([fauxAssistantMessage("Received.")]);
  assert.equal((await post(`${reviewPath}/end-review`)).headers.get("location"), path);
  await session.root.waitForIdle(context);
  const after = await readHistory(session.root);
  assert.equal((await post(`${reviewPath}/end-review`)).headers.get("location"), path);
  assert.deepEqual(await readHistory(session.root), after);
  assert.equal(f.faux.state.callCount, 3);
});

await test("HTML forms preserve cross-site, Host, input and size protections", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const base = await serve(t, f.sessions);
  const path = base + conversationURL(session);
  const data = { content: "Rejected", requestId: randomUUID(), whenBusy: "reject" };
  const send = (headers: Record<string, string>, body: BodyInit = new URLSearchParams(data)) =>
    fetch(`${path}/submit`, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
    });
  const origins: Record<string, string>[] = [
    {},
    { Origin: "null" },
    { Origin: "http://evil.test" },
    { Origin: base, "Sec-Fetch-Site": "cross-site" },
  ];
  for (const headers of origins)
    assert.equal((await send(headers)).status, 403, JSON.stringify(headers));
  const badHost = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(path, { headers: { Host: "evil.test" } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(badHost, 403);
  assert.equal(
    (await send({ Origin: base, "Content-Type": "application/json" }, JSON.stringify(data))).status,
    415,
  );
  assert.equal(
    (await send({ Origin: base }, new URLSearchParams({ ...data, whenBusy: "invalid" }))).status,
    400,
  );
  assert.equal(
    (await send({ Origin: base }, new URLSearchParams({ ...data, content: "" }))).status,
    400,
  );
  const duplicate = new URLSearchParams(data);
  duplicate.append("requestId", "another");
  assert.equal((await send({ Origin: base }, duplicate)).status, 400);
  const image = new FormData();
  for (const [key, value] of Object.entries(data)) image.set(key, value);
  image.set("images", new Blob(["<svg></svg>"], { type: "image/svg+xml" }), "unsafe.svg");
  assert.equal((await send({ Origin: base }, image)).status, 400);
  assert.equal(
    (
      await send(
        { Origin: base },
        new URLSearchParams({ ...data, content: "x".repeat(8 * 1024 * 1024) }),
      )
    ).status,
    413,
  );
  assert.deepEqual(await readHistory(session.root), []);
  assert.equal(f.faux.state.callCount, 0);
  const page = await fetch(path);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.equal(page.headers.get("referrer-policy"), "same-origin");
});

await test("document-only projections never re-render completed history; reconnect and reset reconcile identities", () => {
  const { view } = benchmarkFixture(50);
  const renderer = new ConversationFragments("/htmx/sessions/test/conversations/1");
  renderer.render(view, {});
  assert.equal(renderer.metrics.entries, 150);
  const initial = { ...renderer.metrics };
  // Equal immutable state does no work, even for an independently read Review value.
  renderer.render(view, {});
  assert.equal(renderer.metrics.frames, initial.frames);
  assert.equal(renderer.metrics.bytes, initial.bytes);
  for (let i = 0; i < 40; i++)
    renderer.render(
      {
        ...view,
        docs: {
          "pi.live": {
            generation: {
              attempt: 1,
              message: copyJson(fauxAssistantMessage("Live output ".repeat(i + 1)), {
                omitUndefinedProperties: true,
              }),
            },
          },
        },
      },
      {},
    );
  assert.equal(renderer.metrics.entries, 150);
  assert.equal(renderer.metrics.frames, 41);
  const reconnect = new ConversationFragments(renderer.url);
  reconnect.render(view, {});
  assert.equal(reconnect.metrics.entries, 150);
  const reset = { ...view, entries: view.entries.slice(-3) };
  renderer.render(reset, {});
  assert.equal(renderer.metrics.entries, 150);
  reconnect.render(reset, {});
  assert.equal(reconnect.metrics.entries, 150);
});

await test("HTML admission revalidates stale idle controls and supports steer, queue and stop", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const base = await serve(t, f.sessions);
  const path = base + conversationURL(session);
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 30" }), { stopReason: "toolUse" }),
  ]);
  await session.root.submit({ type: "input", content: "Wait" }, context);
  await waitFor(
    async () =>
      !!(await session.harness.snapshot(LiveDoc, session.root.id, context))?.tools?.length,
  );
  const post = (action: string, data: Record<string, string>) =>
    fetch(`${path}/${action}`, {
      method: "POST",
      headers: { Origin: base },
      body: new URLSearchParams(data),
      redirect: "manual",
    });
  assert.equal(
    (
      await post("submit", {
        content: "Stale idle form",
        requestId: randomUUID(),
        whenBusy: "reject",
      })
    ).status,
    409,
  );
  assert.equal((await post("review", {})).status, 409);
  for (const whenBusy of ["followUp", "steer"]) {
    const data = { content: "Queued", requestId: randomUUID(), whenBusy };
    assert.equal((await post("submit", data)).status, 303);
    assert.equal((await post("submit", data)).status, 303);
  }
  const queued = await session.harness.snapshot(InboxDoc, session.root.id, context);
  assert.deepEqual(
    queued?.items.map((item) => item.mode),
    ["followUp", "steer"],
  );
  const branch = await session.root.fork(
    (await readHistory(session.root)).at(-1)!.id,
    { ownership: { kind: "ownerless" } },
    context,
  );
  const cancel = new URLSearchParams({ id: String(queued!.items[0].id) });
  const foreign = await fetch(base + conversationURL(session, branch.id) + "/cancel", {
    method: "POST",
    headers: { Origin: base },
    body: cancel,
    redirect: "manual",
  });
  assert.equal(foreign.status, 404);
  assert.equal(
    (await session.harness.snapshot(InboxDoc, session.root.id, context))?.items.length,
    2,
  );
  assert.equal((await post("cancel", { id: String(queued!.items[0].id) })).status, 303);
  assert.deepEqual(
    (await session.harness.snapshot(InboxDoc, session.root.id, context))?.items.map(
      (item) => item.id,
    ),
    [queued!.items[1].id],
  );
  assert.equal((await post("abort", {})).status, 303);
  await session.root.waitForIdle(context);
  assert.equal((await session.harness.snapshot(LiveDoc, session.root.id, context))?.run, undefined);
  assert.deepEqual((await session.harness.snapshot(InboxDoc, session.root.id, context))?.items, []);
});

await test("HTML settings reject invalid forms before changing configuration or metadata", async (t) => {
  const f = await fixture(t),
    session = await f.create(),
    base = await serve(t, f.sessions);
  const current = async () => ({
    agent: await session.harness.snapshot(AgentDoc, session.root.id, context),
    environment: await session.harness.snapshot(Environment, session.root.id, context),
    metadata: await session.harness.snapshot(Metadata, session.root.id, context),
  });
  const before = await current();
  const valid = {
    name: "A changed name",
    target: targetKey(f.binding),
    model: modelKey(model),
    thinkingLevel: "high",
    baseDirectory: "",
  };
  for (const change of [
    { thinkingLevel: "unsupported" },
    { name: "invalid\nname" },
    { model: modelKey({ provider: "missing", modelId: "missing" }) },
    { target: targetKey({ provider: "missing", target: "missing" }) },
  ]) {
    const response = await fetch(base + conversationURL(session) + "/settings", {
      method: "POST",
      headers: { Origin: base },
      body: new URLSearchParams({ ...valid, ...change }),
      redirect: "manual",
    });
    assert([400, 409].includes(response.status));
    assert.deepEqual(await current(), before);
  }
  const response = await fetch(base + conversationURL(session) + "/settings", {
    method: "POST",
    headers: { Origin: base },
    body: new URLSearchParams(valid),
    redirect: "manual",
  });
  assert.equal(response.status, 303);
  assert.deepEqual((await current()).agent?.model, model);
  assert.equal((await current()).agent?.thinkingLevel, "high");
  assert.equal((await current()).metadata?.name, valid.name);
});

await test("HTML creation validates the initial submission and deduplicates lost responses", async (t) => {
  const f = await fixture(t),
    base = await serve(t, f.sessions);
  const id = randomUUID();
  const data = {
    id,
    target: targetKey(f.binding),
    model: modelKey(model),
    content: "Initial request",
  };
  const post = (data: Record<string, string>) =>
    fetch(base + "/htmx/", {
      method: "POST",
      headers: { Origin: base },
      body: new URLSearchParams(data),
      redirect: "manual",
    });
  assert.equal((await post(data)).status, 400);
  assert.deepEqual((await f.sessions.catalog()).sessions, []);
  f.faux.setResponses([fauxAssistantMessage("Created once.")]);
  const requestId = randomUUID();
  assert.equal((await post({ ...data, requestId })).status, 303);
  const session = await f.sessions.get(id);
  await session.root.waitForIdle(context);
  const before = await readHistory(session.root);
  assert.equal((await post({ ...data, requestId })).status, 303);
  assert.deepEqual(await readHistory(session.root), before);
  assert.equal(f.faux.state.callCount, 1);
  assert.deepEqual((await session.root.agent(context)).model, model);
});

await test("HTML context inspection never opens an execution environment", async (t) => {
  const f = await fixture(t);
  let executions = 0;
  await f.reopen({
    ...f.options,
    env: async () => {
      executions++;
      throw new Error("No environment allowed");
    },
  });
  const session = await f.create(),
    base = await serve(t, f.sessions);
  const before = await readHistory(session.root);
  assert.equal((await fetch(base + conversationURL(session) + "/context")).status, 200);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(base + conversationURL(session) + "/events?pane=context", {
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert(response.body);
  const reader = response.body.getReader();
  assert.equal((await reader.read()).done, false);
  controller.abort();
  reader.releaseLock();
  assert.equal(executions, 0);
  assert.deepEqual(await readHistory(session.root), before);
});
