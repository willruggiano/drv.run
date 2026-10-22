import type { CompactionResult, TaskRecord, SubmissionRecord } from "@earendil-works/pi-durable";
import type { ContextInspection } from "./inspection.ts";
import type { ConversationView, Page, Cursor } from "@earendil-works/pi-durable";
import { settingFields, type GlobalSettings } from "./settings.ts";
import { commands, installCompletions } from "./completions.ts";
import {
  installPickerKeyMappings,
  installSelectKeyMappings,
  navigationDirection,
  moveFocus,
} from "./key-mappings.ts";
import type { ContextPart } from "./inspection.ts";
import type { ImageContent, Message } from "@earendil-works/pi-ai";
import type {
  AgentState,
  ConversationRecord,
  EntryRecord,
  InboxState,
  LiveState,
  UsageState,
} from "@earendil-works/pi-durable";
import type { Catalog, ContextStatus, ExecutionBinding, SessionInfo } from "./sessions.ts";

export type RenderState = {
  session: SessionInfo;
  view: ConversationView;
  context: ContextStatus;
  inspection: ContextInspection;
  history?: readonly EntryRecord[];
  /** Durable compaction task durations, keyed by the resulting entry. */
  contextDurations?: Record<number, number>;
};

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
const branches = element("branches", HTMLDivElement);
const preferences = element("preferences", HTMLElement);
const globalPreferences = element("global-preferences", HTMLElement);
const newThinking = element("new-thinking", HTMLSelectElement);
let globalSettings: GlobalSettings | null = null;
let editingSettings: GlobalSettings | null = null;
const contextView = element("context-view", HTMLElement);
const bottomLine = element("bottom-line", HTMLElement);
const sessionModel = element("session-model", HTMLSelectElement);
const thinking = element("thinking", HTMLSelectElement);
const instructions = element("instructions", HTMLTextAreaElement);
let conversation: number | undefined;
let latest: RenderState | undefined;
let images: (ImageContent & { name: string })[] = [];
const targets = element("targets", HTMLSelectElement);
const models = element("models", HTMLSelectElement);
const sessions = element("sessions", HTMLDivElement);
const transcript = element("transcript", HTMLDivElement);
const landing = element("landing", HTMLElement);
const recentSessions = element("recent-sessions", HTMLDivElement);
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
const picker = element("picker", HTMLElement);
const messageMenu = element("message-menu", HTMLDivElement);
const inputMenu = element("input-menu", HTMLDivElement);
const sessionFilter = element("session-filter", HTMLTextAreaElement);
const search = element("search", HTMLTextAreaElement);
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
let observation: AbortController | undefined;
let generation = 0;
let busy = false;
let recovering = false;
let connected = false;
let sending = false;
let creating = false;
let pending:
  | {
      session: string;
      conversation: number | undefined;
      text: string;
      mode: string;
      requestId: string;
      images: ImageContent[];
      sourceDraft?: { key: string; text: string };
    }
  | undefined;
const entries = new Map<number, EntryRecord>();
const rendered = new Map<string, { node: HTMLElement; signature: string }>();
const archives = new WeakMap<HTMLElement, HTMLElement>();
let archiveStyles: CSSStyleSheet | undefined;

function archive(): HTMLElement {
  const host = document.createElement("div");
  host.className = "context-history";
  const root = host.attachShadow({ mode: "open" });
  // Share the exact application CSS, including highlighting and responsive
  // rules. Only the scroll container differs.
  if (!archiveStyles) {
    archiveStyles = new CSSStyleSheet();
    archiveStyles.replaceSync(
      Array.from(document.styleSheets)
        .flatMap((sheet) => Array.from(sheet.cssRules, (rule) => rule.cssText))
        .join("\n") +
        `
        #transcript { padding: 0; overflow: visible; scrollbar-gutter: auto; }
        `,
    );
  }
  root.adoptedStyleSheets = [archiveStyles];
  const body = document.createElement("div");
  body.id = "transcript";
  root.append(body);
  return host;
}

function reconcile(parent: HTMLElement, nodes: HTMLElement[]): void {
  nodes.forEach((node, index) => {
    if (parent.children[index] !== node) parent.insertBefore(node, parent.children[index] ?? null);
  });
  while (parent.children.length > nodes.length) parent.lastElementChild!.remove();
}

function composedParent(node: Node): Node | null {
  return node.parentNode ?? (node instanceof ShadowRoot ? node.host : null);
}

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
    ? "Offline: reconnect to load conversations."
    : error instanceof Error
      ? error.message
      : String(error);
  notice.textContent = message;
  notice.hidden = false;
}
async function api<T>(path: string, data?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    signal,
    ...(data === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  return result as T;
}
async function pages<T>(path: string, signal?: AbortSignal): Promise<T[]> {
  const result: T[] = [];
  let cursor: Cursor | undefined;
  do {
    const url = new URL(path, location.origin);
    const query = JSON.parse(url.searchParams.get("query") ?? "{}") as Record<string, unknown>;
    url.searchParams.set("query", JSON.stringify({ ...query, order: "ascending" }));
    if (cursor !== undefined) url.searchParams.set("cursor", JSON.stringify(cursor));
    const page = await api<Page<T, Cursor>>(url.pathname + url.search, undefined, signal);
    result.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  return result;
}

function controls(): void {
  const isCommand = prompt.value.startsWith("/");
  create.disabled = creating || sending || !targets.value || !models.value;
  send.hidden = !active && !isCommand;
  send.disabled =
    sending ||
    creating ||
    !prompt.value.trim() ||
    (!isCommand && (active ? !connected : create.disabled));
  stop.disabled = !active || !connected || !busy;
  stop.hidden = !busy;
  modeToggle.hidden = !busy;
  modeToggle.disabled = !active || !connected || sending;
  modeToggle.textContent = submissionMode === "steer" ? "Steer" : "Follow up";
  modeToggle.dataset.mode = submissionMode;
  modeToggle.setAttribute(
    "aria-label",
    `${modeToggle.textContent}. Switch to ${submissionMode === "steer" ? "Follow up" : "Steer"}`,
  );
  resume.disabled = !active || !connected || !recovering;
  recovery.hidden = !recovering;
  element("footer-model", HTMLButtonElement).disabled = !active || !connected;
  document.body.classList.toggle("offline", !navigator.onLine);
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
function targetKey(binding: ExecutionBinding | undefined): string {
  return binding ? JSON.stringify([binding.provider, binding.target, binding.cwd]) : "";
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
    catalog.models.length ? "Select a model" : "No models: you may need to /login on the host",
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
  updateDirectoryField();
  renderSessions();
  controls();
}
function sessionTitle(session: SessionInfo): string {
  return (
    session.name ||
    session.binding?.target.split("/").filter(Boolean).at(-1) ||
    session.binding?.provider ||
    "Session"
  );
}
function renderSessions(): void {
  if (!catalog) return;
  const focused = document.activeElement;
  const focusedSession =
    focused instanceof HTMLButtonElement && sessions.contains(focused)
      ? focused.dataset.session
      : undefined;
  sessions.replaceChildren();
  const query = sessionFilter.value.trim().toLocaleLowerCase();
  for (const session of catalog.sessions) {
    const target = catalog.targets.find((item) => targetKey(item) === targetKey(session.binding));
    const label =
      (target?.label ?? session.binding?.target) +
      (session.cwd && session.cwd !== session.binding?.cwd ? ` · ${session.cwd}` : "");
    if (
      query &&
      !`${sessionTitle(session)} ${label} ${session.id}`.toLocaleLowerCase().includes(query)
    )
      continue;
    const row = sessionRow(session);
    sessions.append(row);
    if (session.id === focusedSession) row.focus({ preventScroll: true });
  }
  recentSessions.replaceChildren(...catalog.sessions.slice(0, 5).map(sessionRow));
  element("recent-title", HTMLHeadingElement).hidden = catalog.sessions.length === 0;
  const empty = element("sessions-empty", HTMLParagraphElement);
  empty.hidden = !!sessions.childElementCount;
  empty.textContent = query ? "No matching sessions" : "No sessions";
}

function sessionRow(session: Catalog["sessions"][number]): HTMLButtonElement {
  const target = catalog.targets.find((item) => targetKey(item) === targetKey(session.binding));
  const label =
    (target?.label ?? session.binding?.target) +
    (session.cwd && session.cwd !== session.binding?.cwd ? ` · ${session.cwd}` : "");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "session";
  button.dataset.session = session.id;
  button.setAttribute("aria-current", String(session.id === active));
  const name = document.createElement("strong");
  name.textContent = sessionTitle(session);
  const heading = document.createElement("span");
  heading.className = "session-heading";
  const timestamp = document.createElement("time");
  const date = new Date(session.created);
  timestamp.dateTime = date.toISOString();
  timestamp.textContent = date.toLocaleDateString();
  timestamp.title = `Created ${date.toLocaleString()}`;
  heading.append(name, timestamp);
  const detail = document.createElement("span");
  detail.className = "session-detail";
  const environment = document.createElement("span");
  environment.className = "session-environment";
  environment.textContent = environmentText(session.binding, session.cwd);
  const model = document.createElement("span");
  model.className = "model-summary";
  renderModelSummary(model, session.model, session.thinkingLevel);
  const usage = document.createElement("span");
  usage.className = "context-usage";
  renderContextUsage(usage, session.context);
  detail.append(environment, summaryDot(), model, summaryDot(), usage);
  button.title = `${label}${target?.available ? "" : " · unavailable"}`;
  button.append(heading, detail);
  button.onclick = () => {
    void selectSession(session.id);
  };
  return button;
}

function codeBlock(text: string, language = "", disclosure?: HTMLDetailsElement): HTMLElement {
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.textContent = text;
  if (language && hljs.getLanguage(language)) {
    const highlight = () => {
      // highlight.js escapes all input before adding its own span markup.
      code.innerHTML = hljs.highlight(text, {
        language,
        ignoreIllegals: true,
      }).value;
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
  const upstream = [
    "submit",
    "abort",
    "resume",
    "configure",
    "compact",
    "reset",
    "abortSubmission",
    "fork",
    "scanConversations",
    "entries",
    "watch",
    "watchDoc",
    "context",
    "inspect",
  ].includes(action);
  return `/api/${upstream ? "harness" : "sessions"}/${active}/${action}${conversation === undefined ? "" : `?conversation=${conversation}`}`;
}
async function refreshBranches(): Promise<void> {
  const current = generation;
  const id = active;
  if (!id) return;
  const records = await pages<ConversationRecord>(endpoint("scanConversations"));
  const reviews = await Promise.all(
    records.map((record) =>
      api<{ original?: number } | null>(
        `/api/harness/${id}/snapshot?conversation=${record.id}&kind=app.review`,
      ),
    ),
  );
  if (current !== generation) return;
  // Keep existing buttons connected so a pending refresh cannot drop keyboard focus.
  const existing = new Map(
    Array.from(branches.querySelectorAll<HTMLButtonElement>("button")).map((button) => [
      button.dataset.conversation,
      button,
    ]),
  );
  records.forEach((record, index) => {
    const key = String(record.id);
    const button = existing.get(key) ?? document.createElement("button");
    existing.delete(key);
    button.type = "button";
    button.className = "session";
    button.dataset.conversation = String(record.id);
    button.setAttribute(
      "aria-current",
      String(conversation === undefined ? index === 0 : conversation === record.id),
    );
    const name = document.createElement("strong");
    const original = reviews[index]?.original;
    name.textContent =
      original !== undefined ? `Review ${record.id}` : index === 0 ? "Main" : `Branch ${record.id}`;
    button.replaceChildren(name);
    const parent = original ?? record.parent?.conversationId;
    if (parent !== undefined) {
      const detail = document.createElement("small");
      detail.textContent = `From ${parent}`;
      button.append(detail);
    }
    button.onclick = () => {
      void selectSession(id, index === 0 ? undefined : record.id);
    };
    if (branches.children[index] !== button)
      branches.insertBefore(button, branches.children[index] ?? null);
  });
  for (const button of existing.values()) button.remove();
}

function toolLabel(name: string, args: Record<string, unknown> = {}): string {
  const short = name.split(".").at(-1) ?? name;
  const path = typeof args.path === "string" ? args.path : "";
  if (short === "bash") {
    const command = typeof args.command === "string" ? args.command.trim() : "Shell command";
    return `$ ${command}`;
  }
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
      running: "",
      pending: "◷",
      failed: "✕",
      cancelled: "⊘",
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
      button.setAttribute("aria-label", label);
      button.title = label;
      button.append(element("copy-message", HTMLButtonElement).firstElementChild!.cloneNode(true));
      button.onclick = () => copyText(text);
      return button;
    });
    messageMenu.prepend(...buttons);
    element("copy-message", HTMLButtonElement).hidden = !message || copies.length > 0;
    element("quote-message", HTMLButtonElement).hidden = !message;
    const fork = element("fork-message", HTMLButtonElement);
    fork.hidden = entry === undefined;
    fork.disabled = !connected;
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
  if (!actions.isConnected) return;
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
  const actions = touchActions(event.composedPath()[0] ?? null);
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
  const actions = touchActions(event.composedPath()[0] ?? null);
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
      touchActions(event.composedPath()[0] ?? null) === heldActions
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      heldActions = undefined;
    }
  },
  true,
);

const messageTime = new Intl.DateTimeFormat([], {
  hour: "2-digit",
  minute: "2-digit",
});
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
  if (message.role === "toolResult") toolDetails(node, message.details);
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
export function render(snapshot: RenderState): void {
  const wasEmpty = !transcript.childElementCount;
  latest = snapshot;
  const agent = snapshot.view.docs["pi.agent"] as AgentState | undefined;
  const queue = element("queue", HTMLDivElement);
  const queueScroll = queue.scrollTop;
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
        void api(endpoint("abortSubmission"), { id: item.id }).catch(report);
      };
      row.append(cancel);
    }
    queue.append(row);
  }
  queue.hidden = !queue.childElementCount || (view !== "conversation" && view !== "search");
  queue.scrollTop = queueScroll;
  const stick =
    view === "conversation" &&
    transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80;
  for (const entry of [...(snapshot.history ?? []), ...snapshot.view.entries])
    entries.set(entry.id, entry);
  const live = snapshot.view.docs["pi.live"] as LiveState | undefined;
  busy = !!live?.run;
  recovering = snapshot.session.needsResume;
  const heading = `${snapshot.session.reviewOf === undefined ? "" : "Review · "}${sessionTitle(snapshot.session)}`;
  title.textContent = heading;
  if (view === "search") updateViewTitle();
  title.title = `${snapshot.session.binding?.provider} / ${snapshot.session.binding?.target} · ${agent?.model?.modelId ?? snapshot.session.model?.modelId}`;
  const activity = element("activity", HTMLDivElement);
  activity.textContent =
    live?.generation?.retry?.error ?? (live?.generation?.deferred ? "Waiting for provider…" : "");
  activity.hidden = !activity.textContent;
  document.title = `${busy ? "Working · " : ""}${heading}`;
  const wanted = new Set<string>();
  const ordered: HTMLElement[] = [];
  // A streamed assistant entry can be replaced by its committed entry. Keep
  // disclosure state by call ID across that transition as well as live updates.
  const disclosureState = new Map(
    Array.from(rendered.values())
      .flatMap(({ node }) =>
        Array.from(node.querySelectorAll<HTMLDetailsElement>("details[data-disclosure]")),
      )
      .map((detail) => [detail.dataset.disclosure, detail.open]),
  );
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
  const slots = live?.tools ?? [];
  const buildTool = (call: Call): HTMLElement => {
    const result = results.get(call.id);
    const slot = slots.find((tool) => tool.callId === call.id);
    const failed = result?.message.isError;
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
    const durationMs = result?.message.durationMs;
    details.append(toolSummary(toolCommand(call.name, call.arguments), state, durationMs));
    if (result) {
      const output = document.createElement("div");
      output.className = "tool-result";
      content(output, result.message, call, undefined, true);
      details.append(output);
    } else if (slot) {
      if (slot.output) details.append(codeBlock(slot.output));
      toolDetails(details, slot.details);
    }
    const output = result
      ? result.message.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n\n")
      : slot?.output;
    const actions = messageActions(
      result?.entry,
      result?.message,
      toolCopies(
        toolInput(call.name, call.arguments).text,
        output,
        result ? result.message.details : slot?.details,
      ),
    );
    actions.setAttribute("aria-label", "Tool actions");
    details.append(actions);
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
            slots.filter((slot) => slot.callId === call.id),
          ])
      : undefined;
  for (const entry of [...entries.values()].sort((a, b) => a.id - b.id)) {
    if (entry.kind === "pi.reset" || entry.kind === "pi.compaction")
      item(`context:${entry.id}`, [entry, snapshot.contextDurations?.[entry.id]], (node) => {
        node.dataset.context = entry.kind;
        const details = document.createElement("details");
        details.className = "tool-call context-event";
        details.dataset.state = "completed";
        details.dataset.disclosure = `context:${entry.id}`;
        const summary = toolSummary(
          entry.kind === "pi.reset" ? "Context reset" : "Context compacted",
          "completed",
          snapshot.contextDurations?.[entry.id],
        );
        summary.title =
          entry.kind === "pi.compaction"
            ? "Expand summary and prior conversation"
            : "Expand prior conversation";
        const host = archive();
        details.append(summary, host);
        archives.set(node, host.shadowRoot!.querySelector<HTMLElement>("#transcript")!);
        if (entry.kind === "pi.compaction" && entry.model?.length) {
          const summaryContent = document.createElement("div");
          summaryContent.className = "compaction-summary";
          for (const message of entry.model)
            content(summaryContent, message, undefined, undefined, true);
          details.insertBefore(summaryContent, host);
        }
        node.append(details);
      });
    if (entry.kind === "pi.compaction") continue;
    entry.model?.forEach((message, index) => {
      if (message.role === "toolResult" && calls.has(message.toolCallId)) return;
      if (message.role !== "system")
        item(`${entry.id}:${index}`, [message, toolState(message)], (node) => {
          if (message.role === "toolResult") {
            node.dataset.role = "toolResult";
            node.append(
              buildTool({
                id: message.toolCallId,
                name: message.toolName,
                arguments: {},
              }),
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
    item(`tool:${tool.callId}`, tool, (node) => {
      node.dataset.role = "toolResult";
      node.append(
        buildTool({
          id: tool.callId,
          name: tool.name,
          arguments: {},
        }),
      );
    });
  }
  for (const compaction of live?.compactions ?? [])
    item(`compacting:${compaction.taskId}`, compaction, (node) => {
      node.dataset.context = "pi.compaction";
      const details = document.createElement("details");
      details.className = "tool-call context-event";
      details.dataset.state = "running";
      details.append(toolSummary("Compacting context…", "running"));
      if (compaction.retry) details.append(codeBlock(compaction.retry.error));
      node.append(details);
    });
  if (live?.compactionFailure)
    item(`compaction-failed:${live.compactionFailure.taskId}`, live.compactionFailure, (node) => {
      node.dataset.context = "pi.compaction";
      const details = document.createElement("details");
      details.className = "tool-call context-event";
      details.dataset.state = "failed";
      details.append(
        toolSummary("Compaction failed", "failed"),
        codeBlock(live.compactionFailure!.error),
      );
      node.append(details);
    });
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
  });
  // Each successful boundary wraps everything before it, including older
  // archives. Moving nodes preserves disclosures and handlers.
  let visible: HTMLElement[] = [];
  for (const node of ordered) {
    const body = archives.get(node);
    if (body) {
      reconcile(body, visible);
      visible = [];
    }
    visible.push(node);
  }
  reconcile(transcript, visible);
  if (wasEmpty !== !transcript.childElementCount) resizePrompt();
  if (stick) transcript.scrollTop = transcript.scrollHeight;
  if (!searchBar.hidden) updateSearch();
  updateLatest();
  renderFooter();
  if (view === "context") renderContext();
  controls();
}

function attach(id: string, branch?: number): void {
  completions.close();
  saveDraft();
  closePopovers();
  selectedMessage = undefined;
  clearSearch();
  conversation = branch;
  images = [];
  showAttachments();
  latest = undefined;
  contextView.replaceChildren();
  contextRevision = "";
  bottomLine.hidden = true;
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
  element("queue", HTMLDivElement).replaceChildren();
  element("queue", HTMLDivElement).hidden = true;
  resizePrompt();
  history.replaceState(
    null,
    "",
    `/?session=${encodeURIComponent(id)}${branch === undefined ? "" : `&conversation=${branch}`}`,
  );
  void refreshBranches().catch(report);
  for (const button of sessions.querySelectorAll("button"))
    button.setAttribute("aria-current", String(button.dataset.session === id));
  connectEvents();
  setView(view);
}

function disconnectEvents(): void {
  observation?.abort();
}

function connectEvents(): void {
  disconnectEvents();
  observation = new AbortController();
  const { signal } = observation;
  const watchPath = endpoint("watch");
  const infoPath = endpoint("info");
  const statusPath = endpoint("context-status");
  const inspectionPath = endpoint("inspection");
  const historyPath = endpoint("entries");
  const source = new EventSource(watchPath);
  const documents = new Map<string, EventSource>();
  signal.addEventListener(
    "abort",
    () => {
      source.close();
      for (const document of documents.values()) document.close();
    },
    { once: true },
  );
  let currentView: ConversationView | undefined;
  let refreshing = false;
  let dirty = false;
  let needsHistory = true;
  const saved = new Map<number, EntryRecord>();
  const failed = (error: unknown) => {
    if (!signal.aborted) report(error);
  };
  const contextDurations: Record<number, number> = {};
  async function timings(entries: readonly EntryRecord[]) {
    if (
      !entries.some(
        (entry) => entry.kind === "pi.compaction" && contextDurations[entry.id] === undefined,
      )
    )
      return;
    const base = watchPath.split("?")[0].replace(/\/watch$/, "");
    // CompactionResult identifies both directly appended and queued summaries.
    const tasks = await pages<TaskRecord<unknown, unknown, CompactionResult>>(
      `${base}/scanTasks?query=${encodeURIComponent(JSON.stringify({ kind: "pi.compaction" }))}`,
      signal,
    );
    for (const task of tasks) {
      if (
        task.state.status !== "terminal" ||
        task.state.outcome.status !== "completed" ||
        task.startedAt === undefined ||
        task.endedAt === undefined
      )
        continue;
      const { entryId, submissionId } = task.state.outcome.result;
      const id =
        entryId ??
        (submissionId === undefined
          ? undefined
          : (
              await api<SubmissionRecord>(
                `${base}/submission/status?id=${submissionId}`,
                undefined,
                signal,
              )
            ).entry);
      if (id !== undefined) contextDurations[id] = task.endedAt - task.startedAt;
    }
  }
  // One refresh at a time. Frames arriving during a read request one more pass,
  // not another batch of requests; each delivered frame still contributes history.
  async function update() {
    dirty = true;
    if (refreshing) return;
    refreshing = true;
    while (dirty && currentView && !signal.aborted) {
      dirty = false;
      const view = currentView;
      const loadHistory = needsHistory;
      needsHistory = false;
      const reads = [
        api<SessionInfo>(infoPath, undefined, signal),
        api<ContextStatus>(statusPath, undefined, signal),
        api<ContextInspection>(inspectionPath, undefined, signal).catch(
          (error: unknown): ContextInspection => {
            failed(error);
            return { state: "unavailable", conversation: view.conversation.id };
          },
        ),
        loadHistory ? pages<EntryRecord>(historyPath, signal) : Promise.resolve([]),
      ] as const;
      try {
        const [session, context, inspection, history] = await Promise.all(reads);
        for (const entry of history) saved.set(entry.id, entry);
        const entries = [...saved.values()].sort((a, b) => a.id - b.id);
        await timings(entries);
        // Keep the last delivered frame readable after disconnect, but not interactive.
        if (signal.aborted) continue;
        connected = source.readyState === EventSource.OPEN && !needsHistory;
        render({
          session,
          view,
          context,
          inspection,
          history: entries,
          contextDurations,
        });
      } catch (error) {
        if (loadHistory) needsHistory = true;
        failed(error);
        // A failed read does not mean the rest of its batch has finished.
        await Promise.allSettled(reads);
      }
    }
    refreshing = false;
  }
  connected = false;
  source.onmessage = (event) => {
    if (signal.aborted) return;
    try {
      currentView = (JSON.parse(event.data) as { value: ConversationView }).value;
      for (const entry of currentView.entries) saved.set(entry.id, entry);
      connectDocuments();
      void update();
    } catch (error) {
      failed(error);
    }
  };
  source.onerror = () => {
    if (signal.aborted) return;
    connected = false;
    currentView = undefined;
    needsHistory = true;
    controls();
  };
  function connectDocuments() {
    for (const kind of ["app.environment", "app.session"]) {
      const previous = documents.get(kind);
      if (previous && previous.readyState !== EventSource.CLOSED) continue;
      const path = new URL(endpoint("watchDoc"), location.origin);
      path.searchParams.set("kind", kind);
      if (kind === "app.session") path.searchParams.delete("conversation");
      const documentSource = new EventSource(path.pathname + path.search);
      documentSource.onmessage = () => {
        if (!signal.aborted) void update();
      };
      documents.set(kind, documentSource);
    }
  }
  connectDocuments();
  const policies = new EventSource("/api/settings/watch");
  policies.onmessage = (event) => {
    if (signal.aborted) return;
    globalSettings = JSON.parse(event.data) as GlobalSettings;
    document.body.classList.toggle(
      "hide-thinking",
      globalSettings.values.hideThinkingBlock === true,
    );
    document.body.classList.toggle(
      "hide-images",
      globalSettings.values["terminal.showImages"] === false,
    );
    void update();
  };
  documents.set("settings", policies);
  controls();
}

function selectedTarget() {
  return catalog.targets.find((target) => targetKey(target) === targets.value);
}
function updateDirectoryField(): void {
  const root = selectedTarget()?.directoryRoot;
  element("new-directory-field", HTMLLabelElement).hidden = !root;
  if (root) element("new-directory", HTMLInputElement).placeholder = `${root} (default)`;
}

// Native datalists keep the path editable and provide keyboard/touch completion.
// Debounce remote listings and discard responses after input or target changes.
for (const scope of ["new", "session"] as const) {
  const input = element(`${scope}-directory`, HTMLInputElement);
  const list = element(`${scope}-directories`, HTMLDataListElement);
  let revision = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const binding = () =>
    scope === "new" ? selectedTarget() : (settingsTarget() ?? latest?.session.binding);
  const identity = () => JSON.stringify([binding(), scope === "new" ? targets.value : generation]);
  const suggest = () => {
    clearTimeout(timer);
    const current = ++revision;
    const key = identity();
    const query = input.value;
    list.replaceChildren();
    timer = setTimeout(() => {
      if (input.disabled || !binding()) return;
      void api<string[]>("/api/directories", { binding: binding(), query })
        .then((paths) => {
          if (current !== revision || key !== identity() || query !== input.value) return;
          list.replaceChildren(...paths.map((path) => new Option(path, path)));
        })
        .catch(() => {
          // Completion is optional; saving still surfaces validation/connection errors.
          if (current === revision) list.replaceChildren();
        });
    }, 150);
  };
  input.addEventListener("input", suggest);
  input.addEventListener("focus", suggest);
  if (scope === "new")
    targets.addEventListener("change", () => {
      ++revision;
      clearTimeout(timer);
      list.replaceChildren();
    });
}

targets.onchange = () => {
  updateDirectoryField();
  controls();
};
models.onchange = () => {
  fillThinking(newThinking, models, "", true);
  controls();
};
async function newSession(commandText?: string): Promise<boolean> {
  if (creating) return false;
  if (!targets.value || !models.value)
    throw new Error("Choose an available target and model in New session options first.");
  const current = generation;
  const request = navigation;
  const sourceDraft = {
    key: draftKey(active, conversation),
    text: prompt.value,
  };
  const attached = images;
  const text =
    commandText === undefined && !sourceDraft.text.startsWith("/") ? sourceDraft.text : "";
  const options = {
    id: requestId(),
    binding: selectedTarget(),
    baseDirectory: selectedTarget()?.directoryRoot
      ? element("new-directory", HTMLInputElement).value
      : undefined,
    model: catalog.models[Number(models.value)],
    thinkingLevel: newThinking.value || undefined,
  };
  creating = true;
  notice.hidden = true;
  controls();
  try {
    if (!(await flushSettings()) || current !== generation || request !== navigation) return false;
    const session = await api<SessionInfo>("/api/sessions", options);
    void refresh().catch(report);
    // A navigation during creation cancels automatic attachment/submission.
    // The original draft remains available; the new empty session is in Sessions.
    if (current !== generation || request !== navigation) return false;
    if (!(await flushSettings()) || current !== generation || request !== navigation) return false;
    if (commandText !== undefined && prompt.value === commandText) prompt.value = "";
    const draft = prompt.value;
    const draftImages = images;
    sessionFilter.value = "";
    attach(session.id);
    submissionMode = "followUp";
    if (!sourceDraft.text.startsWith("/") || (commandText !== undefined && draft)) {
      prompt.value = draft;
      images = draftImages;
      showAttachments();
      saveDraft();
    }
    setView("conversation");
    if (text.trim())
      await submitPrompt(session.id, undefined, text, "followUp", attached, sourceDraft);
    return true;
  } finally {
    creating = false;
    controls();
  }
}
create.onclick = () => {
  if (create.disabled) return;
  if (!active && prompt.value.startsWith("/")) composer.requestSubmit();
  else void newSession().catch(report);
};
const completions = installCompletions(
  prompt,
  element("completions", HTMLDivElement),
  () => `${generation}:${active ?? "none"}:${conversation ?? "main"}`,
  (query) => {
    if (!active || !connected) return Promise.reject(new Error("No connected session."));
    return api<string[]>(
      `${endpoint("completions")}${conversation === undefined ? "?" : "&"}query=${encodeURIComponent(query)}`,
    );
  },
  () => latest?.session.reviewOf !== undefined,
);

async function runCommand(text: string): Promise<boolean> {
  const name = text.slice(1).split(/\s/, 1)[0];
  const argument = text.slice(name.length + 1).trim();
  if (!commands.some((command) => command.name === name))
    throw new Error(`Unknown command /${name}.`);
  if (name === "endreview" && latest?.session.reviewOf === undefined)
    throw new Error("/endreview is available only in a review conversation.");
  if (images.length) throw new Error("Remove attached images before running a command.");
  if (argument && name !== "compact" && name !== "reset" && name !== "review")
    throw new Error(`/${name} does not accept arguments.`);
  if (name === "sessions") {
    return navigate("sessions");
  }
  if (name === "new") {
    return newSession(text);
  }
  if (!active || !connected) throw new Error("Connect to a session first.");
  if (name === "review" || name === "endreview") {
    const id = active;
    const branch = conversation;
    const current = generation;
    const request = ++navigation;
    if (!(await flushSettings()) || current !== generation || request !== navigation) return false;
    const result = await api<{ conversationId: number | null }>(endpoint("submit"), {
      type: "input",
      content: text,
    });
    clearDraft(draftKey(id, branch), text);
    if (current === generation && request === navigation)
      await selectSession(id, result.conversationId ?? undefined);
  } else if (name === "resume") {
    if (!recovering) throw new Error("This session does not need to be resumed.");
    await resumeSession();
  } else if (name === "compact" || name === "reset") {
    if (name === "reset" && !confirm("Start a new model context? History is preserved."))
      return false;
    await api(
      endpoint(name),
      argument ? { [name === "reset" ? "handoff" : "instructions"]: argument } : {},
    );
  } else if (name === "stop") {
    if (!busy) throw new Error("There is no running response to stop.");
    await api(endpoint("abort"), {});
  } else if (name === "search") return navigate("search");
  else if (name === "fork") return navigate("fork");
  else if (name === "model" || name === "settings") return navigate("settings");
  else if (name === "export") await exportConversation();
  return true;
}

composer.onsubmit = (event) => {
  event.preventDefault();
  if (send.disabled) return;
  completions.close();
  const text = prompt.value;
  if (text.startsWith("/")) {
    const current = generation;
    sending = true;
    notice.hidden = true;
    controls();
    void runCommand(text)
      .then((done) => {
        if (done && current === generation && prompt.value === text) {
          prompt.value = "";
          resizePrompt();
          saveDraft();
        }
      })
      .catch(report)
      .finally(() => {
        sending = false;
        controls();
      });
    return;
  }
  if (!active) void newSession().catch(report);
  else void submitPrompt(active, conversation, text, submissionMode, images).catch(report);
};

async function submitPrompt(
  session: string,
  branch: number | undefined,
  text: string,
  mode: string,
  attached: ImageContent[],
  sourceDraft?: { key: string; text: string },
): Promise<void> {
  if (
    pending?.session !== session ||
    pending.conversation !== branch ||
    pending.text !== text ||
    pending.mode !== mode ||
    pending.images !== attached
  )
    pending = {
      session,
      conversation: branch,
      text,
      mode,
      requestId: requestId(),
      images: attached,
      sourceDraft,
    };
  const submission = pending;
  sending = true;
  notice.hidden = true;
  controls();
  try {
    const { sourceDraft: origin, ...payload } = submission;
    await api(
      `/api/harness/${session}/submit${branch === undefined ? "" : `?conversation=${branch}`}`,
      {
        type: "input",
        requestId: payload.requestId,
        content: attached.length ? [{ type: "text", text }, ...attached] : text,
        whenBusy: mode,
      },
    );
    clearDraft(draftKey(session, branch), text);
    if (origin) clearDraft(origin.key, origin.text);
    if (active === session && conversation === branch && images === attached) {
      images = [];
      showAttachments();
    }
    if (pending === submission) pending = undefined;
  } finally {
    sending = false;
    controls();
  }
}
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
  if (event.defaultPrevented || event.isComposing) return;
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    composer.requestSubmit();
  }
};
stop.onclick = () => {
  if (active) void api(endpoint("abort"), {}).catch(report);
};
async function resumeSession(): Promise<void> {
  const id = active;
  if (!id) return;
  await api(`/api/harness/${id}/resume`, {});
  if (active === id) {
    recovering = false;
    controls();
  }
}
resume.onclick = () => {
  void resumeSession().catch(report);
};
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    void refresh().catch(report);
  }
});
window.addEventListener("pagehide", disconnectEvents);
window.addEventListener("pageshow", (event) => {
  if (event.persisted && active) connectEvents();
});
void refresh()
  .then(() => {
    const id = new URL(location.href).searchParams.get("session");
    if (id && catalog.sessions.some((session) => session.id === id)) {
      const branch = new URL(location.href).searchParams.get("conversation");
      attach(id, branch === null ? undefined : Number(branch));
    }
    setView(view);
  })
  .catch(report);

function draftKey(session: string | undefined, branch: number | undefined): string {
  return `pi.draft:${session ?? "new"}:${branch ?? "main"}`;
}
function clearDraft(key: string, text: string): void {
  if (draftKey(active, conversation) === key && prompt.value === text) {
    prompt.value = "";
    completions.close();
    resizePrompt();
  }
  try {
    if (sessionStorage.getItem(key) === text) sessionStorage.setItem(key, "");
  } catch {
    /* Storage can be disabled by browser policy. */
  }
}
function saveDraft(): void {
  try {
    sessionStorage.setItem(draftKey(active, conversation), prompt.value);
  } catch {
    /* Storage can be disabled by browser policy. */
  }
}
function loadDraft(): string {
  try {
    return sessionStorage.getItem(draftKey(active, conversation)) ?? "";
  } catch {
    return "";
  }
}
notice.onclick = () => {
  notice.hidden = true;
};
function fillThinking(
  select: HTMLSelectElement,
  modelSelect: HTMLSelectElement,
  value?: string,
  inherit = false,
): void {
  const choices = modelSelect === sessionModel ? settingsModels : catalog.models;
  const model = modelSelect.value ? choices[Number(modelSelect.value)] : undefined;
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
  const model = defaultModel.value ? settingsModels[Number(defaultModel.value)] : undefined;
  for (const level of model?.thinkingLevels ?? []) chooseOption(modelThinkingDefault, level, level);
  const saved = model && editingSettings?.modelThinkingLevels[`${model.provider}/${model.modelId}`];
  // Keep a configured unsupported level visible: Pi will clamp it when starting.
  if (saved && !model?.thinkingLevels.includes(saved))
    chooseOption(modelThinkingDefault, saved, `${saved} (clamped by model)`);
  modelThinkingDefault.value = saved ?? "";
  modelThinkingDefault.disabled = !model;
}
// Forms are initialized only on entry. Streamed snapshots never overwrite edits.
let settingsModels: Catalog["models"] = [];
let settingsTargets: Catalog["targets"] = [];
const sessionTarget = element("session-target", HTMLSelectElement);
function settingsTarget() {
  return settingsTargets.find((target) => targetKey(target) === sessionTarget.value);
}
let sessionBaseline: ReturnType<typeof sessionSettings> | undefined;
let settingsBinding:
  | {
      configure: string;
      environment: string;
      rename: string;
      generation: number;
    }
  | undefined;
let savingSettings: Promise<boolean> | undefined;
function sessionSettings() {
  return {
    name: element("session-name", HTMLInputElement).value,
    model: sessionModel.value ? settingsModels[Number(sessionModel.value)] : undefined,
    thinkingLevel: thinking.value,
    instructions: instructions.value,
    target: settingsTarget(),
    baseDirectory: settingsTarget()?.directoryRoot
      ? element("session-directory", HTMLInputElement).value
      : undefined,
  };
}
function prepareSessionSettings(): void {
  settingsModels = catalog.models;
  settingsTargets = catalog.targets;
  sessionTarget.replaceChildren();
  chooseOption(sessionTarget, "", "No available environment selected", true);
  for (const target of settingsTargets) {
    chooseOption(sessionTarget, targetKey(target), target.label);
    sessionTarget.options[sessionTarget.options.length - 1].disabled = !target.available;
  }
  const selected = latest?.session.binding;
  const target = settingsTargets.find(
    (target) => target.provider === selected?.provider && target.target === selected?.target,
  );
  if (!target && selected)
    chooseOption(sessionTarget, targetKey(selected), selected.target + " (unavailable)", true);
  sessionTarget.value = targetKey(target ?? selected);
  settingsBinding = {
    configure: endpoint("configure"),
    environment: endpoint("environment"),
    rename: endpoint("rename"),
    generation,
  };
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
  settingsModels.forEach((model, index) =>
    chooseOption(sessionModel, String(index), `${model.provider} / ${model.name}`),
  );
  const index = settingsModels.findIndex(
    (model) => model.provider === agent?.model?.provider && model.modelId === agent?.model?.modelId,
  );
  sessionModel.value = index < 0 ? "" : String(index);
  fillThinking(thinking, sessionModel, agent?.thinkingLevel ?? "off");
  instructions.value = agent?.instructions ?? "";
  const root = latest?.session.directoryRoot;
  const directory = element("session-directory", HTMLInputElement);
  element("session-directory-field", HTMLLabelElement).hidden = !root;
  directory.disabled = !root;
  const cwd = agent?.cwd ?? latest?.session.binding?.cwd;
  directory.value = root && cwd?.startsWith(root + "/") ? cwd.slice(root.length + 1) : "";
  if (root) directory.placeholder = `${root} (default)`;
  element("session-directories", HTMLDataListElement).replaceChildren();
  sessionBaseline = sessionSettings();
}
sessionTarget.onchange = () => {
  const target = settingsTarget();
  const directory = element("session-directory", HTMLInputElement);
  directory.value = "";
  directory.disabled = !target?.directoryRoot;
  element("session-directory-field", HTMLLabelElement).hidden = !target?.directoryRoot;
  if (target?.directoryRoot) directory.placeholder = `${target.directoryRoot} (default)`;
};
function prepareGlobalSettings(): void {
  settingsModels = catalog?.models ?? [];
  editingSettings = globalSettings;
  defaultModel.replaceChildren();
  chooseOption(
    defaultModel,
    "",
    globalSettings?.model
      ? `Keep configured model: ${globalSettings.model.provider}/${globalSettings.model.modelId} (keep)`
      : "No configured default (keep)",
  );
  settingsModels.forEach((model, index) =>
    chooseOption(defaultModel, String(index), `${model.provider} / ${model.name}`),
  );
  const index = settingsModels.findIndex(
    (model) =>
      model.provider === globalSettings?.model?.provider &&
      model.modelId === globalSettings.model.modelId,
  );
  defaultModel.value = index < 0 ? "" : String(index);
  fillModelDefault();
  const fields = element("global-settings-fields", HTMLDivElement);
  const modelGroup = element("model-defaults", HTMLElement);
  const wrapField = element("wrap-field", HTMLLabelElement);
  wrapField.remove();
  fields.replaceChildren(modelGroup);
  modelGroup.querySelector("[data-generated]")?.remove();
  modelGroup.hidden = !globalSettings;
  let group = "Model / thinking";
  let parent = modelGroup;
  for (const field of globalSettings ? settingFields : []) {
    if (field.group !== group) {
      group = field.group;
      parent = document.createElement("section");
      parent.className = "settings-group";
      const heading = document.createElement("h2");
      heading.textContent = group;
      parent.append(heading);
      fields.append(parent);
    }
    const label = document.createElement("label");
    label.dataset.generated = "";
    const caption = document.createElement("span");
    caption.textContent = field.label;
    const input =
      "choices" in field || field.type === "boolean"
        ? document.createElement("select")
        : document.createElement("input");
    input.id = `default-${field.key}`;
    input.name = field.key;
    if (input instanceof HTMLSelectElement) {
      for (const choice of "choices" in field ? field.choices : ["true", "false"])
        chooseOption(input, choice, choice === "true" ? "On" : choice === "false" ? "Off" : choice);
    } else {
      input.type = "number";
      input.readOnly = true;
    }
    input.value = String(globalSettings!.values[field.key]);
    label.append(caption, input);
    parent.append(label);
  }
  if (!globalSettings) {
    parent = document.createElement("section");
    parent.className = "settings-group";
    const heading = document.createElement("h2");
    heading.textContent = "Display";
    parent.append(heading);
    fields.append(parent);
  }
  parent.append(wrapField);
}

// Serialize autosaves, then read the form again: edits made during a request
// are persisted before any navigation completes. URLs and catalog choices are
// captured when opening the form, not taken from a later session/catalog.
function flushSettings(): Promise<boolean> {
  if (savingSettings) return savingSettings;
  const form =
    view === "settings" ? preferences : view === "global" ? globalPreferences : undefined;
  form?.setAttribute("aria-busy", "true");
  savingSettings = (async () => {
    try {
      while (view === "settings" && sessionBaseline && settingsBinding) {
        const binding = settingsBinding;
        const next = sessionSettings();
        const { name, ...configure } = next;
        const { name: oldName, ...oldConfigure } = sessionBaseline;
        const changed = JSON.stringify(configure) !== JSON.stringify(oldConfigure);
        if (!changed && name === oldName) break;
        if (changed) {
          if (!configure.model || !configure.thinkingLevel)
            throw new Error("Select an available model.");
          const root = configure.target?.directoryRoot ?? latest?.session.directoryRoot;
          const directory = configure.baseDirectory;
          if (
            directory !== undefined &&
            (directory.split("/").includes("..") ||
              Array.from(directory).some(
                (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
              ))
          )
            throw new Error("Expected a workspace-relative directory without '..'.");
          const switched = targetKey(configure.target) !== targetKey(oldConfigure.target);
          const cwd =
            root && directory !== undefined
              ? [root, ...directory.split("/").filter(Boolean)].join("/")
              : switched
                ? configure.target?.cwd
                : undefined;
          if (switched && configure.target) {
            await api(binding.environment, {
              binding: {
                provider: configure.target.provider,
                target: configure.target.target,
                cwd: cwd ?? configure.target.cwd,
              },
            });
            if (generation !== binding.generation || settingsBinding !== binding) return false;
          }
          await api(binding.configure, {
            model: {
              provider: configure.model.provider,
              modelId: configure.model.modelId,
            },
            thinkingLevel: configure.thinkingLevel,
            instructions: configure.instructions,
            ...(cwd === undefined ? {} : { cwd }),
          });
          if (generation !== binding.generation || settingsBinding !== binding) return false;
          sessionBaseline = { ...next, name: oldName };
        }
        if (name !== oldName) {
          const session = await api<SessionInfo>(binding.rename, { name });
          if (generation !== binding.generation || settingsBinding !== binding) return false;
          sessionBaseline = { ...next };
          if (latest) render({ ...latest, session });
          if (catalog)
            catalog.sessions = catalog.sessions.map((item) =>
              item.id === session.id ? { ...item, ...session } : item,
            );
        }
        notice.hidden = true;
      }
      while (view === "global" && editingSettings) {
        const values: Record<string, string | boolean> = {};
        for (const field of settingFields) {
          if ("readonly" in field) continue;
          const value = element(`default-${field.key}`, HTMLSelectElement).value;
          if (value !== String(editingSettings.values[field.key]))
            values[field.key] = "choices" in field ? value : value === "true";
        }
        const selected = defaultModel.value
          ? settingsModels[Number(defaultModel.value)]
          : undefined;
        const modelChanged =
          selected &&
          (selected.provider !== editingSettings.model?.provider ||
            selected.modelId !== editingSettings.model.modelId);
        const overrideChanged =
          selected &&
          modelThinkingDefault.value !==
            (editingSettings.modelThinkingLevels[`${selected.provider}/${selected.modelId}`] ?? "");
        if (!Object.keys(values).length && !modelChanged && !overrideChanged) break;
        const saved = await api<GlobalSettings>("/api/settings", {
          values,
          ...(selected && (modelChanged || overrideChanged)
            ? {
                model: selected,
                ...(overrideChanged
                  ? { modelThinkingLevel: modelThinkingDefault.value || null }
                  : {}),
              }
            : {}),
        });
        globalSettings = editingSettings = saved;
        if (modelChanged) {
          models.value = "";
          newThinking.value = "";
        }
        await refresh();
        notice.hidden = true;
      }
      return true;
    } catch (error) {
      report(error);
      return false;
    }
  })().finally(() => {
    savingSettings = undefined;
    form?.removeAttribute("aria-busy");
  });
  return savingSettings;
}
defaultModel.onchange = () => {
  fillModelDefault();
};
sessionModel.onchange = () => {
  fillThinking(thinking, sessionModel);
};
for (const form of [preferences, globalPreferences]) {
  form.addEventListener("change", (event) => {
    if (!form.hidden && event.target instanceof HTMLSelectElement) void flushSettings();
  });
  form.addEventListener("focusout", (event) => {
    if (
      !form.hidden &&
      (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
    )
      void flushSettings();
  });
}

async function exportConversation(): Promise<void> {
  const filename = `pi-${active}-${conversation ?? "main"}.json`;
  const records = await pages<EntryRecord>(endpoint("entries"));
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(records, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
window.addEventListener("offline", () => {
  connected = false;
  controls();
});
window.addEventListener("online", () => {
  // Reconnect without resetting the current view, draft or attachments.
  if (active) connectEvents();
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
  element("app-settings", HTMLElement).hidden = false;
  install.onclick = () => {
    void (event as InstallEvent)
      .prompt()
      .then(() => (event as InstallEvent).userChoice)
      .then(() => {
        install.hidden = true;
        element("app-settings", HTMLElement).hidden = true;
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
  for (const popover of [messageMenu, inputMenu]) popover.hidePopover();
}
const panes = {
  conversation: transcript,
  sessions: picker,
  settings: preferences,
  global: globalPreferences,
  context: contextView,
  fork: element("branch-picker", HTMLElement),
  search: transcript,
};
type View = keyof typeof panes;
let view: View = "conversation";
let conversationScroll = 0;
let navigation = 0;
const viewTitle = element("view-title", HTMLSpanElement);
function updateViewTitle(): void {
  const titles = {
    conversation: "",
    sessions: "Sessions",
    settings: "Session settings",
    global: "Defaults and preferences",
    context: "Context",
    fork: "Branches",
    search: `Search in “${title.textContent}”`,
  };
  viewTitle.textContent = titles[view];
}
function setView(next: View): void {
  if (view === "conversation" && next !== view) conversationScroll = transcript.scrollTop;
  if (view === "search" && next !== view) clearSearch();
  completions.close();
  closePopovers();
  for (const pane of new Set(Object.values(panes))) pane.hidden = pane !== panes[next];
  const isLanding = next === "conversation" && !active;
  landing.hidden = !isLanding;
  if (isLanding) transcript.hidden = true;
  const actions = element(
    next === "sessions" ? "session-actions" : "composer-actions",
    HTMLDivElement,
  );
  const optionsToggle = element("new-options-toggle", HTMLButtonElement);
  if (create.parentElement !== actions) actions.append(optionsToggle, create);
  optionsToggle.hidden = create.hidden = !isLanding && next !== "sessions";
  title.hidden =
    status.hidden =
    element("menu-toggle", HTMLButtonElement).hidden =
      next !== "conversation";
  viewTitle.hidden = element("close-view", HTMLButtonElement).hidden = next === "conversation";
  element("new-options", HTMLElement).hidden =
    (!isLanding && next !== "sessions") || optionsToggle.getAttribute("aria-expanded") !== "true";
  const queue = element("queue", HTMLDivElement);
  queue.hidden = !queue.childElementCount || (next !== "conversation" && next !== "search");
  composer.hidden = next === "sessions" || next === "search";
  element("app-footer", HTMLElement).hidden = next === "context";
  element("session-filter-bar", HTMLDivElement).hidden = next !== "sessions";
  searchBar.hidden = next !== "search";
  view = next;
  document.body.dataset.view = view;
  updateViewTitle();
  resizePrompt();
  if (next === "conversation") transcript.scrollTop = conversationScroll;
  if (next === "search") updateSearch();
  if (next === "context") renderContext();
  updateLatest();
  controls();
}
async function navigate(next: View): Promise<boolean> {
  const request = ++navigation;
  if (!(await flushSettings()) || request !== navigation) return false;
  if (["settings", "context", "fork", "search"].includes(next) && !latest) return false;
  if (view !== next) {
    if (next === "settings") prepareSessionSettings();
    if (next === "global") prepareGlobalSettings();
  }
  setView(next);
  if (next === "sessions") void refresh().catch(report);
  if (next === "fork") void refreshBranches().catch(report);
  return true;
}
async function selectSession(id: string, branch?: number): Promise<void> {
  const request = ++navigation;
  if (!(await flushSettings()) || request !== navigation) return;
  if (active !== id || conversation !== branch) {
    attach(id, branch);
    conversationScroll = 0;
  }
  setView("conversation");
}
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-view]")) {
  button.onclick = () => {
    const next = button.dataset.view;
    if (next && next in panes) void navigate(next as View);
  };
}
function showNewOptions(expanded: boolean): void {
  element("new-options-toggle", HTMLButtonElement).setAttribute("aria-expanded", String(expanded));
  element("new-options", HTMLElement).hidden =
    !expanded || (view !== "sessions" && (view !== "conversation" || !!active));
}
element("new-options-toggle", HTMLButtonElement).onclick = () =>
  showNewOptions(!!element("new-options", HTMLElement).hidden);
sessionFilter.oninput = renderSessions;
sessionFilter.onkeydown = (event) => {
  if (event.key === "Enter" && !event.isComposing) event.preventDefault();
};
installPickerKeyMappings(
  document,
  () => view === "sessions",
  () => showNewOptions(true),
);
installSelectKeyMappings(document);
inputMenu.addEventListener("click", (event) => {
  if (event.target instanceof Element && event.target.closest("button")) inputMenu.hidePopover();
});
// Manual dismissal keeps the release of a long press from immediately closing
// the menu (automatic popover light-dismiss runs on that same pointer release).
document.addEventListener("pointerdown", (event) => {
  if (
    messageMenu.matches(":popover-open") &&
    !event.composedPath().includes(messageMenu) &&
    (!selectedMessage || !event.composedPath().includes(selectedMessage.trigger))
  )
    messageMenu.hidePopover();
});
inputMenu.addEventListener("beforetoggle", (event) => {
  if (event.newState === "open") messageMenu.hidePopover();
});
messageMenu.addEventListener("toggle", () => {
  if (!messageMenu.matches(":popover-open"))
    selectedMessage?.trigger.setAttribute("aria-expanded", "false");
});
for (const popover of [messageMenu, inputMenu])
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
  const text = message.content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "thinking") return block.thinking;
      if (block.type === "toolCall")
        return `${block.name}\n${JSON.stringify(block.arguments, null, 2)}`;
      return "[image]";
    })
    .join("\n\n");
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
  if (view === "search") void navigate("conversation");
  resizePrompt();
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
  void api<{ id: number }>(endpoint("fork"), {
    at: selected.entry,
    options: { ownership: { kind: "ownerless" } },
  })
    .then((result) => {
      if (active === selected.session && conversation === selected.branch)
        void selectSession(selected.session, result.id);
    })
    .catch(report);
};
const wrap = element("wrap-code", HTMLSelectElement);
function setWrap(value: boolean): void {
  document.body.classList.toggle("wrap-code", value);
  wrap.value = String(value);
}
try {
  setWrap(localStorage.getItem("pi.wrapCode") === "true");
} catch {
  /* Browser storage may be disabled. */
}
wrap.onchange = () => {
  const value = wrap.value === "true";
  setWrap(value);
  try {
    localStorage.setItem("pi.wrapCode", String(value));
  } catch {
    /* Browser storage may be disabled. */
  }
};
function updateLatest(): void {
  element("latest", HTMLButtonElement).hidden =
    view !== "conversation" ||
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
  for (const { node: article } of rendered.values()) {
    const found = !searchBar.hidden && !!query && (article.dataset.search ?? "").includes(query);
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
  element("search-count", HTMLSpanElement).textContent = query
    ? `${matches.length ? matchIndex + 1 : 0} / ${matches.length}`
    : "";
  for (const id of ["search-prev", "search-next"])
    element(id, HTMLButtonElement).disabled = !matches.length;
}
function goToMatch(direction: number): void {
  if (!matches.length) return;
  matchIndex = (matchIndex + direction + matches.length) % matches.length;
  const node = matches[matchIndex];
  for (
    let parent = composedParent(node);
    parent && parent !== transcript;
    parent = composedParent(parent)
  )
    if (parent instanceof HTMLDetailsElement) parent.open = true;
  for (const details of node.querySelectorAll("details"))
    if (details.textContent?.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()))
      details.open = true;
  node.scrollIntoView({ block: "center" });
  element("search-count", HTMLSpanElement).textContent = `${matchIndex + 1} / ${matches.length}`;
}
function clearSearch(): void {
  searchBar.hidden = true;
  search.value = "";
  updateSearch();
}
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
    void navigate("conversation");
  }
  if (event.key === "Enter") {
    event.preventDefault();
    goToMatch(event.shiftKey ? -1 : 1);
  }
};
element("search-prev", HTMLButtonElement).onclick = () => goToMatch(-1);
element("search-next", HTMLButtonElement).onclick = () => goToMatch(1);
document.addEventListener("keydown", (event) => {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.altKey ||
    event.shiftKey ||
    !(event.metaKey || event.ctrlKey)
  )
    return;
  const direction = view === "fork" ? navigationDirection(event) : 0;
  if (direction) {
    event.preventDefault();
    moveFocus(Array.from(branches.querySelectorAll<HTMLButtonElement>("button")), direction);
    return;
  }
  if (event.key.toLowerCase() === "k") {
    event.preventDefault();
    void navigate("sessions");
  }
  if (event.key.toLowerCase() === "f" && active) {
    event.preventDefault();
    void navigate("search");
  }
});

document.addEventListener("keydown", (event) => {
  if (event.defaultPrevented || event.isComposing || event.key !== "Escape") return;
  if (messageMenu.matches(":popover-open")) {
    event.preventDefault();
    messageMenu.hidePopover();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.defaultPrevented || event.isComposing || event.key !== "Escape") return;
  if (inputMenu.matches(":popover-open")) {
    event.preventDefault();
    inputMenu.hidePopover();
    return;
  }
  if (view !== "conversation") {
    event.preventDefault();
    void navigate("conversation");
  }
});

function compactTokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}M`;
}
let contextRevision = "";
function renderContext(): void {
  const data = latest?.inspection;
  const revision = JSON.stringify(data);
  if (revision === contextRevision) return;
  contextRevision = revision;
  const span = (className: string, text = "") => {
    const node = document.createElement("span");
    node.className = className;
    node.textContent = text;
    return node;
  };
  const count = (n: number) =>
    n < 1000 ? String(n) : `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  contextView.replaceChildren();
  delete contextView.dataset.conversation;
  delete contextView.dataset.tail;
  delete contextView.dataset.tokens;
  if (!data || data.state === "unavailable" || data.conversation !== latest?.view.conversation.id) {
    contextView.append(span("ctx-state", "Context unavailable"));
    return;
  }
  contextView.dataset.conversation = String(data.conversation);
  contextView.dataset.tail = String(data.tail ?? "");
  contextView.dataset.tokens = String(data.tokens);
  const usage = document.createElement("section");
  usage.setAttribute("aria-label", "Context usage");
  const summary = document.createElement("div");
  summary.className = "ctx-usage";
  const total = span("ctx-big", `~${count(data.tokens)} `);
  total.append(span("", `/ ${data.window === null ? "?" : count(data.window)}`));
  const capacity = document.createElement("div");
  capacity.className = "ctx-capacity";
  capacity.append(
    span("ctx-percent", data.fraction === null ? "-" : `${(data.fraction * 100).toFixed(1)}%`),
    span("ctx-remaining", data.remaining === null ? "" : `${count(data.remaining)} remaining`),
  );
  summary.append(total, capacity);
  usage.append(summary);
  const position = (n: number) => `${Math.max(0, Math.min(100, (n / data.window!) * 100))}%`;
  if (data.window !== null) {
    const window = document.createElement("div");
    window.className = "ctx-window";
    window.setAttribute("role", "img");
    window.setAttribute(
      "aria-label",
      `Estimated context: ${data.tokens.toLocaleString()} of ${data.window.toLocaleString()} tokens.`,
    );
    const track = document.createElement("div");
    track.className = "ctx-track";
    for (const role of data.roles) {
      const segment = span("ctx-segment");
      segment.dataset.role = role.role;
      segment.style.width = position(role.tokens);
      track.append(segment);
    }
    window.append(track);
    usage.append(window);
    if (data.policy.enabled) {
      const threshold = data.policy.backgroundTokens > 0 ? data.backgroundAt! : data.blockingAt!;
      const marker = span("ctx-threshold");
      marker.style.left = position(threshold);
      const reserved = span("ctx-reserved");
      reserved.style.width = position(data.policy.reserveTokens);
      window.append(marker, reserved);
      window.setAttribute(
        "aria-label",
        `${window.getAttribute("aria-label")} Automatic compaction threshold: ${threshold.toLocaleString()} tokens. Reserved headroom: ${data.policy.reserveTokens.toLocaleString()} tokens.`,
      );
      const ruler = document.createElement("div");
      ruler.className = "ctx-ruler";
      ruler.setAttribute("aria-hidden", "true");
      const label = span("ctx-auto", `~${compactTokens(threshold)}`);
      label.style.left = position(threshold);
      ruler.append(label);
      const reserve = document.createElement("div");
      reserve.className = "ctx-reserve-caption";
      reserve.append(span("ctx-reserve-key"), `${count(data.policy.reserveTokens)} reserved`);
      usage.append(ruler, reserve);
    }
  }
  const legend = document.createElement("ul");
  legend.className = "ctx-legend";
  legend.setAttribute("aria-label", "Message roles");
  for (const role of data.roles) {
    const item = document.createElement("li");
    item.dataset.role = role.role;
    item.append(span("ctx-swatch"), span("", role.role), span("ctx-tokens", count(role.tokens)));
    legend.append(item);
  }
  usage.append(legend);
  const inventory = document.createElement("section");
  inventory.className = "ctx-inventory";
  inventory.setAttribute("aria-label", "Context messages in provider order");
  const messages = document.createElement("ol");
  messages.className = "ctx-messages";
  const fields = (parts: ContextPart[], nested = false): HTMLOListElement => {
    const list = document.createElement("ol");
    list.className = nested ? "ctx-fields ctx-files" : "ctx-fields";
    for (const part of parts) {
      const item = document.createElement("li");
      const row = document.createElement("div");
      row.className = "ctx-field";
      const main = span("ctx-field-main");
      main.append(span(nested ? "ctx-field-value" : "ctx-field-name", part.name));
      if (part.value !== undefined) main.append(span("ctx-field-value", part.value));
      row.append(main, span("ctx-tokens", count(part.tokens)));
      item.append(row);
      if (part.children?.length) item.append(fields(part.children, true));
      list.append(item);
    }
    return list;
  };
  for (const [index, message] of data.messages.entries()) {
    const item = document.createElement("li");
    item.className = "ctx-message";
    item.dataset.order = String(index);
    item.dataset.role = message.role;
    item.dataset.tokens = String(message.tokens);
    if (message.source) {
      item.dataset.entry = String(message.source.entry);
      item.dataset.kind = message.source.kind;
    }
    const heading = document.createElement("div");
    heading.className = "ctx-message-heading";
    const main = span("ctx-heading-main");
    main.append(span("ctx-role", message.role));
    if (message.source?.kind === "pi.compaction" || message.source?.kind === "pi.reset")
      main.append(span("ctx-provenance", message.source.kind));
    if (message.toolName !== undefined) main.append(span("ctx-tool-name", message.toolName));
    heading.append(span("ctx-swatch"), main, span("ctx-tokens", count(message.tokens)));
    item.append(heading);
    // A simple text result is already represented by its message, as in the mock.
    if (
      message.parts.length &&
      !(
        message.role === "toolResult" &&
        message.parts.length === 1 &&
        message.parts[0]!.name === "text"
      )
    )
      item.append(fields(message.parts));
    messages.append(item);
  }
  inventory.append(messages);
  if (!data.messages.length) inventory.append(span("ctx-state", "No context"));
  contextView.append(usage, inventory);
}

function environmentText(binding: ExecutionBinding | undefined, cwd: string): string {
  if (!binding) return "No execution environment";
  return `${binding.provider === "local" ? "local" : binding.target} · ${cwd}`;
}

function summaryDot(): HTMLSpanElement {
  const dot = document.createElement("span");
  dot.className = "footer-dot";
  dot.setAttribute("aria-hidden", "true");
  return dot;
}

function renderModelSummary(
  node: HTMLElement,
  model: SessionInfo["model"],
  thinking: SessionInfo["thinkingLevel"],
  prefix = "",
): void {
  if (!node.childElementCount) {
    const name = document.createElement("span");
    name.className = "model-name";
    const effort = document.createElement("span");
    effort.className = "model-effort";
    if (prefix) {
      name.id = `${prefix}model-name`;
      effort.id = `${prefix}effort`;
    }
    node.append(name, summaryDot(), effort);
  }
  node.children[0].textContent = model?.modelId ?? "No model";
  node.children[2].textContent = thinking;
  node.title = `${model?.provider ?? ""} / ${model?.modelId ?? ""} · thinking ${thinking}`;
}

function renderContextUsage(node: HTMLElement, context: ContextStatus): void {
  const { window: limit, lastResponse, autoCompact } = context;
  const tokens = lastResponse?.tokens;
  const percent = tokens !== undefined && limit ? (tokens / limit) * 100 : undefined;
  node.textContent = `${percent === undefined ? "-" : percent.toFixed(1) + "%"}/${limit ? compactTokens(limit) : "?"}${autoCompact ? " (auto)" : ""}`;
  node.dataset.level =
    percent !== undefined && percent > 90
      ? "critical"
      : percent !== undefined && percent > 70
        ? "warning"
        : "normal";
  node.dataset.tokens = tokens === undefined ? "" : String(tokens);
  node.title = `Context at last completed response: ${tokens?.toLocaleString() ?? "unknown"} / ${limit?.toLocaleString() ?? "unknown"} tokens. ${autoCompact ? "Automatic compaction enabled." : "Automatic compaction disabled."}`;
}

function renderFooter(): void {
  if (!latest) return;
  bottomLine.hidden = false;
  const agent = latest.view.docs["pi.agent"] as AgentState | undefined;
  const model = agent?.model ?? latest.session.model;
  const thinking = agent?.thinkingLevel ?? latest.session.thinkingLevel;
  renderModelSummary(element("footer-model", HTMLButtonElement), model, thinking, "footer-");
  const usage = latest.view.docs["pi.usage"] as UsageState | undefined;
  const totals = [...Object.values(usage?.models ?? {}), ...Object.values(usage?.tools ?? {})];
  const sum = (key: "input" | "output" | "cacheRead" | "cacheWrite") =>
    totals.reduce((value, item) => value + item[key], 0);
  const cost = totals.reduce((value, item) => value + item.cost.total, 0);
  const binding = latest.session.binding;
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
  }
  renderContextUsage(element("footer-context", HTMLButtonElement), latest.context);
  const hit = latest.context.lastResponse?.cacheHit;
  const hitNode = element("footer-hit", HTMLSpanElement);
  hitNode.textContent = hit == null ? "CH-" : `CH${hit.toFixed(1)}%`;
  hitNode.title = "Cache hit rate at the last completed response";
  const costNode = element("footer-cost", HTMLSpanElement);
  costNode.textContent = `$${cost.toFixed(3)}`;
  costNode.dataset.value = String(cost);
  costNode.title = "Estimated cost (USD)";
  set("footer-instance", environmentText(binding, agent?.cwd ?? binding?.cwd ?? ""));
}
for (const id of ["footer-stats", "footer-context"])
  element(id, HTMLButtonElement).onclick = () => {
    void navigate("context");
  };
element("footer-model", HTMLButtonElement).onclick = () => {
  void navigate("settings");
};
prompt.value = loadDraft();
setView("conversation");
