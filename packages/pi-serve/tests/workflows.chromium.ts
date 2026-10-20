import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { chromium, type Page } from "playwright";
import { fixture, waitFor } from "../../pi-runtime/testing.ts";
import type { AskRequest } from "../../pi-runtime/workflows.ts";
import {
  chromiumExecutable,
  serve,
  workflowQuestions as questions,
  workflowReport as report,
} from "./testing.ts";
import { buildAssets } from "../build.ts";

const context = BACKGROUND_CONTEXT;

await test(
  "mobile browser native questions and review work end to end",
  { timeout: 90000 },
  async (t) => {
    const f = await fixture(t);
    const assets = await mkdtemp(join(tmpdir(), "ask-review-assets-"));
    t.after(() => rm(assets, { recursive: true, force: true }));
    await buildAssets(dirname(dirname(fileURLToPath(import.meta.url))), assets);
    const base = await serve(t, f.sessions, assets);
    const browser = await chromium.launch({ executablePath: chromiumExecutable() });
    t.after(() => browser.close());
    const desktop = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await desktop.newPage();
    const phone = await mobile.newPage();
    const errors: Error[] = [];
    page.on("pageerror", (error) => errors.push(error));
    phone.on("pageerror", (error) => errors.push(error));
    const shots = process.env.PI_SCREENSHOT_DIR;
    if (shots) await mkdir(shots, { recursive: true });
    async function shot(page: Page, name: string) {
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
        "No horizontal viewport overflow",
      );
      if (shots) await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true });
    }
    const session = await f.create();
    await session.rename("Preferences service");
    await writeFile(join(f.workspace, "preferences.ts"), "export const preferences = {};\n");
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("ask_user", questions), { stopReason: "toolUse" }),
      fauxAssistantMessage("I will use SQLite and run the requested checks."),
    ]);
    await session.prompt("Choose the preferences implementation before coding.", randomUUID());
    await waitFor(async () => (await session.workflows()).asks.length === 1);
    const url = `${base}/?session=${session.id}`;
    await page.goto(url);
    await phone.goto(url);
    await page.waitForSelector(".ask-panel[open]");
    await phone.waitForSelector(".ask-panel[open]");
    assert.equal(
      await page.locator(".ask-panel input:checked").count(),
      0,
      "Recommendations are not selections",
    );
    await page.locator(".ask-panel > summary").click();
    assert.equal((await session.workflows()).asks[0].actionable, true);
    await page.locator(".ask-panel > summary").click();
    await page.locator('.ask-panel input[value="sqlite"]').focus();
    await page.keyboard.press("Space");
    await page.locator('.ask-panel input[value="unit"]').check();
    await page.locator('.ask-panel input[value="browser"]').check();
    await page
      .getByLabel("Your answer · Verification", { exact: true })
      .fill("Also run the type checker");
    await page.getByText("Note on JSON file", { exact: true }).first().click();
    await page
      .getByLabel("Note on JSON file", { exact: true })
      .fill("Explain the concurrency tradeoff");
    await page.locator(".ask-panel").evaluate((panel) => panel.scrollIntoView({ block: "start" }));
    await shot(page, "ask-desktop");
    await phone.locator(".ask-panel").evaluate((panel) => panel.scrollIntoView({ block: "start" }));
    await shot(phone, "ask-mobile");
    await phone.getByLabel("Your answer · Storage", { exact: true }).fill("Unsaved phone draft");
    await phone.reload();
    await phone.waitForSelector(".ask-panel[open]");
    assert.equal(await phone.getByLabel("Your answer · Storage", { exact: true }).inputValue(), "");
    await desktop.setOffline(true);
    await page.waitForFunction(
      () => document.querySelector<HTMLFieldSetElement>(".ask-panel form > fieldset")?.disabled,
    );
    await desktop.setOffline(false);
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLFieldSetElement>(".ask-panel form > fieldset")?.disabled ===
        false,
    );
    assert.equal((await session.workflows()).asks[0].actionable, true);
    // Reconnect restores committed questions, not browser drafts.
    await page.locator('.ask-panel input[value="sqlite"]').check();
    await page.locator('.ask-panel input[value="unit"]').check();
    await page.locator('.ask-panel input[value="browser"]').check();
    await page
      .getByLabel("Your answer · Verification", { exact: true })
      .fill("Also run the type checker");
    await page.getByRole("button", { name: "Review answers", exact: true }).click();
    await page.locator(".answer-confirmation").scrollIntoViewIfNeeded();
    await shot(page, "ask-confirm-desktop");
    await page.getByRole("button", { name: "Submit answers", exact: true }).click();
    await session.root.waitForIdle(context);
    const response = (await session.workflows()).asks[0].response!;
    assert.deepEqual(
      response.answers.map((answer) => answer.selected),
      [["sqlite"], ["unit", "browser"]],
    );
    assert.deepEqual(response.answers[0].optionNotes, []);
    assert.equal(response.answers[1].text, "Also run the type checker");
    await phone.waitForSelector(".ask-panel:not([open])");

    // Model-supplied preview text is never executable HTML. Elaboration keeps unselected notes.
    const unsafe: AskRequest = {
      questions: [
        {
          id: "unsafe",
          prompt: "Inspect this literal preview",
          type: "single",
          preview: true,
          options: [
            {
              value: "html",
              label: "Literal HTML",
              preview: '<img src=x onerror="window.injected=true">',
            },
          ],
        },
      ],
    };
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("ask_user", unsafe), { stopReason: "toolUse" }),
      fauxAssistantMessage("Explanation supplied."),
    ]);
    await session.prompt("Clarify the preview.", randomUUID());
    await phone.waitForSelector('.ask-panel[open] [data-question="unsafe"]');
    assert.equal(await phone.locator(".ask-preview img").count(), 0);
    await phone
      .locator(".ask-panel[open] summary")
      .filter({ hasText: "Note on Literal HTML" })
      .click();
    await phone.getByLabel("Note on Literal HTML", { exact: true }).fill("Explain this option.");
    await phone.getByRole("button", { name: "Review answers", exact: true }).click();
    await phone.locator(".answer-confirmation:visible").scrollIntoViewIfNeeded();
    await shot(phone, "ask-elaboration-mobile");
    await phone.getByRole("button", { name: "Request elaboration", exact: true }).click();
    await session.root.waitForIdle(context);
    assert.equal((await session.workflows()).asks.at(-1)!.response?.action, "elaborate");
    assert.deepEqual((await session.workflows()).asks.at(-1)!.response?.answers[0].optionNotes, [
      { value: "html", note: "Explain this option." },
    ]);

    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("ask_user", unsafe), { stopReason: "toolUse" }),
      fauxAssistantMessage("Cancelled; no answer inferred."),
    ]);
    await session.prompt("Ask once more.", randomUUID());
    await phone.waitForSelector('.ask-panel[open] [data-question="unsafe"]');
    await phone.getByRole("button", { name: "Cancel question", exact: true }).click();
    await session.root.waitForIdle(context);
    assert.deepEqual((await session.workflows()).asks.at(-1)!.response, {
      action: "cancel",
      answers: [],
    });

    // Start from the command surface; target selection is handled by the real HTTP/runtime path.
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("submit_review", report), { stopReason: "toolUse" }),
    ]);
    await page.fill("#prompt", "/review");
    await page.click("#send");
    await page.waitForSelector("#review-setup[open]");
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.click("#footer-model");
    await page.waitForSelector("#preferences:visible");
    await page.click("#review-start");
    await page.waitForSelector("#review-setup[open]");
    assert.equal(await page.locator("#transcript").isVisible(), true);
    await page.selectOption("#review-target", "paths");
    await page.fill("#review-paths", "preferences.ts");
    await page.fill(
      "#review-instructions",
      "Prioritize correctness and keep the implementation small.",
    );
    await shot(page, "review-setup-desktop");
    await page.click("#review-submit");
    await page.waitForSelector(".review-finding");
    const reviewerId = Number(new URL(page.url()).searchParams.get("conversation"));
    const reviewer = await session.conversation(reviewerId);
    await reviewer.waitForIdle(context);
    await page.locator(".review-panel").scrollIntoViewIfNeeded();
    await shot(page, "review-desktop");
    await phone.goto(page.url());
    await phone.waitForSelector(".review-finding");
    await phone
      .locator(".review-panel")
      .evaluate((panel) => panel.scrollIntoView({ block: "start" }));
    await shot(phone, "review-mobile");
    assert.equal(
      await page.getByRole("button", { name: "Fix selected findings", exact: true }).isDisabled(),
      true,
    );
    const beforeHandoff = f.faux.state.callCount;
    await phone.getByRole("button", { name: "Handoff report", exact: true }).click();
    await phone.waitForURL(
      (url) => Number(url.searchParams.get("conversation")) === session.root.id,
    );
    assert.equal(f.faux.state.callCount, beforeHandoff);
    assert.equal(
      (await session.history()).filter((entry) => entry.kind === "app.review").length,
      1,
    );
    await page.locator('.review-finding input[value="updates"]').check();
    f.faux.setResponses([fauxAssistantMessage("Implemented and verified the selected finding.")]);
    await page.getByRole("button", { name: "Fix selected findings", exact: true }).click();
    await page.waitForURL(
      (url) => Number(url.searchParams.get("conversation")) === session.root.id,
    );
    await session.root.waitForIdle(context);
    const fixes = (await session.history()).filter((entry) => entry.kind === "app.review-fix");
    assert.equal(fixes.length, 1);
    assert.deepEqual(fixes[0].data, {
      reviewer: reviewerId,
      report: { ...report, findings: [report.findings[0]] },
    });
    assert.equal(f.faux.state.callCount, beforeHandoff + 1);
    await page.goto(`${base}/?session=${session.id}&conversation=${reviewerId}`);
    await page.waitForSelector(".review-panel");
    await page.fill("#prompt", "/end-review");
    await page.click("#send");
    await page.click("#footer-model");
    await page.waitForSelector("#preferences:visible");
    await page.click("#review-end");
    await page.waitForSelector("#transcript:visible");
    await page.getByRole("button", { name: "Return to origin", exact: true }).click();
    await page.waitForURL(
      (url) => Number(url.searchParams.get("conversation")) === session.root.id,
    );
    assert.deepEqual(errors, []);
  },
);
