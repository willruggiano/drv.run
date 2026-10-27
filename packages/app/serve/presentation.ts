import type { Context } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import type { Conversation, Cursor, EntryRecord, SubmissionId } from "@earendil-works/pi-durable";
import type { Session } from "./sessions.ts";

export const conversationURL = (session: Session, id = session.root.id) =>
  `/sessions/${session.id}/conversations/${id}`;

export type Call = { id: string; name: string; arguments: Record<string, unknown> };
export type Result = { entry: number; message: Extract<Message, { role: "toolResult" }> };

export function compactTokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}M`;
}

export async function history(conversation: Conversation, context: Context) {
  const records: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await conversation.entries({ order: "ascending" }, 256, cursor, context);
    records.push(...page.items);
    cursor = page.next;
  } while (cursor);
  return records;
}
export async function compactionTimes(
  session: Session,
  context: Context,
): Promise<Map<number, number>> {
  const times = new Map<number, number>();
  let cursor: Cursor | undefined;
  do {
    const tasks = await session.harness.commit(
      (tx) => tx.scanTasks({ kind: "pi.compaction", status: "terminal" }, 256, cursor),
      context,
    );
    for (const task of tasks.items) {
      if (
        task.state.status !== "terminal" ||
        task.state.outcome.status !== "completed" ||
        task.startedAt === undefined ||
        task.endedAt === undefined
      )
        continue;
      const result = task.state.outcome.result;
      if (!result || typeof result !== "object" || Array.isArray(result)) continue;
      let entry = typeof result.entryId === "number" ? result.entryId : undefined;
      if (entry === undefined && typeof result.submissionId === "number") {
        const submission = await session.harness.submission(
          result.submissionId as SubmissionId,
          context,
        );
        entry = (await submission?.status(context))?.entry;
      }
      if (entry !== undefined) times.set(entry, task.endedAt - task.startedAt);
    }
    cursor = tasks.next;
  } while (cursor);
  return times;
}
