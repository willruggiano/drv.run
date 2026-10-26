import assert from "node:assert/strict";
import type { Context } from "@earendil-works/chord/context";
import type {
  CommitPublication,
  ConversationId,
  ConversationRecord,
  Cursor,
  EntryRecord,
} from "@earendil-works/pi-durable";
import type { Branch } from "./branches.ts";
import type { Session } from "./sessions.ts";
import { conversationURL } from "./presentation.ts";

export type TreeNode = {
  id: number;
  parent: number | null;
  text: string;
  role: "user" | "assistant" | "tool" | "event" | "branch";
  state: Branch["state"] | null;
  timestamp: number | null;
  active: boolean;
  current: boolean;
  path: string | null;
};
export type TreeData = { kind: "branches" | "entries"; path: string; nodes: TreeNode[] };

/** Per-reader immutable history cache. Live token/tool deltas do not rescan history. */
export class SessionTree {
  private readonly conversations = new Map<ConversationId, ConversationRecord>();
  private readonly records = new Map<number, EntryRecord>();
  private readonly dirty = new Set<ConversationId>();
  private initialized = false;
  private readonly session: Session;
  constructor(session: Session) {
    this.session = session;
  }

  invalidate(publication: CommitPublication): boolean {
    let changed = false;
    for (const change of publication.changes) {
      if (change.type === "conversation") {
        this.conversations.set(change.value.id, change.value);
        this.dirty.add(change.value.id);
        changed = true;
      } else if (change.type === "entry") {
        this.dirty.add(change.value.conversationId);
        changed = true;
      }
    }
    return changed;
  }

  async read(current: ConversationId, context: Context): Promise<TreeNode[]> {
    if (!this.initialized) {
      let cursor: Cursor | undefined;
      do {
        const page = await this.session.harness.commit(
          (tx) => tx.scanConversations({}, 256, cursor),
          context,
        );
        for (const record of page.items) {
          this.conversations.set(record.id, record);
          this.dirty.add(record.id);
        }
        cursor = page.next;
      } while (cursor);
      this.initialized = true;
    }
    const dirty = [...this.dirty];
    this.dirty.clear();
    for (const id of dirty) {
      // Read the full fork-aware history once; subsequent reads only fetch newer entries.
      const own = [...this.records.values()].filter((record) => record.conversationId === id);
      const last = own.sort((a, b) => b.id - a.id)[0]?.id;
      let cursor: Cursor | undefined;
      do {
        const page = await this.session.harness.commit(
          (tx) =>
            tx.scanEntries(
              { conversationId: id, order: "ascending", minEntryId: last },
              256,
              cursor,
            ),
          context,
        );
        for (const record of page.items) this.records.set(record.id, record);
        cursor = page.next;
      } while (cursor);
    }
    const latest = new Map<ConversationId, number>();
    const nodes: TreeNode[] = [];
    for (const record of [...this.records.values()].sort((a, b) => a.id - b.id)) {
      const conversation = this.conversations.get(record.conversationId);
      assert(conversation, "Entry conversation must exist");
      const parent = latest.get(record.conversationId) ?? conversation.parent?.at ?? null;
      assert(parent === null || parent < record.id, "Entry ancestry must precede its child");
      latest.set(record.conversationId, record.id);
      const messages = record.model ?? [];
      const boundary = record.kind === "pi.reset" || record.kind === "pi.compaction";
      const role = boundary ? "event" : messages[0]?.role;
      const text = messages
        .map((message) => {
          const content =
            typeof message.content === "string"
              ? message.content
              : message.content
                  .map((part) => {
                    switch (part.type) {
                      case "text":
                        return part.text;
                      case "thinking":
                        return part.thinking;
                      case "image":
                        return "[image]";
                      case "toolCall":
                        return `[${part.name}: ${JSON.stringify(part.arguments)}]`;
                    }
                  })
                  .join(" ");
          return message.role === "toolResult" ? `[${message.toolName}] ${content}` : content;
        })
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      nodes.push({
        id: record.id,
        parent,
        role:
          role === "user" || role === "assistant" ? role : role === "toolResult" ? "tool" : "event",
        text: boundary
          ? `${record.kind === "pi.reset" ? "Reset" : "Compaction"}${text ? `: ${text}` : ""}`
          : text || record.kind,
        state: null,
        timestamp:
          messages.find((message) => Number.isFinite(message.timestamp))?.timestamp ?? null,
        active: false,
        current: false,
        path: null,
      });
    }
    const conversation = this.conversations.get(current);
    assert(conversation, "Open conversation must exist");
    const tip = latest.get(current) ?? conversation.parent?.at ?? null;
    const byId = new Map(nodes.map((node) => [node.id, node]));
    for (let id = tip; id !== null;) {
      const node = byId.get(id);
      assert(node, "Fork point must exist in session history");
      node.active = true;
      node.current = id === tip;
      id = node.parent;
    }
    return nodes;
  }
}

export function conversationTree(
  session: Session,
  current: ConversationId,
  branches: Branch[],
  frontend: "elm" | "htmx",
): TreeData {
  return {
    kind: "branches",
    path: conversationURL(session, current, frontend),
    nodes: branches.map((branch) => ({
      id: branch.id,
      parent: branch.parent,
      text: branch.title,
      role: "branch",
      state: branch.state,
      timestamp: branch.activity,
      active: false,
      current: branch.id === current,
      path: conversationURL(session, branch.id, frontend),
    })),
  };
}
