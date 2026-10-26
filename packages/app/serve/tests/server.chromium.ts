import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "playwright";
import { checkCLI, chromiumExecutable } from "./testing.ts";
import { benchmark, benchmarkOptions } from "../benchmark.ts";
import { conversationURL } from "../presentation.ts";
import { fixture, readHistory, waitFor, model } from "./sessions-testing.ts";
import { rename, sessionInfo } from "../sessions.ts";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { GlobalSettingsStore } from "../server.ts";
import { browserFixture } from "./browser-testing.ts";

await test("both frontends use only the shared stylesheet", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const b = await browserFixture(t, f.sessions);
  for (const prefix of ["", "/elm"]) {
    await b.page.goto(
      b.base + conversationURL(session, undefined, prefix === "/elm" ? "elm" : "htmx"),
    );
    await b.page.locator("#prompt").waitFor();
    assert.deepEqual(
      await b.page.evaluate(() =>
        Array.from(document.styleSheets, (sheet) => sheet.href && new URL(sheet.href).pathname),
      ),
      ["/styles.css"],
    );
  }
  assert.deepEqual(b.errors, []);
});

await test("both frontends confirm /reset with two keyboard submissions without losing input focus", async (t) => {
  const f = await fixture(t);
  const b = await browserFixture(t, f.sessions);
  b.page.setDefaultTimeout(10000);
  for (const prefix of ["", "/elm"])
    for (const shortcut of ["Control+Enter", "Meta+Enter"])
      for (const handoff of ["", "Preserve the handoff."])
        await t.test(`${prefix || "htmx"}: ${shortcut}, handoff=${Boolean(handoff)}`, async () => {
          const session = await f.create();
          await b.page.goto(
            b.base + conversationURL(session, undefined, prefix === "/elm" ? "elm" : "htmx"),
          );
          const prompt = b.page.locator("#prompt");
          await prompt.fill(handoff ? `/reset ${handoff}` : "/reset");
          if (!handoff) await b.page.locator('#completions [role="option"]').waitFor();
          const before = await readHistory(session.root);
          await b.page.keyboard.press(shortcut);
          await b.page.getByRole("button", { name: "Confirm reset" }).waitFor();
          await b.page.waitForFunction(() => document.activeElement?.id === "prompt");
          assert.equal(await prompt.inputValue(), handoff);
          assert.deepEqual(await readHistory(session.root), before);
          await b.page.keyboard.press(shortcut);
          await b.page.locator('[data-context="pi.reset"]').waitFor();
          const after = await readHistory(session.root);
          assert.equal(after.length, before.length + 1);
          assert.equal(after.at(-1)?.kind, "pi.reset");
        });
  assert.deepEqual(b.errors, []);
});

await test("frontend landings create, reopen and archive sessions without crossing frontend routes", async (t) => {
  const f = await fixture(t);
  const settings = new GlobalSettingsStore(
    SettingsManager.inMemory({ defaultProvider: model.provider, defaultModel: model.modelId }),
  );
  const b = await browserFixture(t, f.sessions, undefined, undefined, settings);
  b.page.setDefaultTimeout(10000);
  const root = await b.page.goto(b.base);
  assert.equal(root?.status(), 200);
  assert.deepEqual(
    await b.page
      .locator("a")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("href"))),
    ["/elm", "/htmx/"],
  );
  assert.equal(await b.page.locator("script").count(), 0);
  for (let i = 0; i < 7; i++) await rename(await f.create(), `Session ${i}`);
  for (const frontend of ["elm", "htmx"] as const) {
    await t.test(frontend, async () => {
      const page = await b.browserContext.newPage();
      t.after(() => page.close());
      page.setDefaultTimeout(10000);
      const requests: string[] = [];
      page.on("request", (request) => requests.push(new URL(request.url()).pathname));
      page.on("pageerror", (error) => b.errors.push(error));
      const landing = frontend === "elm" ? "/elm" : "/htmx/";
      await page.goto(b.base + landing);
      await page.locator("#session-list a").first().waitFor();
      assert.equal(await page.locator("#session-list a").count(), 5);
      const catalog = await f.sessions.catalog();
      assert.deepEqual(
        await page
          .locator("#session-list a")
          .evaluateAll((nodes) =>
            nodes.map((node) => new URL((node as HTMLAnchorElement).href).pathname.split("/")[3]),
          ),
        catalog.sessions.slice(0, 5).map((item) => item.id),
      );
      assert.equal(await page.locator("#session-filter, #picker").count(), 0);
      f.faux.setResponses([fauxAssistantMessage("Created from the landing.")]);
      await page.locator("#prompt").fill("Initial prompt");
      await page.keyboard.press("Control+Enter");
      await page.waitForURL(new RegExp(`/${frontend}/sessions/.*/conversations/`));
      const id = new URL(page.url()).pathname.split("/")[3];
      const session = await f.sessions.get(id);
      await session.root.waitForIdle(BACKGROUND_CONTEXT);
      assert.equal(
        (await readHistory(session.root)).filter((entry) => entry.kind === "pi.user").length,
        1,
      );
      await page.goto(b.base + landing);
      await page.locator(`#session-list a[href="/${frontend}/sessions/${id}"]`).waitFor();
      await page.locator("#menu-toggle").click();
      await page.locator('#global-settings select[name="hideThinkingBlock"]').selectOption("true");
      await waitFor(async () => settings.read().values.hideThinkingBlock === true);
      await page.getByRole("link", { name: "Sessions", exact: true }).click();
      await page.locator("#landing").waitFor();
      await page.getByRole("link", { name: "Auth", exact: true }).click();
      await page.locator('#github-authorization [data-state="unconfigured"]').waitFor();
      await page.goto(b.base + landing);
      await page.locator(`#session-list a[href="/${frontend}/sessions/${id}"]`).click();
      await page.waitForURL(b.base + conversationURL(session, undefined, frontend));
      await page.goto(b.base + landing);
      await page.locator("#prompt").fill("Unsent new-session draft");
      for (const operation of ["repository", "history", "compact", "reset"]) {
        await page.goto(b.base + conversationURL(session, undefined, frontend) + "/" + operation);
        if (operation === "reset")
          await page.getByRole("button", { name: "Confirm reset" }).waitFor();
        else
          await page
            .getByRole("heading", {
              name: { repository: "Repository", history: "History", compact: "Compact context" }[
                operation
              ],
              exact: true,
              includeHidden: true,
            })
            .last()
            .waitFor({ state: "attached" });
        if (operation === "compact") {
          assert.equal(await page.locator('textarea[name="argument"]').inputValue(), "");
          await page.locator('textarea[name="argument"]').fill("Retain the important context");
        }
      }
      await page.goto(b.base + landing);
      await page.waitForFunction(
        () =>
          document.querySelector<HTMLTextAreaElement>("#prompt")?.value ===
          "Unsent new-session draft",
      );
      const row = page
        .locator(".session-row")
        .filter({ has: page.locator(`a[href="/${frontend}/sessions/${id}"]`) });
      await row.getByRole("button", { name: "Archive session" }).click();
      await row.waitFor({ state: "detached" });
      assert.equal(
        (await f.sessions.catalog()).sessions.some((item) => item.id === id),
        false,
      );
      assert.equal(await page.locator("#session-list a").count(), 5);
      assert.equal(
        requests.some((path) => path.startsWith(frontend === "elm" ? "/htmx" : "/elm")),
        false,
      );
      assert.equal(
        requests.some((path) => /^\/(sessions|auth|activity)(\/|$)/.test(path)),
        false,
      );
      await settings.update({ values: { hideThinkingBlock: false } }, f.sessions);
    });
  }
  assert.deepEqual(b.errors, []);
});

await test("mobile browser page benchmark returns complete JSON-compatible samples", async () => {
  const report = await benchmark(benchmarkOptions(["--runs", "2", "--turns", "2"]));
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.benchmark, "serve.render");
  assert.equal(report.measurement.profiling, false);
  assert.equal(report.measurement.freshBrowserPerRun, true);
  assert.equal(report.workload.entries, 6);
  assert.equal(report.environment.cpuRate, 1);
  assert.equal(report.source.clientSha256.length, 64);
  assert.equal(report.runs.length, 2);
  assert.equal(report.profile, null);
  assert.equal(report.memory, null);
  for (const run of report.runs) {
    assert(run.firstUpdateMs >= run.initialMs);
    assert(run.initialDomElements > 0);
    assert.equal(run.streamingMs.length, report.workload.streamUpdates);
    assert.equal(run.transitionsMs.length, report.workload.transitions);
    for (const value of [run.initialMs, run.startMs, ...run.streamingMs, ...run.transitionsMs])
      assert(Number.isFinite(value) && value >= 0);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
});

await test("page benchmarks drive the production stream and count HTTP response bytes", async () => {
  for (const frontend of ["hypermedia", "elm"]) {
    const report = await benchmark(
      benchmarkOptions(["--frontend", frontend, "--runs", "1", "--turns", "2"]),
    );
    assert.equal(report.frontend, frontend);
    assert.deepEqual(report.environment.viewport, { width: 390, height: 844 });
    assert.equal(report.workload.entries, 6);
    assert.equal(report.runs.length, 1);
    const run = report.runs[0];
    assert(run.firstUpdateMs >= run.initialMs);
    assert(run.initialDomElements > 0);
    assert.equal(run.streamingMs.length, 40);
    assert.equal(run.streamingBytes.length, 40);
    assert.equal(run.transitionsMs.length, 10);
    assert.equal(run.transitionsBytes.length, 10);
    assert(run.reconnectMs > 0 && run.reconnectBytes > 0);
    assert.deepEqual(
      run.archives.map((sample) => sample.kind),
      ["pi.reset", "pi.compaction"],
    );
    for (const sample of run.archives) assert(sample.ms > 0 && sample.bytes > 0);
    for (const ms of [run.initialMs, run.startMs, ...run.streamingMs, ...run.transitionsMs])
      assert(Number.isFinite(ms) && ms > 0);
    for (const bytes of [
      run.initialBytes,
      run.startBytes,
      ...run.streamingBytes,
      ...run.transitionsBytes,
    ])
      assert(Number.isSafeInteger(bytes) && bytes > 0);
    assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
  }
});

await test("page benchmark samples exact history sizes and memory in separate fresh browsers", async () => {
  {
    const frontend = "hypermedia";
    const report = await benchmark(
      benchmarkOptions(["--frontend", frontend, "--entries", "5", "--runs", "2", "--memory"]),
    );
    assert.equal(report.workload.entries, 5);
    assert.equal(report.workload.completeToolTurns, 1);
    assert.equal(report.workload.trailingEntries, 2);
    assert.equal(report.runs.length, 2);
    assert(report.memory);
    assert.equal(report.memory.separateRuns, true);
    assert.equal(report.memory.timingsIncludedInRuns, false);
    assert.equal(report.memory.forcedGC, true);
    assert.equal(report.memory.runs.length, 2);
    for (const run of report.memory.runs) {
      assert.deepEqual(
        run.samples.map((sample) => sample.phase),
        ["empty", "initial", "settled"],
      );
      assert.equal(run.samples[0].transcriptElements, 0);
      for (const sample of run.samples) {
        assert(sample.usedSize > 0 && sample.totalSize >= sample.usedSize);
        for (const value of [
          sample.embedderHeapUsedSize,
          sample.backingStorageSize,
          sample.documents,
          sample.nodes,
          sample.jsEventListeners,
          sample.transcriptElements,
        ])
          assert(Number.isFinite(value) && value >= 0);
      }
      for (const sample of run.samples.slice(1)) {
        assert.equal(sample.transcriptElements, report.runs[0].initialDomElements);
        assert(sample.nodes >= sample.transcriptElements);
      }
    }
    assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
  }
});

await test("mobile browser page profiling saves separate per-phase CPU and timeline data", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "serve-profile-test-"));
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

await test("server reads HOST/PORT and starts with no local execution target", async (t) => {
  for (const host of [undefined, "127.0.0.2"]) {
    await t.test(host ?? "default host", async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "serve-startup-"));
      t.after(() => rm(directory, { recursive: true, force: true }));
      const address = host ?? "127.0.0.1";
      const reservation = createServer();
      await new Promise<void>((resolve) => reservation.listen(0, address, resolve));
      const port = (reservation.address() as AddressInfo).port;
      await new Promise<void>((resolve) => reservation.close(() => resolve()));
      const browser = await chromium.launch({ executablePath: chromiumExecutable() });
      t.after(() => browser.close());
      const page = await browser.newPage({ javaScriptEnabled: false });
      const child = spawn(
        process.execPath,
        [
          // The fixture has an empty inventory; use a fixed instance-owner identity.
          "--import",
          'data:text/javascript,import { mock } from "node:test"; mock.method(process, "getuid", () => 1000);',
          fileURLToPath(new URL("../server.ts", import.meta.url)),
        ],
        {
          env: {
            ...process.env,
            HOST: host,
            PORT: String(port),
            HOME: directory,
            XDG_STATE_HOME: join(directory, "state"),
            PATH: "",
            PI_OFFLINE: "1",
            PI_CODING_AGENT_DIR: join(directory, "agent"),
          },
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      await checkCLI(
        child,
        `http://${address}:${port}/htmx/`,
        (response) => response.text(),
        async (html) => {
          await page.setContent(html);
          assert.equal(await page.locator("#session-list").count(), 1);
          assert.equal(await page.locator("#session-list a").count(), 0);
          assert.equal(await page.locator("#targets").count(), 1);
          assert.equal(await page.locator("#targets option").count(), 0);
          assert.equal(await page.locator("#create").isDisabled(), true);
        },
      );
    });
  }
});

for (const frontend of ["elm", "htmx"] as const)
  await test(`${frontend}: landing creation retry after reload retains options and input identity`, async (t) => {
    const f = await fixture(t);
    f.faux.setResponses([fauxAssistantMessage("Created once.")]);
    const b = await browserFixture(t, f.sessions);
    const path = frontend === "elm" ? "/elm" : "/htmx/";
    await b.page.goto(b.base + path);
    await b.page.locator("#new-options summary").click();
    await b.page.locator('select[name="thinkingLevel"]').selectOption("high");
    await b.page.locator("#new-options summary").click();
    await b.page.locator("#prompt").fill("Create exactly once");
    await b.page.route(b.base + path, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await route.fetch({ maxRedirects: 0 });
      await route.abort("connectionreset");
    });
    await b.page.locator("#create").click();
    await b.page.locator("#request-error:not(:empty)").waitFor();
    assert.equal((await f.sessions.catalog()).sessions.length, 1);
    await b.page.unrouteAll({ behavior: "wait" });
    await b.page.reload();
    await b.page.waitForFunction(
      () => document.querySelector<HTMLTextAreaElement>("#prompt")?.value === "Create exactly once",
    );
    assert.equal(await b.page.locator('select[name="thinkingLevel"]').inputValue(), "high");
    await b.page.locator("#create").click();
    await b.page.waitForURL(new RegExp(`/${frontend}/sessions/.*/conversations/`));
    const catalog = await f.sessions.catalog();
    assert.equal(catalog.sessions.length, 1);
    const session = await f.sessions.get(catalog.sessions[0].id);
    await session.root.waitForIdle(BACKGROUND_CONTEXT);
    assert.equal((await sessionInfo(session, session.root)).thinkingLevel, "high");
    assert.equal(
      (await readHistory(session.root)).filter((entry) => entry.kind === "pi.user").length,
      1,
    );
    assert.equal(f.faux.state.callCount, 1);
    assert.deepEqual(b.errors, []);
  });

await test("Elm default model reselection preserves saved thinking overrides", async (t) => {
  const f = await fixture(t);
  const plain = { provider: "plain", modelId: "plain" };
  f.options.models.setProvider(
    fauxProvider({ provider: plain.provider, models: [{ id: plain.modelId, reasoning: false }] })
      .provider,
  );
  const settings = new GlobalSettingsStore(
    SettingsManager.inMemory({ defaultProvider: model.provider, defaultModel: model.modelId }),
  );
  const b = await browserFixture(t, f.sessions, undefined, undefined, settings);
  b.page.setDefaultTimeout(10000);
  await b.page.goto(b.base + "/elm/settings");
  const selected = b.page.locator('[name="model"]');
  const thinking = b.page.locator('[name="modelThinkingLevel"]');
  const key = `${model.provider}/${model.modelId}`;
  for (const level of ["high", ""]) {
    await thinking.selectOption(level);
    await waitFor(async () => settings.read().modelThinkingLevels[key] === (level || undefined));
    await selected.selectOption(JSON.stringify([plain.provider, plain.modelId]));
    await waitFor(async () => settings.read().model?.provider === plain.provider);
    await selected.selectOption(JSON.stringify([model.provider, model.modelId]));
    await waitFor(async () => settings.read().model?.provider === model.provider);
    assert.equal(await thinking.inputValue(), level);
    assert.equal(settings.read().modelThinkingLevels[key], level || undefined);
  }
  const accepted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  await b.page.route(b.base + "/elm/settings", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    accepted.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  await thinking.selectOption("high");
  await accepted.promise;
  await selected.selectOption(JSON.stringify([plain.provider, plain.modelId]));
  await selected.selectOption(JSON.stringify([model.provider, model.modelId]));
  assert.equal(await thinking.inputValue(), "high");
  release.resolve();
  await b.page.waitForFunction(
    () => document.querySelector(".save-status")?.textContent === "Saved",
  );
  assert.equal(settings.read().modelThinkingLevels[key], "high");
  assert.deepEqual(b.errors, []);
});
