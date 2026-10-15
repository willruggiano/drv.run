import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { join } from "node:path";
import { GlobalSettingsStore } from "../server.ts";
import { Activity, activityDefaults } from "../activity.ts";
import { Notifications } from "../notifications.ts";
import { browserFixture } from "./browser-testing.ts";
import { fixture, model } from "./sessions-testing.ts";

await test(`elm: settings push controls reflect subscription state without a global error`, async (t) => {
  const f = await fixture(t);
  const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({
    format: "jwk",
  });
  const notifications = new Notifications(
    new Activity(":memory:"),
    {
      activity: activityDefaults,
      push: {
        origins: ["https://push.example"],
        subject: "mailto:test@example.com",
        privateKeyFile: "/unused",
      },
    },
    key,
  );
  t.after(() => notifications.close());
  const b = await browserFixture(
    t,
    f.sessions,
    undefined,
    notifications,
    new GlobalSettingsStore({ model }),
  );
  await b.page.addInitScript((publicKey) => {
    const key = Uint8Array.from(atob(publicKey.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
      c.charCodeAt(0),
    ).buffer;
    const subscription = {
      endpoint: "https://push.example/device",
      options: { applicationServerKey: key },
      toJSON: () => ({
        endpoint: "https://push.example/device",
        keys: { auth: "auth", p256dh: "key" },
      }),
      unsubscribe: async () => {
        localStorage.removeItem("test-push");
        return true;
      },
    };
    Object.defineProperty(PushManager.prototype, "getSubscription", {
      value: async () => (localStorage.getItem("test-push") ? subscription : null),
    });
    Object.defineProperty(PushManager.prototype, "subscribe", {
      value: async () => {
        localStorage.setItem("test-push", "true");
        return subscription;
      },
    });
    Object.defineProperty(Notification, "requestPermission", {
      value: async () => (localStorage.getItem("test-deny") ? "denied" : "granted"),
    });
  }, notifications.publicKey!);
  const registered = new Set<string>();
  let fail = false;
  const pending = Promise.withResolvers<void>();
  let writes = 0;
  await b.page.route(`**/settings/push/*`, async (route) => {
    writes++;
    const request = route.request();
    assert.equal(request.method(), "POST");
    if (fail) {
      await route.fulfill({ status: 503 });
      return;
    }
    await pending.promise;
    const data = request.postDataJSON();
    if (new URL(request.url()).pathname.endsWith("/subscribe")) registered.add(data.endpoint);
    else registered.delete(data.endpoint);
    await route.fulfill({ status: 204 });
  });
  await b.page.goto(`${b.base}/`);
  const primary = await b.page
    .locator("#create")
    .evaluate((node) => getComputedStyle(node).backgroundColor);
  assert.equal(await b.page.getByRole("link", { name: "Activity", exact: true }).count(), 0);
  await b.page.getByRole("link", { name: "Global settings", exact: true }).click();
  await b.page.locator("push-settings[aria-busy=false] #push-off:checked").waitFor();
  assert.equal(await b.page.locator("#inbox, #sources").count(), 0);
  assert.equal(await b.page.locator("#push-on").isChecked(), false);
  assert.equal(await b.page.locator("#push-on").isEnabled(), true);
  assert.equal(await b.page.locator("#push-error").isVisible(), false);
  await b.page.evaluate(() => localStorage.setItem("test-deny", "true"));
  await b.page.locator("#push-on").click();
  await b.page.locator("#push-error").waitFor();
  assert.equal(writes, 0);
  assert.equal(await b.page.locator("#push-off").isChecked(), true);
  assert.equal(await b.page.locator("#push-on").isEnabled(), true);
  assert.equal(await b.page.locator("#request-error button").count(), 0);
  await b.page.evaluate(() => localStorage.removeItem("test-deny"));
  const request = b.page.waitForRequest(`**/settings/push/subscribe`);
  await b.page.locator("#push-on").click();
  await request;
  assert.equal(await b.page.locator("#push-on").isDisabled(), true);
  assert.equal(await b.page.locator("#push-off").isChecked(), true);
  assert.equal(registered.size, 0);
  pending.resolve();
  await b.page.locator("#push-on:checked").waitFor();
  assert.deepEqual([...registered], ["https://push.example/device"]);
  assert.equal(
    await b.page
      .locator("#push-on + span")
      .evaluate((node) => getComputedStyle(node).backgroundColor),
    primary,
  );
  if (b.screenshots) {
    await b.page.locator("push-settings").scrollIntoViewIfNeeded();
    await b.page.screenshot({ path: join(b.screenshots, `elm-push-toggle-on.png`) });
  }
  assert.equal(await b.page.locator("#push-on").isChecked(), true);
  assert.equal(await b.page.locator("#push-error").isVisible(), false);
  assert.equal(await b.page.locator("#request-error button").count(), 0);
  await b.page.reload();
  await b.page.locator("#push-on:checked").waitFor();
  fail = true;
  await b.page.locator("#push-off").click();
  await b.page.locator("#push-error").waitFor();
  assert.equal(registered.size, 1);
  assert.equal(await b.page.locator("#push-on").isChecked(), true);
  assert.equal(await b.page.locator("#push-off").isEnabled(), true);
  assert.equal(await b.page.locator("#request-error button").count(), 0);
  fail = false;
  await b.page.locator("#push-off").click();
  await b.page.locator("#push-off:checked").waitFor();
  assert.equal(registered.size, 0);
  assert.equal(await b.page.locator("#push-error").isVisible(), false);
  await b.page.reload();
  await b.page.locator("push-settings[aria-busy=false] #push-off:checked").waitFor();
  assert.equal(await b.page.locator("#push-on").isEnabled(), true);
  await b.page.goto(`${b.base}/`);
  await b.page.locator("#landing").waitFor();
  assert.deepEqual(b.errors, []);
});

await test(`elm: settings cannot enable push when the host disables it or the browser lacks support`, async (t) => {
  const f = await fixture(t);
  const b = await browserFixture(t, f.sessions);
  await b.page.goto(`${b.base}/settings`);
  await b.page.locator("push-settings[aria-busy=false] #push-off:checked").waitFor();
  assert.equal(await b.page.locator("#push-on").isDisabled(), true);
  assert.equal(await b.page.locator("#push-error").isVisible(), false);
  await b.page.addInitScript(() => {
    Reflect.deleteProperty(window, "PushManager");
  });
  await b.page.reload();
  await b.page.locator("#push-error").waitFor();
  assert.equal(await b.page.locator("#push-on").isDisabled(), true);
  assert.equal(await b.page.locator("#push-off").isDisabled(), true);
  assert.equal(await b.page.locator("#request-error button").count(), 0);
  assert.deepEqual(b.errors, []);
});
