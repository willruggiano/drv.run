import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  AgentDoc,
  LiveDoc,
  ToolResultEntry,
  type AgentChange,
  type JsonObject,
} from "@earendil-works/pi-durable";
import { createBashTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { endReview, startReview } from "../review.ts";
import { Environment } from "../sessions.ts";
import { code, exists, fixture, readHistory, waitFor } from "./sessions-testing.ts";

const context = BACKGROUND_CONTEXT;
const call = (name: string, args: JsonObject) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

await test("review commands start fresh from the selected branch and return its latest review as input", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  f.faux.setResponses([fauxAssistantMessage("Implementation complete.")]);
  await (
    await session.root.submit({ type: "input", content: "Implement it." }, context)
  ).wait(context);
  const at = (await readHistory(session.root)).at(-1)!;
  const branch = await session.root.fork(at.id, { ownership: { kind: "ownerless" } }, context);
  // Changes after the fork entry must reach the reviewer, not just the historical choices.
  await branch.configure({ thinkingLevel: "high", instructions: "Project conventions." }, context);
  const before = await readHistory(branch);
  const findings = fauxAssistantMessage("Check the missing validation at server.ts:12.");
  f.faux.setResponses([
    ({ messages }) => {
      assert.deepEqual(
        messages.filter((message) => message.role !== "system").map((message) => message.role),
        ["user"],
      );
      return call("write", { path: "REVIEW.md", content: "Check server.ts:12." });
    },
    findings,
  ]);
  const { id } = await startReview(session, branch, context);
  assert.notEqual(id, branch.id);
  const review = await session.harness.conversation(id, context);
  assert(review);
  await review.waitForIdle(context);
  assert.deepEqual(await readHistory(branch), before);
  assert.deepEqual(
    (await review.agent(context)).tools.map((tool) => tool.name),
    ["read", "write", "edit", "bash", "web_search", "web_fetch"],
  );
  assert.equal((await review.agent(context)).thinkingLevel, "high");
  assert.deepEqual(await startReview(session, branch, context), { id });
  assert.equal(f.faux.state.callCount, 3);
  assert.equal(await exists(join(f.workspace, "REVIEW.md")), true);

  const revised = fauxAssistantMessage(
    "The remaining finding is missing validation at server.ts:12.",
  );
  f.faux.setResponses([revised]);
  await (
    await review.submit({ type: "input", content: "Recheck the findings." }, context)
  ).wait(context);
  f.faux.setResponses([
    ({ messages }) => {
      const input = messages.findLast((message) => message.role === "user");
      assert(input?.role === "user");
      assert.deepEqual([{ type: "text", text: input.content }], revised.content);
      return fauxAssistantMessage("Addressing the review.");
    },
  ]);
  assert.deepEqual(await endReview(session, review, context), { id: branch.id });
  await branch.waitForIdle(context);
  assert.equal(f.faux.state.callCount, 5);
  const reports = (await readHistory(branch)).filter((entry) => entry.kind === "app.review");
  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0].data, { conversationId: id });
  assert.deepEqual(await readHistory(session.root), before);
});

await test("review inherits current settings and environment without widening tool selections", async (t) => {
  for (const tools of [
    undefined,
    [createReadTool(), createWriteTool()],
    { remove: [createBashTool()] },
  ] satisfies AgentChange["tools"][]) {
    await t.test(
      Array.isArray(tools) ? "allowlist" : tools ? "denylist" : "defaults",
      async (t) => {
        const f = await fixture(t);
        const session = await f.create();
        await session.root.configure(
          {
            tools,
            modelTools: [createReadTool()],
            thinkingLevel: "high",
            instructions: "Keep these instructions.",
          },
          context,
        );
        const before = await session.harness.snapshot(AgentDoc, session.root.id, context);
        f.faux.setResponses([fauxAssistantMessage("No findings.")]);
        const { id } = await startReview(session, session.root, context);
        const review = await session.harness.conversation(id, context);
        assert(review);
        await review.waitForIdle(context);
        const agent = await session.harness.snapshot(AgentDoc, id, context);
        assert.deepEqual(agent, before);
        assert.deepEqual(
          await session.harness.snapshot(AgentDoc, session.root.id, context),
          before,
        );
        assert.deepEqual(
          await session.harness.snapshot(Environment, id, context),
          await session.harness.snapshot(Environment, session.root.id, context),
        );
        const original = await session.root.agent(context);
        const reviewer = await review.agent(context);
        for (const key of ["tools", "callable", "deferred"] as const)
          assert.deepEqual(
            reviewer[key].map((tool) => tool.name),
            original[key].map((tool) => tool.name),
          );
      },
    );
  }
});

await test("review commands survive restart, deduplicate retries, and allow a subsequent review", async (t) => {
  const f = await fixture(t);
  let session = await f.create();
  f.faux.setResponses([fauxAssistantMessage("No findings.")]);
  const first = await startReview(session, session.root, context);
  await (await session.harness.conversation(first.id, context))!.waitForIdle(context);
  await f.reopen();
  session = await f.sessions.get(session.id);
  assert.deepEqual(await startReview(session, session.root, context), first);
  const review = await session.harness.conversation(first.id, context);
  assert(review);
  f.faux.setResponses([fauxAssistantMessage("Review received.")]);
  assert.deepEqual(await endReview(session, review, context), { id: session.root.id });
  await session.root.waitForIdle(context);
  const history = await readHistory(session.root);
  await f.reopen();
  session = await f.sessions.get(session.id);
  await endReview(session, (await session.harness.conversation(first.id, context))!, context);
  await session.root.waitForIdle(context);
  assert.deepEqual(await readHistory(session.root), history);
  assert.equal(f.faux.state.callCount, 2);
  f.faux.setResponses([fauxAssistantMessage("Rechecked. No findings.")]);
  const second = await startReview(session, session.root, context);
  assert.notEqual(second.id, first.id);
  await (await session.harness.conversation(second.id, context))!.waitForIdle(context);
});

await test("endreview cancels unfinished work without a report or final answer", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  await assert.rejects(endReview(session, session.root, context), code("conflict"));
  f.faux.setResponses([
    call("bash", { command: "sleep 30" }),
    fauxAssistantMessage("Cancelled review received."),
  ]);
  const { id } = await startReview(session, session.root, context);
  const review = await session.harness.conversation(id, context);
  assert(review);
  await waitFor(
    async () => !!(await session.harness.snapshot(LiveDoc, id, context))?.tools?.length,
  );
  await assert.rejects(startReview(session, review, context), code("conflict"));
  assert.deepEqual(await endReview(session, review, context), { id: session.root.id });
  await session.root.waitForIdle(context);
  assert.equal((await session.harness.snapshot(LiveDoc, id, context))?.run, undefined);
  assert.equal(await exists(join(f.workspace, "REVIEW.md")), false);
  assert.equal(f.faux.state.callCount, 2);
});

await test("review keeps running until its latest answer contains the exact completion phrase", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  f.faux.setResponses([
    fauxAssistantMessage("No findings"),
    fauxAssistantMessage("no findings."),
    fauxAssistantMessage("No Findings."),
    fauxAssistantMessage("No findings. Review complete."),
  ]);
  const { id } = await startReview(session, session.root, context);
  const review = await session.harness.conversation(id, context);
  assert(review);
  await review.waitForIdle(context);
  assert.equal(f.faux.state.callCount, 4);
  assert.equal(await exists(join(f.workspace, "REVIEW.md")), false);
  assert.deepEqual(await readHistory(session.root), []);
  // An earlier completion phrase does not authorize a later answer.
  f.faux.setResponses([
    fauxAssistantMessage("Found a bug on the second pass."),
    call("write", { path: "REVIEW.md", content: "A finding." }),
    fauxAssistantMessage("Saved to REVIEW.md."),
  ]);
  await (await review.submit({ type: "input", content: "Look again." }, context)).wait(context);
  assert.equal(f.faux.state.callCount, 7);
  assert.equal(await exists(join(f.workspace, "REVIEW.md")), true);
});

await test("review writes and edits only REVIEW.md; ordinary conversations retain unrestricted tools", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  await writeFile(join(f.workspace, "other.json"), "0");
  await mkdir(join(f.workspace, "nested"));
  f.faux.setResponses([
    call("write", { path: "nested/REVIEW.md", content: "1" }),
    call("write", { path: "../escaped.json", content: "1" }),
    call("edit", { path: "other.json", edits: [{ oldText: "0", newText: "1" }] }),
    call("write", { path: join(f.workspace, "REVIEW.md"), content: "1" }),
    call("edit", { path: "./REVIEW.md", edits: [{ oldText: "1", newText: "2" }] }),
    fauxAssistantMessage("Review saved to REVIEW.md."),
  ]);
  const { id } = await startReview(session, session.root, context);
  const review = await session.harness.conversation(id, context);
  assert(review);
  await review.waitForIdle(context);
  assert.equal(f.faux.state.callCount, 6);
  assert.equal(JSON.parse(await readFile(join(f.workspace, "REVIEW.md"), "utf8")), 2);
  assert.equal(JSON.parse(await readFile(join(f.workspace, "other.json"), "utf8")), 0);
  assert.equal(await exists(join(f.workspace, "nested/REVIEW.md")), false);
  assert.deepEqual(
    (await readHistory(review))
      .filter((entry) => ToolResultEntry.is(entry))
      .map((entry) => entry.data.diagnostics.map((item) => item.code)),
    [["review_path"], ["review_path"], ["review_path"], [], []],
  );
  f.faux.setResponses([
    call("write", { path: "other.json", content: "3" }),
    call("edit", { path: "other.json", edits: [{ oldText: "3", newText: "4" }] }),
    fauxAssistantMessage("Done."),
  ]);
  await (await session.root.submit({ type: "input", content: "Continue." }, context)).wait(context);
  assert.equal(JSON.parse(await readFile(join(f.workspace, "other.json"), "utf8")), 4);
});

await test("explicit extension selections cannot omit the review hook or wrappers", async (t) => {
  for (const mode of ["allowlist", "remove"] as const)
    await t.test(mode, async (t) => {
      const f = await fixture(t);
      const session = await f.create();
      const extensions = (await session.root.agent(context)).extensions;
      await session.root.configure(
        {
          extensions:
            mode === "allowlist"
              ? extensions.filter((extension) => extension.name !== "review")
              : { remove: extensions.filter((extension) => extension.name === "review") },
        },
        context,
      );
      const before = await session.harness.snapshot(AgentDoc, session.root.id, context);
      f.faux.setResponses([
        call("write", { path: "other.json", content: "1" }),
        fauxAssistantMessage("Not finished."),
        fauxAssistantMessage("No findings."),
      ]);
      const { id } = await startReview(session, session.root, context);
      const review = await session.harness.conversation(id, context);
      assert(review);
      await review.waitForIdle(context);
      assert.equal(f.faux.state.callCount, 3);
      assert.equal(await exists(join(f.workspace, "other.json")), false);
      assert.deepEqual(await session.harness.snapshot(AgentDoc, session.root.id, context), before);
    });
});

await test("a symlink REVIEW.md neither permits mutations nor completes a review", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  await writeFile(join(f.workspace, "other.json"), "0");
  await symlink("other.json", join(f.workspace, "REVIEW.md"));
  f.faux.setResponses([
    call("write", { path: "REVIEW.md", content: "1" }),
    call("edit", { path: "REVIEW.md", edits: [{ oldText: "0", newText: "1" }] }),
    fauxAssistantMessage("Review complete."),
    fauxAssistantMessage("No findings."),
  ]);
  const { id } = await startReview(session, session.root, context);
  const review = await session.harness.conversation(id, context);
  assert(review);
  await review.waitForIdle(context);
  assert.equal(f.faux.state.callCount, 4);
  assert.equal(JSON.parse(await readFile(join(f.workspace, "other.json"), "utf8")), 0);
  assert.deepEqual(
    (await readHistory(review))
      .filter((entry) => ToolResultEntry.is(entry))
      .map((entry) => entry.data.diagnostics.map((item) => item.code)),
    [["review_path"], ["review_path"]],
  );
});
