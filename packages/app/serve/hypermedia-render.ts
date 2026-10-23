import { html as h, raw, type SafeHtml } from "./html.ts";
import type { Message } from "@earendil-works/pi-ai";
import type { EntryRecord, LiveState, ToolSlot, NestedToolSlot } from "@earendil-works/pi-durable";
import type { ContextInspection, ContextPart } from "./inspection.ts";

export const hidden = (name: string, value: string) =>
  h`<input type="hidden" name="${name}" value="${value}">`;
export const link = (url: string, text: string, attributes = h``) =>
  h`<a href="${url}" ${attributes}>${text}</a>`;
export const action = (
  url: string,
  text: string | SafeHtml,
  command = "",
  fields = h``,
  buttonAttributes = h``,
) =>
  h`<form method="post" action="${url}"${command ? h` data-command="${command}"` : ""}>${fields}<button${buttonAttributes}>${text}</button></form>`;
export function icon(name: "settings" | "close" | "send"): SafeHtml {
  const paths = {
    settings:
      '<path d="m9 3-.6 2.4-1.5.9-2.4-.7-3 5.2L3.3 12l.1 1.8-1.7 1.8 3 5.2 2.3-.7 1.6.9.5 2.4h6l.6-2.4 1.5-.9 2.4.7 3-5.2-1.8-1.2-.1-1.8 1.7-1.8-3-5.2-2.3.7-1.6-.9L15 3Z" transform="translate(1 -1) scale(.92)"/><circle cx="12" cy="12" r="3.2"/>',
    send: '<path d="M12 20V4m-7 7 7-7 7 7"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
  } as const;
  return h`<svg class="glyph" aria-hidden="true" viewBox="0 0 24 24">${raw(paths[name])}</svg>`;
}
export const code = (text: string, language = "") =>
  h`<pre><code data-language="${language}">${text}</code></pre>`;
function inline(text: string): SafeHtml {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g;
  let offset = 0;
  const parts: SafeHtml[] = [];
  for (const match of text.matchAll(pattern)) {
    parts.push(h`${text.slice(offset, match.index)}`);
    const value = match[0];
    if (value.startsWith("[")) {
      const split = value.indexOf("](");
      parts.push(
        h`<a href="${value.slice(split + 2, -1)}" target="_blank" rel="noopener noreferrer">${value.slice(1, split)}</a>`,
      );
    } else
      parts.push(
        value.startsWith("`")
          ? h`<code>${value.slice(1, -1)}</code>`
          : h`<strong>${value.slice(2, -2)}</strong>`,
      );
    offset = match.index + value.length;
  }
  return h`${parts}${text.slice(offset)}`;
}
export function markdown(text: string): SafeHtml {
  const parts = text.split(/^```([^\n]*)\n([\s\S]*?)(?:^```\s*$|(?![\s\S]))/gm);
  const rendered: SafeHtml[] = [];
  for (let i = 0; i < parts.length; i += 3) {
    for (const paragraph of parts[i].split(/\n\n+/).filter(Boolean)) {
      const heading = /^(#{1,4}) (.*)$/.exec(paragraph);
      const tag = heading ? `h${heading[1].length + 1}` : "p";
      rendered.push(h`<${tag}>${inline(heading ? heading[2] : paragraph)}</${tag}>`);
    }
    if (parts[i + 1] !== undefined)
      rendered.push(code(parts[i + 2], parts[i + 1].trim().split(/\s/)[0]));
  }
  return h`<div class="text" hx-ignore>${rendered}</div>`;
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
function details(data: unknown): SafeHtml {
  if (!data || typeof data !== "object") return h``;
  const patch =
    "patch" in data && typeof data.patch === "string"
      ? data.patch
      : "diff" in data && typeof data.diff === "string"
        ? data.diff
        : undefined;
  return h`<details${patch ? h` open` : ""}><summary>${patch ? "Changes" : "Details"}</summary>${code(patch ?? JSON.stringify(data, null, 2), patch ? "diff" : "json")}</details>`;
}
export function toolStatus(
  state: "pending" | "running" | "completed" | "failed" | "cancelled" | "unavailable",
): SafeHtml {
  const symbols = { completed: "✓", failed: "✕", pending: "◷", cancelled: "⊘", unavailable: "?" };
  return h`<span class="tool-status" data-state="${state}" role="img" aria-label="${state}">${state === "running" ? h`${[0, 1, 2, 3].map((index) => h`<span aria-hidden="true" style="animation-delay:-${index * 225}ms"></span>`)}` : symbols[state]}</span>`;
}
export function tool(
  call: Call,
  result?: Result,
  slot?: ToolSlot | NestedToolSlot,
  busy = false,
): SafeHtml {
  const name = call.name.split(".").at(-1)!;
  const args = call.arguments;
  const input =
    name === "bash" && typeof args.command === "string"
      ? args.command
      : name === "write" && typeof args.content === "string"
        ? args.content
        : JSON.stringify(args, null, 2);
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
  const summary = h`<summary>${toolStatus(state)}<span class="tool-command" hx-ignore>${command}</span>${duration === undefined ? "" : h`<span class="tool-duration" title="${duration}ms">${duration < 1000 ? `${Math.round(duration)}ms` : `${(duration / 1000).toFixed(1)}s`}</span>`}</summary>`;
  const outputMarkup = h`<div class="tool-result">${result ? h`${result.message.content.map((part) => (part.type === "text" ? code(part.text) : part.type === "image" ? image(part.mimeType, part.data) : ""))}` : output ? code(output) : ""}${slot?.droppedBytes || slot?.droppedLines ? h`<p class="notice">Output truncated: ${slot.droppedBytes ?? 0} bytes / ${slot.droppedLines ?? 0} lines omitted.</p>` : ""}${slot?.diagnostics?.length ? h`<details><summary>Diagnostics</summary>${code(JSON.stringify(slot.diagnostics, null, 2), "json")}</details>` : ""}${nested?.error ? h`<p class="error" hx-ignore>${nested.error}</p>` : ""}${details(metadata)}${result && !result.message.isError && name === "write" ? h`<details><summary>Written content</summary>${code(input)}</details>` : ""}</div>`;
  return h`<details id="${toolID(call.id)}" class="tool-call" data-call-id="${call.id}" data-tool="${call.name}" data-disclosure="${toolID(call.id)}" data-state="${state}"${state === "failed" ? h` open` : ""}>${summary}${outputMarkup}</details>`;
}
function image(mime: string, data: string): SafeHtml {
  return /^image\/(png|jpeg|gif|webp)$/.test(mime) && /^[A-Za-z0-9+/=\s]*$/.test(data)
    ? h`<img class="transcript-image" alt="Attachment" src="data:${mime};base64,${data}">`
    : h`[attachment]`;
}
export function message(
  message: Message,
  renderTool?: (call: Call) => SafeHtml,
  wrap = true,
  showHeader = true,
): SafeHtml {
  if (message.role === "system") return h``;
  const date = new Date(message.timestamp);
  const time = Number.isFinite(date.getTime()) ? date.toISOString() : "";
  const content =
    typeof message.content === "string"
      ? markdown(message.content)
      : h`${message.content.map((part) => {
          if (part.type === "text")
            return message.role === "toolResult" ? code(part.text) : markdown(part.text);
          if (part.type === "thinking")
            return h`<div class="thinking" hx-ignore>${part.thinking || "Thinking…"}</div>`;
          if (part.type === "toolCall") return renderTool ? renderTool(part) : tool(part);
          if (part.type === "image") return image(part.mimeType, part.data);
          return h``;
        })}`;
  const html = h`${showHeader ? h`<header><span class="speaker">${message.role === "assistant" ? "Pi" : message.role === "user" ? "You" : message.toolName}</span><time class="message-time" datetime="${time}">${time}</time></header>` : ""}${content}${message.role === "assistant" && message.errorMessage ? h`<p class="error" hx-ignore>${message.errorMessage}</p>` : ""}`;
  return wrap ? h`<article data-role="${message.role}">${html}</article>` : html;
}
export function entry(
  record: EntryRecord,
  calls = new Map<string, Call>(),
  results = new Map<string, Result>(),
  live?: LiveState,
  archive = h``,
  duration?: number,
): SafeHtml {
  const boundary = record.kind === "pi.reset" || record.kind === "pi.compaction";
  const messages =
    record.model?.filter(
      (message) =>
        message.role !== "system" &&
        !(message.role === "toolResult" && calls.has(message.toolCallId)),
    ) ?? [];
  const rendered = h`${messages.map((item) =>
    message(
      item,
      (call) =>
        tool(
          call,
          results.get(call.id),
          live?.tools?.find((slot) => slot.callId === call.id),
          !!live?.run,
        ),
      false,
      record.kind !== "pi.compaction",
    ),
  )}`;
  const html = boundary
    ? h`<details class="tool-call context-event" data-state="completed" data-disclosure="context-${record.id}"><summary>${toolStatus("completed")}<span class="tool-command">${record.kind === "pi.reset" ? "Context reset" : "Context compacted"}</span>${timing(record.id, duration)}</summary>${record.kind === "pi.compaction" ? h`<div class="compaction-summary">${rendered}</div>` : ""}<div id="archive-${record.id}" class="context-history">${archive}</div></details>${record.kind === "pi.reset" ? rendered : ""}`
    : rendered;
  return h`<article id="entry-${record.id}" data-entry="${record.id}"${boundary ? "" : h` hx-morph-skip`}${!boundary && messages[0] ? h` data-role="${messages[0].role}"` : ""}${boundary ? h` data-context="${record.kind}"` : ""}${!html.length ? h` hidden` : ""}>${html}</article>`;
}
export function compactTokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}M`;
}
export function contextHTML(data: ContextInspection): SafeHtml {
  if (data.state === "unavailable")
    return h`<section id="context-view" class="pane"><span class="ctx-state">Context unavailable</span></section>`;
  const count = (n: number) =>
    n < 1000 ? String(n) : `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  const span = (className: string, text = "") => h`<span class="${className}">${text}</span>`;
  const position = (n: number) =>
    data.window ? Math.max(0, Math.min(100, (n / data.window) * 100)) : 0;
  const fields = (parts: ContextPart[], nested = false): SafeHtml =>
    h`<ol class="ctx-fields${nested ? " ctx-files" : ""}">${h`${parts.map((part) => h`<li><div class="ctx-field"><span class="ctx-field-main">${span(nested ? "ctx-field-value" : "ctx-field-name", part.name)}${part.value === undefined ? "" : span("ctx-field-value", part.value)}</span>${span("ctx-tokens", count(part.tokens))}</div>${part.children?.length ? fields(part.children, true) : ""}</li>`)}`}</ol>`;
  const threshold = (data.policy.backgroundTokens > 0 ? data.backgroundAt : data.blockingAt) ?? 0;
  const window =
    data.window === null
      ? ""
      : h`<div class="ctx-window" role="img" aria-label="Estimated context: ${data.tokens.toLocaleString()} of ${data.window.toLocaleString()} tokens."><div class="ctx-track">${h`${data.roles.map((role) => h`<span class="ctx-segment" data-role="${role.role}" style="width:${position(role.tokens)}%"></span>`)}`}</div>${data.policy.enabled ? h`<span class="ctx-threshold" style="left:${position(threshold)}%"></span><span class="ctx-reserved" style="width:${position(data.policy.reserveTokens)}%"></span>` : ""}</div>${data.policy.enabled ? h`<div class="ctx-ruler" aria-hidden="true"><span class="ctx-auto" style="left:${position(threshold)}%">~${compactTokens(threshold)}</span></div><div class="ctx-reserve-caption">${span("ctx-reserve-key")}${count(data.policy.reserveTokens)} reserved</div>` : ""}`;
  const messages = h`${data.messages.map(
    (message, index) =>
      h`<li class="ctx-message" data-order="${index}" data-role="${message.role}" data-tokens="${message.tokens}"${message.source ? h` data-entry="${message.source.entry}" data-kind="${message.source.kind}"` : ""}><div class="ctx-message-heading">${span("ctx-swatch")}<span class="ctx-heading-main">${span("ctx-role", message.role)}${message.source?.kind === "pi.compaction" || message.source?.kind === "pi.reset" ? span("ctx-provenance", message.source.kind) : ""}${message.toolName === undefined ? "" : span("ctx-tool-name", message.toolName)}</span>${span("ctx-tokens", count(message.tokens))}</div>${message.role === "toolResult" && message.parts.length === 1 && message.parts[0].name === "text" ? "" : fields(message.parts)}</li>`,
  )}`;
  return h`<section id="context-view" class="pane" data-conversation="${data.conversation}" data-tail="${data.tail ?? ""}" data-tokens="${data.tokens}" hx-ignore><section aria-label="Context usage"><div class="ctx-usage"><span class="ctx-big">~${count(data.tokens)} ${span("", `/ ${data.window === null ? "?" : count(data.window)}`)}</span><div class="ctx-capacity">${span("ctx-percent", data.fraction === null ? "-" : `${(data.fraction * 100).toFixed(1)}%`)}${span("ctx-remaining", data.remaining === null ? "" : `${count(data.remaining)} remaining`)}</div></div>${window}<ul class="ctx-legend" aria-label="Message roles">${h`${data.roles.map((role) => h`<li data-role="${role.role}">${span("ctx-swatch")}${span("", role.role)}${span("ctx-tokens", count(role.tokens))}</li>`)}`}</ul></section><section class="ctx-inventory" aria-label="Context messages in provider order"><ol class="ctx-messages">${messages}</ol>${messages.length ? "" : span("ctx-state", "No context")}</section></section>`;
}

export function timing(entry: number, ms?: number): SafeHtml {
  return h`<span id="duration-${entry}" class="tool-duration"${ms === undefined ? "" : h` data-duration-ms="${ms}" title="Duration: ${ms}ms"`}>${ms === undefined ? "" : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`}</span>`;
}
