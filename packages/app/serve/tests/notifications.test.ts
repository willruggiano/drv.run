import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Activity, activityDefaults } from "../activity.ts";
import { Notifications } from "../notifications.ts";
import { Metadata } from "../sessions.ts";
import { pushMessage } from "../push-message.ts";
import { vapidKey } from "../push.ts";
import { httpServer } from "../server.ts";
import { fixture, waitFor } from "./sessions-testing.ts";

const source = { instance: "instance1", incarnation: "boot1", terminal: "terminal1" };
await test("native Pi completion reaches the durable inbox without a terminal or browser", async (t) => {
  const f = await fixture(t);
  const activity = new Activity(":memory:");
  const notifications = new Notifications(activity, { activity: activityDefaults, push: null });
  t.after(() => notifications.close());
  await f.reopen({ onSession: (session) => notifications.attach(session) });
  const session = await f.create();
  await session.root.commit(async (tx) => {
    (await tx.doc(Metadata, session.root.id)).name = "Notification test";
  }, BACKGROUND_CONTEXT);
  f.faux.setResponses([fauxAssistantMessage("Original assistant message\nSecond line")]);
  await session.root.submit({ type: "input", content: "PRIVATE PROMPT" }, BACKGROUND_CONTEXT);
  await session.root.waitForIdle(BACKGROUND_CONTEXT);
  await waitFor(async () => activity.history().length === 1);
  assert.equal(activity.history().length, 1);
  assert.deepEqual(activity.history()[0].event, {
    type: "status",
    record: {
      id: String(session.root.id),
      state: "done",
      app: "pi",
      title: "Notification test",
      msg: "Original assistant message\nSecond line",
    },
  });
  assert.equal(activity.sources()[0].source.incarnation, session.id);
  const message = pushMessage(activity.history()[0]);
  assert.equal(message.title, "Notification test");
  assert.equal(message.body, "Original assistant message\nSecond line");
  assert.equal(message.url, `/sessions/${session.id}/conversations/${session.root.id}`);
  assert.equal(activity.history()[0].delivery, "pending");
  await f.reopen({ onSession: (session) => notifications.attach(session) });
  await f.sessions.get(session.id);
  assert.equal(activity.history().length, 1, "snapshot on reopen must not alert again");
  assert.equal(activity.sources()[0].available, true);
  assert.equal(
    activity.history()[0].delivery,
    "pending",
    "restart must preserve accepted undelivered alerts",
  );
  await notifications.deliver();
  assert.equal(activity.history()[0].delivery, "disabled");
  await f.sessions.close();
});
await test("settings subscriptions retain the same-origin boundary and Activity routes are removed", async (t) => {
  const f = await fixture(t);
  const activity = new Activity(":memory:");
  const notifications = new Notifications(activity, { activity: activityDefaults, push: null });
  t.after(() => notifications.close());
  const server = httpServer(
    f.sessions,
    "127.0.0.1",
    undefined,
    undefined,
    undefined,
    undefined,
    notifications,
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  for (const frontend of ["elm", "htmx"]) {
    for (const path of ["activity", "activity/events", "activity/read", "activity/subscribe"])
      assert.equal((await fetch(`${base}/${frontend}/${path}`)).status, 404);
    const sessions = await fetch(`${base}/${frontend}/sessions`, { redirect: "manual" });
    assert.equal(sessions.status, 303);
    assert.equal(sessions.headers.get("Location"), `/${frontend}/`);
    const endpoint = "https://push.example/device";
    const subscription = { endpoint };
    activity.subscribe(endpoint, subscription);
    const write = (origin?: string) =>
      fetch(`${base}/${frontend}/settings/push/unsubscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
        body: JSON.stringify({ endpoint }),
      });
    assert.equal((await write()).status, 403);
    assert.equal((await write("https://attacker.example")).status, 403);
    assert.deepEqual(activity.subscriptions(), [subscription]);
    assert.equal((await write(base)).status, 204);
    assert.deepEqual(activity.subscriptions(), []);
    const response = await fetch(`${base}/${frontend}/settings/push/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base },
      body: "{}",
    });
    assert.equal(response.status, 409);
  }
});
await test("push failures are retried finitely and never erase accepted activity", async (t) => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  const options = { ...activityDefaults, burst: 1, intervalMs: 1000 };
  const activity = new Activity(":memory:", options);
  const ec = createECDH("prime256v1"),
    publicKey = ec.generateKeys();
  const key = vapidKey({
    kty: "EC",
    crv: "P-256",
    d: ec.getPrivateKey().toString("base64url"),
    x: publicKey.subarray(1, 33).toString("base64url"),
    y: publicKey.subarray(33).toString("base64url"),
  });
  const push = {
    origins: ["https://push.example"],
    subject: "mailto:owner@example.org",
    privateKeyFile: "/run/secrets/vapid",
  };
  let calls = 0;
  const notifications = new Notifications(activity, { activity: options, push }, key, async () => {
    calls++;
    return 302;
  });
  t.after(() => notifications.close());
  activity.subscribe("https://push.example/id", {
    endpoint: "https://push.example/id",
    keys: { p256dh: publicKey.toString("base64url"), auth: randomBytes(16).toString("base64url") },
  });
  activity.accept(source, 1, { type: "status", record: { id: "", state: "done" } });
  for (let i = 0; i < 4; i++) {
    await notifications.deliver();
    now += 1001;
  }
  assert.equal(calls, 3);
  assert.equal(activity.history().length, 1);
  assert.equal(activity.history()[0].delivery, "failed");
  assert.equal(activity.takePending(), undefined);
});

await test("tool continuations produce one settled notification, then another for the next input", async (t) => {
  const f = await fixture(t);
  const activity = new Activity(":memory:");
  const notifications = new Notifications(activity, { activity: activityDefaults, push: null });
  t.after(() => notifications.close());
  await f.reopen({ onSession: (session) => notifications.attach(session) });
  const session = await f.create();
  const continued = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  t.after(() => finish.resolve());
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("write", { path: "test.txt", content: "test" }), {
      stopReason: "toolUse",
    }),
    async () => {
      continued.resolve();
      await finish.promise;
      return fauxAssistantMessage("All tools finished.");
    },
    fauxAssistantMessage("Second response."),
  ]);
  await session.root.submit({ type: "input", content: "Do some work" }, BACKGROUND_CONTEXT);
  await continued.promise;
  assert.equal(activity.history().length, 0, "a tool-calling generation is not settled");
  finish.resolve();
  await session.root.waitForIdle(BACKGROUND_CONTEXT);
  await waitFor(async () => activity.history().length === 1);
  assert.equal(pushMessage(activity.history()[0]).body, "All tools finished.");
  await session.root.submit({ type: "input", content: "Again" }, BACKGROUND_CONTEXT);
  await session.root.waitForIdle(BACKGROUND_CONTEXT);
  await waitFor(async () => activity.history().length === 2);
  assert.equal(pushMessage(activity.history()[0]).body, "Second response.");
});

await test("queued follow-up runs do not notify until the conversation needs input", async (t) => {
  const f = await fixture(t);
  const activity = new Activity(":memory:");
  const notifications = new Notifications(activity, { activity: activityDefaults, push: null });
  t.after(() => notifications.close());
  await f.reopen({ onSession: (session) => notifications.attach(session) });
  const session = await f.create();
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  t.after(() => finish.resolve());
  f.faux.setResponses([
    async () => {
      started.resolve();
      await finish.promise;
      return fauxAssistantMessage("First response.");
    },
    fauxAssistantMessage("Follow-up response."),
  ]);
  await session.root.submit({ type: "input", content: "First" }, BACKGROUND_CONTEXT);
  await started.promise;
  await session.root.submit(
    { type: "input", content: "Follow up", whenBusy: "followUp" },
    BACKGROUND_CONTEXT,
  );
  finish.resolve();
  await session.root.waitForIdle(BACKGROUND_CONTEXT);
  await waitFor(async () => activity.history().length > 0);
  assert.equal(activity.history().length, 1);
  assert.equal(pushMessage(activity.history()[0]).body, "Follow-up response.");
});

await test("user cancellation is silent", async (t) => {
  const f = await fixture(t);
  const activity = new Activity(":memory:");
  const notifications = new Notifications(activity, { activity: activityDefaults, push: null });
  t.after(() => notifications.close());
  await f.reopen({ onSession: (session) => notifications.attach(session) });
  const session = await f.create();
  const started = Promise.withResolvers<void>();
  f.faux.setResponses([
    async (_messages, options) => {
      assert(options?.signal);
      started.resolve();
      await new Promise<void>((resolve) => {
        if (options.signal?.aborted) resolve();
        else options.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return fauxAssistantMessage("Partial response", { stopReason: "aborted" });
    },
  ]);
  await session.root.submit({ type: "input", content: "Work" }, BACKGROUND_CONTEXT);
  await started.promise;
  await session.root.abort(BACKGROUND_CONTEXT);
  await waitFor(async () => activity.sources()[0].records[0].state === "idle");
  assert.equal(activity.history().length, 0);
});

await test("ownerless branches notify with their own destination; task-owned helpers are silent", async (t) => {
  const f = await fixture(t);
  const activity = new Activity(":memory:");
  const notifications = new Notifications(activity, { activity: activityDefaults, push: null });
  t.after(() => notifications.close());
  await f.reopen({ onSession: (session) => notifications.attach(session) });
  const session = await f.create();
  f.faux.setResponses([
    fauxAssistantMessage("Root answer."),
    fauxAssistantMessage("Branch answer."),
  ]);
  await session.root.submit({ type: "input", content: "Root" }, BACKGROUND_CONTEXT);
  await session.root.waitForIdle(BACKGROUND_CONTEXT);
  await waitFor(async () => activity.history().length === 1);
  const context = await session.root.context(BACKGROUND_CONTEXT);
  const branch = await session.root.fork(
    context.entries.at(-1)!.id,
    { ownership: { kind: "ownerless" } },
    BACKGROUND_CONTEXT,
  );
  await branch.submit({ type: "input", content: "Branch" }, BACKGROUND_CONTEXT);
  await branch.waitForIdle(BACKGROUND_CONTEXT);
  await waitFor(async () => activity.history().length === 2);
  assert.equal(
    pushMessage(activity.history()[0]).url,
    `/sessions/${session.id}/conversations/${branch.id}`,
  );
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  t.after(() => finish.resolve());
  f.faux.setResponses([
    async () => {
      started.resolve();
      await finish.promise;
      return fauxAssistantMessage("Parent finished.");
    },
    fauxAssistantMessage("Helper answer."),
  ]);
  await session.root.submit({ type: "input", content: "Parent work" }, BACKGROUND_CONTEXT);
  await started.promise;
  const parentTask = await session.harness.commit(
    async (tx) =>
      (
        await tx.scanTasks(
          { conversationId: session.root.id, kind: "pi.generation", order: "descending" },
          1,
        )
      ).items[0].id,
    BACKGROUND_CONTEXT,
  );
  const helper = await session.root.fork(
    context.entries.at(-1)!.id,
    { ownership: { kind: "task", taskId: parentTask } },
    BACKGROUND_CONTEXT,
  );
  await helper.submit({ type: "input", content: "Helper" }, BACKGROUND_CONTEXT);
  await helper.waitForIdle(BACKGROUND_CONTEXT);
  assert.equal(activity.history().length, 2);
  assert(!activity.sources()[0].records.some((record) => record.id === String(helper.id)));
  finish.resolve();
  await session.root.waitForIdle(BACKGROUND_CONTEXT);
  await waitFor(async () => activity.history().length === 3);
  assert.equal(pushMessage(activity.history()[0]).body, "Parent finished.");
});

await test("upgrade supersedes pending per-generation alerts without losing their history", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const activity = new Activity(":memory:");
  const notifications = new Notifications(activity, { activity: activityDefaults, push: null });
  t.after(() => notifications.close());
  activity.accept({ instance: "host-pi", incarnation: session.id, terminal: "api" }, 1, {
    type: "status",
    record: { id: `${session.root.id}/123`, state: "done", app: "pi" },
  });
  await f.reopen({ onSession: (session) => notifications.attach(session) });
  await f.sessions.get(session.id);
  assert.equal(activity.history().length, 1);
  assert.equal(activity.history()[0].delivery, "superseded");
  assert.equal(activity.takePending(), undefined);
  assert.deepEqual(
    activity.sources()[0].records.map((record) => record.id),
    [String(session.root.id)],
  );
});
