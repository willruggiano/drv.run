import { html as h, renderHTML, type SafeHtml } from "./html.ts";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@earendil-works/chord/context";
import type { EntryId, SubmissionId, Conversation } from "@earendil-works/pi-durable";
import type { ContextInspection } from "./inspection.ts";
import type { GlobalSettingsStore } from "./server.ts";
import { settingFields } from "./settings.ts";
import {
  commands,
  commandCompletions,
  directoryCompletion,
  pathCompletion,
} from "./completions.ts";
import {
  hidden,
  icon,
  link,
  action,
  entry,
  message,
  tool,
  toolID,
  timing,
  contextHTML,
  compactTokens,
  type Call,
  type Result,
} from "./hypermedia-render.ts";
import {
  createForm,
  options,
  sessionForm,
  globalForm,
  thinking,
  modelKey,
  targetKey,
} from "./hypermedia-forms.ts";
import {
  InboxDoc,
  LiveDoc,
  UsageDoc,
  type ConversationView,
  type EntryRecord,
  type LiveState,
  type InboxState,
  type UsageState,
  type Cursor,
  type UserInput,
} from "@earendil-works/pi-durable";
import { Review } from "harness";
import { endReview, startReview } from "./review.ts";
import {
  getConversation,
  sessionInfo,
  repository as repositoryInfo,
  rename,
  selectEnvironment,
  completePaths,
  completeWorkingDirectories,
  changeDirectory,
  inspectContext,
  contextStatus,
  Environment,
  Metadata,
  SessionError,
  type Sessions,
  type Catalog,
  type Session,
  type SessionInfo,
} from "./sessions.ts";

export class FormError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const conversationURL = (session: Session, id = session.root.id) =>
  `/sessions/${session.id}/conversations/${id}`;

function sessionRow(item: Catalog["sessions"][number], back?: string): SafeHtml {
  const context = item.context;
  const percent =
    context.window && context.lastResponse
      ? (context.lastResponse.tokens / context.window) * 100
      : undefined;
  const heading = h`<span class="session-heading"><strong>${item.name || "Untitled session"}</strong><time data-date-only datetime="${new Date(item.created).toISOString()}">${new Date(item.created).toISOString().slice(0, 10)}</time></span>`;
  const environment = h`<span class="session-environment">${item.binding ? `${item.binding.provider === "local" ? "local" : item.binding.target} · ${item.cwd}` : "No execution environment"}</span>`;
  const model = h`<span class="model-summary"><span class="model-name">${item.model?.modelId ?? "No model"}</span><span class="footer-dot" aria-hidden="true"></span><span class="model-effort">${item.thinkingLevel}</span></span>`;
  const usage = h`<span class="context-usage">${percent === undefined ? "—" : `${percent.toFixed(1)}%`}/${context.window ? compactTokens(context.window) : "?"}${context.autoCompact ? " (auto)" : ""}</span>`;
  return h`<a class="session" href="/sessions/${item.id}" aria-current="${back?.startsWith(`/sessions/${item.id}/`) ?? false}">${heading}<span class="session-detail">${environment}<span class="footer-dot" aria-hidden="true"></span>${model}<span class="footer-dot" aria-hidden="true"></span>${usage}</span></a>`;
}

function returnPath(value: string | null): string | undefined {
  return value && /^\/sessions\/[0-9a-f-]+\/conversations\/\d+$/.test(value) ? value : undefined;
}
export function htmlPage(
  content: SafeHtml,
  back?: string,
  title = "Sessions",
  conversation = false,
): string {
  const sessionsPath = `/sessions${back ? `?return=${encodeURIComponent(back)}` : "?view=sessions"}`;
  const heading = conversation
    ? h`<a id="conversation-title" class="header-title" href="${sessionsPath}" aria-label="Sessions" title="Sessions" data-command="sessions">${title}</a>${!back ? h`<span id="status" class="session-status" data-state="none" role="status" aria-label="No session"></span>` : h`<button class="status-menu" type="button" popovertarget="conversation-menu" aria-label="Conversation actions"><span id="status" class="session-status" data-state="ready" role="status"><span class="sr-only">Ready</span></span></button>`}`
    : h`<span class="header-title">${title}</span>`;
  // htmx must see readyState=loading so initialization waits for DOMContentLoaded,
  // after the deferred extensions and module have registered their handlers.
  const head = h`<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#151719"><title>${title}</title><meta name="htmx-config" content='{"history":true,"mode":"same-origin"}'><link rel="manifest" href="/sessions/manifest.webmanifest"><link rel="icon" href="/icon.svg"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/hypermedia.css"><script src="/htmx.js"></script><script src="/hx-sse.js" defer></script><script src="/hypermedia-morph.js" defer></script><script type="module" src="/hypermedia-client.js"></script></head>`;
  const header = h`<header id="app-header"><div class="bar"><h1>${heading}</h1>${!conversation && (back || title !== "Sessions") ? h`<a id="close-view" class="icon" href="${back ?? "/sessions"}" data-return aria-label="${back ? "Conversation" : "Sessions"}" title="${back ? "Return to conversation" : "Return to sessions"}">${icon("close")}</a>` : h`<a id="menu-toggle" class="icon" href="/sessions/settings${back ? `?return=${encodeURIComponent(back)}` : ""}" aria-label="Global settings" title="Global settings">${icon("settings")}</a>`}</div><p id="request-error" role="alert"></p></header>`;
  return renderHTML(
    h`<!doctype html><html lang="en">${head}<body class="stacked-layout bottom-align"><main id="page" data-view="${conversation ? "conversation" : "panel"}" hx-history-elt hx-boost:inherited="true" hx-target:inherited="#page" hx-select:inherited="#page" hx-swap:inherited="outerHTML" hx-sync:inherited="#page:replace">${title === "Session settings" ? h`<div id="request-error" role="alert"></div>` : header}${content}</main></body></html>`,
  );
}
export function html(
  response: ServerResponse,
  content: SafeHtml,
  status = 200,
  back?: string,
  title?: string,
  conversation = false,
): void {
  // Native form POSTs must retain a same-origin Origin, not null.
  response.setHeader("Referrer-Policy", "same-origin");
  response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  response.end(htmlPage(content, back, title, conversation));
}
function redirect(request: IncomingMessage, response: ServerResponse, path: string): void {
  if (request.headers["hx-request"] === "true") {
    response.writeHead(200, {
      "HX-Location": JSON.stringify({ path, target: "#page", select: "#page", swap: "outerHTML" }),
    });
  } else response.writeHead(303, { Location: path });
  response.end();
}

async function form(request: IncomingMessage, maximum = 128 * 1024): Promise<FormData> {
  // Unlike JSON, ordinary forms are cross-site writable without a preflight.
  if (!request.headers.origin) throw new FormError(403, "Origin header required for forms.");
  const type = request.headers["content-type"] ?? "";
  if (
    !["application/x-www-form-urlencoded", "multipart/form-data"].includes(
      type.split(";")[0].trim(),
    )
  )
    throw new FormError(415, "Expected a form.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > maximum) throw new FormError(413, "Request too large.");
    chunks.push(buffer);
  }
  try {
    return await new Response(Buffer.concat(chunks), {
      headers: { "Content-Type": type },
    }).formData();
  } catch {
    throw new FormError(400, "Invalid form.");
  }
}
function field(data: FormData, key: string, max = 100_000): string {
  const values = data.getAll(key);
  const value = values[0];
  if (values.length !== 1 || typeof value !== "string" || value.length > max)
    throw new FormError(400, `Invalid ${key}.`);
  // Native form encoders canonicalize textarea newlines to CRLF.
  return value.replace(/\r\n?/g, "\n");
}

type ReviewState = { original?: number; active?: number };
function controls(url: string, view: ConversationView, review: ReviewState): SafeHtml {
  const live = view.docs[LiveDoc.definition.kind] as LiveState | undefined;
  const busy = live?.run !== undefined;
  return h`<div id="controls" class="actions" data-state="${busy ? "working" : "ready"}"><button id="input-toggle" class="icon enhanced-only" type="button" data-file-picker="images" aria-label="Upload attachments" title="Upload attachments">+</button><div id="review-menu" popover aria-label="Review actions">${
    review.original !== undefined
      ? h`${link(url.replace(/\d+$/, String(review.original)), "Visit original")}${action(`${url}/end-review`, "End review and return", "endreview")}`
      : review.active !== undefined
        ? link(url.replace(/\d+$/, String(review.active)), "Open review", h`data-command="review"`)
        : busy
          ? ""
          : action(
              `${url}/review`,
              "Start review",
              "review",
              h`<input type="hidden" name="scope" data-command-argument>`,
            )
  }</div><span class="spacer"></span>${busy ? h`<button class="submission-mode" form="composer" name="whenBusy" value="steer">Steer</button>${action(`${url}/abort`, icon("close"), "stop", h``, h` id="stop" class="icon" aria-label="Stop" title="Stop"`)}` : ""}<button id="send" class="icon" form="composer" name="whenBusy" value="${busy ? "followUp" : "reject"}" aria-label="${busy ? "Queue" : "Send"}" title="${busy ? "Queue" : "Send"} (Ctrl/⌘ Enter)">${icon("send")}</button></div>`;
}
function composerHTML(
  path: string,
  view: ConversationView,
  review: ReviewState,
  metadata: SafeHtml,
): SafeHtml {
  return h`<footer id="app-footer" class="composer-area"><button id="latest" type="button" data-latest hidden>↓ Latest</button><div class="composer-shell"><div class="compose-box"><form id="composer" method="post" action="${path}/submit" enctype="multipart/form-data" hx-encoding="multipart/form-data" hx-sync="this:drop">${hidden("requestId", randomUUID())}<textarea id="prompt" name="content" aria-label="Message" data-completions hx-get="${path}/completions" hx-trigger="input changed delay:120ms, compositionend delay:120ms" hx-target="#completions" hx-select="#completions" hx-swap="outerHTML" hx-sync="this:replace" rows="2" maxlength="100000" placeholder="Ask Pi…"></textarea><div id="completions" role="listbox" hidden></div><label class="attachment-picker">Images<input id="images" name="images" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple></label><div id="previews" aria-label="Attached images"></div></form>${controls(path, view, review)}</div></div><div id="usage-menu" popover>${usageHTML(view)}</div>${metadata}<p id="connection" class="sr-only" role="status">Live updates require JavaScript.</p></footer>`;
}
async function panelFrame(
  session: Session,
  conversation: Conversation,
  settings: GlobalSettingsStore | undefined,
  context: Context,
  content: SafeHtml,
): Promise<SafeHtml> {
  const path = conversationURL(session, conversation.id);
  const watch = await conversation.watch(context);
  try {
    const review = (await session.harness.snapshot(Review, conversation.id, context)) ?? {};
    return h`${navigation(path)}<section class="conversation-layout" ${streamAttributes(`${path}/events`)}><main id="main-area">${content}</main>${queueHTML(watch.value, path)}${composerHTML(path, watch.value, review, await metadataHTML(session, conversation, watch.value, settings, context))}</section>`;
  } finally {
    await watch.stop();
  }
}
function liveHTML(view: ConversationView, calls: ReadonlyMap<string, Call> = new Map()): SafeHtml {
  const live = view.docs[LiveDoc.definition.kind] as LiveState | undefined;
  return h`<section id="live" aria-label="Live output">${live?.generation?.message ? message(live.generation.message) : ""}${h`${[...(live?.tools ?? []).filter((slot) => !calls.has(slot.callId)), ...(live?.nestedTools ?? [])].map((slot) => tool({ id: slot.callId, name: slot.name, arguments: "arguments" in slot ? slot.arguments : {} }, undefined, slot, !!live?.run))}`}${live?.generation?.retry ? h`<p class="notice" hx-ignore>Retry ${live.generation.attempt}: ${live.generation.retry.error}</p>` : ""}${live?.generation?.deferred ? h`<p class="notice">Waiting for provider response…</p>` : ""}${h`${(live?.compactions ?? []).map((item) => h`<p class="notice">${item.blocking ? "Compacting context" : "Background compaction"} · ${item.reason} · Attempt ${item.attempt}${item.retry ? ` · ${item.retry.error}` : ""}</p>`)}`}${live?.compactionFailure ? h`<p class="error" hx-ignore>Compaction failed: ${live.compactionFailure.error}</p>` : ""}</section>`;
}
function queueHTML(view: ConversationView, path = ""): SafeHtml {
  const inbox = view.docs[InboxDoc.definition.kind] as InboxState | undefined;
  const items = inbox?.items ?? [];
  return h`<section id="queue" aria-label="Queued messages">${items.length ? h`<div class="queued-messages"><h2>Queued messages</h2>${items.map((item) => h`<article id="queued-${item.id}" data-role="user" data-mode="${item.mode}"><header><span class="speaker">${item.mode === "followUp" ? "Follow up" : item.mode === "steer" ? "Steer" : "Write"}</span>${path && item.mode !== "write" ? action(`${path}/cancel`, "×", "", hidden("id", String(item.id)), h` class="icon" aria-label="Cancel queued message" title="Cancel queued message"`) : ""}</header>${message({ role: "user", content: "content" in item ? item.content : typeof item.entry.kind === "string" ? item.entry.kind : JSON.stringify(item.entry.kind), timestamp: 0 }, undefined, false, false)}</article>`)}</div>` : ""}</section>`;
}
function usageHTML(view: ConversationView): SafeHtml {
  const usage = view.docs[UsageDoc.definition.kind] as UsageState | undefined;
  const rows = [...Object.entries(usage?.models ?? {}), ...Object.entries(usage?.tools ?? {})];
  const totals = rows.map(([, value]) => value);
  return h`<details id="usage"><summary>${totals.reduce((sum, item) => sum + item.totalTokens, 0).toLocaleString()} tokens · $${totals.reduce((sum, item) => sum + item.cost.total, 0).toFixed(4)}</summary><div class="usage-table"><table><thead><tr><th>Model / tool</th><th>Input</th><th>Output</th><th>Cache read</th><th>Cache write</th><th>Cost</th></tr></thead><tbody>${h`${rows.map(([name, item]) => h`<tr><th hx-ignore>${name}</th><td>${item.input}</td><td>${item.output}</td><td>${item.cacheRead}</td><td>${item.cacheWrite}</td><td>$${item.cost.total.toFixed(4)}</td></tr>`)}`}</tbody></table></div></details>`;
}

function streamAttributes(url: string): SafeHtml {
  return h`data-events="${url.split("?head=")[0]}" hx-sse:connect="${url}" hx-target="this" hx-select="" hx-swap="none" hx-sync="this:drop"`;
}
function partial(id: string, content: SafeHtml, swap = "outerMorph"): SafeHtml {
  return h`<hx-partial id="${id}" hx-swap="${swap}">${content}</hx-partial>`;
}

/** One projection per subscriber. Completed entries are immutable; document-only
 * revisions neither render nor transmit them. A new subscription sends a keyed
 * reconciliation, not append commands that require an uninterrupted connection. */
export class ConversationFragments {
  private entries: readonly EntryRecord[] | undefined;
  private readonly records = new Map<number, EntryRecord>();
  private readonly rendered = new Map<number, SafeHtml>();
  private readonly regions = new Map<string, unknown>();
  private readonly calls = new Map<string, Call>();
  private readonly results = new Map<string, Result>();
  private readonly retain: boolean;
  private liveState: LiveState | undefined;
  private sent: number[] | undefined;
  private clientHead: string | undefined;
  head = "0.0";
  readonly metrics = { frames: 0, bytes: 0, entries: 0, renderMs: 0 };
  readonly url: string;
  constructor(url: string, history?: EntryRecord[], head?: string) {
    this.clientHead = head;
    this.url = url;
    this.retain = history !== undefined;
    for (const record of history ?? []) this.records.set(record.id, record);
  }
  live(view: ConversationView): SafeHtml {
    return liveHTML(view, this.calls);
  }
  transcript(times = new Map<number, number>()): SafeHtml {
    let content = h``;
    for (const [id, record] of this.records) {
      content =
        record.kind === "pi.reset" || record.kind === "pi.compaction"
          ? entry(
              record,
              this.url,
              this.calls,
              this.results,
              this.liveState,
              content,
              times.get(id),
            )
          : h`${content}${this.rendered.get(id)}`;
    }
    return content;
  }
  render(view: ConversationView, review: ReviewState): string {
    return renderHTML(this.project(view, review));
  }
  project(
    view: ConversationView,
    review: ReviewState,
    times = new Map<number, number>(),
  ): SafeHtml {
    const start = performance.now();
    const parts: SafeHtml[] = [];
    const live = view.docs[LiveDoc.definition.kind] as LiveState | undefined;
    this.liveState = live;
    if (this.entries !== view.entries) {
      if (!this.retain) this.records.clear();
      for (const record of view.entries) this.records.set(record.id, record);
      const records = [...this.records.values()].sort((a, b) => a.id - b.id);
      this.records.clear();
      for (const record of records) {
        this.records.set(record.id, record);
        for (const message of record.model ?? []) {
          if (message.role === "assistant")
            for (const part of message.content)
              if (part.type === "toolCall") this.calls.set(part.id, part);
          if (message.role === "toolResult")
            this.results.set(message.toolCallId, { entry: record.id, message });
        }
      }
      const ids = records.map((record) => record.id);
      const layout =
        records.findLast((record) => record.kind === "pi.reset" || record.kind === "pi.compaction")
          ?.id ?? 0;
      this.head = `${ids.at(-1) ?? 0}.${layout}`;
      if (this.clientHead !== undefined) {
        const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(this.clientHead);
        const tail = match ? Number(match[1]) : NaN;
        const version = match ? Number(match[2]) : NaN;
        const index = tail === 0 ? -1 : ids.findIndex((id) => id === tail);
        if (
          Number.isSafeInteger(tail) &&
          Number.isSafeInteger(version) &&
          (tail === 0 || index >= 0) &&
          version === layout &&
          layout <= tail
        )
          this.sent = ids.slice(0, index + 1);
        this.clientHead = undefined;
      }
      const initial = this.entries === undefined;
      const appended =
        this.sent !== undefined &&
        this.sent.every((id, index) => ids[index] === id) &&
        records
          .slice(this.sent.length)
          .every((record) => record.kind !== "pi.reset" && record.kind !== "pi.compaction");
      for (const record of records) {
        if (this.rendered.has(record.id)) continue;
        this.metrics.entries++;
        this.rendered.set(
          record.id,
          entry(record, this.url, this.calls, this.results, live, h``, times.get(record.id)),
        );
      }
      if (!appended) parts.push(partial("transcript", this.transcript(times), "innerMorph"));
      else if (ids.length !== this.sent!.length)
        parts.push(
          partial(
            "transcript",
            h`${records.slice(this.sent!.length).map((record) => this.rendered.get(record.id))}`,
            "beforeend",
          ),
        );
      // Initial markup already contains completed tool results. Hydrate only
      // results newer than the client's head; active slots remain live regions.
      if (initial) {
        const tail = appended ? (this.sent!.at(-1) ?? 0) : Infinity;
        for (const call of this.calls.values()) {
          const result = this.results.get(call.id);
          if (result && result.entry <= tail)
            this.regions.set(toolID(call.id), JSON.stringify(result.entry));
        }
      }
      this.sent = ids;
      this.entries = view.entries;
    }
    const regions: [string, unknown, () => SafeHtml][] = [
      ["live", live, () => liveHTML(view, this.calls)],
      ["queue", view.docs[InboxDoc.definition.kind], () => queueHTML(view, this.url)],
      ["usage", view.docs[UsageDoc.definition.kind], () => usageHTML(view)],
      ["controls", JSON.stringify([!!live?.run, review]), () => controls(this.url, view, review)],
    ];
    for (const call of this.calls.values()) {
      const result = this.results.get(call.id);
      const slot = live?.tools?.find((slot) => slot.callId === call.id);
      regions.push([
        toolID(call.id),
        JSON.stringify(result ? result.entry : [slot, !!live?.run]),
        () => tool(call, result, slot, !!live?.run, this.url),
      ]);
    }
    for (const [id, value, render] of regions) {
      if (this.regions.has(id) && this.regions.get(id) === value) continue;
      this.regions.set(id, value);
      parts.push(partial(id, render()));
    }
    const output = h`${parts}`;
    if (output.length) {
      this.metrics.frames++;
      this.metrics.bytes += Buffer.byteLength(renderHTML(output));
    }
    this.metrics.renderMs += performance.now() - start;
    return output;
  }
}

async function events(
  session: Session,
  id: number,
  response: ServerResponse,
  context: Context,
  settings?: GlobalSettingsStore,
  inspection = false,
  head?: string,
): Promise<void> {
  const conversation = await getConversation(session, id, context);
  const watch = await conversation.watch(context);
  let view = watch.value;
  let review: ReviewState | undefined;
  let ready = false,
    dirty = false,
    sending = false,
    metadata = true;
  let timingsDirty = true;
  let durations = new Map<number, number>();
  const stopCommits = session.harness.subscribeCommits((publication) => {
    for (const change of publication.changes) {
      if (
        (change.type === "task" &&
          change.value.kind === "pi.compaction" &&
          change.value.state.status === "terminal") ||
        (change.type === "entry" && change.value.kind === "pi.compaction")
      ) {
        timingsDirty = true;
        if (ready) queueMicrotask(schedule);
      }
      if (change.type !== "document") continue;
      if (change.conversationId === id && change.record.kind === Review.definition.kind) {
        review = (change.value ?? {}) as ReviewState;
        if (ready) queueMicrotask(schedule);
      }
      if (
        (change.conversationId === id &&
          [Environment.definition.kind, "pi.agent"].includes(change.record.kind)) ||
        change.record.kind === Metadata.definition.kind
      ) {
        metadata = true;
        if (ready) queueMicrotask(schedule);
      }
    }
  });
  const stopSettings = settings?.watch(() => {
    metadata = true;
    if (ready) schedule();
  });
  const stop = () => {
    stopCommits();
    stopSettings?.();
  };
  response.once("close", stop);
  let records: EntryRecord[];
  try {
    const snapshot = await session.harness.snapshot(Review, conversation.id, context);
    review ??= snapshot ?? {};
    records = inspection ? [] : await history(conversation, context);
    context.abortSignal?.throwIfAborted();
  } catch (error) {
    stop();
    await watch.stop();
    throw error;
  }
  const path = conversationURL(session, conversation.id);
  const renderer = new ConversationFragments(path, records, head);
  let sentHead: string | undefined;
  response.writeHead(200, { "Content-Type": "text/event-stream", "X-Accel-Buffering": "no" });
  ready = true;
  let previousRun: unknown;
  let previousInspection: ContextInspection | undefined;
  function schedule() {
    dirty = true;
    void send().catch(() => response.destroy());
  }
  async function send() {
    if (sending) return;
    sending = true;
    try {
      while (dirty && !response.destroyed) {
        dirty = false;
        if (response.writableLength > 1024 * 1024) {
          response.destroy();
          return;
        }
        const current = view;
        const run = (current.docs[LiveDoc.definition.kind] as LiveState | undefined)?.run?.taskId;
        if (previousRun !== run) {
          metadata = true;
          previousRun = run;
        }
        const timingsChanged = !inspection && timingsDirty;
        if (timingsChanged) {
          timingsDirty = false;
          durations = await compactionTimes(session, context);
        }
        let fragment = h``;
        if (inspection) {
          const inspected = await inspectContext(session, current, context);
          if (inspected !== previousInspection)
            fragment = partial("context-view", contextHTML(inspected));
          previousInspection = inspected;
        } else fragment = renderer.project(current, review ?? {}, durations);
        if (timingsChanged) {
          for (const [entry, ms] of durations)
            fragment = h`${fragment}${partial(`duration-${entry}`, timing(entry, ms))}`;
        }
        if (!inspection && metadata) {
          metadata = false;
          fragment = h`${fragment}${partial("session-meta", await metadataHTML(session, conversation, current, settings, context))}`;
        }
        if (fragment.length && !response.destroyed) {
          const id = inspection || sentHead === renderer.head ? "" : `id: ${renderer.head}\n`;
          response.write(`${id}data: ${renderHTML(fragment).replace(/\r\n?|\n/g, "\ndata: ")}\n\n`);
          sentHead = renderer.head;
        }
      }
    } finally {
      sending = false;
    }
  }
  schedule();
  watch.start(async (value) => {
    view = value;
    schedule();
  });
  const heartbeat = setInterval(() => {
    if (response.writableLength > 1024 * 1024) response.destroy();
    else response.write(": heartbeat\n\n");
  }, 15_000);
  response.once("close", () => clearInterval(heartbeat));
  void watch.closed.then(() => {
    stop();
    clearInterval(heartbeat);
    if (!response.destroyed) response.end();
  });
}

export async function hypermedia(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  sessions: Sessions,
  context: Context,
  settings?: GlobalSettingsStore,
): Promise<void> {
  // htmx 4 boosts forms into history even when HX-Reswap is none. Only the
  // explicit HX-Location redirect may navigate after a mutation.
  if (request.method !== "GET") response.setHeader("HX-Push-Url", "false");
  if (url.pathname === "/sessions") {
    if (request.method === "GET") {
      const catalog = await sessions.catalog(context);
      const query = url.searchParams.get("q")?.toLocaleLowerCase() ?? "";
      const back = returnPath(url.searchParams.get("return"));
      const picker = !!back || url.searchParams.get("view") === "sessions";
      let metadata = h``;
      if (back) {
        const parts = back.split("/");
        const session = await sessions.get(parts[2]);
        const conversation = await getConversation(session, Number(parts[4]), context);
        const watch = await conversation.watch(context);
        try {
          metadata = await metadataHTML(session, conversation, watch.value, settings, context);
        } finally {
          await watch.stop();
        }
      }
      const list = catalog.sessions.filter((item) =>
        `${item.name} ${item.binding?.target} ${item.id}`.toLocaleLowerCase().includes(query),
      );
      const rows = h`${(picker ? list : list.slice(0, 5)).map((item) => sessionRow(item, back))}`;
      html(
        response,
        h`<main id="main-area"><section id="${picker ? "picker" : "landing"}" class="pane"><nav aria-label="Account"><a href="/auth">Auth</a></nav><div>${!picker && rows.length ? h`<h2 id="recent-title">Recent sessions</h2>` : ""}<div id="session-list">${rows}</div>${rows.length ? "" : h`<p id="sessions-empty">No sessions</p>`}</div></section></main><form id="session-filter-form" method="get" action="/sessions" hidden>${back ? hidden("return", back) : hidden("view", "sessions")}</form>${createForm(catalog, randomUUID(), picker, query, metadata)}`,
        200,
        picker ? (back ?? "/sessions") : undefined,
        picker ? "Sessions" : "No session",
        !picker,
      );

      return;
    }
    if (request.method === "POST") {
      const data = await form(request, 8 * 1024 * 1024);
      const catalog = await sessions.catalog(context);
      const target = catalog.targets.find(
        (target) =>
          JSON.stringify([target.provider, target.target]) === field(data, "target", 8192) &&
          target.available,
      );
      const model = catalog.models.find(
        (model) => JSON.stringify([model.provider, model.modelId]) === field(data, "model", 1024),
      );
      if (!target || !model)
        throw new SessionError("unavailable", "Target or model is unavailable.");
      const level = optional(data, "thinkingLevel");
      if (level && !thinking(level)) throw new FormError(400, "Invalid thinking level.");
      let content = await inputContent(data);
      if (data.has("command")) {
        if (
          field(data, "command", 20) !== "new" ||
          typeof content !== "string" ||
          content.trim() !== "/new"
        )
          throw new FormError(400, "Invalid creation command.");
        content = undefined;
      }
      const requestId = content === undefined ? undefined : field(data, "requestId", 200);
      if (requestId !== undefined && !requestId.trim())
        throw new FormError(400, "Missing request ID.");
      const baseDirectory = optional(data, "baseDirectory");
      const session = await sessions.create(
        field(data, "id", 36),
        target,
        { provider: model.provider, modelId: model.modelId },
        thinking(level),
        target.directoryRoot ? baseDirectory : baseDirectory || undefined,
      );
      if (content !== undefined)
        await session.root.submit({ type: "input", content, requestId }, context);
      response.setHeader(
        "HX-Trigger",
        JSON.stringify({
          submitted: {
            requestId: optional(data, "requestId"),
            draftAction: `${conversationURL(session)}/submit`,
          },
        }),
      );
      redirect(request, response, conversationURL(session));
      return;
    }
    throw new FormError(405, "Method not allowed.");
  }
  if (url.pathname === "/sessions/offline" && request.method === "GET") {
    html(
      response,
      h`<h1>Offline</h1><p>Conversation history is not cached in this browser.</p><p><a href="/sessions">Reconnect</a></p>`,
    );
    return;
  }
  if (url.pathname === "/sessions/manifest.webmanifest" && request.method === "GET") {
    response.setHeader("Content-Type", "application/manifest+json");
    response.end(
      JSON.stringify({
        id: "/sessions",
        scope: "/",
        name: "Pi · Hypermedia",
        short_name: "Pi",
        start_url: "/sessions",
        display: "standalone",
        background_color: "#151719",
        theme_color: "#151719",
        icons: [192, 512].map((size) => ({
          src: `/icon-${size}.png`,
          sizes: `${size}x${size}`,
          type: "image/png",
        })),
      }),
    );
    return;
  }
  if (url.pathname === "/sessions/completions" && request.method === "GET") {
    const query = url.searchParams.get("query") ?? "";
    const items =
      url.searchParams.get("kind") === "command"
        ? commands.filter(
            (item) =>
              ["new", "sessions"].includes(item.name) && item.name.startsWith(query.toLowerCase()),
          )
        : [];
    html(
      response,
      h`<div id="completions" role="listbox">${h`${items.map((item) => h`<button type="button" role="option" data-completion="/${item.name} ">/${item.name} · ${item.description}</button>`)}`}</div>`,
    );
    return;
  }
  if (url.pathname === "/sessions/options" && request.method === "GET") {
    const values = new URLSearchParams(url.searchParams);
    if (request.headers["hx-source"] === "select#models") values.delete("thinkingLevel");
    if (request.headers["hx-source"] === "select#targets") values.set("baseDirectory", "");
    html(response, options(await sessions.catalog(context), values));
    return;
  }
  if (url.pathname === "/sessions/directories" && request.method === "GET") {
    const targets = (await sessions.options.targets?.(context)) ?? [];
    const target = targets.find(
      (item) => targetKey(item) === url.searchParams.get("target") && item.available,
    );
    if (!target) throw new FormError(409, "Execution target is unavailable.");
    const paths = await sessions.completeDirectories(
      target,
      url.searchParams.get("baseDirectory") ?? "",
      context,
    );
    html(
      response,
      h`<datalist id="directories">${h`${paths.map((path) => h`<option value="${path}"></option>`)}`}</datalist>`,
    );
    return;
  }
  if (url.pathname === "/sessions/settings") {
    const back = returnPath(url.searchParams.get("return"));
    const settingsPath = `/sessions/settings${back ? `?return=${encodeURIComponent(back)}` : ""}`;
    if (request.method === "GET") {
      const content = h`<section id="global-preferences" class="pane">${globalForm(await sessions.catalog(context), settings?.read(), url.searchParams.get("model") ?? undefined, settingsPath)}</section>`;
      let frame = h`<main id="main-area">${content}</main>`;
      if (back) {
        const parts = back.split("/");
        const session = await sessions.get(parts[2]);
        const conversation = await getConversation(session, Number(parts[4]), context);
        frame = await panelFrame(session, conversation, settings, context, content);
      }
      html(response, frame, 200, back, "Default preferences");
      return;
    }
    if (request.method !== "POST") throw new FormError(405, "Method not allowed.");
    if (!settings) throw new FormError(503, "Shared settings are not configured.");
    const data = await form(request);
    const values: Record<string, unknown> = {};
    for (const item of settingFields) {
      if ("readonly" in item) continue;
      const value = field(data, item.key, 100);
      if ("type" in item && item.type === "boolean" && value !== "true" && value !== "false")
        throw new FormError(400, "Invalid boolean setting.");
      values[item.key] = "choices" in item ? value : value === "true";
    }
    const model = (await sessions.catalog(context)).models.find(
      (model) => modelKey(model) === optional(data, "model"),
    );
    if (optional(data, "model") && !model) throw new FormError(400, "Model is unavailable.");
    await settings.update(
      {
        values,
        ...(model
          ? { model, modelThinkingLevel: optional(data, "modelThinkingLevel") || null }
          : {}),
      },
      sessions,
    );
    saved(request, response, settingsPath);
    return;
  }
  const match =
    /^\/sessions\/([^/]+)(?:\/conversations\/(\d+)(?:\/(events|submit|review|end-review|abort|resume|history|settings|branches|fork|cd|compact|reset|cancel|context|export|completions|repository))?)?$/.exec(
      url.pathname,
    );
  if (!match) throw new FormError(404, "Not found.");
  const session = await sessions.get(match[1]);
  const conversation = await getConversation(
    session,
    match[2] === undefined ? undefined : Number(match[2]),
    context,
  );
  const path = conversationURL(session, conversation.id);
  const operation = match[3];
  const titles: Record<string, string> = {
    settings: "Session settings",
    branches: "Branches",
    context: "Context",
    history: "History",
    compact: "Compact context",
    reset: "Reset context",
  };
  const page = (
    content: SafeHtml,
    title = titles[operation ?? ""] ?? "Conversation",
    conversationPage = false,
  ) => html(response, content, 200, path, title, conversationPage);
  if (request.method === "GET" && operation === "settings") {
    const catalog = await sessions.catalog(context);
    const info = await sessionInfo(session, conversation, catalog.targets, context);
    page(
      await panelFrame(
        session,
        conversation,
        settings,
        context,
        h`<section id="preferences" class="pane" aria-label="Session settings"><div><a id="close-view" class="icon" href="${path}" data-return aria-label="Conversation" title="Return to conversation">${icon("close")}</a>${sessionForm(path, catalog, info)}</div></section>`,
      ),
    );
    return;
  }
  if (request.method === "GET" && operation === "branches") {
    const records = [];
    let cursor: Cursor | undefined;
    do {
      const page = await session.harness.commit(
        (tx) => tx.scanConversations({}, 256, cursor),
        context,
      );
      records.push(...page.items);
      cursor = page.next;
    } while (cursor);
    const items = await Promise.all(
      records.map(async (record) => {
        const review = await session.harness.snapshot(Review, record.id, context);
        const parent = review?.original ?? record.parent?.conversationId;
        return h`<a href="${conversationURL(session, record.id)}" class="session" data-conversation="${record.id}" aria-current="${record.id === conversation.id}"><strong>${review?.original !== undefined ? `Review ${record.id}` : record.id === session.root.id ? "Main" : `Branch ${record.id}`}</strong>${parent === undefined ? "" : h`<small>From ${parent}</small>`}</a>`;
      }),
    );
    page(
      await panelFrame(
        session,
        conversation,
        settings,
        context,
        h`<section id="branch-picker" class="pane"><div id="branches">${h`${items}`}</div></section>`,
      ),
    );
    return;
  }
  if (request.method === "GET" && operation === "repository") {
    const [info, repository] = await Promise.all([
      sessionInfo(session, conversation, undefined, context),
      repositoryInfo(session, conversation, context),
    ]);
    const title =
      repository.state === "repository"
        ? (repository.branch ?? repository.revision ?? "unborn")
        : repository.state === "none"
          ? "no repository"
          : "repository unavailable";
    page(h`<h1>Repository</h1>${instanceHTML(info, path, title)}<p>${title}</p>`);
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
  if (request.method === "GET" && operation === "completions") {
    const query = url.searchParams.get("query") ?? "";
    const review = await session.harness.snapshot(Review, conversation.id, context);
    const completions =
      url.searchParams.get("kind") === "command"
        ? commandCompletions(query, review?.original !== undefined).map((item) => ({
            ...item,
            label: `${item.label} · ${item.description}`,
          }))
        : url.searchParams.get("kind") === "directory"
          ? (await completeWorkingDirectories(session, query, conversation, context)).map(
              directoryCompletion,
            )
          : (await completePaths(session, query, conversation, context)).map(pathCompletion);
    page(
      h`<div id="completions" role="listbox">${h`${completions.map((item) => h`<button type="button" role="option" data-completion="${item.value}">${item.label}</button>`)}`}</div>`,
    );
    return;
  }
  if (request.method === "GET" && (operation === "reset" || operation === "compact")) {
    page(
      h`${navigation(path)}<main id="main-area"><section class="pane"><h1>${operation === "reset" ? "Reset context" : "Compact context"}</h1><p>History is preserved.</p><form method="post" action="${path}/${operation}" data-command="${operation}">${hidden("requestId", url.searchParams.get("requestId") ?? "")}<label>${operation === "reset" ? "Handoff" : "Instructions"}<textarea name="argument" data-command-argument maxlength="100000">${url.searchParams.get("argument") ?? ""}</textarea></label><button>${operation === "reset" ? "Confirm reset" : "Compact"}</button></form></section></main>`,
    );
    return;
  }
  if (request.method === "GET" && operation === "context") {
    const watch = await conversation.watch(context);
    try {
      page(
        h`${navigation(path)}<main id="main-area" ${streamAttributes(`${path}/events?pane=context`)}>${contextHTML(await inspectContext(session, watch.value, context))}<p id="connection" class="sr-only" role="status"></p></main>`,
      );
    } finally {
      await watch.stop();
    }
    return;
  }
  if (request.method === "GET") {
    if (!match[2]) {
      redirect(request, response, path);
      return;
    }
    if (operation === "events") {
      await events(
        session,
        conversation.id,
        response,
        context,
        settings,
        url.searchParams.get("pane") === "context",
        typeof request.headers["last-event-id"] === "string"
          ? request.headers["last-event-id"]
          : (url.searchParams.get("head") ?? undefined),
      );
      return;
    }
    if (operation === "history") {
      let cursor: Cursor | undefined;
      try {
        cursor = url.searchParams.has("cursor")
          ? (JSON.parse(url.searchParams.get("cursor")!) as Cursor)
          : undefined;
      } catch {
        throw new FormError(400, "Invalid history cursor.");
      }
      const history = await conversation.entries({ order: "descending" }, 100, cursor, context);
      page(
        h`<main id="main-area"><section class="pane"><h1>History</h1>${h`${history.items
          .toReversed()
          .map((record) =>
            entry(record, path),
          )}`}${history.next ? link(`${path}/history?cursor=${encodeURIComponent(JSON.stringify(history.next))}`, "Older history") : ""}</section></main>`,
      );
      return;
    }
    if (operation) throw new FormError(405, "Method not allowed.");
    const watch = await conversation.watch(context);
    try {
      const review = (await session.harness.snapshot(Review, conversation.id, context)) ?? {};
      const info = await sessionInfo(session, conversation, undefined, context);
      const records = await history(conversation, context);
      const renderer = new ConversationFragments(path, records);
      renderer.render(watch.value, review);
      page(
        h`${navigation(path)}<section class="conversation-layout" ${streamAttributes(`${path}/events?head=${renderer.head}`)}><main id="main-area"><div class="scrollport pane" id="conversation-scroll" tabindex="0" aria-label="Conversation"><div id="transcript">${renderer.transcript(records.some((record) => record.kind === "pi.compaction") ? await compactionTimes(session, context) : undefined)}</div>${renderer.live(watch.value)}</div></main>${queueHTML(watch.value, path)}${composerHTML(path, watch.value, review, await metadataHTML(session, conversation, watch.value, settings, context))}</section>`,
        info.name || "Untitled session",
        true,
      );
    } finally {
      await watch.stop();
    }
    return;
  }
  if (request.method !== "POST") throw new FormError(405, "Method not allowed.");
  const data = await form(request, operation === "submit" ? 8 * 1024 * 1024 : 128 * 1024);
  if (operation === "settings") {
    const catalog = await sessions.catalog(context);
    const current = await sessionInfo(session, conversation, catalog.targets, context);
    const name = field(data, "name", 120);
    const targetValue = field(data, "target", 8192),
      modelValue = field(data, "model", 1024);
    const target = catalog.targets.find(
      (item) => targetKey(item) === targetValue && item.available,
    );
    const model = catalog.models.find((item) => modelKey(item) === modelValue);
    const level = optional(data, "thinkingLevel");
    if (level && !thinking(level)) throw new FormError(400, "Invalid thinking level.");
    if (!model && (!current.model || modelKey(current.model) !== modelValue))
      throw new FormError(409, "Model is unavailable.");
    if (!target && (!current.binding || targetKey(current.binding) !== targetValue))
      throw new FormError(409, "Target is unavailable.");
    const baseDirectory = optional(data, "baseDirectory");
    const currentBase =
      current.directoryRoot && current.cwd.startsWith(current.directoryRoot + "/")
        ? current.cwd.slice(current.directoryRoot.length + 1)
        : "";
    if (!target && baseDirectory !== currentBase)
      throw new FormError(409, "Target is unavailable.");
    const cwd = target?.directoryRoot
      ? await sessions.baseDirectory(target, baseDirectory)
      : (target?.cwd ?? current.cwd);
    // Validate every field before persisting any part of the form.
    if (Array.from(name).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))
      throw new FormError(400, "Invalid session name.");
    if (
      target &&
      (!current.binding || targetKey(current.binding) !== targetValue || current.cwd !== cwd)
    )
      await selectEnvironment(session, { ...target, cwd }, conversation);
    await conversation.configure(
      {
        ...(model ? { model: { provider: model.provider, modelId: model.modelId } } : {}),
        ...(model
          ? { thinkingLevel: sessions.resolveThinking(model, thinking(level)) }
          : level
            ? { thinkingLevel: thinking(level) }
            : {}),
        cwd,
      },
      context,
    );
    if (name !== current.name) await rename(session, name);
    saved(request, response, `${path}/settings`);
    return;
  }
  if (operation === "fork") {
    const at = Number(field(data, "at", 30));
    if (!Number.isSafeInteger(at) || at < 0) throw new FormError(400, "Invalid entry ID.");
    const fork = await conversation.fork(
      at as EntryId,
      { ownership: { kind: "ownerless" } },
      context,
    );
    redirect(request, response, conversationURL(session, fork.id));
    return;
  }
  if (operation === "cd") {
    await changeDirectory(session, field(data, "argument", 4096), conversation, context);
    response.setHeader("HX-Push-Url", "false");
    saved(request, response, path);
    return;
  }
  if (operation === "compact" || operation === "reset") {
    const argument = optional(data, "argument");
    const requestId = data.has("requestId") ? field(data, "requestId", 200) : "";
    if (operation === "compact") await conversation.compact(argument || undefined, context);
    else await conversation.reset(argument || undefined, context);
    if (requestId) response.setHeader("HX-Trigger", JSON.stringify({ submitted: { requestId } }));
    const current = request.headers["hx-current-url"];
    if (typeof current === "string" && current.endsWith(path)) saved(request, response, path);
    else redirect(request, response, path);
    return;
  }
  if (operation === "cancel") {
    const id = Number(field(data, "id", 30));
    if (!Number.isSafeInteger(id) || id < 0) throw new FormError(400, "Invalid submission ID.");
    const result = await session.harness.abortSubmission(
      id as SubmissionId,
      context,
      conversation.id,
    );
    if (result === "not_found")
      throw new FormError(404, "Submission not found in this conversation.");
    if (result === "already_placed") throw new FormError(409, "Submission was already placed.");
    saved(request, response, path);
    return;
  }
  if (operation === "submit") {
    const content = await inputContent(data);
    if (content === undefined) throw new FormError(400, "Enter a message or attach an image.");
    const requestId = field(data, "requestId", 200);
    if (!requestId.trim()) throw new FormError(400, "Missing request ID.");
    const mode = field(data, "whenBusy", 20);
    if (mode !== "steer" && mode !== "followUp" && mode !== "reject")
      throw new FormError(400, "Invalid submission mode.");
    await conversation.submit(
      {
        type: "input",
        requestId,
        content,
        whenBusy: mode,
      },
      context,
    );
    if (request.headers["hx-request"] === "true") {
      response.writeHead(200, {
        "HX-Reswap": "none",
        "HX-Trigger": JSON.stringify({ submitted: { requestId } }),
      });
      response.end();
    } else redirect(request, response, path);
    return;
  }
  if (operation === "review" || operation === "end-review") {
    const result =
      operation === "review"
        ? await startReview(
            session,
            conversation,
            context,
            data.has("scope") ? field(data, "scope") : undefined,
          )
        : await endReview(session, conversation, context);
    redirect(request, response, conversationURL(session, result.id));
    return;
  }
  if (operation === "abort") await conversation.abort(context);
  else if (operation === "resume") session.harness.resume();
  else throw new FormError(405, "Method not allowed.");
  saved(request, response, path);
}

function optional(data: FormData, key: string): string {
  return data.has(key) ? field(data, key) : "";
}
function saved(request: IncomingMessage, response: ServerResponse, path: string) {
  if (request.headers["hx-request"] === "true") {
    response.writeHead(200, {
      "HX-Reswap": "none",
      "HX-Trigger": response.getHeader("HX-Trigger") ?? "saved",
    });
    response.end();
  } else redirect(request, response, path);
}
async function inputContent(data: FormData): Promise<UserInput | undefined> {
  const text = optional(data, "content");
  const images: Exclude<UserInput, string> = [];
  let size = 0;
  for (const file of data.getAll("images")) {
    if (typeof file === "string") throw new FormError(400, "Invalid image.");
    if (!file.size) continue;
    if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type))
      throw new FormError(400, "Unsupported image type.");
    size += file.size;
    images.push({
      type: "image",
      mimeType: file.type,
      data: Buffer.from(await file.arrayBuffer()).toString("base64"),
    });
  }
  if (images.length > 4 || size > 5 * 1024 * 1024)
    throw new FormError(400, "Attach up to four images, totaling at most 5 MiB.");
  return images.length ? [{ type: "text", text }, ...images] : text.trim() ? text : undefined;
}
async function history(conversation: Conversation, context: Context) {
  const records: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await conversation.entries({ order: "ascending" }, 256, cursor, context);
    records.push(...page.items);
    cursor = page.next;
  } while (cursor);
  return records;
}
function navigation(path: string): SafeHtml {
  const menu = h`<nav id="conversation-menu" class="conversation-nav" popover aria-label="Conversation actions">${link(path, "Conversation", h`data-return`)}${link(`${path}/settings`, "Settings", h`data-command="settings"`)}${link(`${path}/settings`, "Model", h`data-command="model"`)}${link(`${path}/branches`, "Branches", h`data-command="fork"`)}${link(`${path}/context`, "Context")}${link(`${path}/history`, "History")}${link(`${path}/compact`, "Compact")}${link(`${path}/reset`, "Reset")}${link(`${path}/export`, "Export JSON", h`hx-boost="false" data-command="export" download`)}<button type="button" data-command="search" data-search-toggle>Search</button><button type="button" popovertarget="review-menu">Review actions</button><button type="button" popovertarget="usage-menu">Usage</button></nav>`;
  const commands = h`<div hidden>${action(`${path}/cd`, "Change working directory", "cd", h`<input type="hidden" name="argument" data-command-argument>`)}${action(`${path}/compact`, "Compact", "compact", h`<input type="hidden" name="argument" data-command-argument>`)}<form method="get" action="${path}/reset" data-command="reset" data-command-deferred><input type="hidden" name="requestId" data-command-request><input type="hidden" name="argument" data-command-argument><button>Reset</button></form></div>`;
  const search = h`<div id="search-bar" hidden><div class="compose-box"><input id="search" type="search" aria-label="Find in conversation" placeholder="Find in conversation…"><div class="actions"><output id="search-count"></output><span class="spacer"></span><button id="search-prev" class="icon" type="button" data-search-step="-1" aria-label="Previous match">↑</button><button id="search-next" class="icon" type="button" data-search-step="1" aria-label="Next match">↓</button></div></div></div>`;
  return h`${menu}${commands}${search}`;
}

function instanceHTML(info: SessionInfo, path: string, title?: string): SafeHtml {
  return h`<a id="footer-instance" href="${path}/repository"${
    title === undefined
      ? h` hx-get="${path}/repository" hx-trigger="pointerenter once, focus once" hx-target="this" hx-select="#footer-instance" hx-swap="outerMorph" hx-sync="this:drop" hx-push-url="false"`
      : h` title="${title}"`
  }>${info.binding ? `${info.binding.provider === "local" ? "local" : info.binding.target} · ${info.cwd}` : "No execution environment"}</a>`;
}

async function metadataHTML(
  session: Session,
  conversation: Conversation,
  view: ConversationView,
  settings: GlobalSettingsStore | undefined,
  context: Context,
): Promise<SafeHtml> {
  const [info, inspection] = await Promise.all([
    sessionInfo(session, conversation, undefined, context),
    session.harness.inspect(context),
  ]);
  const path = conversationURL(session, conversation.id);
  const status = contextStatus(session, view);
  const count = (n: number | null | undefined) =>
    n === null || n === undefined ? "—" : compactTokens(n);
  const percent =
    status.window && status.lastResponse
      ? (status.lastResponse.tokens / status.window) * 100
      : undefined;
  const usage = view.docs[UsageDoc.definition.kind] as UsageState | undefined;
  const totals = [...Object.values(usage?.models ?? {}), ...Object.values(usage?.tools ?? {})];
  const sum = (key: "input" | "output" | "cacheRead") =>
    totals.reduce((total, item) => total + item[key], 0);
  const cost = totals.reduce((total, item) => total + item.cost.total, 0);
  const dot = h`<span class="footer-dot" aria-hidden="true"></span>`;
  const display = settings?.read().values;
  const id = randomUUID();
  const instance = instanceHTML(info, path);
  const statistics = h`<a id="footer-stats" href="${path}/context" aria-label="Context"><span id="footer-input">↑${count(sum("input"))}</span><span id="footer-output">↓${count(sum("output"))}</span><span id="footer-read">R${count(sum("cacheRead"))}</span><span id="footer-hit">${status.lastResponse?.cacheHit == null ? "CH—" : `CH${status.lastResponse.cacheHit.toFixed(1)}%`}</span><span id="footer-cost">$${cost.toFixed(3)}</span></a>`;
  const model = h`<a id="footer-model" class="model-summary" href="${path}/settings" aria-label="Model and thinking settings"><span class="model-name">${info.model?.modelId ?? "No model"}</span>${dot}<span class="model-effort">${info.thinkingLevel}</span></a>`;
  const contextUsage = h`<a id="footer-context" class="context-usage" href="${path}/context" aria-label="Context usage details" data-level="${percent !== undefined && percent > 90 ? "critical" : percent !== undefined && percent > 70 ? "warning" : "normal"}">${percent === undefined ? "—" : `${percent.toFixed(1)}%`}/${count(status.window)}${status.autoCompact ? " (auto)" : ""}</a>`;
  const newSession = h`${info.binding && info.model ? h`<form method="post" action="/sessions" data-command="new"><input type="hidden" name="id" value="${id}" data-command-request><input type="hidden" name="requestId" value="${id}" data-command-request>${hidden("target", targetKey(info.binding))}${hidden("model", modelKey(info.model))}${hidden("thinkingLevel", info.thinkingLevel)}${hidden("baseDirectory", info.directoryRoot && info.cwd.startsWith(info.directoryRoot + "/") ? info.cwd.slice(info.directoryRoot.length + 1) : "")}<button>New session</button></form>` : ""}`;
  return h`<section id="session-meta" data-name="${info.name || `Conversation ${conversation.id}`}" data-hide-thinking="${display?.hideThinkingBlock === true}" data-hide-images="${display?.["terminal.showImages"] === false}"><div id="bottom-line" aria-label="Conversation statistics"><div class="footer-row">${instance}${statistics}<div class="footer-model-context">${model}${dot}${contextUsage}</div></div></div>${inspection.scheduling === "paused" && (inspection.tasks.length > 0 || inspection.submissions.length > 0) ? action(`${path}/resume`, "Resume interrupted execution", "resume") : ""}${newSession}</section>`;
}

async function compactionTimes(session: Session, context: Context): Promise<Map<number, number>> {
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
