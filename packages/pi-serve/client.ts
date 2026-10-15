import type { Message } from "@earendil-works/pi-ai";
import type { EntryRecord, LiveState } from "@earendil-works/pi-durable";
import type { Catalog, ExecutionBinding, SessionInfo, Snapshot } from "../pi-runtime/index.ts";

function element<T extends HTMLElement>(id: string, type: { new (): T }): T {
  const found = document.getElementById(id);
  if (!(found instanceof type)) throw new Error(`Missing ${id}`);
  return found;
}
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
const picker = element("picker", HTMLDetailsElement);

let catalog: Catalog;
let active: string | undefined;
let source: EventSource | undefined;
let generation = 0;
let busy = false;
let recovering = false;
let connected = false;
let sending = false;
let pending: { session: string; text: string; requestId: string } | undefined;
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
  notice.textContent = error instanceof Error ? error.message : String(error);
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
  send.disabled = !active || !connected || busy || recovering || sending || !prompt.value.trim();
  stop.disabled = !active || !connected || !busy || recovering;
  resume.disabled = !active || !connected || !recovering;
  recovery.hidden = !recovering;
  status.textContent = !active
    ? "Select a target"
    : !connected
      ? "Reconnecting…"
      : recovering
        ? "Interrupted"
        : busy
          ? "Working"
          : "Ready";
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
  sessions.replaceChildren();
  for (const session of catalog.sessions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "session";
    button.setAttribute("aria-current", String(session.id === active));
    const target = catalog.targets.find((item) => targetKey(item) === targetKey(session.binding));
    button.textContent = `${target?.label ?? session.binding.target} · ${new Date(session.created).toLocaleString()}${target?.available ? "" : " · unavailable"}`;
    button.onclick = () => {
      attach(session.id);
    };
    sessions.append(button);
  }
  create.disabled = !targets.value || !models.value;
}

function content(node: HTMLElement, message: Message): void {
  if (message.role === "system") return;
  const heading = document.createElement("header");
  heading.textContent =
    message.role === "toolResult" ? message.toolName : message.role === "assistant" ? "Pi" : "You";
  node.append(heading);
  if (typeof message.content === "string") {
    const text = document.createElement("div");
    text.className = "text";
    text.textContent = message.content;
    node.append(text);
    return;
  }
  for (const block of message.content) {
    if (block.type === "text") {
      const text = document.createElement("div");
      text.className = "text";
      text.textContent = block.text;
      node.append(text);
    } else if (block.type === "toolCall" || block.type === "thinking") {
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = block.type === "toolCall" ? block.name : "Thinking";
      const pre = document.createElement("pre");
      pre.textContent =
        block.type === "toolCall" ? JSON.stringify(block.arguments, null, 2) : block.thinking;
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
  if (message.role === "assistant" && message.errorMessage) {
    const error = document.createElement("p");
    error.className = "error";
    error.textContent = message.errorMessage;
    node.append(error);
  }
}

function render(snapshot: Snapshot): void {
  const stick = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80;
  for (const entry of [...(snapshot.history ?? []), ...snapshot.view.entries])
    entries.set(entry.id, entry);
  const live = snapshot.view.docs["pi.live"] as LiveState | undefined;
  const wasBusy = busy;
  busy = !!live?.run;
  recovering = snapshot.session.needsResume;
  title.textContent = `${snapshot.session.binding.provider} · ${snapshot.session.binding.cwd} · ${snapshot.session.model.modelId}`;
  if (wasBusy && !busy) {
    notice.textContent = "Run finished. Ready for input.";
    notice.hidden = false;
    document.title = "✓ Pi";
  } else if (busy) document.title = "Working · Pi";
  const wanted = new Set<string>();
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
        detail.open = open[index] ?? false;
      });
      existing.signature = signature;
    }
    transcript.append(existing.node);
  };
  for (const entry of [...entries.values()].sort((a, b) => a.id - b.id)) {
    entry.model?.forEach((message, index) => {
      if (message.role !== "system")
        item(`${entry.id}:${index}`, message, (node) => content(node, message));
    });
  }
  const partial = live?.generation?.message;
  if (partial) item("partial", partial, (node) => content(node, partial));
  for (const tool of live?.tools ?? []) {
    if (tool.status === "done") continue;
    item(`tool:${tool.callId}`, tool, (node) => {
      const header = document.createElement("header");
      header.textContent = `${tool.name} · ${tool.status}`;
      const pre = document.createElement("pre");
      pre.textContent = tool.output ?? "";
      node.append(header, pre);
    });
  }
  for (const [key, value] of rendered) {
    if (!wanted.has(key)) {
      value.node.remove();
      rendered.delete(key);
    }
  }
  if (stick) transcript.scrollTop = transcript.scrollHeight;
  controls();
}

function attach(id: string): void {
  source?.close();
  generation++;
  active = id;
  connected = false;
  busy = false;
  recovering = false;
  entries.clear();
  rendered.clear();
  transcript.replaceChildren();
  picker.open = false;
  history.replaceState(null, "", `/?session=${encodeURIComponent(id)}`);
  const currentGeneration = generation;
  source = new EventSource(`/api/sessions/${encodeURIComponent(id)}/events`);
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
  if (pending?.session !== active || pending.text !== text)
    pending = { session: active, text, requestId: requestId() };
  const submission = pending;
  sending = true;
  notice.hidden = true;
  controls();
  void api(`/api/sessions/${active}/prompt`, submission)
    .then(() => {
      if (active === submission.session && prompt.value === text) prompt.value = "";
      if (pending === submission) pending = undefined;
    })
    .catch(report)
    .finally(() => {
      sending = false;
      controls();
    });
};
prompt.oninput = controls;
stop.onclick = () => {
  if (active) void api(`/api/sessions/${active}/stop`, {}).catch(report);
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
    void refresh().catch(report);
  }
});
window.addEventListener("pagehide", () => {
  source?.close();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted && active) attach(active);
});
void refresh()
  .then(() => {
    const id = new URL(location.href).searchParams.get("session");
    if (id && catalog.sessions.some((session) => session.id === id)) attach(id);
  })
  .catch(report);
controls();
