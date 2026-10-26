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

export async function openGlobalSettings(page: Page): Promise<void> {
  await page.goto(new URL("/htmx/settings", page.url()).href);
  await page.locator("#global-preferences").waitFor();
}

export async function submitCommand(page: Page, command: string): Promise<void> {
  await page.locator('#composer [name="content"]').fill(command);
  await page.locator('#composer [name="content"]').press("Control+Enter");
}

export async function visitOriginal(page: Page): Promise<void> {
  await submitCommand(page, "/fork");
  await page.locator("#tree-rows a").first().click();
}
