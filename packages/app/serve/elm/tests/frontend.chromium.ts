import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { InboxDoc, LiveDoc, type TaskId, type Conversation } from "@earendil-works/pi-durable";
import { browserFixture } from "../../tests/browser-testing.ts";
import { fixture, readHistory, waitFor } from "../../tests/sessions-testing.ts";
import { conversationURL } from "../../presentation.ts";
import { rename, type Sessions, type Session } from "../../sessions.ts";
import { httpServer } from "../../server.ts";

const context = BACKGROUND_CONTEXT;

await test(
  "Elm retains completed nodes, drafts and local state across updates and archives",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    const session = await f.create();
    await rename(session, "Elm conversation prototype");
    const records = await session.root.commit(async (tx) => {
      const first = await tx.appendEntry(session.root.id, {
        kind: "pi.user",
        model: [
          {
            role: "user",
            content: "Check the build and explain the result.",
            timestamp: 1700000000000,
          },
        ],
      });
      const second = await tx.appendEntry(session.root.id, {
        kind: "pi.assistant",
        model: [
          fauxAssistantMessage(
            [
              { type: "thinking", thinking: "I’ll run the focused tests first." },
              fauxToolCall("bash", { command: "npm test" }, { id: "build" }),
            ],
            { timestamp: 1700000001000 },
          ),
        ],
      });
      await tx.appendEntry(session.root.id, {
        kind: "pi.tool",
        model: [
          {
            role: "toolResult",
            toolCallId: "build",
            toolName: "bash",
            content: [{ type: "text", text: "12 tests passed.\nNo failures." }],
            isError: false,
            durationMs: 124,
            timestamp: 1700000002000,
          },
        ],
      });
      await tx.appendEntry(session.root.id, {
        kind: "pi.assistant",
        model: [
          fauxAssistantMessage(
            "All **12 tests passed**. The build is ready.\n\n```typescript\nconst ready = true;\n```",
            { timestamp: 1700000003000 },
          ),
        ],
      });
      return { first, second };
    }, context);
    const b = await browserFixture(t, f.sessions);
    const page = b.page;
    page.setDefaultTimeout(10000);
    const path = conversationURL(session);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(b.base + path);
    await page.waitForFunction(
      () => document.querySelector("#connection")?.textContent === "Connected",
    );
    await page.locator('[data-call-id="build"] > summary').click();
    await page.locator("pre code").first().waitFor();
    const node = await page.locator(`#entry-${records.first.id}`).elementHandle();
    assert(node);
    const prompt = page.getByRole("textbox", { name: "Message", exact: true });
    await prompt.fill("Retain this newer draft");
    await session.root.commit(async (tx) => {
      (await tx.doc(LiveDoc, session.root.id)).run = { taskId: 123 as TaskId, inputs: [] };
    }, context);
    await page.waitForFunction(
      () => document.querySelector("#controls")?.getAttribute("data-state") === "working",
    );
    assert.equal(await node.evaluate((node) => node === document.getElementById(node.id)), true);
    const reset = await session.root.commit(
      (tx) => tx.appendEntry(session.root.id, { kind: "pi.reset", head: "self" }),
      context,
    );
    await page.locator(`[data-context="pi.reset"]`).waitFor();
    assert.equal(await node.evaluate((node) => node === document.getElementById(node.id)), true);
    assert.equal(await node.getAttribute("data-archives"), String(reset.id));
    assert.equal(await node.isVisible(), false);
    await page.locator(`[data-context="pi.reset"] summary`).click();
    await page.locator(`#entry-${records.first.id}`).waitFor();
    assert.equal(await node.isVisible(), true);
    assert.equal(await prompt.inputValue(), "Retain this newer draft");
    assert.equal(
      await page
        .locator('[data-call-id="build"]')
        .evaluate((node) => (node as HTMLDetailsElement).open),
      true,
    );
    await page.reload();
    await page.waitForFunction(
      () => document.querySelector("#connection")?.textContent === "Connected",
    );
    assert.equal(await prompt.inputValue(), "Retain this newer draft");
    await prompt.fill("/unknown-command");
    await page.getByRole("button", { name: "Queue", exact: true }).click();
    assert.equal(await prompt.inputValue(), "/unknown-command");
    assert.equal((await readHistory(session.root)).length, 5);
    assert.deepEqual(b.errors, []);
  },
);

await test(
  "Elm timestamp formatting preserves locale, timezone and attribute updates",
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t);
    const session = await f.create();
    const b = await browserFixture(t, f.sessions);
    for (const [locale, timezoneId] of [
      ["en-US", "America/Los_Angeles"],
      ["en-GB", "Europe/London"],
      ["fr-FR", "Asia/Kolkata"],
      ["ar-EG", "Africa/Cairo"],
      ["ja-JP-u-ca-japanese", "Asia/Tokyo"],
    ]) {
      const browserContext = await b.browser.newContext({ locale, timezoneId });
      const page = await browserContext.newPage();
      page.on("pageerror", (error) => b.errors.push(error));
      await page.goto(b.base + conversationURL(session));
      await page.waitForFunction(() => customElements.get("elm-time") !== undefined);
      const results = await page.evaluate(() => {
        const node = document.createElement("elm-time");
        const values = [0, Date.UTC(2024, 2, 10, 9, 59), Date.UTC(2024, 6, 1, 13, 5, 11), NaN];
        node.setAttribute("timestamp", String(values[0]));
        document.body.append(node);
        const results = values.map((value) => {
          node.setAttribute("timestamp", String(value));
          const date = new Date(value);
          return {
            actual: { label: node.textContent, title: node.title },
            expected: {
              label: Number.isFinite(value)
                ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                : "",
              title: Number.isFinite(value) ? date.toLocaleString() : "",
            },
          };
        });
        node.remove();
        node.setAttribute("timestamp", String(values[0]));
        document.body.append(node);
        const reconnected = { label: node.textContent, title: node.title };
        node.remove();
        return { results, reconnected };
      });
      for (const result of results.results)
        assert.deepEqual(result.actual, result.expected, `${locale}, ${timezoneId}`);
      assert.deepEqual(results.reconnected, results.results[0].expected);
      await browserContext.close();
    }
    assert.deepEqual(b.errors, []);
  },
);

await test(
  "Elm sizes drafts on content, mount and width changes, not stream updates",
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t);
    const first = await f.create(),
      second = await f.create();
    await rename(second, "Other conversation");
    const b = await browserFixture(t, f.sessions);
    const page = b.page;
    page.setDefaultTimeout(10000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const path = conversationURL(first, undefined);
    await page.goto(b.base + path);
    await page.waitForFunction(
      () => document.querySelector("#connection")?.textContent === "Connected",
    );
    const prompt = page.locator("#prompt");
    const height = () => prompt.evaluate((node) => node.clientHeight);
    const fits = () =>
      page.waitForFunction(() => {
        const node = document.querySelector<HTMLTextAreaElement>("#prompt");
        return node && node.style.height && node.scrollHeight <= node.clientHeight + 1;
      });
    const draft = "draft ".repeat(30);
    await prompt.fill(draft);
    await fits();
    const wide = await height();
    await page.setViewportSize({ width: 390, height: 844 });
    await fits();
    const narrow = await height();
    assert(narrow > wide);
    await page.setViewportSize({ width: 1440, height: 900 });
    await waitFor(async () => (await height()) === wide);
    // A container can change width without a viewport resize.
    await prompt.evaluate((node) => (node.style.width = "300px"));
    await fits();
    assert((await height()) > wide);
    await prompt.evaluate((node) => node.style.removeProperty("width"));
    await waitFor(async () => (await height()) === wide);

    await prompt.fill("one\ntwo\nthree\nfour");
    await fits();
    const multiline = await height();
    assert(multiline > wide);
    // Initial restoration must not depend on receiving an SSE frame.
    await page.route("**/events", (route) => route.abort());
    await page.reload();
    await waitFor(async () => (await height()) === multiline);
    assert.equal(await prompt.inputValue(), "one\ntwo\nthree\nfour");
    await page.unroute("**/events");
    await page.reload();
    await page.waitForFunction(
      () => document.querySelector("#connection")?.textContent === "Connected",
    );
    await waitFor(async () => (await height()) === multiline);
    const updates = await prompt.evaluateHandle((node) => {
      const state = { writes: 0, text: "" };
      const observer = new MutationObserver((records) => (state.writes += records.length));
      observer.observe(node, { attributes: true, attributeFilter: ["style"] });
      const rendered = () => {
        state.text = document.querySelector("#live .text")?.textContent ?? "";
      };
      document.addEventListener("elm:rendered", rendered);
      return { state, observer, rendered };
    });
    for (let update = 0; update < 3; update++) {
      await first.root.commit(async (tx) => {
        const live = await tx.doc(LiveDoc, first.root.id);
        live.run = { taskId: 1 as TaskId, inputs: [] };
        const message = fauxAssistantMessage("");
        live.generation = {
          attempt: 1,
          message: {
            role: "assistant",
            content: [{ type: "text", text: `Update ${update}` }],
            api: message.api,
            provider: message.provider,
            model: message.model,
            usage: message.usage,
            stopReason: message.stopReason,
            timestamp: message.timestamp,
          },
        };
      }, context);
      await waitFor(
        async () => (await updates.evaluate(({ state }) => state.text)) === `Update ${update}`,
      );
    }
    assert.equal(await updates.evaluate(({ state }) => state.writes), 0);
    assert.equal(await height(), multiline);
    await updates.evaluate(({ observer, rendered }) => {
      observer.disconnect();
      document.removeEventListener("elm:rendered", rendered);
    });
    await updates.dispose();
    await first.root.commit(async (tx) => {
      const live = await tx.doc(LiveDoc, first.root.id);
      delete live.run;
      delete live.generation;
    }, context);
    await page.waitForFunction(
      () => document.querySelector("#controls")?.getAttribute("data-state") === "ready",
    );

    // The dedicated landing is a real history entry; returning restores the draft.
    await page.locator("#conversation-title").click();
    await page.locator("#session-list").waitFor();
    await page.goBack();
    await waitFor(async () => (await height()) === multiline);
    await page.locator("#conversation-title").click();
    await page.locator("#session-list a").filter({ hasText: "Other conversation" }).click();
    await page.waitForURL(b.base + conversationURL(second, undefined));
    await prompt.fill("short");
    await fits();
    assert((await height()) < multiline);
    await page.goBack();
    await page.locator("#landing").waitFor();
    await page.goBack();
    await page.waitForURL(b.base + path);
    await waitFor(async () => (await height()) === multiline);

    // Both reset-composer transitions change text without changing the draft.
    await prompt.fill("/reset one\ntwo\nthree\nfour");
    await fits();
    const commandHeight = await height();
    await page.locator("#send").click();
    await page.getByRole("textbox", { name: "Handoff instructions", exact: true }).waitFor();
    await prompt.fill("short");
    await waitFor(async () => (await height()) < commandHeight);
    await prompt.fill("one\ntwo\nthree\nfour");
    await fits();
    assert.equal(await height(), multiline);
    await page.getByRole("link", { name: "Cancel reset", exact: true }).click();
    await waitFor(async () => (await height()) === commandHeight);
    await prompt.fill("Send and clear");
    f.faux.setResponses([fauxAssistantMessage("Accepted")]);
    await page.locator("#send").click();
    await page.waitForFunction(
      () => document.querySelector<HTMLTextAreaElement>("#prompt")?.value === "",
    );
    await fits();
    assert((await height()) < multiline);
    assert.deepEqual(b.errors, []);
  },
);

await test(
  "Elm submission acknowledgement cannot clear a newer draft; uncertain retry is idempotent",
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t);
    const session = await f.create();
    const b = await browserFixture(t, f.sessions);
    const page = b.page;
    page.setDefaultTimeout(10000);
    const path = conversationURL(session);
    await page.goto(b.base + path);
    await page.waitForFunction(
      () => document.querySelector("#connection")?.textContent === "Connected",
    );
    f.faux.setResponses([fauxAssistantMessage("Accepted once.")]);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let received!: () => void;
    const accepted = new Promise<void>((resolve) => {
      received = resolve;
    });
    await page.route("**/command", async (route) => {
      const response = await route.fetch();
      received();
      await held;
      await route.fulfill({ response });
    });
    await page.locator("#prompt").fill("Original input");
    await page.locator("#send").click();
    await accepted;
    await page.locator("#prompt").fill("Newer input");
    release();
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>("#send")?.disabled);
    assert.equal(await page.locator("#prompt").inputValue(), "Newer input");
    await page.unroute("**/command");
    f.faux.setResponses([fauxAssistantMessage("Second response.")]);
    await page.route("**/command", async (route) => {
      await route.fetch();
      await route.abort("connectionfailed");
    });
    await page.locator("#send").click();
    await page.getByRole("button", { name: "Retry original input" }).waitFor();
    await session.root.waitForIdle(context);
    const before = await readHistory(session.root);
    await page.unroute("**/command");
    await page.reload();
    await page.getByRole("button", { name: "Retry original input" }).click();
    await page.waitForFunction(
      () => document.querySelector<HTMLTextAreaElement>("#prompt")?.value === "",
    );
    assert.deepEqual(await readHistory(session.root), before);
    assert.deepEqual(b.errors, []);
  },
);

await test(
  "Elm navigation, completion dismissal, IME and attachments keep route-local state",
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t);
    const first = await f.create(),
      second = await f.create();
    await rename(first, "First");
    await rename(second, "Second");
    const b = await browserFixture(t, f.sessions);
    const page = b.page;
    page.setDefaultTimeout(10000);
    await page.setViewportSize({ width: 1000, height: 900 });
    await page.goto(b.base + conversationURL(first, undefined));
    await page.waitForFunction(
      () => document.querySelector("#connection")?.textContent === "Connected",
    );
    await page.locator("#prompt").fill("First draft");
    await page.locator("#conversation-title").click();
    await page.locator("#session-list a").filter({ hasText: "Second" }).click();
    await page.waitForURL(b.base + conversationURL(second, undefined));
    await page.locator("#prompt").fill("Second draft");
    await page.goBack();
    await page.locator("#landing").waitFor();
    await page.goBack();
    await page.waitForFunction(
      () => document.querySelector<HTMLTextAreaElement>("#prompt")?.value === "First draft",
    );
    await page.goForward();
    await page.locator("#landing").waitFor();
    await page.goForward();
    await page.waitForFunction(
      () => document.querySelector<HTMLTextAreaElement>("#prompt")?.value === "Second draft",
    );
    await page.locator("#prompt").fill("/res");
    await page.locator('#completions [role="option"]').first().waitFor();
    await page.locator("#prompt").press("Escape");
    await page.locator("#completions").waitFor({ state: "hidden" });
    await page.locator("#prompt").dispatchEvent("compositionstart");
    await page.locator("#prompt").fill("構成中");
    await page
      .locator("#prompt")
      .dispatchEvent("keydown", { key: "Enter", ctrlKey: true, isComposing: true });
    assert.deepEqual(await readHistory(second.root), []);
    await page.locator("#prompt").dispatchEvent("compositionend");
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Upload attachments" }).click();
    await (await chooser).setFiles(join(b.source, "icon-192.png"));
    await page.locator("#previews img").waitFor();
    assert.equal(await page.locator("#previews img").count(), 1);
    await page.getByRole("button", { name: "Remove attachment" }).click();
    await page.locator("#previews img").waitFor({ state: "detached" });
    assert.equal(await page.locator("#previews img").count(), 0);
    await page.evaluate(async () => {
      const file = new File([await (await fetch("/icon-192.png")).blob()], "image.png", {
        type: "image/png",
      });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      document
        .querySelector("#prompt")!
        .dispatchEvent(
          new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }),
        );
    });
    await page.locator("#previews img").waitFor();
    f.faux.setResponses([fauxAssistantMessage("Image received")]);
    await page.locator("#send").click();
    await page.waitForFunction(
      () => document.querySelector<HTMLTextAreaElement>("#prompt")?.value === "",
    );
    await second.root.waitForIdle(context);
    const message = (await readHistory(second.root))
      .flatMap((entry) => entry.model ?? [])
      .find((message) => message.role === "user");
    assert(message && Array.isArray(message.content));
    assert.equal(message.content.filter((part) => part.type === "image").length, 1);
    assert.deepEqual(b.errors, []);
  },
);

await test(
  "Elm rejects malformed frames and searches nested archives without replacing nodes",
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t);
    const session = await f.create();
    const first = await session.root.commit(
      (tx) =>
        tx.appendEntry(session.root.id, {
          kind: "pi.user",
          model: [
            {
              role: "user",
              content: "An archived needle <img src=x onerror=alert(1)>",
              timestamp: 0,
            },
          ],
        }),
      context,
    );
    const b = await browserFixture(t, f.sessions);
    const page = b.page;
    page.setDefaultTimeout(10000);
    await page.route("**/events", (route) =>
      route.fulfill({ contentType: "text/event-stream", body: 'data: {"version":999}\n\n' }),
    );
    await page.goto(b.base + conversationURL(session));
    await page.getByRole("button", { name: "Reconnect", exact: true }).waitFor();
    await page.unroute("**/events");
    await page.getByRole("button", { name: "Reconnect", exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector("#connection")?.textContent === "Connected",
    );
    const node = await page.locator(`#entry-${first.id}`).elementHandle();
    assert(node);
    assert.equal(await page.locator("#transcript img").count(), 0);
    for (const kind of ["pi.reset", "pi.compaction"]) {
      await session.root.commit(
        (tx) => tx.appendEntry(session.root.id, { kind, head: "self" }),
        context,
      );
      await page.locator(`[data-context="${kind}"]`).waitFor();
    }
    assert.equal(await node.isVisible(), false);
    await page.keyboard.press("Control+f");
    await page.locator("#search").fill("needle");
    await page.waitForFunction((id) => !document.getElementById(id)?.hidden, `entry-${first.id}`);
    assert.equal(await node.evaluate((node) => node === document.getElementById(node.id)), true);
    assert.equal(await page.locator("#search-count").textContent(), "1/1");
    await page.locator("#search").press("Escape");
    assert.equal(await node.isVisible(), false);
    assert.deepEqual(b.errors, []);
  },
);

await test(
  "Elm context commands ask for confirmation and retain committed history and duration",
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t);
    await f.reopen({ ...f.options, settings: { compaction: { keepRecentTokens: 1 } } });
    const session = await f.create();
    f.faux.setResponses([
      fauxAssistantMessage("First response"),
      fauxAssistantMessage("Second response"),
    ]);
    for (const content of ["First ".repeat(1000), "Second ".repeat(1000)])
      await (await session.root.submit({ type: "input", content }, context)).wait(context);
    const records = await readHistory(session.root);
    const b = await browserFixture(t, f.sessions);
    const page = b.page;
    page.setDefaultTimeout(10000);
    await page.goto(b.base + conversationURL(session));
    await page.waitForFunction(
      () => document.querySelector("#connection")?.textContent === "Connected",
    );
    const original = await page.locator(`#entry-${records[0].id}`).elementHandle();
    assert(original);
    f.faux.setResponses([fauxAssistantMessage("Summary of the completed work")]);
    await page.locator("#prompt").fill("/compact Keep the key decisions");
    await page.locator("#send").click();
    await page.getByRole("button", { name: "Confirm compaction" }).waitFor();
    assert.deepEqual(await readHistory(session.root), records);
    await page.getByRole("button", { name: "Confirm compaction" }).click();
    await page.locator('[data-context="pi.compaction"]').waitFor();
    await page.locator("[data-duration-ms]").waitFor({ state: "attached" });
    assert.equal(
      await original.evaluate((node) => node === document.getElementById(node.id)),
      true,
    );
    assert.equal(await original.isVisible(), false);
    await page.locator("#prompt").fill("/reset Preserve the handoff");
    await page.locator("#send").click();
    await page.getByRole("button", { name: "Confirm reset" }).waitFor();
    assert.notEqual((await readHistory(session.root)).at(-1)?.kind, "pi.reset");
    await page.getByRole("button", { name: "Confirm reset" }).click();
    await page.locator('[data-context="pi.reset"]').waitFor();
    assert.equal((await readHistory(session.root)).at(-1)?.kind, "pi.reset");
    assert.equal(
      await original.evaluate((node) => node === document.getElementById(node.id)),
      true,
    );
    assert.deepEqual(b.errors, []);
  },
);

await test(
  "Elm queues follow-up and steering inputs, cancels queued work and aborts a running tool",
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t);
    const session = await f.create();
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 30" }), {
        stopReason: "toolUse",
      }),
    ]);
    const b = await browserFixture(t, f.sessions);
    const page = b.page;
    page.setDefaultTimeout(10000);
    await page.goto(b.base + conversationURL(session));
    await page.locator("#prompt").fill("Start a cancellable tool");
    const send = await page.locator("#send").elementHandle();
    assert(send);
    await page.locator("#send").click();
    await page.locator('.tool-call[data-state="running"]').waitFor();
    assert.equal(await send.evaluate((node) => node === document.getElementById("send")), true);
    for (const mode of ["followUp", "steer"]) {
      await page.locator("#prompt").fill(`Queued ${mode}`);
      await page
        .getByRole("button", { name: mode === "steer" ? "Steer" : "Queue", exact: true })
        .click();
      await page.locator(`#queue [data-mode="${mode}"]`).waitFor();
      assert.equal(
        (await session.harness.snapshot(InboxDoc, session.root.id, context))?.items?.some(
          (item) => item.mode === mode,
        ),
        true,
      );
      await page.getByRole("button", { name: "Cancel queued message" }).click();
      await page.locator("#queue article").waitFor({ state: "detached" });
      assert.deepEqual(
        (await session.harness.snapshot(InboxDoc, session.root.id, context))?.items ?? [],
        [],
      );
    }
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await session.root.waitForIdle(context);
    await page.waitForFunction(
      () => document.querySelector("#controls")?.getAttribute("data-state") === "ready",
    );
    assert.equal(
      (await session.harness.snapshot(LiveDoc, session.root.id, context))?.run,
      undefined,
    );
    assert.equal(await send.evaluate((node) => node === document.getElementById("send")), true);
    assert.deepEqual(b.errors, []);
  },
);

await test(
  "Elm recovers an acknowledged image submission after reload without losing a newer draft",
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t);
    const session = await f.create();
    const b = await browserFixture(t, f.sessions);
    const server = await streamServer(t, f.sessions, b.assets);
    const page = b.page;
    page.setDefaultTimeout(10000);
    await page.goto(server.base + conversationURL(session));
    const select = async (file: string) => {
      const chooser = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: "Upload attachments" }).click();
      await (await chooser).setFiles(join(b.source, file));
    };
    await page.locator("#prompt").fill("Original image input");
    await select("icon-192.png");
    await page.locator("#previews img").waitFor();
    f.faux.setResponses([fauxAssistantMessage("Image accepted")]);
    const received = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    t.after(() => release.resolve());
    // Intercept the server response, not Playwright's request forwarding: browser
    // interception does not preserve uploaded file bytes in route.fetch().
    server.server.on("request", (request, response) => {
      if (!request.url?.endsWith("/command")) return;
      t.mock.method(response, "end", () => {
        received.resolve();
        void release.promise.then(() => response.destroy());
        return response;
      });
    });
    await page.locator("#send").click();
    await received.promise;
    await page.locator("#prompt").fill("Newer image draft");
    await select("icon-512.png");
    await page.waitForFunction(() => document.querySelectorAll("#previews img").length === 2);
    release.resolve();
    await page.getByRole("button", { name: "Retry original input" }).waitFor();
    const pending = await page.evaluate(
      () => JSON.parse(sessionStorage.getItem("pi.elm.drafts")!)[location.pathname].pending,
    );
    assert.equal(pending.missingFiles, true);
    assert.equal(Object.hasOwn(pending, "files"), false);
    await session.root.waitForIdle(context);
    const before = await readHistory(session.root);
    const user = before
      .flatMap((entry) => entry.model ?? [])
      .find((message) => message.role === "user");
    assert(user && Array.isArray(user.content));
    assert.equal(user.content.filter((part) => part.type === "image").length, 1);
    await page.reload();
    await page.getByRole("button", { name: "Check original submission" }).click();
    await page
      .getByRole("button", { name: "Check original submission" })
      .waitFor({ state: "detached" });
    assert.equal(await page.locator("#prompt").inputValue(), "Newer image draft");
    assert.deepEqual(await readHistory(session.root), before);
    await page.getByRole("button", { name: "Discard missing attachments" }).click();
    assert.equal(await page.locator("#previews img").count(), 0);
    assert.equal(f.faux.state.callCount, 1);
    assert.deepEqual(b.errors, []);
  },
);

await test(
  "Elm retains uncertainty for missing image submissions and non-idempotent commands across reload",
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t);
    const session = await f.create();
    const b = await browserFixture(t, f.sessions);
    const page = b.page;
    page.setDefaultTimeout(10000);
    await page.goto(b.base + conversationURL(session));
    await page.locator("#prompt").fill("Not admitted");
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Upload attachments" }).click();
    await (await chooser).setFiles(join(b.source, "icon-192.png"));
    await page.locator("#previews img").waitFor();
    await page.route("**/command", (route) => route.abort("connectionfailed"));
    await page.locator("#send").click();
    await page.getByRole("button", { name: "Retry original input" }).waitFor();
    const identity = await page.evaluate(
      () =>
        JSON.parse(sessionStorage.getItem("pi.elm.drafts")!)[location.pathname].pending.identity,
    );
    await page.reload();
    const receipt = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith("/receipt"),
    );
    await page.getByRole("button", { name: "Check original submission" }).click();
    assert.deepEqual(await (await receipt).json(), { accepted: false });
    await page.getByRole("button", { name: "Check original submission" }).waitFor();
    assert.equal(
      await page.evaluate(
        () =>
          JSON.parse(sessionStorage.getItem("pi.elm.drafts")!)[location.pathname].pending.identity,
      ),
      identity,
    );
    assert.deepEqual(await readHistory(session.root), []);
    await page.getByRole("button", { name: "Keep draft; dismiss uncertain command" }).click();
    await page.getByRole("button", { name: "Discard missing attachments" }).click();
    await page.unroute("**/command");
    await page.route("**/command", async (route) => {
      await route.fetch();
      await route.abort("connectionfailed");
    });
    await page.locator("#prompt").fill("/reset Explicit handoff");
    await page.locator("#send").click();
    await page.getByRole("button", { name: "Confirm reset" }).click();
    await page.getByRole("button", { name: "Keep draft; dismiss uncertain command" }).waitFor();
    const before = await readHistory(session.root);
    assert.equal(before.filter((entry) => entry.kind === "pi.reset").length, 1);
    await page.reload();
    await page.getByRole("button", { name: "Keep draft; dismiss uncertain command" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Retry original input" }).count(), 0);
    assert.equal(await page.locator("#prompt").inputValue(), "/reset Explicit handoff");
    assert.deepEqual(await readHistory(session.root), before);
    assert.deepEqual(b.errors, []);
  },
);

await test(
  "Elm resumes interrupted Durable execution rather than submitting a new input",
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t);
    const session = await f.create();
    const started = Promise.withResolvers<void>();
    f.faux.setResponses([
      async (_messages, options) => {
        assert(options?.signal);
        started.resolve();
        await new Promise<void>((resolve) => {
          if (options.signal?.aborted) resolve();
          else options.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return fauxAssistantMessage("", { stopReason: "aborted" });
      },
    ]);
    await session.root.submit({ type: "input", content: "Interrupted input" }, context);
    await started.promise;
    await f.reopen();
    const restored = await f.sessions.get(session.id);
    assert.equal((await restored.harness.inspect(context)).scheduling, "paused");
    assert((await restored.harness.inspect(context)).tasks.length > 0);
    f.faux.setResponses([fauxAssistantMessage("Resumed")]);
    const b = await browserFixture(t, f.sessions);
    const page = b.page;
    page.setDefaultTimeout(10000);
    await page.goto(b.base + conversationURL(restored, undefined));
    await page.waitForFunction(
      () => document.querySelector("#connection")?.textContent === "Connected",
    );
    assert.equal((await restored.harness.inspect(context)).scheduling, "paused");
    await page.locator("#prompt").fill("/resume");
    await page.locator("#send").click();
    await page.waitForFunction(
      () => document.querySelector<HTMLTextAreaElement>("#prompt")?.value === "",
    );
    await restored.root.waitForIdle(context);
    assert.equal((await restored.harness.inspect(context)).tasks.length, 0);
    assert.equal(
      (await readHistory(restored.root))
        .flatMap((entry) => entry.model ?? [])
        .filter((message) => message.role === "user").length,
      1,
    );
    assert.equal(f.faux.state.callCount, 2);
    assert.deepEqual(b.errors, []);
  },
);

await test(
  "Elm exposes terminal stream failures for explicit retry",
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t);
    const session = await f.create();
    const b = await browserFixture(t, f.sessions);
    const page = b.page;
    let attempts = 0;
    await page.route("**/events", (route) => {
      attempts++;
      return route.fulfill({ status: 204 });
    });
    await page.goto(b.base + conversationURL(session));
    await page.getByRole("button", { name: "Reconnect", exact: true }).waitFor();
    assert.equal(attempts, 1);
    await page.locator("#prompt").fill("Retained after terminal failure");
    await page.unroute("**/events");
    await page.getByRole("button", { name: "Reconnect", exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector("#connection")?.textContent === "Connected",
    );
    assert.equal(await page.locator("#prompt").inputValue(), "Retained after terminal failure");
    assert.deepEqual(b.errors, []);
  },
);

async function streamServer(t: TestContext, sessions: Sessions, assets: string) {
  const server = httpServer(sessions, "127.0.0.1", assets);
  const streams = new Set<ServerResponse>();
  let blocked = false;
  server.on("request", (request, response) => {
    if (!new URL(request.url!, "http://localhost").pathname.endsWith("/events")) return;
    streams.add(response);
    response.once("close", () => streams.delete(response));
    if (blocked) response.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  return {
    server,
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    streams,
    disconnect() {
      blocked = true;
      for (const stream of streams) stream.destroy();
    },
    reconnect() {
      blocked = false;
    },
  };
}

function observeWatches(t: TestContext, session: Session) {
  const active = new Set<Awaited<ReturnType<Conversation["watch"]>>>();
  const observed = new WeakSet<Conversation>();
  const original = session.harness.conversation.bind(session.harness);
  t.mock.method(session.harness, "conversation", async (...args: Parameters<typeof original>) => {
    const conversation = await original(...args);
    if (conversation && !observed.has(conversation)) {
      observed.add(conversation);
      const watch = conversation.watch.bind(conversation);
      t.mock.method(conversation, "watch", async (...args: Parameters<typeof watch>) => {
        const observer = await watch(...args);
        active.add(observer);
        void observer.closed.then(() => active.delete(observer));
        return observer;
      });
    }
    return conversation;
  });
  return active;
}

await test(
  "Elm reconnects across generation, append, reset and compaction without losing local state",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    const session = await f.create();
    const first = await session.root.commit(async (tx) => {
      const first = await tx.appendEntry(session.root.id, {
        kind: "message",
        model: [{ role: "user", content: "Retain this entry", timestamp: 0 }],
      });
      for (let i = 0; i < 40; i++)
        await tx.appendEntry(session.root.id, {
          kind: "message",
          model: [fauxAssistantMessage(`History paragraph ${i}`)],
        });
      return first;
    }, context);
    const b = await browserFixture(t, f.sessions);
    const server = await streamServer(t, f.sessions, b.assets);
    const watches = observeWatches(t, session);
    const page = b.page;
    page.setDefaultTimeout(10000);
    await page.goto(server.base + conversationURL(session));
    await page.waitForFunction(
      () => document.querySelector("#connection")?.textContent === "Connected",
    );
    const node = await page.locator(`#entry-${first.id}`).elementHandle();
    assert(node);
    await page.locator("#prompt").fill("Newer local draft");
    await page.evaluate(() => {
      document.getElementById("conversation-scroll")!.scrollTop = 0;
    });
    for (const phase of ["generation", "append", "pi.reset", "pi.compaction"]) {
      server.disconnect();
      await page.waitForFunction(
        () => document.querySelector("#connection")?.textContent === "Disconnected; reconnecting…",
      );
      await waitFor(async () => watches.size === 0 && server.streams.size === 0);
      const record = await session.root.commit(async (tx) => {
        const live = await tx.doc(LiveDoc, session.root.id);
        if (phase === "generation") {
          live.run = { taskId: 1 as TaskId, inputs: [] };
          const message = fauxAssistantMessage("Latest live output");
          live.generation = {
            attempt: 1,
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Latest live output" }],
              api: message.api,
              provider: message.provider,
              model: message.model,
              usage: message.usage,
              stopReason: message.stopReason,
              timestamp: message.timestamp,
            },
          };
          return undefined;
        }
        delete live.run;
        delete live.generation;
        return tx.appendEntry(session.root.id, {
          kind: phase === "append" ? "message" : phase,
          ...(phase === "append" ? {} : { head: "self" as const }),
          model: [fauxAssistantMessage(phase)],
        });
      }, context);
      server.reconnect();
      await page.waitForFunction(
        () => document.querySelector("#connection")?.textContent === "Connected",
      );
      await waitFor(async () => watches.size === 1 && server.streams.size === 1);
      assert.equal(await node.evaluate((node) => node === document.getElementById(node.id)), true);
      assert.equal(await page.locator("#prompt").inputValue(), "Newer local draft");
      assert.equal(
        await page.locator("#controls").getAttribute("data-state"),
        phase === "generation" ? "working" : "ready",
      );
      if (record) {
        assert.equal(await page.locator(`#entry-${record.id}`).count(), 1);
        assert.equal(await page.locator("#live article").count(), 0);
      } else {
        assert.equal(await page.locator("#live article").count(), 1);
        assert.equal(
          await page.locator("#conversation-scroll").evaluate((node) => node.scrollTop),
          0,
        );
      }
      const ids = await page
        .locator("#transcript [data-entry]")
        .evaluateAll((nodes) => nodes.map((node) => node.id));
      assert.equal(new Set(ids).size, ids.length);
    }
    await page.evaluate(() =>
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })),
    );
    await waitFor(async () => watches.size === 0 && server.streams.size === 0);
    await page.evaluate(() =>
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })),
    );
    await waitFor(async () => watches.size === 1 && server.streams.size === 1);
    assert.equal(await page.locator("#prompt").inputValue(), "Newer local draft");
    await page.goto("about:blank");
    await waitFor(async () => watches.size === 0 && server.streams.size === 0);
    assert.deepEqual(b.errors, []);
  },
);

await test(
  "Elm releases observers on landing navigation and reconciles an acknowledgement lost with the old document",
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t);
    const first = await f.create(),
      second = await f.create();
    await rename(first, "First");
    await rename(second, "Second");
    const b = await browserFixture(t, f.sessions);
    const server = await streamServer(t, f.sessions, b.assets);
    const firstWatches = observeWatches(t, first),
      secondWatches = observeWatches(t, second);
    const page = b.page;
    page.setDefaultTimeout(10000);
    await page.setViewportSize({ width: 1000, height: 900 });
    await page.goto(server.base + conversationURL(first, undefined));
    await page.waitForFunction(
      () => document.querySelector("#connection")?.textContent === "Connected",
    );
    f.faux.setResponses([fauxAssistantMessage("First accepted")]);
    const received = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    t.after(() => release.resolve());
    await page.route("**/command", async (route) => {
      const response = await route.fetch();
      received.resolve();
      await release.promise;
      await route.fulfill({ response });
    });
    await page.locator("#prompt").fill("First input");
    await page.locator("#send").click();
    await received.promise;
    await page.locator("#conversation-title").click();
    await page.locator("#session-list a").filter({ hasText: "Second" }).click();
    await page.waitForURL(server.base + conversationURL(second, undefined));
    await page.locator("#prompt").fill("Second draft");
    await waitFor(
      async () => firstWatches.size === 0 && secondWatches.size === 1 && server.streams.size === 1,
    );
    release.resolve();
    assert.equal(await page.locator("#prompt").inputValue(), "Second draft");
    assert.deepEqual(await readHistory(second.root), []);
    await page.locator("#conversation-title").click();
    await page.locator("#session-list a").filter({ hasText: "First" }).click();
    await page.waitForURL(server.base + conversationURL(first, undefined));
    await page.unrouteAll({ behavior: "wait" });
    await waitFor(async () => firstWatches.size === 1 && secondWatches.size === 0);
    assert.equal(await page.locator("#session-list").count(), 0);
    // A full document navigation cannot receive the old acknowledgement. Retry
    // reconciles the persisted request identity without another model input.
    await page.getByRole("button", { name: "Retry original input", exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector<HTMLTextAreaElement>("#prompt")?.value === "",
    );
    assert.equal(
      (await readHistory(first.root)).filter((entry) => entry.kind === "pi.user").length,
      1,
    );
    await page.evaluate(() =>
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })),
    );
    await waitFor(async () => firstWatches.size === 0);
    await page.evaluate(() =>
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })),
    );
    await waitFor(async () => firstWatches.size === 1);
    await page.goto("about:blank");
    await waitFor(
      async () => firstWatches.size === 0 && secondWatches.size === 0 && server.streams.size === 0,
    );
    assert.deepEqual(b.errors, []);
  },
);

await test(
  "Elm rejects delayed completions and keeps in-memory drafts when storage is unusable",
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t);
    const session = await f.create();
    const b = await browserFixture(t, f.sessions);
    for (const mode of ["denied", "malformed"]) {
      const page = await b.browserContext.newPage();
      page.on("pageerror", (error) => b.errors.push(error));
      page.setDefaultTimeout(10000);
      await page.addInitScript((mode) => {
        if (mode === "denied") {
          Storage.prototype.getItem = () => {
            throw new DOMException("Denied", "SecurityError");
          };
          Storage.prototype.setItem = () => {
            throw new DOMException("Denied", "SecurityError");
          };
        } else sessionStorage.setItem("pi.elm.drafts", "{");
      }, mode);
      await page.goto(b.base + conversationURL(session));
      await page.waitForFunction(
        () => document.querySelector("#connection")?.textContent === "Connected",
      );
      const received = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      t.after(() => release.resolve());
      await page.route("**/completions?*", async (route) => {
        const response = await route.fetch();
        received.resolve();
        await release.promise;
        await route.fulfill({ response });
      });
      await page.locator("#prompt").fill("/res");
      await received.promise;
      await page.locator("#prompt").press("Escape");
      await page.locator("#prompt").fill("New draft");
      const response = page.waitForResponse((response) =>
        new URL(response.url()).pathname.endsWith("/completions"),
      );
      release.resolve();
      await response;
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      assert.equal(await page.locator("#completions").isVisible(), false);
      assert.equal(await page.locator("#prompt").inputValue(), "New draft");
      await page.unrouteAll({ behavior: "wait" });
      await page.locator("#prompt").press("Enter");
      assert.equal(await page.locator("#prompt").inputValue(), "New draft\n");
      await page.locator("#prompt").fill("/res");
      await page.locator('#completions [role="option"]').first().waitFor();
      await page.locator("#prompt").press("ArrowDown");
      await page.locator("#prompt").press("Tab");
      const caret = await page.locator("#prompt").evaluate((node: HTMLTextAreaElement) => ({
        start: node.selectionStart,
        end: node.selectionEnd,
        length: node.value.length,
      }));
      assert.equal(caret.start, caret.length);
      assert.equal(caret.end, caret.length);
      await page.locator("#prompt").fill("Submit despite unavailable storage");
      f.faux.setResponses([fauxAssistantMessage("Accepted")]);
      await page.locator("#send").click();
      await page.waitForFunction(
        () => document.querySelector<HTMLTextAreaElement>("#prompt")?.value === "",
      );
      await session.root.waitForIdle(context);
      assert.equal(
        await page.evaluate(async () =>
          (
            await Promise.all(
              (await caches.keys()).map(async (key) =>
                (await (await caches.open(key)).keys()).some((request) =>
                  new URL(request.url).pathname.includes("/sessions/"),
                ),
              ),
            )
          ).some(Boolean),
        ),
        false,
      );
      await page.close();
    }
    assert.equal(
      (await readHistory(session.root))
        .flatMap((entry) => entry.model ?? [])
        .filter((message) => message.role === "user").length,
      2,
    );
    assert.deepEqual(b.errors, []);
  },
);

await test(
  "Elm attaches text and images together and preserves files through a failed request and retry",
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t);
    const session = await f.create();
    const b = await browserFixture(t, f.sessions);
    const page = b.page;
    page.setDefaultTimeout(10000);
    await page.goto(b.base + conversationURL(session));
    assert.equal(await page.getByRole("button", { name: "Upload attachments" }).count(), 1);
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Upload attachments" }).click();
    const picker = await chooser;
    assert.equal(await picker.element().getAttribute("accept"), "");
    await picker.setFiles([
      ...Array.from({ length: 5 }, (_, index) => ({
        name: `data${index}.json`,
        mimeType: "application/json",
        buffer: Buffer.from('{"ok":true}'),
      })),
      { name: "large.txt", mimeType: "text/plain", buffer: Buffer.alloc(5 * 1024 * 1024 + 1, "x") },
    ]);
    await page.locator("#previews button").nth(5).waitFor();
    await page.locator("#previews button").nth(5).click();
    await page.locator("#previews button").nth(5).waitFor({ state: "detached" });
    assert.equal(await page.locator("#previews img").count(), 0);
    await page.locator("#prompt").fill("Retry with the original files");
    await page.evaluate(async () => {
      const transfer = new DataTransfer();
      transfer.items.add(
        new File([await (await fetch("/icon-192.png")).blob()], "image.png", { type: "image/png" }),
      );
      document
        .getElementById("prompt")!
        .dispatchEvent(
          new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
        );
    });
    await page.locator("#previews img").waitFor();
    await page.route("**/command", (route) => route.abort("connectionfailed"));
    await page.locator("#send").click();
    await page.getByRole("button", { name: "Retry original input" }).waitFor();
    assert.equal(await page.locator("#previews img").count(), 1);
    assert.deepEqual(await readHistory(session.root), []);
    await page.unroute("**/command");
    f.faux.setResponses([fauxAssistantMessage("Retried files")]);
    await page.getByRole("button", { name: "Retry original input" }).click();
    await page.waitForFunction(
      () => document.querySelector<HTMLTextAreaElement>("#prompt")?.value === "",
    );
    await session.root.waitForIdle(context);
    const user = (await readHistory(session.root))
      .flatMap((entry) => entry.model ?? [])
      .find((message) => message.role === "user");
    assert(user && Array.isArray(user.content));
    assert.equal(user.content.filter((part) => part.type === "image").length, 1);
    assert.equal(user.content.filter((part) => part.type === "text").length, 6);
    assert.deepEqual(user.content[1], { type: "text", text: 'File: "data0.json"\n\n{"ok":true}' });
    const entry = (await readHistory(session.root)).find(
      (entry) => entry.kind === "app.attachments",
    );
    assert(entry && entry.data && typeof entry.data === "object" && !Array.isArray(entry.data));
    assert(Array.isArray(entry.data.attachments));
    assert.equal(entry.data.attachments.length, 6);
    assert.deepEqual(b.errors, []);
  },
);

await test(
  "Elm preserves selection, scrollback, focus and tool disclosure choices through updates and archives",
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t);
    const session = await f.create(),
      other = await f.create();
    await rename(other, "Other");
    const first = await session.root.commit(async (tx) => {
      const first = await tx.appendEntry(session.root.id, {
        kind: "message",
        model: [{ role: "user", content: "Selected history", timestamp: 0 }],
      });
      for (let i = 0; i < 40; i++)
        await tx.appendEntry(session.root.id, {
          kind: "message",
          model: [fauxAssistantMessage(`Long history ${i}`)],
        });
      return first;
    }, context);
    const failedTool = async (id: string) =>
      session.root.commit(async (tx) => {
        await tx.appendEntry(session.root.id, {
          kind: "message",
          model: [fauxAssistantMessage(fauxToolCall("bash", { command: "false" }, { id }))],
        });
        await tx.appendEntry(session.root.id, {
          kind: "message",
          model: [
            {
              role: "toolResult",
              toolCallId: id,
              toolName: "bash",
              content: [{ type: "text", text: "Failed" }],
              isError: true,
              timestamp: 0,
            },
          ],
        });
      }, context);
    await failedTool("old-failed");
    const b = await browserFixture(t, f.sessions);
    const page = b.page;
    page.setDefaultTimeout(10000);
    await page.setViewportSize({ width: 1000, height: 900 });
    await page.goto(b.base + conversationURL(session));
    await page.waitForFunction(
      () => document.querySelector("#connection")?.textContent === "Connected",
    );
    const oldTool = page.locator('[data-call-id="old-failed"]');
    assert.equal(await oldTool.evaluate((node: HTMLDetailsElement) => node.open), true);
    await oldTool.locator(":scope > summary").click();
    await page.waitForFunction(
      () => !document.querySelector<HTMLDetailsElement>('[data-call-id="old-failed"]')?.open,
    );
    await page.locator("#conversation-scroll").focus();
    await page.evaluate((id) => {
      const paragraph = document.querySelector(`#entry-${id} .text p`)!;
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
      document.getElementById("conversation-scroll")!.scrollTop = 100;
    }, first.id);
    await failedTool("new-failed");
    await page.locator('[data-call-id="new-failed"]').waitFor({ state: "attached" });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    assert.equal(await oldTool.evaluate((node: HTMLDetailsElement) => node.open), false);
    assert.equal(
      await page
        .locator('[data-call-id="new-failed"]')
        .evaluate((node: HTMLDetailsElement) => node.open),
      true,
    );
    assert.equal(
      await page.locator("#conversation-scroll").evaluate((node) => node.scrollTop),
      100,
    );
    assert.deepEqual(
      await page.evaluate(() => ({
        selection: getSelection()?.toString(),
        focus: document.activeElement?.id,
      })),
      { selection: "Selected history", focus: "conversation-scroll" },
    );
    const selectedTop = await page.evaluate(() => {
      const scroll = document.getElementById("conversation-scroll")!;
      scroll.scrollTop = scroll.scrollHeight;
      return scroll.scrollTop;
    });
    const selectedAppend = await session.root.commit(
      (tx) =>
        tx.appendEntry(session.root.id, {
          kind: "message",
          model: [fauxAssistantMessage("Append while selecting. ".repeat(100))],
        }),
      context,
    );
    await page.locator(`#entry-${selectedAppend.id}`).waitFor({ state: "attached" });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    assert.equal(
      await page.locator("#conversation-scroll").evaluate((node) => node.scrollTop),
      selectedTop,
    );
    await page.evaluate(() => getSelection()!.removeAllRanges());
    await page.locator("#latest").click();
    await page.waitForFunction(() => {
      const node = document.getElementById("conversation-scroll")!;
      return Math.abs(node.scrollHeight - node.clientHeight - node.scrollTop) < 1;
    });
    const followed = await session.root.commit(
      (tx) =>
        tx.appendEntry(session.root.id, {
          kind: "message",
          model: [fauxAssistantMessage("Follow new output. ".repeat(100))],
        }),
      context,
    );
    await page.locator(`#entry-${followed.id}`).waitFor({ state: "attached" });
    await page.waitForFunction(() => {
      const node = document.getElementById("conversation-scroll")!;
      return Math.abs(node.scrollHeight - node.clientHeight - node.scrollTop) < 1;
    });
    await page.evaluate((id) => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector(`#entry-${id} .text p`)!);
      getSelection()!.addRange(range);
    }, first.id);
    const original = await page.locator(`#entry-${first.id}`).elementHandle();
    assert(original);
    for (const kind of ["pi.reset", "pi.compaction"]) {
      const record = await session.root.commit(
        (tx) => tx.appendEntry(session.root.id, { kind, head: "self" }),
        context,
      );
      await page.locator(`#entry-${record.id} summary`).focus();
      await page.locator(`#entry-${record.id} summary`).press("Enter");
      await page.waitForFunction((id) => !document.getElementById(id)?.hidden, `entry-${first.id}`);
      assert.equal(
        await original.evaluate((node) => node === document.getElementById(node.id)),
        true,
      );
      assert.equal(await page.evaluate(() => getSelection()?.toString()), "Selected history");
      assert.equal(await oldTool.evaluate((node: HTMLDetailsElement) => node.open), false);
    }
    await page.evaluate(() => {
      getSelection()!.removeAllRanges();
      document.getElementById("conversation-scroll")!.scrollTop = 120;
    });
    // Deliver the scroll event before navigation removes this scrollport.
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>("#latest")?.hidden);
    await page.locator("#conversation-title").click();
    await page.locator("#session-list a").filter({ hasText: "Other" }).click();
    await page.waitForURL(b.base + conversationURL(other, undefined));
    await page.waitForFunction(
      () => document.querySelector("#connection")?.textContent === "Connected",
    );
    await page.goBack();
    await page.locator("#landing").waitFor();
    await page.goBack();
    await page.waitForFunction(
      () => document.querySelector("#connection")?.textContent === "Connected",
    );
    await page.waitForFunction(
      () => document.getElementById("conversation-scroll")?.scrollTop === 120,
    );
    assert.deepEqual(b.errors, []);
  },
);

await test(
  "Elm creates sessions with text attachments through the single upload button",
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t);
    const b = await browserFixture(t, f.sessions);
    const page = b.page;
    page.setDefaultTimeout(10000);
    await page.goto(b.base + "/");
    const upload = page.getByRole("button", { name: "Upload attachments" });
    assert.equal(await upload.count(), 1);
    const chooser = page.waitForEvent("filechooser");
    await upload.click();
    const picker = await chooser;
    assert.equal(await picker.element().getAttribute("accept"), "");
    await picker.setFiles({
      name: "notes.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# Notes"),
    });
    await page.getByRole("button", { name: "Remove notes.md" }).waitFor();
    assert.equal(await page.locator("#previews img").count(), 0);
    await page.getByRole("button", { name: "Remove notes.md" }).click();
    assert.equal(await page.locator("#previews button").count(), 0);
    await page.evaluate(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(["# Notes"], "notes.md", { type: "text/markdown" }));
      document.getElementById("prompt")!.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: transfer,
        }),
      );
    });
    await page.getByRole("button", { name: "Remove notes.md" }).waitFor();
    f.faux.setResponses([fauxAssistantMessage("Received notes")]);
    await page.getByRole("button", { name: "Create session", exact: true }).click();
    await page.waitForURL("**/sessions/*/conversations/*");
    const id = new URL(page.url()).pathname.split("/")[2];
    const session = await f.sessions.get(id);
    await session.root.waitForIdle(context);
    const entry = (await readHistory(session.root)).find(
      (entry) => entry.kind === "app.attachments",
    );
    assert(entry);
    assert.deepEqual(entry.data, {
      attachments: [{ name: "notes.md", mimeType: "text/markdown", size: 7, block: 1 }],
    });
    const message = entry.model?.[0];
    assert(message?.role === "user");
    assert.deepEqual(message.content, [
      { type: "text", text: "" },
      { type: "text", text: 'File: "notes.md"\n\n# Notes' },
    ]);
    assert.deepEqual(b.errors, []);
  },
);
