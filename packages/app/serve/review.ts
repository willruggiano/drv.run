import assert from "node:assert/strict";
import type { Context } from "@earendil-works/chord/context";
import { AgentDoc, ConversationBusy, LiveDoc, type Conversation } from "@earendil-works/pi-durable";
import { Review } from "harness";
import { Environment, SessionError, type Session } from "./sessions.ts";

export async function startReview(
  session: Session,
  original: Conversation,
  context: Context,
  scope?: string,
) {
  const id = await original.commit(async (tx) => {
    const state = await tx.doc(Review, original.id);
    if (state.original !== undefined) throw new SessionError("conflict", "Already in a review.");
    if (state.active !== undefined) return state.active;
    if ((await tx.doc(LiveDoc, original.id)).run !== undefined)
      throw new ConversationBusy(original.id);
    const agent = await tx.doc(AgentDoc, original.id);
    const environment = await tx.doc(Environment, original.id);
    // Fresh transcript; copy the current choices, not the choices at an older fork entry.
    const child = await tx.createConversation({ ownership: { kind: "ownerless" } });
    const reviewer = await tx.doc(AgentDoc, child.id);
    Object.assign(reviewer, agent);
    // Explicit extension selections must still include the review hook and tool wrappers.
    if (Array.isArray(reviewer.extensions)) {
      if (!reviewer.extensions.includes("review")) reviewer.extensions.push("review");
    } else if (reviewer.extensions) {
      reviewer.extensions = {
        add: [...new Set([...(reviewer.extensions.add ?? []), "review"])],
        remove: reviewer.extensions.remove?.filter((name) => name !== "review"),
      };
    }
    Object.assign(await tx.doc(Environment, child.id), environment);
    (await tx.doc(Review, child.id)).original = original.id;
    state.active = child.id;
    return child.id;
  }, context);
  const review = await session.harness.conversation(id, context);
  assert(review);
  // Retrying after a disconnect or restart reuses both the conversation and its input.
  await review.submit(
    {
      type: "input",
      content: `Review the ${scope?.trim() || "current code changes (staged, unstaged, and untracked files)"} and provide prioritized findings.`,
      requestId: `review:${id}`,
    },
    context,
  );
  return { id };
}

export async function endReview(session: Session, review: Conversation, context: Context) {
  const state = await session.harness.snapshot(Review, review.id, context);
  if (state?.original === undefined)
    throw new SessionError("conflict", "This conversation is not a review.");
  // /endreview is the user's escape hatch, including during an unfinished review.
  await review.abort(context);
  const answer = (await review.context(context)).messages.findLast(
    (message) => message.role === "assistant",
  );
  const report = answer?.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");

  const original = await session.harness.conversation(state.original, context);
  assert(original);
  await original.submit(
    {
      type: "input",
      content: report?.trim() ? report : "Review cancelled.",
      entry: { kind: "app.review", data: { conversationId: review.id } },
      requestId: `endreview:${review.id}`,
      whenBusy: "followUp",
    },
    context,
  );
  await original.commit(async (tx) => {
    const state = await tx.doc(Review, original.id);
    if (state.active === review.id) delete state.active;
  }, context);
  return { id: original.id };
}
