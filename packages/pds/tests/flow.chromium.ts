import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { chromium, type Page } from "playwright";
import {
  fauxAssistantMessage,
  fauxThinking,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { AgentDoc, LiveDoc } from "@earendil-works/pi-durable";
import {
  context,
  ConversationMetadata,
  discoverEnvironments,
  type Application,
} from "../src/application.ts";
import { ConversationId, SessionId, decode } from "../src/identity.ts";
import { serve } from "../src/server.ts";
import { fixture, sessionsFixture, knownHostsFixture, form, servePrefixed } from "./fixtures.ts";

const conversationRoute = new URLPattern({ pathname: "*/api/s/:session/c/:conversation" });
async function selected(sessions: Application, url: string) {
  const groups = conversationRoute.exec(url)?.pathname.groups;
  assert(groups?.session && groups.conversation);
  const app = await sessions.get(decode(SessionId, decodeURIComponent(groups.session)));
  assert(app);
  const conversation = await app.conversation(decode(ConversationId, groups.conversation));
  assert(conversation);
  return { app, conversation };
}

const idle = (page: Page) =>
  page.waitForFunction(() => document.getElementById("status")?.dataset.state === "idle");

await test(
  "home → selections → uploads → streaming → tools → compaction → /new → persisted session",
  { timeout: 60_000 },
  async (t) => {
    const { sessions, auth, faux, directory } = await sessionsFixture(t);
    const server = await serve(sessions, { auth, port: 0 });
    t.after(() => server.close());
    const browser = await chromium.launch({
      executablePath:
        process.env.CHROMIUM_BINARY ??
        execFileSync("which", ["chromium"], { encoding: "utf8" }).trim(),
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    try {
      const page = await browser.newPage();
      const errors: Error[] = [];
      page.on("pageerror", (error) => errors.push(error));
      await page.goto(server.origin);
      await page.locator("#thinking").selectOption("high");
      await page.getByRole("button", { name: "Create session", exact: true }).click();
      await page.waitForURL((url) => conversationRoute.test(url.href));
      const firstURL = page.url();
      const { app, conversation: session } = await selected(sessions, firstURL);
      assert.equal((await session.agent(context)).thinkingLevel, "high");
      await idle(page);

      const changed = join(directory, "other");
      await mkdir(changed);
      await writeFile(join(changed, "check.txt"), "selected directory");
      const answer =
        "# Answer\n\n**Rendered markdown**\n\n```ts\nconst answer = 42;\n```\n\n<script>window.pdsInjected = true</script>\n\n" +
        "Streaming text. ".repeat(200);
      faux.setResponses([
        (input, options, _state, model) => {
          assert.equal(model.id, "first");
          assert.equal(options?.reasoning, "high");
          const user = input.messages.find((message) => message.role === "user");
          assert(user && Array.isArray(user.content));
          assert(user.content.some((part) => part.type === "image"));
          assert(
            user.content.some(
              (part) =>
                part.type === "text" && part.text === "Attachment: source.ts\n\nconst source = 1;",
            ),
          );
          return fauxAssistantMessage([
            fauxThinking("Consider the attachments."),
            fauxText(answer),
          ]);
        },
        (_input, _options, _state, model) => {
          assert.equal(model.id, "second");
          return fauxAssistantMessage(fauxToolCall("read", { path: "check.txt" }), {
            stopReason: "toolUse",
          });
        },
        (input) => {
          const result = input.messages.findLast((message) => message.role === "toolResult");
          assert(result?.role === "toolResult" && !result.isError);
          return fauxAssistantMessage("The tool read the selected directory.");
        },
        fauxAssistantMessage(
          "The user supplied attachments. The tool read check.txt. Preserve these decisions.",
        ),
      ]);
      await page.locator("#message").fill("Review these files");
      await page.locator("#attachments").setInputFiles([
        {
          name: "tiny.png",
          mimeType: "image/png",
          buffer: Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
            "base64",
          ),
        },
        { name: "source.ts", mimeType: "text/plain", buffer: Buffer.from("const source = 1;") },
      ]);
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await page.locator("#partial").waitFor();
      assert.equal(await page.locator("#message").inputValue(), "");
      assert.equal(
        await page
          .locator("#attachments")
          .evaluate((input: HTMLInputElement) => input.files?.length),
        0,
      );
      // Draft/configuration controls are not part of the streamed transcript morph.
      await page.locator("#message").fill("Read check.txt");
      await page.locator("#cwd").fill("unfinished directory draft");
      const partial = await page.locator("#partial").textContent();
      await page.waitForFunction(
        (before) => document.querySelector("#partial")?.textContent !== before,
        partial,
      );
      assert.equal(await page.locator("#cwd").inputValue(), "unfinished directory draft");
      await page.locator("#cwd").fill("");
      await page.locator("#cwd").press("Enter");
      await page.locator("#notice").waitFor({ state: "visible" });
      assert.equal((await session.agent(context)).cwd, directory);
      await page.locator("#cwd").fill(changed);
      await page.locator("#cwd").press("Enter");
      await page.waitForFunction(
        (value) => document.querySelector("#cwd")?.getAttribute("value") === value,
        changed,
      );
      await page.locator("#model").selectOption("faux/second");
      await page.waitForFunction(() => document.querySelectorAll("#thinking option").length === 1);
      assert.equal(await page.locator("#message").inputValue(), "Read check.txt");
      // Queue while the first response is still streaming.
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await page.locator("#queue article").waitFor();
      await idle(page);
      assert.equal((await session.agent(context)).cwd, changed);
      assert.equal(await page.locator("#transcript .hljs-keyword").count(), 1);
      assert.equal(
        await page.locator("#transcript strong").first().textContent(),
        "Rendered markdown",
      );
      assert.equal(await page.locator("#transcript .thinking").count(), 1);
      assert.equal(await page.locator("#transcript script").count(), 0);
      assert.equal(await page.evaluate(() => Object.hasOwn(window, "pdsInjected")), false);
      assert.equal(await page.locator("#transcript img").count(), 1);
      assert.equal(await page.locator(".tool-call[data-state=completed]").count(), 1);
      assert.equal(
        (await app.harness.snapshot(LiveDoc, session.id, context))?.runFailure,
        undefined,
      );

      await page.locator("#message").fill("/compact keep the file decisions");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await page.locator('[data-kind="pi.compaction"]').waitFor();
      await idle(page);
      assert.equal((await session.context(context)).head?.kind, "pi.compaction");
      await page.reload();
      await page.locator('[data-kind="pi.compaction"]').waitFor();
      assert.equal(await page.locator("#cwd").inputValue(), changed);

      // Environment changes are durable and inherited by /new, without starting SSH on selection.
      await page.locator("#environment").fill("ssh:test-guest");
      await page.locator("#environment").press("Enter");
      await page.waitForFunction(
        () =>
          document.querySelector<HTMLInputElement>("#environment")?.defaultValue ===
          "ssh:test-guest",
      );
      await page.locator("#message").fill("/new");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await page.waitForURL((url) => url.href !== firstURL);
      await idle(page);
      assert.equal(await page.locator("#environment").inputValue(), "ssh:test-guest");
      assert.equal(await page.locator("#cwd").inputValue(), changed);
      assert.equal(await page.locator("#transcript article").count(), 0);
      assert.equal((await app.list()).length, 2);
      await page.getByRole("link", { name: "Conversations", exact: true }).first().click();
      assert.equal(await page.locator("#session-list .session-row").count(), 2);
      await page.getByRole("link", { name: "Review these files", exact: true }).click();
      await page.locator('[data-kind="pi.compaction"]').waitFor();
      assert.equal(page.url(), firstURL);
      assert.equal(
        (await app.harness.snapshot(AgentDoc, session.id, context))?.model?.modelId,
        "second",
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  },
);

await test(
  "disconnects do not cancel runs; reconnect, stop, errors, and rejected commands keep usable state",
  { timeout: 60_000 },
  async (t) => {
    const { sessions, auth, faux } = await sessionsFixture(t);
    const server = await serve(sessions, { auth, port: 0 });
    t.after(() => server.close());
    const browser = await chromium.launch({
      executablePath:
        process.env.CHROMIUM_BINARY ??
        execFileSync("which", ["chromium"], { encoding: "utf8" }).trim(),
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    try {
      const page = await browser.newPage();
      const errors: Error[] = [];
      page.on("pageerror", (error) => errors.push(error));
      await page.goto(server.origin);
      await page.getByRole("button", { name: "Create session", exact: true }).click();
      await page.waitForURL((url) => conversationRoute.test(url.href));
      const url = page.url();
      const { app, conversation: session } = await selected(sessions, url);
      await idle(page);
      await page.locator("#message").fill("/not-a-command");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await page.waitForFunction(() => !!document.getElementById("notice")?.textContent);
      assert.equal(await page.locator("#message").inputValue(), "/not-a-command");
      assert.equal((await session.context(context)).entries.length, 0);

      faux.setResponses([
        fauxAssistantMessage("Long running response. ".repeat(2000)),
        fauxAssistantMessage("", { stopReason: "error", errorMessage: "Provider unavailable" }),
        fauxAssistantMessage("", { stopReason: "error", errorMessage: "Summary unavailable" }),
      ]);
      await page.locator("#message").fill("Start work");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await page.locator("#partial").waitFor();
      await page.goto(server.origin);
      assert((await app.harness.snapshot(LiveDoc, session.id, context))?.run);
      await page.goto(url);
      await page.locator("#partial").waitFor();
      assert.equal(await page.locator("#connection").textContent(), "Connected");
      const other = await browser.newPage();
      await other.goto(url);
      await other.locator("#partial").waitFor();
      await page.getByRole("button", { name: "Stop", exact: true }).click();
      await idle(page);
      await idle(other);
      assert.equal(
        (await app.harness.snapshot(LiveDoc, session.id, context))?.runFailure?.reason,
        "aborted",
      );
      assert.equal(await page.locator("#partial").count(), 0);
      await other.close();
      await page.locator("#message").fill("Try again");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await page.waitForFunction(() =>
        [...document.querySelectorAll("#conversation .error")].some(
          (element) => element.textContent === "model_error: Provider unavailable",
        ),
      );
      assert.equal(
        (await app.harness.snapshot(LiveDoc, session.id, context))?.runFailure?.reason,
        "model_error",
      );
      await page.locator("#message").fill("/compact");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await page.waitForFunction(() =>
        [...document.querySelectorAll("#conversation .error")].some(
          (element) =>
            element.textContent === "Compaction failed: Summarization failed: Summary unavailable",
        ),
      );
      assert((await app.harness.snapshot(LiveDoc, session.id, context))?.compactionFailure);
      assert.equal(await page.locator("#message").inputValue(), "");
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  },
);

await test(
  "mobile creation sends attachments; streaming preserves scroll and collapsed composer",
  { timeout: 60_000 },
  async (t) => {
    const { sessions, auth, faux } = await sessionsFixture(t);
    const server = await serve(sessions, { auth, port: 0 });
    t.after(() => server.close());
    const browser = await chromium.launch({
      executablePath:
        process.env.CHROMIUM_BINARY ??
        execFileSync("which", ["chromium"], { encoding: "utf8" }).trim(),
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      const errors: Error[] = [];
      page.on("pageerror", (error) => errors.push(error));
      faux.setResponses([
        fauxAssistantMessage("A mobile answer.\n\n" + "Line of streamed text.\n\n".repeat(200)),
      ]);
      await page.goto(server.origin);
      await page.locator("#message").fill("Hello from mobile");
      await page
        .locator("#attachments")
        .setInputFiles([
          { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("Mobile attachment") },
        ]);
      await page.getByRole("button", { name: "Remove notes.txt", exact: true }).waitFor();
      await page.getByRole("button", { name: "Create session", exact: true }).click();
      await page.waitForURL((url) => conversationRoute.test(url.href));
      await page.locator("#partial").waitFor();
      const { conversation: session } = await selected(sessions, page.url());
      const user = (await session.context(context)).messages.find(
        (message) => message.role === "user",
      );
      assert.deepEqual(user?.content, [
        { type: "text", text: "Hello from mobile" },
        { type: "text", text: "Attachment: notes.txt\n\nMobile attachment" },
      ]);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      assert.equal(
        await page.locator("#composer-shell").evaluate((element) => {
          const box = element.getBoundingClientRect();
          return box.top >= 0 && box.bottom <= innerHeight;
        }),
        true,
      );
      await page.locator("#footer-collapse").click();
      await page.locator("#composer-shell").waitFor({ state: "hidden" });
      await page.waitForFunction(
        () =>
          document.querySelector("#stream")!.scrollHeight >
          document.querySelector("#stream")!.clientHeight + 100,
      );
      assert.equal(
        await page
          .locator("#stream")
          .evaluate(
            (element) => element.scrollHeight - element.clientHeight - element.scrollTop < 32,
          ),
        true,
      );
      await page.locator("#stream").evaluate((element) => {
        element.scrollTop = 0;
      });
      const previous = await page.locator("#partial").textContent();
      await page.waitForFunction(
        (before) => document.querySelector("#partial")?.textContent !== before,
        previous,
      );
      assert.equal(await page.locator("#footer-collapse").getAttribute("aria-expanded"), "false");
      assert.equal(await page.locator("#stream").evaluate((element) => element.scrollTop), 0);
      await page.locator("#footer-collapse").click();
      await page.locator("#composer-shell").waitFor({ state: "visible" });
      await page.getByRole("button", { name: "Latest", exact: true }).click();
      assert.equal(
        await page
          .locator("#stream")
          .evaluate(
            (element) => element.scrollHeight - element.clientHeight - element.scrollTop < 32,
          ),
        true,
      );
      await page.getByRole("button", { name: "Stop", exact: true }).click();
      await idle(page);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  },
);

await test(
  "home retains recent sessions and only the composer on desktop and mobile",
  { timeout: 60_000 },
  async (t) => {
    const { sessions, auth, selection, faux } = await sessionsFixture(t);
    const server = await serve(sessions, { auth, port: 0 });
    t.after(() => server.close());
    const browser = await chromium.launch({
      executablePath:
        process.env.CHROMIUM_BINARY ??
        execFileSync("which", ["chromium"], { encoding: "utf8" }).trim(),
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    try {
      for (const width of [1280, 390]) {
        const page = await browser.newPage({ viewport: { width, height: 844 } });
        await page.goto(server.origin);
        assert.equal(await page.locator("#sessions-empty").isVisible(), true);
        assert.equal(await page.locator("#recent-title").count(), 0);
        assert.deepEqual(
          await page.locator("form").evaluateAll((forms) => forms.map((element) => element.id)),
          ["composer"],
        );
        assert.equal(await page.locator("#landing a, #landing input, #landing button").count(), 0);
        await page.close();
      }
      const expected = [];
      for (const [id, title, date] of [
        ["older", "Fix the build", "2026-11-18"],
        ["newer", "Review the changes", "2026-11-20"],
      ]) {
        assert(id && title && date);
        const app = await sessions.open(decode(SessionId, id));
        const conversation = await app.createConversation(form(selection));
        await conversation.commit(async (tx) => {
          const metadata = await tx.doc(ConversationMetadata, conversation.id);
          metadata.title = title;
          metadata.createdAt = Date.parse(date);
        }, context);
        expected.unshift({ title, date, path: `/api/s/${id}/c/${conversation.id}` });
      }
      for (const width of [1280, 390]) {
        const page = await browser.newPage({ viewport: { width, height: 844 } });
        await page.goto(server.origin);
        assert.equal(await page.getByRole("heading", { name: "Recent sessions" }).count(), 1);
        assert.deepEqual(
          await page.locator("#session-list .session").evaluateAll((links) =>
            links.map((link) => ({
              title: link.querySelector("strong")?.textContent,
              date: link.querySelector("time")?.dateTime,
              path: new URL(link.getAttribute("href")!, document.baseURI).pathname,
            })),
          ),
          expected,
        );
        assert.equal(await page.locator("#landing form, #landing button").count(), 0);
        assert.equal(await page.locator("#sessions-empty").count(), 0);
        const alignment = await page.locator("#environment").evaluate((element) => ({
          text: getComputedStyle(element).textAlign,
          right: element.getBoundingClientRect().right,
          label: element.parentElement!.getBoundingClientRect().right,
          composer: document.querySelector(".compose-box")!.getBoundingClientRect().right,
        }));
        assert.equal(alignment.text, "right");
        assert.equal(alignment.right, alignment.label);
        assert.equal(alignment.right, alignment.composer);
        if (process.env.PDS_SCREENSHOT_DIR) {
          await mkdir(process.env.PDS_SCREENSHOT_DIR, { recursive: true });
          await page.screenshot({
            path: join(process.env.PDS_SCREENSHOT_DIR, `recent-home-${width}.png`),
            fullPage: true,
          });
        }
        await page.getByRole("link", { name: "Review the changes", exact: true }).click();
        await page.waitForURL(new URL(expected[0]!.path, server.origin).href);
        await idle(page);
        await page.close();
      }
      const page = await browser.newPage();
      await page.goto(server.origin);
      faux.setResponses([fauxAssistantMessage("New session response")]);
      const posts: string[] = [];
      page.on("request", (request) => {
        if (request.method() === "POST") posts.push(new URL(request.url()).pathname);
      });
      await page.locator("#message").fill("Start from the home composer");
      await page
        .locator("#composer")
        .evaluate((element: HTMLFormElement) => element.requestSubmit());
      await page.waitForURL((url) => conversationRoute.test(url.href));
      const { conversation } = await selected(sessions, page.url());
      await conversation.waitForIdle(context);
      assert.deepEqual(posts, ["/"]);
      assert.equal((await sessions.list()).length, 3);
      assert.equal(faux.state.callCount, 1);
      await page.close();
    } finally {
      await browser.close();
    }
  },
);

await test(
  "stealth footer controls on desktop and mobile; /cd is not a model turn",
  { timeout: 60_000 },
  async (t) => {
    const { sessions, auth, app, faux, selection, directory } = await fixture(t);
    const server = await serve(sessions, { auth, port: 0 });
    t.after(() => server.close());
    const browser = await chromium.launch({
      executablePath:
        process.env.CHROMIUM_BINARY ??
        execFileSync("which", ["chromium"], { encoding: "utf8" }).trim(),
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    try {
      for (const width of [1280, 390]) {
        const page = await browser.newPage({ viewport: { width, height: 844 } });
        const errors: Error[] = [];
        page.on("pageerror", (error) => errors.push(error));
        await page.goto(server.origin);
        assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
        assert.equal(await page.locator("#environment").isVisible(), true);
        assert.equal(await page.locator("#cwd").isVisible(), true);
        if (process.env.PDS_SCREENSHOT_DIR) {
          await mkdir(process.env.PDS_SCREENSHOT_DIR, { recursive: true });
          await page.screenshot({
            path: join(process.env.PDS_SCREENSHOT_DIR, `home-${width}.png`),
            fullPage: true,
          });
        }
        const conversation = await app.createConversation(form(selection));
        await page.goto(
          `${server.origin}/api/s/${encodeURIComponent(app.id)}/c/${conversation.id}`,
        );
        await idle(page);
        assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
        assert.equal(await page.locator("dialog").count(), 0);
        assert.equal(await page.locator("#environment").isVisible(), width > 650);
        assert.equal(await page.locator("#cwd").isVisible(), width > 650);
        for (const id of width > 650
          ? ["model", "thinking", "environment", "cwd"]
          : ["model", "thinking"]) {
          const control = page.locator(`#${id}`);
          await control.focus();
          assert.deepEqual(
            await control.evaluate((element) => {
              const style = getComputedStyle(element);
              return [style.outlineStyle, style.borderTopWidth, style.boxShadow];
            }),
            ["none", "0px", "none"],
          );
          assert.equal(
            await control
              .locator("..")
              .evaluate((element) => getComputedStyle(element).outlineStyle),
            "none",
          );
        }
        await page.locator("#thinking").selectOption("high");
        await page.waitForFunction(
          () =>
            document.querySelector<HTMLSelectElement>("#thinking")?.selectedOptions[0]
              ?.defaultSelected,
        );
        assert.equal((await conversation.agent(context)).thinkingLevel, "high");
        await page.locator("#model").selectOption("faux/second");
        await page.waitForFunction(
          () => document.querySelectorAll("#thinking option").length === 1,
        );
        assert.equal((await conversation.agent(context)).model?.modelId, "second");
        assert.equal((await conversation.agent(context)).thinkingLevel, "off");
        if (process.env.PDS_SCREENSHOT_DIR)
          await page.screenshot({
            path: join(process.env.PDS_SCREENSHOT_DIR, `configuration-${width}.png`),
            fullPage: true,
          });
        const url = page.url();
        await page.locator("#footer-context").click();
        if (width > 650) await page.locator("#footer-stats").click();
        assert.equal(page.url(), url);
        assert.equal(await page.locator("dialog").count(), 0);
        await page.locator("#message").fill("/cd nested directory");
        assert.notEqual(
          await page
            .locator(".compose-box")
            .evaluate((element) => getComputedStyle(element).borderTopColor),
          await page
            .locator("#message")
            .evaluate((element) => getComputedStyle(element).borderTopColor),
        );
        await page.getByRole("button", { name: "Send", exact: true }).click();
        await page.waitForFunction(
          (value) => document.querySelector<HTMLInputElement>("#cwd")?.value === value,
          join(directory, "nested directory"),
        );
        assert.equal((await conversation.agent(context)).cwd, join(directory, "nested directory"));
        assert.equal((await conversation.context(context)).entries.length, 0);
        assert.equal(faux.state.callCount, 0);
        await page.reload();
        await idle(page);
        assert.equal(await page.locator("#cwd").inputValue(), join(directory, "nested directory"));
        assert.deepEqual(errors, []);
        await page.close();
      }
    } finally {
      await browser.close();
    }
  },
);

await test(
  "bounded HTML history, native forms, and incremental patches preserve committed DOM",
  { timeout: 30_000 },
  async (t) => {
    const { sessions, auth, app, selection, faux } = await fixture(t);
    const conversation = await app.createConversation(form(selection));
    await conversation.commit(async (tx) => {
      for (let index = 0; index < 120; index++)
        await tx.appendEntry(conversation.id, {
          kind: "test.message",
          model: [
            fauxAssistantMessage(
              `Committed ${index}.\n\n\`\`\`ts\nconst value = ${index};\n\`\`\``,
            ),
          ],
        });
    }, context);
    const server = await serve(sessions, { auth, port: 0 });
    t.after(() => server.close());
    const browser = await chromium.launch({
      executablePath:
        process.env.CHROMIUM_BINARY ??
        execFileSync("which", ["chromium"], { encoding: "utf8" }).trim(),
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    try {
      const native = await browser.newPage({ javaScriptEnabled: false });
      await native.goto(
        `${server.origin}/api/s/${encodeURIComponent(app.id)}/c/${conversation.id}`,
      );
      assert.equal(await native.locator("#entries > article").count(), 50);
      assert.equal(await native.locator("#model").inputValue(), "faux/first");
      await native.locator("#cwd").fill("/native-directory");
      await native.locator("#configuration-cwd button").click();
      assert.equal((await conversation.agent(context)).cwd, "/native-directory");
      await native.close();

      const page = await browser.newPage();
      await page.goto(`${server.origin}/api/s/${encodeURIComponent(app.id)}/c/${conversation.id}`);
      await idle(page);
      assert.equal(await page.locator("#entries > article").count(), 50);
      await page.getByRole("link", { name: "Earlier messages", exact: true }).click();
      await page.waitForFunction(
        () => document.querySelectorAll("#conversation article").length === 100,
      );
      await page.getByRole("link", { name: "Earlier messages", exact: true }).click();
      await page.waitForFunction(
        () => document.querySelectorAll("#conversation article").length === 120,
      );
      assert.equal(
        await page.getByRole("link", { name: "Earlier messages", exact: true }).count(),
        0,
      );
      await page
        .locator("#entries > article")
        .first()
        .evaluate((entry) => {
          entry.setAttribute("data-sentinel", "preserved");
          const changed: string[] = [];
          document.addEventListener("datastar-fetch", (event) => {
            const detail = event.detail;
            if (detail.type !== "datastar-patch-elements" || !detail.argsRaw.elements) return;
            const fragment = document
              .createRange()
              .createContextualFragment(detail.argsRaw.elements);
            changed.push(...Array.from(fragment.children, (child) => child.id));
            entry.setAttribute("data-patched-roots", JSON.stringify(changed));
          });
        });
      faux.setResponses([fauxAssistantMessage("An incremental response. ".repeat(20))]);
      await page.locator("#message").fill("Continue");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await page.locator("#partial").waitFor();
      await conversation.waitForIdle(context);
      await idle(page);
      const kept = page.locator("[data-sentinel=preserved]");
      assert.equal(await kept.count(), 1);
      const roots: string[] = JSON.parse((await kept.getAttribute("data-patched-roots"))!);
      assert(roots.length > 0);
      assert.equal(roots.includes("conversation"), false);
      assert.equal(roots.includes((await kept.getAttribute("id"))!), false);
      assert.equal(await page.locator("#conversation article[data-role]").count(), 122);
      assert.equal(await page.locator("#partial").count(), 0);
      assert(
        Number.isSafeInteger(
          Number(await page.locator("#admission").getAttribute("data-submission-id")),
        ),
      );
      await page.reload();
      await idle(page);
      assert.equal(await page.locator("#entries > article").count(), 50);
      await conversation.commit(async (tx) => {
        for (let index = 0; index < 150; index++)
          await tx.appendEntry(conversation.id, {
            kind: "test.message",
            model: [fauxAssistantMessage(`Burst ${index}`)],
          });
      }, context);
      await page.waitForFunction(
        () => document.querySelectorAll("#entries > article").length === 100,
      );
      assert.equal(await page.locator("#entries article").count(), 100);
      await page.getByRole("link", { name: "Load missing messages", exact: true }).click();
      await page.waitForFunction(
        () => document.querySelectorAll("#entries article").length === 150,
      );
      await page.getByRole("link", { name: "Load missing messages", exact: true }).click();
      await page.waitForFunction(
        () => document.querySelectorAll("#entries article").length === 200,
      );
      assert.equal(
        await page.getByRole("link", { name: "Load missing messages", exact: true }).count(),
        0,
      );
    } finally {
      await browser.close();
    }
  },
);

await test(
  "prefixed session lifecycle and metadata use native forms without secret model fields",
  { timeout: 60_000 },
  async (t) => {
    const { sessions, auth, models, faux } = await sessionsFixture(t);
    const base = await servePrefixed(t, sessions, auth, "/tools/pds");
    const browser = await chromium.launch({
      executablePath:
        process.env.CHROMIUM_BINARY ??
        execFileSync("which", ["chromium"], { encoding: "utf8" }).trim(),
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    try {
      const page = await browser.newPage();
      const errors: Error[] = [];
      page.on("pageerror", (error) => errors.push(error));
      const originals = faux.provider.getModels();
      models.setProvider({
        ...faux.provider,
        getModels: () =>
          originals.map((model) => ({
            ...model,
            baseUrl: "https://private.invalid",
            headers: { Authorization: "not-for-the-browser" },
          })),
      });
      const refresh = t.mock.method(models, "refresh");
      await page.goto(new URL("api/models", base).href);
      assert.deepEqual(
        await page.locator("#models article").evaluateAll((rows) =>
          rows.map((row) => ({
            id: row.getAttribute("data-model-id"),
            provider: row.getAttribute("data-provider"),
            fields: Array.from(row.querySelectorAll("dd"), (field) =>
              field.getAttribute("data-field"),
            ),
          })),
        ),
        originals.map((model) => ({
          id: model.id,
          provider: model.provider,
          fields: [
            "id",
            "provider",
            "name",
            "input",
            "reasoning",
            "contextWindow",
            "maxTokens",
            "cost",
            "thinkingLevels",
          ],
        })),
      );
      assert.equal(await page.locator("#models select, #models input").count(), 0);
      const viewport = page.viewportSize();
      assert(viewport);
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(
        await page.locator("#models").evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          return (
            bounds.left >= 0 &&
            bounds.right <= innerWidth &&
            element.scrollWidth <= element.clientWidth
          );
        }),
        true,
      );
      await page.locator("#models").press("End");
      await page.waitForFunction(() => (document.getElementById("models")?.scrollTop ?? 0) > 0);
      await page.setViewportSize(viewport);
      assert.deepEqual(await sessions.list(), []);
      models.setProvider({ ...faux.provider, getModels: () => [] });
      await page.reload();
      assert.equal(await page.locator("#models article").count(), 0);
      assert.deepEqual(await sessions.list(), []);
      assert.equal(refresh.mock.callCount(), 0);
      models.setProvider(faux.provider);

      const id = "../λ/owner ' & % session";
      // Explicit store opening remains an API operation, not a second home creation control.
      const opened = await page.request.post(new URL("api/s/open", base).href, {
        form: { sessionId: id },
        maxRedirects: 0,
      });
      assert.equal(opened.status(), 303);
      await page.goto(new URL(opened.headers().location!, base).href);
      const app = await sessions.get(decode(SessionId, id));
      assert(app);
      assert.deepEqual(await app.list(), []);
      assert.equal((await app.harness.inspect(context)).scheduling, "paused");
      assert.equal(
        await page.getByRole("button", { name: "Create conversation", exact: true }).count(),
        1,
      );
      await page.getByRole("button", { name: "Open root conversation", exact: true }).click();
      await page.waitForURL((url) => conversationRoute.test(url.href));
      await idle(page);
      const selectedSession = await selected(sessions, page.url());
      assert.equal(selectedSession.app, app);
      assert.equal((await selectedSession.conversation.agent(context)).model, undefined);
      assert.equal((await app.harness.inspect(context)).scheduling, "paused");
      assert.deepEqual(
        await page
          .locator("link[rel=stylesheet], script[src]")
          .evaluateAll((nodes) =>
            nodes
              .map(
                (node) =>
                  new URL(node.getAttribute("href") ?? node.getAttribute("src")!, document.baseURI)
                    .pathname,
              )
              .toSorted(),
          ),
        [
          "/tools/pds/assets/browser.js",
          "/tools/pds/assets/datastar.js",
          "/tools/pds/assets/style.css",
        ],
      );
      await page.locator("#model").selectOption("faux/second");
      await page.waitForFunction(
        () =>
          document.querySelector<HTMLSelectElement>("#model")?.selectedOptions[0]?.defaultSelected,
      );
      faux.setResponses([fauxAssistantMessage("A prefixed conversation")]);
      await page.locator("#message").fill("Continue in this store");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await selectedSession.conversation.waitForIdle(context);
      await idle(page);
      assert.equal((await selectedSession.conversation.agent(context)).model?.modelId, "second");
      assert.equal(faux.state.callCount, 1);
      await page.getByRole("link", { name: "Conversations", exact: true }).first().click();
      assert.equal((await app.list()).length, 1);
      assert.equal(await page.locator("#session-list .session-row").count(), 1);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  },
);

await test(
  "configuration labels are target identifiers and discovery does not own selections or drafts",
  { timeout: 30_000 },
  async (t) => {
    const directory = await knownHostsFixture(t);
    await writeFile(join(directory, "test-guest"), "");
    const { app, sessions, auth, selection } = await fixture(t, () =>
      discoverEnvironments(directory),
    );
    const conversation = await app.createConversation(form(selection));
    const server = await serve(sessions, { auth, port: 0 });
    t.after(() => server.close());
    const browser = await chromium.launch({
      executablePath:
        process.env.CHROMIUM_BINARY ??
        execFileSync("which", ["chromium"], { encoding: "utf8" }).trim(),
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.goto(`${server.origin}/api/s/test/c/${conversation.id}`);
    await idle(page);
    assert.deepEqual(
      await page.locator("#environment-options option").evaluateAll((options) =>
        options.map((option) => {
          if (!(option instanceof HTMLOptionElement)) throw new Error("Expected an option");
          return { value: option.value, label: option.label };
        }),
      ),
      [
        { value: "local", label: "local" },
        { value: "ssh:test-guest", label: "test-guest" },
      ],
    );
    assert.equal(await page.locator("#environment").getAttribute("title"), "local");
    assert.equal(await page.locator("#environment-discovery").isVisible(), false);
    await page.locator("#message").fill("Keep the composer draft");
    await page.locator("#cwd").fill("untouched directory draft");
    // Do not blur cwd: change another control in the DOM without submitting that draft.
    await page.locator("#thinking").selectOption("high");
    await page.waitForFunction(
      () => document.querySelector<HTMLOptionElement>("#thinking option:checked")?.defaultSelected,
    );
    assert.equal(await page.locator("#cwd").inputValue(), "untouched directory draft");
    await page.locator("#environment").fill("ssh:ordinary-alias");
    await page.locator("#environment").press("Enter");
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLInputElement>("#environment")?.defaultValue ===
        "ssh:ordinary-alias",
    );
    await page.getByRole("button", { name: "Clear environment", exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector<HTMLInputElement>("#environment")?.defaultValue === "",
    );
    assert.equal(await page.locator("#message").inputValue(), "Keep the composer draft");
    await page.getByRole("button", { name: "Clear working directory", exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector<HTMLInputElement>("#cwd")?.defaultValue === "",
    );
    assert.equal((await conversation.agent(context)).cwd, undefined);
    await app.configure(conversation, form({ env: "ssh:test-guest" }));
    await rm(directory, { recursive: true });
    await writeFile(directory, "not a directory");
    await page.reload();
    await idle(page);
    assert.equal(await page.locator("#environment").inputValue(), "ssh:test-guest");
    assert.equal(await page.locator("#environment").getAttribute("title"), "test-guest");
    assert.equal(await page.locator("#environment-discovery").isVisible(), true);
    assert.equal(await page.locator("#environment-options option").count(), 1);
    await rm(directory);
    await mkdir(directory);
    await page.reload();
    await idle(page);
    assert.equal(await page.locator("#environment-discovery").isVisible(), false);
    assert.equal(await page.locator("#environment-options option").count(), 1);
    assert.equal(await page.locator("#environment").inputValue(), "ssh:test-guest");
    await rm(directory, { recursive: true });
    await writeFile(directory, "not a directory");
    await page.reload();
    await idle(page);
    assert.equal(await page.locator("#environment-discovery").isVisible(), true);
    await page.locator("#environment").fill("local");
    await page.locator("#environment").press("Enter");
    await page.waitForFunction(
      () => document.querySelector<HTMLInputElement>("#environment")?.defaultValue === "local",
    );
  },
);
