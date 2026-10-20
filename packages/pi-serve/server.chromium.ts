import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { chromium } from "playwright";
import { Sessions } from "../pi-runtime/index.ts";
import { fixture, model, waitFor } from "../pi-runtime/testing.ts";
import { browserFlow, chromiumExecutable, directoryFixture, serve } from "./testing.ts";
import { GlobalSettingsStore } from "./server.ts";
import { benchmark, benchmarkFixture, benchmarkOptions } from "./benchmark.ts";
import { buildAssets } from "./build.ts";

const context = BACKGROUND_CONTEXT;

await test("landing lists the newest five sessions regardless of target availability", async (t) => {
  const f = await directoryFixture(t);
  const assets = join(f.workspace, "assets");
  await buildAssets(dirname(fileURLToPath(import.meta.url)), assets);
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
    await session.rename(`Session ${index}`);
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

await test("mobile browser runs local tools, reconnects and renders untrusted content safely", async (t) => {
  const f = await fixture(t);
  await browserFlow(t, {
    ...f,
    extended: true,
    restart: async () => {
      await f.reopen();
      return f.sessions;
    },
  });
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
  const sessions = await Sessions.open(store.bind(f.options));
  t.after(() => sessions.close());
  const assets = join(f.workspace, "assets");
  await buildAssets(dirname(fileURLToPath(import.meta.url)), assets);
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
  assert.equal((await session.info()).thinkingLevel, "high");
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
  assert.equal((await session.info()).thinkingLevel, "off");
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
  assert.equal((await session.info()).thinkingLevel, "off");
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
  await f.reopen([
    ...f.options.integrations,
    {
      id: "remote",
      targets: async () => [
        {
          ...binding,
          label: `guest · git-https://git.example/${"repository/".repeat(30)}?submodules=1`,
          available,
        },
      ],
      validate: async () => {},
      open: () => {
        throw new Error("Listing sessions must not connect to the environment.");
      },
    },
  ]);
  const session = await f.create();
  await session.rename("Session with a very long name ".repeat(4));
  f.faux.setResponses([fauxAssistantMessage("Measured response.")]);
  await session.prompt("Hello.", randomUUID());
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
  await buildAssets(dirname(fileURLToPath(import.meta.url)), assets);
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
  await buildAssets(dirname(fileURLToPath(import.meta.url)), assets);
  const base = await serve(t, f.sessions, assets, "127.0.0.1", undefined, store);
  const browser = await chromium.launch({
    executablePath: chromiumExecutable(),
  });
  t.after(() => browser.close());
  f.faux.setResponses([fauxAssistantMessage("Searchable history.\n".repeat(80))]);
  await session.prompt("Seed history.", randomUUID());
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
    await waitFor(async () => (await session.info()).name === `Session ${width}`);
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
    assert.equal((await session.info()).name, `Old session ${width}`);
    assert.equal(
      (await (await f.sessions.get(newSession.id)).root.agent(context)).instructions,
      undefined,
    );
    assert.equal(await page.locator("#title").textContent(), f.workspace.split("/").at(-1));
    assert.deepEqual(errors, []);
    await page.close();
  }
});

await test("mobile browser branch refresh preserves keyboard focus while loading new conversations", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  await session.root.reset(undefined, context);
  const last = (await session.history()).at(-1);
  assert(last);
  const assets = join(f.workspace, "assets");
  await buildAssets(dirname(fileURLToPath(import.meta.url)), assets);
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
  await page.route("**/conversations", async (route) => {
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
  await buildAssets(dirname(fileURLToPath(import.meta.url)), assets);
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
  const sessions = await Sessions.open({
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
  await buildAssets(dirname(fileURLToPath(import.meta.url)), assets);
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
  assert.deepEqual(errors, []);
});
