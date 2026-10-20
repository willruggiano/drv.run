import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { chromium } from "playwright";
import { localIntegration } from "../pi-runtime/index.ts";
import { buildAssets } from "./build.ts";
import { chromiumExecutable, directoryFixture, serve } from "./testing.ts";

const context = BACKGROUND_CONTEXT;

await test("mobile browser exposes remote directory suggestions for new sessions and conversation settings", async (t) => {
  const f = await directoryFixture(t);
  await f.reopen([f.integration, localIntegration(f.workspace)]);
  await mkdir(join(f.workspace, "one"));
  await mkdir(join(f.workspace, "two"));
  await writeFile(join(f.workspace, "only-file.txt"), "file");
  const assets = join(f.directory, "assets");
  await buildAssets(fileURLToPath(new URL(".", import.meta.url)), assets);
  const base = await serve(t, f.sessions, assets);
  const browser = await chromium.launch({
    executablePath: chromiumExecutable(),
  });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  await page.goto(base);
  await page.waitForSelector("#picker:not([hidden])");
  await page.click("#new-options-toggle");
  const remote = JSON.stringify([f.binding.provider, f.binding.target, f.binding.cwd]);
  await page.selectOption("#targets", remote);
  await page.waitForSelector("#new-directory-field", { state: "visible" });
  await page.fill("#new-directory", "/o");
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLDataListElement>("#new-directories")?.options[0]?.value ===
      "/one/",
  );
  assert.deepEqual(
    await page
      .locator("#new-directories option")
      .evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value)),
    ["/one/"],
  );
  await page.fill("#new-directory", "/one/");
  await page.click("#create");
  await page.waitForSelector("#picker:not([hidden])", { state: "hidden" });
  const id = new URL(page.url()).searchParams.get("session");
  assert(id);
  const session = await f.sessions.get(id);
  assert.equal((await session.root.agent(context)).cwd, join(f.workspace, "one"));
  await page.fill("#prompt", "/settings");
  await page.keyboard.press("Control+Enter");
  await page.waitForSelector("#preferences:not([hidden])");
  assert.equal(await page.inputValue("#session-directory"), "one");
  await page.fill("#session-directory", "t");
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLDataListElement>("#session-directories")?.options[0]?.value ===
      "two/",
  );
  await page.fill("#session-directory", "/two");
  await page.click("#close-view");
  await page.waitForSelector("#preferences:not([hidden])", { state: "hidden" });
  assert.equal((await session.root.agent(context)).cwd, join(f.workspace, "two"));
  await page.reload();
  await page.waitForFunction(
    () => !document.querySelector<HTMLButtonElement>("#footer-model")?.disabled,
  );
  await page.fill("#prompt", "/settings");
  await page.keyboard.press("Control+Enter");
  await page.waitForSelector("#preferences:not([hidden])");
  assert.equal(await page.inputValue("#session-directory"), "two");
  await page.fill("#session-directory", "");
  await page.click("#close-view");
  await page.waitForSelector("#preferences:not([hidden])", { state: "hidden" });
  assert.equal((await session.root.agent(context)).cwd, f.workspace);
  await page.fill("#prompt", "/sessions");
  await page.keyboard.press("Control+Enter");
  await page.waitForSelector("#picker:not([hidden])");
  await page.click("#new-options-toggle");
  await page.selectOption("#targets", JSON.stringify(["local", f.workspace, f.workspace]));
  assert.equal(await page.locator("#new-directory-field").isVisible(), false);
  assert.deepEqual(errors, []);
  assert.equal(f.faux.state.callCount, 0);
});
