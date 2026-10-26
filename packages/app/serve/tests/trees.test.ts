import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { LiveDoc, type Conversation, type EntryDraft } from "@earendil-works/pi-durable";
import { SessionTree } from "../trees.ts";
import { fixture } from "./sessions-testing.ts";

const context = BACKGROUND_CONTEXT;
const append = (conversation: Conversation, entry: EntryDraft) =>
  conversation.commit((tx) => tx.appendEntry(conversation.id, entry), context);
await test("session tree derives fork ancestry, unique history, empty-fork tips, and context boundaries", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const first = await append(session.root, {
    kind: "pi.user",
    model: [{ role: "user", content: "Start", timestamp: 1 }],
  });
  const answer = await append(session.root, {
    kind: "pi.assistant",
    model: [fauxAssistantMessage("Original answer", { timestamp: 2 })],
  });
  const fork = await session.root.fork(first.id, { ownership: { kind: "ownerless" } }, context);
  const alternative = await append(fork, {
    kind: "pi.assistant",
    model: [fauxAssistantMessage("Alternative", { timestamp: 3 })],
  });
  const empty = await fork.fork(first.id, { ownership: { kind: "ownerless" } }, context);
  const child = await session.harness.commit(
    (tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
    context,
  );
  const unrelated = await session.harness.conversation(child.id, context);
  assert(unrelated);
  const independent = await append(unrelated, {
    kind: "pi.user",
    model: [{ role: "user", content: "Independent", timestamp: 4 }],
  });
  const reset = await append(fork, { kind: "pi.reset", head: "self" });
  const compact = await append(fork, {
    kind: "pi.compaction",
    head: reset.id,
    model: [{ role: "user", content: "Summary", timestamp: 5 }],
  });
  const tree = new SessionTree(session);
  const rows = await tree.read(fork.id, context);
  assert.equal(rows.length, 6);
  assert.equal(new Set(rows.map((row) => row.id)).size, rows.length);
  const byId = new Map(rows.map((row) => [row.id, row]));
  assert.equal(byId.get(first.id)?.parent, null);
  assert.equal(byId.get(answer.id)?.parent, first.id);
  assert.equal(byId.get(alternative.id)?.parent, first.id);
  assert.equal(byId.get(independent.id)?.parent, null);
  assert.equal(byId.get(reset.id)?.parent, alternative.id);
  assert.equal(byId.get(reset.id)?.role, "event");
  assert.equal(byId.get(reset.id)?.timestamp, null);
  assert.equal(byId.get(compact.id)?.role, "event");
  assert.deepEqual(
    rows.filter((row) => row.active).map((row) => row.id),
    [first.id, alternative.id, reset.id, compact.id],
  );
  assert.deepEqual(
    rows.filter((row) => row.current).map((row) => row.id),
    [compact.id],
  );
  assert.deepEqual(
    (await tree.read(empty.id, context)).filter((row) => row.active).map((row) => row.id),
    [first.id],
  );
});

await test("session tree observes sibling commits and paginated history without rescanning on live deltas", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  const entries = await session.root.commit(async (tx) => {
    const entries = [];
    for (let index = 0; index < 270; index++)
      entries.push(
        await tx.appendEntry(session.root.id, {
          kind: "pi.user",
          model: [{ role: "user", content: `Entry ${index}`, timestamp: index }],
        }),
      );
    return entries;
  }, context);
  const tree = new SessionTree(session);
  const changes: boolean[] = [];
  const stop = session.harness.subscribeCommits((publication) =>
    changes.push(tree.invalidate(publication)),
  );
  t.after(stop);
  assert.equal((await tree.read(session.root.id, context)).length, 270);
  const commits = t.mock.method(session.harness, "commit");
  await tree.read(session.root.id, context);
  assert.equal(commits.mock.callCount(), 0);
  await session.root.commit(async (tx) => {
    const { role, api, provider, model, usage, stopReason, timestamp } =
      fauxAssistantMessage("Streaming");
    (await tx.doc(LiveDoc, session.root.id)).generation = {
      attempt: 1,
      message: {
        role,
        api,
        provider,
        model,
        usage,
        stopReason,
        timestamp,
        content: [{ type: "text", text: "Streaming" }],
      },
    };
  }, context);
  assert.equal(changes.at(-1), false);
  commits.mock.resetCalls();
  await tree.read(session.root.id, context);
  assert.equal(commits.mock.callCount(), 0);
  const fork = await session.root.fork(
    entries[0].id,
    { ownership: { kind: "ownerless" } },
    context,
  );
  const last = await append(fork, {
    kind: "pi.assistant",
    model: [fauxAssistantMessage("Sibling")],
  });
  assert.equal(changes.at(-1), true);
  const rows = await tree.read(session.root.id, context);
  assert.equal(rows.length, 271);
  assert.equal(rows.find((row) => row.id === last.id)?.parent, entries[0].id);
  assert.equal(rows.find((row) => row.id === last.id)?.active, false);
  assert.deepEqual(
    rows.filter((row) => row.current).map((row) => row.id),
    [entries.at(-1)!.id],
  );
});
