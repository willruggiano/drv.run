import * as runtime from "../sessions.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import { readHistory, fixture } from "./sessions-testing.ts";
import { serve, snapshot } from "./testing.ts";

const context = BACKGROUND_CONTEXT;
const text = (tokens: number) => "x".repeat(Math.floor(tokens * 3.5));
const user = (tokens: number): Message => ({ role: "user", content: text(tokens), timestamp: 1 });

await test("Context HTTP inspection is scoped, read-only and available without its execution target", async (t) => {
  const f = await fixture(t);
  const session = await f.create();
  await session.root.submit(
    { type: "write", entry: { kind: "pi.user", model: [user(20)] } },
    context,
  );
  const last = (await readHistory(session.root)).at(-1)!;
  const branch = await session.root.fork(last.id, { ownership: { kind: "ownerless" } }, context);
  await branch.reset(undefined, context);
  const before = await readHistory(session.root);
  await f.reopen({ env: undefined, targets: async () => [] });
  const restored = await f.sessions.get(session.id);
  const base = await serve(t, f.sessions);
  const url = `${base}/api/harness/${session.id}/watch`;
  for (const selected of [
    restored.root,
    await runtime.getConversation(restored, branch.id),
    restored.root,
  ]) {
    const state = await snapshot(`${url}?conversation=${selected.id}`);
    assert.equal(state.inspection.state, "available");
    assert(state.inspection.state === "available");
    assert.equal(state.inspection.conversation, state.view.conversation.id);
    assert.equal(state.inspection.tokens, selected.id === branch.id ? 0 : 20);
    assert.deepEqual(
      state.inspection.messages.map((message) => message.tokens),
      (await selected.context(context)).messages.map(estimateMessageTokens),
    );
  }
  assert.equal((await fetch(`${url}?conversation=999999`)).status, 404);
  assert.deepEqual(await readHistory(restored.root), before);
  assert.equal(f.faux.state.callCount, 0);
  assert.equal((await restored.harness.inspect(context)).tasks.length, 0);
});
