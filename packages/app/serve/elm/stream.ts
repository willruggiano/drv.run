import { randomUUID } from "node:crypto";
import { awaitWithContext, withAbortSignal, type Context } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import {
  LiveDoc,
  InboxDoc,
  UsageDoc,
  type ConversationView,
  type EntryRecord,
  type LiveState,
  type InboxState,
  type UsageState,
  type Conversation,
} from "@earendil-works/pi-durable";
import type { GlobalSettingsStore } from "../server.ts";
import type { SettingValues } from "../settings.ts";
import { BranchTree, type Branch } from "../branches.ts";
import { SessionTree, conversationTree, type TreeData } from "../trees.ts";
import {
  sessionInfo,
  contextStatus,
  inspectContext,
  Metadata,
  Environment,
  type Session,
} from "../sessions.ts";
import {
  conversationURL,
  history,
  compactionTimes,
  compactTokens,
  type Call,
  type Result,
} from "../presentation.ts";
import type { ContextInspection } from "../inspection.ts";

export type Block =
  | { kind: "text" | "thinking" | "code"; text: string }
  | { kind: "image"; mime: string; data: string }
  | { kind: "tool"; id: string };
export type DisplayMessage = { role: string; timestamp: number; blocks: Block[]; error: string };
export type DisplayEntry = { id: number; boundary: string; messages: DisplayMessage[] };
export type DisplayTool = {
  id: string;
  name: string;
  command: string;
  state: string;
  duration: string;
  blocks: Block[];
  details: string;
  patch: boolean;
  path: string;
  written: string;
  notice: string;
};
function message(value: Message): DisplayMessage {
  const blocks: Block[] =
    typeof value.content === "string"
      ? [{ kind: "text", text: value.content }]
      : value.content.flatMap((part): Block[] => {
          switch (part.type) {
            case "text":
              return [{ kind: value.role === "toolResult" ? "code" : "text", text: part.text }];
            case "thinking":
              return [{ kind: "thinking", text: part.thinking || "Thinking…" }];
            case "image":
              return /^image\/(png|jpeg|gif|webp)$/.test(part.mimeType) &&
                /^[A-Za-z0-9+/=\s]*$/.test(part.data)
                ? [{ kind: "image", mime: part.mimeType, data: part.data }]
                : [{ kind: "text", text: "[attachment]" }];
            case "toolCall":
              return [{ kind: "tool", id: part.id }];
          }
        });
  return {
    role: value.role,
    timestamp: value.timestamp,
    blocks,
    error: value.role === "assistant" ? (value.errorMessage ?? "") : "",
  };
}
function tool(call: Call, result: Result | undefined, live: LiveState | undefined): DisplayTool {
  const slot = [...(live?.tools ?? []), ...(live?.nestedTools ?? [])].find(
    (item) => item.callId === call.id,
  );
  const nested = slot && "summary" in slot ? slot.summary : undefined;
  const name = call.name.split(".").at(-1)!;
  const args = call.arguments;
  const label =
    name === "bash"
      ? `$ ${typeof args.command === "string" ? args.command.trim() : "Shell command"}`
      : `${({ read: "Read", write: "Write", edit: "Edit", grep: "Search", find: "Find", ls: "List" } as Record<string, string>)[name] ?? call.name}${typeof args.path === "string" ? ` · ${args.path}` : ""}`;
  const command =
    name === "bash"
      ? label
      : name === "write" && typeof args.content === "string"
        ? `${label}\n${args.content}`
        : Object.keys(args).length
          ? `${label}\n${JSON.stringify(args, null, 2)}`
          : label;
  const state = result
    ? result.message.isError
      ? "failed"
      : "completed"
    : nested
      ? nested.isError
        ? "failed"
        : "completed"
      : slot?.status === "done"
        ? "unavailable"
        : (slot?.status ?? (live?.run ? "pending" : "unavailable"));
  const duration = result?.message.durationMs ?? nested?.durationMs;
  const metadata = result?.message.details ?? slot?.details;
  const patch =
    metadata &&
    typeof metadata === "object" &&
    ("patch" in metadata && typeof metadata.patch === "string"
      ? metadata.patch
      : "diff" in metadata && typeof metadata.diff === "string"
        ? metadata.diff
        : undefined);
  return {
    id: call.id,
    name: call.name,
    command,
    state,
    duration:
      duration === undefined
        ? ""
        : duration < 1000
          ? `${Math.round(duration)}ms`
          : `${(duration / 1000).toFixed(1)}s`,
    blocks: result
      ? message(result.message).blocks
      : slot?.output
        ? [{ kind: "code", text: slot.output }]
        : [],
    details: typeof patch === "string" ? patch : metadata ? JSON.stringify(metadata, null, 2) : "",
    patch: typeof patch === "string",
    path: typeof args.path === "string" ? args.path : "",
    written:
      result && !result.message.isError && name === "write" && typeof args.content === "string"
        ? args.content
        : "",
    notice:
      slot?.droppedBytes || slot?.droppedLines
        ? `Output truncated: ${slot.droppedBytes ?? 0} bytes / ${slot.droppedLines ?? 0} lines omitted.`
        : (nested?.error ?? ""),
  };
}

/** One projection per connection. Retain immutable history; send only changed regions. */
export class ElmProjection {
  private readonly records = new Map<number, EntryRecord>();
  private readonly sent = new Set<number>();
  private readonly tools = new Map<string, string>();
  private readonly regions = new Map<string, string>();
  private sequence = 0;
  private entries: readonly EntryRecord[] | undefined;
  private readonly calls = new Map<string, Call>();
  private readonly results = new Map<string, Result>();
  private readonly toolInputs = new Map<string, string>();
  constructor(records: EntryRecord[] = []) {
    for (const record of records) this.records.set(record.id, record);
  }
  include(records: readonly EntryRecord[]): void {
    if (!records.length) return;
    for (const record of records) this.records.set(record.id, record);
    this.entries = undefined;
  }
  project(view: ConversationView, metadata: Metadata, inspection?: ContextInspection) {
    const { calls, results } = this;
    const records: EntryRecord[] = [];
    if (view.entries !== this.entries) {
      for (const record of view.entries) this.records.set(record.id, record);
      for (const record of [...this.records.values()].sort((a, b) => a.id - b.id)) {
        if (this.sent.has(record.id)) continue;
        records.push(record);
        for (const item of record.model ?? []) {
          if (item.role === "assistant")
            for (const part of item.content) if (part.type === "toolCall") calls.set(part.id, part);
          if (item.role === "toolResult")
            results.set(item.toolCallId, { entry: record.id, message: item });
        }
      }
      this.entries = view.entries;
    }
    const live = view.docs[LiveDoc.definition.kind] as LiveState | undefined;
    const entries: DisplayEntry[] = [];
    for (const record of records)
      if (!this.sent.has(record.id)) {
        entries.push({
          id: record.id,
          boundary: ["pi.reset", "pi.compaction"].includes(record.kind) ? record.kind : "",
          messages: (record.model ?? [])
            .filter(
              (item) =>
                item.role !== "system" &&
                !(item.role === "toolResult" && calls.has(item.toolCallId)),
            )
            .map(message),
        });
        this.sent.add(record.id);
      }
    const historyCalls = new Set(calls.keys());
    const extra = [...(live?.tools ?? []), ...(live?.nestedTools ?? [])].filter(
      (slot) => !historyCalls.has(slot.callId),
    );
    const displayCalls = new Map(calls);
    for (const slot of extra)
      displayCalls.set(slot.callId, {
        id: slot.callId,
        name: slot.name,
        arguments: "arguments" in slot ? slot.arguments : {},
      });
    const tools: DisplayTool[] = [];
    for (const call of displayCalls.values()) {
      const result = results.get(call.id);
      const slots = [...(live?.tools ?? []), ...(live?.nestedTools ?? [])];
      const input = JSON.stringify(
        result ? result.entry : [slots.find((slot) => slot.callId === call.id), !!live?.run],
      );
      if (this.toolInputs.get(call.id) === input) continue;
      this.toolInputs.set(call.id, input);
      const value = tool(call, results.get(call.id), live);
      const encoded = JSON.stringify(value);
      if (this.tools.get(call.id) !== encoded) {
        tools.push(value);
        this.tools.set(call.id, encoded);
      }
    }
    const inbox = view.docs[InboxDoc.definition.kind] as InboxState | undefined;
    const liveMessages = live?.generation?.message ? [message(live.generation.message)] : [];
    const queue = (inbox?.items ?? []).map((item) => ({
      id: item.id,
      mode: item.mode,
      blocks: message({
        role: "user",
        timestamp: 0,
        content:
          "content" in item
            ? item.content
            : typeof item.entry.kind === "string"
              ? item.entry.kind
              : JSON.stringify(item.entry.kind),
      }).blocks,
    }));
    const notices = [
      ...(live?.generation?.retry
        ? [`Retry ${live.generation.attempt}: ${live.generation.retry.error}`]
        : []),
      ...(live?.generation?.deferred ? ["Waiting for provider response…"] : []),
      ...(live?.compactionFailure ? [`Compaction failed: ${live.compactionFailure.error}`] : []),
    ];
    const regions = {
      live: {
        busy: !!live?.run,
        messages: liveMessages,
        tools: extra.map((slot) => slot.callId),
        notices,
        compactions: (live?.compactions ?? []).map((item) => ({
          id: String(item.taskId),
          title: item.blocking ? "Compacting context" : "Background compaction",
          detail: `${item.reason} · Attempt ${item.attempt}${item.retry ? ` · ${item.retry.error}` : ""}`,
        })),
      },
      queue,
      metadata,
      ...(inspection ? { inspection } : {}),
    };
    const changed: Partial<typeof regions> = {};
    for (const key of ["live", "queue", "metadata", "inspection"] as const) {
      const encoded = JSON.stringify(regions[key]);
      if (this.regions.get(key) !== encoded) {
        Object.assign(changed, { [key]: regions[key] });
        this.regions.set(key, encoded);
      }
    }
    if (this.sequence && !entries.length && !tools.length && !Object.keys(changed).length)
      return undefined;
    return {
      version: 1,
      sequence: ++this.sequence,
      snapshot: this.sequence === 1,
      conversation: view.conversation.id,
      entries,
      tools,
      ...changed,
    };
  }
}

type Metadata = {
  explorer?: TreeData;
  branches: (Branch & { path: string })[];
  durations: Record<string, number>;
  title: string;
  instance: string;
  model: string;
  thinking: string;
  input: string;
  output: string;
  read: string;
  hit: string;
  cost: string;
  context: string;
  level: string;
  resume: boolean;
  hideThinking?: boolean;
  hideImages?: boolean;
  defaultDeliveryMode?: SettingValues["defaultDeliveryMode"];
};
async function metadata(
  session: Session,
  conversation: Conversation,
  view: ConversationView,
  context: Context,
  settings?: GlobalSettingsStore,
): Promise<Metadata> {
  const info = await sessionInfo(session, conversation, undefined, context);
  const status = contextStatus(session, view);
  const usage = view.docs[UsageDoc.definition.kind] as UsageState | undefined;
  const totals = [...Object.values(usage?.models ?? {}), ...Object.values(usage?.tools ?? {})];
  const sum = (key: "input" | "output" | "cacheRead") =>
    compactTokens(totals.reduce((total, value) => total + value[key], 0));
  const percent =
    status.window && status.lastResponse
      ? (status.lastResponse.tokens / status.window) * 100
      : undefined;
  return {
    defaultDeliveryMode: settings?.read().values.defaultDeliveryMode ?? "follow-up",
    hideThinking: settings?.read().values.hideThinkingBlock === true,
    hideImages: settings?.read().values["terminal.showImages"] === false,
    branches: [],
    durations: {},
    resume: info.needsResume,
    title: info.name || "Untitled session",
    instance: info.binding
      ? `${info.binding.provider === "local" ? "local" : info.binding.target} · ${info.cwd}`
      : "No execution environment",
    model: info.model?.modelId ?? "No model",
    thinking: info.thinkingLevel,
    input: sum("input"),
    output: sum("output"),
    read: sum("cacheRead"),
    hit:
      status.lastResponse?.cacheHit == null
        ? "CH—"
        : `CH${status.lastResponse.cacheHit.toFixed(1)}%`,
    cost: totals.reduce((total, value) => total + value.cost.total, 0).toFixed(3),
    context: `${percent === undefined ? "—" : `${percent.toFixed(1)}%`}/${status.window ? compactTokens(status.window) : "—"}${status.autoCompact ? " (auto)" : ""}`,
    level:
      percent !== undefined && percent > 90
        ? "critical"
        : percent !== undefined && percent > 70
          ? "warning"
          : "normal",
  };
}

export type ConversationFrame = NonNullable<ReturnType<ElmProjection["project"]>> & {
  subscription: string;
};

/** One reader owns observation, history, invalidation, and projection until cancellation or return. */
export async function* conversationFrames(
  session: Session,
  conversation: Conversation,
  parent: Context,
  options: { pane?: string | null; settings?: GlobalSettingsStore } = {},
): AsyncGenerator<ConversationFrame, void, void> {
  const lifetime = new AbortController();
  const context = withAbortSignal(lifetime.signal, parent);
  const signal = context.abortSignal!;
  const watch = await conversation.watch(context);
  let view = watch.value;
  let dirty = true;
  let stopped = false;
  let failure: Error | undefined;
  let wake = Promise.withResolvers<void>();
  let stopCommits: (() => void) | undefined;
  let stopSettings: (() => void) | undefined;
  const branches = new BranchTree(session);
  const sessionTree = options.pane === "tree" ? new SessionTree(session) : undefined;
  const pendingEntries: EntryRecord[] = [];
  let timingsDirty = true;
  let durations: Record<string, number> = {};
  const subscription = randomUUID();
  function stop() {
    if (stopped) return;
    stopped = true;
    stopCommits?.();
    stopSettings?.();
    lifetime.abort();
    void watch.stop();
  }
  function invalidate() {
    dirty = true;
    wake.resolve();
  }
  try {
    signal.addEventListener("abort", stop, { once: true });
    void watch.closed.then(stop);
    signal.throwIfAborted();
    // Register before history reads. Commit listeners only invalidate; reads run on the consumer.
    stopCommits = session.harness.subscribeCommits((publication) => {
      if (stopped) return;
      const treeChanged = sessionTree?.invalidate(publication) ?? false;
      if (branches.invalidate(publication) || treeChanged) invalidate();
      for (const change of publication.changes) {
        if (
          change.type === "document" &&
          (change.record.kind === Metadata.definition.kind ||
            (change.conversationId === conversation.id &&
              [Environment.definition.kind, "pi.agent"].includes(change.record.kind)))
        )
          invalidate();
        if (change.type === "entry" && change.value.conversationId === conversation.id) {
          // Bound retained history even while initialization or the consumer is blocked.
          if (pendingEntries.length >= 1024) {
            failure = new Error("Conversation stream exceeded its pending history limit.");
            stop();
            return;
          }
          pendingEntries.push(change.value);
          invalidate();
        }
      }
      if (
        publication.changes.some(
          (change) =>
            change.type === "task" &&
            change.value.kind === "pi.compaction" &&
            change.value.state.status === "terminal",
        )
      ) {
        timingsDirty = true;
        invalidate();
      }
    });
    stopSettings = options.settings?.watch(invalidate);
    watch.start(async (value) => {
      view = value;
      invalidate();
    });
    const projector = new ElmProjection(
      await awaitWithContext(history(conversation, context), context),
    );
    while (!stopped) {
      if (!dirty) {
        wake = Promise.withResolvers<void>();
        await awaitWithContext(wake.promise, context);
      }
      dirty = false;
      if (timingsDirty) {
        timingsDirty = false;
        durations = Object.fromEntries(
          await awaitWithContext(compactionTimes(session, context), context),
        );
      }
      const current = view;
      const info = await awaitWithContext(
        metadata(session, conversation, current, context, options.settings),
        context,
      );
      projector.include(pendingEntries.splice(0));
      const inspection =
        options.pane === "context"
          ? await awaitWithContext(inspectContext(session, current, context), context)
          : undefined;
      const tree = (await awaitWithContext(branches.read(context), context)).map((branch) => ({
        ...branch,
        path: conversationURL(session, branch.id),
      }));
      const explorer: TreeData | undefined = sessionTree
        ? {
            kind: "entries",
            path: conversationURL(session, conversation.id),
            nodes: await awaitWithContext(sessionTree.read(conversation.id, context), context),
          }
        : options.pane === "branches"
          ? conversationTree(session, conversation.id, tree)
          : undefined;
      if (view !== current) {
        dirty = true;
        continue;
      }
      const frame = projector.project(
        current,
        { ...info, durations, branches: tree, ...(explorer ? { explorer } : {}) },
        inspection,
      );
      if (frame) yield { ...frame, subscription };
    }
    if (failure) throw failure;
  } catch (error) {
    if (failure) throw failure;
    if (!stopped) throw error;
  } finally {
    stop();
    signal.removeEventListener("abort", stop);
    await watch.stop();
  }
}
