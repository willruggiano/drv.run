import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import type { Page } from "playwright";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fixture } from "./sessions-testing.ts";
import {
  openSessions,
  returnToConversation,
  openGlobalSettings,
  browserFixture,
  htmlMessageActions,
  openMessageActions,
} from "./browser-testing.ts";
import { serve } from "./testing.ts";
import { rename } from "../sessions.ts";
import { GlobalSettingsStore } from "../server.ts";
import { conversationURL } from "../hypermedia.ts";

const context = BACKGROUND_CONTEXT;

async function geometry(page: Page, selectors: string[]) {
  return page.evaluate(
    (selectors) =>
      selectors.map((selector) => {
        const node = document.querySelector(selector);
        if (!node) throw new Error(`Missing ${selector}`);
        const box = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return {
          box: [box.x, box.y, box.width, box.height],
          color: style.color,
          font: style.font,
          background: style.backgroundColor,
        };
      }),
    selectors,
  );
}
function equalLayout(
  original: Awaited<ReturnType<typeof geometry>>,
  html: Awaited<ReturnType<typeof geometry>>,
) {
  assert.equal(html.length, original.length);
  original.forEach((item, index) => {
    assert.deepEqual({ ...html[index], box: [] }, { ...item, box: [] }, `Styles at ${index}`);
    item.box.forEach((value, axis) =>
      assert(
        Math.abs(html[index].box[axis] - value) < 1,
        `Box ${index}, axis ${axis}: original ${value}, HTML ${html[index].box[axis]}`,
      ),
    );
  });
}

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
  for (const path of [`/?session=${session.id}`, conversationURL(session)]) {
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
        const scroll = document.querySelector("#conversation-scroll, #main-area > #transcript");
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
    const error = page.locator("#notice:not([hidden]), #request-error:not(:empty)");
    await error.waitFor();
    const errorBox = await error.boundingBox();
    const mainBox = await page.locator("#main-area").boundingBox();
    assert(errorBox && mainBox);
    assert(mainBox.y >= errorBox.y + errorBox.height);
    assert.equal(await page.locator(".bar").isVisible(), false);
  }
});

for (const [name, width, height, mobile] of [
  ["mobile", 390, 844, true],
  ["desktop", 1440, 1000, false],
] as const) {
  await test(`HTML visual contract matches original ${name} layout and controls`, async (t) => {
    const f = await fixture(t),
      session = await f.create();
    await rename(session, "Htmx poc");
    const timestamp = 1_700_000_000_000;
    await session.root.commit(async (tx) => {
      await tx.appendEntry(session.root.id, { kind: "pi.compaction", head: "self" });
      await tx.appendEntry(session.root.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "Make these interfaces visually equal.", timestamp }],
      });
      await tx.appendEntry(session.root.id, {
        kind: "pi.assistant",
        model: [
          fauxAssistantMessage(
            [
              { type: "thinking", thinking: "Use the original interface as the visual reference." },
              fauxToolCall("bash", { command: "just check" }, { id: "visual-check" }),
            ],
            { timestamp },
          ),
        ],
      });
      await tx.appendEntry(session.root.id, {
        kind: "pi.tool",
        model: [
          {
            role: "toolResult",
            toolCallId: "visual-check",
            toolName: "bash",
            content: [{ type: "text", text: "All checks passed." }],
            isError: false,
            durationMs: 23800,
            timestamp,
          },
        ],
      });
      await tx.appendEntry(session.root.id, {
        kind: "pi.assistant",
        model: [
          fauxAssistantMessage(
            "The layout now uses the same **styles**, `composer`, and message spacing.",
            { timestamp },
          ),
        ],
      });
      await tx.appendEntry(session.root.id, {
        kind: "pi.assistant",
        model: [
          fauxAssistantMessage(
            fauxToolCall("read", { path: "packages/app/serve/styles.css" }, { id: "visual-read" }),
            { timestamp },
          ),
        ],
      });
      await tx.appendEntry(session.root.id, {
        kind: "pi.tool",
        model: [
          {
            role: "toolResult",
            toolCallId: "visual-read",
            toolName: "read",
            content: [{ type: "text", text: "body { margin: 0; }" }],
            isError: false,
            durationMs: 94,
            timestamp,
          },
        ],
      });
    }, context);
    const b = await browserFixture(t, f.sessions);
    const settings = new GlobalSettingsStore(
      SettingsManager.inMemory({ defaultProvider: "faux", defaultModel: "faux-1" }),
    );
    const base = await serve(t, f.sessions, b.assets, "127.0.0.1", settings);
    const bc = await b.browser.newContext({
      viewport: { width, height },
      isMobile: mobile,
      hasTouch: mobile,
      locale: "en-US",
      timezoneId: "UTC",
    });
    t.after(() => bc.close());
    const original = await bc.newPage(),
      html = await bc.newPage();
    const errors: Error[] = [];
    for (const page of [original, html]) {
      page.setDefaultTimeout(10000);
      page.on("pageerror", (error) => errors.push(error));
    }
    await original.goto(`${base}/?session=${session.id}`);
    await original.waitForFunction(
      () => document.querySelector<HTMLElement>("#status")?.dataset.state === "ready",
    );
    await html.goto(base + conversationURL(session));
    await html.waitForFunction(
      () => document.querySelector("#connection")?.textContent === "Connected",
    );
    for (const page of [original, html])
      await page
        .locator("#prompt")
        .fill("Keep the workflows server-driven.\nCompare mobile and desktop.");
    await original.locator("#main-area > #transcript").evaluate((node) => {
      node.scrollTop = 0;
    });
    await html.locator(".scrollport").evaluate((node) => {
      node.scrollTop = 0;
    });
    const capture = async (view: string) => {
      if (b.screenshots)
        for (const [label, page] of [
          ["original", original],
          ["htmx", html],
        ] as const)
          await page.screenshot({
            path: join(b.screenshots, `visual-${label}-${name}-${view}.png`),
          });
    };
    await capture("conversation");
    const selectors = [
      ".bar",
      "#prompt",
      "#send",
      "#bottom-line",
      '#transcript article[data-role="user"] > .text',
      "#transcript .thinking",
      '[data-call-id="visual-check"] > summary',
      '[data-call-id="visual-read"] > summary',
      ".context-event > summary",
    ];
    equalLayout(await geometry(original, selectors), await geometry(html, selectors));
    for (const page of [original, html]) {
      assert.equal(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth <= innerWidth &&
            document.documentElement.scrollHeight <= innerHeight,
        ),
        true,
      );
    }

    for (const page of [original, html])
      await page.locator('[data-call-id="visual-check"] > summary').click();
    equalLayout(
      await geometry(original, [
        '[data-call-id="visual-check"]',
        '[data-call-id="visual-check"] pre',
      ]),
      await geometry(html, ['[data-call-id="visual-check"]', '[data-call-id="visual-check"] pre']),
    );
    await capture("tool");
    for (const page of [original, html])
      await page.locator('[data-call-id="visual-check"] > summary').click();
    await openMessageActions(
      original,
      original.locator('article[data-role="user"] > header > .message-actions'),
    );
    await htmlMessageActions(html, html.locator('article[data-role="user"]'));
    equalLayout(
      await geometry(original, ["#message-menu"]),
      await geometry(html, [".action-menu:popover-open"]),
    );
    await capture("actions");
    for (const page of [original, html]) await page.keyboard.press("Escape");
    // Close a possible native popover before navigating to server-owned views.
    await original.locator("#footer-model").click();
    await html.locator("#footer-model").click();
    await html.locator("#session-settings").waitFor();
    equalLayout(
      await geometry(original, [
        ".bar",
        "#preferences",
        "#session-name",
        "#instructions",
        "#prompt",
      ]),
      await geometry(html, [
        ".bar",
        "#preferences",
        '[name="name"]',
        '[name="instructions"]',
        "#prompt",
      ]),
    );
    await capture("settings");
    await returnToConversation(original);
    await returnToConversation(html);
    await original.locator("#footer-context").click();
    await html.locator("#footer-context").click();
    await html.locator("#context-view").waitFor();
    equalLayout(
      await geometry(original, [".bar", ".ctx-big", ".ctx-track", ".ctx-legend", ".ctx-inventory"]),
      await geometry(html, [".bar", ".ctx-big", ".ctx-track", ".ctx-legend", ".ctx-inventory"]),
    );
    await capture("context");
    await returnToConversation(original);
    await returnToConversation(html);
    await openGlobalSettings(original);
    await openGlobalSettings(html);
    await html.locator("#global-settings").waitFor();
    await capture("global");
    equalLayout(
      await geometry(original, [
        ".bar",
        "#global-preferences",
        "#default-model",
        '[name="transport"]',
        "#wrap-code",
        "#prompt",
      ]),
      await geometry(html, [
        ".bar",
        "#global-preferences",
        '[name="model"]',
        '[name="transport"]',
        "#wrap-code",
        "#prompt",
      ]),
    );
    await returnToConversation(original);
    await returnToConversation(html);
    await openSessions(original);
    await openSessions(html);
    await html.locator("#session-filter").waitFor();
    await capture("sessions");
    equalLayout(
      await geometry(original, [
        ".bar",
        "#sessions > .session",
        "#session-filter",
        "#create",
        "#new-options-toggle",
        "#bottom-line",
      ]),
      await geometry(html, [
        ".bar",
        "#session-list > .session",
        "#session-filter",
        "#create",
        "#new-options > summary",
        "#bottom-line",
      ]),
    );
    await original.locator("#new-options-toggle").click();
    await html.locator("#new-options > summary").click();
    await capture("new-options");
    equalLayout(
      await geometry(original, ["#new-options > div", "#targets", "#models"]),
      await geometry(html, ["#options", "#targets", "#models"]),
    );
    await original.goto(base + "/");
    await html.goto(base + "/sessions");
    await original.locator("#recent-sessions > .session").waitFor();
    await html.locator("#landing .session").waitFor();
    await capture("landing");
    equalLayout(
      await geometry(original, [
        ".bar",
        "#status",
        "#recent-title",
        "#recent-sessions > .session",
        "#prompt",
        "#create",
      ]),
      await geometry(html, [
        ".bar",
        "#status",
        "#recent-title",
        "#session-list > .session",
        "#prompt",
        "#create",
      ]),
    );
    assert.deepEqual(errors, []);
  });
}
