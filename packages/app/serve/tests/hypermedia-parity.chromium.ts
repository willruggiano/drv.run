import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxToolCall,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Review } from "harness";
import { GlobalSettingsStore } from "../server.ts";
import { conversationURL } from "../hypermedia.ts";
import { modelKey, targetKey } from "../hypermedia-forms.ts";
import { sessionInfo, Sessions } from "../sessions.ts";
import {
  browserFixture,
  htmlAction,
  htmlMessageActions,
  returnToConversation,
} from "./browser-testing.ts";
import { fixture, readHistory, waitFor, model } from "./sessions-testing.ts";
import { directoryFixture, serve } from "./testing.ts";

const context = BACKGROUND_CONTEXT;

await test("HTML native settings, fork, reset, archive, context and export preserve Durable state", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  f.faux.setResponses([fauxAssistantMessage("Original history.")]);
  await (
    await session.root.submit({ type: "input", content: "Seed history." }, context)
  ).wait(context);
  const records = await readHistory(session.root);
  const b = await browserFixture(t, f.sessions);
  const native = await b.browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 820, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  t.after(() => native.close());
  const page = await native.newPage();
  page.setDefaultTimeout(10000);
  const path = conversationURL(session);
  await page.goto(b.base + path + "/settings");
  await page.locator('[name="name"]').fill("Renamed session");
  await page.locator('[name="instructions"]').fill("Keep changes surgical.");
  await page.selectOption('[name="thinkingLevel"]', "high");
  await page.getByRole("button", { name: "Save settings" }).click();
  assert.equal((await sessionInfo(session)).name, "Renamed session");
  assert.equal((await session.root.agent(context)).thinkingLevel, "high");
  assert.equal((await session.root.agent(context)).instructions, "Keep changes surgical.");
  await returnToConversation(page);
  await page.locator(`#entry-${records.at(-1)!.id} .entry-actions > summary`).click();
  await page
    .locator(`#entry-${records.at(-1)!.id}`)
    .getByRole("button", { name: "Fork here" })
    .click();
  const branchId = Number(new URL(page.url()).pathname.split("/").at(-1));
  assert.notEqual(branchId, session.root.id);
  const branch = await session.harness.conversation(branchId as typeof session.root.id, context);
  assert(branch);
  assert.deepEqual(await readHistory(branch), records);
  await (await htmlAction(page, "link", "Reset")).click();
  assert.deepEqual(await readHistory(branch), records);
  await page.locator('textarea[name="argument"]').fill("Continue with a clean context.");
  await page.getByRole("button", { name: "Confirm reset" }).click();
  const after = await readHistory(branch);
  assert.equal(after.at(-1)?.kind, "pi.reset");
  assert.equal(await page.locator(".context-history article").count(), records.length);
  assert.equal(
    await page.locator(".context-event").evaluate((node: HTMLDetailsElement) => node.open),
    false,
  );
  await page.getByRole("link", { name: "Context usage details", exact: true }).click();
  assert.equal(
    await page.locator("#context-view").getAttribute("data-conversation"),
    String(branchId),
  );
  assert.equal(
    await page.locator("#context-view").getAttribute("data-tail"),
    String(after.at(-1)!.id),
  );
  const exported = await fetch(b.base + conversationURL(session, branch.id) + "/export");
  assert.equal(exported.status, 200);
  assert.deepEqual(await exported.json(), after);
  assert.deepEqual(await readHistory(session.root), records);
});

await test("HTML session autosaves drain before navigation, retain drafts and recover from failed saves", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const b = await browserFixture(t, f.sessions);
  const { page } = b;
  page.setDefaultTimeout(10000);
  const path = conversationURL(session);
  await page.goto(b.base + path);
  await page.locator('#composer [name="content"]').fill("Unsent draft");
  await page.getByRole("link", { name: "Model and thinking settings", exact: true }).click();
  const requested = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  await page.route("**/settings", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    requested.resolve();
    await release.promise;
    await route.continue();
  });
  await page.locator('[name="instructions"]').fill("Persist before leaving.");
  await returnToConversation(page);
  await requested.promise;
  assert.equal(new URL(page.url()).pathname, path + "/settings");
  release.resolve();
  await page.waitForURL(b.base + path);
  assert.equal((await session.root.agent(context)).instructions, "Persist before leaving.");
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLTextAreaElement>('#composer [name="content"]')?.value ===
      "Unsent draft",
  );
  await page.unroute("**/settings");
  await page.getByRole("link", { name: "Model and thinking settings", exact: true }).click();
  await page.route("**/settings", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 503,
      contentType: "text/html",
      body: '<p id="form-error">Unavailable</p>',
    });
  });
  await page.locator('[name="instructions"]').fill("Retry this change.");
  await returnToConversation(page);
  await page.waitForFunction(
    () => document.querySelector<HTMLFormElement>("#session-settings")?.dataset.failed === "true",
  );
  assert.equal(new URL(page.url()).pathname, path + "/settings");
  assert.equal((await session.root.agent(context)).instructions, "Persist before leaving.");
  assert.equal(await page.locator('[name="instructions"]').inputValue(), "Retry this change.");
  await page.unroute("**/settings");
  await page.getByRole("button", { name: "Save settings" }).click();
  await waitFor(
    async () => (await session.root.agent(context)).instructions === "Retry this change.",
  );
  assert.deepEqual(b.errors, []);
});

await test("HTML shared defaults persist and do not change existing conversation configuration", async (t) => {
  const f = await fixture(t);
  await f.sessions.close();
  const plain = fauxProvider({ provider: "plain", models: [{ id: "plain", reasoning: false }] });
  f.options.models.setProvider(plain.provider);
  const store = new GlobalSettingsStore(
    SettingsManager.inMemory({ defaultProvider: model.provider, defaultModel: model.modelId }),
  );
  const sessions = await Sessions.open(store.bind(f.options));
  t.after(() => sessions.close());
  const session = await sessions.create(crypto.randomUUID(), f.binding, model);
  const b = await browserFixture(t, sessions);
  const base = await serve(t, sessions, b.assets, "127.0.0.1", store);
  const { page } = b;
  page.setDefaultTimeout(10000);
  await page.goto(base + "/sessions/settings");
  await page.selectOption('[name="defaultThinkingLevel"]', "low");
  await waitFor(async () => store.read().values.defaultThinkingLevel === "low");
  await page.selectOption('[name="hideThinkingBlock"]', "true");
  await waitFor(async () => store.read().values.hideThinkingBlock === true);
  await page.selectOption('[name="model"]', modelKey({ provider: "plain", modelId: "plain" }));
  await waitFor(async () => store.read().model?.provider === "plain");
  assert.deepEqual((await session.root.agent(context)).model, model);
  await page.keyboard.press("Escape");
  assert.equal(
    await page.locator('[name="model"]').inputValue(),
    modelKey({ provider: "plain", modelId: "plain" }),
  );
  assert.deepEqual(
    await page
      .locator('[name="thinkingLevel"] option')
      .evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value)),
    ["", "off"],
  );
  await page.getByRole("button", { name: "Create session", exact: true }).click();
  await page.locator("[data-events] #composer").waitFor();
  const created = (await sessions.catalog()).sessions.find((item) => item.id !== session.id)!;
  assert(created);
  assert.equal(created.model?.provider, "plain");
  assert.equal(created.thinkingLevel, "off");
  assert.equal(
    await page.locator("body").evaluate((node) => node.classList.contains("hide-thinking")),
    true,
  );
  assert.deepEqual(b.errors, []);
});

await test("HTML scoped review command uses the shared review input without submitting slash text", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const before = await readHistory(session.root);
  const b = await browserFixture(t, f.sessions);
  await b.page.goto(b.base + conversationURL(session));
  f.faux.setResponses([fauxAssistantMessage("No findings.")]);
  await b.page.getByRole("textbox", { name: "Message" }).fill("/review packages/app");
  await b.page.getByRole("button", { name: "Send", exact: true }).click();
  await (await htmlAction(b.page, "button", "End review and return")).waitFor();
  const state = await session.harness.snapshot(Review, session.root.id, context);
  assert(state?.active !== undefined);
  const review = await session.harness.conversation(state.active, context);
  assert(review);
  await review.waitForIdle(context);
  assert.deepEqual(
    (await readHistory(review))
      .flatMap((entry) => entry.model ?? [])
      .filter((message) => message.role === "user")
      .map((message) => message.content),
    ["Review the packages/app and provide prioritized findings."],
  );
  assert.deepEqual(await readHistory(session.root), before);
  assert.deepEqual(b.errors, []);
});

await test("HTML declarative completions reject stale and dismissed requests and preserve IME and keyboard behavior", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const b = await browserFixture(t, f.sessions);
  const { page } = b;
  await page.goto(b.base + conversationURL(session));
  const requested = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const returned = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  await page.route("**/completions?**", async (route) => {
    if (new URL(route.request().url()).searchParams.get("query") !== "re") return route.continue();
    const response = await route.fetch();
    requested.resolve();
    await release.promise;
    await route.fulfill({ response });
    returned.resolve();
  });
  const text = page.getByRole("textbox", { name: "Message" });
  await text.fill("/re");
  await requested.promise;
  await text.fill("/se");
  await page.locator('[data-completion="/settings "]').waitFor();
  release.resolve();
  await returned.promise;
  assert.deepEqual(
    await page
      .locator("#completions [data-completion]")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-completion"))),
    ["/sessions ", "/settings ", "/search "],
  );
  await text.press("ArrowDown");
  await text.press("Tab");
  assert.equal(await text.inputValue(), "/settings ");
  await page.unroute("**/completions?**");
  const cancelled = (mode: "dismiss" | "compose") =>
    page.evaluate(async (mode) => {
      const text = document.querySelector<HTMLTextAreaElement>("#prompt")!;
      const configured = new Promise<boolean>((resolve) => {
        const listener = (event: DocumentEventMap["htmx:config:request"]) => {
          if (event.detail.ctx.sourceElement !== text) return;
          document.removeEventListener("htmx:config:request", listener);
          resolve(event.defaultPrevented);
        };
        document.addEventListener("htmx:config:request", listener);
      });
      text.value = mode === "dismiss" ? "/re" : "/co";
      text.dispatchEvent(
        new InputEvent("input", { bubbles: true, isComposing: mode === "compose" }),
      );
      if (mode === "dismiss")
        text.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      return configured;
    }, mode);
  assert.equal(await cancelled("dismiss"), true);
  assert.equal(await page.locator("#completions").isVisible(), false);
  assert.equal(await cancelled("compose"), true);
  await text.dispatchEvent("compositionend");
  await page.locator('[data-completion="/compact "]').waitFor();
  await text.press("Enter");
  assert.equal(await text.inputValue(), "/compact ");
  assert.deepEqual(await readHistory(session.root), []);
  assert.deepEqual(b.errors, []);
});

await test("HTML target directory selection, path completions and slash activation use advertised controls", async (t) => {
  const f = await directoryFixture(t);
  await mkdir(join(f.workspace, "project"));
  await writeFile(join(f.workspace, "project", "file name.ts"), "export {};\n");
  const b = await browserFixture(t, f.sessions);
  const { page } = b;
  page.setDefaultTimeout(10000);
  await page.goto(b.base + "/sessions");
  await page.locator("#new-options > summary").click();
  await page.selectOption('[name="target"]', targetKey(f.binding));
  await page.locator('[name="baseDirectory"]').fill("project");
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll<HTMLOptionElement>("#directories option")).some(
      (option) => option.value === "project/",
    ),
  );
  await page.getByRole("button", { name: "Create session", exact: true }).click();
  await page.locator("[data-events] #composer").waitFor();
  const [info] = (await f.sessions.catalog()).sessions;
  const session = await f.sessions.get(info.id);
  assert.equal(info.cwd, join(f.workspace, "project"));
  const text = page.locator('#composer [name="content"]');
  await text.fill("Inspect @file");
  await page.locator("#completions [data-completion]").waitFor();
  await text.press("Tab");
  assert.equal(await text.inputValue(), 'Inspect @"file name.ts" ');
  f.faux.setResponses([fauxAssistantMessage("No findings.")]);
  await text.fill("/review");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.locator('[data-command="endreview"]').waitFor({ state: "attached" });
  const review = await session.harness.snapshot(Review, session.root.id, context);
  assert(review?.active !== undefined);
  const reviewConversation = await session.harness.conversation(review.active, context);
  assert(reviewConversation);
  await reviewConversation.waitForIdle(context);
  await text.fill("/endrev");
  await page.locator("#completions [data-completion]").waitFor();
  await text.press("Tab");
  assert.equal(await text.inputValue(), "/endreview ");
  f.faux.setResponses([fauxAssistantMessage("Received.")]);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.waitForURL(b.base + conversationURL(session));
  await session.root.waitForIdle(context);
  await text.fill("/reset Preserve the handoff.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("button", { name: "Confirm reset" }).waitFor();
  assert.equal(
    await page.locator('textarea[name="argument"]').inputValue(),
    "Preserve the handoff.",
  );
  const before = await readHistory(session.root);
  assert.notEqual(before.at(-1)?.kind, "pi.reset");
  await returnToConversation(page);
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLTextAreaElement>('#composer [name="content"]')?.value ===
      "/reset Preserve the handoff.",
  );
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("button", { name: "Confirm reset" }).waitFor();
  await page.getByRole("button", { name: "Confirm reset" }).click();
  await page.locator("[data-events] #composer").waitFor();
  assert.equal((await readHistory(session.root)).at(-1)?.kind, "pi.reset");
  assert.deepEqual(b.errors, []);
});

await test("HTML rich transcript has paired tools, local copy/quote/search, images and bounded responsive layout", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  f.faux.setResponses([
    fauxAssistantMessage(
      [
        { type: "thinking", thinking: "Consider the source." },
        fauxToolCall("bash", { command: "printf 'tool result\\n'" }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      "## Result\n\n**Done** with `bash`.\n\n```typescript\nconst answer = 42;\n```",
    ),
  ]);
  await (
    await session.root.submit({ type: "input", content: "Read the source." }, context)
  ).wait(context);
  const b = await browserFixture(t, f.sessions);
  const { page } = b;
  page.setDefaultTimeout(10000);
  await b.browserContext.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(b.base + conversationURL(session));
  await page.locator('.tool-call[data-state="completed"]').waitFor();
  assert.equal(await page.locator(".tool-call").count(), 1);
  const details = page.locator(".tool-call");
  await details.locator(":scope > summary").click();
  await (
    await htmlMessageActions(page, details)
  )
    .getByRole("button", { name: "Copy output", exact: true })
    .click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "tool result\n");
  await (
    await htmlMessageActions(page, details)
  )
    .getByRole("button", { name: "Quote output", exact: true })
    .click();
  assert.equal(
    await page.locator('#composer [name="content"]').inputValue(),
    "> tool result\n> \n\n",
  );
  await page.locator('#composer [name="content"]').fill("");
  const answer = page.locator("article").filter({ has: page.locator("h3") });
  await (
    await htmlMessageActions(page, answer)
  )
    .getByRole("button", { name: "Quote", exact: true })
    .click();
  assert.equal(
    (await page.locator('#composer [name="content"]').inputValue()).startsWith("> ## Result"),
    true,
  );
  await page.keyboard.press("Control+f");
  await page.locator("#search").fill("tool result");
  assert.equal(await page.locator(".search-current").count(), 1);
  await page.locator("#search").press("Escape");
  await page.locator('code[data-language="typescript"] .hljs-keyword').waitFor();
  assert.equal(
    await page
      .locator("time[datetime]")
      .evaluateAll((nodes) =>
        nodes.every((node) => !!node.textContent && !!(node as HTMLElement).title),
      ),
    true,
  );
  const userMessage = page.locator('#transcript article[data-role="user"]').first();
  await htmlMessageActions(page, userMessage);
  await page.keyboard.press("Escape");
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <= innerWidth &&
          document.documentElement.scrollHeight <= innerHeight,
      ),
      true,
    );
    assert.equal(await page.getByRole("button", { name: "Send", exact: true }).isVisible(), true);
  }
  await page.locator('#composer [name="content"]').fill("Keep");
  await page.locator('#composer [name="content"]').evaluate((node: HTMLTextAreaElement) => {
    node.maxLength = 5;
  });
  await (
    await htmlMessageActions(page, userMessage)
  )
    .getByRole("button", { name: "Quote", exact: true })
    .click();
  assert.equal(await page.locator('#composer [name="content"]').inputValue(), "Keep");
  await page.locator('#composer [name="content"]').evaluate((node: HTMLTextAreaElement) => {
    node.maxLength = 100000;
  });
  const composer = page.locator('#composer [name="content"]');
  await composer.fill("One line");
  await composer.press("Enter");
  assert.equal(await composer.inputValue(), "One line\n");
  f.faux.setResponses([fauxAssistantMessage("Keyboard submission.")]);
  await composer.press("Control+Enter");
  await page.waitForFunction(
    () => document.querySelector<HTMLTextAreaElement>('#composer [name="content"]')?.value === "",
  );
  await session.root.waitForIdle(context);
  const user = (await readHistory(session.root))
    .flatMap((record) => record.model ?? [])
    .findLast((message) => message.role === "user");
  assert.equal(user?.content, "One line\n");
  assert.deepEqual(b.errors, []);
});

await test("HTML draft reload and offline shell never persist conversation representations", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const b = await browserFixture(t, f.sessions);
  const { page } = b;
  page.setDefaultTimeout(10000);
  await page.goto(b.base + conversationURL(session));
  await page.locator('#composer [name="content"]').fill("Unsent across reload");
  const requestId = await page.locator('#composer [name="requestId"]').inputValue();
  await page.reload();
  assert.equal(
    await page.locator('#composer [name="content"]').inputValue(),
    "Unsent across reload",
  );
  assert.equal(await page.locator('#composer [name="requestId"]').inputValue(), requestId);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  const cached = await page.evaluate(async () =>
    (
      await Promise.all(
        (
          await caches.keys()
        ).map(async (key) =>
          (await (await caches.open(key)).keys()).map((request) => new URL(request.url).pathname),
        ),
      )
    ).flat(),
  );
  assert(cached.includes("/sessions/offline"));
  assert.equal(
    cached.some((path) => path.includes(session.id)),
    false,
  );
  assert.equal(cached.includes("/sessions"), false);
  await b.browserContext.setOffline(true);
  await page.reload();
  assert.equal(await page.locator("[data-events]").count(), 0);
  assert.equal(await page.getByRole("link", { name: "Reconnect", exact: true }).isVisible(), true);
  await b.browserContext.setOffline(false);
  await page.goto(b.base + conversationURL(session));
  assert.equal(
    await page.locator('#composer [name="content"]').inputValue(),
    "Unsent across reload",
  );
  assert.deepEqual(b.errors, []);
});

await test("HTML compaction uses committed summaries and durations without replacing completed entry nodes", async (t) => {
  const f = await fixture(t);
  await f.reopen({ ...f.options, settings: { compaction: { keepRecentTokens: 1 } } });
  const session = await f.create();
  f.faux.setResponses([
    fauxAssistantMessage("First response."),
    fauxAssistantMessage("Second response."),
  ]);
  for (const text of ["First ".repeat(1000), "Second ".repeat(1000)])
    await (await session.root.submit({ type: "input", content: text }, context)).wait(context);
  const records = await readHistory(session.root);
  const b = await browserFixture(t, f.sessions);
  const { page } = b;
  page.setDefaultTimeout(10000);
  await page.goto(b.base + conversationURL(session));
  await page.waitForFunction(
    () => document.querySelector("#connection")?.textContent === "Connected",
  );
  const first = await page.locator(`#entry-${records[0].id}`).elementHandle();
  assert(first);
  f.faux.setResponses([fauxAssistantMessage("Summary of the completed work.")]);
  await page.locator('#composer [name="content"]').fill("/compact Keep the key decisions.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.locator('[data-context="pi.compaction"]').waitFor();
  const compacted = (await readHistory(session.root)).findLast(
    (entry) => entry.kind === "pi.compaction",
  );
  assert(compacted);
  await page.locator(`#duration-${compacted.id}[data-duration-ms]`).waitFor({ state: "attached" });
  assert.equal(
    await first.evaluate((node) => node === document.querySelector(`#${node.id}`)),
    true,
  );
  assert.equal(await first.evaluate((node) => !!node.closest(".context-history")), true);
  assert.equal(await page.locator('#composer [name="content"]').inputValue(), "");
  assert(
    Number(await page.locator(`#duration-${compacted.id}`).getAttribute("data-duration-ms")) >= 0,
  );
  assert.deepEqual(b.errors, []);
  await first.dispose();
});

await test("HTML initial-message retry after reload keeps its creation and submission identities", async (t) => {
  const f = await fixture(t),
    b = await browserFixture(t, f.sessions);
  const { page } = b;
  page.setDefaultTimeout(10000);
  await page.goto(b.base + "/sessions");
  f.faux.setResponses([fauxAssistantMessage("Created exactly once.")]);
  await page.locator('#composer [name="content"]').fill("Initial message");
  const id = await page.locator('#composer [name="id"]').inputValue();
  const requestId = await page.locator('#composer [name="requestId"]').inputValue();
  await page.route("**/sessions", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    await route.fetch();
    await route.abort("connectionfailed");
  });
  await page.getByRole("button", { name: "Create session", exact: true }).click();
  await page.waitForFunction(() => !!document.querySelector("#request-error")?.textContent);
  const session = await f.sessions.get(id);
  await session.root.waitForIdle(context);
  const before = await readHistory(session.root);
  await page.unroute("**/sessions");
  await page.reload();
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLTextAreaElement>('#composer [name="content"]')?.value ===
      "Initial message",
  );
  assert.equal(await page.locator('#composer [name="id"]').inputValue(), id);
  assert.equal(await page.locator('#composer [name="requestId"]').inputValue(), requestId);
  await page.getByRole("button", { name: "Create session", exact: true }).click();
  await page.waitForURL(b.base + conversationURL(session));
  assert.deepEqual(await readHistory(session.root), before);
  assert.equal((await f.sessions.catalog()).sessions.length, 1);
  assert.equal(f.faux.state.callCount, 1);
  await page.goto(b.base + "/sessions");
  await page.locator('#composer [name="content"]').fill("/new");
  await page.getByRole("button", { name: "Create session", exact: true }).click();
  await page.locator("[data-events] #composer").waitFor();
  const created = (await f.sessions.catalog()).sessions.find((item) => item.id !== id);
  assert(created);
  assert.deepEqual(await readHistory((await f.sessions.get(created.id)).root), []);
  assert.deepEqual(b.errors, []);
});
