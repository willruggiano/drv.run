import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { copyJson } from "@earendil-works/chord";
import { test } from "node:test";
import { ElmProjection, conversationFrames } from "../stream.ts";
import { benchmarkFixture } from "../../benchmark.ts";
import { fixture, readHistory, model } from "../../tests/sessions-testing.ts";
import {
  serve,
  directoryFixture,
  authorizationFixture,
  post,
  modelKey,
  targetKey,
} from "../../tests/testing.ts";
import { GlobalSettingsStore } from "../../server.ts";
import { inputContent, FormError } from "../../forms.ts";
import { sessionInfo } from "../../sessions.ts";
import { conversationURL } from "../../presentation.ts";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { LiveDoc } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";

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
  const url = base + conversationURL(session) + "/command";
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
  const catalog = await fetch(base + "/?data=1");
  const data = await catalog.json();
  assert.equal(data.sessions[0].path, `/sessions/${session.id}`);
  assert.equal(data.sessions[0].title, "Untitled session");
});

await test("Elm receipts acknowledge admission without mutating state or exposing other conversations", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const other = await f.create();
  const base = await serve(t, f.sessions);
  const url = (id: string) =>
    base + conversationURL(session) + "/receipt?requestId=" + encodeURIComponent(id);
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
      await fetch(base + conversationURL(other, undefined) + "/receipt?requestId=stable-id")
    ).json(),
    { accepted: false },
  );
  assert.deepEqual(await readHistory(session.root), records);
  assert.equal(commits, 0);
});

await test("attachments decode text, retain images and preserve file metadata", async () => {
  const data = new FormData();
  const files = [
    new File(["# Markdown\n"], "notes.md", { type: "text/markdown" }),
    new File(['{"ok":true}'], "data.json", { type: "application/json" }),
    new File(["λ\r\n"], "unknown", { type: "application/octet-stream" }),
    new File([], "empty.txt"),
    new File([new Uint8Array([0, 255, 1])], "image.png", { type: "image/png" }),
  ];
  for (const file of files) data.append("files", file);
  assert.deepEqual(await inputContent(data), {
    content: [
      { type: "text", text: "" },
      { type: "text", text: 'File: "notes.md"\n\n# Markdown\n' },
      { type: "text", text: 'File: "data.json"\n\n{"ok":true}' },
      { type: "text", text: 'File: "unknown"\n\nλ\r\n' },
      { type: "text", text: 'File: "empty.txt"\n\n' },
      { type: "image", mimeType: "image/png", data: "AP8B" },
    ],
    entry: {
      kind: "app.attachments",
      data: {
        attachments: files.map((file, index) => ({
          name: file.name,
          mimeType: file.type,
          size: file.size,
          block: index + 1,
        })),
      },
    },
  });
  assert.equal(await inputContent(new FormData()), undefined);
  const text = new FormData();
  text.set("content", "Plain message");
  assert.deepEqual(await inputContent(text), { content: "Plain message" });
});

await test("Elm rejects malformed and binary attachments without admitting inputs", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const base = await serve(t, f.sessions);
  for (const file of [
    "not a file",
    new File([new Uint8Array([0xff])], "invalid.txt", { type: "text/plain" }),
    new File([new Uint8Array([0])], "binary.json", { type: "application/json" }),
  ]) {
    const data = new FormData();
    for (const [key, value] of Object.entries({
      command: "submit",
      requestId: "invalid-file",
      revision: "draft",
      content: "No effect",
      whenBusy: "reject",
    }))
      data.set(key, value);
    data.append("files", new File(["Valid text"], "valid.txt"));
    data.append("files", file);
    await assert.rejects(
      inputContent(data),
      (error) => error instanceof FormError && error.status === 400,
    );
    assert.equal(
      (
        await fetch(base + conversationURL(session) + "/command", {
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

await test("Elm persists attachment entries on creation and submission without count or size limits", async (t) => {
  for (const creating of [false, true])
    await t.test(creating ? "creation" : "conversation", async (t) => {
      const f = await fixture(t);
      const id = randomUUID();
      const session = creating ? undefined : await f.create();
      const base = await serve(t, f.sessions);
      const url = creating ? base + "/" : base + conversationURL(session!) + "/command";
      const data = new FormData();
      for (const [key, value] of Object.entries(
        creating
          ? {
              id,
              requestId: "files",
              target: targetKey(f.binding),
              model: modelKey(model),
            }
          : {
              command: "submit",
              requestId: "files",
              revision: "draft",
              whenBusy: "reject",
            },
      ))
        data.set(key, value);
      // Cross both the old attachment limit and the old HTTP body limit.
      const text = "x".repeat(8 * 1024 * 1024 + 1);
      data.append("files", new Blob([text], { type: "text/markdown" }), "notes.md");
      for (let index = 0; index < 5; index++)
        data.append(
          "files",
          new Blob(['{"ok":true}'], { type: "application/json" }),
          `data${index}.json`,
        );
      f.faux.setResponses([fauxAssistantMessage("Received")]);
      const send = () => fetch(url, { method: "POST", headers: { Origin: base }, body: data });
      assert.equal((await send()).status, 200);
      const current = session ?? (await f.sessions.get(id));
      await current.root.waitForIdle(BACKGROUND_CONTEXT);
      const records = await readHistory(current.root);
      const entry = records.find((entry) => entry.kind === "app.attachments");
      assert(entry);
      assert.deepEqual(entry.data, {
        attachments: [
          { name: "notes.md", mimeType: "text/markdown", size: Buffer.byteLength(text), block: 1 },
          ...Array.from({ length: 5 }, (_, index) => ({
            name: `data${index}.json`,
            mimeType: "application/json",
            size: 11,
            block: index + 2,
          })),
        ],
      });
      const message = entry.model?.[0];
      assert(message?.role === "user" && Array.isArray(message.content));
      assert.equal(message.content.length, 7);
      assert.deepEqual(message.content[1], { type: "text", text: `File: "notes.md"\n\n${text}` });
      assert.equal((await send()).status, 200);
      assert.deepEqual(await readHistory(current.root), records);
      assert.equal(f.faux.state.callCount, 1);
      await f.reopen();
      const reopened = await f.sessions.get(current.id);
      assert.deepEqual(await readHistory(reopened.root), records);
    });
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
      const response = fetch(`http://127.0.0.1:${address.port}${conversationURL(session)}/events`, {
        signal: abort.signal,
      });
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

await test("Elm session settings validate and persist form data", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const base = await serve(t, f.sessions);
  const path = base + conversationURL(session);
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

await test("selection routes do not open unrelated sessions and share choice projections", async (t) => {
  const f = await directoryFixture(t);
  const session = await f.sessions.create(randomUUID(), f.binding, model);
  const unrelated = await f.create();
  await mkdir(join(f.workspace, "nested"));
  const attached: string[] = [];
  await f.reopen({
    ...f.execution,
    onSession: (session) => {
      attached.push(session.id);
    },
  });
  const { authorization } = await authorizationFixture(t);
  const store = new GlobalSettingsStore();
  const base = await serve(t, f.sessions, undefined, "127.0.0.1", store, undefined, authorization);
  const global = await (await fetch(base + "/settings?data=1")).json();
  assert.deepEqual(attached, []);
  assert.equal(f.sessions.opened.size, 0);
  const query = new URLSearchParams({ target: targetKey(f.binding), directory: "n" });
  assert.deepEqual(await (await fetch(`${base}/directories?${query}`)).json(), ["nested/"]);
  assert.deepEqual(attached, []);
  const path = base + conversationURL(session);
  const panel = await (await fetch(path + "/panel?view=settings")).json();
  assert.deepEqual(panel.models, global.models);
  assert.deepEqual(panel.targets, global.targets);
  assert.deepEqual(attached, [session.id]);
  assert.deepEqual(await (await fetch(`${path}/directories?${query}`)).json(), ["nested/"]);
  const selected = {
    model: modelKey(model),
    target: targetKey(f.binding),
    thinkingLevel: "max",
    baseDirectory: "nested",
  };
  assert.equal((await post(path + "/settings", { ...selected, name: "Selected" })).status, 200);
  const created = randomUUID();
  assert.equal((await post(base + "/", { ...selected, id: created })).status, 200);
  for (const id of [session.id, created]) {
    const current = await f.sessions.get(id);
    const info = await sessionInfo(current);
    assert.equal(info.cwd, join(f.workspace, "nested"));
    assert.equal(info.thinkingLevel, "high");
  }
  assert.deepEqual(attached, [session.id, created]);
  assert.equal(f.sessions.opened.has(unrelated.id), false);
  assert.equal(f.faux.state.callCount, 0);
});

await test("editing retains unavailable choices but creation cannot select them", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  await f.reopen({ targets: async () => [] });
  t.mock.method(f.options.models, "getAvailable", async () => []);
  const current = await f.sessions.get(session.id);
  const before = await sessionInfo(current);
  const base = await serve(t, f.sessions);
  const path = base + conversationURL(current);
  const panel = await (await fetch(path + "/panel?view=settings")).json();
  assert.equal(panel.model, modelKey(model));
  assert.equal(panel.target, targetKey(f.binding));
  assert.equal(panel.models[0].key, panel.model);
  assert.equal(panel.targets[0].key, panel.target);
  assert.equal(panel.targets[0].disabled, false);
  const selected = {
    model: modelKey(model),
    target: targetKey(f.binding),
    thinkingLevel: "",
    baseDirectory: "",
  };
  assert.equal((await post(path + "/settings", { ...selected, name: "Retained" })).status, 200);
  assert.deepEqual(await sessionInfo(current), { ...before, name: "Retained" });
  assert.equal(
    (await post(path + "/settings", { ...selected, name: "Invalid", baseDirectory: "other" }))
      .status,
    409,
  );
  assert.equal((await post(base + "/", { ...selected, id: randomUUID() })).status, 409);
  assert.deepEqual(await sessionInfo(current), { ...before, name: "Retained" });
  assert.equal(f.sessions.opened.size, 1);
});

await test(
  "conversation frames retain commits across initialization and resets, including sibling trees",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const session = await f.create();
    const context = BACKGROUND_CONTEXT;
    const first = await session.root.commit(
      (tx) =>
        tx.appendEntry(session.root.id, {
          kind: "pi.user",
          model: [{ role: "user", content: "First", timestamp: 1 }],
        }),
      context,
    );
    const acquired = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    t.after(() => release.resolve());
    const entries = session.root.entries.bind(session.root);
    const read = t.mock.method(
      session.root,
      "entries",
      async (...args: Parameters<typeof entries>) => {
        const page = await entries(...args);
        acquired.resolve();
        await release.promise;
        return page;
      },
    );
    const frames = conversationFrames(session, session.root, context, { pane: "tree" });
    t.after(() => frames.return());
    const initial = frames.next();
    await acquired.promise;
    const during = await session.root.commit(async (tx) => {
      const entry = await tx.appendEntry(session.root.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "During initialization", timestamp: 2 }],
      });
      const reset = await tx.appendEntry(session.root.id, { kind: "pi.reset", head: "self" });
      return [entry.id, reset.id];
    }, context);
    release.resolve();
    const snapshot = await initial;
    assert(!snapshot.done);
    assert.equal(snapshot.value.snapshot, true);
    assert.equal(snapshot.value.sequence, 1);
    assert.deepEqual(
      snapshot.value.entries.map((entry) => entry.id),
      [first.id, ...during],
    );
    assert.deepEqual(
      snapshot.value.metadata?.explorer?.nodes.map((node) => node.id),
      [first.id, ...during],
    );
    assert.equal(read.mock.callCount(), 1);
    read.mock.restore();
    const fork = await session.root.fork(first.id, { ownership: { kind: "ownerless" } }, context);
    const sibling = await fork.commit(
      (tx) =>
        tx.appendEntry(fork.id, { kind: "pi.assistant", model: [fauxAssistantMessage("Sibling")] }),
      context,
    );
    const changed = await frames.next();
    assert(!changed.done);
    assert.equal(changed.value.subscription, snapshot.value.subscription);
    assert.equal(changed.value.sequence, 2);
    assert.deepEqual(changed.value.entries, []);
    assert.equal(
      changed.value.metadata?.branches.some((branch) => branch.id === fork.id),
      true,
    );
    const node = changed.value.metadata?.explorer?.nodes.find((node) => node.id === sibling.id);
    assert(node);
    assert.equal(node.parent, first.id);
    assert.equal(node.active, false);
  },
);

await test(
  "conversation frames coalesce slow consumption and publish settings-only changes",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const session = await f.create();
    const settings = new GlobalSettingsStore();
    const context = BACKGROUND_CONTEXT;
    const frames = conversationFrames(session, session.root, context, { settings });
    t.after(() => frames.return());
    const first = await frames.next();
    assert(!first.done);
    for (let index = 0; index < 110; index++) {
      await session.root.commit(async (tx) => {
        const { role, api, provider, model, usage, stopReason, timestamp } =
          fauxAssistantMessage("");
        (await tx.doc(LiveDoc, session.root.id)).generation = {
          attempt: 1,
          message: {
            role,
            api,
            provider,
            model,
            usage,
            stopReason,
            timestamp,
            content: [{ type: "text", text: `Partial ${index}` }],
          },
        };
      }, context);
    }
    const latest = await frames.next();
    assert(!latest.done);
    assert.equal(latest.value.sequence, 2);
    assert.deepEqual(latest.value.entries, []);
    assert.deepEqual(latest.value.live?.messages[0].blocks, [
      { kind: "text", text: "Partial 109" },
    ]);
    const waiting = frames.next();
    await settings.update({ values: { hideThinkingBlock: true } }, f.sessions);
    const preference = await waiting;
    assert(!preference.done);
    assert.equal(preference.value.sequence, 3);
    assert.equal(preference.value.metadata?.hideThinking, true);
    assert.equal(preference.value.live, undefined);
    assert.deepEqual(preference.value.entries, []);
  },
);

await test("conversation frame lifetime releases all observers on return, cancellation, close, overflow, and failure", async (t) => {
  for (const end of ["return", "cancel", "close", "overflow", "failure"])
    await t.test(end, { timeout: 10000 }, async (t) => {
      const f = await fixture(t);
      const session = await f.create();
      const settings = new GlobalSettingsStore();
      let commits = 0,
        preferences = 0;
      const subscribe = session.harness.subscribeCommits.bind(session.harness);
      t.mock.method(
        session.harness,
        "subscribeCommits",
        (listener: Parameters<typeof subscribe>[0]) => {
          commits++;
          const release = subscribe(listener);
          return () => {
            commits--;
            release();
          };
        },
      );
      const observe = settings.watch.bind(settings);
      t.mock.method(settings, "watch", (listener: () => void) => {
        preferences++;
        const release = observe(listener);
        return () => {
          preferences--;
          release();
        };
      });
      const watch = session.root.watch.bind(session.root);
      const watches: Awaited<ReturnType<typeof watch>>[] = [];
      t.mock.method(session.root, "watch", async (...args: Parameters<typeof watch>) => {
        const value = await watch(...args);
        watches.push(value);
        return value;
      });
      const abort = new AbortController();
      const frames = conversationFrames(
        session,
        session.root,
        withAbortSignal(abort.signal, BACKGROUND_CONTEXT),
        { settings },
      );
      t.after(async () => {
        abort.abort();
        await frames.return();
      });
      assert.equal((await frames.next()).done, false);
      assert.equal(commits, 1);
      assert.equal(preferences, 1);
      if (end === "return") await frames.return();
      else if (end === "overflow") {
        await session.root.commit(async (tx) => {
          for (let i = 0; i < 1025; i++) await tx.appendEntry(session.root.id, { kind: "message" });
        }, BACKGROUND_CONTEXT);
        await assert.rejects(frames.next(), Error);
      } else if (end === "failure") {
        const error = new Error("Metadata failure");
        t.mock.method(session.root, "agent", async () => {
          throw error;
        });
        const pending = frames.next();
        const rejected = assert.rejects(pending, (actual) => actual === error);
        await settings.update({ values: { hideThinkingBlock: true } }, f.sessions);
        await rejected;
      } else {
        const pending = frames.next();
        if (end === "cancel") abort.abort();
        else await session.harness.close(BACKGROUND_CONTEXT);
        assert.equal((await pending).done, true);
      }
      assert.equal(watches.length, 1);
      await watches[0].closed;
      assert.equal(commits, 0);
      assert.equal(preferences, 0);
      assert.equal(f.faux.state.callCount, 0);
    });
});
