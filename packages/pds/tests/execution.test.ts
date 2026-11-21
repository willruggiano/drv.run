import assert from "node:assert/strict";
import { test } from "node:test";
import { watch } from "node:fs";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { InboxDoc, CompactionTask, defineTask } from "@earendil-works/pi-durable";
import { context } from "../src/application.ts";
import { form, sessionsFixture, servePrefixed } from "./fixtures.ts";

await test(
  "withdrawal preserves queued, placed, settled and foreign results without aborting execution",
  { timeout: 10000 },
  async (t) => {
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    t.after(() => finish.resolve());
    const { sessions, auth, selection, faux } = await sessionsFixture(t);
    const base = await servePrefixed(t, sessions, auth, "/pds");
    const app = await sessions.open();
    const conversation = await app.root(form(selection));
    const other = await app.createConversation(form(selection));
    const path = `api/s/${app.id}/c/${conversation.id}`;
    faux.setResponses([
      async () => {
        started.resolve();
        await finish.promise;
        return fauxAssistantMessage("Completed, not aborted");
      },
    ]);
    const placed = await app.submit(conversation, form({ message: "Running" }));
    await started.promise;
    const queued = await app.submit(conversation, form({ message: "Queued" }));
    const withdraw = async (id: number, addressed = conversation.id) => {
      const response = await fetch(
        new URL(`api/s/${app.id}/c/${addressed}/abortSubmission`, base),
        {
          method: "POST",
          body: form({ id: String(id) }),
          redirect: "manual",
        },
      );
      await response.body?.cancel();
      assert.equal(response.status, 303);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const location = new URL(response.headers.get("location")!, base);
      assert.equal(location.pathname, `/pds/api/s/${app.id}/c/${addressed}`);
      assert.equal(location.searchParams.get("id"), String(id));
      return location.searchParams.get("withdrawal");
    };
    assert.equal(await withdraw(queued, other.id), "not_found");
    assert.equal(await withdraw(999999), "not_found");
    assert.equal(await withdraw(queued), "aborted");
    assert.equal(await withdraw(queued), "settled");
    assert.equal(await withdraw(placed), "already_placed");
    const running = await app.harness.inspect(context);
    assert(running.tasks.some(({ state }) => state.kind === "running"));
    assert(running.tasks.every(({ record }) => !record.abortRequested));
    assert.deepEqual((await app.harness.snapshot(InboxDoc, conversation.id, context))?.items, []);
    finish.resolve();
    await conversation.waitForIdle(context);
    assert.equal(await withdraw(placed), "settled");
    const receipt = await app.harness.submission(placed, context);
    assert.equal((await receipt?.status(context))?.status, "done");
    const page = await fetch(new URL(path, base));
    await page.body?.cancel();
    assert.equal(page.status, 200);
  },
);

await test("execution inspection is not exposed", async (t) => {
  const { sessions, auth } = await sessionsFixture(t);
  const base = await servePrefixed(t, sessions, auth, "/pds");
  const app = await sessions.open();
  for (const method of ["GET", "POST"]) {
    const response = await fetch(new URL(`api/s/${app.id}/inspect`, base), { method });
    await response.body?.cancel();
    assert.equal(response.status, 404);
  }
  assert.equal((await app.harness.inspect(context)).scheduling, "paused");
});

await test(
  "resume enables scheduling without waiting or repairing blocked tasks",
  { timeout: 10000 },
  async (t) => {
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    t.after(() => finish.resolve());
    const { sessions, auth, selection, faux } = await sessionsFixture(t);
    const base = await servePrefixed(t, sessions, auth, "/pds");
    const app = await sessions.open();
    const conversation = await app.root(form(selection));
    const missing = defineTask({ ...CompactionTask.definition, name: "unavailable.task" });
    const [blocked, pending] = await conversation.commit(async (tx) => {
      for (let index = 0; index < 4; index++)
        await tx.appendEntry(conversation.id, {
          kind: "pi.assistant",
          model: [fauxAssistantMessage(`Existing context ${index}`)],
        });
      return [
        await tx.createTask(missing, { reason: "manual" }, { ownership: { kind: "conversation" } }),
        await tx.createTask(
          CompactionTask,
          { reason: "manual" },
          { ownership: { kind: "conversation" } },
        ),
      ];
    }, context);
    const before = await app.harness.inspect(context);
    assert.equal(before.scheduling, "paused");
    assert.equal(before.tasks.find(({ record }) => record.id === blocked)?.state.kind, "blocked");
    assert.equal(before.tasks.find(({ record }) => record.id === pending)?.state.kind, "pending");
    const path = `api/s/${app.id}`;
    for (let i = 0; i < 2; i++) {
      const response = await fetch(new URL(path, base));
      await response.body?.cancel();
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await app.harness.inspect(context), before);
    }
    assert.equal(faux.state.callCount, 0);
    faux.setResponses([
      async () => {
        started.resolve();
        await finish.promise;
        return fauxAssistantMessage("Resumed summary");
      },
    ]);
    const response = await fetch(new URL(`${path}/resume`, base), {
      method: "POST",
      body: form({}),
      redirect: "manual",
    });
    await response.body?.cancel();
    assert.equal(response.status, 303);
    assert.equal(new URL(response.headers.get("location")!, base).pathname, `/pds/${path}`);
    await started.promise;
    const running = await app.harness.inspect(context);
    assert.equal(running.scheduling, "running");
    assert.equal(running.tasks.find(({ record }) => record.id === blocked)?.state.kind, "blocked");
    assert.equal((await app.harness.getTask(pending, context))?.state.status, "running");
    finish.resolve();
    assert.equal((await app.harness.waitForTask(pending, context)).state.status, "terminal");
  },
);

await test(
  "abort waits for native completion, withdraws inputs, and preserves writes and background subtrees",
  { timeout: 10000 },
  async (t) => {
    const started = Promise.withResolvers<void>();
    const signalled = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    t.after(() => finish.resolve());
    const { sessions, auth, selection, faux } = await sessionsFixture(t);
    const base = await servePrefixed(t, sessions, auth, "/pds");
    const app = await sessions.open();
    const conversation = await app.root(form(selection));
    faux.setResponses([
      async (_messages, options) => {
        assert(options?.signal);
        options.signal.addEventListener("abort", () => signalled.resolve(), { once: true });
        started.resolve();
        await finish.promise;
        return fauxAssistantMessage("Released after abort");
      },
    ]);
    await app.submit(conversation, form({ message: "Running" }));
    await started.promise;
    const run = (await app.harness.inspect(context)).tasks.find(
      ({ record }) => record.kind === "pi.generation",
    );
    assert(run);
    const missing = defineTask({ ...CompactionTask.definition, name: "unavailable.task" });
    const child = await app.createConversation(form(selection), {
      kind: "task",
      taskId: run.record.id,
    });
    const ordinary = await child.commit(
      (tx) => tx.createTask(missing, { reason: "manual" }, { ownership: { kind: "conversation" } }),
      context,
    );
    const background = await conversation.commit(
      (tx) =>
        tx.createTask(
          missing,
          { reason: "manual" },
          { ownership: { kind: "conversation" }, background: true },
        ),
      context,
    );
    const backgroundChild = await app.createConversation(form(selection), {
      kind: "task",
      taskId: background,
    });
    const retained = await backgroundChild.commit(
      (tx) => tx.createTask(missing, { reason: "manual" }, { ownership: { kind: "conversation" } }),
      context,
    );
    const queued = await app.submit(conversation, form({ message: "Withdraw this" }));
    const write = await conversation.submit(
      {
        type: "write",
        entry: {
          kind: "example.write",
          model: [{ role: "user", content: "Keep this", timestamp: 0 }],
        },
      },
      context,
    );
    assert.equal((await write.status(context)).status, "queued");
    let completed = false;
    const abort = fetch(new URL(`api/s/${app.id}/c/${conversation.id}/abort`, base), {
      method: "POST",
      body: form({}),
      redirect: "manual",
    }).then((response) => {
      completed = true;
      return response;
    });
    await signalled.promise;
    assert.equal(completed, false);
    const withdrawn = await app.harness.submission(queued, context);
    assert.equal((await withdrawn?.status(context))?.reason, "aborted");
    assert.equal((await write.status(context)).status, "queued");
    finish.resolve();
    const response = await abort;
    await response.body?.cancel();
    assert.equal(response.status, 303);
    assert.equal(
      new URL(response.headers.get("location")!, base).searchParams.get("aborted"),
      "true",
    );
    assert.equal((await app.harness.getTask(ordinary, context))?.state.status, "terminal");
    for (const id of [background, retained]) {
      const task = await app.harness.getTask(id, context);
      assert.equal(task?.state.status, "pending");
      assert.equal(task.abortRequested, false);
    }
    assert.notEqual((await write.status(context)).reason, "aborted");
  },
);

await test("execution routes enforce methods, scope, request shape and origin without scheduling", async (t) => {
  const { sessions, auth, selection } = await sessionsFixture(t);
  const base = await servePrefixed(t, sessions, auth, "/pds");
  const app = await sessions.open();
  const conversation = await app.root(form(selection));
  const session = `api/s/${app.id}`;
  const scope = `${session}/c/${conversation.id}`;
  const routes = [
    [`${session}/resume`, "POST"],
    [`${scope}/abortSubmission`, "POST"],
    [`${scope}/abort`, "POST"],
  ] as const;
  for (const [path, method] of routes) {
    const wrong = await fetch(new URL(path, base), { method: "GET" });
    await wrong.body?.cancel();
    assert.equal(wrong.status, 405);
    assert.equal(wrong.headers.get("allow"), method);
    assert.equal(wrong.headers.get("cache-control"), "no-store");
  }
  for (const [path, body] of [
    [`${session}/resume`, "background=true"],
    [`${scope}/abort`, "background=true"],
    [`${scope}/abortSubmission`, ""],
    [`${scope}/abortSubmission`, "id=-1"],
    [`${scope}/abortSubmission`, "id=01"],
    [`${scope}/abortSubmission`, "id=9007199254740992"],
    [`${scope}/abortSubmission`, "id=1&id=2"],
    [`${scope}/abortSubmission`, "id=1&conversationId=2"],
  ]) {
    const response = await fetch(new URL(path!, base), {
      method: "POST",
      body: new URLSearchParams(body),
    });
    await response.body?.cancel();
    assert.equal(response.status, 400);
  }
  for (const path of [
    `${scope}?withdrawal=bad&id=1`,
    `${scope}?withdrawal=aborted`,
    `${scope}?id=1`,
    `${scope}?aborted=false`,
  ]) {
    const response = await fetch(new URL(path, base));
    await response.body?.cancel();
    assert.equal(response.status, 400);
  }
  for (const [path, method] of routes) {
    const missing = await fetch(new URL(path.replace(app.id, "missing"), base), {
      method,
      ...(method === "POST" ? { body: form({}) } : {}),
    });
    await missing.body?.cancel();
    assert.equal(missing.status, 404);
  }
  const foreign = await fetch(new URL(`${session}/resume`, base), {
    method: "POST",
    body: form({}),
    headers: { origin: "https://foreign.invalid" },
  });
  await foreign.body?.cancel();
  assert.equal(foreign.status, 403);
  assert.equal((await app.harness.inspect(context)).scheduling, "paused");
  assert.equal((await sessions.list()).length, 1);
});

await test(
  "disconnecting a watch leaves a running tool and its subsequent model turn alive",
  { timeout: 10000 },
  async (t) => {
    const { sessions, auth, selection, faux, directory } = await sessionsFixture(t);
    const base = await servePrefixed(t, sessions, auth, "/pds");
    const app = await sessions.open();
    const conversation = await app.root(form(selection));
    const started = Promise.withResolvers<void>();
    const watcher = watch(directory, (_event, name) => {
      if (name === "started") started.resolve();
    });
    try {
      faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall("bash", {
            command: "touch started; while ! test -e release; do sleep 0.01; done; touch completed",
          }),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("Tool completed after observer disconnected"),
      ]);
      const submitted = await app.submit(conversation, form({ message: "Run the tool" }));
      await started.promise;
      const stream = await fetch(new URL(`api/s/${app.id}/c/${conversation.id}/watch`, base));
      assert.equal(stream.status, 200);
      const reader = stream.body!.getReader();
      assert.equal((await reader.read()).done, false);
      await reader.cancel();
      assert(
        (await app.harness.inspect(context)).tasks.every(({ record }) => !record.abortRequested),
      );
      await writeFile(join(directory, "release"), "");
      await conversation.waitForIdle(context);
      await access(join(directory, "completed"));
      const receipt = await app.harness.submission(submitted, context);
      assert.equal((await receipt?.status(context))?.status, "done");
      assert.equal(faux.state.callCount, 2);
    } finally {
      watcher.close();
      await writeFile(join(directory, "release"), "");
    }
  },
);

await test(
  "losing the abort response does not cancel native abort completion",
  { timeout: 10000 },
  async (t) => {
    const started = Promise.withResolvers<void>();
    const signalled = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    t.after(() => finish.resolve());
    const { sessions, auth, selection, faux } = await sessionsFixture(t);
    const base = await servePrefixed(t, sessions, auth, "/pds");
    const app = await sessions.open();
    const conversation = await app.root(form(selection));
    faux.setResponses([
      async (_messages, options) => {
        assert(options?.signal);
        options.signal.addEventListener("abort", () => signalled.resolve(), { once: true });
        started.resolve();
        await finish.promise;
        return fauxAssistantMessage("Released after disconnection");
      },
    ]);
    const submission = await app.submit(conversation, form({ message: "Running" }));
    await started.promise;
    const disconnected = new AbortController();
    const failure = assert.rejects(
      fetch(new URL(`api/s/${app.id}/c/${conversation.id}/abort`, base), {
        method: "POST",
        body: form({}),
        signal: disconnected.signal,
      }),
      { name: "AbortError" },
    );
    await signalled.promise;
    disconnected.abort();
    await failure;
    finish.resolve();
    await conversation.waitForIdle(context);
    const receipt = await app.harness.submission(submission, context);
    assert.equal((await receipt?.status(context))?.reason, "aborted");
    assert.deepEqual((await app.harness.inspect(context)).tasks, []);
  },
);
