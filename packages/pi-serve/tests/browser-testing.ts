import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { chromium, type Locator, type Page } from "playwright";
import type { Sessions, ExecutionBinding } from "../../pi-runtime/index.ts";
import { exists, waitFor } from "../../pi-runtime/testing.ts";
import { chromiumExecutable, serve } from "./testing.ts";
import { buildAssets } from "../build.ts";

const context = BACKGROUND_CONTEXT;

export async function assertMessageTimestamps(page: Page): Promise<void> {
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

export async function assertTouchMenuPosition(
  page: Page,
  point: { x: number; y: number },
): Promise<void> {
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
  for (const height of layout.targets) assert.equal(height, 40);
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

export async function openMessageActions(page: Page, actions: Locator): Promise<void> {
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
  const point = await actions.evaluate(async (node) => {
    const target =
      node.closest(".tool-call")?.querySelector(":scope > summary") ??
      node.closest("article")?.querySelector(":scope > .text") ??
      node.closest("article");
    if (!target) throw new Error("Missing long-press target");
    target.scrollIntoView({ block: "center" });
    // Deliver the programmatic scroll before starting a hold. A scroll during
    // the gesture intentionally cancels it, just as it does for a real finger.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
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

export async function assertLayout(page: Page, name: string): Promise<void> {
  const screenshots = process.env.PI_SCREENSHOT_DIR;
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight),
    true,
    `${name}: clipped action buttons must not escape the transcript scrollport`,
  );
  const compactComposer = await page.evaluate(
    () => matchMedia("(min-width: 651px) and (hover: hover) and (pointer: fine)").matches,
  );
  const composerAlignment = await page
    .locator(".compose-box:visible > .actions")
    .evaluateAll((rows) =>
      rows.flatMap((row) => {
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
      }),
    );
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
      const rows = new Map<number, Element[]>();
      for (const button of footer.querySelectorAll("button")) {
        if (!button.checkVisibility()) continue;
        const top = Math.round(button.getBoundingClientRect().top);
        rows.set(top, [...(rows.get(top) ?? []), button]);
      }
      return [...rows.values()]
        .filter((row) => row.length > 1)
        .map((row) => textCenter(row[0]) - textCenter(row[1]));
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
            offset: dot.top + dot.height / 2 - (model.top + model.height / 2),
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
      36,
      `${name}: mobile footer must remain one line with bottom padding`,
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
}
export async function browserFixture(t: TestContext, sessions: Sessions) {
  const assets = await mkdtemp(join(tmpdir(), "pi-serve-assets-"));
  t.after(() => rm(assets, { recursive: true, force: true }));
  const source = dirname(dirname(fileURLToPath(import.meta.url)));
  const screenshots = process.env.PI_SCREENSHOT_DIR;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  await buildAssets(source, assets);
  const base = await serve(t, sessions, assets);
  const browser = await chromium.launch({ executablePath: chromiumExecutable() });
  t.after(() => browser.close());
  const browserContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await browserContext.newPage();
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));

  return { assets, source, screenshots, base, browser, browserContext, page, errors };
}

export async function browserFlow(
  t: TestContext,
  f: {
    sessions: Sessions;
    workspace: string;
    binding: ExecutionBinding;
    faux: ReturnType<typeof fauxProvider>;
    filePath?: string;
  },
) {
  const b = await browserFixture(t, f.sessions);
  const { base, browserContext, page, errors } = b;
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
  await page.click("#new-options-toggle");
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
    () => !document.querySelector<HTMLButtonElement>("#footer-model")?.disabled,
  );
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
  return { ...b, session, reconnected, id, url };
}
