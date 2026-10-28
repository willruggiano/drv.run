import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { browserFixture } from "../../tests/browser-testing.ts";
import { LiveDoc, type TaskId, type CompactionResult } from "@earendil-works/pi-durable";
import { fixture, readHistory, waitFor } from "../../tests/sessions-testing.ts";
import { conversationURL } from "../../presentation.ts";
import { Review } from "harness";
import { GlobalSettingsStore } from "../../server.ts";
import { changeDirectory, rename, sessionInfo, inspectContext } from "../../sessions.ts";

const context = BACKGROUND_CONTEXT;

await test(
  "session archive buttons move databases out of the list",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    const { page, base, errors } = await browserFixture(t, f.sessions);
    page.setDefaultTimeout(10000);

    const session = await f.create();
    const other = await f.create();
    const path = conversationURL(session);
    const tab = page;
    await tab.goto(base + path);
    await tab
      .locator(
        (await tab.locator("#conversation-title").isVisible())
          ? "#conversation-title"
          : "#footer-sessions",
      )
      .click();
    const row = tab
      .locator(".session-row")
      .filter({ has: tab.locator(`a[href*="${session.id}"]`) });
    const button = row.getByRole("button", { name: "Archive session", exact: true });
    await button.waitFor();
    const listURL = tab.url();
    const linkBounds = await row.locator("a").boundingBox();
    const buttonBounds = await button.boundingBox();
    assert(linkBounds && buttonBounds);
    assert(buttonBounds.x >= linkBounds.x + linkBounds.width);
    await button.click();
    await row.waitFor({ state: "detached" });
    assert.equal(tab.url(), listURL);
    assert.equal(await tab.locator(".session-row").count(), 1);
    assert.deepEqual(
      (await f.sessions.catalog()).sessions.map((item) => item.id),
      [other.id],
    );
    await tab.reload();
    await tab.locator(".session-row").waitFor();
    assert.equal(await tab.locator(`.session-row a[href*="${session.id}"]`).count(), 0);
    await tab.getByRole("button", { name: "Archive session", exact: true }).click();
    await tab.locator("#sessions-empty").waitFor();
    assert.deepEqual((await f.sessions.catalog()).sessions, []);

    assert.deepEqual(errors, []);
  },
);

await test(
  "global settings close button aligns with its opener on desktop and mobile",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    const { browser, base } = await browserFixture(t, f.sessions);
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 900, height: 900 },
      { width: 390, height: 844 },
    ]) {
      const browserContext = await browser.newContext({
        viewport,
        isMobile: viewport.width === 390,
        hasTouch: viewport.width === 390,
      });
      try {
        const page = await browserContext.newPage();
        page.setDefaultTimeout(10000);
        await page.goto(base);
        const opener = page.getByRole("link", { name: "Global settings", exact: true });
        await opener.waitFor();
        const openerBounds = await opener.boundingBox();
        assert(openerBounds);
        await opener.click();
        await page.locator("#settings").waitFor();
        const close = page.locator("#close-view");
        assert.deepEqual(await close.boundingBox(), openerBounds);
        assert.equal(await page.getByRole("heading", { level: 1 }).count(), 0);
        await page.locator("#main-area").evaluate((node) => {
          node.scrollTop = node.scrollHeight;
        });
        assert.deepEqual(await close.boundingBox(), openerBounds);
        await close.click();
        await opener.waitFor();
        assert.deepEqual(await opener.boundingBox(), openerBounds);
      } finally {
        await browserContext.close();
      }
    }
  },
);

await test("rename completes and updates the session title in the frontend", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const { page, base, errors } = await browserFixture(t, f.sessions);
  page.setDefaultTimeout(10000);

  const path = conversationURL(session);
  await page.goto(base + path);
  await page.locator("#controls[data-state=ready]").waitFor({ state: "attached" });
  await page.fill("#prompt", "/rena");
  await page.locator("#completions [role=option]").waitFor();
  await page.press("#prompt", "Tab");
  await page.waitForFunction(
    () => document.querySelector<HTMLTextAreaElement>("#prompt")?.value === "/rename ",
  );
  const name = `<b>elm session</b>`;
  await page.fill("#prompt", `/rename   ${name}  `);
  await page.press("#prompt", "Control+Enter");
  await waitFor(async () => (await sessionInfo(session)).name === name);
  await page.waitForFunction(
    (title) => document.querySelector("#conversation-title")?.textContent === title,
    name,
  );
  assert.equal(await page.locator("#conversation-title b").count(), 0);
  await page.waitForFunction(
    () => document.querySelector<HTMLTextAreaElement>("#prompt")?.value === "",
  );
  const invalid = `/rename ${"x".repeat(121)}`;
  await page.fill("#prompt", invalid);
  await page.press("#prompt", "Control+Enter");
  await page.waitForFunction(() => !!document.querySelector("#composer-error")?.textContent);
  assert.equal(await page.inputValue("#prompt"), invalid);
  assert.equal((await sessionInfo(session)).name, name);
  await page.fill("#prompt", "/rename");
  await page.locator("#send").click();
  await waitFor(async () => (await sessionInfo(session)).name === "");
  await page.waitForFunction(
    () =>
      document.querySelector("#conversation-title")?.textContent === "Untitled session" &&
      document.querySelector<HTMLTextAreaElement>("#prompt")?.value === "",
  );
  assert.equal(new URL(page.url()).pathname, path);

  assert.deepEqual(await readHistory(session.root), []);
  assert.equal(f.faux.state.callCount, 0);
  assert.deepEqual(errors, []);
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
    const path = conversationURL(session);
    await page.goto(b.base + path);
    const entry = await page.locator(`#entry-${first.id}`).elementHandle();
    assert(entry);
    await page.locator("#prompt").fill("Unsaved conversation draft");
    await page.locator("#conversation-scroll").evaluate((node) => {
      node.scrollTop = 80;
    });
    await page.locator("#latest").waitFor();
    await page.locator("#footer-model").click();
    await page.locator('#settings form[data-autosave] input[name="name"]').fill("First name");
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
    await page.locator('#settings form[data-autosave] input[name="name"]').fill("Second name");
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
    await page.locator('#settings form[data-autosave] input[name="name"]').fill("Retry name");
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
    await page.locator("#tree-rows a").nth(1).waitFor();
    assert.equal(await page.locator('#tree-rows [aria-current="true"]').getAttribute("href"), path);
    await page.locator(`#tree-rows a[href="${conversationURL(session, branch.id)}"]`).click();
    await page.waitForURL(b.base + conversationURL(session, branch.id));
    await page.locator("#prompt").fill("Branch draft");
    await page.goBack();
    await page.locator("#tree-rows a").nth(1).waitFor();
    await page.locator("#tree-rows a").first().focus();
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
    await page.goto(b.base + conversationURL(session));
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
    const path = conversationURL(session);
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const [panel, selector] of [
      ["settings", '#settings form[data-autosave] input[name="name"]'],
      ["context", "#context-view[data-tokens]"],
      ["branches", "#tree-rows a"],
      ["tree", "#tree-view"],
    ]) {
      await page.goto(b.base + path + "/" + panel);
      await page.locator(selector).waitFor();
      await page.reload();
      await page.locator(selector).waitFor();
      await page.locator("#close-view, #tree-close").click();
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
    const attachment = page.locator("elm-file[image]");
    await attachment.locator("img").waitFor();
    const openedImage = page.waitForEvent("popup");
    await attachment.getByRole("link", { name: "Open in new tab" }).click();
    const imageTab = await openedImage;
    await imageTab.waitForFunction(() => {
      const image = document.querySelector("img");
      return image?.complete && image.naturalWidth > 0;
    });
    await imageTab.close();
    await attachment.getByRole("button", { name: "Collapse Attachment" }).click();
    await attachment.locator("img").waitFor({ state: "detached" });
    await attachment.getByRole("button", { name: "Expand Attachment" }).click();
    await attachment.locator("img").waitFor();

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
    assert.equal(new URL(page.url()).pathname, conversationURL(session, review));
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

await test(
  "Markdown guest images and source citations render without model reads on mobile and desktop",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    const session = await f.create();
    const settings = new GlobalSettingsStore();
    await settings.update({ values: { "terminal.showImages": false } }, f.sessions);
    const b = await browserFixture(t, f.sessions, undefined, undefined, settings);
    const { page } = b;
    page.setDefaultTimeout(10000);
    const path = conversationURL(session);
    const fileRequests: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === path + "/file") fileRequests.push(request.url());
    });
    const image = await readFile(new URL("../../icon-192.png", import.meta.url));
    await writeFile(join(f.workspace, "shot #1?.png"), image);
    const sourceName = "source <&>.ts";
    const sourceLines = Array.from(
      { length: 100 },
      (_, index) => `const value${index + 1} = ${index + 1};`,
    );
    sourceLines[49] = '<script>globalThis.executed = true</script> & "quotes"';
    await writeFile(join(f.workspace, sourceName), sourceLines.join("\n"));
    const text = `![Screenshot](shot%20%231%3F.png)\n\n[Source:50](${encodeURIComponent(sourceName)}#L50)\n\n[Docs](https://example.com/docs)`;
    const assistant = fauxAssistantMessage("");
    const liveMessage = (text: string) => ({
      role: "assistant" as const,
      content: [{ type: "text" as const, text }],
      api: assistant.api,
      provider: assistant.provider,
      model: assistant.model,
      usage: assistant.usage,
      stopReason: assistant.stopReason,
      timestamp: assistant.timestamp,
    });
    await session.root.commit(async (tx) => {
      (await tx.doc(LiveDoc, session.root.id)).generation = {
        attempt: 1,
        message: liveMessage("![Screenshot](shot%20%231%3F.png"),
      };
    }, context);
    await page.goto(b.base + path);
    await page.locator("#live .text").waitFor();
    assert.equal(await page.locator("#live img").count(), 0);
    await session.root.commit(async (tx) => {
      (await tx.doc(LiveDoc, session.root.id)).generation = {
        attempt: 1,
        message: liveMessage(text),
      };
    }, context);
    await page.waitForFunction(
      (text) => document.querySelector("#live .text")?.getAttribute("data-source") === text,
      text,
    );
    assert.equal(await page.locator("#live img").count(), 0);
    assert.deepEqual(fileRequests, []);
    await settings.update({ values: { "terminal.showImages": true } }, f.sessions);
    await page.waitForFunction(() => {
      const image = document.querySelector<HTMLImageElement>("#live img.transcript-image");
      return image?.complete && image.naturalWidth > 0;
    });
    await session.root.commit(async (tx) => {
      delete (await tx.doc(LiveDoc, session.root.id)).generation;
      await tx.appendEntry(session.root.id, {
        kind: "pi.assistant",
        model: [fauxAssistantMessage(text)],
      });
    }, context);
    const history = await readHistory(session.root);
    const modelContext = await session.root.context(context);
    assert.equal(
      fileRequests.some((url) => new URL(url).searchParams.get("path") === sourceName),
      false,
    );
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      await page.waitForFunction(() => {
        const image = document.querySelector<HTMLImageElement>("#transcript img.transcript-image");
        return image?.complete && image.naturalWidth > 0;
      });
      const imageElement = page.locator("#transcript img.transcript-image");
      assert.equal(await imageElement.getAttribute("alt"), "Screenshot");
      assert.equal(await imageElement.getAttribute("loading"), "lazy");
      assert.equal(await imageElement.getAttribute("decoding"), "async");
      const imagePreview = page.locator("#transcript elm-file[image]");
      const openedImage = page.waitForEvent("popup");
      await imagePreview.getByRole("link", { name: "Open in new tab" }).click();
      const imageTab = await openedImage;
      await imageTab.waitForFunction(() => {
        const image = document.querySelector("img");
        return image?.complete && image.naturalWidth > 0;
      });
      await imageTab.close();
      await imagePreview.getByRole("button", { name: "Collapse Screenshot" }).click();
      await imagePreview.locator("img").waitFor({ state: "detached" });
      assert.equal(await imagePreview.getByRole("link").count(), 0);
      assert.equal(
        await imagePreview.locator(".file-toggle").textContent(),
        await page.locator("#transcript elm-file:not([image]) .file-toggle").textContent(),
      );
      await imagePreview.getByRole("button", { name: "Expand Screenshot" }).click();
      await imagePreview.locator("img").waitFor();
      const preview = page.locator("#transcript elm-file:not([image])");
      assert.equal(await preview.locator("iframe").count(), 0);
      await preview.getByRole("button", { name: "Expand Source:50" }).click();
      const frame = preview.frameLocator("iframe");
      await frame.locator("#file-source code .hljs-keyword").first().waitFor();
      assert.equal(await frame.locator("#file-source code").textContent(), sourceLines.join("\n"));
      assert.equal(await frame.locator("header").count(), 0);
      assert.equal(await frame.locator("script").count(), 0);
      assert.equal(await frame.locator(":target").getAttribute("id"), "L50");
      assert.equal(
        await frame.locator("#L50").evaluate((node) => {
          const rect = node.getBoundingClientRect();
          return rect.top >= 0 && rect.bottom <= innerHeight;
        }),
        true,
      );
      assert.equal(await preview.locator("iframe").getAttribute("sandbox"), "allow-same-origin");
      const sourceLink = page.getByRole("link", { name: "Source:50", exact: true });
      const linkColor = await sourceLink.evaluate((node) => getComputedStyle(node).color);
      const mutedColor = await page
        .locator("#transcript .message-time")
        .first()
        .evaluate((node) => getComputedStyle(node).color);
      assert.notEqual(linkColor, mutedColor);
      for (const item of [imagePreview, preview]) {
        assert.equal(
          await item.locator("summary").evaluate((node) => getComputedStyle(node).color),
          linkColor,
        );
        assert.equal(
          await item.locator(".file-toggle").evaluate((node) => getComputedStyle(node).color),
          mutedColor,
        );
      }
      assert.equal(
        await imagePreview.locator(".file-toggle").textContent(),
        await preview.locator(".file-toggle").textContent(),
      );
      assert.equal(
        await imagePreview.locator(".file-toggle").evaluate((node) => {
          const label = node.previousSibling;
          if (!(label instanceof Text)) return false;
          const range = document.createRange();
          range.selectNodeContents(label);
          return node.getBoundingClientRect().left >= range.getBoundingClientRect().right;
        }),
        true,
      );
      const labelBounds = await sourceLink.boundingBox();
      const toggleBounds = await preview.locator(".file-toggle").boundingBox();
      assert(labelBounds && toggleBounds);
      assert(toggleBounds.x >= labelBounds.x + labelBounds.width);
      assert.equal(
        (await imagePreview.locator(".file-toggle").boundingBox())?.width,
        toggleBounds.width,
      );
      if (b.screenshots)
        await page.screenshot({
          path: join(b.screenshots, `elm-${viewport.width}-file-preview.png`),
        });
      // Unrelated transcript updates must not reload or collapse the open preview.
      const originalFrame = await preview.locator("iframe").elementHandle();
      await settings.update({ values: { hideThinkingBlock: viewport.width === 390 } }, f.sessions);
      await page
        .locator(viewport.width === 390 ? "#page.hide-thinking" : "#page:not(.hide-thinking)")
        .waitFor();
      assert.equal(
        await preview
          .locator("iframe")
          .evaluate((node, original) => node === original, originalFrame),
        true,
      );
      await originalFrame?.dispose();
      const opened = page.waitForEvent("popup");
      await preview.getByRole("link", { name: "Open in new tab", exact: true }).click();
      const source = await opened;
      await source.waitForLoadState();
      assert.equal(new URL(source.url()).hash, "#L50");
      assert.equal(new URL(source.url()).searchParams.get("path"), sourceName);
      assert.equal(await source.locator("#file-source code").textContent(), sourceLines.join("\n"));
      assert((await source.locator("#file-source .hljs-keyword").count()) > 0);
      assert.equal(await source.locator("#file-source script").count(), 0);
      assert.equal(await source.evaluate(() => Object.hasOwn(globalThis, "executed")), false);
      assert.equal(await source.locator(":target").getAttribute("id"), "L50");
      assert.equal(
        await source.locator("#L50").evaluate((node) => {
          const rect = node.getBoundingClientRect();
          return rect.top >= 0 && rect.bottom <= innerHeight;
        }),
        true,
      );
      await source.close();
      await preview.getByRole("button", { name: "Collapse Source:50" }).click();
      await preview.locator("iframe").waitFor({ state: "detached" });
      assert.equal(await preview.getByRole("link").count(), 0);
    }
    await settings.update({ values: { "terminal.showImages": false } }, f.sessions);
    await page.locator("#transcript img.transcript-image").waitFor({ state: "detached" });
    fileRequests.length = 0;
    await page.reload();
    await page.locator("#page.hide-images #transcript .text").first().waitFor();
    assert.equal(await page.locator("#transcript img").count(), 0);
    assert.deepEqual(fileRequests, []);
    await settings.update({ values: { "terminal.showImages": true } }, f.sessions);
    await page.locator("#transcript img.transcript-image").waitFor({ state: "visible" });
    assert.deepEqual(await readHistory(session.root), history);
    assert.deepEqual(await session.root.context(context), modelContext);
    // Existing citations resolve relative to the current cwd, not the application server's cwd.
    await mkdir(join(f.workspace, "nested"));
    await writeFile(join(f.workspace, "nested", sourceName), "Different cwd");
    await changeDirectory(session, "nested", session.root, context);
    const source = await b.browserContext.newPage();
    await source.goto(`${b.base}${path}/file?path=${encodeURIComponent(sourceName)}`);
    assert.equal(await source.locator("#file-source code").textContent(), "Different cwd");
    await source.close();
    assert.deepEqual(b.errors, []);
  },
);

await test(
  "transcript images defer offscreen reads until scrolled near the viewport",
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t);
    const session = await f.create();
    const settings = new GlobalSettingsStore();
    await settings.update({ values: { "terminal.showImages": false } }, f.sessions);
    const image = await readFile(new URL("../../icon-192.png", import.meta.url));
    await writeFile(join(f.workspace, "offscreen.png"), image);
    await session.root.commit(
      (tx) =>
        tx.appendEntry(session.root.id, {
          kind: "pi.assistant",
          model: [
            fauxAssistantMessage("![Offscreen](offscreen.png)\n\n" + "Paragraph\n\n".repeat(1000)),
          ],
        }),
      context,
    );
    const b = await browserFixture(t, f.sessions, undefined, undefined, settings);
    const { page } = b;
    page.setDefaultTimeout(10000);
    const path = conversationURL(session);
    const requests: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === path + "/file") requests.push(request.url());
    });
    await page.goto(b.base + path);
    await page.locator("#page.hide-images #transcript .text").waitFor();
    await page.locator("#conversation-scroll").evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await settings.update({ values: { "terminal.showImages": true } }, f.sessions);
    await page.locator("#transcript img").waitFor({ state: "attached" });
    // Give layout and the browser's lazy-load observer a turn without a timer-based sleep.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    assert.equal(
      await page
        .locator("#transcript img")
        .evaluate(
          (node: HTMLImageElement) =>
            node.getBoundingClientRect().bottom < -10000 && node.naturalWidth === 0,
        ),
      true,
    );
    assert.deepEqual(requests, []);
    await page.locator("#transcript img").scrollIntoViewIfNeeded();
    await page.waitForFunction(() => {
      const image = document.querySelector<HTMLImageElement>("#transcript img");
      return image?.complete && image.naturalWidth > 0;
    });
    assert.equal(requests.length, 1);
    assert.deepEqual(b.errors, []);
  },
);

await test(
  "inline citations preview images, highlighted contracts and file errors on demand",
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t);
    const session = await f.create();
    const contract =
      "/** A contract\n * spanning lines. */\nexport type Reader = { read(): string };\n";
    await writeFile(join(f.workspace, "reader.d.ts"), contract);
    await writeFile(
      join(f.workspace, "shot.png"),
      await readFile(new URL("../../icon-192.png", import.meta.url)),
    );
    await session.root.commit(
      (tx) =>
        tx.appendEntry(session.root.id, {
          kind: "pi.assistant",
          model: [
            fauxAssistantMessage(
              "[Reader contract](reader.d.ts#L3) [Screenshot](shot.png) [Missing](missing.ts)",
            ),
          ],
        }),
      context,
    );
    const b = await browserFixture(t, f.sessions);
    const { page } = b;
    page.setDefaultTimeout(10000);
    const requests: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.endsWith("/file")) requests.push(request.url());
    });
    await page.goto(b.base + conversationURL(session));
    const reader = page.locator('elm-file[label="Reader contract"]');
    await reader.getByRole("button", { name: "Expand Reader contract" }).waitFor();
    assert.equal(await page.locator("elm-file iframe").count(), 0);
    assert.deepEqual(requests, []);
    await reader.getByRole("button", { name: "Expand Reader contract" }).press("Enter");
    const source = reader.frameLocator("iframe");
    await source.locator("#file-source .hljs-comment").waitFor();
    assert.equal(await source.locator("#file-source code").textContent(), contract);
    assert.equal(
      await source.locator(".hljs-comment").textContent(),
      "/** A contract\n * spanning lines. */",
    );
    assert.equal(await source.locator(":target").getAttribute("id"), "L3");
    assert.equal(
      await source
        .locator(".hljs-keyword")
        .first()
        .evaluate(
          (node) => getComputedStyle(node).color !== getComputedStyle(node.parentElement!).color,
        ),
      true,
    );
    await reader.getByRole("button", { name: "Collapse Reader contract" }).press("Space");
    await reader.locator("iframe").waitFor({ state: "detached" });
    const updated = "export type Reader = { close(): void };\n";
    await writeFile(join(f.workspace, "reader.d.ts"), updated);
    await reader.getByRole("button", { name: "Expand Reader contract" }).click();
    await source.locator("#file-source code").waitFor();
    assert.equal(await source.locator("#file-source code").textContent(), updated);
    const image = page.locator('elm-file[label="Screenshot"]');
    await image.getByRole("button", { name: "Expand Screenshot" }).click();
    await image.frameLocator("iframe").locator("img").waitFor();
    assert.equal(
      await image
        .frameLocator("iframe")
        .locator("img")
        .evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0),
      true,
    );
    assert.equal(
      await image.getByRole("link", { name: "Open in new tab" }).getAttribute("target"),
      "_blank",
    );
    const missing = page.locator('elm-file[label="Missing"]');
    await missing.getByRole("button", { name: "Expand Missing" }).click();
    await missing.frameLocator("iframe").getByRole("heading", { name: "Request failed" }).waitFor();
    assert.deepEqual(b.errors, []);
  },
);
