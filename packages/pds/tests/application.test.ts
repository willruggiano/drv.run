import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AgentDoc, CompactionEntry, LiveDoc } from "@earendil-works/pi-durable";
import { Env } from "../src/harness/index.ts";
import { attachments, context, discoverEnvironments } from "../src/application.ts";
import { ConversationId, SessionId, decode } from "../src/identity.ts";
import { fixture, sessionsFixture, knownHostsFixture, form } from "./fixtures.ts";

await test("sessions persist configuration, attachments, messages, compaction, and /new isolation", async (t) => {
  const { app, faux, selection, open } = await fixture(t);
  const first = await app.createConversation(form(selection));
  faux.setResponses([
    fauxAssistantMessage("First answer"),
    fauxAssistantMessage("Second answer"),
    fauxAssistantMessage("Summary"),
  ]);
  await app.send(first, form({ message: "First question" }));
  await first.waitForIdle(context);
  await app.send(first, form({ message: "Second question" }));
  await first.waitForIdle(context);
  await app.send(first, form({ message: "/compact retain the decisions" }));
  await app.harness.waitForIdle(context);
  const history = await first.entries({ order: "ascending" }, 256, undefined, context);
  assert(history.items.some((entry) => CompactionEntry.is(entry)));
  assert.equal((await first.context(context)).head?.kind, "pi.compaction");
  await app.configure(
    first,
    form({ ...selection, model: "faux/second", env: "ssh:test-guest", cwd: "/other" }),
  );
  assert.deepEqual(await app.harness.snapshot(Env, first.id, context), {
    env: {
      type: "ssh",
      host: "test-guest",
    },
  });
  const next = await app.send(first, form({ message: "/new" }));
  assert(next && typeof next === "object");
  assert.notEqual(first.id, next.id);
  assert.equal((await next.context(context)).entries.length, 0);
  assert.deepEqual(
    await app.harness.snapshot(AgentDoc, next.id, context),
    await app.harness.snapshot(AgentDoc, first.id, context),
  );
  assert.deepEqual(
    await app.harness.snapshot(Env, next.id, context),
    await app.harness.snapshot(Env, first.id, context),
  );
  assert.equal((await app.list()).length, 2);
  await app.close();
  const reopened = await open();
  try {
    assert.deepEqual(
      (await reopened.list()).map((item) => item.title),
      ["New session", "First question"],
    );
    const restored = await reopened.conversation(first.id);
    assert(restored);
    assert.equal((await restored.agent(context)).cwd, "/other");
    assert.equal((await restored.context(context)).head?.kind, "pi.compaction");
  } finally {
    await reopened.close();
  }
});

await test("configuration is atomic and running tool requests use the selected working directory", async (t) => {
  const { app, faux, selection, directory } = await fixture(t);
  const first = await app.createConversation(form(selection));
  const changed = join(directory, "changed");
  await mkdir(changed);
  await writeFile(join(changed, "value.txt"), "from changed directory");
  await app.configure(first, form({ ...selection, cwd: changed, thinking: "high" }));
  const before = await app.harness.snapshot(AgentDoc, first.id, context);
  await assert.rejects(
    app.configure(first, form({ ...selection, model: "faux/second", thinking: "high" })),
  );
  assert.deepEqual(await app.harness.snapshot(AgentDoc, first.id, context), before);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("read", { path: "value.txt" }), { stopReason: "toolUse" }),
    (messages) => {
      const result = messages.messages.findLast((message) => message.role === "toolResult");
      assert(result?.role === "toolResult");
      assert.equal(result.isError, false);
      return fauxAssistantMessage("Read completed");
    },
  ]);
  await app.send(first, form({ message: "Read value.txt" }));
  await first.waitForIdle(context);
  assert.equal(faux.state.callCount, 2);
  assert.equal((await app.harness.snapshot(LiveDoc, first.id, context))?.runFailure, undefined);
});

await test("attachments retain image bytes and UTF-8 text; unsupported input does not admit a turn", async (t) => {
  const { app, selection } = await fixture(t);
  const image = new File([new Uint8Array([1, 2, 3])], "image.png", { type: "image/png" });
  const text = new File(["const x = 1;"], "source.ts");
  assert.deepEqual(await attachments("hello", [image, text]), [
    { type: "text", text: "hello" },
    { type: "text", text: "Attachment: image.png" },
    { type: "image", mimeType: "image/png", data: "AQID" },
    { type: "text", text: "Attachment: source.ts\n\nconst x = 1;" },
  ]);
  await assert.rejects(attachments("", []));
  await assert.rejects(attachments("", [new File([new Uint8Array([0, 255])], "binary.pdf")]));
  const conversation = await app.createConversation(form({ ...selection, model: "faux/second" }));
  const input = form({ message: "look" });
  input.append("attachments", image);
  await assert.rejects(app.send(conversation, input));
  await assert.rejects(app.send(conversation, form({ message: "/unknown" })));
  assert.equal((await conversation.context(context)).entries.length, 0);
});

await test("environment discovery preserves published SSH filenames without reading keys", async (t) => {
  const directory = await knownHostsFixture(t);
  await writeFile(join(directory, "Mixed.Case-Alias"), "not an inventory or a key", { mode: 0 });
  assert.deepEqual(await discoverEnvironments(directory), [
    { type: "ssh", host: "Mixed.Case-Alias" },
  ]);
});

await test("environment discovery lists files and links, not subdirectories or their contents", async (t) => {
  const directory = await knownHostsFixture(t);
  await writeFile(join(directory, "zebra"), "");
  await symlink("zebra", join(directory, "linked-alias"));
  await symlink("not-present", join(directory, "stale-alias"));
  await mkdir(join(directory, "nested"));
  await writeFile(join(directory, "nested", "not-a-suggestion"), "");
  assert.deepEqual(await discoverEnvironments(directory), [
    { type: "ssh", host: "linked-alias" },
    { type: "ssh", host: "stale-alias" },
    { type: "ssh", host: "zebra" },
  ]);
  await rm(join(directory, "linked-alias"));
  assert.deepEqual(await discoverEnvironments(directory), [
    { type: "ssh", host: "stale-alias" },
    { type: "ssh", host: "zebra" },
  ]);
});

await test("environment discovery treats disabled, empty and missing directories as no suggestions", async (t) => {
  const directory = await knownHostsFixture(t);
  assert.deepEqual(await discoverEnvironments(""), []);
  assert.deepEqual(await discoverEnvironments(directory), []);
  const missing = join(directory, "absent");
  assert.deepEqual(await discoverEnvironments(missing), []);
  const { stat } = await import("node:fs/promises");
  await assert.rejects(stat(missing), { code: "ENOENT" });
});

await test("environment discovery reports directory read failures", async (t) => {
  const directory = await knownHostsFixture(t);
  const file = join(directory, "not-a-directory");
  await writeFile(file, "");
  await assert.rejects(discoverEnvironments(file), { code: "ENOTDIR" });
  const loop = join(directory, "loop");
  await symlink(loop, loop);
  await assert.rejects(discoverEnvironments(loop), { code: "ELOOP" });
});

await test("environment discovery defaults to the owner's known-hosts directory", async (t) => {
  const home = await knownHostsFixture(t);
  const previous = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  });
  const directory = join(home, ".ssh", "known_hosts.d");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "ordinary-host"), "");
  assert.deepEqual(await discoverEnvironments(), [{ type: "ssh", host: "ordinary-host" }]);
});

await test("HTTP rejects foreign writes and accepts native forms at the configured public origin", async (t) => {
  const { serve } = await import("../src/server.ts");
  const { sessions, auth, selection } = await sessionsFixture(t);
  const server = await serve(sessions, { auth, port: 0, origin: "https://pds.test" });
  try {
    const foreign = await fetch(`${server.origin}/`, {
      method: "POST",
      body: form(selection),
      headers: { Origin: "https://foreign.test", "Datastar-Request": "true" },
    });
    assert.equal(foreign.status, 403);
    await foreign.body?.cancel();
    const plain = await fetch(`${server.origin}/`, {
      method: "POST",
      body: form(selection),
      headers: { Origin: "https://pds.test" },
      redirect: "manual",
    });
    assert.equal(plain.status, 303);
    await plain.body?.cancel();
    assert.equal((await sessions.list()).length, 1);
    const missing = await fetch(`${server.origin}/api/s/missing/c/9999`);
    assert.equal(missing.status, 404);
    await missing.body?.cancel();
    const allowed = await fetch(`${server.origin}/`, {
      method: "POST",
      body: form(selection),
      headers: { Origin: "https://pds.test", "Datastar-Request": "true" },
    });
    assert.equal(allowed.status, 200);
    await allowed.body?.cancel();
    assert.equal((await sessions.list()).length, 2);
  } finally {
    await server.close();
  }
});

await test("home creation validates attachments before creating conversations and admits initial input", async (t) => {
  const { app, sessions, faux, selection } = await fixture(t);
  faux.setResponses([fauxAssistantMessage("Created with input")]);
  const initial = form({ ...selection, sessionId: app.id, message: "First prompt" });
  initial.append("attachments", new File(["the attached text"], "note.txt"));
  const { conversation } = await sessions.compose(initial);
  await conversation.waitForIdle(context);
  const messages = (await conversation.context(context)).messages;
  const user = messages.find((message) => message.role === "user");
  assert.deepEqual(user?.content, [
    { type: "text", text: "First prompt" },
    { type: "text", text: "Attachment: note.txt\n\nthe attached text" },
  ]);
  const invalid = form({ ...selection, sessionId: app.id, message: "Invalid attachment" });
  invalid.append("attachments", new File([new Uint8Array([255])], "binary"));
  await assert.rejects(sessions.compose(invalid));
  await assert.rejects(
    sessions.compose(form({ ...selection, sessionId: app.id, message: "/compact" })),
  );
  assert.equal((await app.list()).length, 1);
});

await test("partial configuration and /cd preserve unrelated state without admitting model turns", async (t) => {
  const { app, faux, selection, directory } = await fixture(t);
  const conversation = await app.createConversation(form(selection));
  await Promise.all([
    app.configure(conversation, form({ thinking: "high" })),
    app.configure(conversation, form({ cwd: "subdirectory" })),
  ]);
  assert.equal((await conversation.agent(context)).cwd, "subdirectory");
  assert.equal((await conversation.agent(context)).thinkingLevel, "high");
  await assert.rejects(app.configure(conversation, form({ model: "faux/second" })));
  assert.equal((await conversation.agent(context)).thinkingLevel, "high");
  await app.configure(
    conversation,
    form({ model: "faux/second", thinking: "off", cwd: join(directory, "subdirectory") }),
  );
  assert.equal((await conversation.agent(context)).thinkingLevel, "off");
  const env = await app.harness.snapshot(Env, conversation.id, context);
  await app.send(conversation, form({ message: "/cd ../a  directory" }));
  assert.equal((await conversation.agent(context)).cwd, join(directory, "a  directory"));
  await app.send(conversation, form({ message: "/cd /absolute/path" }));
  const agent = await app.harness.snapshot(AgentDoc, conversation.id, context);
  assert.equal(agent?.cwd, "/absolute/path");
  await assert.rejects(app.send(conversation, form({ message: "/cd" })));
  const upload = form({ message: "/cd /other" });
  upload.append("attachments", new File(["text"], "note.txt"));
  await assert.rejects(app.send(conversation, upload));
  await assert.rejects(app.configure(conversation, form({ cwd: "" })));
  assert.deepEqual(await app.harness.snapshot(AgentDoc, conversation.id, context), agent);
  assert.deepEqual(await app.harness.snapshot(Env, conversation.id, context), env);
  assert.equal((await conversation.context(context)).entries.length, 0);
  assert.equal(faux.state.callCount, 0);
  const next = await app.send(conversation, form({ message: "/new" }));
  assert(next && typeof next === "object");
  assert.equal((await next.agent(context)).cwd, "/absolute/path");
});

await test("session lifecycle HTTP opens stores separately from native conversations", async (t) => {
  const { serve } = await import("../src/server.ts");
  const { sessions, auth } = await sessionsFixture(t);
  const server = await serve(sessions, { auth, port: 0 });
  t.after(() => server.close());
  const open = () =>
    fetch(`${server.origin}/api/s/open`, {
      method: "POST",
      body: form({ sessionId: "first" }),
      redirect: "manual",
    });
  const responses = await Promise.all([open(), open()]);
  for (const response of responses) {
    await response.body?.cancel();
    assert.equal(response.status, 303);
    assert.equal(
      new URL(response.headers.get("location")!, server.origin).pathname,
      "/api/s/first",
    );
  }
  const root = await fetch(`${server.origin}/api/s/first/root`, {
    method: "POST",
    body: form({}),
    redirect: "manual",
  });
  await root.body?.cancel();
  assert.equal(root.status, 303);
});

await test("one Harness owns each opaque session ID; opens and roots preserve existing configuration", async (t) => {
  const { sessions, directory, selection } = await sessionsFixture(t);
  const id = decode(SessionId, "../λ/owner ' & % session");
  const opened = await Promise.all(Array.from({ length: 8 }, () => sessions.open(id)));
  const first = opened[0]!;
  assert(opened.every((app) => app === first));
  assert.equal(first.id, id);
  assert.deepEqual(await first.list(), []);
  assert.equal((await first.harness.inspect(context)).scheduling, "paused");
  const left = await first.root(form(selection));
  const initial = await first.harness.snapshot(AgentDoc, left.id, context);
  const repeated = await first.root(form({ model: "not a model", cwd: "" }));
  assert.equal(repeated.id, left.id);
  assert.deepEqual(await first.harness.snapshot(AgentDoc, left.id, context), initial);
  const second = await sessions.open(decode(SessionId, "different store"));
  const right = await second.root(form({}));
  assert.equal(right.id, left.id);
  assert.equal((await right.agent(context)).model, undefined);
  await first.configure(left, form({ model: "faux/second" }));
  assert.equal((await right.agent(context)).model, undefined);
  assert.equal((await first.harness.inspect(context)).scheduling, "paused");
  assert.deepEqual(
    (await sessions.list()).map((item) => item.id).toSorted(),
    [id, "different store"].toSorted(),
  );
  const { readdir } = await import("node:fs/promises");
  assert.deepEqual(await readdir(directory), ["sessions"]);
});

await test("session reads, observations, missing addresses, and model metadata never provision or resume", async (t) => {
  const { serve } = await import("../src/server.ts");
  const { sessions, auth, faux, models } = await sessionsFixture(t);
  const server = await serve(sessions, { auth, port: 0 });
  t.after(() => server.close());
  const refresh = t.mock.method(models, "refresh");
  for (const path of ["/", "/api/s"]) {
    const response = await fetch(`${server.origin}${path}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    await response.body?.cancel();
  }
  assert.equal(refresh.mock.callCount(), 0);
  assert.deepEqual(await sessions.list(), []);
  const app = await sessions.open(decode(SessionId, "read only"));
  const conversation = await app.createConversation(form({}));
  const base = `/api/s/${encodeURIComponent(app.id)}`;
  for (const [path, expected] of [
    ["/api/s/missing", 404],
    ["/api/s/missing/c/0", 404],
    [base, 200],
    [`${base}/c/${conversation.id}`, 200],
    [`${base}/c/999999`, 404],
  ] as const) {
    const response = await fetch(`${server.origin}${path}`);
    assert.equal(response.status, expected);
    await response.body?.cancel();
  }
  const signals = new URLSearchParams({
    datastar: JSON.stringify({ model: "faux/second", env: "local" }),
  });
  const observed = await fetch(`${server.origin}${base}/c/${conversation.id}/watch?${signals}`, {
    headers: { "Datastar-Request": "true" },
  });
  assert.equal(observed.status, 200);
  const reader = observed.body!.getReader();
  assert.equal((await reader.read()).done, false);
  await reader.cancel();
  assert.equal(app.available, true);
  assert.equal((await app.harness.inspect(context)).scheduling, "paused");
  assert.equal((await app.list()).length, 1);
  assert.equal((await conversation.agent(context)).model, undefined);
  assert.equal((await app.harness.snapshot(Env, conversation.id, context))?.env, undefined);
  assert.equal(faux.state.callCount, 0);
  assert.equal((await sessions.list()).length, 1);
});

await test("corrupt persisted stores remain unavailable without replacement or hiding healthy sessions", async (t) => {
  const { readFile, stat } = await import("node:fs/promises");
  const { serve } = await import("../src/server.ts");
  const { sessions, auth, directory, open } = await sessionsFixture(t);
  const broken = await sessions.open(decode(SessionId, "broken"));
  await broken.root(form({}));
  const healthy = await sessions.open(decode(SessionId, "healthy"));
  const retained = await healthy.root(form({}));
  await sessions.close();
  const path = join(
    directory,
    "sessions",
    Buffer.from("broken").toString("base64url"),
    "store.sqlite",
  );
  const bytes = Buffer.from([1, 2, 3, 4, 5]);
  await writeFile(path, bytes);
  const before = await stat(path);
  const reopened = await open();
  assert.deepEqual(
    (await reopened.list()).toSorted((a, b) => a.id.localeCompare(b.id)),
    [
      { id: "broken", status: "unavailable" },
      { id: "healthy", status: "open" },
    ],
  );
  await assert.rejects(reopened.open(decode(SessionId, "broken")));
  assert.deepEqual(await readFile(path), bytes);
  assert.equal((await stat(path)).ino, before.ino);
  const recovered = await reopened.get(decode(SessionId, "healthy"));
  assert(recovered);
  assert.equal((await recovered.root(form({}))).id, retained.id);
  const server = await serve(reopened, { auth, port: 0 });
  t.after(() => server.close());
  for (const [route, expected] of [
    ["/api/s", 200],
    ["/api/s/broken", 503],
    ["/api/s/healthy", 200],
  ] as const) {
    const response = await fetch(`${server.origin}${route}`);
    assert.equal(response.status, expected);
    await response.body?.cancel();
  }
  const retry = await fetch(`${server.origin}/api/s/open`, {
    method: "POST",
    body: form({ sessionId: "broken" }),
  });
  assert.equal(retry.status, 503);
  assert.equal(retry.headers.has("retry-after"), false);
  await retry.body?.cancel();
  assert.deepEqual(await readFile(path), bytes);
});

await test(
  "startup resumes eligible durable work without browser or progress-wait calls",
  { timeout: 10_000 },
  async (t) => {
    const { CompactionTask } = await import("@earendil-works/pi-durable");
    const { sessions, open, faux, selection } = await sessionsFixture(t);
    const app = await sessions.open(decode(SessionId, "recovery"));
    const conversation = await app.createConversation(form(selection));
    await conversation.commit(async (tx) => {
      for (let index = 0; index < 4; index++)
        await tx.appendEntry(conversation.id, {
          kind: "pi.assistant",
          model: [fauxAssistantMessage(`Recorded answer ${index}`)],
        });
      await tx.createTask(
        CompactionTask,
        { reason: "manual" },
        { ownership: { kind: "conversation" } },
      );
    }, context);
    assert.equal((await app.harness.inspect(context)).scheduling, "paused");
    assert.equal(faux.state.callCount, 0);
    await sessions.close();
    const requested = Promise.withResolvers<void>();
    faux.setResponses([
      () => {
        requested.resolve();
        return fauxAssistantMessage("Recovered summary");
      },
    ]);
    const reopened = await open();
    await requested.promise;
    const recovered = await reopened.get(app.id);
    assert(recovered);
    assert.equal((await recovered.harness.inspect(context)).scheduling, "running");
    await recovered.harness.waitForIdle(context);
    assert.equal((await recovered.conversation(conversation.id))?.id, conversation.id);
    assert.equal(faux.state.callCount, 1);
  },
);

await test("HTTP validates complete addresses, methods, fields, and media types before mutation", async (t) => {
  const { serve } = await import("../src/server.ts");
  const { sessions, auth } = await sessionsFixture(t);
  const app = await sessions.open(decode(SessionId, "validation"));
  const conversation = await app.root(form({}));
  const server = await serve(sessions, { auth, port: 0 });
  t.after(() => server.close());
  const base = `${server.origin}/api/s/${app.id}`;
  for (const invalid of ["-1", "1e0", "0x0", "0.0", "00", " 0", "9007199254740992", "NaN"]) {
    const response = await fetch(`${base}/c/${encodeURIComponent(invalid)}`);
    assert.equal(response.status, 400);
    await response.body?.cancel();
  }
  for (const query of ["?unknown=value", "?before=5&before=6"]) {
    const response = await fetch(`${base}/c/${conversation.id}/entries${query}`);
    assert.equal(response.status, 400);
    await response.body?.cancel();
  }
  for (const sessionId of ["", ".", "..", "x".repeat(129), "λ".repeat(65), "\0", "line\nfeed"]) {
    const response = await fetch(`${server.origin}/api/s/open`, {
      method: "POST",
      body: form({ sessionId }),
      redirect: "manual",
    });
    assert.equal(response.status, 400);
    assert.equal(response.headers.has("location"), false);
    await response.body?.cancel();
  }
  for (const taskId of ["-1", "1e0", "00", "9007199254740992"]) {
    const response = await fetch(`${base}/createConversation`, {
      method: "POST",
      body: form({ ownership: "task", taskId }),
      redirect: "manual",
    });
    assert.equal(response.status, 400);
    await response.body?.cancel();
  }
  const wrongMethod = await fetch(`${base}/root`, { method: "GET" });
  assert.equal(wrongMethod.status, 405);
  assert.deepEqual(wrongMethod.headers.get("allow")?.split(", "), ["POST"]);
  await wrongMethod.body?.cancel();
  const duplicate = form({ sessionId: "a" });
  duplicate.append("sessionId", "b");
  for (const body of [duplicate, form({ sessionId: "c", unknown: "value" })]) {
    const response = await fetch(`${server.origin}/api/s/open`, { method: "POST", body });
    assert.equal(response.status, 400);
    await response.body?.cancel();
  }
  const unsupported = await fetch(`${server.origin}/api/s/open`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(unsupported.status, 415);
  await unsupported.body?.cancel();
  const invalidForm = await fetch(`${base}/createConversation`, {
    method: "POST",
    body: form({ model: "missing" }),
  });
  assert.equal(invalidForm.status, 200);
  assert.equal(invalidForm.headers.has("location"), false);
  await invalidForm.body?.cancel();
  assert.equal((await app.list()).length, 1);
  assert.equal((await sessions.list()).length, 1);
});

await test("typed read errors and unexpected failures retain their declared HTTP statuses", async (t) => {
  const { SessionFailed, StorageRequestError } = await import("@earendil-works/pi-durable");
  const { AssertError } = await import("typebox/value");
  const { serve } = await import("../src/server.ts");
  const { sessions, auth } = await sessionsFixture(t);
  const app = await sessions.open(decode(SessionId, "errors"));
  const server = await serve(sessions, { auth, port: 0 });
  t.after(() => server.close());
  for (const [error, status] of [
    [new StorageRequestError("rejected read arguments"), 400],
    [new SessionFailed(new Error("storage failed")), 503],
    [new TypeError("unexpected adapter error"), 500],
    [new AssertError("Assert", null, []), 500],
  ] as const) {
    const read = t.mock.method(app.harness, "conversation", async () => {
      throw error;
    });
    const response = await fetch(`${server.origin}/api/s/errors/c/0`);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("cache-control"), "no-store");
    await response.body?.cancel();
    read.mock.restore();
  }
});

await test("the combined home form validates all configuration before allocating a session", async (t) => {
  const { serve } = await import("../src/server.ts");
  const { sessions, auth, selection } = await sessionsFixture(t);
  const server = await serve(sessions, { auth, port: 0 });
  t.after(() => server.close());
  const incomplete = form(selection);
  incomplete.delete("thinking");
  for (const body of [
    incomplete,
    form({ ...selection, cwd: "" }),
    form({ ...selection, env: "missing" }),
  ]) {
    const response = await fetch(`${server.origin}/`, { method: "POST", body, redirect: "manual" });
    assert.equal(response.status, 200);
    assert.equal(response.headers.has("location"), false);
    await response.body?.cancel();
    assert.deepEqual(await sessions.list(), []);
  }
});

await test("task-owned creation validates store ownership and an explicit local choice overrides inherited SSH", async (t) => {
  const { CompactionTask } = await import("@earendil-works/pi-durable");
  const { serve } = await import("../src/server.ts");
  const { sessions, auth, selection } = await sessionsFixture(t);
  const owner = await sessions.open(decode(SessionId, "owner"));
  await sessions.open(decode(SessionId, "other"));
  const parent = await owner.createConversation(form({ ...selection, env: "ssh:test-guest" }));
  const task = await parent.commit(
    (tx) =>
      tx.createTask(CompactionTask, { reason: "manual" }, { ownership: { kind: "conversation" } }),
    context,
  );
  const server = await serve(sessions, { auth, port: 0 });
  t.after(() => server.close());
  const body = () => form({ ownership: "task", taskId: String(task), env: "local" });
  const rejected = await fetch(`${server.origin}/api/s/other/createConversation`, {
    method: "POST",
    body: body(),
    redirect: "manual",
  });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.headers.has("location"), false);
  await rejected.body?.cancel();
  const response = await fetch(`${server.origin}/api/s/owner/createConversation`, {
    method: "POST",
    body: body(),
    redirect: "manual",
  });
  assert.equal(response.status, 303);
  const location = new URL(response.headers.get("location")!, server.origin);
  const match = new URLPattern({ pathname: "/api/s/:session/c/:conversation" }).exec(location.href);
  assert(match?.pathname.groups.conversation);
  const child = await owner.conversation(
    decode(ConversationId, match.pathname.groups.conversation),
  );
  assert(child);
  await response.body?.cancel();
  assert.deepEqual((await owner.harness.snapshot(Env, child.id, context))?.env, { type: "local" });
  assert.equal((await owner.harness.inspect(context)).scheduling, "paused");
});

await test("new unselected conversations cannot execute tools on the host", async (t) => {
  const { stat } = await import("node:fs/promises");
  const { app, faux, directory } = await fixture(t);
  const conversation = await app.createConversation(form({ model: "faux/first" }));
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("write", { path: "unselected-write", content: "not permitted" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("No environment selected"),
  ]);
  await app.send(conversation, form({ message: "Try the write" }));
  await conversation.waitForIdle(context);
  await assert.rejects(stat(join(directory, "unselected-write")), { code: "ENOENT" });
  const result = (await conversation.context(context)).messages.find(
    (message) => message.role === "toolResult",
  );
  assert(result?.role === "toolResult");
  assert.equal(result.isError, true);
});

await test("missing and aliased stores remain unavailable without modifying healthy storage", async (t) => {
  const { link, lstat, readFile, unlink } = await import("node:fs/promises");
  const { SessionUnavailable } = await import("../src/application.ts");
  const { sessions, directory, open } = await sessionsFixture(t);
  const healthy = await sessions.open(decode(SessionId, "healthy"));
  const root = await healthy.root(form({}));
  await sessions.open(decode(SessionId, "missing"));
  await sessions.close();
  const path = (id: string) => join(directory, "sessions", Buffer.from(id).toString("base64url"));
  const database = join(path("healthy"), "store.sqlite");
  const retained = await readFile(database);
  assert.equal((await lstat(database)).mode & 0o777, 0o600);
  assert.equal((await lstat(path("healthy"))).mode & 0o777, 0o700);
  await unlink(join(path("missing"), "store.sqlite"));
  await symlink(path("healthy"), path("directory alias"));
  await mkdir(path("file alias"));
  await symlink(database, join(path("file alias"), "store.sqlite"));
  await mkdir(path("hard link"));
  const linked = join(directory, "retained.sqlite");
  await writeFile(linked, retained);
  await link(linked, join(path("hard link"), "store.sqlite"));
  const reopened = await open();
  for (const id of ["missing", "directory alias", "file alias", "hard link"]) {
    await assert.rejects(reopened.get(decode(SessionId, id)), SessionUnavailable);
    await assert.rejects(reopened.open(decode(SessionId, id)), SessionUnavailable);
  }
  await assert.rejects(lstat(join(path("missing"), "store.sqlite")), { code: "ENOENT" });
  assert((await lstat(path("directory alias"))).isSymbolicLink());
  assert((await lstat(join(path("file alias"), "store.sqlite"))).isSymbolicLink());
  assert.equal((await lstat(linked)).nlink, 2);
  assert.deepEqual(await readFile(linked), retained);
  const recovered = await reopened.get(decode(SessionId, "healthy"));
  assert(recovered);
  assert.equal((await recovered.root(form({}))).id, root.id);
});

await test("shutdown closes every Harness before waiting for all environment cleanups, including failed ones", async (t) => {
  const { openApplication } = await import("../src/application.ts");
  const { NodeExecutionEnv } = await import("@earendil-works/pi-durable/env/node");
  const { sessions, directory, faux, selection } = await sessionsFixture(t);
  const owned = await openApplication({
    directory: join(directory, "shutdown"),
    models: sessions.models,
    environments: sessions.environments,
    cwd: directory,
  });
  let closing: Promise<void> | undefined;
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  t.after(async () => {
    release.resolve();
    if (closing) await closing.catch(() => {});
    else await owned.close();
  });
  await mkdir(join(directory, "second"));
  const owners = await Promise.all([
    owned.open(decode(SessionId, "one")),
    owned.open(decode(SessionId, "two")),
  ]);
  for (const [index, owner] of owners.entries()) {
    const conversation = await owner.createConversation(form(selection));
    for (const cwd of index === 0 ? [directory, join(directory, "second")] : [directory]) {
      await owner.configure(conversation, form({ cwd }));
      await writeFile(join(cwd, "sample.txt"), "owned");
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("read", { path: "sample.txt" }), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("Read"),
      ]);
      await owner.send(conversation, form({ message: "Read the sample" }));
      await conversation.waitForIdle(context);
    }
  }
  const failure = new Error("Expected cleanup failure");
  // oxlint-disable-next-line typescript/unbound-method -- Capture before mocking; invoke with the receiver via original.call(this, ctx).
  const original = NodeExecutionEnv.prototype.cleanup;
  let count = 0;
  t.mock.method(
    NodeExecutionEnv.prototype,
    "cleanup",
    async function (
      this: InstanceType<typeof NodeExecutionEnv>,
      ctx: Parameters<typeof original>[0],
    ) {
      assert(owners.every((owner) => !owner.available));
      const call = ++count;
      await original.call(this, ctx);
      if (call === 2) {
        started.resolve();
        await release.promise;
      }
      if (this.cwd === join(directory, "second")) throw failure;
    },
  );
  const harnessFailure = new Error("Expected Harness close failure");
  const firstHarness = owners[0].harness;
  const close = firstHarness.close.bind(firstHarness);
  t.mock.method(firstHarness, "close", async (ctx: Parameters<typeof close>[0]) => {
    await close(ctx);
    throw harnessFailure;
  });
  closing = owned.close();
  let settled = false;
  const result = closing.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    await started.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
  } finally {
    release.resolve();
  }
  await assert.rejects(
    closing,
    (error: unknown) =>
      error instanceof AggregateError &&
      error.errors.some(
        (cleanupError: unknown) =>
          cleanupError instanceof AggregateError &&
          cleanupError.errors.includes(failure) &&
          cleanupError.errors.includes(harnessFailure),
      ),
  );
  await result;
  assert.equal(count, 3);
  assert(owners.every((owner) => !owner.available));
});

await test(
  "HTTP rejects oversized uploads from headers without waiting for their body",
  { timeout: 5000 },
  async (t) => {
    const { request } = await import("node:http");
    const { serve } = await import("../src/server.ts");
    const { sessions, auth } = await sessionsFixture(t);
    const server = await serve(sessions, { auth, port: 0 });
    t.after(() => server.close());
    const response = Promise.withResolvers<number | undefined>();
    const incoming = request(
      `${server.origin}/api/s/open`,
      {
        method: "POST",
        headers: { "Content-Length": String(32 * 1024 * 1024 + 1) },
      },
      (message) => {
        response.resolve(message.statusCode);
        message.resume();
      },
    );
    incoming.on("error", response.reject);
    t.after(() => incoming.destroy());
    incoming.flushHeaders();
    assert.equal(await response.promise, 413);
    assert.deepEqual(await sessions.list(), []);
  },
);

await test("shutdown settles pending opens and rejects further ownership acquisition", async (t) => {
  const { SessionUnavailable } = await import("../src/application.ts");
  const { sessions } = await sessionsFixture(t);
  const opening = sessions.open(decode(SessionId, "opening"));
  const closing = sessions.close();
  await assert.rejects(sessions.open(decode(SessionId, "too late")), SessionUnavailable);
  const owner = await opening;
  await closing;
  assert.equal(owner.available, false);
  await assert.rejects(sessions.get(decode(SessionId, "opening")), SessionUnavailable);
  assert.deepEqual(await sessions.list(), [{ id: "opening", status: "unavailable" }]);
});

await test("reserved action names remain valid session identities and transport envelopes carry no read arguments", async (t) => {
  const { serve } = await import("../src/server.ts");
  const { sessions, auth } = await sessionsFixture(t);
  await sessions.open(decode(SessionId, "open"));
  const server = await serve(sessions, { auth, port: 0 });
  t.after(() => server.close());
  const session = await fetch(`${server.origin}/api/s/open`);
  assert.equal(session.status, 200);
  await session.body?.cancel();
  const method = await fetch(`${server.origin}/api/s/open`, { method: "PUT" });
  assert.equal(method.status, 405);
  assert.equal(method.headers.get("allow"), "GET, POST");
  await method.body?.cancel();
  for (const value of ["null", "[]", "not JSON"]) {
    const query = new URLSearchParams({ datastar: value });
    const response = await fetch(`${server.origin}/api/s?${query}`, {
      headers: { "Datastar-Request": "true" },
    });
    assert.equal(response.status, 400);
    await response.body?.cancel();
  }
  const unsupported = await fetch(`${server.origin}/api/s/open`, {
    method: "POST",
    body: "sessionId=invalid",
    headers: { "Content-Type": "application/x-www-form-urlencoded-invalid" },
  });
  assert.equal(unsupported.status, 415);
  await unsupported.body?.cancel();
  assert.deepEqual(await sessions.list(), [{ id: "open", status: "open" }]);
});

await test("unsupported persisted environment selections never fall back to host execution", async (t) => {
  const { stat } = await import("node:fs/promises");
  const { app, faux, directory } = await fixture(t);
  const conversation = await app.createConversation(form({ model: "faux/first" }));
  await conversation.commit(async (tx) => {
    // Exercise a persisted value outside this binary's supported selection schema.
    Object.assign(await tx.doc(Env, conversation.id), { env: { type: "unsupported" } });
  }, context);
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("write", { path: "unsupported-write", content: "not permitted" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("No execution environment"),
  ]);
  await app.send(conversation, form({ message: "Try the write" }));
  await conversation.waitForIdle(context);
  await assert.rejects(stat(join(directory, "unsupported-write")), { code: "ENOENT" });
  assert.equal(app.available, true);
});

await test("HTTP configuration commits tri-state agent and env changes atomically without normalizing cwd", async (t) => {
  const { serve } = await import("../src/server.ts");
  const { app, sessions, auth, selection } = await fixture(t);
  const conversation = await app.createConversation(form(selection));
  const server = await serve(sessions, { auth, port: 0 });
  t.after(() => server.close());
  const post = async (body: FormData) => {
    const response = await fetch(`${server.origin}/api/s/test/c/${conversation.id}/configure`, {
      method: "POST",
      body,
      redirect: "manual",
    });
    await response.body?.cancel();
    return response;
  };
  const change = form({ cwd: " ../raw directory ", env: "ssh:ordinary-host" });
  change.append("clear", "model");
  change.append("clear", "thinking");
  assert.equal((await post(change)).status, 303);
  assert.deepEqual(await app.harness.snapshot(AgentDoc, conversation.id, context), {
    cwd: " ../raw directory ",
  });
  assert.deepEqual(await app.harness.snapshot(Env, conversation.id, context), {
    env: { type: "ssh", host: "ordinary-host" },
  });
  const conflict = form({ cwd: "/should-not-commit", env: "local", clear: "env" });
  const rejected = await post(conflict);
  assert.equal(rejected.status, 200);
  assert.equal(rejected.headers.has("location"), false);
  assert.deepEqual(await app.harness.snapshot(AgentDoc, conversation.id, context), {
    cwd: " ../raw directory ",
  });
  assert.deepEqual(await app.harness.snapshot(Env, conversation.id, context), {
    env: { type: "ssh", host: "ordinary-host" },
  });
  const clear = form({ clear: "cwd" });
  clear.append("clear", "env");
  assert.equal((await post(clear)).status, 303);
  assert.deepEqual(await app.harness.snapshot(AgentDoc, conversation.id, context), {});
  assert.deepEqual(await app.harness.snapshot(Env, conversation.id, context), {});
  assert.equal((await conversation.agent(context)).thinkingLevel, "off");
});

await test("creation applies explicit clears after task inheritance and existing roots ignore new options", async (t) => {
  const { CompactionTask } = await import("@earendil-works/pi-durable");
  const { app, sessions, auth } = await fixture(t);
  const { serve } = await import("../src/server.ts");
  const server = await serve(sessions, { auth, port: 0 });
  t.after(() => server.close());
  const post = async (action: string, body: FormData) => {
    const response = await fetch(`${server.origin}/api/s/test/${action}`, {
      method: "POST",
      body,
      redirect: "manual",
    });
    await response.body?.cancel();
    assert.equal(response.status, 303);
    const location = new URL(response.headers.get("location")!, server.origin);
    const parts = new URLPattern({ pathname: "/api/s/:session/c/:conversation" }).exec(
      location.href,
    );
    assert(parts?.pathname.groups.conversation);
    const conversation = await app.conversation(
      decode(ConversationId, parts.pathname.groups.conversation),
    );
    assert(conversation);
    return conversation;
  };
  const root = await post(
    "root",
    form({ model: "faux/first", thinking: "high", cwd: "relative", env: "ssh:inherited" }),
  );
  const task = await root.commit(
    (tx) =>
      tx.createTask(CompactionTask, { reason: "manual" }, { ownership: { kind: "conversation" } }),
    context,
  );
  const inherited = await post(
    "createConversation",
    form({ ownership: "task", taskId: String(task), thinking: "low" }),
  );
  assert.deepEqual(await app.harness.snapshot(Env, inherited.id, context), {
    env: { type: "ssh", host: "inherited" },
  });
  assert.deepEqual(await app.harness.snapshot(AgentDoc, inherited.id, context), {
    model: { provider: "faux", modelId: "first" },
    thinkingLevel: "low",
    cwd: "relative",
  });
  const cleared = form({ ownership: "task", taskId: String(task) });
  for (const name of ["model", "thinking", "cwd", "env"]) cleared.append("clear", name);
  const child = await post("createConversation", cleared);
  assert.deepEqual(await app.harness.snapshot(AgentDoc, child.id, context), {});
  assert.deepEqual(await app.harness.snapshot(Env, child.id, context), {});
  const existing = await post(
    "root",
    form({ model: "not-a-model", env: "invalid", clear: "model" }),
  );
  assert.equal(existing.id, root.id);
  assert.deepEqual(await app.harness.snapshot(Env, root.id, context), {
    env: { type: "ssh", host: "inherited" },
  });
});

await test("clearing the local selection prevents subsequent execution on the host", async (t) => {
  const { stat } = await import("node:fs/promises");
  const { app, selection, faux, directory } = await fixture(t);
  const conversation = await app.createConversation(form(selection));
  await app.configure(conversation, form({ clear: "env" }));
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("write", { path: "cleared", content: "not permitted" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("Finished"),
  ]);
  await app.send(conversation, form({ message: "Try the write" }));
  await conversation.waitForIdle(context);
  await assert.rejects(stat(join(directory, "cleared")), { code: "ENOENT" });
  assert.deepEqual(await app.harness.snapshot(Env, conversation.id, context), {});
});

await test("/new preserves unset overrides and /cd requires a selected environment and cwd", async (t) => {
  const { app, directory } = await fixture(t);
  const conversation = await app.root(form({}));
  await assert.rejects(app.send(conversation, form({ message: "/cd elsewhere" })));
  assert.deepEqual(await app.harness.snapshot(AgentDoc, conversation.id, context), {});
  const next = await app.send(conversation, form({ message: "/new" }));
  assert(next && typeof next === "object");
  assert.deepEqual(await app.harness.snapshot(AgentDoc, next.id, context), {});
  assert.deepEqual(await app.harness.snapshot(Env, next.id, context), {});
  await app.configure(next, form({ env: "local" }));
  await assert.rejects(app.send(next, form({ message: "/cd elsewhere" })));
  await app.configure(next, form({ cwd: directory }));
  await app.send(next, form({ message: "/cd nested directory" }));
  assert.equal((await next.agent(context)).cwd, join(directory, "nested directory"));
  assert.equal((await next.context(context)).entries.length, 0);
});

await test("configuration rejects invalid host-only selections without partial writes", async (t) => {
  const { app, selection } = await fixture(t);
  const conversation = await app.createConversation(form(selection));
  const before = await app.harness.snapshot(AgentDoc, conversation.id, context);
  for (const env of ["other:missing", "ssh:-option", "ssh:two hosts", "ssh:host\n"]) {
    await assert.rejects(app.configure(conversation, form({ env, cwd: "/must-not-commit" })));
    assert.deepEqual(await app.harness.snapshot(AgentDoc, conversation.id, context), before);
    assert.deepEqual(await app.harness.snapshot(Env, conversation.id, context), {
      env: { type: "local" },
    });
  }
});

await test(
  "active tools retain their environment while later acquisitions use the committed cwd",
  { timeout: 15_000 },
  async (t) => {
    const { watch } = await import("node:fs");
    const { readFile, stat } = await import("node:fs/promises");
    const { app, faux, selection, directory } = await fixture(t);
    const oldCwd = join(directory, "old");
    const newCwd = join(directory, "new");
    await Promise.all([mkdir(oldCwd), mkdir(newCwd)]);
    const watcher = watch(oldCwd);
    t.after(() => watcher.close());
    const started = once(watcher, "change");
    const conversation = await app.createConversation(form({ ...selection, cwd: oldCwd }));
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("bash", {
          command: "touch started; while [ ! -f release ]; do sleep 0.02; done; touch retained",
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(fauxToolCall("write", { path: "later", content: "new environment" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("Finished"),
    ]);
    await app.send(conversation, form({ message: "Run across configuration" }));
    await started;
    await app.configure(conversation, form({ cwd: newCwd }));
    await writeFile(join(oldCwd, "release"), "");
    await conversation.waitForIdle(context);
    assert((await stat(join(oldCwd, "retained"))).isFile());
    await assert.rejects(stat(join(newCwd, "retained")), { code: "ENOENT" });
    assert.equal(await readFile(join(newCwd, "later"), "utf8"), "new environment");
  },
);

await test("/cd rejects a path when configuration changes during resolution", async (t) => {
  const { NodeExecutionEnv } = await import("@earendil-works/pi-durable/env/node");
  const { app, selection } = await fixture(t);
  const acquired = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  t.mock.method(NodeExecutionEnv.prototype, "absolutePath", async () => {
    acquired.resolve();
    await release.promise;
    return { ok: true, value: "/stale" } as const;
  });
  const conversation = await app.createConversation(form(selection));
  t.after(() => release.resolve());
  const pending = app.send(conversation, form({ message: "/cd nested" }));
  const rejected = assert.rejects(pending);
  await acquired.promise;
  await app.configure(conversation, form({ env: "local", cwd: "/changed" }));
  release.resolve();
  await rejected;
  assert.equal((await conversation.agent(context)).cwd, "/changed");
  assert.deepEqual(await app.harness.snapshot(Env, conversation.id, context), {
    env: { type: "local" },
  });
});

await test("configuration forms reject unsupported fields, duplicate scalars, and ambiguous clears", async (t) => {
  const { app, sessions, auth, selection } = await fixture(t);
  const { serve } = await import("../src/server.ts");
  const server = await serve(sessions, { auth, port: 0 });
  t.after(() => server.close());
  const conversation = await app.createConversation(form(selection));
  const before = await app.harness.snapshot(AgentDoc, conversation.id, context);
  const cases: { body: FormData; status: number }[] = [];
  for (const name of ["instructions", "tools", "extensions", "environment", "configFile", "host"])
    cases.push({ body: form({ [name]: "unsupported", cwd: "/not-committed" }), status: 400 });
  const duplicate = form({ cwd: "/one" });
  duplicate.append("cwd", "/two");
  cases.push({ body: duplicate, status: 400 });
  const repeated = form({ clear: "model" });
  repeated.append("clear", "model");
  cases.push({ body: repeated, status: 200 });
  const fileClear = form({ clear: "model" });
  fileClear.append("clear", new File(["cwd"], "field.txt"));
  cases.push({ body: fileClear, status: 400 });
  cases.push({ body: form({ clear: "unsupported", cwd: "/not-committed" }), status: 200 });
  cases.push({ body: form({ cwd: "" }), status: 200 });
  cases.push({ body: form({ env: "" }), status: 200 });
  for (const { body, status } of cases) {
    const response = await fetch(`${server.origin}/api/s/test/c/${conversation.id}/configure`, {
      method: "POST",
      body,
      redirect: "manual",
    });
    assert.equal(response.status, status);
    assert.equal(response.headers.has("location"), false);
    await response.body?.cancel();
    assert.deepEqual(await app.harness.snapshot(AgentDoc, conversation.id, context), before);
    assert.deepEqual(await app.harness.snapshot(Env, conversation.id, context), {
      env: { type: "local" },
    });
  }
});

await test("removed navigation and catalog pages do not replace home or conversation", async (t) => {
  const { servePrefixed } = await import("./fixtures.ts");
  const { sessions, auth, selection } = await sessionsFixture(t);
  const base = await servePrefixed(t, sessions, auth, "/pds");
  const app = await sessions.open(decode(SessionId, "page removal"));
  const conversation = await app.root(form(selection));
  const path = `api/s/${encodeURIComponent(app.id)}`;
  for (const [route, destination] of [
    ["api/s", "/pds/"],
    [path, "/pds/"],
    [`${path}/c/${conversation.id}/entries?before=1`, `/pds/${path}/c/${conversation.id}`],
  ] as const) {
    const response = await fetch(new URL(route, base), { redirect: "manual" });
    await response.body?.cancel();
    assert.equal(response.status, 303);
    assert.equal(new URL(response.headers.get("location")!, base).pathname, destination);
  }
  const catalog = await fetch(new URL("api/models", base));
  await catalog.body?.cancel();
  assert.equal(catalog.status, 404);
  assert.equal((await app.harness.inspect(context)).scheduling, "paused");
  assert.equal((await app.list()).length, 1);
});
