import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";
import { LiveDoc } from "@earendil-works/pi-durable";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { context } from "../src/application.ts";
import { fixture, form, servePrefixed } from "./fixtures.ts";

await test(
  "fork-aware pages preserve native cursors, context boundaries and scoped DOM identity",
  { timeout: 30_000 },
  async (t) => {
    const { app, sessions, auth, selection } = await fixture(t);
    const parent = await app.createConversation(form(selection));
    const records = await parent.commit(async (tx) => {
      const entries = [];
      for (let index = 0; index < 180; index++)
        entries.push(
          await tx.appendEntry(parent.id, {
            kind: "test.message",
            model: [
              fauxAssistantMessage(`Entry ${index}.\n\n\`\`\`ts\nconst value = ${index};\n\`\`\``),
            ],
          }),
        );
      return entries;
    }, context);
    const conversation = await parent.fork(
      records[159]!.id,
      { ownership: { kind: "ownerless" } },
      context,
    );
    const head = await conversation.commit(
      (tx) =>
        tx.appendEntry(conversation.id, {
          kind: "pi.compaction",
          head: records[60]!.id,
          model: [fauxAssistantMessage("Compaction summary")],
        }),
      context,
    );
    await conversation.commit(async (tx) => {
      for (let index = 0; index < 120; index++)
        await tx.appendEntry(conversation.id, {
          kind: "test.message",
          model: [fauxAssistantMessage(`After ${index}`)],
        });
    }, context);
    const base = await servePrefixed(t, sessions, auth, "/pds");
    const browser = await chromium.launch({
      executablePath:
        process.env.CHROMIUM_BINARY ??
        execFileSync("which", ["chromium"], { encoding: "utf8" }).trim(),
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.goto(new URL(`api/s/${app.id}/c/${conversation.id}`, base).href);
    await page.waitForFunction(
      () => document.getElementById("connection")?.textContent === "Connected",
    );
    // The marker is outside the native window, but its head still divides active context.
    assert.equal(await page.locator("#entries > article").count(), 51);
    const active = page.locator("#entries a").first();
    const url = new URL((await active.getAttribute("href"))!, base);
    assert.equal(url.searchParams.get("minEntryId"), String(records[60]!.id));
    assert.equal(url.searchParams.get("maxEntryId"), String(head.id - 1));
    assert.equal(url.searchParams.get("order"), "descending");
    assert.equal(url.searchParams.has("before"), false);
    const expected = await conversation.entries(
      {
        minEntryId: records[60]!.id,
        maxEntryId: records[159]!.id,
        order: "descending",
      },
      50,
      undefined,
      context,
    );
    await active.click();
    await page.waitForFunction(() => document.querySelectorAll("#entries article").length === 101);
    const continuation = new URL(
      (await page.locator("#entries a").first().getAttribute("href"))!,
      base,
    );
    assert.deepEqual(
      JSON.parse(Buffer.from(continuation.searchParams.get("cursor")!, "base64url").toString()),
      expected.next,
    );
    assert.equal(continuation.searchParams.get("maxEntryId"), url.searchParams.get("maxEntryId"));
    assert.equal(continuation.searchParams.get("minEntryId"), url.searchParams.get("minEntryId"));
    await page.locator("#entries a").first().click();
    await page.waitForFunction(() => document.querySelectorAll("#entries article").length === 151);
    const ids = await page
      .locator("#entries article")
      .evaluateAll((entries) =>
        entries.map((entry) => Number(entry.getAttribute("data-entry-id"))),
      );
    assert.deepEqual(
      ids.slice(0, 100),
      records.slice(60, 160).map((entry) => entry.id),
    );
    assert.equal(ids[100], head.id);
    assert.equal(await page.locator("#context-history article").count(), 0);
    await page.locator("#context-history > summary").click();
    await page.locator("#context-history a").click();
    await page.waitForFunction(
      () => document.querySelectorAll("#context-history article").length === 50,
    );
    const archived = await page
      .locator("#context-history article")
      .evaluateAll((entries) =>
        entries.map((entry) => Number(entry.getAttribute("data-entry-id"))),
      );
    assert.deepEqual(
      archived,
      records.slice(10, 60).map((entry) => entry.id),
    );
    const identity = await page.locator(`[data-entry-id="${records[110]!.id}"]`).getAttribute("id");
    const other = await browser.newPage();
    await other.goto(new URL(`api/s/${app.id}/c/${parent.id}`, base).href);
    await other.waitForFunction(
      () => document.getElementById("connection")?.textContent === "Connected",
    );
    await other.getByRole("link", { name: "Earlier messages", exact: true }).click();
    await other.locator(`[data-entry-id="${records[110]!.id}"]`).waitFor();
    assert.notEqual(
      await other.locator(`[data-entry-id="${records[110]!.id}"]`).getAttribute("id"),
      identity,
    );
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      if (process.env.PDS_SCREENSHOT_DIR) {
        await mkdir(process.env.PDS_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({
          path: join(process.env.PDS_SCREENSHOT_DIR, `history-${width}.png`),
          fullPage: true,
        });
      }
    }
  },
);

await test(
  "a changed head discards in-flight pages; replaying a page cannot duplicate entries",
  { timeout: 30_000 },
  async (t) => {
    const { app, sessions, auth, selection } = await fixture(t);
    const conversation = await app.createConversation(form(selection));
    await conversation.commit(async (tx) => {
      for (let index = 0; index < 120; index++)
        await tx.appendEntry(conversation.id, {
          kind: "test.message",
          model: [fauxAssistantMessage(`Entry ${index}`)],
        });
    }, context);
    const base = await servePrefixed(t, sessions, auth, "/pds");
    const browser = await chromium.launch({
      executablePath:
        process.env.CHROMIUM_BINARY ??
        execFileSync("which", ["chromium"], { encoding: "utf8" }).trim(),
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.goto(new URL(`api/s/${app.id}/c/${conversation.id}`, base).href);
    await page.waitForFunction(
      () => document.getElementById("connection")?.textContent === "Connected",
    );
    await page.evaluate(() => {
      document.addEventListener("datastar-fetch", ({ detail }) => {
        if (
          detail.type === "finished" &&
          detail.el instanceof HTMLAnchorElement &&
          new URL(detail.el.href).pathname.endsWith("/entries")
        ) {
          const stream = document.getElementById("stream")!;
          stream.dataset.pagesFinished = String(Number(stream.dataset.pagesFinished ?? "0") + 1);
        }
      });
    });
    const captured = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    t.after(() => release.resolve());
    await page.route("**/entries?**", async (route) => {
      const response = await route.fetch();
      const body = await response.text();
      captured.resolve();
      await release.promise;
      // Two identical responses in one SSE stream also exercise idempotent insertion.
      await route.fulfill({ response, body: body + body });
    });
    await page.getByRole("link", { name: "Earlier messages", exact: true }).click();
    await captured.promise;
    const reset = await conversation.commit(
      (tx) => tx.appendEntry(conversation.id, { kind: "pi.reset", head: "self" }),
      context,
    );
    await page.locator(`[data-entry-id="${reset.id}"]`).waitFor();
    const applied = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith("/entries"),
    );
    release.resolve();
    await applied;
    // Wait until Datastar consumes the page, not merely until fetch receives its headers.
    await page.waitForFunction(
      () => document.getElementById("stream")?.dataset.pagesFinished === "1",
    );
    assert.equal(await page.locator("#transcript article").count(), 51);
    assert.equal(await page.locator("#entries article").count(), 1);
    await page.locator("#context-history > summary").click();
    await page.locator("#context-history a").click();
    await page.waitForFunction(
      () => document.querySelectorAll("#context-history article").length === 100,
    );
    const ids = await page
      .locator("#transcript article")
      .evaluateAll((entries) => entries.map((entry) => entry.id));
    assert.equal(new Set(ids).size, ids.length);
  },
);

await test(
  "tool progress and finalization preserve nodes, disclosure, drafts and upward scroll",
  { timeout: 30_000 },
  async (t) => {
    const { app, sessions, auth, selection } = await fixture(t);
    const conversation = await app.createConversation(form(selection));
    const callId = `read / ' <script>`;
    const entry = await conversation.commit(async (tx) => {
      const record = await tx.appendEntry(conversation.id, {
        kind: "test.message",
        model: [
          fauxAssistantMessage([
            { type: "text", text: "[unsafe](javascript:alert(1))\n\n<img src=x onerror=alert(1)>" },
            {
              type: "toolCall",
              id: callId,
              name: "read",
              arguments: { path: '<script>alert("unsafe")</script>' },
            },
          ]),
        ],
      });
      const live = await tx.doc(LiveDoc, conversation.id);
      live.tools = [{ callId, name: "read", status: "running" }];
      for (let index = 0; index < 30; index++)
        await tx.appendEntry(conversation.id, {
          kind: "test.message",
          model: [fauxAssistantMessage(`Paragraph ${index}\n\n`.repeat(10))],
        });
      return record;
    }, context);
    const base = await servePrefixed(t, sessions, auth, "/pds");
    const browser = await chromium.launch({
      executablePath:
        process.env.CHROMIUM_BINARY ??
        execFileSync("which", ["chromium"], { encoding: "utf8" }).trim(),
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors: Error[] = [];
    page.on("pageerror", (error) => errors.push(error));
    await page.goto(new URL(`api/s/${app.id}/c/${conversation.id}`, base).href);
    await page.waitForFunction(
      () => document.getElementById("connection")?.textContent === "Connected",
    );
    const article = page.locator(`[data-entry-id="${entry.id}"]`);
    const node = await article.elementHandle();
    const transcript = await page.locator("#transcript").elementHandle();
    const tool = article.locator("details");
    const toolNode = await tool.elementHandle();
    assert.equal(await article.locator("script, img, a").count(), 0);
    await tool.locator("summary").click();
    assert.equal(await tool.getAttribute("open"), "");
    await page.locator("#message").fill("Unsent draft");
    await page.locator("#stream").evaluate((element) => {
      element.scrollTop = 0;
    });
    await conversation.commit(async (tx) => {
      const live = await tx.doc(LiveDoc, conversation.id);
      live.tools![0]!.output = "Progress output";
    }, context);
    await page.waitForFunction(
      () => document.querySelector(".tool-result code")?.textContent === "Progress output",
    );
    assert.equal(await tool.evaluate((element, original) => element === original, toolNode), true);
    assert.equal(await tool.getAttribute("open"), "");
    assert.equal(await page.locator("#stream").evaluate((element) => element.scrollTop), 0);
    await conversation.commit(async (tx) => {
      const live = await tx.doc(LiveDoc, conversation.id);
      await tx.appendEntry(conversation.id, {
        kind: "test.tool",
        model: [
          {
            role: "toolResult",
            toolCallId: callId,
            toolName: "read",
            content: [{ type: "text", text: "Final output" }],
            isError: false,
            timestamp: 1,
          },
        ],
      });
      delete live.tools;
    }, context);
    await page.waitForFunction(
      () => document.querySelector(".tool-result code")?.textContent === "Final output",
    );
    assert.equal(await article.evaluate((element, original) => element === original, node), true);
    assert.equal(
      await page
        .locator("#transcript")
        .evaluate((element, original) => element === original, transcript),
      true,
    );
    assert.equal(await tool.getAttribute("open"), "");
    assert.equal(await page.locator(".tool-call").count(), 1);
    assert.equal(await page.locator("#message").inputValue(), "Unsent draft");
    assert.equal(await page.locator("#stream").evaluate((element) => element.scrollTop), 0);
    assert.deepEqual(errors, []);
  },
);

await test(
  "observation rendering failures are sanitized before and after SSE headers",
  { timeout: 15_000 },
  async (t) => {
    const { app, sessions, auth, selection, models } = await fixture(t);
    const conversation = await app.createConversation(form(selection));
    const base = await servePrefixed(t, sessions, auth, "/pds");
    const browser = await chromium.launch({
      executablePath:
        process.env.CHROMIUM_BINARY ??
        execFileSync("which", ["chromium"], { encoding: "utf8" }).trim(),
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    t.after(() => browser.close());
    const page = await browser.newPage();
    const path = new URL(`api/s/${app.id}/c/${conversation.id}`, base).href;
    await page.goto(path);
    await page.waitForFunction(
      () => document.getElementById("connection")?.textContent === "Connected",
    );
    const secret = "private provider failure";
    t.mock.method(models, "getAvailable", async () => {
      throw new Error(secret);
    });
    await app.configure(conversation, form({ thinking: "high" }));
    await page.waitForFunction(
      () => !document.getElementById("connection")?.classList.contains("sr-only"),
    );
    assert.equal(await page.getByText(secret, { exact: false }).count(), 0);
    const response = await page.goto(`${path}/watch`);
    assert.equal(response?.status(), 500);
    assert.equal(
      await page.locator("#notice").textContent(),
      "Request failed. Check the conversation before resending.",
    );
    assert.equal(await page.getByText(secret, { exact: false }).count(), 0);
  },
);
