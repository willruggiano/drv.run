import type { Htmx } from "htmx.org";

declare const htmx: Htmx;

// New details retain server defaults (including failed tools). Only details
// already processed in the live DOM own their open/closed state locally.
const existing = new WeakSet<HTMLDetailsElement>();
htmx.registerExtension("disclosure", {
  htmx_after_process(element: Element) {
    if (element instanceof HTMLDetailsElement) existing.add(element);
    element.querySelectorAll("details").forEach((details) => existing.add(details));
  },
  htmx_before_morph_attr(element: Element, detail: { attrName: string }) {
    if (
      detail.attrName === "open" &&
      element instanceof HTMLDetailsElement &&
      existing.has(element)
    )
      return false;
  },
});
