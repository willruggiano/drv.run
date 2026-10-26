import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  watchEvents,
  type AgentEvent,
  type AgentEventStream,
  type ConversationId,
  type Cursor,
  type SnapshotEvent,
  type SubmissionId,
} from "@earendil-works/pi-durable";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Activity, type ProgramStatus } from "./activity.ts";
import { Metadata, type Session } from "./sessions.ts";
import { previewText } from "./push-message.ts";

/** A run, unlike a generation/turn, includes all automatic tool continuations. */
export class SettledConversation {
  private running = false;
  private queued = false;
  private ended = false;
  private message?: AssistantMessage;
  private failure?: string;
  private cancelled = false;
  private inputs = new Set<SubmissionId>();

  snapshot(snapshot: SnapshotEvent): void {
    this.running = snapshot.run !== undefined;
    this.inputs = new Set(snapshot.run?.inputs);
    this.queued = snapshot.inbox.length > 0;
    this.ended = false;
    this.message = snapshot.run
      ? snapshot.entries
          .flatMap((entry) => entry.model ?? [])
          .findLast((message): message is AssistantMessage => message.role === "assistant")
      : undefined;
    this.failure = undefined;
    this.cancelled = false;
  }

  accept(events: readonly AgentEvent[]): Omit<ProgramStatus, "id"> | undefined {
    let started = false;
    let baseline = false;
    for (const event of events) {
      switch (event.type) {
        case "snapshot":
          // Attachment/reconnect/overflow is a baseline, never a completion alert.
          this.snapshot(event);
          baseline = true;
          break;
        case "run_start":
          this.running = true;
          this.inputs = new Set(event.inputs);
          this.ended = false;
          this.message = undefined;
          this.failure = undefined;
          this.cancelled = false;
          started = true;
          break;
        case "run_end":
          this.running = false;
          this.ended = true;
          break;
        case "inbox_update":
          this.queued = event.items.length > 0;
          break;
        case "message_end":
          for (const message of event.entry.model ?? [])
            if (message.role === "assistant") this.message = message;
          break;
        case "task_failed":
          if (event.kind === "pi.generation") this.failure = event.message;
          break;
        case "submission":
          if (
            event.record.type === "input" &&
            this.inputs.has(event.record.id) &&
            event.record.status === "unanswered"
          ) {
            this.cancelled = event.record.reason === "aborted";
            if (!this.cancelled)
              this.failure ??=
                typeof event.record.detail === "string" ? event.record.detail : event.record.reason;
          }
          break;
      }
    }
    if (this.running || this.queued || !this.ended)
      return started || baseline
        ? { state: this.running || this.queued ? "working" : "idle", app: "pi" }
        : undefined;
    this.ended = false;
    if (this.cancelled || this.message?.stopReason === "aborted")
      return { state: "idle", app: "pi" };
    const error = this.failure ?? this.message?.errorMessage;
    const text = this.message?.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    return {
      state: error || this.message?.stopReason === "error" ? "error" : "done",
      app: "pi",
      msg: previewText(error || text || "", 2048, true),
    };
  }
}

/** Read-only event observers. Never start scheduling just to inspect a session. */
export async function attachPiNotifications(
  session: Session,
  activity: Activity,
): Promise<{ close: () => Promise<void>; closed: Promise<void> }> {
  const source = { instance: "host-pi", incarnation: session.id, terminal: "api" };
  let sequence = activity.sequence(source);
  const records = () =>
    activity
      .sources()
      .find(
        (view) =>
          view.source.instance === source.instance &&
          view.source.incarnation === source.incarnation &&
          view.source.terminal === source.terminal,
      )?.records ?? [];
  // Old versions recorded individual generation tasks as conversation/task.
  // Retain their inbox history, but do not deliver stale per-generation alerts after upgrade.
  for (const record of records())
    if (/^\d+\/\d+$/.test(record.id))
      activity.accept(source, ++sequence, { type: "clear", id: record.id });
  let closed = false;
  const stopped = Promise.withResolvers<void>();
  const streams = new Map<ConversationId, Promise<AgentEventStream>>();
  const report = (error: unknown) => {
    if (!closed) {
      activity.unavailable(source);
      session.owner.options.onReport?.(error);
    }
  };
  const attach = (id: ConversationId): Promise<AgentEventStream> => {
    const existing = streams.get(id);
    if (existing) return existing;
    const opening = (async () => {
      const stream = await watchEvents(session.harness, id, BACKGROUND_CONTEXT);
      if (closed) {
        await stream.stop();
        return stream;
      }
      const state = new SettledConversation();
      state.snapshot(stream.snapshot);
      // A busy snapshot invalidates old pending alerts. An idle snapshot must not
      // erase an already accepted completion still awaiting delivery after restart.
      const previous = records().find((record) => record.id === String(id));
      const busy = stream.snapshot.run !== undefined || stream.snapshot.inbox.length > 0;
      activity.accept(source, ++sequence, {
        type: "status",
        record:
          !busy && previous && (previous.state === "done" || previous.state === "error")
            ? previous
            : { id: String(id), app: "pi", state: busy ? "working" : "idle" },
      });
      stream.start(async (events) => {
        if (closed) return;
        if (events.some((event) => event.type === "snapshot")) activity.gap(source);
        const status = state.accept(events);
        if (!status) return;
        const metadata = await session.harness.snapshot(
          Metadata,
          session.root.id,
          BACKGROUND_CONTEXT,
        );
        if (closed) return;
        activity.accept(source, ++sequence, {
          type: "status",
          record: {
            ...status,
            id: String(id),
            title: previewText(metadata?.name ?? "", 192),
          },
        });
      });
      void stream.closed
        .then((end) => {
          if (!closed && end.reason !== "stopped") {
            if ("error" in end) report(end.error);
            else activity.unavailable(source);
          }
        })
        .catch(report);
      return stream;
    })();
    streams.set(id, opening);
    return opening;
  };
  const stopCommits = session.harness.subscribeCommits((publication) => {
    for (const change of publication.changes)
      if (change.type === "conversation" && !change.value.owner)
        // Acquire outside the commit observer. Helpers owned by tasks don't need user input.
        queueMicrotask(() => {
          if (!closed) void attach(change.value.id).catch(report);
        });
  });
  const stopClose = session.harness.subscribeClose(() => {
    if (!closed) activity.unavailable(source);
    void close().catch(report);
  });
  async function close(): Promise<void> {
    if (closed) return await stopped.promise;
    closed = true;
    stopCommits();
    stopClose();
    await Promise.allSettled([...streams.values()].map(async (stream) => (await stream).stop()));
    streams.clear();
    stopped.resolve();
  }
  try {
    let cursor: Cursor | undefined;
    do {
      const page = await session.harness.commit(
        (tx) => tx.scanConversations({}, 100, cursor),
        BACKGROUND_CONTEXT,
      );
      await Promise.all(
        page.items.filter((record) => !record.owner).map((record) => attach(record.id)),
      );
      cursor = page.next;
    } while (cursor !== undefined);
    return { close, closed: stopped.promise };
  } catch (error) {
    await close();
    throw error;
  }
}
