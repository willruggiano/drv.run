import assert from "node:assert/strict";
import { copyJson } from "@earendil-works/chord";
import { test } from "node:test";
import { ElmProjection } from "../frontend.ts";
import { benchmarkFixture } from "../../benchmark.ts";
import { fixture, readHistory } from "../../tests/sessions-testing.ts";
import { serve } from "../../tests/testing.ts";
import { sessionInfo } from "../../sessions.ts";
import { conversationURL } from "../../presentation.ts";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

const metadata = {
  branches: [],
  durations: {},
  title: "Test",
  instance: "",
  model: "",
  thinking: "medium",
  input: "0",
  output: "0",
  read: "0",
  hit: "CH—",
  cost: "0",
  context: "—",
  level: "normal",
  resume: false,
};
await test("Elm projection never retransmits completed history on document-only updates", () => {
  const { view } = benchmarkFixture(200);
  const projection = new ElmProjection();
  const first = projection.project(view, metadata);
  assert(first);
  assert.equal(first.snapshot, true);
  assert.equal(first.entries.length, 600);
  assert.equal(first.tools.length, 200);
  assert.equal(projection.project(view, metadata), undefined);
  const live = {
    ...view,
    docs: {
      "pi.live": {
        generation: {
          attempt: 1,
          message: copyJson(fauxAssistantMessage("streaming"), { omitUndefinedProperties: true }),
        },
      },
    },
  };
  const next = projection.project(live, metadata);
  assert(next);
  assert.equal(next.sequence, 2);
  assert.equal(next.snapshot, false);
  assert.deepEqual(next.entries, []);
  assert.deepEqual(next.tools, []);
  assert.equal(next.live?.messages.length, 1);
});

await test("Elm command boundary enforces origins, methods, identities and durable idempotency", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const base = await serve(t, f.sessions);
  const url = base + conversationURL(session, undefined, "elm") + "/command";
  const fields = {
    command: "submit",
    requestId: "input-1",
    revision: "draft-1",
    content: "Accepted once",
    whenBusy: "reject",
  };
  const post = (origin: string, body: unknown = fields) =>
    fetch(url, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  assert.equal((await post("https://evil.example")).status, 403);
  assert.equal((await fetch(url)).status, 405);
  assert.equal((await post(base, { ...fields, requestId: "" })).status, 400);
  assert.equal((await post(base, { ...fields, whenBusy: "invalid" })).status, 400);
  assert.equal((await post(base, { ...fields, content: "/not-implemented" })).status, 400);
  assert.deepEqual(await readHistory(session.root), []);
  f.faux.setResponses([fauxAssistantMessage("Done")]);
  const first = await post(base);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { requestId: "input-1", revision: "draft-1" });
  await session.root.waitForIdle(BACKGROUND_CONTEXT);
  const records = await readHistory(session.root);
  assert.equal((await post(base)).status, 200);
  assert.deepEqual(await readHistory(session.root), records);
  assert.equal(f.faux.state.callCount, 1);
  assert.equal((await post(base, { ...fields, command: "unknown" })).status, 400);
  const catalog = await fetch(base + "/elm?data=1");
  const data = await catalog.json();
  assert.equal(data.sessions[0].path, `/elm/sessions/${session.id}`);
  assert.equal(data.sessions[0].title, "Untitled session");
});

await test("Elm receipts acknowledge admission without mutating state or exposing other conversations", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const other = await f.create();
  const base = await serve(t, f.sessions);
  const url = (id: string) =>
    base +
    conversationURL(session, undefined, "elm") +
    "/receipt?requestId=" +
    encodeURIComponent(id);
  assert.equal((await fetch(url(""))).status, 400);
  assert.deepEqual(await (await fetch(url("missing"))).json(), { accepted: false });
  f.faux.setResponses([fauxAssistantMessage("Received")]);
  await (
    await session.root.submit(
      { type: "input", content: "Original", requestId: "stable-id" },
      BACKGROUND_CONTEXT,
    )
  ).wait(BACKGROUND_CONTEXT);
  const records = await readHistory(session.root);
  let commits = 0;
  const stop = session.harness.subscribeCommits(() => commits++);
  t.after(stop);
  assert.deepEqual(await (await fetch(url("stable-id"))).json(), { accepted: true });
  assert.deepEqual(
    await (
      await fetch(base + conversationURL(other, undefined, "elm") + "/receipt?requestId=stable-id")
    ).json(),
    { accepted: false },
  );
  assert.deepEqual(await readHistory(session.root), records);
  assert.equal(commits, 0);
});

await test("Elm rejects invalid multipart attachments without admitting inputs", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const base = await serve(t, f.sessions);
  for (const [count, size, type] of [
    [5, 1, "image/png"],
    [1, 5 * 1024 * 1024 + 1, "image/png"],
    [1, 1, "text/plain"],
  ] as const) {
    const data = new FormData();
    for (const [key, value] of Object.entries({
      command: "submit",
      requestId: "invalid-image",
      revision: "draft",
      content: "No effect",
      whenBusy: "reject",
    }))
      data.set(key, value);
    for (let i = 0; i < count; i++)
      data.append("images", new Blob([new Uint8Array(size)], { type }), `file${i}`);
    assert.equal(
      (
        await fetch(base + conversationURL(session, undefined, "elm") + "/command", {
          method: "POST",
          headers: { Origin: base },
          body: data,
        })
      ).status,
      400,
    );
  }
  assert.deepEqual(await readHistory(session.root), []);
});

await test("Elm releases early-disconnected watches and bounds pending entries during initialization", async (t) => {
  for (const stage of ["watch", "history"])
    await t.test(stage, { timeout: 10000 }, async (t) => {
      const f = await fixture(t);
      const session = await f.create();
      const { httpServer } = await import("../../server.ts");
      const server = httpServer(f.sessions, "127.0.0.1");
      const disconnected = Promise.withResolvers<void>();
      server.on("request", (_request, response) =>
        response.once("close", () => disconnected.resolve()),
      );
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert(address && typeof address === "object");
      t.after(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      });
      const acquired = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      t.after(() => release.resolve());
      const watches: Awaited<ReturnType<typeof session.root.watch>>[] = [];
      const watch = session.root.watch.bind(session.root);
      t.mock.method(session.root, "watch", async (...args: Parameters<typeof watch>) => {
        const observer = await watch(...args);
        watches.push(observer);
        if (stage === "watch") {
          acquired.resolve();
          await release.promise;
        }
        return observer;
      });
      if (stage === "history") {
        const entries = session.root.entries.bind(session.root);
        t.mock.method(session.root, "entries", async (...args: Parameters<typeof entries>) => {
          acquired.resolve();
          await release.promise;
          return entries(...args);
        });
      }
      t.mock.method(session.harness, "conversation", async () => session.root);
      const abort = new AbortController();
      const response = fetch(
        `http://127.0.0.1:${address.port}${conversationURL(session, undefined, "elm")}/events`,
        { signal: abort.signal },
      );
      const rejected = assert.rejects(response);
      await acquired.promise;
      if (stage === "watch") abort.abort();
      else
        await session.root.commit(async (tx) => {
          for (let i = 0; i < 1025; i++) await tx.appendEntry(session.root.id, { kind: "message" });
        }, BACKGROUND_CONTEXT);
      await disconnected.promise;
      release.resolve();
      await rejected;
      assert.equal(watches.length, 1);
      await watches[0].closed;
    });
});

await test("Elm session settings use the same validation and persistence as native forms", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const base = await serve(t, f.sessions);
  const path = base + conversationURL(session, undefined, "elm");
  const catalog = await f.sessions.catalog(BACKGROUND_CONTEXT);
  const model = catalog.models[0];
  const target = catalog.targets[0];
  const initial = await sessionInfo(session);
  const values = {
    name: "Edited session",
    model: JSON.stringify([model.provider, model.modelId]),
    target: JSON.stringify([target.provider, target.target]),
    thinkingLevel: "low",
    baseDirectory: "",
  };
  const post = (body: typeof values, origin = base) =>
    fetch(path + "/settings", {
      method: "POST",
      headers: { Origin: origin },
      body: new URLSearchParams(body),
    });
  assert.equal((await post(values, "https://evil.example")).status, 403);
  for (const invalid of [
    { thinkingLevel: "unknown" },
    { name: "Invalid\u0001" },
    { model: "unknown" },
    { target: "unknown" },
  ])
    assert.equal((await post({ ...values, ...invalid })).ok, false);
  assert.deepEqual(await sessionInfo(session), initial);
  assert.deepEqual(await (await post(values)).json(), { saved: true });
  const settings = await (await fetch(path + "/panel?view=settings")).json();
  assert.equal(settings.name, values.name);
  assert.equal(settings.model, values.model);
  assert.equal(settings.target, values.target);
  assert.equal(settings.thinking, "low");
  assert.equal((await session.root.agent(BACKGROUND_CONTEXT)).thinkingLevel, "low");
  assert.deepEqual(await (await fetch(path + "/export")).json(), await readHistory(session.root));
  assert.equal((await fetch(path + "/panel?view=unknown")).status, 400);
  assert.equal((await fetch(path + "/directories?target=unknown")).status, 409);
});
