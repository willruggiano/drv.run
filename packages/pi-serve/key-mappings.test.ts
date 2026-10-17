import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { test, type TestContext } from "node:test";
import { chromium, type Page } from "playwright";

async function focused(page: Page, id: string) {
  assert.equal(
    await page.locator(`#${id}`).evaluate((node) => node === document.activeElement),
    true,
  );
}

async function setup(t: TestContext): Promise<Page> {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const html = await readFile(new URL("./index.html", import.meta.url), "utf8");
  await page.setContent(html.replace(/<script[\s\S]*?<\/script>/g, ""));
  const source = stripTypeScriptTypes(
    await readFile(new URL("./key-mappings.ts", import.meta.url), "utf8"),
  );
  await page.addScriptTag({
    content:
      source.replace(/export /g, "") +
      `
    const picker = document.querySelector('#picker');
    installPickerKeyMappings(picker);
    installSelectKeyMappings(document);
    for (const id of ['targets', 'models']) {
      const select = document.getElementById(id);
      select.innerHTML = '<option>First</option><option>Next</option>';
      select.showPicker = () => { select.dataset.opened = 'true'; };
    }
    const create = document.getElementById('create');
    create.disabled = false;
    create.onclick = () => { create.dataset.clicks = String(Number(create.dataset.clicks || 0) + 1); };
    picker.showModal();
  `,
  });
  return page;
}

await test("browser key mappings: sessions mnemonics", async (t) => {
  const page = await setup(t);
  for (const [key, id] of [
    ["t", "targets"],
    ["m", "models"],
  ]) {
    await page.focus("#close-picker");
    await page.keyboard.press(key);
    await focused(page, id);
    assert.equal(await page.locator(`#${id}`).getAttribute("data-opened"), "true");
  }
  await page.focus("#close-picker");
  await page.keyboard.press("n");
  assert.equal(await page.locator("#create").getAttribute("data-clicks"), "1");
  await page.locator("#create").evaluate((node) => {
    (node as HTMLButtonElement).disabled = true;
  });
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
  assert.equal(
    await page.evaluate(() => {
      const button = document.getElementById("close-picker")!;
      return [{ repeat: true }, { isComposing: true }].every((extra) =>
        button.dispatchEvent(
          new KeyboardEvent("keydown", { key: "t", bubbles: true, cancelable: true, ...extra }),
        ),
      );
    }),
    true,
  );
});

await test("browser key mappings: slash focuses session filter without inserting text", async (t) => {
  const page = await setup(t);
  await page.fill("#session-filter", "existing");
  await page.focus("#close-picker");
  await page.keyboard.press("/");
  await focused(page, "session-filter");
  assert.equal(await page.inputValue("#session-filter"), "existing");
  // Once editing, slash remains ordinary input.
  await page.keyboard.press("End");
  await page.keyboard.press("/");
  assert.equal(await page.inputValue("#session-filter"), "existing/");
  await page.focus("#targets");
  await page.keyboard.press("/");
  await focused(page, "targets");
  await page.focus("#close-picker");
  await page.keyboard.press("Control+/");
  await focused(page, "close-picker");
});

await test("browser key mappings: Ctrl+J/K navigate visible sessions and Enter activates", async (t) => {
  const page = await setup(t);
  await page.locator("#sessions").evaluate((node) => {
    node.innerHTML =
      '<button id="one">One</button><button disabled>Disabled</button><button hidden>Hidden</button><button id="two">Two</button>';
    node.addEventListener("click", (event) => {
      node.setAttribute("data-selected", (event.target as HTMLElement).id);
    });
  });
  await page.focus("#session-filter");
  await page.keyboard.press("Control+j");
  await focused(page, "one");
  await page.keyboard.press("Control+j");
  await focused(page, "two");
  await page.keyboard.press("Control+j");
  await focused(page, "one");
  await page.keyboard.press("Control+k");
  await focused(page, "two");
  assert.equal(await page.locator("#sessions").getAttribute("data-selected"), null);
  await page.keyboard.press("Enter");
  assert.equal(await page.locator("#sessions").getAttribute("data-selected"), "two");
  await page.focus("#session-filter");
  await page.keyboard.press("Control+k");
  await focused(page, "two");
  // Filtering rebuilds the list; navigation must not retain stale buttons.
  await page.locator("#sessions").evaluate((node) => {
    node.innerHTML = '<button id="only">Only match</button>';
  });
  await page.focus("#session-filter");
  await page.keyboard.press("Control+j");
  await focused(page, "only");
  await page.keyboard.press("Control+k");
  await focused(page, "only");
  await page.locator("#sessions").evaluate((node) => node.replaceChildren());
  await page.focus("#session-filter");
  await page.keyboard.press("Control+j");
  await page.keyboard.press("Control+k");
  await focused(page, "session-filter");
  assert.equal(await page.inputValue("#session-filter"), "");
});

await test("browser key mappings: Ctrl+J/K select options and emit changes", async (t) => {
  const page = await setup(t);
  await page.locator("#models").evaluate((node) => {
    node.innerHTML =
      "<option>First</option><option disabled>Disabled</option><optgroup disabled><option>Disabled group</option></optgroup><option>Last</option>";
    node.addEventListener("change", () => {
      node.dataset.changes = String(Number(node.dataset.changes || 0) + 1);
    });
  });
  await page.focus("#models");
  await page.keyboard.press("Control+j");
  await focused(page, "models");
  assert.equal(await page.inputValue("#models"), "Last");
  await page.keyboard.press("Control+j");
  assert.equal(await page.inputValue("#models"), "First");
  await page.keyboard.press("Control+k");
  assert.equal(await page.inputValue("#models"), "Last");
  assert.equal(await page.locator("#models").getAttribute("data-changes"), "3");
});
