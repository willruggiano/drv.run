import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
import { post, serve, snapshot } from "./testing.ts";

const context = BACKGROUND_CONTEXT;
const call = (name: string, args: JsonObject) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

await test("HTTP review commands select conversations without submitting slash text to the model", async (t) => {
  for (const fork of [false, true])
    await t.test(fork ? "branch" : "root", async (t) => {
      const f = await fixture(t);
      const session = await f.create();
      f.faux.setResponses([fauxAssistantMessage("Implemented.")]);
      await (
        await session.root.submit({ type: "input", content: "Implement." }, context)
      ).wait(context);
      const at = (await readHistory(session.root)).at(-1)!;
      const original = fork
        ? await session.root.fork(at.id, { ownership: { kind: "ownerless" } }, context)
        : session.root;
      const before = await readHistory(original);
      const base = await serve(t, f.sessions);
      const resource = `${base}/api/harness/${session.id}`;
      const submit = (id: number, content: string) =>
        post(`${resource}/submit?conversation=${id}`, { type: "input", content });
      assert.equal((await submit(original.id, "/endreview")).status, 409);
      f.faux.setResponses([fauxAssistantMessage("No findings.")]);
      const response = await submit(original.id, "/review");
      assert.equal(response.status, 200);
      const result = await response.json();
      assert(Number.isSafeInteger(result.conversationId));
      assert.notEqual(result.conversationId, original.id);
      assert.deepEqual(await (await submit(original.id, "/review")).json(), result);
      const review = await session.harness.conversation(result.conversationId, context);
      assert(review);
      await review.waitForIdle(context);
      assert.equal((await submit(review.id, "/review")).status, 409);
      assert.deepEqual(await readHistory(original), before);
      const view = await snapshot(`${resource}/watch?conversation=${review.id}`);
      assert.equal(view.view.conversation.id, review.id);
      assert.equal(view.session.reviewOf, original.id);
      assert.deepEqual(
        view.history?.toSorted((a, b) => a.id - b.id),
        await readHistory(review),
      );
      assert.equal(
        view.history?.some((entry) => before.some((old) => old.id === entry.id)),
        false,
      );
      assert.deepEqual(
        await (
          await fetch(`${resource}/snapshot?conversation=${review.id}&kind=app.review`)
        ).json(),
        { original: original.id },
      );
      f.faux.setResponses([fauxAssistantMessage("Received review.")]);
      const ended = await submit(review.id, "/endreview");
      assert.equal(ended.status, 200);
      const destination = { conversationId: fork ? original.id : null };
      assert.deepEqual(await ended.json(), destination);
      assert.deepEqual(await (await submit(review.id, "/endreview")).json(), destination);
      await original.waitForIdle(context);
      const reports = (await readHistory(original)).filter((entry) => entry.kind === "app.review");
      assert.equal(reports.length, 1);
      assert.deepEqual(reports[0].data, { conversationId: review.id });
      assert.equal(f.faux.state.callCount, 3);
    });
});

await test("HTTP review scopes compose the review input and retries preserve the original input", async (t) => {
  for (const [command, scope] of [
    ["/review", "current code changes (staged, unstaged, and untracked files)"],
    ["  /review \t\n", "current code changes (staged, unstaged, and untracked files)"],
    ["/review packages/app", "packages/app"],
    [
      "/review\tchanges against main\nwith emphasis on cancellation  ",
      "changes against main\nwith emphasis on cancellation",
    ],
  ]) {
    await t.test(command, async (t) => {
      const f = await fixture(t);
      const session = await f.create();
      f.faux.setResponses([
        ({ messages }) => {
          assert.deepEqual(
            messages.filter((message) => message.role === "user").map(({ content }) => content),
            [`Review the ${scope} and provide prioritized findings.`],
          );
          const sections = messages.find((message) => message.role === "system")?.sections;
          assert(sections?.review);
          assert.equal(sections["review-guidelines"], undefined);
          return fauxAssistantMessage("No findings.");
        },
      ]);
      const base = await serve(t, f.sessions);
      const url = `${base}/api/harness/${session.id}/submit`;
      const response = await post(url, { type: "input", content: command });
      assert.equal(response.status, 200);
      const result = await response.json();
      const review = await session.harness.conversation(result.conversationId, context);
      assert(review);
      await review.waitForIdle(context);
      const before = await readHistory(review);
      const retry = await post(url, { type: "input", content: "/review a different scope" });
      assert.equal(retry.status, 200);
      assert.deepEqual(await retry.json(), result);
      assert.deepEqual(await readHistory(review), before);
      assert.deepEqual(await readHistory(session.root), []);
      assert.equal(f.faux.state.callCount, 1);
    });
  }
});

await test("review guidelines use the selected cwd and appear only in review conversations", async (t) => {
  const f = await fixture(t);
  const cwd = join(f.workspace, "nested");
  await mkdir(cwd);
  await mkdir(join(f.workspace, ".git"));
  await writeFile(join(f.workspace, "REVIEW_GUIDELINES.md"), "Wrong directory.");
  const path = join(cwd, "REVIEW_GUIDELINES.md");
  await writeFile(path, "Check cancellation.\n");
  const session = await f.create();
  await session.root.configure({ cwd }, context);
  f.faux.setResponses([
    ({ messages }) => {
      const sections = messages.find((message) => message.role === "system")?.sections;
      assert.equal(sections?.review, undefined);
      assert.equal(sections?.["review-guidelines"], undefined);
      return fauxAssistantMessage("Done.");
    },
  ]);
  await (await session.root.submit({ type: "input", content: "Work." }, context)).wait(context);
  f.faux.setResponses([
    ({ messages }) => {
      const sections = messages.find((message) => message.role === "system")?.sections;
      assert(sections?.review);
      assert.deepEqual(
        sections["review-guidelines"],
        "<review-guidelines>\nCheck cancellation.\n\n</review-guidelines>",
      );
      return fauxAssistantMessage("No findings.");
    },
  ]);
  const { id } = await startReview(session, session.root, context);
  const review = await session.harness.conversation(id, context);
  assert(review);
  await review.waitForIdle(context);

  // Rendering uses the execution environment on every request, not a cached server-side read.
  const agent = await review.agent(context);
  const section = agent.sections.find((section) => section.key === "review-guidelines");
  assert(section);
  const env = await f.options.env({ conversationId: id, cwd, read: session.harness }, context);
  const input = { conversationId: id, agent, env, read: session.harness, shown: {} };
  await writeFile(path, "Check cleanup.");
  assert.deepEqual(await section.render(input, context), "Check cleanup.");
  await rm(path);
  assert.equal(await section.render(input, context), undefined);
  await mkdir(path);
  await assert.rejects(async () => section.render(input, context));
});

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
