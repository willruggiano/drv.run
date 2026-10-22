import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import type { Page } from "playwright";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fixture } from "./sessions-testing.ts";
import { browserFixture, htmlMessageActions, openMessageActions } from "./browser-testing.ts";
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
    await original.locator("#close-view").click();
    await html.locator("#close-view").click();
    await original.locator("#footer-context").click();
    await html.locator("#footer-context").click();
    await html.locator("#context-view").waitFor();
    equalLayout(
      await geometry(original, [".bar", ".ctx-big", ".ctx-track", ".ctx-legend", ".ctx-inventory"]),
      await geometry(html, [".bar", ".ctx-big", ".ctx-track", ".ctx-legend", ".ctx-inventory"]),
    );
    await capture("context");
    await original.locator("#close-view").click();
    await html.locator("#close-view").click();
    await original.locator("#menu-toggle").click();
    await html.locator("#menu-toggle").click();
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
    await original.locator("#close-view").click();
    await html.locator("#close-view").click();
    await original.locator("#title").click();
    await html.locator("#conversation-title").click();
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
