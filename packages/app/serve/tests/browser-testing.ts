import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Locator, type Page } from "playwright";
import type { ProxyAuthorization } from "../auth.ts";
import type { Sessions } from "../sessions.ts";
import { chromiumExecutable, serve } from "./testing.ts";
import { buildAssets } from "../build.ts";

export async function browserFixture(
  t: TestContext,
  sessions: Sessions,
  authorization?: ProxyAuthorization,
) {
  const assets = await mkdtemp(join(tmpdir(), "serve-assets-"));
  t.after(() => rm(assets, { recursive: true, force: true }));
  const source = dirname(dirname(fileURLToPath(import.meta.url)));
  const screenshots = process.env.PI_SCREENSHOT_DIR;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  await buildAssets(source, assets);
  const base = await serve(t, sessions, assets, "127.0.0.1", undefined, undefined, authorization);
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

export async function openSessions(page: Page): Promise<void> {
  const title = page.locator("#conversation-title");
  if (await title.isVisible()) await title.click();
  else await page.keyboard.press("Meta+k");
}

export async function returnToConversation(page: Page): Promise<void> {
  const close = page.locator("#close-view");
  if (await close.isVisible()) await close.click();
  else await page.keyboard.press("Escape");
}

// Global settings have no mobile entry point. Open them at a desktop width
// before testing their responsive form; do not activate a hidden control.
export async function openGlobalSettings(page: Page): Promise<void> {
  const viewport = page.viewportSize();
  assert(viewport);
  if (viewport.width <= 650) await page.setViewportSize({ ...viewport, width: 820 });
  await page.locator("#menu-toggle").click();
  await page.locator("#global-preferences").waitFor();
  if (viewport.width <= 650) await page.setViewportSize(viewport);
}

// HTML pages advertise additional native actions through the header popovers.
export async function htmlAction(
  page: Page,
  role: "link" | "button",
  name: string,
): Promise<Locator> {
  const action = page.getByRole(role, { name, exact: true });
  await page
    .getByRole(role, { name, exact: true, includeHidden: true })
    .first()
    .waitFor({ state: "attached" });
  if (!(await action.isVisible())) {
    const viewport = page.viewportSize();
    assert(viewport);
    // Header controls are desktop-only; open the menu there before testing its action.
    if (viewport.width <= 650) await page.setViewportSize({ ...viewport, width: 820 });
    if (
      !(await page.locator("#conversation-menu").evaluate((node) => node.matches(":popover-open")))
    )
      await page.getByRole("button", { name: "Conversation actions", exact: true }).click();
    if (!(await action.isVisible()))
      await page.getByRole("button", { name: "Review actions", exact: true }).click();
    if (viewport.width <= 650) await page.setViewportSize(viewport);
  }
  await action.waitFor();
  return action;
}

export async function htmlMessageActions(page: Page, owner: Locator): Promise<Locator> {
  await owner.scrollIntoViewIfNeeded();
  if (await page.evaluate(() => matchMedia("(hover: hover) and (pointer: fine)").matches)) {
    await owner.hover();
    await owner.locator(":scope > .entry-actions > summary").click();
  } else {
    // Use a real touch sequence, after any programmatic scroll has settled.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const rect = await owner.locator(":scope > summary, :scope > .text").first().boundingBox();
    assert(rect);
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: rect.x + 2, y: rect.y + 2, id: 1 }],
      });
      await page.locator(".action-menu:popover-open").waitFor();
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } finally {
      await cdp.detach();
    }
  }
  return page.locator(".action-menu:popover-open");
}
