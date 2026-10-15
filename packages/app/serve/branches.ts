import assert from "node:assert/strict";
import type { Context } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import {
  InboxDoc,
  type CommitPublication,
  type ConversationId,
  type Cursor,
} from "@earendil-works/pi-durable";
import { Review } from "harness";
import type { Session } from "./sessions.ts";

export type Branch = {
  id: ConversationId;
  parent: ConversationId | null;
  title: string;
  state: "pending" | "running" | "completed" | "failed" | "cancelled" | "unavailable";
  activity: number | null;
};

function messageState(message: Message): Branch["state"] {
  if (message.role === "user") return "pending";
  if (message.role === "toolResult") return message.isError ? "failed" : "completed";
  if (message.role !== "assistant") return "unavailable";
  return message.stopReason === "error"
    ? "failed"
    : message.stopReason === "aborted"
      ? "cancelled"
      : message.stopReason === "toolUse"
        ? "pending"
        : "completed";
}

/** Per-reader cache. Token/output deltas do not rescan the session's history. */
export class BranchTree {
  private readonly branches = new Map<ConversationId, Branch>();
  private readonly dirty = new Set<ConversationId>();
  private initialized = false;
  private readonly session: Session;
  constructor(session: Session) {
    this.session = session;
  }

  invalidate(publication: CommitPublication): boolean {
    let changed = false;
    for (const change of publication.changes) {
      const id =
        change.type === "conversation"
          ? change.value.id
          : change.type === "entry" || change.type === "task" || change.type === "submission"
            ? change.value.conversationId
            : (change.type === "document" || change.type === "document.copy") &&
                [Review.definition.kind, InboxDoc.definition.kind].includes(change.record.kind)
              ? change.conversationId
              : undefined;
      if (typeof id === "number") {
        this.dirty.add(id);
        changed = true;
      }
    }
    return changed;
  }

  async read(context: Context): Promise<Branch[]> {
    if (!this.initialized) {
      let cursor: Cursor | undefined;
      do {
        const page = await this.session.harness.commit(
          (tx) => tx.scanConversations({}, 256, cursor),
          context,
        );
        for (const record of page.items) this.dirty.add(record.id);
        cursor = page.next;
      } while (cursor);
      this.initialized = true;
    }
    const ids = [...this.dirty];
    this.dirty.clear();
    for (const id of ids) this.branches.set(id, await this.readBranch(id, context));
    return [...this.branches.values()].sort((a, b) => a.id - b.id);
  }

  private async readBranch(id: ConversationId, context: Context): Promise<Branch> {
    const { record, activity, state, active } = await this.session.harness.commit(async (tx) => {
      const record = await tx.conversation(id);
      assert(record);
      let activity: number | null = null;
      let state: Branch["state"] = "pending";
      let cursor: Cursor | undefined;
      let latest: Message | undefined;
      // Fork ancestry is navigation, not activity in this branch.
      do {
        const page = await tx.scanEntries({ conversationId: id, order: "descending" }, 64, cursor);
        let inherited = false;
        for (const entry of page.items) {
          if (entry.conversationId !== id) {
            inherited = true;
            break;
          }
          for (const message of entry.model ?? []) {
            if (
              Number.isFinite(message.timestamp) &&
              (!latest || message.timestamp > latest.timestamp)
            )
              latest = message;
          }
          if (latest) break;
        }
        cursor = !latest && !inherited ? page.next : undefined;
      } while (cursor);
      if (latest) {
        activity = latest.timestamp;
        state = messageState(latest);
      }
      let active: "running" | "pending" | undefined;
      cursor = undefined;
      do {
        const page = await tx.scanTasks({ conversationId: id, background: false }, 256, cursor);
        for (const task of page.items) {
          if (task.state.status !== "terminal") {
            if (task.state.status !== "pending") active = "running";
            else active ??= "pending";
          }
          const timestamp = task.endedAt ?? task.startedAt;
          if (
            timestamp === undefined ||
            !Number.isFinite(timestamp) ||
            (activity !== null && timestamp < activity)
          )
            continue;
          activity = timestamp;
          // A failed tool can be recovered by its run; it is not the run's outcome.
          if (task.state.status === "terminal" && task.owner === undefined) {
            const outcome = task.state.outcome.status;
            state =
              outcome === "completed"
                ? "completed"
                : outcome === "aborted"
                  ? "cancelled"
                  : "failed";
          }
        }
        cursor = page.next;
      } while (cursor);
      return { record, activity, state, active };
    }, context);
    const review = await this.session.harness.snapshot(Review, id, context);
    const inbox = await this.session.harness.snapshot(InboxDoc, id, context);
    const parent =
      review?.original ?? record.parent?.conversationId ?? record.owner?.conversationId ?? null;
    assert(parent === null || parent < id, "Conversation ancestry must precede its child");
    return {
      id,
      parent,
      title:
        review?.original !== undefined
          ? `Review ${id}`
          : id === this.session.root.id
            ? "Main"
            : `Branch ${id}`,
      state: active ?? (inbox?.items.length ? "pending" : state),
      activity,
    };
  }
}
