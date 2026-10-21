import { readFile } from "node:fs/promises";
import { serve, post } from "../packages/pi-serve/tests/testing.ts";
import * as workflow from "../packages/pi-runtime/workflows.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { readHistory, model, waitFor, code } from "../packages/pi-runtime/testing.ts";
import { join } from "node:path";
import { test } from "node:test";
import { remoteFixture } from "../packages/pi-drv-run/tests/fixture.ts";

const context = BACKGROUND_CONTEXT;

await test("ask and fresh review use pi-env without a host fallback", async (t) => {
  const f = await remoteFixture(t);
  // The real daemon runs locally; use a temporary workspace instead of guest /workspace.
  await f.reopen({ targets: f.targets });
  const session = await f.sessions.create(randomUUID(), f.binding, model, undefined, "");
  const request = {
    questions: [{ id: "confirm", prompt: "Review this workspace?", type: "single", options: [] }],
  };
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("ask_user", request), { stopReason: "toolUse" }),
    fauxAssistantMessage("Confirmed."),
  ]);
  await session.root.submit(
    { type: "input", content: "Confirm before reviewing.", requestId: randomUUID() },
    context,
  );
  await waitFor(async () => (await workflow.workflows(session)).asks.length === 1);
  await workflow.answer(session, (await workflow.workflows(session)).asks[0].id, {
    action: "submit",
    answers: [{ id: "confirm", selected: [], text: "Yes", optionNotes: [] }],
  });
  await session.root.waitForIdle(BACKGROUND_CONTEXT);
  const file = join(f.workspace, "review.json");
  await writeFile(file, "{}\n");
  const report = { scope: "Workspace", findings: [], verdict: "correct", callouts: [] };
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("read", { path: file }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("submit_review", report), { stopReason: "toolUse" }),
  ]);
  const reviewer = await workflow.startReview(session, { target: { kind: "paths", paths: ["."] } });
  await reviewer.waitForIdle(BACKGROUND_CONTEXT);
  assert.equal((await reviewer.agent(BACKGROUND_CONTEXT)).cwd, f.workspace);
  assert.deepEqual((await workflow.workflows(session, reviewer)).review?.report, report);
  const results = (await readHistory(reviewer))
    .flatMap((entry) => entry.model ?? [])
    .filter((message) => message.role === "toolResult");
  assert.equal(results.length, 2);
  assert.equal(
    results.every((result) => !result.isError),
    true,
  );
  assert.equal(f.connections.length, 1);
  assert.equal(f.sshOptions.length, 1);
  await writeFile(f.states, JSON.stringify({ test1: "inactive" }));
  await assert.rejects(
    workflow.startReview(session, { target: { kind: "paths", paths: ["."] } }),
    code("unavailable"),
  );
  assert.equal(f.connections.length, 1);
});

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
