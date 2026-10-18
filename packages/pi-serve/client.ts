import { settingFields, type GlobalSettings } from "./settings.ts";
import {
  installPickerKeyMappings,
  installSelectKeyMappings,
  navigationDirection,
  moveFocus,
} from "./key-mappings.ts";
import type { ImageContent, Message } from "@earendil-works/pi-ai";
import type {
  AgentState,
  ConversationRecord,
  EntryRecord,
  InboxState,
  LiveState,
  UsageState,
} from "@earendil-works/pi-durable";
import type {
  Catalog,
  ExecutionBinding,
  RepositoryStatus,
  SessionInfo,
  Snapshot,
} from "../pi-runtime/index.ts";

function element<T extends HTMLElement>(id: string, type: { new (): T }): T {
  const found = document.getElementById(id);
  if (!(found instanceof type)) throw new Error(`Missing ${id}`);
  return found;
}
const highlighterURL = "/highlight.js";
const {
  default: hljs,
}: {
  default: {
    getLanguage(name: string): unknown;
    highlight(
      code: string,
      options: { language: string; ignoreIllegals: boolean },
    ): { value: string };
  };
} = await import(highlighterURL);
const modeToggle = element("input-mode", HTMLButtonElement);
let submissionMode: "followUp" | "steer" = "followUp";
const branches = element("branches", HTMLSelectElement);
const preferences = element("preferences", HTMLDialogElement);
const globalPreferences = element("global-preferences", HTMLDialogElement);
const newThinking = element("new-thinking", HTMLSelectElement);
let globalSettings: GlobalSettings | null = null;
let editingSettings: GlobalSettings | null = null;
const usageDialog = element("usage-dialog", HTMLDialogElement);
const bottomLine = element("bottom-line", HTMLElement);
let repository: RepositoryStatus | undefined;
let repositoryRequest = -1;
const sessionModel = element("session-model", HTMLSelectElement);
const thinking = element("thinking", HTMLSelectElement);
const instructions = element("instructions", HTMLTextAreaElement);
let conversation: number | undefined;
let latest: Snapshot | undefined;
let images: (ImageContent & { name: string })[] = [];
const targets = element("targets", HTMLSelectElement);
const models = element("models", HTMLSelectElement);
const sessions = element("sessions", HTMLDivElement);
const transcript = element("transcript", HTMLDivElement);
const composer = element("composer", HTMLFormElement);
const prompt = element("prompt", HTMLTextAreaElement);
const send = element("send", HTMLButtonElement);
const stop = element("stop", HTMLButtonElement);
const resume = element("resume", HTMLButtonElement);
const notice = element("notice", HTMLDivElement);
const status = element("status", HTMLSpanElement);
const title = element("title", HTMLButtonElement);
const create = element("create", HTMLButtonElement);
const recovery = element("recovery", HTMLDivElement);
const picker = element("picker", HTMLDialogElement);
const menu = element("conversation-menu", HTMLDivElement);
const appMenu = element("app-menu", HTMLDivElement);
const messageMenu = element("message-menu", HTMLDivElement);
const inputMenu = element("input-menu", HTMLDivElement);
const sessionFilter = element("session-filter", HTMLInputElement);
const search = element("search", HTMLInputElement);
const searchBar = element("search-bar", HTMLDivElement);
let matches: HTMLElement[] = [];
let matchIndex = -1;
let selectedMessage:
  | {
      entry: number | undefined;
      message: Message | undefined;
      session: string;
      branch: number | undefined;
      trigger: HTMLButtonElement;
    }
  | undefined;

let catalog: Catalog;
let active: string | undefined;
let source: EventSource | undefined;
let generation = 0;
let busy = false;
let recovering = false;
let connected = false;
let sending = false;
let pending:
  | {
      session: string;
      conversation: number | undefined;
      text: string;
      mode: string;
      requestId: string;
      images: ImageContent[];
    }
  | undefined;
const entries = new Map<number, EntryRecord>();
const rendered = new Map<string, { node: HTMLElement; signature: string }>();

// randomUUID is secure-context-only; getRandomValues also works on LAN HTTP.
function requestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

function report(error: unknown): void {
  const message = !navigator.onLine
    ? "Offline — reconnect to load conversations."
    : error instanceof Error
      ? error.message
      : String(error);
  const dialog = [globalPreferences, picker, preferences].find((dialog) => dialog.open);
  if (dialog) {
    let local = dialog.querySelector<HTMLParagraphElement>(".dialog-error");
    if (!local) {
      local = document.createElement("p");
      local.className = "dialog-error error";
      local.setAttribute("role", "alert");
      dialog.querySelector(".dialog-heading")?.after(local);
    }
    local.textContent = message;
    return;
  }
  notice.textContent = message;
  notice.hidden = false;
}
async function api<T>(path: string, data?: unknown): Promise<T> {
  const response = await fetch(
    path,
    data === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        },
  );
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  return result as T;
}
function controls(): void {
  send.disabled = !active || !connected || recovering || sending || !prompt.value.trim();
  stop.disabled = !active || !connected || !busy || recovering;
  stop.hidden = !busy || recovering;
  modeToggle.hidden = !busy || recovering;
  modeToggle.disabled = !active || !connected || recovering || sending;
  modeToggle.textContent = submissionMode === "steer" ? "Steer" : "Follow up";
  modeToggle.dataset.mode = submissionMode;
  modeToggle.title =
    submissionMode === "steer"
      ? "Steer at the next opportunity. Click to switch to Follow up."
      : "Queue after the current run. Click to switch to Steer.";
  modeToggle.setAttribute(
    "aria-label",
    `${modeToggle.textContent}. Switch to ${submissionMode === "steer" ? "Follow up" : "Steer"}`,
  );
  resume.disabled = !active || !connected || !recovering;
  recovery.hidden = !recovering;
  for (const id of ["settings", "export", "find", "footer-model"])
    element(id, HTMLButtonElement).disabled = !active || !connected || recovering;
  document.body.classList.toggle("offline", !navigator.onLine);
  branches.disabled = !active;
  bottomLine.dataset.connected = String(connected);
  const action = busy && !recovering ? (submissionMode === "steer" ? "Steer" : "Queue") : "Send";
  send.setAttribute("aria-label", action);
  send.title = `${action} (Ctrl/⌘ Enter)`;
  const state = !navigator.onLine
    ? "offline"
    : !active
      ? "none"
      : !connected
        ? "reconnecting"
        : recovering
          ? "interrupted"
          : busy
            ? "working"
            : "ready";
  const label = {
    offline: "Offline",
    none: "No session",
    reconnecting: "Reconnecting",
    interrupted: "Interrupted",
    working: "Working",
    ready: "Ready",
  }[state];
  status.dataset.state = state;
  status.title = label;
  status.querySelector(".sr-only")!.textContent = label;
}
function targetKey(binding: ExecutionBinding): string {
  return JSON.stringify([binding.provider, binding.target, binding.cwd]);
}
function chooseOption(
  select: HTMLSelectElement,
  value: string,
  label: string,
  disabled = false,
): void {
  const option = new Option(label, value);
  option.disabled = disabled;
  select.add(option);
}
async function refresh(): Promise<void> {
  const [next, defaults] = await Promise.all([
    api<Catalog>("/api/catalog"),
    api<GlobalSettings | null>("/api/settings"),
  ]);
  // Preserve choices made while the catalog request was pending.
  const previousTarget = targets.value;
  const previousModel = models.value ? catalog?.models[Number(models.value)] : undefined;
  globalSettings = defaults;
  for (const id of ["global-settings", "picker-defaults"])
    element(id, HTMLButtonElement).hidden = !defaults;
  document.body.classList.toggle("hide-thinking", defaults?.values.hideThinkingBlock === true);
  document.body.classList.toggle("hide-images", defaults?.values["terminal.showImages"] === false);
  catalog = next;
  targets.replaceChildren();
  chooseOption(targets, "", "Select an execution target");
  for (const target of catalog.targets) {
    chooseOption(
      targets,
      targetKey(target),
      target.label + (target.available ? "" : " (unavailable)"),
      !target.available,
    );
  }
  if (catalog.targets.some((target) => targetKey(target) === previousTarget && target.available))
    targets.value = previousTarget;
  else if (catalog.targets.length === 1 && catalog.targets[0].available)
    targets.value = targetKey(catalog.targets[0]);
  models.replaceChildren();
  chooseOption(
    models,
    "",
    catalog.models.length ? "Select a model" : "No models — configure pi /login on the host",
  );
  catalog.models.forEach((model, index) =>
    chooseOption(models, String(index), `${model.provider} / ${model.name}`),
  );
  const old = catalog.models.find(
    (model) =>
      model.provider === previousModel?.provider && model.modelId === previousModel?.modelId,
  );
  const selected =
    old ??
    catalog.models.find(
      (model) =>
        model.provider === catalog.defaultModel?.provider &&
        model.modelId === catalog.defaultModel?.modelId,
    );
  if (selected) models.value = String(catalog.models.indexOf(selected));
  else if (catalog.models.length === 1) models.value = "0";
  fillThinking(newThinking, models, newThinking.value, true);
  renderSessions();
  create.disabled = !targets.value || !models.value;
}
function sessionTitle(session: SessionInfo): string {
  return (
    session.name ||
    session.binding.target.split("/").filter(Boolean).at(-1) ||
    session.binding.provider
  );
}
function renderSessions(): void {
  if (!catalog) return;
  sessions.replaceChildren();
  const query = sessionFilter.value.trim().toLocaleLowerCase();
  for (const session of catalog.sessions) {
    const target = catalog.targets.find((item) => targetKey(item) === targetKey(session.binding));
    const label = target?.label ?? session.binding.target;
    if (
      query &&
      !`${sessionTitle(session)} ${label} ${session.id}`.toLocaleLowerCase().includes(query)
    )
      continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "session";
    button.dataset.session = session.id;
    button.setAttribute("aria-current", String(session.id === active));
    const name = document.createElement("strong");
    name.textContent = sessionTitle(session);
    const detail = document.createElement("small");
    detail.textContent = `${label} · ${new Date(session.created).toLocaleDateString()}${target?.available ? "" : " · unavailable"}`;
    button.title = detail.textContent;
    button.append(name, detail);
    button.onclick = () => attach(session.id);
    sessions.append(button);
  }
  const empty = element("sessions-empty", HTMLParagraphElement);
  empty.hidden = !!sessions.childElementCount;
  empty.textContent = query ? "No matching sessions" : "No sessions";
}

function codeBlock(text: string, language = "", disclosure?: HTMLDetailsElement): HTMLElement {
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.textContent = text;
  if (language && hljs.getLanguage(language)) {
    const highlight = () => {
      // highlight.js escapes all input before adding its own span markup.
      code.innerHTML = hljs.highlight(text, { language, ignoreIllegals: true }).value;
    };
    if (disclosure && !disclosure.open) {
      // Keep raw text searchable without parsing thousands of hidden spans.
      const onToggle = () => {
        if (!disclosure.open) return;
        disclosure.removeEventListener("toggle", onToggle);
        highlight();
        // Highlighting replaces text nodes referenced by search ranges.
        if (!searchBar.hidden) updateSearch();
      };
      disclosure.addEventListener("toggle", onToggle);
    } else highlight();
  }
  pre.append(code);
  return pre;
}
function inline(parent: HTMLElement, text: string): void {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    parent.append(text.slice(offset, match.index));
    const value = match[0];
    if (value.startsWith("[")) {
      const split = value.indexOf("](");
      const link = document.createElement("a");
      link.textContent = value.slice(1, split);
      link.href = value.slice(split + 2, -1);
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      parent.append(link);
    } else {
      const node = document.createElement(value.startsWith("`") ? "code" : "strong");
      node.textContent = value.startsWith("`") ? value.slice(1, -1) : value.slice(2, -2);
      parent.append(node);
    }
    offset = match.index + value.length;
  }
  parent.append(text.slice(offset));
}
function markdown(text: string): HTMLElement {
  const result = document.createElement("div");
  result.className = "text";
  const parts = text.split(/^```([^\n]*)\n([\s\S]*?)(?:^```\s*$|(?![\s\S]))/gm);
  for (let i = 0; i < parts.length; i += 3) {
    if (parts[i]) {
      for (const paragraph of parts[i].trim().split(/\n\n+/)) {
        const heading = /^(#{1,4}) (.*)$/.exec(paragraph);
        const node = document.createElement(heading ? `h${heading[1].length + 1}` : "p");
        inline(node, heading ? heading[2] : paragraph);
        result.append(node);
      }
    }
    if (parts[i + 1] !== undefined)
      result.append(codeBlock(parts[i + 2], parts[i + 1].trim().split(/\s/)[0]));
  }
  return result;
}
function endpoint(action: string): string {
  return `/api/sessions/${active}/${action}${conversation === undefined ? "" : `?conversation=${conversation}`}`;
}
async function refreshBranches(): Promise<void> {
  const id = active;
  const records = await api<ConversationRecord[]>(endpoint("conversations"));
  if (active !== id) return;
  branches.replaceChildren();
  records.forEach((record, index) =>
    chooseOption(
      branches,
      String(record.id),
      index === 0
        ? "Main"
        : `Branch ${record.id}${record.parent ? ` · from ${record.parent.conversationId}` : ""}`,
    ),
  );
  if (conversation !== undefined) branches.value = String(conversation);
}

// Arguments may be incomplete while streaming. Never parse display previews (in
// particular codemode's truncated args) as JSON.
function toolLabel(name: string, args: Record<string, unknown> = {}): string {
  const short = name.split(".").at(-1) ?? name;
  const path = typeof args.path === "string" ? args.path : "";
  if (short === "bash") {
    const command = typeof args.command === "string" ? args.command.trim() : "Shell command";
    return `$ ${command}`;
  }
  if (short === "codemode") return "Code · JavaScript";
  const verb = {
    read: "Read",
    edit: "Edit",
    write: "Write",
    grep: "Search",
    find: "Find",
    ls: "List",
  }[short];
  return `${verb ?? name}${path ? ` · ${path}` : ""}`;
}

function toolCommand(name: string, args: Record<string, unknown> = {}): string {
  const short = name.split(".").at(-1);
  if (short === "bash") return toolLabel(name, args);
  if (short === "codemode" && typeof args.code === "string") return args.code.trim();
  const label = toolLabel(name, args);
  if (short === "write" && typeof args.content === "string") return `${label}\n${args.content}`;
  return Object.keys(args).length ? `${label}\n${JSON.stringify(args, null, 2)}` : label;
}

function toolSummary(command: string, state: string, durationMs?: number): HTMLElement {
  const summary = document.createElement("summary");
  const status = document.createElement("span");
  status.className = "tool-status";
  status.textContent =
    {
      completed: "✓",
      ok: "✓",
      running: "",
      pending: "◷",
      failed: "✕",
      error: "✕",
      cancelled: "⊘",
      done: "✓",
      unfinished: "◷",
    }[state] ?? "?";
  status.dataset.state = state;
  status.setAttribute("role", "img");
  status.setAttribute("aria-label", state);
  status.title = state;
  if (state === "running") {
    for (let index = 0; index < 4; index++) {
      const dot = document.createElement("span");
      dot.setAttribute("aria-hidden", "true");
      dot.style.animationDelay = `-${index * 225}ms`;
      status.append(dot);
    }
  }
  const label = document.createElement("span");
  label.className = "tool-command";
  label.textContent = command;
  summary.append(status, label);
  if (typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0) {
    const duration = document.createElement("span");
    duration.className = "tool-duration";
    duration.textContent =
      durationMs < 1000 ? `${Math.round(durationMs)}ms` : `${(durationMs / 1000).toFixed(1)}s`;
    duration.title = `Duration: ${durationMs}ms`;
    duration.setAttribute("aria-label", `Duration: ${durationMs} milliseconds`);
    summary.append(duration);
  }
  return summary;
}

function toolInput(
  name: string,
  args: Record<string, unknown>,
): { text: string; language: string } {
  const short = name.split(".").at(-1);
  if (short === "bash" && typeof args.command === "string")
    return { text: args.command, language: "bash" };
  if (short === "codemode" && typeof args.code === "string")
    return { text: args.code, language: "javascript" };
  if (short === "write" && typeof args.content === "string")
    return { text: args.content, language: "" };
  if (short === "edit") {
    const edits = Array.isArray(args.edits) ? args.edits : [args];
    if (
      edits.every(
        (edit) => edit && typeof edit.oldText === "string" && typeof edit.newText === "string",
      )
    ) {
      const preview = edits
        .map(
          (edit) =>
            `@@ Requested replacement @@\n${edit.oldText
              .split("\n")
              .map((line: string) => `-${line}`)
              .join("\n")}\n${edit.newText
              .split("\n")
              .map((line: string) => `+${line}`)
              .join("\n")}`,
        )
        .join("\n");
      return { text: preview, language: "diff" };
    }
  }
  return { text: JSON.stringify(args, null, 2), language: "json" };
}

function resultDetails(message: Extract<Message, { role: "toolResult" }>): unknown {
  const data = message.details;
  return message.nestedCalls
    ? {
        ...(data && typeof data === "object" && !Array.isArray(data)
          ? Object.fromEntries(Object.entries(data))
          : {}),
        ...message.nestedCalls,
      }
    : data;
}

function toolDetails(node: HTMLElement, data: unknown): void {
  if (!data || typeof data !== "object") return;
  const patch =
    "patch" in data && typeof data.patch === "string"
      ? data.patch
      : "diff" in data && typeof data.diff === "string"
        ? data.diff
        : undefined;
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = patch ? "Changes" : "Details";
  details.open = !!patch;
  details.append(summary);
  if ("calls" in data && Array.isArray(data.calls)) {
    summary.textContent = `Nested tools · ${data.calls.length}${"complete" in data && data.complete === false ? " · partial record" : ""}`;
    details.className = "nested-tools";
    for (const call of data.calls) {
      if (!call || typeof call !== "object") continue;
      const row = document.createElement("details");
      row.className = "tool-call";
      row.dataset.state = String(call.status);
      const command =
        call.arguments && typeof call.arguments === "object"
          ? toolCommand(String(call.name), call.arguments)
          : `${toolLabel(String(call.name))}${typeof call.args === "string" ? `\n${call.args}` : ""}`;
      row.append(toolSummary(command, String(call.status), call.durationMs));
      if (typeof call.argumentsBytes === "number")
        row.append(`Arguments omitted (${call.argumentsBytes} bytes)`);
      if (typeof call.error === "string") {
        row.classList.add("error");
        row.append(codeBlock(call.error));
      }
      const actions = messageActions(
        undefined,
        undefined,
        toolCopies(
          call.arguments && typeof call.arguments === "object"
            ? toolInput(String(call.name), call.arguments).text
            : typeof call.args === "string"
              ? call.args
              : undefined,
          typeof call.error === "string" ? call.error : undefined,
          call,
        ),
      );
      actions.setAttribute("aria-label", "Tool actions");
      row.append(actions);
      details.append(row);
    }
    // Keep truncation paths and any future metadata accessible as well.
    const raw = document.createElement("details");
    const label = document.createElement("summary");
    label.textContent = "Raw details";
    raw.append(label, codeBlock(JSON.stringify(data, null, 2), "json", raw));
    details.append(raw);
  } else
    details.append(
      codeBlock(patch ?? JSON.stringify(data, null, 2), patch ? "diff" : "json", details),
    );
  node.append(details);
}

type CopyAction = { label: string; text: string };

function copyText(text: string): void {
  messageMenu.hidePopover();
  if (!navigator.clipboard) return report("Copy requires HTTPS or localhost.");
  void navigator.clipboard
    .writeText(text)
    .then(() => report("Copied"))
    .catch(report);
}

function toolCopies(
  input: string | undefined,
  output: string | undefined,
  data: unknown,
): CopyAction[] {
  const copies: CopyAction[] = [];
  if (input !== undefined) copies.push({ label: "Copy input", text: input });
  if (output !== undefined) copies.push({ label: "Copy output", text: output });
  if (data && typeof data === "object") {
    const patch =
      "patch" in data && typeof data.patch === "string"
        ? data.patch
        : "diff" in data && typeof data.diff === "string"
          ? data.diff
          : undefined;
    if (patch !== undefined) copies.push({ label: "Copy changes", text: patch });
    copies.push({ label: "Copy details", text: JSON.stringify(data, null, 2) });
  }
  return copies;
}

let touchMenuAnchor: { x: number; y: number } | undefined;
function positionTouchMenu(point: { x: number; y: number }): void {
  const viewport = visualViewport;
  const style = getComputedStyle(messageMenu);
  const inset = (side: string) => parseFloat(style.getPropertyValue(`--menu-safe-${side}`)) || 0;
  const left = (viewport?.offsetLeft ?? 0) + inset("left") + 8;
  const top = (viewport?.offsetTop ?? 0) + inset("top") + 8;
  const right = (viewport?.offsetLeft ?? 0) + (viewport?.width ?? innerWidth) - inset("right") - 8;
  const bottom =
    (viewport?.offsetTop ?? 0) + (viewport?.height ?? innerHeight) - inset("bottom") - 8;
  messageMenu.style.maxWidth = `${Math.max(0, right - left)}px`;
  messageMenu.style.maxHeight = `${Math.max(0, bottom - top)}px`;
  const { width, height } = messageMenu.getBoundingClientRect();
  const gap = 12;
  const x = point.x + gap + width <= right ? point.x + gap : point.x - gap - width;
  const y = point.y - gap - height >= top ? point.y - gap - height : point.y + gap;
  messageMenu.style.left = `${Math.max(left, Math.min(x, right - width))}px`;
  messageMenu.style.top = `${Math.max(top, Math.min(y, bottom - height))}px`;
  messageMenu.style.right = "auto";
  messageMenu.style.bottom = "auto";
}

function messageActions(
  entry: number | undefined,
  message: Message | undefined,
  copies: CopyAction[] = [],
): HTMLButtonElement {
  const actions = document.createElement("button");
  actions.className = "icon message-actions";
  actions.textContent = "···";
  actions.setAttribute("aria-label", "Message actions");
  actions.setAttribute("aria-controls", "message-menu");
  actions.setAttribute("aria-expanded", "false");
  actions.onclick = () => {
    if (!active) return;
    if (messageMenu.matches(":popover-open") && selectedMessage?.trigger === actions) {
      messageMenu.hidePopover();
      return;
    }
    selectedMessage?.trigger.setAttribute("aria-expanded", "false");
    messageMenu.hidePopover();
    selectedMessage = {
      entry,
      message,
      session: active,
      branch: conversation,
      trigger: actions,
    };
    messageMenu.querySelectorAll("[data-copy]").forEach((button) => button.remove());
    const buttons = copies.map(({ label, text }) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.copy = label;
      button.textContent = label;
      button.onclick = () => copyText(text);
      return button;
    });
    messageMenu.prepend(...buttons);
    element("copy-message", HTMLButtonElement).hidden = !message || copies.length > 0;
    element("quote-message", HTMLButtonElement).hidden = !message;
    const fork = element("fork-message", HTMLButtonElement);
    fork.hidden = entry === undefined;
    fork.disabled = !connected || recovering;
    // Clear the last anchor when switching between touch and mouse/keyboard.
    for (const property of ["top", "right", "bottom", "left", "max-width", "max-height"])
      messageMenu.style.removeProperty(property);
    messageMenu.showPopover();
    actions.setAttribute("aria-expanded", "true");
    if (touchMenuAnchor || matchMedia("(hover: none), (pointer: coarse)").matches) {
      const owner =
        actions.closest(".tool-call")?.querySelector(":scope > summary") ??
        actions.closest("article") ??
        actions;
      const rect = owner.getBoundingClientRect();
      positionTouchMenu(touchMenuAnchor ?? { x: rect.left + 16, y: rect.top + 16 });
    } else if (matchMedia("(min-width: 651px)").matches) {
      const rect = actions.getBoundingClientRect();
      messageMenu.style.top = `${Math.max(8, Math.min(rect.bottom + 4, innerHeight - messageMenu.offsetHeight - 8))}px`;
      messageMenu.style.right = `${Math.max(8, Math.min(innerWidth - rect.right, innerWidth - messageMenu.offsetWidth - 8))}px`;
    }
    messageMenu
      .querySelector<HTMLButtonElement>("button:not([hidden]):not(:disabled)")
      ?.focus({ preventScroll: true });
  };
  return actions;
}

// Delegate to the live DOM so streamed/replaced messages never retain gesture handlers.
function touchActions(target: EventTarget | null): HTMLButtonElement | undefined {
  if (
    !(target instanceof Element) ||
    target.closest("a, button, input, textarea, select, pre, code, img, [contenteditable]")
  )
    return;
  return (
    target
      .closest(".tool-call, article")
      ?.querySelector<HTMLButtonElement>(
        ":scope > .message-actions, :scope > header > .message-actions",
      ) ?? undefined
  );
}
let longPress:
  | {
      pointer: number;
      x: number;
      y: number;
      actions: HTMLButtonElement;
      timer: number;
    }
  | undefined;
let heldActions: HTMLButtonElement | undefined;
function cancelLongPress(): void {
  if (longPress) clearTimeout(longPress.timer);
  longPress = undefined;
}
function openHeldActions(actions: HTMLButtonElement): void {
  const point = longPress && { x: longPress.x, y: longPress.y };
  cancelLongPress();
  if (!actions.isConnected || !transcript.contains(actions)) return;
  heldActions = actions;
  touchMenuAnchor = point;
  try {
    actions.click();
  } finally {
    touchMenuAnchor = undefined;
  }
}
transcript.addEventListener("pointerdown", (event) => {
  cancelLongPress();
  heldActions = undefined;
  if (event.pointerType !== "touch" || !event.isPrimary) return;
  const actions = touchActions(event.target);
  if (!actions) return;
  longPress = {
    pointer: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    actions,
    timer: window.setTimeout(() => openHeldActions(actions), 500),
  };
});
document.addEventListener("pointermove", (event) => {
  if (
    longPress &&
    event.pointerId === longPress.pointer &&
    Math.hypot(event.clientX - longPress.x, event.clientY - longPress.y) > 8
  )
    cancelLongPress();
});
for (const event of ["pointerup", "pointercancel"])
  document.addEventListener(event, cancelLongPress);
document.addEventListener("pointerdown", (event) => {
  if (!event.isPrimary) cancelLongPress();
});
function dismissTouchMenu(): void {
  cancelLongPress();
  messageMenu.hidePopover();
}
transcript.addEventListener("scroll", dismissTouchMenu, { passive: true });
visualViewport?.addEventListener("resize", dismissTouchMenu);
visualViewport?.addEventListener("scroll", dismissTouchMenu);
window.addEventListener("blur", cancelLongPress);
document.addEventListener("visibilitychange", cancelLongPress);
transcript.addEventListener("contextmenu", (event) => {
  const actions = touchActions(event.target);
  if (!actions || (!longPress && !matchMedia("(pointer: coarse)").matches)) return;
  event.preventDefault();
  if (longPress?.actions === actions) openHeldActions(actions);
});
transcript.addEventListener(
  "click",
  (event) => {
    // A completed hold must not also toggle the tool disclosure on release.
    if (
      event.isTrusted &&
      event.detail > 0 &&
      heldActions &&
      touchActions(event.target) === heldActions
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      heldActions = undefined;
    }
  },
  true,
);

const messageTime = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit" });
const messageDateTime = new Intl.DateTimeFormat([], {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
});

function content(
  node: HTMLElement,
  message: Message,
  call?: { name: string; arguments: Record<string, unknown> },
  renderTool?: (call: {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }) => HTMLElement,
  embedded = false,
): void {
  if (message.role === "system") return;
  node.dataset.role = message.role;
  const heading = document.createElement("header");
  const speaker = document.createElement("span");
  speaker.className = "speaker";
  heading.append(speaker);
  speaker.textContent =
    message.role === "toolResult"
      ? `${message.isError ? "Failed" : "Completed"} · ${toolLabel(message.toolName, call?.arguments)}`
      : message.role === "assistant"
        ? "Pi"
        : "You";
  if (!embedded) {
    const date = new Date(message.timestamp);
    if (Number.isFinite(date.getTime())) {
      const time = document.createElement("time");
      time.className = "message-time";
      time.dateTime = date.toISOString();
      time.textContent = messageTime.format(date);
      time.title = messageDateTime.format(date);
      heading.append(time);
    }
    node.append(heading);
  }
  if (typeof message.content === "string") {
    node.append(markdown(message.content));
    return;
  }
  for (const block of message.content) {
    if (block.type === "text") {
      if (message.role === "toolResult" && embedded) {
        node.append(codeBlock(block.text));
      } else if (message.role === "toolResult") {
        const details = document.createElement("details");
        const summary = document.createElement("summary");
        summary.textContent = message.isError ? "Error output" : "Output";
        details.open = message.isError;
        details.append(summary, codeBlock(block.text));
        node.append(details);
      } else node.append(markdown(block.text));
    } else if (block.type === "toolCall" && renderTool) {
      node.append(renderTool(block));
    } else if (block.type === "thinking") {
      const thinking = document.createElement("div");
      thinking.className = "thinking";
      thinking.textContent = block.thinking || "Thinking…";
      node.append(thinking);
    } else if (block.type === "toolCall") {
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = toolLabel(block.name, block.arguments);
      details.className = "tool-call";
      const input = toolInput(block.name, block.arguments);
      details.append(summary, codeBlock(input.text, input.language));
      node.append(details);
    } else if (
      block.type === "image" &&
      ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(block.mimeType)
    ) {
      const image = document.createElement("img");
      image.alt = "Tool image";
      image.src = `data:${block.mimeType};base64,${block.data}`;
      node.append(image);
    }
  }
  if (message.role === "toolResult") toolDetails(node, resultDetails(message));
  if (
    message.role === "toolResult" &&
    !message.isError &&
    message.toolName.split(".").at(-1) === "write" &&
    typeof call?.arguments.content === "string"
  ) {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    // The write tool does not supply the old file. Do not invent a diff that
    // would incorrectly describe an overwrite as a newly created file.
    summary.textContent = "Written content";
    details.append(summary, codeBlock(call.arguments.content));
    node.append(details);
  }

  if (message.role === "assistant" && message.errorMessage) {
    const error = document.createElement("p");
    error.className = "error";
    error.textContent = message.errorMessage;
    node.append(error);
  }
}

// A stable module export lets benchmarks exercise the minified renderer.
export function render(snapshot: Snapshot): void {
  const wasEmpty = !transcript.childElementCount;
  latest = snapshot;
  const agent = snapshot.view.docs["pi.agent"] as AgentState | undefined;
  const queue = element("queue", HTMLDivElement);
  queue.replaceChildren();
  for (const item of (snapshot.view.docs["pi.inbox"] as InboxState | undefined)?.items ?? []) {
    const row = document.createElement("div");
    const text = document.createElement("span");
    text.textContent = `${item.mode} · ${item.mode === "write" ? "Context change" : typeof item.content === "string" ? item.content : JSON.stringify(item.content)}`;
    row.append(text);
    if (item.mode !== "write") {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "icon";
      cancel.textContent = "×";
      cancel.setAttribute("aria-label", "Cancel queued message");
      cancel.title = "Cancel queued message";
      cancel.onclick = () => {
        void api(endpoint("cancel"), { id: item.id }).catch(report);
      };
      row.append(cancel);
    }
    queue.append(row);
  }
  queue.hidden = !queue.childElementCount;
  const stick =
    searchBar.hidden &&
    transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80;
  for (const entry of [...(snapshot.history ?? []), ...snapshot.view.entries])
    entries.set(entry.id, entry);
  const live = snapshot.view.docs["pi.live"] as LiveState | undefined;
  const wasBusy = busy;
  busy = !!live?.run;
  recovering = snapshot.session.needsResume;
  title.textContent = sessionTitle(snapshot.session);
  title.title = `${snapshot.session.binding.provider} / ${snapshot.session.binding.target} · ${agent?.model?.modelId ?? snapshot.session.model.modelId}`;
  const activity = element("activity", HTMLDivElement);
  activity.textContent =
    live?.compactionFailure?.error ??
    live?.generation?.retry?.error ??
    (live?.compactions?.length
      ? "Compacting context…"
      : live?.generation?.deferred
        ? "Waiting for provider…"
        : "");
  activity.hidden = !activity.textContent;
  if (wasBusy && !busy) void refreshRepository();
  document.title = `${busy ? "Working · " : ""}${sessionTitle(snapshot.session)}`;
  const wanted = new Set<string>();
  const ordered: HTMLElement[] = [];
  // A streamed assistant entry can be replaced by its committed entry. Keep
  // disclosure state by call ID across that transition as well as live updates.
  const disclosureState = new Map(
    Array.from(transcript.querySelectorAll<HTMLDetailsElement>("details[data-disclosure]")).map(
      (detail) => [detail.dataset.disclosure, detail.open],
    ),
  );
  const focusedDisclosure =
    document.activeElement?.tagName === "SUMMARY"
      ? (document.activeElement.parentElement as HTMLElement | null)?.dataset.disclosure
      : undefined;
  const item = (key: string, value: unknown, build: (node: HTMLElement) => void) => {
    wanted.add(key);
    const signature = JSON.stringify(value);
    let existing = rendered.get(key);
    if (!existing) {
      existing = { node: document.createElement("article"), signature: "" };
      rendered.set(key, existing);
    }
    if (signature !== existing.signature) {
      const open = new Map(
        Array.from(existing.node.querySelectorAll("details")).map((detail, index) => [
          detail.dataset.disclosure ?? `detail:${index}`,
          detail.open,
        ]),
      );
      existing.node.replaceChildren();
      build(existing.node);
      existing.node.querySelectorAll("details").forEach((detail, index) => {
        detail.open =
          (detail.dataset.disclosure
            ? disclosureState.get(detail.dataset.disclosure)
            : open.get(`detail:${index}`)) ?? detail.open;
        if (focusedDisclosure && detail.dataset.disclosure === focusedDisclosure)
          detail.querySelector<HTMLElement>(":scope > summary")?.focus({ preventScroll: true });
      });
      existing.signature = signature;
    }
    ordered.push(existing.node);
  };
  type Call = { id: string; name: string; arguments: Record<string, unknown> };
  const calls = new Map<string, Call>();
  const results = new Map<
    string,
    { entry: number; message: Extract<Message, { role: "toolResult" }> }
  >();
  const partial = live?.generation?.message;
  for (const entry of entries.values())
    for (const message of entry.model ?? []) {
      if (message.role === "assistant")
        for (const block of message.content)
          if (block.type === "toolCall") calls.set(block.id, block);
      if (message.role === "toolResult")
        results.set(message.toolCallId, { entry: entry.id, message });
    }
  if (partial)
    for (const block of partial.content) if (block.type === "toolCall") calls.set(block.id, block);
  const slots = [...(live?.tools ?? []), ...(live?.nestedTools ?? [])];
  const buildTool = (call: Call): HTMLElement => {
    const result = results.get(call.id);
    const slot = slots.find((tool) => tool.callId === call.id);
    const failed = result?.message.isError || (slot && "summary" in slot && slot.summary?.isError);
    const state = failed
      ? "failed"
      : result
        ? "completed"
        : (slot?.status ?? (busy ? "pending" : "unavailable"));
    const details = document.createElement("details");
    details.className = "tool-call";
    details.dataset.callId = call.id;
    details.dataset.tool = call.name;
    details.dataset.disclosure = `call:${call.id}`;
    details.dataset.state = state;
    details.open = !!failed;
    const durationMs =
      result?.message.durationMs ??
      (slot && "summary" in slot ? slot.summary?.durationMs : undefined);
    details.append(toolSummary(toolCommand(call.name, call.arguments), state, durationMs));
    if (result) {
      const output = document.createElement("div");
      output.className = "tool-result";
      content(output, result.message, call, undefined, true);
      details.append(output);
    } else if (slot) {
      if (slot.output) details.append(codeBlock(slot.output));
      toolDetails(details, slot.details);
      if ("summary" in slot && slot.summary?.error) details.append(codeBlock(slot.summary.error));
    }
    const output = result
      ? result.message.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n\n")
      : (slot?.output ?? (slot && "summary" in slot ? slot.summary?.error : undefined));
    const actions = messageActions(
      result?.entry,
      result?.message,
      toolCopies(
        toolInput(call.name, call.arguments).text,
        output,
        result ? resultDetails(result.message) : slot?.details,
      ),
    );
    actions.setAttribute("aria-label", "Tool actions");
    details.append(actions);
    for (const child of live?.nestedTools ?? [])
      if (child.parentCallId === call.id)
        details.append(
          buildTool({ id: child.callId, name: child.name, arguments: child.arguments }),
        );
    // Stable disclosure keys keep input/output expansion independent when a
    // running call gains its result or a sibling finishes out of order.
    details.querySelectorAll("details:not([data-disclosure])").forEach((node, index) => {
      (node as HTMLElement).dataset.disclosure = `result:${call.id}:${index}`;
    });
    return details;
  };
  const toolState = (message: Message) =>
    message.role === "assistant"
      ? message.content
          .filter((block) => block.type === "toolCall")
          .map((call) => [
            // Busy only affects calls without a result or a live slot. Completed
            // history must not be rebuilt when an unrelated run starts/stops.
            !results.has(call.id) && !slots.some((slot) => slot.callId === call.id)
              ? busy
              : undefined,
            results.get(call.id),
            slots.filter(
              (slot) => slot.callId === call.id || slot.callId.startsWith(`${call.id}/`),
            ),
          ])
      : undefined;
  for (const entry of [...entries.values()].sort((a, b) => a.id - b.id)) {
    if (entry.kind === "pi.reset" || entry.kind === "pi.compaction")
      item(`context:${entry.id}`, entry, (node) => {
        const details = document.createElement("details");
        const summary = document.createElement("summary");
        summary.textContent = entry.kind === "pi.reset" ? "Context reset" : "Context compacted";
        details.append(
          summary,
          codeBlock(JSON.stringify(entry.data ?? {}, null, 2), "json", details),
        );
        node.append(details);
      });
    entry.model?.forEach((message, index) => {
      if (message.role === "toolResult" && calls.has(message.toolCallId)) return;
      if (message.role !== "system")
        item(`${entry.id}:${index}`, [message, toolState(message)], (node) => {
          if (message.role === "toolResult") {
            node.dataset.role = "toolResult";
            node.append(
              buildTool({ id: message.toolCallId, name: message.toolName, arguments: {} }),
            );
          } else content(node, message, undefined, buildTool);
          const resultText =
            message.role === "assistant"
              ? message.content
                  .flatMap((block) => {
                    const result = block.type === "toolCall" ? results.get(block.id) : undefined;
                    return result ? [messageText(result.message)] : [];
                  })
                  .join("\n")
              : "";
          node.dataset.search = `${messageText(message)}\n${resultText}`.toLocaleLowerCase();
          const heading = node.querySelector("header");
          heading?.insertBefore(
            messageActions(entry.id, message),
            heading.querySelector(".message-time"),
          );
        });
    });
  }
  if (partial)
    item("partial", [partial, toolState(partial)], (node) =>
      content(node, partial, undefined, buildTool),
    );
  for (const tool of slots) {
    if (calls.has(tool.callId) || results.has(tool.callId)) continue;
    if (
      "parentCallId" in tool &&
      (calls.has(tool.parentCallId) || slots.some((parent) => parent.callId === tool.parentCallId))
    )
      continue;
    item(`tool:${tool.callId}`, [tool, live?.nestedTools], (node) => {
      node.dataset.role = "toolResult";
      node.append(
        buildTool({
          id: tool.callId,
          name: tool.name,
          arguments: "arguments" in tool ? tool.arguments : {},
        }),
      );
    });
  }
  for (const [key, value] of rendered) {
    if (!wanted.has(key)) {
      value.node.remove();
      rendered.delete(key);
    }
  }
  let previousRole: string | undefined;
  ordered.forEach((node, index) => {
    // Tool output belongs to the assistant visually; context markers break a group.
    const role = node.dataset.role === "toolResult" ? "assistant" : node.dataset.role;
    const sameSpeaker = role !== undefined && role === previousRole;
    if (node.classList.contains("same-speaker") !== sameSpeaker)
      node.classList.toggle("same-speaker", sameSpeaker);
    previousRole = role;
    // A sibling :has() selector invalidates the whole transcript on each
    // streamed child mutation. Record this relationship only when it changes.
    const next = ordered[index + 1];
    const nextRole = next?.dataset.role === "toolResult" ? "assistant" : next?.dataset.role;
    const traceContinues =
      role !== undefined &&
      role === nextRole &&
      !!node.lastElementChild?.matches(".tool-call, .thinking") &&
      !!next?.querySelector(":scope > :is(.tool-call, .thinking):is(:first-child, header + *)");
    if (node.classList.contains("trace-continues") !== traceContinues)
      node.classList.toggle("trace-continues", traceContinues);
    if (transcript.children[index] !== node)
      transcript.insertBefore(node, transcript.children[index] ?? null);
  });
  if (wasEmpty !== !transcript.childElementCount) resizePrompt();
  if (stick) transcript.scrollTop = transcript.scrollHeight;
  if (!searchBar.hidden) updateSearch();
  updateLatest();
  renderFooter();
  controls();
}

function attach(id: string, branch?: number): void {
  saveDraft();
  closePopovers();
  selectedMessage = undefined;
  closeSearch();
  source?.close();
  conversation = branch;
  images = [];
  showAttachments();
  latest = undefined;
  repository = undefined;
  bottomLine.hidden = true;
  usageDialog.close();
  generation++;
  active = id;
  prompt.value = loadDraft();
  notice.hidden = true;
  connected = false;
  busy = false;
  recovering = false;
  entries.clear();
  rendered.clear();
  transcript.replaceChildren();
  resizePrompt();
  picker.close();
  history.replaceState(
    null,
    "",
    `/?session=${encodeURIComponent(id)}${branch === undefined ? "" : `&conversation=${branch}`}`,
  );
  void refreshBranches().catch(report);
  void refreshRepository();
  for (const button of sessions.querySelectorAll("button"))
    button.setAttribute("aria-current", String(button.dataset.session === id));
  const currentGeneration = generation;
  source = new EventSource(endpoint("events"));
  source.onopen = () => {
    if (currentGeneration === generation) {
      connected = true;
      controls();
    }
  };
  source.onmessage = (event) => {
    if (currentGeneration !== generation) return;
    try {
      render(JSON.parse(event.data) as Snapshot);
    } catch (error) {
      report(error);
    }
  };
  source.onerror = () => {
    if (currentGeneration !== generation) return;
    connected = false;
    controls();
  };
  controls();
}

targets.onchange = () => {
  create.disabled = !targets.value || !models.value;
};
models.onchange = () => {
  fillThinking(newThinking, models, "", true);
  create.disabled = !targets.value || !models.value;
};
create.onclick = () => {
  create.disabled = true;
  const id = requestId();
  void api<SessionInfo>("/api/sessions", {
    id,
    binding: catalog.targets.find((target) => targetKey(target) === targets.value),
    model: models.value ? catalog.models[Number(models.value)] : undefined,
    thinkingLevel: newThinking.value || undefined,
  })
    .then((session) => {
      sessionFilter.value = "";
      attach(session.id);
      return refresh();
    })
    .catch(report)
    .finally(() => {
      create.disabled = !targets.value || !models.value;
    });
};
composer.onsubmit = (event) => {
  event.preventDefault();
  if (send.disabled || !active) return;
  const text = prompt.value;
  if (
    pending?.session !== active ||
    pending.conversation !== conversation ||
    pending.text !== text ||
    pending.mode !== submissionMode ||
    pending.images !== images
  )
    pending = {
      session: active,
      conversation,
      text,
      mode: submissionMode,
      requestId: requestId(),
      images,
    };
  const submission = pending;
  sending = true;
  notice.hidden = true;
  controls();
  void api(endpoint("prompt"), submission)
    .then(() => {
      if (
        active === submission.session &&
        conversation === submission.conversation &&
        prompt.value === text
      ) {
        prompt.value = "";
        resizePrompt();
        images = [];
        showAttachments();
        saveDraft();
      }
      if (pending === submission) pending = undefined;
    })
    .catch(report)
    .finally(() => {
      sending = false;
      controls();
    });
};
prompt.oninput = () => {
  resizePrompt();
  saveDraft();
  controls();
};
modeToggle.onclick = () => {
  submissionMode = submissionMode === "followUp" ? "steer" : "followUp";
  controls();
};
prompt.onkeydown = (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    composer.requestSubmit();
  }
};
stop.onclick = () => {
  if (active) void api(endpoint("stop"), {}).catch(report);
};
resume.onclick = () => {
  const id = active;
  if (id)
    void api(`/api/sessions/${id}/resume`, {})
      .then(() => {
        if (active === id) {
          recovering = false;
          controls();
        }
      })
      .catch(report);
};
element("refresh", HTMLButtonElement).onclick = () => {
  void refresh().catch(report);
};
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    void refreshRepository();
    void refresh().catch(report);
  }
});
window.addEventListener("pagehide", () => {
  source?.close();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted && active) attach(active, conversation);
});
void refresh()
  .then(() => {
    const id = new URL(location.href).searchParams.get("session");
    if (id && catalog.sessions.some((session) => session.id === id)) {
      const branch = new URL(location.href).searchParams.get("conversation");
      attach(id, branch === null ? undefined : Number(branch));
    } else picker.showModal();
  })
  .catch(report);
controls();

function draftKey(): string {
  return `pi.draft:${active ?? "new"}:${conversation ?? "main"}`;
}
function saveDraft(): void {
  try {
    sessionStorage.setItem(draftKey(), prompt.value);
  } catch {
    /* Storage can be disabled by browser policy. */
  }
}
function loadDraft(): string {
  try {
    return sessionStorage.getItem(draftKey()) ?? "";
  } catch {
    return "";
  }
}
notice.onclick = () => {
  notice.hidden = true;
};
branches.onchange = () => {
  if (active) {
    closePopovers();
    attach(active, Number(branches.value));
  }
};
function fillThinking(
  select: HTMLSelectElement,
  modelSelect: HTMLSelectElement,
  value?: string,
  inherit = false,
): void {
  const model = modelSelect.value ? catalog.models[Number(modelSelect.value)] : undefined;
  select.replaceChildren();
  if (inherit)
    chooseOption(
      select,
      "",
      model ? `Default (${model.defaultThinkingLevel})` : "Select a model first",
    );
  for (const level of model?.thinkingLevels ?? []) chooseOption(select, level, level);
  // Existing sessions can outlive a model capability change. Do not silently
  // replace their saved effort with the new-session default when opening a form.
  if (model && value && !model.thinkingLevels.some((level) => level === value) && !inherit)
    chooseOption(select, value, `${value} (will be clamped to model capabilities)`);
  select.value =
    inherit && (!value || !model?.thinkingLevels.some((level) => level === value))
      ? ""
      : value || model?.defaultThinkingLevel || "";
  select.disabled = !model;
}

const defaultModel = element("default-model", HTMLSelectElement);
const modelThinkingDefault = element("model-thinking-default", HTMLSelectElement);
function fillModelDefault(): void {
  modelThinkingDefault.replaceChildren();
  chooseOption(modelThinkingDefault, "", "Use global default");
  const model = defaultModel.value ? catalog.models[Number(defaultModel.value)] : undefined;
  for (const level of model?.thinkingLevels ?? []) chooseOption(modelThinkingDefault, level, level);
  const saved = model && editingSettings?.modelThinkingLevels[`${model.provider}/${model.modelId}`];
  // Keep a configured unsupported level visible: Pi will clamp it when starting.
  if (saved && !model?.thinkingLevels.includes(saved))
    chooseOption(modelThinkingDefault, saved, `${saved} (clamped by model)`);
  modelThinkingDefault.value = saved ?? "";
  modelThinkingDefault.disabled = !model;
}
defaultModel.onchange = fillModelDefault;
function openGlobalSettings(): void {
  closePopovers();
  if (!globalSettings) return;
  editingSettings = globalSettings;
  globalPreferences.querySelector(".dialog-error")?.remove();
  defaultModel.replaceChildren();
  chooseOption(
    defaultModel,
    "",
    globalSettings.model
      ? `Keep configured model: ${globalSettings.model.provider}/${globalSettings.model.modelId} (keep)`
      : "No configured default (keep)",
  );
  catalog.models.forEach((model, index) =>
    chooseOption(defaultModel, String(index), `${model.provider} / ${model.name}`),
  );
  const index = catalog.models.findIndex(
    (model) =>
      model.provider === globalSettings?.model?.provider &&
      model.modelId === globalSettings.model.modelId,
  );
  defaultModel.value = index >= 0 ? String(index) : "";
  fillModelDefault();
  const fields = element("global-settings-fields", HTMLDivElement);
  fields.replaceChildren();
  let group = "";
  let parent: HTMLElement = fields;
  for (const field of settingFields) {
    if (field.group !== group) {
      group = field.group;
      const details = document.createElement("details");
      details.open = group === "New sessions";
      const summary = document.createElement("summary");
      summary.textContent = group;
      details.append(summary);
      fields.append(details);
      parent = details;
    }
    const label = document.createElement("label");
    const caption = document.createElement("span");
    caption.textContent = field.label;
    const input =
      "choices" in field || field.type === "boolean"
        ? document.createElement("select")
        : document.createElement("input");
    input.id = `default-${field.key}`;
    input.name = field.key;
    if (input instanceof HTMLSelectElement) {
      const choices = "choices" in field ? field.choices : ["true", "false"];
      for (const choice of choices)
        chooseOption(input, choice, choice === "true" ? "On" : choice === "false" ? "Off" : choice);
    } else {
      input.type = "number";
      input.min = "0";
      input.step = "1";
      input.readOnly = true;
    }
    input.value = String(globalSettings.values[field.key]);
    label.append(caption, input);
    parent.append(label);
  }
  globalPreferences.showModal();
}
element("global-settings", HTMLButtonElement).onclick = openGlobalSettings;
element("picker-defaults", HTMLButtonElement).onclick = openGlobalSettings;
element("close-global-settings", HTMLButtonElement).onclick = () => globalPreferences.close();
element("global-settings-form", HTMLFormElement).onsubmit = (event) => {
  event.preventDefault();
  const values: Record<string, string | boolean> = {};
  for (const field of settingFields) {
    if ("readonly" in field) continue;
    const value = element(`default-${field.key}`, HTMLSelectElement).value;
    if (value !== String(editingSettings?.values[field.key]))
      values[field.key] = "choices" in field ? value : value === "true";
  }
  const selected = defaultModel.value ? catalog.models[Number(defaultModel.value)] : undefined;
  const modelChanged =
    selected &&
    (selected.provider !== editingSettings?.model?.provider ||
      selected.modelId !== editingSettings.model.modelId);
  const overrideChanged =
    selected &&
    modelThinkingDefault.value !==
      (editingSettings?.modelThinkingLevels[`${selected.provider}/${selected.modelId}`] ?? "");
  const button = element("save-global-settings", HTMLButtonElement);
  button.disabled = true;
  void api<GlobalSettings>("/api/settings", {
    values,
    ...(selected && (modelChanged || overrideChanged)
      ? {
          model: selected,
          ...(overrideChanged ? { modelThinkingLevel: modelThinkingDefault.value || null } : {}),
        }
      : {}),
  })
    .then(async (saved) => {
      globalSettings = saved;
      // An explicit default change should be reflected in the new-session picker.
      if (modelChanged) {
        models.value = "";
        newThinking.value = "";
      }
      await refresh();
      globalPreferences.close();
    })
    .catch(report)
    .finally(() => {
      button.disabled = false;
    });
};

element("settings", HTMLButtonElement).onclick = () => {
  closePopovers();
  preferences.querySelector(".dialog-error")?.remove();
  const agent = latest?.view.docs["pi.agent"] as AgentState | undefined;
  element("session-name", HTMLInputElement).value = latest?.session.name ?? "";
  sessionModel.replaceChildren();
  chooseOption(
    sessionModel,
    "",
    agent?.model
      ? `${agent.model.provider} / ${agent.model.modelId} (unavailable)`
      : "Select a model",
    true,
  );
  catalog.models.forEach((model, index) =>
    chooseOption(sessionModel, String(index), `${model.provider} / ${model.name}`),
  );
  sessionModel.value = String(
    catalog.models.findIndex(
      (model) =>
        model.provider === agent?.model?.provider && model.modelId === agent?.model?.modelId,
    ),
  );
  fillThinking(thinking, sessionModel, agent?.thinkingLevel ?? "off");
  instructions.value = agent?.instructions ?? "";
  preferences.showModal();
};
sessionModel.onchange = () => fillThinking(thinking, sessionModel);
element("close-settings", HTMLButtonElement).onclick = () => preferences.close();
element("save-settings", HTMLButtonElement).onclick = () => {
  if (!sessionModel.value || !thinking.value) return report("Select an available model.");
  const id = active;
  const branch = conversation;
  const renameURL = endpoint("rename");
  const name = element("session-name", HTMLInputElement).value;
  const save = element("save-settings", HTMLButtonElement);
  save.disabled = true;
  void api(endpoint("configure"), {
    model: catalog.models[Number(sessionModel.value)],
    thinkingLevel: thinking.value,
    instructions: instructions.value,
  })
    .then(() => api<SessionInfo>(renameURL, { name }))
    .then((session) => {
      if (active === id && conversation === branch && latest) render({ ...latest, session });
      preferences.close();
      return refresh();
    })
    .catch(report)
    .finally(() => {
      save.disabled = false;
    });
};
for (const action of ["compact", "reset"])
  element(action, HTMLButtonElement).onclick = () => {
    if (action === "reset" && !confirm("Start a new model context? History is preserved.")) return;
    const text = element("handoff", HTMLTextAreaElement).value.trim();
    void api(
      endpoint(action),
      text ? { [action === "reset" ? "handoff" : "instructions"]: text } : {},
    )
      .then(() => preferences.close())
      .catch((error) => {
        preferences.close();
        report(error);
      });
  };
element("export", HTMLButtonElement).onclick = () => {
  void api<EntryRecord[]>(endpoint("export"))
    .then((records) => {
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(records, null, 2)], { type: "application/json" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `pi-${active}-${conversation ?? "main"}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    })
    .catch(report);
};
window.addEventListener("offline", () => {
  connected = false;
  controls();
});
window.addEventListener("online", () => {
  if (active) attach(active, conversation);
  void refresh()
    .then(() => {
      if (active) return;
      const url = new URL(location.href);
      const id = url.searchParams.get("session");
      if (id && catalog.sessions.some((session) => session.id === id)) {
        const branch = url.searchParams.get("conversation");
        attach(id, branch === null ? undefined : Number(branch));
      }
    })
    .catch(report);
});
if ("serviceWorker" in navigator && isSecureContext) {
  void navigator.serviceWorker
    .register("/sw.js")
    .then((registration) => {
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        worker?.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller)
            report("Update ready. Close all Pi tabs and reopen to update.");
        });
      });
    })
    .catch(report);
}
interface InstallEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: string }>;
}
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  const install = element("install", HTMLButtonElement);
  install.hidden = false;
  install.onclick = () => {
    void (event as InstallEvent)
      .prompt()
      .then(() => (event as InstallEvent).userChoice)
      .then(() => {
        install.hidden = true;
      })
      .catch(report);
  };
});

function showAttachments(): void {
  const list = element("attachments", HTMLDivElement);
  list.replaceChildren();
  images.forEach((image, index) => {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = `${image.name} ×`;
    remove.setAttribute("aria-label", `Remove ${image.name}`);
    remove.onclick = () => {
      images = images.filter((_, i) => i !== index);
      showAttachments();
    };
    list.append(remove);
  });
}
const imageInput = element("images", HTMLInputElement);
element("input-toggle", HTMLButtonElement).onclick = (event) => {
  if (matchMedia("(max-width: 650px)").matches) {
    event.preventDefault();
    imageInput.click();
  }
};
element("attach", HTMLButtonElement).onclick = () => imageInput.click();
imageInput.onchange = () => {
  const files = Array.from(imageInput.files ?? []);
  imageInput.value = "";
  addImages(files);
};
prompt.onpaste = (event) => {
  const files = Array.from(event.clipboardData?.files ?? []).filter((file) =>
    file.type.startsWith("image/"),
  );
  if (!files.length) return;
  if (!event.clipboardData?.getData("text/plain")) event.preventDefault();
  addImages(files);
};
function addImages(files: File[]): void {
  if (
    images.length + files.length > 4 ||
    files.reduce((sum, file) => sum + file.size, 0) +
      images.reduce((sum, image) => sum + image.data.length * 0.75, 0) >
      5 * 1024 * 1024
  )
    return report("Attach up to four images, totaling at most 5 MiB.");
  const id = active,
    branch = conversation;
  void Promise.all(
    files.map(
      (file) =>
        new Promise<ImageContent & { name: string }>((resolve, reject) => {
          if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type))
            return reject(new Error("Unsupported image type."));
          const reader = new FileReader();
          reader.onerror = () => reject(reader.error);
          reader.onload = () => {
            if (typeof reader.result !== "string")
              return reject(new Error("Could not read image."));
            resolve({
              type: "image",
              mimeType: file.type,
              data: reader.result.split(",")[1],
              name: file.name,
            });
          };
          reader.readAsDataURL(file);
        }),
    ),
  )
    .then((added) => {
      if (active !== id || conversation !== branch) return;
      images = [...images, ...added];
      showAttachments();
    })
    .catch(report);
}

function resizePrompt(): void {
  prompt.style.height = "auto";
  prompt.style.height = `${prompt.scrollHeight}px`;
}
function closePopovers(): void {
  for (const popover of [menu, appMenu, messageMenu, inputMenu]) popover.hidePopover();
}
function openPicker(): void {
  closePopovers();
  picker.querySelector(".dialog-error")?.remove();
  picker.showModal();
  void refresh().catch(report);
}
element("workspace", HTMLButtonElement).onclick = openPicker;
element("close-picker", HTMLButtonElement).onclick = () => picker.close();
sessionFilter.oninput = renderSessions;
installPickerKeyMappings(picker);
installSelectKeyMappings(document);
for (const popover of [menu, appMenu, inputMenu])
  popover.addEventListener("click", (event) => {
    if (
      event.target instanceof Element &&
      event.target.closest("button")?.id !== "wrap-code" &&
      event.target.closest("button")
    )
      popover.hidePopover();
  });
// Manual dismissal keeps the release of a long press from immediately closing
// the menu (automatic popover light-dismiss runs on that same pointer release).
document.addEventListener("pointerdown", (event) => {
  if (
    messageMenu.matches(":popover-open") &&
    event.target instanceof Node &&
    !messageMenu.contains(event.target) &&
    !selectedMessage?.trigger.contains(event.target)
  )
    messageMenu.hidePopover();
});
for (const popover of [menu, appMenu, inputMenu])
  popover.addEventListener("beforetoggle", (event) => {
    if (event.newState === "open") messageMenu.hidePopover();
  });
messageMenu.addEventListener("toggle", () => {
  if (!messageMenu.matches(":popover-open"))
    selectedMessage?.trigger.setAttribute("aria-expanded", "false");
});
for (const popover of [menu, appMenu, messageMenu, inputMenu])
  popover.addEventListener("keydown", (event) => {
    const direction = navigationDirection(event);
    if (
      (!direction && !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) ||
      event.target instanceof HTMLSelectElement
    )
      return;
    const buttons = Array.from(
      popover.querySelectorAll<HTMLButtonElement>("button:not(:disabled):not([hidden])"),
    );
    if (!buttons.length) return;
    if (direction) {
      event.preventDefault();
      moveFocus(buttons, direction);
      return;
    }
    const index = buttons.findIndex((button) => button === document.activeElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
    event.preventDefault();
    buttons[next].focus();
  });
window.addEventListener("resize", () => {
  closePopovers();
  messageMenu.style.removeProperty("top");
  messageMenu.style.removeProperty("right");
  resizePrompt();
  updateLatest();
});
function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  let text = message.content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "thinking") return block.thinking;
      if (block.type === "toolCall")
        return `${block.name}\n${JSON.stringify(block.arguments, null, 2)}`;
      return "[image]";
    })
    .join("\n\n");
  if (message.role === "toolResult" && message.nestedCalls)
    text += `\n\n${JSON.stringify(message.nestedCalls, null, 2)}`;
  if (message.role === "toolResult" && "details" in message && message.details) {
    const data = message.details;
    const patch =
      typeof data === "object" && "patch" in data && typeof data.patch === "string"
        ? data.patch
        : JSON.stringify(data, null, 2);
    return `${text}\n\n${patch}`;
  }
  return text;
}
element("copy-message", HTMLButtonElement).onclick = () => {
  if (selectedMessage?.message) copyText(messageText(selectedMessage.message));
};
element("quote-message", HTMLButtonElement).onclick = () => {
  if (!selectedMessage?.message) return;
  const quoted = messageText(selectedMessage.message)
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  if (prompt.value.length + quoted.length + 4 > prompt.maxLength)
    return report("Quote exceeds the message limit.");
  prompt.value += `${prompt.value ? "\n\n" : ""}${quoted}\n\n`;
  messageMenu.hidePopover();
  resizePrompt();
  prompt.focus();
  saveDraft();
  controls();
};
element("fork-message", HTMLButtonElement).onclick = () => {
  const selected = selectedMessage;
  if (
    !selected ||
    selected.entry === undefined ||
    selected.session !== active ||
    selected.branch !== conversation
  )
    return;
  messageMenu.hidePopover();
  void api<{ id: number }>(endpoint("fork"), { entry: selected.entry })
    .then((result) => {
      if (active === selected.session && conversation === selected.branch)
        attach(selected.session, result.id);
    })
    .catch(report);
};
const wrap = element("wrap-code", HTMLButtonElement);
function setWrap(value: boolean): void {
  document.body.classList.toggle("wrap-code", value);
  wrap.setAttribute("aria-pressed", String(value));
  const indicator = wrap.querySelector("span");
  if (indicator) indicator.textContent = value ? "On" : "Off";
}
try {
  setWrap(localStorage.getItem("pi.wrapCode") === "true");
} catch {
  /* Browser storage may be disabled. */
}
wrap.onclick = () => {
  const value = !document.body.classList.contains("wrap-code");
  setWrap(value);
  try {
    localStorage.setItem("pi.wrapCode", String(value));
  } catch {
    /* Browser storage may be disabled. */
  }
};
function updateLatest(): void {
  element("latest", HTMLButtonElement).hidden =
    transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 100;
}
transcript.addEventListener("scroll", updateLatest);
element("latest", HTMLButtonElement).onclick = () => {
  transcript.scrollTop = transcript.scrollHeight;
  updateLatest();
};
function updateSearch(): void {
  const current = matches[matchIndex];
  const query = search.value.trim().toLocaleLowerCase();
  matches = [];
  const ranges: Range[] = [];
  for (const article of transcript.querySelectorAll("article")) {
    const found = !searchBar.hidden && !!query && (article.dataset.search ?? "").includes(query);
    article.classList.toggle("search-hit", found);
    article.classList.remove("search-current");
    if (found) {
      matches.push(article);
      // Keep syntax markup intact while highlighting matching text.
      const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.parentElement?.closest("header, button")) continue;
        const pattern = new RegExp(
          search.value.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          "giu",
        );
        for (const match of (node.textContent ?? "").matchAll(pattern)) {
          if (ranges.length >= 2000) break;
          const range = document.createRange();
          range.setStart(node, match.index);
          range.setEnd(node, match.index + match[0].length);
          ranges.push(range);
        }
      }
    }
  }
  if (typeof Highlight !== "undefined" && CSS.highlights) {
    const highlight = new Highlight();
    for (const range of ranges) highlight.add(range);
    CSS.highlights.set("pi-search", highlight);
  }
  matchIndex = Math.max(
    0,
    matches.findIndex((node) => node === current),
  );
  matches[matchIndex]?.classList.add("search-current");
  element("search-count", HTMLSpanElement).textContent = query
    ? `${matches.length ? matchIndex + 1 : 0} / ${matches.length}`
    : "";
  for (const id of ["search-prev", "search-next"])
    element(id, HTMLButtonElement).disabled = !matches.length;
}
function goToMatch(direction: number): void {
  if (!matches.length) return;
  matches[matchIndex]?.classList.remove("search-current");
  matchIndex = (matchIndex + direction + matches.length) % matches.length;
  const node = matches[matchIndex];
  node.classList.add("search-current");
  for (const details of node.querySelectorAll("details"))
    if (details.textContent?.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()))
      details.open = true;
  node.scrollIntoView({ block: "center" });
  element("search-count", HTMLSpanElement).textContent = `${matchIndex + 1} / ${matches.length}`;
}
function openSearch(): void {
  if (!active) return;
  closePopovers();
  searchBar.hidden = false;
  search.focus();
  search.select();
  updateSearch();
}
function closeSearch(): void {
  searchBar.hidden = true;
  search.value = "";
  updateSearch();
}
element("find", HTMLButtonElement).onclick = openSearch;
search.oninput = () => {
  updateSearch();
  goToMatch(0);
};
search.onkeydown = (event) => {
  const direction = navigationDirection(event);
  if (direction) {
    event.preventDefault();
    goToMatch(direction);
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    closeSearch();
    prompt.focus();
  }
  if (event.key === "Enter") {
    event.preventDefault();
    goToMatch(event.shiftKey ? -1 : 1);
  }
};
element("search-prev", HTMLButtonElement).onclick = () => goToMatch(-1);
element("search-next", HTMLButtonElement).onclick = () => goToMatch(1);
element("search-close", HTMLButtonElement).onclick = () => {
  closeSearch();
  prompt.focus();
};
document.addEventListener("keydown", (event) => {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.altKey ||
    event.shiftKey ||
    !(event.metaKey || event.ctrlKey) ||
    preferences.open ||
    globalPreferences.open ||
    picker.open ||
    usageDialog.open
  )
    return;
  if (event.key.toLowerCase() === "k") {
    event.preventDefault();
    openPicker();
  }
  if (event.key.toLowerCase() === "f" && active) {
    event.preventDefault();
    openSearch();
  }
});

for (const popover of [menu, appMenu, inputMenu])
  popover.addEventListener("toggle", () => {
    if (popover.matches(":popover-open"))
      popover.querySelector<HTMLButtonElement>("button:not(:disabled):not([hidden])")?.focus();
  });
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && messageMenu.matches(":popover-open")) {
    event.preventDefault();
    messageMenu.hidePopover();
    const trigger = selectedMessage?.trigger;
    if (matchMedia("(hover: hover) and (pointer: fine)").matches) trigger?.focus();
    else {
      const summary = trigger
        ?.closest(".tool-call")
        ?.querySelector<HTMLElement>(":scope > summary");
      (summary ?? transcript).focus({ preventScroll: true });
    }
  }
});

const findShortcut = element("find", HTMLButtonElement).querySelector("kbd");
if (findShortcut)
  findShortcut.textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘ F" : "Ctrl F";

function compactTokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}M`;
}
function renderFooter(): void {
  if (!latest) return;
  bottomLine.hidden = false;
  const agent = latest.view.docs["pi.agent"] as AgentState | undefined;
  const model = agent?.model ?? latest.session.model;
  const thinking = agent?.thinkingLevel ?? latest.session.thinkingLevel;
  element("footer-model-name", HTMLSpanElement).textContent = model.modelId;
  element("footer-effort", HTMLSpanElement).textContent = thinking;
  element("footer-model", HTMLButtonElement).title =
    `${model.provider} / ${model.modelId} · thinking ${thinking}`;
  const usage = latest.view.docs["pi.usage"] as UsageState | undefined;
  const totals = [...Object.values(usage?.models ?? {}), ...Object.values(usage?.tools ?? {})];
  const sum = (key: "input" | "output" | "cacheRead" | "cacheWrite") =>
    totals.reduce((value, item) => value + item[key], 0);
  const cost = totals.reduce((value, item) => value + item.cost.total, 0);
  const binding = latest.session.binding;
  const workspace =
    binding.provider === "local"
      ? binding.cwd
      : `${binding.provider}/${binding.target} · ${binding.cwd}`;
  const set = (id: string, text: string) => {
    element(id, HTMLElement).textContent = text;
  };
  for (const [field, key, prefix] of [
    ["input", "input", "↑"],
    ["output", "output", "↓"],
    ["read", "cacheRead", "R"],
  ] as const) {
    const value = sum(key);
    const node = element(`footer-${field}`, HTMLSpanElement);
    node.textContent = `${prefix}${compactTokens(value)}`;
    node.dataset.value = String(value);
    node.title = `${field === "read" ? "Cache " : ""}${field}: ${value.toLocaleString()} tokens`;
    set(`usage-${field}`, value.toLocaleString());
  }
  set("usage-write", sum("cacheWrite").toLocaleString());
  const { window: limit, lastResponse, autoCompact } = latest.context;
  const hit = lastResponse?.cacheHit;
  const tokens = lastResponse?.tokens;
  const percent = tokens !== undefined && limit ? (tokens / limit) * 100 : undefined;
  const contextText = `${percent === undefined ? "—" : percent.toFixed(1) + "%"}/${limit ? compactTokens(limit) : "?"}${autoCompact ? " (auto)" : ""}`;
  const contextButton = element("footer-context", HTMLButtonElement);
  contextButton.textContent = contextText;
  contextButton.dataset.level =
    percent !== undefined && percent > 90
      ? "critical"
      : percent !== undefined && percent > 70
        ? "warning"
        : "normal";
  contextButton.dataset.tokens = tokens === undefined ? "" : String(tokens);
  contextButton.title = `Context at last completed response: ${tokens?.toLocaleString() ?? "unknown"} / ${limit?.toLocaleString() ?? "unknown"} tokens. ${autoCompact ? "Automatic compaction enabled." : "Automatic compaction disabled."}`;
  const hitNode = element("footer-hit", HTMLSpanElement);
  hitNode.textContent = hit == null ? "CH—" : `CH${hit.toFixed(1)}%`;
  hitNode.title = "Cache hit rate at the last completed response";
  const costNode = element("footer-cost", HTMLSpanElement);
  costNode.textContent = `$${cost.toFixed(3)}`;
  costNode.dataset.value = String(cost);
  costNode.title = "Estimated cost (USD), not a subscription balance";
  set("usage-workspace", workspace);
  set(
    "usage-repository",
    repository?.state === "repository"
      ? `${repository.branch ?? "Detached HEAD"}${repository.revision ? ` · ${repository.revision}` : " · no commits"}`
      : repository?.state === "none"
        ? "Not a Git repository"
        : repository?.state === "unavailable"
          ? "Unavailable"
          : "Checking…",
  );
  set("usage-model", `${model.provider} / ${model.modelId}`);
  set("usage-thinking", thinking);
  set("usage-hit", hit == null ? "Unknown" : `${hit.toFixed(1)}%`);
  set("usage-cost", `$${cost.toFixed(3)}`);
  set(
    "usage-context",
    tokens === undefined
      ? "Unknown until a response in this context"
      : `${tokens.toLocaleString()} tokens${percent === undefined ? "" : ` · ${percent.toFixed(1)}%`}`,
  );
  set("usage-window", limit ? `${limit.toLocaleString()} tokens` : "Unknown");
  set("usage-auto", autoCompact ? "On" : "Off");
}
async function refreshRepository(): Promise<void> {
  const current = generation;
  if (!active || document.hidden || repositoryRequest === current) return;
  repositoryRequest = current;
  try {
    const result = await api<RepositoryStatus>(endpoint("repository"));
    if (current !== generation) return;
    repository = result;
  } catch {
    if (current !== generation) return;
    repository = { state: "unavailable" };
  } finally {
    if (repositoryRequest === current) repositoryRequest = -1;
  }
  renderFooter();
}
for (const id of ["footer-stats", "footer-context"])
  element(id, HTMLButtonElement).onclick = () => {
    closePopovers();
    usageDialog.showModal();
    void refreshRepository();
  };
element("footer-model", HTMLButtonElement).onclick = () =>
  element("settings", HTMLButtonElement).click();
element("close-usage", HTMLButtonElement).onclick = () => usageDialog.close();
setInterval(() => {
  if (active && connected && !document.hidden) void refreshRepository();
}, 30_000);
