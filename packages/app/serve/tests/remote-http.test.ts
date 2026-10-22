import { mkdir, readFile, writeFile } from "node:fs/promises";
import { serve, post } from "./testing.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { model } from "./sessions-testing.ts";
import { join } from "node:path";
import { test } from "node:test";
import { remoteFixture } from "./drv-run-testing.ts";

const context = BACKGROUND_CONTEXT;

await test("HTTP composition runs pi-env tools and preserves work after disconnect", async (t) => {
  const f = await remoteFixture(t);
  await f.reopen({ targets: f.targets });
  const base = await serve(t, f.sessions);
  const id = randomUUID();
  const created = await post(base + "/api/sessions", {
    id,
    binding: f.binding,
    model,
    baseDirectory: "",
  });
  assert.equal(created.status, 201);
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("write", { path: "http.json", content: '{"ok":true}' }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage(fauxToolCall("read", { path: "http.json" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Done."),
  ]);
  const url = `${base}/api/harness/${id}`;
  const stream = await fetch(url + "/watch");
  assert.equal(stream.status, 200);
  await stream.body?.cancel();
  const draft = { type: "input", content: "Write and read.", requestId: "http-idempotency" };
  const submitted = await post(url + "/submit", draft);
  assert.equal(submitted.status, 200);
  const handle = await submitted.json();
  const duplicate = await (await post(url + "/submit", draft)).json();
  assert.equal(handle.id, duplicate.id);
  const waited = await post(url + "/submission/wait", { id: handle.id });
  assert.equal(waited.status, 200);
  await (await f.sessions.get(id)).root.waitForIdle(context);
  assert.deepEqual(JSON.parse(await readFile(join(f.workspace, "http.json"), "utf8")), {
    ok: true,
  });
  const entries = await (await fetch(url + "/entries")).json();
  assert.equal(
    entries.items
      .flatMap((entry: { model?: unknown[] }) => entry.model ?? [])
      .filter((message: { role: string }) => message.role === "user").length,
    1,
  );
  assert.equal(f.faux.state.callCount, 3);
});

await test("HTTP cd and directory completion use the daemon and subsequent tools use the new cwd", async (t) => {
  const f = await remoteFixture(t);
  await f.reopen({ targets: f.targets });
  const nested = join(f.workspace, "new directory");
  await mkdir(nested);
  const session = await f.sessions.create(randomUUID(), f.binding, model, undefined, "");
  const base = await serve(t, f.sessions);
  const url = `${base}/api/harness/${session.id}/submit`;
  const complete = await fetch(
    `${base}/api/sessions/${session.id}/completions?kind=directory&query=new`,
  );
  assert.equal(complete.status, 200);
  assert.deepEqual(await complete.json(), ["new directory/"]);
  assert.equal((await post(url, { type: "input", content: "/cd new directory" })).status, 200);
  assert.equal((await session.root.agent(context)).cwd, nested);
  assert.equal(f.faux.state.callCount, 0);
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("write", { path: "after-cd.json", content: "42" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("Done."),
  ]);
  assert.equal((await post(url, { type: "input", content: "Write here." })).status, 200);
  await session.root.waitForIdle(context);
  assert.equal(JSON.parse(await readFile(join(nested, "after-cd.json"), "utf8")), 42);
  assert.equal(f.faux.state.callCount, 2);
  await writeFile(f.states, "{}");
  assert.equal((await post(url, { type: "input", content: "/cd .." })).status, 409);
  assert.equal((await session.root.agent(context)).cwd, nested);
});
