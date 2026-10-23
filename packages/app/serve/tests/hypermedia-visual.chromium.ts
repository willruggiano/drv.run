import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { InboxDoc } from "@earendil-works/pi-durable";
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
    assert.equal(await page.locator(".bar").count(), 0);
    assert.equal(await page.locator("#close-view").isVisible(), true);
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

await test("panel headers respect safe areas, stay above scrolling content and close to their origin", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const path = conversationURL(session);
  const b = await browserFixture(t, f.sessions);
  const page = b.page;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", {
    insets: { top: 47, bottom: 34, left: 12, right: 12 },
  });
  const panels = [
    {
      url: `/sessions/settings?return=${encodeURIComponent(path)}`,
      title: "Default preferences",
      pane: "#global-preferences",
      composer: true,
    },
    { url: `${path}/context`, title: "Context", pane: "#context-view", composer: false },
  ];
  for (const width of [320, 390, 650, 651, 1199, 1200, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const panel of panels) {
      await page.goto(b.base + panel.url);
      const bar = page.locator("#app-header > .bar");
      const close = page.locator("#close-view");
      assert.equal(await bar.isVisible(), true);
      assert.equal(await bar.locator("h1").textContent(), panel.title);
      assert.equal(await close.isVisible(), true);
      assert.equal(await page.locator("#app-footer").isVisible(), panel.composer);
      const header = await bar.boundingBox();
      const label = await bar.locator("h1").boundingBox();
      const button = await close.boundingBox();
      const pane = page.locator(panel.pane);
      const content = await pane.boundingBox();
      assert(header && label && button && content);
      assert.equal(header.y, 47);
      assert(label.x < button.x);
      assert(button.width >= 44 && button.height >= 44);
      assert(button.x + button.width <= width - 12);
      assert(content.y >= header.y + header.height);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      // Force overflow even when a fixture has only a few settings/messages.
      await page.addStyleTag({
        content: `${panel.pane}::after { content: ""; display: block; height: 2000px; }`,
      });
      await pane.evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });
      assert(await pane.evaluate((node) => node.scrollTop > 0));
      assert.deepEqual(await bar.boundingBox(), header);
      assert.deepEqual(await close.boundingBox(), button);
      await close.click();
      await page.waitForURL(b.base + path);
      await page.locator("#conversation-scroll").waitFor();
    }
    await page.goto(b.base + "/sessions");
    await page.locator("#landing").waitFor();
    assert.equal(await page.locator("#app-header > .bar").isVisible(), false);
    assert.equal((await page.locator("#main-area").boundingBox())?.y, 47);
  }
  await page.goto(b.base + "/sessions/settings");
  assert.equal(await page.locator("#app-footer").isVisible(), false);
  await page.locator("#close-view").click();
  await page.waitForURL(b.base + "/sessions");
  await page.locator("#landing").waitFor();
  assert.deepEqual(b.errors, []);
});

await test("session settings center above the composer without a header or save indicator", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const b = await browserFixture(t, f.sessions);
  const page = b.page;
  const path = conversationURL(session);
  for (const width of [320, 390, 820, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(b.base + path + "/settings");
    assert.equal(await page.locator("#app-header").count(), 0);
    assert.equal(await page.locator("#session-settings .save-status").count(), 0);
    assert.equal(await page.locator('#session-settings [name="instructions"]').count(), 0);
    assert.equal(await page.locator("#session-settings > button").isVisible(), false);
    for (const name of ["name", "target", "model", "thinkingLevel"]) {
      const control = page.locator(`#session-settings [name="${name}"]`);
      assert.equal(await control.isVisible(), true);
      const row = await control.evaluate((input) => {
        const label = input.closest("label")!.querySelector("span")!;
        return {
          value: input.getBoundingClientRect().toJSON(),
          label: label.getBoundingClientRect().toJSON(),
          valueSize: parseFloat(getComputedStyle(input).fontSize),
          labelSize: parseFloat(getComputedStyle(label).fontSize),
          alignment: getComputedStyle(input).textAlign,
        };
      });
      assert(row.value.bottom <= row.label.top);
      assert.equal(row.value.left, row.label.left);
      assert(row.valueSize > row.labelSize);
      assert.equal(row.alignment, "left");
    }
    const close = await page.locator("#close-view").boundingBox();
    const form = await page.locator("#session-settings").boundingBox();
    assert(close && form);
    assert(close.y + close.height < form.y);
    assert.equal(close.x + close.width, form.x + form.width);
    const pane = await page.locator("#preferences").boundingBox();
    const settings = await page.locator("#preferences > div").boundingBox();
    const footer = await page.locator("#app-footer").boundingBox();
    assert(pane && settings && footer);
    assert(settings.y > pane.y);
    assert(settings.y + settings.height < footer.y);
    assert(Math.abs(settings.y + settings.height / 2 - (pane.y + pane.height / 2)) < 12);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await returnToConversation(page);
    await page.waitForURL(b.base + path);
  }
  assert.deepEqual(b.errors, []);
});

await test("recent sessions and session settings share a compact, horizontally aligned column", async (t) => {
  const f = await fixture(t);
  const sessions = [];
  for (let i = 0; i < 5; i++) sessions.push(await f.create());
  const b = await browserFixture(t, f.sessions);
  for (const page of [b.page, await b.browser.newPage()]) {
    for (const width of [320, 390, 650, 651, 1199, 1200, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(b.base + "/sessions");
      assert.equal(await page.locator("#session-list a").count(), 5);
      const landing = await page.locator("#landing > div").boundingBox();
      const title = await page
        .locator("#session-list .session-heading strong")
        .first()
        .boundingBox();
      const heading = await page.locator("#recent-title").boundingBox();
      assert(landing && title && heading);
      const available = await page.locator("#landing").evaluate((pane) => {
        const style = getComputedStyle(pane);
        return {
          left: pane.getBoundingClientRect().left + parseFloat(style.paddingLeft),
          width: pane.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        };
      });
      assert.equal(landing.width, Math.min(560, available.width));
      assert(Math.abs(landing.x - (available.left + (available.width - landing.width) / 2)) < 1);
      assert(Math.abs(heading.x - title.x) <= 1);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      await page.goto(b.base + conversationURL(sessions[0]) + "/settings");
      const settings = await page.locator("#preferences > div").boundingBox();
      const valueLeft = await page.locator('#session-settings [name="name"]').evaluate((input) => {
        const style = getComputedStyle(input);
        return (
          input.getBoundingClientRect().left +
          parseFloat(style.borderLeftWidth) +
          parseFloat(style.paddingLeft)
        );
      });
      assert(settings);
      assert.equal(landing.x, settings.x);
      assert.equal(landing.width, settings.width);
      assert.equal(title.x, valueLeft);
    }
  }
  assert.deepEqual(b.errors, []);
});

await test("queued messages share transcript rendering and footer metadata stays aligned", async (t) => {
  const gate = Promise.withResolvers<void>();
  t.after(() => gate.resolve());
  const f = await fixture(t);
  const session = await f.create();
  const b = await browserFixture(t, f.sessions);
  const page = b.page;
  const entered = Promise.withResolvers<void>();
  f.faux.setResponses([
    async () => {
      entered.resolve();
      await gate.promise;
      return fauxAssistantMessage("Done.");
    },
  ]);
  await session.root.submit({ type: "input", content: "Wait." }, context);
  await entered.promise;
  await page.goto(b.base + conversationURL(session));
  assert.equal(await page.locator("#queue").isVisible(), false);
  const image = {
    type: "image" as const,
    mimeType: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6Z9kAAAAASUVORK5CYII=",
  };
  for (const whenBusy of ["followUp", "steer"] as const)
    await session.root.submit(
      {
        type: "input",
        whenBusy,
        content: [{ type: "text", text: "**Queued** `code`\n" + "long".repeat(100) }, image],
      },
      context,
    );
  await page.locator('#queue article[data-mode="steer"] img').waitFor();
  assert.equal(await page.locator("#queue article .text strong").count(), 2);
  assert.equal(await page.locator("#queue article .text code").count(), 2);
  for (const width of [320, 390, 650, 651, 1199, 1200, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const geometry = await page.evaluate(() => {
      const node = (selector: string) => document.querySelector(selector)!;
      const box = (selector: string) => node(selector).getBoundingClientRect().toJSON();
      const textBox = (selector: string) => {
        const range = document.createRange();
        range.selectNodeContents(node(selector));
        return range.getBoundingClientRect().toJSON();
      };
      return {
        model: textBox("#footer-model .model-name"),
        context: textBox("#footer-context"),
        queue: box("#queue"),
        content: box(".queued-messages"),
        composer: box(".compose-box:has(#prompt)"),
        cancel: box("#queue button"),
        background: getComputedStyle(node("#queue")).backgroundColor,
        border: parseFloat(getComputedStyle(node(".queued-messages")).borderTopWidth),
        overflow: document.documentElement.scrollWidth > innerWidth,
        scrolls: node("#queue").scrollHeight > node("#queue").clientHeight,
      };
    });
    assert(Math.abs(geometry.model.y - geometry.context.y) < 1);
    assert(
      Math.abs(geometry.content.x - geometry.composer.x) < 1,
      JSON.stringify({ width, geometry }),
    );
    assert(Math.abs(geometry.content.right - geometry.composer.right) < 1);
    assert(geometry.cancel.width <= 32 && geometry.cancel.height <= 32);
    assert(geometry.queue.height <= 225);
    assert.equal(geometry.border, 1);
    assert.equal(geometry.background, "rgba(0, 0, 0, 0)");
    assert.equal(geometry.overflow, false);
    assert.equal(geometry.scrolls, true);
  }
  for (const remaining of [1, 0]) {
    await page.getByRole("button", { name: "Cancel queued message", exact: true }).first().click();
    await page.waitForFunction(
      (count) => document.querySelectorAll("#queue article").length === count,
      remaining,
    );
    assert.equal(
      (await session.harness.snapshot(InboxDoc, session.root.id, context))?.items.length,
      remaining,
    );
  }
  assert.equal(await page.locator("#queue").isVisible(), false);
  gate.resolve();
  await session.root.waitForIdle(context);
  assert.deepEqual(b.errors, []);
});

await test("busy composer labels and icons share a centerline on touch and desktop", async (t) => {
  const gate = Promise.withResolvers<void>();
  t.after(() => gate.resolve());
  const f = await fixture(t);
  const session = await f.create();
  const b = await browserFixture(t, f.sessions);
  const entered = Promise.withResolvers<void>();
  f.faux.setResponses([
    async () => {
      entered.resolve();
      await gate.promise;
      return fauxAssistantMessage("Done.");
    },
  ]);
  await session.root.submit({ type: "input", content: "Wait." }, context);
  await entered.promise;
  for (const page of [b.page, await b.browser.newPage()]) {
    await page.goto(b.base + conversationURL(session));
    await page.locator('#controls[data-state="working"]').waitFor();
    for (const width of [320, 390, 820, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const geometry = await page.locator("#controls").evaluate((controls) => {
        return [".submission-mode", "#stop", "#send"].map((selector) => {
          const button = controls.querySelector(selector)!;
          const bounds = button.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(button);
          const label =
            button.querySelector("svg")?.getBoundingClientRect() ?? range.getBoundingClientRect();
          return {
            top: bounds.top,
            bottom: bounds.bottom,
            center: bounds.top + bounds.height / 2,
            labelCenter: label.top + label.height / 2,
          };
        });
      });
      for (const button of geometry) {
        assert.equal(button.top, geometry[0].top);
        assert.equal(button.bottom, geometry[0].bottom);
        assert(Math.abs(button.labelCenter - button.center) < 2);
      }
    }
    for (const [selector, mode] of [
      [".submission-mode", "steer"],
      ["#send", "followUp"],
    ]) {
      await page.locator("#prompt").fill(mode);
      await page.locator(selector).click();
      await page.locator(`#queue article[data-mode="${mode}"]`).waitFor();
      const items = (await session.harness.snapshot(InboxDoc, session.root.id, context))!.items;
      const last = items.at(-1)!;
      assert.equal(last.mode, mode);
      assert.equal("content" in last && last.content, mode);
      await page.locator(`#queue article[data-mode="${mode}"] button`).click();
      await page.locator("#queue").waitFor({ state: "hidden" });
    }
  }
  gate.resolve();
  await session.root.waitForIdle(context);
  assert.deepEqual(b.errors, []);
});

await test("attachment thumbnails remove only the selected file by pointer or keyboard", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const b = await browserFixture(t, f.sessions);
  const page = b.page;
  const names = ["first.png", "second.png", "third.png"];
  const buffer = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6Z9kAAAAASUVORK5CYII=",
    "base64",
  );
  for (const path of ["/sessions", conversationURL(session)]) {
    await page.goto(b.base + path);
    await page
      .locator("#images")
      .setInputFiles(names.map((name) => ({ name, mimeType: "image/png", buffer })));
    await page.locator("#previews img").nth(2).waitFor();
    assert.equal(await page.locator("#previews > button > img").count(), 3);
    assert.equal(
      await page
        .locator("#previews button")
        .evaluateAll((buttons) =>
          buttons.every(
            (button) =>
              button.childNodes.length === 1 && button.firstElementChild?.tagName === "IMG",
          ),
        ),
      true,
    );
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const sizes = await page.locator("#previews img").evaluateAll((images) =>
        images.map((image) => {
          const rect = image.getBoundingClientRect();
          return { width: rect.width, height: rect.height };
        }),
      );
      assert(
        sizes.every(
          (size) => size.width > 0 && size.width <= 64 && size.height > 0 && size.height <= 64,
        ),
      );
    }
    const files = () =>
      page
        .locator("#images")
        .evaluate((input: HTMLInputElement) => Array.from(input.files ?? [], (file) => file.name));
    await page
      .getByRole("button", { name: "Remove second.png", exact: true })
      .locator("img")
      .click();
    assert.deepEqual(await files(), [names[0], names[2]]);
    const first = page.getByRole("button", { name: "Remove first.png", exact: true });
    await first.focus();
    await page.keyboard.press("Enter");
    assert.deepEqual(await files(), [names[2]]);
    await page.getByRole("button", { name: "Remove third.png", exact: true }).focus();
    await page.keyboard.press("Space");
    assert.deepEqual(await files(), []);
    assert.equal(await page.locator("#previews").isVisible(), false);
    if (path !== "/sessions") assert.equal(await page.locator("#send").isDisabled(), true);
    assert.equal(new URL(page.url()).pathname, path);
  }
  assert.equal((await f.sessions.catalog(context)).sessions.length, 1);
  assert.deepEqual(b.errors, []);
});

await test("transcripts have no action controls, session indicator, or reserved action gutter", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: "printf done" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("```typescript\nconst answer = 42;\n```"),
  ]);
  await (
    await session.root.submit({ type: "input", content: "Run the command." }, context)
  ).wait(context);
  const b = await browserFixture(t, f.sessions);
  for (const javaScriptEnabled of [false, true]) {
    for (const touch of [false, true]) {
      const browserContext = await b.browser.newContext({
        javaScriptEnabled,
        viewport: { width: touch ? 390 : 1440, height: 900 },
        isMobile: touch,
        hasTouch: touch,
      });
      const page = await browserContext.newPage();
      page.setDefaultTimeout(10000);
      page.on("pageerror", (error) => b.errors.push(error));
      await page.goto(b.base + conversationURL(session));
      if (javaScriptEnabled)
        await page.waitForFunction(
          () => document.querySelector("#connection")?.textContent === "Connected",
        );
      const absent =
        '#status, .session-status, .status-menu, .entry-actions, .message-actions, .action-menu, #message-menu, #transcript button, #live button, [data-copy-source], a[href="/auth"]';
      assert.equal(await page.locator(absent).count(), 0);
      const message = page.locator('#transcript article[data-role="user"]');
      assert.equal(
        await message.evaluate((node) => getComputedStyle(node).userSelect === "none"),
        false,
      );
      // Native context menus must not be intercepted by a hidden message menu.
      assert.equal(
        await message.evaluate((node) =>
          node.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
        ),
        true,
      );
      if (javaScriptEnabled && touch) {
        await message.dispatchEvent("pointerdown", {
          pointerType: "touch",
          pointerId: 1,
          isPrimary: true,
        });
        await page.waitForTimeout(600);
        await message.dispatchEvent("pointerup", {
          pointerType: "touch",
          pointerId: 1,
          isPrimary: true,
        });
      }
      assert.equal(await page.locator(":popover-open").count(), 0);
      assert.equal(await page.locator(absent).count(), 0);
      // Tool disclosure remains native, but opening it adds no buttons.
      await page.locator(".tool-call > summary").click();
      assert.equal(await page.locator(".tool-result").isVisible(), true);
      assert.equal(await page.locator(absent).count(), 0);
      for (const path of [conversationURL(session), "/sessions?view=sessions"]) {
        await page.goto(b.base + path);
        const geometry = await page.evaluate(() => {
          const main = document.querySelector("#main-area")!;
          const pane = main.querySelector(".pane")!;
          return {
            main: main.getBoundingClientRect().width,
            pane: pane.getBoundingClientRect().width,
            right: parseFloat(getComputedStyle(pane).paddingRight),
            overflow: pane.scrollWidth > pane.clientWidth,
          };
        });
        if (!touch) {
          assert.equal(geometry.main, 820);
          assert.equal(geometry.pane, geometry.main);
          assert.equal(geometry.right, 0);
        }
        assert.equal(geometry.overflow, false);
      }
      await browserContext.close();
    }
  }
  assert.deepEqual(b.errors, []);
});
