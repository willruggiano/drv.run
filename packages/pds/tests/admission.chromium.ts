import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test, type TestContext } from "node:test";
import { chromium } from "playwright";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type * as D from "@earendil-works/pi-durable";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { context } from "../src/application.ts";
import { SessionId, decode } from "../src/identity.ts";
import { serve } from "../src/server.ts";
import { sessionsFixture, form, servePrefixed } from "./fixtures.ts";

await test(
  "uncertain home and conversation responses recover inputs without replaying POSTs",
  { timeout: 30_000 },
  async (t) => {
    const admitted = Promise.withResolvers<void>();
    const loseResponse = Promise.withResolvers<void>();
    t.after(() => loseResponse.resolve());
    const { sessions, auth, faux } = await sessionsFixture(t);
    const server = await serve(sessions, { auth, port: 0 });
    t.after(() => server.close());
    const page = await browserPage(t);
    await page.goto(server.origin);
    assert.equal(await page.locator('#composer [name="requestId"]').count(), 1);
    assert.equal(await page.locator('#composer [name="requestId"]').getAttribute("type"), "hidden");
    assert.equal(await page.locator("#admission-options").count(), 0);
    await page.locator('[name="requestId"]').evaluate((element: HTMLInputElement, value) => {
      element.value = value;
    }, "request\u0000<&>λ");
    const requestId = await page.locator('[name="requestId"]').inputValue();
    assert.equal(requestId, "request\u0000<&>λ");
    const sessionId = decode(SessionId, await page.locator('[name="sessionId"]').inputValue());
    let writes = 0;
    await page.route(`${server.origin}/`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      writes++;
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      admitted.resolve();
      await loseResponse.promise;
      await route.abort("failed");
    });
    faux.setResponses([fauxAssistantMessage("Admitted once")]);
    await page.locator("#message").fill("Keep this draft until its receipt arrives");
    await page.locator("#attachments").setInputFiles({
      name: "note.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("retained attachment"),
    });
    await page.locator("#create").click();
    await admitted.promise;
    await page.locator("#composer").evaluate((element: HTMLFormElement) => element.requestSubmit());
    assert.equal(writes, 1);
    assert.equal(await page.locator("#message").isDisabled(), true);
    assert.equal(
      await page.locator("#message").inputValue(),
      "Keep this draft until its receipt arrives",
    );
    assert.equal(
      await page
        .locator("#attachments")
        .evaluate((element: HTMLInputElement) => element.files?.length),
      1,
    );
    loseResponse.resolve();
    await page.waitForURL(`${server.origin}/api/s/${sessionId}/c/${ROOT_CONVERSATION_ID}`);
    assert.equal(await page.locator("#message").inputValue(), "");
    assert.equal(
      await page
        .locator("#attachments")
        .evaluate((element: HTMLInputElement) => element.files?.length),
      0,
    );
    const app = await sessions.get(sessionId);
    assert(app);
    assert.equal((await app.list()).length, 1);
    const receipt = await app.harness.commit(
      (tx) => tx.submissionByRequest(ROOT_CONVERSATION_ID, requestId),
      context,
    );
    assert(receipt?.type === "input");
    assert.equal(writes, 1);
    assert.equal(faux.state.callCount, 1);
    const conversation = await app.conversation(ROOT_CONVERSATION_ID);
    assert(conversation);
    await conversation.waitForIdle(context);
    const nextRequest = await page.locator('[name="requestId"]').inputValue();
    await page.route("**/composer", async (route) => {
      writes++;
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      await route.fulfill({ status: 500, contentType: "text/plain", body: "" });
    });
    faux.setResponses([fauxAssistantMessage("Recovered in place")]);
    await page.locator("#message").fill("Recover without navigating away");
    await page.locator("#send").click();
    await page.waitForFunction(
      () => document.querySelector<HTMLInputElement>("#message")?.value === "",
    );
    assert.equal(await page.locator("#notice").textContent(), "");
    assert.equal(await page.locator("#recovery").isHidden(), true);
    assert(
      await app.harness.commit(
        (tx) => tx.submissionByRequest(conversation.id, nextRequest),
        context,
      ),
    );
    await conversation.waitForIdle(context);
    assert.equal(writes, 2);
    assert.equal(faux.state.callCount, 2);
  },
);

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
  "absent and mismatched receipts retain locked drafts; explicit new input gets a new ID",
  { timeout: 30_000 },
  async (t) => {
    const { sessions, auth, faux, selection } = await sessionsFixture(t);
    const server = await serve(sessions, { auth, port: 0 });
    t.after(() => server.close());
    const app = await sessions.open(decode(SessionId, "receipts"));
    const conversation = await app.root(form(selection));
    const other = await app.createConversation(form(selection));
    const scope = `/api/s/${app.id}/c/${conversation.id}`;
    const page = await browserPage(t);
    await page.goto(`${server.origin}${scope}`);
    const requestId = await page.locator('[name="requestId"]').inputValue();
    faux.setResponses([
      fauxAssistantMessage("Another conversation"),
      fauxAssistantMessage("Another request"),
    ]);
    await app.submit(other, form({ message: "Other conversation", requestId }));
    await other.waitForIdle(context);
    await app.submit(conversation, form({ message: "Other request", requestId: "other" }));
    await conversation.waitForIdle(context);
    let writes = 0;
    let read = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === `${scope}/composer`)
        writes++;
    });
    await page.route(`**${scope}/composer`, (route) => route.abort("failed"));
    await page.route("**/submissionByRequest?**", async (route) => {
      read++;
      const path =
        read === 1
          ? `/api/s/${app.id}/c/${other.id}/submissionByRequest?${new URLSearchParams({ requestId })}`
          : read === 2
            ? `${scope}/submissionByRequest?requestId=other`
            : route.request().url();
      const response = await route.fetch({ url: new URL(path, server.origin).href });
      await route.fulfill({ response });
    });
    await page.locator("#message").fill("Uncertain draft");
    await page
      .locator("#attachments")
      .setInputFiles({ name: "draft.txt", mimeType: "text/plain", buffer: Buffer.from("Keep me") });
    await page.locator("#send").click();
    await page
      .locator(`#admission[data-scope="/api/s/${app.id}/c/${other.id}"]`)
      .waitFor({ state: "attached" });
    assert.equal(await page.locator("#message").inputValue(), "Uncertain draft");
    assert.equal(await page.locator("#message").isDisabled(), true);
    await page.locator("#recover-admission").click();
    await page.locator('#admission[data-request-id="other"]').waitFor({ state: "attached" });
    assert.equal(await page.locator("#message").inputValue(), "Uncertain draft");
    assert.equal(await page.locator("#message").isDisabled(), true);
    await page.locator("#recover-admission").click();
    await page.locator('#admission[data-result="absent"]').waitFor({ state: "attached" });
    assert.equal(
      await page
        .locator("#attachments")
        .evaluate((element: HTMLInputElement) => element.files?.length),
      1,
    );
    assert.equal(await page.locator('[name="requestId"]').inputValue(), requestId);
    assert.equal(writes, 1);
    assert.equal(faux.state.callCount, 2);
    await page.locator("#edit-draft").click();
    const changed = await page.locator('[name="requestId"]').inputValue();
    assert.notEqual(changed, requestId);
    assert.equal(await page.locator("#message").isDisabled(), false);
    assert.equal(await page.locator("#message").inputValue(), "Uncertain draft");
    await page.unroute(`**${scope}/composer`);
    faux.setResponses([fauxAssistantMessage("New input")]);
    await page.locator("#message").fill("Changed draft");
    await page.locator("#send").click();
    await page.waitForFunction(
      () => document.querySelector<HTMLInputElement>("#message")?.value === "",
    );
    assert.equal(writes, 2);
    assert.equal(
      await page
        .locator("#attachments")
        .evaluate((element: HTMLInputElement) => element.files?.length),
      0,
    );
    assert(
      await app.harness.commit((tx) => tx.submissionByRequest(conversation.id, changed), context),
    );
    assert.equal(
      await app.harness.commit((tx) => tx.submissionByRequest(conversation.id, requestId), context),
      undefined,
    );
    await conversation.waitForIdle(context);
    await page.locator('[name="requestId"]').evaluate((element: HTMLInputElement, value) => {
      element.value = value;
    }, changed);
    await page.locator("#message").fill("/resume");
    await page.locator("#attachments").setInputFiles({
      name: "kept.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Keep this file"),
    });
    await page.locator("#send").click();
    await page.locator('#notice[data-field="attachments"]').waitFor();
    assert.equal(await page.locator("#message").inputValue(), "/resume");
    assert.equal(await page.locator("#message").isDisabled(), false);
    assert.equal(
      await page
        .locator("#attachments")
        .evaluate((element: HTMLInputElement) => element.files?.length),
      1,
    );
    assert.equal(faux.state.callCount, 3);
  },
);

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6mL0AAAAASUVORK5CYII=",
  "base64",
);

await test(
  "typed image validation keeps files and offers available models without selecting or submitting",
  { timeout: 30_000 },
  async (t) => {
    const { sessions, auth, faux } = await sessionsFixture(t);
    const server = await serve(sessions, { auth, port: 0 });
    t.after(() => server.close());
    const page = await browserPage(t);
    await page.goto(server.origin);
    await page.locator("#model").selectOption("faux/second");
    let writes = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/") writes++;
    });
    await page.locator("#message").fill("Review these files");
    await page.locator("#attachments").setInputFiles([
      { name: "pixel.png", mimeType: "image/png", buffer: png },
      { name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("remove me") },
    ]);
    await page.locator('[name="requestId"]').evaluate((element: HTMLInputElement, value) => {
      element.value = value;
    }, "invalid\u0000<&>λ");
    const requestId = await page.locator('[name="requestId"]').inputValue();
    await page.locator("#create").click();
    await page.locator('#notice[data-issue="image-model"]').waitFor();
    await page.waitForFunction(
      () => !document.querySelector<HTMLInputElement>("#message")?.matches(":disabled"),
    );
    assert.equal(await page.locator("#model").inputValue(), "faux/second");
    assert.equal(await page.locator("#message").inputValue(), "Review these files");
    assert.equal(
      await page
        .locator("#attachments")
        .evaluate((element: HTMLInputElement) => element.files?.length),
      2,
    );
    assert.equal(await page.locator('[name="requestId"]').inputValue(), requestId);
    assert.deepEqual(
      await page
        .locator("#notice [data-select-model]")
        .evaluateAll((elements) =>
          elements.map((element) => element.getAttribute("data-select-model")),
        ),
      ["faux/first"],
    );
    assert.deepEqual(await sessions.list(), []);
    assert.equal(faux.state.callCount, 0);
    assert.equal(writes, 1);
    await page.getByRole("button", { name: "Remove note.txt", exact: true }).click();
    assert.notEqual(await page.locator('[name="requestId"]').inputValue(), requestId);
    await page.locator("#message").evaluate((element) => {
      const transfer = new DataTransfer();
      transfer.items.add(
        new File(["export const answer = 42;"], "pasted.ts", { type: "text/plain" }),
      );
      element.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }),
      );
    });
    await page.locator(".compose-box").evaluate((element) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([""], "empty.txt", { type: "text/plain" }));
      element.dispatchEvent(
        new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }),
      );
    });
    assert.equal(await page.getByRole("img", { name: "pixel.png", exact: true }).count(), 1);
    await page.waitForFunction(
      () => document.querySelector<HTMLImageElement>("#previews img")?.naturalWidth === 1,
    );
    assert.equal(
      await page.getByRole("button", { name: "Remove pasted.ts", exact: true }).count(),
      1,
    );
    assert.equal(
      await page.getByRole("button", { name: "Remove empty.txt", exact: true }).count(),
      1,
    );
    await page.locator('#notice [data-select-model="faux/first"]').click();
    assert.equal(await page.locator("#model").inputValue(), "faux/first");
    assert.equal(writes, 1);
    assert.deepEqual(await sessions.list(), []);
    await page.locator('[name="requestId"]').evaluate((element: HTMLInputElement, value) => {
      element.value = value;
    }, "accepted\u0000<&>λ");
    faux.setResponses([fauxAssistantMessage("Files accepted")]);
    await page.locator("#create").click();
    await page.waitForURL((url) => url.pathname.endsWith(`/c/${ROOT_CONVERSATION_ID}`));
    const selected = (await sessions.list())[0];
    assert(selected);
    const app = await sessions.get(selected.id);
    assert(app);
    const conversation = await app.conversation(ROOT_CONVERSATION_ID);
    assert(conversation);
    await conversation.waitForIdle(context);
    const messages = (await conversation.context(context)).messages;
    assert.deepEqual(messages.find((message) => message.role === "user")?.content, [
      { type: "text", text: "Review these files" },
      { type: "text", text: "Attachment: pixel.png" },
      { type: "image", mimeType: "image/png", data: png.toString("base64") },
      { type: "text", text: "Attachment: pasted.ts\n\nexport const answer = 42;" },
      { type: "text", text: "Attachment: empty.txt\n\n" },
    ]);
    assert.equal(writes, 2);
  },
);

await test(
  "native file controls submit without preview JavaScript and return a scoped receipt through PRG",
  { timeout: 30_000 },
  async (t) => {
    const { sessions, auth, faux } = await sessionsFixture(t);
    const server = await serve(sessions, { auth, port: 0 });
    t.after(() => server.close());
    const page = await browserPage(t, false);
    await page.goto(server.origin);
    const sessionId = decode(SessionId, await page.locator('[name="sessionId"]').inputValue());
    const requestId = await page.locator('[name="requestId"]').inputValue();
    await page
      .locator("#attachments")
      .setInputFiles({ name: "native.png", mimeType: "image/png", buffer: png });
    assert.equal(
      await page.locator("#previews").evaluate((element) => element.childElementCount),
      0,
    );
    faux.setResponses([fauxAssistantMessage("Native file received")]);
    const posted = page.waitForResponse((response) => response.request().method() === "POST");
    await page.locator("#create").click();
    assert.equal((await posted).status(), 303);
    await page.waitForURL(
      (url) => url.pathname === `/api/s/${sessionId}/c/${ROOT_CONVERSATION_ID}`,
    );
    assert.equal(await page.locator("#admission").getAttribute("data-request-id"), requestId);
    assert.equal(await page.locator("#admission").getAttribute("data-result"), "present");
    const app = await sessions.get(sessionId);
    assert(app);
    const receipt = await app.harness.commit(
      (tx) => tx.submissionByRequest(ROOT_CONVERSATION_ID, requestId),
      context,
    );
    assert(receipt);
    assert.equal(
      await page.locator("#admission").getAttribute("data-submission-id"),
      String(receipt.id),
    );
  },
);

await test(
  "HTTP rejection keeps the home scope and draft without treating it as an admission",
  { timeout: 30_000 },
  async (t) => {
    const { sessions, auth, faux } = await sessionsFixture(t);
    const server = await serve(sessions, { auth, port: 0 });
    t.after(() => server.close());
    const page = await browserPage(t);
    await page.goto(server.origin);
    const sessionId = decode(SessionId, await page.locator('[name="sessionId"]').inputValue());
    const requestId = await page.locator('[name="requestId"]').inputValue();
    await page.route(`${server.origin}/`, (route) => route.fulfill({ status: 409, body: "" }));
    await page.locator("#message").fill("Keep the scope");
    const rejected = page.waitForResponse(
      (response) => response.request().method() === "POST" && response.status() === 409,
    );
    await page.locator("#create").click();
    await rejected;
    await page.waitForFunction(
      () => !document.querySelector<HTMLInputElement>("#message")?.matches(":disabled"),
    );
    assert.equal(await page.locator("#message").inputValue(), "Keep the scope");
    assert.equal(await page.locator("#recovery").isVisible(), false);
    assert.equal(await page.locator("#admission").getAttribute("data-submission-id"), null);
    assert.equal(faux.state.callCount, 0);
    assert.deepEqual(await sessions.list(), []);
    await page.unroute(`${server.origin}/`);
    await page.locator("#message").fill("Now accept the draft");
    assert.equal(await page.locator('[name="sessionId"]').inputValue(), sessionId);
    assert.notEqual(await page.locator('[name="requestId"]').inputValue(), requestId);
    faux.setResponses([fauxAssistantMessage("Now admitted")]);
    await page.locator("#create").click();
    await page.waitForURL(`${server.origin}/api/s/${sessionId}/c/${ROOT_CONVERSATION_ID}`);
    assert.equal((await sessions.list()).length, 1);
    const app = await sessions.get(sessionId);
    assert(app);
    assert.equal((await app.list()).length, 1);
  },
);

await test(
  "prefixed receipt views preserve every native status and scope without enabling scheduling",
  { timeout: 30_000 },
  async (t) => {
    const { sessions, auth, selection } = await sessionsFixture(t);
    const base = await servePrefixed(t, sessions, auth, "/pds");
    const app = await sessions.open(decode(SessionId, "λ/receipts ' & %"));
    const conversation = await app.root(form(selection));
    const other = await app.createConversation(form(selection));
    const entry = await app.harness.commit(
      (tx) => tx.appendEntry(conversation.id, { kind: "example.entry" }),
      context,
    );
    const answer = await app.harness.commit(
      (tx) => tx.appendEntry(conversation.id, { kind: "example.answer" }),
      context,
    );
    const cases = [
      { type: "input", status: "queued" },
      { type: "input", status: "placed", entry: entry.id },
      { type: "input", status: "done", entry: entry.id, answer: answer.id },
      {
        type: "input",
        status: "unanswered",
        entry: entry.id,
        reason: "aborted",
        detail: { value: "<img src=x>", count: 3 },
      },
      { type: "write", status: "queued" },
      { type: "write", status: "done", entry: entry.id },
      { type: "write", status: "unanswered", reason: "aborted", detail: "stopped" },
      { type: "continue", status: "placed" },
      { type: "continue", status: "done", answer: answer.id },
      { type: "continue", status: "unanswered", reason: "aborted", detail: false },
    ] as const;
    const page = await browserPage(t);
    const scope = `/pds/api/s/${encodeURIComponent(app.id)}/c/${conversation.id}`;
    for (const variant of cases) {
      const record: D.SubmissionRecord = await app.harness.commit(
        (tx) =>
          tx.createSubmission({
            ...variant,
            conversationId: conversation.id,
            requestId: `${variant.type}/${variant.status} '<>&%`,
          }),
        context,
      );
      for (const read of [
        `submissionByRequest?${new URLSearchParams({ requestId: record.requestId! })}`,
        `submissions/status?id=${record.id}`,
      ]) {
        const response = await page.goto(new URL(`${scope}/${read}`, base).href);
        assert.equal(response?.status(), 200);
        assert.equal(response?.headers()["cache-control"], "no-store");
        const result = page.locator("#admission");
        assert.equal(await result.getAttribute("data-result"), "present");
        assert.equal(await result.getAttribute("data-type"), record.type);
        assert.equal(await result.getAttribute("data-status"), record.status);
        assert.equal(await result.getAttribute("data-scope"), scope);
        assert.equal(
          await result.getAttribute("data-request-id"),
          encodeURIComponent(record.requestId!),
        );
        assert.equal(await result.getAttribute("data-submission-id"), String(record.id));
        for (const name of ["entry", "answer", "reason", "detail"] as const) {
          const field = result.locator(`[data-field="${name}"]`);
          if (record[name] === undefined) assert.equal(await field.count(), 0);
          else if (name === "detail") {
            const value: unknown = JSON.parse((await field.textContent())!);
            assert.deepEqual(value, record.detail);
          } else assert.equal(await field.textContent(), String(record[name]));
        }
        assert.equal(await result.locator("img").count(), 0);
      }
      await page.goto(
        new URL(
          `/pds/api/s/${encodeURIComponent(app.id)}/c/${other.id}/submissions/status?id=${record.id}`,
          base,
        ).href,
      );
      assert.equal(await page.locator("#admission").getAttribute("data-result"), "absent");
      assert.equal((await app.harness.inspect(context)).scheduling, "paused");
      assert.deepEqual(await app.harness.commit((tx) => tx.submission(record.id), context), record);
    }
  },
);

await test(
  "an image model that becomes available after page load can be selected without losing the draft",
  { timeout: 30_000 },
  async (t) => {
    const { sessions, auth, models, faux, selection } = await sessionsFixture(t);
    const server = await serve(sessions, { auth, port: 0 });
    t.after(() => server.close());
    const app = await sessions.open();
    const conversation = await app.root(form({ ...selection, thinking: "high" }));
    const page = await browserPage(t);
    await page.goto(`${server.origin}/api/s/${app.id}/c/${conversation.id}`);
    await page.waitForFunction(() =>
      document.getElementById("connection")?.classList.contains("sr-only"),
    );
    const first = models.getModel("faux", "first");
    const second = models.getModel("faux", "second");
    assert(first && second);
    models.setProvider({
      ...faux.provider,
      getModels: () => [
        { ...first, input: ["text"] },
        second,
        { ...first, id: "image-only", name: "Image-capable model", reasoning: false },
      ],
    });
    await page.locator("#message").fill("Keep the image");
    await page
      .locator("#attachments")
      .setInputFiles({ name: "image.png", mimeType: "image/png", buffer: png });
    await page.locator("#send").click();
    await page.locator('#notice[data-issue="image-model"]').waitFor();
    assert.deepEqual(
      await page
        .locator("#notice [data-select-model]")
        .evaluateAll((elements) =>
          elements.map((element) => element.getAttribute("data-select-model")),
        ),
      ["faux/image-only"],
    );
    assert.equal(await page.locator('#model option[value="faux/image-only"]').count(), 0);
    const configured = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith("/configure"),
    );
    await page.locator('#notice [data-select-model="faux/image-only"]').click();
    await configured;
    const agent = await conversation.agent(context);
    assert.equal(agent.model?.modelId, "image-only");
    assert.equal(agent.thinkingLevel, "off");
    assert.equal(await page.locator("#message").inputValue(), "Keep the image");
    assert.equal(
      await page
        .locator("#attachments")
        .evaluate((element: HTMLInputElement) => element.files?.length),
      1,
    );
    assert.equal(faux.state.callCount, 0);
  },
);
