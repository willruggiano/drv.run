import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { Page } from "playwright";
import { fixture } from "../../tests/sessions-testing.ts";
import { browserFixture } from "../../tests/browser-testing.ts";
import { conversationURL } from "../../presentation.ts";

async function focused(page: Page, id: string) {
  assert.equal(
    await page.locator(`#${id}`).evaluate((node) => node === document.activeElement),
    true,
  );
}

async function setup(t: TestContext): Promise<Page> {
  const f = await fixture(t);
  const { page, base, errors } = await browserFixture(t, f.sessions);
  t.after(() => assert.deepEqual(errors, []));
  await page.setViewportSize({ width: 820, height: 844 });
  await page.goto(base + "/htmx/");
  await page.evaluate(() => {
    document.addEventListener("htmx:config:request", (event) => {
      if (["targets", "models"].includes(event.detail.ctx.sourceElement.id)) event.preventDefault();
    });
    for (const id of ["targets", "models"]) {
      const select = document.querySelector<HTMLSelectElement>(`#${id}`)!;
      select.innerHTML = "<option>First</option><option>Next</option>";
      select.showPicker = () => {
        select.dataset.opened = "true";
      };
    }
    const create = document.querySelector<HTMLButtonElement>("#create")!;
    create.type = "button";
    create.onclick = () => {
      create.dataset.clicks = String(Number(create.dataset.clicks || 0) + 1);
    };
  });
  return page;
}

await test("browser key mappings: sessions mnemonics", async (t) => {
  const page = await setup(t);
  for (const [key, id] of [
    ["t", "targets"],
    ["m", "models"],
  ]) {
    await page.focus("#input-toggle");
    await page.keyboard.press(key);
    await focused(page, id);
    assert.equal(await page.locator(`#${id}`).getAttribute("data-opened"), "true");
  }
  await page.focus("#input-toggle");
  await page.keyboard.press("n");
  assert.equal(await page.locator("#create").getAttribute("data-clicks"), "1");
  await page.locator("#create").evaluate((node) => {
    (node as HTMLButtonElement).disabled = true;
  });
  await page.keyboard.press("n");
  assert.equal(await page.locator("#create").getAttribute("data-clicks"), "1");
  await page.focus("#prompt");
  await page.keyboard.type("tmn");
  assert.equal(await page.inputValue("#prompt"), "tmn");
  for (const id of ["targets", "models"]) {
    await page.focus(`#${id}`);
    await page.keyboard.press("n");
    await focused(page, id);
  }
  await page.focus("#input-toggle");
  for (const key of ["Control+t", "Alt+m", "Shift+N", "Meta+n"]) {
    await page.keyboard.press(key);
    await focused(page, "input-toggle");
  }
  assert.equal(
    await page.evaluate(() => {
      const button = document.getElementById("input-toggle")!;
      return [{ repeat: true }, { isComposing: true }].every((extra) =>
        button.dispatchEvent(
          new KeyboardEvent("keydown", { key: "t", bubbles: true, cancelable: true, ...extra }),
        ),
      );
    }),
    true,
  );
});

await test("browser key mappings: Ctrl+J/K navigate visible sessions and Enter activates", async (t) => {
  const page = await setup(t);
  await page.locator("#session-list").evaluate((node) => {
    node.innerHTML =
      '<a id="one" href="#one">One</a><a aria-disabled="true" href="#disabled">Disabled</a><a hidden href="#hidden">Hidden</a><a id="two" href="#two">Two</a>';
    node.addEventListener("click", (event) => {
      event.preventDefault();
      node.setAttribute("data-selected", (event.target as HTMLElement).id);
    });
  });
  await page.focus("#prompt");
  await page.keyboard.press("Control+j");
  await focused(page, "one");
  await page.keyboard.press("Control+j");
  await focused(page, "two");
  await page.keyboard.press("Control+j");
  await focused(page, "one");
  await page.keyboard.press("Control+k");
  await focused(page, "two");
  assert.equal(await page.locator("#session-list").getAttribute("data-selected"), null);
  await page.keyboard.press("Enter");
  assert.equal(await page.locator("#session-list").getAttribute("data-selected"), "two");
  await page.focus("#prompt");
  await page.keyboard.press("Control+k");
  await focused(page, "two");
  // Archiving rebuilds the list; navigation must not retain stale buttons.
  await page.locator("#session-list").evaluate((node) => {
    node.innerHTML = '<a id="only" href="#only">Only match</a>';
  });
  await page.focus("#prompt");
  await page.keyboard.press("Control+j");
  await focused(page, "only");
  await page.keyboard.press("Control+k");
  await focused(page, "only");
  await page.locator("#session-list").evaluate((node) => node.replaceChildren());
  await page.focus("#prompt");
  await page.keyboard.press("Control+j");
  await page.keyboard.press("Control+k");
  await focused(page, "prompt");
  assert.equal(await page.inputValue("#prompt"), "");
});

await test("browser key mappings: Ctrl+J/K navigate landing recent sessions", async (t) => {
  const f = await fixture(t);
  await f.create();
  await f.create();
  const { page, base, errors } = await browserFixture(t, f.sessions);
  page.setDefaultTimeout(10000);
  await page.goto(base + "/htmx/");
  const recent = page.locator("#landing #session-list a");
  assert.equal(await recent.count(), 2);
  const selected = async (index: number) =>
    assert.equal(await recent.nth(index).evaluate((node) => node === document.activeElement), true);
  await page.focus("#prompt");
  await page.keyboard.press("Control+j");
  await selected(0);
  await page.keyboard.press("Control+j");
  await selected(1);
  await page.keyboard.press("Control+j");
  await selected(0);
  await page.keyboard.press("Control+k");
  await selected(1);
  await page.focus("#prompt");
  await page.keyboard.press("Control+k");
  await selected(1);
  assert.equal(page.url(), base + "/htmx/");
  const href = await recent.nth(1).getAttribute("href");
  assert(href);
  const session = await f.sessions.get(href.split("/").at(-1)!);
  await page.keyboard.press("Enter");
  await page.waitForURL(base + conversationURL(session));
  await page.keyboard.press("Tab");
  await focused(page, "prompt");
  await page.goto(base + "/htmx/");
  await page.focus("#prompt");
  await page.keyboard.press("Meta+k");
  await page.locator("#landing").waitFor();
  assert.deepEqual(errors, []);
});

await test("browser key mappings: composer is first in native tab order without autofocus", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const b = await browserFixture(t, f.sessions);
  const path = conversationURL(session);
  for (const javaScriptEnabled of [true, false]) {
    const browserContext = await b.browser.newContext({ javaScriptEnabled });
    t.after(() => browserContext.close());
    const page = await browserContext.newPage();
    page.on("pageerror", (error) => b.errors.push(error));
    for (const width of [390, 820]) {
      await page.setViewportSize({ width, height: 844 });
      for (const [route, id] of [
        ["/htmx/", "prompt"],
        [path, "prompt"],
        [path + "/reset", "prompt"],
        [path + "/settings", "prompt"],
      ]) {
        await page.goto(b.base + route);
        assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
        await page.keyboard.press("Tab");
        await focused(page, id);
        await page.keyboard.press("Tab");
        assert.equal(
          await page.locator(`#${id}`).evaluate((node) => node === document.activeElement),
          false,
        );
        await page.keyboard.press("Shift+Tab");
        await focused(page, id);
      }
    }
  }
  assert.deepEqual(b.errors, []);
});

await test("browser key mappings: Escape blurs the composer without navigation or replacement", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const { page, base, errors } = await browserFixture(t, f.sessions);
  page.setDefaultTimeout(10000);
  const path = conversationURL(session);
  for (const [route, id] of [
    ["/htmx/", "prompt"],
    [path, "prompt"],
    [path + "/reset", "prompt"],
    [path + "/settings", "prompt"],
  ]) {
    await page.goto(base + route);
    await page.locator(`#${id}`).fill("Keep this draft.");
    const root = await page.locator("#page").elementHandle();
    assert(root);
    await page.evaluate(() => {
      document.addEventListener("htmx:config:request", (event) => {
        if (event.detail.ctx.target?.id === "page")
          document.querySelector<HTMLElement>("#page")!.dataset.navigationRequested = "true";
      });
    });
    await page.keyboard.press("Escape");
    assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
    assert.equal(await root.evaluate((node) => node.isConnected), true);
    assert.equal(await root.getAttribute("data-navigation-requested"), null);
    assert.equal(page.url(), base + route);
    assert.equal(await page.inputValue(`#${id}`), "Keep this draft.");
    await root.dispose();
  }
  // Dismiss completions before leaving the input.
  await page.goto(base + path);
  await page.locator("#prompt").fill("/re");
  await page.locator("#completions [data-completion]").first().waitFor();
  await page.keyboard.press("Escape");
  await focused(page, "prompt");
  assert.equal(await page.locator("#completions").isVisible(), false);
  await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
  assert.equal(page.url(), base + path);
  assert.deepEqual(errors, []);
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
