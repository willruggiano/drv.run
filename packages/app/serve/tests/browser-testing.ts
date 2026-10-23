import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
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
  // Match the production package context; Elm must remain a working classic script.
  await writeFile(join(assets, "package.json"), JSON.stringify({ type: "module" }));
  await buildAssets(source, assets);
  const base = await serve(t, sessions, assets, "127.0.0.1", undefined, undefined, authorization);
  const browser = await chromium.launch({
    executablePath: chromiumExecutable(),
    // Exercise the site's scrollbar styles, not Playwright's blanket suppression.
    ignoreDefaultArgs: ["--hide-scrollbars"],
  });
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

export async function submitCommand(page: Page, command: string): Promise<void> {
  await page.locator('#composer [name="content"]').fill(command);
  await page.locator('#composer [name="content"]').press("Control+Enter");
}

export async function visitOriginal(page: Page): Promise<void> {
  await submitCommand(page, "/fork");
  await page.locator("#branches .session").filter({ hasText: "Main" }).click();
}
