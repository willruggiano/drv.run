import type { GlobalSettingsStore } from "../server.ts";
import { BranchTree, type Branch } from "../branches.ts";
import { SessionTree, conversationTree, type TreeData } from "../trees.ts";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@earendil-works/chord/context";
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
  type SubmissionId,
} from "@earendil-works/pi-durable";
import {
  getConversation,
  sessionInfo,
  contextStatus,
  completePaths,
  completeWorkingDirectories,
  inspectContext,
  changeDirectory,
  rename,
  Metadata,
  Environment,
  type Sessions,
  type Session,
} from "../sessions.ts";
import {
  form,
  field,
  inputContent,
  FormError,
  saveSessionSettings,
  createSession,
} from "../forms.ts";
import {
  conversationURL,
  history,
  compactionTimes,
  compactTokens,
  type Call,
  type Result,
} from "../presentation.ts";
import { Review } from "harness";
import { startReview, endReview } from "../review.ts";
import type { ContextInspection } from "../inspection.ts";
import { thinkingLevels } from "../settings.ts";
import {
  completionToken,
  commandCompletions,
  pathCompletion,
  directoryCompletion,
} from "../completions.ts";

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
};
export async function metadata(
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
function json(response: ServerResponse, value: unknown) {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}
export function elmDocument(response: ServerResponse, site = false): void {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#151719"><title>Pi</title><link rel="icon" href="/icon.svg"><link rel="manifest" href="/manifest.webmanifest"><link rel="stylesheet" href="/styles.css"><script src="/main.js" defer></script><script src="/${site ? "site" : "client"}.js" type="module"></script></head><body class="stacked-layout bottom-align"><div id="elm"></div></body></html>`,
  );
}
export async function elmFrontend(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  sessions: Sessions,
  context: Context,
  settings?: GlobalSettingsStore,
): Promise<void> {
  const root = /^\/sessions\/([^/]+)$/.exec(url.pathname);
  if (root && request.method === "GET") {
    response.writeHead(303, {
      Location: conversationURL(await sessions.get(root[1])),
    });
    response.end();
    return;
  }
  const match =
    /^\/sessions\/([^/]+)\/conversations\/(\d+)(?:\/(events|command|completions|receipt|panel|settings|context|branches|tree|reset|compact|export|directories|archive))?$/.exec(
      url.pathname,
    );
  if (!match) throw new FormError(404, "Not found.");
  const operation = match[3];
  if (operation === "archive") {
    if (request.method !== "POST") throw new FormError(405, "Method not allowed.");
    await form(request);
    await sessions.archive(match[1]);
    json(response, { archived: true });
    return;
  }
  const session = await sessions.get(match[1]);
  const conversation = await getConversation(session, Number(match[2]), context);
  if (
    request.method === "GET" &&
    (!operation ||
      ["settings", "context", "branches", "tree", "reset", "compact"].includes(operation))
  ) {
    elmDocument(response);
    return;
  }
  if (request.method === "GET" && operation === "panel") {
    const pane = url.searchParams.get("view");
    if (pane === "settings") {
      const catalog = await sessions.catalog(context);
      const info = await sessionInfo(session, conversation, catalog.targets, context);
      const modelKey = (item: { provider: string; modelId: string }) =>
        JSON.stringify([item.provider, item.modelId]);
      const targetKey = (item: { provider: string; target: string }) =>
        JSON.stringify([item.provider, item.target]);
      const model = info.model ? modelKey(info.model) : "";
      const target = info.binding ? targetKey(info.binding) : "";
      json(response, {
        name: info.name,
        model,
        target,
        thinking: info.thinkingLevel,
        directory:
          info.directoryRoot && info.cwd.startsWith(info.directoryRoot + "/")
            ? info.cwd.slice(info.directoryRoot.length + 1)
            : "",
        models: [
          ...(!catalog.models.some((item) => modelKey(item) === model) && info.model
            ? [
                {
                  key: model,
                  label: `${info.model.modelId} (unavailable, keep)`,
                  levels: thinkingLevels,
                  default: "off",
                },
              ]
            : []),
          ...catalog.models.map((item) => ({
            key: modelKey(item),
            label: `${item.provider} / ${item.name}`,
            levels: item.thinkingLevels,
            default: item.defaultThinkingLevel,
          })),
        ],
        targets: [
          ...(!catalog.targets.some((item) => targetKey(item) === target) && info.binding
            ? [
                {
                  key: target,
                  label: `${info.binding.target} (unavailable, keep)`,
                  disabled: false,
                  root: info.directoryRoot ?? "",
                },
              ]
            : []),
          ...catalog.targets.map((item) => ({
            key: targetKey(item),
            label: item.label,
            disabled: !item.available && targetKey(item) !== target,
            root: item.directoryRoot ?? "",
          })),
        ],
      });
    } else throw new FormError(400, "Unknown panel.");
    return;
  }
  if (request.method === "GET" && operation === "directories") {
    const target = ((await sessions.options.targets?.(context)) ?? []).find(
      (item) =>
        JSON.stringify([item.provider, item.target]) === url.searchParams.get("target") &&
        item.available,
    );
    if (!target) throw new FormError(409, "Execution target is unavailable.");
    json(
      response,
      await sessions.completeDirectories(target, url.searchParams.get("directory") ?? "", context),
    );
    return;
  }
  if (request.method === "POST" && operation === "settings") {
    await saveSessionSettings(await form(request), sessions, session, conversation, context);
    json(response, { saved: true });
    return;
  }
  if (request.method === "GET" && operation === "export") {
    response.setHeader("Content-Type", "application/json");
    response.setHeader(
      "Content-Disposition",
      `attachment; filename="pi-${session.id}-${conversation.id}.json"`,
    );
    response.end(JSON.stringify(await history(conversation, context), null, 2));
    return;
  }
  if (request.method === "GET" && operation === "receipt") {
    const requestId = url.searchParams.get("requestId") ?? "";
    if (!requestId.trim() || requestId.length > 200)
      throw new FormError(400, "Invalid request identity.");
    const submission = await session.harness.commit(
      (tx) => tx.submissionByRequest(conversation.id, requestId),
      context,
    );
    // Presence acknowledges admission, not successful execution. A missing receipt is not proof of failure.
    json(response, { accepted: submission?.type === "input" });
    return;
  }
  if (request.method === "GET" && operation === "completions") {
    const text = url.searchParams.get("text") ?? "";
    const caret = Number(url.searchParams.get("caret"));
    if (text.length > 100_000 || !Number.isSafeInteger(caret) || caret < 0 || caret > text.length)
      throw new FormError(400, "Invalid completion query.");
    const token = completionToken(text, caret);
    const items =
      token?.kind === "command"
        ? commandCompletions(
            token.query,
            (await session.harness.snapshot(Review, conversation.id, context))?.original !==
              undefined,
          )
        : token?.kind === "directory"
          ? (await completeWorkingDirectories(session, token.query, conversation, context)).map(
              directoryCompletion,
            )
          : token?.kind === "path"
            ? (await completePaths(session, token.query, conversation, context)).map(pathCompletion)
            : [];
    json(response, {
      start: token?.start ?? caret,
      end: token?.end ?? caret,
      items,
    });
    return;
  }
  if (request.method === "GET" && operation === "events") {
    const watch = await conversation.watch(context);
    // Subscribe before asynchronous history/metadata reads. Coalesce to the latest committed view.
    let view = watch.value;
    let dirty = true;
    let ready = false;
    let sending = false;
    const branches = new BranchTree(session);
    const sessionTree =
      url.searchParams.get("pane") === "tree" ? new SessionTree(session) : undefined;
    let timingsDirty = true;
    let durations: Record<string, number> = {};
    const pendingEntries: EntryRecord[] = [];
    const stopCommits = session.harness.subscribeCommits((publication) => {
      if (response.destroyed) return;
      const treeChanged = sessionTree?.invalidate(publication) ?? false;
      if (branches.invalidate(publication) || treeChanged) {
        dirty = true;
        if (ready) void send();
      }
      for (const change of publication.changes) {
        if (
          change.type === "document" &&
          (change.record.kind === Metadata.definition.kind ||
            (change.conversationId === conversation.id &&
              [Environment.definition.kind, "pi.agent"].includes(change.record.kind)))
        ) {
          dirty = true;
          if (ready) void send();
        }
        if (change.type === "entry" && change.value.conversationId === conversation.id) {
          // Bound commits retained while history or metadata reads are in flight.
          if (pendingEntries.length >= 1024) {
            response.destroy();
            return;
          }
          pendingEntries.push(change.value);
          dirty = true;
          if (ready) void send();
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
        dirty = true;
        if (ready) void send();
      }
    });
    const stopSettings = settings?.watch(() => {
      dirty = true;
      if (ready) void send();
    });
    const stop = () => {
      stopSettings?.();
      stopCommits();
      void watch.stop();
    };
    response.once("close", stop);
    if (response.destroyed) {
      stop();
      return;
    }
    watch.start(async (value) => {
      view = value;
      dirty = true;
      if (ready) void send();
    });
    let projector: ElmProjection;
    try {
      projector = new ElmProjection(await history(conversation, context));
    } catch (error) {
      stop();
      await watch.stop();
      throw error;
    }
    if (response.destroyed) return;
    response.writeHead(200, { "Content-Type": "text/event-stream", "X-Accel-Buffering": "no" });
    const subscription = randomUUID();
    async function send() {
      if (sending || response.destroyed) return;
      sending = true;
      try {
        while (dirty && !response.destroyed) {
          dirty = false;
          if (timingsDirty) {
            timingsDirty = false;
            durations = Object.fromEntries(await compactionTimes(session, context));
          }
          const current = view;
          const info = await metadata(session, conversation, current, context, settings);
          if (view !== current) {
            dirty = true;
            continue;
          }
          if (response.writableLength > 1024 * 1024) {
            response.destroy();
            break;
          }
          projector.include(pendingEntries.splice(0));
          const inspection =
            url.searchParams.get("pane") === "context"
              ? await inspectContext(session, current, context)
              : undefined;
          if (view !== current) {
            dirty = true;
            continue;
          }
          const tree = (await branches.read(context)).map((branch) => ({
            ...branch,
            path: conversationURL(session, branch.id),
          }));
          const explorer: TreeData | undefined = sessionTree
            ? {
                kind: "entries",
                path: conversationURL(session, conversation.id),
                nodes: await sessionTree.read(conversation.id, context),
              }
            : url.searchParams.get("pane") === "branches"
              ? conversationTree(session, conversation.id, tree)
              : undefined;
          const frame = projector.project(
            current,
            { ...info, durations, branches: tree, ...(explorer ? { explorer } : {}) },
            inspection,
          );
          if (frame) response.write(`data: ${JSON.stringify({ ...frame, subscription })}\n\n`);
        }
      } catch {
        response.destroy();
      } finally {
        sending = false;
      }
    }
    ready = true;
    void send();
    const heartbeat = setInterval(() => {
      if (response.writableLength > 1024 * 1024) response.destroy();
      else response.write(": heartbeat\n\n");
    }, 15_000);
    response.once("close", () => clearInterval(heartbeat));
    void watch.closed.then(() => {
      stopSettings?.();
      stopCommits();
      clearInterval(heartbeat);
      if (!response.destroyed) response.end();
    });
    return;
  }
  if (request.method !== "POST" || operation !== "command")
    throw new FormError(405, "Method not allowed.");
  let data: FormData;
  if (request.headers["content-type"]?.split(";")[0] === "application/json") {
    if (!request.headers.origin) throw new FormError(403, "Origin header required.");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > 128 * 1024) throw new FormError(413, "Request too large.");
      chunks.push(buffer);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      throw new FormError(400, "Invalid JSON.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new FormError(400, "Expected an object.");
    data = new FormData();
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== "string") throw new FormError(400, "Expected string fields.");
      data.set(key, value);
    }
  } else data = await form(request, 8 * 1024 * 1024);
  const command = field(data, "command", 20);
  const requestId = field(data, "requestId", 200);
  const revision = field(data, "revision", 200);
  if (!requestId.trim() || !revision.trim()) throw new FormError(400, "Missing request identity.");
  const argument = data.has("argument") ? field(data, "argument") : "";
  if (command === "submit") {
    if (data.has("content") && field(data, "content").trimStart().startsWith("/"))
      throw new FormError(400, "Slash commands must use the command interface.");
    const content = await inputContent(data);
    if (content === undefined) throw new FormError(400, "Enter a message or attach an image.");
    const mode = field(data, "whenBusy", 20);
    if (mode !== "reject" && mode !== "steer" && mode !== "followUp")
      throw new FormError(400, "Invalid submission mode.");
    await conversation.submit({ type: "input", requestId, content, whenBusy: mode }, context);
  } else if (command === "new") {
    const info = await sessionInfo(session, conversation, undefined, context);
    if (!info.binding || !info.model) throw new FormError(409, "Target or model is unavailable.");
    const creation = new FormData();
    for (const [key, value] of Object.entries({
      id: randomUUID(),
      target: JSON.stringify([info.binding.provider, info.binding.target]),
      model: JSON.stringify([info.model.provider, info.model.modelId]),
      thinkingLevel: info.thinkingLevel,
      baseDirectory:
        info.directoryRoot && info.cwd.startsWith(info.directoryRoot + "/")
          ? info.cwd.slice(info.directoryRoot.length + 1)
          : "",
    }))
      creation.set(key, value);
    const created = await createSession(creation, sessions, context);
    json(response, { requestId, revision, path: conversationURL(created) });
    return;
  } else if (command === "abort") await conversation.abort(context);
  else if (command === "resume") session.harness.resume();
  else if (command === "compact") await conversation.compact(argument || undefined, context);
  else if (command === "reset") await conversation.reset(argument || undefined, context);
  else if (command === "cancel") {
    const id = Number(argument);
    if (!Number.isSafeInteger(id) || id < 0) throw new FormError(400, "Invalid submission ID.");
    const result = await session.harness.abortSubmission(
      id as SubmissionId,
      context,
      conversation.id,
    );
    if (result !== "aborted") {
      if (result === "not_found")
        throw new FormError(404, "Submission not found in this conversation.");
      if (result === "already_placed") throw new FormError(409, "Submission was already placed.");
    }
  } else if (command === "cd") await changeDirectory(session, argument, conversation, context);
  else if (command === "rename") await rename(session, argument);
  else if (command === "review" || command === "endreview") {
    const result =
      command === "review"
        ? await startReview(session, conversation, context, argument || undefined)
        : await endReview(session, conversation, context);
    json(response, { requestId, revision, path: conversationURL(session, result.id) });
    return;
  } else throw new FormError(400, "Unsupported command.");
  json(response, { requestId, revision });
}
