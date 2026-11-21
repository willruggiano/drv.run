import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test, type TestContext } from "node:test";
import { chromium } from "playwright";
import { CompactionTask, GenerationTask, defineTask } from "@earendil-works/pi-durable";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { context } from "../src/application.ts";
import { decode, SessionId } from "../src/identity.ts";
import { form, sessionsFixture, servePrefixed } from "./fixtures.ts";

async function browserPage(t: TestContext, javaScriptEnabled = true) {
  const browser = await chromium.launch({
    executablePath:
      process.env.CHROMIUM_BINARY ??
      execFileSync("which", ["chromium"], { encoding: "utf8" }).trim(),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  t.after(() => browser.close());
  const page = await browser.newPage({ javaScriptEnabled });
  page.setDefaultTimeout(8000);
  return page;
}

await test(
  "inspection renders native task and submission distinctions; resume is an explicit prefixed form",
  { timeout: 30000 },
  async (t) => {
    const { sessions, auth, selection } = await sessionsFixture(t);
    const base = await servePrefixed(t, sessions, auth, "/pds");
    const app = await sessions.open(decode(SessionId, "λ/execution ' & %"));
    const conversation = await app.root(form(selection));
    const path = `/pds/api/s/${encodeURIComponent(app.id)}`;
    const missing = defineTask({ ...CompactionTask.definition, name: "unavailable.<task>" });
    const newer = defineTask({ ...CompactionTask.definition, version: 99 });
    const older = defineTask({ ...GenerationTask.definition, version: 1 });
    const [blocked, tooNew, pending, migrates, queued, placed] = await conversation.commit(
      async (tx) => {
        const missingId = await tx.createTask(
          missing,
          { reason: "manual" },
          { ownership: { kind: "conversation" }, background: true },
        );
        const newerId = await tx.createTask(
          newer,
          { reason: "manual" },
          { ownership: { kind: "conversation" } },
        );
        const pendingId = await tx.createTask(
          CompactionTask,
          { reason: "manual" },
          { ownership: { kind: "conversation" } },
        );
        const migratingId = await tx.createTask(older, {}, { ownership: { kind: "conversation" } });
        const entry = await tx.appendEntry(conversation.id, { kind: "example.entry" });
        const queuedRecord = await tx.createSubmission({
          type: "input",
          conversationId: conversation.id,
          status: "queued",
          requestId: "<queued>",
        });
        const placedRecord = await tx.createSubmission({
          type: "input",
          conversationId: conversation.id,
          status: "placed",
          entry: entry.id,
        });
        return [missingId, newerId, pendingId, migratingId, queuedRecord, placedRecord] as const;
      },
      context,
    );
    const before = await app.harness.inspect(context);
    const page = await browserPage(t, false);
    const inspected = await page.goto(new URL(`${path}/inspect`, base).href);
    assert.equal(inspected?.status(), 200);
    assert.equal(inspected?.headers()["cache-control"], "no-store");
    assert.equal(await page.locator("#inspection").getAttribute("data-scheduling"), "paused");
    for (const [id, kind, extra, value] of [
      [blocked, "blocked", "reason", "missing_task"],
      [tooNew, "blocked", "reason", "task_too_old"],
      [pending, "pending", "migrates", "false"],
      [migrates, "pending", "migrates", "true"],
    ] as const) {
      const task = page.locator(`[data-task-id="${id}"]`);
      assert.equal(await task.getAttribute("data-state"), kind);
      assert.equal(
        await task.locator(`[data-inspection] [data-field="${extra}"]`).textContent(),
        value,
      );
    }
    assert.equal(
      await page.locator(`[data-task-id="${blocked}"] [data-field="background"]`).textContent(),
      "true",
    );
    assert.equal(
      await page.locator(`[data-submission-id="${queued.id}"]`).getAttribute("data-status"),
      "queued",
    );
    assert.equal(
      await page.locator(`[data-submission-id="${placed.id}"]`).getAttribute("data-status"),
      "placed",
    );
    assert.equal(
      await page
        .locator(`[data-submission-id="${queued.id}"] [data-field="requestId"]`)
        .textContent(),
      "<queued>",
    );
    assert.equal(await page.locator("task, queued").count(), 0);
    assert.deepEqual(await app.harness.inspect(context), before);
    const resume = page.getByRole("button", { name: "Resume scheduling", exact: true });
    assert.equal(await resume.evaluate((button: HTMLButtonElement) => button.form?.method), "post");
    const posted = page.waitForResponse((response) => response.request().method() === "POST");
    await resume.click();
    assert.equal((await posted).status(), 303);
    assert.equal(await page.locator("#execution-result").getAttribute("data-action"), "resume");
    assert.equal(await page.locator("#inspection").getAttribute("data-scheduling"), "running");
    assert.equal(
      await page.locator(`[data-task-id="${blocked}"]`).getAttribute("data-state"),
      "blocked",
    );
  },
);

await test(
  "queued withdrawal works with and without Datastar without clearing a draft or aborting placed work",
  { timeout: 30000 },
  async (t) => {
    for (const enhanced of [false, true])
      await t.test(String(enhanced), async (subtest) => {
        const started = Promise.withResolvers<void>();
        const finish = Promise.withResolvers<void>();
        subtest.after(() => finish.resolve());
        const { sessions, auth, selection, faux } = await sessionsFixture(subtest);
        const base = await servePrefixed(subtest, sessions, auth, "/pds");
        const app = await sessions.open();
        const conversation = await app.root(form(selection));
        faux.setResponses([
          async () => {
            started.resolve();
            await finish.promise;
            return fauxAssistantMessage("Finished");
          },
        ]);
        const placed = await app.submit(conversation, form({ message: "Running" }));
        await started.promise;
        const queued = await app.submit(conversation, form({ message: "Withdraw this" }));
        const page = await browserPage(subtest, enhanced);
        await page.setViewportSize({ width: 390, height: 850 });
        const scope = `/pds/api/s/${app.id}/c/${conversation.id}`;
        await page.goto(new URL(scope, base).href);
        if (enhanced)
          await page.waitForFunction(() =>
            document.getElementById("connection")?.classList.contains("sr-only"),
          );
        const button = page.getByRole("button", {
          name: `Withdraw queued input ${queued}`,
          exact: true,
        });
        const withdrawalBounds = await button.boundingBox();
        const navigationBounds = await page.locator("#conversation-navigation").boundingBox();
        assert(withdrawalBounds && navigationBounds);
        assert(withdrawalBounds.y + withdrawalBounds.height <= navigationBounds.y);
        await page.locator("#message").fill("Unsubmitted draft");
        const posted = page.waitForResponse((response) => response.request().method() === "POST");
        await page
          .getByRole("button", { name: `Withdraw queued input ${queued}`, exact: true })
          .click();
        assert.equal((await posted).status(), enhanced ? 200 : 303);
        await page.locator('#execution-result[data-result="aborted"]').waitFor();
        const result = page.locator("#execution-result");
        assert.equal(await result.getAttribute("data-submission-id"), String(queued));
        assert.equal(await result.getAttribute("data-scope"), scope);
        if (enhanced)
          assert.equal(await page.locator("#message").inputValue(), "Unsubmitted draft");
        assert.equal(
          (await (await app.harness.submission(placed, context))?.status(context))?.status,
          "placed",
        );
        assert(
          (await app.harness.inspect(context)).tasks.every(({ record }) => !record.abortRequested),
        );
        for (const [id, expected] of [
          [placed, "already_placed"],
          [queued, "settled"],
          [999999, "not_found"],
        ] as const) {
          const response = await page.request.post(new URL(`${scope}/abortSubmission`, base).href, {
            form: { id: String(id) },
            maxRedirects: 0,
          });
          assert.equal(response.status(), 303);
          await page.goto(new URL(response.headers().location!, base).href);
          assert.equal(
            await page.locator("#execution-result").getAttribute("data-result"),
            expected,
          );
          assert.equal(
            await page.locator("#execution-result").getAttribute("data-submission-id"),
            String(id),
          );
        }
        finish.resolve();
        await conversation.waitForIdle(context);
      });
  },
);

await test(
  "lost control responses are not replayed and observer loss does not own model execution",
  { timeout: 30000 },
  async (t) => {
    const started = Promise.withResolvers<void>();
    const signalled = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    t.after(() => finish.resolve());
    const { sessions, auth, selection, faux } = await sessionsFixture(t);
    const base = await servePrefixed(t, sessions, auth, "/pds");
    const app = await sessions.open();
    const conversation = await app.root(form(selection));
    let signal: AbortSignal | undefined;
    faux.setResponses([
      async (_messages, options) => {
        signal = options?.signal;
        assert(signal);
        signal.addEventListener("abort", () => signalled.resolve(), { once: true });
        started.resolve();
        await finish.promise;
        return fauxAssistantMessage("Released");
      },
    ]);
    await app.submit(conversation, form({ message: "Running" }));
    await started.promise;
    const scope = `/pds/api/s/${app.id}/c/${conversation.id}`;
    const page = await browserPage(t);
    await page.goto(new URL(scope, base).href);
    await page.waitForFunction(() =>
      document.getElementById("connection")?.classList.contains("sr-only"),
    );
    await page.goto(new URL(`/pds/api/s/${app.id}/inspect`, base).href);
    assert.equal(signal?.aborted, false);
    assert.equal(await page.locator('[data-task-id][data-state="running"]').count(), 1);
    await page.goto(new URL(scope, base).href);
    await page.waitForFunction(() =>
      document.getElementById("connection")?.classList.contains("sr-only"),
    );
    await page.locator("#message").fill("Keep this draft");
    let writes = 0;
    await page.route("**/abort", async (route) => {
      writes++;
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      await route.abort("failed");
    });
    await page.locator("#execution-controls summary").click();
    await page.getByRole("button", { name: "Abort ordinary work", exact: true }).click();
    await signalled.promise;
    assert.equal(await page.locator("#execution-result").getAttribute("data-action"), null);
    finish.resolve();
    await page.waitForFunction(() => document.getElementById("notice")?.textContent !== "");
    assert.equal(await page.locator("#message").inputValue(), "Keep this draft");
    await conversation.waitForIdle(context);
    assert.equal(writes, 1);
    assert.equal(await page.locator("#execution-result").getAttribute("data-action"), null);
    await page.getByRole("link", { name: "Inspect execution", exact: true }).click();
    assert.deepEqual((await app.harness.inspect(context)).tasks, []);
    assert.equal(writes, 1);
  },
);

await test(
  "receipt-page withdrawal and inspection resume acknowledge in place",
  { timeout: 30000 },
  async (t) => {
    const { sessions, auth, selection } = await sessionsFixture(t);
    const base = await servePrefixed(t, sessions, auth, "/pds");
    const app = await sessions.open();
    const conversation = await app.root(form(selection));
    const record = await conversation.commit(
      (tx) =>
        tx.createSubmission({ type: "input", conversationId: conversation.id, status: "queued" }),
      context,
    );
    const page = await browserPage(t);
    const scope = `/pds/api/s/${app.id}/c/${conversation.id}`;
    await page.goto(new URL(`${scope}/submissions/status?id=${record.id}`, base).href);
    await page
      .getByRole("button", { name: `Withdraw queued input ${record.id}`, exact: true })
      .click();
    await page.locator('#execution-result[data-result="aborted"]').waitFor();
    assert.equal(await page.locator("#notice").textContent(), "");
    assert.equal((await app.harness.inspect(context)).scheduling, "paused");
    await page.goto(new URL(`/pds/api/s/${app.id}/inspect`, base).href);
    await page.getByRole("button", { name: "Resume scheduling", exact: true }).click();
    await page.locator('#execution-result[data-action="resume"]').waitFor();
    assert.equal(await page.locator("#notice").textContent(), "");
    assert.equal((await app.harness.inspect(context)).scheduling, "running");
    await page.getByRole("link", { name: "Refresh inspection", exact: true }).click();
    assert.equal(await page.locator("#inspection").getAttribute("data-scheduling"), "running");
  },
);
