import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { fixture } from "../pi-runtime/testing.ts";
import type { Snapshot } from "../pi-runtime/index.ts";
import {
  post,
  serve,
  snapshot,
  workflowQuestions as questions,
  workflowReport as report,
} from "./testing.ts";

const context = BACKGROUND_CONTEXT;

await test("workflow HTTP validates scope, admission, answers and review actions", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  await writeFile(join(f.workspace, "preferences.ts"), "export {};\n");
  const base = await serve(t, f.sessions);
  const url = `${base}/api/sessions/${session.id}`;
  for (const [action, data] of [
    ["review", {}],
    ["answer", { id: "bad" }],
    ["end-review", {}],
  ] as const)
    assert.equal((await post(`${url}/${action}`, data)).status, 400);
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("ask_user", questions), { stopReason: "toolUse" }),
    fauxAssistantMessage("Thanks."),
  ]);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const stream = await fetch(`${url}/events`, { signal: controller.signal });
  assert(stream.body);
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  async function nextSnapshot(predicate: (value: Snapshot) => boolean) {
    for (;;) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (!frame.startsWith("data: ")) continue;
        const value = JSON.parse(frame.slice(6)) as Snapshot;
        if (predicate(value)) return value;
        continue;
      }
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  }
  const timeout = setTimeout(() => controller.abort(), 10000);
  t.after(() => clearTimeout(timeout));
  await nextSnapshot((value) => value.workflows?.asks.length === 0);
  await session.prompt("Ask about the design.", randomUUID());
  const pending = await nextSnapshot(
    (value) => !!value.workflows?.asks.some((item) => item.actionable),
  );
  const ask = pending.workflows!.asks[0];
  assert.equal(
    (await post(`${url}/review`, { target: { kind: "paths", paths: ["preferences.ts"] } })).status,
    409,
  );
  assert.equal(
    (
      await post(`${url}/answer`, {
        id: ask.id,
        response: { action: "submit", answers: [{ id: "unknown", selected: [], optionNotes: [] }] },
      })
    ).status,
    400,
  );
  const response = {
    action: "submit",
    answers: [{ id: "storage", selected: ["sqlite"], optionNotes: [] }],
  };
  assert.equal((await post(`${url}/answer`, { id: ask.id, response })).status, 200);
  const answered = await nextSnapshot((value) => !!value.workflows?.asks[0]?.response);
  assert.deepEqual(answered.workflows!.asks[0].response, response);
  controller.abort();
  reader.releaseLock();
  await session.root.waitForIdle(context);
  assert.equal((await post(`${url}/answer`, { id: ask.id, response })).status, 409);
  const restored = await snapshot(`${url}/events`);
  assert.deepEqual(restored.workflows?.asks[0].response, response);
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("submit_review", report), { stopReason: "toolUse" }),
  ]);
  const started = await post(`${url}/review`, {
    target: { kind: "paths", paths: ["preferences.ts"] },
  });
  assert.equal(started.status, 201);
  const { id } = (await started.json()) as { id: number };
  const reviewer = await session.conversation(id);
  await reviewer.waitForIdle(context);
  const reviewSnapshot = await snapshot(`${url}/events?conversation=${id}`);
  assert.deepEqual(reviewSnapshot.workflows?.review?.report, report);
  assert(reviewSnapshot.inspection.state === "available");
  assert.equal(reviewSnapshot.inspection.conversation, reviewer.id);
  assert.deepEqual(
    reviewSnapshot.inspection.messages.map((message) => message.role),
    (await reviewer.context(context)).messages.map((message) => message.role),
  );
  assert.equal(
    (
      await post(`${url}/end-review?conversation=${id}`, {
        action: "fix",
        findings: [],
        requestId: randomUUID(),
      })
    ).status,
    400,
  );
  const count = f.faux.state.callCount;
  assert.equal(
    (
      await post(`${url}/end-review?conversation=${id}`, {
        action: "handoff",
        findings: [],
        requestId: randomUUID(),
      })
    ).status,
    200,
  );
  assert.equal(f.faux.state.callCount, count);
});
