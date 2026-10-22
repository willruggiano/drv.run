import type { Htmx, HtmxRequestCtx } from "htmx.org";
import { completionToken, type CompletionToken } from "./completions.ts";
import { installSelectKeyMappings, navigationDirection, moveFocus } from "./key-mappings.ts";

// The pinned standalone htmx distribution is loaded before this module.
declare const htmx: Htmx;

// This adapter owns only transport, keyed DOM reconciliation and local drafts.
// Links and forms (including review) get their operations from the server.
const representations = new WeakMap<Element, string>();
export function reconcileFragments(root: HTMLElement, source: string): void {
  const fragment = document.createElement("template");
  fragment.innerHTML = source;
  const scroll = root.querySelector<HTMLElement>(".scrollport");
  const pinned = scroll
    ? scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 32
    : innerHeight + scrollY >= document.documentElement.scrollHeight - 32;
  for (const template of fragment.content.querySelectorAll<HTMLTemplateElement>("template")) {
    if (template.dataset.entries !== undefined) {
      const transcript = root.querySelector("#transcript");
      if (!transcript) continue;
      const ids = template.dataset.entries.split(" ").filter(Boolean);
      const keep = new Set(ids);
      for (const child of transcript.querySelectorAll<HTMLElement>("[data-entry]"))
        if (!keep.has(child.dataset.entry!)) child.remove();
      const nodes = new Map(
        ids.map((id) => [
          id,
          transcript.querySelector(`#entry-${CSS.escape(id)}`) ??
            template.content.querySelector(`#entry-${CSS.escape(id)}`),
        ]),
      );
      const layout = template.dataset.layout
        ? (JSON.parse(template.dataset.layout) as Record<string, number[]>)
        : { transcript: ids.map(Number) };
      // Create all containers before placing children; archives can nest.
      for (const node of nodes.values()) if (node && !node.isConnected) transcript.append(node);
      for (const [container, children] of Object.entries(layout)) {
        const parent = root.querySelector(`#${CSS.escape(container)}`);
        if (!parent) continue;
        let previous: Element | null = null;
        for (const id of children) {
          const element = nodes.get(String(id));
          if (!element) continue;
          const next: Element | null = previous
            ? previous.nextElementSibling
            : parent.firstElementChild;
          if (next !== element) {
            if (typeof parent.moveBefore === "function") parent.moveBefore(element, next);
            else parent.insertBefore(element, next);
          }
          previous = element;
        }
      }
      htmx.process(transcript);
      enhance(transcript);
    } else if (template.dataset.region) {
      const old = root.querySelector(`#${CSS.escape(template.dataset.region)}`);
      const replacement = template.content.firstElementChild;
      if (!old || !replacement) continue;
      const representation = replacement.outerHTML;
      if ((representations.get(old) ?? old.outerHTML) === representation) continue;
      representations.set(replacement, representation);
      // Disclosure is local even while the live text changes.
      if (old instanceof HTMLDetailsElement && replacement instanceof HTMLDetailsElement)
        replacement.open = old.open;
      const opened = Array.from(old.querySelectorAll("details"), (node) => node.open);
      replacement.querySelectorAll("details").forEach((node, index) => {
        node.open = opened[index] ?? node.open;
      });
      old.replaceWith(replacement);
      htmx.process(replacement);
      enhance(replacement);
    }
  }
  if (pinned && !getSelection()?.toString()) {
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
    else scrollTo(0, document.documentElement.scrollHeight);
  }
  localStatus();
  updateSend();
}

type Draft = { text: string; files: File[]; requestId: string; creationId?: string };
const drafts = new Map<string, Draft>();
const requestPages = new WeakMap<HtmxRequestCtx, number>();
let pageRevision = 0;
let selected: HTMLElement | undefined;
let events: EventSource | undefined;
let previewRevision = 0;
function composer(): HTMLFormElement | null {
  return document.querySelector("#composer");
}
function controls(form: HTMLFormElement) {
  return {
    text: form.querySelector<HTMLTextAreaElement>("textarea")!,
    files: form.querySelector<HTMLInputElement>('input[type="file"]')!,
    request: form.querySelector<HTMLInputElement>('[name="requestId"]')!,
  };
}
function updateSend() {
  const form = composer();
  const button = document.querySelector<HTMLButtonElement>("#send");
  if (form && button) {
    const { text, files } = controls(form);
    button.disabled = text.readOnly || (!text.value.trim() && !files.files?.length);
  }
}
function resizePrompt() {
  const text = composer()?.querySelector<HTMLTextAreaElement>('textarea[name="content"]');
  if (!text) return;
  text.style.height = "auto";
  text.style.height = `${text.scrollHeight}px`;
  updateSend();
}
function saveDraft() {
  resizePrompt();
  const form = composer();
  if (!form) return;
  const { text, files, request } = controls(form);
  const draft = {
    text: text.value,
    files: Array.from(files.files ?? []),
    requestId: request.value,
    creationId: form.querySelector<HTMLInputElement>('[name="id"]')?.value,
  };
  drafts.set(form.action, draft);
  try {
    if (draft.text)
      sessionStorage.setItem(
        `pi.html.draft:${form.action}`,
        JSON.stringify({
          text: draft.text,
          requestId: draft.requestId,
          creationId: draft.creationId,
        }),
      );
    else sessionStorage.removeItem(`pi.html.draft:${form.action}`);
  } catch {
    /* Storage can be disabled. In-memory drafts still work. */
  }
}
function previews() {
  const revision = ++previewRevision;
  const form = composer();
  if (!form) return;
  const container = form.querySelector("#previews")!;
  container.replaceChildren();
  for (const [index, file] of Array.from(controls(form).files.files ?? []).entries()) {
    if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) continue;
    const image = document.createElement("img");
    image.alt = file.name;
    const reader = new FileReader();
    reader.onload = () => {
      if (
        revision !== previewRevision ||
        !container.isConnected ||
        typeof reader.result !== "string"
      )
        return;
      image.src = reader.result;
      const preview = document.createElement("div");
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = `Remove ${file.name}`;
      remove.addEventListener("click", () => {
        const transfer = new DataTransfer();
        Array.from(controls(form).files.files ?? [])
          .filter((_, i) => i !== index)
          .forEach((file) => transfer.items.add(file));
        controls(form).files.files = transfer.files;
        controls(form).files.dispatchEvent(new Event("input", { bubbles: true }));
        previews();
      });
      preview.append(image, remove);
      container.append(preview);
    };
    reader.readAsDataURL(file);
  }
}
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
  closeActions();
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
  events?.close();
  events = undefined;
  selected = undefined;
}
function connect() {
  enhance(document);
  initializeComposer();
  const root = document.querySelector<HTMLElement>("[data-events]");
  if (root === selected) return;
  disconnect();
  if (!root) return;
  selected = root;
  const source = new EventSource(root.dataset.events!);
  events = source;
  const status = root.querySelector("#connection")!;
  source.onopen = () => {
    if (root.isConnected) {
      status.textContent = "Connected";
      document.body.classList.remove("offline");
      localStatus();
    }
  };
  source.onerror = () => {
    if (root.isConnected) {
      status.textContent = "Disconnected; reconnecting…";
      document.body.classList.add("offline");
      localStatus();
    }
  };
  source.addEventListener("fragments", (event: MessageEvent<string>) => {
    if (selected !== root || !root.isConnected) return;
    reconcileFragments(root, event.data);
  });
}

document.addEventListener("input", (event) => {
  const form = composer();
  if (!form || !(event.target instanceof Element) || !form.contains(event.target)) return;
  controls(form).request.value = crypto.randomUUID();
  saveDraft();
});
document.addEventListener("change", (event) => {
  if (event.target instanceof HTMLInputElement && event.target.type === "file") {
    previews();
    updateSend();
  }
});
document.addEventListener("htmx:before:request", (event) => {
  requestPages.set(event.detail.ctx, pageRevision);
  const activation = commandRequests.get(event.detail.ctx.sourceElement);
  if (activation) {
    commandAcknowledgements.set(event.detail.ctx, activation);
    commandRequests.delete(event.detail.ctx.sourceElement);
  }
  const form = composer();
  if (!form || event.detail.ctx.sourceElement !== form) return;
  // FormData is already collected. Lock only until this attempt settles.
  controls(form).text.readOnly = true;
  controls(form).files.disabled = true;
  saveDraft();
});
document.addEventListener("htmx:after:request", (event) => {
  const { response, sourceElement, text } = event.detail.ctx;
  if (response && response.status >= 400 && sourceElement.isConnected) {
    const fragment = document.createElement("template");
    fragment.innerHTML = text ?? "";
    report(
      fragment.content.querySelector("#request-error")?.textContent ||
        fragment.content.querySelector("p")?.textContent ||
        `Request failed (${response.status}).`,
    );
  }
  const activation = commandAcknowledgements.get(event.detail.ctx);
  if (activation && response && response.status < 400) {
    const draft = drafts.get(activation.key);
    if (draft?.requestId === activation.requestId) deleteDraft(activation.key);
    const form = composer();
    if (form?.action === activation.key && controls(form).request.value === activation.requestId)
      controls(form).text.value = "";
    commandAcknowledgements.delete(event.detail.ctx);
  }
  // A slow response from a page we left must not redirect or replace the new page.
  // HX-Trigger acknowledgements still run in htmx's finally block.
  if (requestPages.get(event.detail.ctx) !== pageRevision) event.preventDefault();
});
document.addEventListener("htmx:finally:request", (event) => {
  const { sourceElement, response } = event.detail.ctx;
  if (sourceElement instanceof HTMLFormElement && sourceElement.getAttribute("id") === "composer") {
    controls(sourceElement).text.readOnly = false;
    controls(sourceElement).files.disabled = false;
    updateSend();
  }
  if (!response && sourceElement.isConnected) {
    const error = document.querySelector("#request-error");
    if (error)
      error.textContent = "Connection lost. Your draft is retained; retry the same submission.";
  }
});
document.addEventListener("submitted", (event) => {
  if (!(event instanceof CustomEvent)) return;
  const { requestId } = event.detail as { requestId: string };
  // A response from an old page may acknowledge its draft, never the new page's.
  for (const [key, draft] of drafts) if (draft.requestId === requestId) deleteDraft(key);
  const form = composer();
  if (!form || controls(form).request.value !== requestId) return;
  controls(form).text.value = "";
  controls(form).files.value = "";
  controls(form).request.value = crypto.randomUUID();
  const creation = form.querySelector<HTMLInputElement>('[name="id"]');
  if (creation) creation.value = crypto.randomUUID();
  previews();
  resizePrompt();
  const error = document.querySelector("#request-error");
  if (error) error.textContent = "";
});
document.addEventListener("htmx:before:swap", (event) => {
  if (
    event.detail.ctx.target === document.querySelector("#page") &&
    event.detail.ctx.swap !== "none"
  ) {
    saveDraft();
    disconnect();
    pageRevision++;
  }
});
document.addEventListener("htmx:after:settle", connect);
window.addEventListener("pagehide", () => {
  saveDraft();
  disconnect();
});
window.addEventListener("pageshow", connect);

function deleteDraft(key: string) {
  drafts.delete(key);
  try {
    sessionStorage.removeItem(`pi.html.draft:${key}`);
  } catch {
    /* Storage can be disabled. */
  }
}
function report(message: string) {
  const output = document.querySelector("#request-error");
  if (output) output.textContent = message;
}
function localStatus() {
  const meta = document.querySelector<HTMLElement>("#session-meta");
  if (meta) {
    document.body.classList.toggle("hide-thinking", meta.dataset.hideThinking === "true");
    document.body.classList.toggle("hide-images", meta.dataset.hideImages === "true");
    const title = document.querySelector("#conversation-title");
    if (title) title.textContent = meta.dataset.name ?? "";
  }
  const status = document.querySelector<HTMLElement>("#status");
  if (status && document.querySelector("[data-events]"))
    status.dataset.state = document.body.classList.contains("offline")
      ? "reconnecting"
      : (document.querySelector<HTMLElement>("#controls")?.dataset.state ?? "ready");
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
      Array.from(item.children).filter(
        (child) => !child.matches("header, .entry-actions, textarea[hidden]"),
      );
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
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Copy code";
    button.className = "code-copy";
    button.addEventListener(
      "click",
      () =>
        void navigator.clipboard
          .writeText(code.textContent ?? "")
          .catch((error) => report(String(error))),
    );
    code.parentElement!.append(button);
  }
  const preference = document.querySelector<HTMLSelectElement>("[data-preference=wrap-code]");
  if (preference) preference.value = String(document.body.classList.contains("wrap-code"));
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
  let draft = drafts.get(form.action);
  if (!draft) {
    try {
      const saved: unknown = JSON.parse(
        sessionStorage.getItem(`pi.html.draft:${form.action}`) ?? "null",
      );
      if (
        saved &&
        typeof saved === "object" &&
        "text" in saved &&
        typeof saved.text === "string" &&
        "requestId" in saved &&
        typeof saved.requestId === "string"
      )
        draft = {
          text: saved.text,
          requestId: saved.requestId,
          files: [],
          creationId:
            "creationId" in saved && typeof saved.creationId === "string"
              ? saved.creationId
              : undefined,
        };
    } catch {
      /* Invalid or disabled draft storage is not authoritative. */
    }
    if (draft) drafts.set(form.action, draft);
  }
  if (draft) {
    const { text, files, request } = controls(form);
    text.value = draft.text;
    request.value = draft.requestId;
    const id = form.querySelector<HTMLInputElement>('[name="id"]');
    if (id && draft.creationId && (draft.text || draft.files.length)) id.value = draft.creationId;
    const transfer = new DataTransfer();
    draft.files.forEach((file) => transfer.items.add(file));
    files.files = transfer.files;
  }
  const text = controls(form).text;
  text.setAttribute("aria-autocomplete", "list");
  text.setAttribute("aria-controls", "completions");
  previews();
  resizePrompt();
  const scroll = document.querySelector<HTMLElement>(".scrollport");
  const root = document.querySelector<HTMLElement>("[data-events]");
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
// Commands activate the forms and links advertised by this representation.
// No endpoints or workflow response types are known here.
const commandRequests = new WeakMap<Element, { key: string; requestId: string }>();
const commandAcknowledgements = new WeakMap<HtmxRequestCtx, { key: string; requestId: string }>();
document.addEventListener(
  "submit",
  (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || form.getAttribute("id") !== "composer") return;
    const { text, files, request } = controls(form);
    const match = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(text.value.trim());
    if (!text.value.startsWith("/")) return;
    if (event.submitter?.dataset.command === match?.[1]) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const control =
      match &&
      document.querySelector<HTMLElement>(`[data-command="${CSS.escape(match[1].toLowerCase())}"]`);
    if (!control) {
      report("Command is not available here.");
      return;
    }
    if (files.files?.length) {
      report("Commands do not accept images.");
      return;
    }
    const argument = control.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      "[data-command-argument]",
    );
    if (match?.[2] && !argument) {
      report("This command does not accept arguments.");
      return;
    }
    if (argument) argument.value = match?.[2] ?? "";
    saveDraft();
    control.querySelectorAll<HTMLInputElement>("[data-command-request]").forEach((input) => {
      input.value = request.value;
    });
    if (!control.hasAttribute("data-command-deferred"))
      commandRequests.set(
        control instanceof HTMLButtonElement && control.form ? control.form : control,
        { key: form.action, requestId: request.value },
      );
    closeCompletions();
    if (control instanceof HTMLFormElement) control.requestSubmit();
    else if (control instanceof HTMLAnchorElement) {
      control.click();
      if (control.hasAttribute("download")) {
        text.value = "";
        saveDraft();
      }
    } else if (control instanceof HTMLButtonElement && control.type === "submit")
      setTimeout(() => control.form?.requestSubmit(control), 0);
    else {
      control.click();
      text.value = "";
      saveDraft();
    }
  },
  true,
);

let completionRevision = 0;
let completionTimer: ReturnType<typeof setTimeout> | undefined;
let token: CompletionToken | undefined;
let completionIndex = 0;
function closeCompletions() {
  completionRevision++;
  clearTimeout(completionTimer);
  token = undefined;
  const popup = document.querySelector<HTMLElement>("#completions");
  if (popup) {
    popup.hidden = true;
    popup.replaceChildren();
  }
}
function completionItems() {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("#completions [data-completion]"));
}
function selectCompletion(index: number) {
  const items = completionItems();
  if (!items.length) return;
  completionIndex = (index + items.length) % items.length;
  items.forEach((item, i) => item.setAttribute("aria-selected", String(i === completionIndex)));
  items[completionIndex].scrollIntoView({ block: "nearest" });
}
function applyCompletion(item: HTMLButtonElement) {
  const form = composer();
  if (!form || !token) return;
  const text = controls(form).text;
  text.setRangeText(item.dataset.completion!, token.start, token.end, "end");
  closeCompletions();
  text.focus();
  text.dispatchEvent(new Event("input", { bubbles: true }));
}
document.addEventListener("input", (event) => {
  const form = composer();
  if (
    !form ||
    event.target !== controls(form).text ||
    (event instanceof InputEvent && event.isComposing)
  )
    return;
  const text = controls(form).text;
  closeCompletions();
  token = completionToken(text.value, text.selectionStart);
  if (!token || !form.dataset.completions) return;
  const revision = completionRevision;
  const url = new URL(form.dataset.completions, location.href);
  url.searchParams.set("kind", token.kind);
  url.searchParams.set("query", token.query);
  completionTimer = setTimeout(
    () => {
      void fetch(url)
        .then(async (response) => {
          const html = await response.text();
          if (!response.ok || revision !== completionRevision || !form.isConnected) return;
          const fragment = document.createElement("template");
          fragment.innerHTML = html;
          const next = fragment.content.querySelector("#completions");
          const popup = form.querySelector<HTMLElement>("#completions");
          if (!next || !popup) return;
          popup.replaceChildren(...next.childNodes);
          popup.hidden = !popup.childElementCount;
          selectCompletion(0);
        })
        .catch(() => {
          if (revision === completionRevision) closeCompletions();
        });
    },
    token.kind === "path" ? 120 : 0,
  );
});
document.addEventListener("pointerdown", (event) => {
  if (event.target instanceof Element && event.target.closest("[data-completion]"))
    event.preventDefault();
});
let directoryRevision = 0;
document.addEventListener("input", (event) => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || !input.dataset.suggest) return;
  const revision = ++directoryRevision;
  const url = new URL(input.dataset.suggest, location.href);
  const form = input.form;
  if (!form) return;
  const target = new FormData(form).get("target");
  if (typeof target !== "string") return;
  url.searchParams.set("query", input.value);
  url.searchParams.set("target", target);
  void fetch(url)
    .then(async (response) => {
      const html = await response.text();
      if (!response.ok || revision !== directoryRevision || !input.isConnected) return;
      const fragment = document.createElement("template");
      fragment.innerHTML = html;
      const next = fragment.content.querySelector("datalist");
      if (next && input.list) input.list.replaceChildren(...next.childNodes);
    })
    .catch(() => {});
});

let searchIndex = 0;
function search(step = 0) {
  const input = document.querySelector<HTMLInputElement>("#search");
  if (!input) return;
  const value = document.querySelector<HTMLElement>("#search-bar")?.hidden
    ? ""
    : input.value.trim().toLocaleLowerCase();
  const nodes = Array.from(document.querySelectorAll<HTMLElement>("#transcript article"));
  const matches = nodes.filter((node) => {
    // Exclude nested archives and hidden copy-source controls from this entry's text.
    const own = Array.from(
      node.querySelectorAll<HTMLElement>(".text, pre, .thinking, .tool-command"),
    )
      .filter((part) => part.closest("article") === node)
      .map((part) => part.textContent)
      .join("\n");
    const matched = !!value && own.toLocaleLowerCase().includes(value);
    node.classList.toggle("search-hit", matched);
    node.classList.remove("search-current");
    return matched;
  });
  searchIndex = matches.length ? (searchIndex + step + matches.length) % matches.length : 0;
  const node = matches[searchIndex];
  if (node) {
    for (let parent = node.parentElement; parent; parent = parent.parentElement)
      if (parent instanceof HTMLDetailsElement) parent.open = true;
    for (const details of node.querySelectorAll("details"))
      if (details.textContent?.toLocaleLowerCase().includes(value)) details.open = true;
    node.classList.add("search-current");
    node.scrollIntoView({ block: "center" });
  }
  if (typeof Highlight !== "undefined" && CSS.highlights) {
    const highlight = new Highlight();
    if (value)
      for (const article of matches) {
        const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
        for (
          let node = walker.nextNode();
          node && highlight.size < 2000;
          node = walker.nextNode()
        ) {
          if (
            node.parentElement?.closest("header, button, textarea, .entry-actions") ||
            node.parentElement?.closest("article") !== article
          )
            continue;
          const text = (node.textContent ?? "").toLocaleLowerCase();
          for (
            let at = text.indexOf(value);
            at >= 0 && highlight.size < 2000;
            at = text.indexOf(value, at + value.length)
          ) {
            const range = document.createRange();
            range.setStart(node, at);
            range.setEnd(node, at + value.length);
            highlight.add(range);
          }
        }
      }
    CSS.highlights.set("pi-search", highlight);
  }
  const count = document.querySelector("#search-count");
  if (count) count.textContent = matches.length ? `${searchIndex + 1}/${matches.length}` : "0/0";
}
document.addEventListener("input", (event) => {
  if (event.target instanceof HTMLInputElement && event.target.id === "search") {
    searchIndex = 0;
    search();
  }
});
document.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  if (heldOwner?.contains(event.target)) {
    heldOwner = undefined;
    event.preventDefault();
    return;
  }
  const trigger = event.target.closest(".entry-actions > summary");
  if (trigger) {
    event.preventDefault();
    const owner = trigger.parentElement?.parentElement;
    if (owner) revealActions(owner);
    return;
  }
  const button = event.target.closest<HTMLButtonElement>("button");
  if (button?.dataset.filePicker) document.getElementById(button.dataset.filePicker)?.click();
  if (button?.dataset.completion !== undefined) applyCompletion(button);
  if (button?.hasAttribute("data-latest")) {
    const scroll = document.querySelector<HTMLElement>(".scrollport");
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  }
  if (button?.hasAttribute("data-search-toggle")) {
    const bar = document.querySelector<HTMLElement>("#search-bar");
    if (bar) {
      bar.hidden = !bar.hidden;
      for (const popup of document.querySelectorAll<HTMLElement>("nav:popover-open"))
        popup.hidePopover();
      if (!bar.hidden) bar.querySelector("input")?.focus();
    }
  }
  if (button?.dataset.searchStep) search(Number(button.dataset.searchStep));
  if (button?.dataset.copy) {
    const container = button.closest(".tool-call, article") ?? activeActions?.owner;
    const source = container?.querySelector<HTMLTextAreaElement>(
      `[data-copy-source="${CSS.escape(button.dataset.copy)}"]`,
    );
    if (source)
      void navigator.clipboard.writeText(source.value).catch((error) => report(String(error)));
  }
  if (button?.hasAttribute("data-quote")) {
    const source = (
      button.closest(".tool-call, article") ?? activeActions?.owner
    )?.querySelector<HTMLTextAreaElement>(
      `[data-copy-source="${CSS.escape(button.dataset.quote || "message")}"]`,
    );
    const form = composer();
    if (source && form) {
      const text = controls(form).text;
      const value = `${text.value}${text.value ? "\n\n" : ""}${source.value
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")}\n\n`;
      if (value.length > text.maxLength) {
        report("Quote exceeds the message limit.");
        return;
      }
      text.value = value;
      text.focus();
      text.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }
  if (button?.dataset.copy || button?.hasAttribute("data-quote")) closeActions();
  const image = event.target.closest<HTMLImageElement>("img.transcript-image");
  if (image) {
    const dialog = document.createElement("dialog");
    dialog.id = "image-dialog";
    const close = document.createElement("button");
    close.textContent = "Close image";
    close.addEventListener("click", () => dialog.close());
    dialog.append(image.cloneNode(true), close);
    dialog.addEventListener("close", () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
  }
});
function actionOwner(target: EventTarget | null): HTMLElement | null {
  if (
    !(target instanceof Element) ||
    target.closest("a, button, input, textarea, select, pre, code, img, [contenteditable]") ||
    getSelection()?.toString()
  )
    return null;
  return target.closest<HTMLElement>("#transcript .tool-call, #transcript article");
}
let activeActions:
  | { owner: HTMLElement; menu: HTMLElement; parent: HTMLDetailsElement }
  | undefined;
function closeActions() {
  const active = activeActions;
  if (!active) return;
  activeActions = undefined;
  if (active.menu.matches(":popover-open")) active.menu.hidePopover();
  active.menu.removeAttribute("popover");
  active.parent.open = false;
  if (active.parent.isConnected) active.parent.append(active.menu);
  else active.menu.remove();
}
function revealActions(owner: HTMLElement, point?: { x: number; y: number }) {
  if (!owner.isConnected) return;
  closeActions();
  const parent = owner.querySelector<HTMLDetailsElement>(":scope > .entry-actions");
  const menu = parent?.querySelector<HTMLElement>(".action-menu");
  if (!parent || !menu) return;
  const rect = (
    owner.querySelector(":scope > summary, :scope > header") ?? owner
  ).getBoundingClientRect();
  activeActions = { owner, menu, parent };
  parent.open = true;
  menu.setAttribute("popover", "manual");
  document.querySelector("#page")!.append(menu);
  menu.ontoggle = () => {
    if (!menu.matches(":popover-open") && activeActions?.menu === menu) closeActions();
  };
  menu.showPopover();
  if (!point && matchMedia("(hover: none), (pointer: coarse)").matches)
    point = { x: rect.left + 16, y: rect.top + 16 };
  const trigger = parent.querySelector("summary")!.getBoundingClientRect();
  if (!point) {
    menu.style.left = `${Math.max(8, Math.min(innerWidth - menu.offsetWidth - 8, trigger.right - menu.offsetWidth))}px`;
    menu.style.top = `${Math.max(8, Math.min(innerHeight - menu.offsetHeight - 8, trigger.bottom + 4))}px`;
    return;
  }
  const x = point.x;
  const y = point.y;
  menu.style.left = `${Math.max(8, Math.min(innerWidth - menu.offsetWidth - 8, x + 12))}px`;
  menu.style.top = `${Math.max(8, Math.min(innerHeight - menu.offsetHeight - 8, point && y - menu.offsetHeight - 12 >= 8 ? y - menu.offsetHeight - 12 : y + 12))}px`;
}

let heldOwner: HTMLElement | undefined;
let hold:
  | { pointer: number; x: number; y: number; timer: ReturnType<typeof setTimeout> }
  | undefined;
function cancelHold() {
  clearTimeout(hold?.timer);
  hold = undefined;
}
document.addEventListener("pointerdown", (event) => {
  cancelHold();
  heldOwner = undefined;
  if (activeActions && event.target instanceof Node && !activeActions.menu.contains(event.target))
    closeActions();
  if (event.pointerType !== "touch" || !event.isPrimary) return;
  const owner = actionOwner(event.target);
  if (!owner) return;
  hold = {
    pointer: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    timer: setTimeout(() => {
      const point = hold && { x: hold.x, y: hold.y };
      cancelHold();
      heldOwner = owner;
      revealActions(owner, point);
    }, 500),
  };
});
document.addEventListener("pointermove", (event) => {
  if (
    hold &&
    event.pointerId === hold.pointer &&
    Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > 8
  )
    cancelHold();
});
for (const name of ["pointerup", "pointercancel"]) document.addEventListener(name, cancelHold);
document.addEventListener("scroll", cancelHold, { capture: true, passive: true });
window.addEventListener("blur", cancelHold);
document.addEventListener("contextmenu", (event) => {
  const owner = actionOwner(event.target);
  if (owner) {
    event.preventDefault();
    cancelHold();
    revealActions(owner);
  }
});

function addFiles(files: File[]) {
  const form = composer();
  if (!form) return;
  const input = controls(form).files;
  const selected = [...Array.from(input.files ?? []), ...files];
  if (
    selected.some((file) => !/^image\/(png|jpeg|gif|webp)$/.test(file.type)) ||
    selected.length > 4 ||
    selected.reduce((n, file) => n + file.size, 0) > 5 * 1024 * 1024
  ) {
    report("Attach up to four raster images, totaling at most 5 MiB.");
    return;
  }
  const transfer = new DataTransfer();
  selected.forEach((file) => transfer.items.add(file));
  input.files = transfer.files;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  previews();
}
document.addEventListener("paste", (event) => {
  if (
    !(event.target instanceof Element) ||
    !event.target.closest("#composer") ||
    !event.clipboardData?.files.length
  )
    return;
  event.preventDefault();
  addFiles(Array.from(event.clipboardData.files));
});
document.addEventListener("dragover", (event) => {
  if (composer() && event.dataTransfer?.types.includes("Files")) event.preventDefault();
});
document.addEventListener("drop", (event) => {
  if (composer() && event.dataTransfer?.files.length) {
    event.preventDefault();
    addFiles(Array.from(event.dataTransfer.files));
  }
});
installSelectKeyMappings(document);
document.addEventListener("keydown", (event) => {
  if (event.isComposing || event.defaultPrevented) return;
  const form = composer();
  const text = form && controls(form).text;
  if (event.target === text && completionItems().length) {
    const direction = navigationDirection(event);
    if (direction || ["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      selectCompletion(completionIndex + (direction || (event.key === "ArrowDown" ? 1 : -1)));
      return;
    }
    if (["Enter", "Tab"].includes(event.key)) {
      event.preventDefault();
      applyCompletion(completionItems()[completionIndex]);
      return;
    }
  }
  if (event.key === "Escape") {
    if (activeActions) {
      closeActions();
      event.preventDefault();
      return;
    }
    closeCompletions();
    const popovers = document.querySelectorAll<HTMLElement>(":popover-open");
    if (popovers.length) {
      popovers.forEach((node) => node.hidePopover());
      event.preventDefault();
      return;
    }
    const bar = document.querySelector<HTMLElement>("#search-bar");
    if (bar && !bar.hidden) {
      bar.hidden = true;
      search();
      event.preventDefault();
    } else document.querySelector<HTMLAnchorElement>("[data-return]")?.click();
    return;
  }
  if (
    (event.ctrlKey || event.metaKey) &&
    !event.shiftKey &&
    event.key === "f" &&
    document.querySelector("#search-bar")
  ) {
    event.preventDefault();
    document.querySelector<HTMLButtonElement>("[data-search-toggle]")?.click();
    return;
  }
  const direction = navigationDirection(event);
  if (
    event.target instanceof HTMLInputElement &&
    event.target.id === "search" &&
    (direction || event.key === "Enter")
  ) {
    event.preventDefault();
    search(direction || (event.shiftKey ? -1 : 1));
    return;
  }
  const list = Array.from(document.querySelectorAll<HTMLElement>("#session-list a, #branches a"));
  if (direction && list.length && !(event.target instanceof HTMLSelectElement)) {
    event.preventDefault();
    moveFocus(list, direction);
    return;
  }
  if (event.target === text && event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    const submitter = document.querySelector<HTMLButtonElement>(
      event.altKey
        ? "button[form=composer][value=followUp]"
        : "#send, #composer button[type=submit]:not([hidden]), #composer button:not([type]):not([hidden])",
    );
    if (submitter) form?.requestSubmit(submitter);
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key === "k" && !event.shiftKey) {
    event.preventDefault();
    document.querySelector<HTMLAnchorElement>('[data-command="sessions"]')?.click();
    return;
  }
  if (
    event.target instanceof Element &&
    event.target.closest("input, textarea, select, [contenteditable]")
  )
    return;
  if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
  const id = { t: "targets", m: "models", n: "create", "/": "session-filter" }[event.key];
  const control = id && document.getElementById(id);
  if (control) {
    event.preventDefault();
    control.focus();
    if (control instanceof HTMLButtonElement) control.click();
  }
});

// Serialize autosaves and drain them before following a navigation link.
const saves = new WeakMap<HTMLFormElement, Promise<boolean>>();
const refreshedForms = new WeakMap<HtmxRequestCtx, HTMLFormElement>();
document.addEventListener("htmx:before:request", (event) => {
  const source = event.detail.ctx.sourceElement;
  if (source instanceof HTMLSelectElement) {
    const form = source.closest<HTMLFormElement>("form[data-autosave]");
    if (form) refreshedForms.set(event.detail.ctx, form);
  }
});
async function saveForm(form: HTMLFormElement): Promise<boolean> {
  const pending = saves.get(form);
  if (pending) return pending;
  const task = (async () => {
    while (form.dataset.dirty === "true" && form.isConnected) {
      form.dataset.dirty = "false";
      form.dataset.failed = "false";
      const status = form.querySelector(".save-status");
      if (status) status.textContent = "Saving…";
      await htmx.ajax("POST", form.action, { source: form, target: form, swap: "none" });
      if (form.dataset.failed === "true") {
        form.dataset.dirty = "true";
        if (status) status.textContent = "Save failed";
        return false;
      }
      if (status) status.textContent = "Saved";
    }
    return true;
  })();
  saves.set(form, task);
  try {
    return await task;
  } finally {
    saves.delete(form);
  }
}
document.addEventListener("input", (event) => {
  if (event.target instanceof Element) {
    const form = event.target.closest<HTMLFormElement>("form[data-autosave]");
    if (form) form.dataset.dirty = "true";
  }
});
document.addEventListener("focusout", (event) => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
    const form = event.target.closest<HTMLFormElement>("form[data-autosave]");
    if (form) void saveForm(form);
  }
});
document.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement)) return;
  if (target.hasAttribute("data-preference")) {
    document.body.classList.toggle("wrap-code", target.value === "true");
    try {
      localStorage.setItem("pi.html.wrap-code", target.value);
    } catch {
      /* Optional local preference. */
    }
  }
  const form = target.closest<HTMLFormElement>("form[data-autosave]");
  if (form) {
    form.dataset.dirty = "true";
    if (!target.hasAttribute("hx-get")) void saveForm(form);
  }
});
document.addEventListener("htmx:finally:request", (event) => {
  const { sourceElement, response } = event.detail.ctx;
  if (sourceElement instanceof HTMLFormElement && sourceElement.hasAttribute("data-autosave"))
    sourceElement.dataset.failed = String(!response || response.status >= 400);
  const refreshed = refreshedForms.get(event.detail.ctx);
  if (refreshed?.isConnected && response && response.status < 400) {
    refreshed.dataset.dirty = "true";
    void saveForm(refreshed);
  }
});
const follow = new WeakSet<HTMLAnchorElement>();
document.addEventListener(
  "click",
  (event) => {
    const link = event.target instanceof Element && event.target.closest("a");
    if (
      !link ||
      follow.has(link) ||
      event.ctrlKey ||
      event.metaKey ||
      link.hasAttribute("download")
    )
      return;
    const form = document.querySelector<HTMLFormElement>("form[data-autosave]");
    if (!form || (form.dataset.dirty !== "true" && !saves.has(form))) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void saveForm(form).then((saved) => {
      if (saved && link.isConnected) {
        follow.add(link);
        link.click();
        follow.delete(link);
      }
    });
  },
  true,
);
window.addEventListener("offline", () => document.body.classList.add("offline"));
window.addEventListener("online", () => document.body.classList.remove("offline"));

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
}
let installPrompt: InstallPromptEvent | undefined;
let registration: ServiceWorkerRegistration | undefined;
let updateRequested = false;
function installStatus() {
  const install = document.querySelector<HTMLButtonElement>("#install");
  if (install) install.hidden = !installPrompt;
  const update = document.querySelector<HTMLButtonElement>("#update");
  if (update) update.hidden = !registration?.waiting;
}
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event as InstallPromptEvent;
  installStatus();
});
document.addEventListener("click", (event) => {
  if (!(event.target instanceof HTMLButtonElement)) return;
  if (event.target.id === "install")
    void installPrompt?.prompt().finally(() => {
      installPrompt = undefined;
      installStatus();
    });
  if (event.target.id === "update") {
    updateRequested = true;
    registration?.waiting?.postMessage("activate");
  }
});
if ("serviceWorker" in navigator) {
  void navigator.serviceWorker
    .register("/hypermedia-sw.js", { scope: "/sessions" })
    .then((worker) => {
      registration = worker;
      worker.addEventListener("updatefound", () =>
        worker.installing?.addEventListener("statechange", installStatus),
      );
      installStatus();
      // Activation may race a navigation; claim the now-loaded document.
      void navigator.serviceWorker.ready.then((ready) => ready.active?.postMessage("claim"));
    })
    .catch(() => {
      /* Offline first visits still render the supplied document. */
    });
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (updateRequested) location.reload();
  });
}
try {
  document.body.classList.toggle("wrap-code", localStorage.getItem("pi.html.wrap-code") === "true");
} catch {
  /* Optional local preference. */
}
document.documentElement.classList.add("enhanced");
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", connect);
else connect();
