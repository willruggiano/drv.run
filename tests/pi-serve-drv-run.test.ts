import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { model, waitFor, code } from "../packages/pi-runtime/testing.ts";
import { join } from "node:path";
import { test } from "node:test";
import { remoteFixture } from "../packages/pi-extensions/drv-run/tests/fixture.ts";
import { browserFlow } from "../packages/pi-serve/testing.ts";

await test("mobile browser uses the optional drv.run integration and reconnects", async (t) => {
  const f = await remoteFixture(t);
  // The daemon runs locally in this test. The NixOS test exercises real guest /workspace.
  await browserFlow(t, { ...f, filePath: join(f.workspace, "browser.json") });
});

await test("ask and fresh review use the drv.run pi-env lease without a host fallback", async (t) => {
  const f = await remoteFixture(t);
  const session = await f.sessions.create(randomUUID(), f.binding, model);
  const request = {
    questions: [{ id: "confirm", prompt: "Review this workspace?", type: "single", options: [] }],
  };
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("ask_user", request), { stopReason: "toolUse" }),
    fauxAssistantMessage("Confirmed."),
  ]);
  await session.prompt("Confirm before reviewing.", randomUUID());
  await waitFor(async () => (await session.workflows()).asks.length === 1);
  await session.answer((await session.workflows()).asks[0].id, {
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
  const reviewer = await session.startReview({ target: { kind: "paths", paths: ["."] } });
  await reviewer.waitForIdle(BACKGROUND_CONTEXT);
  assert.equal((await reviewer.agent(BACKGROUND_CONTEXT)).cwd, "/workspace");
  assert.deepEqual((await session.workflows(reviewer)).review?.report, report);
  const results = (await session.history(reviewer))
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
    session.startReview({ target: { kind: "paths", paths: ["."] } }),
    code("unavailable"),
  );
  assert.equal(f.connections.length, 1);
});
