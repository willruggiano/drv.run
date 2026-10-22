import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { Htmx } from "htmx.org";
import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { httpServer } from "../server.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { LiveDoc } from "@earendil-works/pi-durable";
import { Review } from "harness";
import { html, renderHTML, type SafeHtml } from "../html.ts";
import { conversationURL, htmlPage } from "../hypermedia.ts";
import { browserFixture, htmlAction, openSessions } from "./browser-testing.ts";
import { fixture, readHistory, waitFor } from "./sessions-testing.ts";

const context = BACKGROUND_CONTEXT;
const partial = (text: string) => {
  const { role, api, provider, model, usage, stopReason, timestamp } = fauxAssistantMessage(text);
  return {
    role,
    api,
    provider,
    model,
    usage,
    stopReason,
    timestamp,
    content: [{ type: "text" as const, text }],
  };
};

await test("HTML templates escape text and attributes, and compose only branded markup", async (t) => {
  const f = await fixture(t);
  const { page } = await browserFixture(t, f.sessions);
  // These assignments must fail to compile if render boundaries accept strings.
  const acceptsString: string extends Parameters<typeof htmlPage>[0] ? true : false = false;
  const acceptsConcatenation: string extends SafeHtml ? true : false = false;
  assert.equal(acceptsString, false);
  assert.equal(acceptsConcatenation, false);
  const attack = `"'&><button id="injected">Injected</button>`;
  const text = html`<p id="text">${attack}</p>`;
  const attribute = html`<input id="attribute" value="${attack}" title="${attack}" />`;
  const nested = html`<section id="nested">${[text, attribute]}</section>`;
  await page.setContent(
    renderHTML(
      html`${nested}<textarea>${"</textarea>" + attack}</textarea
        ><output>${0}${false}${true}${null}${undefined}</output>`,
    ),
  );
  assert.equal(await page.locator("#text").textContent(), attack);
  assert.deepEqual(
    await page
      .locator("#attribute")
      .evaluate((node) =>
        Object.fromEntries(Array.from(node.attributes, (attr) => [attr.name, attr.value])),
      ),
    { id: "attribute", value: attack, title: attack },
  );
  assert.equal(await page.locator("input").inputValue(), attack);
  assert.equal(await page.locator("textarea").inputValue(), "</textarea>" + attack);
  assert.equal(await page.locator("button").count(), 0);
  assert.deepEqual(
    await page
      .locator("#nested")
      .evaluate((node) => Array.from(node.children, (child) => child.tagName)),
    ["P", "INPUT"],
  );
  assert.equal(await page.locator("output").textContent(), "0falsetrue");
  assert(Object.isFrozen(text));
});

declare global {
  interface Window {
    __projections: {
      head: string;
      onlyPartials: boolean;
      parts: { id: string; swap: string | null; entries: number }[];
    }[];
  }
}

await test("htmx waits for delayed extensions before initializing the first SSE connection", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const b = await browserFixture(t, f.sessions);
  const requested = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  await b.page.route("**/hx-sse.js", async (route) => {
    const response = await route.fetch();
    requested.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  const loaded = b.page.goto(b.base + conversationURL(session));
  await requested.promise;
  await b.page.waitForFunction(
    "typeof htmx !== 'undefined' && document.readyState === 'interactive'",
  );
  // Let any prematurely queued initialization timer run before releasing hx-sse.
  await b.page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  const initialized = await b.page.locator("[data-htmx-powered]").count();
  release.resolve();
  await loaded;
  assert.equal(initialized, 0);
  await b.page.waitForFunction(
    () => document.querySelector("#connection")?.textContent === "Connected",
  );
  assert.deepEqual(b.errors, []);
});

await test("SSE heads avoid initial history, append keyed entries, and morph reset layouts without replacing nodes", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const first = await session.root.commit(
    (tx) =>
      tx.appendEntry(session.root.id, {
        kind: "message",
        model: [fauxAssistantMessage("Immutable history")],
      }),
    context,
  );
  const records = await readHistory(session.root);
  const b = await browserFixture(t, f.sessions);
  const { page } = b;
  await page.addInitScript(() => {
    window.__projections = [];
    document.addEventListener("htmx:sse:after:message", (event) => {
      if (!(event instanceof CustomEvent)) throw new Error("Expected SSE event");
      const { message } = event.detail as { message: { data: string; id: string } };
      const body = new DOMParser().parseFromString(message.data, "text/html").body;
      window.__projections.push({
        head: message.id,
        onlyPartials: Array.from(body.children).every((node) => node.tagName === "HX-PARTIAL"),
        parts: Array.from(body.children, (node) => ({
          id: node.id,
          swap: node.getAttribute("hx-swap"),
          entries: node.querySelectorAll("article[data-entry]").length,
        })),
      });
    });
  });
  await page.goto(b.base + conversationURL(session));
  await page.waitForFunction(() => window.__projections.length > 0);
  const initial = await page.evaluate(() => window.__projections[0]);
  assert.equal(initial.head, `${first.id}.0`);
  assert(initial.onlyPartials);
  assert(
    initial.parts.every(
      (part) => part.id !== "transcript" && part.entries === 0 && part.swap === "outerMorph",
    ),
  );
  const node = await page.locator(`#entry-${first.id}`).elementHandle();
  assert(node);
  const setLive = (text: string) =>
    session.root.commit(async (tx) => {
      const live = await tx.doc(LiveDoc, session.root.id);
      live.generation = { attempt: 1, message: partial(text) };
    }, context);
  await setLive("Selection survives");
  await page.locator("#live p").waitFor();
  const selected = await page.evaluateHandle(() => {
    const text = document.querySelector("#live p")!.firstChild!;
    getSelection()!.setBaseAndExtent(text, 0, text, 9);
    return text;
  });
  await setLive("Selection survives an appended token");
  await page.waitForFunction(
    () => document.querySelector("#live p")?.textContent === "Selection survives an appended token",
  );
  assert.deepEqual(
    await page.evaluate(
      (text) => ({
        node: text === document.querySelector("#live p")!.firstChild,
        anchor: getSelection()!.anchorNode === text,
        focus: getSelection()!.focusNode === text,
        start: getSelection()!.anchorOffset,
        end: getSelection()!.focusOffset,
        text: getSelection()!.toString(),
      }),
      selected,
    ),
    { node: true, anchor: true, focus: true, start: 0, end: 9, text: "Selection" },
  );
  assert.deepEqual(await readHistory(session.root), records);
  assert(
    (await page.evaluate(() => window.__projections)).every(
      (frame) =>
        frame.onlyPartials &&
        frame.parts.every((part) => part.id !== "transcript" && part.entries === 0),
    ),
  );
  await selected.dispose();
  const appended = await session.root.commit(
    (tx) =>
      tx.appendEntry(session.root.id, {
        kind: "message",
        model: [fauxAssistantMessage("Appended")],
      }),
    context,
  );
  await page.waitForFunction(
    (head) => window.__projections.at(-1)?.head === head,
    `${appended.id}.0`,
  );
  const append = await page.evaluate(() =>
    window.__projections.at(-1)!.parts.find((part) => part.id === "transcript"),
  );
  assert.deepEqual(append, { id: "transcript", swap: "beforeend", entries: 1 });
  const reset = await session.root.commit(
    (tx) =>
      tx.appendEntry(session.root.id, {
        kind: "pi.reset",
        head: "self",
      }),
    context,
  );
  await page.waitForFunction(
    (head) => window.__projections.at(-1)?.head === head,
    `${reset.id}.${reset.id}`,
  );
  assert.deepEqual(
    await page.evaluate(() =>
      window.__projections.at(-1)!.parts.find((part) => part.id === "transcript"),
    ),
    { id: "transcript", swap: "innerMorph", entries: 3 },
  );
  assert.equal(await node.evaluate((node) => node === document.getElementById(node.id)), true);
  assert.equal(await node.evaluate((node) => !!node.closest(".context-history")), true);
  assert.deepEqual((await readHistory(session.root)).slice(0, records.length), records);
  assert.deepEqual(b.errors, []);
  await node.dispose();
});

await test("morph preserves existing disclosure but applies server defaults to new failed details", async (t) => {
  const f = await fixture(t);
  const b = await browserFixture(t, f.sessions);
  await b.page.goto(`${b.base}/sessions`);
  await b.page.evaluate(() => {
    const host = document.createElement("section");
    host.id = "disclosure-test";
    document.body.append(host);
  });
  const frontend = await b.page.evaluateHandle<Htmx>("htmx");
  const swap = (content: SafeHtml) =>
    b.page.evaluate(
      async ({ frontend, text }) => {
        await frontend.swap({
          target: document.getElementById("disclosure-test")!,
          swap: "innerMorph",
          text,
        });
      },
      { frontend, text: renderHTML(content) },
    );
  await swap(
    html`<details id="existing">
      <summary>Tool</summary>
      <span id="payload">Output</span>
    </details>`,
  );
  await b.page.locator("#existing > summary").click();
  await swap(
    html`<details id="existing">
      <summary>Tool updated</summary>
      <span id="payload">Output</span>
    </details>`,
  );
  assert.equal(
    await b.page.locator("#existing").evaluate((node: HTMLDetailsElement) => node.open),
    true,
  );
  await b.page.locator("#existing > summary").click();
  await swap(
    html`<details id="existing" open>
      <summary>Failed</summary>
      <span id="payload">Output</span>
    </details>`,
  );
  assert.equal(
    await b.page.locator("#existing").evaluate((node: HTMLDetailsElement) => node.open),
    false,
  );
  const payload = await b.page.locator("#payload").elementHandle();
  assert(payload);
  await swap(
    html`<details id="failed" open>
      <summary>New failure</summary>
      <span id="payload">Output</span>
    </details>`,
  );
  assert.equal(
    await b.page.locator("#failed").evaluate((node: HTMLDetailsElement) => node.open),
    true,
  );
  assert.equal(await payload.evaluate((node) => node === document.getElementById("payload")), true);
  assert.deepEqual(b.errors, []);
  await payload.dispose();
  await frontend.dispose();
});

await test("HTML workflow: create, submit, review, navigate without ending, end, back/forward", async (t) => {
  const f = await fixture(t);
  const b = await browserFixture(t, f.sessions);
  await b.page.setViewportSize({ width: 820, height: 844 });
  const { page } = b;
  const apiRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/")) apiRequests.push(request.url());
  });
  await page.goto(`${b.base}/sessions`);
  // Window state proves links/forms use enhanced navigation, not document reloads.
  await page.evaluate(() => {
    document.documentElement.dataset.enhanced = "yes";
  });
  await page.getByRole("button", { name: "Create session", exact: true }).click();
  await page.locator("[data-events] #composer").waitFor();
  assert.equal(await page.locator("html").getAttribute("data-enhanced"), "yes");
  const sessions = (await f.sessions.catalog()).sessions;
  assert.equal(sessions.length, 1);
  const session = await f.sessions.get(sessions[0].id);
  const originalURL = b.base + conversationURL(session);
  assert.equal(page.url(), originalURL);
  f.faux.setResponses([fauxAssistantMessage("Implemented.")]);
  await page.getByRole("textbox", { name: "Message" }).fill("Implement it.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLTextAreaElement>("#composer textarea[name=content]")?.value === "",
  );
  await session.root.waitForIdle(context);
  await page.waitForFunction(() => document.querySelectorAll("#transcript article").length === 3);
  const originalHistory = await readHistory(session.root);
  assert.equal(originalHistory.length, 3);
  f.faux.setResponses([fauxAssistantMessage("No findings.")]);
  await (await htmlAction(page, "button", "Start review")).click();
  await (await htmlAction(page, "link", "Visit original")).waitFor();
  const state = await session.harness.snapshot(Review, session.root.id, context);
  assert(state?.active !== undefined);
  const review = await session.harness.conversation(state.active, context);
  assert(review);
  await review.waitForIdle(context);
  const reviewURL = page.url();
  assert.equal(reviewURL, b.base + conversationURL(session, review.id));
  assert.deepEqual(await readHistory(session.root), originalHistory);
  await (await htmlAction(page, "link", "Visit original")).click();
  await (await htmlAction(page, "link", "Open review")).waitFor();
  assert.equal(page.url(), originalURL);
  assert.equal(
    (await session.harness.snapshot(Review, session.root.id, context))?.active,
    review.id,
  );
  await (await htmlAction(page, "link", "Open review")).click();
  await (await htmlAction(page, "button", "End review and return")).waitFor();
  f.faux.setResponses([fauxAssistantMessage("Received review.")]);
  await (await htmlAction(page, "button", "End review and return")).click();
  await page.waitForURL(originalURL);
  await session.root.waitForIdle(context);
  await (await htmlAction(page, "button", "Start review")).waitFor();
  assert.equal(
    (await readHistory(session.root)).filter((entry) => entry.kind === "app.review").length,
    1,
  );
  await page.goBack();
  await (await htmlAction(page, "link", "Visit original")).waitFor();
  assert.equal(page.url(), reviewURL);
  await page.goForward();
  await (await htmlAction(page, "button", "Start review")).waitFor();
  assert.equal(page.url(), originalURL);
  assert.equal(await page.locator("html").getAttribute("data-enhanced"), "yes");
  assert.deepEqual(
    await page.evaluate(() => ({
      local: Object.keys(localStorage),
      session: Object.keys(sessionStorage),
    })),
    { local: [], session: [] },
  );
  assert.deepEqual(apiRequests, []);
  assert.deepEqual(b.errors, []);
});

await test("ordinary forms and direct URLs work without JavaScript; GET actions do not mutate", async (t) => {
  const f = await fixture(t);
  const b = await browserFixture(t, f.sessions);
  const browserContext = await b.browser.newContext({ javaScriptEnabled: false });
  t.after(() => browserContext.close());
  const page = await browserContext.newPage();
  await page.goto(`${b.base}/sessions`);
  await page.getByRole("button", { name: "Create session", exact: true }).click();
  await page.locator("[data-events] #composer").waitFor();
  const [info] = (await f.sessions.catalog()).sessions;
  const session = await f.sessions.get(info.id);
  assert.equal(page.url(), b.base + conversationURL(session));
  await openSessions(page);
  await page.locator("#session-filter").fill("no matching session");
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  assert.equal(await page.locator("#session-list > .session").count(), 0);
  await page.locator("#session-filter").fill(info.id);
  await page.getByRole("button", { name: "Filter", exact: true }).click();
  assert.equal(await page.locator("#session-list > .session").count(), 1);
  await page.locator("#session-list > .session").click();
  const initial = await readHistory(session.root);
  for (const operation of ["submit", "review", "end-review", "abort", "resume"]) {
    const response = await fetch(`${page.url()}/${operation}`);
    assert.equal(response.status, 405);
  }
  assert.deepEqual(await readHistory(session.root), initial);
  assert.equal(await session.harness.snapshot(Review, session.root.id, context), undefined);
  f.faux.setResponses([fauxAssistantMessage("Submitted without JS.")]);
  await page.getByRole("textbox", { name: "Message" }).fill("Ordinary form");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.locator("[data-events] #composer").waitFor();
  await session.root.waitForIdle(context);
  await page.reload();
  assert.equal(await page.locator("#transcript article").count(), 3);
  f.faux.setResponses([fauxAssistantMessage("No findings.")]);
  await (await htmlAction(page, "button", "Start review")).click();
  await (await htmlAction(page, "link", "Visit original")).waitFor();
  const reviewURL = page.url();
  await (await htmlAction(page, "link", "Visit original")).click();
  await (await htmlAction(page, "link", "Open review")).click();
  assert.equal(page.url(), reviewURL);
  const id = (await session.harness.snapshot(Review, session.root.id, context))?.active;
  assert(id !== undefined);
  await (await session.harness.conversation(id, context))!.waitForIdle(context);
  f.faux.setResponses([fauxAssistantMessage("Received.")]);
  await (await htmlAction(page, "button", "End review and return")).click();
  await page.locator("[data-events] #composer").waitFor();
  assert.equal(page.url(), b.base + conversationURL(session));
  await session.root.waitForIdle(context);
});

await test("ending an active review aborts it; a disconnected page does not interrupt work", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const b = await browserFixture(t, f.sessions);
  await b.page.setViewportSize({ width: 820, height: 844 });
  await b.page.goto(b.base + conversationURL(session));
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 30" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Review cancelled."),
  ]);
  await (await htmlAction(b.page, "button", "Start review")).click();
  await (await htmlAction(b.page, "button", "End review and return")).waitFor();
  const id = (await session.harness.snapshot(Review, session.root.id, context))?.active;
  assert(id !== undefined);
  await waitFor(
    async () => !!(await session.harness.snapshot(LiveDoc, id, context))?.tools?.length,
  );
  await (await htmlAction(b.page, "link", "Visit original")).click();
  await (await htmlAction(b.page, "link", "Open review")).waitFor();
  assert((await session.harness.snapshot(LiveDoc, id, context))?.run);
  await (await htmlAction(b.page, "link", "Open review")).click();
  await (await htmlAction(b.page, "button", "End review and return")).click();
  await b.page.waitForURL(b.base + conversationURL(session));
  await session.root.waitForIdle(context);
  assert.equal((await session.harness.snapshot(LiveDoc, id, context))?.run, undefined);
  assert.equal(
    (await readHistory(session.root)).filter((entry) => entry.kind === "app.review").length,
    1,
  );
  assert.deepEqual(b.errors, []);
});

await test("committed fragments preserve history, drafts, attachments, focus and disclosure; output is inert", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const attack =
    '<img src=x onerror="window.injected=true"><form hx-post="/sessions"><button>Injected</button></form><script>window.injected=true</script>';
  await session.root.commit(
    (tx) =>
      tx.appendEntry(session.root.id, {
        kind: "message",
        model: [
          fauxAssistantMessage([
            { type: "thinking", thinking: "Keep this thought" },
            fauxToolCall("bash", { command: "printf preserved" }, { id: "preserved" }),
            { type: "text", text: attack + "\n" + "Completed history\n".repeat(100) },
          ]),
        ],
      }),
    context,
  );
  const b = await browserFixture(t, f.sessions);
  const { page } = b;
  await page.goto(b.base + conversationURL(session));
  await page.waitForFunction(
    () => document.querySelector("#connection")?.textContent === "Connected",
  );
  await page.locator("#transcript .tool-call > summary").click();
  const text = page.getByRole("textbox", { name: "Message" });
  await text.fill("Keep this draft");
  await page.locator('input[type="file"]').setInputFiles({
    name: "pixel.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6Z9kAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await page.locator("#previews img").waitFor();
  await text.focus();
  await page.evaluate(() => {
    scrollTo(0, 0);
  });
  const before = await page.evaluateHandle(() => ({
    entry: document.querySelector("#transcript article"),
    composer: document.querySelector("#composer"),
    file: document.querySelector<HTMLInputElement>('input[type="file"]')!.files![0],
    focus: document.activeElement,
  }));
  for (let i = 1; i <= 3; i++) {
    await session.root.commit(async (tx) => {
      const live = await tx.doc(LiveDoc, session.root.id);
      live.generation = {
        attempt: i,
        message: partial(attack + "\r\ndata: still text\r\n" + " ".repeat(i)),
      };
    }, context);
    await page.waitForFunction(
      (content) => document.querySelector("#live .text")?.textContent === content,
      attack + "\ndata: still text\n" + " ".repeat(i),
    );
    assert.deepEqual(
      await page.evaluate(
        (before) => ({
          entry: before.entry === document.querySelector("#transcript article"),
          composer: before.composer === document.querySelector("#composer"),
          file:
            before.file ===
            document.querySelector<HTMLInputElement>('input[type="file"]')!.files![0],
          focus: before.focus === document.activeElement,
          draft: document.querySelector<HTMLTextAreaElement>("#composer textarea[name=content]")!
            .value,
          disclosure: document.querySelector<HTMLDetailsElement>("#transcript details")!.open,
          scroll: scrollY,
          injected: Object.hasOwn(window, "injected"),
          activeOutput: document.querySelectorAll(
            "#transcript script, #transcript .text form, #transcript img, #live script, #live form, #live img",
          ).length,
        }),
        before,
      ),
      {
        entry: true,
        composer: true,
        file: true,
        focus: true,
        draft: "Keep this draft",
        disclosure: true,
        scroll: 0,
        injected: false,
        activeOutput: 0,
      },
    );
  }
  // A selection in completed output survives live tool output too.
  const selection = await page.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector("#transcript .text")!);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    return getSelection()!.toString();
  });
  await session.root.commit(async (tx) => {
    const live = await tx.doc(LiveDoc, session.root.id);
    delete live.generation;
    live.tools = [{ callId: "test", name: "bash", status: "running", output: attack }];
  }, context);
  await page.waitForFunction(
    (attack) => document.querySelector("#live .tool-result > pre > code")?.textContent === attack,
    attack,
  );
  assert.equal(await page.evaluate(() => getSelection()!.toString()), selection);
  assert.equal(await page.locator("#live img, #live form, #live script").count(), 0);
  await before.dispose();
  const requestId = await page.locator('#composer [name="requestId"]').inputValue();
  await openSessions(page);
  await page.locator(`a[href="/sessions/${session.id}"]`).click();
  await page.locator("#previews img").waitFor();
  assert.equal(await text.inputValue(), "Keep this draft");
  assert.equal(await page.locator('#composer [name="requestId"]').inputValue(), requestId);
  assert.equal(
    await page
      .locator('input[type="file"]')
      .evaluate((input: HTMLInputElement) => input.files?.[0].name),
    "pixel.png",
  );
  assert.deepEqual(b.errors, []);
});

await test("lost submission response retains retry identity; unrelated updates never acknowledge a draft", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const b = await browserFixture(t, f.sessions);
  const { page } = b;
  await page.goto(b.base + conversationURL(session));
  f.faux.setResponses([fauxAssistantMessage("Once.")]);
  const text = page.getByRole("textbox", { name: "Message" });
  await text.fill("Do this once");
  const requestId = await page.locator('#composer [name="requestId"]').inputValue();
  await page.route(
    "**/submit",
    async (route) => {
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      await route.abort("connectionfailed");
    },
    { times: 1 },
  );
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.waitForFunction(() => !!document.querySelector("#request-error")?.textContent);
  await session.root.waitForIdle(context);
  assert.equal(await text.inputValue(), "Do this once");
  assert.equal(await page.locator('#composer [name="requestId"]').inputValue(), requestId);
  const history = await readHistory(session.root);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLTextAreaElement>("#composer textarea[name=content]")?.value === "",
  );
  assert.deepEqual(await readHistory(session.root), history);
  assert.equal(f.faux.state.callCount, 1);
  // Empty submissions are disabled locally; HTTP validation is covered separately.
  assert.equal(await page.getByRole("button", { name: "Send", exact: true }).isDisabled(), true);
  assert.equal(await page.locator("#composer").count(), 1);
  assert.equal(await page.locator("#transcript article").count(), history.length);
  assert.deepEqual(b.errors, []);
});

await test("reconnect reconciles generation, reset and compaction-style heads without duplicate entries", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const first = await session.root.commit(
    (tx) =>
      tx.appendEntry(session.root.id, {
        kind: "message",
        model: [fauxAssistantMessage("Before disconnect")],
      }),
    context,
  );
  const b = await browserFixture(t, f.sessions);
  const { page } = b;
  // Real TCP disconnects exercise hx-sse retry. Chromium offline
  // emulation does not reliably close an already established SSE connection.
  const connections = new Set<ServerResponse>();
  const heads: { url: string | null; last: string | string[] | undefined }[] = [];
  const server = httpServer(f.sessions, "127.0.0.1", b.assets);
  server.on("request", (request, response) => {
    if (request.url && new URL(request.url, "http://localhost").pathname.endsWith("/events")) {
      heads.push({
        url: new URL(request.url, "http://localhost").searchParams.get("head"),
        last: request.headers["last-event-id"],
      });
      connections.add(response);
      response.once("close", () => connections.delete(response));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await page.goto(base + conversationURL(session));
  await page.waitForFunction(
    () => document.querySelector("#connection")?.textContent === "Connected",
  );
  const firstNode = await page.locator(`#entry-${first.id}`).elementHandle();
  assert(firstNode);
  await page.getByRole("textbox", { name: "Message" }).fill("Still unsent");
  assert.deepEqual(heads[0], { url: `${first.id}.0`, last: undefined });
  for (const mode of ["append", "reset", "compact"] as const) {
    const previousTail = (await readHistory(session.root)).at(-1)!.id;
    for (const response of connections) response.destroy();
    await page.waitForFunction(
      () => document.querySelector("#connection")?.textContent !== "Connected",
    );
    const history = await readHistory(session.root);
    const head = mode === "append" ? undefined : mode === "reset" ? "self" : history.at(-1)!.id;
    await session.root.commit(async (tx) => {
      await tx.appendEntry(session.root.id, {
        kind: "test.marker",
        ...(head === undefined ? {} : { head }),
      });
      const live = await tx.doc(LiveDoc, session.root.id);
      live.generation = { attempt: 1, message: partial(`Disconnected at ${head}`) };
    }, context);
    const watch = await session.root.watch(context);
    const expected = (await readHistory(session.root)).map((entry) => String(entry.id));
    await watch.stop();

    await page.waitForFunction((expected) => {
      const actual = Array.from(
        document.querySelectorAll<HTMLElement>("#transcript article"),
        (node) => node.dataset.entry,
      );
      return (
        actual.length === expected.length && actual.every((id, index) => id === expected[index])
      );
    }, expected);
    assert.deepEqual(heads.at(-1), { url: `${first.id}.0`, last: `${previousTail}.0` });
    assert.equal(await page.getByRole("textbox", { name: "Message" }).inputValue(), "Still unsent");
    assert.equal(
      await firstNode.evaluate((node) => node === document.querySelector(`#${node.id}`)),
      true,
    );
  }
  await firstNode.dispose();
  assert.deepEqual(b.errors, []);
});

await test("pending review response cannot navigate a newer page; review subscriptions clean up", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  let subscriptions = 0;
  const subscribe = session.harness.subscribeCommits.bind(session.harness);
  session.harness.subscribeCommits = (listener) => {
    subscriptions++;
    const stop = subscribe(listener);
    let stopped = false;
    return () => {
      if (!stopped) {
        stopped = true;
        subscriptions--;
        stop();
      }
    };
  };
  const b = await browserFixture(t, f.sessions);
  await b.page.setViewportSize({ width: 820, height: 844 });
  const { page } = b;
  await page.goto(`${b.base}/sessions`);
  await page.locator(`a[href="/sessions/${session.id}"]`).click();
  await page.waitForFunction(
    () => document.querySelector("#connection")?.textContent === "Connected",
  );
  assert.equal(subscriptions, 1);
  f.faux.setResponses([fauxAssistantMessage("No findings.")]);
  const pending = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const delivered = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  await page.route("**/review", async (route) => {
    const response = await route.fetch();
    pending.resolve();
    await release.promise;
    await route.fulfill({ response });
    delivered.resolve();
  });
  await (await htmlAction(page, "button", "Start review")).click();
  await pending.promise;
  // Creation of the formerly absent Review document must update another view.
  await (await htmlAction(page, "link", "Open review")).waitFor();
  // htmx history restores with outerSync: #page itself stays connected.
  await page.goBack();
  await page.getByRole("button", { name: "Create session", exact: true }).waitFor();
  await page.waitForURL(`${b.base}/sessions`);
  await waitFor(async () => subscriptions === 0);
  release.resolve();
  await delivered.promise;
  // Wait for the actual old response's lifecycle, not an arbitrary timeout.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        if (!document.querySelector(".htmx-request")) resolve();
        else document.addEventListener("htmx:finally:request", () => resolve(), { once: true });
      }),
  );
  assert.equal(page.url(), `${b.base}/sessions`);
  assert.equal(await page.locator("[data-events]").count(), 0);
  assert.equal(subscriptions, 0);
  assert.deepEqual(b.errors, []);
});

await test("HTML projection measurements: same 150-entry, 40-update workload as the renderer baseline", async (t) => {
  const { benchmarkFixture } = await import("../benchmark.ts");
  const { ConversationFragments } = await import("../hypermedia.ts");
  const { copyJson } = await import("@earendil-works/chord");
  const { readFile } = await import("node:fs/promises");
  const { gzipSync } = await import("node:zlib");
  const f = await fixture(t);
  const session = await f.create();
  const b = await browserFixture(t, f.sessions);
  await b.page.route(/\/events(?:\?.*)?$/, (route) =>
    route.fulfill({ contentType: "text/event-stream", body: "retry: 3600000\n\n" }),
  );
  await b.page.goto(b.base + conversationURL(session));
  const frontend = await b.page.evaluateHandle<Htmx>("htmx");
  const view = benchmarkFixture(50).view;
  const renderer = new ConversationFragments(conversationURL(session));
  const frames: string[] = [renderer.render(view, {})];
  let jsonBytes = Buffer.byteLength(`data: ${JSON.stringify({ value: view, ops: [] })}\n\n`);
  let jsonEncodeMs = 0;
  for (let update = 1; update <= 40; update++) {
    const value = {
      ...view,
      docs: {
        "pi.live": {
          run: { taskId: 1, inputs: [] },
          generation: {
            attempt: 1,
            message: copyJson(partial("An incremental update. ".repeat(update))),
          },
        },
      },
    };
    const start = performance.now();
    const json = `data: ${JSON.stringify({ value, ops: [] })}\n\n`;
    jsonEncodeMs += performance.now() - start;
    jsonBytes += Buffer.byteLength(json);
    frames.push(renderer.render(value, {}));
  }
  const browserMs: number[] = [];
  for (const html of frames)
    browserMs.push(
      await b.page.evaluate(
        async ({ frontend, html }) => {
          const root = document.querySelector<HTMLElement>("[data-events]")!;
          const start = performance.now();
          await frontend.swap({ sourceElement: root, target: root, swap: "none", text: html });
          root.getBoundingClientRect();
          return performance.now() - start;
        },
        { frontend, html },
      ),
    );
  await frontend.dispose();
  const assets: Record<string, { bytes: number; gzip: number }> = {};
  for (const name of [
    "htmx.js",
    "hypermedia-client.js",
    "hypermedia.css",
    "client.js",
    "styles.css",
    "highlight.js",
  ]) {
    const content = await readFile(join(b.assets, name));
    assets[name] = { bytes: content.length, gzip: gzipSync(content).length };
  }
  assert.equal(renderer.metrics.entries, 150);
  assert.equal(await b.page.locator("#transcript article").count(), 150);
  assert.deepEqual(b.errors, []);
  t.diagnostic(
    JSON.stringify({
      benchmark: "hypermedia.poc",
      entries: 150,
      updates: 40,
      // Exact SSE framing, uncompressed. JSON is a lower bound: excludes real ops
      // and the original client's supplementary HTTP reads. No network in timers.
      htmlWireBytes: frames.reduce(
        (sum, html) =>
          sum + Buffer.byteLength(`data: ${html.replace(/\r\n?|\n/g, "\ndata: ")}\n\n`),
        0,
      ),
      jsonWireBytesLowerBound: jsonBytes,
      jsonUpdateEncodeMs: jsonEncodeMs,
      projection: renderer.metrics,
      initialBrowserMs: browserMs[0],
      updateBrowserMs: browserMs.slice(1),
      assets,
      caveat:
        "Rich server-rendered transcript; layouts are not pixel-equivalent. Browser timers include parsing, reconciliation and synchronous layout, not network or paint.",
    }),
  );
});

await test("image submission reaches Durable; generation completes after the HTML page disconnects", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const b = await browserFixture(t, f.sessions);
  const gate = Promise.withResolvers<void>();
  t.after(() => gate.resolve());
  const entered = Promise.withResolvers<void>();
  const image = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6Z9kAAAAASUVORK5CYII=",
    "base64",
  );
  f.faux.setResponses([
    async ({ messages }) => {
      const input = messages.findLast((message) => message.role === "user");
      assert(input?.role === "user" && Array.isArray(input.content));
      assert.deepEqual(input.content, [
        { type: "text", text: "Inspect this image" },
        { type: "image", mimeType: "image/png", data: image.toString("base64") },
      ]);
      entered.resolve();
      await gate.promise;
      return fauxAssistantMessage("Completed after disconnect.");
    },
  ]);
  await b.page.goto(b.base + conversationURL(session));
  await b.page.getByRole("textbox", { name: "Message" }).fill("Inspect this image");
  await b.page
    .locator('input[type="file"]')
    .setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: image });
  await b.page.getByRole("button", { name: "Send", exact: true }).click();
  await entered.promise;
  await b.page.waitForFunction(
    () => document.querySelector<HTMLInputElement>('input[type="file"]')?.files?.length === 0,
  );
  await b.page.close();
  assert((await session.harness.snapshot(LiveDoc, session.root.id, context))?.run);
  gate.resolve();
  await session.root.waitForIdle(context);
  const messages = (await readHistory(session.root)).flatMap((entry) => entry.model ?? []);
  assert.equal(messages.filter((message) => message.role === "assistant").length, 1);
  assert.equal(f.faux.state.callCount, 1);
  assert.equal((await session.harness.snapshot(LiveDoc, session.root.id, context))?.run, undefined);
});
