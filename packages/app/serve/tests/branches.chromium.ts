import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import type { Locator } from "playwright";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { Review } from "harness";
import { browserFixture } from "./browser-testing.ts";
import { fixture, waitFor } from "./sessions-testing.ts";
import { conversationURL } from "../presentation.ts";

const context = BACKGROUND_CONTEXT;

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
  "/tree replaces the mobile main pane and keeps drafts, navigation, and branch activity live",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    const session = await f.create();
    const at = await session.root.commit(
      (tx) =>
        tx.appendEntry(session.root.id, {
          kind: "pi.assistant",
          model: [fauxAssistantMessage("Original conversation", { timestamp: 1700000000000 })],
        }),
      context,
    );
    const branch = await session.root.fork(at.id, { ownership: { kind: "ownerless" } }, context);
    // Enough rows to require scrolling in the pane, not the document or composer.
    await session.root.commit(async (tx) => {
      for (let index = 0; index < 32; index++)
        await tx.forkConversation(session.root.id, at.id, { ownership: { kind: "ownerless" } });
    }, context);
    const b = await browserFixture(t, f.sessions);
    const page = b.page;
    page.setDefaultTimeout(10000);
    for (const frontend of ["htmx", "elm"]) {
      const prefix = frontend === "elm" ? "/elm" : "";
      const path = conversationURL(session, undefined, prefix === "/elm" ? "elm" : "htmx");
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(b.base + path);
      await page.locator("#controls[data-state=ready]").waitFor({ state: "attached" });
      const documentHandle = await page.evaluateHandle(() => window.document);
      await page.locator("#prompt").fill("/tr");
      await page.locator("#completions [role=option]").waitFor();
      await page.locator("#prompt").press("Tab");
      await waitFor(async () => (await page.locator("#prompt").inputValue()) === "/tree ");
      await page.locator("#send").click();
      await page.waitForURL(b.base + path + "/tree");
      const pane = page.locator("#tree-view");
      await pane.locator(`#branch-${branch.id}`).waitFor();
      assert.equal(await page.locator("#conversation-scroll").isVisible(), false);
      assert.equal(await page.locator("#app-footer").isVisible(), true);
      assert.equal(await page.locator("dialog[open], :modal, :popover-open").count(), 0);
      assert.equal(await page.locator("#branch-disclosure").isVisible(), false);
      assert.equal(await page.locator("#app-header .bar").isVisible(), false);
      assert.equal(await pane.locator("h1, h2, #close-view").count(), 0);
      assert.equal(await documentHandle.evaluate((doc) => doc === document), true);
      assert.equal(f.faux.state.callCount, 0);
      for (const width of [320, 390, 650, 1440]) {
        await page.setViewportSize({ width, height: 844 });
        await assertCompactTree(pane.locator("#branch-tree"));
        const bounds = await pane.boundingBox();
        const footer = await page.locator("#app-footer").boundingBox();
        assert.ok(bounds && footer && bounds.y + bounds.height <= footer.y + 1);
        assert.equal(await pane.evaluate((node) => node.scrollHeight > node.clientHeight), true);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        assert.equal(await page.locator("#footer-sessions").isVisible(), true);
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator("#prompt").fill("Retained while browsing branches");
      const footerBefore = await page.locator("#app-footer").boundingBox();
      await pane.evaluate((node) => {
        node.scrollTop = 120;
      });
      assert.equal(await pane.evaluate((node) => node.scrollTop), 120);
      assert.deepEqual(await page.locator("#app-footer").boundingBox(), footerBefore);
      await pane.evaluate((node) => {
        node.scrollTop = 0;
      });
      await branch.commit(
        (tx) =>
          tx.appendEntry(branch.id, {
            kind: "pi.assistant",
            model: [fauxAssistantMessage("Updated sibling", { timestamp: 1700000001000 })],
          }),
        context,
      );
      await pane
        .locator(`#branch-${branch.id} > .branch-row .tool-status[data-state=completed]`)
        .waitFor();
      const time = pane.locator(`#branch-${branch.id} > .branch-row .branch-time`);
      assert.equal(
        frontend === "elm"
          ? Number(await time.getAttribute("timestamp"))
          : Date.parse((await time.getAttribute("datetime"))!),
        1700000001000,
      );
      if (b.screenshots)
        await page.screenshot({ path: join(b.screenshots, `mobile-tree-${frontend}.png`) });
      await page.locator("#footer-sessions").click();
      await page.waitForURL(b.base + path);
      assert.equal(await documentHandle.evaluate((doc) => doc === document), true);
      await waitFor(
        async () =>
          (await page.locator("#prompt").inputValue()) === "Retained while browsing branches",
      );
      assert.equal(await page.locator("#prompt").inputValue(), "Retained while browsing branches");
      await page.goBack();
      await page.waitForURL(b.base + path + "/tree");
      await pane.locator(`#branch-${branch.id}`).waitFor();
      assert.equal(await page.locator("#prompt").inputValue(), "Retained while browsing branches");
      await page.reload();
      await pane
        .locator(`#branch-${branch.id} > .branch-row .tool-status[data-state=completed]`)
        .waitFor();
      assert.equal(await page.locator("#prompt").inputValue(), "Retained while browsing branches");
      await page.locator("#footer-sessions").focus();
      await page.keyboard.press("Escape");
      await page.waitForURL(b.base + path);
      await page.goto(b.base + path + "/tree");
      await pane.locator(`#branch-${branch.id} > .branch-row a`).click();
      await page.waitForURL(
        b.base + conversationURL(session, branch.id, prefix === "/elm" ? "elm" : "htmx"),
      );
      assert.equal(await page.locator("#conversation-scroll").isVisible(), true);
      assert.equal(await page.locator("#tree-view").isVisible(), false);
      assert.equal(f.faux.state.callCount, 0);
      await documentHandle.dispose();
    }
    assert.deepEqual(b.errors, []);
  },
);
