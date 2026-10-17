import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { UsageDoc } from "@earendil-works/pi-durable";
import { chromium, type Page } from "playwright";
import type { Sessions, Snapshot, ExecutionBinding } from "../pi-runtime/index.ts";
import { exists, waitFor } from "../pi-runtime/testing.ts";
import { httpServer } from "./server.ts";

const context = BACKGROUND_CONTEXT;

export async function serve(
  t: TestContext,
  sessions: Sessions,
  assets?: string,
  host = "127.0.0.1",
  publicOrigin?: string,
) {
  const server = httpServer(sessions, host, assets, publicOrigin);
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
export async function snapshot(url: string): Promise<Snapshot> {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (!text.includes("\n\n")) {
      const part = await reader.read();
      assert.equal(part.done, false);
      text += decoder.decode(part.value, { stream: true });
    }
    return JSON.parse(text.slice(6, text.indexOf("\n\n"))) as Snapshot;
  } finally {
    controller.abort();
    reader.releaseLock();
  }
}
export function post(url: string, data: unknown) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function browserFlow(
  t: TestContext,
  f: {
    sessions: Sessions;
    workspace: string;
    binding: ExecutionBinding;
    faux: ReturnType<typeof fauxProvider>;
    filePath?: string;
    extended?: boolean;
    restart?: () => Promise<Sessions>;
  },
) {
  const assets = await mkdtemp(join(tmpdir(), "pi-serve-assets-"));
  t.after(() => rm(assets, { recursive: true, force: true }));
  const source = dirname(fileURLToPath(import.meta.url));
  await writeFile(
    join(assets, "client.js"),
    stripTypeScriptTypes(await readFile(join(source, "client.ts"), "utf8")),
  );
  await writeFile(join(assets, "index.html"), await readFile(join(source, "index.html")));
  await writeFile(join(assets, "sw.js"), await readFile(join(source, "sw.js")));
  for (const size of [192, 512])
    await writeFile(
      join(assets, `icon-${size}.png`),
      await readFile(join(source, `icon-${size}.png`)),
    );
  const base = await serve(t, f.sessions, assets);
  const executablePath =
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
    (process.env.PATH ?? "")
      .split(delimiter)
      .map((path) => join(path, "chromium"))
      .find(existsSync);
  assert(executablePath, "Chromium is required for browser tests; use nix develop.");
  const browser = await chromium.launch({ executablePath });
  t.after(() => browser.close());
  const browserContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await browserContext.newPage();
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  f.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("write", { path: f.filePath ?? "browser.json", content: '{"value":31}' }),
      {
        stopReason: "toolUse",
      },
    ),
    fauxAssistantMessage('<img src=x onerror="document.body.dataset.injected=1">'),
  ]);
  await page.goto(base);
  await page.waitForFunction(
    () => document.querySelector<HTMLSelectElement>("#models")?.options.length === 2,
  );
  await page.selectOption(
    "#targets",
    JSON.stringify([f.binding.provider, f.binding.target, f.binding.cwd]),
  );
  await page.selectOption("#models", "0");
  await page.click("#create");
  await page.waitForFunction(() => new URL(location.href).searchParams.has("session"));
  const url = page.url();
  const id = new URL(url).searchParams.get("session");
  assert(id);
  await page.fill("#prompt", "Run the browser integration test.");
  await page.click("#send");
  const session = await f.sessions.get(id);
  await waitFor(() => exists(join(f.workspace, "browser.json")));
  await session.root.waitForIdle(context);
  assert.deepEqual(JSON.parse(await readFile(join(f.workspace, "browser.json"), "utf8")), {
    value: 31,
  });
  await page.waitForFunction(() => document.querySelectorAll("#transcript article").length === 4);
  assert.equal(await page.locator(".tool-call").count(), 1);
  assert.equal(await page.locator('article[data-role="toolResult"] > header').count(), 1);
  assert.equal(await page.locator('article[data-role="toolResult"] details').count(), 2);
  assert.equal(await page.locator("#transcript img").count(), 0);
  assert.equal(await page.evaluate(() => document.body.dataset.injected), undefined);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.close();
  const reconnected = await browserContext.newPage();
  reconnected.on("pageerror", (error) => errors.push(error));
  await reconnected.goto(url);
  await reconnected.waitForFunction(
    () => document.querySelectorAll("#transcript article").length === 4,
  );
  assert.equal((await f.sessions.catalog()).sessions.length, 1);
  assert.equal(f.faux.state.callCount, 2);
  assert.equal(errors.length, 0);
  // Persist both supported nested-call record formats. Legacy codemode args are
  // deliberately truncated JSON: display text, not a parseable input payload.
  await session.root.commit(async (tx) => {
    await tx.appendEntry(session.root.id, {
      kind: "test.tool-history",
      model: [
        fauxAssistantMessage(
          fauxToolCall(
            "codemode",
            { code: 'await tools.read({ path: "example.txt" })' },
            { id: "code-history" },
          ),
        ),
        {
          role: "toolResult",
          toolCallId: "code-history",
          toolName: "codemode",
          content: [{ type: "text", text: "Nested call finished" }],
          isError: false,
          timestamp: 1,
          details: {
            calls: [
              { id: 1, name: "read", args: '{"path":"example...', status: "ok", durationMs: 2 },
            ],
          },
        },
        {
          role: "toolResult",
          toolCallId: "nested-history",
          toolName: "custom.tool",
          content: [],
          isError: true,
          timestamp: 2,
          nestedCalls: {
            complete: false,
            calls: [
              {
                id: "nested-history/c1",
                name: "read",
                status: "error",
                argumentsBytes: 300,
                error: "File unavailable",
              },
            ],
          },
        },
      ],
    });
  }, context);
  await reconnected.waitForSelector(".nested-tools", { state: "attached" });
  await reconnected.reload();
  await reconnected.waitForFunction(() => document.querySelectorAll(".nested-tools").length === 2);
  assert.equal(await reconnected.locator(".nested-tools .error").count(), 1);
  assert.equal(await reconnected.locator(".nested-tools > details").count(), 4);
  assert.equal(errors.length, 0);
  if (!f.extended) return;

  // A real repository in the bound workspace, created through the scripted agent.
  f.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("bash", {
        command:
          "git init --initial-branch=pi-pwa && git -c user.name=Pi -c user.email=pi@example.invalid commit --allow-empty -m Initial",
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Repository ready."),
  ]);
  await reconnected.fill("#prompt", "Initialize the workspace repository.");
  await reconnected.click("#send");
  await reconnected.waitForFunction(
    () => document.querySelector("#footer-git")?.textContent === "(pi-pwa)",
  );
  await session.root.waitForIdle(context);

  // Real edit tool details carry a unified patch independently of assistant prose.
  f.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("edit", { path: f.filePath ?? "browser.json", oldText: "31", newText: "32" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Updated the stored value."),
  ]);
  await reconnected.fill("#prompt", "Update the stored value.");
  await reconnected.click("#send");
  await reconnected.waitForFunction(
    () => !!document.querySelector('article[data-role="toolResult"] .hljs-addition'),
  );
  await session.root.waitForIdle(context);
  assert.equal(JSON.parse(await readFile(join(f.workspace, "browser.json"), "utf8")).value, 32);

  // Scripted code-review conversation: real Durable storage, tools and streamed events.
  f.faux.setResponses([
    fauxAssistantMessage(`Updated the counter. **Small change, same interface.**

\`\`\`typescript
export function increment(value: number): number {
  return value + 1;
}
\`\`\`

\`\`\`diff
@@ -1,3 +1,3 @@
 export function increment(value: number): number {
-  return value;
+  return value + 1;
 }
\`\`\`

The new behavior is covered by a focused test. Run \`npm test\` to verify.`),
  ]);
  await reconnected.fill("#prompt", "Fix the counter and show me the change.");
  await reconnected.press("#prompt", "Control+Enter");
  await reconnected.waitForFunction(
    () =>
      document.querySelectorAll('article[data-role="assistant"] .text .hljs-addition').length > 0,
  );
  await session.root.waitForIdle(context);
  assert((await reconnected.locator(".hljs-keyword").count()) > 0);
  assert((await reconnected.locator(".hljs-deletion").count()) > 0);
  // Settings persist in the actual agent document, not just in the form.
  await reconnected.click("#menu-toggle");
  await reconnected.click("#settings");
  await reconnected.selectOption("#thinking", "high");
  await reconnected.fill("#session-name", "Counter cleanup");
  await reconnected.fill("#instructions", "Keep changes small and verify them.");
  await reconnected.click("#save-settings");
  await reconnected.waitForFunction(
    () => !document.querySelector<HTMLDialogElement>("#preferences")?.open,
  );
  assert.equal((await session.root.agent(context)).thinkingLevel, "high");
  assert.equal((await session.info()).name, "Counter cleanup");

  const ledger = await session.harness.snapshot(UsageDoc, session.root.id, context);
  assert(ledger);
  const buckets = [...Object.values(ledger.models), ...Object.values(ledger.tools)];
  const expectedInput = buckets.reduce((sum, usage) => sum + usage.input, 0);
  const expectedOutput = buckets.reduce((sum, usage) => sum + usage.output, 0);
  const expectedRead = buckets.reduce((sum, usage) => sum + usage.cacheRead, 0);
  const expectedWrite = buckets.reduce((sum, usage) => sum + usage.cacheWrite, 0);
  const expectedContext = (await snapshot(`${base}/api/sessions/${id}/events`)).context;
  // Exercise secondary controls in both pointer/keyboard and touch layouts.
  const screenshots = process.env.PI_SCREENSHOT_DIR;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  const shot = async (page: Page, name: string) => {
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    // Compare text, not button boxes: flex children must share the vertical
    // center of the adjacent native button label, including taller touch targets.
    const offsets = await page.locator("#bottom-line:visible").evaluateAll((footers) => {
      const textCenter = (button: Element) => {
        const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
        const rects: DOMRect[] = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!node.textContent?.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          rects.push(...Array.from(range.getClientRects()).filter((rect) => rect.height > 0));
        }
        return (
          (Math.min(...rects.map((rect) => rect.top)) +
            Math.max(...rects.map((rect) => rect.bottom))) /
          2
        );
      };
      return footers.flatMap((footer) => {
        const groups = matchMedia("(max-width: 650px)").matches
          ? [Array.from(footer.querySelectorAll("#footer-model, #footer-context"))]
          : Array.from(footer.querySelectorAll(".footer-row"), (row) => Array.from(row.children));
        return groups.map(([left, right]) => textCenter(left) - textCenter(right));
      });
    });
    for (const offset of offsets)
      assert(Math.abs(offset) <= 1, `${name}: footer text offset ${offset}px`);
    if (
      (page.viewportSize()?.width ?? Infinity) <= 650 &&
      (await page.locator("#bottom-line").isVisible())
    ) {
      const layout = await page.locator("#bottom-line").evaluate((footer) => {
        const box = footer.getBoundingClientRect();
        const [model, context] = Array.from(
          footer.querySelectorAll("#footer-model, #footer-context"),
          (node) => node.getBoundingClientRect(),
        );
        return {
          height: box.height,
          offset: (model.left + context.right) / 2 - (box.left + box.right) / 2,
          buttons: Array.from(footer.querySelectorAll("button"))
            .filter((node) => node.checkVisibility())
            .map((node) => node.id),
        };
      });
      assert(layout.height <= 35, `${name}: mobile footer must stay one tight line`);
      assert(Math.abs(layout.offset) <= 1, `${name}: mobile footer must be centered`);
      assert.deepEqual(layout.buttons, ["footer-model", "footer-context"]);
    }
    if (screenshots)
      await page.screenshot({ path: join(screenshots, `${name}.png`), fullPage: true });
  };
  const gallery = async (page: Page, size: string) => {
    await page.locator("#transcript").evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await page.waitForFunction(
      () => document.querySelector("#footer-git")?.textContent === "(pi-pwa)",
    );
    await shot(page, `${size}-conversation`);
    for (const [field, expected] of [
      ["input", expectedInput],
      ["output", expectedOutput],
      ["read", expectedRead],
      ["write", expectedWrite],
    ] as const)
      assert.equal(
        Number(await page.locator(`#footer-${field}`).getAttribute("data-value")),
        expected,
      );
    assert.equal(
      Number(await page.locator("#footer-context").getAttribute("data-tokens")),
      expectedContext.lastResponse?.tokens,
    );
    assert.equal(await page.locator("#footer-read").isVisible(), size === "desktop");
    await page.click(size === "desktop" ? "#footer-stats" : "#footer-context");
    await page.waitForSelector("#usage-dialog[open]");
    assert.equal(await page.locator("#usage-input").textContent(), expectedInput.toLocaleString());
    assert.equal(await page.locator("#usage-thinking").textContent(), "high");
    await shot(page, `${size}-footer-breakdown`);
    await page.keyboard.press("Escape");
    await page.click("#footer-model");
    await page.waitForSelector("#preferences[open]");
    assert.equal(await page.locator("#thinking").inputValue(), "high");
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#stop").isVisible(), false);
    assert.equal(await page.locator('label[for="prompt"]').count(), 0);
    await page.click("#menu-toggle");
    await page.waitForFunction(() =>
      document.querySelector("#conversation-menu")?.matches(":popover-open"),
    );
    await shot(page, `${size}-menu`);
    await page.keyboard.press("End");
    assert.equal(
      await page.locator("#wrap-code").evaluate((node) => node === document.activeElement),
      true,
    );
    await page.keyboard.press("Enter");
    assert.equal(
      await page.locator("body").evaluate((node) => node.classList.contains("wrap-code")),
      true,
    );
    await page.keyboard.press("Escape");
    assert.equal(
      await page.locator("#menu-toggle").evaluate((node) => node === document.activeElement),
      true,
    );
    await page.click("#menu-toggle");
    await page.click("#find");
    await page.fill("#search", "counter");
    assert.equal(await page.locator("article.search-hit").count(), 2);
    assert(await page.evaluate(() => (CSS.highlights.get("pi-search")?.size ?? 0) > 0));
    const before = await page
      .locator("article.search-current")
      .evaluate((node) => node.dataset.role);
    await page.click("#search-next");
    assert.notEqual(
      await page.locator("article.search-current").evaluate((node) => node.dataset.role),
      before,
    );
    await shot(page, `${size}-search`);
    await page.fill("#search", "Successfully");
    assert.equal(await page.locator("article.search-hit").count(), 2);
    assert((await page.locator("article.search-current details[open]").count()) > 0);
    await shot(page, `${size}-tool-search`);
    await page.fill("#search", "[");
    assert.equal(await page.locator("#notice").isVisible(), false);
    await page.fill("#search", "missing-word-abcdef");
    assert.equal(await page.locator("article.search-hit").count(), 0);
    assert.equal(await page.locator("#search-next").isDisabled(), true);
    await page.press("#search", "Escape");
    assert.equal(await page.locator("#search-bar").isVisible(), false);
    await page.locator("article .message-actions").last().click();
    await shot(page, `${size}-message-menu`);
    await page.click("#quote-message");
    assert.equal(
      await page.locator("#prompt").evaluate((node) => document.activeElement === node),
      true,
    );
    assert.equal(
      (await page.locator("#prompt").inputValue()).startsWith("> Updated the counter."),
      true,
    );
    await shot(page, `${size}-quote`);
    await page.fill("#prompt", "");
    await page.click("#input-toggle");
    await shot(page, `${size}-input-menu`);
    await page.keyboard.press("Escape");
    await page.click("#workspace");
    await page.waitForSelector("#picker[open]");
    await page.fill("#session-filter", "Counter cleanup");
    assert.equal(await page.locator("#sessions button").count(), 1);
    if (size === "mobile")
      assert.equal(
        await page
          .locator("#picker")
          .evaluate((node) => Math.round(node.getBoundingClientRect().width)),
        390,
      );
    await shot(page, `${size}-sessions`);
    await page.fill("#session-filter", "not-a-session");
    assert.equal(await page.locator("#sessions button").count(), 0);
    assert.equal(await page.locator("#sessions-empty").isVisible(), true);
    await page.fill("#session-filter", "");
    await page.keyboard.press("Escape");
    await page.click("#menu-toggle");
    await page.click("#settings");
    assert.equal(await page.locator("#session-name").inputValue(), "Counter cleanup");
    if (size === "mobile")
      assert.equal(
        await page
          .locator("#preferences")
          .evaluate((node) => Math.round(node.getBoundingClientRect().width)),
        390,
      );
    await shot(page, `${size}-settings`);
    await page.keyboard.press("Escape");
    // Persisted presentation preference and name survive a page reload.
    await page.reload();
    await page.waitForSelector('article[data-role="assistant"] .text .hljs-addition');
    assert.equal(
      await page.locator("body").evaluate((node) => node.classList.contains("wrap-code")),
      true,
    );
    await page.click("#menu-toggle");
    await page.click("#wrap-code");
    await page.keyboard.press("Escape");
    await page.locator("#transcript").evaluate((node) => {
      node.scrollTop = 0;
    });
    await page.waitForSelector("#latest", { state: "visible" });
    await shot(page, `${size}-history`);
    await page.click("#latest");
    await page.waitForSelector("#latest", { state: "hidden" });
  };
  const desktop = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const desktopPage = await desktop.newPage();
  desktopPage.on("pageerror", (error) => errors.push(error));
  await desktopPage.goto(url);
  await desktopPage.waitForSelector('article[data-role="assistant"] .text .hljs-addition');
  await gallery(desktopPage, "desktop");
  await desktop.setOffline(true);
  await desktopPage.waitForFunction(
    () => document.querySelector<HTMLElement>("#bottom-line")?.dataset.connected === "false",
  );
  await desktopPage.click("#footer-stats");
  assert.equal(await desktopPage.locator("#usage-connection").isVisible(), true);
  assert.equal(
    Number(await desktopPage.locator("#footer-input").getAttribute("data-value")),
    expectedInput,
  );
  await shot(desktopPage, "desktop-footer-offline");
  await desktopPage.keyboard.press("Escape");
  await desktop.setOffline(false);
  await desktopPage.waitForFunction(
    () => document.querySelector<HTMLElement>("#bottom-line")?.dataset.connected === "true",
  );
  await desktopPage.waitForSelector('article[data-role="assistant"] .text .hljs-addition');
  // Stress the presentation with a persisted high-usage ledger. No fake HTTP/SSE data.
  await session.root.commit(async (tx) => {
    const usage = await tx.doc(UsageDoc, session.root.id);
    usage.models["stress/model"] = {
      input: 15_000_000,
      output: 81_000,
      cacheRead: 1_300_000,
      cacheWrite: 20_000,
      totalTokens: 16_401_000,
      cost: { input: 150, output: 4, cacheRead: 0.9, cacheWrite: 0.089, total: 154.989 },
    };
  }, context);
  await desktopPage.waitForFunction(
    () => Number(document.querySelector<HTMLElement>("#footer-input")?.dataset.value) > 15_000_000,
  );
  await shot(desktopPage, "desktop-footer-high-usage");
  await reconnected.waitForFunction(
    () => Number(document.querySelector<HTMLElement>("#footer-input")?.dataset.value) > 15_000_000,
  );
  await reconnected.setViewportSize({ width: 320, height: 640 });
  await shot(reconnected, "mobile-footer-high-usage");
  await reconnected.click("#footer-context");
  await shot(reconnected, "mobile-footer-high-usage-breakdown");
  await reconnected.keyboard.press("Escape");
  await reconnected.setViewportSize({ width: 390, height: 844 });
  await session.root.commit(async (tx) => {
    const usage = await tx.doc(UsageDoc, session.root.id);
    delete usage.models["stress/model"];
  }, context);
  await reconnected.waitForFunction(
    (expected) =>
      Number(document.querySelector<HTMLElement>("#footer-input")?.dataset.value) === expected,
    expectedInput,
  );
  await desktopPage.locator('article[data-role="user"] .message-actions').last().click();
  await desktopPage.click("#copy-message");
  assert.equal(
    await desktopPage.evaluate(() => navigator.clipboard.readText()),
    "Fix the counter and show me the change.",
  );
  await desktopPage.keyboard.press("Control+k");
  assert.equal(
    await desktopPage.locator("#picker").evaluate((node) => node.hasAttribute("open")),
    true,
  );
  await desktopPage.keyboard.press("Escape");
  await desktopPage.keyboard.press("Control+f");
  assert.equal(
    await desktopPage.locator("#search").evaluate((node) => document.activeElement === node),
    true,
  );
  await desktop.close();
  await gallery(reconnected, "mobile");
  // Chromium does not reproduce iOS's keyboard-triggered auto-zoom. Guard the
  // computed 16px minimum that prevents it, including controls inside dialogs
  // and touch viewports wider than the phone layout breakpoint.
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 844, height: 390 },
    { width: 768, height: 1024 },
    { width: 1024, height: 768 },
  ]) {
    await reconnected.setViewportSize(viewport);
    const undersized = await reconnected
      .locator('input:not([type="file"]), textarea, select')
      .evaluateAll((nodes) =>
        nodes
          .map((node) => ({ id: node.id, size: parseFloat(getComputedStyle(node).fontSize) }))
          .filter((field) => field.size < 16),
      );
    assert.deepEqual(
      undersized,
      [],
      `Touch form controls at ${viewport.width}px must not trigger iOS focus zoom`,
    );
    const scale = await reconnected.evaluate(() => visualViewport?.scale);
    await reconnected.fill("#prompt", "Check the input without changing the page zoom.");
    assert.equal(await reconnected.evaluate(() => visualViewport?.scale), scale);
    assert.equal(
      await reconnected.locator("#prompt").evaluate((node) => node === document.activeElement),
      true,
    );
    await shot(reconnected, `touch-focused-${viewport.width}`);
    await reconnected.fill("#prompt", "");
  }
  await reconnected.setViewportSize({ width: 320, height: 640 });
  await reconnected.locator("#transcript").evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await shot(reconnected, "mobile-narrow");
  // Stress just the label layout: effort and context must survive model truncation.
  const modelLabel = reconnected.locator("#footer-model-name");
  const modelName = await modelLabel.textContent();
  await modelLabel.evaluate((node) => {
    node.textContent = "provider/very-long-model-name-with-version-20261017";
  });
  assert.equal(await modelLabel.evaluate((node) => node.scrollWidth > node.clientWidth), true);
  assert.equal(
    await reconnected
      .locator("#footer-effort")
      .evaluate((node) => node.scrollWidth <= node.clientWidth),
    true,
  );
  await shot(reconnected, "mobile-narrow-long-model");
  await modelLabel.evaluate((node, text) => {
    node.textContent = text;
  }, modelName);
  await reconnected.click("#menu-toggle");
  await shot(reconnected, "mobile-narrow-menu");
  await reconnected.keyboard.press("Escape");
  await reconnected.setViewportSize({ width: 768, height: 1024 });
  await shot(reconnected, "tablet");
  await reconnected.setViewportSize({ width: 390, height: 844 });

  // Fork history is isolated and survives a browser reload.
  const originalEntries = await session.history();
  await reconnected.locator("article .message-actions").last().click();
  await reconnected.click("#fork-message");
  await reconnected.waitForFunction(() => new URL(location.href).searchParams.has("conversation"));
  const branchId = Number(new URL(reconnected.url()).searchParams.get("conversation"));
  const branch = await session.conversation(branchId);
  assert.notEqual(branch.id, session.root.id);
  await reconnected.waitForFunction(
    () => document.querySelector<HTMLElement>("#footer-input")?.dataset.value === "0",
  );
  assert.equal(
    Number(await reconnected.locator("#footer-context").getAttribute("data-tokens")),
    expectedContext.lastResponse?.tokens,
  );
  f.faux.setResponses([fauxAssistantMessage("This alternative is isolated in the branch.")]);
  await reconnected.fill("#prompt", "Try another approach.");
  await reconnected.click("#send");
  await reconnected.waitForFunction(
    (count) => document.querySelectorAll("article[data-role=assistant]").length > count,
    3,
  );
  await branch.waitForIdle(context);
  assert.equal((await session.history()).length, originalEntries.length);
  await reconnected.fill("#prompt", "Unsent branch draft");
  await reconnected.reload();
  await reconnected.waitForFunction(
    () => document.querySelector<HTMLTextAreaElement>("#prompt")?.value === "Unsent branch draft",
  );
  await reconnected.fill("#prompt", "");

  // Queue both modes behind a deterministic provider barrier; cancel one.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  let entered = false;
  f.faux.setResponses([
    async () => {
      entered = true;
      await gate;
      return fauxAssistantMessage("First run finished.");
    },
    fauxAssistantMessage("Follow-up finished."),
  ]);
  await reconnected.fill("#prompt", "Start a controlled run.");
  await reconnected.click("#send");
  await waitFor(async () => entered);
  await reconnected.waitForFunction(
    () => !document.querySelector<HTMLButtonElement>("#stop")?.disabled,
  );
  await reconnected.click("#input-toggle");
  await reconnected.selectOption("#mode", "steer");
  await reconnected.press("#mode", "Escape");
  await reconnected.fill("#prompt", "Withdraw this steering input.");
  await reconnected.click("#send");
  await reconnected.waitForFunction(() => document.querySelectorAll("#queue button").length === 1);
  await shot(reconnected, "mobile-working-queue");
  await reconnected.click("#queue button");
  await reconnected.waitForFunction(() => document.querySelector("#queue")?.hasAttribute("hidden"));
  await reconnected.click("#input-toggle");
  await reconnected.selectOption("#mode", "followUp");
  await reconnected.press("#mode", "Escape");
  await reconnected.fill("#prompt", "Follow up after the current run.");
  await reconnected.click("#send");
  await reconnected.waitForFunction(() => document.querySelectorAll("#queue button").length === 1);
  release();
  await branch.waitForIdle(context);
  await reconnected.waitForFunction(() => document.querySelector("#queue")?.hasAttribute("hidden"));
  const afterQueue = await session.history(branch);
  assert.equal(
    afterQueue.filter((entry) =>
      entry.model?.some(
        (message) => message.role === "user" && message.content === "Withdraw this steering input.",
      ),
    ).length,
    0,
  );
  assert.equal(
    afterQueue.filter((entry) =>
      entry.model?.some(
        (message) =>
          message.role === "user" && message.content === "Follow up after the current run.",
      ),
    ).length,
    1,
  );

  // Images are persisted as model input, not merely previewed in the browser.
  f.faux.setResponses([fauxAssistantMessage("The attached image is available.")]);
  await reconnected.locator("#images").setInputFiles(join(source, "icon-192.png"));
  await reconnected.waitForSelector("#attachments button");
  await reconnected.fill("#prompt", "Describe this image.");
  await shot(reconnected, "mobile-attachment");
  await reconnected.click("#send");
  await reconnected.waitForFunction(
    () => document.querySelectorAll("#attachments button").length === 0,
  );
  await branch.waitForIdle(context);
  assert(
    (await session.history(branch)).some((entry) =>
      entry.model?.some(
        (message) =>
          message.role === "user" &&
          Array.isArray(message.content) &&
          message.content.some((block) => block.type === "image"),
      ),
    ),
  );

  // Stop a real running tool; waiting for the live slot avoids timing assumptions.
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 60" }), { stopReason: "toolUse" }),
  ]);
  await reconnected.fill("#prompt", "Run a command so I can stop it.");
  await reconnected.click("#send");
  await reconnected.waitForFunction(() =>
    Array.from(document.querySelectorAll("article header")).some(
      (node) => node.textContent === "$ sleep 60 · running",
    ),
  );
  await reconnected.click("#stop");
  await reconnected.waitForFunction(
    () => document.querySelector<HTMLButtonElement>("#stop")?.disabled,
  );
  await branch.waitForIdle(context);

  // Context reset preserves history, and export returns the selected branch.
  await reconnected.click("#menu-toggle");
  await reconnected.click("#settings");
  reconnected.once("dialog", (dialog) => {
    void dialog.accept();
  });
  await reconnected.getByText("Context", { exact: true }).click();
  await reconnected.click("#reset");
  await reconnected.waitForFunction(
    () => !document.querySelector<HTMLDialogElement>("#preferences")?.open,
  );
  assert((await session.history(branch)).some((entry) => entry.kind === "pi.reset"));
  assert.equal((await branch.context(context)).messages.length, 0);
  await reconnected.waitForFunction(
    () => document.querySelector<HTMLElement>("#footer-context")?.dataset.tokens === "",
  );
  assert(Number(await reconnected.locator("#footer-input").getAttribute("data-value")) > 0);
  await shot(reconnected, "mobile-footer-reset");
  const download = reconnected.waitForEvent("download");
  await reconnected.click("#menu-toggle");
  await reconnected.click("#export");
  assert(await (await download).path());

  // Offline reload serves only the shell. It never replays writes or cached API data.
  await reconnected.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await reconnected.reload();
  await reconnected.waitForFunction(() => !!navigator.serviceWorker.controller);
  await browserContext.setOffline(true);
  await reconnected.reload();
  await reconnected.waitForSelector("#prompt");
  assert.equal(await reconnected.locator("#send").isDisabled(), true);
  await shot(reconnected, "mobile-offline");
  await browserContext.setOffline(false);
  await reconnected.waitForFunction(
    () => !document.querySelector<HTMLButtonElement>("#settings")?.disabled,
  );
  assert.equal(errors.length, 0);
  if (f.restart) {
    const started = Promise.withResolvers<void>();
    f.faux.setResponses([
      async (_messages, options) => {
        assert(options?.signal);
        started.resolve();
        await new Promise<void>((resolve) => {
          if (options.signal?.aborted) resolve();
          else options.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return fauxAssistantMessage("", { stopReason: "aborted" });
      },
    ]);
    await reconnected.fill("#prompt", "Interrupt this run with a server restart.");
    await reconnected.click("#send");
    await started.promise;
    const restoredSessions = await f.restart();
    const restored = await restoredSessions.get(id);
    assert.equal(restored.needsResume, true);
    assert.equal((await restored.info()).name, "Counter cleanup");
    const restoredBase = await serve(t, restoredSessions, assets);
    f.faux.setResponses([fauxAssistantMessage("Explicitly resumed after restart.")]);
    await reconnected.goto(`${restoredBase}/?session=${id}&conversation=${branchId}`);
    await reconnected.waitForSelector("#recovery", { state: "visible" });
    await shot(reconnected, "mobile-recovery");
    assert.equal(await reconnected.locator("#send").isDisabled(), true);
    assert.equal((await restored.harness.inspect(context)).scheduling, "paused");
    await reconnected.click("#resume");
    await reconnected.waitForSelector("#recovery", { state: "hidden" });
    await (await restored.conversation(branchId)).waitForIdle(context);
    assert.equal(restored.needsResume, false);
    assert.equal((await restored.harness.inspect(context)).tasks.length, 0);
  }
}
