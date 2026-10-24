import type { HtmxRequestCtx } from "htmx.org";
import { completionToken, type CompletionToken } from "../completions.ts";
import { composer, controls } from "./dom.ts";
let completionRevision = 0;
let token: CompletionToken | undefined;
export let completionIndex = 0;
export function closeCompletions() {
  const active = token !== undefined;
  completionRevision++;
  token = undefined;
  const popup = document.querySelector<HTMLElement>("#completions");
  if (popup) {
    popup.hidden = true;
    popup.replaceChildren();
  }
  return active;
}
export function completionItems() {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("#completions [data-completion]"));
}
export function selectCompletion(index: number) {
  const items = completionItems();
  if (!items.length) return;
  completionIndex = (index + items.length) % items.length;
  items.forEach((item, i) => item.setAttribute("aria-selected", String(i === completionIndex)));
  items[completionIndex].scrollIntoView({ block: "nearest" });
}
export function applyCompletion(item: HTMLButtonElement) {
  const form = composer();
  if (!form || !token) return;
  const text = controls(form).text;
  text.setRangeText(item.dataset.completion!, token.start, token.end, "end");
  closeCompletions();
  text.focus();
  text.dispatchEvent(new Event("input", { bubbles: true }));
}

export function installCompletions() {
  const revisions = new WeakMap<HtmxRequestCtx, number>();
  const edits = new WeakMap<Event, number>();
  for (const name of ["input", "compositionend"])
    document.addEventListener(name, (event) => {
      const form = composer();
      if (!form || event.target !== controls(form).text) return;
      closeCompletions();
      const text = controls(form).text;
      if (!(event instanceof InputEvent && event.isComposing))
        token = completionToken(text.value, text.selectionStart);
      edits.set(event, completionRevision);
    });
  document.addEventListener("htmx:config:request", (event) => {
    const { ctx } = event.detail;
    const text = ctx.sourceElement;
    if (!(text instanceof HTMLTextAreaElement) || !text.hasAttribute("data-completions")) return;
    if (
      !ctx.sourceEvent ||
      edits.get(ctx.sourceEvent) !== completionRevision ||
      (ctx.sourceEvent instanceof InputEvent && ctx.sourceEvent.isComposing)
    ) {
      event.preventDefault();
      return;
    }
    token = completionToken(text.value, text.selectionStart);
    if (!token) {
      event.preventDefault();
      return;
    }
    const values = new FormData();
    values.set("kind", token.kind);
    values.set("query", token.query);
    ctx.request.body = values;
    revisions.set(ctx, completionRevision);
  });
  document.addEventListener("htmx:after:request", (event) => {
    const { ctx } = event.detail;
    const source = ctx.sourceElement;
    if (
      source.hasAttribute("data-completions") &&
      (revisions.get(ctx) !== completionRevision ||
        !source.isConnected ||
        !ctx.response ||
        ctx.response.status >= 400)
    )
      event.preventDefault();
    if (source instanceof HTMLInputElement && source.hasAttribute("data-suggest")) {
      const values = new URL(ctx.request.action, location.href).searchParams;
      if (
        !source.isConnected ||
        values.get("baseDirectory") !== source.value ||
        values.get("target") !==
          source.form?.querySelector<HTMLSelectElement>("[name=target]")?.value
      )
        event.preventDefault();
    }
  });
  document.addEventListener("htmx:after:swap", (event) => {
    if (event.detail.ctx.sourceElement?.hasAttribute("data-completions")) {
      const popup = document.querySelector<HTMLElement>("#completions");
      if (popup) popup.hidden = !popup.childElementCount;
      selectCompletion(0);
    }
  });
  document.addEventListener("pointerdown", (event) => {
    if (event.target instanceof Element && event.target.closest("[data-completion]"))
      event.preventDefault();
  });
  document.addEventListener("click", (event) => {
    const button =
      event.target instanceof Element &&
      event.target.closest<HTMLButtonElement>("button[data-completion]");
    if (button) applyCompletion(button);
  });
}
