import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test, type TestContext } from "node:test";
import { chromium } from "playwright";
import { CompactionTask } from "@earendil-works/pi-durable";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { context } from "../src/application.ts";
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
        assert.equal(await page.locator("#execution-controls, #admission-options").count(), 0);
        assert.equal(
          await page.locator('#composer [name="requestId"]').getAttribute("type"),
          "hidden",
        );
        const button = page.locator(`#queued-${queued}`).getByRole("button", {
          name: "Cancel queued message",
          exact: true,
        });
        const withdrawalBounds = await button.boundingBox();
        const queueBounds = await page.locator(`#queued-${queued}`).boundingBox();
        const stop = page.getByRole("button", { name: "Stop", exact: true });
        assert.equal(await stop.isVisible(), true);
        assert(withdrawalBounds && queueBounds);
        assert(
          Math.abs(
            withdrawalBounds.x + withdrawalBounds.width - queueBounds.x - queueBounds.width,
          ) < 1,
        );
        assert.equal(
          await button.evaluate(
            (element: HTMLButtonElement) => new URL(element.form!.action).pathname,
          ),
          `${scope}/abortSubmission`,
        );
        assert.equal(
          await stop.evaluate(
            (element: HTMLButtonElement) => new URL(element.form!.action).pathname,
          ),
          `${scope}/abort`,
        );
        await page.locator("#message").fill("Unsubmitted draft");
        const posted = page.waitForResponse((response) => response.request().method() === "POST");
        await button.click();
        assert.equal((await posted).status(), enhanced ? 200 : 303);
        await page
          .locator('#execution-result[data-result="aborted"]')
          .waitFor({ state: "attached" });
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
    await page.goto(new URL(`/pds/api/s/${app.id}`, base).href);
    assert.equal(signal?.aborted, false);
    assert.equal(
      (await app.harness.inspect(context)).tasks.filter(({ state }) => state.kind === "running")
        .length,
      1,
    );
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
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await signalled.promise;
    assert.equal(await page.locator("#execution-result").getAttribute("data-action"), null);
    finish.resolve();
    await page.waitForFunction(() => document.getElementById("notice")?.textContent !== "");
    assert.equal(await page.locator("#message").inputValue(), "Keep this draft");
    await conversation.waitForIdle(context);
    assert.equal(writes, 1);
    assert.equal(await page.locator("#execution-result").getAttribute("data-action"), null);
    await page.goto(new URL(`/pds/api/s/${app.id}`, base).href);
    assert.deepEqual((await app.harness.inspect(context)).tasks, []);
    assert.equal(writes, 1);
  },
);

await test("receipt-page withdrawal acknowledges in place", { timeout: 30000 }, async (t) => {
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
  await page.getByRole("button", { name: "Cancel queued message", exact: true }).click();
  await page.locator('#execution-result[data-result="aborted"]').waitFor({ state: "attached" });
  assert.equal(await page.locator("#notice").textContent(), "");
  assert.equal((await app.harness.inspect(context)).scheduling, "paused");
});

await test(
  "composer /resume enables scheduling without submitting input, with and without Datastar",
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
        const pending = await conversation.commit(async (tx) => {
          for (let index = 0; index < 4; index++)
            await tx.appendEntry(conversation.id, {
              kind: "pi.assistant",
              model: [fauxAssistantMessage(`Existing context ${index}`)],
            });
          return tx.createTask(
            CompactionTask,
            { reason: "manual" },
            { ownership: { kind: "conversation" } },
          );
        }, context);
        faux.setResponses([
          async () => {
            started.resolve();
            await finish.promise;
            return fauxAssistantMessage("Resumed summary");
          },
        ]);
        const page = await browserPage(subtest, enhanced);
        const scope = `/pds/api/s/${app.id}/c/${conversation.id}`;
        await page.goto(new URL(scope, base).href);
        if (enhanced)
          await page.waitForFunction(() =>
            document.getElementById("connection")?.classList.contains("sr-only"),
          );
        assert.equal((await app.harness.inspect(context)).scheduling, "paused");
        assert.equal(await page.getByRole("link", { name: "Inspect execution" }).count(), 0);
        assert.equal(await page.getByRole("button", { name: "Resume scheduling" }).count(), 0);
        await page.locator("#message").fill("/resume");
        const posted = page.waitForResponse((response) => response.request().method() === "POST");
        await page.locator("#send").click();
        assert.equal((await posted).status(), enhanced ? 200 : 303);
        await page.waitForFunction(
          () => document.querySelector<HTMLTextAreaElement>("#message")?.value === "",
        );
        await started.promise;
        const running = await app.harness.inspect(context);
        assert.equal(running.scheduling, "running");
        assert.deepEqual(running.submissions, []);
        assert.equal((await app.harness.getTask(pending, context))?.state.status, "running");
        finish.resolve();
        await app.harness.waitForTask(pending, context);
        assert.equal(faux.state.callCount, 1);
      });
  },
);
