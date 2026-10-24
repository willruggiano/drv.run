import assert from "node:assert/strict";
import { test } from "node:test";
import { Activity, activityDefaults } from "../activity.ts";
import { Notifications } from "../notifications.ts";
import { browserFixture } from "./browser-testing.ts";
import { fixture, waitFor } from "./sessions-testing.ts";

await test("live inbox renders text, marks read independently and reconnects", async (t) => {
  const f = await fixture(t);
  const activity = new Activity(":memory:");
  const notifications = new Notifications(activity, { activity: activityDefaults, push: null });
  t.after(() => notifications.close());
  const b = await browserFixture(t, f.sessions, undefined, notifications);
  const source = { instance: "guest", incarnation: "boot", terminal: "build" };
  await b.page.goto(b.base + "/sessions?view=sessions");
  await b.page.getByRole("link", { name: "Activity inbox", exact: true }).click();
  await b.page.waitForURL(b.base + "/activity");
  activity.accept(source, 1, {
    type: "status",
    record: { id: "", state: "blocked", kind: "permission", msg: '<img src="/secret">' },
  });
  await b.page.locator("#inbox article").waitFor();
  assert.equal(await b.page.locator("#inbox img").count(), 0);
  assert.equal(await b.page.getByRole("button", { name: "Approve", exact: true }).count(), 0);
  await b.page.getByRole("button", { name: "Mark read", exact: true }).click();
  await waitFor(async () => activity.history()[0].read);
  assert.equal(activity.sources()[0].records[0].state, "blocked");
  await b.page.goto("about:blank");
  activity.accept(source, 2, { type: "status", record: { id: "", state: "done" } });
  await b.page.goto(b.base + "/activity");
  await b.page.locator("#inbox article").first().waitFor();
  await b.page.waitForFunction(() => document.querySelectorAll("#inbox article").length === 2);
  assert.equal(await b.page.getByRole("button", { name: "Read", exact: true }).isDisabled(), true);
  assert.deepEqual(b.errors, []);
});

await test("D-Bus inbox keeps text inert and read state separate from notification closure", async (t) => {
  const f = await fixture(t);
  const activity = new Activity(":memory:");
  const notifications = new Notifications(activity, { activity: activityDefaults, push: null });
  t.after(() => notifications.close());
  const b = await browserFixture(t, f.sessions, undefined, notifications);
  const source = { instance: "drv.run.fixture", incarnation: "vm", terminal: "dbus-root/server" };
  activity.accept(source, 1, {
    type: "notify",
    notification: {
      id: 1,
      app: "notify-send",
      summary: "<script>bad()</script>",
      body: '<img src="/secret"><a href="https://untrusted.invalid">text</a>',
      urgency: 2,
      expires: 0,
      expiresAt: 0,
    },
  });
  const id = activity.history()[0].id;
  await b.page.goto(`${b.base}/activity#activity-${id}`);
  await b.page.locator(`#activity-${id}`).waitFor();
  assert.equal(await b.page.locator("#inbox img, #inbox script, #inbox a").count(), 0);
  await b.page.getByRole("button", { name: "Mark read", exact: true }).click();
  await waitFor(async () => activity.history()[0].read);
  assert.equal(activity.sources()[0].notifications.length, 1);
  assert.equal(activity.history().length, 1);
  activity.accept(source, 2, { type: "close", id: 1, reason: 3 });
  await b.page.waitForFunction(() => document.querySelectorAll("#inbox article").length === 2);
  assert.equal(activity.sources()[0].notifications.length, 0);
  assert.deepEqual(b.errors, []);
});
