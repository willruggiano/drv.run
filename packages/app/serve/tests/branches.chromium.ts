import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import type { Locator, Page } from "playwright";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { Review } from "harness";
import { browserFixture } from "./browser-testing.ts";
import { fixture, waitFor } from "./sessions-testing.ts";
import { conversationURL } from "../presentation.ts";

const context = BACKGROUND_CONTEXT;

async function assertCanonicalGrid(page: Page) {
  const width = page.viewportSize()!.width;
  if (width < 1200) return;
  const main = await page.locator("#main-area").boundingBox();
  const composer = await page.locator("#app-footer .compose-box").boundingBox();
  assert.ok(main && composer);
  assert.equal(main.width, 820);
  assert.equal(main.x, (width - 820) / 2);
  assert.equal(main.x, composer.x);
  assert.equal(main.width, composer.width);
}

async function assertCompactTree(tree: Locator) {
  const bounds = await tree.boundingBox();
  assert.ok(bounds && bounds.width <= 280);
  assert.equal(
    await tree.locator(".branch-row a").evaluateAll((rows) =>
      rows.every((row) => {
        const name = row.querySelector(".branch-name")?.getBoundingClientRect();
        const status = row.querySelector(".tool-status")?.getBoundingClientRect();
        const time = row.querySelector(".branch-time")?.getBoundingClientRect();
        return (
          name &&
          status &&
          time &&
          name.right <= status.x &&
          status.right <= time.x &&
          row.parentElement?.getBoundingClientRect().height === 24
        );
      }),
    ),
    true,
  );
}

await test(
  "desktop branch trees navigate and receive sibling activity in both frontends",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    const session = await f.create();
    const at = await session.root.commit(
      (tx) =>
        tx.appendEntry(session.root.id, {
          kind: "pi.assistant",
          model: [fauxAssistantMessage("Done", { timestamp: 1700000000000 })],
        }),
      context,
    );
    const branch = await session.root.fork(at.id, { ownership: { kind: "ownerless" } }, context);
    const nested = await branch.fork(at.id, { ownership: { kind: "ownerless" } }, context);
    const b = await browserFixture(t, f.sessions);
    const page = await b.browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on("pageerror", (error) => b.errors.push(error));
    page.setDefaultTimeout(10000);
    for (const frontend of ["htmx", "elm"]) {
      const prefix = frontend === "elm" ? "/elm" : "";
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(
        b.base + conversationURL(session, undefined, prefix === "/elm" ? "elm" : "htmx"),
      );
      await page.locator("#controls[data-state=ready]").waitFor({ state: "attached" });
      const disclosure = page.locator("#branch-disclosure");
      const summary = disclosure.locator("summary");
      const tree = page.locator("#branch-tree");
      assert.equal(await tree.isVisible(), false);
      const before = await page.locator("#transcript").boundingBox();
      await summary.click();
      await tree.locator(`#branch-${nested.id}`).waitFor();
      await assertCompactTree(tree);
      assert.deepEqual(await page.locator("#transcript").boundingBox(), before);
      assert.equal(
        await tree.locator(`#branch-${branch.id} > ul > #branch-${nested.id}`).count(),
        1,
      );
      assert.equal(
        await tree.locator('[aria-current="true"]').getAttribute("href"),
        conversationURL(session, undefined, prefix === "/elm" ? "elm" : "htmx"),
      );
      assert.equal(
        await tree
          .locator(`#branch-${nested.id} > .branch-row .branch-time`)
          .getAttribute("aria-label"),
        "No activity yet",
      );
      const review = await session.root.commit(async (tx) => {
        const child = await tx.createConversation({ ownership: { kind: "ownerless" } });
        (await tx.doc(Review, child.id)).original = branch.id;
        return child.id;
      }, context);
      await tree.locator(`#branch-${branch.id} > ul > #branch-${review}`).waitFor();
      // A running sibling changes the header while the displayed transcript stays idle.
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      t.after(() => release.resolve());
      f.faux.setResponses([
        async () => {
          entered.resolve();
          await release.promise;
          return fauxAssistantMessage("Sibling complete");
        },
      ]);
      const submission = await branch.submit(
        { type: "input", content: "Work on the sibling" },
        context,
      );
      await entered.promise;
      const branchRow = tree.locator(`#branch-${branch.id} > .branch-row`);
      await branchRow.locator('.tool-status[data-state="running"]').waitFor();
      assert.equal(await branchRow.locator(".tool-status > span").count(), 4);
      const time = branchRow.locator(".branch-time");
      const stamp = await time.getAttribute(frontend === "elm" ? "timestamp" : "datetime");
      assert.ok(stamp !== null);
      assert.ok(Number.isFinite(frontend === "elm" ? Number(stamp) : Date.parse(stamp)));
      release.resolve();
      await submission.wait(context);
      await branch.waitForIdle(context);
      await branchRow.locator('.tool-status[data-state="completed"]').waitFor();
      assert.equal(
        await disclosure.evaluate((node) => node instanceof HTMLDetailsElement && node.open),
        true,
      );
      assert.deepEqual(await page.locator("#transcript").boundingBox(), before);
      await branch.commit(
        (tx) =>
          tx.appendEntry(branch.id, {
            kind: "pi.assistant",
            model: [
              fauxAssistantMessage("Failed", { stopReason: "error", timestamp: Date.now() + 1 }),
            ],
          }),
        context,
      );
      await branchRow.locator('.tool-status[data-state="failed"]').waitFor();
      await page.reload();
      await page.locator("#controls[data-state=ready]").waitFor({ state: "attached" });
      await summary.click();
      await branchRow.locator('.tool-status[data-state="failed"]').waitFor();
      if (b.screenshots)
        await page.screenshot({ path: join(b.screenshots, `branch-tree-${frontend}.png`) });
      for (const width of [651, 1199, 1200, 1440, 1920]) {
        await page.setViewportSize({ width, height: 900 });
        await assertCompactTree(tree);
        assert.equal(
          await tree
            .locator("a")
            .evaluateAll((nodes) => nodes.every((node) => node.scrollWidth <= node.clientWidth)),
          true,
        );
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
      }
      await page.keyboard.press("Escape");
      assert.equal(await tree.isVisible(), false);
      assert.equal(await summary.evaluate((node) => node === document.activeElement), true);
      await page.keyboard.press("Enter");
      assert.equal(await tree.isVisible(), true);
      await tree.locator(`#branch-${nested.id} > .branch-row a`).click();
      await page.waitForURL(
        b.base + conversationURL(session, nested.id, prefix === "/elm" ? "elm" : "htmx"),
      );
      await waitFor(
        async () =>
          (await page.locator('#branch-tree [aria-current="true"]').getAttribute("href")) ===
          conversationURL(session, nested.id, prefix === "/elm" ? "elm" : "htmx"),
      );
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await disclosure.isVisible(), false);
    }
    assert.deepEqual(b.errors, []);
  },
);

await test(
  "/fork and /tree use live data, isolated search composers and continuous rails in both frontends",
  { timeout: 90000 },
  async (t) => {
    const f = await fixture(t);
    const b = await browserFixture(t, f.sessions);
    const page = b.page;
    page.setDefaultTimeout(10000);
    for (const frontend of ["htmx", "elm"] as const) {
      const session = await f.create();
      const first = await session.root.commit(
        (tx) =>
          tx.appendEntry(session.root.id, {
            kind: "pi.user",
            model: [{ role: "user", content: "Shared prompt", timestamp: 1700000000000 }],
          }),
        context,
      );
      const original = await session.root.commit(
        (tx) =>
          tx.appendEntry(session.root.id, {
            kind: "pi.assistant",
            model: [fauxAssistantMessage("Original answer")],
          }),
        context,
      );
      const branch = await session.root.fork(
        first.id,
        { ownership: { kind: "ownerless" } },
        context,
      );
      const alternative = await branch.commit(
        (tx) =>
          tx.appendEntry(branch.id, {
            kind: "pi.assistant",
            model: [
              fauxAssistantMessage(
                [
                  { type: "text", text: "Alternative answer" },
                  {
                    type: "toolCall",
                    id: "read-1",
                    name: "read",
                    arguments: { path: "src/main.ts" },
                  },
                ],
                { stopReason: "toolUse" },
              ),
            ],
          }),
        context,
      );
      const tool = await branch.commit(
        (tx) =>
          tx.appendEntry(branch.id, {
            kind: "pi.tool-result",
            data: { diagnostics: [] },
            model: [
              {
                role: "toolResult",
                toolCallId: "read-1",
                toolName: "read",
                content: [{ type: "text", text: "Source file contents" }],
                isError: false,
                timestamp: 3,
              },
            ],
          }),
        context,
      );
      const more = await session.root.commit(async (tx) => {
        const entries = [];
        for (let i = 0; i < 35; i++)
          entries.push(
            await tx.appendEntry(session.root.id, {
              kind: "pi.user",
              model: [
                {
                  role: "user",
                  content: `Root prompt ${i}`,
                  timestamp: 1700000000000 + (i + 10) * 1000,
                },
              ],
            }),
          );
        return entries;
      }, context);
      const path = conversationURL(session, session.root.id, frontend);
      await page.goto(b.base + path);
      await page.locator("#controls[data-state=ready]").waitFor({ state: "attached" });
      const documentHandle = await page.evaluateHandle(() => document);
      await page.locator("#prompt").fill("/fork");
      await page.locator("#send").click();
      await page.waitForURL(b.base + path + "/branches");
      const pane = page.locator("#tree-view");
      const rows = page.locator("#tree-rows");
      await rows.locator(`[data-id="${branch.id}"]`).waitFor();
      await assertCompactTree(rows);
      assert.equal(await page.locator("#app-header, #queue, #preview, #send").count(), 0);
      assert.equal(await page.locator("#tree-close svg").count(), 1);
      assert.equal(await page.locator("#tree-filter").isVisible(), false);
      assert.equal(await page.locator("#prompt").inputValue(), "");
      await page.locator("#prompt").fill(`branch ${branch.id}`);
      assert.equal(await rows.locator("a").count(), 1);
      const update = await branch.commit(
        (tx) =>
          tx.appendEntry(branch.id, {
            kind: "pi.assistant",
            model: [fauxAssistantMessage("Failed sibling", { stopReason: "error" })],
          }),
        context,
      );
      await rows.locator('.tool-status[data-state="failed"]').waitFor();
      assert.equal(await page.locator("#prompt").inputValue(), `branch ${branch.id}`);
      assert.equal(
        await page.locator("#prompt").evaluate((node) => node === document.activeElement),
        true,
      );
      await page.locator("#prompt").fill("");
      for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: 844 });
        await assertCompactTree(rows);
        await assertCanonicalGrid(page);
        if (b.screenshots)
          await page.screenshot({ path: join(b.screenshots, `fork-${frontend}-${width}.png`) });
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator("#tree-close").click();
      await page.waitForURL(b.base + path);
      assert.equal(await documentHandle.evaluate((doc) => doc === document), true);
      await waitFor(
        async () =>
          (await page.locator("#prompt").inputValue()) === (frontend === "elm" ? "/fork" : ""),
      );
      await page.locator("#prompt").fill("/tree");
      await page.locator("#send").click();
      await page.waitForURL(b.base + path + "/tree");
      await rows.locator(`[data-id="${alternative.id}"]`).waitFor();
      assert.equal(await page.locator("#prompt").inputValue(), "");
      assert.equal(await page.locator("#tree-filter").isVisible(), true);
      assert.equal(await rows.locator(`[data-id="${first.id}"]`).count(), 1);
      assert.equal(
        await rows.locator(`[data-id="${alternative.id}"]`).getAttribute("data-parent"),
        String(first.id),
      );
      assert.equal(
        await rows.locator(`[data-id="${original.id}"]`).getAttribute("data-parent"),
        String(first.id),
      );
      assert.equal(
        await rows.locator('[aria-current="true"]').getAttribute("data-id"),
        String(more.at(-1)!.id),
      );
      assert.equal(await rows.locator(`[data-id="${tool.id}"]`).count(), 1);
      await page.locator("#tree-filter").selectOption("no-tools");
      assert.equal(await rows.locator(`[data-id="${tool.id}"]`).count(), 0);
      await page.locator("#tree-filter").selectOption("user-only");
      assert.equal(await rows.locator("button").count(), 36);
      await page.locator("#prompt").fill("no-such-entry");
      assert.equal(await rows.locator("button").count(), 0);
      assert.equal(await page.locator("#tree-empty").isVisible(), true);
      assert.equal(await page.locator("#tree-next").isDisabled(), true);
      await page.locator("#tree-filter").selectOption("all");
      await page.locator("#prompt").fill("alternative");
      assert.equal(await rows.locator("button").count(), 1);
      const appended = await branch.commit(
        (tx) =>
          tx.appendEntry(branch.id, {
            kind: "pi.assistant",
            model: [fauxAssistantMessage("Alternative continued")],
          }),
        context,
      );
      await rows.locator(`[data-id="${appended.id}"]`).waitFor();
      assert.equal(await page.locator("#prompt").inputValue(), "alternative");
      await page.locator("#prompt").press("ArrowDown");
      assert.equal(
        await rows.locator('[aria-pressed="true"]').getAttribute("data-id"),
        String(appended.id),
      );
      await page.locator("#prompt").fill("");
      assert.equal(
        await rows.locator(`[data-id="${appended.id}"]`).getAttribute("data-parent"),
        String(update.id),
      );
      await rows.locator(`[data-id="${alternative.id}"]`).click();
      assert.equal(page.url(), b.base + path + "/tree");
      assert.equal(
        await rows.locator('[aria-current="true"]').getAttribute("data-id"),
        String(more.at(-1)!.id),
      );
      for (const width of [320, 390, 650, 1440, 1920]) {
        await page.setViewportSize({ width, height: 844 });
        await assertCanonicalGrid(page);
        const bounds = await pane.boundingBox();
        const footer = await page.locator("#app-footer").boundingBox();
        const tree = await rows.boundingBox();
        assert.ok(tree && tree.width <= 820 && tree.x >= Math.max(0, (width - 820) / 2));
        assert.ok(bounds && footer && bounds.y + bounds.height <= footer.y + 1);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        assert.equal(await pane.evaluate((node) => node.scrollHeight > node.clientHeight), true);
        if (b.screenshots && [390, 1440].includes(width))
          await page.screenshot({
            path: join(b.screenshots, `session-tree-${frontend}-${width}.png`),
          });
      }
      await page.setViewportSize({ width: 390, height: 420 });
      const compactFooter = await page.locator("#app-footer").boundingBox();
      assert.ok(compactFooter && compactFooter.y + compactFooter.height <= 420);
      await page.locator("#prompt").focus();
      await page.keyboard.press("Escape");
      await page.waitForURL(b.base + path);
      await waitFor(
        async () =>
          (await page.locator("#prompt").inputValue()) === (frontend === "elm" ? "/tree" : ""),
      );
      await page.locator("#prompt").fill("Keep this unsent draft");
      await page.goto(b.base + path + "/tree");
      await rows.locator("button").first().waitFor();
      await page.locator("#prompt").fill("isolated search");
      await page.locator("#tree-close").click();
      await page.waitForURL(b.base + path);
      await waitFor(
        async () => (await page.locator("#prompt").inputValue()) === "Keep this unsent draft",
      );
      await page.goto(b.base + path + "/branches");
      const explorerDocument = await page.evaluateHandle(() => document);
      await rows.locator(`a[data-id="${branch.id}"]`).click();
      await page.waitForURL(b.base + conversationURL(session, branch.id, frontend));
      await page.locator("#controls[data-state=ready]").waitFor({ state: "attached" });
      assert.equal(await explorerDocument.evaluate((doc) => doc === document), true);
      await explorerDocument.dispose();
      assert.equal(f.faux.state.callCount, 0);
      await page.setViewportSize({ width: 390, height: 844 });
      await documentHandle.dispose();
    }
    assert.deepEqual(b.errors, []);
  },
);
