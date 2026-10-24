import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { browserFixture } from "../../tests/browser-testing.ts";
import { LiveDoc, type TaskId, type CompactionResult } from "@earendil-works/pi-durable";
import { fixture, waitFor } from "../../tests/sessions-testing.ts";
import { conversationURL } from "../../presentation.ts";
import { Review } from "harness";
import { rename, sessionInfo, inspectContext } from "../../sessions.ts";

const context = BACKGROUND_CONTEXT;

await test("conversation frontend visual parity", { timeout: 60000 }, async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  await rename(session, "Conversation alignment");
  await session.root.commit(async (tx) => {
    await tx.appendEntry(session.root.id, {
      kind: "pi.user",
      model: [
        {
          role: "user",
          content: "Check the build and explain the result.",
          timestamp: 1700000000000,
        },
      ],
    });
    await tx.appendEntry(session.root.id, {
      kind: "pi.assistant",
      model: [
        fauxAssistantMessage(
          [
            { type: "thinking", thinking: "I'll run the focused tests first." },
            fauxToolCall(
              "bash",
              { command: "node --test packages/app/serve/elm/tests/" + "long-path/".repeat(12) },
              { id: "build" },
            ),
          ],
          { timestamp: 1700000001000 },
        ),
      ],
    });
    await tx.appendEntry(session.root.id, {
      kind: "pi.tool",
      model: [
        {
          role: "toolResult",
          toolCallId: "build",
          toolName: "bash",
          content: [{ type: "text", text: "12 tests passed.\nNo failures." }],
          isError: false,
          durationMs: 124,
          timestamp: 1700000002000,
        },
      ],
    });
    await tx.appendEntry(session.root.id, {
      kind: "pi.assistant",
      model: [
        fauxAssistantMessage("All **12 tests passed**. The build is ready.", {
          timestamp: 1700000003000,
        }),
      ],
    });
  }, context);
  const b = await browserFixture(t, f.sessions);
  const page = b.page;
  page.setDefaultTimeout(10000);
  for (const width of [390, 1440]) {
    const geometry = new Map<string, unknown>();
    await page.setViewportSize({ width, height: 900 });
    for (const frontend of ["htmx", "elm"]) {
      const path = (frontend === "elm" ? "/elm" : "") + conversationURL(session);
      await page.goto(b.base + path);
      await page.locator("#transcript .tool-call").waitFor();
      await page.locator("#prompt").fill("A retained draft");
      await page.waitForFunction(() => {
        const prompt = document.querySelector<HTMLTextAreaElement>("#prompt");
        return prompt?.style.height;
      });
      const compare = async (view: string, selector: string) => {
        const boxes = await page.locator(selector).evaluateAll((nodes) =>
          nodes
            .filter((node) => node.checkVisibility())
            .map((node) => {
              const { x, y, width, height } = node.getBoundingClientRect();
              return {
                x: Math.round(x),
                y: Math.round(y),
                width: Math.round(width),
                height: Math.round(height),
              };
            }),
        );
        if (frontend === "htmx") geometry.set(view, boxes);
        else assert.deepEqual(boxes, geometry.get(view));
      };
      await compare(
        "conversation",
        "#composer-shell, #bottom-line, #transcript > article:not(:empty):not([hidden])",
      );
      if (width === 390) {
        await page.locator("#footer-collapse").click();
        assert.equal(await page.locator("#composer-shell").isVisible(), false);
        if (b.screenshots)
          await page.screenshot({
            path: join(b.screenshots, `${frontend}-${width}-collapsed.png`),
          });
        await page.locator("#footer-collapse").click();
        assert.equal(await page.locator("#prompt").inputValue(), "A retained draft");
      }
      const documentHandle = await page.evaluateHandle(() => window.document);
      if (b.screenshots)
        await page.screenshot({
          path: join(b.screenshots, `${frontend}-${width}-conversation.png`),
        });
      await page.locator("#footer-model").click();
      await page.locator('#session-settings input[name="name"]').waitFor();
      await compare(
        "settings",
        "#preferences, #session-settings, #session-settings label:not([hidden]), #composer-shell",
      );
      assert.equal(await documentHandle.evaluate((doc) => doc === window.document), true);
      assert.equal(await page.locator("#prompt").inputValue(), "A retained draft");
      if (frontend === "elm") await page.waitForURL(b.base + path + "/settings");
      if (b.screenshots)
        await page.screenshot({ path: join(b.screenshots, `${frontend}-${width}-settings.png`) });
      await page.locator("#close-view").click();
      await page.locator("#footer-context").click();
      await page.locator("#context-view[data-tokens]").waitFor();
      await compare("context", "#context-view, .ctx-usage, .ctx-window, .ctx-message");
      assert.equal(await documentHandle.evaluate((doc) => doc === window.document), true);
      if (frontend === "elm") await page.waitForURL(b.base + path + "/context");
      if (b.screenshots)
        await page.screenshot({ path: join(b.screenshots, `${frontend}-${width}-context.png`) });
      await page.locator("#close-view").click();
      await page.locator("#prompt").fill("/reset");
      await page.locator("#send").click();
      await page.getByRole("textbox", { name: "Handoff instructions", exact: true }).waitFor();
      await compare("reset", "#composer-shell, #prompt, .actions > .icon");
      if (b.screenshots)
        await page.screenshot({ path: join(b.screenshots, `${frontend}-${width}-reset.png`) });
      await documentHandle.dispose();
    }
  }
  assert.deepEqual(b.errors, []);
});

await test(
  "Elm session panels preserve local state, serialize settings saves and stream context",
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t);
    const session = await f.create();
    const first = await session.root.commit(
      (tx) =>
        tx.appendEntry(session.root.id, {
          kind: "pi.user",
          model: [{ role: "user", content: "Original context\n".repeat(100), timestamp: 0 }],
        }),
      context,
    );
    const b = await browserFixture(t, f.sessions);
    const page = b.page;
    page.setDefaultTimeout(10000);
    const path = "/elm" + conversationURL(session);
    await page.goto(b.base + path);
    const entry = await page.locator(`#entry-${first.id}`).elementHandle();
    assert(entry);
    await page.locator("#prompt").fill("Unsaved conversation draft");
    await page.locator("#conversation-scroll").evaluate((node) => {
      node.scrollTop = 80;
    });
    await page.locator("#latest").waitFor();
    await page.locator("#footer-model").click();
    await page.locator('#session-settings input[name="name"]').fill("First name");
    const received = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    t.after(() => release.resolve());
    let saves = 0;
    await page.route("**/settings", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch();
      if (++saves === 1) {
        received.resolve();
        await release.promise;
      }
      await route.fulfill({ response });
    });
    await page.locator("#thinking").selectOption("low");
    await received.promise;
    await page.locator('#session-settings input[name="name"]').fill("Second name");
    await page.locator("#close-view").click();
    assert.equal(new URL(page.url()).pathname, path + "/settings");
    release.resolve();
    await page.waitForURL(b.base + path);
    assert.equal(saves, 2);
    const info = await sessionInfo(session);
    assert.equal(info.name, "Second name");
    assert.equal(info.thinkingLevel, "low");
    assert.equal(await page.locator("#prompt").inputValue(), "Unsaved conversation draft");
    await page.waitForFunction(
      () => document.getElementById("conversation-scroll")?.scrollTop === 80,
    );
    assert.equal(await entry.evaluate((node) => node === document.getElementById(node.id)), true);
    await page.unroute("**/settings");

    await page.locator("#footer-model").click();
    await page.route("**/settings", (route) =>
      route.request().method() === "POST" ? route.fulfill({ status: 503 }) : route.continue(),
    );
    await page.locator('#session-settings input[name="name"]').fill("Retry name");
    await page.locator("#close-view").click();
    await page.getByRole("button", { name: "Retry saving settings" }).waitFor();
    assert.equal(new URL(page.url()).pathname, path + "/settings");
    assert.equal((await sessionInfo(session)).name, "Second name");
    await page.unroute("**/settings");
    await page.getByRole("button", { name: "Retry saving settings" }).click();
    await page.waitForURL(b.base + path);
    assert.equal((await sessionInfo(session)).name, "Retry name");

    await page.locator("#footer-context").click();
    await page.locator("#context-view[data-tokens]").waitFor();
    assert.equal(await page.locator("#app-footer").isVisible(), false);
    await session.root.commit(
      (tx) =>
        tx.appendEntry(session.root.id, {
          kind: "pi.user",
          model: [{ role: "user", content: "More context ".repeat(500), timestamp: 1 }],
        }),
      context,
    );
    const watch = await session.root.watch(context);
    const inspection = await inspectContext(session, watch.value, context);
    await watch.stop();
    assert.equal(inspection.state, "available");
    if (inspection.state !== "available") throw new Error("Context unavailable");
    await waitFor(
      async () =>
        Number(await page.locator("#context-view").getAttribute("data-tokens")) ===
        inspection.tokens,
    );
    assert.deepEqual(
      await page.locator(".ctx-message").evaluateAll((nodes) =>
        nodes.map((node) => ({
          role: node.getAttribute("data-role"),
          tokens: Number(node.getAttribute("data-tokens")),
        })),
      ),
      inspection.messages.map(({ role, tokens }) => ({ role, tokens })),
    );
    await page.goBack();
    await page.waitForURL(b.base + path);
    assert.equal(await page.locator("#prompt").inputValue(), "Unsaved conversation draft");
    await page.waitForFunction(
      () => document.getElementById("conversation-scroll")?.scrollTop === 80,
    );
    assert.equal(await entry.evaluate((node) => node === document.getElementById(node.id)), true);

    const branch = await session.root.fork(first.id, { ownership: { kind: "ownerless" } }, context);
    await page.locator("#prompt").fill("/fork");
    await page.locator("#send").click();
    await page.locator("#branches a").nth(1).waitFor();
    assert.equal(await page.locator('#branches [aria-current="true"]').getAttribute("href"), path);
    await page.locator(`#branches a[href="/elm${conversationURL(session, branch.id)}"]`).click();
    await page.waitForURL(b.base + "/elm" + conversationURL(session, branch.id));
    await page.locator("#prompt").fill("Branch draft");
    await page.goBack();
    await page.locator("#branches a").nth(1).waitFor();
    await page.locator("#branches a").first().focus();
    await page.keyboard.press("Escape");
    await page.waitForURL(b.base + path);
    assert.equal(await page.locator("#prompt").inputValue(), "/fork");
    assert.deepEqual(b.errors, []);
  },
);

await test(
  "Elm keeps mobile collapse through live metadata updates and renders compaction disclosures",
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t);
    const session = await f.create();
    const b = await browserFixture(t, f.sessions);
    const page = b.page;
    page.setDefaultTimeout(10000);
    await page.goto(b.base + "/elm" + conversationURL(session));
    await page.locator("#prompt").fill("Retained draft");
    await page.locator("#footer-collapse").click();
    await rename(session, "Changed name");
    await session.root.commit(async (tx) => {
      const live = await tx.doc(LiveDoc, session.root.id);
      live.run = { taskId: 100 as TaskId, inputs: [] };
      live.compactions = [
        { taskId: 101 as TaskId<CompactionResult>, blocking: true, reason: "manual", attempt: 1 },
      ];
    }, context);
    await page.locator('#controls[data-state="working"]').waitFor({ state: "attached" });
    assert.equal(await page.locator("#composer-shell").isVisible(), false);
    await page.locator("#compaction-101 summary").click();
    assert.equal(
      await page.locator("#compaction-101").evaluate((node: HTMLDetailsElement) => node.open),
      true,
    );
    assert.equal(
      await page.locator('#compaction-101 .tool-status[data-state="running"] > span').count(),
      4,
    );
    if (b.screenshots)
      await page.screenshot({ path: join(b.screenshots, "elm-390-compaction.png") });
    await page.setViewportSize({ width: 1440, height: 900 });
    assert.equal(await page.locator("#composer-shell").isVisible(), true);
    await page.setViewportSize({ width: 390, height: 900 });
    assert.equal(await page.locator("#composer-shell").isVisible(), false);
    await page.locator("#footer-collapse").click();
    assert.equal(await page.locator("#prompt").inputValue(), "Retained draft");
    await page.locator("#footer-sessions").click();
    await page.locator("#session-list").waitFor();
    assert.deepEqual(b.errors, []);
  },
);

await test(
  "Elm session deep links, exports, images and review navigation stay within the conversation frontend",
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t);
    const session = await f.create();
    const b = await browserFixture(t, f.sessions);
    const page = b.page;
    page.setDefaultTimeout(10000);
    const path = "/elm" + conversationURL(session);
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const [panel, selector] of [
      ["settings", '#session-settings input[name="name"]'],
      ["context", "#context-view[data-tokens]"],
      ["branches", "#branches a"],
    ]) {
      await page.goto(b.base + path + "/" + panel);
      await page.locator(selector).waitFor();
      await page.reload();
      await page.locator(selector).waitFor();
      await page.locator("#close-view").click();
      await page.waitForURL(b.base + path);
    }
    const image = await (await fetch(b.base + "/icon-192.png")).arrayBuffer();
    await session.root.commit(
      (tx) =>
        tx.appendEntry(session.root.id, {
          kind: "pi.user",
          model: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  mimeType: "image/png",
                  data: Buffer.from(image).toString("base64"),
                },
              ],
              timestamp: 0,
            },
          ],
        }),
      context,
    );
    await page.locator(".transcript-image").click();
    assert.equal(
      await page.locator("#image-dialog").evaluate((node: HTMLDialogElement) => node.open),
      true,
    );
    await page.keyboard.press("Escape");
    await page.locator("#image-dialog").waitFor({ state: "detached" });

    const download = page.waitForEvent("download");
    await page.locator("#prompt").fill("/export");
    await page.locator("#send").click();
    assert.equal((await download).suggestedFilename(), `pi-${session.id}-${session.root.id}.json`);
    assert.equal(new URL(page.url()).pathname, path);

    f.faux.setResponses([fauxAssistantMessage("No findings.")]);
    const documentHandle = await page.evaluateHandle(() => document);
    await page.locator("#prompt").fill("/review");
    await page.locator("#send").click();
    await page.waitForURL((url) => url.pathname !== path);
    const review = (await session.harness.snapshot(Review, session.root.id, context))?.active;
    assert(review !== undefined);
    assert.equal(new URL(page.url()).pathname, "/elm" + conversationURL(session, review));
    const conversation = await session.harness.conversation(review, context);
    assert(conversation);
    await conversation.waitForIdle(context);
    await page.locator("#prompt").fill("/endreview");
    await page.locator("#send").click();
    await page.waitForURL(b.base + path);
    assert.equal(await documentHandle.evaluate((doc) => doc === document), true);
    assert.equal(
      (await session.harness.snapshot(Review, session.root.id, context))?.active,
      undefined,
    );
    assert.deepEqual(b.errors, []);
  },
);
