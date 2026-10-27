import "../tree-view.ts";
import { openStream } from "./transport.ts";
import { installPwa, installPreferences } from "../pwa.ts";
type App = {
  ports: {
    stream: {
      subscribe(callback: (value: { path: string; epoch: number; pane?: string }) => void): void;
    };
    persist: { subscribe(callback: (value: unknown) => void): void };
    browser: { subscribe(callback: (value: BrowserRequest) => void): void };
    incoming: { send(value: { kind: string; epoch: number; payload: unknown }): void };
  };
};
type BrowserRequest =
  | { kind: "opened"; value: Record<string, Record<string, boolean>> }
  | { kind: "rendered"; epoch: number }
  | { kind: "download"; url: string }
  | { kind: "selection"; caret: number }
  | { kind: "highlight"; query: string; entries: number[]; current: number | null }
  | { kind: "focus" | "reveal" | "dialog"; id: string }
  | { kind: "resize" | "latest" | "cancel-completions" };
declare const Elm: { Main: { init(options: { flags: unknown }): App } };

// These elements own their contents and measured truncation. Elm owns input attributes and placement.
const highlighterURL = "/highlight.js";
let highlighter: Promise<typeof import("../highlight.ts")> | undefined;
class ElmCommand extends HTMLElement {
  static observedAttributes = ["source"];
  private readonly text = document.createElement("span");
  private readonly sizes = new ResizeObserver(() => this.measure());
  constructor() {
    super();
    this.text.className = "tool-command-text";
  }
  connectedCallback() {
    this.replaceChildren(this.text);
    this.render();
    this.sizes.observe(this);
  }
  disconnectedCallback() {
    this.sizes.disconnect();
  }
  attributeChangedCallback() {
    if (this.isConnected) this.render();
  }
  private render() {
    this.text.textContent = this.getAttribute("source") ?? "";
    this.measure();
  }
  private measure() {
    this.dataset.truncated = String(this.text.scrollWidth > this.clientWidth);
  }
}
class ElmCode extends HTMLElement {
  static observedAttributes = ["language", "source"];
  connectedCallback() {
    this.render();
  }
  attributeChangedCallback() {
    if (this.isConnected) this.render();
  }
  private render() {
    const source = this.getAttribute("source") ?? "";
    const language = this.getAttribute("language") ?? "";
    const code = document.createElement("code");
    code.textContent = source;
    const pre = document.createElement("pre");
    pre.append(code);
    this.replaceChildren(pre);
    if (language) {
      highlighter ??= import(highlighterURL);
      void highlighter.then(({ default: hljs }) => {
        if (code.isConnected && hljs.getLanguage(language))
          code.innerHTML = hljs.highlight(source, { language, ignoreIllegals: true }).value;
      });
    }
  }
}
class ElmTime extends HTMLElement {
  static observedAttributes = ["timestamp"];
  private static time: Intl.DateTimeFormat | undefined;
  private static dateTime: Intl.DateTimeFormat | undefined;
  connectedCallback() {
    this.render();
  }
  attributeChangedCallback() {
    if (this.isConnected) this.render();
  }
  private render() {
    const date = new Date(Number(this.getAttribute("timestamp")));
    if (!Number.isFinite(date.getTime())) {
      this.textContent = "";
      this.title = "";
      return;
    }
    ElmTime.time ??= new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit" });
    ElmTime.dateTime ??= new Intl.DateTimeFormat([], {
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    this.textContent = ElmTime.time.format(date);
    this.title = ElmTime.dateTime.format(date);
  }
}
customElements.define("elm-command", ElmCommand);
customElements.define("elm-code", ElmCode);
customElements.define("elm-time", ElmTime);
let drafts: unknown = {};
try {
  drafts = JSON.parse(sessionStorage.getItem("pi.elm.drafts") ?? "{}");
} catch {
  /* Optional storage. */
}
let opened: unknown = {};
try {
  opened = JSON.parse(sessionStorage.getItem("pi.elm.opened") ?? "{}");
} catch {
  /* Optional disclosure restoration. */
}
const app = Elm.Main.init({ flags: { nonce: crypto.randomUUID(), drafts, opened } });
document.body.classList.add("stacked-layout", "bottom-align");
installPwa();
installPreferences();
let stopStream: (() => void) | undefined;
let epoch = 0;
let path = location.pathname;
let pane = "";
const positions = new Map<string, number>();
try {
  const saved: unknown = JSON.parse(sessionStorage.getItem("pi.elm.scroll") ?? "{}");
  if (saved && typeof saved === "object")
    for (const [key, value] of Object.entries(saved))
      if (
        key.startsWith("/sessions/") &&
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= 0
      )
        positions.set(key, value);
} catch {
  /* Optional scroll restoration. */
}
let restore = positions.get(path);
let pinned = restore === undefined;
const scroll = () => document.querySelector<HTMLElement>("#conversation-scroll");
const prompt = () => document.querySelector<HTMLTextAreaElement>("#prompt");
const send = (kind: string, payload: unknown) => app.ports.incoming.send({ kind, epoch, payload });
const afterRender = (callback: () => void) =>
  requestAnimationFrame(() => requestAnimationFrame(callback));
let resizedPrompt: HTMLTextAreaElement | null = null;
let resizedValue = "";
let promptWidth: number | undefined;
const promptObserver = new ResizeObserver((entries) => {
  for (const entry of entries) {
    if (entry.target !== resizedPrompt) continue;
    const width = entry.borderBoxSize[0].inlineSize;
    if (!entry.target.isConnected || width !== promptWidth) {
      // Height changes also notify this observer. Only width changes invalidate sizing,
      // and writes run outside observer delivery to avoid a resize notification loop.
      const node = entry.target;
      requestAnimationFrame(() => {
        if (node === resizedPrompt) resize(true);
      });
    }
    promptWidth = width;
  }
});
function resize(force = false) {
  const node = prompt();
  if (node !== resizedPrompt) {
    promptObserver.disconnect();
    resizedPrompt = node;
    promptWidth = undefined;
    if (node) promptObserver.observe(node, { box: "border-box" });
    force = true;
  }
  if (!node || !node.checkVisibility() || (!force && node.value === resizedValue)) return;
  resizedValue = node.value;
  promptWidth = node.getBoundingClientRect().width;
  node.style.height = "auto";
  node.style.height = `${node.scrollHeight}px`;
}
function latest() {
  const node = scroll();
  if (node) {
    pinned = true;
    node.scrollTop = node.scrollHeight;
    send("latest", false);
  }
}
app.ports.stream.subscribe((request) => {
  stopStream?.();
  stopStream = undefined;
  epoch = request.epoch;
  if (!request.path) return;
  if (path !== request.path || (pane !== (request.pane ?? "") && !request.pane)) {
    // The old scrollport may already be gone. Positions are captured by scroll events.
    path = request.path;
    restore = positions.get(path);
    pinned = restore === undefined;
  }
  pane = request.pane ?? "";
  // Restore draft sizing even offline; leave a fresh empty composer to the first frame.
  afterRender(() => {
    const node = prompt();
    if (request.epoch === epoch && (node?.value || node?.style.height)) resize();
  });
  stopStream = openStream(
    `${request.path}/events${request.pane ? `?pane=${encodeURIComponent(request.pane)}` : ""}`,
    ({ kind, payload }) => {
      if (kind === "frame") {
        const node = scroll();
        if (node && !node.hidden && restore === undefined)
          pinned = node.scrollHeight - node.clientHeight - node.scrollTop < 32;
      }
      send(kind, payload);
    },
  );
});
app.ports.persist.subscribe((value) => {
  try {
    sessionStorage.setItem("pi.elm.drafts", JSON.stringify(value));
  } catch {
    /* In-memory drafts remain authoritative. */
  }
});
app.ports.browser.subscribe((request) => {
  if (request.kind === "opened") {
    try {
      sessionStorage.setItem("pi.elm.opened", JSON.stringify(request.value));
    } catch {
      /* Optional disclosure restoration. */
    }
    return;
  }
  if (request.kind === "cancel-completions") {
    clearTimeout(completionTimer);
    return;
  }
  const requestedEpoch = epoch;
  afterRender(() => {
    if (requestedEpoch !== epoch) return;
    switch (request.kind) {
      case "rendered": {
        if (request.epoch !== epoch) return;
        const node = scroll();
        if (node && !node.hidden) {
          if (restore !== undefined) {
            node.scrollTop = restore;
            restore = undefined;
          } else if (pinned && getSelection()?.isCollapsed !== false)
            node.scrollTop = node.scrollHeight;
          send("latest", node.scrollHeight - node.clientHeight - node.scrollTop >= 32);
        }
        resize();
        document.dispatchEvent(new Event("elm:rendered"));
        break;
      }
      case "highlight": {
        const highlight = new Highlight();
        if (request.query)
          for (const id of request.entries) {
            const article = document.getElementById(`entry-${id}`);
            if (!article) continue;
            const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
            for (
              let node = walker.nextNode();
              node && highlight.size < 2000;
              node = walker.nextNode()
            ) {
              if (node.parentElement?.closest("header")) continue;
              const text = (node.textContent ?? "").toLowerCase();
              for (
                let offset = text.indexOf(request.query);
                offset >= 0 && highlight.size < 2000;
                offset = text.indexOf(request.query, offset + request.query.length)
              ) {
                const range = document.createRange();
                range.setStart(node, offset);
                range.setEnd(node, offset + request.query.length);
                highlight.add(range);
              }
            }
          }
        CSS.highlights.set("pi-search", highlight);
        if (request.current !== null)
          document.getElementById(`entry-${request.current}`)?.scrollIntoView({ block: "center" });
        break;
      }
      case "download": {
        const link = document.createElement("a");
        link.href = request.url;
        link.download = "";
        link.click();
        break;
      }
      case "resize":
        resize(true);
        if (restore === undefined && pinned && scroll()?.checkVisibility()) latest();
        break;
      case "latest":
        latest();
        break;
      case "selection":
        prompt()?.focus();
        prompt()?.setSelectionRange(request.caret, request.caret);
        break;
      case "dialog":
        document.querySelector<HTMLDialogElement>(`#${request.id}`)?.showModal();
        break;
      case "focus":
        document.getElementById(request.id)?.focus();
        break;
      case "reveal":
        document.getElementById(request.id)?.scrollIntoView({ block: "center" });
        break;
    }
  });
});
document.addEventListener(
  "scroll",
  (event) => {
    const node = scroll();
    if (event.target === node && node && !node.hidden) {
      pinned = node.scrollHeight - node.clientHeight - node.scrollTop < 32;
      positions.set(path, node.scrollTop);
      send("latest", !pinned);
    }
  },
  true,
);
let completionTimer: ReturnType<typeof setTimeout> | undefined;
for (const name of ["input", "click", "keyup", "compositionend"])
  document.addEventListener(
    name,
    (event) => {
      if (event.target !== prompt() || prompt()?.closest("pi-tree")) return;
      if (
        event instanceof KeyboardEvent &&
        !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
      )
        return;
      clearTimeout(completionTimer);
      const requestedEpoch = epoch;
      completionTimer = setTimeout(() => {
        if (requestedEpoch === epoch) send("caret", prompt()?.selectionStart ?? 0);
      }, 120);
    },
    true,
  );
for (const name of ["paste", "drop"])
  document.addEventListener(name, (event) => {
    const files =
      event instanceof ClipboardEvent
        ? event.clipboardData?.files
        : event instanceof DragEvent
          ? event.dataTransfer?.files
          : undefined;
    if (files?.length && !document.querySelector("pi-tree")) {
      event.preventDefault();
      send("files", Array.from(files));
    }
  });
document.addEventListener("dragover", (event) => {
  if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
});
document.addEventListener("click", (event) => {
  const link =
    event.target instanceof Element && event.target.closest<HTMLAnchorElement>("pi-tree a");
  if (
    link &&
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    !event.altKey &&
    link.origin === location.origin
  ) {
    event.preventDefault();
    send("navigate", link.href);
    return;
  }
  const image =
    event.target instanceof Element &&
    event.target.closest<HTMLImageElement>("img.transcript-image");
  if (image) send("image", image.src);
});
document.addEventListener("keydown", (event) => {
  if (event.defaultPrevented || event.isComposing) return;
  if (document.querySelector("dialog[open]")) return;
  if ((event.ctrlKey || event.metaKey) && event.key === "k" && !event.shiftKey) {
    event.preventDefault();
    send("sessions", null);
    return;
  }
  if (event.key === "Escape") {
    const branches = document.querySelector<HTMLDetailsElement>("#branch-disclosure[open]");
    if (branches?.checkVisibility()) {
      branches.open = false;
      branches.querySelector("summary")?.focus();
      event.preventDefault();
      return;
    }

    send("dismiss", null);
    return;
  }
  if (event.key === "f" && (event.ctrlKey || event.metaKey) && scroll()?.checkVisibility()) {
    event.preventDefault();
    send("search", null);
  }
});
window.addEventListener("pagehide", () => {
  stopStream?.();
  try {
    sessionStorage.setItem("pi.elm.scroll", JSON.stringify(Object.fromEntries(positions)));
  } catch {
    /* Optional scroll restoration. */
  }
});

window.addEventListener("pageshow", (event) => {
  if (event.persisted) send("restored", null);
});
