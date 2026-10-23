import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, readdir, writeFile } from "node:fs/promises";
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
import { rename, sessionInfo, Sessions } from "../sessions.ts";
import {
  browserFixture,
  htmlAction,
  htmlMessageActions,
  returnToConversation,
  openSessions,
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
  assert.equal(await page.locator('[name="instructions"]').count(), 0);
  await page.selectOption('[name="thinkingLevel"]', "high");
  await page.getByRole("button", { name: "Save settings" }).click();
  assert.equal((await sessionInfo(session)).name, "Renamed session");
  assert.equal((await session.root.agent(context)).thinkingLevel, "high");

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

await test("HTML reset keeps the conversation and swaps only the composer with or without JavaScript", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const b = await browserFixture(t, f.sessions);
  const path = conversationURL(session);
  for (const javaScriptEnabled of [true, false]) {
    const browserContext = await b.browser.newContext({ javaScriptEnabled });
    t.after(() => browserContext.close());
    const page = await browserContext.newPage();
    page.on("pageerror", (error) => b.errors.push(error));
    page.setDefaultTimeout(10000);
    const appearance = () =>
      page.locator(".compose-box:has(#prompt), #prompt, #send").evaluateAll((nodes) =>
        nodes.map((node) => {
          const style = getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          return {
            background: style.backgroundColor,
            border: style.border,
            radius: style.borderRadius,
            color: style.color,
            padding: style.padding,
            x: rect.x,
            width: rect.width,
          };
        }),
      );
    for (const width of [390, 820]) {
      f.faux.setResponses([fauxAssistantMessage("Conversation history.\n\n".repeat(60))]);
      await (
        await session.root.submit(
          { type: "input", content: "Keep this conversation visible." },
          context,
        )
      ).wait(context);
      await page.setViewportSize({ width, height: 844 });
      await page.goto(b.base + path);
      const expected = await appearance();
      assert.equal(expected.length, 3);
      const entries = () =>
        page.locator("#transcript article").evaluateAll((nodes) => nodes.map((node) => node.id));
      const visibleEntries = await entries();
      assert(visibleEntries.length > 0);
      let before = await readHistory(session.root);
      await page.goto(b.base + path + "/reset");
      assert.deepEqual(await appearance(), expected);
      assert.deepEqual(await entries(), visibleEntries);
      assert.equal(await page.locator("#session-meta").isVisible(), true);
      assert.equal(await page.locator("#composer").count(), 0);
      const handoff = page.getByRole("textbox", { name: "Handoff instructions" });
      assert.equal(await handoff.inputValue(), "");
      if (javaScriptEnabled) {
        await page.waitForFunction(() => {
          const scroll = document.querySelector("#conversation-scroll")!;
          return scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 32;
        });
        await handoff.fill("Keep these handoff edits while the conversation updates.");
        f.faux.setResponses([fauxAssistantMessage("New conversation output.")]);
        await (
          await session.root.submit(
            { type: "input", content: "Update while handing off." },
            context,
          )
        ).wait(context);
        before = await readHistory(session.root);
        await page.locator(`#transcript #entry-${before.at(-1)!.id}`).waitFor();
        assert.equal(
          await handoff.inputValue(),
          "Keep these handoff edits while the conversation updates.",
        );
        await handoff.fill("");
      }
      const confirm = page.getByRole("button", { name: "Confirm reset" });
      assert.equal(await confirm.isEnabled(), true);
      const box = await page.locator(".composer-shell .compose-box").boundingBox();
      const button = await confirm.boundingBox();
      assert(box && button);
      assert(button.x >= box.x && button.x + button.width <= box.x + box.width);
      assert(button.y >= box.y && button.y + button.height <= box.y + box.height);
      assert(box.y + box.height <= 844);
      assert.deepEqual(await readHistory(session.root), before);
      await confirm.click();
      await page.waitForURL(b.base + path);
      const after = await readHistory(session.root);
      assert.equal(after.length, before.length + 1);
      assert.equal(after.at(-1)?.kind, "pi.reset");
      assert.deepEqual((await session.root.context(context)).messages, []);
    }
  }
  assert.deepEqual(b.errors, []);
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
  await page.locator('[name="name"]').fill("Persist before leaving.");
  await returnToConversation(page);
  await requested.promise;
  assert.equal(new URL(page.url()).pathname, path + "/settings");
  release.resolve();
  await page.waitForURL(b.base + path);
  assert.equal((await sessionInfo(session)).name, "Persist before leaving.");
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
  await page.locator('[name="name"]').fill("Retry this change.");
  await returnToConversation(page);
  await page.waitForFunction(
    () => document.querySelector<HTMLFormElement>("#session-settings")?.dataset.failed === "true",
  );
  assert.equal(new URL(page.url()).pathname, path + "/settings");
  assert.equal((await sessionInfo(session)).name, "Persist before leaving.");
  assert.equal(await page.locator('[name="name"]').inputValue(), "Retry this change.");
  await page.unroute("**/settings");
  await page.getByRole("button", { name: "Save settings" }).click();
  await waitFor(async () => (await sessionInfo(session)).name === "Retry this change.");
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

for (const [command, scope] of [
  ["/review packages/app", "packages/app"],
  ["  /review \t\n", "current code changes (staged, unstaged, and untracked files)"],
  [
    "/review\tchanges against main\nwith emphasis on cancellation  ",
    "changes against main\nwith emphasis on cancellation",
  ],
])
  await test(`HTML scoped review command uses the shared review input: ${JSON.stringify(command)}`, async (t) => {
    const f = await fixture(t);
    const session = await f.create();
    const before = await readHistory(session.root);
    const b = await browserFixture(t, f.sessions);
    await b.page.goto(b.base + conversationURL(session));
    f.faux.setResponses([fauxAssistantMessage("No findings.")]);
    await b.page.getByRole("textbox", { name: "Message" }).fill(command);
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
      [`Review the ${scope} and provide prioritized findings.`],
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
  const options = await page.locator("#options").elementHandle();
  assert(options);
  await page.selectOption('[name="target"]', targetKey(f.binding));
  await options.waitForElementState("hidden");
  await options.dispose();
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

await test("HTML ordinary messages enable Send and consecutive submissions retain the conversation URL", async (t) => {
  const f = await fixture(t);
  const b = await browserFixture(t, f.sessions);
  const { page } = b;
  page.setDefaultTimeout(10000);
  await page.goto(b.base + "/sessions");
  await page.locator("#create").click();
  await page.locator("[data-events] #composer").waitFor();
  const catalog = await f.sessions.catalog();
  const session = await f.sessions.get(catalog.sessions[0].id);
  const url = b.base + conversationURL(session);
  await page.locator("#status[data-state=ready]").waitFor({ state: "attached" });
  const prompt = page.getByRole("textbox", { name: "Message" });
  for (const [index, text] of ["First ordinary message", "Second ordinary message"].entries()) {
    f.faux.setResponses([fauxAssistantMessage(`Response ${index}`)]);
    await prompt.pressSequentially(text[0]);
    assert.equal(await page.locator("#send").isEnabled(), true);
    await prompt.pressSequentially(text.slice(1));
    assert.equal(await page.locator("#send").isEnabled(), true);
    await page.locator("#send").click();
    await page.waitForFunction(
      () => document.querySelector<HTMLTextAreaElement>("#prompt")?.value === "",
    );
    await session.root.waitForIdle(context);
    await page.locator("#status[data-state=ready]").waitFor({ state: "attached" });
    assert.equal(page.url(), url);
  }
  assert.deepEqual(
    (await readHistory(session.root))
      .flatMap((entry) => entry.model ?? [])
      .filter((message) => message.role === "user")
      .map((message) => message.content),
    ["First ordinary message", "Second ordinary message"],
  );
  assert.equal((await page.reload())?.status(), 200);
  assert.equal(page.url(), url);
  assert.deepEqual(b.errors, []);
});

await test("HTML submission preserves edits and attachments made while its acknowledgement is pending", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const b = await browserFixture(t, f.sessions);
  const { page } = b;
  page.setDefaultTimeout(10000);
  await page.goto(b.base + conversationURL(session));
  const requested = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  await page.route("**/submit", async (route) => {
    const response = await route.fetch();
    requested.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  f.faux.setResponses([fauxAssistantMessage("Received first message")]);
  const prompt = page.getByRole("textbox", { name: "Message" });
  await prompt.fill("Original draft");
  await page.locator("#send").click();
  await requested.promise;
  assert.equal(await prompt.isEditable(), true);
  await prompt.fill("Next draft");
  await page.locator('input[type="file"]').setInputFiles({
    name: "next.png",
    mimeType: "image/png",
    buffer: Buffer.from([137, 80, 78, 71]),
  });
  const identity = await page.locator('#composer [name="requestId"]').inputValue();
  release.resolve();
  await page.waitForFunction(
    () => document.querySelector<HTMLFormElement>("#composer")?.dataset.submitting === undefined,
  );
  assert.equal(await prompt.inputValue(), "Next draft");
  assert.equal(await page.locator('#composer [name="requestId"]').inputValue(), identity);
  assert.deepEqual(
    await page
      .locator('input[type="file"]')
      .evaluate((node: HTMLInputElement) => Array.from(node.files ?? [], (file) => file.name)),
    ["next.png"],
  );
  assert.deepEqual(
    (await readHistory(session.root))
      .flatMap((entry) => entry.model ?? [])
      .filter((message) => message.role === "user")
      .map((message) => message.content),
    ["Original draft"],
  );
  assert.deepEqual(b.errors, []);
});

await test("HTML creation captures options once and carries newer drafts and files into the created conversation", async (t) => {
  const f = await fixture(t);
  const plain = fauxProvider({ provider: "plain", models: [{ id: "plain", reasoning: false }] });
  f.options.models.setProvider(plain.provider);
  const b = await browserFixture(t, f.sessions);
  const { page } = b;
  page.setDefaultTimeout(10000);
  await page.goto(b.base + "/sessions");
  for (const [key, id] of [
    ["t", "targets"],
    ["m", "models"],
  ]) {
    await page.locator("#new-options").evaluate((node: HTMLDetailsElement) => {
      node.open = false;
    });
    await page.locator("#prompt").blur();
    await page.keyboard.press(key);
    assert.equal(
      await page.locator("#new-options").evaluate((node: HTMLDetailsElement) => node.open),
      true,
    );
    assert.equal(await page.evaluate(() => document.activeElement?.id), id);
    await page.locator(`#${id}`).blur();
  }
  await page.selectOption('[name="thinkingLevel"]', "high");
  const prompt = page.getByRole("textbox", { name: "Message" });
  await prompt.fill("Captured first message");
  const requested = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  await page.route("**/sessions", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    requested.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  f.faux.setResponses([fauxAssistantMessage("Created")]);
  await page.locator("#create").click();
  await requested.promise;
  assert.equal(await page.locator("#create").isDisabled(), true);
  await prompt.fill("Edited during creation");
  const otherModel = await page.locator("#models option").nth(1).getAttribute("value");
  assert(otherModel);
  await page.selectOption("#models", otherModel);
  await page.waitForFunction(
    () => document.querySelector<HTMLSelectElement>("#thinking")?.value === "",
  );
  assert.equal(await page.locator("#create").isDisabled(), true);
  await page.locator('input[type="file"]').setInputFiles({
    name: "next.png",
    mimeType: "image/png",
    buffer: Buffer.from([137, 80, 78, 71]),
  });
  const identity = await page.locator('#composer [name="requestId"]').inputValue();
  release.resolve();
  const catalog = await f.sessions.catalog();
  assert.equal(catalog.sessions.length, 1);
  const session = await f.sessions.get(catalog.sessions[0].id);
  await page.waitForURL(b.base + conversationURL(session));
  await page.locator("[data-events] #composer").waitFor();
  assert.equal(await prompt.inputValue(), "Edited during creation");
  assert.equal(await page.locator('#composer [name="requestId"]').inputValue(), identity);
  assert.deepEqual(
    await page
      .locator('input[type="file"]')
      .evaluate((node: HTMLInputElement) => Array.from(node.files ?? [], (file) => file.name)),
    ["next.png"],
  );
  assert.equal((await session.root.agent(context)).thinkingLevel, "high");
  assert.deepEqual(
    (await readHistory(session.root))
      .flatMap((entry) => entry.model ?? [])
      .filter((message) => message.role === "user")
      .map((message) => message.content),
    ["Captured first message"],
  );
  await page.reload();
  assert.equal(await prompt.inputValue(), "Edited during creation");
  assert.equal(await page.locator('#composer [name="requestId"]').inputValue(), identity);
  assert.deepEqual(b.errors, []);
});

await test("HTML malformed commands never fall through to ordinary prompt submission", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const b = await browserFixture(t, f.sessions);
  const { page } = b;
  await page.goto(b.base + conversationURL(session));
  const prompt = page.getByRole("textbox", { name: "Message" });
  for (const command of ["/", "/???", "  /missing-command  "]) {
    await prompt.fill(command);
    await page.locator("#send").click();
    assert.notEqual(await page.locator("#request-error").textContent(), "");
    assert.equal(await prompt.inputValue(), command);
    assert.deepEqual(await readHistory(session.root), []);
    assert.equal(f.faux.state.callCount, 0);
    assert.equal(page.url(), b.base + conversationURL(session));
  }
  assert.deepEqual(b.errors, []);
});

await test("HTML is the only served frontend and removed routes cannot mutate sessions", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const before = await sessionInfo(session);
  const b = await browserFixture(t, f.sessions);
  const assets = await readdir(b.assets);
  for (const removed of ["client.js", "index.html", "sw.js"])
    assert.equal(assets.includes(removed), false);
  const root = await fetch(b.base, { redirect: "manual" });
  assert.equal(root.status, 303);
  assert.equal(root.headers.get("location"), "/sessions");
  await b.page.goto(b.base);
  assert.equal(new URL(b.page.url()).pathname, "/sessions");
  assert.equal(await b.page.locator("#composer").count(), 1);
  assert.equal(await b.page.getByRole("link", { name: "Original UI" }).count(), 0);
  for (const path of [
    "/api/catalog",
    "/api/settings",
    `/api/harness/${session.id}/watch`,
    "/client.js",
    "/sw.js",
    "/index.html",
    "/manifest.webmanifest",
  ]) {
    const response = await fetch(b.base + path);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  }
  const mutation = await fetch(`${b.base}/api/harness/${session.id}/settings`, {
    method: "POST",
    headers: { Origin: b.base, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Removed API must not run" }),
  });
  assert.equal(mutation.status, 404);
  assert.deepEqual(await sessionInfo(session), before);
  const catalog = await f.sessions.catalog();
  t.mock.method(f.sessions, "catalog", async () => ({ ...catalog, targets: [] }));
  await b.page.reload();
  assert.equal(await b.page.locator("#create").isDisabled(), true);
  assert.deepEqual(b.errors, []);
});

await test("HTML landing lists the newest five sessions even when execution is unavailable", async (t) => {
  const f = await directoryFixture(t);
  const { page, base, errors } = await browserFixture(t, f.sessions);
  await page.goto(base);
  assert.equal(await page.locator("#recent-title").count(), 0);
  assert.equal(await page.locator("#session-list a").count(), 0);
  assert.equal(await page.locator("#composer #create").isVisible(), true);
  assert.equal(await page.locator("#send").count(), 0);
  const ids: string[] = [];
  for (let index = 0; index < 7; index++) {
    const session = await f.sessions.create(crypto.randomUUID(), f.binding, model);
    await rename(session, `Session ${index}`);
    ids.unshift(session.id);
    if (index === 1) {
      await page.reload();
      assert.equal(await page.locator("#session-list a").count(), 2);
    }
  }
  f.stop();
  await page.reload();
  assert.equal(
    await page
      .locator("#targets")
      .evaluate(
        (node: HTMLSelectElement, value) =>
          Array.from(node.options).find((option) => option.value === value)?.disabled,
        targetKey(f.binding),
      ),
    true,
  );
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.deepEqual(
      await page
        .locator("#session-list a")
        .evaluateAll((nodes) =>
          nodes.map((node) => new URL((node as HTMLAnchorElement).href).pathname.split("/")[2]),
        ),
      ids.slice(0, 5),
    );
    assert.equal(await page.locator("#recent-title").isVisible(), true);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    assert.equal(await page.locator("#new-options > summary").isVisible(), true);
    await openSessions(page);
    await page.locator("#picker").waitFor();
    assert.equal(await page.locator("#session-list a").count(), 7);
    await page.locator("#session-filter").fill("Session 0");
    await page.waitForFunction(() => document.querySelectorAll("#session-list a").length === 1);
    await page.goBack();
    await page.locator("#landing").waitFor();
    assert.equal(await page.locator("#session-list a").count(), 5);
    await page.locator("#session-list a").first().click();
    await page.waitForURL(`${base}/sessions/${ids[0]}/conversations/1`);
    await page.reload();
    await page.locator("#status[data-state=ready]").waitFor({ state: "attached" });
    await page.goto(base);
  }
  assert.deepEqual(errors, []);
});

await test("HTML repository inspection is explicit, works natively and does not navigate on hover", async (t) => {
  const f = await fixture(t);
  const env = t.mock.fn(f.options.env.bind(f.options));
  await f.reopen({ env });
  const session = await f.create();
  const b = await browserFixture(t, f.sessions);
  const path = conversationURL(session);
  await b.page.setViewportSize({ width: 1440, height: 900 });
  await b.page.goto(b.base + path);
  assert.equal(env.mock.callCount(), 0);
  const instance = b.page.locator("#footer-instance");
  await instance.hover();
  await b.page.waitForFunction(
    () => document.querySelector("#footer-instance")?.getAttribute("title") === "no repository",
  );
  assert.equal(env.mock.callCount(), 1);
  assert.equal(new URL(b.page.url()).pathname, path);
  const native = await b.browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 1440, height: 900 },
  });
  t.after(() => native.close());
  const page = await native.newPage();
  await page.goto(b.base + path);
  assert.equal(env.mock.callCount(), 1);
  await page.locator("#footer-instance").click();
  assert.equal(new URL(page.url()).pathname, path + "/repository");
  assert.equal(await page.locator("#footer-instance").getAttribute("title"), "no repository");
  assert.equal(env.mock.callCount(), 2);
  assert.equal(f.faux.state.callCount, 0);
  assert.deepEqual(b.errors, []);
});

await test("cd completes directories and changes cwd in HTML without model input", async (t) => {
  {
    const f = await fixture(t);
    const session = await f.create();
    const nested = join(f.workspace, "space name");
    await mkdir(nested);
    await writeFile(join(f.workspace, "spurious-file"), "file");
    const { page, base, errors } = await browserFixture(t, f.sessions);
    await page.goto(base + conversationURL(session));
    await page.locator("#status[data-state=ready]").waitFor({ state: "attached" });
    await page.fill("#prompt", "/cd");
    await page.locator("#completions [role=option]").waitFor();
    await page.press("#prompt", "Tab");
    assert.equal(await page.inputValue("#prompt"), "/cd ");
    await page.fill("#prompt", "/cd sp");
    const option = page.getByRole("option", { name: "space name/", exact: true });
    await option.waitFor();
    assert.equal(await page.locator("#completions [role=option]").count(), 1);
    await option.tap();
    assert.equal(await page.inputValue("#prompt"), "/cd space name/");
    await page.press("#prompt", "Control+Enter");
    await waitFor(async () => (await session.root.agent(context)).cwd === nested);
    await page.waitForFunction(
      () => document.querySelector<HTMLTextAreaElement>("#prompt")?.value === "",
    );
    assert.deepEqual(await readHistory(session.root), []);
    await page.reload();
    await page.locator("#status[data-state=ready]").waitFor({ state: "attached" });
    await page.waitForFunction(
      (path) => document.querySelector("#footer-instance")?.textContent === `local · ${path}`,
      nested,
    );
    await page.fill("#prompt", "/cd ../missing");
    await page.press("#prompt", "Control+Enter");
    await page.waitForFunction(() => !!document.querySelector("#request-error")?.textContent);
    assert.equal(await page.inputValue("#prompt"), "/cd ../missing");
    assert.equal((await session.root.agent(context)).cwd, nested);
    await page.fill("#prompt", "/cd ..");
    await page.press("#prompt", "Control+Enter");
    await waitFor(async () => (await session.root.agent(context)).cwd === f.workspace);
    await page.waitForFunction(
      () => document.querySelector<HTMLTextAreaElement>("#prompt")?.value === "",
    );
    assert.equal(f.faux.state.callCount, 0);
    assert.deepEqual(errors, []);
  }
});
