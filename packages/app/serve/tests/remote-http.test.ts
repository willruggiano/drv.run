import { mkdir, readFile, writeFile } from "node:fs/promises";
import { serve, post } from "./testing.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { model } from "./sessions-testing.ts";
import { completeWorkingDirectories } from "../sessions.ts";
import { conversationURL } from "../hypermedia.ts";
import { modelKey, targetKey } from "../hypermedia-forms.ts";
import { join } from "node:path";
import { test } from "node:test";
import { remoteFixture } from "./drv-run-testing.ts";

const context = BACKGROUND_CONTEXT;

await test("HTTP composition runs pi-env tools and preserves work after disconnect", async (t) => {
  const f = await remoteFixture(t);
  await f.reopen({ targets: f.targets });
  const base = await serve(t, f.sessions);
  const id = randomUUID();
  const post = (url: string, data: Record<string, string>) =>
    fetch(url, {
      method: "POST",
      headers: { Origin: base },
      body: new URLSearchParams(data),
      redirect: "manual",
    });
  const created = await post(base + "/sessions", {
    id,
    target: targetKey(f.binding),
    model: modelKey(model),
    baseDirectory: "",
  });
  assert.equal(created.status, 303);
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("write", { path: "http.json", content: '{"ok":true}' }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage(fauxToolCall("read", { path: "http.json" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Done."),
  ]);
  const session = await f.sessions.get(id);
  assert.equal((await session.root.agent(context)).cwd, f.workspace);
  const url = base + conversationURL(session);
  const stream = await fetch(url + "/events");
  assert.equal(stream.status, 200);
  await stream.body?.cancel();
  const draft = { whenBusy: "reject", content: "Write and read.", requestId: "http-idempotency" };
  const submitted = await post(url + "/submit", draft);
  assert.equal(submitted.status, 303);
  assert.equal((await post(url + "/submit", draft)).status, 303);
  await session.root.waitForIdle(context);
  assert.deepEqual(JSON.parse(await readFile(join(f.workspace, "http.json"), "utf8")), {
    ok: true,
  });
  const entries = await (await fetch(url + "/export")).json();
  assert.equal(
    entries
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
  const url = base + conversationURL(session);
  const complete = await fetch(`${url}/completions?kind=directory&query=new`);
  assert.equal(complete.status, 200);
  assert.deepEqual(await completeWorkingDirectories(session, "new"), ["new directory/"]);
  assert.equal((await post(url + "/cd", { argument: "new directory" })).status, 303);
  assert.equal((await session.root.agent(context)).cwd, nested);
  assert.equal(f.faux.state.callCount, 0);
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("write", { path: "after-cd.json", content: "42" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("Done."),
  ]);
  assert.equal(
    (
      await post(url + "/submit", {
        content: "Write here.",
        requestId: "after-cd",
        whenBusy: "reject",
      })
    ).status,
    303,
  );
  await session.root.waitForIdle(context);
  assert.equal(JSON.parse(await readFile(join(nested, "after-cd.json"), "utf8")), 42);
  assert.equal(f.faux.state.callCount, 2);
  await writeFile(f.states, "{}");
  assert.equal((await post(url + "/cd", { argument: ".." })).status, 409);
  assert.equal((await session.root.agent(context)).cwd, nested);
});
