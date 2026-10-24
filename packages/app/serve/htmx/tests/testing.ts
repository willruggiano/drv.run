import assert from "node:assert/strict";
import type { Page } from "playwright";

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
