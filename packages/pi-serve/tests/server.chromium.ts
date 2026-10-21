import { openCodingSessions } from "../../pi-runtime/coding.ts";
import * as runtime from "../../pi-runtime/index.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { UsageDoc } from "@earendil-works/pi-durable";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { chromium, type Page } from "playwright";
import { readHistory, fixture, model, waitFor } from "../../pi-runtime/testing.ts";
import { chromiumExecutable, directoryFixture, serve, snapshot } from "./testing.ts";
import {
  assertLayout,
  assertMessageTimestamps,
  browserFlow,
  browserFixture,
  openMessageActions,
} from "./browser-testing.ts";
import { GlobalSettingsStore } from "../server.ts";
import { benchmark, benchmarkFixture, benchmarkOptions } from "../benchmark.ts";
import { buildAssets } from "../build.ts";

const context = BACKGROUND_CONTEXT;

await test("landing lists the newest five sessions regardless of target availability", async (t) => {
  const f = await directoryFixture(t);
  const assets = join(f.workspace, "assets");
  await buildAssets(dirname(dirname(fileURLToPath(import.meta.url))), assets);
  const base = await serve(t, f.sessions, assets);
  const browser = await chromium.launch({ executablePath: chromiumExecutable() });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  await page.goto(base);
  await page.locator("#recent-empty:not([hidden])").waitFor();
  assert.equal(await page.locator("#recent-sessions button").count(), 0);
  assert.equal(await page.locator("#composer #create").isVisible(), true);
  assert.equal(await page.locator("#send").isVisible(), false);

  const ids: string[] = [];
  for (let index = 0; index < 7; index++) {
    const session = await f.sessions.create(randomUUID(), f.binding, model);
    await runtime.rename(session, `Session ${index}`);
    ids.unshift(session.id);
    if (index === 1) {
      await page.reload();
      await page.locator("#recent-sessions button").nth(1).waitFor();
      assert.equal(await page.locator("#recent-sessions button").count(), 2);
    }
  }
  f.stop();
  await page.reload();
  await page.locator("#recent-sessions button").nth(4).waitFor();
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.deepEqual(
      await page
        .locator("#recent-sessions button")
        .evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.session)),
      ids.slice(0, 5),
    );
    assert.equal(await page.locator("#recent-empty").isVisible(), false);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    assert.equal(await page.locator("#new-options-toggle").isVisible(), true);
    if (process.env.PI_SCREENSHOT_DIR) {
      await mkdir(process.env.PI_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.PI_SCREENSHOT_DIR, `landing-${width}.png`) });
    }
    await page.click("#title");
    await page.locator("#picker:not([hidden])").waitFor();
    assert.equal(await page.locator("#landing").isVisible(), false);
    assert.equal(await page.locator("#sessions button").count(), 7);
    await page.fill("#session-filter", "Session 0");
    assert.equal(await page.locator("#sessions button").count(), 1);
    await page.click("#close-view");
    assert.equal(await page.locator("#recent-sessions button").count(), 5);
    await page.click("#recent-sessions button:first-child");
    await page.waitForFunction(
      (id) => new URL(location.href).searchParams.get("session") === id,
      ids[0],
    );
    assert.equal(await page.locator("#landing").isVisible(), false);
    await page.reload();
    await page.locator("#status[data-state=ready]").waitFor();
    assert.equal(await page.locator("#landing").isVisible(), false);
    await page.goto(base);
    await page.locator("#recent-sessions button").nth(4).waitFor();
  }
  await page.route("**/api/catalog", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Unavailable" }),
    }),
  );
  await page.reload();
  await page.locator("#notice:not([hidden])").waitFor();
  assert.equal(await page.locator("#recent-empty").isVisible(), false);
  assert.equal(await page.locator("#create").isDisabled(), true);
  assert.deepEqual(errors, []);
});

await test("mobile browser renderer benchmark returns complete JSON-compatible samples", async () => {
  const report = await benchmark(benchmarkOptions(["--runs", "2", "--turns", "2"]));
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.benchmark, "pi-serve.render");
  assert.equal(report.measurement.profiling, false);
  assert.equal(report.measurement.freshBrowserPerRun, true);
  assert.equal(report.workload.entries, 6);
  assert.equal(report.environment.cpuRate, 1);
  assert.equal(report.source.clientSha256.length, 64);
  assert.equal(report.runs.length, 2);
  assert.equal(report.profile, null);
  for (const run of report.runs) {
    assert(run.initialDomElements > 0);
    assert.equal(run.streamingMs.length, report.workload.streamUpdates);
    assert.equal(run.transitionsMs.length, report.workload.transitions);
    for (const value of [run.initialMs, run.startMs, ...run.streamingMs, ...run.transitionsMs])
      assert(Number.isFinite(value) && value >= 0);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
});

await test("mobile browser renderer profiling saves separate per-phase CPU and timeline data", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-serve-profile-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const report = await benchmark(
    benchmarkOptions(["--runs", "1", "--turns", "2", "--profile", "--profile-dir", directory]),
  );
  assert.equal(report.runs.length, 1);
  assert.equal(report.runs[0].streamingMs.length, 40);
  assert.equal(report.runs[0].transitionsMs.length, 10);
  assert.equal(report.measurement.profiling, false);
  assert(report.profile);
  assert.equal(report.profile.separateRun, true);
  assert.equal(report.profile.timingsIncludedInRuns, false);
  assert.equal(report.profile.includesPaint, true);
  assert.equal(report.profile.samplingIntervalUs, 1000);
  assert.deepEqual(
    report.profile.artifacts.map((artifact) => artifact.phase),
    ["initial", "streaming", "transitions"],
  );
  for (const artifact of report.profile.artifacts) {
    assert.equal(artifact.traceDataLoss, false);
    const cpu: {
      nodes: { id: number }[];
      samples: number[];
      timeDeltas: number[];
      startTime: number;
      endTime: number;
    } = JSON.parse(await readFile(artifact.cpuProfile, "utf8"));
    assert(cpu.endTime > cpu.startTime);
    assert(cpu.samples.length > 0);
    assert.equal(cpu.timeDeltas.length, cpu.samples.length);
    const ids = new Set(cpu.nodes.map((node) => node.id));
    assert(cpu.samples.every((id) => ids.has(id)));
    const trace: { traceEvents: { name: string }[] } = JSON.parse(
      await readFile(artifact.trace, "utf8"),
    );
    const events = new Set(trace.traceEvents.map((event) => event.name));
    assert(events.has(`pi-bench:${artifact.phase}:start`));
    assert(events.has(`pi-bench:${artifact.phase}:end`));
    if (artifact.phase === "initial") {
      assert(events.has("Layout"));
      assert(events.has("Paint"));
      assert(events.has("StyleRecalcInvalidationTracking"));
    }
  }
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
});

async function assertHeaderStatus(page: Page, state: string, label: string): Promise<void> {
  const dot = page.locator(".bar #status");
  assert.equal(await dot.getAttribute("data-state"), state);
  assert.equal(await dot.getAttribute("title"), label);
  assert.equal(await dot.locator(".sr-only").textContent(), label);
  const style = await dot.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const css = getComputedStyle(node);
    return {
      width: box.width,
      height: box.height,
      radius: css.borderRadius,
      color: css.backgroundColor,
    };
  });
  assert.equal(style.width, (await dot.isVisible()) ? 8 : 0);
  assert.equal(style.height, (await dot.isVisible()) ? 8 : 0);
  assert.equal(style.radius, "50%");
  const colors: Record<string, string> = {
    ready: "rgb(175, 214, 188)",
    working: "rgb(162, 201, 223)",
    offline: "rgb(255, 173, 173)",
  };
  if (colors[state]) assert.equal(style.color, colors[state]);
  assert.equal(
    await page.locator("#conversation-menu #status, #app-menu p, #context-view p").count(),
    0,
  );
}

await test("mobile browser integrates local tools, settings, branches, recovery and offline reload", async (t) => {
  const f = await fixture(t);
  const { assets, source, base, browser, browserContext, reconnected, session, id, url, errors } =
    await browserFlow(t, f);
  await browserContext.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  // Keep a real streamed-tool identity check alongside the fixture update checks.
  const firstCall = reconnected.locator(".tool-call").first();
  // Completed tool subtrees must survive unrelated runs, not merely look the
  // same after being rebuilt (which loses selection and repeats highlighting).
  const historicalTool = await firstCall.elementHandle();
  const historicalOutput = await firstCall.locator(".tool-result").elementHandle();
  assert(historicalTool);
  assert(historicalOutput);

  // A real repository in the bound workspace, created through the scripted agent.
  f.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("bash", {
        command:
          "git init --initial-branch=pi-pwa && git -c user.name=Pi -c user.email=pi@example.invalid commit --no-gpg-sign --allow-empty -m Initial",
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Repository ready."),
  ]);
  await reconnected.fill("#prompt", "Initialize the workspace repository.");
  await reconnected.click("#send");
  await session.root.waitForIdle(context);
  assert.equal(await historicalTool.evaluate((node) => node.isConnected), true);
  assert.equal(await historicalOutput.evaluate((node) => node.isConnected), true);

  // Real edit tool details carry a unified patch independently of assistant prose.
  f.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("edit", { path: "browser.json", oldText: "31", newText: "32" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Updated the stored value."),
  ]);
  await reconnected.fill("#prompt", "Update the stored value.");
  await reconnected.click("#send");
  await reconnected.waitForFunction(() => !!document.querySelector(".tool-result .hljs-addition"));
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
  await reconnected.click("#footer-model");
  await reconnected.selectOption("#thinking", "high");
  await reconnected.fill("#session-name", "Counter cleanup");
  await reconnected.fill("#instructions", "Keep changes small and verify them.");
  await reconnected.click("#close-view");
  await reconnected.waitForFunction(
    () => document.querySelector<HTMLElement>("#preferences")?.hidden,
  );
  assert.equal((await session.root.agent(context)).thinkingLevel, "high");
  assert.equal((await runtime.sessionInfo(session)).name, "Counter cleanup");

  const ledger = await session.harness.snapshot(UsageDoc, session.root.id, context);
  assert(ledger);
  const buckets = [...Object.values(ledger.models), ...Object.values(ledger.tools)];
  const expectedInput = buckets.reduce((sum, usage) => sum + usage.input, 0);
  const expectedOutput = buckets.reduce((sum, usage) => sum + usage.output, 0);
  const expectedRead = buckets.reduce((sum, usage) => sum + usage.cacheRead, 0);
  const expectedContext = (await snapshot(`${base}/api/harness/${id}/watch`)).context;
  const gallery = async (page: Page, size: string) => {
    await assertHeaderStatus(page, "ready", "Ready");
    assert.equal(await page.locator(".bar button:visible").count(), 2);
    assert.equal(await page.locator("#menu-toggle svg").isVisible(), true);
    assert.equal(await page.locator("#title").textContent(), "Counter cleanup");
    assert.equal(await page.locator("#menu-toggle").getAttribute("aria-label"), "Global settings");
    const originalTitle = await page.locator("#title").textContent();
    await page.locator("#title").evaluate((node) => {
      node.textContent = "Very long session name ".repeat(30);
    });
    const layout = await page.locator(".bar").evaluate((bar) => {
      const title = bar.querySelector("#title")!.getBoundingClientRect();
      const menu = bar.querySelector("#menu-toggle")!.getBoundingClientRect();
      const bounds = bar.getBoundingClientRect();
      return {
        left: title.left - bounds.left,
        right: bounds.right - menu.right,
        overlap: title.right > menu.left,
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    assert(layout.left <= 16 && layout.right <= 16);
    assert.equal(layout.overlap, false);
    assert.equal(layout.overflow, false);
    await assertHeaderStatus(page, "ready", "Ready");
    await assertLayout(page, `${size}-header-long-name`);
    await page.locator("#title").evaluate((node, name) => {
      node.textContent = name;
    }, originalTitle);
    await page.click("#title");
    await page.waitForSelector("#picker:not([hidden])");
    assert.equal(await page.locator("#title").isVisible(), false);
    assert.equal(await page.locator("#menu-toggle").isVisible(), false);
    await assertLayout(page, `${size}-sessions`);
    await page.click("#close-view");
    await page.click("#menu-toggle");
    await page.waitForSelector("#global-preferences:not([hidden])");
    assert.equal(await page.locator("#wrap-code").isVisible(), true);
    await page.keyboard.press("Escape");

    await page.locator("#transcript").evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await assertLayout(page, `${size}-conversation`);
    for (const tool of ["bash", "edit"]) {
      const call = page.locator(`.tool-call[data-tool="${tool}"]`).last();
      await call.evaluate((node) => {
        (node as HTMLDetailsElement).open = false;
      });
      await call.scrollIntoViewIfNeeded();
      await assertLayout(page, `${size}-collapsed-${tool}`);
      await call.evaluate((node) => {
        (node as HTMLDetailsElement).open = true;
      });
      await call.scrollIntoViewIfNeeded();
      await assertLayout(page, `${size}-unified-${tool}`);
      await call.evaluate((node) => {
        (node as HTMLDetailsElement).open = false;
      });
    }

    for (const [field, expected] of [
      ["input", expectedInput],
      ["output", expectedOutput],
      ["read", expectedRead],
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
    assert.equal(await page.locator("#footer-model-name").isVisible(), true);
    assert.equal(await page.locator("#footer-effort").textContent(), "high");
    assert.deepEqual(
      await page
        .locator("#footer-stats > span")
        .evaluateAll((nodes) => nodes.map((node) => node.id)),
      ["footer-input", "footer-output", "footer-read", "footer-hit", "footer-cost"],
    );
    assert.deepEqual(
      await page
        .locator("#bottom-line button")
        .evaluateAll((nodes) =>
          nodes.filter((node) => node.checkVisibility()).map((node) => node.id),
        ),
      size === "desktop"
        ? ["footer-stats", "footer-model", "footer-context"]
        : ["footer-model", "footer-context"],
    );
    await page.click(size === "desktop" ? "#footer-stats" : "#footer-context");
    await page.waitForSelector("#context-view:not([hidden])");
    assert.equal(await page.locator("#view-title").textContent(), "Context");
    const inspection = (await snapshot(`${base}/api/harness/${id}/watch`)).inspection;
    assert(inspection.state === "available");
    assert.equal(
      Number(await page.locator("#context-view").getAttribute("data-tokens")),
      inspection.tokens,
    );
    await assertLayout(page, `${size}-footer-breakdown`);
    await page.keyboard.press("Escape");
    await page.click("#footer-model");
    await page.waitForSelector("#preferences:not([hidden])");
    assert.equal(await page.locator("#thinking").inputValue(), "high");
    assert.equal(
      await page.locator("#footer-model").getAttribute("title"),
      "faux / faux-1 · thinking high",
    );
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#stop").isVisible(), false);
    assert.equal(await page.locator("#input-mode").isVisible(), false);
    assert.equal(await page.locator("#send").getAttribute("aria-label"), "Send");
    assert.equal(await page.locator("#send [aria-hidden=true]").textContent(), "↑");
    assert.equal(await page.locator("#stop [aria-hidden=true]").textContent(), "×");
    assert.equal(await page.locator('label[for="prompt"]').count(), 0);
    await page.click("#menu-toggle");
    await page.selectOption("#wrap-code", "true");
    await assertLayout(page, `${size}-global`);
    assert.equal(
      await page.locator("body").evaluate((node) => node.classList.contains("wrap-code")),
      true,
    );
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+f");
    await page.fill("#search", "counter");
    assert.equal(await page.locator("#search-count").textContent(), "1 / 2");
    assert(await page.evaluate(() => (CSS.highlights.get("pi-search")?.size ?? 0) > 0));
    assert.equal(await page.locator("article.search-hit, article.search-current").count(), 0);
    await page.keyboard.press("Control+j");
    assert.equal(await page.locator("#search-count").textContent(), "2 / 2");
    await page.keyboard.press("Control+k");
    assert.equal(await page.locator("#search-count").textContent(), "1 / 2");
    assert.equal(await page.locator("#picker").isVisible(), false);
    await page.click("#search-next");
    assert.equal(await page.locator("#search-count").textContent(), "2 / 2");
    await assertLayout(page, `${size}-search`);
    await page.fill("#search", "Successfully");
    assert.equal(await page.locator("#search-count").textContent(), "1 / 2");
    assert((await page.locator("#transcript details[open]").count()) > 0);
    await assertLayout(page, `${size}-tool-search`);
    await page.fill("#search", "[");
    assert.equal(await page.locator("#notice").isVisible(), false);
    await page.fill("#search", "missing-word-abcdef");
    assert.equal(await page.locator("article.search-hit").count(), 0);
    assert.equal(await page.locator("#search-next").isDisabled(), true);
    await page.press("#search", "Escape");
    assert.equal(await page.locator("#search-bar").isVisible(), false);
    await openMessageActions(page, page.locator("article .message-actions").last());
    await assertLayout(page, `${size}-message-menu`);
    await page.click("#quote-message");
    assert.equal(
      await page.locator("#prompt").evaluate((node) => document.activeElement === node),
      false,
    );
    assert.equal(
      (await page.locator("#prompt").inputValue()).startsWith("> Updated the counter."),
      true,
    );
    await assertLayout(page, `${size}-quote`);
    await page.fill("#prompt", "");
    await page.click("#input-toggle");
    assert.equal(await page.locator("#input-menu select").count(), 0);
    assert.equal(await page.locator("#input-menu > button").count(), 1);
    await assertLayout(page, `${size}-input-menu`);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+k");
    await page.waitForSelector("#picker:not([hidden])");
    await page.focus("#close-view");
    await page.keyboard.press("/");
    assert.equal(
      await page.locator("#session-filter").evaluate((node) => node === document.activeElement),
      true,
    );
    await page.fill("#session-filter", "Counter cleanup");
    await page.keyboard.press("Control+j");
    assert.equal(
      await page.locator("#sessions button").evaluate((node) => node === document.activeElement),
      true,
    );
    await page.keyboard.press("Control+k");
    assert.equal(
      await page.locator("#sessions button").evaluate((node) => node === document.activeElement),
      true,
    );
    assert.equal(await page.locator("#sessions button").count(), 1);
    if (size === "mobile")
      assert.equal(
        await page
          .locator("#picker")
          .evaluate((node) => Math.round(node.getBoundingClientRect().width)),
        390,
      );
    await assertLayout(page, `${size}-sessions`);
    await page.fill("#session-filter", "not-a-session");
    assert.equal(await page.locator("#sessions button").count(), 0);
    assert.equal(await page.locator("#sessions-empty").isVisible(), true);
    await page.fill("#session-filter", "");
    await page.keyboard.press("Escape");
    await page.click("#footer-model");
    assert.equal(await page.locator("#session-name").inputValue(), "Counter cleanup");
    if (size === "mobile")
      assert.equal(
        await page
          .locator("#preferences")
          .evaluate((node) => Math.round(node.getBoundingClientRect().width)),
        390,
      );
    await assertLayout(page, `${size}-settings`);
    await page.keyboard.press("Escape");
    // Persisted presentation preference and name survive a page reload.
    await page.reload();
    await page.waitForSelector('article[data-role="assistant"] .text .hljs-addition');
    assert.equal(
      await page.locator("body").evaluate((node) => node.classList.contains("wrap-code")),
      true,
    );
    await page.click("#menu-toggle");
    await page.selectOption("#wrap-code", "false");
    await page.keyboard.press("Escape");
    await page.locator("#transcript").evaluate((node) => {
      node.scrollTop = 0;
    });
    await page.waitForSelector("#latest", { state: "visible" });
    await assertLayout(page, `${size}-history`);
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
  const desktopActions = desktopPage
    .locator('article[data-role="user"] > header > .message-actions')
    .last();
  await desktopPage.mouse.move(0, 0);
  assert.equal(await desktopActions.evaluate((node) => getComputedStyle(node).opacity), "0");
  await desktopActions.focus();
  assert.equal(await desktopActions.evaluate((node) => getComputedStyle(node).opacity), "1");
  await desktopActions.press("Enter");
  assert.equal(await desktopPage.locator("#message-menu").isVisible(), true);
  await desktopPage.keyboard.press("Escape");
  await desktopPage.locator("#prompt").focus();
  await desktopActions.hover();
  assert.equal(await desktopActions.evaluate((node) => getComputedStyle(node).opacity), "1");
  await desktopPage.mouse.move(0, 0);
  assert.equal(await desktopActions.evaluate((node) => getComputedStyle(node).opacity), "0");
  await gallery(desktopPage, "desktop");
  await desktop.setOffline(true);
  await desktopPage.waitForFunction(
    () => document.querySelector<HTMLElement>("#bottom-line")?.dataset.connected === "false",
  );
  await desktopPage.click("#footer-stats");
  await assertHeaderStatus(desktopPage, "offline", "Offline");
  assert.equal(
    Number(await desktopPage.locator("#footer-input").getAttribute("data-value")),
    expectedInput,
  );
  await assertLayout(desktopPage, "desktop-footer-offline");
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
  await assertLayout(desktopPage, "desktop-footer-high-usage");
  await reconnected.waitForFunction(
    () => Number(document.querySelector<HTMLElement>("#footer-input")?.dataset.value) > 15_000_000,
  );
  await reconnected.setViewportSize({ width: 320, height: 640 });
  await assertLayout(reconnected, "mobile-footer-high-usage");
  await reconnected.click("#footer-context");
  await assertLayout(reconnected, "mobile-footer-high-usage-breakdown");
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
  await openMessageActions(
    desktopPage,
    desktopPage.locator('article[data-role="user"] .message-actions').last(),
  );
  await desktopPage.click("#copy-message");
  assert.equal(
    await desktopPage.evaluate(() => navigator.clipboard.readText()),
    "Fix the counter and show me the change.",
  );
  await desktopPage.keyboard.press("Control+k");
  assert.equal(await desktopPage.locator("#picker").isVisible(), true);
  await desktopPage.keyboard.press("Escape");
  await desktopPage.keyboard.press("Control+f");
  assert.equal(
    await desktopPage.locator("#search").evaluate((node) => document.activeElement === node),
    false,
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
    await assertLayout(reconnected, `touch-focused-${viewport.width}`);
    await reconnected.fill("#prompt", "");
  }
  await reconnected.setViewportSize({ width: 320, height: 640 });
  await reconnected.locator("#transcript").evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await assertLayout(reconnected, "mobile-narrow");
  // Keep effort and context readable when only the model name needs truncation.
  const modelLabel = reconnected.locator("#footer-model-name");
  const modelName = await modelLabel.textContent();
  await modelLabel.evaluate((node) => {
    node.textContent = "provider/very-long-model-name-with-version-20261017";
  });
  assert.equal(await modelLabel.evaluate((node) => node.scrollWidth > node.clientWidth), true);
  for (const id of ["footer-effort", "footer-context"])
    assert.equal(
      await reconnected.locator(`#${id}`).evaluate((node) => node.scrollWidth <= node.clientWidth),
      true,
    );
  await assertLayout(reconnected, "mobile-narrow-long-model");
  await modelLabel.evaluate((node, text) => {
    node.textContent = text;
  }, modelName);
  await reconnected.click("#menu-toggle");
  await assertLayout(reconnected, "mobile-narrow-menu");
  await reconnected.keyboard.press("Escape");
  await reconnected.setViewportSize({ width: 768, height: 1024 });
  await assertLayout(reconnected, "tablet");
  await reconnected.setViewportSize({ width: 390, height: 844 });

  // Fork history is isolated and survives a browser reload.
  const originalEntries = await readHistory(session.root);
  await openMessageActions(reconnected, reconnected.locator("article .message-actions").last());
  await reconnected.click("#fork-message");
  await reconnected.waitForFunction(() => new URL(location.href).searchParams.has("conversation"));
  const branchId = Number(new URL(reconnected.url()).searchParams.get("conversation"));
  const branch = await runtime.getConversation(session, branchId);
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
  assert.equal((await readHistory(session.root)).length, originalEntries.length);
  await reconnected.fill("#prompt", "Unsent branch draft");
  await reconnected.reload();
  await reconnected.waitForFunction(
    () => document.querySelector<HTMLTextAreaElement>("#prompt")?.value === "Unsent branch draft",
  );
  await reconnected.fill("#prompt", "/fork");
  await reconnected.press("#prompt", "Control+Enter");
  await reconnected.waitForSelector("#branches button");
  assert.equal(await reconnected.locator("#branches button").count(), 2);
  await reconnected.keyboard.press("Control+j");
  assert.equal(
    await reconnected
      .locator("#branches button")
      .first()
      .evaluate((node) => node === document.activeElement),
    true,
  );
  await reconnected.keyboard.press("Control+k");
  await reconnected.keyboard.press("Enter");
  await reconnected.waitForSelector("#title", { state: "visible" });
  assert.equal(Number(new URL(reconnected.url()).searchParams.get("conversation")), branchId);
  await reconnected.click("#footer-model");
  await reconnected.fill("#instructions", "Branch-only instructions.");
  await reconnected.click("#close-view");
  await reconnected.waitForSelector("#preferences", { state: "hidden" });
  assert.equal((await branch.agent(context)).instructions, "Branch-only instructions.");
  assert.equal(
    (await session.root.agent(context)).instructions,
    "Keep changes small and verify them.",
  );

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
  await assertHeaderStatus(reconnected, "working", "Working");
  assert.equal(await reconnected.locator("#input-mode").getAttribute("data-mode"), "followUp");
  await reconnected.click("#input-mode");
  assert.equal(await reconnected.locator("#input-mode").getAttribute("data-mode"), "steer");
  assert.equal(
    await reconnected.locator("#input-menu").evaluate((node) => node.matches(":popover-open")),
    false,
  );
  assert.equal(await reconnected.locator("#send").getAttribute("aria-label"), "Steer");
  await reconnected.fill("#prompt", "Withdraw this steering input.");
  await reconnected.click("#send");
  await reconnected.waitForFunction(() => document.querySelectorAll("#queue button").length === 1);
  await assertLayout(reconnected, "mobile-working-queue");
  for (const width of [320, 768, 1440]) {
    await reconnected.setViewportSize({ width, height: 900 });
    await assertLayout(reconnected, `working-buttons-${width}`);
  }
  await reconnected.setViewportSize({ width: 390, height: 844 });
  await reconnected.getByRole("button", { name: "Cancel queued message", exact: true }).click();
  await reconnected.waitForFunction(() => document.querySelector("#queue")?.hasAttribute("hidden"));
  await reconnected.click("#input-mode");
  assert.equal(await reconnected.locator("#input-mode").getAttribute("data-mode"), "followUp");
  assert.equal(await reconnected.locator("#send").getAttribute("aria-label"), "Queue");
  await assertLayout(reconnected, "mobile-follow-up-buttons");
  await reconnected.fill("#prompt", "Follow up after the current run.");
  await reconnected.click("#send");
  await reconnected.waitForFunction(() => document.querySelectorAll("#queue button").length === 1);
  release();
  await branch.waitForIdle(context);
  await reconnected.waitForFunction(() => document.querySelector("#queue")?.hasAttribute("hidden"));
  const afterQueue = await readHistory(branch);
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
  const chooserPromise = reconnected.waitForEvent("filechooser");
  await reconnected.click("#input-toggle");
  const chooser = await chooserPromise;
  assert.equal(await reconnected.locator("#input-menu").isVisible(), false);
  assert.equal(chooser.isMultiple(), true);
  await chooser.setFiles(join(source, "icon-192.png"));
  await reconnected.waitForSelector("#attachments button");
  await reconnected.locator("#attachments button").click();
  await reconnected.fill("#prompt", "Describe this image.");
  const pastedImage = await readFile(join(source, "icon-192.png"));
  assert.equal(
    await reconnected.locator("#prompt").evaluate((input, bytes) => {
      const clipboardData = new DataTransfer();
      clipboardData.items.add(
        new File([new Uint8Array(bytes)], "pasted.png", { type: "image/png" }),
      );
      return input.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
      );
    }, Array.from(pastedImage)),
    false,
  );
  await reconnected.waitForSelector("#attachments button");
  assert.equal(await reconnected.locator("#prompt").inputValue(), "Describe this image.");
  assert.equal(
    await reconnected.locator("#prompt").evaluate((input) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", "ordinary text");
      return input.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
      );
    }),
    true,
  );
  await assertLayout(reconnected, "mobile-attachment");
  await reconnected.click("#send");
  await reconnected.waitForFunction(
    () => document.querySelectorAll("#attachments button").length === 0,
  );
  await branch.waitForIdle(context);
  assert(
    (await readHistory(branch)).some((entry) =>
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
  await reconnected.waitForFunction(
    () => !!document.querySelector('.tool-call[data-state="running"]'),
  );
  const running = reconnected.locator('.tool-call[data-state="running"]');
  assert.equal(await running.count(), 1);
  const runningStatus = running.locator(":scope > summary > .tool-status");
  assert.equal(await runningStatus.textContent(), "");
  assert.equal(await runningStatus.getAttribute("aria-label"), "running");
  assert.equal(await runningStatus.getAttribute("title"), "running");
  assert.equal(await runningStatus.locator("span").count(), 4);
  assert.deepEqual(
    await runningStatus.evaluate((node) => {
      const style = getComputedStyle(node);
      return [style.gridTemplateColumns, style.gridTemplateRows, style.color];
    }),
    ["2px 2px", "2px 2px", "rgb(175, 214, 188)"],
  );
  assert.equal(
    await runningStatus
      .locator("span")
      .first()
      .evaluate((node) => getComputedStyle(node).animationName),
    "tool-spinner",
  );
  await reconnected.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(
    await runningStatus
      .locator("span")
      .first()
      .evaluate((node) => getComputedStyle(node).animationName),
    "none",
  );
  await reconnected.emulateMedia({ reducedMotion: "no-preference" });
  await running.locator(":scope > summary").click();
  const runningId = await running.getAttribute("data-call-id");
  await reconnected.click("#stop");
  await reconnected.waitForFunction(
    () => document.querySelector<HTMLButtonElement>("#stop")?.disabled,
  );
  await branch.waitForIdle(context);
  await reconnected.waitForFunction((id) => {
    const call = Array.from(document.querySelectorAll<HTMLElement>(".tool-call")).find(
      (node) => node.dataset.callId === id,
    );
    return !!call?.querySelector(".tool-result");
  }, runningId);
  assert.equal(await reconnected.locator(`.tool-call[data-call-id="${runningId}"]`).count(), 1);
  assert.equal(
    await reconnected
      .locator(`.tool-call[data-call-id="${runningId}"]`)
      .evaluate((node) => node.hasAttribute("open")),
    true,
  );

  // Context commands retain their behavior, without settings buttons.
  reconnected.once("dialog", (dialog) => {
    void dialog.accept();
  });
  await reconnected.fill("#prompt", "/reset");
  await reconnected.press("#prompt", "Control+Enter");
  await reconnected.waitForFunction(
    () => document.querySelector<HTMLTextAreaElement>("#prompt")?.value === "",
  );
  assert((await readHistory(branch)).some((entry) => entry.kind === "pi.reset"));
  assert.equal((await branch.context(context)).messages.length, 0);
  await reconnected.waitForFunction(
    () => document.querySelector<HTMLElement>("#footer-context")?.dataset.tokens === "",
  );
  assert(Number(await reconnected.locator("#footer-input").getAttribute("data-value")) > 0);
  await assertLayout(reconnected, "mobile-footer-reset");
  const download = reconnected.waitForEvent("download");
  await reconnected.fill("#prompt", "/export");
  await reconnected.press("#prompt", "Control+Enter");
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
  await assertLayout(reconnected, "mobile-offline");
  await browserContext.setOffline(false);
  await reconnected.waitForFunction(
    () => !document.querySelector<HTMLButtonElement>("#footer-model")?.disabled,
  );
  assert.deepEqual([...errors], []);
  // Real codemode: the faux provider selects the tool, but QuickJS, nested
  // coding tools, Durable storage, SSE and both browser layouts are production.
  const codeFile = "codemode.json";
  const releaseFile = join(f.workspace, "codemode-release");
  const desktopCodeContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const desktopCode = await desktopCodeContext.newPage();
  desktopCode.on("pageerror", (error) => errors.push(error));
  await desktopCode.goto(reconnected.url());
  f.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall(
        "codemode",
        {
          code: `
      await tools.write({ path: ${JSON.stringify(codeFile)}, content: '{"value":1}' });
      await tools.edit({ path: ${JSON.stringify(codeFile)}, edits: [{ oldText: "1", newText: "2" }] });
      await Promise.all([
        tools.read({ path: ${JSON.stringify(codeFile)} }),
        tools.bash({ command: ${JSON.stringify(`while [ ! -f ${JSON.stringify(releaseFile)} ]; do sleep 0.05; done`)} }),
      ]);
      return { updated: true, value: 2 };
    `,
        },
        { id: "real-codemode" },
      ),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Codemode updated and read the file, then finished the shell command."),
  ]);
  await reconnected.fill(
    "#prompt",
    "Use codemode to write, edit and read a file, and run a shell command.",
  );
  await reconnected.click("#send");
  try {
    for (const [page, size] of [
      [desktopCode, "desktop"],
      [reconnected, "mobile"],
    ] as const) {
      await page.waitForSelector(
        '.tool-call[data-call-id="real-codemode"] .tool-call[data-tool="bash"][data-state="running"]',
        { state: "attached" },
      );
      const call = page.locator('.tool-call[data-call-id="real-codemode"]');
      assert.equal(await call.count(), 1);
      await call.evaluate((node) => {
        (node as HTMLDetailsElement).open = true;
      });
      // Finished nested tools already have timing, even while their parent runs.
      await page.waitForSelector(
        '.tool-call[data-call-id="real-codemode"] .tool-call[data-tool="write"] > summary > .tool-duration',
        { state: "attached" },
      );
      assert.equal(await call.locator(":scope > summary > .tool-duration").count(), 0);
      assert.equal(
        await call.locator('.tool-call[data-state="running"] > summary > .tool-duration').count(),
        0,
      );
      await call.scrollIntoViewIfNeeded();
      await assertLayout(page, `${size}-codemode-running`);
    }
  } finally {
    await writeFile(releaseFile, "release");
  }
  await branch.waitForIdle(context);
  assert.deepEqual(JSON.parse(await readFile(join(f.workspace, "codemode.json"), "utf8")), {
    value: 2,
  });
  const codeResult = (await readHistory(branch))
    .flatMap((entry) => entry.model ?? [])
    .find((message) => message.role === "toolResult" && message.toolCallId === "real-codemode");
  assert(codeResult?.role === "toolResult");
  assert.equal(codeResult.isError, false);
  for (const [page, size] of [
    [desktopCode, "desktop"],
    [reconnected, "mobile"],
  ] as const) {
    await page.reload();
    await page.waitForSelector('.tool-call[data-call-id="real-codemode"][data-state="completed"]', {
      state: "attached",
    });
    const call = page.locator('.tool-call[data-call-id="real-codemode"]');
    assert.equal(await call.count(), 1);
    assert.equal(await call.locator(".nested-tools > details").count(), 5); // four calls plus raw metadata
    await call.evaluate((node) => {
      (node as HTMLDetailsElement).open = true;
      node.querySelector<HTMLDetailsElement>(".nested-tools")!.open = true;
    });
    await assertMessageTimestamps(page);
    assert.equal(await call.locator(".tool-duration").count(), 5);
    assert.deepEqual(
      await call
        .locator(".tool-call")
        .evaluateAll((nodes) => [
          ...new Set(nodes.map((node) => getComputedStyle(node).borderLeftWidth)),
        ]),
      ["0px"],
    );
    assert.equal(
      await call.locator(":scope > summary > .tool-duration").getAttribute("title"),
      `Duration: ${codeResult.durationMs}ms`,
    );
    // Timing stays at the right edge without overlapping long or expanded commands.
    for (const open of [false, true]) {
      await call.locator(".nested-tools > .tool-call").evaluateAll((nodes, expanded) => {
        for (const node of nodes) (node as HTMLDetailsElement).open = expanded;
      }, open);
      const positions = await call.locator(".tool-duration").evaluateAll((nodes) =>
        nodes.map((node) => ({
          right: node.getBoundingClientRect().right,
          edge: node.parentElement!.getBoundingClientRect().right,
          left: node.getBoundingClientRect().left,
          commandRight: node.parentElement!.querySelector(".tool-command")!.getBoundingClientRect()
            .right,
        })),
      );
      for (const position of positions) {
        assert(Math.abs(position.right - position.edge) < 1);
        assert(position.left - position.commandRight >= 7);
      }
    }
    await call.locator(".nested-tools > .tool-call").evaluateAll((nodes) => {
      for (const node of nodes) (node as HTMLDetailsElement).open = false;
    });
    await call.scrollIntoViewIfNeeded();
    await assertLayout(page, `${size}-codemode-completed`);
  }
  f.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall(
        "codemode",
        {
          code: `await tools.read({ path: ${JSON.stringify(join(f.workspace, "missing-codemode-file"))} });`,
        },
        { id: "failed-codemode" },
      ),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("The nested read failed."),
  ]);
  await reconnected.fill("#prompt", "Exercise a nested codemode error.");
  await reconnected.click("#send");
  for (const [page, size] of [
    [desktopCode, "desktop"],
    [reconnected, "mobile"],
  ] as const) {
    await page.waitForSelector('.tool-call[data-call-id="failed-codemode"][data-state="failed"]', {
      state: "attached",
    });
    const call = page.locator('.tool-call[data-call-id="failed-codemode"]');
    assert.equal(await call.locator(".nested-tools .error").count(), 1);
    assert.equal(await call.locator(".tool-duration").count(), 2);
    await call.evaluate((node) => {
      (node as HTMLDetailsElement).open = true;
      node.querySelector<HTMLDetailsElement>(".nested-tools")!.open = true;
    });
    await call.scrollIntoViewIfNeeded();
    await assertLayout(page, `${size}-codemode-error`);
  }
  await branch.waitForIdle(context);
  await desktopCodeContext.close();

  assert.equal(errors.length, 0);
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
  await f.reopen();
  const restoredSessions = f.sessions;
  const restored = await restoredSessions.get(id);
  assert.equal((await runtime.sessionInfo(restored)).needsResume, true);
  assert.equal((await runtime.sessionInfo(restored)).name, "Counter cleanup");
  const restoredBase = await serve(t, restoredSessions, assets);
  f.faux.setResponses([fauxAssistantMessage("Explicitly resumed after restart.")]);
  await reconnected.goto(`${restoredBase}/?session=${id}&conversation=${branchId}`);
  await reconnected.waitForSelector("#recovery", { state: "visible" });
  await assertLayout(reconnected, "mobile-recovery");
  await reconnected.fill("#prompt", "A new submission may also enable progress.");
  assert.equal(await reconnected.locator("#send").isDisabled(), false);
  await reconnected.fill("#prompt", "");
  assert.equal((await restored.harness.inspect(context)).scheduling, "paused");
  await reconnected.click("#resume");
  await reconnected.waitForSelector("#recovery", { state: "hidden" });
  await (await runtime.getConversation(restored, branchId)).waitForIdle(context);
  assert.equal((await runtime.sessionInfo(restored)).needsResume, false);
  assert.equal((await restored.harness.inspect(context)).tasks.length, 0);
});

await test("mobile browser edits shared defaults and keeps session settings independent", async (t) => {
  const f = await fixture(t);
  await f.sessions.close();
  const plain = fauxProvider({ provider: "plain", models: [{ id: "plain", reasoning: false }] });
  f.options.models.setProvider(plain.provider);
  const store = new GlobalSettingsStore(
    SettingsManager.inMemory({
      defaultProvider: model.provider,
      defaultModel: model.modelId,
    }),
  );
  const sessions = await openCodingSessions(store.bind(f.options));
  t.after(() => sessions.close());
  const assets = join(f.workspace, "assets");
  await buildAssets(dirname(dirname(fileURLToPath(import.meta.url))), assets);
  const base = await serve(t, sessions, assets, "127.0.0.1", undefined, store);
  const browser = await chromium.launch({
    executablePath: chromiumExecutable(),
  });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  await page.goto(base);
  await page.click("#title");
  await page.waitForSelector("#picker:not([hidden])");
  await page.click("#new-options-toggle");
  assert.equal(await page.locator("#models").inputValue(), "0");
  assert.equal(
    await page.locator("#new-thinking option").first().textContent(),
    "Default (medium)",
  );
  await page.selectOption("#models", "1");
  assert.equal(await page.locator("#new-thinking option").first().textContent(), "Default (off)");
  assert.deepEqual(
    await page
      .locator("#new-thinking option")
      .evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value)),
    ["", "off"],
  );
  const oldOption = await page.locator("#models option").last().elementHandle();
  assert(oldOption);
  await page.click("#close-view");
  await page.click("#title");
  await page.waitForFunction((option) => !option.isConnected, oldOption);
  assert.equal(await page.locator("#models").inputValue(), "1");

  // Change models while a refresh is pending. Its response must not restore
  // the selection from before the request.
  const requested = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  await page.route("**/api/catalog", async (route) => {
    requested.resolve();
    await release.promise;
    await route.continue();
  });
  const pendingOption = await page.locator("#models option").last().elementHandle();
  assert(pendingOption);
  await page.click("#close-view");
  await page.click("#title");
  await requested.promise;
  await page.selectOption("#models", "0");
  release.resolve();
  await page.waitForFunction((option) => !option.isConnected, pendingOption);
  await page.unroute("**/api/catalog");
  assert.equal(await page.locator("#models").inputValue(), "0");
  assert.equal(await page.locator("#new-thinking").inputValue(), "");

  await page.click("#close-view");
  await page.click("#menu-toggle");
  await page.selectOption("#default-model", "0");
  await page.selectOption("#model-thinking-default", "high");
  await page.selectOption('[name="defaultThinkingLevel"]', "low");
  await page.selectOption('[name="hideThinkingBlock"]', "true");
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(
      await page
        .locator("#global-preferences")
        .evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth),
      true,
    );
    if (process.env.PI_SCREENSHOT_DIR) {
      await mkdir(process.env.PI_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.PI_SCREENSHOT_DIR, `defaults-${width}.png`) });
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click("#close-view");
  await page.waitForSelector("#global-preferences", { state: "hidden" });
  assert.equal(await page.locator("#new-thinking option").first().textContent(), "Default (high)");
  assert.equal(
    await page.locator("body").evaluate((node) => node.classList.contains("hide-thinking")),
    true,
  );
  await page.click("#title");
  await page.click("#create");
  await page.waitForFunction(() => new URL(location.href).searchParams.has("session"));
  const id = new URL(page.url()).searchParams.get("session")!;
  const session = await sessions.get(id);
  assert.equal((await runtime.sessionInfo(session)).thinkingLevel, "high");
  await page.waitForFunction(
    () => !document.querySelector<HTMLButtonElement>("#footer-model")?.disabled,
  );
  await page.click("#footer-model");
  assert.deepEqual(
    await page
      .locator("#thinking option")
      .evaluateAll((nodes) => nodes.map((node) => node.textContent)),
    ["off", "minimal", "low", "medium", "high"],
  );
  await page.selectOption("#thinking", "off");
  await page.click("#close-view");
  await page.waitForSelector("#preferences", { state: "hidden" });
  assert.equal((await runtime.sessionInfo(session)).thinkingLevel, "off");
  assert.equal(store.read().values.defaultThinkingLevel, "low");
  assert.equal(store.read().modelThinkingLevels["faux/faux-1"], "high");
  await page.reload();
  await page.waitForFunction(
    () => !document.querySelector<HTMLButtonElement>("#footer-model")?.disabled,
  );
  assert.equal(
    await page.locator("body").evaluate((node) => node.classList.contains("hide-thinking")),
    true,
  );
  assert.equal((await runtime.sessionInfo(session)).thinkingLevel, "off");
  assert.deepEqual(errors, []);
});

await test("mobile browser sessions share header and footer formatting and stay within narrow viewports", async (t) => {
  const f = await fixture(t);
  const binding = {
    provider: "remote",
    target: "guest-" + "long-target-".repeat(20),
    cwd: "/workspace",
  };
  let available = true;
  await f.reopen({
    targets: async () => [
      ...(await f.options.targets()),
      {
        ...binding,
        label: `guest · git-https://git.example/${"repository/".repeat(30)}?submodules=1`,
        available,
      },
    ],
    env: async (target, context) => {
      const selected = await target.read.snapshot(
        runtime.Environment,
        target.conversationId,
        context,
      );
      if (selected?.provider !== "local")
        throw new Error("Listing sessions must not connect to the environment.");
      return f.options.env(target, context);
    },
  });
  const session = await f.create();
  await runtime.rename(session, "Session with a very long name ".repeat(4));
  f.faux.setResponses([fauxAssistantMessage("Measured response.")]);
  await session.root.submit({ type: "input", content: "Hello.", requestId: randomUUID() }, context);
  await session.root.waitForIdle(context);
  const remote = await f.sessions.create(randomUUID(), binding, model);
  await remote.root.configure(
    {
      model: { provider: "missing", modelId: "long-model-".repeat(30) },
      thinkingLevel: "high",
    },
    context,
  );
  available = false;
  const assets = join(f.workspace, "assets");
  await buildAssets(dirname(dirname(fileURLToPath(import.meta.url))), assets);
  const base = await serve(t, f.sessions, assets);
  const browser = await chromium.launch({ executablePath: chromiumExecutable() });
  t.after(() => browser.close());
  for (const width of [320, 390, 650, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    page.setDefaultTimeout(10_000);
    await page.goto(`${base}/?session=${session.id}`);
    await page.waitForSelector("#status[data-state=ready]");
    // Exercise nonzero safe-area-like insets as well as the usual portrait layout.
    if (width === 650)
      await page.addStyleTag({ content: "body { padding-left: 28px; padding-right: 28px; }" });
    const header = await page.locator("#title").evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const box = range.getBoundingClientRect();
      return {
        left: box.left,
        top: box.top,
        height: node.closest(".bar")!.getBoundingClientRect().height,
      };
    });
    const footerModel = await page.locator("#footer-model").textContent();
    const footerContext = await page.locator("#footer-context").textContent();
    const footerTokens = await page.locator("#footer-context").getAttribute("data-tokens");
    for (const [level, variable] of [
      ["warning", "--warning"],
      ["critical", "--danger"],
    ]) {
      const colors = await page.locator("#footer-context").evaluate(
        (node, { level, variable }) => {
          const previous = node.dataset.level;
          node.dataset.level = level;
          const actual = getComputedStyle(node).color;
          const reference = document.createElement("span");
          reference.style.color = `var(${variable})`;
          document.body.append(reference);
          const expected = getComputedStyle(reference).color;
          reference.remove();
          node.dataset.level = previous;
          return { actual, expected };
        },
        { level, variable },
      );
      assert.equal(colors.actual, colors.expected);
    }
    await page.click("#title");
    await page.waitForSelector("#picker:not([hidden])");
    const row = page.locator(`#sessions [data-session="${session.id}"]`);
    await row.waitFor();
    assert.equal(await row.locator(".model-summary").textContent(), footerModel);
    assert.equal(await row.locator(".context-usage").textContent(), footerContext);
    assert.equal(await row.locator(".context-usage").getAttribute("data-tokens"), footerTokens);
    assert.equal(await row.locator(".session-environment").textContent(), `local · ${f.workspace}`);
    assert.equal(
      await row.locator("time").getAttribute("datetime"),
      new Date(session.created).toISOString(),
    );
    const viewHeader = await page.locator("#view-title").evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const box = range.getBoundingClientRect();
      return {
        left: box.left,
        top: box.top,
        height: node.closest(".bar")!.getBoundingClientRect().height,
      };
    });
    assert.deepEqual(viewHeader, header);
    const layout = await page.locator("#picker").evaluate((picker) => ({
      overflow: picker.scrollWidth > picker.clientWidth,
      pageOverflow: document.documentElement.scrollWidth > innerWidth,
      rows: Array.from(picker.querySelectorAll(".session"), (button) => {
        const box = button.getBoundingClientRect();
        const heading = button.querySelector(".session-heading")!.getBoundingClientRect();
        const detail = button.querySelector(".session-detail")!.getBoundingClientRect();
        const name = button.querySelector("strong")!.getBoundingClientRect();
        const time = button.querySelector("time")!.getBoundingClientRect();
        const fields = Array.from(
          button.querySelectorAll(
            ".session-environment, .model-name, .model-effort, .context-usage",
          ),
        );
        return {
          children: button.children.length,
          twoRows: detail.top >= heading.bottom && detail.bottom <= box.bottom,
          timestampRight: time.right === heading.right && time.left > name.right,
          contained: fields.every((field) => {
            const rect = field.getBoundingClientRect();
            return (
              rect.width > 0 &&
              rect.left >= box.left &&
              rect.right <= box.right &&
              rect.top >= detail.top &&
              rect.bottom <= detail.bottom
            );
          }),
        };
      }),
    }));
    assert.equal(layout.overflow, false, `picker overflow at ${width}px`);
    assert.equal(layout.pageOverflow, false);
    assert.equal(layout.rows.length, 2);
    for (const item of layout.rows) {
      assert.equal(item.children, 2);
      assert.equal(item.twoRows, true);
      assert.equal(item.timestampRight, true);
      assert.equal(item.contained, true, `summary fields at ${width}px`);
    }
    if (process.env.PI_SCREENSHOT_DIR) {
      await mkdir(process.env.PI_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.PI_SCREENSHOT_DIR, `sessions-${width}.png`) });
    }
    await page.fill("#session-filter", "repository");
    assert.equal(await page.locator("#sessions .session").count(), 1);
    await page.fill("#session-filter", session.id);
    await row.click();
    await page.waitForSelector("#transcript:not([hidden])");
    assert.equal(new URL(page.url()).searchParams.get("session"), session.id);
    await page.close();
  }
});

await test("mobile browser stacked views preserve input and scroll, serialize autosaves and isolate background work", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const store = new GlobalSettingsStore(SettingsManager.inMemory());
  const assets = join(f.workspace, "assets");
  await buildAssets(dirname(dirname(fileURLToPath(import.meta.url))), assets);
  const base = await serve(t, f.sessions, assets, "127.0.0.1", undefined, store);
  const browser = await chromium.launch({
    executablePath: chromiumExecutable(),
  });
  t.after(() => browser.close());
  f.faux.setResponses([fauxAssistantMessage("Searchable history.\n".repeat(80))]);
  await session.root.submit(
    { type: "input", content: "Seed history.", requestId: randomUUID() },
    context,
  );
  await session.root.waitForIdle(context);
  for (const width of [390, 1440]) {
    const page = await browser.newPage({
      viewport: { width, height: 900 },
      hasTouch: width === 390,
    });
    const errors: Error[] = [];
    page.on("pageerror", (error) => errors.push(error));
    page.setDefaultTimeout(10_000);
    await page.goto(`${base}/?session=${session.id}`);
    await page.waitForSelector("#status[data-state=ready]");
    await page.fill("#prompt", "Unsent draft");
    await page.setInputFiles("#images", {
      name: "pixel.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    });
    await page.waitForSelector("#attachments button");
    const scroll = await page.locator("#transcript").evaluate((node) => {
      node.scrollTop = 120;
      return node.scrollTop;
    });
    await page.click("#footer-model");
    await page.fill("#session-name", `Session ${width}`);
    await page.focus("#instructions");
    await waitFor(async () => (await runtime.sessionInfo(session)).name === `Session ${width}`);
    assert.equal(await page.locator("body").getAttribute("data-view"), "settings");

    // A blur starts a save; leaving during that request must wait and fail closed.
    const requested = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    t.after(() => release.resolve());
    let fail = true;
    await page.route("**/configure*", async (route) => {
      requested.resolve();
      await release.promise;
      if (fail)
        await route.fulfill({ status: 503, json: { error: "Settings storage unavailable" } });
      else await route.continue();
    });
    await page.fill("#instructions", `Instructions ${width}`);
    await page.click("#close-view");
    await requested.promise;
    assert.equal(await page.locator("body").getAttribute("data-view"), "settings");
    assert.equal(await page.locator("#preferences").getAttribute("aria-busy"), "true");
    release.resolve();
    await page.waitForSelector("#preferences:not([aria-busy])");
    assert.equal(await page.locator("#notice").isVisible(), true);
    assert.equal(await page.inputValue("#instructions"), `Instructions ${width}`);
    assert.equal(await page.inputValue("#prompt"), "Unsent draft");
    const failed = page.waitForResponse(
      (response) => response.url().includes("/configure") && response.status() === 503,
    );
    await page.keyboard.press("Control+k");
    await failed;
    await page.waitForSelector("#preferences:not([aria-busy])");
    assert.equal(await page.locator("body").getAttribute("data-view"), "settings");
    fail = false;
    await page.keyboard.press("Control+k");
    await page.waitForSelector("#picker:not([hidden])");
    assert.equal((await session.root.agent(context)).instructions, `Instructions ${width}`);
    assert.equal(await page.locator("#attachments button").count(), 1);
    assert.equal(await page.locator("#new-options").isHidden(), true);
    await page.click("#new-options-toggle");
    assert.equal(await page.locator("#new-options").isVisible(), true);
    assert.equal(
      await page.locator("#new-options-toggle .options-close").textContent(),
      await page.locator("#stop span").textContent(),
    );
    await page.fill("#session-filter", "not a session");
    assert.equal(await page.locator("#sessions button").count(), 0);
    await page.fill("#session-filter", `Session ${width}`);
    assert.equal(await page.locator("#sessions button").count(), 1);
    await page.keyboard.press("Control+f");
    await page.waitForSelector("#search-bar:not([hidden])");
    assert.equal(await page.locator("#view-title").textContent(), `Search in “Session ${width}”`);
    const articleStyles = () =>
      page.locator("#transcript article").evaluateAll((nodes) =>
        nodes.map((node) => {
          const css = getComputedStyle(node);
          return [css.paddingLeft, css.borderLeftWidth, css.backgroundColor];
        }),
      );
    const before = await articleStyles();
    await page.fill("#search", "Searchable");
    assert.deepEqual(await articleStyles(), before);
    assert(await page.evaluate(() => (CSS.highlights.get("pi-search")?.size ?? 0) > 0));
    await page.click("#close-view");
    await page.waitForSelector("#composer:not([hidden])");
    assert.equal(await page.locator("#transcript").evaluate((node) => node.scrollTop), scroll);
    assert.equal(await page.inputValue("#prompt"), "Unsent draft");
    await page.locator("#attachments button").click();

    // Saving immediately on selects includes edits made while a save is pending.
    const selectRequested = Promise.withResolvers<void>();
    const selectRelease = Promise.withResolvers<void>();
    t.after(() => selectRelease.resolve());
    await page.unroute("**/configure*");
    await page.route("**/configure*", async (route) => {
      selectRequested.resolve();
      await selectRelease.promise;
      await route.continue();
    });
    await page.click("#footer-model");
    await page.selectOption("#thinking", "low");
    await selectRequested.promise;
    await page.selectOption("#thinking", "high");
    await page.click("#footer-context");
    assert.equal(await page.locator("body").getAttribute("data-view"), "settings");
    selectRelease.resolve();
    await page.waitForSelector("#context-view:not([hidden])");
    assert.equal((await session.root.agent(context)).thinkingLevel, "high");
    await page.unroute("**/configure*");

    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    t.after(() => finish.resolve());
    f.faux.setResponses([
      async () => {
        started.resolve();
        await finish.promise;
        return fauxAssistantMessage(`Background response ${width}`);
      },
    ]);
    await page.click("#close-view");
    await page.fill("#prompt", "Run in the background.");
    await page.press("#prompt", "Control+Enter");
    await started.promise;
    await page.waitForSelector("#status[data-state=working]", { state: "attached" });
    await page.fill("#prompt", "Queued text ".repeat(200));
    await page.press("#prompt", "Control+Enter");
    await page.waitForSelector("#queue button", { state: "attached" });
    await page.click("#footer-context");
    assert.equal(await page.locator("body").getAttribute("data-view"), "context");
    assert.equal(await page.locator("#queue").isHidden(), true);
    await page.click("#close-view");
    const queue = await page.locator("#queue").evaluate((node) => ({
      height: node.getBoundingClientRect().height,
      scroll: node.scrollHeight,
      client: node.clientHeight,
    }));
    assert(queue.height > 0 && queue.height <= 180);
    assert(queue.scroll > queue.client);
    await page.locator("#queue button").click();
    await page.waitForSelector("#queue", { state: "hidden" });
    await page.click("#footer-context");
    finish.resolve();
    await session.root.waitForIdle(context);
    await page.waitForSelector("#status[data-state=ready]", { state: "attached" });
    assert.equal(await page.locator("body").getAttribute("data-view"), "context");
    await page.click("#close-view");
    await page.fill("#prompt", "/fork");
    await page.press("#prompt", "Control+Enter");
    await page.waitForSelector("#branches button");
    assert.equal(await page.locator("#branches button").count(), 1);
    await page.locator("#branches button").click();
    await page.waitForSelector("#title", { state: "visible" });

    // Global save failures use the same bar and transition guard, not a dialog.
    await page.click("#menu-toggle");
    fail = true;
    await page.route("**/api/settings", async (route) => {
      if (fail && route.request().method() === "POST")
        await route.fulfill({ status: 503, json: { error: "Defaults storage unavailable" } });
      else await route.continue();
    });
    await page.selectOption('[name="defaultThinkingLevel"]', width === 390 ? "high" : "low");
    await page.waitForSelector("#notice", { state: "visible" });
    await page.waitForSelector("#global-preferences:not([aria-busy])");
    const failedGlobal = page.waitForResponse(
      (response) => response.url().endsWith("/api/settings") && response.status() === 503,
    );
    await page.click("#close-view");
    await failedGlobal;
    await page.waitForSelector("#global-preferences:not([aria-busy])");
    assert.equal(await page.locator("body").getAttribute("data-view"), "global");
    if (process.env.PI_SCREENSHOT_DIR) {
      await mkdir(process.env.PI_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({
        path: join(process.env.PI_SCREENSHOT_DIR, `autosave-failure-${width}.png`),
      });
    }
    fail = false;
    await page.click("#close-view");
    await page.waitForSelector("#title", { state: "visible" });
    assert.equal(store.read().values.defaultThinkingLevel, width === 390 ? "high" : "low");
    await page.fill("#prompt", "Keep through reconnect");
    await page.click("#footer-context");
    await page.context().setOffline(true);
    await page.waitForSelector('#bottom-line[data-connected="false"]', { state: "attached" });
    await page.context().setOffline(false);
    await page.waitForSelector('#bottom-line[data-connected="true"]', { state: "attached" });
    assert.equal(await page.locator("body").getAttribute("data-view"), "context");
    assert.equal(await page.inputValue("#prompt"), "Keep through reconnect");
    await page.click("#close-view");

    // Creation can finish while a new edit is saving. It must not switch the
    // form binding or repaint the new session with the old rename/configure result.
    const creating = Promise.withResolvers<void>();
    const createRelease = Promise.withResolvers<void>();
    const configuring = Promise.withResolvers<void>();
    const configureRelease = Promise.withResolvers<void>();
    t.after(() => {
      createRelease.resolve();
      configureRelease.resolve();
    });
    await page.route("**/api/sessions", async (route) => {
      creating.resolve();
      await createRelease.promise;
      await route.continue();
    });
    await page.route("**/configure*", async (route) => {
      configuring.resolve();
      await configureRelease.promise;
      await route.continue();
    });
    await page.click("#footer-model");
    await page.fill("#prompt", "/new");
    await page.press("#prompt", "Control+Enter");
    await creating.promise;
    await page.fill("#instructions", `Before creating ${width}`);
    await page.focus("#session-name");
    await configuring.promise;
    await page.fill("#session-name", `Old session ${width}`);
    const created = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/sessions") && response.request().method() === "POST",
    );
    createRelease.resolve();
    const newSession = await (await created).json();
    assert.equal(await page.locator("body").getAttribute("data-view"), "settings");
    assert.equal(new URL(page.url()).searchParams.get("session"), session.id);
    configureRelease.resolve();
    await page.waitForURL((url) => url.searchParams.get("session") === newSession.id);
    await page.waitForSelector("#status[data-state=ready]");
    assert.equal((await session.root.agent(context)).instructions, `Before creating ${width}`);
    assert.equal((await runtime.sessionInfo(session)).name, `Old session ${width}`);
    assert.equal(
      (await (await f.sessions.get(newSession.id)).root.agent(context)).instructions,
      undefined,
    );
    assert.equal(await page.locator("#title").textContent(), f.workspace.split("/").at(-1));
    assert.deepEqual(errors, []);
    await page.close();
  }
});

await test("session catalog refresh preserves row focus without stealing focus from the filter", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const assets = join(f.workspace, "assets");
  await buildAssets(dirname(dirname(fileURLToPath(import.meta.url))), assets);
  const base = await serve(t, f.sessions, assets);
  const browser = await chromium.launch({ executablePath: chromiumExecutable() });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(`${base}/?session=${session.id}`);
  await page.waitForSelector("#status[data-state=ready]");
  await page.waitForSelector("#sessions button", { state: "attached" });

  for (const focusFilter of [false, true]) {
    const requested = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    t.after(() => release.resolve());
    await page.route("**/api/catalog", async (route) => {
      requested.resolve();
      await release.promise;
      await route.continue();
    });
    await page.click("#title");
    await requested.promise;
    await page.focus("#session-filter");
    await page.keyboard.press("Control+j");
    const focused = await page.locator("#sessions button:focus").getAttribute("data-session");
    assert(focused);
    if (focusFilter) await page.focus("#session-filter");
    const added = await f.create();
    release.resolve();
    await page.waitForSelector(`#sessions button[data-session="${added.id}"]`);
    assert.equal(
      await page
        .locator(focusFilter ? "#session-filter" : `#sessions button[data-session="${focused}"]`)
        .evaluate((node) => node === document.activeElement),
      true,
    );
    await page.unroute("**/api/catalog");
    await page.click("#close-view");
  }
});

await test("mobile browser branch refresh preserves keyboard focus while loading new conversations", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  await session.root.reset(undefined, context);
  const last = (await readHistory(session.root)).at(-1);
  assert(last);
  const assets = join(f.workspace, "assets");
  await buildAssets(dirname(dirname(fileURLToPath(import.meta.url))), assets);
  const base = await serve(t, f.sessions, assets);
  const browser = await chromium.launch({
    executablePath: chromiumExecutable(),
  });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(`${base}/?session=${session.id}`);
  await page.waitForSelector("#status[data-state=ready]");
  await page.waitForSelector("#branches button", { state: "attached" });
  const original = await page.locator("#branches button").first().elementHandle();
  assert(original);
  const requested = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  await page.route("**/scanConversations*", async (route) => {
    requested.resolve();
    await release.promise;
    await route.continue();
  });
  await page.fill("#prompt", "/fork");
  await page.press("#prompt", "Control+Enter");
  await requested.promise;
  await page.keyboard.press("Control+j");
  assert.equal(await original.evaluate((node) => node === document.activeElement), true);
  const branch = await session.root.fork(last.id, { ownership: { kind: "ownerless" } }, context);
  release.resolve();
  await page.waitForFunction(() => document.querySelectorAll("#branches button").length === 2);
  assert.equal(
    await original.evaluate((node) => node.isConnected && node === document.activeElement),
    true,
  );
  await page.keyboard.press("Control+k");
  assert.equal(
    await page
      .locator("#branches button")
      .last()
      .evaluate((node) => node === document.activeElement),
    true,
  );
  await page.keyboard.press("Enter");
  await page.waitForURL((url) => url.searchParams.get("conversation") === String(branch.id));
});

await test("mobile browser navigation never automatically focuses controls", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const assets = join(f.workspace, "assets");
  await buildAssets(dirname(dirname(fileURLToPath(import.meta.url))), assets);
  const base = await serve(t, f.sessions, assets);
  const browser = await chromium.launch({
    executablePath: chromiumExecutable(),
  });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  // Catch transient focus too, not just the active element after a transition.
  await page.addInitScript(() => {
    const calls: string[] = [];
    Object.assign(window, { automaticFocus: calls });
    const focus = Reflect.get(HTMLElement.prototype, "focus") as HTMLElement["focus"];
    HTMLElement.prototype.focus = function (...args) {
      calls.push(this.id || this.tagName);
      focus.apply(this, args);
    };
  });
  await page.goto(`${base}/?session=${session.id}`);
  await page.waitForFunction(
    () => !document.querySelector<HTMLButtonElement>("#footer-model")?.disabled,
  );
  assert.equal(
    await page.locator("#prompt").evaluate((node) => node === document.activeElement),
    false,
  );
  for (const initiallyFocused of [false, true]) {
    if (initiallyFocused) await page.click("#prompt");
    await page.click("#menu-toggle");
    await page.waitForSelector("#global-preferences", { state: "visible" });
    await page.click("#close-view");
    await page.waitForSelector("#global-preferences", { state: "hidden" });
    assert.equal(
      await page.locator("#prompt").evaluate((node) => node === document.activeElement),
      false,
    );
  }
  for (const trigger of ["#footer-model", "#title"]) {
    await page.click(trigger);
    await page.waitForSelector("#close-view", { state: "visible" });
    await page.keyboard.press("Escape");
    await page.waitForSelector("#close-view", { state: "hidden" });
  }
  await page.click("#prompt");
  await page.keyboard.type("/review");
  await page.keyboard.press("Control+Enter");
  await page.waitForSelector("#review-setup[open]");
  assert.equal(
    await page.locator("#review-setup").evaluate((node) => node.contains(document.activeElement)),
    false,
  );
  await page.click("#review-instructions");
  await page.keyboard.press("Escape");
  await page.waitForSelector("#review-setup", { state: "hidden" });
  assert.equal(
    await page.locator("#prompt").evaluate((node) => node === document.activeElement),
    false,
  );
  assert.deepEqual(await page.evaluate(() => Reflect.get(window, "automaticFocus")), []);
});

await test("mobile browser compaction and reset archive unchanged conversation nodes in Shadow DOM", async (t) => {
  const f = await fixture(t);
  const sessions = await openCodingSessions({
    ...f.options,
    directory: join(f.workspace, "state"),
    settings: { compaction: { keepRecentTokens: 1 } },
  });
  t.after(() => sessions.close());
  const session = await sessions.create(randomUUID(), f.binding, model);
  for (const entry of benchmarkFixture(2).view.entries)
    await session.root.submit(
      { type: "write", entry: { kind: entry.kind, model: entry.model } },
      context,
    );
  const assets = join(f.workspace, "assets");
  await buildAssets(dirname(dirname(fileURLToPath(import.meta.url))), assets);
  const base = await serve(t, sessions, assets);
  const browser = await chromium.launch({
    executablePath: chromiumExecutable(),
  });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  await page.goto(`${base}/?session=${session.id}`);
  await page.waitForSelector('.tool-call[data-call-id="call1"]');
  const tool = page.locator('.tool-call[data-call-id="call0"]');
  await tool.locator(":scope > summary").click();
  const original = await page.evaluateHandle(() =>
    Array.from(document.querySelectorAll("#transcript > article")),
  );
  const appearance = async () =>
    original.evaluate((nodes) =>
      nodes
        .flatMap((node) => [node, ...node.querySelectorAll("*")])
        .map((node) => {
          const style = getComputedStyle(node);
          return [
            style.font,
            style.color,
            style.padding,
            style.margin,
            style.border,
            style.display,
            node.getBoundingClientRect().width,
          ];
        }),
    );
  const before = await appearance();
  await page.setViewportSize({ width: 1440, height: 900 });
  const desktopBefore = await appearance();
  await page.setViewportSize({ width: 390, height: 844 });
  const release = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  f.faux.setResponses([
    async () => {
      await release.promise;
      return fauxAssistantMessage("A concise checkpoint.");
    },
  ]);
  const taskId = await session.root.compact(undefined, context);
  const running = page.locator('.context-event[data-state="running"]');
  await running.waitFor();
  assert.equal(await running.locator(".tool-status > span").count(), 4);
  assert.equal(await running.locator(".tool-status").getAttribute("aria-label"), "running");
  assert.equal(
    await running
      .locator(".tool-status > span")
      .first()
      .evaluate((node) => getComputedStyle(node).animationName),
    "tool-spinner",
  );
  assert.equal(await page.locator(".context-history").count(), 0);
  release.resolve();
  await session.harness.waitForTask(taskId, context);
  const completed = page.locator('.context-event[data-state="completed"]');
  await completed.waitFor();
  assert.equal(await running.count(), 0);
  assert.equal(await completed.evaluate((node) => (node as HTMLDetailsElement).open), false);
  assert.equal(
    await completed.locator(":scope > summary > .tool-status").getAttribute("aria-label"),
    "completed",
  );
  const task = await session.harness.getTask(taskId, context);
  assert(task?.startedAt !== undefined && task.endedAt !== undefined);
  const duration = task.endedAt - task.startedAt;
  assert.equal(
    await completed.locator(":scope > summary > .tool-duration").getAttribute("title"),
    `Duration: ${duration}ms`,
  );
  assert.equal(
    await original.evaluate((nodes) =>
      nodes.every((node) => node.isConnected && node.getRootNode() instanceof ShadowRoot),
    ),
    true,
  );
  assert.equal(
    await page.evaluate(() => document.querySelectorAll("#transcript > article").length),
    1,
  );
  assert.equal(await tool.isVisible(), false);
  const summaryContent = completed.locator(":scope > .compaction-summary");
  assert.equal(await summaryContent.count(), 1);
  assert.equal(await summaryContent.isVisible(), false);
  assert.equal(await completed.locator(":scope > details").count(), 0);
  await completed.locator(":scope > summary").click();
  assert.equal(await summaryContent.isVisible(), true);
  assert.equal(await tool.evaluate((node) => (node as HTMLDetailsElement).open), true);
  assert.deepEqual(await appearance(), before);
  await page.setViewportSize({ width: 1440, height: 900 });
  assert.deepEqual(await appearance(), desktopBefore);
  await page.setViewportSize({ width: 390, height: 844 });
  // Updates reuse both the archive and its message nodes, preserving expansion.
  await session.root.submit(
    {
      type: "write",
      entry: {
        kind: "message",
        model: [{ role: "user", content: "After compaction", timestamp: Date.now() }],
      },
    },
    context,
  );
  await page.locator('article[data-role="user"]').filter({ hasText: "After compaction" }).waitFor();
  assert.equal(await completed.evaluate((node) => (node as HTMLDetailsElement).open), true);
  assert.equal(await original.evaluate((nodes) => nodes.every((node) => node.isConnected)), true);
  await session.root.reset(undefined, context);
  const reset = page.locator('article[data-context="pi.reset"] > .context-event');
  await reset.waitFor();
  assert.equal(await reset.evaluate((node) => (node as HTMLDetailsElement).open), false);
  assert.equal(await page.locator(".context-history").count(), 2);
  await reset.locator(":scope > summary").click();
  assert.equal(await tool.isVisible(), true);
  assert.deepEqual(await appearance(), before);
  // Archived message actions still work across the shadow boundary.
  await tool.locator(":scope > summary").dispatchEvent("pointerdown", {
    pointerType: "touch",
    isPrimary: true,
    pointerId: 1,
    composed: true,
  });
  await page.locator("#message-menu").waitFor();
  await tool
    .locator(":scope > summary")
    .dispatchEvent("pointerup", { pointerId: 1, composed: true });
  assert.equal(await page.locator("#message-menu").isVisible(), true);
  await page.keyboard.press("Escape");
  await page.reload();
  await reset.waitFor();
  assert.equal(await reset.evaluate((node) => (node as HTMLDetailsElement).open), false);
  assert.equal(await page.locator(".context-history").count(), 2);
  assert.equal(
    await page
      .locator('article[data-context="pi.compaction"] > .context-event > summary > .tool-duration')
      .getAttribute("title"),
    `Duration: ${duration}ms`,
  );
  await page.keyboard.press("Control+f");
  await page.fill("#search", "Inspect module 0");
  assert.equal(await page.locator("#search-count").textContent(), "1 / 1");
  assert.equal(await reset.evaluate((node) => (node as HTMLDetailsElement).open), true);
  assert.equal(
    await page
      .locator('article[data-context="pi.compaction"] > .context-event')
      .evaluate((node) => (node as HTMLDetailsElement).open),
    true,
  );
  const cutoff = (await readHistory(session.root)).at(-1);
  assert(cutoff);
  const branch = await session.root.fork(cutoff.id, { ownership: { kind: "ownerless" } }, context);
  await page.goto(`${base}/?session=${session.id}&conversation=${branch.id}`);
  await reset.waitFor();
  assert.equal(
    await page
      .locator('article[data-context="pi.compaction"] > .context-event > summary > .tool-duration')
      .getAttribute("title"),
    `Duration: ${duration}ms`,
  );
  assert.deepEqual(errors, []);
});

await test("browser coalesces observation refreshes and cancels reads on navigation", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const other = await f.create();
  const { page, base, errors } = await browserFixture(t, f.sessions);
  await page.addInitScript(() => {
    const metrics = { pending: 0, peak: 0, frames: 0, aborted: 0 };
    Object.assign(window, { observationMetrics: metrics });
    const fetch = window.fetch.bind(window);
    window.fetch = async (...args: Parameters<typeof fetch>) => {
      const input = args[0];
      const url = new URL(input instanceof Request ? input.url : input, location.href);
      if (!url.pathname.endsWith("/info")) return fetch(...args);
      metrics.pending++;
      metrics.peak = Math.max(metrics.peak, metrics.pending);
      try {
        return await fetch(...args);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") metrics.aborted++;
        throw error;
      } finally {
        metrics.pending--;
      }
    };
    window.EventSource = class extends EventSource {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        if (new URL(this.url).pathname.endsWith("/watch"))
          this.addEventListener("message", () => metrics.frames++);
      }
    };
  });
  await page.goto(`${base}/?session=${session.id}`);
  await page.waitForSelector("#status[data-state=ready]");
  let hold = false;
  let entered = Promise.withResolvers<void>();
  let release = Promise.withResolvers<void>();
  const agent = session.root.agent.bind(session.root);
  t.mock.method(session.root, "agent", async (...args: Parameters<typeof agent>) => {
    if (hold) {
      entered.resolve();
      await release.promise;
    }
    return agent(...args);
  });
  try {
    await page.evaluate(() => {
      const metrics = Reflect.get(window, "observationMetrics");
      metrics.peak = metrics.pending;
      metrics.frames = 0;
    });
    // One failed read must not start a second batch while its peers are pending.
    await page.route(
      `**/api/sessions/${session.id}/context-status`,
      (route) => route.fulfill({ status: 503, json: { error: "Temporary context failure" } }),
      { times: 1 },
    );
    hold = true;
    await session.root.configure({ instructions: "initial" }, context);
    await entered.promise;
    await page.locator("#notice").waitFor();
    for (let index = 0; index < 20; index++)
      await session.root.configure({ instructions: String(index), thinkingLevel: "high" }, context);
    await page.waitForFunction(() => Reflect.get(window, "observationMetrics").frames >= 21);
    const peak = await page.evaluate(() => Reflect.get(window, "observationMetrics").peak);
    t.diagnostic(`Peak pending info fetches during 21 view frames: ${peak}`);
    assert.equal(peak, 1);
    hold = false;
    release.resolve();
    await page.waitForFunction(
      () => document.querySelector("#footer-effort")?.textContent === "high",
    );
    await page.click("#footer-model");
    assert.equal(await page.inputValue("#instructions"), "19");
    await page.click("#close-view");

    entered = Promise.withResolvers<void>();
    release = Promise.withResolvers<void>();
    hold = true;
    await session.root.configure({ thinkingLevel: "low" }, context);
    await entered.promise;
    await page.click("#title");
    await page.click(`#sessions [data-session="${other.id}"]`);
    await page.waitForURL((url) => url.searchParams.get("session") === other.id);
    await page.waitForFunction(() => Reflect.get(window, "observationMetrics").aborted > 0);
    hold = false;
    release.resolve();
    await page.waitForSelector("#status[data-state=ready]");
    assert.equal(await page.locator("#footer-effort").textContent(), "medium");
    assert.equal(await page.locator("#notice").isVisible(), false);
    assert.deepEqual(errors, []);
  } finally {
    hold = false;
    release.resolve();
  }
});

await test("browser reconnect recovers history hidden by a reset while disconnected", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const watches = t.mock.method(session.root, "watch");
  const { page, base, errors } = await browserFixture(t, f.sessions);
  await page.goto(`${base}/?session=${session.id}`);
  await page.waitForSelector("#status[data-state=ready]");
  for (const call of watches.mock.calls) {
    const watch = await call.result;
    assert(watch);
    await watch.stop();
  }
  await page.waitForSelector("#status[data-state=reconnecting]");
  const submission = await session.root.submit(
    {
      type: "write",
      entry: {
        kind: "pi.user",
        model: [{ role: "user", content: "While disconnected", timestamp: 1 }],
      },
    },
    context,
  );
  const entry = (await submission.status(context)).entry;
  assert(entry !== undefined);
  await session.root.reset(undefined, context);
  await page.waitForSelector("#status[data-state=ready]");
  const boundary = page.locator('article[data-context="pi.reset"] > .context-event');
  await boundary.locator(":scope > summary").click();
  await page.getByText("While disconnected", { exact: true }).waitFor();
  assert.equal(await page.locator('article[data-role="user"]').count(), 1);
  assert.deepEqual(errors, []);
});

await test("browser switches execution independently of the model and restores historical selection", async (t) => {
  const f = await fixture(t);
  const other = join(f.workspace, "other");
  await mkdir(other);
  const targets = [
    { ...f.binding, label: "First environment", available: true },
    { provider: "local", target: other, cwd: other, label: "Second environment", available: true },
  ];
  await f.reopen({ targets: async () => targets });
  const session = await f.create();
  const marker = await session.root.submit(
    { type: "write", entry: { kind: "marker", data: { before: true } } },
    context,
  );
  const at = (await marker.status(context)).entry;
  assert(at !== undefined);
  const { page, base, errors } = await browserFixture(t, f.sessions);
  await page.goto(`${base}/?session=${session.id}`);
  await page.waitForSelector("#status[data-state=ready]");
  await page.click("#footer-model");
  await page.selectOption("#session-target", { label: "Second environment" });
  await page.click("#close-view");
  await waitFor(
    async () =>
      (await session.harness.snapshot(runtime.Environment, session.root.id, context))?.target ===
      other,
  );
  assert.deepEqual((await session.root.agent(context)).model, model);
  assert.equal((await session.root.agent(context)).cwd, other);
  await page.reload();
  await page.waitForSelector("#status[data-state=ready]");
  await page.click("#footer-model");
  assert.equal(
    await page.locator("#session-target option:checked").textContent(),
    "Second environment",
  );
  await page.click("#close-view");
  const branch = await session.root.fork(at, { ownership: { kind: "ownerless" } }, context);
  await page.goto(`${base}/?session=${session.id}&conversation=${branch.id}`);
  await page.waitForSelector("#status[data-state=ready]");
  await page.click("#footer-model");
  assert.equal(
    await page.locator("#session-target option:checked").textContent(),
    "First environment",
  );
  assert.equal((await branch.agent(context)).cwd, f.workspace);
  assert.deepEqual(errors, []);
});
