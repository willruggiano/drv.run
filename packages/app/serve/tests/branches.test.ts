import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { InboxDoc, LiveDoc } from "@earendil-works/pi-durable";
import { Review } from "harness";
import { BranchTree } from "../branches.ts";
import { fixture } from "./sessions-testing.ts";

const context = BACKGROUND_CONTEXT;

await test("branch activity is local, persists, and distinguishes forks and reviews", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const tree = new BranchTree(session);
  t.after(session.harness.subscribeCommits((publication) => tree.invalidate(publication)));
  assert.deepEqual(await tree.read(context), [
    {
      id: session.root.id,
      parent: null,
      title: "Main",
      state: "pending",
      activity: null,
    },
  ]);
  const at = await session.root.commit(
    (tx) =>
      tx.appendEntry(session.root.id, {
        kind: "pi.assistant",
        model: [fauxAssistantMessage("Done", { timestamp: 1000 })],
      }),
    context,
  );
  const branch = await session.root.fork(at.id, { ownership: { kind: "ownerless" } }, context);
  const nested = await branch.fork(at.id, { ownership: { kind: "ownerless" } }, context);
  const review = await session.root.commit(async (tx) => {
    const child = await tx.createConversation({ ownership: { kind: "ownerless" } });
    (await tx.doc(Review, child.id)).original = branch.id;
    return child.id;
  }, context);
  let rows = await tree.read(context);
  assert.equal(rows.find((row) => row.id === session.root.id)?.activity, 1000);
  assert.deepEqual(
    rows.find((row) => row.id === branch.id),
    {
      id: branch.id,
      parent: session.root.id,
      title: `Branch ${branch.id}`,
      state: "pending",
      activity: null,
    },
  );
  assert.equal(rows.find((row) => row.id === nested.id)?.parent, branch.id);
  assert.deepEqual(
    rows.find((row) => row.id === review),
    {
      id: review,
      parent: branch.id,
      title: `Review ${review}`,
      state: "pending",
      activity: null,
    },
  );
  for (const [stopReason, expected] of [
    ["error", "failed"],
    ["aborted", "cancelled"],
    ["stop", "completed"],
  ] as const) {
    await branch.commit(
      (tx) =>
        tx.appendEntry(branch.id, {
          kind: "pi.assistant",
          model: [fauxAssistantMessage("Result", { timestamp: 2000, stopReason })],
        }),
      context,
    );
    rows = await tree.read(context);
    assert.equal(rows.find((row) => row.id === branch.id)?.state, expected);
    assert.equal(rows.find((row) => row.id === branch.id)?.activity, 2000);
    assert.equal(rows.find((row) => row.id === nested.id)?.activity, null);
  }
  // A context marker with no messages must not erase the last activity.
  await branch.commit(
    (tx) => tx.appendEntry(branch.id, { kind: "pi.reset", head: "self" }),
    context,
  );
  assert.equal((await tree.read(context)).find((row) => row.id === branch.id)?.activity, 2000);
  const before = await tree.read(context);
  await f.reopen();
  const restored = await f.sessions.get(session.id);
  assert.deepEqual(await new BranchTree(restored).read(context), before);
});

await test("branch activity follows running and completed work without token-delta invalidation", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const tree = new BranchTree(session);
  t.after(session.harness.subscribeCommits((publication) => tree.invalidate(publication)));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  t.after(() => release.resolve());
  f.faux.setResponses([
    async () => {
      entered.resolve();
      await release.promise;
      return fauxAssistantMessage("Done");
    },
  ]);
  const submission = await session.root.submit({ type: "input", content: "Work" }, context);
  await entered.promise;
  const running = (await tree.read(context))[0];
  assert.equal(running.state, "running");
  assert.ok(running.activity !== null);
  let invalidated = false;
  const stop = session.harness.subscribeCommits((publication) => {
    invalidated ||= tree.invalidate(publication);
  });
  await session.root.commit(async (tx) => {
    const live = await tx.doc(LiveDoc, session.root.id);
    const { role, api, provider, model, usage, stopReason, timestamp } =
      fauxAssistantMessage("Partial");
    live.generation = {
      attempt: 0,
      message: {
        role,
        api,
        provider,
        model,
        usage,
        stopReason,
        timestamp,
        content: [{ type: "text", text: "Partial" }],
      },
    };
  }, context);
  stop();
  assert.equal(invalidated, false);
  assert.equal((await tree.read(context))[0], running);
  release.resolve();
  await submission.wait(context);
  await session.root.waitForIdle(context);
  const completed = (await tree.read(context))[0];
  assert.equal(completed.state, "completed");
  assert.ok(completed.activity !== null && completed.activity >= running.activity);
  await session.root.commit(async (tx) => {
    // A queued passive entry has no wall-clock timestamp of its own.
    const item = await tx.createSubmission({
      conversationId: session.root.id,
      type: "write",
      status: "queued",
    });
    (await tx.doc(InboxDoc, session.root.id)).items.push({
      id: item.id,
      mode: "write",
      entry: { kind: "test.queued" },
    });
  }, context);
  assert.equal((await tree.read(context))[0].state, "pending");
});

await test("branch enumeration includes every page and ignores inherited bookkeeping", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  await session.root.commit(async (tx) => {
    for (let index = 0; index < 260; index++)
      await tx.createConversation({ ownership: { kind: "ownerless" } });
    await tx.appendEntry(session.root.id, {
      kind: "pi.user",
      model: [{ role: "user", content: "Hi", timestamp: 1000 }],
    });
    for (let index = 0; index < 65; index++)
      await tx.appendEntry(session.root.id, { kind: "test.marker" });
  }, context);
  const rows = await new BranchTree(session).read(context);
  assert.equal(rows.length, 261);
  assert.equal(rows[0].activity, 1000);
  assert.equal(new Set(rows.map((row) => row.id)).size, 261);
});
