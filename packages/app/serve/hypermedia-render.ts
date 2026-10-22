import type { Message } from "@earendil-works/pi-ai";
import type { EntryRecord, LiveState, ToolSlot, NestedToolSlot } from "@earendil-works/pi-durable";
import type { ContextInspection, ContextPart } from "./inspection.ts";

export function escapeHTML(value: string | number | boolean | null | undefined): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );
}
const e = escapeHTML;
export const hidden = (name: string, value: string) =>
  `<input type="hidden" name="${e(name)}" value="${e(value)}">`;
export const link = (url: string, text: string, attributes = "") =>
  `<a href="${e(url)}" ${attributes}>${e(text)}</a>`;
export const action = (url: string, text: string, command = "", fields = "") =>
  `<form method="post" action="${e(url)}"${command ? ` data-command="${e(command)}"` : ""}>${fields}<button>${e(text)}</button></form>`;
export function icon(name: "settings" | "close" | "copy" | "quote" | "fork"): string {
  const paths = {
    settings:
      '<path d="m9 3-.6 2.4-1.5.9-2.4-.7-3 5.2L3.3 12l.1 1.8-1.7 1.8 3 5.2 2.3-.7 1.6.9.5 2.4h6l.6-2.4 1.5-.9 2.4.7 3-5.2-1.8-1.2-.1-1.8 1.7-1.8-3-5.2-2.3.7-1.6-.9L15 3Z" transform="translate(1 -1) scale(.92)"/><circle cx="12" cy="12" r="3.2"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>',
    quote: '<path d="M5 6h5v6H5zM14 6h5v6h-5zM10 12c0 4-2 6-5 6m14-6c0 4-2 6-5 6"/>',
    fork: '<circle cx="6" cy="5" r="2"/><circle cx="18" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10m12-10v2c0 4-12 2-12 6"/>',
  };
  return `<svg class="glyph" aria-hidden="true" viewBox="0 0 24 24">${paths[name]}</svg>`;
}
function copyButton(key: string, label: string): string {
  return `<button type="button" class="enhanced-only" data-copy="${key}" aria-label="${label}" title="${label}">${icon("copy")}</button>`;
}
function quoteButton(key = "", label = "Quote"): string {
  return `<button type="button" class="enhanced-only" data-quote="${key}" aria-label="${label}" title="${label}">${icon("quote")}</button>`;
}
function forkAction(path: string, at: number): string {
  return `<form method="post" action="${path}/fork">${hidden("at", String(at))}<button aria-label="Fork here" title="Fork here">${icon("fork")}</button></form>`;
}
export const code = (text: string, language = "") =>
  `<pre><code data-language="${e(language)}">${e(text)}</code></pre>`;
function inline(text: string): string {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g;
  let offset = 0,
    html = "";
  for (const match of text.matchAll(pattern)) {
    html += e(text.slice(offset, match.index));
    const value = match[0];
    if (value.startsWith("[")) {
      const split = value.indexOf("](");
      html += `<a href="${e(value.slice(split + 2, -1))}" target="_blank" rel="noopener noreferrer">${e(value.slice(1, split))}</a>`;
    } else
      html += value.startsWith("`")
        ? `<code>${e(value.slice(1, -1))}</code>`
        : `<strong>${e(value.slice(2, -2))}</strong>`;
    offset = match.index + value.length;
  }
  return html + e(text.slice(offset));
}
export function markdown(text: string): string {
  const parts = text.split(/^```([^\n]*)\n([\s\S]*?)(?:^```\s*$|(?![\s\S]))/gm);
  let html = "";
  for (let i = 0; i < parts.length; i += 3) {
    for (const paragraph of parts[i].split(/\n\n+/).filter(Boolean)) {
      const heading = /^(#{1,4}) (.*)$/.exec(paragraph);
      const tag = heading ? `h${heading[1].length + 1}` : "p";
      html += `<${tag}>${inline(heading ? heading[2] : paragraph)}</${tag}>`;
    }
    if (parts[i + 1] !== undefined) html += code(parts[i + 2], parts[i + 1].trim().split(/\s/)[0]);
  }
  return `<div class="text" hx-ignore>${html}</div>`;
}
export function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((part) =>
      part.type === "text"
        ? part.text
        : part.type === "thinking"
          ? part.thinking
          : part.type === "toolCall"
            ? `${part.name}\n${JSON.stringify(part.arguments, null, 2)}`
            : "[image]",
    )
    .join("\n\n");
}
export type Call = { id: string; name: string; arguments: Record<string, unknown> };
export type Result = { entry: number; message: Extract<Message, { role: "toolResult" }> };
export const toolID = (id: string) => `tool-${Buffer.from(id).toString("base64url")}`;
function details(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const patch =
    "patch" in data && typeof data.patch === "string"
      ? data.patch
      : "diff" in data && typeof data.diff === "string"
        ? data.diff
        : undefined;
  return `<details${patch ? " open" : ""}><summary>${patch ? "Changes" : "Details"}</summary>${code(patch ?? JSON.stringify(data, null, 2), patch ? "diff" : "json")}</details>`;
}
export function tool(
  call: Call,
  result?: Result,
  slot?: ToolSlot | NestedToolSlot,
  busy = false,
  path = "",
): string {
  const name = call.name.split(".").at(-1)!;
  const args = call.arguments;
  const input =
    name === "bash" && typeof args.command === "string"
      ? args.command
      : name === "write" && typeof args.content === "string"
        ? args.content
        : JSON.stringify(args, null, 2);
  let inputText = input;
  if (name === "edit") {
    const edits: unknown[] = Array.isArray(args.edits) ? args.edits : [args];
    const replacements: string[] = [];
    for (const edit of edits) {
      if (
        !edit ||
        typeof edit !== "object" ||
        !("oldText" in edit) ||
        typeof edit.oldText !== "string" ||
        !("newText" in edit) ||
        typeof edit.newText !== "string"
      )
        break;
      replacements.push(
        `@@ Requested replacement @@\n${edit.oldText
          .split("\n")
          .map((line) => `-${line}`)
          .join("\n")}\n${edit.newText
          .split("\n")
          .map((line) => `+${line}`)
          .join("\n")}`,
      );
    }
    if (replacements.length === edits.length) {
      inputText = replacements.join("\n");
    }
  }
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
  const nested = slot && "summary" in slot ? slot.summary : undefined;
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
        : (slot?.status ?? (busy ? "pending" : "unavailable"));
  const output = result ? messageText(result.message) : (slot?.output ?? "");
  const duration = result?.message.durationMs ?? nested?.durationMs;
  const metadata = result?.message.details ?? slot?.details;
  const patch =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? "patch" in metadata && typeof metadata.patch === "string"
        ? metadata.patch
        : "diff" in metadata && typeof metadata.diff === "string"
          ? metadata.diff
          : undefined
      : undefined;
  return `<details id="${toolID(call.id)}" class="tool-call" data-call-id="${e(call.id)}" data-tool="${e(call.name)}" data-disclosure="${toolID(call.id)}" data-state="${state}"${state === "failed" ? " open" : ""}><summary><span class="tool-status" data-state="${state}" role="img" aria-label="${state}">${state === "running" ? [0, 1, 2, 3].map((index) => `<span aria-hidden="true" style="animation-delay:-${index * 225}ms"></span>`).join("") : (({ completed: "✓", failed: "✕", pending: "◷", cancelled: "⊘" } as Record<string, string>)[state] ?? "?")}</span><span class="tool-command" hx-ignore>${e(command)}</span>${duration === undefined ? "" : `<span class="tool-duration" title="${duration}ms">${duration < 1000 ? `${Math.round(duration)}ms` : `${(duration / 1000).toFixed(1)}s`}</span>`}</summary><div class="tool-result">${result ? result.message.content.map((part) => (part.type === "text" ? code(part.text) : part.type === "image" ? image(part.mimeType, part.data) : "")).join("") : output ? code(output) : ""}${slot?.droppedBytes || slot?.droppedLines ? `<p class="notice">Output truncated: ${slot.droppedBytes ?? 0} bytes / ${slot.droppedLines ?? 0} lines omitted.</p>` : ""}${slot?.diagnostics?.length ? `<details><summary>Diagnostics</summary>${code(JSON.stringify(slot.diagnostics, null, 2), "json")}</details>` : ""}${nested?.error ? `<p class="error" hx-ignore>${e(nested.error)}</p>` : ""}${details(metadata)}${result && !result.message.isError && name === "write" ? `<details><summary>Written content</summary>${code(input)}</details>` : ""}</div><details class="entry-actions tool-actions"><summary class="icon message-actions" aria-label="Tool actions">···</summary><div class="action-menu">${copyButton("input", "Copy input")}${copyButton("output", "Copy output")}${result ? quoteButton("output", "Quote output") : ""}${patch === undefined ? "" : copyButton("changes", "Copy changes")}${metadata ? copyButton("details", "Copy details") : ""}${result && path ? forkAction(path, result.entry) : ""}</div></details><textarea hidden data-copy-source="input">${e(inputText)}</textarea><textarea hidden data-copy-source="output">${e(output)}</textarea><textarea hidden data-copy-source="changes">${e(patch)}</textarea><textarea hidden data-copy-source="details">${e(JSON.stringify(metadata, null, 2))}</textarea></details>`;
}
function image(mime: string, data: string): string {
  return /^image\/(png|jpeg|gif|webp)$/.test(mime) && /^[A-Za-z0-9+/=\s]*$/.test(data)
    ? `<img class="transcript-image" alt="Attachment" src="data:${mime};base64,${data}">`
    : "[attachment]";
}
export function message(
  message: Message,
  renderTool?: (call: Call) => string,
  wrap = true,
  showHeader = true,
): string {
  if (message.role === "system") return "";
  const date = new Date(message.timestamp);
  const time = Number.isFinite(date.getTime()) ? date.toISOString() : "";
  const content =
    typeof message.content === "string"
      ? markdown(message.content)
      : message.content
          .map((part) => {
            if (part.type === "text")
              return message.role === "toolResult" ? code(part.text) : markdown(part.text);
            if (part.type === "thinking")
              return `<div class="thinking" hx-ignore>${e(part.thinking || "Thinking…")}</div>`;
            if (part.type === "toolCall") return renderTool ? renderTool(part) : tool(part);
            if (part.type === "image") return image(part.mimeType, part.data);
            return "";
          })
          .join("");
  const html = `${showHeader ? `<header><span class="speaker">${message.role === "assistant" ? "Pi" : message.role === "user" ? "You" : message.toolName}</span><time class="message-time" datetime="${time}">${e(time)}</time></header>` : ""}${content}${message.role === "assistant" && message.errorMessage ? `<p class="error" hx-ignore>${e(message.errorMessage)}</p>` : ""}`;
  return wrap ? `<article data-role="${message.role}">${html}</article>` : html;
}
export function entry(
  record: EntryRecord,
  path = "",
  calls = new Map<string, Call>(),
  results = new Map<string, Result>(),
  live?: LiveState,
): string {
  const boundary = record.kind === "pi.reset" || record.kind === "pi.compaction";
  const messages =
    record.model?.filter(
      (message) =>
        message.role !== "system" &&
        !(message.role === "toolResult" && calls.has(message.toolCallId)),
    ) ?? [];
  const rendered = messages
    .map((item) =>
      message(
        item,
        (call) =>
          tool(
            call,
            results.get(call.id),
            live?.tools?.find((slot) => slot.callId === call.id),
            !!live?.run,
            path,
          ),
        false,
        record.kind !== "pi.compaction",
      ),
    )
    .join("");
  const text = messages.map(messageText).join("\n\n");
  const actions =
    path && !boundary && messages.length
      ? `<details class="entry-actions"><summary class="icon message-actions" aria-label="Message actions">···</summary><div class="action-menu">${copyButton("message", "Copy message")}${quoteButton()}${forkAction(path, record.id)}</div></details><textarea hidden data-copy-source="message">${e(text)}</textarea>`
      : "";
  const html = boundary
    ? `<details class="tool-call context-event" data-state="completed" data-disclosure="context-${record.id}"><summary><span class="tool-status" data-state="completed" aria-label="Completed">✓</span><span class="tool-command">${record.kind === "pi.reset" ? "Context reset" : "Context compacted"}</span><span id="duration-${record.id}" class="tool-duration"></span></summary>${record.kind === "pi.compaction" ? `<div class="compaction-summary">${rendered}</div>` : ""}<div id="archive-${record.id}" class="context-history"></div></details>${record.kind === "pi.reset" ? rendered : ""}`
    : rendered;
  return `<article id="entry-${record.id}" data-entry="${record.id}"${!boundary && messages[0] ? ` data-role="${messages[0].role}"` : ""}${boundary ? ` data-context="${record.kind}"` : ""}${!html && !actions ? " hidden" : ""}>${html}${actions}</article>`;
}
export function compactTokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}M`;
}
export function contextHTML(data: ContextInspection): string {
  if (data.state === "unavailable")
    return '<section id="context-view" class="pane"><span class="ctx-state">Context unavailable</span></section>';
  const count = (n: number) =>
    n < 1000 ? String(n) : `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  const span = (className: string, text = "") => `<span class="${className}">${e(text)}</span>`;
  const position = (n: number) =>
    data.window ? Math.max(0, Math.min(100, (n / data.window) * 100)) : 0;
  const fields = (parts: ContextPart[], nested = false): string =>
    `<ol class="ctx-fields${nested ? " ctx-files" : ""}">${parts.map((part) => `<li><div class="ctx-field"><span class="ctx-field-main">${span(nested ? "ctx-field-value" : "ctx-field-name", part.name)}${part.value === undefined ? "" : span("ctx-field-value", part.value)}</span>${span("ctx-tokens", count(part.tokens))}</div>${part.children?.length ? fields(part.children, true) : ""}</li>`).join("")}</ol>`;
  const threshold = (data.policy.backgroundTokens > 0 ? data.backgroundAt : data.blockingAt) ?? 0;
  const window =
    data.window === null
      ? ""
      : `<div class="ctx-window" role="img" aria-label="Estimated context: ${data.tokens.toLocaleString()} of ${data.window.toLocaleString()} tokens."><div class="ctx-track">${data.roles.map((role) => `<span class="ctx-segment" data-role="${role.role}" style="width:${position(role.tokens)}%"></span>`).join("")}</div>${data.policy.enabled ? `<span class="ctx-threshold" style="left:${position(threshold)}%"></span><span class="ctx-reserved" style="width:${position(data.policy.reserveTokens)}%"></span>` : ""}</div>${data.policy.enabled ? `<div class="ctx-ruler" aria-hidden="true"><span class="ctx-auto" style="left:${position(threshold)}%">~${compactTokens(threshold)}</span></div><div class="ctx-reserve-caption">${span("ctx-reserve-key")}${count(data.policy.reserveTokens)} reserved</div>` : ""}`;
  const messages = data.messages
    .map(
      (message, index) =>
        `<li class="ctx-message" data-order="${index}" data-role="${message.role}" data-tokens="${message.tokens}"${message.source ? ` data-entry="${message.source.entry}" data-kind="${e(message.source.kind)}"` : ""}><div class="ctx-message-heading">${span("ctx-swatch")}<span class="ctx-heading-main">${span("ctx-role", message.role)}${message.source?.kind === "pi.compaction" || message.source?.kind === "pi.reset" ? span("ctx-provenance", message.source.kind) : ""}${message.toolName === undefined ? "" : span("ctx-tool-name", message.toolName)}</span>${span("ctx-tokens", count(message.tokens))}</div>${message.role === "toolResult" && message.parts.length === 1 && message.parts[0].name === "text" ? "" : fields(message.parts)}</li>`,
    )
    .join("");
  return `<section id="context-view" class="pane" data-conversation="${data.conversation}" data-tail="${data.tail ?? ""}" data-tokens="${data.tokens}" hx-ignore><section aria-label="Context usage"><div class="ctx-usage"><span class="ctx-big">~${count(data.tokens)} ${span("", `/ ${data.window === null ? "?" : count(data.window)}`)}</span><div class="ctx-capacity">${span("ctx-percent", data.fraction === null ? "—" : `${(data.fraction * 100).toFixed(1)}%`)}${span("ctx-remaining", data.remaining === null ? "" : `${count(data.remaining)} remaining`)}</div></div>${window}<ul class="ctx-legend" aria-label="Message roles">${data.roles.map((role) => `<li data-role="${role.role}">${span("ctx-swatch")}${span("", role.role)}${span("ctx-tokens", count(role.tokens))}</li>`).join("")}</ul></section><section class="ctx-inventory" aria-label="Context messages in provider order"><ol class="ctx-messages">${messages}</ol>${messages ? "" : span("ctx-state", "No context")}</section></section>`;
}
