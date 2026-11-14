import assert from "node:assert/strict";
import { generateKeyPairSync, createECDH, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { mock, test, type TestContext } from "node:test";
import { CompactionTask } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import * as webPush from "web-push";

const sent = mock.fn<typeof webPush.sendNotification>(async () => ({
  statusCode: 201,
  headers: {},
  body: "",
}));
mock.module("web-push", { namedExports: { ...webPush, sendNotification: sent } });
const { openPush } = await import("../src/push.ts");
const { openHarness } = await import("./fixtures.ts");
const context = BACKGROUND_CONTEXT;
async function fixture(t: TestContext) {
  sent.mock.resetCalls();
  sent.mock.mockImplementation(async () => ({ statusCode: 201, headers: {}, body: "" }));
  const directory = await mkdtemp(join(tmpdir(), "push-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({
    format: "jwk",
  });
  const privateKeyFile = join(directory, "key.json");
  await writeFile(privateKeyFile, JSON.stringify(key));
  const config = {
    privateKeyFile,
    subject: "mailto:operator@example.com",
    origins: ["https://push.example"],
  };
  const push = await openPush(directory, config);
  t.after(() => push.close());
  const ecdh = createECDH("prime256v1");
  const subscription = {
    endpoint: "https://push.example/subscription",
    keys: {
      p256dh: ecdh.generateKeys().toString("base64url"),
      auth: randomBytes(16).toString("base64url"),
    },
  };
  return { ...push, directory, config, subscription };
}

await test("push persists complete subscriptions and supports removal with delivery disabled", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.service.applicationServerKey(context))?.length, 87);
  assert.deepEqual(await f.service.registered(f.subscription.endpoint, context), { value: false });
  assert.deepEqual(await f.service.register(f.subscription, context), { value: undefined });
  const updated = {
    ...f.subscription,
    keys: { ...f.subscription.keys, auth: randomBytes(16).toString("base64url") },
  };
  assert.deepEqual(await f.service.register(updated, context), { value: undefined });
  assert.equal((await stat(join(f.directory, "push.sqlite"))).mode & 0o777, 0o600);
  await f.close();
  const disabled = await openPush(f.directory, undefined);
  t.after(() => disabled.close());
  assert.equal(await disabled.service.applicationServerKey(context), undefined);
  assert.deepEqual(await disabled.service.registered(f.subscription.endpoint, context), {
    value: true,
  });
  for (let i = 0; i < 2; i++)
    assert.deepEqual(await disabled.service.remove(f.subscription.endpoint, context), {
      value: undefined,
    });
  assert.deepEqual(await disabled.service.registered(f.subscription.endpoint, context), {
    value: false,
  });
  assert.deepEqual(await disabled.service.register(f.subscription, context), {
    error: "BAD_REQUEST",
  });
});

await test("push rejects untrusted endpoints and invalid browser key material", async (t) => {
  const f = await fixture(t);
  for (const endpoint of [
    "not a URL",
    "http://push.example/a",
    "https://other.example/a",
    "https://user:password@push.example/a",
    "https://push.example/a#fragment",
    "https://push.example/a#",
  ]) {
    assert.deepEqual(await f.service.register({ ...f.subscription, endpoint }, context), {
      error: "BAD_REQUEST",
    });
    assert.deepEqual(await f.service.registered(endpoint, context), { value: false });
  }
  for (const keys of [
    { ...f.subscription.keys, auth: "invalid" },
    { ...f.subscription.keys, p256dh: "invalid" },
    { ...f.subscription.keys, p256dh: Buffer.alloc(65).toString("base64url") },
    {
      ...f.subscription.keys,
      p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]).toString("base64url"),
    },
  ])
    assert.deepEqual(await f.service.register({ ...f.subscription, keys }, context), {
      error: "BAD_REQUEST",
    });
});

await test("completed Harness submissions deliver encrypted pushes without an SSE client", async (t) => {
  const f = await fixture(t);
  await f.service.register(f.subscription, context);
  const { harness, root, faux } = await openHarness(t);
  f.attach(harness, "test session");
  faux.setResponses([fauxAssistantMessage("An answer")]);
  const delivered = Promise.withResolvers<void>();
  sent.mock.mockImplementation(async (subscription, payload, options) => {
    assert(typeof payload === "string");
    const request = webPush.generateRequestDetails(subscription, payload, options);
    assert.equal(request.headers["Content-Encoding"], "aes128gcm");
    assert(Buffer.isBuffer(request.body));
    delivered.resolve();
    return { statusCode: 201, headers: {}, body: "" };
  });
  const submission = await root.submit({ type: "input", content: "A question" }, context);
  await submission.wait(context);
  await delivered.promise;
  assert.equal(sent.mock.callCount(), 1);
  const [subscription, payload, options] = sent.mock.calls[0]!.arguments;
  assert.deepEqual(subscription, f.subscription);
  const message: unknown = JSON.parse(String(payload));
  assert.deepEqual(message, {
    title: "Response ready",
    body: "Open the conversation to continue.",
    url: `/sessions/test%20session/conversations/${root.id}`,
    tag: `/sessions/test%20session/conversations/${root.id}`,
    timestamp: (message as { timestamp: number }).timestamp,
  });
  assert.equal(options?.TTL, 300);
  await f.close();
  await harness.close(context);
});

await test("expired subscriptions are removed; other delivery failures do not fail execution", async (t) => {
  const f = await fixture(t);
  const { harness, root, faux } = await openHarness(t);
  f.attach(harness, "session");
  for (const status of [503, 410]) {
    await f.service.register(f.subscription, context);
    const attempted = Promise.withResolvers<void>();
    sent.mock.mockImplementation(async () => {
      attempted.resolve();
      throw new webPush.WebPushError("failed", status, {}, "", f.subscription.endpoint);
    });
    faux.setResponses([fauxAssistantMessage("answer")]);
    const submission = await root.submit({ type: "input", content: "question" }, context);
    assert.equal((await submission.wait(context)).status, "done");
    await attempted.promise;
    await setImmediate();
    assert.deepEqual(await f.service.registered(f.subscription.endpoint, context), {
      value: status !== 410,
    });
  }
});

await test("push observes only new settlements and ignores aborted inputs and passive writes", async (t) => {
  const f = await fixture(t);
  await f.service.register(f.subscription, context);
  const { harness, root } = await openHarness(t);
  f.attach(harness, "session");
  await harness.commit(async (tx) => {
    await tx.createSubmission({
      type: "input",
      conversationId: root.id,
      status: "unanswered",
      reason: "aborted",
    });
    await tx.createSubmission({ type: "write", conversationId: root.id, status: "queued" });
  }, context);
  await setImmediate();
  assert.equal(sent.mock.callCount(), 0);
  const delivered = Promise.withResolvers<void>();
  sent.mock.mockImplementation(async () => {
    delivered.resolve();
    return { statusCode: 201, headers: {}, body: "" };
  });
  await harness.commit(async (tx) => {
    await tx.createSubmission({
      type: "input",
      conversationId: root.id,
      status: "unanswered",
      reason: "failed",
    });
  }, context);
  await delivered.promise;
  assert.equal(
    (JSON.parse(String(sent.mock.calls[0]!.arguments[1])) as { title: string }).title,
    "Conversation needs attention",
  );
});

await test("VAPID startup validates key correspondence and contact policy", async (t) => {
  const f = await fixture(t);
  await f.close();
  const key = JSON.parse(await readFile(f.config.privateKeyFile, "utf8")) as { x: string };
  key.x = randomBytes(32).toString("base64url");
  await writeFile(f.config.privateKeyFile, JSON.stringify(key));
  await assert.rejects(openPush(f.directory, f.config));
});

await test("push closes observation when Harness closes and excludes owned conversations", async (t) => {
  const f = await fixture(t);
  await f.service.register(f.subscription, context);
  const { harness, root } = await openHarness(t);
  const taskId = await harness.commit(
    (tx) =>
      tx.createTask(
        CompactionTask,
        { reason: "manual" },
        { conversationId: root.id, ownership: { kind: "conversation" } },
      ),
    context,
  );
  const child = await harness.createConversation({ ownership: { kind: "task", taskId } }, context);
  f.attach(harness, "session");
  await child.commit(
    (tx) =>
      tx.createSubmission({
        type: "input",
        conversationId: child.id,
        status: "unanswered",
        reason: "failed",
      }),
    context,
  );
  await setImmediate();
  assert.equal(sent.mock.callCount(), 0);
  await harness.close(context);
});

await test("push bounds pending deliveries and waits for admitted sends on shutdown", async (t) => {
  const pending = Promise.withResolvers<webPush.SendResult>();
  t.after(() => pending.resolve({ statusCode: 201, headers: {}, body: "" }));
  const f = await fixture(t);
  await f.service.register(f.subscription, context);
  const { harness } = await openHarness(t);
  sent.mock.mockImplementation(() => pending.promise);
  f.attach(harness, "session");
  await harness.commit(async (tx) => {
    for (let i = 0; i < 17; i++) {
      const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
      await tx.createSubmission({
        type: "input",
        conversationId: conversation.id,
        status: "unanswered",
        reason: "failed",
      });
    }
  }, context);
  await setImmediate();
  assert.equal(sent.mock.callCount(), 16);
  let closed = false;
  const closing = f.close().then(() => {
    closed = true;
  });
  await setImmediate();
  assert.equal(closed, false);
  pending.resolve({ statusCode: 201, headers: {}, body: "" });
  await closing;
  assert.equal(closed, true);
});

await test("push discards scheduled work after shutdown without entering the Harness", async (t) => {
  const f = await fixture(t);
  await f.service.register(f.subscription, context);
  const { harness, root } = await openHarness(t);
  f.attach(harness, "session");
  harness.observeCommits({
    advance() {
      void f.close();
    },
    end() {},
  });
  await harness.commit(
    (tx) =>
      tx.createSubmission({
        type: "input",
        conversationId: root.id,
        status: "unanswered",
        reason: "failed",
      }),
    context,
  );
  await f.close();
  assert.equal(sent.mock.callCount(), 0);
});

await test("push observation failures do not change committed execution", async (t) => {
  const f = await fixture(t);
  const { harness, root } = await openHarness(t);
  f.attach(harness, "session");
  harness.observeCommits({
    advance() {
      t.mock.method(harness, "commit", async () => {
        throw new Error("storage unavailable");
      });
    },
    end() {},
  });
  const submission = await harness.commit(
    (tx) =>
      tx.createSubmission({
        type: "input",
        conversationId: root.id,
        status: "unanswered",
        reason: "failed",
      }),
    context,
  );
  assert.equal(submission.status, "unanswered");
  await setImmediate();
  assert.equal(sent.mock.callCount(), 0);
});

await test("VAPID supports HTTPS contact addresses", async (t) => {
  const f = await fixture(t);
  await f.close();
  const push = await openPush(f.directory, { ...f.config, subject: "https://operator.example" });
  t.after(() => push.close());
  assert(await push.service.applicationServerKey(context));
});

await test("a narrowed origin allowlist does not block delivery to remaining subscriptions", async (t) => {
  const f = await fixture(t);
  await f.service.register(f.subscription, context);
  await f.close();
  const both = await openPush(f.directory, {
    ...f.config,
    origins: [...f.config.origins, "https://other.example"],
  });
  const allowed = { ...f.subscription, endpoint: "https://other.example/subscription" };
  await both.service.register(allowed, context);
  await both.close();
  const restricted = await openPush(f.directory, {
    ...f.config,
    origins: ["https://other.example"],
  });
  t.after(() => restricted.close());
  const { harness, root } = await openHarness(t);
  restricted.attach(harness, "session");
  await harness.commit(
    (tx) =>
      tx.createSubmission({
        type: "input",
        conversationId: root.id,
        status: "unanswered",
        reason: "failed",
      }),
    context,
  );
  await setImmediate();
  assert.equal(sent.mock.callCount(), 1);
  assert.deepEqual(sent.mock.calls[0]!.arguments[0], allowed);
});
