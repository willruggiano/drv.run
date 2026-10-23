import type { HtmxRequestCtx } from "htmx.org";
import { composer, controls, resizePrompt, updateSend } from "./hypermedia-dom.ts";
import { restoreDraft } from "./hypermedia-drafts.ts";
import { previews } from "./hypermedia-attachments.ts";
import { closeCompletions } from "./hypermedia-completions.ts";
import { installStatus } from "./hypermedia-pwa.ts";
import { localPreferences } from "./hypermedia-settings.ts";
let selected: HTMLElement | undefined;
const positions = new Map<string, number>();
const disclosures = new Map<string, Map<string, boolean>>();
function disclosureKey(node: HTMLDetailsElement): string {
  if (node.dataset.disclosure) return node.dataset.disclosure;
  const article = node.closest("article");
  return `${article?.id}:${
    article
      ? Array.from(article.querySelectorAll("details"))
          .filter((item) => item.closest("article") === article)
          .indexOf(node)
      : 0
  }`;
}
function disconnect() {
  const scroll = selected?.querySelector<HTMLElement>(".scrollport");
  if (scroll) positions.set(selected!.dataset.events!, scroll.scrollTop);
  if (selected)
    disclosures.set(
      selected.dataset.events!,
      new Map(
        Array.from(selected.querySelectorAll<HTMLDetailsElement>("#transcript details"), (node) => [
          disclosureKey(node),
          node.open,
        ]),
      ),
    );
  selected = undefined;
}
function connect() {
  const root = document.querySelector<HTMLElement>("[data-events]") ?? undefined;
  if (root === selected && composer() === initialized) return;
  enhance(document);
  initializeComposer();
  if (root === selected) return;
  disconnect();
  selected = root;
  const scroll = document.querySelector<HTMLElement>(".scrollport");
  const opened = disclosures.get(root?.dataset.events ?? "");
  if (opened)
    root?.querySelectorAll<HTMLDetailsElement>("#transcript details").forEach((node) => {
      node.open = opened.get(disclosureKey(node)) ?? node.open;
    });
  if (scroll) {
    scroll.scrollTop = positions.get(root?.dataset.events ?? "") ?? scroll.scrollHeight;
    scroll.addEventListener("scroll", localStatus, { passive: true });
  }
}
function connection(event: Event, online: boolean) {
  const root = event.target;
  if (!(root instanceof HTMLElement) || !root.isConnected || !root.matches("[data-events]")) return;
  const status = root.querySelector("#connection");
  if (status) status.textContent = online ? "Connected" : "Disconnected; reconnecting…";
  localStatus();
}
const swaps = new WeakMap<
  HtmxRequestCtx,
  {
    targets: Element[];
    scroll: HTMLElement | null;
    pinned: boolean;
    selection?: { anchor: Node; anchorOffset: number; focus: Node; focusOffset: number };
  }
>();
function localStatus() {
  const meta = document.querySelector<HTMLElement>("#session-meta");
  if (meta) {
    document.body.classList.toggle("hide-thinking", meta.dataset.hideThinking === "true");
    document.body.classList.toggle("hide-images", meta.dataset.hideImages === "true");
    const title = document.querySelector("#conversation-title");
    if (title) title.textContent = meta.dataset.name ?? "";
  }
  const ordered = Array.from(
    document.querySelectorAll<HTMLElement>(
      "#transcript > article:not([hidden]), #live > article:not([hidden])",
    ),
  );
  let previous: string | undefined;
  ordered.forEach((node, index) => {
    const role = node.dataset.role === "toolResult" ? "assistant" : node.dataset.role;
    node.classList.toggle("same-speaker", role !== undefined && role === previous);
    node.dataset.separator = String(index > 0 && role !== previous);
    previous = role;
    const content = (item: Element) =>
      Array.from(item.children).filter((child) => !child.matches("header"));
    const next = ordered[index + 1];
    const traces =
      !!role &&
      next?.dataset.role === role &&
      !!content(node).at(-1)?.matches(".tool-call, .thinking") &&
      !!content(next)[0]?.matches(".tool-call, .thinking");
    node.classList.toggle("trace-continues", traces);
    next?.classList.toggle("trace-start", traces);
  });
  const scroll = document.querySelector<HTMLElement>(".scrollport");
  const button = document.querySelector<HTMLButtonElement>("[data-latest]");
  if (scroll && button)
    button.hidden = scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 32;
}
const commands = new Set<HTMLElement>();
function truncateCommand(command: HTMLElement) {
  const text = command.querySelector<HTMLElement>(".tool-command-text")!;
  // Compare the full text against the space WITHOUT the marker to avoid toggling
  // back and forth when the text fits but text plus marker does not.
  const truncated = String(text.scrollWidth > command.clientWidth);
  if (command.dataset.truncated !== truncated) command.dataset.truncated = truncated;
}
const commandSizes = new ResizeObserver((entries) => {
  for (const { target } of entries) {
    if (target instanceof HTMLElement && target.isConnected) truncateCommand(target);
  }
});
function enhanceCommands() {
  for (const command of commands) {
    if (!command.isConnected) {
      commandSizes.unobserve(command);
      commands.delete(command);
    }
  }
  for (const command of document.querySelectorAll<HTMLElement>(".tool-command")) {
    if (!command.querySelector(".tool-command-text")) {
      const text = document.createElement("span");
      text.className = "tool-command-text";
      text.append(...command.childNodes);
      command.append(text);
    }
    command.dataset.truncated ??= "false";
    truncateCommand(command);
    commands.add(command);
    commandSizes.observe(command);
  }
}
const highlighterURL = "/highlight.js";
let highlighter: Promise<typeof import("./highlight.ts")> | undefined;
function enhance(root: ParentNode) {
  root.querySelectorAll<HTMLTimeElement>("time[datetime]").forEach((time) => {
    const date = new Date(time.dateTime);
    time.textContent = time.hasAttribute("data-date-only")
      ? date.toLocaleDateString()
      : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    time.title = date.toLocaleString();
  });
  for (const code of root.querySelectorAll<HTMLElement>("pre > code:not([data-highlighted])")) {
    code.dataset.highlighted = "true";
    const language = code.dataset.language;
    if (language) {
      highlighter ??= import(highlighterURL);
      void highlighter.then(({ default: hljs }) => {
        if (hljs.getLanguage(language) && code.isConnected)
          code.innerHTML = hljs.highlight(code.textContent ?? "", {
            language,
            ignoreIllegals: true,
          }).value;
      });
    }
  }
  for (const name of Object.keys(localPreferences)) {
    const preference = document.querySelector<HTMLSelectElement>(`[data-preference=${name}]`);
    if (preference) preference.value = String(document.body.classList.contains(name));
  }
  enhanceCommands();
  localStatus();
  installStatus();
}
let initialized: HTMLFormElement | null = null;
function initializeComposer() {
  const form = composer();
  if (form === initialized) return;
  initialized = form;
  closeCompletions();
  if (!form) return;
  restoreDraft(form);
  const text = controls(form).text;
  text.setAttribute("aria-autocomplete", "list");
  text.setAttribute("aria-controls", "completions");
  previews();
  resizePrompt();
}

export function installStream() {
  document.addEventListener("htmx:sse:after:connection", (event) => connection(event, true));
  for (const name of ["htmx:sse:before:connection", "htmx:sse:error", "htmx:sse:close"])
    document.addEventListener(name, (event) => connection(event, false));

  document.addEventListener("htmx:before:swap", (event) => {
    const { ctx, tasks } = event.detail;
    // Public htmx.swap() permits an omitted sourceElement (HtmxSwapContext).
    const root = ctx.sourceElement ?? ctx.target ?? document.body;
    const streaming = root.hasAttribute("hx-sse:connect");
    if (streaming && !root.isConnected) {
      event.preventDefault();
      return;
    }
    const scroll = streaming ? root.querySelector<HTMLElement>(".scrollport") : null;
    const selection = getSelection();
    swaps.set(ctx, {
      targets: tasks.flatMap((task: { target?: Element }) => (task.target ? [task.target] : [])),
      scroll,
      pinned: !!scroll && scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 32,
      selection:
        streaming &&
        selection?.anchorNode &&
        selection.focusNode &&
        root.querySelector("#live")?.contains(selection.anchorNode) &&
        root.querySelector("#live")?.contains(selection.focusNode)
          ? {
              anchor: selection.anchorNode,
              anchorOffset: selection.anchorOffset,
              focus: selection.focusNode,
              focusOffset: selection.focusOffset,
            }
          : undefined,
    });
  });
  document.addEventListener("htmx:after:swap", (event) => {
    const state = swaps.get(event.detail.ctx);
    if (state) {
      const selection = state.selection;
      if (selection?.anchor.isConnected && selection.focus.isConnected) {
        const length = (node: Node) =>
          node.nodeType === Node.TEXT_NODE ? node.textContent!.length : node.childNodes.length;
        getSelection()?.setBaseAndExtent(
          selection.anchor,
          Math.min(selection.anchorOffset, length(selection.anchor)),
          selection.focus,
          Math.min(selection.focusOffset, length(selection.focus)),
        );
      }
      for (const target of state.targets) {
        const current = target.isConnected
          ? target
          : target.id
            ? document.getElementById(target.id)
            : null;
        if (current) enhance(current);
      }
      if (state.pinned && state.scroll && !getSelection()?.toString())
        state.scroll.scrollTop = state.scroll.scrollHeight;
      swaps.delete(event.detail.ctx);
    }
    connect();
    enhanceCommands();
    localStatus();
    updateSend();
  });

  document.addEventListener("htmx:before:swap", (event) => {
    if (
      event.detail.ctx.target === document.querySelector("#page") &&
      event.detail.ctx.swap !== "none"
    )
      disconnect();
  });
  window.addEventListener("pagehide", disconnect);
  window.addEventListener("pageshow", connect);
  document.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest("[data-latest]")) {
      const scroll = document.querySelector<HTMLElement>(".scrollport");
      if (scroll) scroll.scrollTop = scroll.scrollHeight;
    }
  });
  document.documentElement.classList.add("enhanced");
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", connect);
  else connect();
}
