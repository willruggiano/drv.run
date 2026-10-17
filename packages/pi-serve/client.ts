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
const mode = element("mode", HTMLSelectElement);
const branches = element("branches", HTMLSelectElement);
const preferences = element("preferences", HTMLDialogElement);
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
const title = element("title", HTMLHeadingElement);
const create = element("create", HTMLButtonElement);
const recovery = element("recovery", HTMLDivElement);
const picker = element("picker", HTMLDialogElement);
const menu = element("conversation-menu", HTMLDivElement);
const messageMenu = element("message-menu", HTMLDivElement);
const inputMenu = element("input-menu", HTMLDivElement);
const sessionFilter = element("session-filter", HTMLInputElement);
const search = element("search", HTMLInputElement);
const searchBar = element("search-bar", HTMLDivElement);
let matches: HTMLElement[] = [];
let matchIndex = -1;
let selectedMessage:
  | {
      entry: number;
      message: Message;
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
  const dialog = [picker, preferences].find((dialog) => dialog.open);
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
  send.disabled =
    !active ||
    !connected ||
    (busy && mode.value === "reject") ||
    recovering ||
    sending ||
    !prompt.value.trim();
  stop.disabled = !active || !connected || !busy || recovering;
  stop.hidden = !busy || recovering;
  element("input-mode", HTMLSpanElement).textContent =
    busy && !recovering ? mode.selectedOptions[0].textContent : "";
  resume.disabled = !active || !connected || !recovering;
  recovery.hidden = !recovering;
  for (const id of ["settings", "export", "find"])
    element(id, HTMLButtonElement).disabled = !active || !connected || recovering;
  document.body.classList.toggle("offline", !navigator.onLine);
  branches.disabled = !active;
  bottomLine.dataset.connected = String(connected);
  element("usage-connection", HTMLParagraphElement).hidden = connected;
  element("footer-model", HTMLButtonElement).disabled = !active || !connected || recovering;
  send.textContent = busy && !recovering ? (mode.value === "steer" ? "Steer" : "Queue") : "Send";
  status.textContent = !navigator.onLine
    ? "Offline"
    : !active
      ? "Select a target"
      : !connected
        ? "Reconnecting…"
        : recovering
          ? "Interrupted"
          : busy
            ? "Working"
            : "Ready";
  status.dataset.state = !connected || recovering ? "disconnected" : "connected";
  status.title = status.textContent;
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
  const previousTarget = targets.value;
  const previousModel = models.value ? catalog?.models[Number(models.value)] : undefined;
  const next = await api<Catalog>("/api/catalog");
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

function codeBlock(text: string, language = ""): HTMLElement {
  const pre = document.createElement("pre");
  const bar = document.createElement("div");
  bar.className = "codebar";
  const name = document.createElement("span");
  name.textContent = language || "text";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = "Copy";
  copy.onclick = () => {
    if (!navigator.clipboard) return report("Copy requires HTTPS or localhost.");
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        copy.textContent = "Copied";
      })
      .catch(report);
  };
  bar.append(name, copy);
  const code = document.createElement("code");
  if (language && hljs.getLanguage(language)) {
    // highlight.js escapes all input before adding its own span markup.
    code.innerHTML = hljs.highlight(text, { language, ignoreIllegals: true }).value;
  } else code.textContent = text;
  pre.append(bar, code);
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
    const line = command.split("\n")[0].slice(0, 140);
    return `$ ${line}${line.length < command.length ? "…" : ""}`;
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

function toolInput(name: string, args: Record<string, unknown>): HTMLElement {
  const short = name.split(".").at(-1);
  if (short === "bash" && typeof args.command === "string") return codeBlock(args.command, "bash");
  if (short === "codemode" && typeof args.code === "string")
    return codeBlock(args.code, "javascript");
  if (short === "write" && typeof args.content === "string") return codeBlock(args.content);
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
      return codeBlock(preview, "diff");
    }
  }
  return codeBlock(JSON.stringify(args, null, 2), "json");
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
  details.append(
    summary,
    codeBlock(patch ?? JSON.stringify(data, null, 2), patch ? "diff" : "json"),
  );
  if ("calls" in data && Array.isArray(data.calls)) {
    summary.textContent = `Nested tools · ${data.calls.length}${"complete" in data && data.complete === false ? " · partial record" : ""}`;
    details.className = "nested-tools";
    details.replaceChildren(summary);
    for (const call of data.calls) {
      if (!call || typeof call !== "object") continue;
      const row = document.createElement("details");
      const title = document.createElement("summary");
      title.textContent = `${toolLabel(String(call.name), call.arguments)} · ${String(call.status)}${typeof call.durationMs === "number" ? ` · ${call.durationMs}ms` : ""}`;
      row.append(title);
      if (call.arguments && typeof call.arguments === "object")
        row.append(toolInput(String(call.name), call.arguments));
      else if (typeof call.args === "string") row.append(codeBlock(call.args));
      else if (typeof call.argumentsBytes === "number")
        row.append(`Arguments omitted (${call.argumentsBytes} bytes)`);
      if (typeof call.error === "string") {
        row.classList.add("error");
        row.append(codeBlock(call.error));
      }
      details.append(row);
    }
    // Keep truncation paths and any future metadata accessible as well.
    const raw = document.createElement("details");
    const label = document.createElement("summary");
    label.textContent = "Raw details";
    raw.append(label, codeBlock(JSON.stringify(data, null, 2), "json"));
    details.append(raw);
  }
  node.append(details);
}

function content(
  node: HTMLElement,
  message: Message,
  call?: { name: string; arguments: Record<string, unknown> },
): void {
  if (message.role === "system") return;
  node.dataset.role = message.role;
  const heading = document.createElement("header");
  heading.textContent =
    message.role === "toolResult"
      ? `${message.isError ? "Failed" : "Completed"} · ${toolLabel(message.toolName, call?.arguments)}`
      : message.role === "assistant"
        ? "Pi"
        : "You";
  node.append(heading);
  if (typeof message.content === "string") {
    node.append(markdown(message.content));
    return;
  }
  for (const block of message.content) {
    if (block.type === "text") {
      if (message.role === "toolResult") {
        const details = document.createElement("details");
        const summary = document.createElement("summary");
        summary.textContent = message.isError ? "Error output" : "Output";
        details.open = message.isError;
        details.append(summary, codeBlock(block.text));
        node.append(details);
      } else node.append(markdown(block.text));
    } else if (block.type === "toolCall" || block.type === "thinking") {
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent =
        block.type === "toolCall" ? toolLabel(block.name, block.arguments) : "Thinking";
      if (block.type === "toolCall") details.className = "tool-call";
      const pre =
        block.type === "toolCall"
          ? toolInput(block.name, block.arguments)
          : codeBlock(block.thinking);
      details.append(summary, pre);
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
  if (message.role === "toolResult") {
    const data = message.details;
    toolDetails(
      node,
      message.nestedCalls
        ? {
            ...(data && typeof data === "object" && !Array.isArray(data)
              ? Object.fromEntries(Object.entries(data))
              : {}),
            ...message.nestedCalls,
          }
        : data,
    );
  }
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

function render(snapshot: Snapshot): void {
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
      cancel.textContent = "Cancel";
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
  if (wasBusy && !busy) {
    void refreshRepository();
    document.title = "✓ Pi";
  } else if (busy) document.title = "Working · Pi";
  const wanted = new Set<string>();
  const ordered: HTMLElement[] = [];
  const item = (key: string, value: unknown, build: (node: HTMLElement) => void) => {
    wanted.add(key);
    const signature = JSON.stringify(value);
    let existing = rendered.get(key);
    if (!existing) {
      existing = { node: document.createElement("article"), signature: "" };
      rendered.set(key, existing);
    }
    if (signature !== existing.signature) {
      const open = Array.from(existing.node.querySelectorAll("details")).map(
        (detail) => detail.open,
      );
      existing.node.replaceChildren();
      build(existing.node);
      existing.node.querySelectorAll("details").forEach((detail, index) => {
        detail.open = open[index] ?? detail.open;
      });
      existing.signature = signature;
    }
    ordered.push(existing.node);
  };
  const calls = new Map<string, { name: string; arguments: Record<string, unknown> }>();
  for (const entry of entries.values())
    for (const message of entry.model ?? [])
      if (message.role === "assistant")
        for (const block of message.content)
          if (block.type === "toolCall") calls.set(block.id, block);
  for (const entry of [...entries.values()].sort((a, b) => a.id - b.id)) {
    if (entry.kind === "pi.reset" || entry.kind === "pi.compaction")
      item(`context:${entry.id}`, entry, (node) => {
        const details = document.createElement("details");
        const summary = document.createElement("summary");
        summary.textContent = entry.kind === "pi.reset" ? "Context reset" : "Context compacted";
        details.append(summary, codeBlock(JSON.stringify(entry.data ?? {}, null, 2), "json"));
        node.append(details);
      });
    entry.model?.forEach((message, index) => {
      if (message.role !== "system")
        item(
          `${entry.id}:${index}`,
          [message, message.role === "toolResult" ? calls.get(message.toolCallId) : undefined],
          (node) => {
            content(
              node,
              message,
              message.role === "toolResult" ? calls.get(message.toolCallId) : undefined,
            );
            node.dataset.search = messageText(message).toLocaleLowerCase();
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
                entry: entry.id,
                message,
                session: active,
                branch: conversation,
                trigger: actions,
              };
              element("fork-message", HTMLButtonElement).disabled = !connected || recovering;
              messageMenu.showPopover();
              actions.setAttribute("aria-expanded", "true");
              if (matchMedia("(min-width: 651px)").matches) {
                const rect = actions.getBoundingClientRect();
                messageMenu.style.top = `${Math.max(8, Math.min(rect.bottom + 4, innerHeight - messageMenu.offsetHeight - 8))}px`;
                messageMenu.style.right = `${Math.max(8, Math.min(innerWidth - rect.right, innerWidth - messageMenu.offsetWidth - 8))}px`;
              }
              element("copy-message", HTMLButtonElement).focus();
            };
            node.querySelector("header")?.append(actions);
          },
        );
    });
  }
  const partial = live?.generation?.message;
  if (partial) item("partial", partial, (node) => content(node, partial));
  for (const tool of [...(live?.tools ?? []), ...(live?.nestedTools ?? [])]) {
    if (tool.status === "done" && !("parentCallId" in tool)) continue;
    item(`tool:${tool.callId}`, tool, (node) => {
      const header = document.createElement("header");
      node.dataset.role = "toolResult";
      const args = "arguments" in tool ? tool.arguments : calls.get(tool.callId)?.arguments;
      header.textContent = `${toolLabel(tool.name, args)} · ${tool.status}`;
      if ("parentCallId" in tool) node.dataset.parentCall = tool.parentCallId;
      const pre = document.createElement("pre");
      pre.textContent = tool.output ?? "";
      pre.hidden = !tool.output;
      if ("summary" in tool && tool.summary?.isError) {
        node.classList.add("error");
        pre.hidden = false;
        pre.textContent = tool.summary.error ?? tool.output ?? "Tool failed";
      }
      node.append(header, pre);
      toolDetails(node, tool.details);
    });
  }
  for (const [key, value] of rendered) {
    if (!wanted.has(key)) {
      value.node.remove();
      rendered.delete(key);
    }
  }
  ordered.forEach((node, index) => {
    if (transcript.children[index] !== node)
      transcript.insertBefore(node, transcript.children[index] ?? null);
  });
  if (stick) transcript.scrollTop = transcript.scrollHeight;
  updateSearch();
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
  resizePrompt();
  notice.hidden = true;
  connected = false;
  busy = false;
  recovering = false;
  entries.clear();
  rendered.clear();
  transcript.replaceChildren();
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

targets.onchange = models.onchange = () => {
  create.disabled = !targets.value || !models.value;
};
create.onclick = () => {
  create.disabled = true;
  const id = requestId();
  void api<SessionInfo>("/api/sessions", {
    id,
    binding: catalog.targets.find((target) => targetKey(target) === targets.value),
    model: catalog.models[Number(models.value)],
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
    pending.mode !== mode.value ||
    pending.images !== images
  )
    pending = {
      session: active,
      conversation,
      text,
      mode: mode.value,
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
mode.onchange = controls;
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
  if (active) attach(active, Number(branches.value));
};
element("settings", HTMLButtonElement).onclick = () => {
  preferences.querySelector(".dialog-error")?.remove();
  const agent = latest?.view.docs["pi.agent"] as AgentState | undefined;
  element("session-name", HTMLInputElement).value = latest?.session.name ?? "";
  sessionModel.replaceChildren();
  catalog.models.forEach((model, index) =>
    chooseOption(sessionModel, String(index), `${model.provider} / ${model.name}`),
  );
  sessionModel.value = String(
    catalog.models.findIndex(
      (model) =>
        model.provider === agent?.model?.provider && model.modelId === agent?.model?.modelId,
    ),
  );
  thinking.value = agent?.thinkingLevel ?? "off";
  instructions.value = agent?.instructions ?? "";
  preferences.showModal();
};
element("close-settings", HTMLButtonElement).onclick = () => preferences.close();
element("save-settings", HTMLButtonElement).onclick = () => {
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
const pwaStatus = element("pwa-status", HTMLParagraphElement);
if ("serviceWorker" in navigator && isSecureContext) {
  void navigator.serviceWorker
    .register("/sw.js")
    .then((registration) => {
      pwaStatus.textContent =
        "App shell available offline. Conversations and tools require a connection.";
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        worker?.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller)
            report("Update ready. Close all Pi tabs and reopen to update.");
        });
      });
    })
    .catch(report);
} else
  pwaStatus.textContent =
    "Install and offline support require HTTPS or localhost. Plain HTTP can still connect to your workspace.";
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
element("attach", HTMLButtonElement).onclick = () => imageInput.click();
imageInput.onchange = () => {
  const files = Array.from(imageInput.files ?? []);
  imageInput.value = "";
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
};

function resizePrompt(): void {
  prompt.style.height = "auto";
  prompt.style.height = `${Math.min(prompt.scrollHeight, innerHeight * 0.25)}px`;
}
function closePopovers(): void {
  for (const popover of [menu, messageMenu, inputMenu]) popover.hidePopover();
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
for (const popover of [menu, inputMenu])
  popover.addEventListener("click", (event) => {
    if (
      event.target instanceof Element &&
      event.target.closest("button")?.id !== "wrap-code" &&
      event.target.closest("button")
    )
      popover.hidePopover();
  });
messageMenu.addEventListener("toggle", () => {
  if (!messageMenu.matches(":popover-open"))
    selectedMessage?.trigger.setAttribute("aria-expanded", "false");
});
for (const popover of [menu, messageMenu, inputMenu])
  popover.addEventListener("keydown", (event) => {
    if (
      !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) ||
      event.target instanceof HTMLSelectElement
    )
      return;
    const buttons = Array.from(
      popover.querySelectorAll<HTMLButtonElement>("button:not(:disabled):not([hidden])"),
    );
    if (!buttons.length) return;
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
  if (!selectedMessage) return;
  const text = messageText(selectedMessage.message);
  messageMenu.hidePopover();
  if (!navigator.clipboard) return report("Copy requires HTTPS or localhost.");
  void navigator.clipboard
    .writeText(text)
    .then(() => report("Copied"))
    .catch(report);
};
element("quote-message", HTMLButtonElement).onclick = () => {
  if (!selectedMessage) return;
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
  if (!selected || selected.session !== active || selected.branch !== conversation) return;
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
      // Keep syntax markup and copy handlers intact while highlighting matching text.
      const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.parentElement?.closest("header, .codebar, button")) continue;
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
  if (!(event.metaKey || event.ctrlKey) || preferences.open || picker.open || usageDialog.open)
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

for (const popover of [menu, inputMenu])
  popover.addEventListener("toggle", () => {
    if (popover.matches(":popover-open"))
      popover.querySelector<HTMLButtonElement>("button:not(:disabled):not([hidden])")?.focus();
  });
messageMenu.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    messageMenu.hidePopover();
    selectedMessage?.trigger.focus();
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
  element("footer-workspace", HTMLSpanElement).textContent = workspace;
  element("footer-location", HTMLButtonElement).title = `${workspace} · workspace details`;
  const git =
    repository?.state === "repository"
      ? (repository.branch ?? `detached ${repository.revision ?? ""}`)
      : repository?.state === "unavailable"
        ? "git unavailable"
        : repository
          ? ""
          : "git…";
  element("footer-git", HTMLSpanElement).textContent = git ? `(${git})` : "";
  element("footer-model-name", HTMLSpanElement).textContent = model.modelId;
  element("footer-effort", HTMLSpanElement).textContent = thinking;
  element("footer-model", HTMLButtonElement).title =
    `${model.provider} / ${model.modelId} · thinking ${thinking}`;
  const set = (id: string, text: string) => {
    element(id, HTMLElement).textContent = text;
  };
  for (const [field, key, prefix] of [
    ["input", "input", "↑"],
    ["output", "output", "↓"],
    ["read", "cacheRead", "R"],
    ["write", "cacheWrite", "W"],
  ] as const) {
    const value = sum(key);
    const node = element(`footer-${field}`, HTMLSpanElement);
    node.textContent = `${prefix}${compactTokens(value)}`;
    node.dataset.value = String(value);
    node.title = `${field === "read" || field === "write" ? "Cache " : ""}${field}: ${value.toLocaleString()} tokens`;
    set(`usage-${field}`, value.toLocaleString());
  }
  const { window: limit, lastResponse, autoCompact } = latest.context;
  const hit = lastResponse?.cacheHit;
  const tokens = lastResponse?.tokens;
  const percent = tokens !== undefined && limit ? (tokens / limit) * 100 : undefined;
  const contextText = `${percent === undefined ? "—" : percent.toFixed(1) + "%"}/${limit ? compactTokens(limit) : "?"}${autoCompact ? " auto" : ""}`;
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
  hitNode.hidden = hit === null || hit === undefined;
  hitNode.textContent = hit == null ? "" : `CH${hit.toFixed(1)}%`;
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
for (const id of ["footer-location", "footer-stats", "footer-context"])
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
