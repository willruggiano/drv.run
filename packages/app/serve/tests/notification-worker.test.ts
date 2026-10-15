import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { pushMessage } from "../push-message.ts";

const source = await readFile(new URL("../worker.js", import.meta.url), "utf8");
const message = pushMessage({
  id: 42,
  source: {
    instance: "host-pi",
    incarnation: "12345678-1234-1234-1234-123456789abc",
    terminal: "api",
  },
  record: "7",
  event: {
    type: "status",
    record: { id: "7", state: "done", title: "My conversation", msg: "Original reply\nNext line" },
  },
  received: 1000,
  read: false,
  delivery: "pending",
});
function worker() {
  const handlers = new Map<string, (event: unknown) => void>();
  const shown: { title: string; options: NotificationOptions }[] = [];
  const opened: string[] = [];
  const windows: { url: string; focus: () => Promise<void> }[] = [];
  runInNewContext(source, {
    URL,
    self: {
      location: { origin: "https://drv.example" },
      addEventListener: (name: string, handler: (event: unknown) => void) =>
        handlers.set(name, handler),
      registration: {
        scope: "https://drv.example/",
        showNotification: async (title: string, options: NotificationOptions) => {
          shown.push({ title, options });
        },
      },
      clients: {
        matchAll: async () => windows,
        openWindow: async (url: string) => {
          opened.push(url);
        },
      },
    },
  });
  async function dispatch(name: string, event: object) {
    const pending: Promise<unknown>[] = [];
    handlers.get(name)!({
      ...event,
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    });
    await Promise.all(pending);
  }
  return { shown, opened, windows, dispatch };
}

await test(`elm: worker displays rich text and click opens the conversation`, async () => {
  const w = worker();
  await w.dispatch("push", { data: { json: () => message } });
  assert.equal(w.shown.length, 1);
  const { title, options } = w.shown[0];
  assert.equal(title, message.title);
  assert.equal(options.body, message.body);
  assert.equal(options.tag, message.tag);
  assert.equal(options.icon, message.icon);
  assert.equal(options.badge, message.badge);
  assert.equal(options.dir, "auto");
  let closed = false;
  await w.dispatch("notificationclick", {
    notification: {
      data: options.data,
      close: () => {
        closed = true;
      },
    },
  });
  assert.equal(closed, true);
  assert.deepEqual(w.opened, [message.url]);
  let focused = false;
  w.windows.push({
    url: `https://drv.example${message.url}`,
    focus: async () => {
      focused = true;
    },
  });
  await w.dispatch("notificationclick", {
    notification: { data: options.data, close: () => {} },
  });
  assert.equal(focused, true);
  assert.equal(w.opened.length, 1);
});

await test(`elm: legacy and missing fields have fallbacks; malformed messages don't crash the worker`, async () => {
  const w = worker();
  await w.dispatch("push", { data: { json: () => ({ activity: 1 }) } });
  const { title, options } = w.shown[0];
  assert.equal(title, "drv.run activity");
  assert(options.body);
  assert.equal(options.icon, "/icon-192.png");
  assert.equal(options.tag, "drv-run-1");
  assert.equal(options.data.url, "/");
  for (const invalid of [null, {}, { activity: -1 }, { activity: "1" }])
    await w.dispatch("push", { data: { json: () => invalid } });
  await w.dispatch("push", {
    data: {
      json: () => {
        throw new Error("Bad JSON");
      },
    },
  });
  assert.equal(w.shown.length, 1);
  await w.dispatch("notificationclick", {
    notification: { data: { activity: 1 }, close: () => {} },
  });
  assert.deepEqual(w.opened, ["/"]);
});

await test(`elm: worker never trusts arbitrary navigation or remote image URLs`, async () => {
  const w = worker();
  for (const url of [
    "https://evil.example",
    "//evil.example",
    "javascript:alert(1)",
    "/activity#activity-1",
    `${message.url}?redirect=https://evil.example`,
    "/sessions/../../admin",
    `/unrelated${message.url}`,
  ]) {
    await w.dispatch("push", {
      data: {
        json: () => ({
          ...message,
          url,
          icon: "https://evil.example/icon.png",
          badge: "//evil.example/badge.png",
        }),
      },
    });
    const { options } = w.shown.at(-1)!;
    assert.equal(options.data.url, "/");
    assert.equal(options.icon, "/icon-192.png");
    assert.equal(options.badge, "/icon-192.png");
    await w.dispatch("notificationclick", { notification: { data: { url }, close: () => {} } });
    assert.equal(w.opened.at(-1), "/");
  }
});
