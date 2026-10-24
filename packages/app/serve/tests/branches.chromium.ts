import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { Review } from "harness";
import { browserFixture } from "./browser-testing.ts";
import { fixture, waitFor } from "./sessions-testing.ts";
import { conversationURL } from "../presentation.ts";

const context = BACKGROUND_CONTEXT;

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
      await page.goto(b.base + prefix + conversationURL(session));
      await page.locator("#controls[data-state=ready]").waitFor({ state: "attached" });
      const disclosure = page.locator("#branch-disclosure");
      const summary = disclosure.locator("summary");
      const tree = page.locator("#branch-tree");
      assert.equal(await tree.isVisible(), false);
      const before = await page.locator("#transcript").boundingBox();
      await summary.click();
      await tree.locator(`#branch-${nested.id}`).waitFor();
      assert.deepEqual(await page.locator("#transcript").boundingBox(), before);
      assert.equal(
        await tree.locator(`#branch-${branch.id} > ul > #branch-${nested.id}`).count(),
        1,
      );
      assert.equal(
        await tree.locator('[aria-current="true"]').getAttribute("href"),
        prefix + conversationURL(session),
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
      for (const width of [651, 1199, 1200, 1440]) {
        await page.setViewportSize({ width, height: 900 });
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
      await page.waitForURL(b.base + prefix + conversationURL(session, nested.id));
      await waitFor(
        async () =>
          (await page.locator('#branch-tree [aria-current="true"]').getAttribute("href")) ===
          prefix + conversationURL(session, nested.id),
      );
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await disclosure.isVisible(), false);
    }
    assert.deepEqual(b.errors, []);
  },
);
