import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { chromium, type Page } from "playwright";

async function focused(page: Page, id: string) {
  assert.equal(await page.locator(`#${id}`).evaluate((node) => node === document.activeElement), true);
}

await test("browser key mappings: sessions mnemonics", async (t) => {
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const html = await readFile(new URL("./index.html", import.meta.url), "utf8");
  await page.setContent(html.replace(/<script[\s\S]*?<\/script>/g, ""));
  const source = stripTypeScriptTypes(await readFile(new URL("./key-mappings.ts", import.meta.url), "utf8"));
  await page.addScriptTag({ content: source.replace(/export /g, "") + `
    const picker = document.querySelector('#picker');
    installPickerKeyMappings(picker);
    for (const id of ['targets', 'models']) {
      const select = document.getElementById(id);
      select.innerHTML = '<option>First</option><option>Next</option>';
      select.showPicker = () => { select.dataset.opened = 'true'; };
    }
    const create = document.getElementById('create');
    create.disabled = false;
    create.onclick = () => { create.dataset.clicks = String(Number(create.dataset.clicks || 0) + 1); };
    picker.showModal();
  ` });
  for (const [key, id] of [["t", "targets"], ["m", "models"]]) {
    await page.focus("#close-picker");
    await page.keyboard.press(key);
    await focused(page, id);
    assert.equal(await page.locator(`#${id}`).getAttribute("data-opened"), "true");
  }
  await page.focus("#close-picker");
  await page.keyboard.press("n");
  assert.equal(await page.locator("#create").getAttribute("data-clicks"), "1");
  await page.locator("#create").evaluate((node) => { (node as HTMLButtonElement).disabled = true; });
  await page.keyboard.press("n");
  assert.equal(await page.locator("#create").getAttribute("data-clicks"), "1");
  await page.focus("#session-filter");
  await page.keyboard.type("tmn");
  assert.equal(await page.inputValue("#session-filter"), "tmn");
  for (const id of ["targets", "models"]) {
    await page.focus(`#${id}`);
    await page.keyboard.press("n");
    await focused(page, id);
  }
  await page.focus("#close-picker");
  for (const key of ["Control+t", "Alt+m", "Shift+N", "Meta+n"]) {
    await page.keyboard.press(key);
    await focused(page, "close-picker");
  }
  assert.equal(await page.evaluate(() => {
    const button = document.getElementById('close-picker')!;
    return [ { repeat: true }, { isComposing: true } ].every((extra) =>
      button.dispatchEvent(new KeyboardEvent('keydown', { key: 't', bubbles: true, cancelable: true, ...extra })));
  }), true);
});
