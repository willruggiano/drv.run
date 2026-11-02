import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BACKGROUND_CONTEXT,
  awaitWithContext,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import {
  AgentDoc,
  type SubmissionId,
  type SubmissionRecord,
  type Page,
  type EntryRecord,
  type ConversationRecord,
  type TaskId,
} from "@earendil-works/pi-durable";
import { openHarness, serve, events } from "./fixtures.ts";

const context = BACKGROUND_CONTEXT;
async function post<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  assert.equal(response.status, 200);
  return (await response.json()) as T;
}
async function get<T>(url: string): Promise<T> {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  return (await response.json()) as T;
}

void test("admission, request identity, scoped recovery, withdrawal and execution abort", async (t) => {
  const { harness, root, faux } = await openHarness(t);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let cancelled = false;
  faux.setResponses([
    async (_request, options) => {
      assert(options?.signal);
      started.resolve();
      try {
        await awaitWithContext(release.promise, withAbortSignal(options.signal, context));
      } finally {
        cancelled = options.signal.aborted;
      }
      return fauxAssistantMessage("answer");
    },
  ]);
  t.after(() => release.resolve());
  const { url } = await serve(t, { openHarness: async () => harness });
  const base = `${url}/c/${root.id}`;
  const first = await post<{ id: SubmissionId }>(`${base}/submit`, {
    type: "input",
    content: "hold",
    requestId: "same key & /",
  });
  await started.promise;
  const duplicate = await post(`${base}/submit`, {
    type: "input",
    content: "different",
    requestId: "same key & /",
  });
  assert.deepEqual(duplicate, first);
  const receipt = await get<SubmissionRecord>(
    `${base}/submissionByRequest?requestId=${encodeURIComponent("same key & /")}`,
  );
  assert.equal(receipt.id, first.id);
  assert.deepEqual(await get(`${base}/submissions/status?id=${first.id}`), receipt);
  const busy = await fetch(`${base}/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "input", content: "reject", whenBusy: "reject" }),
  });
  assert.equal(busy.status, 409);
  assert.deepEqual(await busy.json(), {
    type: "about:blank",
    title: "Conflict",
    status: 409,
    sessionId: "test",
    conversationId: root.id,
  });
  assert.equal(await post(`${base}/abortSubmission`, { id: first.id }), "already_placed");
  assert.equal(cancelled, false);
  const queued = await post<{ id: SubmissionId }>(`${base}/submit`, {
    type: "input",
    content: "queued",
    whenBusy: "followUp",
  });
  assert.equal(await post(`${base}/abortSubmission`, queued), "aborted");
  assert.equal(await post(`${base}/abortSubmission`, queued), "settled");
  const other = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
  assert.equal(await get(`${url}/c/${other.id}/submissions/status?id=${first.id}`), null);
  assert.equal(
    await get(
      `${url}/c/${other.id}/submissionByRequest?requestId=${encodeURIComponent("same key & /")}`,
    ),
    null,
  );
  assert.equal(await post(`${url}/c/${other.id}/abortSubmission`, first), "not_found");
  assert.equal(await post(`${base}/abort`), null);
  assert.equal(cancelled, true);
  assert.equal(
    (await (await harness.submission(first.id, context))!.status(context)).status,
    "unanswered",
  );
});

void test("upstream input representation and custom entry data survive admission", async (t) => {
  const { harness, root, faux } = await openHarness(t);
  faux.setResponses([fauxAssistantMessage("done")]);
  const { url } = await serve(t, { openHarness: async () => harness });
  const content = [
    { type: "text", text: "hello", textSignature: "opaque" },
    { type: "image", data: "aGk=", mimeType: "image/png" },
  ];
  const receipt = await post<{ id: SubmissionId }>(`${url}/c/1/submit`, {
    type: "input",
    content,
    entry: { kind: "app.user", data: { author: "test", nested: [null, true, 1] } },
  });
  await (await harness.submission(receipt.id, context))!.wait(context);
  const history = await root.entries({ order: "ascending" }, 100, undefined, context);
  assert.equal(history.items[0]?.kind, "app.user");
  assert.deepEqual(history.items[0]?.data, { author: "test", nested: [null, true, 1] });
  assert.deepEqual(history.items[0]?.model?.[0]?.content, content);
});

void test("history pagination preserves order, bounds, records, and opaque continuations", async (t) => {
  const { harness, root } = await openHarness(t);
  for (let i = 0; i < 3; i++)
    await root.submit({ type: "write", entry: { kind: "seed", data: i } }, context);
  const expected = await root.entries({ order: "ascending" }, 100, undefined, context);
  const { url } = await serve(t, { openHarness: async () => harness });
  const path = `${url}/c/1/entries?limit=2&order=ascending`;
  const first = await get<Page<EntryRecord, string>>(path);
  assert.deepEqual(first.items, expected.items.slice(0, 2));
  assert.equal(typeof first.next, "string");
  const last = await get<Page<EntryRecord, string>>(`${path}&cursor=${first.next}`);
  assert.deepEqual(last, { items: expected.items.slice(2) });
  const conflict = await fetch(`${url}/c/1/entries?limit=2&order=descending&cursor=${first.next}`);
  assert.equal(conflict.status, 400);
  const middle = expected.items[1]!;
  assert.deepEqual(
    await get(`${url}/c/1/entries?limit=5&minEntryId=${middle.id}&maxEntryId=${middle.id}`),
    { items: [middle] },
  );
});

void test("session scans, read-only inspection, explicit resume, and ownership filters", async (t) => {
  const { harness } = await openHarness(t);
  const other = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
  const { url } = await serve(t, { openHarness: async () => harness });
  const inspection = await harness.inspect(context);
  assert.deepEqual(await get(`${url}/inspect`), inspection);
  assert.equal((await harness.inspect(context)).scheduling, "paused");
  const expected = await harness.commit((tx) => tx.scanConversations({}, 100, undefined), context);
  const first = await get<Page<ConversationRecord, string>>(`${url}/scanConversations?limit=1`);
  const last = await get<Page<ConversationRecord, string>>(
    `${url}/scanConversations?limit=1&cursor=${first.next}`,
  );
  assert.deepEqual([...first.items, ...last.items], expected.items);
  for (const filters of [`ownerConversationId=${other.id}`, "ownerTaskId=0"])
    assert.deepEqual(await get(`${url}/scanConversations?limit=1&${filters}`), { items: [] });
  assert.deepEqual(
    await get(
      `${url}/scanTasks?limit=1&conversationId=${other.id}&kind=pi.compaction&status=terminal&background=false&abortRequested=true&order=descending`,
    ),
    { items: [] },
  );
  assert.equal((await harness.inspect(context)).scheduling, "paused");
  assert.equal(await post(`${url}/resume`), null);
  assert.equal((await harness.inspect(context)).scheduling, "running");
});

void test("configuration omission, replacement, clearing, and current/historical context", async (t) => {
  const { harness, root } = await openHarness(t);
  const { url } = await serve(t, { openHarness: async () => harness });
  const base = `${url}/c/1`;
  assert.deepEqual(await get(`${base}/context`), { entries: [], contributions: [], messages: [] });
  const original = await harness.snapshot(AgentDoc, root.id, context);
  assert.equal(await post(`${base}/configure`, {}), null);
  assert.deepEqual(await harness.snapshot(AgentDoc, root.id, context), original);
  await post(`${base}/configure`, {
    model: { provider: "other", modelId: "new" },
    thinkingLevel: "high",
  });
  assert.deepEqual((await harness.snapshot(AgentDoc, root.id, context))?.model, {
    provider: "other",
    modelId: "new",
  });
  assert.equal((await harness.snapshot(AgentDoc, root.id, context))?.thinkingLevel, "high");
  await post(`${base}/configure`, { model: null, thinkingLevel: null });
  const cleared = await harness.snapshot(AgentDoc, root.id, context);
  assert(cleared);
  assert.equal(Object.hasOwn(cleared, "model"), false);
  assert.equal(Object.hasOwn(cleared, "thinkingLevel"), false);
  assert.equal(await post(`${base}/reset`, {}), null);
  assert.equal(await post(`${base}/reset`, { handoff: "exact handoff\n" }), null);
  const current = await root.context(context);
  assert(current.head);
  assert.deepEqual(await get(`${base}/context`), current);
  assert.deepEqual(
    await get(`${base}/context?at=${current.head.id}`),
    await root.context(context, { at: current.head.id }),
  );
  const other = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
  const invisible = await fetch(`${url}/c/${other.id}/context?at=${current.head.id}`);
  assert.equal(invisible.status, 500);
});

void test("compaction admission returns a task ID and scans preserve terminal records", async (t) => {
  const { harness, root, faux } = await openHarness(t);
  faux.setResponses([
    fauxAssistantMessage("answer"),
    fauxAssistantMessage("summary"),
    fauxAssistantMessage("summary 2"),
  ]);
  await (await root.submit({ type: "input", content: "question" }, context)).wait(context);
  const { url } = await serve(t, { openHarness: async () => harness });
  for (const body of [{ instructions: "keep exact" }, {}]) {
    const id = await post<TaskId>(`${url}/c/1/compact`, body);
    assert.equal(typeof id, "number");
    await harness.waitForTask(id, context);
  }
  const query = { kind: "pi.compaction", status: "terminal" } as const;
  const expected = await harness.commit((tx) => tx.scanTasks(query, 100, undefined), context);
  assert.equal(expected.items.length, 2);
  const first = await get<Page<unknown, string>>(
    `${url}/scanTasks?limit=1&kind=pi.compaction&status=terminal`,
  );
  const last = await get<Page<unknown, string>>(
    `${url}/scanTasks?limit=1&kind=pi.compaction&status=terminal&cursor=${first.next}`,
  );
  assert.deepEqual([...first.items, ...last.items], expected.items);
});

void test("SSE acquisition, replacements, reconnect, disconnect isolation, and terminal ordering", async (t) => {
  const { harness, root, faux } = await openHarness(t);
  const { url } = await serve(t, { openHarness: async () => harness });
  const base = `${url}/c/1`;
  const controller = new AbortController();
  const iterator = events(await fetch(`${base}/watch`, { signal: controller.signal }));
  const initial = await iterator.next();
  assert(!initial.done && initial.value.type === "snapshot");
  assert.equal(initial.value.value.conversation.id, root.id);
  assert.deepEqual(initial.value.value.entries, []);
  assert(initial.value.value.docs);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  faux.setResponses([
    async (_request, options) => {
      signal = options?.signal;
      started.resolve();
      assert(signal);
      await awaitWithContext(release.promise, withAbortSignal(signal, context));
      return fauxAssistantMessage("finished after disconnect");
    },
  ]);
  t.after(() => release.resolve());
  const receipt = await post<{ id: SubmissionId }>(`${base}/submit`, {
    type: "input",
    content: "go",
  });
  await started.promise;
  const replacement = await iterator.next();
  assert(!replacement.done && replacement.value.type === "snapshot");
  assert.notDeepEqual(replacement.value.value, initial.value.value);
  const next = iterator.next();
  controller.abort();
  // A buffered frame may already be available; drain until the cancelled read rejects.
  await Promise.allSettled([next, iterator.return(undefined)]);
  assert.equal(signal?.aborted, false);
  release.resolve();
  await (await harness.submission(receipt.id, context))!.wait(context);
  const reconnected = events(await fetch(`${base}/watch`));
  const fresh = await reconnected.next();
  assert(!fresh.done && fresh.value.type === "snapshot");
  assert.deepEqual(
    fresh.value.value.entries,
    (await root.entries({ order: "ascending" }, 100, undefined, context)).items,
  );
  await harness.close(context);
  const end = await reconnected.next();
  assert.deepEqual(end.value, { type: "end", value: { reason: "session_closed" } });
  assert.equal((await reconnected.next()).done, true);
});
