import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fixture } from "./sessions-testing.ts";
import { browserFixture, returnToConversation, openGlobalSettings } from "./browser-testing.ts";
import { conversationURL } from "../hypermedia.ts";
import { rename } from "../sessions.ts";
const context = BACKGROUND_CONTEXT;

await test("conversations stay bottom-aligned as history grows and preserve scrollback", async (t) => {
  const f = await fixture(t);
  const b = await browserFixture(t, f.sessions);
  const page = await b.browser.newPage();
  const scrollSelector = "#conversation-scroll";
  const messages = page.locator("#transcript > article[data-role]");
  const layout = () =>
    page.locator(scrollSelector).evaluate((scroll) => {
      const box = scroll.getBoundingClientRect();
      const style = getComputedStyle(scroll);
      return {
        top: box.top + parseFloat(style.paddingTop),
        bottom: box.bottom - parseFloat(style.paddingBottom),
        scrollTop: scroll.scrollTop,
        overflow: scroll.scrollHeight > scroll.clientHeight,
        footer: document.querySelector("#app-footer")!.getBoundingClientRect().top,
        edge: box.bottom,
        messages: Array.from(
          document.querySelectorAll("#transcript > article[data-role]"),
          (node) => {
            const rect = node.getBoundingClientRect();
            return { top: rect.top, bottom: rect.bottom, role: node.getAttribute("data-role") };
          },
        ),
      };
    });
  const assertBottom = async () => {
    const state = await layout();
    assert.equal(state.edge, state.footer);
    assert(Math.abs(state.messages.at(-1)!.bottom - state.bottom) < 1);
    assert.equal(state.messages[0].role, "user");
    for (let index = 1; index < state.messages.length; index++)
      assert(state.messages[index].top >= state.messages[index - 1].bottom);
    return state;
  };
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    {
      const session = await f.create();
      let timestamp = 1_700_000_000_000;
      await session.root.commit(async (tx) => {
        await tx.appendEntry(session.root.id, {
          kind: "pi.user",
          model: [{ role: "user", content: "First message.", timestamp: timestamp++ }],
        });
      }, context);
      const append = async (text: string) =>
        session.root.commit(async (tx) => {
          await tx.appendEntry(session.root.id, {
            kind: "pi.assistant",
            model: [fauxAssistantMessage(text, { timestamp: timestamp++ })],
          });
        }, context);
      await append("Latest message.");
      await page.goto(b.base + conversationURL(session));
      await messages.nth(1).waitFor();
      const short = await assertBottom();
      assert.equal(short.overflow, false);
      assert.equal(short.scrollTop, 0);
      assert(short.messages[0].top > short.top);

      await append("More history.\n".repeat(80));
      await messages.nth(2).waitFor();
      const long = await assertBottom();
      assert.equal(long.overflow, true);
      assert(long.scrollTop > 0);

      await page.locator(scrollSelector).evaluate((scroll) => {
        scroll.scrollTop = 0;
      });
      const oldest = await layout();
      assert(Math.abs(oldest.messages[0].top - oldest.top) < 1);
      await append("New message while reading older history.");
      await messages.nth(3).waitFor();
      const reading = await layout();
      assert.equal(reading.scrollTop, 0);
      assert.equal(reading.messages[0].top, oldest.messages[0].top);
      await page.locator("#latest").click();
      await assertBottom();
      await page.reload();
      await messages.nth(3).waitFor();
      await assertBottom();
    }
  }
});

await test("message alignment is a persistent browser preference shared across sessions", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  await session.root.commit(async (tx) => {
    await tx.appendEntry(session.root.id, {
      kind: "pi.user",
      model: [{ role: "user", content: "A short conversation.", timestamp: 0 }],
    });
  }, context);
  const branch = await f.create();
  await branch.root.commit(async (tx) => {
    await tx.appendEntry(branch.root.id, {
      kind: "pi.user",
      model: [{ role: "user", content: "Another short conversation.", timestamp: 0 }],
    });
  }, context);
  const b = await browserFixture(t, f.sessions);
  const page = b.page;
  const paths = [conversationURL(session), conversationURL(branch)];
  const aligned = async (bottom: boolean) => {
    await page.locator("#transcript > article[data-role]").waitFor();
    const geometry = await page.locator("#conversation-scroll").evaluate((scroll) => {
      const bounds = scroll.getBoundingClientRect();
      const message = document
        .querySelector("#transcript > article[data-role]")!
        .getBoundingClientRect();
      const style = getComputedStyle(scroll);
      return {
        bottom: document.body.classList.contains("bottom-align"),
        topGap: message.top - bounds.top - parseFloat(style.paddingTop),
        bottomGap: bounds.bottom - parseFloat(style.paddingBottom) - message.bottom,
      };
    });
    assert.equal(geometry.bottom, bottom);
    assert(Math.abs(bottom ? geometry.bottomGap : geometry.topGap) < 1);
    assert((bottom ? geometry.topGap : geometry.bottomGap) > 100);
  };
  let bottom = true;
  for (const path of paths) {
    await page.goto(b.base + path);
    await aligned(bottom);
    await openGlobalSettings(page);
    assert.equal(await page.locator("#bottom-align").inputValue(), String(bottom));
    await page.locator("#wrap-code").selectOption("true");
    bottom = !bottom;
    await page.locator("#bottom-align").selectOption(String(bottom));
    assert.equal(
      await page.locator("body").evaluate((node) => node.classList.contains("wrap-code")),
      true,
    );
    await returnToConversation(page);
    await aligned(bottom);
    await page.reload();
    await aligned(bottom);
    await openGlobalSettings(page);
    assert.equal(await page.locator("#bottom-align").inputValue(), String(bottom));
    await returnToConversation(page);
  }
  await page.goto(b.base + paths[0]);
  await aligned(true);

  // Storage failure must not prevent an in-memory choice or change the default.
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new DOMException("Storage disabled", "SecurityError");
      },
    });
  });
  for (const path of paths) {
    await page.goto(b.base + path);
    await aligned(true);
    await openGlobalSettings(page);
    assert.equal(await page.locator("#bottom-align").inputValue(), "true");
    await page.locator("#bottom-align").selectOption("false");
    await returnToConversation(page);
    await aligned(false);
    await page.reload();
    await aligned(true);
  }
  assert.deepEqual(b.errors, []);
});

await test("main panes reach the top on mobile and wide screens without mobile header controls", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  await rename(session, "A long session title ".repeat(5));
  await session.root.commit(async (tx) => {
    await tx.appendEntry(session.root.id, {
      kind: "pi.user",
      model: [{ role: "user", content: "Scrollable conversation.\n".repeat(100), timestamp: 0 }],
    });
  }, context);
  const b = await browserFixture(t, f.sessions);
  const page = await b.browser.newPage();
  for (const path of [conversationURL(session)]) {
    await page.goto(b.base + path);
    await page.locator("#transcript article").first().waitFor();
    for (const width of [320, 390, 650, 651, 1199, 1200, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      const layout = await page.evaluate(() => {
        const box = (selector: string) => {
          const node = document.querySelector(selector);
          if (!node) throw new Error(`Missing ${selector}`);
          const rect = node.getBoundingClientRect();
          return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left };
        };
        const scroll = document.querySelector("#conversation-scroll");
        if (!scroll) throw new Error("Missing scrollport");
        scroll.scrollTop = scroll.scrollHeight;
        return {
          main: box("#main-area"),
          title: box(".bar h1"),
          menu: box("#menu-toggle"),
          footer: box("#app-footer"),
          composer: box(".compose-box:has(#prompt)"),
          message: box("#transcript article"),
          boundary: getComputedStyle(document.querySelector(".bar")!).borderBottomWidth,
          scrollTop: scroll.scrollTop,
          overflow:
            document.documentElement.scrollWidth > innerWidth ||
            document.documentElement.scrollHeight > innerHeight,
        };
      });
      assert.equal(layout.overflow, false);
      assert(layout.scrollTop > 0);
      assert.equal(layout.footer.left, 0);
      assert.equal(layout.footer.right, width);
      assert.equal(layout.footer.bottom, 900);
      assert.equal(layout.main.bottom, layout.footer.top);
      if (width >= 1200) {
        assert(Math.abs(layout.message.left - layout.composer.left) < 1);
        assert(Math.abs(layout.message.right - layout.composer.right) < 1);
        assert.equal(layout.main.top, 0);
        assert(layout.title.right <= layout.main.left);
        assert(layout.menu.left >= layout.main.right);
        assert.equal(layout.boundary, "0px");
      } else if (width <= 650) {
        assert.equal(layout.main.top, 0);
        assert.equal(await page.locator(".bar").isVisible(), false);
        assert.equal(await page.locator("#menu-toggle").isVisible(), false);
        assert.equal(await page.locator(".header-title").first().isVisible(), false);
        assert.equal(await page.locator("#close-view").isVisible(), false);
      } else {
        assert(layout.main.top >= layout.title.bottom);
        assert(layout.main.top >= layout.menu.bottom);
      }
    }
    await page.setViewportSize({ width: 390, height: 900 });
    await page.locator("#footer-model").click();
    await page.locator("#preferences").waitFor();
    assert.equal(await page.locator(".bar").isVisible(), false);
    assert.equal(await page.locator("#close-view").isVisible(), false);
    await returnToConversation(page);
    await page.locator("#preferences").waitFor({ state: "hidden" });
    await page.locator("#prompt").fill("/unknown-command");
    await page.locator("#send").click();
    const error = page.locator("#request-error:not(:empty)");
    await error.waitFor();
    const errorBox = await error.boundingBox();
    const mainBox = await page.locator("#main-area").boundingBox();
    assert(errorBox && mainBox);
    assert(mainBox.y >= errorBox.y + errorBox.height);
    assert.equal(await page.locator(".bar").isVisible(), false);
  }
});
