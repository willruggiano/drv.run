import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import type * as D from "@earendil-works/pi-durable";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { ROOT_CONVERSATION_ID, InboxDoc } from "@earendil-works/pi-durable";
import { context } from "../src/application.ts";
import { SessionId, decode } from "../src/identity.ts";
import { serve } from "../src/server.ts";
import { sessionsFixture, form } from "./fixtures.ts";

await test("all input paths retain native request IDs, entry metadata and idle rejection", async (t) => {
  for (const action of ["home", "submit", "composer"]) {
    await t.test(action, async (subtest) => {
      const { sessions, auth, selection, faux } = await sessionsFixture(subtest);
      const server = await serve(sessions, { auth, port: 0 });
      subtest.after(() => server.close());
      const app = await sessions.open(decode(SessionId, "admission"));
      const conversation = await app.root(form(selection));
      const path = action === "home" ? "/" : `/api/s/${app.id}/c/${conversation.id}/${action}`;
      const send = (fields: Record<string, string>) =>
        fetch(`${server.origin}${path}`, {
          method: "POST",
          body: form({
            ...(action === "home" ? { ...selection, sessionId: app.id } : {}),
            message: "Hello",
            ...fields,
          }),
          redirect: "manual",
        });
      const rejected = await send({ requestId: "idle", whenIdle: "reject" });
      await rejected.body?.cancel();
      assert.equal(rejected.status, 409);
      assert.equal(
        await app.harness.commit((tx) => tx.submissionByRequest(conversation.id, "idle"), context),
        undefined,
      );
      faux.setResponses([fauxAssistantMessage("Answer")]);
      const entry = { kind: "example.input", data: { author: "owner", tags: [1, null, true] } };
      const accepted = await send({
        requestId: "first",
        whenBusy: "steer",
        entry: JSON.stringify(entry),
      });
      await accepted.body?.cancel();
      assert.equal(accepted.status, 303);
      const record = await app.harness.commit(
        (tx) => tx.submissionByRequest(conversation.id, "first"),
        context,
      );
      assert(record && record.type === "input");
      await conversation.waitForIdle(context);
      const placed = (await conversation.entries({ order: "ascending" }, 50, undefined, context))
        .items[0];
      assert.equal(placed?.kind, entry.kind);
      assert.deepEqual(placed?.data, entry.data);
      const retried = await send({
        requestId: "first",
        message: "Different content",
        whenIdle: "reject",
      });
      await retried.body?.cancel();
      assert.equal(retried.status, 303);
      assert.equal((await app.list()).length, 1);
      assert.equal(faux.state.callCount, 1);
      assert.equal(conversation.id, ROOT_CONVERSATION_ID);
      assert.equal(
        (
          await app.harness.commit(
            (tx) => tx.submissionByRequest(conversation.id, "first"),
            context,
          )
        )?.id,
        record.id,
      );
    });
  }
});

await test("receipt reads preserve scope, absence and paused scheduling", async (t) => {
  const { sessions, auth, selection } = await sessionsFixture(t);
  const server = await serve(sessions, { auth, port: 0 });
  t.after(() => server.close());
  const app = await sessions.open(decode(SessionId, "read receipts"));
  const first = await app.root(form(selection));
  const other = await app.createConversation(form(selection));
  const record = await app.harness.commit(
    (tx) =>
      tx.createSubmission({
        type: "input",
        conversationId: first.id,
        requestId: "pending",
        status: "queued",
      }),
    context,
  );
  const base = `/api/s/${encodeURIComponent(app.id)}/c`;
  for (const path of [
    `${base}/${first.id}/submissionByRequest?requestId=pending`,
    `${base}/${first.id}/submissions/status?id=${record.id}`,
    `${base}/${other.id}/submissionByRequest?requestId=pending`,
    `${base}/${other.id}/submissions/status?id=${record.id}`,
    `${base}/${first.id}/submissionByRequest?requestId=missing`,
    `${base}/${first.id}/submissions/status?id=999999`,
  ]) {
    const response = await fetch(`${server.origin}${path}`);
    await response.body?.cancel();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  for (const query of ["id=-1", "id=01", "id=1&id=2", "id=9007199254740992", "id=1&other=x"]) {
    const response = await fetch(`${server.origin}${base}/${first.id}/submissions/status?${query}`);
    await response.body?.cancel();
    assert.equal(response.status, 400);
  }
  assert.equal((await app.harness.inspect(context)).scheduling, "paused");
  assert.deepEqual(await app.harness.commit((tx) => tx.submission(record.id), context), record);
});

await test("busy options and omitted defaults reach native admission on every input path", async (t) => {
  for (const action of ["home", "submit", "composer"])
    await t.test(action, { timeout: 10000 }, async (subtest) => {
      const started = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      subtest.after(() => finish.resolve());
      const { sessions, auth, selection, faux } = await sessionsFixture(subtest);
      const server = await serve(sessions, { auth, port: 0 });
      subtest.after(() => server.close());
      const app = await sessions.open(decode(SessionId, "busy"));
      const conversation = await app.root(form(selection));
      faux.setResponses([
        async () => {
          started.resolve();
          await finish.promise;
          return fauxAssistantMessage("Finished");
        },
      ]);
      const path = action === "home" ? "/" : `/api/s/${app.id}/c/${conversation.id}/${action}`;
      const send = async (fields: Record<string, string>) => {
        const response = await fetch(`${server.origin}${path}`, {
          method: "POST",
          body: form({
            ...(action === "home" ? { ...selection, sessionId: app.id } : {}),
            message: "Input",
            ...fields,
          }),
          redirect: "manual",
        });
        await response.body?.cancel();
        return response;
      };
      assert.equal((await send({ requestId: "running" })).status, 303);
      await started.promise;
      assert.equal((await send({ requestId: "refused", whenBusy: "reject" })).status, 409);
      assert.equal(
        await app.harness.commit(
          (tx) => tx.submissionByRequest(conversation.id, "refused"),
          context,
        ),
        undefined,
      );
      for (const [key, values] of [
        ["default", {}],
        ["follow", { whenBusy: "followUp" }],
        ["steer", { whenBusy: "steer", whenIdle: "reject" }],
      ] satisfies [string, Record<string, string>][]) {
        assert.equal((await send({ requestId: key, ...values })).status, 303);
      }
      const inbox = await app.harness.snapshot(InboxDoc, conversation.id, context);
      assert.deepEqual(
        inbox?.items.map((item) => item.mode),
        ["followUp", "followUp", "steer"],
      );
      assert.equal((await send({})).status, 303);
      assert.equal((await send({})).status, 303);
      const records = await app.harness.inspect(context);
      assert.equal(
        records.submissions.filter((record) => record.requestId === undefined).length,
        2,
      );
      finish.resolve();
      await conversation.abort(context);
    });
});

await test("home validation precedes allocation; native idle rejection after creation is a separate boundary", async (t) => {
  const { sessions, auth, selection } = await sessionsFixture(t);
  const server = await serve(sessions, { auth, port: 0 });
  t.after(() => server.close());
  for (const fields of [
    { entry: JSON.stringify({ kind: "pi.user" }) },
    { entry: JSON.stringify({ kind: "" }) },
    { entry: JSON.stringify({ kind: "custom", unknown: true }) },
    { entry: "{" },
    { entry: JSON.stringify({ kind: "custom", data: "x".repeat(65536) }) },
    { requestId: "" },
    { whenBusy: "invalid" },
    { whenIdle: "invalid" },
    { model: "not-available" },
  ]) {
    const response = await fetch(server.origin, {
      method: "POST",
      body: form({ ...selection, message: "Invalid", ...fields }),
    });
    await response.body?.cancel();
    assert.equal(response.status, 200);
    assert.deepEqual(await sessions.list(), []);
  }
  const rejected = await fetch(server.origin, {
    method: "POST",
    body: form({
      ...selection,
      sessionId: "retained",
      message: "Idle",
      requestId: "idle",
      whenIdle: "reject",
    }),
  });
  await rejected.body?.cancel();
  assert.equal(rejected.status, 409);
  const app = await sessions.get(decode(SessionId, "retained"));
  assert(app);
  assert.equal((await app.list()).length, 1);
  assert.equal(
    await app.harness.commit((tx) => tx.submissionByRequest(ROOT_CONVERSATION_ID, "idle"), context),
    undefined,
  );
});

await test(
  "the body limit rejects a chunked upload before its body ends",
  { timeout: 10_000 },
  async (t) => {
    const { request } = await import("node:http");
    const { sessions, auth } = await sessionsFixture(t);
    const server = await serve(sessions, { auth, port: 0 });
    t.after(() => server.close());
    const result = Promise.withResolvers<number | undefined>();
    const upload = request(
      server.origin,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Transfer-Encoding": "chunked",
        },
      },
      (response) => {
        result.resolve(response.statusCode);
        response.resume();
      },
    );
    upload.on("error", result.reject);
    t.after(() => upload.destroy());
    const chunk = Buffer.alloc(64 * 1024, "x");
    for (let index = 0; index < 512; index++) if (!upload.write(chunk)) await once(upload, "drain");
    upload.write("x");
    // Deliberately leave the request open. A complete-body check would hang here.
    assert.equal(await result.promise, 413);
    assert.equal(upload.writableEnded, false);
    assert.deepEqual(await sessions.list(), []);
  },
);

await test("home cannot append to a different configuration; same-key retry and restart retain the receipt", async (t) => {
  const { sessions, auth, selection, faux, open } = await sessionsFixture(t);
  const server = await serve(sessions, { auth, port: 0 });
  t.after(() => server.close());
  const send = (values: Record<string, string>) =>
    fetch(server.origin, {
      method: "POST",
      body: form({ ...selection, sessionId: "stable", message: "New session", ...values }),
      redirect: "manual",
    });
  faux.setResponses([fauxAssistantMessage("Original input")]);
  const response = await send({ requestId: "same" });
  await response.body?.cancel();
  assert.equal(response.status, 303);
  const app = await sessions.get(decode(SessionId, "stable"));
  assert(app);
  const conversation = await app.conversation(ROOT_CONVERSATION_ID);
  assert(conversation);
  await conversation.waitForIdle(context);
  const receipt = await app.harness.commit(
    (tx) => tx.submissionByRequest(conversation.id, "same"),
    context,
  );
  assert(receipt);
  const metadata = await app.list();
  const entries = await conversation.entries({ order: "ascending" }, 50, undefined, context);
  for (const changed of [
    { env: "ssh:another" },
    { model: "faux/second" },
    { cwd: "/different" },
    { thinking: "high" },
  ]) {
    const rejected = await send({ ...changed, requestId: "new" });
    await rejected.body?.cancel();
    assert.equal(rejected.status, 200);
    assert.equal(
      await app.harness.commit(
        (tx): Promise<D.SubmissionRecord | undefined> =>
          tx.submissionByRequest(conversation.id, "new"),
        context,
      ),
      undefined,
    );
  }
  const retry = await send({
    requestId: "same",
    message: "This must not rename or append",
    whenIdle: "reject",
  });
  await retry.body?.cancel();
  assert.equal(retry.status, 303);
  assert.deepEqual(await app.list(), metadata);
  assert.deepEqual(
    await conversation.entries({ order: "ascending" }, 50, undefined, context),
    entries,
  );
  await sessions.close();
  const reopened = await open();
  const owner = await reopened.get(app.id);
  assert(owner);
  assert.deepEqual(
    await owner.harness.commit((tx) => tx.submissionByRequest(conversation.id, "same"), context),
    receipt,
  );
  const current = await owner.conversation(conversation.id);
  assert(current);
  assert.equal(
    await owner.submit(current, form({ message: "Different valid content", requestId: "same" })),
    receipt.id,
  );
  assert.equal(faux.state.callCount, 1);
});

await test("input forms reject unsupported content and request shapes without native admissions", async (t) => {
  const { sessions, auth, selection } = await sessionsFixture(t);
  const server = await serve(sessions, { auth, port: 0 });
  t.after(() => server.close());
  const app = await sessions.open(decode(SessionId, "invalid"));
  const conversation = await app.root(form(selection));
  for (const action of ["home", "submit", "composer"]) {
    const path = action === "home" ? "/" : `/api/s/${app.id}/c/${conversation.id}/${action}`;
    for (const fields of [{ type: "write" }, { type: "continue" }, { model: "faux/first" }]) {
      if (action === "home" && "model" in fields) continue;
      const response = await fetch(`${server.origin}${path}`, {
        method: "POST",
        body: form({ ...(action === "home" ? selection : {}), message: "No", ...fields }),
      });
      await response.body?.cancel();
      assert.equal(response.status, 400);
    }
    for (const bytes of [
      new Uint8Array([255]),
      new Uint8Array([0]),
      new Uint8Array([1]),
      new Uint8Array([127]),
    ]) {
      const input = form({
        ...(action === "home" ? selection : {}),
        message: "Invalid file",
        requestId: "rejected",
      });
      input.append("attachments", new File([bytes], "binary"));
      const response = await fetch(`${server.origin}${path}`, { method: "POST", body: input });
      await response.body?.cancel();
      assert.equal(response.status, 200);
      assert.deepEqual(await sessions.list(), [{ id: app.id, status: "open" }]);
    }
  }
  assert.equal((await app.harness.inspect(context)).scheduling, "paused");
  assert.deepEqual(
    (await conversation.entries({ order: "ascending" }, 50, undefined, context)).items,
    [],
  );
  assert.equal(
    await app.harness.commit((tx) => tx.submissionByRequest(conversation.id, "rejected"), context),
    undefined,
  );
});

await test("receipt boundaries reject write methods, origins, query envelopes and typed storage read errors", async (t) => {
  const { StorageRequestError } = await import("@earendil-works/pi-durable");
  const { request } = await import("node:http");
  const { sessions, auth, selection } = await sessionsFixture(t);
  const server = await serve(sessions, { auth, port: 0 });
  t.after(() => server.close());
  const app = await sessions.open(decode(SessionId, "boundaries"));
  const conversation = await app.root(form(selection));
  const base = `${server.origin}/api/s/${app.id}/c/${conversation.id}`;
  const lookup = `${base}/submissionByRequest?requestId=request`;
  const wrongMethod = await fetch(lookup, { method: "POST", body: form({}) });
  await wrongMethod.body?.cancel();
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "GET");
  const foreign = await fetch(`${base}/submit`, {
    method: "POST",
    body: form({ message: "No", requestId: "foreign" }),
    headers: { Origin: "https://foreign.invalid" },
  });
  await foreign.body?.cancel();
  assert.equal(foreign.status, 403);
  const envelope = new URLSearchParams({ datastar: JSON.stringify({ requestId: "request" }) });
  const response = await fetch(`${base}/submissionByRequest?${envelope}`, {
    headers: { "Datastar-Request": "true" },
  });
  await response.body?.cancel();
  assert.equal(response.status, 400);
  const result = Promise.withResolvers<number | undefined>();
  const body = request(
    lookup,
    { method: "GET", headers: { "Content-Length": "1" } },
    (incoming) => {
      result.resolve(incoming.statusCode);
      incoming.resume();
    },
  );
  body.on("error", result.reject);
  body.end("x");
  t.after(() => body.destroy());
  assert.equal(await result.promise, 400);
  for (const operation of ["commit", "submission"] as const) {
    for (const [error, status] of [
      [new StorageRequestError("rejected read"), 400],
      [new TypeError("not a known read error"), 500],
    ] as const) {
      const failure = t.mock.method(app.harness, operation, async () => {
        throw error;
      });
      try {
        const failed = await fetch(
          operation === "commit" ? lookup : `${base}/submissions/status?id=1`,
        );
        await failed.body?.cancel();
        assert.equal(failed.status, status);
        assert.equal(failed.headers.get("cache-control"), "no-store");
      } finally {
        failure.mock.restore();
      }
    }
  }
  assert.equal((await app.harness.inspect(context)).scheduling, "paused");
  assert.equal(
    await app.harness.commit((tx) => tx.submissionByRequest(conversation.id, "foreign"), context),
    undefined,
  );
});

await test("concurrent home retries share the root and receipt, not a global request-ID namespace", async (t) => {
  const { sessions, auth, selection, faux } = await sessionsFixture(t);
  const server = await serve(sessions, { auth, port: 0 });
  t.after(() => server.close());
  faux.setResponses([fauxAssistantMessage("One admission")]);
  const replies = await Promise.all(
    ["first", "second"].map((message) =>
      fetch(server.origin, {
        method: "POST",
        body: form({ ...selection, sessionId: "concurrent", message, requestId: "shared" }),
        redirect: "manual",
      }),
    ),
  );
  for (const response of replies) {
    await response.body?.cancel();
    assert.equal(response.status, 303);
  }
  assert.equal(replies[0]?.headers.get("location"), replies[1]?.headers.get("location"));
  const app = await sessions.get(decode(SessionId, "concurrent"));
  assert(app);
  const conversation = await app.conversation(ROOT_CONVERSATION_ID);
  assert(conversation);
  await conversation.waitForIdle(context);
  assert.equal((await app.list()).length, 1);
  assert.equal(faux.state.callCount, 1);
  assert.equal(
    (await conversation.context(context)).messages.filter((message) => message.role === "user")
      .length,
    1,
  );
  const first = await app.harness.commit(
    (tx) => tx.submissionByRequest(conversation.id, "shared"),
    context,
  );
  assert(first);
  const other = await app.createConversation(form(selection));
  faux.setResponses([fauxAssistantMessage("Different scope")]);
  const response = await fetch(`${server.origin}/api/s/${app.id}/c/${other.id}/submit`, {
    method: "POST",
    body: form({ message: "Another conversation", requestId: "shared" }),
    redirect: "manual",
  });
  await response.body?.cancel();
  assert.equal(response.status, 303);
  await other.waitForIdle(context);
  const second = await app.harness.commit(
    (tx) => tx.submissionByRequest(other.id, "shared"),
    context,
  );
  assert(second);
  assert.notEqual(second.id, first.id);
  assert.equal(faux.state.callCount, 2);
});

await test("model validation reads the configuration at the native admission boundary", async (t) => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  const { InvalidForm } = await import("../src/application.ts");
  const { sessions, models, selection } = await sessionsFixture(t);
  const app = await sessions.open();
  const conversation = await app.root(form(selection));
  const available = await models.getAvailable();
  t.mock.method(models, "getAvailable", async () => {
    entered.resolve();
    await release.promise;
    return available;
  });
  const input = form({ message: "Image", requestId: "configuration-race" });
  input.append(
    "attachments",
    new File([new Uint8Array([1, 2, 3])], "image.png", { type: "image/png" }),
  );
  const rejected = assert.rejects(
    app.submit(conversation, input),
    (error: unknown) => error instanceof InvalidForm && error.issue.kind === "image-model",
  );
  await entered.promise;
  await app.configure(conversation, form({ model: "faux/second" }));
  release.resolve();
  await rejected;
  assert.equal((await conversation.agent(context)).model?.modelId, "second");
  assert.equal((await app.harness.inspect(context)).scheduling, "paused");
  assert.equal(
    await app.harness.commit(
      (tx) => tx.submissionByRequest(conversation.id, "configuration-race"),
      context,
    ),
    undefined,
  );
  assert.deepEqual(
    (await conversation.entries({ order: "ascending" }, 50, undefined, context)).items,
    [],
  );
});
