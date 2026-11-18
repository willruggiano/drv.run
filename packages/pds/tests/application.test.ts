import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AgentDoc, CompactionEntry, LiveDoc } from "@earendil-works/pi-durable";
import { Env } from "../src/harness/index.ts";
import { attachments, context, discoverEnvironments } from "../src/application.ts";
import { fixture, form } from "./fixtures.ts";

await test("sessions persist configuration, attachments, messages, compaction, and /new isolation", async (t) => {
  const { app, faux, selection, open } = await fixture(t);
  const first = await app.create(form(selection));
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
    form({ ...selection, model: "faux/second", environment: "test-guest", cwd: "/other" }),
  );
  assert.deepEqual(await app.harness.snapshot(Env, first.id, context), {
    env: {
      type: "ssh",
      host: "test-guest",
      knownHostsFile: "/known_hosts",
      hostKeyAlias: "test-guest",
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
    const restored = await reopened.conversation(String(first.id));
    assert(restored);
    assert.equal((await restored.agent(context)).cwd, "/other");
    assert.equal((await restored.context(context)).head?.kind, "pi.compaction");
  } finally {
    await reopened.close();
  }
});

await test("configuration is atomic and running tool requests use the selected working directory", async (t) => {
  const { app, faux, selection, directory } = await fixture(t);
  const first = await app.create(form(selection));
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
  const conversation = await app.create(form({ ...selection, model: "faux/second" }));
  const input = form({ message: "look" });
  input.append("attachments", image);
  await assert.rejects(app.send(conversation, input));
  await assert.rejects(app.send(conversation, form({ message: "/unknown" })));
  assert.equal((await conversation.context(context)).entries.length, 0);
});

await test("environment discovery exposes only complete drv.run SSH connection files", async (t) => {
  const { directory } = await fixture(t);
  const ready = join(directory, "drv.run.ready");
  await mkdir(ready);
  await mkdir(join(directory, "drv.run.starting"));
  await Promise.all(
    ["client.conf", "client-key", "known_hosts"].map((name) => writeFile(join(ready, name), "")),
  );
  const environments = await discoverEnvironments(directory);
  assert.deepEqual(
    environments.map((item) => item.id),
    ["local", "drv.run.ready"],
  );
  assert.equal(environments[1]?.target?.configFile, join(ready, "client.conf"));
});

await test("HTTP rejects foreign writes and accepts native forms at the configured public origin", async (t) => {
  const { serve } = await import("../src/server.ts");
  const { app, selection } = await fixture(t);
  const server = await serve(app, { port: 0, origin: "https://pds.test" });
  try {
    const foreign = await fetch(`${server.origin}/sessions`, {
      method: "POST",
      body: form(selection),
      headers: { Origin: "https://foreign.test", "Datastar-Request": "true" },
    });
    assert.equal(foreign.status, 403);
    await foreign.body?.cancel();
    const plain = await fetch(`${server.origin}/sessions`, {
      method: "POST",
      body: form(selection),
      headers: { Origin: "https://pds.test" },
      redirect: "manual",
    });
    assert.equal(plain.status, 303);
    await plain.body?.cancel();
    assert.equal((await app.list()).length, 1);
    const missing = await fetch(`${server.origin}/sessions/9999`);
    assert.equal(missing.status, 404);
    await missing.body?.cancel();
    const allowed = await fetch(`${server.origin}/sessions`, {
      method: "POST",
      body: form(selection),
      headers: { Origin: "https://pds.test", "Datastar-Request": "true" },
    });
    assert.equal(allowed.status, 200);
    await allowed.body?.cancel();
    assert.equal((await app.list()).length, 2);
  } finally {
    await server.close();
  }
});

await test("creation admits its initial prompt and attachments; invalid uploads leave no session", async (t) => {
  const { app, faux, selection } = await fixture(t);
  faux.setResponses([fauxAssistantMessage("Created with input")]);
  const initial = form({ ...selection, message: "First prompt" });
  initial.append("attachments", new File(["the attached text"], "note.txt"));
  const conversation = await app.create(initial);
  await conversation.waitForIdle(context);
  const messages = (await conversation.context(context)).messages;
  const user = messages.find((message) => message.role === "user");
  assert.deepEqual(user?.content, [
    { type: "text", text: "First prompt" },
    { type: "text", text: "Attachment: note.txt\n\nthe attached text" },
  ]);
  const invalid = form({ ...selection, message: "Invalid attachment" });
  invalid.append("attachments", new File([new Uint8Array([255])], "binary"));
  await assert.rejects(app.create(invalid));
  await assert.rejects(app.create(form({ ...selection, message: "/compact" })));
  assert.equal((await app.list()).length, 1);
});

await test("partial configuration and /cd preserve unrelated state without admitting model turns", async (t) => {
  const { app, faux, selection, directory } = await fixture(t);
  const conversation = await app.create(form(selection));
  await Promise.all([
    app.configure(conversation, form({ thinking: "high" })),
    app.configure(conversation, form({ cwd: "subdirectory" })),
  ]);
  assert.equal((await conversation.agent(context)).cwd, join(directory, "subdirectory"));
  assert.equal((await conversation.agent(context)).thinkingLevel, "high");
  await app.configure(conversation, form({ model: "faux/second" }));
  assert.equal((await conversation.agent(context)).thinkingLevel, "off");
  await app.configure(conversation, form({ environment: "test-guest" }));
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
