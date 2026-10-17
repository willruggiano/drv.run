import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { UsageDoc } from "@earendil-works/pi-durable";
import { chromium, type Locator, type Page } from "playwright";
import type { Sessions, Snapshot, ExecutionBinding } from "../pi-runtime/index.ts";
import { exists, waitFor } from "../pi-runtime/testing.ts";
import { httpServer } from "./server.ts";
import { buildAssets } from "./build.ts";

const context = BACKGROUND_CONTEXT;

export async function serve(
  t: TestContext,
  sessions: Sessions,
  assets?: string,
  host = "127.0.0.1",
  publicOrigin?: string,
) {
  const server = httpServer(sessions, host, assets, publicOrigin);
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
export async function snapshot(url: string): Promise<Snapshot> {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (!text.includes("\n\n")) {
      const part = await reader.read();
      assert.equal(part.done, false);
      text += decoder.decode(part.value, { stream: true });
    }
    return JSON.parse(text.slice(6, text.indexOf("\n\n"))) as Snapshot;
  } finally {
    controller.abort();
    reader.releaseLock();
  }
}
export function post(url: string, data: unknown) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

async function assertMessageTimestamps(page: Page): Promise<void> {
  const times = await page.locator("article > header > .message-time").evaluateAll((nodes) =>
    nodes.map((node) => {
      const date = new Date((node as HTMLTimeElement).dateTime);
      return {
        text: node.textContent,
        expected: date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        title: (node as HTMLElement).title,
        expectedTitle: date.toLocaleString(),
        visible: node.checkVisibility(),
        speakerVisible: node.parentElement!.querySelector(".speaker")!.checkVisibility(),
        right: node.getBoundingClientRect().right,
        edge: node.parentElement!.getBoundingClientRect().right,
      };
    }),
  );
  assert(times.length > 0);
  for (const time of times) {
    assert.equal(time.text, time.expected);
    assert.equal(time.title, time.expectedTitle);
    assert.equal(time.visible, time.speakerVisible);
    if (time.visible) assert(Math.abs(time.right - time.edge) < 1);
  }
}

async function assertTouchMenuPosition(page: Page, point: { x: number; y: number }): Promise<void> {
  const layout = await page.locator("#message-menu").evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    const inset = (side: string) => parseFloat(style.getPropertyValue(`--menu-safe-${side}`)) || 0;
    return {
      x: rect.x,
      y: rect.y,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
      leftLimit: (visualViewport?.offsetLeft ?? 0) + inset("left") + 8,
      topLimit: (visualViewport?.offsetTop ?? 0) + inset("top") + 8,
      rightLimit:
        (visualViewport?.offsetLeft ?? 0) +
        (visualViewport?.width ?? innerWidth) -
        inset("right") -
        8,
      bottomLimit:
        (visualViewport?.offsetTop ?? 0) +
        (visualViewport?.height ?? innerHeight) -
        inset("bottom") -
        8,
      targets: Array.from(node.querySelectorAll("button"))
        .filter((button) => button.checkVisibility())
        .map((button) => button.getBoundingClientRect().height),
    };
  });
  assert(layout.x >= layout.leftLimit - 1);
  assert(layout.y >= layout.topLimit - 1);
  assert(layout.right <= layout.rightLimit + 1);
  assert(layout.bottom <= layout.bottomLimit + 1);
  assert(layout.width <= 260);
  for (const height of layout.targets) assert(height >= 44);
  // Prefer above the finger; flip below when there's insufficient space above.
  if (point.y - 12 - layout.height >= layout.topLimit)
    assert(Math.abs(layout.bottom - (point.y - 12)) <= 1);
  else if (point.y + 12 + layout.height <= layout.bottomLimit)
    assert(Math.abs(layout.y - (point.y + 12)) <= 1);
  if (point.x + 12 + layout.width <= layout.rightLimit)
    assert(Math.abs(layout.x - (point.x + 12)) <= 1);
  else if (point.x - 12 - layout.width >= layout.leftLimit)
    assert(Math.abs(layout.right - (point.x - 12)) <= 1);
}

async function openMessageActions(page: Page, actions: Locator): Promise<void> {
  const desktop = await page.evaluate(
    () => matchMedia("(hover: hover) and (pointer: fine)").matches,
  );
  if (desktop) {
    await actions.hover();
    assert.equal(await actions.evaluate((node) => getComputedStyle(node).opacity), "1");
    await actions.click();
    return;
  }
  assert.equal(await actions.evaluate((node) => getComputedStyle(node).opacity), "0");
  const point = await actions.evaluate((node) => {
    const target =
      node.closest(".tool-call")?.querySelector(":scope > summary") ??
      node.closest("article")?.querySelector(":scope > .text") ??
      node.closest("article");
    if (!target) throw new Error("Missing long-press target");
    target.scrollIntoView({ block: "center" });
    const box = target.getBoundingClientRect();
    return { x: box.left + 2, y: box.top + 2 };
  });
  const touch = await page.context().newCDPSession(page);
  try {
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ ...point, id: 1 }],
    });
    await page.waitForSelector("#message-menu:popover-open");
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    assert.equal(await page.locator("#message-menu").isVisible(), true);
    await assertTouchMenuPosition(page, point);
  } finally {
    await touch.detach();
  }
}

export async function browserFlow(
  t: TestContext,
  f: {
    sessions: Sessions;
    workspace: string;
    binding: ExecutionBinding;
    faux: ReturnType<typeof fauxProvider>;
    filePath?: string;
    extended?: boolean;
    restart?: () => Promise<Sessions>;
  },
) {
  const assets = await mkdtemp(join(tmpdir(), "pi-serve-assets-"));
  t.after(() => rm(assets, { recursive: true, force: true }));
  const source = dirname(fileURLToPath(import.meta.url));
  const screenshots = process.env.PI_SCREENSHOT_DIR;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  await buildAssets(source, assets);
  const base = await serve(t, f.sessions, assets);
  const executablePath =
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
    (process.env.PATH ?? "")
      .split(delimiter)
      .map((path) => join(path, "chromium"))
      .find(existsSync);
  assert(executablePath, "Chromium is required for browser tests; use nix develop.");
  const browser = await chromium.launch({ executablePath });
  t.after(() => browser.close());
  const browserContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await browserContext.newPage();
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  // The showcase uses production CSS, needs no API, and also works from disk.
  const showcase = await browserContext.newPage();
  showcase.on("pageerror", (error) => errors.push(error));
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
  const thinkingText = "Considering the next step.\n".repeat(40);
  f.faux.setResponses([
    fauxAssistantMessage(
      [
        { type: "thinking", thinking: "" },
        { type: "thinking", thinking: thinkingText },
        fauxToolCall("write", { path: f.filePath ?? "browser.json", content: '{"value":31}' }),
      ],
      {
        stopReason: "toolUse",
      },
    ),
    fauxAssistantMessage('<img src=x onerror="document.body.dataset.injected=1">'),
  ]);
  await page.goto(base);
  await page.waitForFunction(
    () => document.querySelector<HTMLSelectElement>("#models")?.options.length === 2,
  );
  await page.selectOption(
    "#targets",
    JSON.stringify([f.binding.provider, f.binding.target, f.binding.cwd]),
  );
  await page.selectOption("#models", "0");
  await page.click("#create");
  await page.waitForFunction(() => new URL(location.href).searchParams.has("session"));
  const url = page.url();
  const id = new URL(url).searchParams.get("session");
  assert(id);
  await page.waitForFunction(
    () => !document.querySelector<HTMLButtonElement>("#settings")?.disabled,
  );
  assert.equal(
    await page
      .locator("#transcript")
      .evaluate((node) => getComputedStyle(node, "::before").content),
    "none",
  );
  const emptyPrompt = await page.locator("#prompt").boundingBox();
  assert(emptyPrompt);
  assert(emptyPrompt.height >= 140);
  assert(emptyPrompt.y + emptyPrompt.height < 844 / 2);
  await page.locator("#prompt").tap();
  assert.deepEqual(await page.locator("#prompt").boundingBox(), emptyPrompt);
  assert.equal(await page.evaluate(() => scrollY), 0);
  await page.fill("#prompt", "Run the browser integration test.");
  await page.click("#send");
  const session = await f.sessions.get(id);
  await waitFor(() => exists(join(f.workspace, "browser.json")));
  await session.root.waitForIdle(context);
  assert.deepEqual(JSON.parse(await readFile(join(f.workspace, "browser.json"), "utf8")), {
    value: 31,
  });
  await page.waitForFunction(() => document.querySelectorAll("#transcript article").length === 3);
  assert.equal(await page.locator(".tool-call").count(), 1);
  await assertMessageTimestamps(page);
  assert.deepEqual(
    await page
      .locator("article > header > .message-time")
      .evaluateAll((nodes) => nodes.map((node) => (node as HTMLTimeElement).dateTime)),
    (await session.history())
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
  assert((await page.locator("#prompt").boundingBox())!.height < emptyPrompt.height);
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
          true,
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
  await page.locator("#title").tap();
  assert.equal(await page.locator("#message-menu").isVisible(), false);
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
  const reconnected = await browserContext.newPage();
  reconnected.on("pageerror", (error) => errors.push(error));
  await reconnected.goto(url);
  await reconnected.waitForFunction(
    () => document.querySelectorAll("#transcript article").length === 3,
  );
  assert.equal((await f.sessions.catalog()).sessions.length, 1);
  assert.equal(f.faux.state.callCount, 2);
  assert.equal(errors.length, 0);
  const iconStates = {
    cancelled: "⊘",
    done: "✓",
    unfinished: "◷",
    unavailable: "?",
    unknown: "?",
  };
  // Persist both supported nested-call record formats. Legacy codemode args are
  // deliberately truncated JSON: display text, not a parseable input payload.
  await session.root.commit(async (tx) => {
    await tx.appendEntry(session.root.id, {
      kind: "test.tool-history",
      model: [
        fauxAssistantMessage(
          fauxToolCall(
            "codemode",
            { code: 'await tools.read({ path: "example.txt" })' },
            { id: "code-history" },
          ),
        ),
        {
          role: "toolResult",
          toolCallId: "code-history",
          durationMs: 1234,
          toolName: "codemode",
          content: [{ type: "text", text: "Nested call finished" }],
          isError: false,
          timestamp: 1,
          details: {
            note: '<img src=x onerror="document.body.dataset.metadataInjected = 1">',
            calls: [
              { id: 1, name: "read", args: '{"path":"example...', status: "ok", durationMs: 2 },
              { id: 2, name: "read", args: '{"path":"pending.txt"}', status: "pending" },
              ...Object.keys(iconStates).map((status, index) => ({
                id: index + 3,
                name: "read",
                args: JSON.stringify({ path: `${status}.txt` }),
                ...(status === "done" ? { durationMs: 0 } : {}),
                status,
              })),
            ],
          },
        },
        {
          role: "toolResult",
          toolCallId: "nested-history",
          toolName: "custom.tool",
          content: [],
          isError: true,
          timestamp: 2,
          nestedCalls: {
            complete: false,
            calls: [
              {
                id: "nested-history/c1",
                name: "read",
                status: "error",
                argumentsBytes: 300,
                durationMs: 65000,
                error: "File unavailable",
              },
            ],
          },
        },
      ],
    });
  }, context);
  await reconnected.waitForSelector(".nested-tools", { state: "attached" });
  await reconnected.reload();
  await reconnected.waitForFunction(() => document.querySelectorAll(".nested-tools").length === 2);
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
  assert.equal(await reconnected.locator(".nested-tools .error").count(), 1);
  assert.equal(
    await reconnected.locator(".nested-tools > details").count(),
    5 + Object.keys(iconStates).length,
  );
  for (const [state, icon] of Object.entries(iconStates)) {
    const status = reconnected.locator(`.nested-tools .tool-status[data-state="${state}"]`);
    assert.equal(await status.textContent(), icon);
    assert.equal(await status.getAttribute("aria-label"), state);
    assert.equal(await status.getAttribute("title"), state);
  }
  assert.equal(
    await reconnected
      .locator('.tool-call[data-call-id="code-history"] > summary > .tool-duration')
      .textContent(),
    "1.2s",
  );
  for (const [state, duration] of [
    ["ok", "2ms"],
    ["done", "0ms"],
    ["error", "65.0s"],
  ] as const)
    assert.equal(
      await reconnected
        .locator(`.nested-tools .tool-call[data-state="${state}"] > summary > .tool-duration`)
        .textContent(),
      duration,
    );
  assert.equal(
    await reconnected
      .locator('.nested-tools .tool-call[data-state="pending"] .tool-duration')
      .count(),
    0,
  );
  await reconnected.locator('.tool-call[data-call-id="code-history"] > summary').click();
  await reconnected
    .locator('.tool-call[data-call-id="code-history"] .nested-tools > summary')
    .click();
  for (const state of ["pending", "unfinished"]) {
    const status = reconnected.locator(`.tool-status[data-state="${state}"]`);
    assert.equal(await status.textContent(), "◷");
    assert.equal(await status.locator("span").count(), 0);
    assert.equal(await status.evaluate((node) => getComputedStyle(node).animationName), "none");
  }
  for (const state of ["completed", "ok", "done", "cancelled", "unavailable", "unknown"]) {
    const status = reconnected.locator(`.tool-status[data-state="${state}"]`).first();
    assert.equal(
      await status.evaluate((node) => getComputedStyle(node).color),
      ["completed", "ok", "done"].includes(state) ? "rgb(175, 214, 188)" : "rgb(150, 158, 157)",
    );
  }
  if (screenshots)
    await reconnected.locator('.tool-call[data-call-id="code-history"]').screenshot({
      path: join(screenshots, "mobile-tool-statuses.png"),
    });
  // Collapsed metadata keeps searchable/copyable text, but no syntax spans.
  const historyCall = reconnected.locator('.tool-call[data-call-id="code-history"]');
  const rawDetails = historyCall.locator(".nested-tools > details").last();
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
  await reconnected.click("#menu-toggle");
  await reconnected.click("#find");
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

  const nestedError = reconnected.locator(
    '.nested-tools .tool-call[data-state="error"] > summary > .tool-status',
  );
  assert.equal(await nestedError.textContent(), "✕");
  assert.equal(
    await nestedError.evaluate((node) => getComputedStyle(node).color),
    "rgb(255, 173, 173)",
  );
  assert.equal(errors.length, 0);
  // Parallel calls of the same tool pair by ID, not tool name or result order.
  const fullCommand = `printf '%s\\n' '${"long command argument ".repeat(18)}'\necho finished`;
  await session.root.commit(async (tx) => {
    await tx.appendEntry(session.root.id, {
      kind: "test.parallel-tools",
      model: [
        fauxAssistantMessage([
          fauxToolCall("bash", { command: fullCommand }, { id: "parallel-first" }),
          fauxToolCall("bash", { command: "echo second" }, { id: "parallel-second" }),
        ]),
      ],
    });
  }, context);
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
  await session.root.commit(async (tx) => {
    await tx.appendEntry(session.root.id, {
      kind: "test.parallel-results",
      model: [
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
      ],
    });
  }, context);
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
  if (!f.extended) return;
  for (const [locale, timezoneId] of [
    ["de-DE", "Europe/Berlin"],
    ["en-US", "America/Los_Angeles"],
  ]) {
    const localized = await browser.newContext({ locale, timezoneId });
    try {
      const page = await localized.newPage();
      await page.goto(url);
      await page.waitForSelector('.tool-call[data-call-id="parallel-first"]');
      await assertMessageTimestamps(page);
    } finally {
      await localized.close();
    }
  }

  // Completed tool subtrees must survive unrelated runs, not merely look the
  // same after being rebuilt (which loses selection and repeats highlighting).
  const historicalTool = await firstCall.elementHandle();
  const historicalOutput = await firstCall.locator(".tool-result").elementHandle();
  assert(historicalTool);
  assert(historicalOutput);

  // A real repository in the bound workspace, created through the scripted agent.
  f.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("bash", {
        command:
          "git init --initial-branch=pi-pwa && git -c user.name=Pi -c user.email=pi@example.invalid commit --allow-empty -m Initial",
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Repository ready."),
  ]);
  await reconnected.fill("#prompt", "Initialize the workspace repository.");
  await reconnected.click("#send");
  await reconnected.waitForFunction(() =>
    document.querySelector("#usage-repository")?.textContent?.startsWith("pi-pwa · "),
  );
  await session.root.waitForIdle(context);
  assert.equal(await historicalTool.evaluate((node) => node.isConnected), true);
  assert.equal(await historicalOutput.evaluate((node) => node.isConnected), true);

  // Real edit tool details carry a unified patch independently of assistant prose.
  f.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("edit", { path: f.filePath ?? "browser.json", oldText: "31", newText: "32" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Updated the stored value."),
  ]);
  await reconnected.fill("#prompt", "Update the stored value.");
  await reconnected.click("#send");
  await reconnected.waitForFunction(() => !!document.querySelector(".tool-result .hljs-addition"));
  await session.root.waitForIdle(context);
  assert.equal(JSON.parse(await readFile(join(f.workspace, "browser.json"), "utf8")).value, 32);

  // Scripted code-review conversation: real Durable storage, tools and streamed events.
  f.faux.setResponses([
    fauxAssistantMessage(`Updated the counter. **Small change, same interface.**

\`\`\`typescript
export function increment(value: number): number {
  return value + 1;
}
\`\`\`

\`\`\`diff
@@ -1,3 +1,3 @@
 export function increment(value: number): number {
-  return value;
+  return value + 1;
 }
\`\`\`

The new behavior is covered by a focused test. Run \`npm test\` to verify.`),
  ]);
  await reconnected.fill("#prompt", "Fix the counter and show me the change.");
  await reconnected.press("#prompt", "Control+Enter");
  await reconnected.waitForFunction(
    () =>
      document.querySelectorAll('article[data-role="assistant"] .text .hljs-addition').length > 0,
  );
  await session.root.waitForIdle(context);
  assert((await reconnected.locator(".hljs-keyword").count()) > 0);
  assert((await reconnected.locator(".hljs-deletion").count()) > 0);
  // Settings persist in the actual agent document, not just in the form.
  await reconnected.click("#menu-toggle");
  await reconnected.click("#settings");
  await reconnected.selectOption("#thinking", "high");
  await reconnected.fill("#session-name", "Counter cleanup");
  await reconnected.fill("#instructions", "Keep changes small and verify them.");
  await reconnected.click("#save-settings");
  await reconnected.waitForFunction(
    () => !document.querySelector<HTMLDialogElement>("#preferences")?.open,
  );
  assert.equal((await session.root.agent(context)).thinkingLevel, "high");
  assert.equal((await session.info()).name, "Counter cleanup");

  const ledger = await session.harness.snapshot(UsageDoc, session.root.id, context);
  assert(ledger);
  const buckets = [...Object.values(ledger.models), ...Object.values(ledger.tools)];
  const expectedInput = buckets.reduce((sum, usage) => sum + usage.input, 0);
  const expectedOutput = buckets.reduce((sum, usage) => sum + usage.output, 0);
  const expectedRead = buckets.reduce((sum, usage) => sum + usage.cacheRead, 0);
  const expectedWrite = buckets.reduce((sum, usage) => sum + usage.cacheWrite, 0);
  const expectedContext = (await snapshot(`${base}/api/sessions/${id}/events`)).context;
  // Exercise secondary controls in both pointer/keyboard and touch layouts.
  const shot = async (page: Page, name: string) => {
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight),
      true,
      `${name}: clipped action buttons must not escape the transcript scrollport`,
    );
    const compactComposer = await page.evaluate(
      () => matchMedia("(min-width: 651px) and (hover: hover) and (pointer: fine)").matches,
    );
    const composerAlignment = await page.locator(".compose-box > .actions").evaluate((row) => {
      const buttons = Array.from(row.querySelectorAll("button")).filter((button) =>
        button.checkVisibility(),
      );
      return buttons.map((button) => {
        const box = button.getBoundingClientRect();
        const text = document.createRange();
        text.selectNodeContents(button);
        const label = text.getBoundingClientRect();
        return {
          id: button.id,
          height: box.height,
          width: box.width,
          fontSize: getComputedStyle(button).fontSize,
          center: box.top + box.height / 2,
          labelCenter: label.top + label.height / 2,
        };
      });
    });
    for (const button of composerAlignment) {
      assert.equal(button.height, compactComposer ? 32 : 40, `${name}: ${button.id} height`);
      if (["input-toggle", "send", "stop"].includes(button.id)) {
        assert.equal(button.width, compactComposer ? 32 : 40, `${name}: ${button.id} width`);
        assert.equal(button.fontSize, compactComposer ? "18px" : "20px");
      }
      assert(
        Math.abs(button.center - composerAlignment[0].center) <= 1,
        `${name}: ${button.id} button alignment`,
      );
      assert(
        Math.abs(button.labelCenter - composerAlignment[0].labelCenter) <= 1,
        `${name}: ${button.id} label alignment`,
      );
    }
    const queueAlignment = await page.locator("#queue > div").evaluateAll((rows) =>
      rows.map((row) => {
        const box = row.getBoundingClientRect();
        const button = row.querySelector("button")!.getBoundingClientRect();
        return box.top + box.height / 2 - button.top - button.height / 2;
      }),
    );
    for (const offset of queueAlignment)
      assert(Math.abs(offset) <= 1, `${name}: queue cancel alignment`);
    // Compare text, not button boxes: flex children must share the vertical
    // center of the adjacent native button label, including taller touch targets.
    const offsets = await page.locator("#bottom-line:visible").evaluateAll((footers) => {
      const textCenter = (button: Element) => {
        const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
        const rects: DOMRect[] = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!node.textContent?.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          rects.push(...Array.from(range.getClientRects()).filter((rect) => rect.height > 0));
        }
        return (
          (Math.min(...rects.map((rect) => rect.top)) +
            Math.max(...rects.map((rect) => rect.bottom))) /
          2
        );
      };
      return footers.flatMap((footer) => {
        const groups = Array.from(footer.querySelectorAll(".footer-row"), (row) =>
          Array.from(row.querySelectorAll("button")).filter((node) => node.checkVisibility()),
        );
        return groups.map(([left, right]) => textCenter(left) - textCenter(right));
      });
    });
    for (const offset of offsets)
      assert(Math.abs(offset) <= 1, `${name}: footer text offset ${offset}px`);
    if (
      (page.viewportSize()?.width ?? Infinity) <= 650 &&
      (await page.locator("#bottom-line").isVisible())
    ) {
      const layout = await page.locator("#bottom-line").evaluate((footer) => {
        const box = footer.getBoundingClientRect();
        const [model, context] = Array.from(
          footer.querySelectorAll("#footer-model, #footer-context"),
          (node) => node.getBoundingClientRect(),
        );
        return {
          height: box.height,
          offset: (model.left + context.right) / 2 - (box.left + box.right) / 2,
          overlap: model.right > context.left,
          dots: Array.from(footer.querySelectorAll(".footer-dot"), (node) => {
            const dot = node.getBoundingClientRect();
            return {
              width: dot.width,
              height: dot.height,
              offset: dot.top + dot.height / 2 - (box.top + box.height / 2),
              radius: getComputedStyle(node).borderRadius,
            };
          }),
          overflow: footer.scrollWidth > footer.clientWidth,
          buttons: Array.from(footer.querySelectorAll("button"))
            .filter((node) => node.checkVisibility())
            .map((node) => node.id),
        };
      });
      assert.equal(
        layout.height,
        28,
        `${name}: mobile footer must remain one line without padding`,
      );
      assert(Math.abs(layout.offset) <= 1, `${name}: mobile footer must be centered`);
      assert.equal(layout.dots.length, 2);
      for (const dot of layout.dots) {
        assert.equal(dot.width, 2);
        assert.equal(dot.height, 2);
        assert.equal(dot.radius, "50%");
        assert(Math.abs(dot.offset) <= 1, `${name}: dots must be vertically centered`);
      }
      assert.equal(layout.overlap, false);
      assert.equal(layout.overflow, false);
      assert.deepEqual(layout.buttons, ["footer-model", "footer-context"]);
    }
    if (screenshots)
      await page.screenshot({ path: join(screenshots, `${name}.png`), fullPage: true });
  };
  const gallery = async (page: Page, size: string) => {
    await page.locator("#transcript").evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await page.waitForFunction(() =>
      document.querySelector("#usage-repository")?.textContent?.startsWith("pi-pwa · "),
    );
    await shot(page, `${size}-conversation`);
    for (const tool of ["bash", "edit"]) {
      const call = page.locator(`.tool-call[data-tool="${tool}"]`).last();
      await call.evaluate((node) => {
        (node as HTMLDetailsElement).open = false;
      });
      await call.scrollIntoViewIfNeeded();
      await shot(page, `${size}-collapsed-${tool}`);
      await call.evaluate((node) => {
        (node as HTMLDetailsElement).open = true;
      });
      await call.scrollIntoViewIfNeeded();
      await shot(page, `${size}-unified-${tool}`);
      await call.evaluate((node) => {
        (node as HTMLDetailsElement).open = false;
      });
    }

    for (const [field, expected] of [
      ["input", expectedInput],
      ["output", expectedOutput],
      ["read", expectedRead],
    ] as const)
      assert.equal(
        Number(await page.locator(`#footer-${field}`).getAttribute("data-value")),
        expected,
      );
    assert.equal(
      Number(await page.locator("#footer-context").getAttribute("data-tokens")),
      expectedContext.lastResponse?.tokens,
    );
    assert.equal(await page.locator("#footer-read").isVisible(), size === "desktop");
    assert.equal(await page.locator("#footer-model-name").isVisible(), size !== "desktop");
    assert.equal(await page.locator("#footer-effort").textContent(), "high");
    assert.deepEqual(
      await page
        .locator("#footer-stats > span")
        .evaluateAll((nodes) => nodes.map((node) => node.id)),
      ["footer-input", "footer-output", "footer-read", "footer-hit", "footer-cost"],
    );
    assert.deepEqual(
      await page
        .locator("#bottom-line button")
        .evaluateAll((nodes) =>
          nodes.filter((node) => node.checkVisibility()).map((node) => node.id),
        ),
      size === "desktop" ? ["footer-stats", "footer-context"] : ["footer-model", "footer-context"],
    );
    await page.click(size === "desktop" ? "#footer-stats" : "#footer-context");
    await page.waitForSelector("#usage-dialog[open]");
    assert.equal(await page.locator("#usage-input").textContent(), expectedInput.toLocaleString());
    assert.equal(await page.locator("#usage-thinking").textContent(), "high");
    assert.equal(await page.locator("#usage-write").textContent(), expectedWrite.toLocaleString());
    await shot(page, `${size}-footer-breakdown`);
    await page.keyboard.press("Escape");
    if (size === "desktop") {
      await page.click("#menu-toggle");
      await page.click("#settings");
    } else {
      await page.click("#footer-model");
    }
    await page.waitForSelector("#preferences[open]");
    assert.equal(await page.locator("#thinking").inputValue(), "high");
    assert.equal(
      await page.locator("#footer-model").getAttribute("title"),
      `${await page.locator("#usage-model").textContent()} · thinking high`,
    );
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#stop").isVisible(), false);
    assert.equal(await page.locator("#input-mode").isVisible(), false);
    assert.equal(await page.locator("#send").getAttribute("aria-label"), "Send");
    assert.equal(await page.locator("#send [aria-hidden=true]").textContent(), "↑");
    assert.equal(await page.locator("#stop [aria-hidden=true]").textContent(), "×");
    assert.equal(await page.locator('label[for="prompt"]').count(), 0);
    await page.click("#menu-toggle");
    await page.waitForFunction(() =>
      document.querySelector("#conversation-menu")?.matches(":popover-open"),
    );
    if (size === "mobile") {
      const menuBox = await page.locator("#conversation-menu").boundingBox();
      assert(menuBox);
      assert.equal(menuBox.x, 10);
      assert.equal(menuBox.width, page.viewportSize()!.width - 20);
      assert.equal(menuBox.y + menuBox.height, page.viewportSize()!.height - 10);
    }
    await shot(page, `${size}-menu`);
    await page.keyboard.press("End");
    assert.equal(
      await page.locator("#wrap-code").evaluate((node) => node === document.activeElement),
      true,
    );
    await page.keyboard.press("Enter");
    assert.equal(
      await page.locator("body").evaluate((node) => node.classList.contains("wrap-code")),
      true,
    );
    await page.keyboard.press("Escape");
    assert.equal(
      await page.locator("#menu-toggle").evaluate((node) => node === document.activeElement),
      true,
    );
    await page.click("#menu-toggle");
    await page.waitForFunction(
      () =>
        document.activeElement ===
        document.querySelector("#conversation-menu button:not(:disabled):not([hidden])"),
    );
    const firstMenuItem = await page.evaluate(() => document.activeElement?.id);
    await page.keyboard.press("Control+j");
    assert.notEqual(await page.evaluate(() => document.activeElement?.id), firstMenuItem);
    await page.keyboard.press("Control+k");
    assert.equal(await page.evaluate(() => document.activeElement?.id), firstMenuItem);
    assert.equal(await page.locator("#picker").isVisible(), false);
    await page.click("#find");
    await page.fill("#search", "counter");
    assert.equal(await page.locator("article.search-hit").count(), 2);
    assert(await page.evaluate(() => (CSS.highlights.get("pi-search")?.size ?? 0) > 0));
    const before = await page
      .locator("article.search-current")
      .evaluate((node) => node.dataset.role);
    await page.keyboard.press("Control+j");
    assert.notEqual(
      await page.locator("article.search-current").evaluate((node) => node.dataset.role),
      before,
    );
    await page.keyboard.press("Control+k");
    assert.equal(
      await page.locator("article.search-current").evaluate((node) => node.dataset.role),
      before,
    );
    assert.equal(await page.locator("#picker").isVisible(), false);
    await page.click("#search-next");
    assert.notEqual(
      await page.locator("article.search-current").evaluate((node) => node.dataset.role),
      before,
    );
    await shot(page, `${size}-search`);
    await page.fill("#search", "Successfully");
    assert.equal(await page.locator("article.search-hit").count(), 2);
    assert((await page.locator("article.search-current details[open]").count()) > 0);
    await shot(page, `${size}-tool-search`);
    await page.fill("#search", "[");
    assert.equal(await page.locator("#notice").isVisible(), false);
    await page.fill("#search", "missing-word-abcdef");
    assert.equal(await page.locator("article.search-hit").count(), 0);
    assert.equal(await page.locator("#search-next").isDisabled(), true);
    await page.press("#search", "Escape");
    assert.equal(await page.locator("#search-bar").isVisible(), false);
    await openMessageActions(page, page.locator("article .message-actions").last());
    await shot(page, `${size}-message-menu`);
    await page.click("#quote-message");
    assert.equal(
      await page.locator("#prompt").evaluate((node) => document.activeElement === node),
      true,
    );
    assert.equal(
      (await page.locator("#prompt").inputValue()).startsWith("> Updated the counter."),
      true,
    );
    await shot(page, `${size}-quote`);
    await page.fill("#prompt", "");
    await page.click("#input-toggle");
    assert.equal(await page.locator("#input-menu select").count(), 0);
    assert.equal(await page.locator("#input-menu > button").count(), 1);
    await shot(page, `${size}-input-menu`);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+k");
    await page.waitForSelector("#picker[open]");
    await page.keyboard.press("/");
    assert.equal(
      await page.locator("#session-filter").evaluate((node) => node === document.activeElement),
      true,
    );
    await page.fill("#session-filter", "Counter cleanup");
    await page.keyboard.press("Control+j");
    assert.equal(
      await page.locator("#sessions button").evaluate((node) => node === document.activeElement),
      true,
    );
    await page.keyboard.press("Control+k");
    assert.equal(
      await page.locator("#sessions button").evaluate((node) => node === document.activeElement),
      true,
    );
    assert.equal(await page.locator("#sessions button").count(), 1);
    if (size === "mobile")
      assert.equal(
        await page
          .locator("#picker")
          .evaluate((node) => Math.round(node.getBoundingClientRect().width)),
        390,
      );
    await shot(page, `${size}-sessions`);
    await page.fill("#session-filter", "not-a-session");
    assert.equal(await page.locator("#sessions button").count(), 0);
    assert.equal(await page.locator("#sessions-empty").isVisible(), true);
    await page.fill("#session-filter", "");
    await page.keyboard.press("Escape");
    await page.click("#menu-toggle");
    await page.click("#settings");
    assert.equal(await page.locator("#session-name").inputValue(), "Counter cleanup");
    if (size === "mobile")
      assert.equal(
        await page
          .locator("#preferences")
          .evaluate((node) => Math.round(node.getBoundingClientRect().width)),
        390,
      );
    await shot(page, `${size}-settings`);
    await page.keyboard.press("Escape");
    // Persisted presentation preference and name survive a page reload.
    await page.reload();
    await page.waitForSelector('article[data-role="assistant"] .text .hljs-addition');
    assert.equal(
      await page.locator("body").evaluate((node) => node.classList.contains("wrap-code")),
      true,
    );
    await page.click("#menu-toggle");
    await page.click("#wrap-code");
    await page.keyboard.press("Escape");
    await page.locator("#transcript").evaluate((node) => {
      node.scrollTop = 0;
    });
    await page.waitForSelector("#latest", { state: "visible" });
    await shot(page, `${size}-history`);
    await page.click("#latest");
    await page.waitForSelector("#latest", { state: "hidden" });
  };
  const desktop = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const desktopPage = await desktop.newPage();
  desktopPage.on("pageerror", (error) => errors.push(error));
  await desktopPage.goto(url);
  await desktopPage.waitForSelector('article[data-role="assistant"] .text .hljs-addition');
  const desktopActions = desktopPage
    .locator('article[data-role="user"] > header > .message-actions')
    .last();
  await desktopPage.mouse.move(0, 0);
  assert.equal(await desktopActions.evaluate((node) => getComputedStyle(node).opacity), "0");
  await desktopActions.focus();
  assert.equal(await desktopActions.evaluate((node) => getComputedStyle(node).opacity), "1");
  await desktopActions.press("Enter");
  assert.equal(await desktopPage.locator("#message-menu").isVisible(), true);
  await desktopPage.keyboard.press("Escape");
  await desktopPage.locator("#prompt").focus();
  await desktopActions.hover();
  assert.equal(await desktopActions.evaluate((node) => getComputedStyle(node).opacity), "1");
  await desktopPage.mouse.move(0, 0);
  assert.equal(await desktopActions.evaluate((node) => getComputedStyle(node).opacity), "0");
  await gallery(desktopPage, "desktop");
  await desktop.setOffline(true);
  await desktopPage.waitForFunction(
    () => document.querySelector<HTMLElement>("#bottom-line")?.dataset.connected === "false",
  );
  await desktopPage.click("#footer-stats");
  assert.equal(await desktopPage.locator("#usage-connection").isVisible(), true);
  assert.equal(
    Number(await desktopPage.locator("#footer-input").getAttribute("data-value")),
    expectedInput,
  );
  await shot(desktopPage, "desktop-footer-offline");
  await desktopPage.keyboard.press("Escape");
  await desktop.setOffline(false);
  await desktopPage.waitForFunction(
    () => document.querySelector<HTMLElement>("#bottom-line")?.dataset.connected === "true",
  );
  await desktopPage.waitForSelector('article[data-role="assistant"] .text .hljs-addition');
  // Stress the presentation with a persisted high-usage ledger. No fake HTTP/SSE data.
  await session.root.commit(async (tx) => {
    const usage = await tx.doc(UsageDoc, session.root.id);
    usage.models["stress/model"] = {
      input: 15_000_000,
      output: 81_000,
      cacheRead: 1_300_000,
      cacheWrite: 20_000,
      totalTokens: 16_401_000,
      cost: { input: 150, output: 4, cacheRead: 0.9, cacheWrite: 0.089, total: 154.989 },
    };
  }, context);
  await desktopPage.waitForFunction(
    () => Number(document.querySelector<HTMLElement>("#footer-input")?.dataset.value) > 15_000_000,
  );
  await shot(desktopPage, "desktop-footer-high-usage");
  await reconnected.waitForFunction(
    () => Number(document.querySelector<HTMLElement>("#footer-input")?.dataset.value) > 15_000_000,
  );
  await reconnected.setViewportSize({ width: 320, height: 640 });
  await shot(reconnected, "mobile-footer-high-usage");
  await reconnected.click("#footer-context");
  await shot(reconnected, "mobile-footer-high-usage-breakdown");
  await reconnected.keyboard.press("Escape");
  await reconnected.setViewportSize({ width: 390, height: 844 });
  await session.root.commit(async (tx) => {
    const usage = await tx.doc(UsageDoc, session.root.id);
    delete usage.models["stress/model"];
  }, context);
  await reconnected.waitForFunction(
    (expected) =>
      Number(document.querySelector<HTMLElement>("#footer-input")?.dataset.value) === expected,
    expectedInput,
  );
  await openMessageActions(
    desktopPage,
    desktopPage.locator('article[data-role="user"] .message-actions').last(),
  );
  await desktopPage.click("#copy-message");
  assert.equal(
    await desktopPage.evaluate(() => navigator.clipboard.readText()),
    "Fix the counter and show me the change.",
  );
  await desktopPage.keyboard.press("Control+k");
  assert.equal(
    await desktopPage.locator("#picker").evaluate((node) => node.hasAttribute("open")),
    true,
  );
  await desktopPage.keyboard.press("Escape");
  await desktopPage.keyboard.press("Control+f");
  assert.equal(
    await desktopPage.locator("#search").evaluate((node) => document.activeElement === node),
    true,
  );
  await desktop.close();
  await gallery(reconnected, "mobile");
  // Chromium does not reproduce iOS's keyboard-triggered auto-zoom. Guard the
  // computed 16px minimum that prevents it, including controls inside dialogs
  // and touch viewports wider than the phone layout breakpoint.
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 844, height: 390 },
    { width: 768, height: 1024 },
    { width: 1024, height: 768 },
  ]) {
    await reconnected.setViewportSize(viewport);
    const undersized = await reconnected
      .locator('input:not([type="file"]), textarea, select')
      .evaluateAll((nodes) =>
        nodes
          .map((node) => ({ id: node.id, size: parseFloat(getComputedStyle(node).fontSize) }))
          .filter((field) => field.size < 16),
      );
    assert.deepEqual(
      undersized,
      [],
      `Touch form controls at ${viewport.width}px must not trigger iOS focus zoom`,
    );
    const scale = await reconnected.evaluate(() => visualViewport?.scale);
    await reconnected.fill("#prompt", "Check the input without changing the page zoom.");
    assert.equal(await reconnected.evaluate(() => visualViewport?.scale), scale);
    assert.equal(
      await reconnected.locator("#prompt").evaluate((node) => node === document.activeElement),
      true,
    );
    await shot(reconnected, `touch-focused-${viewport.width}`);
    await reconnected.fill("#prompt", "");
  }
  await reconnected.setViewportSize({ width: 320, height: 640 });
  await reconnected.locator("#transcript").evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await shot(reconnected, "mobile-narrow");
  // Keep effort and context readable when only the model name needs truncation.
  const modelLabel = reconnected.locator("#footer-model-name");
  const modelName = await modelLabel.textContent();
  await modelLabel.evaluate((node) => {
    node.textContent = "provider/very-long-model-name-with-version-20261017";
  });
  assert.equal(await modelLabel.evaluate((node) => node.scrollWidth > node.clientWidth), true);
  for (const id of ["footer-effort", "footer-context"])
    assert.equal(
      await reconnected.locator(`#${id}`).evaluate((node) => node.scrollWidth <= node.clientWidth),
      true,
    );
  await shot(reconnected, "mobile-narrow-long-model");
  await modelLabel.evaluate((node, text) => {
    node.textContent = text;
  }, modelName);
  await reconnected.click("#menu-toggle");
  await shot(reconnected, "mobile-narrow-menu");
  await reconnected.keyboard.press("Escape");
  await reconnected.setViewportSize({ width: 768, height: 1024 });
  await shot(reconnected, "tablet");
  await reconnected.setViewportSize({ width: 390, height: 844 });

  // Fork history is isolated and survives a browser reload.
  const originalEntries = await session.history();
  await openMessageActions(reconnected, reconnected.locator("article .message-actions").last());
  await reconnected.click("#fork-message");
  await reconnected.waitForFunction(() => new URL(location.href).searchParams.has("conversation"));
  const branchId = Number(new URL(reconnected.url()).searchParams.get("conversation"));
  const branch = await session.conversation(branchId);
  assert.notEqual(branch.id, session.root.id);
  await reconnected.waitForFunction(
    () => document.querySelector<HTMLElement>("#footer-input")?.dataset.value === "0",
  );
  assert.equal(
    Number(await reconnected.locator("#footer-context").getAttribute("data-tokens")),
    expectedContext.lastResponse?.tokens,
  );
  f.faux.setResponses([fauxAssistantMessage("This alternative is isolated in the branch.")]);
  await reconnected.fill("#prompt", "Try another approach.");
  await reconnected.click("#send");
  await reconnected.waitForFunction(
    (count) => document.querySelectorAll("article[data-role=assistant]").length > count,
    3,
  );
  await branch.waitForIdle(context);
  assert.equal((await session.history()).length, originalEntries.length);
  await reconnected.fill("#prompt", "Unsent branch draft");
  await reconnected.reload();
  await reconnected.waitForFunction(
    () => document.querySelector<HTMLTextAreaElement>("#prompt")?.value === "Unsent branch draft",
  );
  await reconnected.fill("#prompt", "");

  // Queue both modes behind a deterministic provider barrier; cancel one.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  let entered = false;
  f.faux.setResponses([
    async () => {
      entered = true;
      await gate;
      return fauxAssistantMessage("First run finished.");
    },
    fauxAssistantMessage("Follow-up finished."),
  ]);
  await reconnected.fill("#prompt", "Start a controlled run.");
  await reconnected.click("#send");
  await waitFor(async () => entered);
  await reconnected.waitForFunction(
    () => !document.querySelector<HTMLButtonElement>("#stop")?.disabled,
  );
  assert.equal(await reconnected.locator("#input-mode").getAttribute("data-mode"), "followUp");
  await reconnected.click("#input-mode");
  assert.equal(await reconnected.locator("#input-mode").getAttribute("data-mode"), "steer");
  assert.equal(
    await reconnected.locator("#input-menu").evaluate((node) => node.matches(":popover-open")),
    false,
  );
  assert.equal(await reconnected.locator("#send").getAttribute("aria-label"), "Steer");
  await reconnected.fill("#prompt", "Withdraw this steering input.");
  await reconnected.click("#send");
  await reconnected.waitForFunction(() => document.querySelectorAll("#queue button").length === 1);
  await shot(reconnected, "mobile-working-queue");
  for (const width of [320, 768, 1440]) {
    await reconnected.setViewportSize({ width, height: 900 });
    await shot(reconnected, `working-buttons-${width}`);
  }
  await reconnected.setViewportSize({ width: 390, height: 844 });
  await reconnected.getByRole("button", { name: "Cancel queued message", exact: true }).click();
  await reconnected.waitForFunction(() => document.querySelector("#queue")?.hasAttribute("hidden"));
  await reconnected.click("#input-mode");
  assert.equal(await reconnected.locator("#input-mode").getAttribute("data-mode"), "followUp");
  assert.equal(await reconnected.locator("#send").getAttribute("aria-label"), "Queue");
  await shot(reconnected, "mobile-follow-up-buttons");
  await reconnected.fill("#prompt", "Follow up after the current run.");
  await reconnected.click("#send");
  await reconnected.waitForFunction(() => document.querySelectorAll("#queue button").length === 1);
  release();
  await branch.waitForIdle(context);
  await reconnected.waitForFunction(() => document.querySelector("#queue")?.hasAttribute("hidden"));
  const afterQueue = await session.history(branch);
  assert.equal(
    afterQueue.filter((entry) =>
      entry.model?.some(
        (message) => message.role === "user" && message.content === "Withdraw this steering input.",
      ),
    ).length,
    0,
  );
  assert.equal(
    afterQueue.filter((entry) =>
      entry.model?.some(
        (message) =>
          message.role === "user" && message.content === "Follow up after the current run.",
      ),
    ).length,
    1,
  );

  // Images are persisted as model input, not merely previewed in the browser.
  f.faux.setResponses([fauxAssistantMessage("The attached image is available.")]);
  const chooserPromise = reconnected.waitForEvent("filechooser");
  await reconnected.click("#input-toggle");
  const chooser = await chooserPromise;
  assert.equal(await reconnected.locator("#input-menu").isVisible(), false);
  assert.equal(chooser.isMultiple(), true);
  await chooser.setFiles(join(source, "icon-192.png"));
  await reconnected.waitForSelector("#attachments button");
  await reconnected.locator("#attachments button").click();
  await reconnected.fill("#prompt", "Describe this image.");
  const pastedImage = await readFile(join(source, "icon-192.png"));
  assert.equal(
    await reconnected.locator("#prompt").evaluate((input, bytes) => {
      const clipboardData = new DataTransfer();
      clipboardData.items.add(
        new File([new Uint8Array(bytes)], "pasted.png", { type: "image/png" }),
      );
      return input.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
      );
    }, Array.from(pastedImage)),
    false,
  );
  await reconnected.waitForSelector("#attachments button");
  assert.equal(await reconnected.locator("#prompt").inputValue(), "Describe this image.");
  assert.equal(
    await reconnected.locator("#prompt").evaluate((input) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", "ordinary text");
      return input.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
      );
    }),
    true,
  );
  await shot(reconnected, "mobile-attachment");
  await reconnected.click("#send");
  await reconnected.waitForFunction(
    () => document.querySelectorAll("#attachments button").length === 0,
  );
  await branch.waitForIdle(context);
  assert(
    (await session.history(branch)).some((entry) =>
      entry.model?.some(
        (message) =>
          message.role === "user" &&
          Array.isArray(message.content) &&
          message.content.some((block) => block.type === "image"),
      ),
    ),
  );

  // Stop a real running tool; waiting for the live slot avoids timing assumptions.
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 60" }), { stopReason: "toolUse" }),
  ]);
  await reconnected.fill("#prompt", "Run a command so I can stop it.");
  await reconnected.click("#send");
  await reconnected.waitForFunction(
    () => !!document.querySelector('.tool-call[data-state="running"]'),
  );
  const running = reconnected.locator('.tool-call[data-state="running"]');
  assert.equal(await running.count(), 1);
  const runningStatus = running.locator(":scope > summary > .tool-status");
  assert.equal(await runningStatus.textContent(), "");
  assert.equal(await runningStatus.getAttribute("aria-label"), "running");
  assert.equal(await runningStatus.getAttribute("title"), "running");
  assert.equal(await runningStatus.locator("span").count(), 4);
  assert.deepEqual(
    await runningStatus.evaluate((node) => {
      const style = getComputedStyle(node);
      return [style.gridTemplateColumns, style.gridTemplateRows, style.color];
    }),
    ["2px 2px", "2px 2px", "rgb(175, 214, 188)"],
  );
  assert.equal(
    await runningStatus
      .locator("span")
      .first()
      .evaluate((node) => getComputedStyle(node).animationName),
    "tool-spinner",
  );
  await reconnected.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(
    await runningStatus
      .locator("span")
      .first()
      .evaluate((node) => getComputedStyle(node).animationName),
    "none",
  );
  await reconnected.emulateMedia({ reducedMotion: "no-preference" });
  await running.locator(":scope > summary").click();
  const runningId = await running.getAttribute("data-call-id");
  await reconnected.click("#stop");
  await reconnected.waitForFunction(
    () => document.querySelector<HTMLButtonElement>("#stop")?.disabled,
  );
  await branch.waitForIdle(context);
  await reconnected.waitForFunction((id) => {
    const call = Array.from(document.querySelectorAll<HTMLElement>(".tool-call")).find(
      (node) => node.dataset.callId === id,
    );
    return !!call?.querySelector(".tool-result");
  }, runningId);
  assert.equal(await reconnected.locator(`.tool-call[data-call-id="${runningId}"]`).count(), 1);
  assert.equal(
    await reconnected
      .locator(`.tool-call[data-call-id="${runningId}"]`)
      .evaluate((node) => node.hasAttribute("open")),
    true,
  );

  // Context reset preserves history, and export returns the selected branch.
  await reconnected.click("#menu-toggle");
  await reconnected.click("#settings");
  reconnected.once("dialog", (dialog) => {
    void dialog.accept();
  });
  await reconnected.getByText("Context", { exact: true }).click();
  await reconnected.click("#reset");
  await reconnected.waitForFunction(
    () => !document.querySelector<HTMLDialogElement>("#preferences")?.open,
  );
  assert((await session.history(branch)).some((entry) => entry.kind === "pi.reset"));
  assert.equal((await branch.context(context)).messages.length, 0);
  await reconnected.waitForFunction(
    () => document.querySelector<HTMLElement>("#footer-context")?.dataset.tokens === "",
  );
  assert(Number(await reconnected.locator("#footer-input").getAttribute("data-value")) > 0);
  await shot(reconnected, "mobile-footer-reset");
  const download = reconnected.waitForEvent("download");
  await reconnected.click("#menu-toggle");
  await reconnected.click("#export");
  assert(await (await download).path());

  // Offline reload serves only the shell. It never replays writes or cached API data.
  await reconnected.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await reconnected.reload();
  await reconnected.waitForFunction(() => !!navigator.serviceWorker.controller);
  await browserContext.setOffline(true);
  await reconnected.reload();
  await reconnected.waitForSelector("#prompt");
  assert.equal(await reconnected.locator("#send").isDisabled(), true);
  await shot(reconnected, "mobile-offline");
  await browserContext.setOffline(false);
  await reconnected.waitForFunction(
    () => !document.querySelector<HTMLButtonElement>("#settings")?.disabled,
  );
  assert.equal(errors.length, 0);
  // Real codemode: the faux provider selects the tool, but QuickJS, nested
  // coding tools, Durable storage, SSE and both browser layouts are production.
  const codeFile = f.filePath ? join(dirname(f.filePath), "codemode.json") : "codemode.json";
  const releaseFile = join(f.workspace, "codemode-release");
  const desktopCodeContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const desktopCode = await desktopCodeContext.newPage();
  desktopCode.on("pageerror", (error) => errors.push(error));
  await desktopCode.goto(reconnected.url());
  f.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall(
        "codemode",
        {
          code: `
      await tools.write({ path: ${JSON.stringify(codeFile)}, content: '{"value":1}' });
      await tools.edit({ path: ${JSON.stringify(codeFile)}, edits: [{ oldText: "1", newText: "2" }] });
      await Promise.all([
        tools.read({ path: ${JSON.stringify(codeFile)} }),
        tools.bash({ command: ${JSON.stringify(`while [ ! -f ${JSON.stringify(releaseFile)} ]; do sleep 0.05; done`)} }),
      ]);
      return { updated: true, value: 2 };
    `,
        },
        { id: "real-codemode" },
      ),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Codemode updated and read the file, then finished the shell command."),
  ]);
  await reconnected.fill(
    "#prompt",
    "Use codemode to write, edit and read a file, and run a shell command.",
  );
  await reconnected.click("#send");
  try {
    for (const [page, size] of [
      [desktopCode, "desktop"],
      [reconnected, "mobile"],
    ] as const) {
      await page.waitForSelector(
        '.tool-call[data-call-id="real-codemode"] .tool-call[data-tool="bash"][data-state="running"]',
        { state: "attached" },
      );
      const call = page.locator('.tool-call[data-call-id="real-codemode"]');
      assert.equal(await call.count(), 1);
      await call.evaluate((node) => {
        (node as HTMLDetailsElement).open = true;
      });
      // Finished nested tools already have timing, even while their parent runs.
      await page.waitForSelector(
        '.tool-call[data-call-id="real-codemode"] .tool-call[data-tool="write"] > summary > .tool-duration',
        { state: "attached" },
      );
      assert.equal(await call.locator(":scope > summary > .tool-duration").count(), 0);
      assert.equal(
        await call.locator('.tool-call[data-state="running"] > summary > .tool-duration').count(),
        0,
      );
      await call.scrollIntoViewIfNeeded();
      await shot(page, `${size}-codemode-running`);
    }
  } finally {
    await writeFile(releaseFile, "release");
  }
  await branch.waitForIdle(context);
  assert.deepEqual(JSON.parse(await readFile(join(f.workspace, "codemode.json"), "utf8")), {
    value: 2,
  });
  const codeResult = (await session.history(branch))
    .flatMap((entry) => entry.model ?? [])
    .find((message) => message.role === "toolResult" && message.toolCallId === "real-codemode");
  assert(codeResult?.role === "toolResult");
  assert.equal(codeResult.isError, false);
  for (const [page, size] of [
    [desktopCode, "desktop"],
    [reconnected, "mobile"],
  ] as const) {
    await page.reload();
    await page.waitForSelector('.tool-call[data-call-id="real-codemode"][data-state="completed"]', {
      state: "attached",
    });
    const call = page.locator('.tool-call[data-call-id="real-codemode"]');
    assert.equal(await call.count(), 1);
    assert.equal(await call.locator(".nested-tools > details").count(), 5); // four calls plus raw metadata
    await call.evaluate((node) => {
      (node as HTMLDetailsElement).open = true;
      node.querySelector<HTMLDetailsElement>(".nested-tools")!.open = true;
    });
    await assertMessageTimestamps(page);
    assert.equal(await call.locator(".tool-duration").count(), 5);
    assert.deepEqual(
      await call
        .locator(".tool-call")
        .evaluateAll((nodes) => [
          ...new Set(nodes.map((node) => getComputedStyle(node).borderLeftWidth)),
        ]),
      ["0px"],
    );
    assert.equal(
      await call.locator(":scope > summary > .tool-duration").getAttribute("title"),
      `Duration: ${codeResult.durationMs}ms`,
    );
    // Timing stays at the right edge without overlapping long or expanded commands.
    for (const open of [false, true]) {
      await call.locator(".nested-tools > .tool-call").evaluateAll((nodes, expanded) => {
        for (const node of nodes) (node as HTMLDetailsElement).open = expanded;
      }, open);
      const positions = await call.locator(".tool-duration").evaluateAll((nodes) =>
        nodes.map((node) => ({
          right: node.getBoundingClientRect().right,
          edge: node.parentElement!.getBoundingClientRect().right,
          left: node.getBoundingClientRect().left,
          commandRight: node.parentElement!.querySelector(".tool-command")!.getBoundingClientRect()
            .right,
        })),
      );
      for (const position of positions) {
        assert(Math.abs(position.right - position.edge) < 1);
        assert(position.left - position.commandRight >= 7);
      }
    }
    await call.locator(".nested-tools > .tool-call").evaluateAll((nodes) => {
      for (const node of nodes) (node as HTMLDetailsElement).open = false;
    });
    await call.scrollIntoViewIfNeeded();
    await shot(page, `${size}-codemode-completed`);
  }
  f.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall(
        "codemode",
        {
          code: `await tools.read({ path: ${JSON.stringify(join(f.workspace, "missing-codemode-file"))} });`,
        },
        { id: "failed-codemode" },
      ),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("The nested read failed."),
  ]);
  await reconnected.fill("#prompt", "Exercise a nested codemode error.");
  await reconnected.click("#send");
  for (const [page, size] of [
    [desktopCode, "desktop"],
    [reconnected, "mobile"],
  ] as const) {
    await page.waitForSelector('.tool-call[data-call-id="failed-codemode"][data-state="failed"]', {
      state: "attached",
    });
    const call = page.locator('.tool-call[data-call-id="failed-codemode"]');
    assert.equal(await call.locator(".nested-tools .error").count(), 1);
    assert.equal(await call.locator(".tool-duration").count(), 2);
    await call.evaluate((node) => {
      (node as HTMLDetailsElement).open = true;
      node.querySelector<HTMLDetailsElement>(".nested-tools")!.open = true;
    });
    await call.scrollIntoViewIfNeeded();
    await shot(page, `${size}-codemode-error`);
  }
  await branch.waitForIdle(context);
  await desktopCodeContext.close();

  // Exercise every thinking/tool adjacency within and across assistant messages.
  f.faux.setResponses([
    ...Array.from({ length: 5 }, (_, index) =>
      fauxAssistantMessage(
        [
          ...(index === 2 || index === 3
            ? [{ type: "thinking" as const, thinking: "Inspecting the next file." }]
            : []),
          ...(index === 2
            ? [{ type: "thinking" as const, thinking: "Checking the file format." }]
            : []),
          fauxToolCall(
            "read",
            { path: f.filePath ?? "browser.json" },
            { id: `speaker-group-${index}` },
          ),
          ...(index === 2 || index === 3
            ? [{ type: "thinking" as const, thinking: "Reviewing the tool output." }]
            : []),
        ],
        { stopReason: "toolUse" },
      ),
    ),
    fauxAssistantMessage("All five reads completed."),
  ]);
  await reconnected.fill("#prompt", "Run five consecutive tool calls.");
  await reconnected.click("#send");
  await reconnected.waitForSelector(
    '.tool-call[data-call-id="speaker-group-4"][data-state="completed"]',
  );
  await branch.waitForIdle(context);
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
        await shot(reconnected, `speaker-groups-${width}-${phase}-${open ? "open" : "closed"}`);
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
  assert.equal(errors.length, 0);
  if (f.restart) {
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
    await reconnected.fill("#prompt", "Interrupt this run with a server restart.");
    await reconnected.click("#send");
    await started.promise;
    const restoredSessions = await f.restart();
    const restored = await restoredSessions.get(id);
    assert.equal(restored.needsResume, true);
    assert.equal((await restored.info()).name, "Counter cleanup");
    const restoredBase = await serve(t, restoredSessions, assets);
    f.faux.setResponses([fauxAssistantMessage("Explicitly resumed after restart.")]);
    await reconnected.goto(`${restoredBase}/?session=${id}&conversation=${branchId}`);
    await reconnected.waitForSelector("#recovery", { state: "visible" });
    await shot(reconnected, "mobile-recovery");
    assert.equal(await reconnected.locator("#send").isDisabled(), true);
    assert.equal((await restored.harness.inspect(context)).scheduling, "paused");
    await reconnected.click("#resume");
    await reconnected.waitForSelector("#recovery", { state: "hidden" });
    await (await restored.conversation(branchId)).waitForIdle(context);
    assert.equal(restored.needsResume, false);
    assert.equal((await restored.harness.inspect(context)).tasks.length, 0);
  }
}
