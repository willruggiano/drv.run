import assert from "node:assert/strict";
import MarkdownIt from "markdown-it";
import hljs from "highlight.js";
import type { Message, ModelThinkingLevel, ToolCall } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import {
  AgentDoc,
  InboxDoc,
  LiveDoc,
  UsageDoc,
  type UsageState,
  type Conversation,
  type ConversationView,
  type EntryRecord,
  type InboxState,
  type LiveState,
} from "@earendil-works/pi-durable";
import { Env } from "./harness/index.ts";
import {
  context,
  environmentId,
  modelKey,
  type Application,
  type Sessions,
} from "./application.ts";

export const escape = (value: unknown): string =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  highlight(code, language) {
    return language && hljs.getLanguage(language)
      ? hljs.highlight(code, { language, ignoreIllegals: true }).value
      : escape(code);
  },
});

const icons = {
  send: "M12 20V4m-7 7 7-7 7 7",
  close: "m6 6 12 12M18 6 6 18",
  down: "m6 9 6 6 6-6",
  up: "m6 15 6-6 6 6",
  top: "m6 11 6-6 6 6m-12 8 6-6 6 6",
  latest: "m6 5 6 6 6-6m-12 8 6 6 6-6",
  back: "m15 6-6 6 6 6",
};
const icon = (name: keyof typeof icons) =>
  `<svg class="glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="${icons[name]}"></path></svg>`;
const dot = '<span class="footer-dot" aria-hidden="true"></span>';

export function page(title: string, body: string, view = "home", prefix = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="theme-color" content="#151719"><title>${escape(title)}</title><link rel="icon" href="data:,"><link rel="stylesheet" href="${escape(prefix)}/assets/style.css"><script type="module" src="${escape(prefix)}/assets/datastar.js"></script><script type="module" src="${escape(prefix)}/assets/browser.js"></script></head><body data-signals="{_hasInput:false,_hasFiles:false}"><div id="page" class="stacked-layout bottom-align" data-view="${view}">${body}</div></body></html>`;
}

export function alert(message = ""): string {
  return `<div id="notice" role="alert">${escape(message)}</div>`;
}

const option = (value: string, label: string, selected: string) =>
  `<option value="${escape(value)}"${value === selected ? " selected" : ""}>${escape(label)}</option>`;
const picker = (id: string, label: string, control: string, value: string) =>
  `<label id="${id}-choice"><span class="selector-label">${label}</span>${control}<span class="selector-value" aria-hidden="true">${escape(value)}</span></label>`;
const updateLabel = "el.nextElementSibling.textContent = el.selectedOptions[0].label";

export function thinking(
  app: Pick<Application, "models">,
  key: string,
  selected: string,
  autosave = false,
): string {
  const model = app.models.getModels().find((candidate) => modelKey(candidate) === key);
  const levels: ModelThinkingLevel[] = model ? getSupportedThinkingLevels(model) : ["off"];
  const level = levels.find((level) => level === selected) ?? levels[0] ?? "off";
  return picker(
    "thinking",
    "Thinking",
    `<select id="thinking" name="thinking" aria-label="Thinking" data-on:change="${updateLabel}${autosave ? "; el.form.requestSubmit()" : ""}">${levels.map((item) => option(item, item, level)).join("")}</select>`,
    level,
  );
}

type Menu = Pick<Application, "models" | "environments" | "cwd"> &
  Partial<Pick<Application, "harness">>;
const js = (value: string) => escape(JSON.stringify(value));
export const sessionPath = (prefix: string, id: string) =>
  `${prefix}/api/s/${encodeURIComponent(id)}`;
export const conversationPath = (prefix: string, session: string, id: number) =>
  `${sessionPath(prefix, session)}/c/${id}`;

async function selections(app: Menu, prefix: string, conversation?: Conversation) {
  assert(!conversation || app.harness);
  const agent = await conversation?.agent(context);
  const env = conversation && (await app.harness!.snapshot(Env, conversation.id, context))?.env;
  const models = [...(await app.models.getAvailable())];
  const selectedModel = agent?.model
    ? `${agent.model.provider}/${agent.model.modelId}`
    : !conversation && models[0]
      ? modelKey(models[0])
      : "";
  const environments = await app.environments();
  const selectedEnv = conversation ? environmentId(env) : "local";
  if (selectedModel && !models.some((model) => modelKey(model) === selectedModel)) {
    const previous = agent?.model && app.models.getModel(agent.model.provider, agent.model.modelId);
    if (previous) models.push(previous);
  }
  const environment = picker(
    "environment",
    "Environment",
    `<select name="environment" id="environment" aria-label="Environment" data-on:change="${updateLabel}${conversation ? "; el.form.requestSubmit()" : ""}">${selectedEnv ? "" : '<option value="" selected disabled>No environment</option>'}${environments.map((item) => option(item.id, item.label, selectedEnv)).join("")}${selectedEnv && !environments.some((item) => item.id === selectedEnv) ? option(selectedEnv, `${selectedEnv} (unavailable)`, selectedEnv) : ""}</select>`,
    environments.find((item) => item.id === selectedEnv)?.label ??
      (selectedEnv ? `${selectedEnv} (unavailable)` : "No environment"),
  );
  const directory = `<label id="cwd-choice"><span class="selector-label">Working directory</span><input name="cwd" id="cwd" aria-label="Working directory" value="${escape(agent?.cwd ?? app.cwd)}" placeholder="/workspace"${conversation ? ` data-on:change="el.form.requestSubmit()" data-on:keydown="if (evt.key === 'Enter') { evt.preventDefault(); el.blur() }"` : ""}></label>`;
  const model = picker(
    "model",
    "Model",
    `<select name="model" id="model" aria-label="Model" required data-on:change="${updateLabel}; ${conversation ? "el.form.requestSubmit()" : `@post(${js(`${prefix}/thinking`)}, {contentType: 'form', retry: 'never'})`}">${selectedModel ? "" : '<option value="" selected disabled>No model</option>'}${models.map((model) => option(modelKey(model), model.id, selectedModel)).join("")}</select>`,
    models.find((model) => modelKey(model) === selectedModel)?.id ?? "No model",
  );
  return {
    environment,
    directory,
    model,
    thinking: thinking(app, selectedModel, agent?.thinkingLevel ?? "off", !!conversation),
    available: models.length > 0,
  };
}

export async function configuration(app: Application, conversation: Conversation, prefix: string) {
  const fields = await selections(app, prefix, conversation);
  const base = conversationPath(prefix, app.id, conversation.id);
  const control = (name: "environment" | "cwd" | "model" | "thinking", html: string) =>
    `<form id="configuration-${name}" method="post" action="${escape(base)}/configure" class="selector-summary" data-on:submit="@post(${js(`${base}/configure`)}, {contentType: 'form', retry: 'never'})">${html}<noscript><button>Save</button></noscript></form>`;
  return {
    environment: control("environment", fields.environment),
    cwd: control("cwd", fields.directory),
    model: control("model", fields.model),
    thinking: control("thinking", fields.thinking),
  };
}

function composer(
  creation: boolean,
  available = true,
  label = creation ? "Create session" : "Send",
): string {
  return `<div id="composer-shell" class="composer-shell"><div class="compose-box">
    <textarea data-on:input="$_hasInput = !!el.value.trim()" id="message" name="message" rows="${creation ? 2 : 1}" aria-label="Message" placeholder="Ask Pi…" title="/compact [instructions] · /new · /cd &lt;path&gt; · Ctrl/⌘+Enter to send" data-on:keydown="if ((evt.ctrlKey || evt.metaKey) &amp;&amp; evt.key === 'Enter') { evt.preventDefault(); el.form.requestSubmit() }"></textarea>
    <div id="previews" aria-label="Attached files"></div><template id="attachment-preview"><button type="button"><img hidden><span></span></button></template>
    <div id="controls" class="actions"><input data-on:change="$_hasFiles = !!el.files.length" id="attachments" class="sr-only" type="file" name="attachments" aria-label="Attachments (images or UTF-8 text)" multiple><label id="input-toggle" class="icon" for="attachments" title="Upload images or UTF-8 text">+</label>
    <span class="spacer"></span><span id="run-controls"></span><button id="${creation ? "create" : "send"}" class="icon" ${creation ? "" : 'data-attr:disabled="!$_hasInput &amp;&amp; !$_hasFiles"'} aria-label="${escape(label)}" title="${escape(label)} (Ctrl/Cmd+Enter)"${available ? "" : " disabled"}>${icon("send")}</button></div></div>
    ${available ? "" : '<p class="error">No models available.</p>'}</div>`;
}

async function creationForm(app: Menu, prefix: string, id?: string) {
  const fields = await selections(app, prefix);
  const action = `${prefix}/`;
  return `<footer id="app-footer" class="composer-area"><form id="composer" data-on:reset="$_hasInput = false; $_hasFiles = false" method="post" action="${escape(action)}" class="new-composer" enctype="multipart/form-data" data-indicator:_sending data-on:submit="@post(${js(action)}, {contentType: 'form', retry: 'never'})">${id === undefined ? "" : `<input type="hidden" name="sessionId" value="${escape(id)}">`}<fieldset id="new-options" aria-label="New conversation options" data-attr:disabled="$_sending"><div id="footer-instance" class="selector-summary">${fields.environment}${fields.directory}</div>
    <div id="bottom-line"><div class="footer-row"><div class="footer-model-context"><div id="footer-model" class="model-summary selector-summary"><span class="model-name">${fields.model}</span>${dot}<span class="model-effort">${fields.thinking}</span></div></div></div></div>
    ${composer(true, fields.available, id === undefined ? "Create session" : "Create conversation")}</fieldset></form></footer>`;
}

export async function sessionList(app: Sessions, prefix: string) {
  const records = await app.list();
  return `<section id="session-list" aria-label="Sessions">${records.map((record) => `<div class="session-row" data-session-id="${escape(record.id)}" data-status="${record.status}"><a class="session" href="${escape(sessionPath(prefix, record.id))}">${escape(record.id)}</a><span>${record.status === "open" ? "Open" : "Unavailable"}</span><form method="post" action="${escape(prefix)}/api/s/open"><input type="hidden" name="sessionId" value="${escape(record.id)}"><button>Reopen session</button></form></div>`).join("")}${records.length ? "" : '<p id="sessions-empty">No sessions</p>'}</section>`;
}

export async function home(app: Sessions, prefix: string): Promise<string> {
  return page(
    "Sessions",
    `<header id="app-header">${alert()}</header><main id="main-area"><section id="landing" class="pane" aria-label="Sessions">${await sessionList(app, prefix)}<form id="open-session" method="post" action="${escape(prefix)}/api/s/open"><label>Session ID <input name="sessionId" maxlength="128" required></label><button>Open session</button></form><form method="post" action="${escape(prefix)}/api/s/open"><button>New empty session</button></form><a href="${escape(prefix)}/api/models">Models</a></section></main>${await creationForm(app, prefix)}`,
    "home",
    prefix,
  );
}

export async function sessionPage(app: Application, prefix: string): Promise<string> {
  const base = sessionPath(prefix, app.id);
  const records = await app.list();
  const rows = await Promise.all(
    records.map(async (record) => {
      const agent = await app.harness.snapshot(AgentDoc, record.id, context);
      const env = await app.harness.snapshot(Env, record.id, context);
      return `<div class="session-row" data-conversation-id="${record.id}"><a class="session" href="${escape(conversationPath(prefix, app.id, record.id))}" aria-label="${escape(record.title)}"><span class="session-heading"><strong>${escape(record.title)}</strong></span><span class="session-detail"><span class="session-environment">${escape(environmentId(env?.env) || "No environment")}:${escape(agent?.cwd ?? "")}</span><span class="model-summary"><span class="model-name">${escape(agent?.model ? `${agent.model.provider}/${agent.model.modelId}` : "")}</span></span></span></a></div>`;
    }),
  );
  return page(
    `Session ${app.id}`,
    `<header id="app-header"><div class="bar"><a href="${escape(prefix)}/">Sessions</a><h1 class="header-title" title="${escape(app.id)}">${escape(app.id)}</h1></div>${alert()}</header><main id="main-area"><section id="landing" class="pane" aria-label="Conversations"><div id="session-list">${rows.join("")}</div><form method="post" action="${escape(base)}/root"><button>Open root conversation</button></form><form method="post" action="${escape(base)}/createConversation"><button>New empty conversation</button></form></section></main>${await creationForm(app, prefix, app.id)}`,
    "home",
    prefix,
  );
}

export async function modelsPage(app: Pick<Application, "models">, prefix: string) {
  const models = await app.models.getAvailable();
  const rows = models.map((model) => {
    const values = {
      id: model.id,
      provider: model.provider,
      name: model.name,
      input: model.input.join(", "),
      reasoning: model.reasoning,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      cost: JSON.stringify({
        input: model.cost.input,
        output: model.cost.output,
        cacheRead: model.cost.cacheRead,
        cacheWrite: model.cost.cacheWrite,
      }),
      thinkingLevels: getSupportedThinkingLevels(model).join(", "),
    };
    return `<article data-model-id="${escape(model.id)}" data-provider="${escape(model.provider)}"><dl>${Object.entries(
      values,
    )
      .map(([name, value]) => `<dt>${name}</dt><dd data-field="${name}">${escape(value)}</dd>`)
      .join("")}</dl></article>`;
  });
  return page(
    "Models",
    `<header id="app-header"><div class="bar"><a href="${escape(prefix)}/">Sessions</a><h1>Models</h1></div></header><main id="main-area"><section id="models" class="pane" tabindex="0" aria-label="Available models">${rows.join("")}</section></main>`,
    "home",
    prefix,
  );
}

export async function conversationPage(
  app: Application,
  conversation: Conversation,
  initial: { view: ConversationView; head: EntryRecord | null },
  prefix: string,
): Promise<string> {
  const controls = await configuration(app, conversation, prefix);
  const base = conversationPath(prefix, app.id, conversation.id);
  return page(
    `Conversation ${conversation.id}`,
    `<header id="app-header"><div class="bar"><h1><a id="conversation-title" class="header-title" href="${escape(sessionPath(prefix, app.id))}" aria-label="Conversations">Conversation ${conversation.id}</a></h1></div>${alert()}<form id="abort-command" method="post" action="${escape(base)}/abort" data-on:submit="@post(${js(`${base}/abort`)}, {contentType: 'form', retry: 'never'})"></form><div id="admission" hidden></div><div id="connection" role="status">Connecting…</div><div id="activity" role="status"></div><div id="status" class="sr-only" role="status"></div></header>
    <main id="main-area"><section id="stream" class="pane" tabindex="0" aria-label="Conversation" data-init="@get(${js(`${base}/watch`)}, {requestCancellation: 'cleanup', retry: 'always'})">${baseline(initial.view, initial.head, base, true)}</section></main><div id="queue"></div>
    <footer id="app-footer" class="composer-area"><div id="conversation-navigation" role="group" aria-label="Conversation navigation"><button id="latest" type="button" aria-label="Latest" title="Latest">${icon("latest")}</button><button id="last" type="button" data-on:click="Array.from(document.querySelectorAll('#stream article[data-role=user]')).at(-1)?.scrollIntoView({block: 'start'})" aria-label="Last user message" title="Last user message">${icon("up")}</button><button id="top" type="button" data-on:click="document.getElementById('stream').scrollTop = 0" aria-label="Top" title="Top">${icon("top")}</button></div>
    <form id="composer" data-on:reset="$_hasInput = false; $_hasFiles = false" method="post" action="${escape(base)}/composer" enctype="multipart/form-data" data-indicator:_sending data-on:submit="@post(${js(`${base}/composer`)}, {contentType: 'form', retry: 'never'})"><fieldset class="composer-fields" data-attr:disabled="$_sending">${composer(false)}</fieldset></form><div id="session-meta"><div id="bottom-line"><div class="footer-row"><a id="footer-sessions" class="icon footer-chevron" href="${escape(sessionPath(prefix, app.id))}" aria-label="Conversations" title="Conversations">${icon("back")}</a>
    <div id="footer-instance">${controls.environment}<span>:</span>${controls.cwd}</div><div id="footer-stats"></div>
    <div class="footer-model-context"><div id="footer-model" class="model-summary">${controls.model}${dot}${controls.thinking}</div>${dot}<span id="footer-context" class="context-usage"></span></div>
    <button id="footer-collapse" class="icon footer-chevron" type="button" aria-label="Collapse composer" aria-expanded="true" aria-controls="composer-shell" data-on:click="el.setAttribute('aria-expanded', el.getAttribute('aria-expanded') === 'true' ? 'false' : 'true')">${icon("down")}</button></div></div></div></footer>`,
    "conversation",
    prefix,
  );
}

type Tools = Map<string, { state: string; output: string; call?: ToolCall }>;
function toolStatus(state: string): string {
  return `<span class="tool-status" data-state="${state}" role="img" aria-label="${state}">${state === "running" ? "<span></span><span></span><span></span><span></span>" : state === "failed" ? "×" : state === "completed" ? "✓" : "·"}</span>`;
}

function content(message: Message, tools: Tools = new Map()): string {
  if (typeof message.content === "string") return markdown.render(message.content);
  return message.content
    .map((part) => {
      switch (part.type) {
        case "text":
          return markdown.render(part.text);
        case "thinking":
          return `<div class="thinking">${escape(part.thinking)}</div>`;
        case "image":
          return ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(part.mimeType)
            ? `<img class="transcript-image" alt="Attached image" src="data:${escape(part.mimeType)};base64,${escape(part.data)}">`
            : "<p>Unsupported image format</p>";
        case "toolCall":
          return tool(part, tools.get(part.id));
      }
    })
    .join("");
}

function tool(call: ToolCall, state?: { state: string; output: string }): string {
  const command = call.arguments.command ?? call.arguments.path ?? JSON.stringify(call.arguments);
  return `<details id="call-${escape(call.id)}" class="tool-call" data-preserve-attr="open" data-state="${state?.state ?? "recorded"}"><summary>${toolStatus(state?.state ?? "recorded")}<span class="tool-command">${escape(call.name)} ${escape(command)}</span></summary><div class="tool-result"><pre><code>${escape(state?.output || JSON.stringify(call.arguments, null, 2))}</code></pre></div></details>`;
}

function messageHeader(message: Message): string {
  const timestamp = new Date(message.timestamp);
  return `<header><span class="speaker">${message.role === "user" ? "You" : message.role === "assistant" ? "Pi" : escape(message.role)}</span><time class="message-time" datetime="${timestamp.toISOString()}" title="${escape(timestamp.toLocaleString())}">${escape(timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }))}</time></header>`;
}

function tools(
  view: Pick<ConversationView, "entries" | "docs">,
  previous = new Map<string, ToolCall>(),
): Tools {
  const live = (view.docs[LiveDoc.definition.kind] ?? {}) as LiveState;
  const result: Tools = new Map(
    (live.tools ?? []).map((tool) => [
      tool.callId,
      {
        state: tool.status === "done" ? "completed" : "running",
        output: tool.output ?? "",
      },
    ]),
  );
  for (const entry of view.entries)
    for (const message of entry.model ?? []) {
      if (message.role === "toolResult")
        result.set(message.toolCallId, {
          state: message.isError ? "failed" : "completed",
          output: message.content
            .map((part) => (part.type === "text" ? part.text : "[image]"))
            .join("\n"),
        });
    }
  for (const [id, call] of calls(view, previous, false)) {
    result.set(id, { ...(result.get(id) ?? { state: "recorded", output: "" }), call });
  }
  return result;
}

function calls(
  view: Pick<ConversationView, "entries" | "docs">,
  previous = new Map<string, ToolCall>(),
  prune = true,
): Map<string, ToolCall> {
  const live = (view.docs[LiveDoc.definition.kind] ?? {}) as LiveState;
  const active = new Set(live.tools?.map((slot) => slot.callId));
  const result = new Map([...previous].filter(([id]) => !prune || active.has(id)));
  for (const record of view.entries)
    for (const message of record.model ?? []) {
      if (message.role !== "assistant") continue;
      for (const part of message.content) if (part.type === "toolCall") result.set(part.id, part);
    }
  return result;
}

function entry(record: EntryRecord, states: Tools): string {
  if (record.kind === "pi.compaction" || record.head !== undefined)
    return `<article id="entry-${record.id}" data-kind="${escape(record.kind)}"><details class="tool-call context-event" data-preserve-attr="open"><summary>${toolStatus("completed")}<span class="tool-command">${record.kind === "pi.compaction" ? "Compaction summary" : "Context boundary"}</span></summary><div class="compaction-summary">${(record.model ?? []).map((message) => content(message)).join("")}</div></details></article>`;
  const orphan = (record.model ?? []).find(
    (message) => message.role === "toolResult" && !states.get(message.toolCallId)?.call,
  );
  if (orphan?.role === "toolResult")
    return `<article id="entry-${record.id}" data-role="toolResult"><details class="tool-call" data-preserve-attr="open"><summary>${toolStatus(orphan.isError ? "failed" : "completed")}<span class="tool-command">${escape(orphan.toolName)} result</span></summary><pre><code>${escape(states.get(orphan.toolCallId)?.output ?? "")}</code></pre></details></article>`;
  const messages = (record.model ?? []).filter(
    (message) => message.role !== "system" && message.role !== "toolResult",
  );
  return `<article id="entry-${record.id}" data-kind="${escape(record.kind)}"${messages[0] ? ` data-role="${messages[0].role}"` : " hidden"}>${messages.map((message) => `${messageHeader(message)}<div class="markdown">${content(message, states)}${message.role === "assistant" && message.errorMessage ? `<p class="error">${escape(message.errorMessage)}</p>` : ""}</div>`).join("")}</article>`;
}

function history(address: string, before: number, after?: number): string {
  const id = `history-${after ?? "start"}-${before}`;
  const url = `${address}/entries?before=${before}${after === undefined ? "" : `&after=${after}`}`;
  return `<section id="${id}"><a href="${escape(url)}" data-on:click__prevent="@get(${js(url)}, {retry: 'never'})">${after === undefined ? "Earlier messages" : "Load missing messages"}</a></section>`;
}

function baseline(
  view: ConversationView,
  head: EntryRecord | null,
  address: string,
  initial = false,
): string {
  const states = tools(view);
  const archived = head
    ? view.entries.filter((record) => record.id < head.head! && record.id !== head.id)
    : [];
  const older = view.before === undefined ? "" : history(address, view.entries[0]!.id);
  const entries = view.entries.filter(
    (record) => !head || (record.id >= head.head! && record.id !== head.id),
  );
  return `<div id="conversation"><div id="transcript">${head ? `${entry(head, states)}<details id="context-history" class="context-history" data-preserve-attr="open"><summary>Earlier messages</summary>${older}${archived.map((record) => entry(record, states)).join("")}</details>` : older}<div id="entries">${entries.map((record) => entry(record, states)).join("")}</div>${initial ? live(view) : '<div id="live-response"></div>'}<div id="failures"></div></div></div>`;
}

function live(view: ConversationView): string {
  const state = (view.docs[LiveDoc.definition.kind] ?? {}) as LiveState;
  const message = state.generation?.message;
  return `<div id="live-response">${message ? `<article id="partial" data-role="assistant" aria-label="Streaming response">${messageHeader(message)}<div class="markdown">${content(message)}</div></article>` : ""}</div>`;
}

function status(view: ConversationView): string {
  const live = (view.docs[LiveDoc.definition.kind] ?? {}) as LiveState;
  const state = live.compactions?.length ? "compacting" : live.run ? "working" : "idle";
  return `<div id="status" class="sr-only" role="status" data-state="${state}">${state}</div>
    <div id="activity" role="status">${live.compactions?.length ? "Compacting…" : live.generation?.retry ? `Retrying: ${escape(live.generation.retry.error)}` : ""}</div>
    <div id="run-controls">${live.run || live.compactions?.length ? `<button id="stop" class="icon" type="submit" form="abort-command" aria-label="Stop" title="Stop">${icon("close")}</button>` : ""}</div>
    <div id="failures">${live.runFailure ? `<p class="error" role="alert">${escape(live.runFailure.reason)}: ${escape(live.runFailure.detail ?? "")}</p>` : ""}${live.compactionFailure ? `<p class="error" role="alert">Compaction failed: ${escape(live.compactionFailure.error)}</p>` : ""}</div>`;
}

function queue(view: ConversationView): string {
  const inbox = (view.docs[InboxDoc.definition.kind] ?? { items: [] }) as InboxState;
  return `<div id="queue">${inbox.items.length ? `<div class="queued-messages">${inbox.items.map((item) => `<article id="queued-${item.id}" data-role="user"><header><span class="speaker">Queued ${escape(item.mode)}</span></header>${"content" in item ? content({ role: "user", content: item.content, timestamp: 0 }) : "Context update"}</article>`).join("")}</div>` : ""}</div>`;
}

function toolUpdates(
  view: ConversationView,
  previous?: Map<string, ToolCall>,
): Map<string, string> {
  const updates = new Map<string, string>();
  for (const [id, state] of tools(view, previous))
    if (state.call) updates.set(id, tool(state.call, state));
  return updates;
}

export const regions = { baseline, entry, tools, calls, live, status, queue, toolUpdates, history };

export async function metadata(
  app: Application,
  conversation: Conversation,
  view?: ConversationView,
): Promise<string> {
  const agent = await conversation.agent(context);
  const usage =
    (view?.docs[UsageDoc.definition.kind] as UsageState | undefined) ??
    (await app.harness.snapshot(UsageDoc, conversation.id, context));
  const total = Object.values(usage?.models ?? {}).reduce(
    (sum, item) => ({
      input: sum.input + item.input,
      output: sum.output + item.output,
      read: sum.read + item.cacheRead,
      write: sum.write + item.cacheWrite,
      cost: sum.cost + item.cost.total,
    }),
    { input: 0, output: 0, read: 0, write: 0, cost: 0 },
  );
  const format = (value: number) =>
    value >= 1000 ? `${Number((value / 1000).toFixed(1))}k` : String(value);
  const last = view?.entries
    .flatMap((entry) => entry.model ?? [])
    .findLast((message) => message.role === "assistant");
  const model = agent.model && app.models.getModel(agent.model.provider, agent.model.modelId);
  const window = model?.contextWindow;
  const tokens = last?.role === "assistant" ? last.usage.totalTokens : undefined;
  const requestSize = window
    ? `${tokens === undefined ? "—" : `${((100 * tokens) / window).toFixed(1)}%`} / ${format(window)}`
    : "—";
  const cacheInput = total.input + total.read + total.write;
  const hit = cacheInput ? `CH${((100 * total.read) / cacheInput).toFixed(1)}%` : "CH—";
  return `<div id="footer-stats"><span>↑${format(total.input)}</span><span>↓${format(total.output)}</span><span>R${format(total.read)}</span><span>${hit}</span><span>$${total.cost.toFixed(3)}</span></div>
    <span id="footer-context" class="context-usage" title="Last model request / selected model context window">${requestSize}</span>`;
}
