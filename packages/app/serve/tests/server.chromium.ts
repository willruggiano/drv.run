import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { directoryFixture } from "./testing.ts";
import { benchmark, benchmarkOptions } from "../benchmark.ts";
import { conversationURL } from "../presentation.ts";
import { fixture, readHistory, waitFor, model } from "./sessions-testing.ts";
import { rename, sessionInfo } from "../sessions.ts";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { GlobalSettingsStore } from "../server.ts";
import { settingFields } from "../settings.ts";
import { browserFixture } from "./browser-testing.ts";

await test("the frontend uses only the shared stylesheet", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const b = await browserFixture(t, f.sessions);

  await b.page.goto(b.base + conversationURL(session));
  await b.page.locator("#prompt").waitFor();
  assert.deepEqual(
    await b.page.evaluate(() =>
      Array.from(document.styleSheets, (sheet) => sheet.href && new URL(sheet.href).pathname),
    ),
    ["/styles.css"],
  );

  assert.deepEqual(b.errors, []);
});

await test("global and session settings share one container and autosave form without status output", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const b = await browserFixture(
    t,
    f.sessions,
    undefined,
    undefined,
    new GlobalSettingsStore({ model }),
  );

  for (const scope of ["global", "session"] as const) {
    const root = scope === "global" ? "" : conversationURL(session);
    await b.page.goto(`${b.base}${root}/settings`);
    const settings = b.page.locator("#settings");
    const form = settings.locator("form[data-autosave]");
    await form.waitFor();
    assert.equal(await settings.count(), 1);
    assert.equal(await form.count(), 1);
    assert.equal(
      await settings.getAttribute("data-layout"),
      scope === "session" ? "stacked" : null,
    );
    assert.equal(await form.getAttribute("aria-busy"), "false");
    assert.equal(await form.locator("output, [role=status]").count(), 0);
    assert.equal(
      await settings.getByRole("button", { name: "Save defaults", exact: true }).count(),
      0,
    );
    assert.equal(await settings.locator("#install, #update").count(), 0);
    if (b.screenshots) {
      if (scope === "global") await b.page.locator("push-settings").scrollIntoViewIfNeeded();
      await b.page.screenshot({ path: join(b.screenshots, `elm-${scope}-settings.png`) });
    }
  }

  assert.deepEqual(b.errors, []);
});

await test(`elm: settings toggles persist, support keyboards and use composer colors`, async (t) => {
  const f = await fixture(t);
  const settings = new GlobalSettingsStore({ model });
  const b = await browserFixture(t, f.sessions, undefined, undefined, settings);
  const { page } = b;
  await page.goto(`${b.base}/`);
  const primary = await page.locator("#create").evaluate((node) => {
    const style = getComputedStyle(node);
    return { background: style.backgroundColor, foreground: style.color };
  });
  await page.getByRole("link", { name: "Global settings", exact: true }).click();
  await page.locator("#settings form[data-autosave]").waitFor();
  const booleans = settingFields.filter((field) => "type" in field && field.type === "boolean");
  for (const field of booleans) {
    const toggle = page.getByRole("radiogroup", { name: field.label, exact: true });
    const off = toggle.getByRole("radio", { name: "Off", exact: true });
    const on = toggle.getByRole("radio", { name: "On", exact: true });
    assert.equal(await on.isChecked(), settings.read().values[field.key]);
    await off.focus();
    await off.press("Space");
    await waitFor(async () => settings.read().values[field.key] === false);
    assert.equal(await off.isChecked(), true);
    assert.notEqual(
      await toggle
        .locator("input:checked + span")
        .evaluate((node) => getComputedStyle(node).backgroundColor),
      primary.background,
    );
    await off.press("ArrowRight");
    await waitFor(async () => settings.read().values[field.key] === true);
    assert.equal(await on.isChecked(), true);
    const selected = await toggle.locator("input:checked + span").evaluate((node) => {
      const style = getComputedStyle(node);
      return { background: style.backgroundColor, foreground: style.color };
    });
    assert.deepEqual(selected, primary);
    assert.deepEqual(
      await toggle.evaluate((node) => {
        const bounds = node.getBoundingClientRect();
        return {
          width: bounds.width,
          height: bounds.height,
          segments: Array.from(node.querySelectorAll(".toggle-option > span"), (segment) => {
            const rect = segment.getBoundingClientRect();
            return [rect.left - bounds.left, rect.top - bounds.top, rect.width, rect.height];
          }),
        };
      }),
      {
        width: 88,
        height: 28,
        segments: [
          [0, 0, 44, 28],
          [44, 0, 44, 28],
        ],
      },
    );
    assert.deepEqual(
      await page
        .locator("#settings form[data-autosave]")
        .evaluate((form, key) => new FormData(form as HTMLFormElement).getAll(key), field.key),
      ["true"],
    );
  }
  const wrap = page.getByRole("radiogroup", { name: "Wrap code", exact: true });
  const align = page.getByRole("radiogroup", { name: "Bottom-align messages", exact: true });
  await wrap.getByRole("radio", { name: "On", exact: true }).check();
  await align.getByRole("radio", { name: "Off", exact: true }).check();
  assert.deepEqual(
    await page.evaluate(() => ({
      wrap: document.body.classList.contains("wrap-code"),
      bottom: document.body.classList.contains("bottom-align"),
      storedWrap: localStorage.getItem("pi.html.wrap-code"),
      storedBottom: localStorage.getItem("pi.bottomAlign"),
    })),
    { wrap: true, bottom: false, storedWrap: "true", storedBottom: "false" },
  );
  await page.reload();
  await page.locator("#settings form[data-autosave]").waitFor();
  for (const field of booleans)
    assert.equal(
      await page
        .getByRole("radiogroup", { name: field.label, exact: true })
        .getByRole("radio", { name: "On", exact: true })
        .isChecked(),
      true,
    );
  assert.equal(await wrap.getByRole("radio", { name: "On", exact: true }).isChecked(), true);
  assert.equal(await align.getByRole("radio", { name: "Off", exact: true }).isChecked(), true);
  const centers = await page.locator(".toggle-option > span").evaluateAll((labels) =>
    labels.map((label) => {
      const bounds = label.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(label);
      const text = range.getBoundingClientRect();
      return {
        width: text.width,
        height: text.height,
        x: text.left + text.width / 2 - (bounds.left + bounds.width / 2),
        y: text.top + text.height / 2 - (bounds.top + bounds.height / 2),
      };
    }),
  );
  assert.equal(centers.length, 2 * (booleans.length + 3));
  for (const center of centers) {
    assert.ok(center.width > 0 && center.height > 0);
    assert.ok(Math.abs(center.x) <= 1, `Horizontal center offset: ${center.x}px`);
    assert.ok(Math.abs(center.y) <= 1, `Vertical center offset: ${center.y}px`);
  }
  if (b.screenshots) {
    await align.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(b.screenshots, `elm-settings-toggles.png`) });
  }

  assert.deepEqual(b.errors, []);
});

await test("command completions align descriptions and use the muted color in the frontend", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const b = await browserFixture(t, f.sessions);
  for (const width of [390, 1000]) {
    await b.page.setViewportSize({ width, height: 844 });

    for (const path of [`/`, conversationURL(session)]) {
      await b.page.goto(b.base + path);
      await b.page.locator("#prompt").fill("/");
      await b.page.locator('#completions [role="option"]').first().waitFor();
      const rows = await b.page.locator('#completions [role="option"]').evaluateAll((options) => {
        const probe = document.createElement("span");
        probe.style.color = "var(--muted)";
        document.body.append(probe);
        const muted = getComputedStyle(probe).color;
        probe.remove();
        return options.map((option) => {
          const label = option.firstElementChild!;
          const description = option.querySelector(".completion-description")!;
          const labelBounds = label.getBoundingClientRect();
          const descriptionBounds = description.getBoundingClientRect();
          return {
            labelX: labelBounds.x,
            labelRight: labelBounds.right,
            descriptionX: descriptionBounds.x,
            fits: descriptionBounds.right <= option.getBoundingClientRect().right,
            muted: getComputedStyle(description).color === muted,
            normal: getComputedStyle(label).color === getComputedStyle(option).color,
          };
        });
      });
      assert.ok(rows.length > 1);
      for (const row of rows) {
        assert.equal(row.labelX, rows[0].labelX);
        assert.equal(row.descriptionX, rows[0].descriptionX);
        assert.ok(row.labelRight < row.descriptionX);
        assert.ok(row.fits);
        assert.ok(row.muted);
        assert.ok(row.normal);
      }
    }
  }
  assert.deepEqual(b.errors, []);
});

await test("the frontend confirms context commands with two keyboard submissions without losing input focus", async (t) => {
  const f = await fixture(t);
  await f.reopen({ settings: { compaction: { keepRecentTokens: 1 } } });
  const b = await browserFixture(t, f.sessions);
  b.page.setDefaultTimeout(10000);
  for (const command of ["reset", "compact"] as const)
    for (const shortcut of ["Control+Enter", "Meta+Enter"])
      for (const handoff of ["", "Preserve the handoff."])
        await t.test(`elm: ${command}, ${shortcut}, argument=${Boolean(handoff)}`, async () => {
          const session = await f.create();
          if (command === "compact") {
            f.faux.setResponses([
              fauxAssistantMessage("First response"),
              fauxAssistantMessage("Second response"),
            ]);
            for (const content of ["First ".repeat(1000), "Second ".repeat(1000)])
              await (
                await session.root.submit({ type: "input", content }, BACKGROUND_CONTEXT)
              ).wait(BACKGROUND_CONTEXT);
            f.faux.setResponses([fauxAssistantMessage("Summary of the completed work")]);
          }
          await b.page.goto(b.base + conversationURL(session));
          const prompt = b.page.locator("#prompt");
          await prompt.fill(`/${command}${handoff ? ` ${handoff}` : ""}`);
          if (!handoff) await b.page.locator('#completions [role="option"]').waitFor();
          const before = await readHistory(session.root);
          await b.page.keyboard.press(shortcut);
          await b.page
            .getByRole("button", {
              name: command === "reset" ? "Confirm reset" : "Confirm compaction",
            })
            .waitFor();
          await b.page.waitForFunction(() => document.activeElement?.id === "prompt");
          assert.equal(await prompt.inputValue(), handoff);
          assert.deepEqual(await readHistory(session.root), before);
          await b.page.keyboard.press(shortcut);
          await b.page
            .locator(`[data-context="${command === "reset" ? "pi.reset" : "pi.compaction"}"]`)
            .waitFor();
          const after = await readHistory(session.root);
          assert.equal(after.length, before.length + 1);
          assert.equal(after.at(-1)?.kind, command === "reset" ? "pi.reset" : "pi.compaction");
        });
  assert.deepEqual(b.errors, []);
});

await test("landing composer matches conversation summaries and geometry without context statistics", async (t) => {
  const f = await directoryFixture(t);
  await mkdir(join(f.workspace, "drv.run"));
  const reference = await f.sessions.create(randomUUID(), f.binding, model);
  await rename(reference, "Review changes");
  const b = await browserFixture(t, f.sessions);

  for (const hasTouch of [true, false]) {
    await t.test(`elm: ${hasTouch ? "touch" : "mouse"}`, async () => {
      const browserContext = await b.browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: hasTouch,
        hasTouch,
      });
      t.after(() => browserContext.close());
      const page = await browserContext.newPage();
      page.on("pageerror", (error) => b.errors.push(error));
      const conversation = await browserContext.newPage();
      conversation.on("pageerror", (error) => b.errors.push(error));
      await conversation.goto(b.base + conversationURL(reference, undefined));
      await conversation.locator("#prompt").fill("Review the current changes");
      // Compare the conversation composer with only its context statistics omitted.
      await conversation.addStyleTag({
        content:
          "#footer-stats, #footer-context, .footer-model-context > .footer-dot { display: none !important; } .footer-model-context { grid-row: 1 !important; }",
      });
      await page.goto(`${b.base}/`);
      const models = page.getByRole("combobox", { name: "Model", exact: true });
      const thinking = page.getByRole("combobox", { name: "Thinking", exact: true });
      const environment = page.getByRole("combobox", { name: "Environment", exact: true });
      const directory = page.getByRole("combobox", { name: "Base directory", exact: true });
      // Environment and cwd remain editable on mobile, before a session exists.
      await environment.selectOption(JSON.stringify(["local", f.workspace]));
      await environment.selectOption(JSON.stringify([f.binding.provider, f.binding.target]));
      await directory.fill("drv.run");
      await directory.blur();
      assert.equal(await directory.inputValue(), "drv.run");
      await directory.fill("");
      await directory.blur();
      await models.selectOption(JSON.stringify([model.provider, model.modelId]));
      await page.waitForFunction(
        () => document.querySelector<HTMLSelectElement>("#thinking")?.selectedOptions.length === 1,
      );
      assert.equal(await thinking.inputValue(), "");
      // Closed controls use the same summaries; native menus retain the full labels.
      for (const [selector, value] of [
        ["#footer-model .model-name .selector-value", model.modelId],
        [
          "#footer-model .model-effort .selector-value",
          (await sessionInfo(reference)).thinkingLevel,
        ],
        ["#footer-instance label:first-child .selector-value", f.binding.target],
      ])
        assert.equal(await page.locator(selector).textContent(), value);
      assert.match((await models.locator("option:checked").textContent()) ?? "", /^faux \/ /);
      assert.match((await thinking.locator("option:checked").textContent()) ?? "", /^Default \(/);
      assert.equal(
        await page.locator("#footer-instance label:last-child .selector-value").textContent(),
        f.binding.cwd,
      );
      await page.locator("#prompt").fill("Review the current changes");
      for (const width of [320, 390, 650, 651, 1440]) {
        await page.setViewportSize({ width, height: 844 });
        await conversation.setViewportSize({ width, height: 844 });
        // ResizeObserver schedules textarea measurement on the next animation frame.
        for (const view of [page, conversation])
          await view.evaluate(
            () =>
              new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
              ),
          );
        for (const selector of [
          "#composer-shell .compose-box",
          "#prompt",
          "#input-toggle",
          "#submit",
          "#footer-model",
          "#footer-model .model-name",
          "#footer-model .model-effort",
        ]) {
          const geometry = (node: Element) => {
            const bounds = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            return {
              x: bounds.x,
              width: bounds.width,
              height: bounds.height,
              padding: style.padding,
              font: {
                family: style.fontFamily,
                size: style.fontSize,
                weight: style.fontWeight,
                lineHeight: style.lineHeight,
              },
              background: style.backgroundColor,
              borderRadius: style.borderRadius,
            };
          };
          const actual = await page
            .locator(
              selector === "#submit"
                ? "#create"
                : selector.startsWith("#footer-model .")
                  ? `${selector} .selector-value`
                  : selector,
            )
            .evaluate(geometry);
          const expected = await conversation
            .locator(selector === "#submit" ? "#send" : selector)
            .evaluate(geometry);
          if (width <= 650 && selector.startsWith("#footer-model")) {
            // Landing settings flank a fixed center dot, not a centered text group.
            assert.deepEqual(
              { ...actual, x: expected.x, width: expected.width },
              expected,
              `${selector} at ${width}px`,
            );
          } else {
            assert.deepEqual(actual, expected, `${selector} at ${width}px`);
          }
        }
        for (const control of [models, thinking, environment, directory])
          assert.equal(await control.isVisible(), true);
        const box = await page.locator("#composer-shell .compose-box").boundingBox();
        const selectedModel = await models.boundingBox();
        const selectedThinking = await thinking.boundingBox();
        assert(box && selectedModel && selectedThinking);
        assert.equal(selectedModel.y, selectedThinking.y);
        assert(selectedModel.y >= box.y + box.height);
        const target = await environment.boundingBox();
        const cwd = await directory.boundingBox();
        assert(target && cwd);
        assert.equal(target.y, cwd.y);
        if (width <= 650) {
          assert(target.y + target.height <= box.y);
          assert(cwd.y + cwd.height <= box.y);
          assert(target.x + target.width <= cwd.x);
          assert(cwd.x + cwd.width <= box.x + box.width);
          const dots = await page
            .locator("#footer-instance .instance-separator, #footer-model > .footer-dot")
            .evaluateAll((nodes) =>
              nodes.map((node) => {
                const bounds = node.getBoundingClientRect();
                return {
                  center: bounds.x + bounds.width / 2,
                  width: bounds.width,
                  height: bounds.height,
                };
              }),
            );
          assert.equal(dots.length, 2);
          for (const dot of dots) {
            assert.deepEqual(dot, { center: box.x + box.width / 2, width: 2, height: 2 });
          }
          assert.equal(target.x + target.width, selectedModel.x + selectedModel.width);
          assert.equal(cwd.x, selectedThinking.x);
        } else {
          const instance = await conversation.locator("#footer-instance").boundingBox();
          assert(instance);
          assert.equal(target.x, instance.x);
          assert(target.x + target.width <= cwd.x);
          assert(cwd.x + cwd.width <= selectedModel.x);
        }
        // The metadata starts at the same offset below the shared compose box.
        const offset = async (view: typeof page) =>
          view.evaluate(() => {
            const box = document.querySelector(".compose-box")!.getBoundingClientRect();
            const model = document.querySelector("#footer-model")!.getBoundingClientRect();
            return model.y - box.bottom;
          });
        assert.equal(await offset(page), await offset(conversation));
        assert.equal(
          await page
            .locator("#app-footer .context-usage, #footer-stats, #new-options summary")
            .count(),
          0,
        );
        assert.equal(await page.locator("#create .glyph").count(), 1);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        const settings = await page
          .getByRole("link", { name: "Global settings", exact: true })
          .boundingBox();
        assert(settings && settings.y >= 16);
        if (b.screenshots && ((width === 390 && hasTouch) || (width === 1440 && !hasTouch))) {
          await page.locator("#prompt").blur();
          await page.screenshot({
            path: join(b.screenshots, `elm-landing-${width}.png`),
          });
          await conversation.locator("#prompt").blur();
          await conversation.screenshot({
            path: join(b.screenshots, `elm-conversation-${width}.png`),
          });
        }
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await thinking.selectOption("high");
      assert.equal(
        await page.locator("#footer-model .model-effort .selector-value").textContent(),
        "high",
      );
      await directory.fill("drv.run");
      await directory.blur();
      assert.equal(
        await page.locator("#footer-instance label:last-child .selector-value").textContent(),
        join(f.binding.cwd, "drv.run"),
      );
      await page.reload();
      await page.waitForFunction(
        () => document.querySelector<HTMLSelectElement>("#thinking")?.value === "high",
      );
      assert.equal(await directory.inputValue(), "drv.run");
      assert.equal(await models.inputValue(), JSON.stringify([model.provider, model.modelId]));
      f.faux.setResponses([fauxAssistantMessage("Reviewed.")]);
      await page.getByRole("button", { name: "Create session", exact: true }).click();
      await page.waitForURL(new RegExp(`/sessions/.*/conversations/`));
      const session = await f.sessions.get(new URL(page.url()).pathname.split("/")[2]);
      await session.root.waitForIdle(BACKGROUND_CONTEXT);
      const info = await sessionInfo(session);
      assert.deepEqual(info.model, model);
      assert.equal(info.thinkingLevel, "high");
      assert.equal(info.cwd, join(f.workspace, "drv.run"));
    });
  }

  assert.deepEqual(b.errors, []);
});

await test("the landing creates, reopens and archives sessions", async (t) => {
  const f = await fixture(t);
  const settings = new GlobalSettingsStore({ model });
  const b = await browserFixture(t, f.sessions, undefined, undefined, settings);
  b.page.setDefaultTimeout(10000);
  const root = await b.page.goto(b.base);
  assert.equal(root?.status(), 200);
  await b.page.locator("#landing").waitFor();
  for (let i = 0; i < 7; i++) await rename(await f.create(), `Session ${i}`);

  const page = await b.browserContext.newPage();
  t.after(() => page.close());
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => b.errors.push(error));
  const landing = "/";
  await page.goto(b.base + landing);
  await page.locator("#session-list a").first().waitFor();
  assert.equal(await page.locator("#session-list a").count(), 5);
  const catalog = await f.sessions.catalog();
  assert.deepEqual(
    await page
      .locator("#session-list a")
      .evaluateAll((nodes) =>
        nodes.map((node) => new URL((node as HTMLAnchorElement).href).pathname.split("/")[2]),
      ),
    catalog.sessions.slice(0, 5).map((item) => item.id),
  );
  assert.equal(await page.locator("#session-filter, #picker").count(), 0);
  assert.equal(await page.locator("#app-header .landing-navigation").count(), 1);
  assert.equal(await page.locator(`a[href="/settings"]`).isVisible(), true);
  assert.equal(await page.locator(`a[href="/activity"]`).count(), 0);
  assert.equal(await page.locator(`a[href="/auth"]`).count(), 0);
  for (const route of ["repository", "history"])
    assert.equal(
      (
        await fetch(
          b.base +
            conversationURL(await f.sessions.get(catalog.sessions[0].id), undefined) +
            "/" +
            route,
        )
      ).status,
      404,
    );
  assert.equal((await fetch(`${b.base}/offline`)).status, 404);
  f.faux.setResponses([fauxAssistantMessage("Created from the landing.")]);
  await page.locator("#prompt").fill("Initial prompt");
  await page.keyboard.press("Control+Enter");
  await page.waitForURL(new RegExp(`/sessions/.*/conversations/`));
  const id = new URL(page.url()).pathname.split("/")[2];
  const session = await f.sessions.get(id);
  await session.root.waitForIdle(BACKGROUND_CONTEXT);
  assert.equal(
    (await readHistory(session.root)).filter((entry) => entry.kind === "pi.user").length,
    1,
  );
  await page.goto(b.base + landing);
  await page.locator(`#session-list a[href="/sessions/${id}"]`).waitFor();
  await page.goto(`${b.base}/settings`);
  await page
    .locator('#settings form[data-autosave] input[name="hideThinkingBlock"][value="true"]')
    .check();
  await waitFor(async () => settings.read().values.hideThinkingBlock === true);
  await page.getByRole("link", { name: "Sessions", exact: true }).click();
  await page.locator("#landing").waitFor();
  await page.getByRole("link", { name: "Global settings", exact: true }).click();
  await page.locator('#github-authorization [data-state="unconfigured"]').waitFor();
  await page.goto(b.base + landing);
  await page.locator(`#session-list a[href="/sessions/${id}"]`).click();
  await page.waitForURL(b.base + conversationURL(session));
  await page.goto(b.base + landing);
  await page.locator("#prompt").fill("Unsent new-session draft");
  for (const operation of ["compact", "reset"]) {
    await page.goto(b.base + conversationURL(session) + "/" + operation);
    await page
      .getByRole("button", {
        name: operation === "reset" ? "Confirm reset" : "Confirm compaction",
      })
      .waitFor();
    assert.equal(await page.locator("#prompt").inputValue(), "");
    await page.locator("#prompt").fill("Retain the important context");
  }
  await page.goto(b.base + landing);
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLTextAreaElement>("#prompt")?.value === "Unsent new-session draft",
  );
  const row = page
    .locator(".session-row")
    .filter({ has: page.locator(`a[href="/sessions/${id}"]`) });
  await row.getByRole("button", { name: "Archive session" }).click();
  await row.waitFor({ state: "detached" });
  assert.equal(
    (await f.sessions.catalog()).sessions.some((item) => item.id === id),
    false,
  );
  assert.equal(await page.locator("#session-list a").count(), 5);
  await settings.update({ values: { hideThinkingBlock: false } }, f.sessions);

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
  const report = await benchmark(benchmarkOptions(["--runs", "1", "--turns", "2"]));
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
});

await test("page benchmark samples exact history sizes and memory in separate fresh browsers", async () => {
  const report = await benchmark(benchmarkOptions(["--entries", "5", "--runs", "2", "--memory"]));
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

await test(`elm: landing creation retry after reload retains options and input identity`, async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([fauxAssistantMessage("Created once.")]);
  const b = await browserFixture(t, f.sessions);
  const path = "/";
  await b.page.goto(b.base + path);
  await b.page.locator('select[name="thinkingLevel"]').selectOption("high");
  await b.page.locator("#prompt").fill("Create exactly once");
  await b.page.route(b.base + path, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fetch({ maxRedirects: 0 });
    await route.abort("connectionreset");
  });
  await b.page.locator("#create").click();
  await b.page.locator("#request-error:not(:empty)").waitFor();
  assert.equal((await f.sessions.catalog()).sessions.length, 1);
  assert.equal(await b.page.locator("#prompt").isDisabled(), true);
  assert.equal(await b.page.locator("#input-toggle").isDisabled(), true);
  assert.equal(await b.page.locator("#create").isEnabled(), true);
  await b.page.unrouteAll({ behavior: "wait" });
  await b.page.reload();
  await b.page.waitForFunction(
    () => document.querySelector<HTMLTextAreaElement>("#prompt")?.value === "Create exactly once",
  );
  assert.equal(await b.page.locator('select[name="thinkingLevel"]').inputValue(), "high");
  await b.page.locator("#create").click();
  await b.page.waitForURL(new RegExp(`/sessions/.*/conversations/`));
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
  const settings = new GlobalSettingsStore({ model });
  const b = await browserFixture(t, f.sessions, undefined, undefined, settings);
  b.page.setDefaultTimeout(10000);
  await b.page.goto(b.base + "/settings");
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
  await b.page.route(b.base + "/settings", async (route) => {
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
    () =>
      document.querySelector("#settings form[data-autosave]")?.getAttribute("aria-busy") ===
      "false",
  );
  assert.equal(settings.read().modelThinkingLevels[key], "high");
  assert.deepEqual(b.errors, []);
});

await test("context confirmations retain drafts on cancel and accept instructions through direct routes", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const b = await browserFixture(t, f.sessions);
  const before = await readHistory(session.root);

  const path = conversationURL(session);
  for (const command of ["reset", "compact"] as const) {
    const label = command === "reset" ? "reset" : "compaction";
    await b.page.goto(b.base + path);
    await b.page.locator("#prompt").fill(`/${command} Retain the important context`);
    await b.page.keyboard.press("Control+Enter");
    await b.page.getByRole("button", { name: `Confirm ${label}` }).waitFor();
    assert.equal(await b.page.locator("#conversation-scroll").isVisible(), true);
    assert.equal(
      await b.page.locator("#composer-shell form #prompt").inputValue(),
      "Retain the important context",
    );
    await b.page.getByRole("link", { name: `Cancel ${label}` }).click();
    await b.page.waitForFunction(
      (expected) => document.querySelector<HTMLTextAreaElement>("#prompt")?.value === expected,
      `/${command} Retain the important context`,
    );
    await b.page.goto(
      `${b.base}${path}/${command}?argument=${encodeURIComponent("Explicit instructions & details")}`,
    );
    await b.page.getByRole("button", { name: `Confirm ${label}` }).waitFor();
    assert.equal(await b.page.locator("#prompt").inputValue(), "Explicit instructions & details");
    await b.page.reload();
    await b.page.getByRole("button", { name: `Confirm ${label}` }).waitFor();
    assert.equal(await b.page.locator("#prompt").inputValue(), "Explicit instructions & details");
    assert.deepEqual(await readHistory(session.root), before);
  }

  assert.deepEqual(b.errors, []);
});
