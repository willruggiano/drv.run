import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { chromium, type Page } from "playwright";
import { assistant, entry, fixture, instance, ready } from "./browser-testing.ts";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1kAAAAASUVORK5CYII=";
const deferred = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
async function connected(page: Page) {
  await page.locator("#connection.sr-only").waitFor({ state: "attached" });
}
async function admitted(page: Page) {
  await page.locator('#delivery-status[data-state="admitted"]').waitFor({ state: "attached" });
}
async function configuration(page: Page) {
  await page.locator("#models option").nth(2).waitFor({ state: "attached" });
  await page.locator("#targets option").nth(1).waitFor({ state: "attached" });
}
async function save(page: Page) {
  await page.locator('#session-meta[data-save-state="saved"]').waitFor();
  await page.locator("#app-header > .read-status").waitFor({ state: "detached" });
}

await test("mutable conversation", async (suite) => {
  const executablePath =
    process.env.CHROMIUM_BINARY ??
    (process.env.PATH ?? "")
      .split(delimiter)
      .map((directory) => join(directory, "chromium"))
      .find(existsSync);
  assert(executablePath);
  const browser = await chromium.launch({
    executablePath,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  suite.after(() => browser.close());

  await suite.test(
    "home creation, multi-turn attachments, live configuration, compaction and passive reopening",
    async (t) => {
      const { page, state, url, emit, watchRequests } = await fixture(t, browser);
      await page.goto(url);
      await ready(page);
      await page.locator("#targets").selectOption(JSON.stringify(instance.id));
      await page.locator("#base-directory").fill("/workspace/project");
      await page.locator("#models").selectOption(JSON.stringify(["one", "same/id"]));
      await page.locator("#thinking").selectOption("high");
      await page.locator("#prompt").fill("  initial message\nsecond line  ");
      await page.getByRole("button", { name: "Create session", exact: true }).click();
      await connected(page);
      await admitted(page);
      assert.equal(state.opens.length, 1);
      assert.equal(state.roots.length, 1);
      const externalId = state.opens[0]!;
      assert.equal(new URL(page.url()).pathname, `/sessions/${externalId}/conversations/1`);
      assert.deepEqual(state.roots[0], {
        harnessId: `global:${externalId}`,
        options: {
          agent: {
            cwd: "/workspace/project",
            model: { provider: "one", modelId: "same/id" },
            thinkingLevel: "high",
          },
          env: instance.connect,
        },
      });
      assert.equal(state.submissions[0]?.conversationId, `global:${externalId}:1`);
      assert.deepEqual(state.submissions[0]?.submission.input.content.blocks, [
        { text: { text: "  initial message\nsecond line  " } },
      ]);
      assert.equal(await page.locator("#prompt").inputValue(), "");

      state.snapshot.view.docs["pi.live"] = {
        run: { taskId: 1, inputs: [], turns: 0 },
        generation: { attempt: 1, message: assistant("Streaming first answer") },
      };
      emit([["r", state.snapshot]]);
      await page.locator('#live article[data-role="assistant"]').waitFor();
      await configuration(page);
      await page.locator("#targets").selectOption("");
      await save(page);
      await page.locator("#base-directory").fill("~/literal next");
      await page.locator("#base-directory").press("Enter");
      await save(page);
      await page.locator("#models").selectOption(JSON.stringify(["two", "same/id"]));
      await save(page);
      assert.deepEqual(state.configurations, [
        { conversationId: `global:${externalId}:1`, change: {}, env: null },
        { conversationId: `global:${externalId}:1`, change: { cwd: "~/literal next" } },
        {
          conversationId: `global:${externalId}:1`,
          change: { model: { provider: "two", modelId: "same/id" }, thinkingLevel: null },
        },
      ]);

      state.snapshot.view.docs["pi.live"] = {};
      state.snapshot.view.entries.push(entry(2, assistant("Completed first answer")));
      emit([["r", state.snapshot]]);
      await page.locator("#entry-2").waitFor();
      assert.equal(await page.locator('#live article[data-role="assistant"]').count(), 0);
      const chooser = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: "Upload attachments" }).click();
      await (
        await chooser
      ).setFiles([
        { name: 'a"file.txt', mimeType: "text/plain", buffer: Buffer.from("exact text\n") },
        { name: "pixel.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") },
      ]);
      await page.getByRole("img", { name: "pixel.png" }).waitFor();
      await page.locator("#prompt").fill("second turn");
      await page.locator("#prompt").press("Control+Enter");
      await admitted(page);
      assert.deepEqual(state.submissions[1]?.submission.input.content.blocks, [
        { text: { text: "second turn" } },
        { text: { text: 'File: "a\\\"file.txt"\nexact text\n' } },
        { image: { mimeType: "image/png", data: png } },
      ]);
      assert.equal(await page.locator("#previews button").count(), 0);
      assert.notEqual(
        state.submissions[0]?.submission.input.requestId,
        state.submissions[1]?.submission.input.requestId,
      );

      await page.locator("#prompt").fill("/compact retain decisions");
      await page.locator("#prompt").press("Control+Enter");
      assert.equal(state.compactions.length, 0);
      await page.getByRole("button", { name: "Confirm compaction" }).click();
      await page.getByRole("textbox", { name: "Message", exact: true }).waitFor();
      assert.deepEqual(state.compactions, [
        { conversationId: `global:${externalId}:1`, instructions: "retain decisions" },
      ]);
      assert.equal(await page.locator("#prompt").inputValue(), "");
      const summary = {
        id: 4,
        conversationId: 1,
        kind: "pi.compaction",
        head: 3,
        data: { summary: "Decisions retained" },
      };
      state.snapshot.view.entries.push(summary);
      state.snapshot.head = summary;
      state.snapshot.view.docs["pi.live"] = { run: { taskId: 2, inputs: [], turns: 0 } };
      emit([["r", state.snapshot]]);
      await page.locator("#entry-4").waitFor({ state: "attached" });
      await page.locator("#conversation-title").click();
      await page.locator("#session-list").waitFor();
      await page.locator(`a[href="/sessions/${externalId}"]`).click();
      await connected(page);
      assert.equal(state.submissions.length, 2);
      assert.deepEqual(state.resumes, []);
      assert.equal(watchRequests.length, 2);
      assert.equal(await page.locator("#controls").getAttribute("data-state"), "working");
      await page.locator("#prompt").fill("third turn after reopening");
      await page.locator("#prompt").press("Alt+Enter");
      await admitted(page);
      assert.equal(state.submissions[2]?.submission.input.whenBusy, "steer");
      assert.equal(state.submissions.length, 3);
    },
  );

  await suite.test(
    "admission is single-flight and never clears a newer revision, even identical text",
    async (t) => {
      const { page, state, url } = await fixture(t, browser);
      const gate = deferred();
      t.after(gate.release);
      state.hold.submit = gate.promise;
      await page.goto(new URL("sessions/alpha/conversations/1", url).href);
      await connected(page);
      await page.locator("#prompt").fill("original");
      await page.locator("#prompt").press("Control+Enter");
      await page.locator('#delivery-status[data-state="sending"]').waitFor();
      await page.locator("#prompt").press("Control+Enter");
      await page.locator("#prompt").fill("different");
      await page.locator("#prompt").fill("original");
      gate.release();
      await admitted(page);
      assert.equal(state.submissions.length, 1);
      assert.equal(await page.locator("#prompt").inputValue(), "original");
      await page.locator("#prompt").press("Control+Enter");
      await page.waitForFunction(
        () => (document.querySelector("#prompt") as HTMLTextAreaElement).value === "",
      );
      assert.equal(state.submissions.length, 2);
      assert.notEqual(
        state.submissions[0]?.submission.input.requestId,
        state.submissions[1]?.submission.input.requestId,
      );
    },
  );

  await suite.test(
    "lost acknowledgements recover by receipt without resending or clearing newer edits",
    async (t) => {
      const { page, state, url } = await fixture(t, browser);
      state.loseAcknowledgement.add("submit");
      await page.goto(new URL("sessions/alpha/conversations/1", url).href);
      await connected(page);
      await page.locator("#prompt").fill("once");
      await page.locator("#prompt").press("Control+Enter");
      await page.locator('#delivery-status[data-state="uncertain"]').waitFor();
      assert.equal(
        await page
          .getByRole("button", { name: "Check receipt", exact: true })
          .evaluate((node) => node.closest(".compose-box") !== null),
        true,
      );
      assert.equal(
        await page.locator("#composer-shell").evaluate((node) => node.nextElementSibling?.id),
        "session-meta",
      );
      await page.locator("#prompt").fill("newer draft");
      await page.getByRole("button", { name: "Check receipt", exact: true }).click();
      await admitted(page);
      assert.equal(state.submissions.length, 1);
      assert.equal(await page.locator("#prompt").inputValue(), "newer draft");
      assert.equal(state.receipts.size, 1);
    },
  );

  await suite.test(
    "missing receipts are inconclusive; explicit retry retains the original capture and request identity",
    async (t) => {
      const { page, state, url, requests } = await fixture(t, browser);
      state.faults.submit = "malformed";
      await page.goto(new URL("sessions/alpha/conversations/1", url).href);
      await connected(page);
      await page.locator("#prompt").fill("captured");
      await page.locator("#prompt").press("Control+Enter");
      await page.locator('#delivery-status[data-state="uncertain"]').waitFor();
      await page.locator("#prompt").fill("do not send this yet");
      await page.getByRole("button", { name: "Check receipt", exact: true }).click();
      await page.locator('#delivery-status[data-state="uncertain"]').waitFor();
      assert.equal(state.submissions.length, 0);
      assert.equal(requests.filter((item) => item.field === "submit").length, 1);
      delete state.faults.submit;
      state.loseAcknowledgement.add("submit");
      await page.getByRole("button", { name: "Retry captured input" }).click();
      await page.locator('#delivery-status[data-state="uncertain"]').waitFor();
      const first = structuredClone(state.submissions[0]);
      await page.getByRole("button", { name: "Retry captured input" }).click();
      await admitted(page);
      assert.deepEqual(state.submissions, [first]);
      assert.deepEqual(first?.submission.input.content.blocks, [{ text: { text: "captured" } }]);
      assert.equal(await page.locator("#prompt").inputValue(), "do not send this yet");
    },
  );

  await suite.test("busy rejection retains draft and delivery mode; IME never sends", async (t) => {
    const { page, state, url } = await fixture(t, browser);
    state.busyReject = true;
    state.snapshot.view.docs["pi.live"] = { run: { taskId: 1, inputs: [], turns: 0 } };
    await page.goto(new URL("sessions/alpha/conversations/1", url).href);
    await connected(page);
    await page.locator("#prompt").fill("reject on race");
    await page
      .locator("#prompt")
      .dispatchEvent("keydown", { key: "Enter", ctrlKey: true, isComposing: true });
    assert.equal(state.submissions.length, 0);
    await page.locator("#send").click();
    await page.locator('#delivery-status[data-state="rejected"]').waitFor();
    assert.equal(await page.locator("#prompt").inputValue(), "reject on race");
    state.busyReject = false;
    await page.locator("#send").click();
    await admitted(page);
    assert.equal(state.submissions[0]?.submission.input.whenBusy, "followUp");
  });

  await suite.test(
    "compact, new and cd commands do not silently consume attachments",
    async (t) => {
      const { page, state, url } = await fixture(t, browser);
      await page.goto(new URL("sessions/alpha/conversations/1", url).href);
      await connected(page);
      await page.locator("#prompt").fill("/");
      assert.deepEqual(
        await page.locator("#completions [role=option] > span:first-child").allTextContents(),
        ["/compact", "/new", "/cd"],
      );
      await page.locator("#prompt").fill("/unknown");
      await page.locator("#prompt").press("Control+Enter");
      assert.equal(state.submissions.length, 0);
      assert.equal(await page.locator("#prompt").inputValue(), "/unknown");
      const chooser = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: "Upload attachments" }).click();
      await (
        await chooser
      ).setFiles({ name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("note") });
      await page.locator("#previews button").waitFor();
      await page.locator("#prompt").fill("/new");
      await page.locator("#prompt").press("Control+Enter");
      assert.equal(new URL(page.url()).pathname, "/sessions/alpha/conversations/1");
      assert.equal(await page.locator("#previews button").count(), 1);
      await page.locator("#previews button").click();
      await page.locator("#prompt").press("Control+Enter");
      await page.locator("#session-list").waitFor();
      assert.equal(state.opens.length, 0);
      assert.equal(await page.locator("#prompt").inputValue(), "");
    },
  );

  await suite.test(
    "inline saves serialize newer edits and protect pending writes without moving focus",
    async (t) => {
      const { page, state, url } = await fixture(t, browser);
      await page.goto(url);
      await ready(page);
      await page.locator('a[href="/sessions/alpha"]').click();
      await connected(page);
      await configuration(page);
      const gate = deferred();
      t.after(gate.release);
      state.hold.configure = gate.promise;
      await page.locator("#base-directory").fill("/captured");
      await page.locator("#base-directory").press("Enter");
      await page.locator('#session-meta[data-save-state="saving"]').waitFor();
      await page.locator("#base-directory").fill("/newer");
      await page.locator("#base-directory").press("Enter");
      await page.locator("#conversation-title").click();
      await page.getByRole("dialog", { name: "Pending settings" }).waitFor();
      assert.notEqual(await page.evaluate(() => document.activeElement?.id), "navigation-stay");
      await page.getByRole("button", { name: "Stay", exact: true }).click();
      gate.release();
      await save(page);
      assert.equal(await page.locator("#base-directory").inputValue(), "/newer");
      assert.deepEqual(
        state.configurations.map(({ change }) => change),
        [{ cwd: "/captured" }, { cwd: "/newer" }],
      );
      assert.equal(await page.evaluate(() => document.activeElement?.id), "");
      await page.goBack();
      await ready(page);
      assert.equal(await page.getByRole("dialog").count(), 0);
    },
  );

  await suite.test(
    "uncertain inline saves retry the captured patch before newer edits; env-only changes preserve agent fields",
    async (t) => {
      const { page, state, url } = await fixture(t, browser);
      await page.goto(new URL("sessions/alpha/conversations/1", url).href);
      await connected(page);
      await configuration(page);
      state.loseAcknowledgement.add("configure");
      await page.locator("#base-directory").fill("/captured");
      await page.locator("#base-directory").press("Enter");
      await page.locator('#session-meta[data-save-state="uncertain"]').waitFor();
      await page.locator("#base-directory").fill("/workspace/one");
      await page.locator("#base-directory").press("Enter");
      assert.equal(state.configurations.length, 1);
      await page.getByRole("button", { name: "Retry settings", exact: true }).click();
      await save(page);
      assert.deepEqual(state.configurations[1], state.configurations[0]);
      assert.deepEqual(state.configurations[2]?.change, { cwd: "/workspace/one" });
      assert.equal(state.agent.cwd, "/workspace/one");
      await page.locator("#targets").selectOption("");
      await save(page);
      assert.deepEqual(state.configurations[3], {
        conversationId: "global:alpha:1",
        change: {},
        env: null,
      });
      await page.locator("#targets").selectOption(JSON.stringify(instance.id));
      await save(page);
      assert.deepEqual(state.configurations[4], {
        conversationId: "global:alpha:1",
        change: {},
        env: instance.connect,
      });
    },
  );

  await suite.test(
    "creation recovers uncertain stages with stable identities and never duplicates first input",
    async (t) => {
      const { page, state, url } = await fixture(t, browser);
      state.loseAcknowledgement.add("open");
      state.loseAcknowledgement.add("root");
      await page.goto(url);
      await ready(page);
      await page.locator("#prompt").fill("first input");
      const create = page.getByRole("button", { name: "Create session", exact: true });
      await create.click();
      await page.waitForFunction(
        () => !(document.querySelector("#create") as HTMLButtonElement).disabled,
      );
      assert.equal(state.opens.length, 1);
      assert.equal(state.roots.length, 0);
      await create.click();
      await page.waitForFunction(
        () => !(document.querySelector("#create") as HTMLButtonElement).disabled,
      );
      assert.equal(state.opens.length, 2);
      assert.equal(state.opens[0], state.opens[1]);
      assert.equal(state.roots.length, 1);
      await create.click();
      await connected(page);
      await admitted(page);
      assert.equal(state.roots.length, 2);
      assert.deepEqual(state.roots[0], state.roots[1]);
      assert.equal(state.submissions.length, 1);
    },
  );

  await suite.test(
    "stop and queue withdrawal use explicit buttons and correct identities",
    async (t) => {
      const { page, state, url } = await fixture(t, browser);
      state.snapshot.view.docs["pi.live"] = { run: { taskId: 1, inputs: [], turns: 0 } };
      state.snapshot.view.docs["pi.inbox"] = {
        items: [{ id: 8, mode: "followUp", content: "queued" }],
      };
      await page.goto(new URL("sessions/alpha/conversations/1", url).href);
      await connected(page);
      await page.getByRole("button", { name: "Stop", exact: true }).click();
      await page.locator('#controls[data-state="ready"]').waitFor();
      assert.deepEqual(state.aborts, ["global:alpha:1"]);
      await Promise.all([
        page.waitForResponse(
          async (response) =>
            response.url().endsWith("/api/graphql") &&
            (await response.json()).data?.abortSubmission !== undefined,
        ),
        page.getByRole("button", { name: "Cancel queued message" }).click(),
      ]);
      assert.deepEqual(state.withdrawals, [{ conversationId: "global:alpha:1", id: 8 }]);
      assert.deepEqual(state.resumes, []);
      assert.equal(state.submissions.length, 0);
    },
  );

  await suite.test(
    "home attachments transfer only after completed reads; creation locks the capture",
    async (t) => {
      const { page, state, url } = await fixture(t, browser);
      await page.goto(url);
      await ready(page);
      const chooser = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: "Upload attachments" }).click();
      await (
        await chooser
      ).setFiles({
        name: "initial.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("initial attachment"),
      });
      await page.getByRole("button", { name: "Remove initial.txt", exact: true }).waitFor();
      const gate = deferred();
      t.after(gate.release);
      state.hold.open = gate.promise;
      await page.getByRole("button", { name: "Create session", exact: true }).click();
      assert.equal(
        await page.getByRole("button", { name: "Upload attachments" }).isDisabled(),
        true,
      );
      assert.equal(
        await page.getByRole("button", { name: "Remove initial.txt", exact: true }).isDisabled(),
        true,
      );
      await page.locator("#composer-shell .compose-box").evaluate((node) => {
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(new File(["late"], "late.txt", { type: "text/plain" }));
        node.dispatchEvent(
          new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }),
        );
      });
      gate.release();
      await connected(page);
      await admitted(page);
      assert.deepEqual(state.submissions[0]?.submission.input.content.blocks, [
        { text: { text: 'File: "initial.txt"\ninitial attachment' } },
      ]);
    },
  );

  await suite.test(
    "body-limit rejection preserves attachments; empty input and whitespace cannot send",
    async (t) => {
      const { page, state, url, requests } = await fixture(t, browser);
      await page.goto(new URL("sessions/alpha/conversations/1", url).href);
      await connected(page);
      await page.locator("#prompt").fill("  \n");
      await page.locator("#prompt").press("Control+Enter");
      assert.equal(requests.filter((item) => item.field === "submit").length, 0);
      const chooser = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: "Upload attachments" }).click();
      await (
        await chooser
      ).setFiles({ name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("note") });
      state.faults.submit = "too-large";
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await page.locator('#delivery-status[data-state="rejected"]').waitFor();
      assert.equal(await page.locator("#previews button").count(), 1);
      assert.equal(await page.locator("#prompt").inputValue(), "  \n");
      assert.equal(state.submissions.length, 0);
      assert.equal(requests.filter((item) => item.field === "submit").length, 1);
    },
  );

  await suite.test(
    "late submission replies cannot affect another visit, and observation never resubmits",
    async (t) => {
      const { page, state, url } = await fixture(t, browser);
      const gate = deferred();
      t.after(gate.release);
      state.hold.submit = gate.promise;
      await page.goto(new URL("sessions/alpha/conversations/1", url).href);
      await connected(page);
      await page.locator("#prompt").fill("admit after leaving");
      await page.locator("#prompt").press("Control+Enter");
      await page.locator('#delivery-status[data-state="sending"]').waitFor();
      await page.locator("#conversation-title").click();
      await page.locator('a[href="/sessions/alpha"]').click();
      await connected(page);
      await page.locator("#prompt").fill("new visit draft");
      const response = page.waitForResponse(
        async (response) =>
          response.url().endsWith("/api/graphql") &&
          (await response.json()).data?.submit !== undefined,
      );
      gate.release();
      await response;
      await page.locator("#entry-3").waitFor();
      assert.equal(state.submissions.length, 1);
      assert.equal(await page.locator("#prompt").inputValue(), "new visit draft");
      assert.equal(await page.locator("#delivery-status").getAttribute("data-state"), "unsent");
    },
  );

  await suite.test(
    "compaction is confirmed, single-flight, never replayed after an uncertain result, and preserves newer text",
    async (t) => {
      const { page, state, url, requests } = await fixture(t, browser);
      const gate = deferred();
      t.after(gate.release);
      state.hold.compact = gate.promise;
      state.loseAcknowledgement.add("compact");
      await page.goto(new URL("sessions/alpha/conversations/1", url).href);
      await connected(page);
      await page.locator("#prompt").fill("/compact preserve context");
      await page.locator("#prompt").press("Control+Enter");
      assert.equal(state.compactions.length, 0);
      await page.getByRole("button", { name: "Confirm compaction" }).click();
      assert.equal(
        await page.getByRole("button", { name: "Confirm compaction" }).isDisabled(),
        true,
      );
      await page.getByLabel("Compaction instructions", { exact: true }).press("Control+Enter");
      await page.getByRole("button", { name: "Cancel compaction" }).click();
      await page.locator("#prompt").fill("newer text while compacting");
      const response = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/graphql") &&
          response.request().postDataJSON().query.startsWith("mutation"),
      );
      gate.release();
      await response;
      await page.locator("#operation-status:not([hidden])").waitFor();
      assert.equal(state.compactions.length, 1);
      assert.equal(requests.filter((item) => item.field === "compact").length, 1);
      assert.equal(await page.locator("#prompt").inputValue(), "newer text while compacting");
    },
  );

  await suite.test(
    "explicit root creation permits an empty session without sending or resuming work",
    async (t) => {
      const { page, state, url, watchRequests } = await fixture(t, browser);
      await page.goto(new URL("sessions/zeta", url).href);
      await page.getByRole("button", { name: "Create root", exact: true }).click();
      await connected(page);
      assert.equal(new URL(page.url()).pathname, "/sessions/zeta/conversations/1");
      assert.deepEqual(state.roots, [{ harnessId: "global:z", options: {} }]);
      assert.equal(state.submissions.length, 0);
      assert.equal(state.resumes.length, 0);
      assert.deepEqual(watchRequests, [{ externalId: "zeta", conversationId: 1 }]);
    },
  );

  for (const width of [1440, 390, 320]) {
    await suite.test(
      `native footer controls, inert statistics and no focus decoration at ${width}px`,
      async (t) => {
        const { page, state, url } = await fixture(t, browser, width, 844);
        await page.goto(new URL("sessions/alpha/conversations/1", url).href);
        await connected(page);
        await configuration(page);
        assert.equal(await page.evaluate(() => document.activeElement?.tagName), "BODY");
        assert.equal(await page.locator("[autofocus], .configuration-panel").count(), 0);
        await page.locator("#prompt").fill("retained draft");
        const border = await page
          .locator("#composer-shell .compose-box")
          .evaluate((node) => getComputedStyle(node).borderColor);
        for (const id of ["thinking", "models"]) {
          const summary = page.locator(`#${id} ~ .selector-value`);
          assert.equal(
            await summary.evaluate((node) => {
              const { x, y, width, height } = node.getBoundingClientRect();
              return document.elementFromPoint(x + width / 2, y + height / 2)?.tagName;
            }),
            "SELECT",
          );
          await page.locator(`#${id}`).click();
          await page.keyboard.press(id === "thinking" ? "Home" : "End");
          if (id === "thinking") await page.keyboard.press("ArrowDown");
          await page.keyboard.press("Enter");
          await save(page);
          assert.deepEqual(
            await page.locator(`#${id}`).evaluate((node) => ({
              outline: getComputedStyle(node).outlineStyle,
              border: getComputedStyle(node).borderWidth,
              shadow: getComputedStyle(node).boxShadow,
            })),
            { outline: "none", border: "0px", shadow: "none" },
          );
        }
        assert.deepEqual({ ...state.agent.model }, { provider: "two", modelId: "same/id" });
        assert.equal(state.agent.thinkingLevel, "off");
        assert.equal(await page.locator("#prompt").inputValue(), "retained draft");
        assert.equal(
          await page
            .locator("#composer-shell .compose-box")
            .evaluate((node) => getComputedStyle(node).borderColor),
          border,
        );
        assert.equal(await page.locator("#base-directory").isVisible(), width > 650);
        assert.equal(await page.locator("#targets").isVisible(), width > 650);
        const location = page.url();
        await page.locator("#footer-context").click();
        if (width > 650) await page.locator("#footer-stats").click();
        assert.equal(page.url(), location);
        assert.equal(
          await page
            .locator("#footer-context, #footer-stats")
            .evaluateAll((nodes) =>
              nodes.every(
                (node) =>
                  node.tagName === "SPAN" &&
                  !node.hasAttribute("tabindex") &&
                  !node.hasAttribute("role"),
              ),
            ),
          true,
        );
        assert.equal(
          await page
            .locator("dialog, [role=dialog], [popover], #context-view, #usage-menu")
            .count(),
          0,
        );
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
        assert.deepEqual(
          state.configurations.map(({ change }) => change),
          [{ thinkingLevel: "off" }, { model: { provider: "two", modelId: "same/id" } }],
        );
        assert.equal(state.submissions.length, 0);
      },
    );

    await suite.test(`/cd commits only cwd and preserves newer input at ${width}px`, async (t) => {
      const { page, state, url } = await fixture(t, browser, width, 844);
      await page.goto(new URL("sessions/alpha/conversations/1", url).href);
      await connected(page);
      await configuration(page);
      const gate = deferred();
      t.after(gate.release);
      state.hold.configure = gate.promise;
      await page.locator("#prompt").fill("/cd /workspace/a path");
      await page.locator("#prompt").press("Control+Enter");
      await page.locator('#session-meta[data-save-state="saving"]').waitFor();
      await page.locator("#prompt").fill("newer message");
      gate.release();
      await save(page);
      assert.equal(await page.locator("#prompt").inputValue(), "newer message");
      assert.deepEqual(state.configurations, [
        { conversationId: "global:alpha:1", change: { cwd: "/workspace/a path" } },
      ]);
      await page.locator("#prompt").fill("/cd /workspace/next");
      await page.locator("#prompt").press("Control+Enter");
      await save(page);
      await page.waitForFunction(
        () => (document.querySelector("#prompt") as HTMLTextAreaElement).value === "",
      );
      assert.equal(state.agent.cwd, "/workspace/next");
      assert.deepEqual(state.env, instance.connect);
      assert.deepEqual(state.agent.model, { provider: "one", modelId: "same/id" });
      assert.equal(state.agent.thinkingLevel, "high");
      assert.equal(state.submissions.length, 0);
      assert.equal(state.compactions.length, 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
    });
  }

  await suite.test(
    "desktop cwd commits on Enter or blur, cancels on Escape, and never leaks an unfinished path into model saves",
    async (t) => {
      const { page, state, url } = await fixture(t, browser);
      await page.goto(new URL("sessions/alpha/conversations/1", url).href);
      await connected(page);
      await configuration(page);
      await page.locator("#base-directory").fill("/discard");
      await page.locator("#base-directory").press("Escape");
      await page.waitForFunction(
        () =>
          (document.querySelector("#base-directory") as HTMLInputElement)?.value ===
          "/workspace/one",
      );
      assert.equal(await page.locator("#base-directory").inputValue(), "/workspace/one");
      assert.equal(state.configurations.length, 0);
      await page.locator("#base-directory").fill("/blur");
      await page.locator("#prompt").click();
      await save(page);
      assert.deepEqual(state.configurations[0]?.change, { cwd: "/blur" });
      await page.locator("#base-directory").fill("/unfinished");
      await page.locator("#thinking").selectOption("low");
      await save(page);
      assert.deepEqual(state.configurations[1]?.change, { thinkingLevel: "low" });
      assert.equal(await page.locator("#base-directory").inputValue(), "/unfinished");
      await page.locator("#base-directory").press("Enter");
      await save(page);
      assert.deepEqual(state.configurations[2]?.change, { cwd: "/unfinished" });
    },
  );

  await suite.test(
    "ordinary visibility changes retain the draft; document exit abandons home creation recovery",
    async (t) => {
      const { page, state, url } = await fixture(t, browser);
      await page.goto(new URL("sessions/alpha/conversations/1", url).href);
      await connected(page);
      await page.locator("#prompt").fill("retain on tab switch");
      await page.evaluate(() => {
        Object.defineProperty(document, "hidden", { configurable: true, value: true });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await page.locator("#reconnect").waitFor();
      assert.equal(await page.locator("#prompt").inputValue(), "retain on tab switch");
      await page.evaluate(() => {
        Object.defineProperty(document, "hidden", { configurable: true, value: false });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await connected(page);
      assert.equal(await page.locator("#prompt").inputValue(), "retain on tab switch");
      await page.locator("#conversation-title").click();
      await ready(page);
      await page.locator("#prompt").fill("abandoned creation");
      const gate = deferred();
      t.after(gate.release);
      state.hold.open = gate.promise;
      await page.getByRole("button", { name: "Create session", exact: true }).click();
      await page.evaluate(() => {
        window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
        window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      });
      await ready(page);
      const response = page.waitForResponse(
        async (response) =>
          response.url().endsWith("/api/graphql") &&
          (await response.json()).data?.open !== undefined,
      );
      gate.release();
      await response;
      assert.equal(await page.locator("#prompt").inputValue(), "");
      assert.equal(new URL(page.url()).pathname, "/");
      assert.equal(state.roots.length, 0);
      assert.equal(state.submissions.length, 0);
    },
  );

  await suite.test(
    "a pre-save read cannot overwrite post-save configuration observations",
    async (t) => {
      const { page, state, url, emit } = await fixture(t, browser);
      await page.goto(new URL("sessions/alpha/conversations/1", url).href);
      await connected(page);
      await page.locator(".read-status").waitFor({ state: "detached" });
      await configuration(page);
      const gate = deferred();
      const captured = deferred();
      t.after(gate.release);
      state.holdReply.harness = { ready: captured.release, wait: gate.promise };
      state.snapshot.view.docs["pi.agent"] = { ...state.agent, cwd: "/external" };
      emit([["r", state.snapshot]]);
      await captured.promise;
      delete state.holdReply.harness;
      await page.locator("#base-directory").fill("/saved");
      await page.locator("#base-directory").press("Enter");
      await save(page);
      await page.waitForFunction(
        () => (document.querySelector("#base-directory") as HTMLInputElement)?.value === "/saved",
      );
      const staleResponse = page.waitForResponse(
        async (response) =>
          response.url().endsWith("/api/graphql") &&
          (await response.json()).data?.harness?.conversation?.agent?.cwd === "/workspace/one",
      );
      gate.release();
      await staleResponse;
      await configuration(page);
      assert.equal(await page.locator("#base-directory").inputValue(), "/saved");
    },
  );

  for (const width of [1440, 390]) {
    await suite.test(
      `compact attachment thumbnails and an unobstructed footer at ${width}px`,
      async (t) => {
        const { page, url } = await fixture(t, browser, width, 844);
        for (const path of ["", "sessions/alpha/conversations/1"]) {
          await page.goto(new URL(path, url).href);
          if (path === "") await ready(page);
          else await connected(page);
          const name = "acceptance-cases-with-a-very-long-filename.txt";
          const chooser = page.waitForEvent("filechooser");
          await page.getByRole("button", { name: "Upload attachments" }).click();
          await (
            await chooser
          ).setFiles([
            {
              name,
              mimeType: "text/plain",
              buffer: Buffer.from(
                "Preserve newer drafts.\nRecover uncertain delivery.\n".repeat(50),
              ),
            },
            { name: "reference.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") },
          ]);
          await page.locator(".attachment-document").waitFor();
          await page.getByRole("img", { name: "reference.png" }).waitFor();
          const thumbnails = await page
            .locator("#previews .attachment-thumbnail")
            .evaluateAll((nodes) =>
              nodes.map((node) => {
                const box = node.getBoundingClientRect();
                return {
                  width: box.width,
                  height: box.height,
                  overflowing:
                    node.scrollWidth > node.clientWidth || node.scrollHeight > node.clientHeight,
                };
              }),
            );
          assert.deepEqual(thumbnails, [
            { width: 64, height: 64, overflowing: false },
            { width: 64, height: 64, overflowing: false },
          ]);
          assert.equal(
            await page
              .locator(".attachment-text")
              .evaluate(
                (node) =>
                  node.getAttribute("aria-hidden") ??
                  node.parentElement?.getAttribute("aria-hidden"),
              ),
            "true",
          );
          assert(
            await page
              .locator(".attachment-text")
              .evaluate((node) => parseFloat(getComputedStyle(node).fontSize) <= 6),
          );
          assert.equal(
            await page
              .getByRole("img", { name: "reference.png" })
              .evaluate((node) => getComputedStyle(node).objectFit),
            "contain",
          );
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
          await page.getByRole("button", { name: "Remove " + name, exact: true }).click();
          await page
            .getByRole("button", { name: "Remove " + name, exact: true })
            .waitFor({ state: "detached" });
          assert.equal(await page.locator("#previews .attachment-thumbnail").count(), 1);
          assert.equal(await page.getByRole("img", { name: "reference.png" }).isVisible(), true);

          if (path !== "") {
            assert.equal(
              await page.locator("#composer-shell").evaluate((node) => node.nextElementSibling?.id),
              "session-meta",
            );
            assert.equal(await page.getByLabel("Delivery", { exact: true }).count(), 0);
            assert.equal(
              await page.getByRole("button", { name: "Compact", exact: true }).count(),
              0,
            );
            assert.equal(
              await page.getByRole("button", { name: "Resume scheduling", exact: true }).count(),
              0,
            );
            assert.equal(
              await page.getByRole("link", { name: "New session", exact: true }).count(),
              0,
            );
            await page.locator("#send").click();
            await admitted(page);
            assert.equal(await page.locator(".composer-feedback").isVisible(), false);
            assert.equal(
              await page.locator("#composer-shell").evaluate((node) => node.nextElementSibling?.id),
              "session-meta",
            );
            await configuration(page);
            for (const selector of ["#models", "#thinking"]) {
              assert.equal(
                await page.locator(selector).evaluate((node) => getComputedStyle(node).opacity),
                "0",
              );
              assert.equal(await page.locator(selector).isVisible(), true);
            }
            assert.equal(await page.locator("#targets").isVisible(), width > 650);
            assert.equal(
              await page.locator("#composer-shell").evaluate((node) => node.nextElementSibling?.id),
              "session-meta",
            );
          }
        }
      },
    );
  }
});
