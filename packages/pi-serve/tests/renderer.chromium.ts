import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import type { Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { Page } from "playwright";
import type { RenderState } from "../client.ts";
import { fixture, model } from "../../pi-runtime/testing.ts";
import { snapshot } from "./testing.ts";
import {
  assertLayout,
  assertMessageTimestamps,
  assertTouchMenuPosition,
  browserFixture,
  openMessageActions,
} from "./browser-testing.ts";

// A real shell/catalog, but no provider calls or tool execution. Reloads receive
// the current fixture; incremental updates call the production renderer directly.
async function rendererFixture(t: TestContext) {
  const f = await fixture(t);
  const session = await f.sessions.create(randomUUID(), f.binding, model);
  const b = await browserFixture(t, f.sessions);
  const state = await snapshot(`${b.base}/api/harness/${session.id}/watch`);
  const url = `${b.base}/?session=${session.id}`;
  const entries = [...state.view.entries];
  state.view = { ...state.view, entries };
  const append = (...messages: Message[]) => {
    for (const message of messages)
      entries.push({
        id: (entries.length + 1) as EntryRecord["id"],
        conversationId: state.view.conversation.id,
        kind: "message",
        model: [message],
      });
  };
  const load = async (page: Page = b.page) => {
    // Keep a closed fixture stream from reconnecting and racing direct renders.
    await page.route("**/api/harness/*/watch", (route) =>
      route.fulfill({
        contentType: "text/event-stream",
        body: `retry: 3600000\n\ndata: ${JSON.stringify({ value: state.view, ops: [] })}\n\n`,
      }),
    );
    await page.goto(url);
    await page.locator("#bottom-line:not([hidden])").waitFor();
  };
  const render = async (page: Page = b.page) => {
    const frontend = await page.evaluateHandle<{ render(snapshot: RenderState): void }>(
      "import('/client.js')",
    );
    try {
      await page.evaluate(
        ({ frontend, data }) => frontend.render(JSON.parse(data) as RenderState),
        {
          frontend,
          data: JSON.stringify(state),
        },
      );
    } finally {
      await frontend.dispose();
    }
  };
  t.after(() => assert.equal(f.faux.state.callCount, 0));
  return { ...b, state, append, load, render };
}

const timestamp = 1_700_000_000_000;
const thinkingText = "Considering the next step.\n".repeat(40);
const toolHistory: Message[] = [
  { role: "user", content: "Run the browser integration test.", timestamp },
  fauxAssistantMessage(
    [
      { type: "thinking", thinking: "" },
      { type: "thinking", thinking: thinkingText },
      fauxToolCall("write", { path: "browser.json", content: '{"value":31}' }, { id: "write" }),
    ],
    { timestamp: timestamp + 1, stopReason: "toolUse" },
  ),
  {
    role: "toolResult",
    toolCallId: "write",
    toolName: "write",
    content: [{ type: "text", text: "Successfully wrote browser.json" }],
    isError: false,
    timestamp: timestamp + 2,
  },
  fauxAssistantMessage('<img src=x onerror="document.body.dataset.injected=1">', {
    timestamp: timestamp + 3,
  }),
];

await test("design-system showcase works over HTTP and from disk at every breakpoint", async (t) => {
  const f = await fixture(t);
  const { assets, base, screenshots, page: showcase, errors } = await browserFixture(t, f.sessions);
  const response = await showcase.goto(`${base}/design-system.html`);
  assert.equal(response?.status(), 200);
  assert.equal(response?.headers()["content-type"], "text/html; charset=utf-8");
  const css = await fetch(`${base}/styles.css`);
  assert.equal(css.status, 200);
  assert.equal(css.headers.get("content-type"), "text/css; charset=utf-8");
  for (const width of [320, 390, 650, 651, 1440]) {
    await showcase.setViewportSize({ width, height: 900 });
    assert.equal(
      await showcase.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    assert.equal(await showcase.locator(".ds-section").count(), 9);
    assert.deepEqual(
      await showcase
        .locator("#bottom-line button")
        .evaluateAll((nodes) =>
          nodes.filter((node) => node.checkVisibility()).map((node) => node.id),
        ),
      width <= 650 ? ["footer-model", "footer-context"] : ["footer-stats", "footer-context"],
    );
    assert.equal(
      await showcase
        .locator(".ds-swatch")
        .evaluateAll((nodes) =>
          nodes.every((node) => getComputedStyle(node).backgroundColor !== "rgba(0, 0, 0, 0)"),
        ),
      true,
    );
    if (screenshots)
      await showcase.screenshot({
        path: join(screenshots, `design-system-${width}.png`),
        fullPage: true,
      });
  }
  for (const [id, close, open] of [
    ["picker", "Close sessions", "Open sessions"],
    ["preferences", "Close settings", "Open settings"],
    ["usage-dialog", "Close statistics", "Open statistics"],
  ]) {
    await showcase.getByRole("button", { name: close, exact: true }).click();
    await showcase.getByRole("button", { name: open, exact: true }).click();
    assert.equal(await showcase.locator(`#${id}`).evaluate((node) => node.matches(":modal")), true);
    await showcase.keyboard.press("Escape");
  }
  await showcase.getByRole("button", { name: "More actions", exact: true }).click();
  assert.equal(
    await showcase.locator("#live-menu").evaluate((node) => node.matches(":popover-open")),
    true,
  );
  await showcase.keyboard.press("Escape");
  await showcase.goto(pathToFileURL(join(assets, "design-system.html")).href);
  assert.equal(
    await showcase.locator("#send").evaluate((node) => getComputedStyle(node).backgroundColor),
    "rgb(180, 212, 190)",
  );
  await showcase.close();
  assert.deepEqual(errors, []);
});

await test("renderer preserves safe thinking/tool text and native touch, disclosure and copy behavior", async (t) => {
  const f = await rendererFixture(t);
  const { page, browserContext, base, state, errors } = f;
  await f.load();
  assert.equal(
    await page
      .locator("#transcript")
      .evaluate((node) => getComputedStyle(node, "::before").content),
    "none",
  );
  const emptyPrompt = await page.locator("#prompt").boundingBox();
  assert(emptyPrompt);
  assert(emptyPrompt.height >= 42);
  assert(emptyPrompt.y > 844 / 2);
  await page.locator("#prompt").tap();
  assert.deepEqual(await page.locator("#prompt").boundingBox(), emptyPrompt);
  assert.equal(await page.evaluate(() => scrollY), 0);
  f.append(...toolHistory);
  await f.render();
  await page.waitForFunction(() => document.querySelectorAll("#transcript article").length === 3);
  assert.equal(await page.locator(".tool-call").count(), 1);
  await assertMessageTimestamps(page);
  assert.deepEqual(
    await page
      .locator("article > header > .message-time")
      .evaluateAll((nodes) => nodes.map((node) => (node as HTMLTimeElement).dateTime)),
    state.view.entries
      .flatMap((entry) => entry.model ?? [])
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => new Date(message.timestamp).toISOString()),
  );
  assert.equal(await page.locator(".thinking").count(), 2);
  assert.equal(await page.locator(".thinking").first().textContent(), "Thinking…");
  assert.equal(await page.locator(".thinking").last().textContent(), thinkingText);
  assert.equal(
    await page
      .locator(".thinking")
      .last()
      .evaluate(
        (node) =>
          node.tagName === "DIV" &&
          !node.closest("details") &&
          node.scrollHeight <= node.clientHeight &&
          node.scrollWidth <= node.clientWidth,
      ),
    true,
  );
  assert.deepEqual(
    await page
      .locator(".thinking")
      .last()
      .evaluate((node) => {
        const style = getComputedStyle(node);
        const tool = getComputedStyle(document.querySelector(".tool-call")!);
        const summary = getComputedStyle(document.querySelector(".tool-call > summary")!);
        return [
          style.borderLeftWidth,
          style.paddingLeft,
          tool.borderLeftWidth,
          tool.paddingLeft,
          style.color === summary.color,
        ];
      }),
    ["2px", "10px", "0px", "0px", true],
  );
  assert.equal((await page.locator("#prompt").boundingBox())!.height, emptyPrompt.height);
  assert.equal(await page.locator('article[data-role="toolResult"]').count(), 0);
  assert.equal(await page.locator('.tool-call[data-state="completed"] .tool-result').count(), 1);
  await page.locator(".tool-call > summary").click();
  assert.equal(await page.locator(".tool-result pre").first().isVisible(), true);
  assert.equal(await page.locator(".tool-call pre > :not(code)").count(), 0);
  // A short tap still toggles disclosure; scrolling, lifting, and multitouch cancel a hold.
  const touchSummary = page.locator(".tool-call > summary");
  await touchSummary.tap();
  assert.equal(
    await page.locator(".tool-call").evaluate((node) => node.hasAttribute("open")),
    false,
  );
  await touchSummary.tap();
  await page.clock.install();
  for (const cancel of ["pointerup", "pointercancel", "pointermove", "scroll", "multitouch"]) {
    await touchSummary.dispatchEvent("pointerdown", {
      pointerId: 7,
      pointerType: "touch",
      isPrimary: true,
      clientX: 10,
      clientY: 10,
    });
    if (cancel === "scroll") await page.locator("#transcript").dispatchEvent("scroll");
    else
      await touchSummary.dispatchEvent(cancel === "multitouch" ? "pointerdown" : cancel, {
        pointerId: cancel === "multitouch" ? 8 : 7,
        pointerType: "touch",
        isPrimary: cancel !== "multitouch",
        clientX: 30,
        clientY: 10,
      });
    await page.clock.runFor(600);
    assert.equal(await page.locator("#message-menu").isVisible(), false);
  }
  // Code retains native selection/context menus and does not open app actions.
  const code = page.locator(".tool-result pre").first();
  assert.equal(await code.evaluate((node) => getComputedStyle(node).userSelect), "text");
  await code.dispatchEvent("pointerdown", { pointerId: 9, pointerType: "touch", isPrimary: true });
  await page.clock.runFor(600);
  assert.equal(await page.locator("#message-menu").isVisible(), false);
  assert.equal(
    await code.evaluate((node) =>
      node.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
    ),
    true,
  );
  await code.dispatchEvent("pointerup", { pointerId: 9, pointerType: "touch", isPrimary: true });
  // Boundary placements use the same pointer interface as a real hold, with
  // coordinates at each screen edge. The smaller viewport models keyboard space.
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 320, height: 220 },
  ]) {
    await page.setViewportSize(viewport);
    // Deliver resize and layout scroll events before starting a hold: either
    // event intentionally cancels an in-progress gesture.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await page.locator("#message-menu").evaluate((node) => {
      node.style.setProperty("--menu-safe-top", "24px");
      node.style.setProperty("--menu-safe-right", "12px");
      node.style.setProperty("--menu-safe-bottom", "20px");
      node.style.setProperty("--menu-safe-left", "12px");
    });
    for (const point of [
      { x: 24, y: 36 },
      { x: viewport.width - 24, y: 36 },
      { x: 24, y: viewport.height - 32 },
      { x: viewport.width - 24, y: viewport.height - 32 },
      { x: viewport.width / 2, y: viewport.height / 2 },
    ]) {
      await touchSummary.dispatchEvent("pointerdown", {
        pointerId: 10,
        pointerType: "touch",
        isPrimary: true,
        clientX: point.x,
        clientY: point.y,
      });
      await page.clock.runFor(600);
      assert.equal(
        await page.locator("#message-menu").isVisible(),
        true,
        JSON.stringify({ viewport, point }),
      );
      await touchSummary.dispatchEvent("pointerup", {
        pointerId: 10,
        pointerType: "touch",
        isPrimary: true,
      });
      await assertTouchMenuPosition(page, point);
      if (viewport.height === 220)
        assert.equal(
          await page
            .locator("#message-menu")
            .evaluate((node) => node.scrollHeight > node.clientHeight),
          false,
          "Compact action rows fit above the software keyboard",
        );
      await page.keyboard.press("Escape");
    }
  }
  await page.locator("#message-menu").evaluate((node) => {
    for (const side of ["top", "right", "bottom", "left"])
      node.style.removeProperty(`--menu-safe-${side}`);
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.resume();
  await browserContext.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  await openMessageActions(page, page.locator(".tool-call > .message-actions"));
  assert.equal(
    await page.locator(".tool-call").evaluate((node) => node.hasAttribute("open")),
    true,
  );
  assert.equal(await page.locator("#copy-message").isVisible(), false);
  await page.getByRole("button", { name: "Copy input", exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '{"value":31}');
  const toolOutput = await page.locator(".tool-result > pre code").textContent();
  await openMessageActions(page, page.locator(".tool-call > .message-actions"));
  await page.getByRole("button", { name: "Copy output", exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), toolOutput);
  await openMessageActions(page, page.locator(".tool-call > .message-actions"));
  // Header padding can hit the session button through native touch targeting.
  // The composer dismisses the popup without intentionally navigating away.
  await page.locator("#prompt").tap();
  assert.equal(await page.locator("#message-menu").isVisible(), false);
  assert.equal(await page.locator("#transcript").isVisible(), true);
  await openMessageActions(page, page.locator(".tool-call > .message-actions"));
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#message-menu").isVisible(), false);
  assert.equal(await touchSummary.evaluate((node) => node === document.activeElement), true);
  await openMessageActions(page, page.locator(".tool-call > .message-actions"));
  await page.locator("#transcript").dispatchEvent("scroll");
  assert.equal(await page.locator("#message-menu").isVisible(), false);
  await openMessageActions(page, page.locator(".tool-call > .message-actions"));
  await page.evaluate(() => visualViewport?.dispatchEvent(new Event("resize")));
  assert.equal(await page.locator("#message-menu").isVisible(), false);
  await page.locator("#notice").click();
  assert.equal(await page.locator(".tool-call > details").count(), 0);
  assert.equal(await page.locator("#transcript img").count(), 0);
  assert.equal(await page.evaluate(() => document.body.dataset.injected), undefined);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.close();
  assert.deepEqual(errors, []);
});

await test("renderer pairs parallel calls, displays metadata and preserves highlighted tool subtrees", async (t) => {
  const f = await rendererFixture(t);
  const { page: reconnected, browser, browserContext, base, errors } = f;
  f.append(...toolHistory);
  await f.load();
  await browserContext.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  f.append(
    fauxAssistantMessage(fauxToolCall("read", { path: "example.txt" }, { id: "metadata-history" })),
    {
      role: "toolResult",
      toolCallId: "metadata-history",
      durationMs: 1234,
      toolName: "read",
      content: [{ type: "text", text: "File contents" }],
      isError: false,
      timestamp: 1,
      details: {
        path: "example.txt",
        note: '<img src=x onerror="document.body.dataset.metadataInjected = 1">',
      },
    },
    {
      role: "toolResult",
      toolCallId: "unmatched-history",
      toolName: "custom.tool",
      content: [{ type: "text", text: "File unavailable" }],
      isError: true,
      timestamp: 2,
    },
  );
  await f.render();
  await reconnected.reload();
  await reconnected.waitForSelector('.tool-call[data-call-id="metadata-history"]');
  const speakerGroups = await reconnected.locator("#transcript > article").evaluateAll((nodes) =>
    nodes.map((node) => {
      const speaker = node.querySelector(":scope > header > .speaker");
      return {
        role: (node as HTMLElement).dataset.role,
        grouped: node.classList.contains("same-speaker"),
        border: getComputedStyle(node).borderTopWidth,
        labelVisible: speaker ? getComputedStyle(speaker).display !== "none" : false,
      };
    }),
  );
  assert(speakerGroups.some((group) => group.grouped));
  let previousRole: string | undefined;
  for (const group of speakerGroups) {
    const role = group.role === "toolResult" ? "assistant" : group.role;
    const grouped = role !== undefined && role === previousRole;
    assert.equal(group.grouped, grouped);
    if (grouped) {
      assert.equal(group.border, "0px");
      assert.equal(group.labelVisible, false);
    } else if (role === "assistant" || role === "user") {
      assert.equal(group.labelVisible, true);
    }
    previousRole = role;
  }
  const historyCall = reconnected.locator('.tool-call[data-call-id="metadata-history"]');
  assert.equal(
    await historyCall.locator(":scope > summary > .tool-duration").textContent(),
    "1.2s",
  );
  await historyCall.locator(":scope > summary").click();
  // Collapsed metadata keeps searchable/copyable text, but no syntax spans.
  const rawDetails = historyCall.locator(".tool-result > details");
  const rawCode = rawDetails.locator("pre code");
  const rawText = await rawCode.textContent();
  assert(rawText);
  assert.equal(await rawCode.locator("*").count(), 0);
  assert.equal(await rawDetails.evaluate((node) => node.hasAttribute("open")), false);
  await openMessageActions(reconnected, historyCall.locator(":scope > .message-actions"));
  await reconnected.getByRole("button", { name: "Copy details", exact: true }).click();
  assert.deepEqual(
    JSON.parse(await reconnected.evaluate(() => navigator.clipboard.readText())),
    JSON.parse(rawText),
  );
  await reconnected.locator("#notice").click();
  await reconnected.keyboard.press("Control+f");
  await reconnected.fill("#search", "example");
  await rawCode.locator(".hljs-attr").first().waitFor();
  assert.equal(await rawDetails.evaluate((node) => node.hasAttribute("open")), true);
  assert.equal(await rawCode.textContent(), rawText);
  assert.equal(await rawCode.locator("img").count(), 0);
  assert.equal(await reconnected.evaluate(() => document.body.dataset.metadataInjected), undefined);
  assert(
    await rawCode.evaluate((node) =>
      Array.from(CSS.highlights.get("pi-search") ?? []).some((range) =>
        node.contains(range.startContainer),
      ),
    ),
  );
  await reconnected.press("#search", "Escape");
  const syntax = await rawCode.locator(".hljs-attr").first().elementHandle();
  assert(syntax);
  await rawDetails.locator(":scope > summary").click();
  await rawDetails.locator(":scope > summary").click();
  assert.equal(await syntax.evaluate((node) => node.isConnected), true);

  assert.equal(errors.length, 0);
  // Parallel calls of the same tool pair by ID, not tool name or result order.
  const fullCommand = `printf '%s\\n' '${"long command argument ".repeat(18)}'\necho finished`;
  f.append(
    fauxAssistantMessage([
      fauxToolCall("bash", { command: fullCommand }, { id: "parallel-first" }),
      fauxToolCall("bash", { command: "echo second" }, { id: "parallel-second" }),
    ]),
  );
  await f.render();
  const firstCall = reconnected.locator('.tool-call[data-call-id="parallel-first"]');
  const secondCall = reconnected.locator('.tool-call[data-call-id="parallel-second"]');
  await firstCall.waitFor();
  const summary = firstCall.locator(":scope > summary");
  assert.equal(
    await summary.evaluate((node) => node.firstElementChild?.classList.contains("tool-status")),
    true,
  );
  assert.equal(await summary.evaluate((node) => getComputedStyle(node).listStyleType), "none");
  assert.equal(
    await firstCall
      .locator(".tool-command")
      .evaluate((node) => node.scrollWidth > node.clientWidth),
    true,
  );
  await summary.focus();
  await summary.press("Enter");
  const command = firstCall.locator(":scope > summary > .tool-command");
  assert.equal(await command.evaluate((node) => getComputedStyle(node).whiteSpace), "pre-wrap");
  assert.equal(await command.textContent(), `$ ${fullCommand}`);
  assert.equal(await command.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true);
  f.append(
    {
      role: "toolResult",
      toolCallId: "parallel-second",
      toolName: "bash",
      content: [{ type: "text", text: "Second failed" }],
      isError: true,
      timestamp: 3,
    },
    {
      role: "toolResult",
      toolCallId: "parallel-first",
      toolName: "bash",
      content: [{ type: "text", text: "First finished" }],
      details: { diff: "-old\n+new" },
      isError: false,
      timestamp: 4,
    },
  );
  await f.render();
  await reconnected.waitForSelector(
    '.tool-call[data-call-id="parallel-first"][data-state="completed"]',
  );
  assert.equal(await firstCall.count(), 1);
  assert.equal(await secondCall.count(), 1);
  assert.equal(await secondCall.getAttribute("data-state"), "failed");
  assert.equal(await secondCall.locator(":scope > summary > .tool-status").textContent(), "✕");
  assert.equal(
    await secondCall.locator(":scope > summary > .tool-status").getAttribute("aria-label"),
    "failed",
  );
  await openMessageActions(reconnected, firstCall.locator(":scope > .message-actions"));
  await reconnected.getByRole("button", { name: "Copy changes", exact: true }).click();
  assert.equal(await reconnected.evaluate(() => navigator.clipboard.readText()), "-old\n+new");
  await reconnected.locator("#notice").click();
  assert.equal(await firstCall.evaluate((node) => node.hasAttribute("open")), true);
  assert.equal(await firstCall.locator(".tool-result").count(), 1);
  await summary.focus();
  await summary.press("Enter");
  assert.equal(await firstCall.locator(".tool-result").isVisible(), false);
  assert.equal(await command.evaluate((node) => getComputedStyle(node).whiteSpace), "nowrap");
  await summary.press("Space");
  assert.equal(await firstCall.locator(".tool-result").isVisible(), true);

  assert.equal(await secondCall.locator(".tool-result").count(), 1);
  assert.equal(await reconnected.locator('article[data-role="toolResult"]').count(), 1); // unmatched legacy result only
  await reconnected.reload();
  await reconnected.waitForSelector(
    '.tool-call[data-call-id="parallel-second"][data-state="failed"]',
  );
  assert.equal(await firstCall.count(), 1);
  assert.equal(await secondCall.count(), 1);
  assert.equal(await secondCall.evaluate((node) => node.hasAttribute("open")), true);
  for (const [locale, timezoneId] of [
    ["de-DE", "Europe/Berlin"],
    ["en-US", "America/Los_Angeles"],
  ]) {
    const localized = await browser.newContext({ locale, timezoneId });
    try {
      const page = await localized.newPage();
      page.on("pageerror", (error) => errors.push(error));
      await f.load(page);
      await page.waitForSelector('.tool-call[data-call-id="parallel-first"]');
      await assertMessageTimestamps(page);
    } finally {
      await localized.close();
    }
  }

  const historicalTool = await firstCall.elementHandle();
  const historicalOutput = await firstCall.locator(".tool-result").elementHandle();
  assert(historicalTool);
  assert(historicalOutput);
  f.append(
    { role: "user", content: "Another request.", timestamp: timestamp + 4 },
    fauxAssistantMessage("An unrelated response.", { timestamp: timestamp + 5 }),
  );
  await f.render();
  assert.equal(await historicalTool.evaluate((node) => node.isConnected), true);
  assert.equal(await historicalOutput.evaluate((node) => node.isConnected), true);
  assert.deepEqual(errors, []);
});

await test("renderer keeps thinking/tool adjacency and speaker spacing across updates and reloads", async (t) => {
  const f = await rendererFixture(t);
  const { page: reconnected, errors } = f;
  f.append({ role: "user", content: "Run five consecutive tool calls.", timestamp });
  await f.load();
  for (let index = 0; index < 5; index++) {
    f.append(
      fauxAssistantMessage(
        [
          ...(index === 2 || index === 3
            ? [{ type: "thinking" as const, thinking: "Inspecting the next file." }]
            : []),
          ...(index === 2
            ? [{ type: "thinking" as const, thinking: "Checking the file format." }]
            : []),
          fauxToolCall("read", { path: "browser.json" }, { id: `speaker-group-${index}` }),
          ...(index === 2 || index === 3
            ? [{ type: "thinking" as const, thinking: "Reviewing the tool output." }]
            : []),
        ],
        { timestamp: timestamp + index * 2 + 1, stopReason: "toolUse" },
      ),
    );
    await f.render();
    f.append({
      role: "toolResult",
      toolCallId: `speaker-group-${index}`,
      toolName: "read",
      content: [{ type: "text", text: '{"value":32}' }],
      isError: false,
      timestamp: timestamp + index * 2 + 2,
    });
    await f.render();
  }
  f.append(fauxAssistantMessage("All five reads completed.", { timestamp: timestamp + 11 }));
  await f.render();
  for (const phase of ["live", "reloaded"]) {
    if (phase === "reloaded") await reconnected.reload();
    await reconnected.waitForSelector(
      '.tool-call[data-call-id="speaker-group-4"][data-state="completed"]',
    );
    const calls = reconnected.locator('article:has(> .tool-call[data-call-id^="speaker-group-"])');
    assert.equal(await calls.count(), 5);
    for (const width of [390, 1440]) {
      await reconnected.setViewportSize({ width, height: 900 });
      for (let index = 0; index < 5; index++) {
        const call = calls.nth(index);
        assert.equal(await call.locator(":scope > header > .speaker").isVisible(), index === 0);
        assert.equal(
          await call.locator(":scope > header > .message-time").isVisible(),
          index === 0,
        );
        if (index > 0) {
          assert.equal(await call.evaluate((node) => getComputedStyle(node).borderTopWidth), "0px");
          if (index === 1) assert((await call.boundingBox())!.height < 36);
        }
        assert.equal(
          await call
            .locator(":scope > header > .message-actions")
            .evaluate((node) => getComputedStyle(node).opacity),
          "0",
        );
      }
      await assertMessageTimestamps(reconnected);
      // Measure the actual space between blocks, including after expanded output.
      for (const open of [false, true]) {
        await calls
          .first()
          .locator(":scope > .tool-call")
          .evaluate((node, expanded) => {
            (node as HTMLDetailsElement).open = expanded;
          }, open);
        const gaps = await calls.evaluateAll((nodes) => {
          const blocks = nodes.flatMap((node) =>
            Array.from(node.querySelectorAll(":scope > .tool-call, :scope > .thinking")),
          );
          return blocks.slice(1).map((block, index) => ({
            pair: `${blocks[index].className} → ${block.className}`,
            gap: block.getBoundingClientRect().top - blocks[index].getBoundingClientRect().bottom,
          }));
        });
        assert.deepEqual([...new Set(gaps.map(({ pair }) => pair))].sort(), [
          "thinking → thinking",
          "thinking → tool-call",
          "tool-call → thinking",
          "tool-call → tool-call",
        ]);
        for (const { pair, gap } of gaps)
          assert.equal(gap, 6, `${phase}, ${width}px, open=${open}: ${pair} gap`);
        // The prose after the final tool keeps normal message spacing.
        assert.equal(
          await calls.last().evaluate((node) => {
            const tool = node.querySelector(":scope > .tool-call")!.getBoundingClientRect();
            const prose = node.nextElementSibling!.querySelector(".text")!.getBoundingClientRect();
            return prose.top - tool.bottom;
          }),
          24,
        );
        await calls.first().evaluate((node) => node.previousElementSibling?.scrollIntoView());
        await assertLayout(
          reconnected,
          `speaker-groups-${width}-${phase}-${open ? "open" : "closed"}`,
        );
      }
      await calls
        .first()
        .locator(":scope > .tool-call")
        .evaluate((node) => {
          (node as HTMLDetailsElement).open = false;
        });
    }
    await reconnected.setViewportSize({ width: 390, height: 844 });
  }
  assert.deepEqual(errors, []);
});
