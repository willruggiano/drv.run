import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { LiveDoc } from "@earendil-works/pi-durable";
import { Review } from "harness";
import type { Page } from "playwright";
import { openSessions, browserFixture } from "./browser-testing.ts";
import { exists, fixture, readHistory } from "./sessions-testing.ts";

const context = BACKGROUND_CONTEXT;

async function command(page: Page, name: "review" | "endreview" | "fork", scope = "") {
  await page.fill("#prompt", `/${name}${scope ? ` ${scope}` : ""}`);
  await page.click("#send");
}

async function endReviewCompletion(page: Page, available: boolean) {
  const draft = await page.inputValue("#prompt");
  await page.fill("#prompt", "/endrev");
  assert.equal(await page.locator("#completions [role=option]").count(), available ? 1 : 0);
  await page.fill("#prompt", draft);
}

await test("review renders a separate conversation, survives reload, and returns its report only on endreview", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  f.faux.setResponses([fauxAssistantMessage("Implemented.")]);
  await (
    await session.root.submit({ type: "input", content: "Implement." }, context)
  ).wait(context);
  const before = await readHistory(session.root);
  const { page, base, errors } = await browserFixture(t, f.sessions);
  await page.goto(`${base}/?session=${session.id}`);
  await page.locator("#status[data-state=ready]").waitFor({ state: "attached" });
  await endReviewCompletion(page, false);
  await command(page, "endreview");
  await page.locator("#notice:not([hidden])").waitFor();
  assert.deepEqual(await readHistory(session.root), before);
  assert.equal(await page.inputValue("#prompt"), "/endreview");
  f.faux.setResponses([
    ({ messages }) => {
      assert.deepEqual(
        messages.filter((message) => message.role === "user").map(({ content }) => content),
        ["Review the packages/app lifecycle boundaries and provide prioritized findings."],
      );
      return fauxAssistantMessage(fauxToolCall("write", { path: "REVIEW.md", content: "1" }), {
        stopReason: "toolUse",
      });
    },
    fauxAssistantMessage("Review saved to REVIEW.md."),
  ]);
  await command(page, "review", "packages/app lifecycle boundaries");
  await page.waitForURL((url) => url.searchParams.has("conversation"));
  const id = (await session.harness.snapshot(Review, session.root.id, context))?.active;
  assert(id !== undefined);
  const review = await session.harness.conversation(id, context);
  assert(review);
  await review.waitForIdle(context);
  await page.locator('#transcript .tool-call[data-tool="write"][data-state="completed"]').waitFor();
  await page.locator("#status[data-state=ready]").waitFor({ state: "attached" });
  assert.equal(Number(new URL(page.url()).searchParams.get("conversation")), review.id);
  assert.equal(await page.locator('#transcript > article[data-role="user"]').count(), 1);
  assert.equal(await page.locator('#transcript > article[data-role="assistant"]').count(), 2);
  assert.equal(JSON.parse(await readFile(join(f.workspace, "REVIEW.md"), "utf8")), 1);
  assert.deepEqual(await readHistory(session.root), before);
  assert.equal(await page.inputValue("#prompt"), "");
  assert.equal(
    await page.evaluate((id) => sessionStorage.getItem(`pi.draft:${id}:main`), session.id),
    "",
  );

  await page.reload();
  await page.locator("#status[data-state=ready]").waitFor({ state: "attached" });
  await page.locator('#transcript .tool-call[data-tool="write"][data-state="completed"]').waitFor();
  assert.equal(Number(new URL(page.url()).searchParams.get("conversation")), review.id);
  await endReviewCompletion(page, true);
  // Ordinary branch navigation must preserve both transcripts and drafts.
  await command(page, "fork");
  await page.locator(`#branches [data-conversation="${session.root.id}"]`).click();
  await page.locator("#status[data-state=ready]").waitFor({ state: "attached" });
  assert.equal(await page.locator('#transcript > article[data-role="assistant"]').count(), 1);
  await command(page, "fork");
  await page.locator("#branch-picker:not([hidden])").waitFor();
  await page.fill("#prompt", "Keep this draft.");
  await page.locator(`#branches [data-conversation="${review.id}"]`).click();
  await page.locator("#status[data-state=ready]").waitFor({ state: "attached" });
  f.faux.setResponses([fauxAssistantMessage("Addressing review.")]);
  await command(page, "endreview");
  await page.waitForURL((url) => !url.searchParams.has("conversation"));
  await session.root.waitForIdle(context);
  await page.locator("#status[data-state=ready]").waitFor({ state: "attached" });
  assert.equal(await page.inputValue("#prompt"), "Keep this draft.");
  await endReviewCompletion(page, false);
  assert.equal(await page.locator('#transcript > article[data-role="user"]').count(), 2);
  assert.equal(
    (await readHistory(session.root)).filter((entry) => entry.kind === "app.review").length,
    1,
  );
  assert.equal(
    (await session.harness.snapshot(Review, session.root.id, context))?.active,
    undefined,
  );
  assert.deepEqual(errors, []);
});

await test("endreview cancels an active review and returns to the selected source branch", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  f.faux.setResponses([fauxAssistantMessage("Implemented.")]);
  await (
    await session.root.submit({ type: "input", content: "Implement." }, context)
  ).wait(context);
  const before = await readHistory(session.root);
  const branch = await session.root.fork(
    before.at(-1)!.id,
    { ownership: { kind: "ownerless" } },
    context,
  );
  const { page, base, errors } = await browserFixture(t, f.sessions);
  await page.goto(`${base}/?session=${session.id}&conversation=${branch.id}`);
  await page.locator("#status[data-state=ready]").waitFor({ state: "attached" });
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 30" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Review cancelled."),
  ]);
  await command(page, "review");
  await page.waitForURL((url) => Number(url.searchParams.get("conversation")) !== branch.id);
  const id = (await session.harness.snapshot(Review, branch.id, context))?.active;
  assert(id !== undefined);
  await page.locator('#transcript .tool-call[data-tool="bash"][data-state="running"]').waitFor();
  await page.locator("#status[data-state=working]").waitFor({ state: "attached" });
  await endReviewCompletion(page, true);
  await command(page, "endreview");
  await page.waitForURL((url) => Number(url.searchParams.get("conversation")) === branch.id);
  await branch.waitForIdle(context);
  await page.locator("#status[data-state=ready]").waitFor({ state: "attached" });
  assert.equal((await session.harness.snapshot(LiveDoc, id, context))?.run, undefined);
  assert.equal(await exists(join(f.workspace, "REVIEW.md")), false);
  assert.equal(
    (await readHistory(branch)).filter((entry) => entry.kind === "app.review").length,
    1,
  );
  assert.deepEqual(await readHistory(session.root), before);
  assert.deepEqual(errors, []);
});

await test("a delayed review command does not navigate away from a subsequently selected session", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const other = await f.create();
  const { page, base, errors } = await browserFixture(t, f.sessions);
  await page.goto(`${base}/?session=${session.id}`);
  await page.locator("#status[data-state=ready]").waitFor({ state: "attached" });
  const received = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  await page.route(`**/api/harness/${session.id}/submit`, async (route) => {
    const response = await route.fetch();
    received.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  f.faux.setResponses([fauxAssistantMessage("No findings.")]);
  await command(page, "review");
  await received.promise;
  await openSessions(page);
  await page.locator(`#sessions [data-session="${other.id}"]`).click();
  await page.locator("#status[data-state=ready]").waitFor({ state: "attached" });
  await page.fill("#prompt", "Unrelated draft.");
  release.resolve();
  await page.locator("#send:not([disabled])").waitFor();
  assert.equal(new URL(page.url()).searchParams.get("session"), other.id);
  assert.equal(new URL(page.url()).searchParams.has("conversation"), false);
  assert.equal(await page.inputValue("#prompt"), "Unrelated draft.");
  const id = (await session.harness.snapshot(Review, session.root.id, context))?.active;
  assert(id !== undefined);
  const review = await session.harness.conversation(id, context);
  assert(review);
  await review.waitForIdle(context);
  assert.equal(f.faux.state.callCount, 1);
  assert.deepEqual(errors, []);
});
