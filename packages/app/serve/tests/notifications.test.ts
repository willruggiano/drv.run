import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { Activity, activityDefaults } from "../activity.ts";
import { Notifications } from "../notifications.ts";
import { vapidKey } from "../push.ts";
import { httpServer } from "../server.ts";
import { fixture } from "./sessions-testing.ts";

const source = { instance: "instance1", incarnation: "boot1", terminal: "terminal1" };
await test("native Pi completion reaches the durable inbox without a terminal or browser", async (t) => {
  const f = await fixture(t);
  const activity = new Activity(":memory:");
  const notifications = new Notifications(activity, { activity: activityDefaults, push: null });
  t.after(() => notifications.close());
  await f.reopen({ onSession: (session) => notifications.attach(session) });
  const session = await f.create();
  f.faux.setResponses([fauxAssistantMessage("PRIVATE MODEL OUTPUT")]);
  await session.root.submit({ type: "input", content: "PRIVATE PROMPT" }, BACKGROUND_CONTEXT);
  await session.root.waitForIdle(BACKGROUND_CONTEXT);
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.equal(activity.history().length, 1);
  assert.deepEqual(activity.history()[0].event, {
    type: "status",
    record: { id: activity.history()[0].record, state: "done", app: "pi" },
  });
  assert.equal(activity.sources()[0].source.incarnation, session.id);
  await notifications.deliver();
  assert.equal(activity.history()[0].delivery, "disabled");
  await f.reopen({ onSession: (session) => notifications.attach(session) });
  await f.sessions.get(session.id);
  assert.equal(activity.history().length, 1, "snapshot on reopen must not alert again");
  assert.equal(activity.sources()[0].available, true);
  await f.sessions.close();
});
await test("inbox and subscriptions retain the existing same-origin boundary", async (t) => {
  const f = await fixture(t);
  const activity = new Activity(":memory:");
  const notifications = new Notifications(activity, { activity: activityDefaults, push: null });
  t.after(() => notifications.close());
  activity.accept(source, 1, {
    type: "status",
    record: { id: "", state: "blocked", kind: "permission" },
  });
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
  assert.equal((await fetch(base + "/activity")).status, 200);
  const id = activity.history()[0].id;
  const write = (origin?: string) =>
    fetch(base + "/activity/read", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
      body: JSON.stringify({ id }),
    });
  assert.equal((await write()).status, 403);
  assert.equal((await write("https://attacker.example")).status, 403);
  assert.equal(activity.history()[0].read, false);
  assert.equal((await write(base)).status, 204);
  assert.equal(activity.history()[0].read, true);
  assert.equal(activity.sources()[0].records[0].state, "blocked");
  const response = await fetch(base + "/activity/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base },
    body: "{}",
  });
  assert.equal(response.status, 409);
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
